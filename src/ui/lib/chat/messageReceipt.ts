// Nhãn "Đã nhận"/"Đã xem" dưới tin cuối của mình. Thuần hàm: không import store/IPC.
export type ReceiptStatus = 'delivered' | 'read';

interface ReceiptMessage {
  is_sent?: number | boolean | null;
  timestamp?: number | string | null;
  msg_id?: string | number;
  send_status?: string | null;
  msg_type?: string | null;
  status?: string | null;
  is_recalled?: number | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const SENDING = new Set(['pending', 'sending', 'failed', 'timeout']);

export function lastOutgoingReceipt(
  messages: ReadonlyArray<ReceiptMessage> | null | undefined,
  receipt: { deliveredTs?: number | null; readTs?: number | null } | null | undefined,
  channel: string | null | undefined,
): ReceiptStatus | null {
  if (!messages?.length || !receipt) return null;
  if (channel && channel !== 'zalo' && channel !== 'facebook') return null;
  // Danh sách xếp cũ → mới; bỏ qua dòng hệ thống/thu hồi ở cuối.
  let last: ReceiptMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.is_recalled === 1 || m.status === 'recalled' || m.msg_type === 'recalled' || m.msg_type === 'system') continue;
    last = m;
    break;
  }
  if (!last || !last.is_sent) return null;
  if (SENDING.has(String(last.send_status || '')) || String(last.msg_id ?? '').startsWith('temp_')) return null;
  const ts = num(last.timestamp);
  if (!ts) return null;
  if (ts <= num(receipt.readTs)) return 'read';
  if (ts <= num(receipt.deliveredTs)) return 'delivered';
  return null;
}

export function receiptLabel(status: ReceiptStatus): 'Đã nhận' | 'Đã xem' {
  return status === 'read' ? 'Đã xem' : 'Đã nhận';
}

/** Mốc không bao giờ lùi; null = không đổi. */
export function mergeReceiptMarks(
  current: { peer_delivered_ts?: number | null; peer_read_ts?: number | null } | null | undefined,
  incoming: { deliveredTs?: number | null; readTs?: number | null } | null | undefined,
): { peer_delivered_ts: number; peer_read_ts: number } | null {
  const d0 = num(current?.peer_delivered_ts), r0 = num(current?.peer_read_ts);
  const d = Math.max(d0, num(incoming?.deliveredTs)), r = Math.max(r0, num(incoming?.readTs));
  return d === d0 && r === r0 ? null : { peer_delivered_ts: d, peer_read_ts: r };
}

/** Mốc đã lưu quyết định CÓ hiện hay không; seenInfo (không bao giờ bị xóa) chỉ quyết định cách vẽ 'read'. */
export function receiptDisplay(status: ReceiptStatus | null, hasSeenUids: boolean): 'avatars' | 'label' | 'none' {
  if (!status) return 'none';
  return status === 'read' && hasSeenUids ? 'avatars' : 'label';
}
