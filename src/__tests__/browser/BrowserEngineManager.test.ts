import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { BrowserEngineManager, EngineDeps, downloadFile } from '../../services/browser/BrowserEngineManager';
import type { BrowserEngineConfig } from '../../configs/browserEngine.config';

const ARCHIVE_BYTES = Buffer.from('fake engine archive');
const GOOD_SHA = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

function makeConfig(sha256 = GOOD_SHA): BrowserEngineConfig {
    return { version: '1.2.3', packages: { linux: { url: 'https://example.invalid/engine.tar.xz', sha256, executable: 'engine/chrome' } } };
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps & { downloads: number } {
    const deps = {
        downloads: 0,
        download: async (_url: string, destination: string, onProgress?: (p: { received: number; total: number }) => void) => {
            deps.downloads++;
            fs.writeFileSync(destination, ARCHIVE_BYTES);
            onProgress?.({ received: ARCHIVE_BYTES.length, total: ARCHIVE_BYTES.length });
        },
        extract: async (_archive: string, directory: string) => {
            fs.mkdirSync(path.join(directory, 'engine'), { recursive: true });
            fs.writeFileSync(path.join(directory, 'engine', 'chrome'), '#!/bin/sh\n');
        },
        ...overrides,
    };
    return deps;
}

describe('BrowserEngineManager', () => {
    let baseDir: string;
    beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-')); });
    afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

    it('reports an unsupported platform and refuses to install', async () => {
        const manager = new BrowserEngineManager(baseDir, 'darwin', makeDeps(), makeConfig());
        expect(manager.getStatus()).toEqual({ supported: false, installed: false, version: '1.2.3' });
        expect(manager.getExecutablePath()).toBeNull();
        await expect(manager.install()).rejects.toThrow('chưa được hỗ trợ');
    });

    it('installs, reports progress and returns the executable path', async () => {
        const progress: number[] = [];
        const manager = new BrowserEngineManager(baseDir, 'linux', makeDeps(), makeConfig());
        expect(manager.getStatus().installed).toBe(false);
        await manager.install((p) => progress.push(p.received));
        const executable = path.join(baseDir, '1.2.3', 'engine', 'chrome');
        expect(manager.getExecutablePath()).toBe(executable);
        expect(manager.getStatus().installed).toBe(true);
        expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
        expect(progress).toEqual([ARCHIVE_BYTES.length]);
        expect(fs.existsSync(path.join(baseDir, '1.2.3', 'engine.download'))).toBe(false);
    });

    it('rejects a download whose SHA-256 does not match and leaves nothing installed', async () => {
        let extracted = false;
        const deps = makeDeps({ extract: async () => { extracted = true; } });
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig('0'.repeat(64)));
        await expect(manager.install()).rejects.toThrow('SHA-256');
        expect(extracted).toBe(false);
        expect(manager.getExecutablePath()).toBeNull();
        expect(fs.existsSync(path.join(baseDir, '1.2.3', 'engine.download'))).toBe(false);
    });

    it('treats an extraction without the marker file as not installed and reinstalls cleanly', async () => {
        const versionDir = path.join(baseDir, '1.2.3');
        fs.mkdirSync(path.join(versionDir, 'engine'), { recursive: true });
        fs.writeFileSync(path.join(versionDir, 'engine', 'chrome'), 'half extracted');
        const deps = makeDeps();
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        expect(manager.getExecutablePath()).toBeNull();
        await manager.install();
        expect(deps.downloads).toBe(1);
        expect(fs.readFileSync(manager.getExecutablePath()!, 'utf8')).toBe('#!/bin/sh\n');
    });

    it('fails when the archive does not contain the expected executable', async () => {
        const manager = new BrowserEngineManager(baseDir, 'linux', makeDeps({ extract: async () => undefined }), makeConfig());
        await expect(manager.install()).rejects.toThrow('Không tìm thấy tệp chạy');
        expect(manager.getExecutablePath()).toBeNull();
    });

    it('shares one download between concurrent install calls and skips when already installed', async () => {
        const deps = makeDeps();
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        await Promise.all([manager.install(), manager.install()]);
        await manager.install();
        expect(deps.downloads).toBe(1);
    });

    it('can retry after a failed download', async () => {
        let attempt = 0;
        const good = makeDeps();
        const deps = makeDeps({
            download: async (url, destination, onProgress) => {
                if (attempt++ === 0) throw new Error('network down');
                await good.download(url, destination, onProgress);
            },
        });
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        await expect(manager.install()).rejects.toThrow('network down');
        await manager.install();
        expect(manager.getExecutablePath()).not.toBeNull();
    });
});

describe('downloadFile', () => {
    let dir: string;
    let server: http.Server;
    let sockets: Set<import('net').Socket>;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-test-'));
        sockets = new Set();
    });
    afterEach(async () => {
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function serve(handler: http.RequestListener): Promise<string> {
        server = http.createServer(handler);
        server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}/engine`;
    }

    it('downloads a body and reports progress', async () => {
        const body = Buffer.from('hello engine');
        const url = await serve((_req, res) => { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); });
        const destination = path.join(dir, 'out');
        const reports: Array<{ received: number; total: number }> = [];
        await downloadFile(url, destination, (p) => reports.push(p), 5000);
        expect(fs.readFileSync(destination)).toEqual(body);
        expect(reports[reports.length - 1]).toEqual({ received: body.length, total: body.length });
    });

    it('rejects on an HTTP error status', async () => {
        const url = await serve((_req, res) => { res.writeHead(404); res.end(); });
        await expect(downloadFile(url, path.join(dir, 'out'), undefined, 5000)).rejects.toThrow();
    });

    it('rejects when the connection closes before Content-Length bytes arrive and releases the file', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { 'Content-Length': 1000 });
            res.write('partial', () => res.destroy());
        });
        const destination = path.join(dir, 'out');
        await expect(downloadFile(url, destination, undefined, 5000)).rejects.toThrow();
        expect(() => fs.rmSync(destination, { force: true })).not.toThrow();
    });

    it('rejects after the idle timeout when the server stalls mid-body', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { 'Content-Length': 1000 });
            res.write('first chunk');
        });
        const destination = path.join(dir, 'out');
        await expect(downloadFile(url, destination, undefined, 200)).rejects.toThrow('không nhận được dữ liệu');
        expect(() => fs.rmSync(destination, { force: true })).not.toThrow();
    });
});
