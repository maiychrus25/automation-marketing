// Hàm thuần cho việc tải lịch sử Facebook khi mở hội thoại / kéo lên (không phụ thuộc React/IPC).
import type { FbHistoryPageResult } from '../../../services/facebook/facebookHistory';
import { isFacebook } from '../channelHelper';

export const FB_E2EE_HISTORY_NOTE = 'Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ';

// isPage: tài khoản Page (bản ghi tài khoản có parent_zalo_id). Hội thoại trống của Page không có tin làm mốc nên không tự
// tải khi mở; kéo lên tải tin cũ thì Page làm được như tài khoản cá nhân (từ 26.44.0).
export function shouldFetchFbHistoryOnOpen(input: { channel?: string; isEmployee: boolean; isPage?: boolean; localCount: number; alreadyTried: boolean }): boolean {
  return isFacebook(input.channel) && !input.isEmployee && !input.isPage && input.localCount === 0 && !input.alreadyTried;
}

// Nhân viên chỉ tải tin cũ cho Page được giao (boss xử lý fb:fetchOlderMessages); Facebook cá nhân không bao giờ tới máy nhân viên.
export function shouldFetchFbOlder(input: { channel?: string; isEmployee: boolean; isPage?: boolean }): boolean {
  return isFacebook(input.channel) && (!input.isEmployee || !!input.isPage);
}

/** Chỉ máy chủ tài khoản Facebook cá nhân hỏi được máy xem hội thoại có mã hoá không (chỉ đọc DB cục bộ). */
export function shouldCheckFbEncryption(input: { channel?: string; isEmployee: boolean; isPage: boolean }): boolean {
  return isFacebook(input.channel) && !input.isEmployee && !input.isPage;
}

/** Tin thật (không phải temp_…) có thời điểm nhỏ nhất. */
export function fbOlderAnchor(messages: Array<{ msg_id: string; timestamp?: number }>): { beforeTimestampMs: number; beforeMessageId: string } | null {
  let best: { beforeTimestampMs: number; beforeMessageId: string } | null = null;
  for (const m of messages) {
    const ts = m.timestamp || 0;
    if (m.msg_id.startsWith('temp_') || ts <= 0) continue;
    if (!best || ts < best.beforeTimestampMs) best = { beforeTimestampMs: ts, beforeMessageId: m.msg_id };
  }
  return best;
}

export type FbOlderOutcome = { kind: 'loaded'; hasMore: boolean } | { kind: 'stop'; note?: string; warn?: string } | { kind: 'later' } | { kind: 'retry' };

export function interpretFbOlderResult(res: FbHistoryPageResult | null | undefined): FbOlderOutcome {
  if (!res) return { kind: 'retry' };
  if (res.success === true) return { kind: 'loaded', hasMore: res.hasMoreBefore && res.stored > 0 };
  if (res.code === 'E2EE') return { kind: 'stop', note: FB_E2EE_HISTORY_NOTE };
  if (res.code === 'RISK') return { kind: 'stop', warn: res.error };
  if (res.code === 'FETCH') return { kind: 'retry' };
  if (res.code === 'BRIDGE_OLD') return { kind: 'stop' };
  return { kind: 'later' }; // NOT_CONNECTED | BRIDGE_DOWN | BUSY | COOLDOWN | CANCELLED: tạm thời, thử lại lần sau
}

/** Hàng tin từ DataAccessor.getMessages: boss trả `messages`, nhân viên (REST) trả `items`. */
export function rowsFromGetMessages(res: any): any[] {
  const rows = res?.messages ?? res?.items;
  return Array.isArray(rows) ? rows : [];
}

export function fbHistoryTriedKey(accountId: string, threadId: string): string {
  return `${accountId}::${threadId}`;
}

export const FB_E2EE_PROBE_BUTTON = 'Thử tải tin từ trước khi mã hoá';
export const FB_E2EE_PROBE_BUTTON_BUSY = 'Đang thử…';
// Trung tính: cũng hiện khi Facebook không trả lời kịp, hoặc khi MaiHub không gửi yêu cầu (nhóm, hội thoại đã thử).
export const FB_E2EE_PROBE_EMPTY_NOTE = 'Không tải được tin nào từ trước khi mã hoá.';
export const FB_E2EE_PROBE_LATER = 'Chưa thử được lúc này, hãy thử lại sau.';
export const FB_E2EE_PROBE_FAILED = 'Không tải được, hãy thử lại sau.';

/** Nút thử chỉ hiện cạnh dòng "mã hoá đầu cuối" trên máy chủ tài khoản cá nhân, và chỉ khi chat chưa được thử xong. */
export function shouldShowFbProbeButton(input: { note: string | null; isEmployee: boolean; isPage: boolean; probeClosed: boolean }): boolean {
  return input.note === FB_E2EE_HISTORY_NOTE && !input.isEmployee && !input.isPage && !input.probeClosed;
}

export type FbProbeOutcome =
  | { kind: 'loaded'; hasMore: boolean }
  | { kind: 'empty'; note: string }
  | { kind: 'warn'; text: string }
  | { kind: 'later'; notify: string }
  | { kind: 'failed'; notify: string };

/** Kết quả của nút thử → việc giao diện làm. empty/failed đóng nút cho tới khi đổi hội thoại; warn/later giữ nút. */
export function interpretFbProbeResult(res: FbHistoryPageResult | null | undefined): FbProbeOutcome {
  const base = interpretFbOlderResult(res);
  if (base.kind === 'loaded') return base;
  if (base.kind === 'later') return { kind: 'later', notify: FB_E2EE_PROBE_LATER };
  if (base.kind === 'stop' && base.warn) return { kind: 'warn', text: base.warn };
  if (base.kind === 'stop' && base.note) return { kind: 'empty', note: FB_E2EE_PROBE_EMPTY_NOTE };
  return { kind: 'failed', notify: FB_E2EE_PROBE_FAILED };
}

/** Các kết quả đóng nút trong hội thoại này (fetcher đã đánh dấu hội thoại). */
export function closesFbProbe(outcome: FbProbeOutcome): boolean {
  return outcome.kind === 'empty' || outcome.kind === 'failed';
}
