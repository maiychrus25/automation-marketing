/**
 * Kết nối trực tiếp tới hộp thư của một Page (giao thức lightspeed của Meta Business Suite trên MQTT).
 * Đóng vai "cầu nối" của tài khoản Page: phát sự kiện cùng dạng với cầu nối Go (`{ type, data }`) và có
 * `isAlive()` / `fetchMessages()` cùng chữ ký, để FacebookService và FacebookHistoryFetcher dùng chung một đường.
 * Nhận tin, tải tin cũ, gửi tin chữ / đính kèm đã tải lên / nhãn dán, thả cảm xúc và đánh dấu đã đọc.
 * Log không chứa nội dung tin, cookie, con trỏ, mã thiết bị hay mã phiên.
 */
import { EventEmitter } from 'events';
import Logger from '../../utils/Logger';
import type { BridgeHistoryPage } from './FacebookE2EEBridge';
import { generateSessionId } from './FacebookUtils';
import { e2eeReconnectDelayMs } from './facebookBridgeBackoff';
import { decodeLightspeed } from './lightspeedDecoder';
import {
  ConnectInbox, FALLBACK_LS_VERSION, FetchInboxPage, InboxClient, InboxPageInfo, PAGE_INBOX_ENDPOINT, PageWebSession, connectInbox, fetchInboxPage,
  historyRequest, markReadRequest, newOfflineThreadingId, pageInboxLogin, pageInboxUsername, reactionRequest, readInboxPage, sendAttachmentRequest,
  sendStickerRequest, sendTextRequest, syncRequest, threadListRequest,
} from './pageInboxProtocol';
import { InboxBatch, InboxMessage, PAGE_MAILBOX_DB, readInboxBatch } from './pageInboxTables';

const SYNC_ANSWER_TIMEOUT_MS = 10_000;
const HISTORY_TIMEOUT_MS = 30_000;
/** Chờ Facebook xác nhận một tin đã gửi (trả mã tin thật) hoặc một cảm xúc đã thả tối đa chừng này. */
const SEND_CONFIRM_TIMEOUT_MS = 20_000;
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
  | { type: 'delivered'; data: { threadId: string; userId: string; timestampMs: number } }
  | { type: 'typing'; data: { threadId: string; userId: string; isTyping: boolean } };

interface Session { deviceId: string; version: string; syncParams: string; needThreads: boolean }
interface Pending<T> { resolve: (value: T) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
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
  /** Tin đã gửi đang chờ Facebook xác nhận, theo mã tạm (otid). */
  private readonly pendingSends = new Map<string, Pending<{ messageId: string }>>();
  /** Cảm xúc đã thả đang chờ Facebook xác nhận, theo mã tin. */
  private readonly pendingReactions = new Map<string, Set<Pending<void>>>();
  /** Mã phiên của trang hộp thư (fb_dtsg, lsd, jazoest), dùng cho việc tải tệp lên. */
  private webTokens: Pick<InboxPageInfo, 'fbDtsg' | 'lsd' | 'jazoest'> | null = null;
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

  /**
   * Gửi một tin chữ vào hội thoại (kèm đánh dấu đã đọc, như Business Suite). Hoàn tất khi Facebook xác nhận bằng mã tin thật.
   * Quá hạn mà chưa có xác nhận thì báo lỗi: không biết tin đã tới hay chưa nên không coi là đã gửi.
   */
  sendText(p: { threadId: string; text: string; replyToMessageId?: string }): Promise<{ messageId: string }> {
    if (!p.text?.trim()) return Promise.reject(new Error('Tin gửi không hợp lệ'));
    return this.sendConfirmed(p.threadId, 2, (requestId, firstTaskId, otid, version) =>
      sendTextRequest(requestId, firstTaskId, { threadId: p.threadId, text: p.text, otid, nowMs: Date.now(), replyToMessageId: p.replyToMessageId }, version));
  }

  /** Gửi một đính kèm đã tải lên (`attachmentId` do bước tải lên trả về). Xác nhận và lỗi như sendText. */
  sendAttachment(p: { threadId: string; attachmentId: string }): Promise<{ messageId: string }> {
    if (!/^\d+$/.test(p.attachmentId)) return Promise.reject(new Error('Đính kèm không hợp lệ'));
    return this.sendConfirmed(p.threadId, 1, (requestId, taskId, otid, version) =>
      sendAttachmentRequest(requestId, taskId, { threadId: p.threadId, otid, attachmentId: p.attachmentId }, version));
  }

  /** Gửi một nhãn dán theo mã của nó (kèm đánh dấu đã đọc). Xác nhận và lỗi như sendText. */
  sendSticker(p: { threadId: string; stickerId: string }): Promise<{ messageId: string }> {
    if (!/^\d+$/.test(p.stickerId)) return Promise.reject(new Error('Nhãn dán không hợp lệ'));
    return this.sendConfirmed(p.threadId, 2, (requestId, firstTaskId, otid, version) =>
      sendStickerRequest(requestId, firstTaskId, { threadId: p.threadId, otid, stickerId: p.stickerId, nowMs: Date.now() }, version));
  }

  /** Gửi một yêu cầu gửi tin gồm `taskCount` tác vụ và chờ Facebook đổi mã tạm (otid) thành mã tin thật. */
  private sendConfirmed(
    threadId: string, taskCount: number, build: (requestId: number, firstTaskId: number, otid: string, version: string) => string,
  ): Promise<{ messageId: string }> {
    if (!this.isAlive() || !this.session) return Promise.reject(new Error('Hộp thư Page chưa kết nối'));
    if (!/^\d+$/.test(threadId)) return Promise.reject(new Error('Tin gửi không hợp lệ'));
    const otid = newOfflineThreadingId();
    const version = this.session.version;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSends.delete(otid);
        reject(new Error('Facebook không xác nhận tin đã gửi'));
      }, SEND_CONFIRM_TIMEOUT_MS);
      this.pendingSends.set(otid, { resolve, reject, timer });
      const firstTaskId = this.taskId;
      this.taskId += taskCount;
      this.send(build(++this.requestId, firstTaskId, otid, version));
    });
  }

  /**
   * Thả cảm xúc đứng tên Page lên một tin (`emoji` rỗng = gỡ). Hoàn tất khi Facebook xác nhận; quá hạn thì báo lỗi.
   */
  sendReaction(p: { threadId: string; messageId: string; emoji: string }): Promise<void> {
    if (!this.isAlive() || !this.session) return Promise.reject(new Error('Hộp thư Page chưa kết nối'));
    if (!/^\d+$/.test(p.threadId) || !p.messageId) return Promise.reject(new Error('Cảm xúc không hợp lệ'));
    const { messageId } = p;
    const version = this.session.version;
    return new Promise<void>((resolve, reject) => {
      const waiting = this.pendingReactions.get(messageId) ?? new Set<Pending<void>>();
      this.pendingReactions.set(messageId, waiting);
      const pending: Pending<void> = {
        resolve, reject,
        timer: setTimeout(() => {
          waiting.delete(pending);
          if (!waiting.size && this.pendingReactions.get(messageId) === waiting) this.pendingReactions.delete(messageId);
          reject(new Error('Facebook không xác nhận cảm xúc'));
        }, SEND_CONFIRM_TIMEOUT_MS),
      };
      waiting.add(pending);
      this.send(reactionRequest(++this.requestId, this.taskId++, { threadId: p.threadId, messageId, pageId: this.deps.pageId, emoji: p.emoji || '', nowMs: Date.now() }, version));
    });
  }

  /**
   * Phiên web của hộp thư (cookie cá nhân + mã phiên của trang), cho các lời gọi HTTP của Business Suite như tải tệp lên.
   * `fresh` = tải lại trang để lấy mã phiên mới (mã cũ hết hạn); việc đó không đụng tới con trỏ hay kết nối đang chạy.
   * null nếu thiếu cookie đăng nhập hoặc trang không cho mã phiên.
   */
  async webSession(fresh = false): Promise<PageWebSession | null> {
    const login = pageInboxLogin(this.deps.getCookie());
    if (!login) return null;
    const agent = this.deps.getAgent?.();
    if (fresh || !this.webTokens?.fbDtsg) {
      try {
        const page = await (this.deps.fetchPage ?? fetchInboxPage)(this.deps.pageId, login.cookieHeader, agent);
        this.keepWebTokens(readInboxPage(page.html));
      } catch (err: any) {
        Logger.warn(`${this.tag} không tải được trang hộp thư để lấy mã phiên: ${err?.message}`);
        return null;
      }
    }
    const tokens = this.webTokens;
    if (!tokens?.fbDtsg || !tokens.jazoest) return null;
    return { pageId: this.deps.pageId, userId: login.userId, cookieHeader: login.cookieHeader, agent, fbDtsg: tokens.fbDtsg, lsd: tokens.lsd, jazoest: tokens.jazoest };
  }

  /** Giữ mã phiên của một lần tải trang; trang không có mã (ví dụ trang đăng nhập) thì bỏ mã cũ. */
  private keepWebTokens(info: InboxPageInfo): void {
    this.webTokens = info.fbDtsg ? { fbDtsg: info.fbDtsg, lsd: info.lsd, jazoest: info.jazoest } : null;
  }

  /** Đánh dấu đã đọc một hội thoại tới mốc cho trước. false nếu chưa kết nối hoặc tham số không hợp lệ (không gửi gì). */
  markRead(threadId: string, watermarkMs: number): boolean {
    if (!this.isAlive() || !this.session || !/^\d+$/.test(threadId) || !(watermarkMs > 0)) return false;
    this.send(markReadRequest(++this.requestId, this.taskId++, threadId, watermarkMs, this.session.version));
    return true;
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
      this.keepWebTokens(info);
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
    for (const { otid, messageId } of batch.sent) {
      const pending = this.pendingSends.get(otid);
      if (!pending) continue;
      this.pendingSends.delete(otid);
      clearTimeout(pending.timer);
      pending.resolve({ messageId });
    }
    const { pageId } = this.deps;
    // Cảm xúc vừa thả hay gỡ được xác nhận bằng replaceOptimisticReaction; thay đổi cảm xúc đứng tên Page trên tin đó cũng được tính.
    for (const messageId of [...batch.confirmedReactions, ...batch.reactions.filter(r => r.actorId === pageId).map(r => r.messageId)]) {
      const waiting = this.pendingReactions.get(messageId);
      if (!waiting) continue;
      this.pendingReactions.delete(messageId);
      for (const pending of waiting) { clearTimeout(pending.timer); pending.resolve(); }
    }

    const messages = this.takeHistory(batch);
    if (messages.length || batch.threads.length) {
      Logger.log(`${this.tag} nhận tin=${messages.length} (mới=${messages.filter(m => !m.isHistory).length}) hội thoại=${batch.threads.length}`);
    }
    this.emitMessages(messages);
    const events: PageInboxEvent[] = [
      ...batch.reactions.map((r): PageInboxEvent => ({ type: 'reaction', data: { messageId: r.messageId, threadId: r.threadId, userId: r.actorId, emoji: r.emoji } })),
      // "Đã nhận", "đã xem" và "đang gõ" của chính Page (thao tác ở máy khác) không phải tín hiệu từ khách.
      ...batch.deliveryReceipts.filter(r => r.contactId !== pageId)
        .map((r): PageInboxEvent => ({ type: 'delivered', data: { threadId: r.threadId, userId: r.contactId, timestampMs: r.watermarkMs } })),
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

  /** Bỏ máy khách hiện tại: không nghe nó nữa, đóng socket, trả lỗi cho các yêu cầu tin cũ, tin gửi và cảm xúc đang chờ. */
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
    for (const [otid, pending] of this.pendingSends) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Mất kết nối hộp thư Page khi đang gửi tin'));
      this.pendingSends.delete(otid);
    }
    for (const waiting of this.pendingReactions.values()) {
      for (const pending of waiting) { clearTimeout(pending.timer); pending.reject(new Error('Mất kết nối hộp thư Page khi đang thả cảm xúc')); }
    }
    this.pendingReactions.clear();
    try { client?.end(true); } catch { /* socket đã đóng */ }
    if (wasSynced) this.emit('status', 'disconnected');
  }
}
