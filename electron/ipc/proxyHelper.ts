import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import {
    BOSS_ONLY_CHANNEL_CODE,
    BOSS_ONLY_CHANNEL_ERROR,
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

    const WsMgr = require('../../src/utils/WorkspaceManager').default;
    const activeWs = WsMgr.getInstance().getActiveWorkspace();
    if (!activeWs || activeWs.type !== 'remote') throw new Error('Không kết nối tới Boss');

    const HCM = require('../../src/services/http/HttpConnectionManager').default;
    const client = HCM.getInstance().getServiceForWorkspace(activeWs.id);
    if (!client) throw new Error('Không kết nối tới Boss');

    const bossPaths: string[] = new Array(filePaths.length);

    // Upload parallel all files để giảm thời gian chờ (nhất là khi gửi nhiều ảnh)
    const uploadTasks = filePaths.map(async (fp, index) => {
        if (!fp) { bossPaths[index] = fp; return; }
        if (!fs.existsSync(fp)) {
            Logger.warn(`[uploadEmployeeMedia] File not found on Employee: ${fp}`);
            bossPaths[index] = fp;
            return;
        }
        const buffer = fs.readFileSync(fp);
        const filename = path.basename(fp);
        try {
            const result = await client.uploadMedia(buffer, filename, zaloId);
            if (result.success && result.bossPath) {
                bossPaths[index] = result.bossPath;
                Logger.log(`[uploadEmployeeMedia] ✅ ${fp} → ${result.bossPath}`);
            } else {
                throw new Error(result.error || 'Upload thất bại');
            }
        } catch (err: any) {
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
export async function prepareLocalFilesForProxy(params: any, accountId?: string): Promise<any> {
    const singleFields = ['filePath', 'videoPath', 'thumbPath', 'voicePath', 'avatarPath', 'mediaPath'];
    let result = { ...params };

    for (const field of singleFields) {
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
            error: 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy kiểm tra hội thoại trước khi thử lại.',
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
            prepared = await prepareLocalFilesForProxy(params, params?.accountId);
        } catch {
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
