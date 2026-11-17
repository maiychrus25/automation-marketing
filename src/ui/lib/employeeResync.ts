/** Logic thuần của lần tải lại dữ liệu từ máy Boss sau gián đoạn (không đụng store, IPC hay timer thật). */

export const RESYNC_DEBOUNCE_MS = 500;

export type ResyncStep =
  | { kind: 'conversations'; accountId: string }
  | { kind: 'messages'; accountId: string; threadId: string };

interface SchedulerDeps {
  run: (reasons: string[]) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Chưa sẵn sàng (đang nạp dữ liệu ban đầu) thì giữ tín hiệu lại, chạy sau khi notifyReady(). */
  isReady?: () => boolean;
}

/** Gom nhiều yêu cầu trong 500 ms thành một lượt chạy; yêu cầu đến lúc đang chạy dồn thành đúng một lượt nữa. */
export class ResyncScheduler {
  private reasons: string[] = [];
  private timer: unknown = null;
  private _running = false;
  private disposed = false;

  constructor(private readonly deps: SchedulerDeps) {}

  get running(): boolean { return this._running; }

  /** Dừng hẳn: xoá hẹn giờ; lượt đang chạy xong thì không hẹn thêm. */
  dispose(): void {
    this.disposed = true;
    this.reasons = [];
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  /** Gọi khi dữ liệu ban đầu nạp xong: chạy một lượt cho các tín hiệu đã giữ lại. */
  notifyReady(): void {
    if (this.reasons.length > 0 && !this._running) this.schedule();
  }

  request(reason: string): void {
    if (this.disposed) return;
    this.reasons.push(reason);
    if (this._running) return; // lượt hiện tại xong sẽ tự lên lịch lượt kế
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.start(); }, RESYNC_DEBOUNCE_MS);
  }

  private async start(): Promise<void> {
    if (this.disposed || this._running || this.reasons.length === 0) return;
    if (this.deps.isReady && !this.deps.isReady()) return;
    const batch = this.reasons;
    this.reasons = [];
    this._running = true;
    try {
      await this.deps.run(batch);
    } catch {
      // run tự báo lỗi qua trạng thái của nó; không để lỗi làm kẹt bộ lập lịch
    } finally {
      this._running = false;
      if (!this.disposed && this.reasons.length > 0) this.schedule();
    }
  }
}

/** Hội thoại cho mọi tài khoản (tài khoản đang mở trước), rồi tin của hội thoại đang mở nếu có. */
export function resyncSteps(state: {
  accountIds: string[];
  activeAccountId: string | null;
  activeThreadId: string | null;
}): ResyncStep[] {
  const ordered = state.activeAccountId && state.accountIds.includes(state.activeAccountId)
    ? [state.activeAccountId, ...state.accountIds.filter((id) => id !== state.activeAccountId)]
    : state.accountIds;
  const steps: ResyncStep[] = ordered.map((accountId) => ({ kind: 'conversations', accountId }));
  if (state.activeAccountId && state.activeThreadId) {
    steps.push({ kind: 'messages', accountId: state.activeAccountId, threadId: state.activeThreadId });
  }
  return steps;
}

export function resyncStatusText(running: boolean, failed: boolean): string | null {
  if (running) return 'Đang cập nhật dữ liệu từ máy Boss…';
  if (failed) return 'Chưa cập nhật được dữ liệu từ máy Boss';
  return null;
}

const isPendingRow = (m: any) => String(m.msg_id).startsWith('temp_') || m.send_status === 'pending' || m.send_status === 'sending';
const byTimestamp = (a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0);

/** Số tin mỗi lần tải lại tin của hội thoại đang mở; cùng giá trị dùng để yêu cầu và để xét lô có nối liền hay không. */
export const RESYNC_MESSAGES_LIMIT = 50;

/** Trường máy nhân viên tự điền (đường dẫn file đã tải, trích dẫn dựng từ lô tin, nhân viên xử lý): boss trả rỗng thì giữ giá trị đang có. */
const LOCALLY_FILLED_FIELDS = ['local_paths', 'quote_data', 'handled_by_employee'];

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '' || v === '{}' || v === '[]') return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === 'object' && Object.keys(v as object).length === 0;
}

/** Trường của boss thắng; trường tự điền thì boss rỗng không xoá giá trị đang có; quote_data đang có (đã resolve) luôn thắng bản dựng mới. */
function mergeRow(loaded: any, fetched: any): any {
  const next = { ...loaded };
  for (const [k, v] of Object.entries(fetched)) {
    if (v === undefined) continue;
    if (k === 'quote_data' && !isEmptyValue(loaded[k])) continue;
    if (LOCALLY_FILLED_FIELDS.includes(k) && isEmptyValue(v) && !isEmptyValue(loaded[k])) continue;
    next[k] = v;
  }
  return next;
}

/**
 * Bỏ tin tạm/đang gửi đã có tin thật trong lô tải về, để không hiện hai lần:
 * - real_msg_id của nó có trong lô; hoặc
 * - trạng thái `timeout` (câu trả lời bị mất, không tự gửi lại) và lô có một tin gửi đi MỚI (chưa nạp) cùng nội dung; mỗi tin tải về chỉ khớp một dòng.
 * Dòng `sending`/`failed` không bao giờ bị bỏ theo nội dung.
 */
function dropSettledPending(rows: any[], fetched: any[], existingIds: Set<string>, dedupText: (c: string) => string): any[] {
  const fetchedIds = new Set(fetched.map((m) => String(m.msg_id)));
  const unmatched = fetched
    .filter((m) => Number(m.is_sent) === 1 && !existingIds.has(String(m.msg_id)))
    .map((m) => dedupText(String(m.content ?? '')));
  return rows.filter((m) => {
    if (!isPendingRow(m)) return true;
    if (m.real_msg_id && fetchedIds.has(String(m.real_msg_id))) return false;
    if (m.send_status === 'timeout') {
      const i = unmatched.indexOf(dedupText(String(m.content ?? '')));
      if (i >= 0) { unmatched.splice(i, 1); return false; }
    }
    return true;
  });
}

/**
 * Trộn lô tin vừa tải từ boss (tối đa `limit` tin mới nhất) vào danh sách đang giữ. Lô chỉ coi là NỐI LIỀN với tin đã nạp khi
 * ngắn hơn limit (đã có toàn bộ lịch sử) hoặc tin cũ nhất của lô đã được nạp; một id trùng ở đầu mới không chứng minh được điều đó.
 * - Nối liền: cập nhật các dòng trùng id, giữ mọi dòng khác, thêm dòng mới.
 * - Không nối liền: lô + tin đã nạp mới hơn tin mới nhất của lô (tin live đến sau khi tải) + tin tạm/đang gửi. Phần cũ hơn bị bỏ: cuộn lên sẽ nạp lại, không có lỗ hổng.
 * - Lô rỗng: không đổi (trả đúng mảng cũ).
 * `dedupText` là cách chuẩn hoá nội dung của chatStore.addMessage (truyền vào để không phụ thuộc store).
 */
export function mergeFetchedWindow(existing: any[], fetched: any[], limit: number, dedupText: (c: string) => string): any[] {
  if (fetched.length === 0) return existing;
  const fetchedById = new Map(fetched.map((m) => [String(m.msg_id), m]));
  const existingById = new Map(existing.map((m) => [String(m.msg_id), m]));
  const existingIds = new Set(existingById.keys());
  const oldest = fetched.reduce((min, m) => ((m.timestamp || 0) < (min.timestamp || 0) ? m : min));
  const continuous = fetched.length < limit || existingIds.has(String(oldest.msg_id));
  if (continuous) {
    const updated = dropSettledPending(existing, fetched, existingIds, dedupText).map((m) => {
      const f = fetchedById.get(String(m.msg_id));
      return f ? mergeRow(m, f) : m;
    });
    return [...updated, ...fetched.filter((m) => !existingIds.has(String(m.msg_id)))].sort(byTimestamp);
  }
  const newestFetched = fetched.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
  const newerLive = existing.filter((m) => !isPendingRow(m) && !fetchedById.has(String(m.msg_id)) && (m.timestamp || 0) > newestFetched);
  const pending = dropSettledPending(existing.filter(isPendingRow), fetched, existingIds, dedupText);
  const window = fetched.map((f) => { const l = existingById.get(String(f.msg_id)); return l ? mergeRow(l, f) : f; });
  return [...pending, ...window, ...newerLive].sort(byTimestamp);
}

/** Bỏ tín hiệu chỉ khi CẢ HAI id đều biết và khác nhau; thiếu một bên thì xử lý như bình thường. */
export function shouldIgnoreResyncSignal(payloadWorkspaceId: unknown, activeWorkspaceId: string): boolean {
  return typeof payloadWorkspaceId === 'string' && payloadWorkspaceId !== '' && activeWorkspaceId !== '' && payloadWorkspaceId !== activeWorkspaceId;
}

export interface ResyncDeps {
  accountIds: () => string[];
  activeAccountId: () => string | null;
  activeThreadId: () => string | null;
  activeTopicId: () => string | null;
  /** Chốt phiên đăng nhập hiện tại; hàm trả về cho biết phiên đó còn hiện hành không (đăng xuất / đổi workspace thì false). */
  captureSession: () => () => boolean;
  isWindowFocused: () => boolean;
  /** Xoá số chưa đọc của hội thoại đang mở như một cú nhấp vào nó. */
  markOpenThreadRead: (accountId: string, threadId: string) => void;
  loadConversations: (accountId: string, shouldWrite: () => boolean) => Promise<void>;
  loadMessages: (accountId: string, threadId: string, topicId: string | null) => Promise<any[]>;
  mergeMessages: (accountId: string, threadId: string, fetched: any[], topicId: string | null) => void;
  setStatus: (s: { running: boolean; failed?: boolean }) => void;
}

/** Một lượt tải lại: lỗi ở một bước không dừng các bước khác; kết thúc báo failed nếu có bước lỗi. Phiên đổi giữa chừng thì dừng, không ghi gì và về trạng thái nghỉ. */
export async function runResync(deps: ResyncDeps): Promise<void> {
  deps.setStatus({ running: true });
  const sessionOk = deps.captureSession();
  // Chốt tài khoản + hội thoại + topic đang mở ngay từ đầu để không ghép nhầm sau khi người dùng chuyển
  const capturedAccount = deps.activeAccountId();
  const capturedThread = deps.activeThreadId();
  const capturedTopic = deps.activeTopicId();
  const steps = resyncSteps({ accountIds: deps.accountIds(), activeAccountId: capturedAccount, activeThreadId: capturedThread });
  let failed = false;
  for (const step of steps) {
    if (!sessionOk()) break;
    if (!deps.accountIds().includes(step.accountId)) continue; // tài khoản đã bị gỡ giữa chừng
    try {
      if (step.kind === 'conversations') {
        await deps.loadConversations(step.accountId, sessionOk);
      } else {
        const stillOpenNow = () => deps.activeAccountId() === step.accountId && deps.activeThreadId() === step.threadId;
        // Cuộc hội thoại đang đọc không được hiện số chưa đọc do tải lại (cửa sổ phải đang được chú ý, như khi nhấp vào)
        if (sessionOk() && stillOpenNow() && deps.isWindowFocused()) deps.markOpenThreadRead(step.accountId, step.threadId);
        const fetched = await deps.loadMessages(step.accountId, step.threadId, capturedTopic);
        const stillOpen = sessionOk() && stillOpenNow() && deps.activeTopicId() === capturedTopic;
        if (stillOpen && fetched.length > 0) deps.mergeMessages(step.accountId, step.threadId, fetched, capturedTopic);
      }
    } catch {
      failed = true;
    }
  }
  deps.setStatus(sessionOk() ? { running: false, failed } : { running: false, failed: false });
}
