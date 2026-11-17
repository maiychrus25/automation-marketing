import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { EMPLOYEE_UPLOAD_MAX_BYTES, EMPLOYEE_UPLOAD_PATH_FIELDS } from '../../src/services/http/bossFileAccess';
import {
    BOSS_ONLY_CHANNEL_CODE,
    BOSS_ONLY_CHANNEL_ERROR,
    POSTER_CHANNEL_ROUTES,
    employeeChannelSpec,
} from '../../src/services/http/employeeChannelRoutes';

/**
 * Fire-and-forget proxy: send a DB/CRM mutation to the Boss when running in Employee mode.
 * The Boss executes the same IPC handler on its own DB, then relays the resulting
 * event back to all connected employees via SSE.
 *
 * In Boss / standalone mode this is a no-op.
 */
export function proxyToBoss(channel: string, params: any): void {
    try {
        if (AppModeManager.getInstance().getMode() !== 'employee') return;

        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') return;

        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) return;

        HCM.getInstance().proxyAction(activeWs.id, channel, params).catch((err: any) => {
            Logger.warn(`[proxyToBoss] ${channel} failed: ${err.message}`);
        });
    } catch {}
}

function bossClient(): any {
    const WsMgr = require('../../src/utils/WorkspaceManager').default;
    const activeWs = WsMgr.getInstance().getActiveWorkspace();
    if (!activeWs || activeWs.type !== 'remote') throw new Error('Không kết nối tới Boss');

    const HCM = require('../../src/services/http/HttpConnectionManager').default;
    const client = HCM.getInstance().getServiceForWorkspace(activeWs.id);
    if (!client) throw new Error('Không kết nối tới Boss');
    return client;
}

export const UPLOAD_TOO_LARGE_RESULT = { success: false, error: 'Tệp quá lớn (tối đa 200 MB)', code: 'UPLOAD_TOO_LARGE' };

/** An upload that must come back to the renderer as this exact result (the boss refused it with a code, or the file is too large). Never names a path. */
function uploadRefusal(result: { success: boolean; error: string; code: string }): Error & { uploadResult: typeof result } {
    return Object.assign(new Error('upload refused'), { uploadResult: result });
}

/** The boss answered the upload with a JSON body carrying `code` and `error` (413, 403, ...): that answer, as a command result. */
function bossUploadRefusal(result: any): { success: false; error: string; code: string } | null {
    return result && result.success === false && typeof result.code === 'string' && result.code && typeof result.error === 'string' && result.error
        ? { success: false, error: result.error, code: result.code }
        : null;
}

/**
 * Upload post media of the Facebook poster (X-Upload-Area: poster). A path that exists on this machine is replaced by its boss path;
 * one that does not exist is kept (it is a boss path that draftGet returned). One at a time: a file can be 200 MB.
 * Throws an error with code UPLOAD_TOO_LARGE before reading an oversized file; the message never names a path.
 */
export async function uploadPosterMedia(paths: unknown[]): Promise<unknown[]> {
    const client = bossClient();
    const out: unknown[] = [];
    for (const fp of paths) {
        if (typeof fp !== 'string' || !fp || !fs.existsSync(fp)) { out.push(fp); continue; }
        if (fs.statSync(fp).size > EMPLOYEE_UPLOAD_MAX_BYTES) throw uploadRefusal({ ...UPLOAD_TOO_LARGE_RESULT });
        const result = await client.uploadMedia(fs.readFileSync(fp), path.basename(fp), undefined, 'poster');
        const refusal = bossUploadRefusal(result);
        if (refusal) throw uploadRefusal(refusal);
        if (!result?.success || !result.bossPath) throw new Error('upload failed');
        out.push(result.bossPath);
    }
    return out;
}

/** `mediaPaths` (list) and the legacy single `mediaPath` of one params object, through the poster upload contract. */
async function uploadPosterMediaFields(obj: any): Promise<any> {
    const out = { ...obj };
    if (Array.isArray(out.mediaPaths)) out.mediaPaths = await uploadPosterMedia(out.mediaPaths);
    if (typeof out.mediaPath === 'string' && out.mediaPath) out.mediaPath = (await uploadPosterMedia([out.mediaPath]))[0];
    return out;
}

/**
 * Upload media files from Employee machine to Boss machine.
 * Used when Employee's local file path is not valid on Boss (cross-platform paths).
 * Each file is read on Employee, sent as base64 via HTTP, saved on Boss,
 * and the Boss-resolved absolute path is returned.
 *
 * @param filePaths  - Local file paths on Employee machine
 * @param zaloId     - Zalo account ID for organizing media storage on Boss
 * @returns Boss-resolved absolute file paths (preserves order)
 */
export async function uploadEmployeeMedia(filePaths: string[], zaloId?: string): Promise<string[]> {
    if (AppModeManager.getInstance().getMode() !== 'employee') return filePaths;

    const client = bossClient();

    const bossPaths: string[] = new Array(filePaths.length);

    // Upload parallel all files để giảm thời gian chờ (nhất là khi gửi nhiều ảnh)
    const uploadTasks = filePaths.map(async (fp, index) => {
        if (!fp) { bossPaths[index] = fp; return; }
        if (!fs.existsSync(fp)) {
            Logger.warn('[uploadEmployeeMedia] File not found on Employee');
            bossPaths[index] = fp;
            return;
        }
        const buffer = fs.readFileSync(fp);
        const filename = path.basename(fp);
        try {
            const result = await client.uploadMedia(buffer, filename, zaloId);
            const refusal = bossUploadRefusal(result);
            if (refusal) throw uploadRefusal(refusal);
            if (result.success && result.bossPath) {
                bossPaths[index] = result.bossPath;
                Logger.log('[uploadEmployeeMedia] uploaded');
            } else {
                throw new Error(result.error || 'Upload thất bại');
            }
        } catch (err: any) {
            if (err?.uploadResult) throw err;
            throw new Error(`Không thể upload file ${fp}: ${err.message}`);
        }
    });

    await Promise.all(uploadTasks);
    return bossPaths;
}

/**
 * Upload local media files from Employee machine to Boss storage before proxying.
 * Employee's local file paths are invalid on Boss - reads each file on the
 * Employee side, sends as base64 via uploadEmployeeMedia(), returns Boss-resolved paths.
 * In standalone/boss mode (no-op) returns original params unchanged.
 */
export async function prepareLocalFilesForProxy(params: any, accountId?: string, channel?: string): Promise<any> {
    let result = { ...params };

    // Facebook poster: post media sits at the top level (draft/schedule helpers) or inside params.params (start, scheduleCreate, draftSave).
    if (channel && POSTER_CHANNEL_ROUTES[channel]?.route === 'proxy') {
        result = await uploadPosterMediaFields(result);
        if (result.params && typeof result.params === 'object') result.params = await uploadPosterMediaFields(result.params);
    }

    for (const field of EMPLOYEE_UPLOAD_PATH_FIELDS) {
        if (result[field] && typeof result[field] === 'string' && result[field].length > 0) {
            const bossPaths = await uploadEmployeeMedia([result[field]], accountId);
            if (bossPaths && bossPaths[0]) {
                result[field] = bossPaths[0];
            }
        }
    }

    if (result.filePaths && Array.isArray(result.filePaths) && result.filePaths.length > 0) {
        const bossPaths = await uploadEmployeeMedia(result.filePaths, accountId);
        if (bossPaths && bossPaths.length > 0) {
            result.filePaths = bossPaths;
        }
    }

    return result;
}

const TIMEOUT_ERROR = 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy kiểm tra hội thoại trước khi thử lại.';
/** The poster has no conversation to check: its results show in Progress and History. */
const TIMEOUT_ERROR_POSTER = 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy xem Tiến độ hoặc Lịch sử trước khi bấm lại.';
const NOTHING_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
// HttpClientService / HttpConnectionManager throw these when there is no live connection (nothing was sent).
const NOT_CONNECTED_MESSAGE = /chưa kết nối tới BOSS/i;

/**
 * Proxy a command to the Boss and return its result. Never throws:
 * no connection comes back as NOT_CONNECTED (nothing sent); any other failure as TIMEOUT (the boss may have run it).
 */
export async function proxyToBossWithResult(channel: string, params: any, opts?: { timeoutMs?: number }): Promise<any> {
    const notConnected = { success: false, error: 'Chưa nối được máy Boss', code: 'NOT_CONNECTED' };
    try {
        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') return notConnected;

        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) return notConnected;

        const result = await HCM.getInstance().proxyAction(activeWs.id, channel, params, opts?.timeoutMs);
        // The boss's own answer (including its error results) passes through; only non-objects are rejected.
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            return { success: false, error: 'Máy Boss trả về kết quả không hợp lệ', code: 'BAD_RESPONSE' };
        }
        return result;
    } catch (err: any) {
        Logger.warn(`[proxyToBossWithResult] ${channel} failed: ${err?.code || 'error'}`);
        // Only a failure that proves nothing was sent is NOT_CONNECTED. Anything else (reset, EPIPE,
        // hang up, ETIMEDOUT, unknown) may have reached the boss, which may already have run the command.
        if (NOTHING_SENT_CODES.has(err?.code) || NOT_CONNECTED_MESSAGE.test(String(err?.message || ''))) return notConnected;
        return {
            success: false,
            error: Object.prototype.hasOwnProperty.call(POSTER_CHANNEL_ROUTES, channel) ? TIMEOUT_ERROR_POSTER : TIMEOUT_ERROR,
            code: 'TIMEOUT',
        };
    }
}

function isRemoteWorkspaceActive(): boolean {
    try {
        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        return WsMgr.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch { return false; }
}

/**
 * Wrap an ipcMain listener so that, on an Employee machine, the command is sent to the Boss
 * (route 'proxy') or refused ('boss_only') instead of running against the local empty database.
 * Boss, standalone, relayed (_fromRelay) and unclassified/'local' channels run the listener as is.
 */
export function routeEmployeeChannel(channel: string, listener: (event: any, params: any) => any): (event: any, params: any) => any {
    const spec = employeeChannelSpec(channel);
    if (!spec || spec.route === 'local') return listener;

    return async (event: any, params: any) => {
        if (params?._fromRelay || !isRemoteWorkspaceActive()) return listener(event, params);

        if (spec.route === 'boss_only') {
            return { success: false, error: BOSS_ONLY_CHANNEL_ERROR, code: BOSS_ONLY_CHANNEL_CODE };
        }

        let prepared: any;
        try {
            prepared = await prepareLocalFilesForProxy(params, params?.accountId, channel);
        } catch (err: any) {
            if (err?.uploadResult) return { ...err.uploadResult };
            // The error text names a local file path: keep it out of the result and the log.
            Logger.warn(`[routeEmployeeChannel] ${channel} upload failed`);
            return { success: false, error: 'Không tải được tệp lên máy Boss', code: 'UPLOAD_FAILED' };
        }
        return proxyToBossWithResult(channel, prepared, { timeoutMs: spec.timeoutMs });
    };
}

/** ipcMain look-alike whose handle() registers every listener through routeEmployeeChannel. */
export function employeeRoutedIpcMain<T extends { handle: Function }>(target: T): T {
    return new Proxy(target, {
        get(t, prop) {
            if (prop === 'handle') return (channel: string, listener: any) => t.handle(channel, routeEmployeeChannel(channel, listener));
            const value = (t as any)[prop];
            return typeof value === 'function' ? value.bind(t) : value;
        },
    });
}
