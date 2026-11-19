import { ipcMain as electronIpcMain } from 'electron';
import { employeeRoutedIpcMain } from './proxyHelper';
import FacebookHistorySyncService from '../../src/services/facebook/FacebookHistorySyncService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { getFBServiceOrReconnect, resolveInternalId } from './facebookIpc';

// Employee machine: Page-inbox commands go to the Boss instead of the local (empty) database.
const ipcMain = employeeRoutedIpcMain(electronIpcMain);

const EMPLOYEE_ERROR = 'Chỉ chủ tài khoản (máy đang đăng nhập Facebook) mới tải được lịch sử tin nhắn';
const INVALID_ERROR = 'Tham số không hợp lệ';
const NOT_CONNECTED_ERROR = 'Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.';

function isEmployeeMode(): boolean {
    try {
        return WorkspaceManager.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch { return false; }
}

// facebook_id or internal uuid; the charset also rules out path separators and "..".
const isAccountId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isTs = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isThreadId = (v: unknown): v is string => typeof v === 'string' && /^\d+(@[\w.-]{0,64})?$/.test(v);
const isOptionalTs = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const isOptionalMessageId = (v: unknown): boolean => v === undefined || (typeof v === 'string' && v.length <= 256);

/** Sync channels: employee refusal, input validation, never throws to the renderer. */
function guardedSync(channel: string, needsRange: boolean, run: (accountId: string, payload: any) => Promise<any> | any) {
    ipcMain.handle(channel, async (_event, payload) => {
        if (isEmployeeMode()) return { success: false, error: EMPLOYEE_ERROR };
        if (!isAccountId(payload?.accountId) || (needsRange && !(isTs(payload.fromTs) && isTs(payload.toTs)))) {
            return { success: false, error: INVALID_ERROR };
        }
        try {
            return await run(payload.accountId, payload);
        } catch (err: any) {
            Logger.warn(`[fbHistoryIpc] ${channel} failed: ${err?.message}`);
            return { success: false, error: err?.message || 'Lỗi không xác định' };
        }
    });
}

export function registerFbHistoryIpc(): void {
    ipcMain.handle('fb:fetchOlderMessages', async (_event, p) => {
        if (!isAccountId(p?.accountId) || !isThreadId(p.threadId) || !isOptionalTs(p.beforeTimestampMs) || !isOptionalMessageId(p.beforeMessageId)) {
            return { success: false, code: 'FETCH', error: INVALID_ERROR };
        }
        try {
            const service = await getFBServiceOrReconnect(resolveInternalId(p.accountId));
            if (!service) return { success: false, code: 'NOT_CONNECTED', error: NOT_CONNECTED_ERROR };
            return await service.fetchHistoryPage(
                p.threadId.split('@')[0], { timestampMs: p.beforeTimestampMs ?? 0, messageId: p.beforeMessageId ?? '' }, undefined,
                // Chỉ boolean true từ máy này bật thử tin trước mã hoá; lệnh chuyển tiếp từ máy nhân viên (_fromRelay) không bao giờ bật.
                { mode: 'interactive', ...(p.probeE2ee === true && p._fromRelay !== true ? { probeE2ee: true } : {}) },
            );
        } catch (err: any) {
            Logger.warn(`[fbHistoryIpc] fb:fetchOlderMessages failed: ${err?.message}`);
            return { success: false, code: 'FETCH', error: err?.message || 'Lỗi không xác định' };
        }
    });

    const svc = () => FacebookHistorySyncService.getInstance();
    guardedSync('fb:historySync:start', true, (accountId, p) =>
        svc().start(accountId, { fromTs: p.fromTs, toTs: p.toTs }, () => getFBServiceOrReconnect(resolveInternalId(accountId))));
    guardedSync('fb:historySync:cancel', false, (accountId) => svc().cancel(accountId));
    guardedSync('fb:historySync:status', false, (accountId) => ({ success: true, status: svc().getStatus(accountId) }));
}
