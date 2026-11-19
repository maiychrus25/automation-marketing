// Phân tích một tệp JSON hội thoại của bản sao lưu đoạn chat Facebook. Thuần, không I/O; mọi trường đều là dữ liệu không tin cậy.
export interface ExportReaction { actor: string; reaction: string }
export interface ExportMessage {
  senderName: string; text: string; timestamp: number; isUnsent: boolean; media: string[]; reactions: ExportReaction[];
}
export interface ExportChat { threadName: string; participants: string[]; messages: ExportMessage[]; malformedSkipped: number }

const MIN_TIMESTAMP_MS = Date.UTC(2004, 0, 1);
const DAY_MS = 86_400_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseMessage(raw: unknown): ExportMessage | null {
  if (!isObject(raw)) return null;
  const { senderName, text, timestamp, isUnsent, media, reactions } = raw;
  if (typeof senderName !== 'string' || !Number.isInteger(timestamp) || (timestamp as number) < MIN_TIMESTAMP_MS || (timestamp as number) > Date.now() + DAY_MS) return null;
  const mediaUris = Array.isArray(media)
    ? media.map(m => (isObject(m) ? m.uri : undefined)).filter((u): u is string => typeof u === 'string' && u.length > 0) : [];
  const message: ExportMessage = {
    senderName, text: typeof text === 'string' ? text : '', timestamp: timestamp as number, isUnsent: isUnsent === true, media: mediaUris,
    reactions: Array.isArray(reactions)
      ? reactions.filter((r): r is { actor: string; reaction: string } => isObject(r) && typeof r.actor === 'string' && typeof r.reaction === 'string')
        .map(r => ({ actor: r.actor, reaction: r.reaction }))
      : [],
  };
  // Tin không chữ, không tệp, không thu hồi thì không có gì để nhập.
  return message.text || message.media.length || message.isUnsent ? message : null;
}

/** null = tệp không đúng dạng (không phải đối tượng có mảng `messages`). */
export function parseExportChat(jsonText: string): ExportChat | null {
  let root: unknown;
  try { root = JSON.parse(jsonText); } catch { return null; }
  if (!isObject(root) || !Array.isArray(root.messages)) return null;
  const messages: ExportMessage[] = [];
  let malformedSkipped = 0;
  for (const raw of root.messages) {
    const m = parseMessage(raw);
    if (m) messages.push(m); else malformedSkipped++;
  }
  messages.sort((a, b) => a.timestamp - b.timestamp); // thứ tự trong tệp không được đảm bảo
  return {
    threadName: typeof root.threadName === 'string' ? root.threadName : '',
    participants: Array.isArray(root.participants) ? root.participants.filter((p): p is string => typeof p === 'string') : [],
    messages, malformedSkipped,
  };
}
