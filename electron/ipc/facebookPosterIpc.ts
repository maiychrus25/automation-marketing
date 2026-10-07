import { dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import { FacebookPosterService } from '../../src/services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { buildRunCsv } from '../../src/services/facebookPoster/runCsv';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../../src/services/facebookPoster/mediaRules';
import { validateStartParams, type StartParamsEnv } from '../../src/services/facebookPoster/validateStartParams';
import { FacebookPosterScheduler, type MissedNotice } from '../../src/services/facebookPoster/FacebookPosterScheduler';
import { TIME_RE, computeNextRun } from '../../src/services/facebookPoster/scheduleTime';
import { copyScheduleMedia, removeScheduleMedia, resolveScheduleMedia } from '../../src/services/facebookPoster/scheduleMedia';
import type { FbPosterSchedule } from '../../src/models/facebookPoster';
import { getBrowserProfileService, isBrowserEngineInstalled } from './browserProfileIpc';


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
const MAX_NAME = 100;
const MIN_LEAD_MS = 60 * 1000;
const LEAD_ERROR = 'Giờ đăng phải sau thời điểm hiện tại ít nhất 1 phút';

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

/** Cancels and waits (up to timeoutMs) for the running job to finish, so it cannot write into the next workspace DB. Never throws. */
export async function cancelAndWaitFacebookPosterJobs(timeoutMs = 10000): Promise<void> {
    if (!service) return;
    let timer: NodeJS.Timeout | undefined;
    try {
        service.cancelAll();
        await Promise.race([
            service.whenIdle(),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
    } catch {
        // best effort: the caller goes on to switch the workspace
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const emitSchedulesChanged = (): void => EventBroadcaster.emit('facebookPoster:schedulesChanged', undefined);

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
            return validateStartParams({ kind: 'post', params }, startEnv);
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

/** Validates the timing fields of a schedule; returns the normalized values. */
function readTiming(kind: string, input: { runAt?: unknown; days?: unknown; time?: unknown }, now: number): Pick<FbPosterSchedule, 'runAt' | 'days' | 'time'> {
    if (kind === 'once') {
        const runAt = input.runAt;
        if (typeof runAt !== 'number' || !Number.isInteger(runAt) || runAt < now + MIN_LEAD_MS) throw new Error(LEAD_ERROR);
        return { runAt, days: [], time: '' };
    }
    const days = Array.isArray(input.days) ? [...new Set(input.days)] : [];
    if (days.length === 0 || !days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
        throw new Error('Chọn ít nhất một ngày trong tuần');
    }
    if (typeof input.time !== 'string' || !TIME_RE.test(input.time)) throw new Error('Giờ không hợp lệ');
    return { runAt: null, days: (days as number[]).sort((a, b) => a - b), time: input.time };
}

function readName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name.length > MAX_NAME) throw new Error('Tên lịch tối đa 100 ký tự');
    return name;
}

function clampLimit(value: any, fallback: number, max: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function offsetOf(value: any): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Same employee-mode guard and error envelope as browserProfileIpc. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (AppModeManager.getInstance().isEmployeeMode()) {
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

export function registerFacebookPosterIpc(): void {
    handle('facebookPoster:start', (params) => {
        const startParams = validateStartParams(params, startEnv);
        if (!isBrowserEngineInstalled()) {
            throw new Error('Chưa cài trình duyệt. Hãy tải trình duyệt ở màn hình Trình duyệt.');
        }
        return getService().start(startParams);
    });

    handle('facebookPoster:scheduleCreate', (params) => {
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
    });

    handle('facebookPoster:scheduleList', () => ({
        schedules: store().listSchedules(),
        queuedIds: scheduler?.queuedIds() ?? [],
    }));

    handle('facebookPoster:scheduleUpdate', (params) => {
        const now = Date.now();
        const theStore = store();
        const current = typeof params.id === 'string' ? theStore.getSchedule(params.id) : null;
        if (!current) throw new Error('Không tìm thấy lịch');
        const fields: Parameters<FacebookPosterStore['updateSchedule']>[1] = {};
        if (params.name !== undefined) {
            const name = readName(params.name);
            if (!name) throw new Error('Tên lịch không được để trống');
            fields.name = name;
        }
        if (params.enabled !== undefined) fields.enabled = !!params.enabled;
        if (current.kind === 'once') {
            if (params.runAt !== undefined) fields.runAt = readTiming('once', params, now).runAt;
        } else if (params.days !== undefined || params.time !== undefined) {
            const timing = readTiming('recurring', { days: params.days ?? current.days, time: params.time ?? current.time }, now);
            fields.days = timing.days;
            fields.time = timing.time;
        }
        const merged = { ...current, ...fields };
        const nextRunAt = merged.enabled ? computeNextRun(merged, now) : null;
        if (merged.enabled && nextRunAt === null) throw new Error(LEAD_ERROR);
        theStore.updateSchedule(current.id, { ...fields, nextRunAt }, now);
        scheduler?.reschedule();
        emitSchedulesChanged();
        return { schedule: theStore.getSchedule(current.id) };
    });

    handle('facebookPoster:scheduleDelete', (params) => {
        const id = typeof params.id === 'string' ? params.id : '';
        if (service?.current()?.run.scheduleId === id) {
            throw new Error('Lịch này đang chạy, hãy dừng lượt đăng trước khi xoá');
        }
        store().deleteSchedule(id);
        removeScheduleMedia(scheduleBaseDir(), id);
        scheduler?.reschedule();
        emitSchedulesChanged();
    });

    handle('facebookPoster:takeMissed', () => {
        uiReady = true;
        const notices = pendingMissed;
        pendingMissed = [];
        return { notices };
    });

    handle('facebookPoster:cancel', () => {
        service?.cancel();
    });

    handle('facebookPoster:current', () => {
        const current = getService().current();
        return { run: current?.run ?? null, progress: current?.progress ?? null };
    });

    handle('facebookPoster:listGroups', (params) => {
        const ids = Array.isArray(params.profileIds) ? params.profileIds.filter((id: unknown) => typeof id === 'string') : [];
        return { groups: store().listGroups(ids) };
    });

    handle('facebookPoster:listRuns', (params) => {
        const kind = ['post', 'join', 'scan_groups', 'collect_comments'].includes(params.kind) ? params.kind : undefined;
        return store().listRuns({ limit: clampLimit(params.limit, 50, 200), offset: offsetOf(params.offset), kind });
    });

    handle('facebookPoster:getRun', (params) => {
        const found = typeof params.runId === 'string' ? store().getRun(params.runId) : null;
        if (!found) throw new Error('Không tìm thấy lần chạy');
        return found;
    });

    handle('facebookPoster:listComments', (params) => {
        const postUrl = typeof params.postUrl === 'string' && params.postUrl ? params.postUrl : undefined;
        return store().listComments({ postUrl, limit: clampLimit(params.limit, 100, 500), offset: offsetOf(params.offset) });
    });

    handle('facebookPoster:listPostedUrls', () => ({ posts: store().listPostedUrls(200) }));

    handle('facebookPoster:pickMedia', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [{ name: 'Ảnh/video', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }],
        });
        if (result.canceled) return { items: [] };
        return { items: result.filePaths.map((path) => ({ path, size: fs.statSync(path).size })) };
    });

    handle('facebookPoster:exportRunCsv', async (params) => {
        const found = typeof params.runId === 'string' ? store().getRun(params.runId) : null;
        if (!found) throw new Error('Không tìm thấy lần chạy');
        const result = await dialog.showSaveDialog({
            defaultPath: `facebook-poster-${found.run.id}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (result.canceled || !result.filePath) return { path: null };
        fs.writeFileSync(result.filePath, buildRunCsv(found.results), 'utf8');
        return { path: result.filePath };
    });
}
