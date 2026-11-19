// Nhập lịch sử hội thoại mã hoá từ bản sao lưu đoạn chat chính thức của Facebook. Chỉ đọc tệp trên máy, không gọi mạng, không ghi nhật ký.
import * as path from 'path';
import type DatabaseService from '../../database/DatabaseService';
import FileStorageService from '../../file/FileStorageService';
import { openExportArchive, type ExportArchive } from './exportArchive';
import {
  buildLocalIndex, createSenderResolver, findPresentMessages, identifySelf, matchChatToThread, resolveThreadConflicts, stableMessageIds, PAIR_WINDOW_MS,
  type LocalMessageRow, type ThreadMatch,
} from './exportMatcher';
import { importedSenderId } from './importedMessage';
import type { ExportChat } from './exportParser';

export interface ExportImportSummary {
  chatsInFile: number; chatsMatched: number; chatsUnmatched: number; messagesInFile: number; imported: number; alreadyPresent: number;
  withoutSenderId: number; mediaImported: number; mediaSkipped: number; malformedSkipped: number;
}

export interface ExportImporterDeps {
  db: DatabaseService;
  /** Id nội bộ của tài khoản (fb_accounts.id). */
  accountId: string;
  /** Lưu tệp, trả đường dẫn tương đối như media Facebook trực tiếp. Mặc định dùng FileStorageService. */
  saveMedia?: (ownerFacebookId: string, data: Buffer, fileName: string) => Promise<string>;
}

type MediaKind = 'image' | 'video' | 'audio' | 'file';
const EXTENSION_KINDS: Record<string, MediaKind> = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.mp4': 'video', '.mov': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.ogg': 'audio', '.wav': 'audio',
};
const extensionOf = (uri: string) => path.extname(uri).toLowerCase();
const YIELD_EVERY = 500;
const BATCH_SIZE = 500;
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

const defaultSaveMedia = async (ownerId: string, data: Buffer, fileName: string) =>
  FileStorageService.toRelativePath(await FileStorageService.saveBuffer(ownerId, data, fileName));

const LOCAL_COLUMNS = 'id, thread_id, sender_id, sender_name, body, timestamp, is_self, is_unsent, type';

interface PendingRow {
  id: string; threadId: string; senderId: string; senderName: string; body: string | null; timestamp: number; type: string;
  attachments: string; isSelf: number; isUnsent: number; localPaths: Record<string, string>; reactions: Record<string, string>;
}

export class FacebookE2eeExportImporter {
  private readonly saveMedia: NonNullable<ExportImporterDeps['saveMedia']>;
  private mediaCache = new Map<string, { type: MediaKind; name: string; localPath: string } | null>();
  constructor(private readonly deps: ExportImporterDeps) { this.saveMedia = deps.saveMedia ?? defaultSaveMedia; }

  async importFile(zipPath: string): Promise<ExportImportSummary> {
    const { db, accountId } = this.deps;
    const account = db.getFBAccount(accountId);
    if (!account?.facebook_id) throw new Error('ACCOUNT_NOT_FOUND');
    this.mediaCache = new Map();
    const archive = await openExportArchive(zipPath);
    try {
      const chats = archive.chats;
      const summary: ExportImportSummary = {
        chatsInFile: chats.length, chatsMatched: 0, chatsUnmatched: 0, imported: 0, alreadyPresent: 0, withoutSenderId: 0, mediaImported: 0, mediaSkipped: 0,
        messagesInFile: chats.reduce((n, c) => n + c.messages.length, 0), malformedSkipped: chats.reduce((n, c) => n + c.malformedSkipped, 0),
      };
      const stamps = chats.flatMap(c => c.messages.map(m => m.timestamp));
      if (!stamps.length) return summary;
      // Vòng lặp thay vì Math.min(...stamps): tối đa 500 000 phần tử.
      let from = Infinity, to = -Infinity;
      for (const t of stamps) { if (t < from) from = t; if (t > to) to = t; }
      const local = db.query<LocalMessageRow>(
        `SELECT ${LOCAL_COLUMNS} FROM fb_messages WHERE account_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp`,
        [accountId, from - PAIR_WINDOW_MS, to + PAIR_WINDOW_MS]);

      const index = buildLocalIndex(local); // chuẩn hoá chữ cục bộ một lần cho mọi hội thoại trong tệp
      const matched: Array<ThreadMatch | null> = [];
      for (const c of chats) { matched.push(matchChatToThread(c, index)); await nextTurn(); }
      const matches = resolveThreadConflicts(matched);
      for (let i = 0; i < chats.length; i++) {
        const match = matches[i];
        if (!match) { summary.chatsUnmatched++; continue; }
        summary.chatsMatched++;
        await this.importChat(archive, chats[i], match, account, summary);
      }
      return summary;
    } finally {
      await archive.close();
    }
  }

  private async importChat(archive: ExportArchive, chat: ExportChat, match: ThreadMatch, account: any, summary: ExportImportSummary): Promise<void> {
    const { db, accountId } = this.deps;
    const ownerId = String(account.facebook_id);
    const threadId = match.threadId;
    const threadRows = db.query<LocalMessageRow>(`SELECT ${LOCAL_COLUMNS} FROM fb_messages WHERE account_id = ? AND thread_id = ?`, [accountId, threadId]);
    const threadType = db.queryOne<{ type: string }>('SELECT type FROM fb_threads WHERE id = ? AND account_id = ?', [threadId, accountId])?.type;
    const isGroup = threadType === 'group' || chat.participants.length > 2;

    const selfName = identifySelf({ chat, pairs: match.pairs, isGroup, accountName: account.name || '' });
    const resolver = createSenderResolver({ chat, pairs: match.pairs, threadRows, threadId, isGroup, selfName, ownerId });
    const present = findPresentMessages(chat, threadRows, selfName);
    const ids = stableMessageIds(accountId, threadId, chat.messages);
    const mediaCache = this.mediaCache;

    // Giai đoạn 1 (bất đồng bộ): chọn tin mới, ghi tệp media. Giai đoạn 2 (đồng bộ, một giao dịch): ghi cơ sở dữ liệu.
    const pending: PendingRow[] = [];
    for (let i = 0; i < chat.messages.length; i++) {
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await new Promise(resolve => setImmediate(resolve));
      const m = chat.messages[i];
      if (present.has(i) || db.queryOne('SELECT 1 AS hit FROM fb_messages WHERE id = ?', [ids[i]])) { summary.alreadyPresent++; continue; }

      const attachments: Array<{ type: MediaKind; name: string; localPath: string }> = [];
      const localPaths: Record<string, string> = {};
      for (let k = 0; k < m.media.length; k++) {
        const uri = m.media[k];
        let saved = mediaCache.get(uri); // mỗi tệp trong ZIP chỉ đọc và ghi một lần cho cả lượt nhập
        if (saved === undefined) {
          const data = await archive.readMedia(uri);
          saved = data ? await this.storeMedia(ownerId, data, ids[i], k, uri) : null;
          mediaCache.set(uri, saved);
        }
        if (!saved) { summary.mediaSkipped++; continue; }
        attachments.push({ type: saved.type, name: saved.name, localPath: saved.localPath });
        localPaths[k === 0 ? 'main' : `att_${k}`] = saved.localPath;
        summary.mediaImported++;
      }
      // main luôn trỏ tệp đầu tiên đã lưu được (kể cả khi tệp 0 bị bỏ qua).
      if (attachments.length && !localPaths.main) localPaths.main = attachments[0].localPath;

      const isSelf = resolver.isSelf(m.senderName);
      const realId = resolver.senderIdFor(m.senderName);
      // Người gửi không gắn được mã Facebook: mã riêng chứa tên, để khung chat hiện tên và không lẫn với người khác.
      const senderId = realId || importedSenderId(m.senderName);
      if (!isSelf && !realId) summary.withoutSenderId++;
      const reactions: Record<string, string> = {};
      for (const r of m.reactions) {
        const actorId = resolver.senderIdFor(r.actor);
        if (actorId) reactions[actorId] = r.reaction;
      }
      pending.push({
        id: ids[i], threadId, senderId, senderName: m.senderName, body: m.text || null, timestamp: m.timestamp,
        type: attachments[0]?.type ?? 'text', attachments: JSON.stringify(attachments), isSelf: isSelf ? 1 : 0, isUnsent: m.isUnsent ? 1 : 0,
        localPaths, reactions,
      });
    }

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      if (start > 0) await nextTurn();
      db.transaction(() => { for (const r of pending.slice(start, start + BATCH_SIZE)) this.writeRow(r, ownerId, summary); });
    }
  }

  private writeRow(r: PendingRow, ownerId: string, summary: ExportImportSummary): void {
    const { db, accountId } = this.deps;
    // Như bộ tải lịch sử: is_history không đụng chưa đọc, tin cuối, thông báo.
    const outcome = db.saveFBMessage({
      id: r.id, account_id: accountId, thread_id: r.threadId, sender_id: r.senderId, sender_name: r.senderName, body: r.body || undefined,
      timestamp: r.timestamp, type: r.type, attachments: r.attachments, is_self: r.isSelf, is_unsent: r.isUnsent, is_history: true,
    });
    if (outcome !== 'new') { summary.alreadyPresent++; return; }
    summary.imported++;
    if (Object.keys(r.localPaths).length) db.updateLocalPaths(ownerId, r.id, r.localPaths);
    if (Object.keys(r.reactions).length) db.updateFBMessageReaction(r.id, JSON.stringify(r.reactions));
    if (r.isUnsent) db.updateFBMessageUnsent(r.id);
  }

  /** Tên tệp tự sinh; đuôi chỉ giữ khi thuộc danh sách ảnh/video/âm thanh đã biết, còn lại `.bin` và loại `file`. */
  private async storeMedia(ownerId: string, data: Buffer, messageId: string, k: number, uri: string): Promise<{ type: MediaKind; name: string; localPath: string }> {
    const ext = extensionOf(uri);
    const known = Object.prototype.hasOwnProperty.call(EXTENSION_KINDS, ext);
    const name = `e2ee_${messageId.slice(-12)}_${k}${known ? ext : '.bin'}`;
    return { type: known ? EXTENSION_KINDS[ext] : 'file', name, localPath: await this.saveMedia(ownerId, data, name) };
  }
}
