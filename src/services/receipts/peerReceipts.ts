/**
 * Mốc "người kia đã nhận / đã xem" tin MÌNH gửi, theo hội thoại (Zalo, Facebook).
 *
 * Nền tảng báo kiểu "tới đây": đã nhận / đã xem đến tin X. Lưu mốc trong contacts (peer_delivered_ts, peer_read_ts —
 * epoch ms), chỉ tiến lên, đã xem kéo theo đã nhận, rồi phát event:receipt để khung chat đổi dấu. Nhóm: một người
 * đã xem là tính đã xem.
 */
import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

export interface PeerReceiptUpdate { deliveredTs?: number; readTs?: number }
export interface PeerReceiptState { deliveredTs: number; readTs: number }

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Ghi mốc (chỉ tiến lên). Có đổi → phát event:receipt một lần và trả trạng thái mới; không đổi / chưa có hội thoại → null. */
export function recordPeerReceipt(
  ownerId: string, threadId: string, update: PeerReceiptUpdate,
  emit: (channel: string, data: any) => void = (c, d) => EventBroadcaster.emit(c, d),
): PeerReceiptState | null {
  if (!ownerId || !threadId) return null;
  const readTs = num(update?.readTs);
  const deliveredTs = Math.max(num(update?.deliveredTs), readTs);
  if (!deliveredTs) return null;

  const db = DatabaseService.getInstance();
  const row = db.queryOne<{ peer_delivered_ts: number | null; peer_read_ts: number | null }>(
    `SELECT peer_delivered_ts, peer_read_ts FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [ownerId, threadId],
  );
  if (!row) return null; // không tạo hội thoại mới chỉ vì một biên nhận
  const current = { deliveredTs: num(row.peer_delivered_ts), readTs: num(row.peer_read_ts) };
  const next: PeerReceiptState = {
    deliveredTs: Math.max(current.deliveredTs, deliveredTs),
    readTs: Math.max(current.readTs, readTs),
  };
  if (next.deliveredTs === current.deliveredTs && next.readTs === current.readTs) return null;
  db.run(
    `UPDATE contacts SET peer_delivered_ts = ?, peer_read_ts = ? WHERE owner_zalo_id = ? AND contact_id = ?`,
    [next.deliveredTs, next.readTs, ownerId, threadId],
  );
  emit('event:receipt', { zaloId: ownerId, threadId, ...next });
  return next;
}

/**
 * Thời điểm (ms) mới nhất của các tin có id trong danh sách ở hội thoại này; không thấy → 0.
 * Tra msg_id bằng khóa duy nhất (msg_id, owner, channel, thread); không thấy mới thử cli_msg_id (idx_messages_cli,
 * cần `cli_msg_id IS NOT NULL` để SQLite dùng chỉ mục từng phần).
 */
export function messageTimestampById(
  ownerId: string,
  threadId: string,
  msgIds: Array<string | number | null | undefined>,
  channel: 'zalo' | 'facebook',
): number {
  const thread = String(threadId ?? '');
  const ids = [...new Set(msgIds.map((id) => String(id ?? '').trim()).filter((id) => id && id !== '0'))].slice(0, 50);
  if (!ownerId || !thread || !ids.length) return 0;
  const db = DatabaseService.getInstance();
  const byId = db.queryOne<{ ts: number | null }>(
    `SELECT MAX(timestamp) AS ts FROM messages
     WHERE owner_zalo_id = ? AND msg_id IN (${ids.map(() => '?').join(', ')}) AND channel = ? AND thread_id = ?`,
    [ownerId, ...ids, channel, thread],
  );
  const ts = num(byId?.ts);
  if (ts) return ts;
  let latest = 0;
  for (const id of ids) {
    const byCli = db.queryOne<{ timestamp: number | null }>(
      `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND cli_msg_id IS NOT NULL AND channel = ? AND thread_id = ? LIMIT 1`,
      [ownerId, id, channel, thread],
    );
    latest = Math.max(latest, num(byCli?.timestamp));
  }
  return latest;
}

/**
 * Zalo (zca-js 2.x): `seen_messages` / `delivered_messages` là MẢNG. Mỗi phần tử { threadId, isSelf, data } —
 * seen: data.{msgId, realMsgId, seenUids}; delivered: data.{msgId, realMsgId, seen, deliveredUids, mSTs}.
 * Phần tử hỏng bị bỏ qua riêng; sự kiện của chính mình (máy khác) bỏ qua. `seen_messages` vẫn báo renderer qua event:seen.
 */
export function handleZaloReceiptEvents(zaloId: string, items: unknown, kind: 'read' | 'delivered'): void {
  if (!Array.isArray(items)) return;
  // Tin Zalo nằm ở DB boss (workspace mặc định): ghi mốc ở đó, và không đẩy event:receipt của boss vào workspace khác đang mở
  EventBroadcaster.runOnBossDb(() => applyZaloReceiptItems(zaloId, items, kind));
}

function applyZaloReceiptItems(zaloId: string, items: unknown[], kind: 'read' | 'delivered'): void {
  for (const item of items) {
    try {
      const event: any = item;
      if (!event || event.isSelf) continue;
      const threadId = String(event.threadId || event.data?.groupId || '');
      const data = event.data || {};
      if (!threadId) continue;
      if (kind === 'read') EventBroadcaster.broadcastSeen(zaloId, event);
      let ts = messageTimestampById(zaloId, threadId, [data.msgId, data.realMsgId], 'zalo');
      // Tin chưa có trong máy: dùng thời điểm tin do Zalo gửi kèm (ms)
      if (!ts && kind === 'delivered' && num(data.mSTs) > 1e12) ts = num(data.mSTs);
      const seen = kind === 'read' || Number(data.seen) === 1 || (Array.isArray(data.seenUids) && data.seenUids.length > 0);
      if (!ts) {
        Logger.log(`[ZaloReceipt] ${kind} chưa khớp tin account=${zaloId} thread=${threadId} msgId=${data.msgId ?? '-'}`);
        continue;
      }
      recordPeerReceipt(zaloId, threadId, seen ? { readTs: ts } : { deliveredTs: ts }, (c, d) => EventBroadcaster.emitAware(c, d));
    } catch (err: any) {
      Logger.warn(`[ZaloReceipt] bỏ qua phần tử lỗi: ${err?.message}`);
    }
  }
}

/**
 * Facebook MQTT: deliveryReceipt { messageId, threadId, actorFbId, timestampMs } / readReceipt { threadId, actorFbId,
 * watermarkTimestampMs }, đều epoch ms (có thể là chuỗi). Biên nhận do chính tài khoản (máy khác) phát thì bỏ qua.
 */
export function recordFacebookReceipt(
  ownerId: string,
  selfFbId: string,
  data: { threadId?: string; actorFbId?: string; messageId?: string; timestampMs?: unknown; watermarkTimestampMs?: unknown },
  kind: 'read' | 'delivered',
): PeerReceiptState | null {
  if (!ownerId || !data?.threadId || !data.actorFbId || String(data.actorFbId) === String(selfFbId)) return null;
  const threadId = String(data.threadId);
  if (kind === 'read') return recordPeerReceipt(ownerId, threadId, { readTs: num(data.watermarkTimestampMs) });
  const ts = num(data.timestampMs) || messageTimestampById(ownerId, threadId, [data.messageId], 'facebook');
  return recordPeerReceipt(ownerId, threadId, { deliveredTs: ts });
}
