import * as http from 'http';
import * as net from 'net';
import { ProxyForwarder, splitHostPort } from '../../services/browser/ProxyForwarder';
import type { ProxyConfig } from '../../models/proxy';

const USER = 'ahv user';
const PASS = 'p@ss:word/1';
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}
function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => {
        (server as any).closeAllConnections?.();
        server.close(() => resolve());
    });
}

/** Target web server: answers every request with "hello <path>". */
function createTarget(): http.Server {
    return http.createServer((req, res) => res.end(`hello ${req.url}`));
}

/** Fake upstream HTTP proxy that requires Basic auth and records what it saw. */
function createHttpUpstream(seen: { auth: string[] }): http.Server {
    const server = http.createServer((req, res) => {
        seen.auth.push(String(req.headers['proxy-authorization']));
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) { res.writeHead(407).end(); return; }
        const url = new URL(req.url!);
        const forward = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method }, (r) => {
            res.writeHead(r.statusCode!, r.headers); r.pipe(res);
        });
        req.pipe(forward);
    });
    server.on('connect', (req, socket) => {
        seen.auth.push(String(req.headers['proxy-authorization']));
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
        const [host, port] = req.url!.split(':');
        const target = net.connect(Number(port), host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            target.pipe(socket); socket.pipe(target);
        });
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
    });
    return server;
}

/** Minimal SOCKS5 server with username/password auth (RFC 1928 / 1929), CONNECT only. */
function createSocks5Upstream(seen: { credentials: string[] }): net.Server {
    return net.createServer((client) => {
        let stage = 0;
        client.on('error', () => undefined);
        client.on('data', function onData(chunk: Buffer) {
            if (stage === 0) { stage = 1; client.write(Buffer.from([5, 2])); return; }
            if (stage === 1) {
                const userLength = chunk[1];
                const user = chunk.subarray(2, 2 + userLength).toString();
                const pass = chunk.subarray(3 + userLength, 3 + userLength + chunk[2 + userLength]).toString();
                seen.credentials.push(`${user}:${pass}`);
                const ok = user === USER && pass === PASS;
                client.write(Buffer.from([1, ok ? 0 : 1]));
                if (!ok) client.end();
                stage = 2;
                return;
            }
            if (stage === 2) {
                stage = 3;
                let host: string; let offset: number;
                if (chunk[3] === 1) { host = Array.from(chunk.subarray(4, 8)).join('.'); offset = 8; }
                else { host = chunk.subarray(5, 5 + chunk[4]).toString(); offset = 5 + chunk[4]; }
                const port = chunk.readUInt16BE(offset);
                client.removeListener('data', onData);
                const target = net.connect(port, host, () => {
                    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                    target.pipe(client); client.pipe(target);
                });
                target.on('error', () => client.destroy());
            }
        });
    });
}

/** Sends CONNECT to the forwarder, then a raw GET through the tunnel. Resolves with status line + body. */
function connectThrough(forwarderPort: number, targetPort: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: forwarderPort, method: 'CONNECT', path: `127.0.0.1:${targetPort}` });
        req.once('connect', (res, socket) => {
            if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode!, body: '' }); return; }
            let body = '';
            socket.on('data', (d) => { body += d.toString(); });
            socket.on('end', () => resolve({ status: 200, body }));
            socket.on('error', reject);
            socket.write(`GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
        });
        req.once('error', reject);
        req.end();
    });
}

/** Plain HTTP request through the forwarder (absolute URL in the request line). */
function getThrough(forwarderPort: number, targetPort: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: forwarderPort, method: 'GET', path: `http://127.0.0.1:${targetPort}/plain?x=1` }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d.toString(); });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.once('error', reject);
        req.end();
    });
}

function proxyConfig(type: ProxyConfig['type'], port: number, password = PASS): ProxyConfig {
    return { id: 1, name: 'test', type, host: '127.0.0.1', port, username: USER, password };
}

describe('splitHostPort', () => {
    it('parses hostnames, IPv4 and bracketed IPv6', () => {
        expect(splitHostPort('example.com:443')).toEqual({ host: 'example.com', port: 443 });
        expect(splitHostPort('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    });
    it('rejects malformed authorities', () => {
        expect(splitHostPort('example.com')).toBeNull();
        expect(splitHostPort('example.com:0')).toBeNull();
        expect(splitHostPort('example.com:99999')).toBeNull();
        expect(splitHostPort('')).toBeNull();
    });
});

describe('ProxyForwarder', () => {
    let target: http.Server; let targetPort: number;
    let forwarder: ProxyForwarder | null = null;
    const servers: net.Server[] = [];

    beforeEach(async () => { target = createTarget(); targetPort = await listen(target); });
    afterEach(async () => {
        if (forwarder) { await forwarder.stop(); forwarder = null; }
        await close(target);
        while (servers.length) await close(servers.pop()!);
    });

    it('listens on loopback only', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        await forwarder.start();
        expect(((forwarder as any).server.address() as net.AddressInfo).address).toBe('127.0.0.1');
    });

    it('tunnels CONNECT through an HTTP upstream with credentials containing special characters', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const result = await connectThrough(await forwarder.start(), targetPort);
        expect(result.status).toBe(200);
        expect(result.body).toContain('hello /tunnel');
        expect(seen.auth).toEqual([EXPECTED_AUTH]);
    });

    it('relays plain HTTP through an HTTP upstream', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const result = await getThrough(await forwarder.start(), targetPort);
        expect(result).toEqual({ status: 200, body: 'hello /plain?x=1' });
        expect(seen.auth).toEqual([EXPECTED_AUTH]);
    });

    it('answers 502 and never connects directly when the upstream rejects the password', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream), 'wrong'));
        const port = await forwarder.start();
        expect((await connectThrough(port, targetPort)).status).toBe(502);
    });

    it('answers 502 for CONNECT and plain HTTP when the upstream is down', async () => {
        const dead = net.createServer(); const deadPort = await listen(dead); await close(dead);
        let targetHits = 0;
        target.on('request', () => { targetHits++; });
        forwarder = new ProxyForwarder(proxyConfig('http', deadPort));
        const port = await forwarder.start();
        expect((await connectThrough(port, targetPort)).status).toBe(502);
        expect((await getThrough(port, targetPort)).status).toBe(502);
        expect(targetHits).toBe(0);
    });

    it('tunnels CONNECT and plain HTTP through a SOCKS5 upstream with username/password', async () => {
        const seen = { credentials: [] as string[] };
        const upstream = createSocks5Upstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('socks5', await listen(upstream)));
        const port = await forwarder.start();
        const tunneled = await connectThrough(port, targetPort);
        expect(tunneled.body).toContain('hello /tunnel');
        expect(await getThrough(port, targetPort)).toEqual({ status: 200, body: 'hello /plain?x=1' });
        expect(seen.credentials).toEqual([`${USER}:${PASS}`, `${USER}:${PASS}`]);
    });

    it('answers 502 when the SOCKS5 upstream rejects the password', async () => {
        const seen = { credentials: [] as string[] };
        const upstream = createSocks5Upstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('socks5', await listen(upstream), 'wrong'));
        expect((await connectThrough(await forwarder.start(), targetPort)).status).toBe(502);
    });

    it('rejects a malformed CONNECT target with 400', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const port = await forwarder.start();
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'no-port' });
            req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
            req.once('error', reject);
            req.end();
        });
        expect(status).toBe(400);
        expect(seen.auth).toEqual([]);
    });

    it('stop() closes the listener and open tunnels', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const port = await forwarder.start();
        const closed = new Promise<void>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${targetPort}` });
            req.once('connect', (_res, socket) => { socket.on('error', () => undefined); socket.once('close', () => resolve()); forwarder!.stop(); });
            req.end();
        });
        await closed;
        await expect(connectThrough(port, targetPort)).rejects.toThrow();
        forwarder = null;
    });
});
