const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }));
const proxyAction = jest.fn();
jest.mock('../../services/http/HttpConnectionManager', () => ({
    __esModule: true,
    default: { getInstance: () => ({ isConnected: () => true, proxyAction: (...a: any[]) => proxyAction(...a) }) },
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
let workspaceType = 'local';
jest.mock('../../utils/WorkspaceManager', () => ({
    __esModule: true,
    default: { getInstance: () => ({ getActiveWorkspace: () => ({ type: workspaceType }) }) },
}));
const sync = { start: jest.fn(), cancel: jest.fn(), getStatus: jest.fn() };
jest.mock('../../services/facebook/FacebookHistorySyncService', () => ({
    __esModule: true,
    default: { getInstance: () => sync },
}));
const resolveInternalId = jest.fn((id: string) => `internal-${id}`);
const getFBServiceOrReconnect = jest.fn();
jest.mock('../../../electron/ipc/facebookIpc', () => ({
    resolveInternalId: (id: string) => resolveInternalId(id),
    getFBServiceOrReconnect: (id: string) => getFBServiceOrReconnect(id),
}));

import { registerFbHistoryIpc } from '../../../electron/ipc/fbHistoryIpc';

const EMPLOYEE_ERROR = 'Chỉ chủ tài khoản (máy đang đăng nhập Facebook) mới tải được lịch sử tin nhắn';
const NOT_CONNECTED = 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.';
const call = (ch: string, payload: any) => handlers.get(ch)!({}, payload);
const service = { isPage: jest.fn(), fetchHistoryPage: jest.fn() };

beforeAll(() => registerFbHistoryIpc());
beforeEach(() => {
    jest.clearAllMocks();
    workspaceType = 'local';
    service.isPage.mockReturnValue(false);
    getFBServiceOrReconnect.mockResolvedValue(service);
});

describe('fbHistory IPC', () => {
    it('registers the four channels', () => {
        expect([...handlers.keys()].sort()).toEqual(['fb:fetchOlderMessages', 'fb:historySync:cancel', 'fb:historySync:start', 'fb:historySync:status']);
    });

    it('forwards fetchOlderMessages to the boss and refuses the sync channels in employee mode', async () => {
        workspaceType = 'remote';
        proxyAction.mockResolvedValue({ success: true, from: 'boss' });
        const params = { accountId: '1', threadId: '2' };
        expect(await call('fb:fetchOlderMessages', params)).toEqual({ success: true, from: 'boss' });
        expect(proxyAction).toHaveBeenCalledWith(undefined, 'fb:fetchOlderMessages', params, 60000);
        for (const ch of ['start', 'cancel', 'status']) {
            expect(await call(`fb:historySync:${ch}`, { accountId: '1', fromTs: null, toTs: null })).toMatchObject({ success: false, code: 'BOSS_ONLY' });
        }
        expect(getFBServiceOrReconnect).not.toHaveBeenCalled();
        expect(sync.start).not.toHaveBeenCalled();
        expect(sync.cancel).not.toHaveBeenCalled();
        expect(sync.getStatus).not.toHaveBeenCalled();
    });

    it.each(['', 123, 'a/b', '../x', 'a'.repeat(65), undefined, null])('rejects invalid accountId %p', async (accountId) => {
        expect(await call('fb:fetchOlderMessages', { accountId, threadId: '2' })).toEqual({ success: false, code: 'FETCH', error: 'Tham số không hợp lệ' });
        for (const ch of ['start', 'cancel', 'status']) {
            expect(await call(`fb:historySync:${ch}`, { accountId, fromTs: null, toTs: null })).toEqual({ success: false, error: 'Tham số không hợp lệ' });
        }
        expect(getFBServiceOrReconnect).not.toHaveBeenCalled();
        expect(sync.start).not.toHaveBeenCalled();
    });

    it('accepts uuid-style account ids', async () => {
        sync.getStatus.mockReturnValue(null);
        expect(await call('fb:historySync:status', { accountId: 'ab-12_CD' })).toEqual({ success: true, status: null });
    });

    it.each([
        ['threadId', { threadId: 'abc' }], ['alnum threadId', { threadId: '12abc' }], ['leading @', { threadId: '@123' }],
        ['two @', { threadId: '12@3@4' }], ['newline suffix', { threadId: '12@3\n4' }], ['long suffix', { threadId: '1@' + 'a'.repeat(65) }], ['empty threadId', { threadId: '' }], ['non-string threadId', { threadId: 5 }],
        ['negative ts', { threadId: '2', beforeTimestampMs: -1 }], ['NaN ts', { threadId: '2', beforeTimestampMs: NaN }],
        ['string ts', { threadId: '2', beforeTimestampMs: '1' }], ['Infinity ts', { threadId: '2', beforeTimestampMs: Infinity }],
        ['non-string messageId', { threadId: '2', beforeMessageId: 5 }], ['long messageId', { threadId: '2', beforeMessageId: 'x'.repeat(257) }],
    ])('fetchOlderMessages rejects bad %s', async (_n, extra) => {
        expect(await call('fb:fetchOlderMessages', { accountId: '1', ...extra })).toEqual({ success: false, code: 'FETCH', error: 'Tham số không hợp lệ' });
        expect(service.fetchHistoryPage).not.toHaveBeenCalled();
    });

    it('fetchOlderMessages enables the E2EE probe only for the boolean true and never for relayed calls', async () => {
        service.fetchHistoryPage.mockResolvedValue({ success: true });
        const base = { accountId: '1', threadId: '2', beforeTimestampMs: 5, beforeMessageId: '' };
        const optsOf = () => service.fetchHistoryPage.mock.calls.at(-1)[3];
        await call('fb:fetchOlderMessages', { ...base, probeE2ee: true });
        expect(optsOf()).toEqual({ mode: 'interactive', probeE2ee: true });
        for (const v of ['true', 1, {}, false, undefined]) {
            await call('fb:fetchOlderMessages', { ...base, probeE2ee: v });
            expect(optsOf()).toEqual({ mode: 'interactive' });
        }
        await call('fb:fetchOlderMessages', { ...base, probeE2ee: true, _fromRelay: true });
        expect(optsOf()).toEqual({ mode: 'interactive' });
    });

    it('fetchOlderMessages rejects a missing payload', async () => {
        expect(await call('fb:fetchOlderMessages', undefined)).toEqual({ success: false, code: 'FETCH', error: 'Tham số không hợp lệ' });
    });

    it('fetchOlderMessages reports a missing service', async () => {
        getFBServiceOrReconnect.mockResolvedValue(null);
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2' })).toEqual({ success: false, code: 'NOT_CONNECTED', error: NOT_CONNECTED });
    });

    // Từ 26.44.0 tin cũ của Page lấy qua hộp thư Page, cùng đường với tài khoản cá nhân.
    it('fetchOlderMessages serves Page accounts too', async () => {
        service.isPage.mockReturnValue(true);
        service.fetchHistoryPage.mockResolvedValue({ success: true, saved: 3 });
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2', beforeTimestampMs: 1700, beforeMessageId: 'mid.$a' })).toEqual({ success: true, saved: 3 });
        expect(service.fetchHistoryPage).toHaveBeenCalledWith('2', { timestampMs: 1700, messageId: 'mid.$a' }, undefined, { mode: 'interactive' });
    });

    it('fetchOlderMessages passes the anchor and interactive mode, resolving the internal id', async () => {
        const result = { success: true, saved: 1 };
        service.fetchHistoryPage.mockResolvedValue(result);
        expect(await call('fb:fetchOlderMessages', { accountId: '100', threadId: '555@facebook', beforeTimestampMs: 1700, beforeMessageId: 'mid.$a' })).toBe(result);
        expect(resolveInternalId).toHaveBeenCalledWith('100');
        expect(getFBServiceOrReconnect).toHaveBeenCalledWith('internal-100');
        expect(service.fetchHistoryPage).toHaveBeenCalledWith('555', { timestampMs: 1700, messageId: 'mid.$a' }, undefined, { mode: 'interactive' });
    });

    it('fetchOlderMessages never throws', async () => {
        service.fetchHistoryPage.mockRejectedValue(new Error('boom'));
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2' })).toEqual({ success: false, code: 'FETCH', error: 'boom' });
    });

    it.each([
        ['string', '1'], ['NaN', NaN], ['negative', -1], ['Infinity', Infinity], ['undefined', undefined],
    ])('start rejects invalid range (%s)', async (_n, bad) => {
        expect(await call('fb:historySync:start', { accountId: '1', fromTs: bad, toTs: null })).toEqual({ success: false, error: 'Tham số không hợp lệ' });
        expect(await call('fb:historySync:start', { accountId: '1', fromTs: null, toTs: bad })).toEqual({ success: false, error: 'Tham số không hợp lệ' });
        expect(sync.start).not.toHaveBeenCalled();
    });

    it('start forwards the facebook_id as sent, the normalized range and a service resolver', async () => {
        sync.start.mockReturnValue({ success: true, status: { stage: 'listing' } });
        expect(await call('fb:historySync:start', { accountId: '100', fromTs: 0, toTs: null, extra: 1 })).toEqual({ success: true, status: { stage: 'listing' } });
        expect(sync.start).toHaveBeenCalledWith('100', { fromTs: 0, toTs: null }, expect.any(Function));
        const getService = sync.start.mock.calls[0][2];
        expect(await getService()).toBe(service);
        expect(resolveInternalId).toHaveBeenCalledWith('100');
        expect(getFBServiceOrReconnect).toHaveBeenCalledWith('internal-100');
    });

    it('cancel and status forward the account id', async () => {
        sync.cancel.mockReturnValue({ success: true, status: null });
        sync.getStatus.mockReturnValue({ stage: 'syncing' });
        expect(await call('fb:historySync:cancel', { accountId: '100' })).toEqual({ success: true, status: null });
        expect(sync.cancel).toHaveBeenCalledWith('100');
        expect(await call('fb:historySync:status', { accountId: '100' })).toEqual({ success: true, status: { stage: 'syncing' } });
        expect(sync.getStatus).toHaveBeenCalledWith('100');
    });

    it('sync handlers swallow thrown errors', async () => {
        sync.start.mockImplementation(() => { throw new Error('x'); });
        sync.cancel.mockImplementation(() => { throw new Error('y'); });
        expect(await call('fb:historySync:start', { accountId: '1', fromTs: null, toTs: null })).toEqual({ success: false, error: 'x' });
        expect(await call('fb:historySync:cancel', { accountId: '1' })).toEqual({ success: false, error: 'y' });
    });
    it.each(['123', '123@msgr', '123@' + 'a'.repeat(64)])('fetchOlderMessages accepts threadId %p and sends the stripped id', async (threadId) => {
        service.fetchHistoryPage.mockResolvedValue({ success: true });
        await call('fb:fetchOlderMessages', { accountId: '1', threadId });
        expect(service.fetchHistoryPage.mock.calls[0][0]).toBe('123');
    });

    it('enforces length boundaries and accepts a zero timestamp', async () => {
        service.fetchHistoryPage.mockResolvedValue({ success: true });
        const bad = { success: false, code: 'FETCH', error: 'Tham số không hợp lệ' };
        expect(await call('fb:fetchOlderMessages', { accountId: 'a'.repeat(64), threadId: '2' })).toEqual({ success: true });
        expect(await call('fb:fetchOlderMessages', { accountId: 'a'.repeat(65), threadId: '2' })).toEqual(bad);
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2', beforeMessageId: 'x'.repeat(256) })).toEqual({ success: true });
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2', beforeMessageId: 'x'.repeat(257) })).toEqual(bad);
        service.fetchHistoryPage.mockClear();
        await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2', beforeTimestampMs: 0 });
        expect(service.fetchHistoryPage.mock.calls[0][1]).toEqual({ timestampMs: 0, messageId: '' });
        await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2' });
        expect(service.fetchHistoryPage.mock.calls[1][1]).toEqual({ timestampMs: 0, messageId: '' });
    });

    it('fetchOlderMessages swallows resolveInternalId and reconnect failures', async () => {
        resolveInternalId.mockImplementationOnce(() => { throw new Error('db'); });
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2' })).toEqual({ success: false, code: 'FETCH', error: 'db' });
        getFBServiceOrReconnect.mockRejectedValueOnce(new Error('net'));
        expect(await call('fb:fetchOlderMessages', { accountId: '1', threadId: '2' })).toEqual({ success: false, code: 'FETCH', error: 'net' });
    });

    it('status swallows a thrown error', async () => {
        sync.getStatus.mockImplementation(() => { throw new Error('z'); });
        expect(await call('fb:historySync:status', { accountId: '1' })).toEqual({ success: false, error: 'z' });
        sync.getStatus.mockReset();
    });
});
