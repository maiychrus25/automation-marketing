/**
 * Tải và lưu lịch sử tin nhắn Facebook: một trang mỗi lần (trang mới nhất qua GraphQL, trang cũ hơn qua Go bridge),
 * và lùi dần theo khoảng thời gian. Tin lưu với is_history nên không đổi chưa đọc / tin cuối của hội thoại.
 * Hành vi theo babyvibe/deplao-builder @2162f07 (MIT); nhịp gọi dùng FacebookHistoryLimiter (hằng số cố định).
 */
import DatabaseService from '../database/DatabaseService';
import { BridgeHistoryPage, BridgeNotReadyError } from './FacebookE2EEBridge';
import { FacebookHistoryLimiter, HISTORY_INTERACTIVE_MAX_WAIT_MS } from './FacebookHistoryLimiter';
import {
  FbHistorySource, FbHistoryAnchor, FbHistoryCode, FbHistoryPageResult, FbHistoryRange,
  activityMs, isLightSpeedMessageId, messageInRange, nextHistoryAnchor,
} from './facebookHistory';

export const HISTORY_GRAPHQL_PAGE = 20;
export const HISTORY_TOP_GAP_MS = 60_000;
/** Tin mới hơn mức này thuộc đường tin trực tiếp (MQTT/bridge): lưu như lịch sử sẽ làm mất chưa đọc/thông báo/workflow của tin đó. */
export const HISTORY_LIVE_WINDOW_MS = 5 * 60_000;
export const HISTORY_RISK_TEXT = 'Facebook có dấu hiệu hạn chế — đã tạm dừng tải tin cũ 30 phút để bảo vệ tài khoản';

const WAIT_SLICE_MS = 1_000;
const COLLISION_WAIT_MS = 5_000;
const COLLISION_MAX_RETRIES = 6;
const COLLISION_PATTERN = /history request already running/i;
const NOTIFY_WAIT_MS = 4_000;
const ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'sticker', 'gif', 'file']);
// Thẻ liên kết / vị trí của bridge đã nằm trong nội dung chữ, không lưu thành tệp đính kèm.
const SKIPPED_BRIDGE_ATTACHMENTS = new Set(['link', 'location']);

export interface FacebookHistoryDeps {
  accountId: string;                         // fb_accounts.id
  facebookId: () => string;                  // owner_zalo_id in the unified messages table
  bridge: () => { isAlive(): boolean; fetchMessages(p: { threadId: string; beforeTimestampMs: number; beforeMessageId: string }): Promise<BridgeHistoryPage> } | null;
  fetchGraphQLPage: (threadId: string, limit: number) => Promise<{ success: boolean; messages?: any[]; cursor?: { hasMore?: boolean }; error?: string }>;
  limiter: FacebookHistoryLimiter;
  sleep?: (ms: number) => Promise<void>;     // injectable for tests
  now?: () => number;                        // default Date.now
  /** Mọi truy cập DB chạy trên DB chính của chủ tài khoản, kể cả khi đang mở workspace khác. */
  runOnBossDb?: (fn: (db: DatabaseService) => void) => void;
}

export interface FetchPageOptions { mode?: 'interactive' | 'background'; shouldStop?: () => boolean; onWait?: (ms: number) => void; latestKnownMs?: number }

export interface HistorySyncOptions {
  shouldStop?: () => boolean;
  onPage?: (p: { saved: number; received: number }) => void;
  onWait?: (ms: number) => void;
  latestKnownMs?: number;
}

export interface HistorySyncResult { saved: number; received: number; pages: number; complete: boolean; error?: string; code?: FbHistoryCode }

interface HistoryRow {
  id: string; senderId: string; senderName?: string; body: string | null; timestampMs: number; type: string;
  attachments?: any[]; replyToId?: string; isUnsent?: boolean; reactions?: any[];
}

type Failure = Extract<FbHistoryPageResult, { success: false }>;

const stripJid = (id: unknown) => String(id ?? '').replace(/@.*$/, '');
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class FacebookHistoryFetcher {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: FacebookHistoryDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  // EventBroadcaster nạp muộn để tránh vòng import.
  private onBossDb<T>(fn: (db: DatabaseService) => T): T {
    let result: T;
    const run = this.deps.runOnBossDb ?? ((f: (db: DatabaseService) => void) => require('../event/EventBroadcaster').default.runOnBossDb(f));
    run(db => { result = fn(db); });
    return result!;
  }

  isE2EEThread(threadId: string): boolean {
    return this.onBossDb(db => !!db.queryOne<any>(
      'SELECT 1 AS hit FROM fb_threads WHERE id = ? AND account_id = ? AND is_e2ee = 1', [stripJid(threadId), this.deps.accountId]));
  }

  /** `threadId` (đã biết từ lúc gọi) thay cho threadId trong tin: id 17 chữ số mất chính xác khi bridge trả về dạng số JSON. */
  persistBridgeMessages(messages: any[], range?: FbHistoryRange, threadId?: string): { stored: number; fresh: number; received: number } {
    const rows = new Map<string, HistoryRow & { threadId: string }>();
    for (const m of messages || []) {
      if (!m?.id) continue;
      const attachments = m.isAdminMsg ? [] : (m.attachments || [])
        .filter((a: any) => a && !SKIPPED_BRIDGE_ATTACHMENTS.has(a.type))
        .map((a: any, idx: number) => ({
          id: String(idx + 1),
          type: this.attachmentType(a.type === 'voice' ? 'audio' : (a.type || a.attachmentType)),
          url: a.url || null,
          ...((a.fileName || a.name) ? { name: a.fileName || a.name } : {}),
          ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
          ...(a.mimeType ? { mimeType: a.mimeType } : {}),
        }));
      rows.set(m.id, {
        id: m.id, threadId: threadId ? stripJid(threadId) : stripJid(m.threadId),
        senderId: m.senderId != null ? String(m.senderId) : '', body: m.text || null,
        timestampMs: activityMs(m.timestampMs), attachments, replyToId: m.replyTo?.messageId,
        type: m.isAdminMsg ? 'system' : (attachments[0]?.type || 'text'),
      });
    }
    return this.saveRows([...rows.values()], range);
  }

  persistGraphQLMessages(threadId: string, messages: any[], range?: FbHistoryRange): { stored: number; fresh: number; received: number } {
    const id = stripJid(threadId);
    const rows = (messages || []).filter(m => m?.id).map(m => ({
      id: m.id, threadId: id, senderId: m.senderId != null ? String(m.senderId) : '', senderName: m.senderName || '',
      body: m.body || null, timestampMs: activityMs(m.timestampMs), attachments: m.attachments || [],
      replyToId: m.replyToMessageId || '', isUnsent: !!m.isUnsent, reactions: m.reactions || [],
      type: m.isAdmin ? 'system' : (m.attachments?.length ? this.attachmentType(m.attachments[0].type) : 'text'),
    }));
    return this.saveRows(rows, range);
  }

  async fetchPage(rawThreadId: string, anchor: FbHistoryAnchor, range?: FbHistoryRange, opts: FetchPageOptions = {}): Promise<FbHistoryPageResult> {
    const { limiter } = this.deps;
    const cooling = this.cooldownFailure();
    if (cooling) return cooling;
    const threadId = stripJid(rawThreadId);
    if (!/^\d+$/.test(threadId)) return this.fail('FETCH', 'Mã hội thoại không hợp lệ');
    if (this.isE2EEThread(threadId)) return this.fail('E2EE', 'Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ');

    const start = this.resolveAnchor(threadId, anchor, opts.latestKnownMs);
    if (start && !this.liveBridge()) return this.bridgeDown();

    const blocked = await this.waitForTurn(opts);
    if (blocked) return blocked;
    // Lượt chờ có thể kéo dài tới cả giờ: cooldown / bridge có thể đã đổi trong lúc chờ.
    const coolingNow = this.cooldownFailure();
    if (coolingNow) return coolingNow;
    const bridge = start ? this.liveBridge() : null;
    if (start && !bridge) return this.bridgeDown();

    limiter.recordRequest();
    const source = start ? 'lightspeed' : 'graphql';
    for (let collisions = 0; ; collisions++) {
      const live = collisions === 0 ? bridge : (start ? this.liveBridge() : null);
      if (start && !live) return this.bridgeDown();
      try {
        const page = start
          ? await this.pageFromBridge(live!, threadId, start, range)
          : await this.pageFromGraphQL(threadId, range);
        limiter.recordResult(true);
        return page;
      } catch (err: any) {
        const raw = typeof err === 'string' ? err : err?.message;
        const message = typeof raw === 'string' && raw ? raw : 'Facebook không trả lời';
        // Hai yêu cầu cùng hội thoại va nhau: nền thì chờ rồi thử lại (chưa gửi gì tới Facebook), không tính là lỗi.
        if (COLLISION_PATTERN.test(message)) {
          if (opts.mode === 'background' && collisions < COLLISION_MAX_RETRIES) {
            if (!(await this.sleepUnlessStopped(COLLISION_WAIT_MS, opts.shouldStop))) return this.fail('CANCELLED', 'Đã huỷ');
            continue;
          }
          return this.fail('FETCH', message, source);
        }
        return this.classify(err, message, source);
      }
    }
  }

  /** Lùi từng trang tới hết khoảng (hoặc hết tin). Khoảng kết thúc trong quá khứ: các trang mới hơn toTs được duyệt nhưng không lưu. */
  async syncThread(threadId: string, range: FbHistoryRange, opts: HistorySyncOptions = {}): Promise<HistorySyncResult> {
    let anchor: FbHistoryAnchor = { timestampMs: range.toTs ?? 0, messageId: '' };
    const usedAnchors = new Set<string>([`${anchor.timestampMs}|${anchor.messageId}`]);
    let saved = 0, received = 0, pages = 0, failedInARow = 0;
    for (;;) {
      if (opts.shouldStop?.()) return { saved, received, pages, complete: false };
      const res = await this.fetchPage(threadId, anchor, range, {
        mode: 'background', shouldStop: opts.shouldStop, onWait: opts.onWait,
        ...(pages === 0 && range.toTs == null && opts.latestKnownMs ? { latestKnownMs: opts.latestKnownMs } : {}),
      });
      if (res.success === false) {
        const failure = res as Failure;
        if (failure.code === 'CANCELLED') return { saved, received, pages, complete: false };
        if (failure.code === 'FETCH' && ++failedInARow < 2) continue;
        return { saved, received, pages, complete: false, error: failure.error, code: failure.code };
      }
      failedInARow = 0;
      saved += res.saved; received += res.received; pages++;
      opts.onPage?.({ saved: res.saved, received: res.received });
      const next = nextHistoryAnchor(res, anchor, range);
      if (!next) return { saved, received, pages, complete: true };
      // Chống vòng lặp: chỉ trang đầu của khoảng kết thúc trong quá khứ mới được phép mới hơn mốc.
      if (pages > 1 && next.timestampMs > anchor.timestampMs) return { saved, received, pages, complete: true };
      // Chống vòng A→B→A: mốc đã dùng rồi thì dừng.
      const key = `${next.timestampMs}|${next.messageId}`;
      if (usedAnchors.has(key)) return { saved, received, pages, complete: true };
      usedAnchors.add(key);
      anchor = next;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private classify(err: any, message: string, source: FbHistorySource): Failure {
    if (this.deps.limiter.recordResult(false, message) === 'risk') return this.fail('RISK', HISTORY_RISK_TEXT, source);
    if (/unknown method/i.test(message)) {
      return this.fail('BRIDGE_OLD', 'Bridge Facebook bản cũ chưa hỗ trợ tải lịch sử — khởi động lại MaiHub sau khi cập nhật', source);
    }
    if (err instanceof BridgeNotReadyError || /not initiali[sz]ed|bridge disconnected|bridge exited|bridge closed|BridgeNotReady/i.test(message)) {
      return this.bridgeDown(source);
    }
    return this.fail('FETCH', message, source);
  }

  private fail(code: FbHistoryCode, error: string, source?: Failure['source']): Failure {
    return { success: false, code, error, ...(source ? { source } : {}) };
  }

  private cooldownFailure(): Failure | null {
    const cooldown = this.deps.limiter.cooldownRemaining();
    return cooldown > 0
      ? this.fail('COOLDOWN', `Đang tạm dừng tải lịch sử Facebook để bảo vệ tài khoản (còn ${Math.ceil(cooldown / 60_000)} phút)`)
      : null;
  }

  private liveBridge() {
    const bridge = this.deps.bridge();
    return bridge && bridge.isAlive() ? bridge : null;
  }

  private bridgeDown(source: Failure['source'] = 'lightspeed'): Failure {
    return this.fail('BRIDGE_DOWN', 'Bridge Facebook chưa chạy (đang kết nối lại) — thử lại sau ít phút', source);
  }

  /** Tin cũ nhất có mốc thời gian; tin thiếu timestamp bị bỏ qua để không kết thúc chuỗi tải sớm. */
  private oldestWithTimestamp(messages: any[]): any {
    return messages.reduce<any>((min, m) => {
      const ts = activityMs(m?.timestampMs);
      return ts > 0 && (!min || ts < activityMs(min.timestampMs)) ? m : min;
    }, null);
  }

  private attachmentType(type: unknown): string {
    return ATTACHMENT_TYPES.has(String(type)) ? String(type) : 'file';
  }

  /** Mốc cho bridge, hoặc null = dùng trang GraphQL mới nhất. */
  private resolveAnchor(threadId: string, anchor: FbHistoryAnchor, latestKnownMs?: number): FbHistoryAnchor | null {
    if (isLightSpeedMessageId(anchor.messageId) && anchor.timestampMs > 0) return anchor;
    // Tin mã hoá / tin tạm không làm mốc được: lùi về tin mid.$… gần nhất trong máy.
    const row = this.onBossDb(db => db.queryOne<{ msg_id: string; timestamp: number }>(
      `SELECT msg_id, timestamp FROM messages
       WHERE owner_zalo_id = ? AND channel = 'facebook' AND thread_id = ? AND msg_id LIKE 'mid.$%'
         AND (? <= 0 OR timestamp <= ?)
       ORDER BY timestamp DESC LIMIT 1`,
      [this.deps.facebookId(), threadId, anchor.timestampMs, anchor.timestampMs]));
    if (!row) return null;
    const ts = activityMs(row.timestamp);
    if (latestKnownMs && ts < latestKnownMs - HISTORY_TOP_GAP_MS) return null;
    return { timestampMs: ts, messageId: row.msg_id };
  }

  /** Ngủ theo lát ≤ 1 s; false nếu bị huỷ giữa chừng. */
  private async sleepUnlessStopped(ms: number, shouldStop?: () => boolean): Promise<boolean> {
    for (let remaining = ms; remaining > 0; remaining -= WAIT_SLICE_MS) {
      if (shouldStop?.()) return false;
      await this.sleep(Math.min(remaining, WAIT_SLICE_MS));
    }
    return !shouldStop?.();
  }

  /** null = được đi tiếp; ngược lại là kết quả lỗi (BUSY / CANCELLED). */
  private async waitForTurn(opts: FetchPageOptions): Promise<Failure | null> {
    const { limiter } = this.deps;
    const total = limiter.waitMs();
    if (total <= 0) return null;
    if (opts.mode !== 'background') {
      if (total > HISTORY_INTERACTIVE_MAX_WAIT_MS) return this.fail('BUSY', 'Đang tải nhiều tin cũ — thử lại sau ít phút');
      await this.sleep(total);
      return null;
    }
    if (total >= NOTIFY_WAIT_MS) opts.onWait?.(total);
    for (let remaining = total; remaining > 0; remaining -= WAIT_SLICE_MS) {
      if (opts.shouldStop?.()) return this.fail('CANCELLED', 'Đã huỷ');
      await this.sleep(Math.min(remaining, WAIT_SLICE_MS));
    }
    return null;
  }

  private async pageFromGraphQL(threadId: string, range?: FbHistoryRange): Promise<FbHistoryPageResult> {
    const res = await this.deps.fetchGraphQLPage(threadId, HISTORY_GRAPHQL_PAGE);
    if (!res.success) throw new Error(res.error || 'Facebook không trả về tin nhắn');
    const messages = res.messages || [];
    const lightSpeed = messages.filter(m => isLightSpeedMessageId(m?.id));
    const oldest = this.oldestWithTimestamp(lightSpeed);
    const { stored, fresh, received } = this.persistGraphQLMessages(threadId, messages, range);
    return {
      success: true, source: 'graphql', saved: fresh, stored, received, count: messages.length,
      hasMoreBefore: lightSpeed.length > 0 && (messages.length >= HISTORY_GRAPHQL_PAGE || !!res.cursor?.hasMore),
      minTimestampMs: oldest ? activityMs(oldest.timestampMs) : 0,
      ...(oldest ? { minMessageId: oldest.id } : {}),
    };
  }

  private async pageFromBridge(
    bridge: NonNullable<ReturnType<FacebookHistoryDeps['bridge']>>, threadId: string, start: FbHistoryAnchor, range?: FbHistoryRange,
  ): Promise<FbHistoryPageResult> {
    const page = await bridge.fetchMessages({ threadId, beforeTimestampMs: start.timestampMs, beforeMessageId: start.messageId });
    const messages = page?.messages || [];
    const oldest = this.oldestWithTimestamp(messages);
    const { stored, fresh, received } = this.persistBridgeMessages(messages, range, threadId);
    return {
      success: true, source: 'lightspeed', saved: fresh, stored, received, count: messages.length,
      hasMoreBefore: !!page?.hasMoreBefore,
      minTimestampMs: activityMs(page?.minTimestampMs) || (oldest ? activityMs(oldest.timestampMs) : 0),
      ...(page?.minMessageId ? { minMessageId: page.minMessageId } : {}),
    };
  }

  private saveRows(rows: Array<HistoryRow & { threadId: string }>, range?: FbHistoryRange): { stored: number; fresh: number; received: number } {
    const ownerId = this.deps.facebookId();
    const liveAfter = this.now() - HISTORY_LIVE_WINDOW_MS;
    return this.onBossDb(db => {
      let stored = 0, fresh = 0, received = 0;
      // Lưu tin cũ trước: tin trả lời trong cùng trang tìm được tin gốc để dựng trích dẫn.
      for (const r of [...rows].sort((a, b) => a.timestampMs - b.timestampMs)) {
        if (r.timestampMs > liveAfter) continue; // đường tin trực tiếp lo tin này
        if (range && !messageInRange(r.timestampMs, range)) continue;
        received++;
        const outcome = db.saveFBMessage({
          id: r.id, account_id: this.deps.accountId, thread_id: r.threadId, sender_id: r.senderId,
          sender_name: r.senderName || '', body: r.body || undefined, timestamp: r.timestampMs, type: r.type,
          attachments: r.attachments?.length ? JSON.stringify(r.attachments) : '[]',
          reply_to_id: r.replyToId || '', is_self: r.senderId === ownerId ? 1 : 0, is_unsent: r.isUnsent ? 1 : 0,
          reactions: r.reactions?.length ? JSON.stringify(r.reactions) : '{}',
          is_history: true,
        });
        if (outcome === 'new') { fresh++; stored++; } else if (outcome === 'repaired') stored++;
      }
      return { stored, fresh, received };
    });
  }
}
