/**
 * Đổi các lời gọi thủ tục lightspeed của hộp thư Page thành dữ liệu có kiểu: tin (đã ghép đính kèm), hội thoại,
 * người liên hệ, cảm xúc, đã xem, khoảng tin cũ, con trỏ đồng bộ. Hàm thuần, không ghi log, không chạm mạng hay DB.
 * Số thứ tự trường của từng thủ tục: xem docs/plans/2026-11-16-facebook-page-inbox-direct.md.
 * Tin (`InboxMessage`) cùng tên trường với Message JSON của cầu nối Go để FacebookService xử lý chung một đường.
 */
import { LsCall, LsValue } from './lightspeedDecoder';

export const PAGE_MAILBOX_DB = 205;

export interface InboxAttachment {
  type: string; url: string | null; fileName?: string; mimeType?: string; fileSize?: number; width?: number; height?: number; duration?: number;
}
export interface InboxMessage {
  id: string; threadId: string; senderId: string; text: string; timestampMs: number; attachments: InboxAttachment[];
  replyTo?: { messageId: string; senderId?: string; text?: string };
  isHistory: boolean; isAdminMsg: boolean; isUnsent: boolean;
}
export interface InboxThread { id: string; name: string; pictureUrl: string; snippet: string; lastActivityMs: number; unreadCount: number }
export interface InboxContact { id: string; name: string; pictureUrl: string }
export interface InboxRange {
  threadId: string; hasMoreBefore: boolean; minTimestampMs: number; minMessageId: string;
  /** Chỉ có ở dấu "hết tin cũ" (`updateExistingMessageRange`): mốc thời gian của yêu cầu mà nó trả lời (0 = không rõ). */
  endOfHistoryAt?: number;
}
export interface InboxBatch {
  cursor: string | null; syncStatus: string | null;
  messages: InboxMessage[]; threads: InboxThread[]; contacts: InboxContact[]; ranges: InboxRange[];
  reactions: Array<{ threadId: string; messageId: string; actorId: string; emoji: string }>; // emoji '' = gỡ cảm xúc
  readReceipts: Array<{ threadId: string; contactId: string; watermarkMs: number }>;
  typing: Array<{ threadId: string; senderId: string; isTyping: boolean }>;
  calls: Record<string, number>;
}

const str = (v: LsValue | undefined): string => (v === null || v === undefined ? '' : String(v));
const num = (v: LsValue | undefined): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const id64 = (v: LsValue | undefined): string => { const s = str(v); return /^\d+$/.test(s) ? s : ''; };
const positive = <K extends string>(key: K, value: number) => (value > 0 ? { [key]: value } as Record<K, number> : {});

const MESSAGE_CALLS = new Set(['insertMessage', 'upsertMessage', 'deleteThenInsertMessage']);
const CONTACT_CALLS = new Set(['verifyContactRowExists', 'deleteThenInsertContact']);

// attachmentType của Messenger: 2/8 ảnh, 3 ảnh động, 4/9 video, 5 ghi âm, 12 tin thoại, 6 và còn lại là tệp.
function blobAttachment(a: LsValue[]): InboxAttachment {
  const playable = str(a[3]);
  const preview = str(a[8]);
  const code = num(a[29]);
  const size = { ...positive('width', num(a[14])), ...positive('height', num(a[15])) };
  const duration = positive('duration', Math.floor(num(a[22]) / 1000));
  const base = {
    ...(str(a[0]) ? { fileName: str(a[0]) } : {}), ...(str(a[30]) ? { mimeType: str(a[30]) } : {}), ...positive('fileSize', num(a[1])),
  };
  if (code === 2 || code === 8) return { type: 'image', url: preview || null, ...base, ...size };
  if (code === 3) return { type: 'gif', url: playable || preview || null, ...base, ...size };
  if (code === 4 || code === 9) return { type: 'video', url: playable || null, ...base, ...size, ...duration };
  if (code === 5 || code === 12) return { type: 'audio', url: playable || null, ...base, ...duration };
  return { type: 'file', url: playable || preview || null, ...base };
}

export function readInboxBatch(calls: LsCall[], database: number = PAGE_MAILBOX_DB): InboxBatch {
  const batch: InboxBatch = {
    cursor: null, syncStatus: null, messages: [], threads: [], contacts: [], ranges: [], reactions: [], readReceipts: [], typing: [], calls: {},
  };
  const attachments = new Map<string, InboxAttachment[]>(); // theo mã tin, đúng thứ tự máy chủ gửi
  const seenBlobs = new Set<string>();
  const attach = (messageId: string, attachment: InboxAttachment) => {
    if (!messageId) return;
    const list = attachments.get(messageId) ?? [];
    list.push(attachment);
    attachments.set(messageId, list);
  };

  for (const { name, args: a } of calls) {
    batch.calls[name] = (batch.calls[name] || 0) + 1;
    if (MESSAGE_CALLS.has(name)) {
      const id = str(a[8]);
      const threadId = id64(a[3]);
      if (!id || !threadId) continue;
      const replyId = str(a[23]);
      batch.messages.push({
        id, threadId, senderId: str(a[10]), text: str(a[0]), timestampMs: num(a[5]), attachments: [],
        ...(replyId ? { replyTo: { messageId: replyId, ...(str(a[29]) ? { senderId: str(a[29]) } : {}), ...(str(a[27]) ? { text: str(a[27]) } : {}) } } : {}),
        isHistory: name !== 'insertMessage', isAdminMsg: a[12] === true, isUnsent: a[17] === true,
      });
    } else if (name === 'insertBlobAttachment') {
      const messageId = str(a[32]);
      const blobKey = `${messageId}|${str(a[34])}`;
      if (str(a[34]) && seenBlobs.has(blobKey)) continue; // Facebook đôi khi gửi lặp cùng một đính kèm
      seenBlobs.add(blobKey);
      attach(messageId, blobAttachment(a));
    } else if (name === 'insertStickerAttachment') {
      attach(str(a[18]), { type: 'sticker', url: str(a[4]) || null, ...positive('width', num(a[9])), ...positive('height', num(a[10])) });
    } else if (name === 'insertXmaAttachment') {
      if (str(a[57])) attach(str(a[30]), { type: 'link', url: str(a[57]), ...(str(a[58]) ? { fileName: str(a[58]) } : {}) });
    } else if (name === 'upsertReaction') {
      batch.reactions.push({ threadId: id64(a[0]), messageId: str(a[2]), actorId: str(a[3]), emoji: str(a[4]) });
    } else if (name === 'deleteReaction') {
      batch.reactions.push({ threadId: id64(a[0]), messageId: str(a[1]), actorId: str(a[2]), emoji: '' });
    } else if (name === 'updateReadReceipt') {
      batch.readReceipts.push({ threadId: id64(a[1]), contactId: str(a[2]), watermarkMs: num(a[0]) });
    } else if (name === 'updateTypingIndicator') {
      batch.typing.push({ threadId: id64(a[0]), senderId: str(a[1]), isTyping: a[2] === true });
    } else if (name === 'deleteThenInsertThread') {
      const id = id64(a[7]);
      if (id) batch.threads.push({ id, name: str(a[3]), pictureUrl: str(a[4]), snippet: str(a[2]), lastActivityMs: num(a[0]), unreadCount: num(a[89]) });
    } else if (CONTACT_CALLS.has(name)) {
      const id = id64(a[0]);
      if (id) batch.contacts.push({ id, name: str(a[3]), pictureUrl: str(a[2]) });
    } else if (name === 'insertNewMessageRange') {
      const threadId = id64(a[0]);
      if (threadId) batch.ranges.push({ threadId, hasMoreBefore: a[7] === true, minTimestampMs: num(a[5]), minMessageId: str(a[3]) });
    } else if (name === 'updateExistingMessageRange') {
      const threadId = id64(a[0]);
      if (threadId) batch.ranges.push({ threadId, hasMoreBefore: false, minTimestampMs: 0, minMessageId: '', endOfHistoryAt: num(a[1]) });
    } else if (name.startsWith('executeFirstBlockForSyncTransaction') && str(a[0]) === String(database)) {
      batch.cursor = str(a[3]) || null;
      batch.syncStatus = str(a[name.endsWith('V4') ? 5 : 4]) || null;
    }
  }

  for (const message of batch.messages) {
    message.attachments = attachments.get(message.id) ?? [];
    // Thẻ liên kết không kèm chữ: lấy địa chỉ làm nội dung, vì đường lưu tin cũ bỏ đính kèm loại liên kết.
    if (!message.text) message.text = message.attachments.find(a => a.type === 'link')?.url ?? '';
  }
  return batch;
}
