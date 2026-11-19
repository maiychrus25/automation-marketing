// Ghép hội thoại trong tệp xuất với hội thoại trên máy, nhận ra "tôi", ánh xạ người gửi, chống trùng, mã tin ổn định. Thuần, không I/O.
import { createHash } from 'crypto';
import { IMPORTED_MESSAGE_ID_PREFIX, isImportedSenderId } from './importedMessage';
import type { ExportChat, ExportMessage } from './exportParser';

// Đo trên tệp thật: mọi cặp trùng lệch dưới 1 s; tin gửi từ MaiHub không có trong tệp. Cửa sổ hẹp để không ghép nhầm tin giống nhau.
export const PAIR_WINDOW_MS = 5_000;
const MIN_SINGLE_PAIR_CHARS = 6;

export interface LocalMessageRow {
  id: string; thread_id: string; sender_id: string; sender_name: string; body: string | null;
  timestamp: number; is_self: number; is_unsent: number; type: string;
}
export interface MessagePair { exportIndex: number; local: LocalMessageRow }
export interface ThreadMatch { threadId: string; score: number; pairs: MessagePair[]; bestText: string }

export const normalizeText = (s: unknown): string => (typeof s === 'string' ? s.normalize('NFC').trim().replace(/\s+/g, ' ') : '');

/**
 * Ghép một-một theo thời điểm, cặp gần nhau nhất trước. `localTs` phải tăng dần.
 * shortcut: quét cửa sổ ±60 s theo chỉ số, đủ nhanh vì hội thoại hiếm khi dồn quá vài chục tin trong 1 phút.
 */
function pairNearest(exportTs: number[], localTs: number[], accept: (e: number, l: number) => boolean): Array<[number, number]> {
  const edges: Array<[number, number, number]> = [];
  exportTs.forEach((ts, e) => {
    let lo = 0, hi = localTs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (localTs[mid] < ts - PAIR_WINDOW_MS) lo = mid + 1; else hi = mid; }
    for (let l = lo; l < localTs.length && localTs[l] <= ts + PAIR_WINDOW_MS; l++) if (accept(e, l)) edges.push([Math.abs(localTs[l] - ts), e, l]);
  });
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const usedE = new Set<number>(), usedL = new Set<number>(), out: Array<[number, number]> = [];
  for (const [, e, l] of edges) {
    if (usedE.has(e) || usedL.has(l)) continue;
    usedE.add(e); usedL.add(l); out.push([e, l]);
  }
  return out;
}

/** Hàng cục bộ gom theo hội thoại, chuẩn hoá chữ một lần (dùng lại cho mọi hội thoại trong tệp). `rows` đã sắp xếp theo thời điểm. */
export interface LocalIndex { byThread: Map<string, { rows: LocalMessageRow[]; norm: string[]; ts: number[] }> }
export function buildLocalIndex(local: LocalMessageRow[]): LocalIndex {
  const byThread: LocalIndex['byThread'] = new Map();
  for (const r of local) {
    const entry = byThread.get(r.thread_id) ?? byThread.set(r.thread_id, { rows: [], norm: [], ts: [] }).get(r.thread_id)!;
    entry.rows.push(r); entry.norm.push(normalizeText(r.body)); entry.ts.push(r.timestamp);
  }
  return { byThread };
}

/** `local` đã sắp xếp theo thời điểm. null = không ghép được (thiếu chắc chắn). */
export function matchChatToThread(chat: ExportChat, local: LocalMessageRow[] | LocalIndex): ThreadMatch | null {
  const index = Array.isArray(local) ? buildLocalIndex(local) : local;
  const eNorm = chat.messages.map(m => normalizeText(m.text));
  const eTs = chat.messages.map(m => m.timestamp);
  // Mỗi hội thoại trên máy được ghép riêng (một-một trong hội thoại đó) để điểm của các hội thoại có thể so sánh.
  const byThread = new Map<string, MessagePair[]>();
  for (const [threadId, { rows, norm, ts }] of index.byThread) {
    const pairs = pairNearest(eTs, ts, (e, l) => !!eNorm[e] && eNorm[e] === norm[l]);
    if (pairs.length) byThread.set(threadId, pairs.map(([e, l]) => ({ exportIndex: e, local: rows[l] })));
  }
  const ranked = [...byThread.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!ranked.length) return null;
  const [threadId, best] = ranked[0];
  const runnerUp = ranked[1]?.[1].length ?? 0;
  const bestText = eNorm[best[0].exportIndex];
  const ok = best.length >= 2 ? runnerUp * 2 <= best.length : runnerUp === 0 && bestText.length >= MIN_SINGLE_PAIR_CHARS;
  if (!ok || !coversReceivedText(chat, index.byThread.get(threadId)!, best)) return null;
  return { threadId, score: best.length, pairs: best, bestText };
}

/**
 * Điều kiện phủ: trong khoảng thời gian của hội thoại trong tệp, ít nhất một nửa số tin chữ nhận về (chưa thu hồi) của hội thoại
 * trên máy phải có cặp. Tin gửi từ MaiHub (is_self = 1) không nằm trong tệp nên không tính.
 */
function coversReceivedText(chat: ExportChat, thread: { rows: LocalMessageRow[]; norm: string[] }, pairs: MessagePair[]): boolean {
  const from = chat.messages[0].timestamp - PAIR_WINDOW_MS;
  const to = chat.messages[chat.messages.length - 1].timestamp + PAIR_WINDOW_MS;
  const inR = (r: LocalMessageRow, norm: string) => r.is_self === 0 && r.is_unsent === 0 && r.type === 'text' && !!norm && r.timestamp >= from && r.timestamp <= to;
  let received = 0;
  thread.rows.forEach((r, i) => { if (inR(r, thread.norm[i])) received++; });
  if (!received) return false; // phải có ít nhất một tin chữ nhận về trùng nhau: chỉ trùng tin của chính tài khoản có thể là chữ của người kia
  const paired = pairs.filter(p => inR(p.local, normalizeText(p.local.body))).length;
  return paired >= Math.ceil(received / 2);
}

/** Hai hội thoại trong tệp không được trùng một hội thoại trên máy: giữ điểm cao hơn; hoà thì bỏ cả hai. */
export function resolveThreadConflicts(matches: Array<ThreadMatch | null>): Array<ThreadMatch | null> {
  return matches.map((m, i) => {
    if (!m) return null;
    const rivals = matches.filter((o, j) => j !== i && o?.threadId === m.threadId);
    return rivals.every(o => o!.score < m.score) ? m : null;
  });
}

/** Tên (đã chuẩn hoá) của tài khoản trong tệp; null = chưa biết. */
export function identifySelf(input: { chat: ExportChat; pairs: MessagePair[]; isGroup: boolean; accountName: string }): string | null {
  const { chat, pairs, isGroup, accountName } = input;
  const participants = chat.participants.map(normalizeText);
  const nameOf = (p: MessagePair) => normalizeText(chat.messages[p.exportIndex].senderName);
  // Mỗi cặp là một phiếu: khớp tin gửi đi = thuận cho tên đó, khớp tin nhận về = nghịch.
  const votes = new Map<string, { for: number; against: number }>();
  for (const p of pairs) {
    const v = votes.get(nameOf(p)) ?? votes.set(nameOf(p), { for: 0, against: 0 }).get(nameOf(p))!;
    if (p.local.is_self === 1) v.for++; else v.against++;
  }
  const qualified = [...votes.entries()].filter(([name, v]) => v.for > v.against && (!participants.length || participants.includes(name)))
    .sort((a, b) => b[1].for - a[1].for);
  if (qualified.length && (qualified.length === 1 || qualified[0][1].for > qualified[1][1].for)) return qualified[0][0];

  if (!isGroup && participants.length === 2) {
    const counts = new Map<string, number>();
    for (const p of pairs) if (p.local.is_self !== 1) counts.set(nameOf(p), (counts.get(nameOf(p)) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const received = sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null;
    const other = participants.find(p => p !== received);
    return received && participants.includes(received) && other ? other : null;
  }
  const account = normalizeText(accountName);
  const accountVotes = votes.get(account);
  if (accountVotes && accountVotes.against >= accountVotes.for) return null; // chính tên đó bị phiếu nghịch: không tin tên hiển thị
  return account && participants.includes(account) ? account : null;
}

export interface SenderResolver { isSelf(name: string): boolean; senderIdFor(name: string): string }

export function createSenderResolver(input: {
  chat: ExportChat; pairs: MessagePair[]; threadRows: LocalMessageRow[]; threadId: string; isGroup: boolean; selfName: string | null; ownerId: string;
}): SenderResolver {
  const { chat, pairs, threadRows, threadId, isGroup, selfName, ownerId } = input;
  const ids = new Map<string, Set<string>>();
  const learn = (name: string, id: string) => {
    const key = normalizeText(name);
    if (!key || !id || isImportedSenderId(id)) return; // mã `e2ee-name:` không phải mã Facebook thật
    (ids.get(key) ?? ids.set(key, new Set()).get(key)!).add(id);
  };
  for (const p of pairs) if (p.local.is_self !== 1) learn(chat.messages[p.exportIndex].senderName, p.local.sender_id);
  if (isGroup) for (const r of threadRows) if (r.is_self !== 1) learn(r.sender_name, r.sender_id);
  const participants = chat.participants.map(normalizeText);
  const isSelf = (name: string) => selfName !== null && normalizeText(name) === selfName;
  return {
    isSelf,
    senderIdFor(name: string) {
      if (isSelf(name)) return ownerId;
      // chat 1-1: người còn lại (có trong danh sách người tham gia) có id trùng id hội thoại
      if (!isGroup && selfName !== null && (!participants.length || participants.includes(normalizeText(name)))) return threadId;
      const found = ids.get(normalizeText(name));
      return found?.size === 1 ? [...found][0] : '';
    },
  };
}

/** Chỉ số các tin trong tệp đã có trên máy (hai lượt, ghép một-một). `local` chỉ gồm hàng của hội thoại đã ghép. */
export function findPresentMessages(chat: ExportChat, local: LocalMessageRow[], selfName: string | null): Set<number> {
  const rows = [...local].sort((a, b) => a.timestamp - b.timestamp);
  const ts = rows.map(r => r.timestamp);
  const sameDirection = (e: ExportMessage, l: LocalMessageRow) => selfName === null || (normalizeText(e.senderName) === selfName) === (l.is_self === 1);
  const present = new Set<number>();
  const usedLocal = new Set<number>();
  const run = (candidates: number[], accept: (e: number, l: number) => boolean) => {
    const sub = candidates.map(i => chat.messages[i].timestamp);
    for (const [c, l] of pairNearest(sub, ts, (c, l) => !usedLocal.has(l) && accept(candidates[c], l))) { present.add(candidates[c]); usedLocal.add(l); }
  };
  const indexes = chat.messages.map((_, i) => i);
  run(indexes.filter(i => normalizeText(chat.messages[i].text)), (e, l) =>
    normalizeText(chat.messages[e].text) === normalizeText(rows[l].body) && sameDirection(chat.messages[e], rows[l]));
  run(indexes.filter(i => !normalizeText(chat.messages[i].text)), (e, l) =>
    sameDirection(chat.messages[e], rows[l]) && (!normalizeText(rows[l].body) || rows[l].is_unsent === 1 || rows[l].type !== 'text'));
  return present;
}

/** Mã không bao giờ bắt đầu bằng "mid." nên hội thoại mã hoá vẫn nhận ra là mã hoá. */
export function stableMessageIds(accountId: string, threadId: string, messages: ExportMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map(m => {
    const tuple = JSON.stringify([accountId, threadId, m.timestamp, m.senderName, normalizeText(m.text)]);
    const n = seen.get(tuple) ?? 0;
    seen.set(tuple, n + 1);
    return IMPORTED_MESSAGE_ID_PREFIX + createHash('sha256').update(JSON.stringify([tuple, n])).digest('hex').slice(0, 32);
  });
}
