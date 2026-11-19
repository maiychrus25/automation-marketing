/**
 * Ported from babyvibe/deplao-builder @2162f07 (MIT)
 * Kiểu và quy tắc thuần cho tải lịch sử tin nhắn Facebook (một hội thoại hoặc theo khoảng thời gian).
 */

/** ms; null = không giới hạn phía đó (cả hai null = toàn bộ lịch sử). */
export interface FbHistoryRange { fromTs: number | null; toTs: number | null }
export interface FbHistoryAnchor { timestampMs: number; messageId: string }

export type FbHistoryCode = 'NOT_CONNECTED' | 'BRIDGE_DOWN' | 'BRIDGE_OLD' | 'E2EE' | 'FETCH' | 'RISK' | 'COOLDOWN' | 'BUSY' | 'CANCELLED';
export type FbHistorySource = 'lightspeed' | 'graphql';
// Với `strict: false` của dự án, thu hẹp bằng `res.success === false` hoặc `'error' in res`; `if (!res.success)` không thu hẹp.
export type FbHistoryPageResult =
  | { success: true; saved: number; received: number; stored: number; count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string; source: FbHistorySource }
  | { success: false; code: FbHistoryCode; error: string; source?: FbHistorySource };

export type FbHistorySyncStage = 'idle' | 'listing' | 'syncing' | 'completed' | 'failed' | 'cancelled';

export interface FbHistorySyncStatus {
  accountId: string;
  stage: FbHistorySyncStage;
  range: FbHistoryRange;
  message: string;
  error?: string;
  threadsTotal: number;
  threadsDone: number;
  currentThreadName?: string;
  /** Tin mới lưu vào máy (tin đã có không tính). */
  messagesSaved: number;
  /** Tin Facebook trả về trong khoảng đã chọn (kể cả tin đã có). */
  messagesReceived: number;
  /** Hội thoại mã hoá đầu cuối — Facebook không cho thiết bị mới đọc tin cũ. */
  skippedE2EE: number;
  failedThreads: number;
  startedAt: number;
  finishedAt?: number;
  /** Đang nghỉ (giới hạn tốc độ / cooldown) tới thời điểm này, ms. */
  pausedUntil?: number;
}

export const FB_HISTORY_SYNC_EVENT = 'event:fbHistorySync';

const ACTIVE: FbHistorySyncStage[] = ['listing', 'syncing'];

export function isFbHistorySyncActive(status?: Pick<FbHistorySyncStatus, 'stage'> | null): boolean {
  return !!status && ACTIVE.includes(status.stage);
}

/** Mốc thời gian lưu lẫn giây (thread list GraphQL) và mili giây (bridge / tin nhắn) → luôn mili giây. */
export function activityMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** Hội thoại có hoạt động trong khoảng (không biết thời điểm → vẫn đồng bộ, an toàn hơn bỏ sót). */
export function threadActiveInRange(lastActivity: unknown, range: FbHistoryRange): boolean {
  const ms = activityMs(lastActivity);
  if (!ms) return true;
  return range.fromTs == null || ms >= range.fromTs;
}

/** Tin nằm trong khoảng đã chọn (không biết thời điểm → true). */
export function messageInRange(timestampMs: unknown, range: FbHistoryRange): boolean {
  const ms = activityMs(timestampMs);
  if (!ms) return true;
  if (range.fromTs != null && ms < range.fromTs) return false;
  if (range.toTs != null && ms > range.toTs) return false;
  return true;
}

/**
 * Thử một lần tải tin trước khi mã hoá của chat 1-1 mã hoá (thử nghiệm 26.49.0, chỉ khi `probe` đúng là true). null = từ chối như cũ (E2EE, không gửi yêu cầu).
 * Mốc: tin mid.$… tìm được thì dùng; không thì chỉ theo thời gian (mốc của người gọi, rồi tin cũ nhất trong máy, rồi 0 = "bây giờ").
 */
export function planE2eeProbe(input: {
  probe?: boolean; mode?: 'interactive' | 'background'; isGroup: boolean; probedEmpty: boolean;
  resolved: FbHistoryAnchor | null; callerTimestampMs: number; oldestLocalMs: number;
}): { anchor: FbHistoryAnchor; kind: 'mid' | 'timestamp' | 'none' } | null {
  if (input.probe !== true || input.mode === 'background' || input.isGroup || input.probedEmpty) return null;
  if (input.resolved) return { anchor: input.resolved, kind: 'mid' };
  const timestampMs = activityMs(input.callerTimestampMs) || activityMs(input.oldestLocalMs);
  return { anchor: { timestampMs, messageId: '' }, kind: timestampMs > 0 ? 'timestamp' : 'none' };
}

/** Mã tin Messenger thường (`mid.$…`) — mốc hợp lệ cho FetchMessagesTask; mã E2EE (số) và tin tạm thì không. */
export function isLightSpeedMessageId(id: unknown): boolean {
  return /^mid\.\$./.test(String(id ?? ''));
}

/**
 * Sau một trang lịch sử: tải tiếp hay dừng. `count` = số tin trong trang (kể cả ngoài khoảng). Dừng khi hết tin,
 * trang rỗng, tin cũ nhất đã trước đầu khoảng, hoặc mốc không lùi (Facebook trả lại đúng trang cũ).
 * Mốc được phép đi tới (trang mới hơn mốc): khoảng kết thúc trong quá khứ bắt đầu từ mốc `toTs`, trang đầu luôn mới
 * hơn và phải lùi tiếp. Chống lặp ngoài "cùng mốc thời gian và cùng mã tin" là việc của nơi gọi.
 */
export function nextHistoryAnchor(
  page: { count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string },
  previous: FbHistoryAnchor,
  range: FbHistoryRange,
): FbHistoryAnchor | null {
  if (!page.hasMoreBefore || page.count <= 0) return null;
  const minTs = activityMs(page.minTimestampMs);
  if (!minTs) return null;
  if (range.fromTs != null && minTs < range.fromTs) return null;
  const messageId = String(page.minMessageId || '');
  if (previous.timestampMs > 0 && minTs >= previous.timestampMs && messageId === previous.messageId) return null;
  return { timestampMs: minTs, messageId };
}

export function emptyFbHistorySyncStatus(accountId: string, range: FbHistoryRange = { fromTs: null, toTs: null }): FbHistorySyncStatus {
  return {
    accountId, stage: 'idle', range, message: '',
    threadsTotal: 0, threadsDone: 0, messagesSaved: 0, messagesReceived: 0, skippedE2EE: 0, failedThreads: 0, startedAt: 0,
  };
}
