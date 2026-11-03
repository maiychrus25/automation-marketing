/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { Page } from 'playwright-core';
import type { TaskDeps } from './types';
import { commentTypedInPage, freePointOnBoxInPage, markCommentSendButtonInPage, matchSnippet, SEND_COMMENT_LABELS } from './firstComment';
import { clickLabelInPage, MORE_COMMENTS, SORT_ALL, SORT_TRIGGER } from './collectComments';

/**
 * Trả lời MỘT bình luận cụ thể bằng câu anh đã duyệt (spec 2026-11-02 §8). Chỉ dùng cho EngagementPoster.
 *
 * ĐO trên trang bài thật 2026-11-02 (anh bấm "Trả lời" và gõ vài chữ, chưa gửi; chỉ đọc cấu trúc):
 * - Khối bình luận: div[role="article"], aria-label "Bình luận dưới tên <tác giả> <thời gian>"; các khối KHÔNG lồng nhau.
 * - Mỗi khối có link avatar + link tên mang ?comment_id=<base64 "comment:<bài>_<bình luận>"> và link thời gian
 *   ?comment_id=<số>; cả hai dạng chỉ cùng một bình luận.
 * - Nút "Trả lời" nằm TRONG khối. Bấm xong, ô trả lời (contenteditable, role="textbox", aria-placeholder
 *   "Bình luận dưới tên <Trang>") hiện NGOÀI khối: sau chuỗi của bình luận đó, trước bình luận kế tiếp. Nút gửi
 *   "Đăng bình luận" nằm cạnh ô.
 * - CHƯA ĐO khối câu trả lời đã đăng, nên đọc lại không dựa vào nhãn của nó: chỉ dựa vào vị trí (sau bình luận được trả
 *   lời, trước bình luận kế tiếp đã ghi mốc) và đúng đoạn chữ vừa gửi.
 *
 * Không ném lỗi. `sent` chỉ true từ lúc thử bấm nút gửi (như CommentOutcome); không bao giờ gửi lại bằng Enter.
 */

export type ReplyStatus = 'posted' | 'target_not_found' | 'post_not_found' | 'failed';
export interface ReplyOutcome { status: ReplyStatus; reason: string; sent?: boolean }
export interface ReplyTarget { commentId?: string; author?: string; excerpt?: string }

/** Một khối bình luận hoặc ô nhập, theo thứ tự trong trang (thứ tự của readReplySnapshotInPage). */
export interface ReplySnapshotItem {
  kind: 'article' | 'box';
  label: string;
  /** innerText của khối trừ chữ trong các ô nhập con (ô nhập: rỗng). */
  text: string;
  /** Giá trị comment_id / reply_comment_id thô trên các link thuộc chính khối. */
  commentIds: string[];
  /** Khối là câu trả lời (có link riêng mang reply_comment_id), không phải bình luận đầu chuỗi. */
  isReply: boolean;
  /** Ô nhập nằm bên trong một khối bình luận (không phải ô trả lời như đo được). */
  inArticle: boolean;
  /** Ô nhập đã có trước khi bấm "Trả lời". */
  seen: boolean;
}

export const REPLY_OPEN_LABELS = ['Trả lời', 'Reply'];
const COMMENT_LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
const REPLY_BOX_MARK = 'data-maihub-reply-box';
const SEEN_BOX_MARK = 'data-maihub-box-seen';
const POST_PAGE = /\/posts\/|story_fbid=|\/permalink|\/photo/;

// ---------------------------------------------------------------------------
// Hàm thuần: chọn bình luận, ô trả lời và xác nhận trên snapshot. Test được không cần trình duyệt.
// ---------------------------------------------------------------------------

const norm = (s: unknown) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Id bình luận dạng số từ "9102", "90000_9102", "comment:90000_9102" hoặc base64 của dạng sau cùng; không đọc được → null. */
export function commentIdKey(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  const plain = /^(?:comment:)?(?:\d+_)?(\d+)$/.exec(s);
  if (plain) return plain[1];
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const decoded = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return /^comment:(?:\d+_)?(\d+)$/.exec(decoded)?.[1] ?? null;
}

/** Đúng một khối bình luận khớp: theo id nếu có, không thì tác giả (trong nhãn) + trích đoạn (đầu đoạn) cùng khớp. */
export function findReplyTarget(items: ReplySnapshotItem[], target: ReplyTarget): { index: number } | { error: 'none' | 'many' } {
  const wantedId = target.commentId?.trim() ? commentIdKey(target.commentId) : null;
  if (target.commentId?.trim() && !wantedId) return { error: 'none' }; // id lạ: không đoán bằng tác giả
  const author = norm(target.author);
  const excerpt = norm(matchSnippet(target.excerpt));
  if (!wantedId && !(author && excerpt)) return { error: 'none' };
  const hits: number[] = [];
  items.forEach((it, i) => {
    if (it.kind !== 'article' || !COMMENT_LABEL.test(it.label)) return;
    const ok = wantedId
      ? it.commentIds.some((c) => commentIdKey(c) === wantedId)
      : ` ${norm(it.label)} `.includes(` ${author} `) && norm(it.text).includes(excerpt);
    if (ok) hits.push(i);
  });
  if (hits.length === 1) return { index: hits[0] };
  return { error: hits.length ? 'many' : 'none' };
}

/** Chỉ số bình luận đầu chuỗi kế tiếp (không phải câu trả lời) sau bình luận được trả lời; -1 = không còn. */
function nextHeadIndex(items: ReplySnapshotItem[], targetIndex: number): number {
  return items.findIndex((it, i) => i > targetIndex && it.kind === 'article' && !it.isReply && COMMENT_LABEL.test(it.label));
}

/**
 * Ô nhập mới (không có trước khi bấm) duy nhất nằm trong chuỗi của bình luận được trả lời: sau bình luận đó và trước
 * bình luận đầu chuỗi kế tiếp. Không có bình luận đầu chuỗi kế tiếp thì không có ranh giới: ô cấp bài nạp muộn cũng
 * nằm "sau" bình luận cuối, nên không nhận ô nào.
 */
export function findNewReplyBox(items: ReplySnapshotItem[], targetIndex: number): { index: number } | { error: 'none' | 'many' } {
  const head = nextHeadIndex(items, targetIndex);
  if (head < 0) return { error: 'none' };
  const fresh = items.map((it, i) => (it.kind === 'box' && !it.seen && !it.inArticle && i > targetIndex && i < head ? i : -1)).filter((i) => i >= 0);
  if (fresh.length === 1) return { index: fresh[0] };
  return { error: fresh.length ? 'many' : 'none' };
}

/** Id của bình luận đầu chuỗi kế tiếp sau bình luận được trả lời (mốc cuối chuỗi); null = không còn bình luận nào sau đó. */
export function replyBoundary(items: ReplySnapshotItem[], targetIndex: number): string[] | null {
  const head = nextHeadIndex(items, targetIndex);
  if (head < 0) return null;
  return [...new Set(items[head].commentIds.map(commentIdKey).filter((k): k is string => !!k))];
}

/**
 * Số khối (trừ chính bình luận được trả lời) chứa đoạn chữ, nằm sau bình luận đó và trước mốc.
 * null = không xác định được (mất bình luận, mất mốc, mốc không có id) — không mở rộng tới cuối trang để khỏi đếm nhầm chỗ khác.
 */
export function threadMatchCount(items: ReplySnapshotItem[], target: ReplyTarget, boundary: string[] | null, snippet: string): number | null {
  const found = findReplyTarget(items, target);
  const needle = norm(snippet);
  if (!('index' in found) || !needle) return null;
  let end = items.length;
  if (boundary) {
    end = items.findIndex((it, i) => i > found.index && it.kind === 'article' && it.commentIds.some((c) => boundary.includes(commentIdKey(c) ?? '')));
    if (end < 0) return null;
  }
  return items.slice(found.index + 1, end).filter((it) => it.kind === 'article' && norm(it.text).includes(needle)).length;
}

/** Đọc lại sau khi gửi: số khối chứa câu trả lời trong chuỗi của đúng bình luận đó phải tăng. */
export function confirmReply(items: ReplySnapshotItem[], target: ReplyTarget, boundary: string[] | null, snippet: string, before: number): { ok: boolean; reason: string } {
  const count = threadMatchCount(items, target, boundary, snippet);
  if (count === null) return { ok: false, reason: 'Sau khi gửi không xác định lại được bình luận được trả lời hoặc bình luận kế tiếp — không xác minh được.' };
  if (count <= before) return { ok: false, reason: 'Không thấy câu trả lời mới dưới đúng bình luận.' };
  return { ok: true, reason: 'Đã trả lời và thấy câu trả lời dưới đúng bình luận.' };
}

// ---------------------------------------------------------------------------
// Hàm CHẠY TRONG TRÌNH DUYỆT (page.evaluate): không thấy biến ngoài, mọi hằng lặp lại bên trong.
// Cùng một bộ chọn, nên chỉ số trong snapshot khớp chỉ số ở các hàm đánh dấu; hàm đánh dấu kiểm lại phần tử trước khi đánh dấu.
// ---------------------------------------------------------------------------

export function readReplySnapshotInPage(seenMark: string): ReplySnapshotItem[] {
  const out: ReplySnapshotItem[] = [];
  for (const el of Array.from(document.querySelectorAll('div[role="article"], [role="textbox"][contenteditable="true"]'))) {
    if (el.getAttribute('role') !== 'article') {
      const inArticle = !!el.parentElement?.closest('div[role="article"]');
      out.push({ kind: 'box', label: el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || '', text: '', commentIds: [], isReply: false, inArticle, seen: el.hasAttribute(seenMark) });
      continue;
    }
    const ids: string[] = [];
    let isReply = false;
    for (const a of Array.from(el.querySelectorAll('a[href*="comment_id="]'))) {
      if (a.closest('div[role="article"]') !== el) continue;
      try {
        const q = new URL(a.getAttribute('href') || '', 'https://www.facebook.com/').searchParams;
        // Link của câu trả lời mang cả comment_id của bình luận cha: lấy reply_comment_id để không nhận nhầm là cha.
        const id = q.get('reply_comment_id') || q.get('comment_id');
        if (q.get('reply_comment_id')) isReply = true;
        if (id && !ids.includes(id)) ids.push(id);
      } catch { /* bad href */ }
    }
    // Chữ đang gõ dở trong ô nhập con không phải bình luận đã đăng: bỏ ra để không bao giờ được đọc lại là "đã lên".
    let text = String((el as HTMLElement).innerText || '');
    for (const e of Array.from(el.querySelectorAll('[contenteditable="true"]'))) {
      const typed = String((e as HTMLElement).innerText || '');
      if (typed) text = text.split(typed).join(' ');
    }
    out.push({ kind: 'article', label: el.getAttribute('aria-label') || '', text: text.slice(0, 4000), commentIds: ids, isReply, inArticle: false, seen: false });
  }
  return out;
}

/** Đánh dấu mọi ô nhập đang có, để sau khi bấm "Trả lời" biết ô nào mới hiện. */
export function markSeenBoxesInPage(seenMark: string): number {
  const boxes = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'));
  for (const b of boxes) b.setAttribute(seenMark, '1');
  return boxes.length;
}

/**
 * Đánh dấu nút "Trả lời" của CHÍNH khối thứ `index` (không phải của khối con). Khối phải còn đúng nhãn, và đủ các id đã
 * chọn khi có id. Trả 'ids' (đã đối chiếu id), 'label' (khối không có id: chỉ đối chiếu được nhãn) hoặc false.
 */
export function markReplyButtonInPage({ index, label, commentIds, labels }: { index: number; label: string; commentIds: string[]; labels: string[] }): 'ids' | 'label' | false {
  const isVisible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  document.querySelectorAll('[data-maihub-target]').forEach((e) => e.removeAttribute('data-maihub-target'));
  const el = Array.from(document.querySelectorAll('div[role="article"], [role="textbox"][contenteditable="true"]'))[index];
  if (!el || el.getAttribute('role') !== 'article' || (el.getAttribute('aria-label') || '') !== label) return false;
  // Hai bình luận cùng tác giả có cùng nhãn: chỉ số lệch một vẫn qua được nhãn, nên đối chiếu cả id.
  const own: string[] = [];
  for (const a of Array.from(el.querySelectorAll('a[href*="comment_id="]'))) {
    if (a.closest('div[role="article"]') !== el) continue;
    try {
      const q = new URL(a.getAttribute('href') || '', 'https://www.facebook.com/').searchParams;
      const id = q.get('reply_comment_id') || q.get('comment_id');
      if (id) own.push(id);
    } catch { /* bad href */ }
  }
  const idsChecked = commentIds.length > 0;
  if (idsChecked && !commentIds.every((id) => own.includes(id))) return false;
  const button = Array.from(el.querySelectorAll('div[role="button"], span[role="button"], button'))
    .filter((b) => b.closest('div[role="article"]') === el)
    .filter(isVisible)
    .find((b) => labels.includes(String(b.getAttribute('aria-label') || (b as HTMLElement).innerText || '').trim()));
  if (!button) return false;
  button.setAttribute('data-maihub-target', 'reply-open');
  return idsChecked ? 'ids' : 'label';
}

/**
 * Đánh dấu ô nhập thứ `index` để gõ. Kiểm lại NGAY trong trang (DOM có thể đổi sau lần đọc snapshot): ô mới, không nằm
 * trong khối bình luận, và vẫn nằm sau khối mang `targetIds` và trước khối mang `headIds` (bình luận đầu chuỗi kế tiếp).
 */
export function markReplyBoxInPage({ index, mark, seenMark, targetIds, headIds }: { index: number; mark: string; seenMark: string; targetIds: string[]; headIds: string[] }): boolean {
  const list = Array.from(document.querySelectorAll('div[role="article"], [role="textbox"][contenteditable="true"]'));
  const el = list[index];
  if (!el || el.getAttribute('role') !== 'textbox' || el.hasAttribute(seenMark) || el.parentElement?.closest('div[role="article"]')) return false;
  const ownIds = (art: Element): string[] => {
    const ids: string[] = [];
    for (const a of Array.from(art.querySelectorAll('a[href*="comment_id="]'))) {
      if (a.closest('div[role="article"]') !== art) continue;
      try {
        const q = new URL(a.getAttribute('href') || '', 'https://www.facebook.com/').searchParams;
        const id = q.get('reply_comment_id') || q.get('comment_id');
        if (id) ids.push(id);
      } catch { /* bad href */ }
    }
    return ids;
  };
  const at = (ids: string[]) => (ids.length ? list.findIndex((x) => x.getAttribute('role') === 'article' && ids.every((id) => ownIds(x).includes(id))) : -1);
  const from = at(targetIds);
  const to = at(headIds);
  if (from < 0 || to < 0 || !(from < index && index < to)) return false;
  el.scrollIntoView({ block: 'center' });
  el.setAttribute(mark, '1');
  return true;
}

export function clearReplyMarksInPage(marks: string[]): void {
  for (const m of marks.concat('data-maihub-target')) {
    for (const e of Array.from(document.querySelectorAll(`[${m}]`))) e.removeAttribute(m);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function postCommentReply(
  page: Page,
  input: { postUrl: string; target: ReplyTarget; text: string },
  deps: { sendLog?: TaskDeps['sendLog']; getIsStopping?: () => boolean } = {},
): Promise<ReplyOutcome> {
  const { sendLog = () => {}, getIsStopping = () => false } = deps;
  const { postUrl, target } = input;
  const body = String(input.text ?? '').trim();
  const snippet = matchSnippet(body);
  const done = (o: ReplyOutcome): ReplyOutcome => { sendLog(`[Trả lời bình luận] ${o.reason}`, o.status === 'posted' ? 'success' : 'warning'); return o; };
  if (!body) return done({ status: 'failed', reason: 'Không có nội dung trả lời.' });
  if (!target.commentId?.trim() && !(target.author?.trim() && target.excerpt?.trim())) {
    return done({ status: 'target_not_found', reason: 'Thiếu id bình luận hoặc tác giả + trích đoạn để tìm bình luận.' });
  }

  let sendAttempted = false;
  const result = (o: ReplyOutcome): ReplyOutcome => done(sendAttempted ? { ...o, sent: true } : o);
  const stopped = () => result({ status: 'failed', reason: 'Đã huỷ giữa chừng.' });
  const snap = (): Promise<ReplySnapshotItem[]> => page.evaluate(readReplySnapshotInPage, SEEN_BOX_MARK);
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    if (getIsStopping()) return stopped();
    if (!POST_PAGE.test(page.url())) return result({ status: 'post_not_found', reason: 'Mở link nhưng bị chuyển khỏi trang bài — bài có thể đã bị gỡ hoặc giới hạn xem. Chưa trả lời.' });

    // Bình luận được chọn lúc đọc ở chế độ "Tất cả bình luận" và có thể nằm sau "Xem thêm": đổi sắp xếp / mở thêm khi chưa thấy.
    let items = await snap();
    let found = findReplyTarget(items, target);
    for (let round = 0; round < 6 && 'error' in found && found.error === 'none'; round++) {
      if (getIsStopping()) return stopped();
      let clicked = false;
      if (round === 0 && await page.evaluate(clickLabelInPage, SORT_TRIGGER)) {
        await sleep(1500);
        clicked = await page.evaluate(clickLabelInPage, SORT_ALL);
      }
      if (!clicked) clicked = await page.evaluate(clickLabelInPage, MORE_COMMENTS);
      if (!clicked) break;
      await sleep(2500);
      items = await snap();
      found = findReplyTarget(items, target);
    }
    if ('error' in found) {
      if (!items.some((it) => it.kind === 'article' && COMMENT_LABEL.test(it.label))) {
        return result({ status: 'post_not_found', reason: 'Không thấy bình luận nào trên trang bài — bài có thể đã bị gỡ hoặc giới hạn xem. Chưa trả lời.' });
      }
      return result({ status: 'target_not_found', reason: found.error === 'many' ? 'Có nhiều bình luận cùng khớp — không đoán, chưa trả lời.' : 'Không thấy bình luận cần trả lời trên bài. Chưa trả lời.' });
    }

    if (replyBoundary(items, found.index) === null) {
      return result({ status: 'failed', reason: 'Bình luận cuối danh sách, không xác định được ranh giới để trả lời an toàn' });
    }
    await page.evaluate(markSeenBoxesInPage, SEEN_BOX_MARK);
    const chosen = items[found.index];
    if (!(await page.evaluate(markReplyButtonInPage, { index: found.index, label: chosen.label, commentIds: chosen.commentIds, labels: REPLY_OPEN_LABELS }))) {
      return result({ status: 'failed', reason: 'Không thấy nút "Trả lời" của bình luận đó (có thể bài tắt bình luận). Chưa gửi.' });
    }
    const opened = await page.locator('[data-maihub-target="reply-open"]').first().click({ timeout: 5000 }).then(() => true, () => false);
    if (!opened) return result({ status: 'failed', reason: 'Không bấm được nút "Trả lời". Chưa gửi.' });
    await sleep(3000);
    if (getIsStopping()) return stopped();

    items = await snap();
    const again = findReplyTarget(items, target);
    const box = 'index' in again ? findNewReplyBox(items, again.index) : again;
    if (!('index' in again) || !('index' in box)) return result({ status: 'failed', reason: 'Bấm "Trả lời" nhưng không thấy đúng một ô trả lời mới trong chuỗi của bình luận đó. Chưa gửi.' });
    const boundary = replyBoundary(items, again.index);
    const before = threadMatchCount(items, target, boundary, snippet);
    if (before === null) return result({ status: 'failed', reason: 'Không xác định được bình luận kế tiếp làm mốc nên sẽ không xác minh được. Chưa gửi.' });
    const headIds = items[nextHeadIndex(items, again.index)].commentIds; // exists: boundary is non-null here
    if (!(await page.evaluate(markReplyBoxInPage, { index: box.index, mark: REPLY_BOX_MARK, seenMark: SEEN_BOX_MARK, targetIds: items[again.index].commentIds, headIds }))) {
      return result({ status: 'failed', reason: 'Ô trả lời vừa hiện đã đổi chỗ hoặc không còn nằm trong chuỗi của bình luận đó. Chưa gửi.' });
    }

    // Gõ như postFirstComment: bấm điểm ô thật nhận chuột (hoặc focus), Shift+Enter giữa các dòng, kiểm chữ đã vào ô.
    const free = await page.evaluate(freePointOnBoxInPage, REPLY_BOX_MARK).catch(() => null);
    if (free) await page.mouse.click(free.x, free.y);
    else await page.locator(`[${REPLY_BOX_MARK}]`).focus();
    const parts = body.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      if (getIsStopping()) return stopped();
      if (i > 0) await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(parts[i]);
    }
    await sleep(1200);
    if (!(await page.evaluate(commentTypedInPage, { mark: REPLY_BOX_MARK, snippet }))) {
      return result({ status: 'failed', reason: 'Không gõ được chữ vào ô trả lời (ô bị che hoặc mất tiêu điểm). Chưa gửi.' });
    }
    if (!(await page.evaluate(markCommentSendButtonInPage, { mark: REPLY_BOX_MARK, labels: SEND_COMMENT_LABELS }))) {
      return result({ status: 'failed', reason: 'Không thấy nút gửi cạnh ô trả lời. Chưa gửi.' });
    }
    if (getIsStopping()) return stopped();
    sendAttempted = true;
    const sent = await page.locator('[data-maihub-target="comment-send"]').first().click({ timeout: 5000 }).then(() => true, () => false);
    // A rejected click can still have dispatched: never resend with Enter.
    if (!sent) return result({ status: 'failed', reason: 'Kết quả gửi trả lời chưa rõ; không gửi lại bằng Enter.' });

    // Câu trả lời có thể hiện chậm: đọc lại tối đa 3 lần trước khi kết luận chưa xác nhận.
    let verdict = { ok: false, reason: '' };
    for (let attempt = 0; attempt < 3 && !verdict.ok; attempt++) {
      await sleep(attempt === 0 ? 4000 : 2000);
      verdict = confirmReply(await snap(), target, boundary, snippet, before);
    }
    return result({ status: verdict.ok ? 'posted' : 'failed', reason: verdict.reason });
  } catch (err) {
    return result({ status: 'failed', reason: `Lỗi khi trả lời bình luận: ${(err as Error).message}` });
  } finally {
    await page.evaluate(clearReplyMarksInPage, [REPLY_BOX_MARK, SEEN_BOX_MARK]).catch(() => {});
  }
}
