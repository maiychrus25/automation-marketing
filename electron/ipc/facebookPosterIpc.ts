import { dialog, ipcMain } from 'electron';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { ProfileJobQueue, type ProfileJobRequest, type ProfileTaskContext } from '../../src/services/browser/ProfileJobQueue';
import { FacebookPosterCoordinator } from '../../src/services/facebookPoster/FacebookPosterCoordinator';
import { FacebookPosterService, BUSY_ERROR, ENGINE_MISSING_ERROR, type RunStartOptions } from '../../src/services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore, type SqlDatabase } from '../../src/services/facebookPoster/FacebookPosterStore';
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
import { PageCampaignTracker, CAMPAIGN_TRACK_MILESTONES } from '../../src/services/facebookPoster/PageCampaignTracker';
import { PageCampaignStore } from '../../src/services/dailyBrief/PageCampaignStore';
import { assertCampaignCollection } from '../../src/services/dailyBrief/pageCampaignOperations';
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
import { emitControlEvent, hasControlEventSink, buildRunStarted, buildRunFinished, buildScheduleMissed, buildDraftApproved, buildLoginProblem, buildCheckFinished, buildTrackFinished, buildLeadsFound, buildCollectFinished, buildPagesLearnFinished } from '../../src/services/control/controlEvents';
import { getResearchStore, getResearchService, isResearchRunning, cancelResearch, cancelAndWaitResearch, retireResearchService } from './researchIpc';
import { getPageWorkVideoOperations } from './videoIpc';
import { getInboxMediaStore } from './inboxMedia';
import { createPageWorkOperations, type PageWorkOperationsDeps } from '../../src/services/dailyBrief/pageWorkOperations';
import { createPageApprovalOperations, type PageApprovalDeps } from '../../src/services/dailyBrief/pageApprovalOperations';
import { VideoStore } from '../../src/services/video/VideoStore';
import { PageWorkStore } from '../../src/services/dailyBrief/PageWorkStore';
import { createPageCampaignExecutionGuard, recoverPageCampaignExecutions, type PageCampaignExecutionDeps } from '../../src/services/dailyBrief/pageCampaignExecution';
import type { ControlPrincipal, PageContext } from '../../src/models/pageOperations';
import { getDailyBriefStore } from './dailyBriefIpc';
import { PageLearner } from '../../src/services/dailyBrief/PageLearner';
import { readPageIdentity } from '../../src/services/dailyBrief/pageIdentity';
import { isWorkspaceSwitchInProgress } from './workspaceIpc';
import type { FbPosterLead, FbPosterRun, LeadStatus, LinkStatus, LoginCheckSource, PostStatsGroupBy, ProfileLoginState } from '../../src/models/facebookPoster';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../src/services/facebookPoster/drafts';
import { campaignBlockReason, readCampaignRef } from '../../src/services/facebookPoster/campaigns';
import { scoreGroups } from '../../src/services/facebookPoster/groupScores';
import { pickBestTimes } from '../../src/services/facebookPoster/bestTimes';
import { createCampaignOperations } from '../../src/services/facebookPoster/campaignOperations';


let service: FacebookPosterCoordinator | null = null;
let lastDbPath: string | null = null;
let campaignExecutionContext: Omit<PageCampaignExecutionDeps,'payload'> | null = null;
const campaignExecutionRunIds = new Set<string>();
const campaignExecutionWorkers = new Map<string, FacebookPosterService>();
let campaignTracker: PageCampaignTracker | null = null;

/** Never follows a new singleton DB; shared by leased requests and the existing tracking timer. */
export function getBoundPageCampaignCollector(boundDb: SqlDatabase): Pick<PageCampaignTracker,'collect'> {
    const captured=campaignExecutionContext;
    if (!captured || captured.db!==boundDb) throw new Error(WORKSPACE_SWITCHING_ERROR);
    const guard=()=>{
        captured.assertCurrent();
        if(campaignExecutionContext!==captured || !captured.protectedWritesEnabled()) throw new Error(WORKSPACE_SWITCHING_ERROR);
    };
    guard();
    if(!campaignTracker){
        const research=getResearchService(),researchStore=getResearchStore();guard();
        campaignTracker=new PageCampaignTracker({db:boundDb,research,researchStore,now:captured.now,assertCurrent:guard});
    }
    const instance=campaignTracker;
    return {collect:(scope,campaignId,assertCurrent,priority)=>{
        assertFacebookJobAdmission();
        guard();
        return instance.collect(scope,campaignId,()=>{guard();assertCurrent();},priority);
    }};
}
function runDueCampaignTracking():boolean {
    const captured=campaignExecutionContext;
    if(admissionPaused || !captured || campaignTracker?.isRunning() || isResearchRunning() || isWorkspaceSwitchInProgress())return false;
    try {
        captured.assertCurrent();if(!captured.protectedWritesEnabled())return false;
        const campaigns=new PageCampaignStore(captured.db);
        const links=captured.db.query<{campaign_id:string}>('SELECT campaign_id FROM page_campaign_links WHERE workspace_id=? AND deleted_at IS NULL',[captured.workspaceId]);
        for(const entry of links){
            const scope=campaigns.getLink(entry.campaign_id)!;
            const measurements=campaigns.listMeasurements(scope,scope.campaignId);
            const post=campaigns.listPublished(scope,scope.campaignId).find(row=>row.publishedAt!==null && CAMPAIGN_TRACK_MILESTONES.some(m=>
                captured.now()>=row.publishedAt!+m*60000 && !measurements.some(done=>done.resultId===row.resultId&&done.milestoneMinutes===m&&done.completedAt!==null)));
            if(!post)continue;
            const guard=()=>{captured.assertCurrent();if(campaignExecutionContext!==captured || !captured.protectedWritesEnabled())throw new Error(WORKSPACE_SWITCHING_ERROR);
                assertCampaignCollection(captured.db,scope,scope.campaignId,post.runnerKeyId,captured.now());};
            try {guard();}catch{continue;}
            void getBoundPageCampaignCollector(captured.db).collect(scope,scope.campaignId,guard,'background').catch(()=>undefined);
            return true;
        }
    }catch { /* A retired composition must not follow the new workspace. */ }
    return false;
}
async function drainCampaignTracking():Promise<boolean> {
    const current=campaignTracker;current?.cancel();
    if(!current?.isRunning())return true;
    let timer:NodeJS.Timeout|undefined;
    await Promise.race([current.whenIdle(),new Promise<void>(resolve=>{timer=setTimeout(resolve,CHECK_STOP_GRACE_MS);timer.unref?.();})]);
    clearTimeout(timer);return !current.isRunning();
}
/** Runtime composition passes captured context only, never a request principal. */
export function setPageCampaignExecutionContext(context: Omit<PageCampaignExecutionDeps,'payload'>): void {
    if(campaignTracker?.isRunning())throw new Error(POSTER_NOT_STOPPED_ERROR);
    campaignTracker=null;
    campaignExecutionContext=context;
}
export async function stopPageCampaignExecution(): Promise<boolean> {
    campaignExecutionContext=null;
    const trackingOwner = campaignTracker;
    const tracking = drainCampaignTracking();
    const managed = [...campaignExecutionRunIds].flatMap(id => campaignExecutionWorkers.get(id) ?? []);
    const stopped = await Promise.all([tracking, ...managed.map(worker => worker.stopAndWait())]);
    if (stopped[0] && campaignTracker === trackingOwner) campaignTracker=null;
    return stopped.every(Boolean);
}
function executionGuard(scheduleId:string,runId:string,payload?:Parameters<FacebookPosterService['start']>[0]) {
    if (!campaignExecutionContext) throw new Error('Lịch tự động chưa có ngữ cảnh thực thi');
    return createPageCampaignExecutionGuard({...campaignExecutionContext,payload},scheduleId,runId);
}
let checker: LoginChecker | null = null;
let checkerDbPath: string | null = null;
let checkerService: FacebookPosterCoordinator | null = null;
let learner: PageLearner | null = null;
let learnerDbPath: string | null = null;
let learnerService: FacebookPosterCoordinator | null = null;
let loginScheduler: LoginCheckScheduler | null = null;
let tracker: PostTracker | null = null;
let trackerDbPath: string | null = null;
let trackerService: FacebookPosterCoordinator | null = null;
let trackScheduler: PostTrackScheduler | null = null;
let collector: CommentCollector | null = null;
let collectorDbPath: string | null = null;
let collectorService: FacebookPosterCoordinator | null = null;
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
        recoverPageCampaignExecutions({db:db(),now:Date.now,workspaceId:WorkspaceManager.getInstance().getActiveWorkspace()?.id});
        s.failInterruptedRuns(Date.now());
        safely('pruneTracking', () => { s.pruneTrackingOlderThan(Date.now() - TRACKING_RETENTION_MS); });
        safely('pruneLeads', () => { s.pruneLeadsOlderThan(Date.now() - TRACKING_RETENTION_MS); });
        lastDbPath = dbPath;
        // The service binds to a store, so a new database needs a new service (never while a run is active).
        // The active coordinator retains its captured store until its workers settle.
        if (service && !service.isBusy()) service = null;
    }
    return s;
}

let profileQueue: ProfileJobQueue | null = null;
/** Page-work identity checks are not jobs with their own cancel: a lifecycle pause aborts their profile wait. */
const pausableActorChecks = new Set<AbortController>();
let posterGeneration = 0;
let admissionPaused = false;
let serviceBinding: { db: DatabaseService; path: string; generation: number } | null = null;
let pausedGeneration: typeof serviceBinding = null;

/** Lifecycle callers must exclude competing switch/quit/update transitions before taking this pause. */
export function isFacebookJobAdmissionPaused(): boolean { return admissionPaused; }

export function assertFacebookJobAdmission(): void {
    if (admissionPaused || isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
}

export function pauseFacebookJobAdmission(): void {
    if (!admissionPaused) pausedGeneration = serviceBinding ?? { db: db(), path: db().getDbPath(), generation: posterGeneration };
    admissionPaused = true;
    for (const check of pausableActorChecks) check.abort();
    service?.pause();
    profileQueue?.pause();
}

/** Whoever clears the workspace-switch flag must call this again afterwards: the queue resume is skipped while the flag is set. */
export function resumeFacebookJobAdmission(): void {
    if (pausedGeneration && (pausedGeneration.db !== db() || pausedGeneration.path !== db().getDbPath()
        || pausedGeneration.generation !== posterGeneration)) throw new Error(WORKSPACE_SWITCHING_ERROR);
    pausedGeneration = null;
    admissionPaused = false;
    service?.resume();
    // A refused switch resumes before clearing its flag; grants would fail their full check, so they wait for the final resume.
    if (!isWorkspaceSwitchInProgress()) profileQueue?.resume();
}

/** No old coordinator/queue/observer can become current again after a completed transition. */
export function retireFacebookJobGeneration(): void {
    if (!admissionPaused || isFacebookPosterBusy()) throw new Error(POSTER_NOT_STOPPED_ERROR);
    retireResearchService();
    stopFacebookPosterScheduler();
    service?.retire();
    profileQueue?.retire();
    ++posterGeneration;
    serviceBinding = null;
    service = null;
    profileQueue = null;
    checker = null; learner = null; tracker = null; collector = null; campaignTracker = null;
    campaignExecutionContext = null;
    campaignExecutionRunIds.clear(); campaignExecutionWorkers.clear();
    lastDbPath = null;
    pausedGeneration = null;
}

function getService(): FacebookPosterCoordinator {
    if (!service && admissionPaused) throw new Error(WORKSPACE_SWITCHING_ERROR);
    const s = store();
    if (!service) {
        const boundDb = db();
        const dbPath = boundDb.getDbPath();
        const workspaceId = WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath;
        const generation = ++posterGeneration;
        serviceBinding = { db: boundDb, path: dbPath, generation };
        const browser = getBrowserProfileService();
        // Settlement of a captured job still belongs to its workspace while a switch drains it: generation changes only at retire.
        const assertSettled = () => {
            if (generation !== posterGeneration || db() !== boundDb || boundDb.getDbPath() !== dbPath) throw new Error(WORKSPACE_SWITCHING_ERROR);
        };
        const assertCurrent = () => {
            assertSettled();
            if ((WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath) !== workspaceId || isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        };
        profileQueue?.retire();
        const yieldingSince = new WeakMap<ProfileJobRequest, number>();
        const resourcesChanged = () => {
            try { assertCurrent(); } catch { return; }
            if (schedulerDbPath === dbPath) scheduler?.onResourcesChanged();
        };
        const queue = new ProfileJobQueue({ browser, onChanged: resourcesChanged, deferUntil: (request, now) => {
            if (request.priority !== 'background') return null;
            assertCurrent();
            // Hints only: final authority and profile ownership are checked again at admission.
            try {
                const queued = new Set(schedulerDbPath === dbPath ? scheduler?.queuedIds() : []);
                const matching = s.listSchedules().filter(schedule => schedule.enabled && !schedule.draft
                    && Array.isArray(schedule.params.profiles) && schedule.params.profiles.some(profile => profile?.profileId === request.profileId)
                    && (queued.has(schedule.id) || (schedule.nextRunAt !== null && schedule.nextRunAt <= now + SIDE_JOB_YIELD_MS)));
                if (!matching.length) { yieldingSince.delete(request); return null; }
                const since = yieldingSince.get(request) ?? now;
                yieldingSince.set(request, since);
                const until = since + SIDE_JOB_MAX_YIELD_MS;
                if (now >= until) return null;
                const future = matching.map(schedule => schedule.nextRunAt).filter((at): at is number => at !== null && at > now);
                return Math.min(until, ...future);
            } catch { return null; }
        } });
        profileQueue = queue;
        const boundDiagnosticsDir = diagnosticsDir();
        const boundReadLeadConfig = () => parseLeadConfig(boundDb.getSetting(LEAD_CONFIG_SETTING_KEY));
        service = new FacebookPosterCoordinator({ store: s, onChanged: () => {
            resourcesChanged();
            queue.notifyAvailability();
        }, createWorker: runId => {
            const boundObserver = getBoundFacebookLoginObserver();
            const boundDetector = getDetector(s, boundReadLeadConfig);
            const foundLeads: FbPosterLead[] = [];
            const leadAi: LeadAiState = { failed: false };
            const worker = new FacebookPosterService({
                store: s,
                newId: () => runId,
                assertCurrent,
                createExecutionGuard: (scheduleId,runId,params) => {
                    assertCurrent();
                    const guard=executionGuard(scheduleId,runId,params);
                    campaignExecutionWorkers.set(runId, worker);
                    return guard;
                },
                getProfile: (id) => {
                    const p = boundDb.getBrowserProfileById(id);
                    return p ? { id: p.id, name: p.name } : null;
                },
                acquireProfile: (profileId, context) => queue.acquire({
                    ...context, profileId, owner: { workspaceId, generation, jobId: context.jobId },
                    assertCurrent: () => { assertCurrent(); context.assertCurrent(); },
                }),
                emit: (channel, data) => {
                    if (generation !== posterGeneration) return;
                    if (channel === 'facebookPoster:runFinished') {
                        if ((data as { runId?: string }).runId !== runId) return;
                        campaignExecutionRunIds.delete(runId);
                        campaignExecutionWorkers.delete(runId);
                    }
                    try { (channel === 'facebookPoster:runFinished' ? assertSettled : assertCurrent)(); } catch { return; }
                    EventBroadcaster.emit(channel, data);
                    if (channel === 'facebookPoster:runFinished') {
                        const found = foundLeads.splice(0);
                        leadAi.failed = false;
                        if (found.length) safely('flushManualLeads', () => emitLeadsFound(buildLeadsFoundPayload(found, false)));
                        recordRunFinished(data, s);
                        scheduler?.onRunFinished();
                    }
                },
                diagnosticsDir: () => boundDiagnosticsDir,
                onLoginObserved: (profileId, state) => safely('onLoginObserved', () => {
                    boundObserver(profileId, state);
                }),
                readTrackingConfig: () => parsePostTrackingConfig(boundDb.getSetting(POST_TRACKING_SETTING_KEY)),
                readLeadConfig: boundReadLeadConfig,
                // Lượt thu bình luận thủ công (collect_comments) cũng lọc khách; lỗi lọc không làm hỏng lượt thu.
                // Khách của cả lượt được gom, phát một sự kiện khi lượt kết thúc (flushManualLeads).
                onCommentsSaved: async (rows) => {
                    if (generation !== posterGeneration) return;
                    foundLeads.push(...await boundDetector.process(rows, { auto: false, emit: false, aiState: leadAi }));
                },
            });
            return worker;
        } });
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

/** Login checker and observer retain their captured workspace store. */
function getChecker(): LoginChecker {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (checker && (checkerDbPath !== dbPath || checkerService !== svc) && !checker.isRunning()) checker = null;
    if (!checker) {
        checkerDbPath = dbPath;
        checkerService = svc;
        const boundDb = db();
        const boundStore = new FacebookPosterStore(boundDb);
        const binding = getProfileJobBinding();
        const generation = posterGeneration;
        const workspaceId = WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath;
        const isSettled = () => service === svc && generation === posterGeneration && db() === boundDb && boundDb.getDbPath() === dbPath;
        const isCurrent = () => isSettled() && (WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath) === workspaceId
            && !isWorkspaceSwitchInProgress();
        const emitStates = () => {
            if (isCurrent()) EventBroadcaster.emit('facebookPoster:loginStateChanged', boundStore.listLoginStates());
        };
        checker = new LoginChecker({
            store: boundStore,
            getProfile: (id) => {
                const p = boundDb.getBrowserProfileById(id);
                return p ? { id: p.id, name: p.name } : null;
            },
            openForAutomation: binding.openForAutomation,
            assertCurrent: binding.assertCurrent,
            onProblem: (e) => safely('loginProblem', () => {
                if (!isCurrent()) return;
                emitControlEvent('profile.loginProblem', buildLoginProblem(e));
                emitStates();
            }),
            onFinished: (e) => {
                if (!isSettled()) return;
                safely('checkFinished', () => emitControlEvent('profiles.checkFinished', buildCheckFinished(e)));
                if (isSettled()) safely('onRunFinished', () => scheduler?.onRunFinished());
            },
            onProgress: (p) => safely('loginCheckProgress', () => {
                if (isCurrent()) EventBroadcaster.emit('facebookPoster:loginCheckProgress', p);
            }),
            onStatesChanged: () => safely('loginStateChanged', emitStates),
        });
    }
    return checker;
}

/** Learner binds its store and profile queue to one workspace generation. */
function getPageLearner(): PageLearner {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (learner && (learnerDbPath !== dbPath || learnerService !== svc)) {
        if (learner.isRunning()) throw new Error(BUSY_ERROR);
        learner = null;
    }
    if (!learner) {
        const binding = getProfileJobBinding();
        const boundStore = getDailyBriefStore();
        const observer = getBoundFacebookLoginObserver();
        let instance: PageLearner;
        const current = (check = binding.assertCurrent) => {
            try { check(); } catch { return false; }
            return learner === instance && !isFacebookPosterEmployeeBlocked();
        };
        instance = new PageLearner({
            store: () => boundStore,
            openForAutomation: binding.openForAutomation,
            assertCurrent: () => { if (!current()) throw new Error(WORKSPACE_SWITCHING_ERROR); },
            shouldYield: () => {
                if (!current()) { instance.stop(); return true; }
                return false;
            },
            observeLogin: (id, state) => {
                safely('learnObserveLogin', () => observer(id, state));
            },
            onFinished: (e) => {
                if (!current(binding.assertSettled)) return;
                safely('learnFinished', () => emitControlEvent('pages.learnFinished', buildPagesLearnFinished(e)));
                safely('onRunFinished', () => scheduler?.onRunFinished());
            },
            read: readPageIdentity,
        });
        learner = instance;
        learnerDbPath = dbPath;
        learnerService = svc;
    }
    return learner;
}

export function isPageLearnerRunning(): boolean { return learner?.isRunning() ?? false; }

/** Captured queue binding shared by posting and single-session side jobs. */
export function getProfileJobBinding() {
    const svc = getService();
    const queue = profileQueue!;
    const boundDb = db();
    const dbPath = boundDb.getDbPath();
    const workspaceId = WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath;
    const generation = posterGeneration;
    /** Finished notifications of a captured job: valid until retirement, also during a switch drain. */
    const assertSettled = () => {
        if (service !== svc || generation !== posterGeneration || db() !== boundDb || boundDb.getDbPath() !== dbPath) throw new Error(WORKSPACE_SWITCHING_ERROR);
    };
    /** Starting work or opening sessions: admission stays closed for the whole transition. */
    const assertCurrent = () => {
        assertSettled();
        if ((WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? dbPath) !== workspaceId || isWorkspaceSwitchInProgress()) {
            throw new Error(WORKSPACE_SWITCHING_ERROR);
        }
    };
    return {
        assertCurrent,
        assertSettled,
        openForAutomation: (profileId: string, context: ProfileTaskContext) => queue.open({
            ...context, profileId, owner: { workspaceId, generation, jobId: context.jobId },
            assertCurrent: () => { assertCurrent(); context.assertCurrent(); },
        }),
        isProfileBusy: (id: string) => !queue.canAcquire(id),
    };
}

/** Synchronous BUSY check and slot reservation, before the background read starts. */
export function learnPages(profileIds: string[] | null, force: boolean, assertCurrent?: () => void): { jobId: string; profileIds: string[] } {
    assertCurrent?.();
    if (admissionPaused || isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
    if (isFacebookPosterEmployeeBlocked()) throw new Error('Tính năng Học Page chỉ dùng được ở chế độ Boss/Standalone');
    const known = db().getBrowserProfiles().map((p) => p.id);
    const ids = checkProfileIds(profileIds === null ? undefined : profileIds, known) ?? known;
    return getPageLearner().learn([...new Set(ids)], force, assertCurrent);
}

function readTrackingConfig() {
    return parsePostTrackingConfig(db().getSetting(POST_TRACKING_SETTING_KEY));
}

/** Tracker binds store, configuration and sessions to one workspace generation. */
function getTracker(): PostTracker {
    const svc = getService();
    const dbPath = db().getDbPath();
    if (tracker && (trackerDbPath !== dbPath || trackerService !== svc) && !tracker.isRunning()) tracker = null;
    if (!tracker) {
        trackerDbPath = dbPath;
        trackerService = svc;
        const boundDb = db();
        const trackerStore = new FacebookPosterStore(boundDb);
        const researchStore = getResearchStore();
        const binding = getProfileJobBinding();
        const observer = getBoundFacebookLoginObserver();
        tracker = new PostTracker({
            store: trackerStore,
            assertCurrent: binding.assertCurrent,
            openSession: async (profileId, context) => {
                const session = await binding.openForAutomation(profileId, context);
                try {
                    const page = session.context.pages()[0] ?? await session.context.newPage();
                    binding.assertCurrent();
                    return { session: new GraphqlSession(page, researchStore, { assertCurrent: binding.assertCurrent }), close: () => session.close() };
                } catch (err) {
                    await session.close().catch(() => undefined);
                    throw err;
                }
            },
            observeLogin: (profileId, state) => safely('trackObserveLogin', () => observer(profileId, state)),
            emit: (type, payload) => {
                try { (type === 'posts.trackFinished' ? binding.assertSettled : binding.assertCurrent)(); } catch { return; }
                if (type === 'posts.trackProgress') EventBroadcaster.emit('facebookPoster:trackProgress', payload);
                else if (type === 'posts.trackFinished') {
                    EventBroadcaster.emit('facebookPoster:trackFinished', payload);
                    safely('controlTrackFinished', () => emitControlEvent('posts.trackFinished', buildTrackFinished(payload as any)));
                    safely('onRunFinished', () => scheduler?.onRunFinished()); // queued schedules start once the slot is free
                }
            },
            getConfig: () => parsePostTrackingConfig(boundDb.getSetting(POST_TRACKING_SETTING_KEY)),
            getLeadConfig: () => parseLeadConfig(boundDb.getSetting(LEAD_CONFIG_SETTING_KEY)),
        });
    }
    return tracker;
}

function readLeadConfig() {
    return parseLeadConfig(db().getSetting(LEAD_CONFIG_SETTING_KEY));
}

/** Phát khi có khách mới: cho giao diện và cho Control API (`leads.found`, vào Telegram qua bridge). */
function emitLeadsFound(payload: { count: number; samples: { authorName: string; text: string; postUrl: string }[]; auto: boolean; leadIds: number[]; campaignIds: string[] }): void {
    EventBroadcaster.emit('facebookPoster:leadsFound', payload);
    emitControlEvent('leads.found', buildLeadsFound(payload));
}

/** Bộ lọc khách của DB đang dùng (không giữ trạng thái nên dựng mỗi lần). AI = trợ lý mặc định của app. */
function getDetector(boundStore = store(), readConfig = readLeadConfig): LeadDetector {
    const assistant = AIAssistantService.getInstance();
    return new LeadDetector({
        store: boundStore,
        readConfig,
        classify: createLeadClassifier({
            getAssistantId: () => assistant.getDefaultAssistant()?.id ?? null,
            complete: (assistantId, messages) => assistant.completeRaw(assistantId, messages),
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
        const boundDb = db();
        const boundStore = new FacebookPosterStore(boundDb);
        const binding = getProfileJobBinding();
        const observer = getBoundFacebookLoginObserver();
        const readConfig = () => parseLeadConfig(boundDb.getSetting(LEAD_CONFIG_SETTING_KEY));
        const detector = getDetector(boundStore, readConfig);
        collector = new CommentCollector({
            store: boundStore,
            assertCurrent: binding.assertCurrent,
            launchFor: (profileId, context) => openLoggedInSession(() => binding.openForAutomation(profileId, context), isLoggedIn),
            collect: collectComments,
            observeLogin: (profileId, state) => safely('commentObserveLogin', () => observer(profileId, state)),
            detector,
            readConfig,
            log: (message, level) => {
                if (level === 'error') Logger.error(`[facebookPosterIpc] thu bình luận: ${message}`);
                else if (level === 'warning') Logger.warn(`[facebookPosterIpc] thu bình luận: ${message}`);
            },
            emit: (type, payload) => {
                // The lead flush and the finish settle the captured job; progress is live-only.
                try { (type === 'comments.collectProgress' ? binding.assertCurrent : binding.assertSettled)(); } catch { return; }
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
    assertFacebookJobAdmission();
    const ids = profileIds ?? db().getBrowserProfiles().map((p) => p.id);
    return getChecker().check(ids, source);
}

/** Records a login state seen outside a poster run (topic research); like a run, this raises profile.loginProblem. Never throws. */
export function getBoundFacebookLoginObserver() {
    const observer = getChecker();
    const generation = posterGeneration;
    return (profileId: string, state: 'ok' | 'logged_out' | 'checkpoint') => safely('observeLogin', () => {
        if (generation !== posterGeneration) return;
        observer.observe(profileId, state, 'run');
    });
}

export function observeFacebookLogin(profileId: string, state: 'logged_out' | 'checkpoint'): void {
    safely('researchObserveLogin', () => getChecker().observe(profileId, state, 'run'));
}

/** Union of profiles in every active poster plan, including profile waiters. */
export function listFacebookPosterRunProfileIds(): string[] {
    return [...new Set(service?.active().flatMap(({progress}) => progress.profiles.map(p => p.profileId)) ?? [])];
}

/** Control API event run.finished (additive; counts come from the stored results). Recorded before the scheduler may start the next run. */
function recordRunFinished(data: unknown, boundStore = store()): void {
    if (!hasControlEventSink()) return;
    try {
        const { runId, status } = (data ?? {}) as { runId?: string; status?: FbPosterRun['status'] };
        const found = runId ? boundStore.getRun(runId) : null;
        if (found) emitControlEvent('run.finished', buildRunFinished({ ...found.run, status: status ?? found.run.status }, found.results, found.run.scheduleName));
    } catch (err) {
        Logger.error(`[facebookPosterIpc] control event run.finished failed: ${(err as Error).message}`);
    }
}

/** Starts a run and records the control API event run.started. Used by manual starts and the scheduler. */
function startRun(params: Parameters<FacebookPosterService['start']>[0], scheduleId?: string, options?: RunStartOptions): { runId: string } {
    if (admissionPaused) throw new Error(WORKSPACE_SWITCHING_ERROR);
    let started: { runId: string };
    try { started = getService().start(params, scheduleId, options); }
    catch (error) {
        for (const id of campaignExecutionWorkers.keys()) if (!campaignExecutionRunIds.has(id)) campaignExecutionWorkers.delete(id);
        throw error;
    }
    if (campaignExecutionWorkers.has(started.runId)) campaignExecutionRunIds.add(started.runId);
    if (params.kind === 'post') {
        // Sau khi start thành công (BUSY thì không dọn) và giữ thư mục của chính lượt vừa bắt đầu.
        try {
            pruneDiagnostics(diagnosticsDir(), Date.now(), undefined, new Set(getService().active().map(({run}) => run.id)));
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

/** True while a poster or side job is active; the updater refuses to restart then. */
export function isFacebookPosterBusy(): boolean {
    return (profileQueue?.isBusy() ?? false) || isResearchRunning() || [...campaignExecutionWorkers.values()].some(worker => worker.isBusy()) || (service?.isBusy() ?? false) || (checker?.isRunning() ?? false) || (tracker?.isRunning() ?? false) || (campaignTracker?.isRunning() ?? false) || (collector?.isRunning() ?? false) || isPageLearnerRunning();
}

/** Stops a running job (if any). Called on app quit and before the workspace database is switched. */
export function cancelFacebookPosterJobs(): void {
    pauseFacebookJobAdmission();
    const cancellations = [
        () => campaignTracker?.cancel(), () => service?.cancelAll(), () => checker?.stop(),
        () => tracker?.stop(), () => collector?.stop(), () => learner?.stop(), () => cancelResearch(),
        ...[...campaignExecutionWorkers.values()].map(worker => () => worker.cancel()),
    ];
    for (const cancel of cancellations) safely('cancelJob', cancel);
}

/** Cancels the running job and waits (bounded) for it to end, so it cannot write into the next workspace DB. True = no job runs anymore. Never throws. */
export async function cancelAndWaitFacebookPosterJobs(): Promise<boolean> {
    pauseFacebookJobAdmission();
    const coordinator = service;
    const queue = profileQueue;
    const generation = posterGeneration;
    const managed = [...new Set(campaignExecutionWorkers.values())];
    const sideJobs = [checker, tracker, collector, learner, campaignTracker];
    cancelFacebookPosterJobs();
    const waitForSide = async (job: { isRunning(): boolean; whenIdle(): Promise<void> } | null): Promise<boolean> => {
        if (!job?.isRunning()) return true;
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                job.whenIdle().then(() => !job.isRunning(), () => false),
                new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), CHECK_STOP_GRACE_MS); timer.unref?.(); }),
            ]);
        } catch { return false; }
        finally { clearTimeout(timer); }
    };
    // Invoke every drain before awaiting: research captures its own current service synchronously.
    const results = await Promise.all([
        ...sideJobs.map(waitForSide),
        Promise.resolve().then(() => coordinator?.stopAndWait() ?? true).catch(() => false),
        ...managed.map(worker => Promise.resolve().then(() => worker.stopAndWait()).catch(() => false)),
        cancelAndWaitResearch().catch(() => false),
    ]);
    if (!results.every(Boolean)) return false;
    // Owners may only stop at their force close; the queue's own bound starts after they settled.
    const queueIdle = await (queue?.waitUntilIdle(CHECK_STOP_GRACE_MS).catch(() => false) ?? true);
    return queueIdle && generation === posterGeneration && coordinator === service && queue === profileQueue;

}

const emitSchedulesChanged = (): void => {
    scheduler?.onResourcesChanged();
    profileQueue?.notifyAvailability();
    EventBroadcaster.emit('facebookPoster:schedulesChanged', undefined);
};

function draftDeps(): DraftDeps {
    return { store: store(), env: startEnv, baseDir: scheduleBaseDir(), now: () => Date.now(), newId: () => randomUUID(), maxSchedules: MAX_SCHEDULES };
}

/** Internal capability factory for Tasks6/7; no renderer or HTTP registration. */
export function createBoundPageWorkDependencies(context: (workId: string) => PageContext, assertAuthorized: () => void): PageWorkOperationsDeps {
    const boundDb = db();
    const boundPath = boundDb.getDbPath();
    let stale = false;
    const assertCurrent = () => {
        stale ||= db() !== boundDb || db().getDbPath() !== boundPath || isWorkspaceSwitchInProgress();
        if (stale) throw new Error(WORKSPACE_SWITCHING_ERROR);
        if (isFacebookPosterEmployeeBlocked()) throw new Error('Công việc Page không khả dụng ở chế độ nhân viên');
        assertAuthorized();
    };
    assertCurrent();
    // Schema/service startup may write; finish all initialization before any work transaction.
    new PageWorkStore(boundDb).ensureSchema();
    const research = getResearchService();
    const researchStore = getResearchStore();
    const video = getPageWorkVideoOperations();
    const shared = getProfileJobBinding();
    return {
        db: boundDb, now: Date.now, assertCurrent,
        context: (workId) => {
            assertCurrent();
            const resolved = context(workId);
            if (resolved.dbPath !== boundPath) throw new Error(WORKSPACE_SWITCHING_ERROR);
            return resolved;
        },
        draft: { env: { ...startEnv, profileExists: id => !!boundDb.getBrowserProfileById(id) },
            baseDir: path.dirname(boundPath), now: Date.now, maxSchedules: MAX_SCHEDULES },
        research, researchStore, video, media: getInboxMediaStore(),
        assertActor: async (resolved, guard) => {
            guard();
            const controller = new AbortController();
            pausableActorChecks.add(controller);
            let opened: Awaited<ReturnType<ReturnType<typeof getBrowserProfileService>['openForAutomation']>> | undefined;
            try {
                guard();
                assertFacebookJobAdmission();
                opened = await shared.openForAutomation(resolved.profileId, { jobId: randomUUID(), signal: controller.signal,
                    priority: 'interactive', assertCurrent: guard });
                guard();
                const page = opened.context.pages()[0] ?? await opened.context.newPage();
                guard();
                const actor = await readPageIdentity(page, { assertCurrent: guard });
                guard();
                if (actor.kind !== 'page' || actor.pageId !== resolved.pageId) throw new Error('Danh tính Page hiện tại không khớp');
            } finally {
                pausableActorChecks.delete(controller);
                await opened?.close();
            }
        },
    };
}

export function createBoundPageWorkOperations(context: (workId: string) => PageContext, assertAuthorized: () => void) {
    return createPageWorkOperations(createBoundPageWorkDependencies(context, assertAuthorized));
}

/** Promotion has already committed; shared by legacy and protected receiver, never promotes again. */
function afterDraftApproval(schedule: ReturnType<typeof approveDraft>, when: unknown): void {
    if (when === 'now') scheduler?.bypassCampaignGateOnce(schedule.id);
    emitControlEvent('draft.approved', buildDraftApproved(schedule, when));
    scheduler?.reschedule();
    emitSchedulesChanged();
}

function resourceFileHash(file: string): string {
    const hash = createHash('sha256'); const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(64 * 1024); let size: number;
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
}

/** Read-only evidence from actual local rows/files. Unowned legacy media/video has no protected provenance. */
export function createBoundPageApprovalDependencies(assertAuthorized: () => void): Omit<PageApprovalDeps, 'receiver'> {
    const boundDb = db(); const boundPath = boundDb.getDbPath(); const baseDir = path.dirname(boundPath);
    let stale = false;
    const assertCurrent = () => {
        stale ||= db() !== boundDb || db().getDbPath() !== boundPath || isWorkspaceSwitchInProgress();
        if (stale) throw new Error(WORKSPACE_SWITCHING_ERROR);
        if (isFacebookPosterEmployeeBlocked()) throw new Error('Công việc Page không khả dụng ở chế độ nhân viên');
        assertAuthorized();
    };
    assertCurrent();
    const works = new PageWorkStore(boundDb); works.ensureSchema();
    const poster = new FacebookPosterStore(boundDb); poster.ensureSchema();
    const research = getResearchStore(); const identities = getDailyBriefStore();
    const media = getInboxMediaStore(); const videos = new VideoStore(boundDb); videos.ensureSchema();
    return { db: boundDb, now: Date.now, assertCurrent,
        draft: { env: { ...startEnv, profileExists: id => !!boundDb.getBrowserProfileById(id) }, baseDir, now: Date.now, newId: randomUUID, maxSchedules: MAX_SCHEDULES },
        inspectResource: (ref, work) => {
            assertCurrent();
            const owner = works.getResourceOwner(ref);
            const originating = owner && works.get(owner.workId);
            const identity = identities.getIdentity(work.profileId);
            if (!owner || !originating || owner.workId !== work.id || owner.workspaceId !== work.workspaceId || owner.pageId !== work.pageId
                || originating.profileId !== work.profileId || identity?.kind !== 'page' || identity.pageId !== work.pageId || identity.errorCode) return null;
            let evidence: unknown;
            try {
                if (ref.kind === 'draft') {
                    const row = poster.getSchedule(ref.id); const profiles = row?.params.profiles;
                    if (!row || row.params.mode !== 'page' || !Array.isArray(profiles) || profiles.length !== 1
                        || profiles[0].profileId !== work.profileId || profiles[0].targets?.length !== 1 || profiles[0].targets[0] !== 'https://www.facebook.com/') return null;
                    const names = row.params.mediaPaths;
                    if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) return null;
                    evidence = { row, files: resolveScheduleMedia(baseDir, row.id, names as string[]).map(resourceFileHash) };
                } else if (ref.kind === 'research') {
                    const scan = research.getScan(ref.id);
                    if (!scan || scan.status !== 'done' || work.researchId !== scan.id || scan.profileIds.length !== 1 || scan.profileIds[0] !== work.profileId) return null;
                    const items = boundDb.query('SELECT * FROM research_items WHERE scan_id = ? AND profile_id = ? ORDER BY id', [ref.id, work.profileId]);
                    evidence = { scan, items };
                } else if (ref.kind === 'video') {
                    const row = videos.get(ref.id);
                    if (!row || work.videoId !== row.id) return null;
                    evidence = { row, file: row.filePath ? resourceFileHash(row.filePath) : null };
                } else if (ref.kind === 'media') {
                    evidence = media.resolve([ref.id]).map(resourceFileHash);
                } else {
                    const row = poster.getCampaign(ref.id); if (!row || work.campaignId !== row.id) return null; evidence = row;
                }
            } catch { return null; }
            assertCurrent();
            return { workspaceId: owner.workspaceId, pageId: owner.pageId, profileId: originating.profileId,
                fingerprint: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
        },
        afterCommit: result => {
            assertCurrent();
            if (result.action === 'approveDraft') {
                const row = poster.getSchedule(result.resourceId); if (row) afterDraftApproval(row, result.when);
            }
        },
    };
}

export function createBoundPageApprovalOperations(receiver: Extract<ControlPrincipal, { kind: 'page_receiver' }>, assertAuthorized: () => void) {
    return createPageApprovalOperations({ ...createBoundPageApprovalDependencies(assertAuthorized), receiver });
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

/** Starts the scheduler for the active workspace DB. No-op in employee mode or when one already runs for this DB. */
export function startFacebookPosterScheduler(): void {
    if (AppModeManager.getInstance().isEmployeeMode()) return;
    resumeFacebookJobAdmission();
    const dbPath = db().getDbPath();
    if (scheduler && schedulerDbPath === dbPath) return;
    stopFacebookPosterScheduler();
    pendingMissed = [];
    schedulerDbPath = dbPath;
    const boundStore = store();
    const boundDb = db();
    const boundService = getService();
    const binding = getProfileJobBinding();
    const boundBaseDir = path.dirname(dbPath);
    const readSetting = (key: string) => {
        if (service !== boundService) throw new Error(WORKSPACE_SWITCHING_ERROR);
        return boundDb.getSetting(key);
    };
    const lifecycleBusy = () => {
        try { assertFacebookJobAdmission(); binding.assertCurrent(); return AppModeManager.getInstance().isEmployeeMode(); } catch { return true; }
    };
    scheduler = new FacebookPosterScheduler({
        store: boundStore,
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        isBusy: () => lifecycleBusy() || !boundService.hasCapacity(),
        isScheduleRunning: id => boundService.active().some(({ run }) => run.scheduleId === id),
        canStart: params => {
            const ids = params.kind === 'post' ? params.profiles.map(profile => profile.profileId)
                : params.kind === 'scan_groups' ? params.profileIds : [params.profileId];
            return ids.some(id => !binding.isProfileBusy(id));
        },
        canStartSchedule: s => {
            const profiles = s.params.profiles;
            // No readable profile list: no hint, resolveParams validates it.
            return !Array.isArray(profiles) || profiles.some(profile => !binding.isProfileBusy(profile?.profileId));
        },
        resolveParams: (s) => {
            binding.assertCurrent();
            const names = Array.isArray(s.params.mediaPaths) ? (s.params.mediaPaths as string[]) : [];
            const params = { ...s.params, mediaPaths: resolveScheduleMedia(boundBaseDir, s.id, names) };
            const startParams = validateStartParams({ kind: 'post', params }, { ...startEnv, profileExists: () => true });
            if (!isBrowserEngineInstalled()) throw new Error(ENGINE_MISSING_ERROR);
            // Cột campaign_id của lịch là nguồn đúng; campaignId trong params_json bị bỏ qua.
            return startParams.kind === 'post' ? { ...startParams, campaignId: s.campaignId } : startParams;
        },
        assertAutonomyCurrent: (s) => { binding.assertCurrent(); executionGuard(s.id,'scheduler-preflight').assertCurrent(); },
        // Lịch owner trỏ tới chiến dịch không còn giữ hành vi legacy.
        campaignBlock: (s, t) => {
            if (!s.campaignId) return null;
            const campaign = boundStore.getCampaign(s.campaignId);
            return campaign ? campaignBlockReason(campaign, t) : null;
        },
        startRun: (params, scheduleId, options) => {
            binding.assertCurrent();
            return startRun(params, scheduleId, options);
        },
        newId: randomUUID,
        onMissed: (notice) => {
            if (service !== boundService) return;
            if (!uiReady) {
                pendingMissed.push(notice);
                if (pendingMissed.length > MAX_PENDING_MISSED) pendingMissed.shift();
            }
            EventBroadcaster.emit('facebookPoster:scheduleMissed', notice);
            emitControlEvent('schedule.missed', buildScheduleMissed(notice));
        },
        onChanged: () => {
            if (service !== boundService) return;
            profileQueue?.notifyAvailability();
            EventBroadcaster.emit('facebookPoster:schedulesChanged', undefined);
        },
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
        readConfig: () => parseLoginCheckConfig(readSetting(LOGIN_CHECK_SETTING_KEY)),
        isBusy: () => lifecycleBusy() || (checker?.isRunning() ?? false),
        runCheck: () => { binding.assertCurrent(); checkFacebookLogins(null, 'daily'); },
        log: (msg) => Logger.warn(msg),
    });
    loginScheduler.start();
    const trackingDb=db();
    trackScheduler = new PostTrackScheduler({
        now: Date.now,
        setTimer: (fn, ms) => {
            const handle = setTimeout(fn, ms);
            handle.unref?.();
            return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
        readConfig: () => parsePostTrackingConfig(readSetting(POST_TRACKING_SETTING_KEY)),
        isBusy: () => lifecycleBusy() || (tracker?.isRunning() ?? false),
        runDueCampaignTracking: () => campaignExecutionContext?.db===trackingDb && trackingDb.getDbPath()===dbPath ? runDueCampaignTracking() : false,
        duePairs: (now, limit) => boundStore.listDuePairs(now, limit),
        runTrack: (pairs, auto) => { assertFacebookJobAdmission(); binding.assertCurrent(); getTracker().track({ pairs, auto }); },
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
        readConfig: () => parseLeadConfig(readSetting(LEAD_CONFIG_SETTING_KEY)),
        isBusy: () => lifecycleBusy() || (collector?.isRunning() ?? false),
        blockedUntil: () => collector?.blockedUntil ?? 0,
        duePosts: (now, limit) => boundStore.listDueCommentPosts(now, limit),
        runCollect: () => { assertFacebookJobAdmission(); binding.assertCurrent(); getCollector().collect({ auto: true }); },
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
    const blocked = AppModeManager.getInstance().isEmployeeMode();
    if (blocked) learner?.stop();
    return blocked;
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
        if (service?.active().some(({ run }) => run.scheduleId === id)) {
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
        afterDraftApproval(schedule, params?.when);
        return { schedule };
    },

    takeMissed: (_params?: any) => {
        uiReady = true;
        const notices = pendingMissed;
        pendingMissed = [];
        return { notices };
    },

    /** Không runId: giữ lời xác nhận cũ (true), nhiều lượt sống thì CONFLICT. Có runId: kết quả thật, lạ thì NOT_FOUND. */
    cancel: (params?: any) => {
        const runId = params?.runId;
        if (runId === undefined) {
            service?.cancel();
            return { cancelled: true };
        }
        if (typeof runId !== 'string' || !runId) throw new Error('Mã lượt không hợp lệ');
        return { cancelled: getService().cancel(runId) };
    },

    active: (_params?: any) => ({ runs: getService().active() }),

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
    store, now: Date.now, newId: randomUUID, reschedule: () => {
        scheduler?.reschedule();
        profileQueue?.notifyAvailability();
    },
});

/** Post-tracking handler bodies, shared by the IPC channels and the control API (parameter checks live here). */
export const trackingOperations = {
    track: (params: any, auto = false) => {
        if (admissionPaused || isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
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
        if (admissionPaused || isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
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
    handle('facebookPoster:active', posterOperations.active);
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
