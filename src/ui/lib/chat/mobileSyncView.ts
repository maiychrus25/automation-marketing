// Hàm thuần cho hộp thoại "Đồng bộ tin nhắn từ điện thoại" (không phụ thuộc React/IPC).
import type { MobileSyncStatus } from '../../../services/zalo/mobileSync/types';

export type SyncPreset = 'week' | 'custom' | 'all';

const DAY_START = (y: number, m: number, d: number) => new Date(y, m, d, 0, 0, 0, 0).getTime();

function parseDate(value: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(y, mo, d); // round-trip: loại ngày không có thật (31/02...)
  return check.getFullYear() === y && check.getMonth() === mo && check.getDate() === d ? [y, mo, d] : null;
}

export function resolveSyncRange(
  preset: SyncPreset, fromDate: string, toDate: string, now: number,
): { fromTs: number | null; toTs: number | null } | { error: string } {
  if (preset === 'all') return { fromTs: null, toTs: null };
  if (preset === 'week') {
    const d = new Date(now);
    return { fromTs: DAY_START(d.getFullYear(), d.getMonth(), d.getDate() - 7), toTs: null };
  }
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return { error: 'Chọn đủ ngày bắt đầu và ngày kết thúc' };
  const fromTs = DAY_START(...from);
  const toTs = new Date(to[0], to[1], to[2], 23, 59, 59, 999).getTime();
  if (fromTs > toTs) return { error: 'Ngày bắt đầu phải trước ngày kết thúc' };
  return { fromTs, toTs };
}

/** Bước 0–4 trong danh sách năm bước; -1 khi chưa chạy hoặc đã xong. */
export function mobileSyncStep(stage: string | null | undefined): number {
  switch (stage) {
    case 'requesting': case 'waiting_confirm': return 0;
    case 'waiting_backup': case 'mobile_idle': return 1;
    case 'downloading': return 2;
    case 'decrypting': return 3;
    case 'resolving_ids': case 'importing': return 4;
    default: return -1;
  }
}

export function isMobileSyncRunning(stage: string | null | undefined): boolean {
  return mobileSyncStep(stage) >= 0;
}

export function isMobileSyncTerminal(stage: string | null | undefined): boolean {
  return stage === 'completed' || stage === 'failed' || stage === 'cancelled';
}

export function mobileSyncNotes(stats: Partial<Record<string, number>> | null | undefined): string[] {
  if (!stats) return [];
  const notes: string[] = [];
  if ((stats.messagesSkipped ?? 0) > 0) notes.push(`Bỏ qua ${stats.messagesSkipped} tin đã có hoặc không hỗ trợ`);
  if ((stats.conversationsUnresolved ?? 0) > 0) notes.push(`${stats.conversationsUnresolved} hội thoại không còn truy cập được`);
  if ((stats.messagesOutOfRange ?? 0) > 0) notes.push(`${stats.messagesOutOfRange} tin ngoài khoảng đã chọn`);
  if ((stats.conversationsFailed ?? 0) > 0) notes.push(`${stats.conversationsFailed} hội thoại không đọc được`);
  return notes;
}

/** Giữ trạng thái mới nhất của từng tài khoản; phiên chạy mới hơn (startedAt) luôn thắng, cùng phiên thì updatedAt. */
export function reduceMobileSyncStatus(
  map: Record<string, MobileSyncStatus>, next: MobileSyncStatus,
): Record<string, MobileSyncStatus> {
  const cur = map[next.zaloId];
  if (cur) {
    const cs = cur.startedAt ?? 0;
    const ns = next.startedAt ?? 0;
    if (ns < cs || (ns === cs && next.updatedAt < cur.updatedAt)) return map;
  }
  return { ...map, [next.zaloId]: next };
}

/** Quyết định thông báo / làm mới khi nhận trạng thái; `handledKey` là khoá phiên đã xử lý trước đó.
 *  Hộp thoại chỉ "đang hiện phiên này" khi mở và đang chọn đúng tài khoản của phiên. */
export function terminalEffects(
  status: MobileSyncStatus,
  view: { open: boolean; activeAccountId: string | null },
  handledKey: string | null,
): { key: string | null; notify: boolean; refresh: boolean } {
  if (!isMobileSyncTerminal(status.stage)) return { key: null, notify: false, refresh: false };
  const key = `${status.zaloId}:${status.startedAt ?? 0}:${status.stage}`;
  if (key === handledKey) return { key, notify: false, refresh: false };
  const showingThisRun = view.open && view.activeAccountId === status.zaloId;
  return {
    key,
    notify: !showingThisRun && (status.stage === 'completed' || status.stage === 'failed'),
    refresh: status.stage === 'completed',
  };
}

interface ThreadMessageLike { msg_id: string | number; timestamp: number }

/** Gộp tin DB vào tin đang có: giữ nguyên mọi dòng hiện có (kể cả tin đang gửi/temp), chỉ thêm dòng mới theo msg_id.
 *  Không có gì mới thì trả đúng mảng cũ (không render lại, không nhảy cuộn). */
export function mergeThreadMessages<T extends ThreadMessageLike>(existing: T[], fetched: T[]): T[] {
  const seen = new Set(existing.map(m => String(m.msg_id)));
  const added = fetched.filter(m => !seen.has(String(m.msg_id)));
  if (added.length === 0) return existing;
  return [...existing, ...added].sort((a, b) => a.timestamp - b.timestamp);
}

/** Làm mới danh sách hội thoại của tài khoản vừa xong; chỉ làm mới hội thoại đang mở khi cùng tài khoản đang chọn. */
export function refreshPlan(
  finishedZaloId: string, activeAccountId: string | null, activeThreadId: string | null,
): { list: boolean; thread: boolean } {
  return { list: true, thread: activeAccountId === finishedZaloId && !!activeThreadId };
}

/** Chỉ chặn Tab khi cần quay vòng: trả về chỉ số phần tử cần focus, hoặc null = để trình duyệt tự xử lý
 *  (giữ nguyên thứ tự Tab và các ô ngày nhiều đoạn). active = -1: focus đang ở hộp thoại/ngoài danh sách; danh sách rỗng → -1 (giữ focus ở hộp thoại). */
export function nextFocusIndex(count: number, active: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (active < 0) return shift ? count - 1 : null;
  if (!shift && active === count - 1) return 0;
  if (shift && active === 0) return count - 1;
  return null;
}

export interface FocusableDescriptor { isRadio: boolean; checked: boolean; disabled: boolean; group?: string }

/** Chỉ số các điểm dừng Tab như trình duyệt: bỏ phần tử bị vô hiệu và radio chưa chọn khi nhóm của nó đã có radio được chọn. */
export function tabStopIndexes(items: FocusableDescriptor[]): number[] {
  const checkedGroups = new Set(items.filter(i => i.isRadio && i.checked && !i.disabled).map(i => i.group ?? ''));
  const out: number[] = [];
  items.forEach((i, idx) => {
    if (i.disabled) return;
    if (i.isRadio && !i.checked && checkedGroups.has(i.group ?? '')) return;
    out.push(idx);
  });
  return out;
}
