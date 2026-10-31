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
const mockBrowserDrain = jest.fn(async (_timeoutMs: number) => true);
const mockPauseBrowser = jest.fn();
const mockResumeBrowser = jest.fn();
const mockRetireBrowser = jest.fn();
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({
    closeAllBrowserProfiles: () => mockCloseAllBrowserProfiles(),
    closeAllBrowserProfilesAndWait: (timeoutMs: number) => mockBrowserDrain(timeoutMs),
    pauseBrowserProfileAdmission: () => mockPauseBrowser(),
    resumeBrowserProfileAdmission: () => mockResumeBrowser(),
    retireBrowserProfileGeneration: () => mockRetireBrowser(),
}));

const mockPoster = {
    cancelAndWait: jest.fn(),
    startScheduler: jest.fn(),
    stopScheduler: jest.fn(),
    pause: jest.fn(), resume: jest.fn(), retire: jest.fn(), isPaused: jest.fn(() => false),
    isBusy: jest.fn(() => false),
};
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({
    POSTER_NOT_STOPPED_ERROR: 'Việc Đăng Facebook chưa dừng được. Thử lại sau.',
    cancelAndWaitFacebookPosterJobs: () => mockPoster.cancelAndWait(),
    startFacebookPosterScheduler: () => mockPoster.startScheduler(),
    stopFacebookPosterScheduler: () => mockPoster.stopScheduler(),
    isFacebookPosterBusy: () => mockPoster.isBusy(),
    isFacebookJobAdmissionPaused: () => mockPoster.isPaused(),
    pauseFacebookJobAdmission: () => mockPoster.pause(),
    resumeFacebookJobAdmission: () => mockPoster.resume(),
    retireFacebookJobGeneration: () => mockPoster.retire(),
}));

const mockControl = { stop: jest.fn(async () => undefined), restart: jest.fn(async () => undefined), sync: jest.fn(), drain: jest.fn(async () => true) };
jest.mock('../../../electron/ipc/controlApiIpc', () => ({
    stopControlApi: () => mockControl.stop(),
    PAGE_PREPARATION_NOT_STOPPED_ERROR: 'Công việc Page chưa dừng an toàn. Thử lại sau.',
    stopPagePreparationForWorkspaceSwitch: () => mockControl.drain(),
    restartControlApi: () => mockControl.restart(),
    syncControlEventSink: () => mockControl.sync(),
}));

const mockResearchDrain = jest.fn(async () => true);
jest.mock('../../../electron/ipc/researchIpc', () => ({
    RESEARCH_NOT_STOPPED_ERROR: 'Lượt quét Nghiên cứu chưa dừng được. Thử lại sau.',
    cancelAndWaitResearch: () => mockResearchDrain(),
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
    mockPoster.isPaused.mockReturnValue(false);
    mockControl.drain.mockResolvedValue(true);
});

describe('workspace:switch', () => {
    it.each(['workspace:switch', 'workspace:delete'])('refuses a competing paused lifecycle without resuming its admission: %s', async channel => {
        mockPoster.isPaused.mockReturnValue(true);
        expect(await call(channel, channel === 'workspace:delete' ? 'old' : 'new')).toEqual({ success: false, error: BUSY });
        expect(mockPoster.resume).not.toHaveBeenCalled(); expect(mockResumeBrowser).not.toHaveBeenCalled();
        expect(mockPoster.pause).not.toHaveBeenCalled(); expect(mockControl.drain).not.toHaveBeenCalled();
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled(); expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();
    });
    it.each(['workspace:switch', 'workspace:delete'])('pauses native admission before the first drain await and resumes without retirement after failure: %s', async channel => {
        const gate = deferred<boolean>(); mockControl.drain.mockReturnValueOnce(gate.promise);
        const operation = call(channel, channel === 'workspace:delete' ? 'old' : 'new');
        const pausedBeforeAwait = mockPauseBrowser.mock.calls.length;
        const jobsPausedBeforeAwait = mockPoster.pause.mock.calls.length;
        const resumedBeforeSettlement = mockResumeBrowser.mock.calls.length;
        gate.resolve(false);
        expect((await operation).success).toBe(false);
        expect(pausedBeforeAwait).toBe(1);
        expect(jobsPausedBeforeAwait).toBe(1);
        expect(mockPoster.retire).not.toHaveBeenCalled();
        expect(mockPoster.resume).toHaveBeenCalled();
        expect(resumedBeforeSettlement).toBe(0);
        expect(mockPauseBrowser.mock.invocationCallOrder[0]).toBeLessThan(mockControl.drain.mock.invocationCallOrder[0]);
        expect(mockRetireBrowser).not.toHaveBeenCalled();
        expect(mockResumeBrowser).toHaveBeenCalled();
    });
    it.each(['workspace:switch', 'workspace:delete'])('retires native generation only after confirmed drain and before DB retarget: %s', async channel => {
        mockPoster.cancelAndWait.mockResolvedValue(true);
        expect((await call(channel, channel === 'workspace:delete' ? 'old' : 'new')).success).toBe(true);
        expect(mockRetireBrowser).toHaveBeenCalledTimes(1);
        expect(mockPoster.retire).toHaveBeenCalledTimes(1);
        expect(mockPoster.retire.mock.invocationCallOrder[0]).toBeGreaterThan(mockPoster.cancelAndWait.mock.invocationCallOrder[0]);
        expect(mockPoster.retire.mock.invocationCallOrder[0]).toBeLessThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
        expect(mockRetireBrowser.mock.invocationCallOrder[0]).toBeGreaterThan(mockBrowserDrain.mock.invocationCallOrder[0]);
        expect(mockRetireBrowser.mock.invocationCallOrder[0]).toBeLessThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
        expect(mockResumeBrowser.mock.invocationCallOrder.slice(-1)[0]).toBeGreaterThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
    });
    it.each(['workspace:switch', 'workspace:delete'])('does not replace the DB or delete active data until native closes settle: %s', async channel => {
        mockPoster.cancelAndWait.mockResolvedValue(true);
        mockBrowserDrain.mockResolvedValueOnce(false);
        expect((await call(channel, channel === 'workspace:delete' ? 'old' : 'new')).success).toBe(false);
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled();
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();
        mockBrowserDrain.mockResolvedValue(true);
        expect((await call(channel, channel === 'workspace:delete' ? 'old' : 'new')).success).toBe(true);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledTimes(1);
    });
    it.each(['false', 'reject'])('refuses actual swap/active-delete when protected drain cannot settle: %s', async outcome => {
        mockWm.getActiveWorkspaceId.mockReturnValueOnce('old').mockReturnValue('new');
        if (outcome === 'reject') mockControl.drain.mockRejectedValue(new Error('drain failed'));
        else mockControl.drain.mockResolvedValue(false);
        expect(await call('workspace:switch', 'new')).toEqual({ success: false, error: 'Công việc Page chưa dừng an toàn. Thử lại sau.' });
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled(); expect(mockWm.restoreActiveWorkspace).toHaveBeenCalledWith('old');
        mockWm.getActiveWorkspaceId.mockReturnValue('old');
        expect((await call('workspace:delete', 'old')).success).toBe(false);
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled(); expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled();
    });
    it.each(['protected', 'research'])('a %s refusal neither stops the scheduler nor cancels poster jobs, then resumes admission', async stage => {
        if (stage === 'protected') mockControl.drain.mockResolvedValueOnce(false);
        else mockResearchDrain.mockResolvedValueOnce(false);
        mockWm.getActiveWorkspaceId.mockReturnValueOnce('old').mockReturnValue('new');
        expect((await call('workspace:switch', 'new')).success).toBe(false);
        expect(mockPoster.stopScheduler).not.toHaveBeenCalled();
        expect(mockPoster.cancelAndWait).not.toHaveBeenCalled();
        expect(mockPoster.retire).not.toHaveBeenCalled();
        expect(mockPoster.resume).toHaveBeenCalled(); expect(mockPoster.startScheduler).toHaveBeenCalled();
    });
    it('waits for protected drain before unrelated poster cleanup or DB swap', async () => {
        const drain = deferred<boolean>(); mockControl.drain.mockReturnValueOnce(drain.promise);
        mockPoster.cancelAndWait.mockResolvedValue(true);
        const pending = call('workspace:switch', 'new'); await new Promise(resolve => setImmediate(resolve));
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled(); expect(mockPoster.cancelAndWait).not.toHaveBeenCalled();
        drain.resolve(true); expect((await pending).success).toBe(true);
        expect(mockControl.drain.mock.invocationCallOrder[0]).toBeLessThan(mockPoster.cancelAndWait.mock.invocationCallOrder[0]);
        expect(mockControl.drain.mock.invocationCallOrder[0]).toBeLessThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
    });
    it('keeps DB and event sink on the old workspace until learner cleanup joins poster stop-and-wait', async () => {
        const learnerIdle = deferred<boolean>();
        mockPoster.isBusy.mockReturnValue(true);
        mockPoster.cancelAndWait.mockReturnValueOnce(learnerIdle.promise);
        const switching = call('workspace:switch', 'new');
        await new Promise((r) => setImmediate(r));
        // The scheduler keeps its queue while jobs drain; only retirement (after a confirmed drain) stops it.
        expect(mockPoster.stopScheduler).not.toHaveBeenCalled();
        expect(mockDb.switchToWorkspaceDb).not.toHaveBeenCalled();
        expect(mockControl.sync).not.toHaveBeenCalled();
        expect(mockControl.stop).not.toHaveBeenCalled();
        learnerIdle.resolve(true);
        expect((await switching).success).toBe(true);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledWith('/db/new.db');
    });

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

    it('restores retained identity before restarting the scheduler after false drain', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(false);
        mockWm.getActiveWorkspaceId.mockReturnValueOnce('old').mockReturnValue('new');
        expect(await call('workspace:switch', 'new')).toEqual({ success: false, error: NOT_STOPPED });
        expect(mockWm.restoreActiveWorkspace.mock.invocationCallOrder[0]).toBeLessThan(mockPoster.startScheduler.mock.invocationCallOrder[0]);
    });

    it('restores workspace identity before constructing restarted jobs after DB retarget fails', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(true);
        mockDb.switchToWorkspaceDb.mockRejectedValueOnce(new Error('DB switch failed'));
        mockWm.getActiveWorkspaceId.mockReturnValueOnce('old').mockReturnValue('new');
        expect(await call('workspace:switch', 'new')).toEqual({ success: false, error: 'DB switch failed' });
        expect(mockWm.restoreActiveWorkspace).toHaveBeenCalledWith('old');
        expect(mockWm.restoreActiveWorkspace.mock.invocationCallOrder[0]).toBeLessThan(mockPoster.startScheduler.mock.invocationCallOrder[0]);
    });

    it('switches the database once when the poster job stopped', async () => {
        mockPoster.cancelAndWait.mockResolvedValue(true);

        const result = await call('workspace:switch', 'new');

        expect(result.success).toBe(true);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledTimes(1);
        expect(mockDb.switchToWorkspaceDb).toHaveBeenCalledWith('/db/new.db');
        expect(mockWm.restoreActiveWorkspace).not.toHaveBeenCalled();
        expect(mockPoster.startScheduler).toHaveBeenCalled();
        // The control API stops before the DB changes and restarts on the new workspace afterwards
        expect(mockControl.stop).toHaveBeenCalledTimes(1);
        expect(mockControl.stop.mock.invocationCallOrder[0]).toBeLessThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
        // sink follows the new DB before the scheduler restarts
        expect(mockControl.sync.mock.invocationCallOrder[0]).toBeGreaterThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
        expect(mockControl.sync.mock.invocationCallOrder[0]).toBeLessThan(mockPoster.startScheduler.mock.invocationCallOrder.slice(-1)[0]);
        expect(mockControl.restart).toHaveBeenCalledTimes(1);
        expect(mockControl.restart.mock.invocationCallOrder[0]).toBeGreaterThan(mockDb.switchToWorkspaceDb.mock.invocationCallOrder[0]);
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

    it('refuses deleting the previous workspace while a switch is waiting', async () => {
        const gate = deferred<boolean>();
        mockPoster.cancelAndWait.mockReturnValueOnce(gate.promise);
        const first = call('workspace:switch', 'new');
        await new Promise((r) => setImmediate(r));

        // switchWorkspace already made 'new' active, so 'old' looks non-active
        mockWm.getActiveWorkspaceId.mockReturnValue('new');
        expect(await call('workspace:delete', 'old')).toEqual({ success: false, error: BUSY });
        expect(mockWm.deleteWorkspace).not.toHaveBeenCalled();

        gate.resolve(true);
        await first;
        expect(await call('workspace:delete', 'old')).toEqual({ success: true });
        expect(mockWm.deleteWorkspace).toHaveBeenCalledWith('old');
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
