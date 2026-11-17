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
