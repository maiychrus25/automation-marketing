/**
 * Kết nối trực tiếp tới hộp thư của một Page (giao thức lightspeed của Meta Business Suite trên MQTT).
 * Đóng vai "cầu nối" của tài khoản Page: phát sự kiện cùng dạng với cầu nối Go (`{ type, data }`) và có
 * `isAlive()` / `fetchMessages()` cùng chữ ký, để FacebookService và FacebookHistoryFetcher dùng chung một đường.
 * Chỉ đọc: không gửi tin, không đánh dấu đã đọc. Log không chứa nội dung tin, cookie, con trỏ hay mã thiết bị.
 */
import { EventEmitter } from 'events';
import Logger from '../../utils/Logger';
import type { BridgeHistoryPage } from './FacebookE2EEBridge';
import { generateSessionId } from './FacebookUtils';
import { e2eeReconnectDelayMs } from './facebookBridgeBackoff';
import { decodeLightspeed } from './lightspeedDecoder';
import {
  ConnectInbox, FALLBACK_LS_VERSION, FetchInboxPage, InboxClient, PAGE_INBOX_ENDPOINT, connectInbox, fetchInboxPage, historyRequest,
  pageInboxLogin, pageInboxUsername, readInboxPage, syncRequest, threadListRequest,
} from './pageInboxProtocol';
import { InboxBatch, InboxMessage, PAGE_MAILBOX_DB, readInboxBatch } from './pageInboxTables';

const SYNC_ANSWER_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 30_000;
const RELOAD_PAGE_AFTER_FAILURES = 3;
/** Phiên phải đồng bộ được lâu chừng này mới coi là ổn định; ngắn hơn thì tính là một lần nối hỏng. */
const STABLE_SESSION_MS = 60_000;

export interface PageInboxDeps {
  accountId: string;
  pageId: string;               // delegate_page_id
  getCookie: () => string;      // cookie của tài khoản Page; chỉ phần đăng nhập cá nhân được dùng
  getAgent?: () => unknown;     // proxy hiện tại của tài khoản (đọc lại mỗi lần nối)
  connect?: ConnectInbox;       // tiêm cho test
  fetchPage?: FetchInboxPage;   // tiêm cho test
}

export type PageInboxEvent =
  | { type: 'message'; data: InboxMessage }
  | { type: 'unsend'; data: { messageId: string; threadId: string } }
  | { type: 'reaction'; data: { messageId: string; threadId: string; userId: string; emoji: string } }
  | { type: 'seen'; data: { threadId: string; userId: string; timestampMs: number } }
  | { type: 'typing'; data: { threadId: string; userId: string; isTyping: boolean } };

interface Session { deviceId: string; version: string; syncParams: string; needThreads: boolean }
interface PendingHistory {
  before: number;             // mốc thời gian của yêu cầu: chỉ tin cũ hơn mốc này mới thuộc trang trả về
  held: InboxMessage[];       // tin cũ hơn mốc đã về, chờ khoảng tin xác nhận
  resolve: (page: BridgeHistoryPage) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout>;
}

export class FacebookPageInbox extends EventEmitter {
  private readonly tag: string;
  private client: InboxClient | null = null;
  private generation = 0;          // tăng mỗi lần thay / bỏ máy khách: sự kiện của máy khách cũ bị bỏ qua
  private stopped = true;
  private synced = false;
  private syncedAt = 0;
  private session: Session | null = null;
  private cursor: string | null = null;
  private requestId = 0;
  private taskId = 0;
  private failures = 0;            // số lần nối hỏng liên tiếp (đóng trước khi có trả lời đồng bộ)
  private reloadPage = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingHistory = new Map<string, PendingHistory>();
  private readonly reportedSteps = new Set<number>();

  constructor(private readonly deps: PageInboxDeps) {
    super();
    this.tag = `[FBPageInbox:${deps.accountId.slice(0, 8)}]`;
  }

  /** Bắt đầu nối. Không ném lỗi: mọi thất bại được ghi log và hẹn nối lại. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.drop();
  }

  /** Kết nối tưởng còn sống nhưng đã bỏ sót tin: bỏ nó, lấy lại con trỏ và mã thiết bị từ trang hộp thư rồi nối lại. */
  resync(): void {
    if (this.stopped) return;
    this.reloadPage = true;
    this.drop();
    this.scheduleReconnect();
  }

  /** Đang mở và Facebook đã trả lời đồng bộ hộp thư (từ đó mới đẩy tin về). */
  isAlive(): boolean {
    return !!this.client && this.synced;
  }

  /** Một trang tin cũ hơn mốc đã cho của một hội thoại (cùng chữ ký với cầu nối Go). */
  fetchMessages(p: { threadId: string; beforeTimestampMs: number; beforeMessageId: string }): Promise<BridgeHistoryPage> {
    if (!this.isAlive() || !this.cursor || !this.session) return Promise.reject(new Error('Hộp thư Page chưa kết nối'));
    if (!/^\d+$/.test(p.threadId) || !p.beforeMessageId || !(p.beforeTimestampMs > 0)) return Promise.reject(new Error('Thiếu mốc tin để tải tin cũ'));
    if (this.pendingHistory.has(p.threadId)) return Promise.reject(new Error('history request already running'));
    const { threadId } = p;
    return new Promise<BridgeHistoryPage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const held = this.pendingHistory.get(threadId)?.held ?? [];
        this.pendingHistory.delete(threadId);
        reject(new Error('Facebook không trả lời yêu cầu tải tin cũ'));
        this.emitMessages(held); // tin đã về mà chưa có khoảng tin xác nhận: vẫn lưu theo đường thường
      }, HISTORY_TIMEOUT_MS);
      this.pendingHistory.set(threadId, { before: p.beforeTimestampMs, held: [], resolve, reject, timer });
      this.send(historyRequest(++this.requestId, this.taskId++, { threadId, messageId: p.beforeMessageId, timestampMs: p.beforeTimestampMs }, this.cursor!, this.session!.version));
    });
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const login = pageInboxLogin(this.deps.getCookie());
    const agent = this.deps.getAgent?.();
    if (!login) {
      Logger.warn(`${this.tag} thiếu cookie đăng nhập, không nối hộp thư Page`);
      return;
    }
    if (this.reloadPage || !this.session || !this.cursor) {
      const loaded = await this.loadPage(login.cookieHeader, agent);
      if (this.stopped) return;
      if (!loaded) { this.failed(); return; }
    }
    const session = this.session!;
    const sessionId = generateSessionId();
    const generation = ++this.generation;
    const mine = () => generation === this.generation;
    let client: InboxClient;
    try {
      client = (this.deps.connect ?? connectInbox)(
        `${PAGE_INBOX_ENDPOINT}?region=eag&sid=${sessionId}&cid=${session.deviceId}`,
        pageInboxUsername(login.userId, this.deps.pageId, sessionId, session.deviceId), login.cookieHeader, agent,
      );
    } catch (err: any) {
      Logger.warn(`${this.tag} không mở được kết nối: ${err?.message}`);
      this.failed();
      return;
    }
    this.client = client;
    client.on('connect', () => { if (mine()) this.onConnect(); });
    client.on('message', (topic: string, payload: Buffer) => { if (mine()) this.onMessage(topic, payload); });
    client.on('error', (err: Error) => {
      // Facebook trả PUBACK có cờ khác chuẩn; thư viện mqtt báo lỗi nhưng kết nối vẫn dùng được.
      if (mine() && !/header flag bits/.test(err?.message || '')) Logger.warn(`${this.tag} lỗi kết nối: ${err?.message}`);
    });
    client.on('close', () => { if (mine()) this.closed(); });
  }

  /** Tải trang hộp thư để lấy con trỏ, phiên bản và mã thiết bị. false nếu trang không dùng được. */
  private async loadPage(cookieHeader: string, agent: unknown): Promise<boolean> {
    try {
      const page = await (this.deps.fetchPage ?? fetchInboxPage)(this.deps.pageId, cookieHeader, agent);
      const info = readInboxPage(page.html);
      if (!info.cursor || !info.deviceId) {
        Logger.warn(`${this.tag} trang hộp thư không cho con trỏ hoặc mã thiết bị (status=${page.status} len=${page.html.length})`);
        return false;
      }
      this.cursor = info.cursor;
      this.session = {
        deviceId: info.deviceId, version: info.version ?? FALLBACK_LS_VERSION, needThreads: true,
        syncParams: JSON.stringify({ locale: 'vi_VN', ...(info.bloksVersion ? { bloks_version: info.bloksVersion } : {}) }),
      };
      this.reloadPage = false;
      return true;
    } catch (err: any) {
      Logger.warn(`${this.tag} không tải được trang hộp thư: ${err?.message}`);
      return false;
    }
  }

  private send(request: string): void {
    this.client?.publish('/ls_req', request, { qos: 1 });
  }

  private onConnect(): void {
    const session = this.session!;
    this.client!.publish('/ls_app_settings', JSON.stringify({ ls_fdid: '', ls_sv: session.version }), { qos: 1 });
    this.client!.subscribe(['/ls_foreground_state', '/ls_resp'], { qos: 0 });
    this.send(syncRequest(++this.requestId, PAGE_MAILBOX_DB, this.cursor, session.syncParams, session.version));
    if (session.needThreads && this.cursor) {
      session.needThreads = false;
      this.send(threadListRequest(++this.requestId, this.taskId++, this.cursor, session.version));
    }
    this.syncTimer = setTimeout(() => {
      Logger.warn(`${this.tag} không có trả lời đồng bộ sau ${SYNC_ANSWER_TIMEOUT_MS / 1000}s, sẽ tải lại trang hộp thư`);
      this.reloadPage = true;
      this.drop();
      this.failed();
    }, SYNC_ANSWER_TIMEOUT_MS);
  }

  private onMessage(topic: string, payload: Buffer): void {
    if (topic !== '/ls_resp') return;
    let batch: InboxBatch;
    try {
      const step = JSON.parse(JSON.parse(payload.toString('utf8')).payload).step;
      batch = readInboxBatch(decodeLightspeed(step, type => this.reportStep(type)));
    } catch {
      Logger.warn(`${this.tag} không đọc được một phản hồi (len=${payload.length})`);
      return;
    }
    if (batch.cursor) {
      this.cursor = batch.cursor;
      if (!this.synced) this.markSynced();
    }
    if (batch.threads.length || batch.contacts.length) this.emit('threads', batch.threads, batch.contacts);

    const messages = this.takeHistory(batch);
    if (messages.length || batch.threads.length) {
      Logger.log(`${this.tag} nhận tin=${messages.length} (mới=${messages.filter(m => !m.isHistory).length}) hội thoại=${batch.threads.length}`);
    }
    this.emitMessages(messages);
    const { pageId } = this.deps;
    const events: PageInboxEvent[] = [
      ...batch.reactions.map((r): PageInboxEvent => ({ type: 'reaction', data: { messageId: r.messageId, threadId: r.threadId, userId: r.actorId, emoji: r.emoji } })),
      // "Đã xem" và "đang gõ" của chính Page (thao tác ở máy khác) không phải tín hiệu từ khách.
      ...batch.readReceipts.filter(r => r.contactId !== pageId)
        .map((r): PageInboxEvent => ({ type: 'seen', data: { threadId: r.threadId, userId: r.contactId, timestampMs: r.watermarkMs } })),
      ...batch.typing.filter(t => t.senderId !== pageId)
        .map((t): PageInboxEvent => ({ type: 'typing', data: { threadId: t.threadId, userId: t.senderId, isTyping: t.isTyping } })),
    ];
    for (const event of events) this.emit('event', event);
  }

  /**
   * Tách phần thuộc các yêu cầu tin cũ đang chờ ra khỏi một phản hồi và trả phần còn lại (đi đường tin thường).
   * Tin cũ hơn mốc của yêu cầu được giữ lại cho trang; trang hoàn tất khi có khoảng tin cũ hơn mốc, hoặc dấu "hết tin"
   * của đúng yêu cầu đó. Khoảng tin không cũ hơn mốc (ví dụ tin cuối đi kèm danh sách hội thoại) không phải là trả lời.
   */
  private takeHistory(batch: InboxBatch): InboxMessage[] {
    if (!this.pendingHistory.size) return batch.messages;
    const rest: InboxMessage[] = [];
    for (const message of batch.messages) {
      const pending = this.pendingHistory.get(message.threadId);
      if (!pending || !message.isHistory || !(message.timestampMs > 0 && message.timestampMs < pending.before)) { rest.push(message); continue; }
      if (!pending.held.some(m => m.id === message.id)) pending.held.push(message);
    }
    for (const range of batch.ranges) {
      const pending = this.pendingHistory.get(range.threadId);
      if (!pending) continue;
      const isEnd = range.endOfHistoryAt !== undefined;
      const answers = isEnd
        ? range.endOfHistoryAt === 0 || range.endOfHistoryAt === pending.before
        : range.minTimestampMs > 0 && range.minTimestampMs < pending.before;
      if (!answers) continue;
      this.pendingHistory.delete(range.threadId);
      clearTimeout(pending.timer);
      const unsent = pending.held.filter(m => m.isUnsent);
      const page = pending.held.filter(m => !m.isUnsent);
      const oldest = pending.held.reduce<InboxMessage | null>((min, m) => (!min || m.timestampMs < min.timestampMs ? m : min), null);
      // Dấu "hết tin" đến sau khi đã có tin cũ hơn mốc: trang này chưa phải trang cuối, lần sau xin tiếp từ tin cũ nhất.
      const bounds = isEnd
        ? (oldest ? { hasMoreBefore: true, minTimestampMs: oldest.timestampMs, minMessageId: oldest.id } : { hasMoreBefore: false, minTimestampMs: 0 })
        : { hasMoreBefore: range.hasMoreBefore, minTimestampMs: range.minTimestampMs, ...(range.minMessageId ? { minMessageId: range.minMessageId } : {}) };
      pending.resolve({ threadId: range.threadId, messages: page, ...bounds });
      this.emitMessages(unsent);
    }
    return rest;
  }

  /** Phát tin theo đường thường; tin đã thu hồi (không còn nội dung) thành sự kiện thu hồi cho tin đã lưu. */
  private emitMessages(messages: InboxMessage[]): void {
    for (const data of messages) {
      const event: PageInboxEvent = data.isUnsent ? { type: 'unsend', data: { messageId: data.id, threadId: data.threadId } } : { type: 'message', data };
      this.emit('event', event);
    }
  }

  private markSynced(): void {
    this.synced = true;
    this.syncedAt = Date.now();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    Logger.log(`${this.tag} đã nối hộp thư Page …${this.deps.pageId.slice(-4)}`);
    this.emit('status', 'connected');
  }

  private reportStep(type: number): void {
    if (this.reportedSteps.has(type)) return;
    this.reportedSteps.add(type);
    Logger.warn(`${this.tag} gặp bước lightspeed chưa biết: ${type}`);
  }

  /** Máy chủ (hoặc mạng) đóng kết nối. Phiên chưa đồng bộ, hoặc đồng bộ rồi bị đóng ngay, tính là một lần nối hỏng. */
  private closed(): void {
    const stable = this.synced && Date.now() - this.syncedAt >= STABLE_SESSION_MS;
    this.drop();
    if (!stable) { this.failed(); return; }
    this.failures = 0;
    this.scheduleReconnect();
  }

  /** Một lần nối không tới được bước đồng bộ: giãn cách dần, đủ số lần thì tải lại trang. */
  private failed(): void {
    this.failures++;
    if (this.failures >= RELOAD_PAGE_AFTER_FAILURES) this.reloadPage = true;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = e2eeReconnectDelayMs(Math.max(0, this.failures - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open().catch(err => Logger.warn(`${this.tag} nối lại lỗi: ${err?.message}`));
    }, delay);
  }

  /** Bỏ máy khách hiện tại: không nghe nó nữa, đóng socket, trả lỗi cho các yêu cầu tin cũ đang chờ. */
  private drop(): void {
    this.generation++;
    const client = this.client;
    this.client = null;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    const wasSynced = this.synced;
    this.synced = false;
    for (const [threadId, pending] of this.pendingHistory) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Mất kết nối hộp thư Page'));
      this.pendingHistory.delete(threadId);
    }
    try { client?.end(true); } catch { /* socket đã đóng */ }
    if (wasSynced) this.emit('status', 'disconnected');
  }
}
