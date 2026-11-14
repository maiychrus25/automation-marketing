/**
 * FacebookHistorySyncService — đồng bộ lịch sử tin nhắn Facebook theo khoảng ngày cho một tài khoản.
 *
 * Liệt kê hội thoại có hoạt động trong khoảng, rồi đi ngược từng hội thoại qua `FbHistorySyncTarget`.
 * Mọi lượt kết thúc bằng một trạng thái cuối (completed / failed / cancelled), luôn được phát.
 * Dừng cả lượt khi có dấu hiệu rủi ro tài khoản. Log chỉ có id hội thoại và số đếm — không tên, không nội dung.
 * Mẫu phát sự kiện bám MobileSyncService (EventBroadcaster.emit, không chuyển tiếp cho nhân viên).
 */
import Logger from '../../utils/Logger';
import DatabaseService from '../database/DatabaseService';
import { FacebookHistoryLimiter, isFacebookRiskError } from './FacebookHistoryLimiter';
import {
  activityMs, emptyFbHistorySyncStatus, FB_HISTORY_SYNC_EVENT, FbHistoryCode, FbHistoryRange, FbHistorySyncStatus,
  isFbHistorySyncActive, threadActiveInRange,
} from './facebookHistory';

export interface FbHistorySyncTarget {
  isConnected(): boolean;
  getStatus(): string; // 'cookie_expired' stops the run
  getAccountId(): string; // fb_accounts.id
  isPage(): boolean;
  isE2EEThread(threadId: string): boolean;
  historyLimiterFor(): FacebookHistoryLimiter;
  getThreadListPage(before: number | null): Promise<{ threads: Array<{ id: string; name?: string; lastActivityMs: number; [k: string]: any }>; nextBefore: number | null; error?: string }>;
  syncThreadHistory(threadId: string, range: FbHistoryRange, opts: { shouldStop: () => boolean; onPage: (p: { saved: number; received: number }) => void; onWait: (ms: number) => void; latestKnownMs?: number }):
    Promise<{ saved: number; received: number; pages: number; complete: boolean; error?: string; code?: FbHistoryCode }>;
}

export const MAX_THREAD_PAGES = 400;
const EMIT_THROTTLE_MS = 400;
const SLEEP_SLICE_MS = 1000;
const VISIBLE_WAIT_MS = 4000;
/** Mất kết nối giữa lượt: chờ tối đa chừng này để tài khoản nối lại trước khi dừng cả lượt. */
const RECONNECT_WAIT_MS = 120_000;
const RECONNECT_SLICE_MS = 5_000;

const MSG = {
  listing: 'Đang lấy danh sách hội thoại…',
  noThreads: 'Không có hội thoại nào trong khoảng thời gian này',
  stopping: 'Đang dừng…',
  busy: 'Đang đồng bộ tài khoản này',
  notConnected: 'Tài khoản Facebook chưa kết nối — kết nối lại rồi đồng bộ',
  page: 'Tài khoản Page chưa hỗ trợ đồng bộ lịch sử',
  cookie: 'Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản',
  disconnected: 'Tài khoản Facebook mất kết nối — đã dừng đồng bộ',
  risk: 'Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản',
};

export interface FbHistorySyncDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Mọi ghi/đọc DB của lượt chạy trên DB chính của chủ tài khoản, kể cả khi đang mở workspace khác. */
  runOnBossDb(fn: (db: DatabaseService) => void): void;
}

/** Kết thúc cả lượt với lý do (không phải lỗi riêng một hội thoại). */
class RunFailure extends Error {}

interface Session {
  status: FbHistorySyncStatus;
  cancelled: boolean;
  lastEmitAt: number;
  done: Promise<void>;
}

/** `123@msgr` → `123`; id không toàn chữ số → null (bỏ). */
function normalizeThreadId(raw: unknown): string | null {
  const id = String(raw ?? '').split('@')[0];
  return /^\d+$/.test(id) ? id : null;
}

interface ThreadRow { id: string; name: string; lastActivityMs: number; e2ee: boolean }

export default class FacebookHistorySyncService {
  private static instance: FacebookHistorySyncService;
  private readonly deps: FbHistorySyncDeps;
  private sessions = new Map<string, Session>();

  constructor(deps: Partial<FbHistorySyncDeps> = {}) {
    this.deps = {
      now: Date.now,
      sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
      // EventBroadcaster nạp muộn để tránh vòng import.
      runOnBossDb: fn => require('../event/EventBroadcaster').default.runOnBossDb(fn),
      ...deps,
    };
  }

  static getInstance(): FacebookHistorySyncService {
    if (!FacebookHistorySyncService.instance) FacebookHistorySyncService.instance = new FacebookHistorySyncService();
    return FacebookHistorySyncService.instance;
  }

  getStatus(accountId: string): FbHistorySyncStatus | null {
    const s = this.sessions.get(accountId);
    return s ? { ...s.status } : null;
  }

  /** Chờ lượt hiện tại của tài khoản kết thúc (dùng trong test). */
  whenIdle(accountId: string): Promise<void> {
    return this.sessions.get(accountId)?.done ?? Promise.resolve();
  }

  start(accountId: string, range: FbHistoryRange, getService: () => Promise<FbHistorySyncTarget | null>): { success: boolean; status: FbHistorySyncStatus; error?: string } {
    const existing = this.sessions.get(accountId);
    if (existing && isFbHistorySyncActive(existing.status)) {
      return { success: false, status: { ...existing.status }, error: MSG.busy };
    }
    const status: FbHistorySyncStatus = {
      ...emptyFbHistorySyncStatus(accountId, range), stage: 'listing', message: MSG.listing, startedAt: this.deps.now(),
    };
    const session: Session = { status, cancelled: false, lastEmitAt: 0, done: Promise.resolve() };
    this.sessions.set(accountId, session);
    this.emit(session, true);
    session.done = this.run(session, range, getService);
    return { success: true, status: { ...status } };
  }

  cancel(accountId: string): { success: boolean; status: FbHistorySyncStatus | null } {
    const session = this.sessions.get(accountId);
    if (!session) return { success: false, status: null };
    if (!isFbHistorySyncActive(session.status)) return { success: false, status: { ...session.status } };
    session.cancelled = true;
    session.status.message = MSG.stopping;
    this.emit(session, true);
    return { success: true, status: { ...session.status } };
  }

  private onBossDb<T>(fn: (db: DatabaseService) => T): T {
    let result: T;
    this.deps.runOnBossDb(db => { result = fn(db); });
    return result!;
  }

  private emit(session: Session, force = false): void {
    const now = this.deps.now();
    if (!force && now - session.lastEmitAt < EMIT_THROTTLE_MS) return;
    session.lastEmitAt = now;
    try {
      require('../event/EventBroadcaster').default.emit(FB_HISTORY_SYNC_EVENT, { ...session.status });
    } catch (err: any) {
      Logger.warn(`[FbHistorySync] emit failed: ${err?.message || err}`);
    }
  }

  private finish(session: Session, stage: 'completed' | 'failed' | 'cancelled', message: string, error?: string): void {
    const s = session.status;
    s.stage = stage;
    s.message = message;
    if (error) s.error = error;
    s.finishedAt = this.deps.now();
    delete s.pausedUntil;
    delete s.currentThreadName;
    this.emit(session, true);
  }

  /** Ngủ theo lát ≤ 1 s để huỷ có hiệu lực ngay; trả false nếu bị huỷ. */
  private async wait(session: Session, ms: number): Promise<boolean> {
    let left = ms;
    while (left > 0 && !session.cancelled) {
      const slice = Math.min(SLEEP_SLICE_MS, left);
      await this.deps.sleep(slice);
      left -= slice;
    }
    return !session.cancelled;
  }

  private async run(session: Session, range: FbHistoryRange, getService: () => Promise<FbHistorySyncTarget | null>): Promise<void> {
    const accountId = session.status.accountId;
    try {
      let target: FbHistorySyncTarget | null = null;
      try { target = await getService(); } catch (err: any) { Logger.warn(`[FbHistorySync] getService failed: ${err?.message || err}`); }
      if (!target || !target.isConnected()) throw new RunFailure(MSG.notConnected);
      if (target.isPage()) throw new RunFailure(MSG.page);

      const rows = await this.listThreads(session, target, range, accountId);
      if (session.cancelled) return this.finish(session, 'cancelled', this.cancelMessage(session));
      const s = session.status;
      if (rows.length === 0) return this.finish(session, 'completed', MSG.noThreads);

      s.stage = 'syncing';
      s.threadsTotal = rows.length;
      s.message = `Đang tải tin nhắn ${rows.length} hội thoại…`;
      this.emit(session, true);

      for (const row of rows) {
        if (session.cancelled) break;
        await this.ensureUsable(session, target);
        if (session.cancelled) break;
        s.currentThreadName = row.name || undefined;
        this.emit(session, true);
        await this.syncOne(session, target, range, row);
      }
      if (session.cancelled) return this.finish(session, 'cancelled', this.cancelMessage(session));
      this.finish(session, 'completed', `Đã đồng bộ ${s.threadsDone} hội thoại, ${s.messagesSaved} tin mới`);
    } catch (err: any) {
      const message = err instanceof RunFailure ? err.message : (err?.message || 'Lỗi không xác định');
      Logger.warn(`[FbHistorySync] run ended failed (${accountId}): ${err instanceof RunFailure ? 'stopped' : message}`);
      this.finish(session, 'failed', message, message);
    }
  }

  private cancelMessage(session: Session): string {
    return `Đã dừng — đã lưu ${session.status.messagesSaved} tin mới`;
  }

  /** Phiên hết hạn → dừng ngay; mất kết nối → chờ tối đa 2 phút cho nối lại (huỷ được) rồi mới dừng. */
  private async ensureUsable(session: Session, target: FbHistorySyncTarget): Promise<void> {
    if (target.getStatus() === 'cookie_expired') throw new RunFailure(MSG.cookie);
    if (target.isConnected()) return;
    for (let waited = 0; waited < RECONNECT_WAIT_MS; waited += RECONNECT_SLICE_MS) {
      if (session.cancelled) return;
      await this.deps.sleep(RECONNECT_SLICE_MS);
      if (target.getStatus() === 'cookie_expired') throw new RunFailure(MSG.cookie);
      if (target.isConnected()) return;
    }
    throw new RunFailure(MSG.disconnected);
  }

  private async listThreads(session: Session, target: FbHistorySyncTarget, range: FbHistoryRange, accountId: string): Promise<ThreadRow[]> {
    const internalId = target.getAccountId();
    const limiter = target.historyLimiterFor();
    const byId = new Map<string, ThreadRow>();
    const add = (rawId: unknown, name: string, ms: number, e2ee: boolean) => {
      const id = normalizeThreadId(rawId);
      if (!id) return;
      const prev = byId.get(id);
      if (!prev) byId.set(id, { id, name, lastActivityMs: ms, e2ee });
      else byId.set(id, { id, name: prev.name || name, lastActivityMs: Math.max(prev.lastActivityMs, ms), e2ee: prev.e2ee || e2ee });
    };

    let before: number | null = null;
    const usedCursors = new Set<number | null>();
    let pages = 0;
    for (; pages < MAX_THREAD_PAGES; pages++) {
      await this.ensureUsable(session, target);
      if (session.cancelled) return [];
      if (limiter.cooldownRemaining() > 0) throw new RunFailure(MSG.risk);
      const waitMs = limiter.waitMs();
      const visible = waitMs >= VISIBLE_WAIT_MS;
      if (visible) { session.status.pausedUntil = this.deps.now() + waitMs; this.emit(session, true); }
      const waited = await this.wait(session, waitMs);
      if (visible) { delete session.status.pausedUntil; this.emit(session, true); }
      if (!waited) return [];
      usedCursors.add(before);
      limiter.recordRequest();
      const res = await target.getThreadListPage(before);
      if (res.error) {
        if (limiter.recordResult(false, res.error) === 'risk' || isFacebookRiskError(res.error)) throw new RunFailure(MSG.risk);
        Logger.warn(`[FbHistorySync] thread list page failed (${accountId}); using ${byId.size} listed`);
        break;
      }
      limiter.recordResult(true);
      if (res.threads.length) {
        this.onBossDb(db => db.saveFBThreads(internalId, res.threads.map(({ lastActivityMs: _drop, ...t }) => t)));
        for (const t of res.threads) add(t.id, t.name || '', activityMs(t.lastActivityMs), false);
      }
      session.status.message = `${MSG.listing} (${byId.size})`;
      this.emit(session, true);
      if (res.nextBefore == null) break;
      if (usedCursors.has(res.nextBefore)) {
        Logger.warn(`[FbHistorySync] thread list stopped: repeated cursor (${accountId}), pages=${pages + 1}, listed=${byId.size}`);
        break;
      }
      const times = res.threads.map(t => activityMs(t.lastActivityMs)).filter(ms => ms > 0);
      if (range.fromTs != null && times.length && Math.min(...times) < range.fromTs) break;
      before = res.nextBefore;
    }
    if (pages >= MAX_THREAD_PAGES) Logger.warn(`[FbHistorySync] thread list stopped: MAX_THREAD_PAGES reached (${accountId}), listed=${byId.size}`);

    const local = this.onBossDb(db => ({
      threads: db.query<any>('SELECT id, name, last_message_at, is_e2ee FROM fb_threads WHERE account_id = ?', [internalId]),
      contacts: db.query<any>("SELECT contact_id, display_name, last_message_time FROM contacts WHERE owner_zalo_id = ? AND channel = 'facebook'", [accountId]),
    }));
    for (const r of local.threads) add(String(r.id), r.name || '', activityMs(r.last_message_at), !!r.is_e2ee);
    for (const r of local.contacts) add(String(r.contact_id), r.display_name || '', activityMs(r.last_message_time), false);
    return [...byId.values()]
      .filter(r => threadActiveInRange(r.lastActivityMs, range))
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  private async syncOne(session: Session, target: FbHistorySyncTarget, range: FbHistoryRange, row: ThreadRow): Promise<void> {
    const s = session.status;
    if (row.e2ee || target.isE2EEThread(row.id)) {
      s.skippedE2EE += 1;
      s.threadsDone += 1;
      this.emit(session);
      return;
    }
    let result: Awaited<ReturnType<FbHistorySyncTarget['syncThreadHistory']>>;
    try {
      result = await target.syncThreadHistory(row.id, range, {
        shouldStop: () => session.cancelled,
        onPage: p => {
          s.messagesSaved += p.saved;
          s.messagesReceived += p.received;
          delete s.pausedUntil;
          this.emit(session);
        },
        onWait: ms => {
          s.pausedUntil = this.deps.now() + ms;
          this.emit(session, true);
        },
        latestKnownMs: range.toTs == null && row.lastActivityMs > 0 ? row.lastActivityMs : undefined,
      });
    } catch (err: any) {
      result = { saved: 0, received: 0, pages: 0, complete: false, error: err?.message || String(err), code: 'FETCH' };
    }
    Logger.log(`[FbHistorySync] thread ${row.id}: pages=${result.pages} received=${result.received} saved=${result.saved} code=${result.code || 'none'}`);

    const code = result.code;
    if (code === 'BRIDGE_DOWN' || code === 'BRIDGE_OLD' || code === 'RISK' || code === 'COOLDOWN') {
      throw new RunFailure(result.error || (code === 'RISK' || code === 'COOLDOWN' ? MSG.risk : MSG.disconnected));
    }
    if (code === 'E2EE') s.skippedE2EE += 1;
    else if ((result.error || code) && code !== 'CANCELLED') s.failedThreads += 1;
    if (!session.cancelled) s.threadsDone += 1;
    delete s.pausedUntil;
    this.emit(session);
  }
}
