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
let mockNotificationDeps: any = null;
let mockUseRealNotification = false;
let mockNotificationInstance: any = null;
let mockSink = false;
const mockNotificationStop = jest.fn();
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
jest.mock('../../services/facebookPoster/NotificationScheduler', () => ({
    ...jest.requireActual('../../services/facebookPoster/NotificationScheduler'),
    NotificationScheduler: class {
        constructor(deps: any) {
            mockNotificationDeps = deps;
            mockNotificationInstance = mockUseRealNotification ? new (jest.requireActual('../../services/facebookPoster/NotificationScheduler').NotificationScheduler)(deps) : this;
            if (mockUseRealNotification) return mockNotificationInstance;
        }
        start() {}
        stop() { mockNotificationStop(); }
    },
}));
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
    buildAutonomyChanged: jest.requireActual('../../services/control/controlEvents').buildAutonomyChanged,
    buildAutonomyPaused: jest.requireActual('../../services/control/controlEvents').buildAutonomyPaused,
    buildAutonomyStopped: jest.requireActual('../../services/control/controlEvents').buildAutonomyStopped,
    emitControlEvent: jest.fn(), hasControlEventSink: () => mockSink, buildRunStarted: jest.fn(), buildRunFinished: jest.fn(), buildScheduleMissed: jest.fn(),
    buildDraftApproved: jest.fn(), buildLoginProblem: jest.fn(), buildCheckFinished: jest.fn(), buildTrackFinished: jest.fn(), buildLeadsFound: jest.fn((p: unknown) => p), buildCollectFinished: jest.fn((p: unknown) => p),
    recordControlEvent: jest.fn(), buildLeadsDigest: jest.requireActual('../../services/control/controlEvents').buildLeadsDigest,
}));

jest.mock('../../services/dailyBrief/pageIdentity', () => ({ ...jest.requireActual('../../services/dailyBrief/pageIdentity'), readPageIdentity: (...args: any[]) => mockRead(...args) }));

import { notificationOperations, MAX_PAGE_METRICS_DAYS } from '../../../electron/ipc/facebookPosterIpc';
import { createControlMethods } from '../../services/control/ControlMethods';
import { systemClock } from '../../services/dailyBrief/DailyBriefStore';
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

    test('loginProblemPausesAutonomyProfileOnce: checkpoint and logged_out pause, ok does not', async () => {
        await currentWorkerDeps();
        const control = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        const paused = () => control.mock.calls.filter(call => call[0] === 'autonomy.paused').map(call => call[1]);
        mockServiceDeps.onLoginObserved('pause-profile', 'ok');
        control.mockClear();
        mockServiceDeps.onLoginObserved('pause-profile', 'checkpoint');
        mockServiceDeps.onLoginObserved('pause-profile', 'checkpoint');
        mockServiceDeps.onLoginObserved('pause-profile', 'logged_out');
        expect(paused()).toEqual([expect.objectContaining({ profileId: 'pause-profile', reason: 'checkpoint' })]);
        expect(control.mock.calls.filter(call => call[0] === 'profile.loginProblem').length).toBeGreaterThanOrEqual(1);
    });

    test('publish and tracker Page callbacks bind campaign posts on the captured DB only', async () => {
        await currentWorkerDeps();
        trackingOperations.track({}); await new Promise(resolve => setImmediate(resolve));
        const { PageCampaignExecutionStore } = require('../../services/dailyBrief/PageCampaignExecutionStore');
        const bind = jest.spyOn(PageCampaignExecutionStore.prototype, 'bindTrackedPost');
        const original = mockDatabaseInstance;
        const replacement = memoryDb(); new FacebookPosterStore(replacement).ensureSchema();
        const query = jest.spyOn(replacement, 'query'); const queryOne = jest.spyOn(replacement, 'queryOne');
        mockDatabaseInstance = { ...original, ...replacement };
        const row = { resultId: 1, runId: 'r', scheduleId: 's', targetKind: 'page', pageId: 'p', postId: '1', postUrl: 'https://www.facebook.com/p/posts/1', linkStatus: 'known' };
        try {
            expect(() => mockServiceDeps.onPagePostKnown(row)).not.toThrow();
            expect(() => mockTrackerDeps.onPagePostKnown(row)).not.toThrow();
            expect(bind.mock.calls.map(call => call[0])).toEqual([row, row]);
            expect(bind.mock.results.map(result => result.value)).toEqual(['skipped', 'skipped']);
            expect(query).not.toHaveBeenCalled(); expect(queryOne).not.toHaveBeenCalled();
        } finally { mockDatabaseInstance = original; bind.mockRestore(); }
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
    test('notification scheduler is gated on the binding and the sink; leads.found is deferred only while digesting', async () => {
        const controlEvents = require('../../services/control/controlEvents');
        startFacebookPosterScheduler();
        leadOperations.collect({}); // collector bound to the current generation, independent of test order
        await new Promise(resolve => setImmediate(resolve));
        const deps = mockNotificationDeps;
        expect(deps.canPublish()).toBe(false); // no Control API sink in this composition
        expect(deps.publish).toBe(controlEvents.recordControlEvent);
        expect(deps.readConfig()).toEqual({ reportCadence: 'weekly', reportHour: 8, reportWeekday: 1, leadDigestMinutes: 60 });
        const build = controlEvents.buildLeadsFound as jest.Mock;
        build.mockClear();
        mockCollectorDeps.emit('leads.found', { count: 1, samples: [], auto: true, leadIds: [1], campaignIds: [] });
        expect(build.mock.calls[0][0]).toMatchObject({ count: 1, deferred: false }); // no digest cursor yet: sent immediately
        let minutes = 60;
        const getSetting = jest.spyOn(mockDatabaseInstance, 'getSetting').mockImplementation(((key: string) =>
            key === 'fb_poster_notification_config' ? JSON.stringify({ reportCadence: 'weekly', reportHour: 8, reportWeekday: 1, leadDigestMinutes: minutes })
                : key === 'fb_poster_lead_digest_cursor' ? JSON.stringify({ at: 1, id: 1, minutes }) : null) as any);
        try {
            build.mockClear();
            mockCollectorDeps.emit('leads.found', { count: 1, samples: [], auto: true, leadIds: [2], campaignIds: [] });
            expect(build.mock.calls[0][0]).toMatchObject({ count: 1, deferred: true });
            minutes = 0;
            build.mockClear();
            mockCollectorDeps.emit('leads.found', { count: 1, samples: [], auto: true, leadIds: [3], campaignIds: [] });
            expect(build.mock.calls[0][0]).toMatchObject({ count: 1, deferred: false });
        } finally { getSetting.mockRestore(); await cancelAndWaitFacebookPosterJobs(); }
        mockNotificationStop.mockClear();
        stopFacebookPosterScheduler();
        expect(mockNotificationStop).toHaveBeenCalledTimes(1);
        startFacebookPosterScheduler();
        expect(mockNotificationDeps).not.toBe(deps);
    });
    test('notification canPublish needs the current binding and a sink; isCollecting follows the collector', async () => {
        const ipc = require('../../../electron/ipc/facebookPosterIpc');
        const { CommentCollector } = require('../../services/facebookPoster/CommentCollector');
        startFacebookPosterScheduler();
        const deps = mockNotificationDeps;
        mockSink = true;
        try {
            expect(deps.canPublish()).toBe(true);
            expect(deps.isCollecting()).toBe(false);
            leadOperations.collect({});
            const running = jest.spyOn(CommentCollector.prototype, 'isRunning').mockReturnValue(true);
            try { expect(deps.isCollecting()).toBe(true); } finally { running.mockRestore(); }
            expect(await cancelAndWaitFacebookPosterJobs()).toBe(true); ipc.retireFacebookJobGeneration();
            expect(deps.canPublish()).toBe(false);
            startFacebookPosterScheduler();
            expect(mockNotificationDeps).not.toBe(deps);
            expect(mockNotificationDeps.canPublish()).toBe(true);
            expect(deps.canPublish()).toBe(false);
        } finally { mockSink = false; startFacebookPosterScheduler(); }
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

describe('page metrics and notification config (spec 2026-10-31 §6)', () => {
    const DAY = 24 * 3600_000;
    const handlers = new Map<string, (event: unknown, params?: any) => Promise<any>>();
    const invoke = (channel: string, params?: any) => handlers.get(channel)!({}, params);
    const control = (name: string, params: any = {}) => createControlMethods({ tracking: trackingOperations, notifications: notificationOperations } as any)
        .find((m) => m.name === name)!.run(params, {});
    const setting = (key: string): string | null => mockDb.queryOne<{ value: string }>('SELECT value FROM test_settings WHERE key = ?', [key])?.value ?? null;
    const cursor = () => JSON.parse(setting('fb_poster_lead_digest_cursor')!);
    const config = () => notificationOperations.getConfig().config;
    let seq = 0;
    const addLead = (detectedAt: number) => new FacebookPosterStore(mockDb).createLeads([{
        commentKey: `notif-${++seq}`, postUrl: 'https://www.facebook.com/groups/1/posts/9/', resultId: null, groupUrl: '', campaignId: null, variant: '', profileId: 'p1',
        authorId: '', authorName: `Khách ${seq}`, authorUrl: '', text: 'ib giá', commentedAtMs: null, matched: ['giá'], aiIntent: null, aiScore: null, aiReason: '',
        status: 'new', note: '', detectedAt, updatedAt: detectedAt,
    } as any])[0];
    let getSpy: jest.SpyInstance;
    let setSpy: jest.SpyInstance;

    beforeAll(() => {
        mockDb.exec('CREATE TABLE IF NOT EXISTS test_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        (require('electron').ipcMain.handle as jest.Mock).mockImplementation((channel: string, handler: any) => { handlers.set(channel, handler); });
        registerFacebookPosterIpc();
        (require('electron').ipcMain.handle as jest.Mock).mockReset();
    });
    beforeEach(() => {
        mockDb.run('DELETE FROM test_settings');
        // Settings live in the same SQLite DB so the outer transaction of setConfig really rolls them back.
        getSpy = jest.spyOn(mockDatabaseInstance, 'getSetting').mockImplementation(((key: string) => setting(key)) as any);
        setSpy = jest.spyOn(mockDatabaseInstance, 'setSetting').mockImplementation(((key: string, value: string) =>
            mockDb.run('INSERT OR REPLACE INTO test_settings (key, value) VALUES (?, ?)', [key, value])) as any);
        stopFacebookPosterScheduler();
        mockUseRealNotification = true;
        mockSink = true;
        startFacebookPosterScheduler();
        (require('../../services/control/controlEvents').recordControlEvent as jest.Mock).mockReset();
    });
    afterEach(async () => {
        await cancelAndWaitFacebookPosterJobs();
        // Shared DB: other tests in this file expect no tracking rows, so remove what this block added.
        mockDb.run('DELETE FROM fb_poster_post_stats WHERE result_id BETWEEN 91001 AND 91006');
        mockDb.run('DELETE FROM fb_poster_post_tracking WHERE result_id BETWEEN 91001 AND 91006');
        mockDb.run("DELETE FROM fb_poster_page_followers WHERE page_id IN ('pm-page', 'pm-other')");
        mockDb.run("DELETE FROM fb_poster_leads WHERE comment_key LIKE 'notif-%'");
        stopFacebookPosterScheduler();
        mockUseRealNotification = false;
        mockSink = false;
        getSpy.mockRestore();
        setSpy.mockRestore();
        startFacebookPosterScheduler();
    });
    // Only writes that returned: a call that threw recorded nothing.
    const published = (type: string) => {
        const mock = require('../../services/control/controlEvents').recordControlEvent as jest.Mock;
        return mock.mock.calls.filter((c, i) => c[0] === type && mock.mock.results[i].type === 'return');
    };

    test('setNotificationConfigResetsReportPeriodAndDigestCursor', async () => {
        expect(await invoke('facebookPoster:getNotificationConfig')).toEqual({ success: true, config: { reportCadence: 'weekly', reportHour: 8, reportWeekday: 1, leadDigestMinutes: 60 } });
        mockNotificationInstance.tickNow(); // initialises the report period and the digest cursor without sending
        const initial = JSON.parse(setting('fb_poster_report_last_period')!);
        expect(initial.rule).toBe('weekly:8:1');
        const before = cursor();
        expect(before.minutes).toBe(60);

        // Schedule change: the scheduler re-records the current period of the new rule and sends nothing.
        expect(await invoke('facebookPoster:setNotificationConfig', { reportCadence: 'daily', reportHour: 23 })).toEqual({ success: true, config: { reportCadence: 'daily', reportHour: 23, reportWeekday: 1, leadDigestMinutes: 60 } });
        expect(cursor()).toEqual(before); // digest window unchanged: cursor untouched
        mockNotificationInstance.tickNow();
        expect(JSON.parse(setting('fb_poster_report_last_period')!).rule).toBe('daily:23');
        expect(published('metrics.report')).toEqual([]);

        // 60 → 0 through the Control API: the pending lead is flushed in the same call, cursor stands on it.
        const l1 = addLead(Date.now() + 30 * DAY);
        expect(await control('notifications.setConfig', { leadDigestMinutes: 0 })).toEqual({ config: expect.objectContaining({ leadDigestMinutes: 0 }) });
        expect(published('leads.digest')).toHaveLength(1);
        expect(published('leads.digest')[0][1]).toMatchObject({ leadIds: [l1.id] });
        expect(cursor()).toEqual({ at: l1.detectedAt, id: l1.id, minutes: 0 });

        // 0 → 15: leads already sent immediately are skipped; nothing is published.
        const l2 = addLead(Date.now() + 31 * DAY);
        expect(await invoke('facebookPoster:setNotificationConfig', { leadDigestMinutes: 15 })).toMatchObject({ success: true, config: { leadDigestMinutes: 15 } });
        expect(cursor()).toEqual({ at: l2.detectedAt, id: l2.id, minutes: 15 });
        // 15 → 30: only the stored window changes.
        addLead(Date.now() + 32 * DAY);
        await control('notifications.setConfig', { leadDigestMinutes: 30 });
        expect(cursor()).toEqual({ at: l2.detectedAt, id: l2.id, minutes: 30 });
        expect(published('leads.digest')).toHaveLength(1);
        expect(config()).toEqual({ reportCadence: 'daily', reportHour: 23, reportWeekday: 1, leadDigestMinutes: 30 });
    });

    test('a digest switch is refused while a comment collect runs; other fields still save', async () => {
        const { CommentCollector } = require('../../services/facebookPoster/CommentCollector');
        mockNotificationInstance.tickNow();
        leadOperations.collect({}); // binds the collector of this generation
        const running = jest.spyOn(CommentCollector.prototype, 'isRunning').mockReturnValue(true);
        try {
            const before = { config: setting('fb_poster_notification_config'), cursor: setting('fb_poster_lead_digest_cursor') };
            await expect(control('notifications.setConfig', { leadDigestMinutes: 0 })).rejects.toMatchObject({ code: 'BUSY' });
            expect(await invoke('facebookPoster:setNotificationConfig', { leadDigestMinutes: 240, reportHour: 9 })).toEqual({ success: false, error: expect.stringContaining('thu bình luận') });
            expect({ config: setting('fb_poster_notification_config'), cursor: setting('fb_poster_lead_digest_cursor') }).toEqual(before);
            expect(config().leadDigestMinutes).toBe(60);
            expect(await control('notifications.setConfig', { reportHour: 9, leadDigestMinutes: 60 })).toEqual({ config: expect.objectContaining({ reportHour: 9, leadDigestMinutes: 60 }) });
        } finally { running.mockRestore(); }
        await cancelAndWaitFacebookPosterJobs();
        expect(await control('notifications.setConfig', { leadDigestMinutes: 120 })).toEqual({ config: expect.objectContaining({ leadDigestMinutes: 120 }) });
        expect(cursor().minutes).toBe(120);
    });

    test('a digest switch is refused while a manual collect_comments run (not the auto collector) is active', async () => {
        mockNotificationInstance.tickNow();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        mockOpen.mockImplementation(async () => { await gate; throw new Error('synthetic launch stop'); });
        posterOperations.start({ kind: 'collect_comments', params: { profileId: 'p1', postUrls: ['https://www.facebook.com/groups/1/posts/9/'] } });
        try {
            expect(leadOperations.collectStatus().running).toBe(false);
            expect(mockNotificationDeps.isCollecting()).toBe(true);
            const before = { config: setting('fb_poster_notification_config'), cursor: setting('fb_poster_lead_digest_cursor') };
            await expect(control('notifications.setConfig', { leadDigestMinutes: 0 })).rejects.toMatchObject({ code: 'BUSY' });
            expect({ config: setting('fb_poster_notification_config'), cursor: setting('fb_poster_lead_digest_cursor') }).toEqual(before);
            expect(config().leadDigestMinutes).toBe(60);
        } finally {
            cancelFacebookPosterJobs(); release(); await cancelAndWaitFacebookPosterJobs();
            mockOpen.mockReset(); startFacebookPosterScheduler();
        }
        expect(mockNotificationDeps.isCollecting()).toBe(false);
    });

    test('tracker readPage releases the profile session when the Page read throws', async () => {
        trackingOperations.track({});
        for (let i = 0; i < 50 && trackingOperations.status().running; i++) await new Promise(resolve => setImmediate(resolve));
        expect(trackingOperations.status().running).toBe(false);
        const close = jest.fn(async () => undefined);
        mockOpen.mockResolvedValueOnce({ context: { once: jest.fn(), pages: () => [{}] }, close });
        mockRead.mockRejectedValueOnce(new Error('synthetic read failure'));
        const context = { jobId: 'page-read-error', signal: new AbortController().signal, priority: 'background', assertCurrent: () => undefined };
        try {
            await expect(mockTrackerDeps.readPage('p1', context)).rejects.toThrow('synthetic read failure');
            expect(close).toHaveBeenCalledTimes(1);
            expect(getProfileJobBinding().isProfileBusy('p1')).toBe(false);
        } finally { mockOpen.mockReset(); mockRead.mockReset(); }
    });

    test('a failed digest flush leaves neither the config nor the cursor half-switched', async () => {
        mockNotificationInstance.tickNow();
        const pending = addLead(Date.now() + 40 * DAY);
        const before = cursor();
        const record = require('../../services/control/controlEvents').recordControlEvent as jest.Mock;
        record.mockImplementationOnce(() => { throw new Error('ghi sự kiện lỗi'); });
        expect((await invoke('facebookPoster:setNotificationConfig', { leadDigestMinutes: 0 })).success).toBe(false);
        expect(config().leadDigestMinutes).toBe(60);
        expect(setting('fb_poster_notification_config')).toBeNull();
        expect(cursor()).toEqual(before);
        expect(await invoke('facebookPoster:setNotificationConfig', { leadDigestMinutes: 0 })).toMatchObject({ success: true });
        expect(published('leads.digest').map((c) => c[1].leadIds)).toEqual([[pending.id]]);
        expect(cursor()).toEqual({ at: pending.detectedAt, id: pending.id, minutes: 0 });
    });

    test('without a scheduler bound to this DB a digest switch is refused, other fields save', async () => {
        stopFacebookPosterScheduler();
        await expect(control('notifications.setConfig', { leadDigestMinutes: 0 })).rejects.toMatchObject({ code: 'BUSY' });
        expect(config().leadDigestMinutes).toBe(60);
        expect(await control('notifications.setConfig', { reportCadence: 'off' })).toEqual({ config: expect.objectContaining({ reportCadence: 'off' }) });
        expect(await invoke('facebookPoster:setNotificationConfig', { leadDigestMinutes: 45 })).toEqual({ success: false, error: expect.stringContaining('leadDigestMinutes') });
        expect(await invoke('facebookPoster:setNotificationConfig', { junk: 1 })).toEqual({ success: false, error: expect.stringContaining('junk') });
    });

    test('pageMetrics text is the original posted text when the run row still has it', () => {
        const s = new FacebookPosterStore(mockDb);
        const now = Date.now();
        s.createRun({ id: 'pm-text-run', kind: 'post', mode: 'page', params: { text: 'Khai Trương Chi Nhánh Mới' }, startedAt: now - DAY, scheduleId: null, campaignId: null } as any);
        s.createTracking({ resultId: 91010, runId: 'pm-text-run', scheduleId: null, profileId: 'p1', targetKind: 'page', pageId: 'pm-text', groupUrl: 'https://www.facebook.com/',
            groupId: '', postId: '', postUrl: null, postedAt: now - DAY, textHead: 'khai trương chi nhánh mới', linkStatus: 'missing', removedSuspected: false, lastSeenAt: null,
            lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [] } as any);
        try {
            expect(trackingOperations.pageMetrics({ pageId: 'pm-text' }).pages[0].posts[0].text).toBe('Khai Trương Chi Nhánh Mới');
        } finally {
            mockDb.run('DELETE FROM fb_poster_post_tracking WHERE result_id = 91010');
            mockDb.run("DELETE FROM fb_poster_runs WHERE id = 'pm-text-run'");
        }
    });

    test('pageMetrics returns only known-Page rows with snapshots and followers, days 1–90', async () => {
        const s = new FacebookPosterStore(mockDb);
        const now = Date.now();
        const row = (resultId: number, over: Record<string, unknown>) => s.createTracking({
            resultId, runId: 'pm', scheduleId: null, profileId: 'p1', targetKind: 'page', pageId: 'pm-page', groupUrl: 'https://www.facebook.com/', groupId: '',
            postId: '', postUrl: null, postedAt: now - DAY, textHead: `bài ${resultId}`, linkStatus: 'missing', removedSuspected: false, lastSeenAt: null,
            lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [], ...over,
        } as any);
        row(91001, { postId: 'a1', postUrl: 'https://www.facebook.com/pm-page/posts/a1', linkStatus: 'known', postedAt: now - 2 * DAY });
        row(91002, {});
        row(91003, { pageId: '' });
        row(91004, { targetKind: 'group', pageId: '', groupUrl: 'https://www.facebook.com/groups/pm/' });
        row(91005, { postedAt: now - 40 * DAY });
        row(91006, { pageId: 'pm-other' });
        s.addPostStats(91001, { capturedAt: now - DAY, reactions: 3, comments: 1, shares: null });
        s.addPostStats(91001, { capturedAt: now - 1000, reactions: 5, comments: 2, shares: 0 });
        s.recordPageFollowers({ pageId: 'pm-page', profileId: 'p1', capturedOn: systemClock.date(now), capturedAt: now, followers: 120 });
        s.recordPageFollowers({ pageId: 'pm-page', profileId: 'p1', capturedOn: systemClock.date(now - 60 * DAY), capturedAt: now - 60 * DAY, followers: 90 });
        const out = trackingOperations.pageMetrics({ pageId: 'pm-page' });
        expect(out.pages).toHaveLength(1);
        expect(out.pages[0]).toMatchObject({ pageId: 'pm-page', pageName: 'pm-page' });
        expect(out.pages[0].posts.map((p) => [p.resultId, p.linkStatus, p.snapshots.map((x) => x.reactions)])).toEqual([[91002, 'missing', []], [91001, 'known', [3, 5]]]);
        expect(out.pages[0].posts[1]).toMatchObject({ postId: 'a1', postUrl: 'https://www.facebook.com/pm-page/posts/a1', text: 'bài 91001' });
        expect(out.pages[0].followers.map((f) => f.followers)).toEqual([120]);
        expect(trackingOperations.pageMetrics({ pageId: 'pm-page', days: MAX_PAGE_METRICS_DAYS }).pages[0].posts.map((p) => p.resultId)).toEqual([91002, 91001, 91005]);
        const all = (await invoke('facebookPoster:pageMetrics', {})).pages as { pageId: string; posts: { resultId: number }[] }[];
        expect(all.map((p) => p.pageId)).toEqual(expect.arrayContaining(['pm-page', 'pm-other']));
        expect(all.map((p) => p.pageId)).not.toContain('');
        expect(all.flatMap((p) => p.posts.map((x) => x.resultId))).not.toEqual(expect.arrayContaining([91003]));
        expect(all.flatMap((p) => p.posts.map((x) => x.resultId))).not.toEqual(expect.arrayContaining([91004]));
        for (const days of [0, 91, 1.5, '7']) expect(await invoke('facebookPoster:pageMetrics', { days })).toEqual({ success: false, error: expect.stringContaining('days') });
        expect(await control('pages.metrics', { pageId: 'pm-page', days: 7 })).toMatchObject({ pages: [{ pageId: 'pm-page' }] });
        const schema: any = createControlMethods({} as any).find((m) => m.name === 'pages.metrics')!.paramsSchema;
        expect(schema.properties.days.maximum).toBe(MAX_PAGE_METRICS_DAYS); // Control and IPC limits stay equal
    });
});

describe('bounded autonomy: schedules.update from the Control API and the report limiter', () => {
    const ipcModule = () => require('../../../electron/ipc/facebookPosterIpc');
    const { CONTROL_CONFIG_SETTING_KEY } = require('../../services/control/controlConfig');
    const body = { kind: 'recurring', days: [1], time: '09:30', params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] } };
    let settingSpy: jest.SpyInstance;
    let master = true;
    const limiter = () => ipcModule().getAutonomyLimiter();
    const create = (enabled: boolean) => {
        const id = posterOperations.scheduleCreate(body).schedule!.id;
        if (!enabled) posterOperations.scheduleUpdate({ id, enabled: false });
        return id;
    };
    const origin = (id: string) => new FacebookPosterStore(mockDb).getSchedule(id)!.origin;
    beforeEach(() => {
        mockDb.run('DELETE FROM fb_poster_schedules');
        master = true;
        settingSpy = jest.spyOn(mockDatabaseInstance as { getSetting(key: string): string | null }, 'getSetting').mockImplementation((key: string) =>
            key === CONTROL_CONFIG_SETTING_KEY ? JSON.stringify({ protectedWritesEnabled: master }) : null);
        limiter().setPolicy({ enabled: true }, 'test');
    });
    afterEach(() => { limiter().setPolicy({ enabled: false }, 'test'); settingSpy.mockRestore(); });

    test('apiScheduleUpdateEnablingTagsApiOrigin', () => {
        const id = create(false);
        // A rename or turning it off through the API leaves the operator's schedule alone.
        posterOperations.scheduleUpdate({ id, name: 'Đổi tên' }, 'api');
        posterOperations.scheduleUpdate({ id, enabled: false }, 'api');
        posterOperations.scheduleUpdate({ id, time: '10:00' }, 'api'); // re-timing while off does not run anything
        expect(origin(id)).toBe('app');
        expect(posterOperations.scheduleUpdate({ id, enabled: true }, 'api').schedule).toMatchObject({ enabled: true, origin: 'api' });
    });

    test('apiScheduleUpdateRetimingTagsApiOrigin', () => {
        const id = create(true);
        posterOperations.scheduleUpdate({ id, enabled: true }, 'api'); // already on: not a takeover
        expect(origin(id)).toBe('app');
        expect(posterOperations.scheduleUpdate({ id, time: '10:45' }, 'api').schedule).toMatchObject({ time: '10:45', origin: 'api' });
    });

    test('apiScheduleUpdateRefusedWhenStopped', () => {
        const id = create(false);
        limiter().setPolicy({ enabled: false }, 'test');
        expect(() => posterOperations.scheduleUpdate({ id, enabled: true }, 'api')).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: expect.objectContaining({ reason: 'stopped' }) }));
        limiter().setPolicy({ enabled: true }, 'test');
        master = false;
        expect(() => posterOperations.scheduleUpdate({ id, enabled: true, time: '11:00' }, 'api')).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: expect.objectContaining({ reason: 'master_off' }) }));
        expect(new FacebookPosterStore(mockDb).getSchedule(id)).toMatchObject({ enabled: false, time: '09:30', origin: 'app' });
    });

    test('appScheduleUpdateKeepsOrigin', () => {
        const id = create(false);
        limiter().setPolicy({ enabled: false }, 'test'); // the operator is never limited
        expect(posterOperations.scheduleUpdate({ id, enabled: true }).schedule).toMatchObject({ enabled: true, origin: 'app' });
        posterOperations.scheduleUpdate({ id, time: '10:45' });
        expect(origin(id)).toBe('app');
        limiter().setPolicy({ enabled: true }, 'test');
        posterOperations.scheduleUpdate({ id, time: '11:00' }, 'api');
        posterOperations.scheduleUpdate({ id, time: '11:15' });
        expect(origin(id)).toBe('api');
    });

    test('buildReport reads the autonomy summary from the scheduler DB, not the live one', () => {
        new (require('../../services/dailyBrief/DailyBriefStore').DailyBriefStore)(mockDb).ensureSchema();
        startFacebookPosterScheduler();
        const deps = mockNotificationDeps;
        limiter().commit(limiter().reserve({ action: 'video', origin: 'api' })!);
        const original = mockDatabaseInstance;
        const replacement = memoryDb(); new FacebookPosterStore(replacement).ensureSchema();
        const query = jest.spyOn(replacement, 'query');
        mockDatabaseInstance = { ...original, ...replacement };
        try {
            const report = deps.buildReport({ key: 'k', label: 'l', from: NOW - 3_600_000, to: Date.now() + 3_600_000 }, 'daily');
            expect(report.autonomy).toMatchObject({ videos: 1 });
            expect(query.mock.calls.some((call) => String(call[0]).includes('autonomy_actions'))).toBe(false);
        } finally { mockDatabaseInstance = original; mockDb.run("DELETE FROM autonomy_actions WHERE action = 'video'"); }
    });
});
