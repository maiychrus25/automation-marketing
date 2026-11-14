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

export function fbSyncNotes(status: FbHistorySyncStatus): string[] {
  const notes: string[] = [];
  if (status.skippedE2EE > 0) notes.push(`${status.skippedE2EE} hội thoại mã hoá đầu cuối được bỏ qua`);
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
