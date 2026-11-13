// Kiểu trạng thái phiên "Đồng bộ lịch sử từ điện thoại" (gửi về renderer qua `event:mobileSync`).
import type { SyncRange } from './mobileMessageConverter';

export type { SyncRange };

export type MobileSyncStage =
    | 'requesting'
    | 'waiting_confirm'
    | 'waiting_backup'
    | 'mobile_idle'
    | 'downloading'
    | 'decrypting'
    | 'resolving_ids'
    | 'importing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface MobileSyncStats {
    conversations: number;
    conversationsResolved: number;
    conversationsUnresolved: number;
    /** File hội thoại không đọc được (hỏng): bỏ qua, các hội thoại khác vẫn nhập. */
    conversationsFailed: number;
    /** Tin trong khoảng đã chọn đọc được từ bản sao lưu. */
    messagesRead: number;
    messagesImported: number;
    messagesSkipped: number;
    /** Tin có trong bản sao lưu nhưng ngoài khoảng đã chọn: không nhập. */
    messagesOutOfRange: number;
    durationMs: number;
}

export interface MobileSyncStatus {
    zaloId: string;
    stage: MobileSyncStage;
    /** Tiến độ TỔNG 0-100, không giảm (tải 0-40, giải mã 40-60, ghép ID 60-65, nhập 65-99); 100 khi `completed`. Không phải tiến độ từng bước. */
    progress: number;
    message: string;
    range?: SyncRange;
    error?: string;
    stats?: MobileSyncStats;
    startedAt?: number;
    updatedAt: number;
}
