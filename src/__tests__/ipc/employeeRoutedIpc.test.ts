import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));

let workspace: any = { id: 'ws-1', type: 'local' };
jest.mock('../../utils/WorkspaceManager', () => ({
    __esModule: true,
    default: { getInstance: () => ({ getActiveWorkspace: () => workspace }) },
}));
jest.mock('../../utils/AppModeManager', () => ({
    __esModule: true,
    default: { getInstance: () => ({ getMode: () => (workspace?.type === 'remote' ? 'employee' : 'boss') }) },
}));

const proxyAction = jest.fn();
const uploadMedia = jest.fn();
let connected = true;
jest.mock('../../services/http/HttpConnectionManager', () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            isConnected: () => connected,
            proxyAction: (...a: any[]) => proxyAction(...a),
            getServiceForWorkspace: () => ({ uploadMedia: (...a: any[]) => uploadMedia(...a) }),
        }),
    },
}));

import { employeeRoutedIpcMain, routeEmployeeChannel } from '../../../electron/ipc/proxyHelper';

const listener = jest.fn(async () => ({ success: true, from: 'local' }));
const run = (channel: string, params: any) => routeEmployeeChannel(channel, listener)({}, params);

beforeEach(() => {
    jest.clearAllMocks();
    workspace = { id: 'ws-1', type: 'remote' };
    connected = true;
    proxyAction.mockResolvedValue({ success: true, from: 'boss' });
});

describe('local workspace', () => {
    beforeEach(() => { workspace = { id: 'ws-1', type: 'local' }; });
    it.each(['fb:addReaction', 'fb:historySync:start', 'fb:getAccounts', 'fb:scanGetTabs'])('runs the listener for %s', async (ch) => {
        expect(await run(ch, { accountId: 'page-1' })).toEqual({ success: true, from: 'local' });
        expect(proxyAction).not.toHaveBeenCalled();
    });
});

describe('remote workspace', () => {
    it.each([['fb:sendAttachments', 90000], ['fb:addReaction', 30000], ['fb:fetchOlderMessages', 60000]])('proxies %s with its timeout', async (ch, timeoutMs) => {
        const params = { accountId: 'page-1', threadId: '1' };
        expect(await run(ch, params)).toEqual({ success: true, from: 'boss' });
        expect(listener).not.toHaveBeenCalled();
        expect(proxyAction).toHaveBeenCalledWith('ws-1', ch, params, timeoutMs);
    });

    it('refuses boss_only commands without calling the listener or the boss', async () => {
        const res = await run('fb:historySync:start', { accountId: 'page-1' });
        expect(res).toMatchObject({ success: false, code: 'BOSS_ONLY' });
        expect(listener).not.toHaveBeenCalled();
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('runs local commands locally', async () => {
        const ch = 'fb:scanGetTabs';
        expect(await run(ch, {})).toEqual({ success: true, from: 'local' });
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('runs the listener for a relayed call', async () => {
        expect(await run('fb:addReaction', { accountId: 'page-1', _fromRelay: true })).toEqual({ success: true, from: 'local' });
        expect(await run('fb:historySync:start', { accountId: 'page-1', _fromRelay: true })).toEqual({ success: true, from: 'local' });
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('uploads a local file first and sends the boss path', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emp-')), 'a.png');
        fs.writeFileSync(file, 'x');
        uploadMedia.mockResolvedValue({ success: true, bossPath: '/boss/media/a.png' });
        await run('fb:sendAttachment', { accountId: 'page-1', filePath: file });
        expect(uploadMedia).toHaveBeenCalledWith(expect.any(Buffer), 'a.png', 'page-1');
        expect(proxyAction).toHaveBeenCalledWith('ws-1', 'fb:sendAttachment', { accountId: 'page-1', filePath: '/boss/media/a.png' }, 90000);
    });

    it('reports UPLOAD_FAILED and does not call the boss', async () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emp-')), 'a.png');
        fs.writeFileSync(file, 'x');
        uploadMedia.mockResolvedValue({ success: false, error: 'boom' });
        const res = await run('fb:sendAttachment', { accountId: 'page-1', filePath: file });
        expect(res).toMatchObject({ success: false, code: 'UPLOAD_FAILED' });
        expect(JSON.stringify(res)).not.toContain(file);
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('returns NOT_CONNECTED without throwing', async () => {
        connected = false;
        expect(await run('fb:addReaction', { accountId: 'page-1' })).toMatchObject({ success: false, code: 'NOT_CONNECTED' });
        connected = true;
        proxyAction.mockRejectedValue(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
        expect(await run('fb:addReaction', { accountId: 'page-1' })).toMatchObject({ success: false, code: 'NOT_CONNECTED' });
    });
});

describe('boss result classification', () => {
    const err = (code?: string) => Object.assign(new Error('x'), code ? { code } : {});
    it.each(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'EPIPE', undefined])('reports %s as TIMEOUT (the boss may have run it)', async (code) => {
        proxyAction.mockRejectedValue(err(code));
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toEqual({
            success: false,
            error: 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy kiểm tra hội thoại trước khi thử lại.',
            code: 'TIMEOUT',
        });
    });
    it('reports "socket hang up" as TIMEOUT', async () => {
        proxyAction.mockRejectedValue(new Error('socket hang up'));
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toMatchObject({ success: false, code: 'TIMEOUT' });
    });
    it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])('reports %s as NOT_CONNECTED (nothing was sent)', async (code) => {
        proxyAction.mockRejectedValue(err(code));
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toEqual({ success: false, error: 'Chưa nối được máy Boss', code: 'NOT_CONNECTED' });
    });
    it('reports no active remote workspace as NOT_CONNECTED', async () => {
        proxyAction.mockRejectedValue(new Error('Workspace "ws-1" chưa kết nối tới BOSS'));
        const res = await require('../../../electron/ipc/proxyHelper').proxyToBossWithResult('fb:sendMessage', {});
        expect(res.code).toBe('NOT_CONNECTED');
        workspace = null;
        expect((await require('../../../electron/ipc/proxyHelper').proxyToBossWithResult('fb:sendMessage', {})).code).toBe('NOT_CONNECTED');
    });
    it("passes the boss's own error result through unchanged", async () => {
        const answer = { success: false, error: 'x', code: 'ACCOUNT_FORBIDDEN' };
        proxyAction.mockResolvedValue(answer);
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toEqual(answer);
    });
    it.each([['text'], [null], [[1]], [42], [undefined]])('reports a non-object answer (%p) as BAD_RESPONSE', async (answer) => {
        proxyAction.mockResolvedValue(answer);
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toEqual({ success: false, error: 'Máy Boss trả về kết quả không hợp lệ', code: 'BAD_RESPONSE' });
    });
});

describe('employeeRoutedIpcMain', () => {
    it('registers once under the same channel and passes other members through', () => {
        const fake = { handle: jest.fn(), removeHandler: jest.fn() };
        const routed = employeeRoutedIpcMain(fake);
        routed.handle('fb:x', listener);
        expect(fake.handle).toHaveBeenCalledTimes(1);
        expect(fake.handle.mock.calls[0][0]).toBe('fb:x');
        routed.handle('fb:addReaction', listener);
        expect(fake.handle.mock.calls[1][1]).not.toBe(listener);
        routed.removeHandler('fb:x');
        expect(fake.removeHandler).toHaveBeenCalledWith('fb:x');
    });
});

describe('Facebook poster channels', () => {
    const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'emp-poster-'));
    const file = (name: string, content = 'x') => { const f = path.join(tmp(), name); fs.writeFileSync(f, content); return f; };

    it('proxies a poster command with its params unchanged when there is no media', async () => {
        const params = { kind: 'post', params: { text: 'hi', profiles: ['p1'] } };
        expect(await run('facebookPoster:start', params)).toEqual({ success: true, from: 'boss' });
        expect(proxyAction).toHaveBeenCalledWith('ws-1', 'facebookPoster:start', params, expect.any(Number));
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
    });

    it('uploads params.params.mediaPaths with the poster contract and keeps the order', async () => {
        const a = file('a.png'); const b = file('b b.mp4');
        uploadMedia.mockImplementation(async (_buf: Buffer, name: string) => ({ success: true, bossPath: `/boss/${name}` }));
        await run('facebookPoster:scheduleCreate', { kind: 'once', params: { text: 't', mediaPaths: [a, b] } });
        expect(uploadMedia).toHaveBeenNthCalledWith(1, expect.any(Buffer), 'a.png', undefined, 'poster');
        expect(uploadMedia).toHaveBeenNthCalledWith(2, expect.any(Buffer), 'b b.mp4', undefined, 'poster');
        expect(proxyAction.mock.calls[0][2]).toEqual({ kind: 'once', params: { text: 't', mediaPaths: ['/boss/a.png', '/boss/b b.mp4'] } });
    });

    it('uploads a top-level mediaPaths too (draftSave)', async () => {
        const a = file('a.png');
        uploadMedia.mockResolvedValue({ success: true, bossPath: '/boss/a.png' });
        await run('facebookPoster:draftSave', { mediaPaths: [a], params: { text: 't' } });
        expect(proxyAction.mock.calls[0][2]).toEqual({ mediaPaths: ['/boss/a.png'], params: { text: 't' } });
    });

    it('keeps a path that is not on this machine (a boss path from draftGet), mixed with a local file, in order', async () => {
        const a = file('a.png');
        uploadMedia.mockResolvedValue({ success: true, bossPath: '/boss/new-a.png' });
        await run('facebookPoster:draftSave', { params: { mediaPaths: ['/boss/stored/one.jpg', a, '/boss/stored/two.jpg'] } });
        expect(uploadMedia).toHaveBeenCalledTimes(1);
        expect(proxyAction.mock.calls[0][2].params.mediaPaths).toEqual(['/boss/stored/one.jpg', '/boss/new-a.png', '/boss/stored/two.jpg']);
    });

    it('a failed upload fails the whole command, names no path and sends nothing', async () => {
        const a = file('a.png'); const b = file('b.png');
        uploadMedia.mockResolvedValueOnce({ success: true, bossPath: '/boss/a.png' }).mockResolvedValueOnce({ success: false, error: 'boom' });
        const res = await run('facebookPoster:start', { kind: 'post', params: { mediaPaths: [a, b] } });
        expect(res).toMatchObject({ success: false, code: 'UPLOAD_FAILED' });
        expect(JSON.stringify(res)).not.toContain(a);
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('refuses a file over 200 MB without uploading it (the size is read with stat, before any read)', async () => {
        const big = file('big.mp4');
        fs.truncateSync(big, 200 * 1024 * 1024 + 1); // sparse: no memory or disk spent
        const res = await run('facebookPoster:start', { kind: 'post', params: { mediaPaths: [big] } });
        expect(res).toEqual({ success: false, error: 'Tệp quá lớn (tối đa 200 MB)', code: 'UPLOAD_TOO_LARGE' });
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it('does not send the poster header for other channels', async () => {
        const f = file('a.png');
        uploadMedia.mockResolvedValue({ success: true, bossPath: '/boss/a.png' });
        await run('fb:sendAttachment', { accountId: 'page-1', filePath: f });
        expect(uploadMedia).toHaveBeenCalledWith(expect.any(Buffer), 'a.png', 'page-1');
    });

    it('does not touch mediaPaths of a boss_only or unclassified channel', async () => {
        const f = file('a.png');
        expect(await run('facebookPoster:exportRunCsv', { params: { mediaPaths: [f] } })).toMatchObject({ code: 'BOSS_ONLY' });
        expect(await run('facebookPoster:unlisted', { params: { mediaPaths: [f] } })).toEqual({ success: true, from: 'local' });
        expect(uploadMedia).not.toHaveBeenCalled();
    });

    it('boss_only poster and profile commands return the standard BOSS_ONLY result', async () => {
        for (const ch of ['facebookPoster:takeMissed', 'browserProfile:open', 'engagement:approve', 'autonomy:status']) {
            expect(await run(ch, {})).toEqual({ success: false, error: 'Thao tác này chỉ thực hiện được trên máy Boss', code: 'BOSS_ONLY' });
        }
        expect(listener).not.toHaveBeenCalled();
    });

    it('browserProfile:list is proxied; pickMedia runs on this machine', async () => {
        expect(await run('browserProfile:list', undefined)).toEqual({ success: true, from: 'boss' });
        expect(proxyAction).toHaveBeenCalledWith('ws-1', 'browserProfile:list', {}, 30000);
        expect(await run('facebookPoster:pickMedia', {})).toEqual({ success: true, from: 'local' });
        expect(proxyAction).toHaveBeenCalledTimes(1);
    });

    it('a relayed call on the boss reaches the original listener with the same params, uploads nothing', async () => {
        const params = { kind: 'post', params: { mediaPaths: ['/boss/x.png'] }, _fromRelay: true, _profileScope: ['p1'] };
        expect(await run('facebookPoster:start', params)).toEqual({ success: true, from: 'local' });
        expect(listener).toHaveBeenCalledWith({}, params);
        expect(uploadMedia).not.toHaveBeenCalled();
    });

    it('on a boss or standalone machine nothing changes', async () => {
        workspace = { id: 'ws-1', type: 'local' };
        const f = file('a.png');
        expect(await run('facebookPoster:start', { params: { mediaPaths: [f] } })).toEqual({ success: true, from: 'local' });
        expect(await run('browserProfile:open', { id: 'p1' })).toEqual({ success: true, from: 'local' });
        expect(proxyAction).not.toHaveBeenCalled();
        expect(uploadMedia).not.toHaveBeenCalled();
    });
});

describe('upload refusals from the boss', () => {
    const file = (name: string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emp-ref-')), name); fs.writeFileSync(f, 'x'); return f; };
    it.each([
        ['facebookPoster:start', (f: string) => ({ kind: 'post', params: { mediaPaths: [f] } })],
        ['fb:sendAttachment', (f: string) => ({ accountId: 'page-1', filePath: f })],
    ])('%s: a boss 413 keeps its code and text; a 403 keeps MODULE_FORBIDDEN; nothing is sent', async (channel, make) => {
        const f = file('a.png');
        uploadMedia.mockResolvedValueOnce({ success: false, error: 'Tệp quá lớn (tối đa 200 MB)', code: 'UPLOAD_TOO_LARGE' });
        expect(await run(channel, make(f))).toEqual({ success: false, error: 'Tệp quá lớn (tối đa 200 MB)', code: 'UPLOAD_TOO_LARGE' });
        uploadMedia.mockResolvedValueOnce({ success: false, error: 'Không có quyền dùng module này', code: 'MODULE_FORBIDDEN' });
        const res = await run(channel, make(f));
        expect(res).toEqual({ success: false, error: 'Không có quyền dùng module này', code: 'MODULE_FORBIDDEN' });
        expect(JSON.stringify(res)).not.toContain(f);
        expect(proxyAction).not.toHaveBeenCalled();
    });

    it.each([
        ['facebookPoster:start', (f: string) => ({ kind: 'post', params: { mediaPaths: [f] } })],
        ['fb:sendAttachment', (f: string) => ({ accountId: 'page-1', filePath: f })],
    ])('%s: a network error, an unreadable answer or a body without a code stay UPLOAD_FAILED', async (channel, make) => {
        const f = file('a.png');
        for (const answer of [{ success: false, error: 'connect ECONNREFUSED' }, { success: false, error: 'Invalid JSON response' }, { success: false, code: 'X' }, undefined]) {
            uploadMedia.mockResolvedValueOnce(answer);
            const res = await run(channel, make(f));
            expect(res).toEqual({ success: false, error: 'Không tải được tệp lên máy Boss', code: 'UPLOAD_FAILED' });
        }
        uploadMedia.mockRejectedValueOnce(new Error('boom'));
        expect(await run(channel, make(f))).toMatchObject({ code: 'UPLOAD_FAILED' });
        expect(proxyAction).not.toHaveBeenCalled();
    });
});

describe('legacy single mediaPath of a poster command', () => {
    const file = (name: string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'emp-mp-')), name); fs.writeFileSync(f, 'x'); return f; };
    it('is uploaded with the poster contract at the top level and inside params.params', async () => {
        const a = file('a.png'); const b = file('b.png');
        uploadMedia.mockImplementation(async (_buf: Buffer, name: string) => ({ success: true, bossPath: `/boss/${name}` }));
        await run('facebookPoster:draftSave', { mediaPath: a, params: { text: 't', mediaPath: b, mediaPaths: [a] } });
        expect(uploadMedia).toHaveBeenCalledTimes(3);
        for (const call of uploadMedia.mock.calls) expect(call[3]).toBe('poster');
        expect(proxyAction.mock.calls[0][2]).toEqual({ mediaPath: '/boss/a.png', params: { text: 't', mediaPath: '/boss/b.png', mediaPaths: ['/boss/a.png'] } });
    });
    it('is kept when the file is not on this machine', async () => {
        await run('facebookPoster:start', { kind: 'post', params: { mediaPath: '/boss/stored/one.jpg' } });
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(proxyAction.mock.calls[0][2]).toEqual({ kind: 'post', params: { mediaPath: '/boss/stored/one.jpg' } });
    });
});

describe('timeout text', () => {
    const generic = 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy kiểm tra hội thoại trước khi thử lại.';
    const poster = 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy xem Tiến độ hoặc Lịch sử trước khi bấm lại.';
    it('poster channels point at Progress and History, code stays TIMEOUT', async () => {
        proxyAction.mockRejectedValue(new Error('socket hang up'));
        for (const ch of ['facebookPoster:start', 'facebookPoster:scheduleCreate', 'browserProfile:list']) {
            expect(await run(ch, {})).toEqual({ success: false, error: poster, code: 'TIMEOUT' });
        }
    });
    it('other channels keep the conversation text', async () => {
        proxyAction.mockRejectedValue(new Error('socket hang up'));
        expect(await run('fb:sendMessage', { accountId: 'page-1' })).toEqual({ success: false, error: generic, code: 'TIMEOUT' });
    });
});

describe('poster IPC files register through routeEmployeeChannel', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../../electron/ipc', f), 'utf8');
    it.each(['facebookPosterIpc.ts', 'browserProfileIpc.ts'])('%s wraps its handle() listener and keeps a guard for non-local channels', (file) => {
        const src = read(file);
        expect(src).toMatch(/ipcMain\.handle\(channel, routeEmployeeChannel\(channel, /);
        expect(src).toMatch(/handlerMayRunHere\(/);
        expect((src.match(/ipcMain\.handle\(/g) || []).length).toBe(1);
    });
    it('facebookPosterIpc logs at most 300 characters of an error message', () => {
        const src = read('facebookPosterIpc.ts');
        expect(src).toMatch(/const LOG_MESSAGE_MAX = 300;/);
        expect(src).toMatch(/\$\{channel\} error: \$\{String\(err\?\.message\)\.slice\(0, LOG_MESSAGE_MAX\)\}/);
    });
    it('facebookPosterIpc keeps the learner stop of its employee guard', () => {
        expect(read('facebookPosterIpc.ts')).toMatch(/if \(blocked\) learner\?\.stop\(\)/);
        expect(read('facebookPosterIpc.ts')).toMatch(/!handlerMayRunHere\(isFacebookPosterEmployeeBlocked\(\), channel\)/);
        expect(read('browserProfileIpc.ts')).toMatch(/!handlerMayRunHere\(AppModeManager\.getInstance\(\)\.isEmployeeMode\(\), channel\)/);
    });
});
