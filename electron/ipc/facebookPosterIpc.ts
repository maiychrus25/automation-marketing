import { dialog, ipcMain } from 'electron';
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
import { LoginChecker } from '../../src/services/facebookPoster/loginCheck';
import {
    LoginCheckScheduler, LOGIN_CHECK_SETTING_KEY, parseLoginCheckConfig, validateLoginCheckConfig,
} from '../../src/services/facebookPoster/LoginCheckScheduler';
import { PostTracker, MAX_TRACK_GROUPS, MAX_TRACK_SINCE_DAYS, DEFAULT_TRACK_SINCE_DAYS, type TrackParams } from '../../src/services/facebookPoster/PostTracker';
import { PostTrackScheduler } from '../../src/services/facebookPoster/PostTrackScheduler';
import {
    POST_TRACKING_SETTING_KEY, parsePostTrackingConfig, validatePostTrackingConfig,
} from '../../src/services/facebookPoster/postTracking';
import { GraphqlSession } from '../../src/services/research/graphqlSession';
import { checkProfileIds } from '../../src/services/research/researchOperationsLogic';
import { computeNextRun } from '../../src/services/facebookPoster/scheduleTime';
import { planScheduleUpdate, readName, readTiming } from '../../src/services/facebookPoster/scheduleUpdate';
import { copyScheduleMedia, removeScheduleMedia, resolveScheduleMedia } from '../../src/services/facebookPoster/scheduleMedia';
import { getBrowserProfileService, isBrowserEngineInstalled } from './browserProfileIpc';
import { emitControlEvent, hasControlEventSink, buildRunStarted, buildRunFinished, buildScheduleMissed, buildDraftApproved, buildLoginProblem, buildCheckFinished } from '../../src/services/control/controlEvents';
import { getResearchStore } from './researchIpc';
import { isWorkspaceSwitchInProgress } from './workspaceIpc';
import type { FbPosterRun, LinkStatus, LoginCheckSource, PostStatsGroupBy, ProfileLoginState } from '../../src/models/facebookPoster';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../src/services/facebookPoster/drafts';


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
const MAX_TRACK_LIST_SCAN = 5000;
const DEFAULT_REPORT_DAYS = 30;
const LINK_STATUSES: LinkStatus[] = ['known', 'missing', 'pending_approval', 'not_found'];
const STATS_GROUP_BY: PostStatsGroupBy[] = ['group', 'profile', 'schedule', 'day', 'post'];
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
                    recordRunFinished(data);
                    scheduler?.onRunFinished();
                }
            },
            onLoginObserved: (profileId, state) => safely('onLoginObserved', () => getChecker().observe(profileId, state, 'run')),
            readTrackingConfig: readTrackingConfig,
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
                    safely('onRunFinished', () => scheduler?.onRunFinished()); // queued schedules start once the slot is free
                }
            },
            getConfig: readTrackingConfig,
        });
    }
    return tracker;
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
    emitControlEvent('run.started', buildRunStarted({ runId: started.runId, kind: params.kind, scheduleId: scheduleId ?? null }));
    return started;
}

/** True while the poster scheduler is running for the active workspace (control API system.status). */
export function isFacebookPosterSchedulerRunning(): boolean {
    return scheduler !== null;
}

/** True while a run or a login check is active; the updater refuses to restart then. */
export function isFacebookPosterBusy(): boolean {
    return (service?.isBusy() ?? false) || (tracker?.isRunning() ?? false);
}

/** Stops a running job (if any). Called on app quit and before the workspace database is switched. */
export function cancelFacebookPosterJobs(): void {
    service?.cancelAll();
    checker?.stop();
    tracker?.stop();
}

/** Cancels the running job and waits (bounded) for it to end, so it cannot write into the next workspace DB. True = no job runs anymore. Never throws. */
export async function cancelAndWaitFacebookPosterJobs(): Promise<boolean> {
    const theChecker = checker;
    theChecker?.stop(); // dừng sau profile đang dở
    const theTracker = tracker;
    theTracker?.stop();
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
    return ok;
}

const emitSchedulesChanged = (): void => EventBroadcaster.emit('facebookPoster:schedulesChanged', undefined);

function draftDeps(): DraftDeps {
    return { store: store(), env: startEnv, baseDir: scheduleBaseDir(), now: () => Date.now(), newId: () => randomUUID(), maxSchedules: MAX_SCHEDULES };
}

function scheduleBaseDir(): string {
    return path.dirname(db().getDbPath());
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
            return startParams;
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
        isBusy: () => isFacebookPosterBusy(),
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
        isBusy: () => isFacebookPosterBusy(),
        duePairs: (now, limit) => store().listDuePairs(now, limit),
        runTrack: (pairs, auto) => { getTracker().track({ pairs, auto }); },
        log: (msg) => Logger.warn(msg),
    });
    trackScheduler.start();
}

export function stopFacebookPosterScheduler(): void {
    const current = scheduler;
    const currentLogin = loginScheduler;
    const currentTrack = trackScheduler;
    scheduler = null;
    loginScheduler = null;
    trackScheduler = null;
    schedulerDbPath = null;
    current?.stop();
    currentLogin?.stop();
    currentTrack?.stop();
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
        if (theStore.countSchedules() >= MAX_SCHEDULES) throw new Error('Tối đa 200 lịch cho một workspace');

        const id = randomUUID();
        const baseDir = scheduleBaseDir();
        const names = copyScheduleMedia(baseDir, id, startParams.mediaPaths);
        try {
            theStore.createSchedule({
                id, name, kind, ...timing,
                params: { ...startParams, mediaPaths: names },
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

    scheduleList: (_params?: any) => ({
        schedules: store().listSchedules(),
        queuedIds: scheduler?.queuedIds() ?? [],
    }),

    scheduleUpdate: (params: any) => {
        const now = Date.now();
        const theStore = store();
        const current = typeof params.id === 'string' ? theStore.getSchedule(params.id) : null;
        if (!current) throw new Error('Không tìm thấy lịch');
        theStore.updateSchedule(current.id, planScheduleUpdate(current, params, now), now);
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
        return store().listComments({ postUrl, limit: clampLimit(params.limit, 100, 500), offset: offsetOf(params.offset) });
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

function parseTimeRange(params: any): { from: number; to: number } {
    const to = params.to === undefined ? Date.now() : Number(params.to);
    const from = params.from === undefined ? to - DEFAULT_REPORT_DAYS * DAY_MS : Number(params.from);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Khoảng thời gian không hợp lệ');
    return { from, to };
}

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
        for (const key of ['groupUrl', 'profileId']) {
            if (p[key] !== undefined && (typeof p[key] !== 'string' || !p[key])) throw new Error(`${key} không hợp lệ`);
        }
        const limit = clampLimit(p.limit, 100, MAX_TRACK_LIST_LIMIT);
        const offset = offsetOf(p.offset);
        const s = store();
        const matched = s.listTracking({
            linkStatus: p.linkStatus, profileId: p.profileId, groupUrl: p.groupUrl, sinceMs: from, limit: MAX_TRACK_LIST_SCAN,
        }).filter((r) => r.postedAt <= to);
        const page = matched.slice(offset, offset + limit);
        const latest = new Map(s.latestStats(page.map((r) => r.resultId)).map((x) => [x.resultId, x]));
        return { total: matched.length, rows: page.map((r) => ({ ...r, latestStats: latest.get(r.resultId) ?? null })) };
    },

    stats: (params: any) => {
        const p = params ?? {};
        const { from, to } = parseTimeRange(p);
        if (!STATS_GROUP_BY.includes(p.groupBy)) throw new Error(`groupBy phải là một trong: ${STATS_GROUP_BY.join(', ')}`);
        const limit = clampLimit(p.limit, 200, MAX_TRACK_LIST_LIMIT);
        return { rows: store().statsReport({ from, to, groupBy: p.groupBy, limit }) };
    },

    getConfig: () => ({ config: readTrackingConfig() }),

    setConfig: (params: any) => {
        const config = validatePostTrackingConfig(params);
        db().setSetting(POST_TRACKING_SETTING_KEY, JSON.stringify(config));
        return { config };
    },
};

export function registerFacebookPosterIpc(): void {
    handle('facebookPoster:start', posterOperations.start);
    handle('facebookPoster:scheduleCreate', posterOperations.scheduleCreate);
    handle('facebookPoster:scheduleList', posterOperations.scheduleList);
    handle('facebookPoster:scheduleUpdate', posterOperations.scheduleUpdate);
    handle('facebookPoster:scheduleDelete', posterOperations.scheduleDelete);
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
    handle('facebookPoster:getTrackConfig', trackingOperations.getConfig);
    handle('facebookPoster:setTrackConfig', trackingOperations.setConfig);
    handle('facebookPoster:getLoginStates', () => ({ states: listFacebookLoginStates() }));
    handle('facebookPoster:getLoginCheckConfig', () => ({ config: parseLoginCheckConfig(db().getSetting(LOGIN_CHECK_SETTING_KEY)) }));
    handle('facebookPoster:setLoginCheckConfig', (params) => {
        const config = validateLoginCheckConfig(params);
        db().setSetting(LOGIN_CHECK_SETTING_KEY, JSON.stringify(config));
        loginScheduler?.reschedule();
        return { config };
    });
}
