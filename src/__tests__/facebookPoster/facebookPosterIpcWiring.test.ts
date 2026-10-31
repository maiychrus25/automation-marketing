// Nối dây trong facebookPosterIpc: cổng chiến dịch của scheduler, campaignId từ cột lịch, và gắn chiến dịch qua posterOperations.
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from './helpers';

const mockDb = memoryDb();
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-wiring-'));
let capturedDeps: any = null;
let mockUseRealScheduler = false;
let mockCommentSchedulerDeps: any = null;
let mockLoginSchedulerDeps: any = null;
let mockTrackSchedulerDeps: any = null;
let mockServiceDeps: any = null;
let mockServiceInstance: any = null;
let mockTrackerDeps: any;
let mockCollectorDeps: any;
let mockLearnerDeps: any;
let mockScanTask: ((deps: any) => Promise<any>) | undefined;
let mockPostTask: ((input: any, deps: any) => Promise<void>) | undefined;
const mockReschedule = jest.fn();
const mockBypass = jest.fn();
const mockClearBypass = jest.fn();
const mockRunFinished = jest.fn();
const mockOpen = jest.fn();
const mockRead = jest.fn();
let mockResearchRunning = false;
const mockResearchDrain = jest.fn(async () => !mockResearchRunning);
const mockNativeRunning = new Set<string>();
const mockNativeListeners = new Set<() => void>();
let mockSwitching = false;
let mockEmployee = false;
let mockDbName = 'db.sqlite';
let mockProfiles = [{ id: 'p1', name: 'P1' }];
let mockDatabaseInstance = {
    ...mockDb, getDbPath: () => path.join(mockDir, mockDbName), getBrowserProfileById: () => ({ id: 'p1', name: 'P1' }),
    getBrowserProfiles: () => mockProfiles, getSetting: () => null, setSetting: jest.fn(),
};

jest.mock('electron', () => ({ dialog: {}, ipcMain: { handle: jest.fn() } }));
jest.mock('../../services/database/DatabaseService', () => ({
    __esModule: true,
    default: {
        getInstance: () => mockDatabaseInstance,
    },
}));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../../utils/AppModeManager', () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => mockEmployee }) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/facebookPoster/FacebookPosterScheduler', () => ({
    FacebookPosterScheduler: class {
        constructor(deps: any) {
            capturedDeps = deps;
            if (mockUseRealScheduler) return new (jest.requireActual('../../services/facebookPoster/FacebookPosterScheduler').FacebookPosterScheduler)(deps);
        }
        start() {}
        stop() {}
        onRunFinished() { mockRunFinished(); }
        onResourcesChanged() {}
        reschedule() { mockReschedule(); }
        bypassCampaignGateOnce(id: string) { mockBypass(id); }
        clearCampaignGateBypass(id: string) { mockClearBypass(id); }
        queuedIds() { return []; }
    },
}));
jest.mock('../../services/facebookPoster/LoginCheckScheduler', () => ({
    LoginCheckScheduler: class { constructor(deps: any) { mockLoginSchedulerDeps = deps; } start() {} stop() {} reschedule() {} },
    LOGIN_CHECK_SETTING_KEY: 'k', parseLoginCheckConfig: () => ({}), validateLoginCheckConfig: (c: any) => c,
}));
jest.mock('../../services/facebookPoster/PostTrackScheduler', () => ({ PostTrackScheduler: class { constructor(deps: any) { mockTrackSchedulerDeps = deps; } start() {} stop() {} } }));
jest.mock('../../services/facebookPoster/CommentCollectScheduler', () => ({
    CommentCollectScheduler: class {
        constructor(deps: any) { mockCommentSchedulerDeps = deps; }
        start() {}
        stop() {}
    },
}));
jest.mock('../../services/ai/AIAssistantService', () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null, chat: jest.fn() }) } }));
jest.mock('../../services/facebookPoster/FacebookPosterService', () => {
    const actual = jest.requireActual('../../services/facebookPoster/FacebookPosterService');
    return {
        ...actual,
        FacebookPosterService: class extends actual.FacebookPosterService {
            constructor(deps: any) { super({ ...deps, ...((mockScanTask || mockPostTask) ? { tasks: { ...(mockScanTask ? { scanGroups: mockScanTask } : {}), ...(mockPostTask ? { postToTargets: mockPostTask } : {}) } } : {}) }); mockServiceDeps = deps; mockServiceInstance = this; }
        },
    };
});
jest.mock('../../services/facebookPoster/PostTracker', () => {
    const actual = jest.requireActual('../../services/facebookPoster/PostTracker');
    return { ...actual, PostTracker: class extends actual.PostTracker {
        constructor(deps: any) { super(deps); mockTrackerDeps = deps; }
    } };
});
jest.mock('../../services/facebookPoster/CommentCollector', () => {
    const actual = jest.requireActual('../../services/facebookPoster/CommentCollector');
    return { ...actual, CommentCollector: class extends actual.CommentCollector {
        constructor(deps: any) { super(deps); mockCollectorDeps = deps; }
    } };
});
jest.mock('../../services/dailyBrief/PageLearner', () => {
    const actual = jest.requireActual('../../services/dailyBrief/PageLearner');
    return { ...actual, PageLearner: class extends actual.PageLearner {
        constructor(deps: any) { super(deps); mockLearnerDeps = deps; }
    } };
});
jest.mock('../../services/dailyBrief/pageCampaignExecution', () => ({
    ...jest.requireActual('../../services/dailyBrief/pageCampaignExecution'),
    createPageCampaignExecutionGuard: () => ({ assertCurrent: () => {}, variantIndex: 0 }),
}));
jest.mock('../../services/research/graphqlSession', () => ({ GraphqlSession: class {} }));
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({
    openForAutomation: (id: string) => mockOpen(id),
    onAvailabilityChanged: (listener: () => void) => { mockNativeListeners.add(listener); return () => mockNativeListeners.delete(listener); },
    tryReserveAutomation: (profileId: string) => ({ profileId }),
    releaseAutomationReservation: () => {}, isRunning: (id: string) => mockNativeRunning.has(id), canReserveAutomation: () => true,
}), isBrowserEngineInstalled: () => true }));
jest.mock('../../../electron/ipc/researchIpc', () => ({
    getResearchStore: () => ({}), getResearchService: () => ({}), isResearchRunning: () => mockResearchRunning,
    cancelResearch: () => {}, cancelAndWaitResearch: () => mockResearchDrain(), retireResearchService: () => {},
}));
jest.mock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => mockSwitching }));
jest.mock('../../services/control/controlEvents', () => ({
    buildPagesLearnFinished: jest.requireActual('../../services/control/controlEvents').buildPagesLearnFinished,
    emitControlEvent: jest.fn(), hasControlEventSink: () => false, buildRunStarted: jest.fn(), buildRunFinished: jest.fn(), buildScheduleMissed: jest.fn(),
    buildDraftApproved: jest.fn(), buildLoginProblem: jest.fn(), buildCheckFinished: jest.fn(), buildTrackFinished: jest.fn(), buildLeadsFound: jest.fn((p: unknown) => p), buildCollectFinished: jest.fn((p: unknown) => p),
}));

jest.mock('../../services/dailyBrief/pageIdentity', () => ({ ...jest.requireActual('../../services/dailyBrief/pageIdentity'), readPageIdentity: (...args: any[]) => mockRead(...args) }));

import { getProfileJobBinding, getBoundPageCampaignCollector, listFacebookPosterRunProfileIds, setPageCampaignExecutionContext, stopPageCampaignExecution, learnPages, isPageLearnerRunning, cancelFacebookPosterJobs, cancelAndWaitFacebookPosterJobs, startFacebookPosterScheduler, stopFacebookPosterScheduler, posterOperations, registerFacebookPosterIpc, campaignOperations, trackingOperations, leadOperations, isFacebookPosterBusy } from '../../../electron/ipc/facebookPosterIpc';

const NOW = Date.now();
const schedule = (campaignId: string | null, params: Record<string, unknown> = {}) => ({
    id: 's1', name: 's1', kind: 'once' as const, params, runAt: NOW, days: [], time: '', enabled: true, draft: false,
    campaignId, nextRunAt: NOW, lastRunId: null, createdAt: NOW, updatedAt: NOW,
});

beforeAll(() => {
    new FacebookPosterStore(mockDb).ensureSchema();
    startFacebookPosterScheduler();
});
afterAll(() => { stopFacebookPosterScheduler(); fs.rmSync(mockDir, { recursive: true, force: true }); });

/** Workers are per run: build one in the current generation instead of relying on whichever test built the last one. */
async function currentWorkerDeps(): Promise<void> {
    mockScanTask = async () => ({ groups: [] });
    try {
        posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'] } });
        await mockServiceInstance.whenIdle();
    } finally { mockScanTask = undefined; }
}

describe('facebookPosterIpc wiring', () => {
    test('aggregate does not authorize DB close until critical uncertainty settles into the originating store', async () => {
        let release!: () => void;
        const critical = new Promise<void>(resolve => { release = resolve; });
        let entered = false;
        const BrowserClosedError = require('../../services/facebookPoster/postToTargets').BrowserClosedError;
        mockOpen.mockResolvedValueOnce({ context: { once: jest.fn(), pages: () => [{}], cookies: async () => [{ name: 'c_user', value: 'synthetic' }] }, close: async () => {} });
        mockPostTask = async (_input, deps) => { await deps.launch(); deps.enterCritical(); entered = true; await critical; throw new BrowserClosedError('closed after submit'); };
        const originalStore = new FacebookPosterStore(mockDb);
        const started = posterOperations.start({ kind: 'post', params: {
            mode: 'group', text: 'Test', mediaPaths: [], profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }],
        } });
        await new Promise(resolve => setImmediate(resolve));
        expect(entered).toBe(true);
        mockSwitching = true;
        let dbClosed = false;
        let codeBeforeClose: string | null | undefined;
        const draining = cancelAndWaitFacebookPosterJobs().then(stopped => {
            if (stopped) { codeBeforeClose = originalStore.getRun(started.runId)?.results[0]?.errorCode; dbClosed = true; }
            return stopped;
        });
        await new Promise(resolve => setImmediate(resolve));
        const closedWhileCritical = dbClosed;
        release();
        try {
            expect(await draining).toBe(true);
            expect(closedWhileCritical).toBe(false);
            expect(dbClosed).toBe(true);
            expect(codeBeforeClose).toBe('uncertain_after_submit');
            expect(originalStore.getRun(started.runId)?.run.status).not.toBe('running');
        } finally {
            mockSwitching = false; mockPostTask = undefined;
            mockDb.run('DELETE FROM fb_poster_results WHERE run_id=?', [started.runId]);
            mockDb.run('DELETE FROM fb_poster_runs WHERE id=?', [started.runId]);
            startFacebookPosterScheduler();
        }
    });

    test('aggregate drain waits for research after both real poster workers settle', async () => {
        const gates: (() => void)[] = [];
        mockScanTask = async () => { await new Promise<void>(resolve => gates.push(resolve)); return { groups: [] }; };
        let finishResearch!: (stopped: boolean) => void;
        mockResearchRunning = true;
        mockResearchDrain.mockReturnValueOnce(new Promise<boolean>(resolve => { finishResearch = resolve; }));
        const params = { kind: 'scan_groups', params: { profileIds: ['p1'] } };
        posterOperations.start(params); posterOperations.start(params);
        await new Promise(resolve => setImmediate(resolve));
        let result: boolean | undefined;
        const draining = cancelAndWaitFacebookPosterJobs().then(value => { result = value; return value; });
        gates.forEach(resolve => resolve());
        await new Promise(resolve => setImmediate(resolve));
        const prematureResult = result;
        mockResearchRunning = false; finishResearch(true);
        try {
            expect(await draining).toBe(true);
            expect(prematureResult).toBeUndefined();
            expect(listFacebookPosterRunProfileIds()).toEqual([]);
        } finally { mockScanTask = undefined; mockResearchRunning = false; startFacebookPosterScheduler(); }
    });

    test('aggregate drain refuses retirement while a released queue lease still has native ownership', async () => {
        const binding = getProfileJobBinding();
        mockOpen.mockResolvedValueOnce({ context: { once: jest.fn() }, close: async () => {} });
        mockNativeRunning.add('pending-close');
        const session = await binding.openForAutomation('pending-close', {
            jobId: 'pending-release', signal: new AbortController().signal, priority: 'interactive', assertCurrent: () => {},
        });
        await session.close();
        jest.useFakeTimers();
        try {
            const drain = cancelAndWaitFacebookPosterJobs();
            await jest.advanceTimersByTimeAsync(55000);
            expect(await drain).toBe(false);
            expect(isFacebookPosterBusy()).toBe(true);
            expect(() => require('../../../electron/ipc/facebookPosterIpc').retireFacebookJobGeneration()).toThrow();
        } finally {
            mockNativeRunning.clear(); for (const listener of mockNativeListeners) listener();
            jest.useRealTimers(); startFacebookPosterScheduler();
        }
        expect(await cancelAndWaitFacebookPosterJobs()).toBe(true);
        startFacebookPosterScheduler();
    });

    test('retired A generation callbacks cannot write or wake reopened A and old queue cannot acquire', async () => {
        const ipc = require('../../../electron/ipc/facebookPosterIpc');
        const originalName = mockDbName;
        mockScanTask = async () => ({ groups: [] });
        const first = posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'] } });
        const oldDeps = mockServiceDeps;
        const oldBinding = getProfileJobBinding();
        const oldTimer = mockLoginSchedulerDeps;
        const oldSchedule = capturedDeps;
        await mockServiceInstance.whenIdle();
        oldDeps.onLoginObserved('retired-login', 'ok');
        try {
            expect(await cancelAndWaitFacebookPosterJobs()).toBe(true); ipc.retireFacebookJobGeneration();
            mockDbName = 'generation-b.sqlite'; startFacebookPosterScheduler();
            expect(await cancelAndWaitFacebookPosterJobs()).toBe(true); ipc.retireFacebookJobGeneration();
            mockDbName = originalName; startFacebookPosterScheduler();
            mockRunFinished.mockClear();
            oldDeps.onLoginObserved('retired-login', 'checkpoint');
            oldDeps.emit('facebookPoster:runFinished', { runId: first.runId, status: 'done' });
            await expect(oldBinding.openForAutomation('p1', {
                jobId: 'retired-queue', signal: new AbortController().signal, priority: 'interactive', assertCurrent: () => {},
            })).rejects.toThrow();
            expect(new FacebookPosterStore(mockDb).listLoginStates().find(row => row.profileId === 'retired-login')?.state).toBe('ok');
            expect(mockRunFinished).not.toHaveBeenCalled();
            const readSetting = jest.spyOn(mockDatabaseInstance, 'getSetting');
            const emit = require('../../services/event/EventBroadcaster').default.emit as jest.Mock;
            emit.mockClear();
            try {
                expect(() => oldTimer.readConfig()).toThrow();
                oldSchedule.onChanged();
                expect(readSetting).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
            } finally { readSetting.mockRestore(); }
        } finally {
            mockScanTask = undefined; mockDbName = originalName;
            await cancelAndWaitFacebookPosterJobs(); startFacebookPosterScheduler();
        }
    });

    test('paused login admission creates no checker job and same-generation resume allows retry', async () => {
        const ipc = require('../../../electron/ipc/facebookPosterIpc');
        ipc.pauseFacebookJobAdmission();
        let rejected = false;
        try { ipc.checkFacebookLogins([], 'manual'); } catch { rejected = true; }
        await cancelAndWaitFacebookPosterJobs();
        ipc.resumeFacebookJobAdmission();
        expect(rejected).toBe(true);
        expect(() => ipc.checkFacebookLogins([], 'manual')).not.toThrow();
        await cancelAndWaitFacebookPosterJobs(); startFacebookPosterScheduler();
    });

    test('aggregate busy includes research even with no current poster run', () => {
        mockResearchRunning = true;
        try { expect(isFacebookPosterBusy()).toBe(true); }
        finally { mockResearchRunning = false; }
    });

    test('lifecycle pause rejects side admission before creating a job and resumes the same generation', () => {
        const ipc = require('../../../electron/ipc/facebookPosterIpc');
        const binding = getProfileJobBinding();
        ipc.pauseFacebookJobAdmission();
        try {
            expect(() => binding.assertCurrent()).not.toThrow(); // Pausing admission must not invalidate settlement.
            expect(() => learnPages(['p1'], false)).toThrow();
            expect(isPageLearnerRunning()).toBe(false);
        } finally { ipc.resumeFacebookJobAdmission(); }
        expect(() => binding.assertCurrent()).not.toThrow();
    });
    test('real scheduler publication preserves failed due-read backoff and recovers without a retry loop', async () => {
        // Schedules other tests leave in the shared DB would arm timers or yield hints this test does not own.
        mockDb.run('DELETE FROM fb_poster_schedules');
        stopFacebookPosterScheduler();
        jest.useFakeTimers(); jest.setSystemTime(NOW);
        mockUseRealScheduler = true; mockDbName = 'retry-test.sqlite';
        const { ERROR_RETRY_MS, MISSED_APP_CLOSED } = jest.requireActual('../../services/facebookPoster/FacebookPosterScheduler');
        const store = new FacebookPosterStore(mockDb), id = 'retry-publication';
        store.createSchedule({ ...schedule(null), id, runAt: NOW - 1, nextRunAt: NOW - 1 } as any);
        const originalRead = FacebookPosterStore.prototype.listDueSchedules;
        let failing = true;
        const dueRead = jest.spyOn(FacebookPosterStore.prototype, 'listDueSchedules').mockImplementation(function (this: FacebookPosterStore, now: number) {
            if (failing) throw new Error('synthetic due read failure');
            return originalRead.call(this, now);
        });
        const timers = jest.spyOn(global, 'setTimeout');
        const emit = require('../../services/event/EventBroadcaster').default.emit as jest.Mock;
        emit.mockClear();
        mockOpen.mockImplementation(async () => ({ context: { once: jest.fn() }, close: async () => {} }));
        const touchQueue = async () => {
            const opened = await getProfileJobBinding().openForAutomation('p2', {
                jobId: 'backoff-resource', priority: 'interactive', signal: new AbortController().signal, assertCurrent: () => {},
            });
            await opened.close();
        };
        try {
            expect(store.nextScheduledAt()).toBe(NOW - 1);
            startFacebookPosterScheduler();
            await touchQueue(); // Real queue grant/release notifications reach the real scheduler.
            expect(dueRead).toHaveBeenCalledTimes(1);
            expect(timers.mock.calls[timers.mock.calls.length - 1][1]).toBeGreaterThanOrEqual(ERROR_RETRY_MS);
            expect(jest.getTimerCount()).toBe(1);
            await jest.advanceTimersByTimeAsync(ERROR_RETRY_MS - 1);
            await touchQueue(); // Must neither reset backoff to zero nor postpone the original retry.
            expect(dueRead).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(1);
            expect(dueRead).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(ERROR_RETRY_MS);
            expect(dueRead).toHaveBeenCalledTimes(3);
            expect(timers.mock.calls.every(call => Number(call[1]) >= ERROR_RETRY_MS)).toBe(true);
            failing = false;
            await jest.advanceTimersByTimeAsync(ERROR_RETRY_MS);
            expect(dueRead).toHaveBeenCalledTimes(4);
            expect(store.getSchedule(id)!.nextRunAt).toBeNull();
            expect(store.getRun(store.getSchedule(id)!.lastRunId!)!.run).toMatchObject({ status: 'missed', error: MISSED_APP_CLOSED });
            expect(jest.getTimerCount()).toBe(0);
            expect(emit.mock.calls.filter(call => call[0] === 'facebookPoster:schedulesChanged')).toHaveLength(4);
        } finally {
            stopFacebookPosterScheduler(); dueRead.mockRestore(); timers.mockRestore(); store.deleteSchedule(id); mockOpen.mockReset();
            mockUseRealScheduler = false; jest.useRealTimers(); mockDbName = 'db.sqlite'; startFacebookPosterScheduler();
        }
    });
    test('real scheduler recovery wakes the background queue before its one-hour defer cap', async () => {
        // Schedules other tests leave in the shared DB would arm timers or yield hints this test does not own.
        mockDb.run('DELETE FROM fb_poster_schedules');
        stopFacebookPosterScheduler(); jest.useFakeTimers(); jest.setSystemTime(NOW);
        mockUseRealScheduler = true; mockDbName = 'recovery-wakeup.sqlite';
        const { ERROR_RETRY_MS, MISSED_APP_CLOSED } = jest.requireActual('../../services/facebookPoster/FacebookPosterScheduler');
        const store = new FacebookPosterStore(mockDb), id = 'recovery-wakeup', dueAt = NOW + 1000;
        store.createSchedule({ ...schedule(null), id, runAt: dueAt, nextRunAt: dueAt,
            params: { profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1'] }] } } as any);
        const originalRead = FacebookPosterStore.prototype.listDueSchedules;
        let failing = true;
        const dueRead = jest.spyOn(FacebookPosterStore.prototype, 'listDueSchedules').mockImplementation(function (this: FacebookPosterStore, now: number) {
            if (failing && now >= dueAt) throw new Error('synthetic due read failure');
            return originalRead.call(this, now);
        });
        const timers = jest.spyOn(global, 'setTimeout');
        const openedAt: number[] = [], abort = new AbortController();
        mockOpen.mockImplementation(async () => {
            openedAt.push(Date.now()); return { context: { once: jest.fn() }, close: async () => {} };
        });
        let pending: Promise<void> | undefined;
        try {
            startFacebookPosterScheduler();
            pending = getProfileJobBinding().openForAutomation('p1', {
                jobId: 'deferred-background', priority: 'background', signal: abort.signal, assertCurrent: () => {},
                deadlineAt: NOW + 7_200_000,
            }).then(session => session.close()).catch(error => { if (error.code !== 'profile_wait_cancelled') throw error; });
            await jest.advanceTimersByTimeAsync(1001 + 2 * ERROR_RETRY_MS);
            expect(openedAt).toEqual([]);
            expect(timers.mock.calls.some(call => Number(call[1]) >= 3_500_000)).toBe(true);
            expect(dueRead).toHaveBeenCalledTimes(4); // Initial future read plus three bounded failures.
            failing = false;
            await jest.advanceTimersByTimeAsync(ERROR_RETRY_MS);
            expect(store.getRun(store.getSchedule(id)!.lastRunId!)!.run).toMatchObject({ status: 'missed', error: MISSED_APP_CLOSED });
            expect(openedAt).toHaveLength(1);
            expect(openedAt[0]).toBeLessThanOrEqual(NOW + 91_001);
            expect(dueRead).toHaveBeenCalledTimes(5);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            abort.abort(); await pending; stopFacebookPosterScheduler(); dueRead.mockRestore(); timers.mockRestore();
            store.deleteSchedule(id); mockOpen.mockReset(); mockUseRealScheduler = false;
            jest.useRealTimers(); mockDbName = 'db.sqlite'; startFacebookPosterScheduler();
        }
    });
    test('background waits only for its profile and stops yielding after one hour; interactive bypasses future schedules', async () => {
        // Schedules other tests leave in the shared DB would arm timers or yield hints this test does not own.
        mockDb.run('DELETE FROM fb_poster_schedules');
        jest.useFakeTimers(); jest.setSystemTime(NOW);
        mockDbName = 'yield-test.sqlite'; startFacebookPosterScheduler();
        const store = new FacebookPosterStore(mockDb);
        const id = 'resource-yield';
        const controller = new AbortController();
        const opened: string[] = [];
        mockOpen.mockImplementation(async (profileId: string) => {
            opened.push(profileId);
            return { context: { once: jest.fn() }, close: async () => {} };
        });
        const binding = getProfileJobBinding();
        const context = (jobId: string, priority: 'background' | 'interactive') => ({ jobId, priority, signal: controller.signal, assertCurrent: () => {} });
        store.createSchedule({ ...schedule(null), id, params: { profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1'] }] }, nextRunAt: NOW + 300_000 } as any);
        let same: Promise<any> | undefined;
        try {
            same = binding.openForAutomation('p1', context('background-same', 'background'));
            const other = await binding.openForAutomation('p2', context('background-other', 'background'));
            expect(opened).toEqual(['p2']); await other.close();
            const interactive = await binding.openForAutomation('p1', context('interactive', 'interactive'));
            expect(opened).toEqual(['p2', 'p1']); await interactive.close();
            await jest.advanceTimersByTimeAsync(3_599_999);
            expect(opened).toEqual(['p2', 'p1']);
            await jest.advanceTimersByTimeAsync(1);
            const admitted = await same;
            expect(opened).toEqual(['p2', 'p1', 'p1']); await admitted.close();
            const afterHour = binding.openForAutomation('p1', context('new-background', 'background'));
            await Promise.resolve(); expect(opened).toHaveLength(3);
            posterOperations.scheduleDelete({ id });
            const released = await afterHour;
            expect(opened).toHaveLength(4); await released.close();
        } finally {
            controller.abort(); await same?.catch(() => {}); store.deleteSchedule(id);
            mockOpen.mockReset(); jest.useRealTimers();
            mockDbName = 'db.sqlite'; startFacebookPosterScheduler();
        }
    });
    test.each([
        ['inside', 599_999, true], ['boundary', 600_000, true], ['outside', 600_001, false],
        ['none', null, false], ['read-error', 1, false], ['draft', 1, false], ['disabled', 1, false],
    ] as const)('profile background deferral: %s', async (scenario, delay, deferred) => {
        jest.useFakeTimers(); jest.setSystemTime(NOW);
        mockDbName = `deferral-${scenario}.sqlite`; startFacebookPosterScheduler();
        // Scenario-unique profile: schedules other tests leave for p1 must not decide this deferral.
        const store = new FacebookPosterStore(mockDb), id = `deferral-${scenario}`, profileId = `deferral-profile-${scenario}`;
        if (delay !== null) store.createSchedule({ ...schedule(null), id,
            params: { profiles: [{ profileId, targets: ['https://www.facebook.com/groups/1'] }] },
            nextRunAt: NOW + delay, draft: scenario === 'draft', enabled: scenario !== 'disabled' } as any);
        const fault = scenario === 'read-error' ? jest.spyOn(FacebookPosterStore.prototype, 'listSchedules').mockImplementation(() => { throw new Error('db locked'); }) : undefined;
        const abort = new AbortController(); let admitted = false;
        mockOpen.mockImplementation(async () => ({ context: { once: jest.fn() }, close: async () => {} }));
        const pending = getProfileJobBinding().openForAutomation(profileId, {
            jobId: id, signal: abort.signal, priority: 'background', assertCurrent: () => {},
        }).then(async session => { admitted = true; await session.close(); }).catch(error => {
            if (error.code !== 'profile_wait_cancelled') throw error;
        });
        try {
            for (let i = 0; i < 12; i++) await Promise.resolve();
            expect(admitted).toBe(!deferred);
        } finally {
            abort.abort(); await pending; fault?.mockRestore(); store.deleteSchedule(id);
            mockOpen.mockReset(); jest.useRealTimers(); mockDbName = 'db.sqlite'; startFacebookPosterScheduler();
        }
    });
    test('retired timer configuration callbacks do not follow a replacement database', () => {
        const original = mockDatabaseInstance;
        const replacementRead = jest.fn(() => null);
        mockDatabaseInstance = { ...original, getSetting: replacementRead };
        try {
            mockLoginSchedulerDeps.readConfig(); mockTrackSchedulerDeps.readConfig(); mockCommentSchedulerDeps.readConfig();
            expect(replacementRead).not.toHaveBeenCalled();
            expect(mockLoginSchedulerDeps.isBusy()).toBe(true);
            expect(mockTrackSchedulerDeps.isBusy()).toBe(true);
            expect(mockCommentSchedulerDeps.isBusy()).toBe(true);
        } finally { mockDatabaseInstance = original; }
    });
    test('production composition accepts two distinct workers and rejects a third before a row is created', async () => {
        const params = { kind: 'scan_groups', params: { profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } };
        const first = posterOperations.start(params);
        const second = posterOperations.start({ ...params, params: { ...params.params, profileIds: ['p2'] } });
        try {
            expect(first.runId).not.toBe(second.runId);
            expect(mockLoginSchedulerDeps.isBusy()).toBe(false);
            expect(mockTrackSchedulerDeps.isBusy()).toBe(false);
            expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
            expect(listFacebookPosterRunProfileIds().sort()).toEqual(['p1', 'p2']);
            const before = mockDb.queryOne('SELECT COUNT(*) AS n FROM fb_poster_runs');
            expect(() => posterOperations.start(params)).toThrow('Đang có việc');
            expect(mockDb.queryOne('SELECT COUNT(*) AS n FROM fb_poster_runs')).toEqual(before);
        } finally {
            cancelFacebookPosterJobs();
            await cancelAndWaitFacebookPosterJobs();
            startFacebookPosterScheduler();
        }
    });
    test('active lists both live runs and cancel selects by runId over the real coordinator', async () => {
        const { PosterRunSelectionError } = require('../../services/facebookPoster/FacebookPosterCoordinator');
        const handlers = new Map<string, (event: unknown, params?: any) => Promise<any>>();
        (require('electron').ipcMain.handle as jest.Mock).mockImplementation((channel: string, handler: any) => { handlers.set(channel, handler); });
        registerFacebookPosterIpc();
        const invoke = (channel: string, params?: any) => handlers.get(channel)!({}, params);
        const params = { kind: 'scan_groups', params: { profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } };
        expect(posterOperations.active()).toEqual({ runs: [] });
        expect(posterOperations.cancel({})).toEqual({ cancelled: true });
        const gates: Record<string, () => void> = {};
        const waits = Object.fromEntries(['p1', 'p2'].map(id => [id, new Promise<void>(resolve => { gates[id] = resolve; })]));
        mockOpen.mockImplementation(async (id: string) => { await waits[id]; return { context: { once: jest.fn() }, close: async () => {} }; });
        const first = posterOperations.start(params);
        const second = posterOperations.start({ ...params, params: { ...params.params, profileIds: ['p2'] } });
        try {
            const ids = posterOperations.active().runs.map(({ run }: any) => run.id).sort();
            expect(ids).toEqual([first.runId, second.runId].sort());
            expect(await invoke('facebookPoster:active')).toMatchObject({ success: true, runs: expect.any(Array) });
            expect((await invoke('facebookPoster:active')).runs).toHaveLength(2);
            expect(() => posterOperations.cancel({})).toThrow(PosterRunSelectionError);
            expect(await invoke('facebookPoster:cancel', {})).toEqual({ success: false, error: 'Chọn lượt cần dừng' });
            expect(await invoke('facebookPoster:cancel', { runId: 'missing-run' })).toEqual({ success: false, error: 'Không tìm thấy lượt' });
            for (const runId of ['', 7, null, {}]) expect(() => posterOperations.cancel({ runId })).toThrow('Mã lượt không hợp lệ');
            expect(posterOperations.active().runs).toHaveLength(2);
            expect(await invoke('facebookPoster:cancel', { runId: first.runId })).toEqual({ success: true, cancelled: true });
            gates.p1();
            for (let i = 0; i < 200 && posterOperations.active().runs.some(({ run }: any) => run.id === first.runId); i++) await new Promise(resolve => setTimeout(resolve, 5));
            const store = new FacebookPosterStore(mockDb);
            expect(posterOperations.active().runs.map(({ run }: any) => run.id)).toEqual([second.runId]);
            // Only the requested run was cancelled: first is stored as cancelled, second is still live and unmarked.
            expect(store.getRun(first.runId)!.run.status).toBe('cancelled');
            expect(store.getRun(second.runId)!.run.status).toBe('running');
            expect(posterOperations.cancel({ runId: first.runId })).toEqual({ cancelled: false });
            // A run that exists only in another workspace DB is unknown to the bound coordinator/store.
            const foreign = memoryDb(); const foreignStore = new FacebookPosterStore(foreign); foreignStore.ensureSchema();
            foreignStore.createRun({ id: 'foreign-run', kind: 'scan_groups', mode: '', params: {}, startedAt: Date.now() });
            expect(() => posterOperations.cancel({ runId: 'foreign-run' })).toThrow(PosterRunSelectionError);
            expect(await invoke('facebookPoster:cancel', { runId: 'foreign-run' })).toEqual({ success: false, error: 'Không tìm thấy lượt' });
            expect(foreignStore.getRun('foreign-run')!.run.status).toBe('running');
            expect(posterOperations.active().runs.map(({ run }: any) => run.id)).toEqual([second.runId]);
            gates.p2();
            for (let i = 0; i < 200 && posterOperations.active().runs.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
            expect(posterOperations.active().runs).toEqual([]);
            expect(store.getRun(second.runId)!.run.status).not.toBe('cancelled');
            expect(store.getRun(second.runId)!.run.status).not.toBe('running');
            expect(store.getRun(first.runId)!.run.status).toBe('cancelled');
        } finally {
            gates.p1(); gates.p2(); mockOpen.mockReset();
            (require('electron').ipcMain.handle as jest.Mock).mockReset();
            cancelFacebookPosterJobs(); await cancelAndWaitFacebookPosterJobs(); startFacebookPosterScheduler();
        }
    });
    test('cancel without runId acknowledges and stops the single live run', async () => {
        let open!: () => void;
        const gate = new Promise<void>(resolve => { open = resolve; });
        mockOpen.mockImplementation(async () => { await gate; return { context: { once: jest.fn() }, close: async () => {} }; });
        const only = posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } });
        try {
            expect(posterOperations.cancel({})).toEqual({ cancelled: true });
            open();
            for (let i = 0; i < 200 && posterOperations.active().runs.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
            expect(new FacebookPosterStore(mockDb).getRun(only.runId)!.run.status).toBe('cancelled');
        } finally {
            open(); mockOpen.mockReset();
            cancelFacebookPosterJobs(); await cancelAndWaitFacebookPosterJobs(); startFacebookPosterScheduler();
        }
    });
    test('schedule deletion protects the second active worker as well as current', async () => {
        const store = new FacebookPosterStore(mockDb);
        const params = { kind: 'scan_groups' as const, profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 };
        const ids = ['delete-active-first', 'delete-active-second'];
        try {
            for (const id of ids) { store.createSchedule({ ...schedule(null), id, params } as any); capturedDeps.startRun(params, id); }
            const hiddenId = ids.find(id => id !== posterOperations.current().run?.scheduleId)!;
            expect(() => posterOperations.scheduleDelete({ id: hiddenId })).toThrow('Lịch này đang chạy');
            expect(store.getSchedule(hiddenId)).not.toBeNull();
        } finally {
            cancelFacebookPosterJobs(); await cancelAndWaitFacebookPosterJobs(); startFacebookPosterScheduler();
            for (const id of ids) store.deleteSchedule(id);
        }
    });
    test('a captured campaign drain cannot detach a newer tracking owner', async () => {
        const Tracker = require('../../services/facebookPoster/PageCampaignTracker').PageCampaignTracker;
        const context = { db: mockDb, assertCurrent: () => {}, protectedWritesEnabled: () => true } as any;
        setPageCampaignExecutionContext(context); getBoundPageCampaignCollector(mockDb);
        let oldInstance: any;
        let oldRunning = true; let replacementRunning = true;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const running = jest.spyOn(Tracker.prototype, 'isRunning').mockImplementation(function(this: any) {
            return !oldInstance || this === oldInstance ? oldRunning : replacementRunning;
        });
        const idle = jest.spyOn(Tracker.prototype, 'whenIdle').mockImplementation(function(this: any) { oldInstance = this; return gate; });
        try {
            const draining = stopPageCampaignExecution();
            oldRunning = false;
            setPageCampaignExecutionContext({ ...context }); getBoundPageCampaignCollector(mockDb);
            release(); expect(await draining).toBe(true);
            expect(isFacebookPosterBusy()).toBe(true);
        } finally {
            oldRunning = false; replacementRunning = false; release();
            await stopPageCampaignExecution(); running.mockRestore(); idle.mockRestore();
        }
    });

    test.each([1, 2])('campaign retirement cancels %i managed workers without cancelling a manual worker', async managedCount => {
        const gates: (() => void)[] = [];
        const stopping: (() => boolean)[] = [];
        mockScanTask = async deps => {
            stopping.push(deps.getIsStopping);
            await new Promise<void>(resolve => { gates.push(resolve); });
            return { groups: [] };
        };
        setPageCampaignExecutionContext({ db: mockDb, assertCurrent: () => {}, protectedWritesEnabled: () => true } as any);
        getBoundPageCampaignCollector(mockDb);
        const Tracker = require('../../services/facebookPoster/PageCampaignTracker').PageCampaignTracker;
        let releaseTracking!: () => void;
        const trackingGate = new Promise<void>(resolve => { releaseTracking = resolve; });
        const trackingRunning = jest.spyOn(Tracker.prototype, 'isRunning').mockReturnValue(true);
        const trackingIdle = jest.spyOn(Tracker.prototype, 'whenIdle').mockReturnValue(trackingGate);
        const store = new FacebookPosterStore(mockDb);
        const params = { kind: 'scan_groups' as const, profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 };
        const workers: any[] = [];
        try {
            for (let i = 0; i < 2; i++) {
                if (i < managedCount) {
                    const id = `managed-${managedCount}-${i}`;
                    store.createSchedule({ ...schedule(null), id, params } as any);
                    mockDb.run("UPDATE fb_poster_schedules SET authority_kind='autonomy' WHERE id=?", [id]);
                    capturedDeps.startRun(params, id);
                } else posterOperations.start({ kind: 'scan_groups', params });
                workers.push(mockServiceInstance);
            }
            await new Promise(resolve => setImmediate(resolve));
            expect(stopping).toHaveLength(2);
            const retired = stopPageCampaignExecution();
            await Promise.resolve();
            expect(stopping.map(isStopping => isStopping())).toEqual(managedCount === 1 ? [true, false] : [true, true]);
            for (let i = 0; i < managedCount; i++) gates[i]();
            trackingRunning.mockReturnValue(false); releaseTracking();
            expect(await retired).toBe(true);
            if (managedCount === 1) expect(workers[1].current()).not.toBeNull();
        } finally {
            trackingRunning.mockReturnValue(false); releaseTracking();
            cancelFacebookPosterJobs(); gates.forEach(release => release()); await cancelAndWaitFacebookPosterJobs();
            trackingRunning.mockRestore(); trackingIdle.mockRestore();
            startFacebookPosterScheduler(); mockScanTask = undefined;
            mockDb.run("DELETE FROM fb_poster_schedules WHERE id LIKE 'managed-%'");
        }
    });
    test('manual lead batches belong to each production worker and finish independently', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        mockOpen.mockImplementation(async () => { await gate; return { context: { once: jest.fn(), pages: () => [{}] }, close: async () => {} }; });
        const request = { kind: 'scan_groups', params: { profileIds: ['p1'] } };
        const first = posterOperations.start(request); const firstDeps = mockServiceDeps;
        const second = posterOperations.start(request); const secondDeps = mockServiceDeps;
        const emit = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        const comment = (key: string) => ({ key, profileId: 'p1', postUrl: `https://x/${key}`, authorId: key,
            authorName: key, authorUrl: '', text: 'ib mình báo giá nhé', commentedAt: '', commentedAtMs: null, collectedAt: Date.now() });
        try {
            await firstDeps.onCommentsSaved([comment('isolated-first')]);
            await secondDeps.onCommentsSaved([comment('isolated-second')]);
            emit.mockClear();
            firstDeps.emit('facebookPoster:runFinished', { runId: second.runId, status: 'done' });
            expect(emit.mock.calls.filter(call => call[0] === 'leads.found')).toHaveLength(0);
            secondDeps.emit('facebookPoster:runFinished', { runId: second.runId, status: 'done' });
            firstDeps.emit('facebookPoster:runFinished', { runId: first.runId, status: 'done' });
            const batches = emit.mock.calls.filter(call => call[0] === 'leads.found').map(call => call[1]);
            expect(batches.map(batch => batch.count)).toEqual([1, 1]);
            expect(batches.map(batch => batch.samples[0].authorName)).toEqual(['isolated-second', 'isolated-first']);
            expect(firstDeps.newId()).toBe(first.runId); expect(secondDeps.newId()).toBe(second.runId);
        } finally {
            cancelFacebookPosterJobs(); release(); await cancelAndWaitFacebookPosterJobs();
            startFacebookPosterScheduler(); mockOpen.mockReset();
        }
    });
    test('cached login observer persists old state without replacement DB reads or stale notifications', async () => {
        await currentWorkerDeps();
        const emit = require('../../services/event/EventBroadcaster').default.emit as jest.Mock;
        const control = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        const original = mockDatabaseInstance;
        const oldStore = new FacebookPosterStore(mockDb);
        mockServiceDeps.onLoginObserved('observer-profile', 'ok');
        emit.mockClear(); control.mockClear();
        mockServiceDeps.onLoginObserved('observer-profile', 'logged_out');
        expect(emit).toHaveBeenCalledWith('facebookPoster:loginStateChanged', expect.any(Array));
        expect(control.mock.calls.some(call => call[0] === 'profile.loginProblem')).toBe(true);
        const replacement = memoryDb(); const replacementStore = new FacebookPosterStore(replacement); replacementStore.ensureSchema();
        const query = jest.spyOn(replacement, 'query'); const queryOne = jest.spyOn(replacement, 'queryOne');
        const getBrowserProfileById = jest.fn(original.getBrowserProfileById);
        mockDatabaseInstance = { ...original, ...replacement, getBrowserProfileById };
        emit.mockClear(); control.mockClear(); mockRunFinished.mockClear();
        try {
            mockServiceDeps.onLoginObserved('observer-profile', 'checkpoint');
            expect(oldStore.listLoginStates()).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: 'observer-profile', state: 'checkpoint' })]));
            expect(query).not.toHaveBeenCalled(); expect(queryOne).not.toHaveBeenCalled(); expect(getBrowserProfileById).not.toHaveBeenCalled();
            expect(replacementStore.listLoginStates()).toEqual([]);
            expect(emit).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled(); expect(mockRunFinished).not.toHaveBeenCalled();
        } finally { mockDatabaseInstance = original; }
    });

    test('side factories retain old stores and suppress stale outward callbacks independently', async () => {
        trackingOperations.track({}); leadOperations.collect({}); learnPages(['p1'], true);
        await new Promise(resolve => setImmediate(resolve));
        const oldLearnerStore = mockLearnerDeps.store();
        const original = mockDatabaseInstance;
        const replacement = memoryDb(); new FacebookPosterStore(replacement).ensureSchema();
        const query = jest.spyOn(replacement, 'query'); const queryOne = jest.spyOn(replacement, 'queryOne');
        const getSetting = jest.fn(() => null);
        const emit = require('../../services/event/EventBroadcaster').default.emit as jest.Mock;
        const control = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        mockDatabaseInstance = { ...original, ...replacement, getSetting };
        emit.mockClear(); control.mockClear(); mockRunFinished.mockClear();
        try {
            mockTrackerDeps.getConfig(); mockTrackerDeps.getLeadConfig(); mockCollectorDeps.readConfig();
            expect(mockLearnerDeps.store()).toBe(oldLearnerStore);
            mockTrackerDeps.observeLogin('old-track', 'logged_out');
            mockCollectorDeps.observeLogin('old-collect', 'checkpoint');
            mockTrackerDeps.emit('posts.trackFinished', { jobId: 'late' });
            mockCollectorDeps.emit('comments.collectFinished', { jobId: 'late' });
            mockCollectorDeps.emit('leads.found', { count: 1 });
            expect(new FacebookPosterStore(mockDb).listLoginStates()).toEqual(expect.arrayContaining([
                expect.objectContaining({ profileId: 'old-track', state: 'logged_out' }),
                expect.objectContaining({ profileId: 'old-collect', state: 'checkpoint' }),
            ]));
            expect(query).not.toHaveBeenCalled(); expect(queryOne).not.toHaveBeenCalled(); expect(getSetting).not.toHaveBeenCalled();
            expect(emit).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled(); expect(mockRunFinished).not.toHaveBeenCalled();
        } finally { mockDatabaseInstance = original; }
    });
    test('during a switch drain on the captured DB, side-job finishes still settle while progress stays live-only', async () => {
        trackingOperations.track({}); leadOperations.collect({}); learnPages(['p1'], true);
        await new Promise(resolve => setImmediate(resolve));
        const emit = require('../../services/event/EventBroadcaster').default.emit as jest.Mock;
        const control = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        emit.mockClear(); control.mockClear();
        mockSwitching = true;
        try {
            mockTrackerDeps.emit('posts.trackProgress', { jobId: 'drain' });
            mockCollectorDeps.emit('comments.collectProgress', { jobId: 'drain' });
            expect(emit).not.toHaveBeenCalled();
            mockTrackerDeps.emit('posts.trackFinished', { jobId: 'drain' });
            mockCollectorDeps.emit('leads.found', { count: 1 });
            mockCollectorDeps.emit('comments.collectFinished', { jobId: 'drain' });
            mockLearnerDeps.onFinished({ jobId: 'drain', results: [] });
            expect(emit.mock.calls.map(c => c[0])).toEqual(['facebookPoster:trackFinished', 'facebookPoster:leadsFound', 'facebookPoster:commentCollectFinished']);
            expect(control.mock.calls.map(c => c[0])).toEqual(['posts.trackFinished', 'leads.found', 'comments.collectFinished', 'pages.learnFinished']);
        } finally { mockSwitching = false; }
    });
    test('late completion and config reads stay on the captured DB, stale lease cannot open', async () => {
        await currentWorkerDeps();
        const original = mockDatabaseInstance;
        const replacement = memoryDb();
        const replacementStore = new FacebookPosterStore(replacement); replacementStore.ensureSchema();
        const controller = new AbortController();
        const lease = await mockServiceDeps.acquireProfile('p1', { jobId: 'stale-lease', signal: controller.signal, priority: 'interactive', assertCurrent: () => {} });
        const started = posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } });
        const getSetting = jest.fn(() => null);
        mockDatabaseInstance = { ...original, ...replacement, getSetting };
        try {
            mockServiceDeps.readLeadConfig(); mockServiceDeps.readTrackingConfig();
            expect(getSetting).not.toHaveBeenCalled();
            await expect(lease.open()).rejects.toThrow('Đang đổi workspace');
            await mockServiceInstance.whenIdle();
            expect(new FacebookPosterStore(mockDb).getRun(started.runId)!.run.status).not.toBe('running');
            expect(replacementStore.getRun(started.runId)).toBeNull();
        } finally { lease.release(); mockDatabaseInstance = original; }
    });
    test('campaignBlock: không chiến dịch / chiến dịch mất không chặn; tạm dừng và lưu trữ chặn', () => {
        const { campaign } = campaignOperations.create({ name: 'Tết' });
        expect(capturedDeps.campaignBlock(schedule(null), NOW)).toBeNull();
        expect(capturedDeps.campaignBlock(schedule('missing'), NOW)).toBeNull();
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBeNull();
        campaignOperations.update({ id: campaign.id, status: 'paused' });
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBe('Chiến dịch đang tạm dừng');
        campaignOperations.update({ id: campaign.id, status: 'archived' });
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBe('Chiến dịch đã lưu trữ');
    });

    test('campaign operations gọi reschedule của scheduler', () => {
        mockReschedule.mockClear();
        campaignOperations.create({ name: 'Khác' });
        expect(mockReschedule).toHaveBeenCalledTimes(1);
    });

    test('resolveParams lấy campaignId từ cột lịch, bỏ qua giá trị trong params_json', () => {
        const base = { mode: 'group', text: 'Xin chào', mediaPaths: [], profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] };
        expect(capturedDeps.resolveParams(schedule('c9', { ...base, campaignId: 'other' })).campaignId).toBe('c9');
        expect(capturedDeps.resolveParams(schedule(null, { ...base, campaignId: 'other' })).campaignId).toBeNull();
    });

    test('scheduleCreate / scheduleUpdate / scheduleList gắn chiến dịch và từ chối chiến dịch lạ hoặc lưu trữ', () => {
        mockDb.run('DELETE FROM fb_poster_schedules');
        const active = campaignOperations.create({ name: 'Đang chạy' }).campaign;
        const archived = campaignOperations.create({ name: 'Cũ' }).campaign;
        campaignOperations.update({ id: archived.id, status: 'archived' });
        const body = { kind: 'recurring', days: [1], time: '09:30', params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] } };
        expect(() => posterOperations.scheduleCreate({ ...body, campaignId: 'nope' })).toThrow('Không tìm thấy chiến dịch');
        expect(() => posterOperations.scheduleCreate({ ...body, campaignId: archived.id })).toThrow('Chiến dịch đã lưu trữ');
        const created = posterOperations.scheduleCreate({ ...body, campaignId: active.id }).schedule!;
        expect(created.campaignId).toBe(active.id);
        expect(() => posterOperations.scheduleUpdate({ id: created.id, campaignId: archived.id })).toThrow('Chiến dịch đã lưu trữ');
        expect(posterOperations.scheduleList({ campaignId: active.id }).schedules.map((s) => s.id)).toEqual([created.id]);
        expect(posterOperations.scheduleList({ campaignId: '' }).schedules).toEqual([]);
        mockClearBypass.mockClear();
        expect(posterOperations.scheduleUpdate({ id: created.id, campaignId: null }).schedule!.campaignId).toBeNull();
        posterOperations.scheduleUpdate({ id: created.id, name: 'Đổi tên' });
        expect(mockClearBypass).not.toHaveBeenCalled(); // đổi tên / chiến dịch giữ "Đăng ngay" đang chờ
        posterOperations.scheduleUpdate({ id: created.id, time: '10:45' });
        expect(mockClearBypass).toHaveBeenCalledWith(created.id);
        expect(() => posterOperations.scheduleList({ campaignId: 5 })).toThrow('campaignId không hợp lệ');
    });

    test('draftApprove "now" cho lượt đó bỏ qua kiểm chiến dịch; hẹn giờ thì không', () => {
        const params = { mode: 'group', text: 'Bài nháp', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] };
        const now = posterOperations.draftSave({ params }).schedule;
        mockBypass.mockClear();
        posterOperations.draftApprove({ id: now.id, when: 'now' });
        expect(mockBypass).toHaveBeenCalledWith(now.id);
        const later = posterOperations.draftSave({ params }).schedule;
        mockBypass.mockClear();
        posterOperations.draftApprove({ id: later.id, when: 'scheduled', kind: 'once', runAt: NOW + 3_600_000 });
        expect(mockBypass).not.toHaveBeenCalled();
    });

    test('trackingOperations.list / stats nhận và kiểm campaignId, scheduleId, groupBy mới', () => {
        expect(trackingOperations.stats({ groupBy: 'campaign' }).rows).toEqual([]);
        expect(trackingOperations.stats({ groupBy: 'variant', campaignId: '', scheduleId: 's1' }).rows).toEqual([]);
        expect(trackingOperations.list({ campaignId: '', scheduleId: 's1' }).total).toBe(0);
        expect(() => trackingOperations.stats({ groupBy: 'campaign', campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.stats({ groupBy: 'campaign', scheduleId: '' })).toThrow('scheduleId không hợp lệ');
        expect(() => trackingOperations.list({ scheduleId: '' })).toThrow('scheduleId không hợp lệ');
        expect(() => trackingOperations.list({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
    });

    test('trackingOperations.groupScores / bestTimes trả đúng hình dạng và kiểm tham số; stats nhận hour / weekday', () => {
        expect(trackingOperations.groupScores({})).toEqual({ groups: [] });
        expect(trackingOperations.groupScores({ campaignId: '' })).toEqual({ groups: [] });
        expect(trackingOperations.bestTimes({})).toEqual({ hours: [], weekdays: [], insufficient: true });
        expect(trackingOperations.bestTimes({ groupUrl: 'https://facebook.com/groups/1', campaignId: 'c1' }).insufficient).toBe(true);
        expect(trackingOperations.stats({ groupBy: 'hour' }).rows).toEqual([]);
        expect(trackingOperations.stats({ groupBy: 'weekday' }).rows).toEqual([]);
        expect(() => trackingOperations.groupScores({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.groupScores({ from: 10, to: 5 })).toThrow('Khoảng thời gian không hợp lệ');
        expect(() => trackingOperations.bestTimes({ groupUrl: '' })).toThrow('groupUrl không hợp lệ');
        expect(() => trackingOperations.bestTimes({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.stats({ groupBy: 'minute' })).toThrow('groupBy phải là');
    });

    test('leadOperations.list / update kiểm status, note, id và cập nhật khách', () => {
        const now = Date.now();
        const created = new FacebookPosterStore(mockDb).createLeads([{
            commentKey: 'k-ops', postUrl: 'https://www.facebook.com/groups/1/posts/9/', resultId: null, groupUrl: '', campaignId: null, variant: '',
            profileId: 'p1', authorId: 'a', authorName: 'An', authorUrl: '', text: 'giá bao nhiêu', commentedAtMs: null, matched: ['giá'],
            aiIntent: null, aiScore: null, aiReason: null, status: 'new', note: '', detectedAt: now, updatedAt: now,
        }]);
        const id = created[0].id;
        expect(leadOperations.list({ status: 'new' }).leads.map((l) => l.id)).toContain(id);
        expect(() => leadOperations.list({ status: 'done' })).toThrow('status phải là');
        expect(() => leadOperations.list({ from: 'x' })).toThrow('from không hợp lệ');
        expect(() => leadOperations.list({ search: 5 })).toThrow('search phải là');
        expect(() => leadOperations.update({ id: 0, status: 'won' })).toThrow('id khách không hợp lệ');
        expect(() => leadOperations.update({ id })).toThrow('Cần status hoặc note');
        expect(() => leadOperations.update({ id, status: 'lost' })).toThrow('status phải là');
        expect(() => leadOperations.update({ id, note: 'x'.repeat(1001) })).toThrow('note phải là');
        expect(() => leadOperations.update({ id, note: 5 })).toThrow('note phải là');
        expect(() => leadOperations.update({ id: 99999, status: 'won' })).toThrow('Không tìm thấy khách');
        expect(leadOperations.update({ id, status: 'contacted', note: 'x'.repeat(1000) }).lead.status).toBe('contacted');
        expect(leadOperations.list({ status: 'new' }).leads.map((l) => l.id)).not.toContain(id);
    });

    test('leadOperations.setConfig kiểm cấu hình; getConfig trả mặc định khi chưa lưu', () => {
        expect(leadOperations.getConfig().config.collectAtMinutes).toEqual([120, 1440, 4320]);
        expect(() => leadOperations.setConfig({ ...leadOperations.getConfig().config, aiMinScore: 101 })).toThrow();
        expect(() => leadOperations.setConfig({ ...leadOperations.getConfig().config, collectAtMinutes: [60, 30] })).toThrow('tăng dần');
        expect(leadOperations.setConfig(leadOperations.getConfig().config).config.aiMinScore).toBe(60);
    });

    test('leadOperations.collect kiểm postUrls; comments kiểm và lọc since', () => {
        expect(() => leadOperations.collect({ postUrls: [] })).toThrow('postUrls phải là');
        expect(() => leadOperations.collect({ postUrls: [5] })).toThrow('postUrls phải là');
        expect(() => leadOperations.collect({ postUrls: Array.from({ length: 51 }, (_, i) => `https://x/${i}`) })).toThrow('postUrls phải là');
        expect(() => leadOperations.comments({ since: 'x' })).toThrow('since không hợp lệ');
        expect(() => leadOperations.comments({ postUrl: '' })).toThrow('postUrl không hợp lệ');
        const s = new FacebookPosterStore(mockDb);
        s.saveComments('p1', [{ postUrl: 'https://x/since', authorId: 'a', authorName: 'A', authorUrl: '', text: 'cũ', commentedAt: '' }], 100);
        s.saveComments('p1', [{ postUrl: 'https://x/since', authorId: 'b', authorName: 'B', authorUrl: '', text: 'mới', commentedAt: '' }], 900);
        expect(leadOperations.comments({ postUrl: 'https://x/since', since: 500 }).comments.map((c) => c.text)).toEqual(['mới']);
    });

    test('lượt thu bình luận thủ công (collect_comments) chuyển bình luận mới cho bộ lọc khách (auto = false)', async () => {
        await currentWorkerDeps(); // dựng worker của generation hiện tại
        const text = 'cho mình hỏi giá sản phẩm này';
        await mockServiceDeps.onCommentsSaved([{
            key: 'manual-k1', profileId: 'p1', postUrl: 'https://x/manual', authorId: 'a1', authorName: 'Lan', authorUrl: '', text,
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        }]);
        expect(leadOperations.list({ search: 'hỏi giá' }).leads.map((l) => l.commentKey)).toEqual(['manual-k1']);
        // Thu lại cùng bình luận không tạo khách trùng
        await mockServiceDeps.onCommentsSaved([{
            key: 'manual-k1', profileId: 'p1', postUrl: 'https://x/manual', authorId: 'a1', authorName: 'Lan', authorUrl: '', text,
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        }]);
        expect(leadOperations.list({ search: 'hỏi giá' }).total).toBe(1);
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: mockServiceDeps.newId(), status: 'completed' }); // đóng lượt: xả khách đã gom
    });

    test('khách mới phát sự kiện control leads.found đúng một lần cho cả lượt (khi lượt kết thúc), không phát lại cho bình luận cũ', async () => {
        await currentWorkerDeps();
        const emit = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        emit.mockClear();
        const mk = (n: number) => ({
            key: `ctl-k${n}`, profileId: 'p1', postUrl: `https://x/ctl${n}`, authorId: `a${n}`, authorName: `Hoa ${n}`, authorUrl: '', text: 'ib mình báo giá nhé',
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        });
        const leadCalls = () => emit.mock.calls.filter((c) => c[0] === 'leads.found');
        await mockServiceDeps.onCommentsSaved([mk(1)]);
        await mockServiceDeps.onCommentsSaved([mk(2)]); // bài thứ hai của cùng lượt
        expect(leadCalls()).toHaveLength(0); // chưa phát trước khi lượt kết thúc
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: mockServiceDeps.newId(), status: 'completed' });
        expect(leadCalls()).toHaveLength(1);
        expect(leadCalls()[0][1]).toMatchObject({ count: 2, auto: false });
        // Lượt sau: bình luận cũ không tạo khách mới nên không phát
        await mockServiceDeps.onCommentsSaved([mk(1)]);
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: mockServiceDeps.newId(), status: 'completed' });
        expect(leadCalls()).toHaveLength(1);
    });

    test('comment timer ignores poster activity and keeps automatic collection semantics', async () => {
        posterOperations.current();
        // Các test trên để lại lịch đến hạn trong DB; lịch sắp tới làm việc phụ nhường khe nên xoá chúng để thử riêng khe việc chung.
        mockDb.run('DELETE FROM fb_poster_schedules');
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'] } });
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        expect(isFacebookPosterBusy()).toBe(true);
        cancelFacebookPosterJobs();
        await cancelAndWaitFacebookPosterJobs();
        startFacebookPosterScheduler();
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        mockCommentSchedulerDeps.runCollect([]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const status = leadOperations.collectStatus();
        expect(status.running).toBe(false);
        expect(status.last).toMatchObject({ auto: true, posts: 0, cancelled: false });
        const controlEmit = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        expect(controlEmit).toHaveBeenCalledWith('comments.collectFinished', expect.objectContaining({ auto: true, posts: 0, cancelled: false }));
        expect(leadOperations.collectCancel()).toEqual({ cancelled: false });
        expect(leadOperations.collect({}).posts).toBe(0); // thu tay không có bài đến hạn
    });

    test('store() xoá khách quá 180 ngày cùng chỗ xoá theo dõi khi gặp DB lần đầu', () => {
        jest.isolateModules(() => {
            const { FacebookPosterStore: IsolatedStore } = require('../../services/facebookPoster/FacebookPosterStore');
            const spy = jest.spyOn(IsolatedStore.prototype, 'pruneLeadsOlderThan');
            const isolated = require('../../../electron/ipc/facebookPosterIpc');
            isolated.leadOperations.list();
            isolated.leadOperations.list();
            expect(spy).toHaveBeenCalledTimes(1);
            const cutoff = spy.mock.calls[0][0] as number;
            expect(Math.abs(Date.now() - cutoff - 180 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
        });
    });
});

describe('Page learner lifecycle wiring', () => {
    const reading = { kind: 'page', pageId: '123', pageName: 'Page', category: '', about: '', recentPosts: [] };
    const tick = () => new Promise<void>((r) => setImmediate(r));
    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => { resolve = r; });
        return { promise, resolve };
    }
    beforeEach(async () => {
        mockResearchRunning = false;
        expect(await cancelAndWaitFacebookPosterJobs()).toBe(true);
        require('../../../electron/ipc/facebookPosterIpc').retireFacebookJobGeneration();
        mockEmployee = false; mockSwitching = false; mockResearchRunning = false;
        mockDbName = 'db.sqlite'; mockProfiles = [{ id: 'p1', name: 'P1' }];
        mockDb.run('DELETE FROM fb_poster_schedules');
        mockOpen.mockReset().mockResolvedValue({ context: { once: jest.fn(), pages: () => [{}] }, close: jest.fn(async () => undefined) });
        mockRead.mockReset().mockResolvedValue(reading);
        startFacebookPosterScheduler(); mockRunFinished.mockClear();
        require('../../services/control/controlEvents').emitControlEvent.mockClear();
    });
    // The drain pauses admission like a lifecycle owner; hand later tests a fresh admitting generation on the shared DB, as beforeAll did.
    afterEach(async () => {
        mockEmployee = false; mockSwitching = false; mockResearchRunning = false;
        expect(await cancelAndWaitFacebookPosterJobs()).toBe(true);
        require('../../../electron/ipc/facebookPosterIpc').retireFacebookJobGeneration();
        mockDbName = 'db.sqlite'; startFacebookPosterScheduler();
    });

    test('holds BUSY synchronously, emits a sanitized finish and wakes scheduler exactly once', async () => {
        const started = learnPages(null, true);
        expect(started.profileIds).toEqual(['p1']);
        expect(isPageLearnerRunning()).toBe(true);
        expect(isFacebookPosterBusy()).toBe(true);
        expect(capturedDeps.isBusy()).toBe(false); // Side jobs no longer occupy a poster worker.
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        expect(() => learnPages(['p1'], true)).toThrow();
        await tick();
        expect(isFacebookPosterBusy()).toBe(false);
        expect(mockRunFinished).toHaveBeenCalledTimes(1);
        expect(require('../../services/control/controlEvents').emitControlEvent).toHaveBeenCalledWith('pages.learnFinished', {
            jobId: started.jobId, results: [{ profileId: 'p1', kind: 'page', pageName: 'Page' }],
        });
    });
    test('research activity does not reject a new learner job', async () => {
        mockResearchRunning = true;
        expect(learnPages(['p1'], true).profileIds).toEqual(['p1']);
        expect(() => learnPages(['p1'], true)).toThrow(require('../../services/facebookPoster/FacebookPosterService').BUSY_ERROR);
        await tick();
        expect(mockOpen).toHaveBeenCalledWith('p1');
    });
    test('research admits a search while learning and retains its own one-job limit', async () => {
        const gate = deferred<any>(); mockRead.mockReturnValueOnce(gate.promise);
        learnPages(['p1'], true);
        const realResearch = jest.requireActual('../../../electron/ipc/researchIpc');
        const busy = require('../../services/facebookPoster/FacebookPosterService').BUSY_ERROR;
        expect(realResearch.researchOperations.search({ source: 'posts', query: 'x' }, 'api').scanId).toEqual(expect.any(String));
        expect(() => realResearch.researchOperations.scanGroupFeeds({}, 'api')).toThrow(busy);
        realResearch.cancelResearch();
        gate.resolve(reading); await tick();
        await realResearch.cancelAndWaitResearch();
    });
    test('cancel-and-wait keeps the workspace blocked until read AND session cleanup finish', async () => {
        const readGate = deferred<any>(); const closeGate = deferred<void>();
        const close = jest.fn(() => closeGate.promise);
        mockOpen.mockResolvedValueOnce({ context: { once: jest.fn(), pages: () => [{}] }, close });
        mockRead.mockReturnValueOnce(readGate.promise);
        learnPages(['p1'], true); await tick();
        const { getDailyBriefStore } = require('../../../electron/ipc/dailyBriefIpc');
        const before = getDailyBriefStore().getIdentity('p1');
        let settled = false;
        const waiting = cancelAndWaitFacebookPosterJobs().then((ok) => { settled = true; return ok; });
        await tick(); expect(settled).toBe(false);
        readGate.resolve(reading); await tick(); expect(settled).toBe(false);
        closeGate.resolve(); expect(await waiting).toBe(true);
        expect(getDailyBriefStore().getIdentity('p1')).toEqual(before);
        expect(mockRunFinished).toHaveBeenCalledTimes(1);
    });
    test('cancel helper stops a pending read and still finishes once', async () => {
        const gate = deferred<any>(); mockRead.mockReturnValueOnce(gate.promise);
        learnPages(['p1'], true); await tick(); cancelFacebookPosterJobs();
        gate.resolve(reading); await tick();
        expect(isPageLearnerRunning()).toBe(false);
        expect(mockRunFinished).toHaveBeenCalledTimes(1);
    });
    test.each(['workspace', 'employee'])('late read after %s change cannot write or emit into a new context', async (change) => {
        const gate = deferred<any>(); mockRead.mockReturnValueOnce(gate.promise);
        learnPages(['p1'], true); await tick();
        const { getDailyBriefStore } = require('../../../electron/ipc/dailyBriefIpc');
        const before = getDailyBriefStore().getIdentity('p1');
        if (change === 'workspace') mockDbName = 'new.sqlite'; else mockEmployee = true;
        gate.resolve(reading); await tick();
        expect(getDailyBriefStore().getIdentity('p1')).toEqual(before);
        const emit = require('../../services/control/controlEvents').emitControlEvent;
        expect(emit.mock.calls.filter(([type]: any[]) => type === 'pages.learnFinished')).toHaveLength(0);
        expect(mockRunFinished).not.toHaveBeenCalled();
        expect(isPageLearnerRunning()).toBe(false);
    });
    test('a late open rejection after a workspace change cannot save an error into the new DB', async () => {
        const gate = deferred<void>();
        mockOpen.mockImplementationOnce(async () => { await gate.promise; throw new Error('late open error'); });
        learnPages(['p1'], true); await tick();
        const { getDailyBriefStore } = require('../../../electron/ipc/dailyBriefIpc');
        const before = getDailyBriefStore().getIdentity('p1');
        mockDbName = 'late-open.sqlite';
        gate.resolve(); await tick();
        expect(getDailyBriefStore().getIdentity('p1')).toEqual(before);
        expect(mockRunFinished).not.toHaveBeenCalled();
        const emit = require('../../services/control/controlEvents').emitControlEvent;
        expect(emit.mock.calls.filter(([type]: any[]) => type === 'pages.learnFinished')).toHaveLength(0);
    });
    test('workspace switching and employee mode reject new jobs before opening', () => {
        mockSwitching = true;
        expect(() => learnPages(['p1'], true)).toThrow('Đang đổi workspace');
        mockSwitching = false; mockEmployee = true;
        expect(() => learnPages(['p1'], true)).toThrow();
        expect(mockOpen).not.toHaveBeenCalled();
    });
    test('interactive learning opens despite a due schedule and wakes the scheduler once', async () => {
        const spy = jest.spyOn(FacebookPosterStore.prototype, 'nextScheduledAt').mockReturnValue(Date.now());
        try {
            learnPages(['p1'], true); await tick();
            expect(mockOpen).toHaveBeenCalledWith('p1');
            expect(mockRunFinished).toHaveBeenCalledTimes(1);
        } finally { spy.mockRestore(); }
    });
    test('failed learner construction leaves the shared slot free', () => {
        const mod = require('../../services/dailyBrief/PageLearner');
        const spy = jest.spyOn(mod, 'PageLearner').mockImplementationOnce(() => { throw new Error('construction'); });
        mockDbName = 'construction.sqlite';
        try { expect(() => learnPages(['p1'], true)).toThrow('construction'); }
        finally { spy.mockRestore(); }
        expect(isFacebookPosterBusy()).toBe(false);
    });
    test('pages.list uses identities and pageOperations.learn keeps only jobId', async () => {
        const { pageOperations } = require('../../../electron/ipc/dailyBriefIpc');
        expect(() => pageOperations.learn({ profileIds: [] })).toThrow();
        expect(() => pageOperations.learn({ force: 'true' })).toThrow();
        expect(Object.keys(pageOperations.learn({ profileIds: ['p1'], force: true }))).toEqual(['jobId']);
        await tick();
        expect(pageOperations.list()).toMatchObject({ identities: expect.arrayContaining([expect.objectContaining({ profileId: 'p1' })]) });
    });

    test('bounded stop-and-wait refuses to switch while read is unresolved, retaining the busy slot', async () => {
        jest.useFakeTimers();
        const gate = deferred<any>(); mockRead.mockReturnValueOnce(gate.promise);
        try {
            learnPages(['p1'], true);
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const waiting = cancelAndWaitFacebookPosterJobs();
            await jest.advanceTimersByTimeAsync(45000);
            expect(await waiting).toBe(false);
            expect(isFacebookPosterBusy()).toBe(true);
            expect(() => learnPages(['p1'], true)).toThrow();
            gate.resolve(reading);
            for (let i = 0; i < 15; i++) await Promise.resolve();
            expect(isFacebookPosterBusy()).toBe(false);
            expect(mockRunFinished).toHaveBeenCalledTimes(1);
        } finally { gate.resolve(reading); jest.useRealTimers(); }
    });

    test.each(['checkpoint', 'logged_out'])('%s then successful forced learning restores actual research eligibility', async (state) => {
        const { PageLoginProblem } = require('../../services/dailyBrief/pageIdentity');
        const { eligibleProfiles } = require('../../services/research/profileRotation');
        const posterStore = new FacebookPosterStore(mockDb);
        const eligible = () => eligibleProfiles({ profiles: mockProfiles, excluded: [], busyIds: [],
            loginStates: posterStore.listLoginStates(), usedLast24h: {}, lastUsedAt: {}, cap: 100, failedInScan: [] });
        mockRead.mockRejectedValueOnce(new PageLoginProblem(state));
        learnPages(['p1'], true); await tick();
        expect(eligible()).toEqual([]);
        expect(posterStore.listLoginStates()).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: 'p1', state, source: 'run' })]));
        learnPages(['p1'], true); await tick();
        expect(eligible()).toEqual(['p1']);
        expect(posterStore.listLoginStates()).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: 'p1', state: 'ok', source: 'run' })]));
        expect(isFacebookPosterBusy()).toBe(false);
    });

    test('logged_out observation uses LoginChecker run vocabulary and the stored not_logged_in code', async () => {
        const { PageLoginProblem } = require('../../services/dailyBrief/pageIdentity');
        mockRead.mockRejectedValueOnce(new PageLoginProblem('logged_out'));
        learnPages(['p1'], true); await tick();
        const { getDailyBriefStore } = require('../../../electron/ipc/dailyBriefIpc');
        expect(getDailyBriefStore().getIdentity('p1').errorCode).toBe('not_logged_in');
        expect(new FacebookPosterStore(mockDb).listLoginStates()).toEqual(expect.arrayContaining([
            expect.objectContaining({ profileId: 'p1', state: 'logged_out', source: 'run' }),
        ]));
    });

    test('a broken finish event listener cannot suppress the scheduler wake', async () => {
        const emit = require('../../services/control/controlEvents').emitControlEvent;
        emit.mockImplementationOnce(() => { throw new Error('listener'); });
        learnPages(['p1'], true); await tick();
        expect(mockRunFinished).toHaveBeenCalledTimes(1);
        expect(isFacebookPosterBusy()).toBe(false);
    });
});
