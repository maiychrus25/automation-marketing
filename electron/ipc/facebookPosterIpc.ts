import { dialog, ipcMain } from 'electron';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import { FacebookPosterService, ENGINE_MISSING_ERROR } from '../../src/services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { buildRunCsv } from '../../src/services/facebookPoster/runCsv';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../../src/services/facebookPoster/mediaRules';
import { validateStartParams, type StartParamsEnv } from '../../src/services/facebookPoster/validateStartParams';
import { FacebookPosterScheduler, type MissedNotice } from '../../src/services/facebookPoster/FacebookPosterScheduler';
import { pruneDiagnostics } from '../../src/services/facebookPoster/diagnostics';
import { LoginChecker } from '../../src/services/facebookPoster/loginCheck';
import {
    LoginCheckScheduler, LOGIN_CHECK_SETTING_KEY, parseLoginCheckConfig, validateLoginCheckConfig,
} from '../../src/services/facebookPoster/LoginCheckScheduler';
import { PostTracker, MAX_TRACK_GROUPS, MAX_TRACK_SINCE_DAYS, DEFAULT_TRACK_SINCE_DAYS, type TrackParams } from '../../src/services/facebookPoster/PostTracker';
import { PostTrackScheduler } from '../../src/services/facebookPoster/PostTrackScheduler';
import {
    POST_TRACKING_SETTING_KEY, parsePostTrackingConfig, validatePostTrackingConfig,
} from '../../src/services/facebookPoster/postTracking';
import { CommentCollector } from '../../src/services/facebookPoster/CommentCollector';
import { CommentCollectScheduler } from '../../src/services/facebookPoster/CommentCollectScheduler';
import { LeadDetector, buildLeadsFoundPayload, type LeadAiState } from '../../src/services/facebookPoster/LeadDetector';
import { LEAD_CONFIG_SETTING_KEY, parseLeadConfig, validateLeadConfig } from '../../src/services/facebookPoster/leadRules';
import { createLeadClassifier, openLoggedInSession, buildLeadSheetRows } from '../../src/services/facebookPoster/leadWiring';
import { isLoggedIn } from '../../src/services/facebookPoster/loginState';
import AIAssistantService from '../../src/services/ai/AIAssistantService';
import { collectComments } from '../../src/services/facebookPoster/collectComments';
import { GraphqlSession } from '../../src/services/research/graphqlSession';
import { checkProfileIds } from '../../src/services/research/researchOperationsLogic';
import { computeNextRun } from '../../src/services/facebookPoster/scheduleTime';
import { planScheduleUpdate, readName, readTiming } from '../../src/services/facebookPoster/scheduleUpdate';
import { copyScheduleMedia, removeScheduleMedia, resolveScheduleMedia } from '../../src/services/facebookPoster/scheduleMedia';
import { getBrowserProfileService, isBrowserEngineInstalled } from './browserProfileIpc';
import { emitControlEvent, hasControlEventSink, buildRunStarted, buildRunFinished, buildScheduleMissed, buildDraftApproved, buildLoginProblem, buildCheckFinished, buildTrackFinished, buildLeadsFound, buildCollectFinished } from '../../src/services/control/controlEvents';
import { getResearchStore } from './researchIpc';
import { isWorkspaceSwitchInProgress } from './workspaceIpc';
import type { FbPosterLead, FbPosterRun, LeadStatus, LinkStatus, LoginCheckSource, PostStatsGroupBy, ProfileLoginState } from '../../src/models/facebookPoster';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../src/services/facebookPoster/drafts';
import { campaignBlockReason, readCampaignRef } from '../../src/services/facebookPoster/campaigns';
import { scoreGroups } from '../../src/services/facebookPoster/groupScores';
import { pickBestTimes } from '../../src/services/facebookPoster/bestTimes';
import { createCampaignOperations } from '../../src/services/facebookPoster/campaignOperations';


let service: FacebookPosterService | null = null;
let lastDbPath: string | null = null;
let checker: LoginChecker | null = null;
let checkerDbPath: string | null = null;
let checkerService: FacebookPosterService | null = null;
let loginScheduler: LoginCheckScheduler | null = null;
let tracker: PostTracker | null = null;
let trackerDbPath: string | null = null;
let trackerService: FacebookPosterService | null = null;
let trackScheduler: PostTrackScheduler | null = null;
let collector: CommentCollector | null = null;
let collectorDbPath: string | null = null;
let collectorService: FacebookPosterService | null = null;
let commentScheduler: CommentCollectScheduler | null = null;
let scheduler: FacebookPosterScheduler | null = null;
let schedulerDbPath: string | null = null;
// Missed-run notices not yet handed to the UI. Only the first takeMissed drains them; after that the UI is live
// and gets them as events, so a renderer reload cannot replay old notices.
let pendingMissed: MissedNotice[] = [];
let uiReady = false;

const MAX_PENDING_MISSED = 50;
const MAX_SCHEDULES = 200;
const CHECK_STOP_GRACE_MS = 45000; // same grace as FacebookPosterService.stopAndWait
const TRACKING_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRACK_LIST_LIMIT = 500;
const MAX_LEAD_LIST_LIMIT = 500;
const MAX_LEAD_NOTE_LENGTH = 1000;
const MAX_LEAD_SEARCH_LENGTH = 100;
const MAX_COLLECT_POST_URLS = 50;
const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'won', 'ignored'];
const MAX_TRACK_LIST_SCAN = 5000;
const DEFAULT_REPORT_DAYS = 30;
const BEST_TIMES_DAYS = 60;
const MAX_TIME_BUCKET_ROWS = 100000; // gom giờ / thứ chỉ có 24 / 7 dòng; nới giới hạn để không bị cắt
const LINK_STATUSES: LinkStatus[] = ['known', 'missing', 'pending_approval', 'not_found'];
const STATS_GROUP_BY: PostStatsGroupBy[] = ['group', 'profile', 'schedule', 'campaign', 'variant', 'day', 'post', 'hour', 'weekday'];
export const WORKSPACE_SWITCHING_ERROR = 'Đang đổi workspace, thử lại sau';
export const POSTER_NOT_STOPPED_ERROR = 'Việc Đăng Facebook chưa dừng được. Thử lại sau.';

const startEnv: StartParamsEnv = {
    profileExists: (id) => !!db().getBrowserProfileById(id),
    fileExists: (p) => fs.existsSync(p),
    fileSize: (p) => fs.statSync(p).size,
};

function db(): DatabaseService {
    return DatabaseService.getInstance();
}

/** Store over the active workspace DB; runs left 'running' by a crash are failed once per database. */
function store(): FacebookPosterStore {
    const s = new FacebookPosterStore(db());
    const dbPath = db().getDbPath();
    if (dbPath !== lastDbPath) {
        s.failInterruptedRuns(Date.now());
        safely('pruneTracking', () => { s.pruneTrackingOlderThan(Date.now() - TRACKING_RETENTION_MS); });
        safely('pruneLeads', () => { s.pruneLeadsOlderThan(Date.now() - TRACKING_RETENTION_MS); });
        lastDbPath = dbPath;
        // The service binds to a store, so a new database needs a new service (never while a run is active).
        // isBusy (run or login check): the checker holds the service's work slot, so never swap the service under it.
        if (service && !service.isBusy()) service = null;
    }
    return s;
}

function getService(): FacebookPosterService {
    const s = store();
    if (!service) {
        service = new FacebookPosterService({
            store: s,
            getProfile: (id) => {
                const p = db().getBrowserProfileById(id);
                return p ? { id: p.id, name: p.name } : null;
            },
            openForAutomation: (id) => getBrowserProfileService().openForAutomation(id),
            emit: (channel, data) => {
                EventBroadcaster.emit(channel, data);
                if (channel === 'facebookPoster:runFinished') {
                    safely('flushManualLeads', flushManualLeads);
                    recordRunFinished(data);
                    scheduler?.onRunFinished();
                }
            },
            diagnosticsDir: () => diagnosticsDir(),
            onLoginObserved: (profileId, state) => safely('onLoginObserved', () => getChecker().observe(profileId, state, 'run')),
            readTrackingConfig: readTrackingConfig,
            readLeadConfig,
            // Lượt thu bình luận thủ công (collect_comments) cũng lọc khách; lỗi lọc không làm hỏng lượt thu.
            // Khách của cả lượt được gom, phát một sự kiện khi lượt kết thúc (flushManualLeads).
            onCommentsSaved: async (rows) => {
                manualLeads.push(...await getDetector().process(rows, { auto: false, emit: false, aiState: manualLeadAi }));
            },
        });
    }
    return service;
}

/** Listener callbacks must never throw: a broken listener cannot turn a determined state into an error or break a run. */
function safely(label: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        Logger.error(`[facebookPosterIpc] ${label} failed: ${(err as Error).message}`);
    }
}

/** Login checker bound to the active workspace DB and the service's work slot; rebuilt when the DB changed and no check runs. */
function getChecker(): LoginChecker {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (checker && (checkerDbPath !== dbPath || checkerService !== svc) && !checker.isRunning()) checker = null;
    if (!checker) {
        checkerDbPath = dbPath;
        checkerService = svc;
        checker = new LoginChecker({
            store: store(),
            getProfile: (id) => {
                const p = db().getBrowserProfileById(id);
                return p ? { id: p.id, name: p.name } : null;
            },
            openForAutomation: (id) => getBrowserProfileService().openForAutomation(id),
            slot: { acquire: () => svc.acquireExclusive(), release: () => svc.releaseExclusive() },
            onProblem: (e) => safely('loginProblem', () => {
                emitControlEvent('profile.loginProblem', buildLoginProblem(e));
                emitLoginStatesChanged();
            }),
            onFinished: (e) => {
                safely('checkFinished', () => emitControlEvent('profiles.checkFinished', buildCheckFinished(e)));
                safely('onRunFinished', () => scheduler?.onRunFinished());
            },
            onProgress: (p) => safely('loginCheckProgress', () => EventBroadcaster.emit('facebookPoster:loginCheckProgress', p)),
            onStatesChanged: () => safely('loginStateChanged', emitLoginStatesChanged),
        });
    }
    return checker;
}

function readTrackingConfig() {
    return parsePostTrackingConfig(db().getSetting(POST_TRACKING_SETTING_KEY));
}

/** Post tracker bound to the active workspace DB and the service's work slot (same slot as the login checker); rebuilt when the DB or service changed and no job runs. */
function getTracker(): PostTracker {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (tracker && (trackerDbPath !== dbPath || trackerService !== svc) && !tracker.isRunning()) tracker = null;
    if (!tracker) {
        trackerDbPath = dbPath;
        trackerService = svc;
        const trackerStore = store();
        const researchStore = getResearchStore();
        tracker = new PostTracker({
            store: trackerStore,
            openSession: async (profileId) => {
                const session = await getBrowserProfileService().openForAutomation(profileId);
                try {
                    const page = session.context.pages()[0] ?? await session.context.newPage();
                    return { session: new GraphqlSession(page, researchStore), close: () => session.close() };
                } catch (err) {
                    await session.close().catch(() => undefined);
                    throw err;
                }
            },
            slot: { acquire: () => svc.acquireExclusive(), release: () => svc.releaseExclusive() },
            observeLogin: (profileId, state) => safely('trackObserveLogin', () => getChecker().observe(profileId, state, 'run')),
            emit: (type, payload) => {
                if (type === 'posts.trackProgress') EventBroadcaster.emit('facebookPoster:trackProgress', payload);
                else if (type === 'posts.trackFinished') {
                    EventBroadcaster.emit('facebookPoster:trackFinished', payload);
                    safely('controlTrackFinished', () => emitControlEvent('posts.trackFinished', buildTrackFinished(payload as any)));
                    safely('onRunFinished', () => scheduler?.onRunFinished()); // queued schedules start once the slot is free
                }
            },
            getConfig: readTrackingConfig,
            getLeadConfig: readLeadConfig,
        });
    }
    return tracker;
}

function readLeadConfig() {
    return parseLeadConfig(db().getSetting(LEAD_CONFIG_SETTING_KEY));
}

// Khách của lượt thu bình luận thủ công đang chạy; phát một lần khi lượt kết thúc.
let manualLeads: FbPosterLead[] = [];
let manualLeadAi: LeadAiState = { failed: false };

function flushManualLeads(): void {
    const found = manualLeads;
    manualLeads = [];
    manualLeadAi = { failed: false };
    if (found.length > 0) emitLeadsFound(buildLeadsFoundPayload(found, false));
}

/** Phát khi có khách mới: cho giao diện và cho Control API (`leads.found`, vào Telegram qua bridge). */
function emitLeadsFound(payload: { count: number; samples: { authorName: string; text: string; postUrl: string }[]; auto: boolean; leadIds: number[]; campaignIds: string[] }): void {
    EventBroadcaster.emit('facebookPoster:leadsFound', payload);
    emitControlEvent('leads.found', buildLeadsFound(payload));
}

/** Bộ lọc khách của DB đang dùng (không giữ trạng thái nên dựng mỗi lần). AI = trợ lý mặc định của app. */
function getDetector(): LeadDetector {
    return new LeadDetector({
        store: store(),
        readConfig: readLeadConfig,
        classify: createLeadClassifier({
            getAssistantId: () => AIAssistantService.getInstance().getDefaultAssistant()?.id ?? null,
            complete: (assistantId, messages) => AIAssistantService.getInstance().completeRaw(assistantId, messages),
        }),
        emit: (_type, payload) => emitLeadsFound(payload),
        log: (message) => Logger.warn(`[facebookPosterIpc] ${message}`),
    });
}

/** Bộ thu bình luận gắn với DB đang dùng và khe việc chung của service; dựng lại khi DB / service đổi và không có lượt thu. */
function getCollector(): CommentCollector {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (collector && (collectorDbPath !== dbPath || collectorService !== svc) && !collector.isRunning()) collector = null;
    if (!collector) {
        collectorDbPath = dbPath;
        collectorService = svc;
        collector = new CommentCollector({
            store: store(),
            launchFor: (profileId) => openLoggedInSession(() => getBrowserProfileService().openForAutomation(profileId), isLoggedIn),
            collect: collectComments,
            slot: { acquire: () => svc.acquireExclusive(), release: () => svc.releaseExclusive() },
            observeLogin: (profileId, state) => safely('commentObserveLogin', () => getChecker().observe(profileId, state, 'run')),
            detector: { process: (rows, opts) => getDetector().process(rows, opts) },
            readConfig: readLeadConfig,
            log: (message, level) => {
                if (level === 'error') Logger.error(`[facebookPosterIpc] thu bình luận: ${message}`);
                else if (level === 'warning') Logger.warn(`[facebookPosterIpc] thu bình luận: ${message}`);
            },
            emit: (type, payload) => {
                if (type === 'leads.found') emitLeadsFound(payload as Parameters<typeof emitLeadsFound>[0]);
                else if (type === 'comments.collectProgress') EventBroadcaster.emit('facebookPoster:commentCollectProgress', payload);
                else if (type === 'comments.collectFinished') {
                    EventBroadcaster.emit('facebookPoster:commentCollectFinished', payload);
                    safely('controlCollectFinished', () => emitControlEvent('comments.collectFinished', buildCollectFinished(payload as any)));
                    safely('onRunFinished', () => scheduler?.onRunFinished()); // lịch đăng đã xếp hàng chạy khi khe rảnh
                }
            },
        });
    }
    return collector;
}

function emitLoginStatesChanged(): void {
    EventBroadcaster.emit('facebookPoster:loginStateChanged', listFacebookLoginStates());
}

/** Saved login state of every profile that has one (profiles never checked are absent = unknown). */
export function listFacebookLoginStates(): ProfileLoginState[] {
    return store().listLoginStates();
}

/** Starts a background login check (null = every profile). Throws BUSY_ERROR while a run or another check holds the slot. Shared by IPC and the control API. */
export function checkFacebookLogins(profileIds: string[] | null, source: LoginCheckSource): { checkId: string; profileIds: string[] } {
    const ids = profileIds ?? db().getBrowserProfiles().map((p) => p.id);
    return getChecker().check(ids, source);
}

/** Records a login state seen outside a poster run (topic research); like a run, this raises profile.loginProblem. Never throws. */
export function observeFacebookLogin(profileId: string, state: 'logged_out' | 'checkpoint'): void {
    safely('researchObserveLogin', () => getChecker().observe(profileId, state, 'run'));
}

/** Profiles in the current poster run (any state): topic research must not pick them. */
export function listFacebookPosterRunProfileIds(): string[] {
    return service?.current()?.progress.profiles.map((p) => p.profileId) ?? [];
}

/** Control API event run.finished (additive; counts come from the stored results). Recorded before the scheduler may start the next run. */
function recordRunFinished(data: unknown): void {
    if (!hasControlEventSink()) return;
    try {
        const { runId, status } = (data ?? {}) as { runId?: string; status?: FbPosterRun['status'] };
        const found = runId ? store().getRun(runId) : null;
        if (found) emitControlEvent('run.finished', buildRunFinished({ ...found.run, status: status ?? found.run.status }, found.results, found.run.scheduleName));
    } catch (err) {
        Logger.error(`[facebookPosterIpc] control event run.finished failed: ${(err as Error).message}`);
    }
}

/** Starts a run and records the control API event run.started. Used by manual starts and the scheduler. */
function startRun(params: Parameters<FacebookPosterService['start']>[0], scheduleId?: string): { runId: string } {
    const started = getService().start(params, scheduleId);
    if (params.kind === 'post') {
        // Sau khi start thành công (BUSY thì không dọn) và giữ thư mục của chính lượt vừa bắt đầu.
        try {
            pruneDiagnostics(diagnosticsDir(), Date.now(), undefined, new Set([started.runId]));
        } catch (err) {
            Logger.warn(`[facebookPosterIpc] dọn ảnh chẩn đoán lỗi: ${(err as Error).message}`);
        }
    }
    emitControlEvent('run.started', buildRunStarted({ runId: started.runId, kind: params.kind, scheduleId: scheduleId ?? null }));
    return started;
}

/** True while the poster scheduler is running for the active workspace (control API system.status). */
export function isFacebookPosterSchedulerRunning(): boolean {
    return scheduler !== null;
}

/** True while a run or a login check is active; the updater refuses to restart then. */
export function isFacebookPosterBusy(): boolean {
    return (service?.isBusy() ?? false) || (tracker?.isRunning() ?? false) || (collector?.isRunning() ?? false);
}

/** Stops a running job (if any). Called on app quit and before the workspace database is switched. */
export function cancelFacebookPosterJobs(): void {
    service?.cancelAll();
    checker?.stop();
    tracker?.stop();
    collector?.stop();
}

/** Cancels the running job and waits (bounded) for it to end, so it cannot write into the next workspace DB. True = no job runs anymore. Never throws. */
export async function cancelAndWaitFacebookPosterJobs(): Promise<boolean> {
    const theChecker = checker;
    theChecker?.stop(); // dừng sau profile đang dở
    const theTracker = tracker;
    theTracker?.stop();
    const theCollector = collector;
    theCollector?.stop();
    let ok = true;
    try {
        if (service) ok = await service.stopAndWait();
    } catch {
        ok = false;
    }
    if (theChecker?.isRunning()) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, CHECK_STOP_GRACE_MS); timer.unref?.(); });
        await Promise.race([theChecker.whenIdle().catch(() => undefined), timedOut]);
        clearTimeout(timer);
        if (theChecker.isRunning()) ok = false;
    }
    if (theTracker?.isRunning()) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, CHECK_STOP_GRACE_MS); timer.unref?.(); });
        await Promise.race([theTracker.whenIdle().catch(() => undefined), timedOut]);
        clearTimeout(timer);
        if (theTracker.isRunning()) ok = false;
    }
    if (theCollector?.isRunning()) {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, CHECK_STOP_GRACE_MS); timer.unref?.(); });
        await Promise.race([theCollector.whenIdle().catch(() => undefined), timedOut]);
        clearTimeout(timer);
        if (theCollector.isRunning()) ok = false;
    }
    return ok;
}

const emitSchedulesChanged = (): void => EventBroadcaster.emit('facebookPoster:schedulesChanged', undefined);

function draftDeps(): DraftDeps {
    return { store: store(), env: startEnv, baseDir: scheduleBaseDir(), now: () => Date.now(), newId: () => randomUUID(), maxSchedules: MAX_SCHEDULES };
}

function scheduleBaseDir(): string {
    return path.dirname(db().getDbPath());
}

/** Ảnh chẩn đoán lượt đăng lỗi, cạnh DB của workspace. */
function diagnosticsDir(): string {
    return path.join(scheduleBaseDir(), 'fb-poster-diagnostics');
}

/** Việc phụ (theo dõi bài, thu bình luận, kiểm tra đăng nhập) nhường khe khi lịch đăng sắp tới trong chừng này. */
const SIDE_JOB_YIELD_MS = 10 * 60_000;
const SIDE_JOB_MAX_YIELD_MS = 60 * 60_000;

/**
 * Lịch đăng đang chờ khe hoặc sắp tới giờ trong SIDE_JOB_YIELD_MS thì việc phụ tự chạy phải nhường.
 * Lỗi đọc store trả false: lỗi đọc không được chặn việc phụ.
 */
export function scheduleWantsSlot(now: number, deps: { queued: () => number; nextAt: () => number | null } = {
    queued: () => scheduler?.queuedIds().length ?? 0,
    nextAt: () => store().nextScheduledAt(),
}): boolean {
    try {
        if (deps.queued() > 0) return true;
        const next = deps.nextAt();
        return next !== null && next <= now + SIDE_JOB_YIELD_MS;
    } catch {
        return false;
    }
}

/**
 * isBusy cho một việc phụ: bận khi `base()` bận, hoặc khi lịch đăng cần khe (scheduleWantsSlot) —
 * nhưng chỉ nhường liên tục tối đa SIDE_JOB_MAX_YIELD_MS. Hết hạn thì chỉ theo `base()` cho tới khi lịch hết cần khe.
 * Mỗi việc phụ một thể hiện riêng (có đồng hồ riêng).
 */
export function makeYieldingBusy(
    base: () => boolean,
    now: () => number = Date.now,
    wantsSlot: () => boolean = () => scheduleWantsSlot(now()),
): () => boolean {
    let yieldingSince: number | null = null;
    return () => {
        if (base()) return true;
        if (!wantsSlot()) {
            yieldingSince = null;
            return false;
        }
        const t = now();
        yieldingSince ??= t;
        return t - yieldingSince < SIDE_JOB_MAX_YIELD_MS;
    };
}

/** Starts the scheduler for the active workspace DB. No-op in employee mode or when one already runs for this DB. */
export function startFacebookPosterScheduler(): void {
    if (AppModeManager.getInstance().isEmployeeMode()) return;
    const dbPath = db().getDbPath();
    if (scheduler && schedulerDbPath === dbPath) return;
    stopFacebookPosterScheduler();
    pendingMissed = [];
    schedulerDbPath = dbPath;
    scheduler = new FacebookPosterScheduler({
        store: store(),
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        isBusy: () => service?.isBusy() ?? false,
        resolveParams: (s) => {
            const names = Array.isArray(s.params.mediaPaths) ? (s.params.mediaPaths as string[]) : [];
            const params = { ...s.params, mediaPaths: resolveScheduleMedia(scheduleBaseDir(), s.id, names) };
            const startParams = validateStartParams({ kind: 'post', params }, { ...startEnv, profileExists: () => true });
            if (!isBrowserEngineInstalled()) throw new Error(ENGINE_MISSING_ERROR);
            // Cột campaign_id của lịch là nguồn đúng; campaignId trong params_json bị bỏ qua.
            return startParams.kind === 'post' ? { ...startParams, campaignId: s.campaignId } : startParams;
        },
        // Lịch trỏ tới chiến dịch không còn thì không bị chặn.
        campaignBlock: (s, t) => {
            if (!s.campaignId) return null;
            const campaign = store().getCampaign(s.campaignId);
            return campaign ? campaignBlockReason(campaign, t) : null;
        },
        startRun: (params, scheduleId) => startRun(params, scheduleId),
        newId: randomUUID,
        onMissed: (notice) => {
            if (!uiReady) {
                pendingMissed.push(notice);
                if (pendingMissed.length > MAX_PENDING_MISSED) pendingMissed.shift();
            }
            EventBroadcaster.emit('facebookPoster:scheduleMissed', notice);
            emitControlEvent('schedule.missed', buildScheduleMissed(notice));
        },
        onChanged: emitSchedulesChanged,
    });
    scheduler.start();
    loginScheduler = new LoginCheckScheduler({
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        readConfig: () => parseLoginCheckConfig(db().getSetting(LOGIN_CHECK_SETTING_KEY)),
        isBusy: makeYieldingBusy(() => isFacebookPosterBusy()),
        runCheck: () => { checkFacebookLogins(null, 'daily'); },
        log: (msg) => Logger.warn(msg),
    });
    loginScheduler.start();
    trackScheduler = new PostTrackScheduler({
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        readConfig: readTrackingConfig,
        isBusy: makeYieldingBusy(() => isWorkspaceSwitchInProgress() || isFacebookPosterBusy()),
        duePairs: (now, limit) => store().listDuePairs(now, limit),
        runTrack: (pairs, auto) => { getTracker().track({ pairs, auto }); },
        log: (msg) => Logger.warn(msg),
    });
    trackScheduler.start();
    commentScheduler = new CommentCollectScheduler({
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        readConfig: readLeadConfig,
        isBusy: makeYieldingBusy(() => isWorkspaceSwitchInProgress() || isFacebookPosterBusy()),
        blockedUntil: () => collector?.blockedUntil ?? 0,
        duePosts: (now, limit) => store().listDueCommentPosts(now, limit),
        runCollect: () => { getCollector().collect({ auto: true }); },
        log: (msg) => Logger.warn(msg),
    });
    commentScheduler.start();
}

export function stopFacebookPosterScheduler(): void {
    const current = scheduler;
    const currentLogin = loginScheduler;
    const currentTrack = trackScheduler;
    const currentComment = commentScheduler;
    scheduler = null;
    loginScheduler = null;
    trackScheduler = null;
    commentScheduler = null;
    schedulerDbPath = null;
    current?.stop();
    currentLogin?.stop();
    currentTrack?.stop();
    currentComment?.stop();
}

function clampLimit(value: any, fallback: number, max: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function offsetOf(value: any): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** True when the Facebook Poster is unavailable because the app runs in employee mode. Shared by IPC and the control API. */
export function isFacebookPosterEmployeeBlocked(): boolean {
    return AppModeManager.getInstance().isEmployeeMode();
}

/** Same employee-mode guard and error envelope as browserProfileIpc. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (isFacebookPosterEmployeeBlocked()) {
                return { success: false, error: 'Tính năng Đăng Facebook chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            Logger.error(`[facebookPosterIpc] ${channel} error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

/** Handler bodies, shared verbatim by the IPC channels and the control API. Callers handle the employee-mode guard and envelope. */
export const posterOperations = {
    start: (params: any) => {
        const startParams = validateStartParams(params, startEnv);
        if (!isBrowserEngineInstalled()) {
            throw new Error(ENGINE_MISSING_ERROR);
        }
        return startRun(startParams);
    },

    scheduleCreate: (params: any) => {
        const now = Date.now();
        if (params.kind !== 'once' && params.kind !== 'recurring') throw new Error('Loại lịch không hợp lệ');
        const kind: 'once' | 'recurring' = params.kind;
        const startParams = validateStartParams({ kind: 'post', params: params.params }, startEnv);
        if (startParams.kind !== 'post') throw new Error('Loại lịch không hợp lệ');
        const timing = readTiming(kind, params, now);
        const name = readName(params.name) || startParams.text.trim().slice(0, 40);
        const theStore = store();
        const campaignId = readCampaignRef(params.campaignId, (cid) => theStore.getCampaign(cid)) ?? null;
        if (theStore.countSchedules() >= MAX_SCHEDULES) throw new Error('Tối đa 200 lịch cho một workspace');

        const id = randomUUID();
        const baseDir = scheduleBaseDir();
        const names = copyScheduleMedia(baseDir, id, startParams.mediaPaths);
        try {
            theStore.createSchedule({
                id, name, kind, ...timing,
                params: { ...startParams, mediaPaths: names },
                campaignId,
                enabled: true,
                nextRunAt: computeNextRun({ kind, ...timing }, now),
                createdAt: now,
            });
        } catch (err) {
            removeScheduleMedia(baseDir, id);
            throw err;
        }
        scheduler?.reschedule();
        emitSchedulesChanged();
        return { schedule: theStore.getSchedule(id) };
    },

    scheduleList: (params?: any) => {
        if (params?.campaignId !== undefined && typeof params.campaignId !== 'string') throw new Error('campaignId không hợp lệ');
        return {
            schedules: store().listSchedules(params?.campaignId === undefined ? {} : { campaignId: params.campaignId }),
            queuedIds: scheduler?.queuedIds() ?? [],
        };
    },

    scheduleUpdate: (params: any) => {
        const now = Date.now();
        const theStore = store();
        const current = typeof params.id === 'string' ? theStore.getSchedule(params.id) : null;
        if (!current) throw new Error('Không tìm thấy lịch');
        const fields = planScheduleUpdate(current, params, now);
        // Giữ nguyên khi không đổi (kể cả chiến dịch đã lưu trữ); chỉ kiểm khi gắn sang chiến dịch khác.
        const campaignId = params.campaignId === current.campaignId ? undefined : readCampaignRef(params.campaignId, (cid) => theStore.getCampaign(cid));
        theStore.updateSchedule(current.id, { ...fields, campaignId }, now);
        // Chỉ đổi giờ chạy mới huỷ "Đăng ngay"; đổi tên / chiến dịch thì lượt đang chờ vẫn được chạy.
        if (fields.nextRunAt !== undefined) scheduler?.clearCampaignGateBypass(current.id);
        scheduler?.reschedule();
        emitSchedulesChanged();
        return { schedule: theStore.getSchedule(current.id) };
    },

    scheduleDelete: (params: any) => {
        const id = typeof params.id === 'string' ? params.id : '';
        if (service?.current()?.run.scheduleId === id) {
            throw new Error('Lịch này đang chạy, hãy dừng lượt đăng trước khi xoá');
        }
        store().deleteSchedule(id);
        removeScheduleMedia(scheduleBaseDir(), id);
        scheduler?.reschedule();
        emitSchedulesChanged();
    },

    draftSave: (params: any) => {
        const schedule = saveDraft(draftDeps(), params);
        emitSchedulesChanged();
        return { schedule };
    },

    draftGet: (params: any) => getDraft(draftDeps(), params.id),

    draftApprove: (params: any) => {
        const schedule = approveDraft(draftDeps(), params);
        if (params?.when === 'now') scheduler?.bypassCampaignGateOnce(schedule.id); // lệnh trực tiếp: chiến dịch tạm dừng không chặn
        emitControlEvent('draft.approved', buildDraftApproved(schedule, params?.when));
        scheduler?.reschedule(); // "Đăng ngay" đặt nextRunAt = now → scheduler chạy qua hàng đợi
        emitSchedulesChanged();
        return { schedule };
    },

    takeMissed: (_params?: any) => {
        uiReady = true;
        const notices = pendingMissed;
        pendingMissed = [];
        return { notices };
    },

    cancel: (_params?: any) => {
        service?.cancel();
    },

    current: (_params?: any) => {
        const current = getService().current();
        return { run: current?.run ?? null, progress: current?.progress ?? null };
    },

    listGroups: (params: any) => {
        const ids = Array.isArray(params.profileIds) ? params.profileIds.filter((id: unknown) => typeof id === 'string') : [];
        return { groups: store().listGroups(ids) };
    },

    listRuns: (params: any) => {
        const kind = ['post', 'join', 'scan_groups', 'collect_comments'].includes(params.kind) ? params.kind : undefined;
        return store().listRuns({ limit: clampLimit(params.limit, 50, 200), offset: offsetOf(params.offset), kind });
    },

    getRun: (params: any) => {
        const found = typeof params.runId === 'string' ? store().getRun(params.runId) : null;
        if (!found) throw new Error('Không tìm thấy lần chạy');
        return found;
    },

    listComments: (params: any) => {
        const postUrl = typeof params.postUrl === 'string' && params.postUrl ? params.postUrl : undefined;
        const s = store();
        const page = s.listComments({ postUrl, limit: clampLimit(params.limit, 100, 500), offset: offsetOf(params.offset) });
        // Giao diện đánh dấu cột "Khách" cho bình luận đã thành khách.
        return { ...page, leadKeys: [...s.leadCommentKeys(page.comments.map((c) => c.key))] };
    },

    listPostedUrls: (_params?: any) => ({ posts: store().listPostedUrls(200) }),

    pickMedia: async (_params?: any) => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Ảnh/video', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }],
        });
        if (result.canceled) return { items: [] };
        return { items: result.filePaths.map((path) => ({ path, size: fs.statSync(path).size })) };
    },

    exportRunCsv: async (params: any) => {
        const found = typeof params.runId === 'string' ? store().getRun(params.runId) : null;
        if (!found) throw new Error('Không tìm thấy lần chạy');
        const result = await dialog.showSaveDialog({
            defaultPath: `facebook-poster-${found.run.id}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (result.canceled || !result.filePath) return { path: null };
        fs.writeFileSync(result.filePath, buildRunCsv(found.results), 'utf8');
        return { path: result.filePath };
    },
};

function parseTimeRange(params: any, defaultDays = DEFAULT_REPORT_DAYS): { from: number; to: number } {
    const to = params.to === undefined ? Date.now() : Number(params.to);
    const from = params.from === undefined ? to - defaultDays * DAY_MS : Number(params.from);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Khoảng thời gian không hợp lệ');
    return { from, to };
}

/** campaignId của bộ lọc báo cáo: chuỗi, '' = bài không thuộc chiến dịch. */
function readCampaignFilter(p: any): void {
    if (p.campaignId !== undefined && typeof p.campaignId !== 'string') throw new Error('campaignId không hợp lệ');
}

/** Campaign handler bodies, shared by the IPC channels and the control API. Changes make the scheduler re-evaluate its campaign gates. */
export const campaignOperations = createCampaignOperations({
    store, now: Date.now, newId: randomUUID, reschedule: () => scheduler?.reschedule(),
});

/** Post-tracking handler bodies, shared by the IPC channels and the control API (parameter checks live here). */
export const trackingOperations = {
    track: (params: any, auto = false) => {
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const p = params ?? {};
        const sinceDays = p.sinceDays === undefined ? DEFAULT_TRACK_SINCE_DAYS : p.sinceDays;
        if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_TRACK_SINCE_DAYS) {
            throw new Error(`sinceDays phải là số nguyên từ 1 đến ${MAX_TRACK_SINCE_DAYS}`);
        }
        const trackParams: TrackParams = { sinceDays, auto };
        if (p.groupUrls !== undefined) {
            if (!Array.isArray(p.groupUrls) || p.groupUrls.length === 0 || p.groupUrls.length > MAX_TRACK_GROUPS
                || p.groupUrls.some((u: unknown) => typeof u !== 'string' || !u)) {
                throw new Error(`groupUrls phải là 1–${MAX_TRACK_GROUPS} link nhóm`);
            }
            trackParams.groupUrls = p.groupUrls;
        }
        trackParams.profileIds = checkProfileIds(p.profileIds, db().getBrowserProfiles().map((b) => b.id));
        return getTracker().track(trackParams);
    },

    status: () => ({ ...getTracker().status() }),

    cancel: () => ({ cancelled: tracker?.cancel() ?? false }),

    list: (params: any) => {
        const p = params ?? {};
        const { from, to } = parseTimeRange(p);
        if (p.linkStatus !== undefined && !LINK_STATUSES.includes(p.linkStatus)) throw new Error('linkStatus không hợp lệ');
        for (const key of ['groupUrl', 'profileId', 'scheduleId']) {
            if (p[key] !== undefined && (typeof p[key] !== 'string' || !p[key])) throw new Error(`${key} không hợp lệ`);
        }
        readCampaignFilter(p);
        const limit = clampLimit(p.limit, 100, MAX_TRACK_LIST_LIMIT);
        const offset = offsetOf(p.offset);
        const s = store();
        const matched = s.listTracking({
            linkStatus: p.linkStatus, profileId: p.profileId, groupUrl: p.groupUrl, campaignId: p.campaignId, scheduleId: p.scheduleId, sinceMs: from, untilMs: to, limit: MAX_TRACK_LIST_SCAN,
        });
        const page = matched.slice(offset, offset + limit);
        const latest = new Map(s.latestStats(page.map((r) => r.resultId)).map((x) => [x.resultId, x]));
        return { total: matched.length, rows: page.map((r) => ({ ...r, latestStats: latest.get(r.resultId) ?? null })) };
    },

    stats: (params: any) => {
        const p = params ?? {};
        const { from, to } = parseTimeRange(p);
        if (!STATS_GROUP_BY.includes(p.groupBy)) throw new Error(`groupBy phải là một trong: ${STATS_GROUP_BY.join(', ')}`);
        if (p.scheduleId !== undefined && (typeof p.scheduleId !== 'string' || !p.scheduleId)) throw new Error('scheduleId không hợp lệ');
        readCampaignFilter(p);
        const limit = clampLimit(p.limit, 200, MAX_TRACK_LIST_LIMIT);
        return { rows: store().statsReport({ from, to, groupBy: p.groupBy, limit, campaignId: p.campaignId, scheduleId: p.scheduleId }) };
    },

    groupScores: (params: any) => {
        const p = params ?? {};
        const { from, to } = parseTimeRange(p);
        readCampaignFilter(p);
        return { groups: scoreGroups(store().groupScoreInputs({ from, to, campaignId: p.campaignId })) };
    },

    bestTimes: (params: any) => {
        const p = params ?? {};
        const { from, to } = parseTimeRange(p, BEST_TIMES_DAYS);
        if (p.groupUrl !== undefined && (typeof p.groupUrl !== 'string' || !p.groupUrl)) throw new Error('groupUrl không hợp lệ');
        readCampaignFilter(p);
        const s = store();
        const base = { from, to, limit: MAX_TIME_BUCKET_ROWS, campaignId: p.campaignId, groupUrl: p.groupUrl };
        return pickBestTimes(s.statsReport({ ...base, groupBy: 'hour' }), s.statsReport({ ...base, groupBy: 'weekday' }));
    },

    getConfig: () => ({ config: readTrackingConfig() }),

    setConfig: (params: any) => {
        const config = validatePostTrackingConfig(params);
        db().setSetting(POST_TRACKING_SETTING_KEY, JSON.stringify(config));
        return { config };
    },
};

function readLeadStatus(value: unknown): LeadStatus {
    if (!LEAD_STATUSES.includes(value as LeadStatus)) throw new Error(`status phải là một trong: ${LEAD_STATUSES.join(', ')}`);
    return value as LeadStatus;
}

/** Bộ lọc danh sách khách (dùng chung cho danh sách và xuất Excel). */
function readLeadFilter(p: any) {
    if (p.status !== undefined) readLeadStatus(p.status);
    readCampaignFilter(p);
    for (const key of ['from', 'to']) {
        if (p[key] !== undefined && !Number.isFinite(p[key])) throw new Error(`${key} không hợp lệ`);
    }
    if (p.search !== undefined && (typeof p.search !== 'string' || p.search.length > MAX_LEAD_SEARCH_LENGTH)) {
        throw new Error(`search phải là chuỗi tối đa ${MAX_LEAD_SEARCH_LENGTH} ký tự`);
    }
    return { status: p.status as LeadStatus | undefined, campaignId: p.campaignId as string | undefined, from: p.from as number | undefined, to: p.to as number | undefined, search: p.search as string | undefined };
}

/** Khách tiềm năng và thu bình luận: thân xử lý dùng chung cho IPC và control API (kiểm tham số nằm ở đây). */
export const leadOperations = {
    list: (params?: any) => {
        const p = params ?? {};
        const filter = readLeadFilter(p);
        return store().listLeads({ ...filter, limit: clampLimit(p.limit, 100, MAX_LEAD_LIST_LIMIT), offset: offsetOf(p.offset) });
    },

    update: (params: any) => {
        const p = params ?? {};
        if (!Number.isInteger(p.id) || p.id < 1) throw new Error('id khách không hợp lệ');
        if (p.status === undefined && p.note === undefined) throw new Error('Cần status hoặc note để cập nhật');
        const patch: { status?: LeadStatus; note?: string } = {};
        if (p.status !== undefined) patch.status = readLeadStatus(p.status);
        if (p.note !== undefined) {
            if (typeof p.note !== 'string' || p.note.length > MAX_LEAD_NOTE_LENGTH) throw new Error(`note phải là chuỗi tối đa ${MAX_LEAD_NOTE_LENGTH} ký tự`);
            patch.note = p.note;
        }
        const lead = store().updateLead(p.id, patch, Date.now());
        if (!lead) throw new Error('Không tìm thấy khách');
        return { lead };
    },

    getConfig: () => ({ config: readLeadConfig() }),

    setConfig: (params: any) => {
        const config = validateLeadConfig(params);
        db().setSetting(LEAD_CONFIG_SETTING_KEY, JSON.stringify(config));
        return { config };
    },

    exportXlsx: async (params?: any) => {
        const filter = readLeadFilter(params ?? {});
        const s = store();
        const result = await dialog.showSaveDialog({
            defaultPath: `khach-tiem-nang-${new Date().toISOString().slice(0, 10)}.xlsx`,
            filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        });
        if (result.canceled || !result.filePath) return { saved: false };
        const leads = [];
        for (;;) {
            const page = s.listLeads({ ...filter, limit: MAX_LEAD_LIST_LIMIT, offset: leads.length });
            leads.push(...page.leads);
            if (page.leads.length === 0 || leads.length >= page.total) break;
        }
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(buildLeadSheetRows(leads)), 'Khách tiềm năng');
        await fs.promises.writeFile(result.filePath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
        return { saved: true, path: result.filePath, count: leads.length };
    },

    collect: (params?: any) => {
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const p = params ?? {};
        if (p.postUrls !== undefined) {
            if (!Array.isArray(p.postUrls) || p.postUrls.length === 0 || p.postUrls.length > MAX_COLLECT_POST_URLS
                || p.postUrls.some((u: unknown) => typeof u !== 'string' || !u)) {
                throw new Error(`postUrls phải là 1–${MAX_COLLECT_POST_URLS} link bài`);
            }
        }
        return getCollector().collect({ postUrls: p.postUrls, auto: false });
    },

    collectStatus: () => ({ ...getCollector().status() }),

    collectCancel: () => ({ cancelled: collector?.cancel() ?? false }),

    /** Danh sách bình luận đã thu; `since` (ms) chỉ lấy bình luận thu từ mốc đó. */
    comments: (params?: any) => {
        const p = params ?? {};
        if (p.postUrl !== undefined && (typeof p.postUrl !== 'string' || !p.postUrl)) throw new Error('postUrl không hợp lệ');
        if (p.since !== undefined && !Number.isFinite(p.since)) throw new Error('since không hợp lệ');
        return store().listComments({ postUrl: p.postUrl, since: p.since, limit: clampLimit(p.limit, 100, MAX_TRACK_LIST_LIMIT), offset: offsetOf(p.offset) });
    },
};

export function registerFacebookPosterIpc(): void {
    handle('facebookPoster:start', posterOperations.start);
    handle('facebookPoster:scheduleCreate', posterOperations.scheduleCreate);
    handle('facebookPoster:scheduleList', posterOperations.scheduleList);
    handle('facebookPoster:scheduleUpdate', posterOperations.scheduleUpdate);
    handle('facebookPoster:scheduleDelete', posterOperations.scheduleDelete);
    handle('facebookPoster:campaignList', campaignOperations.list);
    handle('facebookPoster:campaignGet', campaignOperations.get);
    handle('facebookPoster:campaignCreate', campaignOperations.create);
    handle('facebookPoster:campaignUpdate', campaignOperations.update);
    handle('facebookPoster:campaignDelete', campaignOperations.delete);
    handle('facebookPoster:draftSave', posterOperations.draftSave);
    handle('facebookPoster:draftGet', posterOperations.draftGet);
    handle('facebookPoster:draftApprove', posterOperations.draftApprove);
    handle('facebookPoster:takeMissed', posterOperations.takeMissed);
    handle('facebookPoster:cancel', posterOperations.cancel);
    handle('facebookPoster:current', posterOperations.current);
    handle('facebookPoster:listGroups', posterOperations.listGroups);
    handle('facebookPoster:listRuns', posterOperations.listRuns);
    handle('facebookPoster:getRun', posterOperations.getRun);
    handle('facebookPoster:listComments', posterOperations.listComments);
    handle('facebookPoster:listPostedUrls', posterOperations.listPostedUrls);
    handle('facebookPoster:pickMedia', posterOperations.pickMedia);
    handle('facebookPoster:exportRunCsv', posterOperations.exportRunCsv);
    handle('facebookPoster:checkLogins', (params) => {
        let ids: string[] | null = null;
        if (Array.isArray(params.profileIds)) {
            ids = params.profileIds.filter((id: unknown): id is string => typeof id === 'string');
            if (ids.length === 0) throw new Error('Chưa chọn profile nào để kiểm tra');
        }
        return checkFacebookLogins(ids, 'manual');
    });
    handle('facebookPoster:trackPosts', (params) => trackingOperations.track(params));
    handle('facebookPoster:trackStatus', trackingOperations.status);
    handle('facebookPoster:trackCancel', trackingOperations.cancel);
    handle('facebookPoster:listTracking', trackingOperations.list);
    handle('facebookPoster:postStats', trackingOperations.stats);
    handle('facebookPoster:groupScores', trackingOperations.groupScores);
    handle('facebookPoster:bestTimes', trackingOperations.bestTimes);
    handle('facebookPoster:getTrackConfig', trackingOperations.getConfig);
    handle('facebookPoster:setTrackConfig', trackingOperations.setConfig);
    handle('facebookPoster:leadList', leadOperations.list);
    handle('facebookPoster:leadUpdate', leadOperations.update);
    handle('facebookPoster:leadConfigGet', leadOperations.getConfig);
    handle('facebookPoster:leadConfigSet', leadOperations.setConfig);
    handle('facebookPoster:leadExport', leadOperations.exportXlsx);
    handle('facebookPoster:commentCollect', leadOperations.collect);
    handle('facebookPoster:commentCollectStatus', leadOperations.collectStatus);
    handle('facebookPoster:commentCollectCancel', leadOperations.collectCancel);
    handle('facebookPoster:getLoginStates', () => ({ states: listFacebookLoginStates() }));
    handle('facebookPoster:getLoginCheckConfig', () => ({ config: parseLoginCheckConfig(db().getSetting(LOGIN_CHECK_SETTING_KEY)) }));
    handle('facebookPoster:setLoginCheckConfig', (params) => {
        const config = validateLoginCheckConfig(params);
        db().setSetting(LOGIN_CHECK_SETTING_KEY, JSON.stringify(config));
        loginScheduler?.reschedule();
        return { config };
    });
}
