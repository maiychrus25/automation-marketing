import { dialog, ipcMain } from 'electron';
import * as fs from 'fs';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import { FacebookPosterService } from '../../src/services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { validateStartParams } from '../../src/services/facebookPoster/validateStartParams';
import { getBrowserProfileService, isBrowserEngineInstalled } from './browserProfileIpc';

const MEDIA_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm'];
const CSV_COLUMNS = ['profile', 'target', 'name', 'outcome', 'error', 'post_url', 'comment_status', 'identity', 'time'];

let service: FacebookPosterService | null = null;
let lastDbPath: string | null = null;

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
            emit: (channel, data) => EventBroadcaster.emit(channel, data),
        });
    }
    return service;
}

/** Stops a running job (if any). Called on app quit and before the workspace database is switched. */
export function cancelFacebookPosterJobs(): void {
    service?.cancelAll();
}

function clampLimit(value: any, fallback: number, max: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

function offsetOf(value: any): number {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : 0;
}

const csvField = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

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
        const startParams = validateStartParams(params, {
            profileExists: (id) => !!db().getBrowserProfileById(id),
            fileExists: (p) => fs.existsSync(p),
        });
        if (!isBrowserEngineInstalled()) {
            throw new Error('Chưa cài trình duyệt. Hãy tải trình duyệt ở màn hình Trình duyệt.');
        }
        return getService().start(startParams);
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
            properties: ['openFile'],
            filters: [{ name: 'Ảnh/video', extensions: MEDIA_EXTENSIONS }],
        });
        return { path: result.canceled || !result.filePaths.length ? null : result.filePaths[0] };
    });

    handle('facebookPoster:exportRunCsv', async (params) => {
        const found = typeof params.runId === 'string' ? store().getRun(params.runId) : null;
        if (!found) throw new Error('Không tìm thấy lần chạy');
        const result = await dialog.showSaveDialog({
            defaultPath: `facebook-poster-${found.run.id}.csv`,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (result.canceled || !result.filePath) return { path: null };
        const rows = found.results.map((r) => [
            r.profileName, r.targetUrl, r.targetName, r.outcome, r.error, r.postUrl ?? '', r.commentStatus, r.identity,
            new Date(r.createdAt).toISOString(),
        ]);
        const csv = [CSV_COLUMNS, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
        fs.writeFileSync(result.filePath, '﻿' + csv + '\r\n', 'utf8');
        return { path: result.filePath };
    });
}
