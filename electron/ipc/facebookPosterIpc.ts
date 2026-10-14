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
import { computeNextRun } from '../../src/services/facebookPoster/scheduleTime';
import { planScheduleUpdate, readName, readTiming } from '../../src/services/facebookPoster/scheduleUpdate';
import { copyScheduleMedia, removeScheduleMedia, resolveScheduleMedia } from '../../src/services/facebookPoster/scheduleMedia';
import { getBrowserProfileService, isBrowserEngineInstalled } from './browserProfileIpc';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../src/services/facebookPoster/drafts';


let service: FacebookPosterService | null = null;
let lastDbPath: string | null = null;
let scheduler: FacebookPosterScheduler | null = null;
let schedulerDbPath: string | null = null;
// Missed-run notices not yet handed to the UI. Only the first takeMissed drains them; after that the UI is live
// and gets them as events, so a renderer reload cannot replay old notices.
let pendingMissed: MissedNotice[] = [];
let uiReady = false;

const MAX_PENDING_MISSED = 50;
const MAX_SCHEDULES = 200;
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
        lastDbPath = dbPath;
        // The service binds to a store, so a new database needs a new service (never while a run is active).
        if (service && !service.current()) service = null;
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
                if (channel === 'facebookPoster:runFinished') scheduler?.onRunFinished();
            },
        });
    }
    return service;
}

/** True while a job is running; the updater refuses to restart then. */
export function isFacebookPosterBusy(): boolean {
    return !!service?.current();
}

/** Stops a running job (if any). Called on app quit and before the workspace database is switched. */
export function cancelFacebookPosterJobs(): void {
    service?.cancelAll();
}

/** Cancels the running job and waits (bounded) for it to end, so it cannot write into the next workspace DB. True = no job runs anymore. Never throws. */
export async function cancelAndWaitFacebookPosterJobs(): Promise<boolean> {
    if (!service) return true;
    try {
        return await service.stopAndWait();
    } catch {
        return false;
    }
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
        isBusy: () => !!service?.current(),
        resolveParams: (s) => {
            const names = Array.isArray(s.params.mediaPaths) ? (s.params.mediaPaths as string[]) : [];
            const params = { ...s.params, mediaPaths: resolveScheduleMedia(scheduleBaseDir(), s.id, names) };
            const startParams = validateStartParams({ kind: 'post', params }, { ...startEnv, profileExists: () => true });
            if (!isBrowserEngineInstalled()) throw new Error(ENGINE_MISSING_ERROR);
            return startParams;
        },
        startRun: (params, scheduleId) => getService().start(params, scheduleId),
        newId: randomUUID,
        onMissed: (notice) => {
            if (!uiReady) {
                pendingMissed.push(notice);
                if (pendingMissed.length > MAX_PENDING_MISSED) pendingMissed.shift();
            }
            EventBroadcaster.emit('facebookPoster:scheduleMissed', notice);
        },
        onChanged: emitSchedulesChanged,
    });
    scheduler.start();
}

export function stopFacebookPosterScheduler(): void {
    const current = scheduler;
    scheduler = null;
    schedulerDbPath = null;
    current?.stop();
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
        return getService().start(startParams);
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
}
