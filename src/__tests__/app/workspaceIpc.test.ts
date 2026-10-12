const handlers = new Map<string, (event: unknown, args: any) => Promise<any>>();
jest.mock('electron', () => ({
    ipcMain: { handle: (channel: string, fn: any) => { handlers.set(channel, fn); } },
    BrowserWindow: class {},
}));

const mockWm = {
    getActiveWorkspaceId: jest.fn(),
    getActiveWorkspace: jest.fn(),
    switchWorkspace: jest.fn(),
    restoreActiveWorkspace: jest.fn(),
    canDeleteWorkspace: jest.fn(),
    deleteWorkspace: jest.fn(),
    resolveDbPath: jest.fn((p: string) => `/db/${p}`),
};
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => mockWm } }));

const mockDb = { switchToWorkspaceDb: jest.fn(), forceFlush: jest.fn(), run: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));

const mockAppMode = { clearOverride: jest.fn() };
jest.mock('../../utils/AppModeManager', () => ({ __esModule: true, default: { getInstance: () => mockAppMode } }));
jest.mock('../../services/file/FileStorageService', () => ({ __esModule: true, default: { resetBaseDir: jest.fn() } }));
jest.mock('../../services/http/HttpConnectionManager', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../services/http/HttpRelayService', () => ({ __esModule: true, default: { getInstance: () => ({ getStatus: () => ({ running: false }) }) } }));
jest.mock('../../utils/ConnectionManager', () => ({ __esModule: true, default: { getAllConnections: () => new Map() } }));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { clearBeforeSendHooks: jest.fn() } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const mockCloseAllBrowserProfiles = jest.fn();
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ closeAllBrowserProfiles: () => mockCloseAllBrowserProfiles() }));

const mockPoster = {
    cancelAndWait: jest.fn(),
    startScheduler: jest.fn(),
    stopScheduler: jest.fn(),
    isBusy: jest.fn(() => false),
};
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({
    POSTER_NOT_STOPPED_ERROR: 'Việc Đăng Facebook chưa dừng được. Thử lại sau.',
    cancelAndWaitFacebookPosterJobs: () => mockPoster.cancelAndWait(),
    startFacebookPosterScheduler: () => mockPoster.startScheduler(),
    stopFacebookPosterScheduler: () => mockPoster.stopScheduler(),
    isFacebookPosterBusy: () => mockPoster.isBusy(),
}));

import { registerWorkspaceIpc } from '../../../electron/ipc/workspaceIpc';

const NOT_STOPPED = 'Việc Đăng Facebook chưa dừng được. Thử lại sau.';
const BUSY = 'Đang chuyển workspace, thử lại sau.';
const call = (channel: string, id: string) => handlers.get(channel)!({}, { id });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

beforeAll(() => { registerWorkspaceIpc(null); });

beforeEach(() => {
    jest.clearAllMocks();
    mockWm.getActiveWorkspaceId.mockReturnValue('old');
    mockWm.getActiveWorkspace.mockReturnValue({ id: 'next', name: 'Next', dbPath: 'next.db' });
    mockWm.switchWorkspace.mockReturnValue({ success: true, workspace: { id: 'new', name: 'New', type: 'local', dbPath: 'new.db' } });
    mockWm.canDeleteWorkspace.mockReturnValue({ success: true });
    mockWm.deleteWorkspace.mockReturnValue({ success: true });
    mockDb.switchToWorkspaceDb.mockResolvedValue(undefined);
    mockPoster.isBusy.mockReturnValue(false);
});

describe('workspace:switch', () => {
    it('refuses and rolls back when the poster job does not stop', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(false);
        // After switchWorkspace the manager already points at the new id
        mockWm.getActiveWorkspaceId.mockReturnValueOnce('old').mockReturnValue('new');

        const result = await call('workspace:switch', 'new');

        expect(result).toEqual({ success: false, error: NOT_STOPPED });
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled();
        expect(mockWm.restoreActiveWorkspace).toHaveBeenCalledWith('old');
        expect(mockPoster.startScheduler).toHaveBeenCalled();
    });

    it('switches the database once when the poster job stopped', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(true);

        const result = await call('workspace:switch', 'new');

        expect(result.success).toBe(true);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledTimes(1);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledWith('/db/new.db');
        expect(mockWm.restoreActiveWorkspace).not.toHaveBeenCalled();
        expect(mockPoster.startScheduler).toHaveBeenCalled();
    });

    it('refuses a second switch or active delete while one is waiting, then accepts again', async () => {
        const gate = deferred<boolean>();
        mockPoster.cancelAndWait.mockReturnValueOnce(gate.promise);

        const first = call('workspace:switch', 'new');
        await new Promise((r) => setImmediate(r));

        expect(await call('workspace:switch', 'other')).toEqual({ success: false, error: BUSY });
        mockWm.getActiveWorkspaceId.mockReturnValue('old');
        expect(await call('workspace:delete', 'old')).toEqual({ success: false, error: BUSY });
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();

        gate.resolve(true);
        expect((await first).success).toBe(true);

        mockPoster.cancelAndWait.mockResolvedValue(true);
        expect((await call('workspace:switch', 'new')).success).toBe(true);
    });

    it('clears the in-progress flag after a failed switch', async () => {
        mockPoster.cancelAndWait.mockResolvedValueOnce(false).mockResolvedValue(true);
        await call('workspace:switch', 'new');
        expect((await call('workspace:switch', 'new')).success).toBe(true);
    });
});

describe('workspace:delete', () => {
    it('keeps the workspace and restarts the scheduler when the active one cannot stop the poster', async () => {
        mockWm.getActiveWorkspaceId.mockReturnValue('old');
        mockPoster.cancelAndWait.mockResolvedValue(false);

        const result = await call('workspace:delete', 'old');

        expect(result).toEqual({ success: false, error: NOT_STOPPED });
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();
        expect(mockPoster.startScheduler).toHaveBeenCalled();
    });

    it('deletes the active workspace, switches the database and restarts the scheduler', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(true);

        const result = await call('workspace:delete', 'old');

        expect(result).toEqual({ success: true });
        expect(mockWm.deleteWorkspace).toHaveBeenCalledWith('old');
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledWith('/db/next.db');
        expect(mockPoster.startScheduler).toHaveBeenCalled();
    });

    it('restarts the scheduler even when a step after the stop throws', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(true);
        mockAppMode.clearOverride.mockImplementationOnce(() => { throw new Error('boom'); });

        const result = await call('workspace:delete', 'old');

        expect(result).toEqual({ success: false, error: 'boom' });
        expect(mockPoster.startScheduler).toHaveBeenCalled();
        // and the in-progress flag is cleared
        mockPoster.cancelAndWait.mockResolvedValue(true);
        expect((await call('workspace:delete', 'old')).success).toBe(true);
    });

    it('never stops the poster for a non-active workspace', async () => {
        mockWm.getActiveWorkspaceId.mockReturnValue('other');

        const result = await call('workspace:delete', 'old');

        expect(result).toEqual({ success: true });
        expect(mockWm.deleteWorkspace).toHaveBeenCalledWith('old');
        expect(mockPoster.stopScheduler).not.toHaveBeenCalled();
        expect(mockPoster.cancelAndWait).not.toHaveBeenCalled();
    });

    it('does not stop the poster when the delete would be refused', async () => {
        mockWm.canDeleteWorkspace.mockReturnValue({ success: false, error: 'Phải có ít nhất 1 workspace' });

        const result = await call('workspace:delete', 'old');

        expect(result).toEqual({ success: false, error: 'Phải có ít nhất 1 workspace' });
        expect(mockPoster.stopScheduler).not.toHaveBeenCalled();
        expect(mockPoster.cancelAndWait).not.toHaveBeenCalled();
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();
    });
});
