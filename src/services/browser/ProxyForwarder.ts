import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { SocksClient } from 'socks';
import type { ProxyConfig } from '../../models/proxy';

const UPSTREAM_TIMEOUT_MS = 30000;

function proxyAuthorization(proxy: ProxyConfig): string | null {
    if (!proxy.username) return null;
    return 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
}

function isSocks(proxy: ProxyConfig): boolean {
    return proxy.type === 'socks4' || proxy.type === 'socks5';
}

/** Splits "host:port" / "[ipv6]:port" as sent in a CONNECT request line. */
export function splitHostPort(authority: string): { host: string; port: number } | null {
    const index = (authority || '').lastIndexOf(':');
    if (index <= 0) return null;
    const host = authority.slice(0, index).replace(/^\[|\]$/g, '');
    const port = Number(authority.slice(index + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
}

/** Opens a raw TCP tunnel to host:port through the upstream proxy, authenticating if needed. */
export function openTunnel(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket> {
    if (isSocks(proxy)) {
        return SocksClient.createConnection({
            proxy: {
                host: proxy.host,
                port: proxy.port,
                type: proxy.type === 'socks5' ? 5 : 4,
                userId: proxy.username || undefined,
                password: proxy.password || undefined,
            },
            command: 'connect',
            destination: { host, port },
            timeout: UPSTREAM_TIMEOUT_MS,
        }).then((result) => result.socket);
    }

    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { Host: `${host}:${port}` };
        const auth = proxyAuthorization(proxy);
        if (auth) headers['Proxy-Authorization'] = auth;
        const request = (proxy.type === 'https' ? https : http).request({
            host: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            timeout: UPSTREAM_TIMEOUT_MS,
        });
        request.once('connect', (response, socket, head) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Upstream proxy refused CONNECT with status ${response.statusCode}`));
                return;
            }
            if (head && head.length) socket.unshift(head);
            resolve(socket);
        });
        request.once('response', (response) => {
            response.resume();
            reject(new Error(`Upstream proxy answered CONNECT with status ${response.statusCode}`));
        });
        request.once('timeout', () => request.destroy(new Error('Upstream proxy timed out')));
        request.once('error', reject);
        request.end();
    });
}

/**
 * Local HTTP proxy bound to 127.0.0.1 that relays every connection to one upstream proxy.
 * Exists because the browser engine cannot take proxy credentials on its command line.
 * It never falls back to a direct connection: an upstream failure is answered with 502.
 */
export class ProxyForwarder {
    private server: http.Server | null = null;
    private readonly sockets = new Set<net.Socket>();

    constructor(private readonly proxy: ProxyConfig) {}

    public start(): Promise<number> {
        const server = http.createServer((request, response) => this.handleRequest(request, response));
        server.on('connect', (request, socket, head) => this.handleConnect(request, socket as net.Socket, head));
        server.on('connection', (socket) => this.track(socket));
        this.server = server;
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
    }

    public stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (!server) return Promise.resolve();
        return new Promise((resolve) => server.close(() => resolve()));
    }

    private track(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }

    private handleConnect(request: http.IncomingMessage, client: net.Socket, head: Buffer): void {
        client.on('error', () => undefined);
        const target = splitHostPort(request.url || '');
        if (!target) {
            client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        openTunnel(this.proxy, target.host, target.port).then((upstream) => {
            if (client.destroyed || !this.server) {
                upstream.destroy();
                return;
            }
            this.track(upstream);
            upstream.on('error', () => client.destroy());
            upstream.once('close', () => client.destroy());
            client.once('close', () => upstream.destroy());
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        }).catch(() => {
            if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
    }

    private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
        let target: URL;
        try {
            target = new URL(request.url || '');
        } catch {
            response.writeHead(400).end();
            return;
        }
        if (target.protocol !== 'http:') {
            response.writeHead(400).end();
            return;
        }
        const fail = () => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        };
        const headers = { ...request.headers };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];

        const relay = (options: http.RequestOptions, transport: typeof http | typeof https) => {
            const upstream = transport.request(options, (upstreamResponse) => {
                response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
                upstreamResponse.pipe(response);
            });
            upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('Upstream proxy timed out')));
            upstream.once('error', fail);
            request.pipe(upstream);
        };

        if (isSocks(this.proxy)) {
            const port = Number(target.port) || 80;
            openTunnel(this.proxy, target.hostname, port).then((socket) => {
                this.track(socket);
                relay({
                    method: request.method,
                    path: `${target.pathname}${target.search}`,
                    headers,
                    // No `agent` here: Node only honours createConnection when the agent option is unset.
                    createConnection: () => socket,
                }, http);
            }).catch(fail);
            return;
        }

        const auth = proxyAuthorization(this.proxy);
        if (auth) headers['proxy-authorization'] = auth;
        relay({
            host: this.proxy.host,
            port: this.proxy.port,
            method: request.method,
            path: request.url,
            headers,
            agent: false,
        }, this.proxy.type === 'https' ? https : http);
    }
}
