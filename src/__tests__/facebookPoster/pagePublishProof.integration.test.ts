import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from './helpers';
import { BrowserProfileService } from '../../services/browser/BrowserProfileService';
import { ProfileJobQueue, type ProfileTaskContext } from '../../services/browser/ProfileJobQueue';
import { FacebookPosterService, type StartParams } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PostTracker } from '../../services/facebookPoster/PostTracker';
import { PostTrackScheduler } from '../../services/facebookPoster/PostTrackScheduler';
import { NotificationScheduler, buildMetricsReport } from '../../services/facebookPoster/NotificationScheduler';
import { NOTIFICATION_SETTING_KEY, parseNotificationConfig } from '../../services/facebookPoster/notificationRules';
import { DEFAULT_POST_TRACKING_CONFIG } from '../../services/facebookPoster/postTracking';
import { PageCampaignTracker } from '../../services/facebookPoster/PageCampaignTracker';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { readPageIdentity } from '../../services/dailyBrief/pageIdentity';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { buildCampaignReport } from '../../services/dailyBrief/pageCampaignMetrics';
import { ResearchStore } from '../../services/research/ResearchStore';
import { CONTROL_SCHEMA_SQL, ControlStore } from '../../services/control/ControlStore';
import { ControlEventRecorder } from '../../services/control/ControlEventRecorder';
import { hasControlEventSink, recordControlEvent } from '../../services/control/controlEvents';

// Spec 2026-10-31 (bằng chứng bài Page, số liệu, thông báo) — Task 9. Mô-đun thật: FacebookPosterService (postToTargets giả),
// PostTracker + PostTrackScheduler với openSession/readPage đi qua ProfileJobQueue thật trên BrowserProfileService (khởi chạy
// native và trang Playwright giả), bộ đọc Page readPageIdentity thật trên HTML tổng hợp, PageCampaign*Store, PageCampaignTracker,
// NotificationScheduler ghi sự kiện vào ControlStore thật qua ControlEventRecorder. Không dựng composition IPC (không có bộ hẹn
// giờ đăng nhập 07:00), không gọi Facebook/Telegram thật, đồng hồ là biến số, múi giờ truyền tường minh.

// Bảng tin nhóm giả theo khoá "<groupId>|<cursor>" (cùng cách PostTracker.test).
const feeds: Record<string, any> = {};
jest.mock('../../services/research/parsers', () => ({
    ...jest.requireActual('../../services/research/parsers'),
    parseGroupFeed: (text: string) => feeds[text] ?? { items: [], endCursor: null, errorCode: null },
}));

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const TZ = 'Asia/Ho_Chi_Minh';
const T0 = Date.UTC(2026, 9, 28, 3, 0); // Thứ Tư 28/10/2026 10:00 giờ Hồ Chí Minh
const HOME = 'https://www.facebook.com/';
const PAGE_ID = '777';
const GROUP = 'https://www.facebook.com/groups/111/';
const TEXT = 'Ưu đãi cuối tuần cho khách quen của Trang Bảy';
const USERS: Record<string, string> = { p1: '100001', p2: '100002' };
const localDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

interface FakePost { postId: string; text: string; postedAt: number; reactions: number; comments: number; shares: number }

/** HTML /me tổng hợp đúng dạng readPageIdentity đọc: profile đang đóng vai Page, kèm feed bài gần đây của Page. */
function identityHtml(profileId: string, posts: FakePost[]): string {
    const user = USERS[profileId];
    const actor = { id: user, is_profile_plus: true, delegate_page_id: PAGE_ID };
    const edges = posts.map((p) => ({ node: {
        __typename: 'Story', post_id: p.postId, actors: [{ id: user }], permalink_url: `https://www.facebook.com/${PAGE_ID}/posts/${p.postId}`,
        creation_time: Math.floor(p.postedAt / 1000),
        comet_sections: {
            content: { story: { message: { text: p.text } } },
            feedback: { story: { story_ufi_container: { story: { feedback_context: { feedback_target_with_context: {
                comet_ufi_summary_and_actions_renderer: { feedback: { adaptive_ufi_action_renderers: [{ feedback: {
                    reaction_count: { count: p.reactions }, comment_rendering_instance: { comments: { total_count: p.comments } }, share_count: { count: p.shares },
                } }] } },
            } } } } } },
        },
    } }));
    const data = { viewer: { actor }, user: { id: user, delegate_page: { id: PAGE_ID, name: 'Trang Bảy', viewer: { actor } }, timeline_list_feed_units: { edges } } };
    return `<script type="application/json">${JSON.stringify({
        define: [['CurrentUserInitialData', [], { USER_ID: user }]],
        require: [['RelayPrefetchedStreamCache', 'next', [], [null, { __bbox: { result: { data } } }]]],
    })}</script>`;
}

let dir: string;
let recorder: ControlEventRecorder;

beforeEach(() => {
    for (const k of Object.keys(feeds)) delete feeds[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-proof-'));
    recorder = new ControlEventRecorder();
});
afterEach(() => {
    recorder.deactivate();
    fs.rmSync(dir, { recursive: true, force: true });
});

function compose() {
    let clock = T0;
    const db = memoryDb();
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const briefs = new DailyBriefStore(db); briefs.ensureSchema();
    const campaigns = new PageCampaignStore(db); campaigns.ensureSchema();
    const executions = new PageCampaignExecutionStore(db); executions.ensureSchema();
    const researchStore = new ResearchStore(db); researchStore.ensureSchema();
    db.exec(CONTROL_SCHEMA_SQL);
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    recorder.sync(true, false, () => new ControlStore(db));
    for (const profileId of Object.keys(USERS)) {
        briefs.upsertIdentity({ profileId, kind: 'page', pageId: PAGE_ID, pageName: 'Trang Bảy', category: '', about: '', recentPosts: [], learnedAt: T0 - DAY, errorCode: '', error: '' });
    }

    // Trạng thái "Facebook" giả: bài gần đây của Page, số người theo dõi trả về ở mỗi lượt đọc của từng profile.
    const pagePosts: FakePost[] = [];
    const followers: Record<string, number> = { p1: 1200, p2: 1210 };
    const launches: string[] = [];
    const browser = new BrowserProfileService({
        store: {
            getBrowserProfileById: (id: string) => (USERS[id] ? { id, name: id, group_id: null, proxy_id: null, note: '',
                fingerprint: { seed: 1, hardwareConcurrency: 8, language: 'vi-VN', timezone: TZ }, last_opened_at: null, created_at: 0, updated_at: 0 } : null),
            getProxyById: () => null, touchBrowserProfileOpened: () => undefined,
        } as any,
        getProfilesDir: () => dir, getExecutablePath: () => '/synthetic/engine', platform: 'linux',
        launchAutomation: async (_exe, userDataDir) => {
            const profileId = path.basename(userDataDir);
            launches.push(profileId);
            const context = new EventEmitter() as any;
            const page = {
                url: () => 'https://www.facebook.com/me', goto: async () => null,
                content: async () => identityHtml(profileId, pagePosts.slice(-10).reverse()),
            };
            context.pages = () => [page]; context.newPage = async () => page;
            context.cookies = async () => [{ name: 'c_user', value: USERS[profileId] }];
            context.close = async () => { context.emit('close'); };
            return context;
        },
    });
    const queue = new ProfileJobQueue({ browser, now: () => clock });
    const owner = (jobId: string) => ({ workspaceId: 'workspace', generation: 1, jobId });
    const open = (profileId: string, context: ProfileTaskContext) => queue.open({ ...context, profileId, owner: owner(context.jobId) });

    const binds: string[] = [];
    const bind = (row: Parameters<PageCampaignExecutionStore['bindTrackedPost']>[0]) => { binds.push(executions.bindTrackedPost(row, clock, 'workspace')); };

    // Bước đăng giả: profile đăng một bài lên Page; trang "Facebook" có bài ngay sau đó.
    let publishOutcome: 'verified' | 'uncertain' = 'verified';
    let postSeq = 554;
    const publish = jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        const group = input.targets[0].includes('/groups/');
        const postId = String(++postSeq);
        if (group) {
            deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: `${GROUP}posts/${postId}/`, commentStatus: 'not_requested', identity: 'Me' });
            return;
        }
        pagePosts.push({ postId, text: input.text, postedAt: clock + 2 * MIN, reactions: 0, comments: 0, shares: 0 });
        if (publishOutcome === 'uncertain') {
            deps.onResult({ url: input.targets[0], ok: false, error: 'có thể bài đã lên', errorCode: 'uncertain_after_submit', postUrl: null, commentStatus: 'not_requested', identity: '' });
            return;
        }
        const url = `https://www.facebook.com/${deps.expectedPageId}/posts/${postId}`;
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: url, verifiedPostUrl: url, commentStatus: 'not_requested', identity: 'Trang Bảy' });
    });
    let runSeq = 0;
    const service = new FacebookPosterService({
        store: poster, getProfile: (id) => ({ id, name: id }), emit: () => undefined,
        acquireProfile: (profileId, context) => queue.acquire({ ...context, profileId, owner: owner(context.jobId) }),
        now: () => clock, random: () => 0.5, sleep: async () => undefined, newId: () => `run-${++runSeq}`,
        resolvePageId: (id) => { const i = briefs.getIdentity(id); return i?.kind === 'page' && !i.errorCode ? i.pageId : ''; },
        onPagePostKnown: bind,
        // Như createPageCampaignExecutionGuard.settle: chỉ ghi cho đúng run đang gửi / còn uncertain.
        createExecutionGuard: (scheduleId, runId) => ({
            variantIndex: 0, assertCurrent: () => undefined, assertPost: () => undefined, beforeEffect: async () => undefined,
            settle: (outcome, resultId) => {
                const execution = executions.get(scheduleId);
                if (execution?.runId !== runId || !['submitting', 'uncertain'].includes(execution.status)) return;
                executions.settle(scheduleId, outcome, resultId, clock);
            },
        }),
        tasks: { postToTargets: publish as any },
    });

    const reads: string[] = [];
    const sessions: string[] = [];
    let trackSeq = 0;
    const tracker = new PostTracker({
        store: poster,
        openSession: async (profileId, context) => {
            const opened = await open(profileId, context);
            sessions.push(profileId);
            const session = {
                open: async () => undefined, userId: () => USERS[profileId],
                ensureQuery: async () => ({ friendlyName: 'Q', docId: 'd', variables: { id: '111', cursor: null, count: 10 } }),
                recapture: async () => ({ friendlyName: 'Q', docId: 'd2', variables: { id: '111', cursor: null, count: 10 } }),
                call: async (_q: unknown, vars: any) => `${vars.id}|${vars.cursor}`,
            };
            return { session: session as any, close: () => opened.close() };
        },
        // Cùng thân với composition IPC: mở qua hàng chờ, đọc bằng readPageIdentity, luôn đóng phiên.
        // Bộ đọc thật chưa đọc số người theo dõi (chờ mẫu phản hồi thật đã lọc), nên ranh giới bộ đọc gắn một số đã biết
        // để kiểm phần ghi tối đa một lần mỗi ngày.
        readPage: async (profileId, context) => {
            const opened = await open(profileId, context);
            try {
                reads.push(profileId);
                const read = await readPageIdentity(opened.context.pages()[0] as any, { assertCurrent: context.assertCurrent });
                return { ...read, followers: followers[profileId] };
            } finally { await opened.close().catch(() => undefined); }
        },
        assertCurrent: () => undefined, observeLogin: jest.fn(), emit: () => undefined,
        now: () => clock, sleep: async () => undefined, random: () => 0, newId: () => `track-${++trackSeq}`,
        localDate, onPagePostKnown: bind,
    });
    const logs: string[] = [];
    const trackScheduler = new PostTrackScheduler({
        now: () => clock, setTimer: () => null, clearTimer: () => undefined, readConfig: () => DEFAULT_POST_TRACKING_CONFIG,
        isBusy: () => tracker.isRunning(), duePairs: (now, limit) => poster.listDuePairs(now, limit),
        runTrack: (pairs, auto) => { tracker.track({ pairs, auto }); }, log: (m) => { logs.push(m); },
    });

    const readSetting = (key: string) => db.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key])?.value ?? null;
    const notifier = () => new NotificationScheduler({
        now: () => clock, timeZone: () => TZ, setTimer: () => null, clearTimer: () => undefined,
        readConfig: () => parseNotificationConfig(readSetting(NOTIFICATION_SETTING_KEY)),
        readSetting, writeSetting: (key, value) => db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]),
        atomically: (fn) => db.transaction(fn), canPublish: hasControlEventSink, isCollecting: () => false, publish: recordControlEvent,
        buildReport: (period, cadence) => {
            const identities = briefs.listIdentities();
            return buildMetricsReport(poster, period, cadence, (pageId) => identities.find((i) => i.pageId === pageId)?.pageName || pageId);
        },
        leadsAfter: (cursor) => poster.listLeadsAfter(cursor), latestLeadCursor: () => poster.latestLeadCursor(), log: (m) => { logs.push(m); },
    });

    return {
        db, poster, campaigns, executions, researchStore, service, tracker, publish, pagePosts, followers, launches, reads, sessions, binds, logs, notifier,
        get clock() { return clock; }, set clock(v: number) { clock = v; },
        setPublishOutcome: (o: 'verified' | 'uncertain') => { publishOutcome = o; },
        /** Một nhịp của bộ hẹn giờ theo dõi (15 phút) rồi chờ lượt theo dõi xong. */
        trackTick: async () => { trackScheduler.tickNow(); await tracker.whenIdle(); },
        count: (table: string) => db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n,
        stats: (resultId: number) => db.query<any>('SELECT captured_at AS capturedAt, reactions, comments, shares FROM fb_poster_post_stats WHERE result_id = ? ORDER BY captured_at', [resultId]),
        events: (type: string) => db.query<any>('SELECT payload FROM control_events WHERE type = ? ORDER BY seq', [type]).map((r) => JSON.parse(r.payload)),
    };
}
type Harness = ReturnType<typeof compose>;

const pagePost = (profileIds: string[], over: Record<string, unknown> = {}): StartParams => ({
    kind: 'post', mode: 'page', text: TEXT, mediaPaths: [], comment: null, minDelaySec: 0, maxDelaySec: 0, concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0,
    profiles: profileIds.map((profileId) => ({ profileId, targets: [HOME] })), ...over,
} as StartParams);

async function publishPage(h: Harness, profileIds: string[], scheduleId?: string, over: Record<string, unknown> = {}) {
    const { runId } = h.service.start(pagePost(profileIds, over), scheduleId);
    await h.service.whenIdle();
    return runId;
}

/** Lịch tự động của chiến dịch với lượt thực thi đang gửi (như sau beginSubmit), gắn đúng run sắp chạy. */
function seedCampaign(h: Harness, runId: string) {
    const scope = { workspaceId: 'workspace', pageId: PAGE_ID, profileId: 'p1' };
    h.poster.createCampaign({ id: 'campaign', name: 'Cuối tuần', goal: '', status: 'active', startAt: null, endAt: null, createdAt: T0, updatedAt: T0 });
    h.db.run("INSERT INTO page_campaign_links VALUES ('campaign',?,?,?,1,1,'proposal',?,NULL)", [scope.workspaceId, scope.pageId, scope.profileId, T0]);
    h.poster.createSchedule({ id: 'schedule', name: 'Tự động', kind: 'once', params: pagePost(['p1'], { campaignId: 'campaign' }) as any, runAt: T0, days: [], time: '',
        enabled: true, nextRunAt: T0, createdAt: T0 });
    h.poster.updateAutonomySchedule('schedule', {}, T0, 1);
    const execution = { ...scope, scheduleId: 'schedule', workId: 'work', campaignId: 'campaign', grantId: 'grant', grantRevision: 1, runnerKeyId: 'runner',
        authorityFingerprint: 'fingerprint', selection: { variant: 'A', contentRevision: 'revision', factIds: [] }, plannedDate: localDate(T0), actualDate: localDate(T0),
        status: 'submitting', runId, resultId: null, revision: 1 };
    h.db.run('INSERT INTO page_campaign_executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [execution.scheduleId, scope.workspaceId, scope.pageId, scope.profileId,
        execution.workId, execution.campaignId, execution.grantId, execution.plannedDate, execution.actualDate, execution.status, execution.revision, JSON.stringify(execution)]);
    return scope;
}

/** Tương tác của bài trên Page tăng dần theo thời gian (giá trị đọc được ở lần mở Page kế tiếp). */
function setCounts(h: Harness, postId: string, reactions: number, comments: number, shares: number) {
    Object.assign(h.pagePosts.find((p) => p.postId === postId)!, { reactions, comments, shares });
}

test('pagePostKnownThenMeasuredAtThreeMilestonesAndFollowersOncePerDay', async () => {
    const h = compose();
    // Hai profile cùng quản lý Trang Bảy, mỗi profile đăng một bài trong cùng lượt.
    const runId = await publishPage(h, ['p1', 'p2']);
    const rows = h.poster.listTracking({}).sort((a, b) => a.resultId - b.resultId);
    expect(rows.map((r) => [r.profileId, r.targetKind, r.pageId, r.linkStatus, r.postId, r.postUrl, r.nextCheckAt])).toEqual([
        ['p1', 'page', PAGE_ID, 'known', '555', `https://www.facebook.com/${PAGE_ID}/posts/555`, T0 + 60 * MIN],
        ['p2', 'page', PAGE_ID, 'known', '556', `https://www.facebook.com/${PAGE_ID}/posts/556`, T0 + 60 * MIN],
    ]);
    expect(h.poster.getRun(runId)!.results.map((r) => r.outcome)).toEqual(['posted', 'posted']);

    const milestones: [number, number[]][] = [[60, [3, 1, 0]], [1440, [8, 2, 1]], [4320, [12, 4, 2]]];
    for (const [minutes, counts] of milestones) {
        setCounts(h, '555', counts[0], counts[1], counts[2]);
        setCounts(h, '556', counts[0] + 1, counts[1], counts[2]);
        h.clock = T0 + minutes * MIN;
        await h.trackTick();
    }
    const [a, b] = rows.map((r) => r.resultId);
    expect(h.stats(a)).toEqual(milestones.map(([m, c]) => ({ capturedAt: T0 + m * MIN, reactions: c[0], comments: c[1], shares: c[2] })));
    expect(h.stats(b).map((s) => s.reactions)).toEqual([4, 9, 13]);
    for (const row of h.poster.listTracking({})) {
        expect(row).toMatchObject({ linkStatus: 'known', statsDone: ['60m', '1440m', '4320m'], nextCheckAt: null, removedSuspected: false });
    }
    // Mỗi nhịp mở Page một lần cho mỗi profile (2 lượt đọc cùng ngày ở mốc 60 phút) nhưng chỉ một dòng người theo dõi mỗi ngày.
    expect(h.reads).toEqual(['p1', 'p2', 'p1', 'p2', 'p1', 'p2']);
    expect(h.poster.listPageFollowers({ sinceDay: '' }).map((f) => [f.capturedOn, f.followers, f.profileId])).toEqual([
        [localDate(T0), 1200, 'p1'], [localDate(T0 + 1440 * MIN), 1200, 'p1'], [localDate(T0 + 4320 * MIN), 1200, 'p1'],
    ]);
    expect(h.launches).toEqual(['p1', 'p2', 'p1', 'p2', 'p1', 'p2', 'p1', 'p2']);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.count('fb_poster_runs')).toBe(1);
    // Đã xong mọi mốc: không còn cặp đến hạn, nhịp sau không mở trình duyệt.
    h.clock = T0 + 5 * DAY;
    await h.trackTick();
    expect(h.launches).toHaveLength(8);
});

test('uncertainCampaignPostReconciledToPostedWithoutRepost', async () => {
    const h = compose();
    const scope = seedCampaign(h, 'run-1');
    h.setPublishOutcome('uncertain');
    const runId = await publishPage(h, ['p1'], 'schedule', { campaignId: 'campaign' });
    expect(runId).toBe('run-1');
    expect(h.executions.get('schedule')).toMatchObject({ status: 'uncertain', runId });
    const [row] = h.poster.listTracking({});
    expect(row).toMatchObject({ targetKind: 'page', pageId: PAGE_ID, linkStatus: 'missing', postId: '', postUrl: null, scheduleId: 'schedule', nextCheckAt: T0 + 30 * MIN });
    expect(h.campaigns.listPublished(scope, 'campaign')).toEqual([]);

    // Mốc thử lấy link 30 phút: Page có đúng một bài khớp đầu nội dung và giờ đăng (±15 phút) → known → lượt chiến dịch thành posted.
    h.clock = T0 + 30 * MIN;
    await h.trackTick();
    const known = h.poster.listTracking({})[0];
    expect(known).toMatchObject({ linkStatus: 'known', postId: '555', postUrl: `https://www.facebook.com/${PAGE_ID}/posts/555` });
    expect(h.binds).toEqual(['settled']);
    expect(h.executions.get('schedule')).toMatchObject({ status: 'posted', resultId: row.resultId, runId });
    expect(h.campaigns.listPublished(scope, 'campaign')).toEqual([expect.objectContaining({
        resultId: row.resultId, postId: '555', postUrl: `https://www.facebook.com/${PAGE_ID}/posts/555`, sourceRef: `post-tracking:${row.resultId}`, reason: '' })]);

    // Theo dõi tiếp không bao giờ đăng lại: một lần đăng, một lượt chạy, một kết quả.
    for (const minutes of [60, 1440]) { h.clock = T0 + minutes * MIN; await h.trackTick(); }
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.count('fb_poster_runs')).toBe(1);
    expect(h.count('fb_poster_results')).toBe(1);
    expect(h.poster.getRun(runId)!.results.map((r) => [r.outcome, r.errorCode])).toEqual([['failed', 'uncertain_after_submit']]);
    expect(h.binds).toEqual(['settled']); // bài đã known không gắn lại ở các nhịp sau
    expect(h.launches).toEqual(['p1', 'p1', 'p1', 'p1']);
});

test('campaignReportUsesPostStats', async () => {
    const h = compose();
    const scope = seedCampaign(h, 'run-1');
    await publishPage(h, ['p1'], 'schedule', { campaignId: 'campaign' });
    expect(h.binds).toEqual(['bound']);
    expect(h.executions.get('schedule')).toMatchObject({ status: 'posted' });
    for (const [minutes, [reactions, comments, shares]] of [[60, [2, 0, 0]], [1440, [6, 1, 0]], [4320, [9, 3, 1]]] as const) {
        setCounts(h, '555', reactions, comments, shares);
        h.clock = T0 + minutes * MIN;
        await h.trackTick();
    }
    h.clock = T0 + 4320 * MIN + 5 * MIN;
    const campaignTracker = new PageCampaignTracker({ db: h.db, researchStore: h.researchStore, now: () => h.clock, assertCurrent: () => undefined,
        research: { reserveSearch() { throw new Error('a bound Page post is measured from post stats, never research'); }, whenIdle: async () => undefined, cancelOwned: () => false } });
    for (let i = 0; i < 4; i++) await campaignTracker.collect(scope, 'campaign', () => undefined);
    const report = buildCampaignReport({ scope, campaignId: 'campaign', from: T0 - DAY, to: h.clock }, h.db);
    expect(report).toMatchObject({ published: 1, eligible: 1, measured: 1, coverage: 1, totalEngagement: 13, missingReasons: [] });
    expect(report.observations.find((o) => o.milestoneMinutes === 4320)).toMatchObject({
        status: 'measured', sourceRef: `post-stats:${h.poster.listTracking({})[0].resultId}:4320`, reactions: 9, comments: 3, shares: 1, observedAt: T0 + 4320 * MIN });
    expect(h.researchStore.countScans()).toBe(0);
});

test('groupAndPageRowsInOneTickWithoutCrossTalk', async () => {
    const h = compose();
    await publishPage(h, ['p1']);
    const groupRun = h.service.start({ ...pagePost(['p2']), mode: 'group', profiles: [{ profileId: 'p2', targets: [GROUP] }] } as StartParams).runId;
    await h.service.whenIdle();
    const rowOf = (kind: string) => h.poster.listTracking({}).find((r) => r.targetKind === kind)!;
    expect(rowOf('group')).toMatchObject({ profileId: 'p2', groupUrl: GROUP, groupId: '111', postId: '556', pageId: '', linkStatus: 'known', runId: groupRun });
    expect(rowOf('page')).toMatchObject({ profileId: 'p1', groupUrl: HOME, groupId: '', postId: '555', pageId: PAGE_ID, linkStatus: 'known' });
    setCounts(h, '555', 9, 2, 1);
    feeds['111|null'] = { items: [{ kind: 'post', fbId: '556', url: `${GROUP}posts/556/`, title: TEXT, authorId: USERS.p2, postedAt: T0, reactions: 4, comments: 1, shares: 0 }],
        endCursor: null, errorCode: null };

    h.clock = T0 + 60 * MIN;
    expect(h.poster.listDuePairs(h.clock, 10)).toEqual(expect.arrayContaining([{ profileId: 'p1', groupUrl: HOME, pageId: PAGE_ID }, { profileId: 'p2', groupUrl: GROUP }]));
    await h.trackTick();
    // Một lượt theo dõi xử lý cả hai cặp: Page qua readPage, nhóm qua phiên GraphQL nhóm; không cặp nào chạm nguồn của cặp kia.
    expect(h.reads).toEqual(['p1']);
    expect(h.sessions).toEqual(['p2']);
    expect(h.stats(rowOf('page').resultId)).toEqual([{ capturedAt: T0 + 60 * MIN, reactions: 9, comments: 2, shares: 1 }]);
    expect(h.stats(rowOf('group').resultId)).toEqual([{ capturedAt: T0 + 60 * MIN, reactions: 4, comments: 1, shares: 0 }]);
    for (const kind of ['page', 'group']) expect(rowOf(kind)).toMatchObject({ statsDone: ['60m'], lastCheckedAt: T0 + 60 * MIN, removedSuspected: false });
    expect(rowOf('group').postUrl).toBe(`${GROUP}posts/556/`);
    expect(rowOf('page').postUrl).toBe(`https://www.facebook.com/${PAGE_ID}/posts/555`);
    // Điểm nhóm và gom theo nhóm chỉ có nhóm thật, không có trang chủ (FB_HOME); gom theo Page chỉ có Page.
    const range = { from: T0 - DAY, to: T0 + DAY };
    expect(h.poster.groupScoreInputs(range).map((g) => g.groupUrl)).toEqual([GROUP]);
    expect(h.poster.statsReport({ ...range, limit: 100, groupBy: 'group' }).map((r) => r.key)).toEqual([GROUP]);
    expect(h.poster.statsReport({ ...range, limit: 100, groupBy: 'page' }).map((r) => [r.key, r.label])).toEqual([[PAGE_ID, 'Trang Bảy']]);
});

test('weeklyReportAndDigestExactlyOnceAcrossRestart', async () => {
    const h = compose();
    // Mặc định: báo cáo tuần thứ Hai 08:00, gom khách 60 phút. Lần chạy đầu chỉ ghi kỳ hiện tại và con trỏ, không gửi.
    h.notifier().tickNow();
    expect(h.count('control_events')).toBe(0);
    await publishPage(h, ['p1']);
    setCounts(h, '555', 5, 2, 1);
    h.clock = T0 + 60 * MIN;
    await h.trackTick();
    const [lead] = h.poster.createLeads([{ commentKey: 'k1', postUrl: `https://www.facebook.com/${PAGE_ID}/posts/555`, resultId: null, groupUrl: '', campaignId: null,
        variant: '', profileId: 'p1', authorId: 'a1', authorName: 'Khách A', authorUrl: '', text: 'ib giá', commentedAtMs: null, matched: ['giá'], aiIntent: null,
        aiScore: null, aiReason: '', status: 'new', note: '', detectedAt: T0 + 70 * MIN, updatedAt: T0 + 70 * MIN } as any]);

    // App tắt qua giờ gửi; mở lại thứ Hai 02/11 09:00 (giờ Hồ Chí Minh): đúng một báo cáo kỳ trước và một tin gom.
    h.clock = Date.UTC(2026, 10, 2, 2, 0);
    const afterRestart = h.notifier();
    afterRestart.tickNow();
    afterRestart.tickNow();
    h.notifier().tickNow(); // khởi động lại lần nữa
    const reports = h.events('metrics.report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ cadence: 'weekly', posts: 1, measured: 1, engagement: 8, notFound: 0,
        followers: [{ pageId: PAGE_ID, pageName: 'Trang Bảy', current: 1200, change: null }] });
    expect(reports[0].from).toBeLessThan(T0);
    expect(reports[0].to).toBe(Date.UTC(2026, 10, 2, 1, 0)); // thứ Hai 08:00 giờ Hồ Chí Minh
    const digests = h.events('leads.digest');
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ leadIds: [lead.id] });
    expect(h.count('control_events')).toBe(2);
});

test('digestIncludesALeadDetectedAfterTheClockWentBackExactlyOnce', async () => {
    const h = compose();
    const lead = (key: string, detectedAt: number) => h.poster.createLeads([{ commentKey: key, postUrl: `https://www.facebook.com/${PAGE_ID}/posts/555`, resultId: null,
        groupUrl: '', campaignId: null, variant: '', profileId: 'p1', authorId: key, authorName: key, authorUrl: '', text: 'ib giá', commentedAtMs: null, matched: ['giá'],
        aiIntent: null, aiScore: null, aiReason: '', status: 'new', note: '', detectedAt, updatedAt: detectedAt } as any])[0];
    h.notifier().tickNow(); // con trỏ gom khởi tạo trên bảng trống
    const first = lead('k1', T0 + 10 * MIN);
    h.clock = T0 + 80 * MIN;
    h.notifier().tickNow();
    // Đồng hồ máy bị lùi: lead mới có detected_at sớm hơn con trỏ nhưng id lớn hơn.
    const late = lead('k2', T0 + 5 * MIN);
    expect(late.id).toBeGreaterThan(first.id);
    h.clock = T0 + 150 * MIN;
    h.notifier().tickNow();
    h.notifier().tickNow();
    expect(h.events('leads.digest').map((d) => d.leadIds)).toEqual([[first.id], [late.id]]);
});
