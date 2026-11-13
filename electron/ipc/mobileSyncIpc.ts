import { ipcMain } from 'electron';
import MobileSyncService from '../../src/services/zalo/mobileSync/MobileSyncService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';

const EMPLOYEE_ERROR = 'Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại';
const INVALID_ERROR = 'Tham số không hợp lệ';

function isEmployeeMode(): boolean {
    try {
        return WorkspaceManager.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch { return false; }
}

// Zalo account ids are numeric uids; digits-only also rules out path separators and "..".
const isZaloId = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const isTs = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** Wrap a handler: employee refusal, input validation, never throws to the renderer. */
function guarded(channel: string, needsRange: boolean, run: (zaloId: string, payload: any) => Promise<any> | any) {
    ipcMain.handle(channel, async (_event, payload) => {
        if (isEmployeeMode()) return { success: false, error: EMPLOYEE_ERROR };
        if (!isZaloId(payload?.zaloId) || (needsRange && !(isTs(payload.fromTs) && isTs(payload.toTs)))) {
            return { success: false, error: INVALID_ERROR };
        }
        try {
            return await run(payload.zaloId, payload);
        } catch (err: any) {
            Logger.warn(`[mobileSyncIpc] ${channel} failed: ${err?.message}`);
            return { success: false, error: err?.message || 'Lỗi không xác định' };
        }
    });
}

export function registerMobileSyncIpc(): void {
    const svc = () => MobileSyncService.getInstance();
    guarded('zalo:mobileSync:start', true, (zaloId, p) => svc().start(zaloId, { fromTs: p.fromTs, toTs: p.toTs }));
    guarded('zalo:mobileSync:cancel', false, (zaloId) => svc().cancel(zaloId));
    guarded('zalo:mobileSync:status', false, (zaloId) => ({ success: true, status: svc().getStatus(zaloId) }));
}
