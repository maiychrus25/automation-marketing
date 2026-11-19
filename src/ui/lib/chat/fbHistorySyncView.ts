// Hàm thuần cho hộp thoại "Đồng bộ tin nhắn Facebook" (không phụ thuộc React/IPC).
import { isFbHistorySyncActive, type FbHistorySyncStatus } from '../../../services/facebook/facebookHistory';

export const FB_SYNC_TITLE = 'Đồng bộ tin nhắn Facebook';
export const FB_SYNC_ALL_WARNING = 'Tải toàn bộ lịch sử gửi nhiều yêu cầu nhất tới Facebook và có thể chạy nhiều giờ. Chỉ chọn khi thật sự cần.';
export const FB_SYNC_WAITING = 'Đang chờ để không gửi quá nhiều yêu cầu tới Facebook…';

export function isFbSyncRunning(status?: FbHistorySyncStatus | null): boolean {
  return isFbHistorySyncActive(status);
}

export function isFbSyncTerminal(status?: FbHistorySyncStatus | null): boolean {
  return !!status && (status.stage === 'completed' || status.stage === 'failed' || status.stage === 'cancelled');
}

/** 0–100 theo hội thoại xong / tổng; đang lấy danh sách → 0; hoàn tất → 100. */
export function fbSyncProgress(status: FbHistorySyncStatus): number {
  if (status.stage === 'completed') return 100;
  if (status.stage === 'listing' || status.threadsTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((status.threadsDone / status.threadsTotal) * 100)));
}

export const FB_IMPORT_LABEL = 'Nhập từ tệp Facebook (.zip)';
export const FB_IMPORT_BUSY = 'Đang nhập…';
export const FB_IMPORT_NOTE = 'Dùng cho hội thoại mã hoá đầu cuối: tải bản sao lưu đoạn chat từ Facebook rồi chọn tệp .zip. MaiHub chỉ đọc tệp trên máy, không gửi yêu cầu nào tới Facebook.';

/** importHint: tài khoản cá nhân trên máy Boss, có nút nhập tệp. */
export function fbSyncNotes(status: FbHistorySyncStatus, importHint = false): string[] {
  const notes: string[] = [];
  if (status.skippedE2EE > 0) {
    notes.push(`${status.skippedE2EE} hội thoại mã hoá đầu cuối được bỏ qua${importHint ? `. Dùng "${FB_IMPORT_LABEL}" để lấy tin cũ của các hội thoại này.` : ''}`);
  }
  if (status.failedThreads > 0) notes.push(`${status.failedThreads} hội thoại không tải được`);
  return notes;
}

export function isFbSyncWaiting(status: FbHistorySyncStatus, now: number): boolean {
  return isFbSyncRunning(status) && (status.pausedUntil ?? 0) > now;
}

/** Bỏ sự kiện của tài khoản khác và của lượt chạy cũ hơn (startedAt nhỏ hơn). */
export function reduceFbSyncStatus(
  prev: FbHistorySyncStatus | null, next: FbHistorySyncStatus, accountId: string,
): FbHistorySyncStatus | null {
  if (next.accountId !== accountId) return prev;
  if (prev && next.startedAt < prev.startedAt) return prev;
  // Ảnh chụp getStatus đến muộn sau sự kiện kết thúc không được kéo hộp thoại về "đang chạy".
  if (prev && next.startedAt === prev.startedAt && isFbSyncTerminal(prev) && !isFbSyncTerminal(next)) return prev;
  return next;
}

export interface FbImportSummary {
  chatsInFile: number; chatsMatched: number; chatsUnmatched: number; messagesInFile: number; imported: number; alreadyPresent: number;
  withoutSenderId: number; mediaImported: number; mediaSkipped: number; malformedSkipped: number;
}
export interface FbImportResult { success: boolean; canceled?: boolean; summary?: FbImportSummary; code?: string; error?: string }

/** Câu kết quả sau khi nhập tệp (không dùng cho canceled: không có gì để hiện). */
export function fbImportResultText(res?: FbImportResult | null): string {
  if (res?.success && res.summary) {
    const s = res.summary;
    if (s.chatsInFile <= 0) return 'Tệp không đúng định dạng bản sao lưu đoạn chat của Facebook.';
    let text = s.imported === 0 && s.chatsMatched > 0
      ? `Không có tin mới: ${s.alreadyPresent} tin trong tệp đã có sẵn.`
      : `Đã nhập ${s.imported} tin vào ${s.chatsMatched} hội thoại.`;
    if (s.alreadyPresent > 0 && s.imported > 0) text += ` ${s.alreadyPresent} tin đã có sẵn.`;
    if (s.chatsUnmatched > 0) text += ` ${s.chatsUnmatched} hội thoại trong tệp không ghép được với hội thoại nào trên máy.`;
    if (s.withoutSenderId > 0) text += ` ${s.withoutSenderId} tin nhóm chỉ có tên người gửi.`;
    if (s.mediaSkipped > 0) text += ` ${s.mediaSkipped} tệp đính kèm không nhập được.`;
    return text;
  }
  if (res?.code === 'LIMIT') return 'Tệp quá lớn để nhập.';
  if (res?.code === 'IMPORT_IN_PROGRESS') return 'Đang nhập một tệp khác cho tài khoản này.';
  return 'Không nhập được tệp. Thử lại sau.';
}

/** Màu kết quả: xanh chỉ khi có tin mới; trung tính khi tệp hợp lệ nhưng không có gì để nhập; đỏ khi lỗi. */
export function fbImportTone(res?: FbImportResult | null): 'success' | 'neutral' | 'error' {
  if (!res?.success || !res.summary || res.summary.chatsInFile <= 0) return 'error';
  return res.summary.imported > 0 ? 'success' : 'neutral';
}
