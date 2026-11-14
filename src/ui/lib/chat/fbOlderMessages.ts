// Hàm thuần cho việc tải lịch sử Facebook khi mở hội thoại / kéo lên (không phụ thuộc React/IPC).
import type { FbHistoryPageResult } from '../../../services/facebook/facebookHistory';
import { isFacebook } from '../channelHelper';

export const FB_E2EE_HISTORY_NOTE = 'Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ';

// isPage: tài khoản Page (bản ghi tài khoản có parent_zalo_id) chưa hỗ trợ tải lịch sử.
export function shouldFetchFbHistoryOnOpen(input: { channel?: string; isEmployee: boolean; isPage?: boolean; localCount: number; alreadyTried: boolean }): boolean {
  return isFacebook(input.channel) && !input.isEmployee && !input.isPage && input.localCount === 0 && !input.alreadyTried;
}

export function shouldFetchFbOlder(input: { channel?: string; isEmployee: boolean; isPage?: boolean }): boolean {
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
