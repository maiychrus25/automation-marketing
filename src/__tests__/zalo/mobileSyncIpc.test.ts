const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
let workspaceType = 'local';
jest.mock('../../utils/WorkspaceManager', () => ({
    __esModule: true,
    default: { getInstance: () => ({ getActiveWorkspace: () => ({ type: workspaceType }) }) },
}));
const svc = { start: jest.fn(), cancel: jest.fn(), getStatus: jest.fn() };
jest.mock('../../services/zalo/mobileSync/MobileSyncService', () => ({
    __esModule: true,
    default: { getInstance: () => svc },
}));

import { registerMobileSyncIpc } from '../../../electron/ipc/mobileSyncIpc';

const EMPLOYEE_ERROR = 'Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại';
const INVALID = { success: false, error: 'Tham số không hợp lệ' };
const call = (ch: string, payload: any) => handlers.get(ch)!({}, payload);

beforeAll(() => registerMobileSyncIpc());
beforeEach(() => { jest.clearAllMocks(); workspaceType = 'local'; });

describe('mobileSync IPC', () => {
    it('registers the three channels', () => {
        expect([...handlers.keys()].sort()).toEqual(['zalo:mobileSync:cancel', 'zalo:mobileSync:start', 'zalo:mobileSync:status']);
    });

    it('start forwards zaloId and range, including null/null', async () => {
        svc.start.mockResolvedValue({ success: true });
        expect(await call('zalo:mobileSync:start', { zaloId: '123', fromTs: null, toTs: null })).toEqual({ success: true });
        expect(svc.start).toHaveBeenCalledWith('123', { fromTs: null, toTs: null });
        await call('zalo:mobileSync:start', { zaloId: '123', fromTs: 0, toTs: 99 });
        expect(svc.start).toHaveBeenLastCalledWith('123', { fromTs: 0, toTs: 99 });
    });

    it('cancel and status forward zaloId', async () => {
        svc.cancel.mockResolvedValue({ success: true });
        svc.getStatus.mockReturnValue({ zaloId: '123', stage: 'importing' });
        expect(await call('zalo:mobileSync:cancel', { zaloId: '123' })).toEqual({ success: true });
        expect(svc.cancel).toHaveBeenCalledWith('123');
        expect(await call('zalo:mobileSync:status', { zaloId: '123' })).toEqual({ success: true, status: { zaloId: '123', stage: 'importing' } });
        svc.getStatus.mockReturnValue(null);
        expect(await call('zalo:mobileSync:status', { zaloId: '123' })).toEqual({ success: true, status: null });
    });

    it('refuses in employee mode without calling the service', async () => {
        workspaceType = 'remote';
        for (const ch of ['start', 'cancel', 'status']) {
            expect(await call(`zalo:mobileSync:${ch}`, { zaloId: '123', fromTs: null, toTs: null })).toEqual({ success: false, error: EMPLOYEE_ERROR });
        }
        expect(svc.start).not.toHaveBeenCalled();
        expect(svc.cancel).not.toHaveBeenCalled();
        expect(svc.getStatus).not.toHaveBeenCalled();
    });

    it.each(['', 123, '../x', 'a/b', undefined, null])('rejects invalid zaloId %p', async (zaloId) => {
        for (const ch of ['start', 'cancel', 'status']) {
            expect(await call(`zalo:mobileSync:${ch}`, { zaloId, fromTs: null, toTs: null })).toEqual(INVALID);
        }
        expect(svc.start).not.toHaveBeenCalled();
        expect(svc.cancel).not.toHaveBeenCalled();
        expect(svc.getStatus).not.toHaveBeenCalled();
    });

    it('rejects a missing payload', async () => {
        expect(await call('zalo:mobileSync:start', undefined)).toEqual(INVALID);
    });

    it.each([
        ['string', '1'], ['NaN', NaN], ['negative', -1], ['Infinity', Infinity], ['undefined', undefined],
    ])('rejects invalid range (%s)', async (_n, bad) => {
        expect(await call('zalo:mobileSync:start', { zaloId: '123', fromTs: bad, toTs: null })).toEqual(INVALID);
        expect(await call('zalo:mobileSync:start', { zaloId: '123', fromTs: null, toTs: bad })).toEqual(INVALID);
        expect(svc.start).not.toHaveBeenCalled();
    });

    it('passes a service failure through unchanged', async () => {
        svc.start.mockResolvedValue({ success: false, error: 'Đang có phiên khác' });
        expect(await call('zalo:mobileSync:start', { zaloId: '123', fromTs: null, toTs: null })).toEqual({ success: false, error: 'Đang có phiên khác' });
    });

    it('turns a throwing service into an error object', async () => {
        svc.start.mockRejectedValue(new Error('boom'));
        svc.cancel.mockRejectedValue(new Error('boom'));
        svc.getStatus.mockImplementation(() => { throw new Error('boom'); });
        const bad = { success: false, error: 'boom' };
        expect(await call('zalo:mobileSync:start', { zaloId: '123', fromTs: null, toTs: null })).toEqual(bad);
        expect(await call('zalo:mobileSync:cancel', { zaloId: '123' })).toEqual(bad);
        expect(await call('zalo:mobileSync:status', { zaloId: '123' })).toEqual(bad);
    });
});
