/**
 * Đã đọc ở máy khác (Zalo điện thoại / Zalo PC cùng tài khoản) → bỏ số chưa đọc của hội thoại.
 * Zalo đẩy cmd 504 (chat riêng) / 524 (nhóm) với `data.clearUnreads`; zca-js 2.1.2 bỏ qua frame này nên đọc thẳng
 * từ websocket của listener. Nguồn: port sát từ babyvibe/deplao-builder (MIT) `src/services/zalo/zaloReadElsewhere.ts`
 * tại commit 2162f07; phần giải mã frame được viết lại cho MaiHub. KHÔNG gửi "đã xem" ngược lên Zalo; KHÔNG log nội dung frame hay khoá.
 */
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import Logger from '../../utils/Logger';
import EventBroadcaster from '../event/EventBroadcaster';

export const CMD_CLEAR_UNREAD_USER = 504;
export const CMD_CLEAR_UNREAD_GROUP = 524;
/** Số tin mới nhất của hội thoại được xét khi đếm tin chưa đọc. */
export const ZALO_READ_SCOPE = 200;

export interface ZaloClearUnread {
  threadId: string;
  isGroup: boolean;
  /** Tin cuối đã đọc (msgId hoặc cliMsgId); rỗng = đã đọc hết */
  lastMsgId: string;
}

/** Giải mã `{ data, encrypt }` như decodeEventData của zca-js (0 thô, 1 nén, 2 AES-GCM + nén, 3 AES-GCM). */
export function decodeWsEventData(parsed: any, cipherKey: string | null | undefined): any {
  if (typeof parsed?.data !== 'string' || typeof parsed?.encrypt !== 'number') return null;
  const encrypt: number = parsed.encrypt;
  if (encrypt === 0) return JSON.parse(parsed.data);
  if (encrypt < 0 || encrypt > 3) return null;

  let buf = Buffer.from(encrypt === 1 ? parsed.data : decodeURIComponent(parsed.data), 'base64');
  if (encrypt !== 1) {
    if (!cipherKey || buf.length < 48) return null;
    const key = Buffer.from(cipherKey, 'base64');
    const body = buf.subarray(32);
    const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm` as any, key, buf.subarray(0, 16)) as crypto.DecipherGCM;
    decipher.setAAD(buf.subarray(16, 32));
    decipher.setAuthTag(body.subarray(body.length - 16));
    buf = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  }
  const text = (encrypt === 3 ? buf : zlib.unzipSync(buf)).toString('utf8');
  return text ? JSON.parse(text) : null;
}

/** Hội thoại đã đọc ở máy khác trong 1 frame websocket; frame khác → []. */
export function extractClearUnreads(frame: Buffer, cipherKey: string | null | undefined): ZaloClearUnread[] {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame[0] !== 1 || frame[3] !== 0) return [];
  const cmd = frame.readUInt16LE(1);
  if (cmd !== CMD_CLEAR_UNREAD_USER && cmd !== CMD_CLEAR_UNREAD_GROUP) return [];
  const text = frame.subarray(4).toString('utf8');
  if (!text.includes('"data"')) return [];
  const decoded = decodeWsEventData(JSON.parse(text), cipherKey);
  const list: unknown = decoded?.data?.clearUnreads ?? decoded?.clearUnreads;
  if (!Array.isArray(list)) return [];
  const items: ZaloClearUnread[] = [];
  for (const raw of list) {
    if (Number(raw?.type) !== 0) continue; // type 2 đi với idTo "-1", không phải hội thoại thật
    const threadId = String(raw?.idTo ?? '').trim();
    if (!/^\d+$/.test(threadId) || /^0+$/.test(threadId)) continue;
    items.push({
      threadId,
      isGroup: cmd === CMD_CLEAR_UNREAD_GROUP || Number(raw?.isGroup) === 1,
      lastMsgId: String(raw?.lastMsgId ?? '').trim(),
    });
  }
  return items;
}

/** Gắn handler vào websocket hiện tại của listener, gắn lại sau mỗi `connected` (zca-js tạo WebSocket mới). */
function attachClearUnreadListener(api: any, onItems: (items: ZaloClearUnread[]) => void): () => void {
  const listener = api?.listener;
  if (!listener || typeof listener.on !== 'function') return () => {};

  let boundWs: any = null;
  const onFrame = (data: any) => {
    if (!Buffer.isBuffer(data) || data.length < 4 || data[0] !== 1) return;
    const cmd = data.readUInt16LE(1);
    if (cmd !== CMD_CLEAR_UNREAD_USER && cmd !== CMD_CLEAR_UNREAD_GROUP) return;
    try {
      const items = extractClearUnreads(data, listener.cipherKey);
      if (items.length) onItems(items);
    } catch (err: any) {
      // Chỉ log loại lỗi: message của JSON.parse có thể chứa đoạn nội dung frame.
      Logger.warn(`[ZaloReadSync] Không đọc được frame đã đọc (cmd ${cmd}): ${err?.name || 'Error'}`);
    }
  };
  const bind = () => {
    const ws = listener.ws;
    if (!ws || ws === boundWs || typeof ws.on !== 'function') return;
    boundWs?.off?.('message', onFrame);
    boundWs = ws;
    ws.on('message', onFrame);
  };

  listener.on('connected', bind);
  bind();
  return () => {
    listener.off?.('connected', bind);
    boundWs?.off?.('message', onFrame);
    boundWs = null;
  };
}

const detachers = new Map<string, () => void>();

/** Mỗi instance zca-js mới của tài khoản: gỡ listener cũ, gắn listener mới. */
export function attachZaloReadElsewhere(zaloId: string, api: any, onItems: (items: ZaloClearUnread[]) => void): void {
  detachers.get(zaloId)?.();
  detachers.delete(zaloId);
  try {
    detachers.set(zaloId, attachClearUnreadListener(api, onItems));
  } catch (err: any) {
    Logger.warn(`[ZaloReadSync] ${zaloId}: không gắn được listener đã đọc: ${err?.name || 'Error'}`);
  }
}

export interface ZaloReadDb {
  queryOne<T>(sql: string, params?: any[]): T | undefined;
  run(sql: string, params?: any[]): void;
}

export interface ZaloReadResult {
  /** Số chưa đọc mới: chỉ có khi khác giá trị đang lưu. */
  unread?: number;
  /** Đã đọc hết nên tắt cờ @ của hội thoại. */
  mentionCleared: boolean;
}

/** Thời điểm tin đã đọc cuối (msg_id rồi cli_msg_id). 0 = không thấy. */
function lastReadTimestamp(db: ZaloReadDb, ownerId: string, threadId: string, msgId: string): number {
  const byId = db.queryOne<{ timestamp: number | null }>(
    `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND channel = 'zalo' AND CAST(thread_id AS TEXT) = ? LIMIT 1`,
    [ownerId, msgId, threadId],
  );
  if (Number(byId?.timestamp) > 0) return Number(byId!.timestamp);
  const byCli = db.queryOne<{ timestamp: number | null }>(
    `SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND CAST(thread_id AS TEXT) = ? LIMIT 1`,
    [ownerId, msgId, threadId],
  );
  return Number(byCli?.timestamp) > 0 ? Number(byCli!.timestamp) : 0;
}

/**
 * Chưa đọc mới = số tin NHẬN mới hơn tin đã đọc cuối trong ZALO_READ_SCOPE tin gần nhất; không thấy tin = đã đọc hết.
 * Không bao giờ tăng. Đọc hết → tin nhận thành 'read' (như DatabaseService.markAsRead) và tắt cờ @. Không đổi → không ghi.
 */
export function applyZaloClearUnread(db: ZaloReadDb, ownerId: string, item: ZaloClearUnread): ZaloReadResult {
  const result: ZaloReadResult = { mentionCleared: false };
  const contact = db.queryOne<{ unread_count: number | null; has_mention: number | null }>(
    `SELECT unread_count, has_mention FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
    [ownerId, item.threadId],
  );
  if (!contact) return result;

  let remaining = 0;
  const readTs = item.lastMsgId && item.lastMsgId !== '0' ? lastReadTimestamp(db, ownerId, item.threadId, item.lastMsgId) : 0;
  if (readTs) {
    const row = db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT is_sent, timestamp, msg_type FROM messages
         WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?
       ) WHERE is_sent = 0 AND timestamp > ? AND COALESCE(msg_type, '') NOT IN ('system', 'chat.undo', 'recalled')`,
      [ownerId, item.threadId, ZALO_READ_SCOPE, readTs],
    );
    remaining = Math.max(0, Number(row?.n || 0));
  }

  const current = Math.max(0, Number(contact.unread_count || 0));
  const unread = Math.min(current, remaining);
  const unreadChanged = unread !== current;
  const clearMention = unread === 0 && Number(contact.has_mention || 0) !== 0;
  if (unreadChanged || clearMention) {
    db.run(
      `UPDATE contacts SET unread_count = ?${clearMention ? ', has_mention = 0' : ''} WHERE owner_zalo_id = ? AND contact_id = ?`,
      [unread, ownerId, item.threadId],
    );
    if (unread === 0) {
      db.run(
        `UPDATE messages SET status = 'read'
         WHERE id IN (SELECT id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?)
           AND is_sent = 0 AND status != 'read'`,
        [ownerId, item.threadId, ZALO_READ_SCOPE],
      );
    }
    if (unreadChanged) result.unread = unread;
    result.mentionCleared = clearMention;
  }
  return result;
}

/** Áp từng mục "đã đọc ở máy khác" rồi báo UI; tin Zalo nằm ở DB boss nên đọc/ghi qua runOnBossDb. */
export function applyZaloReadElsewhere(zaloId: string, items: ZaloClearUnread[]): void {
  EventBroadcaster.runOnBossDb((db) => {
    for (const item of items) {
      const { unread } = applyZaloClearUnread(db, zaloId, item);
      // DB boss: workspace khác đang mở thì không đẩy số chưa đọc của boss vào renderer (như event:message)
      if (unread !== undefined) EventBroadcaster.emitAware('db:unreadChanged', { zaloId, contactId: item.threadId, unread, source: 'zalo_read_elsewhere' });
    }
  });
}
