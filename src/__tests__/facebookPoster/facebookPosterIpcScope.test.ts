// Employee profile scope in the poster operations: a call from the relay (_fromRelay + _profileScope) sees only its profiles; a boss call never does.
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
let mockQueued: string[] = [];
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
        queuedIds() { return mockQueued; }
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

import { posterOperations, campaignOperations, trackingOperations, leadOperations, scopedStatus, startFacebookPosterScheduler, stopFacebookPosterScheduler } from '../../../electron/ipc/facebookPosterIpc';

const NOW = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const asRelay = (p: Record<string, unknown> = {}, scope: string[] = ['p1']) => ({ ...p, _fromRelay: true, _profileScope: scope });
const params = (...ids: string[]) => JSON.stringify({ mode: 'group', text: 'secret text', profiles: ids.map((profileId) => ({ profileId, targets: [] })) });
const run = (sql: string, p: unknown[] = []) => mockDb.run(sql, p);

beforeAll(() => {
    new FacebookPosterStore(mockDb).ensureSchema();
    startFacebookPosterScheduler();
    run("INSERT INTO fb_poster_campaigns (id, name, created_at, updated_at) VALUES ('c1', 'c1', 1, 1), ('c2', 'c2', 1, 1), ('c-mixed', 'mixed', 1, 1), ('c-empty', 'empty', 1, 1), ('c-page', 'page', 1, 1)");
    const sch = (id: string, ids: string[], campaign: string | null) =>
        run('INSERT INTO fb_poster_schedules (id, name, kind, params_json, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)', [id, id, 'once', params(...ids), campaign]);
    sch('s1', ['p1'], 'c1'); sch('s2', ['p2'], 'c2'); sch('sm1', ['p1'], 'c-mixed'); sch('sm2', ['p2'], 'c-mixed'); sch('sp', ['p1'], 'c-page');
    mockDb.exec('CREATE TABLE IF NOT EXISTS page_campaign_links (campaign_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, page_id TEXT, profile_id TEXT, revision INTEGER, managed INTEGER, proposal_id TEXT, created_at INTEGER, deleted_at INTEGER)');
    run("INSERT INTO page_campaign_links VALUES ('c-page', 'w', 'pg', 'p1', 1, 1, 'pr', 1, NULL)");
    for (const [i, p] of [['r1', 'p1'], ['r2', 'p2'], ['r12', 'p1,p2']] as const) {
        run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?, 'post', 'group', ?, 'done', ?)", [i, params(...p.split(',')), NOW + (i === 'r2' ? 2 : 1)]);
        for (const profile of p.split(',')) run("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, post_url, created_at) VALUES (?, ?, 'n', 'https://g/1', 'posted', ?, ?)", [i, profile, `https://x/${i}-${profile}`, NOW]);
    }
    run("INSERT INTO fb_poster_groups (profile_id, url, name, scanned_at) VALUES ('p1', 'https://g/1', 'G1', 1), ('p2', 'https://g/2', 'G2', 1)");
    run("INSERT INTO fb_poster_comments (key, profile_id, post_url, collected_at) VALUES ('k1', 'p1', 'u', 1), ('k2', 'p2', 'u', 2)");
    run("INSERT INTO fb_poster_login_state (profile_id, state, checked_at, source) VALUES ('p1', 'ok', 1, 'check'), ('p2', 'logged_out', 2, 'check')");
    const tracked = (resultId: number, profile: string, postUrl: string, kind = 'group', pageId = '') =>
        run("INSERT INTO fb_poster_post_tracking (result_id, run_id, profile_id, group_url, post_url, posted_at, link_status, target_kind, page_id) VALUES (?, 'r', ?, 'https://g/1', ?, ?, 'known', ?, ?)", [resultId, profile, postUrl, NOW - resultId, kind, pageId]);
    tracked(1, 'p1', 'https://x/t1'); tracked(2, 'p2', 'https://x/t2'); tracked(3, 'p1', 'https://x/pg1', 'page', 'page-1'); tracked(4, 'p2', 'https://x/pg2', 'page', 'page-2');
    run("INSERT INTO fb_poster_page_followers (page_id, profile_id, captured_on, captured_at, followers) VALUES ('page-1', 'p1', ?, 1, 11), ('page-2', 'p2', ?, 1, 22)", [TODAY, TODAY]);
    run("INSERT INTO fb_poster_leads (comment_key, post_url, profile_id, detected_at, updated_at) VALUES ('k1', 'u', 'p1', 1, 1), ('k2', 'u', 'p2', 2, 2)");
    run("INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, text, status, created_at) VALUES (1, 'p1', 'u', 'a', 'posted', 1), (2, 'p2', 'u', 'b', 'posted', 2)");
});
afterAll(() => { stopFacebookPosterScheduler(); fs.rmSync(mockDir, { recursive: true, force: true }); });

// The database is shared by the whole file and some tests create schedules, drafts, campaigns and runs:
// remove whatever a test added so the exact-list assertions hold in any order.
const SEEDED_TABLES = ['fb_poster_schedules', 'fb_poster_campaigns', 'fb_poster_runs'] as const;
const seededIds = new Map<string, Set<string>>();
beforeAll(() => {
    for (const table of SEEDED_TABLES) seededIds.set(table, new Set(mockDb.query(`SELECT id FROM ${table}`).map((row: { id: string }) => String(row.id))));
});
afterEach(() => {
    for (const table of SEEDED_TABLES) {
        for (const row of mockDb.query(`SELECT id FROM ${table}`) as Array<{ id: string }>) {
            if (!seededIds.get(table)!.has(String(row.id))) run(`DELETE FROM ${table} WHERE id = ?`, [row.id]);
        }
    }
});

const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe('operations called through the relay see only their profiles; a boss call is unchanged', () => {
    test('scheduleList keepsTheScopedSchedulesAndTheirQueuedIds', () => {
        mockQueued = ['s1', 's2', 'sm1'];
        const both = posterOperations.scheduleList({});
        expect(idsOf(both.schedules)).toEqual(['s1', 's2', 'sm1', 'sm2', 'sp']);
        expect(both.queuedIds).toEqual(['s1', 's2', 'sm1']);
        const scoped = posterOperations.scheduleList(asRelay());
        expect(idsOf(scoped.schedules)).toEqual(['s1', 'sm1']); // sp belongs to the Page-managed campaign c-page: boss only
        expect(scoped.queuedIds).toEqual(['s1', 'sm1']);
        expect(idsOf(posterOperations.scheduleList({ _profileScope: ['p1'] }).schedules)).toEqual(['s1', 's2', 'sm1', 'sm2', 'sp']); // no _fromRelay: ignored
        expect(posterOperations.scheduleList(asRelay({}, [])).schedules).toEqual([]);
        mockQueued = [];
    });

    test('campaignList leavesOutMixedAndPageManagedCampaignsAndCountsOnlyTheScope', () => {
        const names = (r: any) => r.campaigns.map((c: any) => c.id).sort();
        expect(names(campaignOperations.list({}))).toEqual(['c-empty', 'c-mixed', 'c-page', 'c1', 'c2']);
        const scoped = campaignOperations.list(asRelay());
        expect(names(scoped)).toEqual(['c-empty', 'c1']);
        expect(scoped.campaigns.find((c: any) => c.id === 'c1').scheduleCount).toBe(1);
        expect(names(campaignOperations.list({ _profileScope: ['p1'] }))).toHaveLength(5);
        expect(names(campaignOperations.list(asRelay({}, ['p1', 'p2'])))).toEqual(['c-empty', 'c-mixed', 'c1', 'c2']); // Page-managed: never
    });

    test('campaignGet listsOnlyScopedSchedulesAndRefusesACampaignOutsideTheScope', () => {
        expect(campaignOperations.get(asRelay({ id: 'c1' })).campaign.schedules.map((s: any) => s.id)).toEqual(['s1']);
        expect(campaignOperations.get({ id: 'c-mixed' }).campaign.schedules).toHaveLength(2);
        expect(() => campaignOperations.get(asRelay({ id: 'c-mixed' }))).toThrow('Không tìm thấy chiến dịch');
        expect(() => campaignOperations.get(asRelay({ id: 'c2' }))).toThrow('Không tìm thấy chiến dịch');
        expect(() => campaignOperations.get(asRelay({ id: 'c-page' }, ['p1', 'p2']))).toThrow('Không tìm thấy chiến dịch');
    });

    test('campaignUpdateAndDeleteRefuseACampaignOutsideTheScope', () => {
        expect(() => campaignOperations.update(asRelay({ id: 'c-mixed', name: 'x' }))).toThrow('Không tìm thấy chiến dịch');
        expect(() => campaignOperations.delete(asRelay({ id: 'c-page' }, ['p1']))).toThrow('Không tìm thấy chiến dịch');
        expect(mockDb.queryOne<any>("SELECT name FROM fb_poster_campaigns WHERE id = 'c-mixed'")!.name).toBe('mixed');
        expect(campaignOperations.update(asRelay({ id: 'c1', name: 'c1 renamed' })).campaign.name).toBe('c1 renamed');
    });

    test('listRuns pagesAfterFilteringAndTotalIsTheFilteredCount', () => {
        const scoped = posterOperations.listRuns(asRelay({ kind: 'post', limit: 1, offset: 0 }));
        expect(scoped.runs.map((r: any) => r.id)).toEqual(['r1']);
        expect(scoped.total).toBe(1);
        const boss = posterOperations.listRuns({ kind: 'post' });
        expect(boss.total).toBe(3);
        expect(posterOperations.listRuns({ kind: 'post', _profileScope: ['p1'] }).total).toBe(3);
        expect(posterOperations.listRuns(asRelay({ kind: 'post' }, ['p1', 'p2'])).total).toBe(3);
    });

    test('listGroupsIsIntersectedWithTheScope', () => {
        expect(Object.keys(posterOperations.listGroups(asRelay({ profileIds: ['p1', 'p2'] })).groups)).toEqual(['p1']);
        expect(Object.keys(posterOperations.listGroups({ profileIds: ['p1', 'p2'] }).groups).sort()).toEqual(['p1', 'p2']);
    });

    test('listCommentsAndListPostedUrlsAndLoginStates', () => {
        expect(posterOperations.listComments({}).total).toBe(2);
        const comments = posterOperations.listComments(asRelay());
        expect(comments.total).toBe(1);
        expect(comments.comments.map((c: any) => c.profileId)).toEqual(['p1']);
        expect(posterOperations.listPostedUrls(asRelay()).posts.every((p: any) => p.profileId === 'p1')).toBe(true);
        expect(posterOperations.listPostedUrls({}).posts.length).toBeGreaterThan(posterOperations.listPostedUrls(asRelay()).posts.length);
        expect(posterOperations.getLoginStates(asRelay()).states.map((s: any) => s.profileId)).toEqual(['p1']);
        expect(posterOperations.getLoginStates({}).states).toHaveLength(2);
        expect(posterOperations.getLoginStates({ _profileScope: ['p1'] }).states).toHaveLength(2);
    });

    test('checkLogins refusesAnOutOfScopeProfileBeforeStartingACheck', () => {
        expect(() => posterOperations.checkLogins(asRelay({ profileIds: ['p2'] }))).toThrow('Chưa chọn profile nào để kiểm tra');
    });

    test('trackingList statsAndPageMetricsAreScoped', () => {
        const base = { from: 0, to: NOW + 86_400_000 };
        expect(trackingOperations.list({ ...base }).total).toBe(4);
        const list = trackingOperations.list(asRelay(base));
        expect(list.total).toBe(2);
        expect(list.rows.every((r: any) => r.profileId === 'p1')).toBe(true);
        expect(trackingOperations.list({ ...base, profileId: 'p2', ...asRelay() }).total).toBe(0);
        expect(trackingOperations.stats({ ...base, groupBy: 'profile' }).rows.map((r: any) => r.key).sort()).toEqual(['p1', 'p2']);
        expect(trackingOperations.stats(asRelay({ ...base, groupBy: 'profile' })).rows.map((r: any) => r.key)).toEqual(['p1']);
        expect(trackingOperations.stats({ ...base, groupBy: 'profile', _profileScope: ['p1'] }).rows).toHaveLength(2);
        const pages = (r: any) => r.pages.map((p: any) => p.pageId);
        expect(pages(trackingOperations.pageMetrics({}))).toEqual(['page-1', 'page-2']);
        expect(pages(trackingOperations.pageMetrics(asRelay()))).toEqual(['page-1']);
        expect(trackingOperations.pageMetrics(asRelay({ pageId: 'page-2' })).pages).toEqual([]);
        expect(trackingOperations.pageMetrics(asRelay({}, [])).pages).toEqual([]);
    });

    test('trackPostsRefusesAProfileOutsideTheScopeAndNeverFallsBackToEveryProfile', () => {
        expect(() => trackingOperations.track(asRelay({ profileIds: ['p2'] }))).toThrow('Hồ sơ không thuộc phạm vi của bạn');
        expect(() => trackingOperations.track(asRelay({ profileIds: ['p1', 'p2'] }))).toThrow('Hồ sơ không thuộc phạm vi của bạn');
        expect(() => trackingOperations.track(asRelay({}, []))).toThrow('profileIds không được rỗng');
        expect(() => trackingOperations.track(asRelay({ profileIds: 'p1' }))).toThrow('Hồ sơ không thuộc phạm vi của bạn');
    });

    test('groupScoresAndBestTimesPassTheScopeToTheStore', () => {
        const groupScores = jest.spyOn(FacebookPosterStore.prototype, 'groupScoreInputs');
        const statsReport = jest.spyOn(FacebookPosterStore.prototype, 'statsReport');
        try {
            trackingOperations.groupScores(asRelay());
            trackingOperations.bestTimes(asRelay());
            expect(groupScores.mock.calls.at(-1)![0].profileIds).toEqual(['p1']);
            expect(statsReport.mock.calls.slice(-2).map((c) => c[0].profileIds)).toEqual([['p1'], ['p1']]);
            trackingOperations.groupScores({});
            trackingOperations.bestTimes({ _profileScope: ['p1'] });
            expect(groupScores.mock.calls.at(-1)![0].profileIds).toBeUndefined();
            expect(statsReport.mock.calls.at(-1)![0].profileIds).toBeUndefined();
        } finally { groupScores.mockRestore(); statsReport.mockRestore(); }
    });

    test('leadListAndRepliesAreScoped', () => {
        expect(leadOperations.list({}).total).toBe(2);
        expect(leadOperations.list(asRelay()).leads.map((l: any) => l.profileId)).toEqual(['p1']);
        expect(leadOperations.list(asRelay()).total).toBe(1);
        expect(leadOperations.list({ _profileScope: ['p1'] }).total).toBe(2);
        expect(leadOperations.listReplies({}).replies).toHaveLength(2);
        expect(leadOperations.listReplies(asRelay()).replies.map((r: any) => r.profileId)).toEqual(['p1']);
    });

    test('trackStatusAndCollectStatusKeepOnlyCountersForAScopedCall', () => {
        const full = trackingOperations.status();
        expect(Object.keys(full)).toEqual(expect.arrayContaining(['running', 'jobId', 'progress', 'last']));
        const scoped = trackingOperations.status(asRelay()) as any;
        expect(scoped.running).toBe(false);
        expect(scoped.progress).toEqual({ done: 0, total: 0 });
        expect(scoped.last).toBeNull();
        const leaked = { running: false, jobId: 'j', progress: { done: 1, total: 2 }, last: { jobId: 'j', auto: false, finishedAt: 5, cancelled: false, posts: 2, collected: 3, leads: 1, errors: [{ postUrl: 'https://secret', profileId: 'p2', error: 'boom' }], shape: ['x'] } };
        expect(scopedStatus(leaked)).toEqual({ running: false, jobId: 'j', progress: { done: 1, total: 2 }, last: null }); // the previous job's result is boss-wide
        expect(JSON.stringify(scopedStatus(leaked))).not.toMatch(/secret|boom|p2/);
        expect(leadOperations.collectStatus(asRelay())).toEqual(expect.objectContaining({ running: false, last: null }));
    });

    test('campaignListWithAThrowingLookupFailsInsteadOfListingEverything', () => {
        const d = mockDatabaseInstance as any;
        d.queryStrict = () => { throw new Error('boom'); };
        d.queryOneStrict = () => { throw new Error('boom'); };
        try {
            expect(() => campaignOperations.list(asRelay())).toThrow();
            expect(() => campaignOperations.get(asRelay({ id: 'c1' }))).toThrow();
            expect(campaignOperations.list({}).campaigns.length).toBeGreaterThan(0); // the boss list never asks the lookup
        } finally { delete d.queryStrict; delete d.queryOneStrict; }
    });

    test('checkLoginsUnderAScopeNeverMeansEveryProfile', () => {
        expect(() => posterOperations.checkLogins(asRelay({}, []))).toThrow('Chưa chọn profile nào để kiểm tra');
        expect(() => posterOperations.checkLogins(asRelay({ profileIds: 'p1' }, []))).toThrow('Chưa chọn profile nào để kiểm tra');
    });

    test('commentCollectUnderAScopeNeedsItsPostUrls', () => {
        expect(() => leadOperations.collect(asRelay())).toThrow('Yêu cầu không hợp lệ');
    });

    test('aRelayedDraftSaveKeepsOnlyThePostKeys', () => {
        const draft = posterOperations.draftSave(asRelay({ params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: [] }], mediaIds: ['m1'], extra: 'x' } })).schedule!;
        const stored = JSON.parse(mockDb.queryOne<any>('SELECT params_json FROM fb_poster_schedules WHERE id = ?', [draft.id])!.params_json);
        expect(stored.mediaIds).toBeUndefined();
        expect(stored.extra).toBeUndefined();
        expect(stored.text).toBe('Bài');
        const boss = posterOperations.draftSave({ params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: [] }], extra: 'x' } }).schedule!;
        expect(JSON.parse(mockDb.queryOne<any>('SELECT params_json FROM fb_poster_schedules WHERE id = ?', [boss.id])!.params_json).extra).toBe('x'); // a boss call is unchanged
    });
});

describe('active runs', () => {
    afterEach(() => { mockScanTask = undefined; });
    test('activeKeepsOnlyRunsWhoseEveryProfileIsInScope', async () => {
        const gates: Array<() => void> = [];
        mockScanTask = async () => { await new Promise<void>((resolve) => gates.push(resolve)); return { groups: [] }; };
        posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p1'] } });
        posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['p2'] } });
        await new Promise((resolve) => setImmediate(resolve));
        try {
            const boss = posterOperations.active({}).runs;
            expect(boss).toHaveLength(2);
            const mine = posterOperations.active(asRelay()).runs;
            expect(mine).toHaveLength(1);
            expect(mine[0].progress.profiles.map((p: any) => p.profileId)).toEqual(['p1']);
            expect(posterOperations.active(asRelay({}, ['p1', 'p2'])).runs).toHaveLength(2);
            expect(posterOperations.active({ _profileScope: ['p1'] }).runs).toHaveLength(2);
            expect(posterOperations.active(asRelay({}, [])).runs).toEqual([]);
        } finally {
            gates.forEach((release) => release());
            await mockServiceInstance.whenIdle();
        }
    });
});

describe('the two internal keys are never stored', () => {
    const body = { kind: 'once', runAt: Date.now() + 3_600_000, name: 'n', params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }], _profileScope: ['p2'], _fromRelay: true } };
    const stored = (table: string, id: string) => (mockDb.queryOne<any>(`SELECT params_json FROM ${table} WHERE id = ?`, [id])!.params_json as string);
    const clean = (json: string) => expect(json).not.toMatch(/_profileScope|_fromRelay/);

    test('scheduleCreateKeepsThemOutOfParamsJson', () => {
        const created = posterOperations.scheduleCreate(asRelay(body)).schedule!;
        clean(stored('fb_poster_schedules', created.id));
    });

    test('draftSaveStripsTheKeysTheDraftParamsWouldSpreadIn', () => {
        const draft = posterOperations.draftSave(asRelay({ params: body.params })).schedule!;
        clean(stored('fb_poster_schedules', draft.id));
        const again = posterOperations.draftSave(asRelay({ id: draft.id, expectedRevision: undefined, params: { ...body.params, text: 'Bài mới' } })).schedule!;
        clean(stored('fb_poster_schedules', again.id));
    });

    test('startKeepsThemOutOfTheRunRow', async () => {
        mockScanTask = async () => ({ groups: [] });
        try {
            const { runId } = posterOperations.start(asRelay({ kind: 'scan_groups', params: { profileIds: ['p1'], _profileScope: ['p2'], _fromRelay: true } }));
            await mockServiceInstance.whenIdle();
            clean(stored('fb_poster_runs', runId));
        } finally { mockScanTask = undefined; }
    });

    test('setTrackConfigAndLeadConfigSetStoreOnlyTheirOwnFields', () => {
        const setSetting = mockDatabaseInstance.setSetting as jest.Mock;
        setSetting.mockClear();
        trackingOperations.setConfig(asRelay({ autoEnabled: true, linkRetryMinutes: [5], statsAtMinutes: [60] }));
        leadOperations.setConfig(asRelay({ autoCollect: true, collectAtMinutes: [60], keywords: ['giá'], detectPhone: true, aiEnabled: false, aiMinScore: 50 }));
        expect(setSetting).toHaveBeenCalledTimes(2);
        for (const call of setSetting.mock.calls) clean(String(call[1]));
    });

    test('campaignCreateAcceptsTheRelayKeysWithoutStoringThem', () => {
        const created = campaignOperations.create(asRelay({ name: 'Mới từ nhân viên' })).campaign;
        expect(JSON.stringify(created)).not.toMatch(/_profileScope|_fromRelay/);
    });
});
