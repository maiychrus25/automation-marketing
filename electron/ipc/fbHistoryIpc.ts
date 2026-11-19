import { dialog, ipcMain as electronIpcMain } from 'electron';
import { employeeRoutedIpcMain } from './proxyHelper';
import FacebookHistorySyncService from '../../src/services/facebook/FacebookHistorySyncService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import FacebookConnectionManager from '../../src/utils/FacebookConnectionManager';
import { getFBServiceOrReconnect, resolveInternalId } from './facebookIpc';
import { BOSS_ONLY_CHANNEL_CODE, BOSS_ONLY_CHANNEL_ERROR } from '../../src/services/http/employeeChannelRoutes';

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

// Mỗi tài khoản một lượt nhập tại một thời điểm (tính cả lúc hộp chọn tệp đang mở).
const importsRunning = new Set<string>();

/** Nhập tệp sao lưu đoạn chat của Facebook: chỉ boss, chỉ tài khoản cá nhân, hộp chọn tệp do tiến trình chính mở, không gọi mạng. */
async function importE2eeExport(p: any) {
    if (p?._fromRelay === true || isEmployeeMode()) return { success: false, code: BOSS_ONLY_CHANNEL_CODE, error: BOSS_ONLY_CHANNEL_ERROR };
    if (!isAccountId(p?.accountId)) return { success: false, error: INVALID_ERROR };
    const internalId = resolveInternalId(p.accountId);
    const db = require('../../src/services/database/DatabaseService').default.getInstance();
    const account = db.getFBAccount(internalId);
    if (!account) return { success: false, error: INVALID_ERROR };
    if (account.parent_facebook_id) return { success: false, code: 'PAGE_ACCOUNT', error: 'PAGE_ACCOUNT' };
    if (importsRunning.has(internalId)) return { success: false, code: 'IMPORT_IN_PROGRESS', error: 'IMPORT_IN_PROGRESS' };
    importsRunning.add(internalId);
    try {
        const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'ZIP', extensions: ['zip'] }] });
        if (picked.canceled || !picked.filePaths?.[0]) return { success: true, canceled: true };
        const { FacebookE2eeExportImporter } = require('../../src/services/facebook/e2eeExport/FacebookE2eeExportImporter');
        const summary = await new FacebookE2eeExportImporter({ db, accountId: internalId }).importFile(picked.filePaths[0]);
        // Chỉ số đếm: không tên, nội dung, đường dẫn hay mã.
        Logger.info(`[fbHistoryIpc] E2EE export import: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        return { success: true, summary };
    } catch (err: any) {
        const limit = err?.code === 'LIMIT';
        // Chỉ thêm err.code / err.name (dạng ký hiệu ngắn); không bao giờ err.message: có thể chứa tên mục trong tệp.
        const tag = String(err?.code || err?.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
        Logger.warn(`[fbHistoryIpc] fb:importE2eeExport failed: ${limit ? 'LIMIT' : 'FAILED'}${tag ? ` ${tag}` : ''}`);
        return limit ? { success: false, code: 'LIMIT', error: 'FILE_TOO_LARGE' } : { success: false, code: 'FAILED', error: 'IMPORT_FAILED' };
    } finally {
        importsRunning.delete(internalId);
    }
}

export function registerFbHistoryIpc(): void {
    ipcMain.handle('fb:importE2eeExport', (_event, p) => importE2eeExport(p));

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

    // Chỉ đọc DB cục bộ: dùng instance dịch vụ ĐÃ có (FacebookConnectionManager.get), không nối lại, không gọi bridge/mạng.
    ipcMain.handle('fb:isEncryptedThread', async (_event, p) => {
        if (!isAccountId(p?.accountId) || !isThreadId(p.threadId)) return { success: false, code: 'FETCH', error: INVALID_ERROR };
        if (p._fromRelay === true) return { success: true, encrypted: false };
        try {
            const service = FacebookConnectionManager.get(resolveInternalId(p.accountId));
            return { success: true, encrypted: service ? service.isE2EEThread(p.threadId.split('@')[0]) : false };
        } catch (err: any) {
            Logger.warn(`[fbHistoryIpc] fb:isEncryptedThread failed: ${err?.message}`);
            return { success: true, encrypted: false };
        }
    });

    const svc = () => FacebookHistorySyncService.getInstance();
    guardedSync('fb:historySync:start', true, (accountId, p) =>
        svc().start(accountId, { fromTs: p.fromTs, toTs: p.toTs }, () => getFBServiceOrReconnect(resolveInternalId(accountId))));
    guardedSync('fb:historySync:cancel', false, (accountId) => svc().cancel(accountId));
    guardedSync('fb:historySync:status', false, (accountId) => ({ success: true, status: svc().getStatus(accountId) }));
}
