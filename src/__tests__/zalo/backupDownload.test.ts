import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { downloadBackupFile, isZaloHost } from '../../services/zalo/mobileSync/backupDownload';

interface Step { status: number; headers?: Record<string, string>; chunks?: string[]; stall?: boolean }
interface Call { url: string; headers: Record<string, string>; agent: unknown }

// Transport giả: không mở cổng mạng, trả phản hồi theo kịch bản và ghi lại từng request.
function fakeTransport(steps: Step[]) {
    const calls: Call[] = [];
    const responses: any[] = [];
    const request = jest.fn((url: any, options: any, cb: (res: any) => void) => {
        calls.push({ url: String(url), headers: { ...options.headers }, agent: options.agent });
        const step = steps.shift();
        if (!step) throw new Error('unexpected request');
        const req: any = new EventEmitter();
        req.destroy = (err?: Error) => { if (err) req.emit('error', err); };
        req.end = () => {
            Promise.resolve().then(() => {
                const res: any = new Readable({ read() {} });
                res.statusCode = step.status;
                res.headers = step.headers || {};
                responses.push(res);
                cb(res);
                for (const c of step.chunks || []) res.push(Buffer.from(c));
                if (!step.stall) res.push(null);
            });
        };
        return req;
    });
    return { request: request as any, calls, responses };
}

const ZALO_URL = 'https://files.zdn.vn/backup/x.db.crypt?token=SECRET123';
let dir: string;
let dest: string;
let cancelNow = false;
const base = (request: any, extra: Record<string, unknown> = {}) => ({
    cookieFor: () => 'sid=abc', userAgent: 'UA', request, ...extra,
});

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-dl-'));
    dest = path.join(dir, 'out.crypt');
});
afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('isZaloHost', () => {
    it('accepts Zalo hosts and subdomains, case-insensitive', () => {
        expect(isZaloHost('zalo.me')).toBe(true);
        expect(isZaloHost('a.b.zdn.vn')).toBe(true);
        expect(isZaloHost('ZADN.VN')).toBe(true);
    });
    it('rejects look-alikes and empty', () => {
        expect(isZaloHost('evilzalo.me')).toBe(false);
        expect(isZaloHost('zalo.me.evil.com')).toBe(false);
        expect(isZaloHost('')).toBe(false);
    });
});

describe('downloadBackupFile', () => {
    it('rejectsHttp without calling request', async () => {
        const t = fakeTransport([]);
        await expect(downloadBackupFile('http://files.zdn.vn/x', dest, base(t.request))).rejects.toThrow();
        expect(t.request).not.toHaveBeenCalled();
    });

    it('sendsCookieOnlyToZaloHosts', async () => {
        const a = fakeTransport([{ status: 200, chunks: ['a'] }]);
        await downloadBackupFile(ZALO_URL, dest, base(a.request));
        expect(a.calls[0].headers.Cookie).toBe('sid=abc');
        const b = fakeTransport([{ status: 200, chunks: ['a'] }]);
        await downloadBackupFile('https://cdn.example.com/x', dest, base(b.request));
        expect(b.calls[0].headers.Cookie).toBeUndefined();
    });

    it('passes the proxy agent through', async () => {
        const agent = {};
        const t = fakeTransport([{ status: 200, chunks: ['a'] }]);
        await downloadBackupFile(ZALO_URL, dest, base(t.request, { agent }));
        expect(t.calls[0].agent).toBe(agent);
    });

    it('stripsCookieOnRedirectToOtherHost, resolves relative Location, and rejects redirect to http', async () => {
        const t = fakeTransport([
            { status: 302, headers: { location: '/next?x=1' } },
            { status: 302, headers: { location: 'https://cdn.example.com/y' } },
            { status: 200, chunks: ['ok'] },
        ]);
        await downloadBackupFile(ZALO_URL, dest, base(t.request));
        expect(t.calls[1].url).toBe('https://files.zdn.vn/next?x=1');
        expect(t.calls[1].headers.Cookie).toBe('sid=abc');
        expect(t.calls[2].url).toBe('https://cdn.example.com/y');
        expect(t.calls[2].headers.Cookie).toBeUndefined();

        const h = fakeTransport([{ status: 302, headers: { location: 'http://files.zdn.vn/z' } }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(h.request))).rejects.toThrow();
        expect(h.request).toHaveBeenCalledTimes(1);
    });

    it('does not re-add the cookie when redirected back to Zalo after leaving it', async () => {
        const t = fakeTransport([
            { status: 302, headers: { location: 'https://cdn.example.com/y' } },
            { status: 302, headers: { location: 'https://files.zdn.vn/back' } },
            { status: 200, chunks: ['ok'] },
        ]);
        await downloadBackupFile(ZALO_URL, dest, base(t.request));
        expect(t.calls[2].headers.Cookie).toBeUndefined();
    });

    it('followsAtMostFiveRedirects', async () => {
        const hop = { status: 302, headers: { location: '/n' } };
        const ok = fakeTransport([hop, hop, hop, hop, hop, { status: 200, chunks: ['ok'] }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(ok.request))).resolves.toEqual({ bytes: 2 });
        fs.rmSync(dest, { force: true });
        const bad = fakeTransport([hop, hop, hop, hop, hop, hop, { status: 200 }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(bad.request))).rejects.toThrow();
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('retriesOnceWithoutCookieOn4xx', async () => {
        const t = fakeTransport([{ status: 403 }, { status: 200, chunks: ['ok'] }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(t.request))).resolves.toEqual({ bytes: 2 });
        expect(t.calls[0].headers.Cookie).toBe('sid=abc');
        expect(t.calls[1].headers.Cookie).toBeUndefined();

        const f = fakeTransport([{ status: 403 }, { status: 403 }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(f.request))).rejects.toThrow(/403/);
        expect(f.request).toHaveBeenCalledTimes(2);
    });

    it('does not retry on 5xx or when no cookie was sent', async () => {
        const a = fakeTransport([{ status: 500 }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(a.request))).rejects.toThrow(/500/);
        expect(a.request).toHaveBeenCalledTimes(1);
        const b = fakeTransport([{ status: 403 }]);
        await expect(downloadBackupFile('https://cdn.example.com/x', dest, base(b.request))).rejects.toThrow(/403/);
        expect(b.request).toHaveBeenCalledTimes(1);
    });

    it('writesFileAndReportsProgress', async () => {
        const t = fakeTransport([{ status: 200, headers: { 'content-length': '10' }, chunks: ['hello', 'world'] }]);
        const progress: Array<[number, number]> = [];
        const r = await downloadBackupFile(ZALO_URL, dest, base(t.request, { onProgress: (a: number, b: number) => progress.push([a, b]) }));
        expect(r).toEqual({ bytes: 10 });
        expect(fs.readFileSync(dest, 'utf8')).toBe('helloworld');
        expect(progress[progress.length - 1]).toEqual([10, 10]);
    });

    it('idleTimeoutAborts and removes the partial file', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        const t = fakeTransport([{ status: 200, chunks: ['part'], stall: true }]);
        const p = downloadBackupFile(ZALO_URL, dest, base(t.request));
        const assertion = expect(p).rejects.toThrow();
        await jest.advanceTimersByTimeAsync(60_000);
        await assertion;
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('cancelAborts and removes the partial file', async () => {
        let cancelled = false;
        const t = fakeTransport([{ status: 200, chunks: ['a', 'b'] }]);
        const p = downloadBackupFile(ZALO_URL, dest, base(t.request, {
            isCancelled: () => cancelled,
            onProgress: () => { cancelled = true; },
        }));
        await expect(p).rejects.toThrow();
        expect(fs.existsSync(dest)).toBe(false);
    });

    it('errorMessagesHideUrl', async () => {
        const msgs: string[] = [];
        for (const steps of [[{ status: 500 }], [{ status: 302, headers: { location: 'http://files.zdn.vn/q?token=SECRET123' } }]]) {
            const t = fakeTransport(steps as Step[]);
            try { await downloadBackupFile(ZALO_URL, dest, base(t.request)); } catch (e: any) { msgs.push(String(e.message)); }
        }
        expect(msgs).toHaveLength(2);
        for (const m of msgs) {
            expect(m).not.toContain('SECRET123');
            expect(m).not.toContain('token=');
        }
        expect(() => { throw new Error(msgs[0]); }).toThrow(/zdn\.vn.*500|500/);
    });
});

describe('downloadBackupFile hardening', () => {
    it('includes the server error message of the cookie attempt, never the URL', async () => {
        const t = fakeTransport([
            { status: 400, chunks: [JSON.stringify({ error_code: -69, error_message: 'Session invalid' })] },
            { status: 400, chunks: [JSON.stringify({ error_code: -1, error_message: 'Missing session' })] },
        ]);
        const err: Error = await downloadBackupFile(ZALO_URL, dest, base(t.request)).then(() => { throw new Error('resolved'); }, e => e);
        expect(err.message).toBe('Tải bản sao lưu thất bại (HTTP 400, files.zdn.vn: -69 Session invalid)');
        expect(t.responses.every(r => r.destroyed)).toBe(true);

        // Nội dung không phải JSON, quá dài hoặc có đường dẫn thì không đưa vào lỗi.
        for (const body of ['<html>Bad Request</html>', JSON.stringify({ error_message: 'see https://x.zdn.vn/?token=SECRET123' })]) {
            const f = fakeTransport([{ status: 500, chunks: [body] }]);
            await expect(downloadBackupFile(ZALO_URL, dest, base(f.request))).rejects.toThrow('Tải bản sao lưu thất bại (HTTP 500, files.zdn.vn)');
        }
    });

    it('destroys redirect and 4xx responses instead of draining them', async () => {
        const t = fakeTransport([
            { status: 302, headers: { location: '/n' }, stall: true },
            { status: 403, stall: true },
            { status: 200, chunks: ['ok'] },
        ]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(t.request))).resolves.toEqual({ bytes: 2 });
        expect(t.responses[0].destroyed).toBe(true);
        expect(t.responses[1].destroyed).toBe(true);
        const f = fakeTransport([{ status: 500, stall: true }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(f.request))).rejects.toThrow(/500/);
        expect(f.responses[0].destroyed).toBe(true);
    });

    it('cleanup failure never masks the original error', async () => {
        const rm = jest.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('EBUSY: busy'), { code: 'EBUSY' }));
        try {
            const t = fakeTransport([{ status: 200, chunks: ['a', 'b'] }]);
            await expect(downloadBackupFile(ZALO_URL, dest, base(t.request, { isCancelled: () => cancelNow, onProgress: () => { cancelNow = true; } })))
                .rejects.toThrow('Đã huỷ tải bản sao lưu');
            expect(rm).toHaveBeenCalled();
        } finally {
            rm.mockRestore();
            cancelNow = false;
        }
    });

    it('rejects userinfo in the initial URL and in a redirect target', async () => {
        const a = fakeTransport([]);
        await expect(downloadBackupFile('https://u:p@zalo.me/x', dest, base(a.request))).rejects.toThrow('Đường dẫn tải bản sao lưu không hợp lệ');
        expect(a.request).not.toHaveBeenCalled();
        const b = fakeTransport([{ status: 302, headers: { location: 'https://u@zalo.me/x' } }]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(b.request))).rejects.toThrow('Đường dẫn tải bản sao lưu không hợp lệ');
        expect(b.request).toHaveBeenCalledTimes(1);
    });

    it('malformed URL rejects without a synchronous throw', async () => {
        const t = fakeTransport([]);
        let p: Promise<unknown> | undefined;
        expect(() => { p = downloadBackupFile('not a url', dest, base(t.request)); }).not.toThrow();
        await expect(p).rejects.toThrow();
        expect(t.request).not.toHaveBeenCalled();
    });

    it('trailing-dot host gets no cookie', async () => {
        const t = fakeTransport([{ status: 200, chunks: ['a'] }]);
        await downloadBackupFile('https://zalo.me./x', dest, base(t.request));
        expect(t.calls[0].headers.Cookie).toBeUndefined();
    });

    it('protocol-relative redirect to another host drops the cookie', async () => {
        const t = fakeTransport([{ status: 302, headers: { location: '//other.example/x' } }, { status: 200, chunks: ['a'] }]);
        await downloadBackupFile(ZALO_URL, dest, base(t.request));
        expect(t.calls[1].url).toBe('https://other.example/x');
        expect(t.calls[1].headers.Cookie).toBeUndefined();
    });

    it('already-cancelled download rejects without calling the transport', async () => {
        const t = fakeTransport([]);
        await expect(downloadBackupFile(ZALO_URL, dest, base(t.request, { isCancelled: () => true }))).rejects.toThrow();
        expect(t.request).not.toHaveBeenCalled();
    });
});
