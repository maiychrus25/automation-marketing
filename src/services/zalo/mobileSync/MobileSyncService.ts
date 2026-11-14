/**
 * MobileSyncService — phiên "Đồng bộ lịch sử tin nhắn từ điện thoại" cho tài khoản Zalo.
 *
 * pullMobile(public_key) → điện thoại hỏi người dùng → sự kiện điều khiển syncmsgmb:
 *   user_confirm → (transfer_error: đang chuẩn bị / máy tạm dừng) → syncmsg_info {url, encrypted_key}
 * → tải `.db.crypt` → giải khoá bằng khoá riêng → giải mã + giải nén ZDB4.0 ra các SQLite `<uid>.db` / `group_<gid>.db`
 * → đổi ID plain (điện thoại) sang noise (web) → nhập hàng loạt vào DB chính → dọn khoá riêng và thư mục làm việc.
 *
 * Luồng bám upstream babyvibe/deplao-builder (MIT) MobileSyncService.ts; viết lại theo giao diện của MaiHub.
 * Trạng thái cuối chỉ phát SAU khi đã xoá khoá riêng và thư mục làm việc. Không log nội dung tin, cookie, khoá, link tải.
 */
import * as fs from 'fs';
import * as path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import Logger from '../../../utils/Logger';
import type DatabaseService from '../../database/DatabaseService';
import type { MobileSyncStage, MobileSyncStats, MobileSyncStatus, SyncRange } from './types';
import { attachSyncEventListener, DEFAULT_SYNC_PC_NAME, installMobileSyncApis, SyncEvent } from './zcaMobileSync';
import { decryptBackupKey, extractZdbBackup, generateSyncKeyPair, verifyChecksum } from './zdbBackup';
import { downloadBackupFile } from './backupDownload';
import {
    collectPlainUserIds,
    countOutOfRange,
    ImportedZaloMessage,
    iterateChatContent,
    parseBackupFileName,
    PlainMessage,
    rowToPlainMessage,
    toZaloMessage,
} from './mobileMessageConverter';

export const MOBILE_SYNC_EVENT = 'event:mobileSync';

const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
const IMPORT_BATCH_SIZE = 1000;
const NOISE_BATCH_SIZE = 500;
const NOISE_ATTEMPTS = 3;
const PROFILE_BATCH_SIZE = 50;
const MAX_PROFILE_LOOKUPS = 1000;
const PROGRESS_THROTTLE_MS = 300;
const PULL_DEADLINE_MS = 30_000;
const CANCEL_DEADLINE_MS = 10_000;

const TERMINAL_STAGES: MobileSyncStage[] = ['completed', 'failed', 'cancelled'];
const WAITING_STAGES: MobileSyncStage[] = ['requesting', 'waiting_confirm', 'waiting_backup', 'mobile_idle'];
/** Tiến độ tổng (0-100, không giảm) của ba bước cuối: mỗi bước chiếm một dải. */
const PROGRESS_BANDS: Partial<Record<MobileSyncStage, [number, number]>> = {
    downloading: [0, 40],
    decrypting: [40, 60],
    resolving_ids: [60, 65],
    importing: [65, 99],
};

export interface MobileSyncDeps {
    /** `api` zca-js của tài khoản đang online, hoặc undefined. */
    getConnectedApi(zaloId: string): any | undefined;
    workRoot(): string;
    download: typeof downloadBackupFile;
    /** Mọi ghi DB của tính năng chạy trên DB chính, kể cả khi đang mở workspace khác. */
    runOnBossDb(fn: (db: DatabaseService) => void): void;
    emit(channel: string, data: MobileSyncStatus): void;
    sleep(ms: number): Promise<void>;
}

// `electron`, ConnectionManager và EventBroadcaster nạp muộn để Jest nạp được module này.
const defaultDeps: MobileSyncDeps = {
    getConnectedApi: zaloId => {
        const conn = require('../../../utils/ConnectionManager').default.getConnection(zaloId);
        return conn?.api && conn.connected ? conn.api : undefined;
    },
    workRoot: () => path.join(require('electron').app.getPath('userData'), 'mobile-sync'),
    download: downloadBackupFile,
    runOnBossDb: fn => require('../../event/EventBroadcaster').default.runOnBossDb(fn),
    emit: (channel, data) => require('../../event/EventBroadcaster').default.emit(channel, data),
    sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

interface SyncSession {
    zaloId: string;
    publicKey: string;
    privateKey: string;
    status: MobileSyncStatus;
    timer: ReturnType<typeof setTimeout> | null;
    cancelled: boolean;
    /** Đang đóng phiên (hết hạn chờ, đang gọi cancelPullMobile): mọi sự kiện bị bỏ qua. */
    closing: boolean;
    /** Lần gọi cancelPullMobile (duy nhất mỗi phiên); cancel() và hạn chót cùng chờ nó. */
    serverCancel: Promise<void> | null;
    importing: boolean;
    /** Điện thoại đã trả lời phiên này (một sự kiện đúng public_key đã tới): không cần huỷ muộn trên máy chủ. */
    phoneAnswered: boolean;
    lastEmitAt: number;
    /** Resolve khi huỷ: đánh thức các chỗ đang chờ (pullMobile, ngủ giữa các lần thử). */
    cancelSignal: Promise<void>;
    wake: () => void;
}

class MobileSyncCancelled extends Error {
    constructor() {
        super('cancelled');
    }
}

/** Lỗi làm hỏng cả phiên (đổi ID, ghi DB), khác lỗi riêng một file hội thoại. */
class FatalImportError extends Error {
    constructor(message: string, public readonly code?: string) {
        super(message);
    }
}

/** Lỗi ghi DB → thông báo tiếng Việt; thông điệp kỹ thuật của SQLite không chứa nội dung dòng. */
const dbWriteError = (err: any): FatalImportError =>
    new FatalImportError(`Không ghi được tin nhắn vào cơ sở dữ liệu (${err?.message || err})`, err?.code === 'ENOSPC' ? 'ENOSPC' : undefined);

const SAFE_ACCOUNT_ID = /^\d+$/;

const emptyStats = (): MobileSyncStats => ({
    conversations: 0, conversationsResolved: 0, conversationsUnresolved: 0, conversationsFailed: 0,
    messagesRead: 0, messagesImported: 0, messagesSkipped: 0, messagesOutOfRange: 0, durationMs: 0,
});

function positiveTs(value: unknown): number | null {
    const n = Math.floor(Number(value) || 0);
    return Number.isFinite(n) && n > 0 ? n : null;
}

class MobileSyncService {
    private static instance: MobileSyncService;
    private readonly deps: MobileSyncDeps;
    private sessions = new Map<string, SyncSession>();
    private detachers = new Map<string, () => void>();
    /** Instance zca-js đang được gắn listener cho từng tài khoản (mỗi lần nối lại là một api mới). */
    private attachedApis = new Map<string, any>();

    constructor(deps: Partial<MobileSyncDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
    }

    public static getInstance(): MobileSyncService {
        if (!MobileSyncService.instance) MobileSyncService.instance = new MobileSyncService();
        return MobileSyncService.instance;
    }

    /** Gắn API + listener sự kiện đồng bộ cho mỗi instance zca-js mới (gọi mỗi lần đăng nhập / dựng lại listener). */
    public attachToApi(zaloId: string, api: any): void {
        this.detachers.get(zaloId)?.();
        this.detachers.delete(zaloId);
        this.attachedApis.delete(zaloId);
        try {
            installMobileSyncApis(api);
            this.detachers.set(zaloId, attachSyncEventListener(api, event => this.onSyncEvent(zaloId, event)));
            this.attachedApis.set(zaloId, api);
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${zaloId}: không gắn được listener đồng bộ: ${err?.message}`);
        }
    }

    public getStatus(zaloId: string): MobileSyncStatus | null {
        if (!SAFE_ACCOUNT_ID.test(String(zaloId))) return null;
        return this.sessions.get(zaloId)?.status ?? null;
    }

    public async start(zaloId: string, range: SyncRange): Promise<{ success: boolean; status?: MobileSyncStatus; error?: string }> {
        if (!SAFE_ACCOUNT_ID.test(String(zaloId))) return { success: false, error: 'Tài khoản không online' };
        const fromTs = positiveTs(range?.fromTs);
        const toTs = positiveTs(range?.toTs);
        if (fromTs && toTs && fromTs > toTs) return { success: false, error: 'Ngày bắt đầu phải trước ngày kết thúc' };
        const existing = this.sessions.get(zaloId);
        if (existing && !TERMINAL_STAGES.includes(existing.status.stage)) {
            return { success: false, status: existing.status, error: 'Đang có một phiên đồng bộ chạy cho tài khoản này' };
        }
        const connected = this.deps.getConnectedApi(zaloId);
        if (!connected) return { success: false, error: 'Tài khoản không online' };
        if (this.attachedApis.get(zaloId) !== connected) this.attachToApi(zaloId, connected);
        let api: any;
        try {
            api = installMobileSyncApis(connected);
        } catch (err: any) {
            return { success: false, error: `Không gửi được yêu cầu đồng bộ: ${err?.message || err}` };
        }

        const { publicKey, privateKey } = generateSyncKeyPair();
        const now = Date.now();
        let wake!: () => void;
        const cancelSignal = new Promise<void>(resolve => { wake = resolve; });
        const session: SyncSession = {
            zaloId, publicKey, privateKey, cancelled: false, closing: false, serverCancel: null, importing: false, phoneAnswered: false, timer: null, lastEmitAt: 0, cancelSignal, wake,
            status: {
                zaloId, stage: 'requesting', progress: 0, message: 'Đang gửi yêu cầu tới điện thoại...',
                range: { fromTs, toTs }, startedAt: now, updatedAt: now,
            },
        };
        this.sessions.set(zaloId, session);
        this.emit(session, true);

        let pullError: any;
        try {
            // from_seq_id = fromTs gợi ý điện thoại chỉ gửi phần mới; khoảng [fromTs, toTs] vẫn được lọc khi đọc bản sao lưu.
            const pull = api.pullMobile({ public_key: publicKey, pc_name: DEFAULT_SYNC_PC_NAME, from_seq_id: fromTs ?? 0, min_seq_id: 0 });
            // Yêu cầu có thể tới máy chủ sau khi phiên đã kết thúc (huỷ / quá 30 s): huỷ lại đúng khoá của phiên này.
            void Promise.resolve(pull).then(() => {
                if (TERMINAL_STAGES.includes(session.status.stage) && !session.phoneAnswered) void this.cancelRequestQuietly(api, session);
            }, () => undefined);
            await this.bounded(pull, PULL_DEADLINE_MS, 'hết thời gian chờ máy chủ Zalo', session);
        } catch (err: any) {
            pullError = err;
        }
        if (session.cancelled) return { success: false, status: session.status, error: 'Đã huỷ' };
        // Sự kiện từ điện thoại có thể tới trước phản hồi HTTP: phiên đã đi tiếp thì không động vào (lỗi pull muộn bị bỏ qua).
        if (session.status.stage !== 'requesting' || session.importing || session.closing) {
            const ended = session.status.stage === 'failed' || session.status.stage === 'cancelled';
            return { success: !ended, status: session.status, ...(ended ? { error: session.status.error ?? session.status.message } : {}) };
        }
        if (pullError) {
            this.fail(session, `Không gửi được yêu cầu đồng bộ: ${pullError?.message || pullError}`);
            return { success: false, status: session.status, error: session.status.error };
        }

        Logger.log(`[MobileSync] ${zaloId}: đã gửi pull_mobile_msg, chờ xác nhận trên điện thoại`);
        this.setStage(session, 'waiting_confirm', 'Mở Zalo trên điện thoại và bấm "Đồng ý" để đồng bộ tin nhắn sang máy tính');
        this.armTimeout(session, CONFIRM_TIMEOUT_MS, 'Hết thời gian chờ xác nhận trên điện thoại');
        return { success: true, status: session.status };
    }

    public async cancel(zaloId: string): Promise<{ success: boolean; status?: MobileSyncStatus }> {
        if (!SAFE_ACCOUNT_ID.test(String(zaloId))) return { success: false };
        const session = this.sessions.get(zaloId);
        if (!session || TERMINAL_STAGES.includes(session.status.stage)) return { success: true, status: session?.status };
        session.cancelled = true;
        session.wake();
        this.clearTimer(session);
        if (!session.importing) {
            await this.cancelOnServer(session);
            this.finish(session, 'cancelled', 'Đã huỷ đồng bộ');
        }
        // Đang tải/giải mã/nhập → vòng xử lý tự dừng ở điểm kiểm tra kế tiếp rồi chuyển sang 'cancelled'.
        return { success: true, status: session.status };
    }

    /** Xoá thư mục làm việc còn sót do app tắt giữa chừng. Gọi lúc khởi động, trước mọi phiên. */
    public sweepLeftovers(): void {
        if (Array.from(this.sessions.values()).some(s => s.importing)) return;
        try {
            fs.rmSync(this.deps.workRoot(), { recursive: true, force: true });
        } catch (err: any) {
            Logger.warn(`[MobileSync] không dọn được thư mục tạm: ${err?.message}`);
        }
    }

    // ─── Sự kiện từ điện thoại ───────────────────────────────────────────────

    private onSyncEvent(zaloId: string, event: SyncEvent): void {
        const session = this.sessions.get(zaloId);
        if (!session || session.importing || session.closing || session.cancelled || TERMINAL_STAGES.includes(session.status.stage)) return;
        const data: any = event.data || {};
        if (data.public_key !== session.publicKey) return;
        session.phoneAnswered = true;

        Logger.log(`[MobileSync] ${zaloId}: sự kiện ${event.type}`);
        switch (event.type) {
            case 'user_confirm': {
                const action = Number(data.user_action);
                if (action === 1 || action === 3) {
                    this.waitForBackup(session);
                } else if (action === 0) {
                    this.finish(session, 'cancelled', 'Bạn đã từ chối đồng bộ trên điện thoại');
                } else if (action === 2) {
                    this.fail(session, 'Điện thoại đang khôi phục dữ liệu, vui lòng thử lại sau');
                }
                break;
            }
            case 'transfer_error': {
                const status = Number(data.status);
                const errorCode = Number(data.error_code || 0);
                if (status === 1) {
                    this.waitForBackup(session);
                } else if (status === 2) {
                    this.setStage(session, 'mobile_idle', 'Điện thoại đang tạm dừng — mở Zalo trên điện thoại để tiếp tục đồng bộ');
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, 'Hết thời gian chờ điện thoại gửi dữ liệu');
                } else if (errorCode !== 0) {
                    this.fail(session, `Điện thoại không tạo được bản sao lưu (mã ${data.error_code}${data.error_msg ? `: ${data.error_msg}` : ''})`);
                }
                break;
            }
            case 'syncmsg_info':
                this.clearTimer(session);
                session.importing = true;
                void this.runImport(session, data);
                break;
            default:
                break;
        }
    }

    private waitForBackup(session: SyncSession): void {
        this.setStage(session, 'waiting_backup', 'Điện thoại đang chuẩn bị dữ liệu tin nhắn, vui lòng giữ Zalo mở trên điện thoại...');
        this.armTimeout(session, BACKUP_TIMEOUT_MS, 'Hết thời gian chờ điện thoại gửi dữ liệu');
    }

    // ─── Tải + giải mã + nhập ────────────────────────────────────────────────

    private async runImport(session: SyncSession, info: any): Promise<void> {
        const startedAt = Date.now();
        const stats = emptyStats();
        let workRoot = '';
        let workDir = '';
        // Trạng thái cuối chỉ phát SAU khi xoá khoá riêng và dọn thư mục làm việc.
        let settle: (() => void) | undefined;
        let aesKey: Buffer | undefined;
        try {
            workRoot = path.resolve(this.deps.workRoot());
            workDir = path.resolve(workRoot, session.zaloId, String(startedAt));
            if (!workDir.startsWith(workRoot + path.sep)) throw new Error('Thư mục làm việc không hợp lệ');
            const api = this.currentApi(session.zaloId);
            const dbInfo = this.parseDbInfo(info.db_info);
            const format = Number(dbInfo.db_format) || 0;
            if (format !== 1) {
                throw new Error(`Định dạng sao lưu chưa được hỗ trợ (db_format=${format}). Hãy cập nhật Zalo trên điện thoại rồi thử lại.`);
            }
            // Giống Zalo PC: origin_db (nếu có) được ưu tiên hơn backup_db; msg_total = 0 → không có gì để nhập.
            const counts = dbInfo.origin_db || dbInfo.backup_db;
            if (counts && Number(counts.msg_total) === 0) {
                this.throwIfCancelled(session);
                settle = () => this.finish(session, 'completed', session.status.range?.fromTs || session.status.range?.toTs
                    ? 'Điện thoại không có tin nhắn nào trong khoảng thời gian đã chọn'
                    : 'Điện thoại không có tin nhắn nào để đồng bộ', stats);
                return;
            }

            await fs.promises.mkdir(workDir, { recursive: true });
            const cryptPath = path.join(workDir, 'backup.db.crypt');
            this.setStage(session, 'downloading', 'Đang tải dữ liệu từ máy chủ Zalo...');
            await this.downloadBackup(api, session, info, cryptPath);

            if (await verifyChecksum(cryptPath, info.checksum_code || info.checksum) === 'mismatch') {
                Logger.warn(`[MobileSync] ${session.zaloId}: checksum không khớp, vẫn thử giải mã`);
            }
            this.throwIfCancelled(session);

            this.setStage(session, 'decrypting', 'Đang giải mã dữ liệu tin nhắn...');
            aesKey = decryptBackupKey(String(info.encrypted_key || ''), session.privateKey);
            const extracted = await extractZdbBackup(cryptPath, aesKey, path.join(workDir, 'db'), {
                isCancelled: () => session.cancelled,
                onProgress: (done, total) => this.setProgress(session, total ? (done / total) * 100 : 0),
            });
            this.throwIfCancelled(session);
            await fs.promises.rm(cryptPath, { force: true });
            if (extracted.skippedEntries.length) {
                Logger.warn(`[MobileSync] ${session.zaloId}: bỏ qua ${extracted.skippedEntries.length} mục có tên không hợp lệ`);
            }

            // Id plain của chính tài khoản lấy từ `uid` của sự kiện (như upstream); thiếu/không phải số → '' (không nhận diện được tin của mình,
            // các id vẫn đổi qua znoise nên không gán sai người gửi).
            const ownPlainId = /^\d+$/.test(String(info.uid ?? '')) ? String(info.uid) : '';
            const withNew = await this.importConversations(session, api, extracted.files, ownPlainId, stats);
            this.throwIfCancelled(session);
            stats.durationMs = Date.now() - startedAt;
            Logger.log(`[MobileSync] ${session.zaloId}: hoàn tất ${JSON.stringify(stats)}`);
            const rangeNote = session.status.range?.fromTs || session.status.range?.toTs ? ' trong khoảng thời gian đã chọn' : '';
            settle = () => this.finish(session, 'completed',
                `Đã đồng bộ ${stats.messagesImported.toLocaleString('vi-VN')} tin nhắn mới từ ${withNew} hội thoại${rangeNote}`,
                stats);
        } catch (err: any) {
            stats.durationMs = Date.now() - startedAt;
            if (session.cancelled || err instanceof MobileSyncCancelled || err?.name === 'AbortError') {
                settle = () => this.finish(session, 'cancelled', 'Đã huỷ đồng bộ', stats);
            } else {
                Logger.error(`[MobileSync] ${session.zaloId}: lỗi ${err?.message || err}`);
                const message = err?.code === 'ENOSPC' ? 'Không đủ dung lượng đĩa để tải hoặc giải nén bản sao lưu' : (err?.message || String(err));
                settle = () => this.fail(session, message, stats);
            }
        } finally {
            session.privateKey = '';
            aesKey?.fill(0);
            if (workDir) {
                await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {
                    Logger.warn(`[MobileSync] ${session.zaloId}: không xoá được thư mục làm việc ${path.relative(workRoot, workDir)}`);
                });
            }
            session.importing = false;
            settle?.();
        }
    }

    private parseDbInfo(raw: unknown): { db_format?: number; backup_db?: any; origin_db?: any } {
        if (!raw) return {};
        if (typeof raw === 'object') return raw as any;
        try {
            return JSON.parse(String(raw)) || {};
        } catch {
            throw new Error('Thông tin bản sao lưu từ điện thoại không hợp lệ');
        }
    }

    private async downloadBackup(api: any, session: SyncSession, info: any, destPath: string): Promise<void> {
        const ctx = api.getContext();
        // Zalo PC gửi cookie phiên của domain đăng nhập (chat.zalo.me) tới máy chủ tải. Hỏi cookie theo host của link
        // tải (zaloapp.com) thì hũ cookie không có gì và máy chủ trả HTTP 400. backupDownload vẫn chỉ gửi cho host
        // Zalo qua https và bỏ cookie khi chuyển hướng ra ngoài.
        const cookieFor = (): string => {
            try { return ctx.cookie.getCookieStringSync('https://chat.zalo.me/') || ''; } catch { return ''; }
        };
        await this.deps.download(String(info.url || ''), destPath, {
            cookieFor,
            userAgent: ctx.userAgent,
            agent: ctx.options?.agent,
            isCancelled: () => session.cancelled,
            onProgress: (received, total) => this.setProgress(session, total ? (received / total) * 100 : 0),
        });
    }

    private async importConversations(session: SyncSession, api: any, files: Array<{ name: string; path: string }>, ownPlainId: string, stats: MobileSyncStats): Promise<number> {
        let conversationsWithNew = 0;
        const zaloId = session.zaloId;
        const ownNoiseId = String(api.getOwnId?.() || zaloId);
        const threads = files.flatMap(file => {
            const ref = parseBackupFileName(file.name);
            return ref ? [{ file, ref }] : [];
        });
        stats.conversations = threads.length;

        this.setStage(session, 'resolving_ids', 'Đang ghép hội thoại với tài khoản trên máy tính...');
        const userMap = this.onBossDb(db => db.getPlainIdMap(zaloId, 'user'));
        const groupMap = this.onBossDb(db => db.getPlainIdMap(zaloId, 'group'));
        await this.resolveNoiseIds(api, session, 'user', threads.filter(t => t.ref.kind === 'user').map(t => t.ref.plainId), userMap, ownPlainId);
        await this.resolveNoiseIds(api, session, 'group', threads.filter(t => t.ref.kind === 'group').map(t => t.ref.plainId), groupMap, ownPlainId);

        this.setStage(session, 'importing', 'Đang ghép tin nhắn vào các hội thoại...');
        const range = session.status.range ?? { fromTs: null, toTs: null };
        // CONTRACT của toZaloMessage: id plain của chính tài khoản → ownNoiseId, người khác → id đã đổi, không biết → ''.
        const resolveUser = (plainId: string): string =>
            ownPlainId && plainId === ownPlainId ? ownNoiseId : (userMap.get(plainId) || '');
        const touched = new Map<string, boolean>(); // noise threadId → isGroup

        for (let i = 0; i < threads.length; i++) {
            this.throwIfCancelled(session);
            const { file, ref } = threads[i];
            const isGroup = ref.kind === 'group';
            const threadNoiseId = isGroup ? groupMap.get(ref.plainId) : (ref.plainId === ownPlainId ? ownNoiseId : userMap.get(ref.plainId));
            if (!threadNoiseId) {
                stats.conversationsUnresolved++;
                continue;
            }
            stats.conversationsResolved++;
            const ctx = { threadNoiseId, isGroup, ownNoiseId, resolveUser };
            const importedBefore = stats.messagesImported;
            let sqlite: ReturnType<typeof BetterSqlite3> | undefined;
            try {
                sqlite = new BetterSqlite3(file.path, { readonly: true, fileMustExist: true });
                try { sqlite.pragma('trusted_schema = OFF'); } catch { /* bản SQLite không hỗ trợ */ }
                sqlite.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get(); // file không phải SQLite → ném ở đây
                // ChatContent phải là bảng thật: view/virtual table trong file độc hại có thể chạy truy vấn tuỳ ý.
                // SQLite phân giải tên không phân biệt hoa thường: mọi đối tượng tên chatcontent phải là bảng.
                const kinds = sqlite.prepare("SELECT type FROM sqlite_master WHERE name = 'ChatContent' COLLATE NOCASE").all() as Array<{ type: string }>;
                if (kinds.some(k => k.type !== 'table')) throw new Error('ChatContent không phải bảng');
                stats.messagesOutOfRange += countOutOfRange(sqlite, range);
                let batch: PlainMessage[] = [];
                for (const dbRow of iterateChatContent(sqlite, range)) {
                    stats.messagesRead++;
                    if (stats.messagesRead % IMPORT_BATCH_SIZE === 0) await this.yieldToEventLoop(session); // cả khi mọi dòng đều bị bỏ qua
                    const plain = rowToPlainMessage(dbRow);
                    if (!plain) {
                        stats.messagesSkipped++;
                        continue;
                    }
                    batch.push(plain);
                    if (batch.length >= IMPORT_BATCH_SIZE) {
                        await this.flushBatch(api, session, batch, ctx, userMap, ownPlainId, stats, touched);
                        batch = [];
                    }
                }
                if (batch.length) await this.flushBatch(api, session, batch, ctx, userMap, ownPlainId, stats, touched);
            } catch (err: any) {
                if (err instanceof MobileSyncCancelled || err instanceof FatalImportError) throw err;
                // Một file hỏng không làm hỏng cả lượt; log loại file + tên lỗi, không log id hay nội dung.
                stats.conversationsFailed++;
                Logger.warn(`[MobileSync] ${zaloId}: bỏ qua một file hội thoại ${ref.kind} không đọc được (${err?.name || 'Error'})`);
            } finally {
                try { sqlite?.close(); } catch { /* đã đóng */ }
            }
            if (stats.messagesImported > importedBefore) conversationsWithNew++;
            this.setProgress(session, ((i + 1) / threads.length) * 100);
        }

        this.throwIfCancelled(session);
        await this.refreshMissingProfiles(api, zaloId, touched);
        return conversationsWithNew;
    }

    private async flushBatch(
        api: any, session: SyncSession, batch: PlainMessage[],
        ctx: { threadNoiseId: string; isGroup: boolean; ownNoiseId: string; resolveUser: (plainId: string) => string },
        userMap: Map<string, string>, ownPlainId: string, stats: MobileSyncStats, touched: Map<string, boolean>,
    ): Promise<void> {
        await this.resolveNoiseIds(api, session, 'user', collectPlainUserIds(batch), userMap, ownPlainId);
        const messages: ImportedZaloMessage[] = [];
        for (const plain of batch) {
            const converted = toZaloMessage(plain, ctx);
            if (converted) messages.push(converted);
        }
        stats.messagesSkipped += batch.length - messages.length; // loại không hỗ trợ / người gửi không đổi được ID
        if (messages.length) {
            let res: { inserted: number; upgraded: number; skipped: number; threads: string[] };
            try {
                res = this.onBossDb(db => db.saveHistoryMessagesBulk(session.zaloId, messages));
            } catch (err: any) {
                throw dbWriteError(err);
            }
            stats.messagesImported += res.inserted;
            stats.messagesSkipped += res.skipped + res.upgraded; // đã có sẵn (trực tiếp / lần đồng bộ trước)
            for (const threadId of res.threads) touched.set(threadId, ctx.isGroup);
        }
        await this.yieldToEventLoop(session);
    }

    /** Nhường event loop (và kiểm tra huỷ) để lượt nhập dài không làm đơ app. */
    private async yieldToEventLoop(session: SyncSession): Promise<void> {
        await new Promise<void>(resolve => setImmediate(resolve));
        this.throwIfCancelled(session);
    }

    /** Đổi plain → noise (theo lô, thử lại), lưu bảng ánh xạ. ID không đổi được → '' (chỉ nhớ trong phiên). */
    private async resolveNoiseIds(
        api: any, session: SyncSession, kind: 'user' | 'group', plainIds: string[],
        cache: Map<string, string>, ownPlainId: string,
    ): Promise<void> {
        const missing = Array.from(new Set(plainIds)).filter(id => /^\d+$/.test(id) && id !== ownPlainId && !cache.has(id));
        for (let i = 0; i < missing.length; i += NOISE_BATCH_SIZE) {
            this.throwIfCancelled(session);
            const chunk = missing.slice(i, i + NOISE_BATCH_SIZE);
            const res = await this.withRetry<{ uids: string[]; gids: string[] }>(session, () => api.getNoisedIds(kind === 'user' ? { uids: chunk, gids: [] } : { uids: [], gids: chunk }));
            const list: string[] = (kind === 'user' ? res.uids : res.gids) || [];
            const pairs: Array<[string, string]> = [];
            chunk.forEach((plainId, idx) => {
                const noiseId = list[idx] || '';
                cache.set(plainId, noiseId);
                if (noiseId) pairs.push([plainId, noiseId]);
            });
            if (pairs.length) {
                try {
                    this.onBossDb(db => db.savePlainIdMap(session.zaloId, kind, pairs));
                } catch (err: any) {
                    throw dbWriteError(err); // lỗi ghi DB: dừng cả lượt, không coi là file hỏng
                }
            }
        }
    }

    private async withRetry<T>(session: SyncSession, fn: () => Promise<T>): Promise<T> {
        let lastErr: any;
        for (let attempt = 1; attempt <= NOISE_ATTEMPTS; attempt++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (attempt === NOISE_ATTEMPTS) break;
                await Promise.race([this.deps.sleep(1000 * attempt), session.cancelSignal]);
                this.throwIfCancelled(session);
            }
        }
        throw new FatalImportError(`Không đổi được ID hội thoại từ điện thoại: ${lastErr?.message || lastErr}`);
    }

    /** Hội thoại mới tạo chưa có tên → lấy tên/ảnh đại diện. Lỗi ở bước này bị bỏ qua. */
    private async refreshMissingProfiles(api: any, zaloId: string, touched: Map<string, boolean>): Promise<void> {
        if (touched.size === 0) return;
        let ids: { users: string[]; groups: string[] };
        try {
            ids = this.onBossDb(db => db.getContactIdsWithoutProfile(zaloId, MAX_PROFILE_LOOKUPS, Array.from(touched.keys())));
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${zaloId}: không đọc được danh sách hồ sơ thiếu: ${err?.message}`);
            return;
        }
        const users = ids.users.filter(id => touched.get(id) === false).slice(0, MAX_PROFILE_LOOKUPS);
        const groups = ids.groups.filter(id => touched.get(id) === true).slice(0, MAX_PROFILE_LOOKUPS);
        for (let i = 0; i < users.length; i += PROFILE_BATCH_SIZE) {
            const chunk = users.slice(i, i + PROFILE_BATCH_SIZE);
            try {
                const res: any = await api.getUserInfo(chunk);
                const profiles = res?.changed_profiles || {};
                this.onBossDb(db => {
                    for (const id of chunk) {
                        const p = profiles[id] || profiles[`${id}_0`];
                        const name = p?.displayName || p?.zaloName || '';
                        if (name) db.updateContactProfile(zaloId, id, name, p?.avatar || '', '', 'user');
                    }
                });
            } catch (err: any) {
                Logger.warn(`[MobileSync] ${zaloId}: getUserInfo lỗi: ${err?.message}`);
            }
        }
        for (let i = 0; i < groups.length; i += PROFILE_BATCH_SIZE) {
            const chunk = groups.slice(i, i + PROFILE_BATCH_SIZE);
            try {
                const res: any = await api.getGroupInfo(chunk);
                const infos = res?.gridInfoMap || {};
                this.onBossDb(db => {
                    for (const id of chunk) {
                        const g = infos[id];
                        if (g?.name) db.updateContactProfile(zaloId, id, g.name, g.avt || g.fullAvt || '', '', 'group');
                    }
                });
            } catch (err: any) {
                Logger.warn(`[MobileSync] ${zaloId}: getGroupInfo lỗi: ${err?.message}`);
            }
        }
    }

    // ─── Trạng thái / tiện ích ───────────────────────────────────────────────

    private onBossDb<T>(fn: (db: DatabaseService) => T): T {
        let result: T;
        this.deps.runOnBossDb(db => { result = fn(db); });
        return result!;
    }

    /** Api đang kết nối, hoặc api đã gắn gần nhất: tải file và znoise là HTTP thường, không cần websocket. */
    private currentApi(zaloId: string): any {
        const api = this.deps.getConnectedApi(zaloId) ?? this.attachedApis.get(zaloId);
        if (!api) throw new Error('Tài khoản đã mất kết nối');
        return installMobileSyncApis(api);
    }

    private cancelOnServer(session: SyncSession): Promise<void> {
        if (!session.serverCancel) {
            session.serverCancel = WAITING_STAGES.includes(session.status.stage) ? this.sendServerCancel(session) : Promise.resolve();
        }
        return session.serverCancel;
    }

    /** Huỷ yêu cầu trên máy chủ cho khoá của `session`, không đổi trạng thái; lỗi bị nuốt. */
    private async cancelRequestQuietly(api: any, session: SyncSession): Promise<void> {
        try {
            await this.bounded(api.cancelPullMobile({ public_key: session.publicKey, pc_name: DEFAULT_SYNC_PC_NAME }), CANCEL_DEADLINE_MS, 'hết thời gian chờ');
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${session.zaloId}: huỷ yêu cầu muộn lỗi: ${err?.message}`);
        }
    }

    private async sendServerCancel(session: SyncSession): Promise<void> {
        try {
            // Best-effort: máy chủ treo hoặc lỗi thì vẫn kết thúc phiên.
            await this.bounded(
                this.currentApi(session.zaloId).cancelPullMobile({ public_key: session.publicKey, pc_name: DEFAULT_SYNC_PC_NAME }),
                CANCEL_DEADLINE_MS, 'hết thời gian chờ',
            );
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${session.zaloId}: cancel_pull_mobile_msg lỗi: ${err?.message}`);
        }
    }

    private armTimeout(session: SyncSession, ms: number, message: string): void {
        this.clearTimer(session);
        session.timer = setTimeout(() => {
            session.timer = null;
            if (!WAITING_STAGES.includes(session.status.stage) || session.importing) return;
            session.closing = true; // từ đây mọi sự kiện bị bỏ qua, kể cả syncmsg_info
            void this.cancelOnServer(session).finally(() => {
                if (session.cancelled) this.finish(session, 'cancelled', 'Đã huỷ đồng bộ'); // ý định của người dùng thắng hạn chót
                else this.fail(session, message);
            });
        }, ms);
    }

    /** Chạy `p` với hạn chót; huỷ phiên (nếu truyền `session`) cũng dừng chờ. Luôn xoá timer. */
    private async bounded<T>(p: Promise<T>, ms: number, timeoutMessage: string, session?: SyncSession): Promise<T | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const racers: Array<Promise<T | undefined>> = [
                p,
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), ms); }),
            ];
            if (session) racers.push(session.cancelSignal.then(() => undefined));
            return await Promise.race(racers);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private clearTimer(session: SyncSession): void {
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
    }

    private throwIfCancelled(session: SyncSession): void {
        if (session.cancelled) throw new MobileSyncCancelled();
    }

    private setStage(session: SyncSession, stage: MobileSyncStage, message: string): void {
        const floor = PROGRESS_BANDS[stage]?.[0] ?? 0;
        session.status = { ...session.status, stage, message, progress: Math.max(session.status.progress, floor), updatedAt: Date.now() };
        this.emit(session, true);
    }

    /** `percent` (0-100) của bước hiện tại → tiến độ tổng không giảm; phát tối đa một lần mỗi 300 ms. */
    private setProgress(session: SyncSession, percent: number): void {
        const band = PROGRESS_BANDS[session.status.stage];
        if (!band) return;
        const clamped = Math.max(0, Math.min(100, percent));
        const value = Math.round(band[0] + (clamped * (band[1] - band[0])) / 100);
        if (value <= session.status.progress) return;
        session.status = { ...session.status, progress: value, updatedAt: Date.now() };
        this.emit(session, false);
    }

    private fail(session: SyncSession, error: string, stats?: MobileSyncStats): void {
        this.finish(session, 'failed', error, stats, error);
    }

    private finish(session: SyncSession, stage: MobileSyncStage, message: string, stats?: MobileSyncStats, error?: string): void {
        if (TERMINAL_STAGES.includes(session.status.stage)) return;
        this.clearTimer(session);
        session.privateKey = '';
        session.status = {
            ...session.status, stage, message, error, stats,
            progress: stage === 'completed' ? 100 : session.status.progress,
            updatedAt: Date.now(),
        };
        this.emit(session, true);
    }

    private emit(session: SyncSession, force: boolean): void {
        const now = Date.now();
        if (!force && now - session.lastEmitAt < PROGRESS_THROTTLE_MS) return;
        session.lastEmitAt = now;
        this.deps.emit(MOBILE_SYNC_EVENT, session.status);
    }
}

export default MobileSyncService;
