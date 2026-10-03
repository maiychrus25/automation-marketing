/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { Page } from 'playwright-core';
import type { TaskDeps } from './types';

/**
 * Đăng MỘT bình luận vào bài mình vừa đăng.
 *
 * Khác hẳn việc đọc bình luận — tệp này VIẾT một bình luận của mình. Để riêng
 * vì một bên chỉ đọc, một bên có tác động ra ngoài; trộn vào nhau thì lúc sửa
 * dễ vô tình cho phần đọc quyền ghi.
 *
 * Vì sao cần: nhiều nhóm chặn bài có liên kết, nên thông tin liên hệ phải nằm
 * ở bình luận đầu tiên thay vì trong thân bài.
 *
 * ĐO ĐƯỢC trên tài khoản thật ngày 2026-08-12 (chỉ đọc, không gõ, không gửi):
 * - Ô nhập KHÔNG tồn tại sẵn. Phải bấm nút "Leave a comment" (tiếng Việt:
 *   "Bình luận") thì nó mới được dựng ra.
 * - Ô nhập là `div[role="textbox"][contenteditable="true"]`, aria-label bắt
 *   đầu bằng "Comment as …" — có KÈM TÊN người dùng phía sau, nên phải khớp
 *   theo đầu chuỗi, không khớp trọn.
 * - Có nút gửi riêng: aria-label "Post comment". Không phải chỉ dựa vào Enter.
 *
 * ĐO LẠI 2026-09-30 sau khi đổi tài khoản sang TIẾNG VIỆT (chỉ đọc):
 * - Nút mở: aria-label "Viết bình luận" (chữ hiển thị rỗng).
 * - Ô nhập: aria-label "Bình luận dưới tên <Tên Page>" — KHÔNG phải "Bình
 *   luận với tư cách …" như đoán trước đó.
 * - Nút gửi: aria-label "Đăng bình luận".
 */

export type CommentStatus = 'not_requested' | 'posted' | 'no_post_url' | 'pending_approval' | 'post_not_found' | 'failed';
export interface CommentOutcome { status: CommentStatus; reason: string; }

// Nút mở ô nhập. Đo được nhãn tiếng Anh "Leave a comment"; nhãn tiếng Việt
// kèm theo cho máy đã đổi ngôn ngữ.
export const OPEN_COMMENT_LABELS = ['Leave a comment', 'Bình luận', 'Comment', 'Viết bình luận'];

// Nút gửi. Chỉ tìm nó TRONG cùng khối với ô nhập (xem markCommentSendButtonInPage):
// tiếng Việt nhãn nút gửi cũng có thể là "Bình luận", trùng với nút MỞ, nên
// tìm toàn trang sẽ bấm nhầm lại nút mở và không bao giờ gửi được.
export const SEND_COMMENT_LABELS = ['Post comment', 'Bình luận', 'Đăng bình luận', 'Post', 'Gửi'];

const COMMENT_BOX_MARK = 'data-maihub-comment-box';

// Dấu hiệu bài đang nằm trong hàng chờ duyệt của nhóm. CHƯA ĐO trên trang
// thật — chỉ dùng để nói cho đúng LÝ DO, không dùng để quyết định có bình luận
// hay không. Quyết định đó dựa vào bằng chứng dương: có nhìn thấy bài hay
// không. Thiếu một câu nào trong danh sách này thì cùng lắm là thông báo chung
// chung, chứ không bao giờ dẫn tới bình luận nhầm vào bài chưa hiện.
export const PENDING_APPROVAL_MARKERS = [
  'đang chờ phê duyệt', 'chờ phê duyệt', 'đang chờ được phê duyệt',
  'chờ quản trị viên phê duyệt', 'pending approval', 'is pending',
  'waiting for approval', 'awaiting approval',
];

/** Bấm nút mở ô bình luận. CHẠY TRONG TRÌNH DUYỆT. */
function openCommentBoxInPage(labels: string[]): boolean {
  const isVisible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const squash = (e: Element) => String(e.getAttribute('aria-label') || (e as HTMLElement).innerText || '').trim();
  const button = Array.from(document.querySelectorAll('div[role="button"], button'))
    .filter(isVisible)
    .find(e => labels.includes(squash(e))) as HTMLElement | undefined;
  if (!button) return false;
  button.scrollIntoView({ block: 'center' });
  button.click();
  return true;
}

/**
 * Đánh dấu ô nhập bình luận để bên Node cầm được bằng locator.
 * CHẠY TRONG TRÌNH DUYỆT.
 *
 * Không dùng focus() rồi gõ bằng keyboard: đo được ở phần điền form TopCV là
 * tiêu điểm đặt trong page.evaluate KHÔNG còn giữ khi lời gọi keyboard chạy
 * sau đó — chữ bay mất mà không có lỗi nào được ném.
 */
function markCommentBoxInPage({ mark }: { mark: string }): boolean {
  const isVisible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const box = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'))
    .filter(isVisible)
    .find(e => /^(Comment as|Bình luận dưới tên|Bình luận với tư cách)/i.test(e.getAttribute('aria-label') || ''));
  if (!box) return false;
  box.scrollIntoView({ block: 'center' });
  box.setAttribute(mark, '1');
  return true;
}

/**
 * Tìm nút gửi NẰM TRONG cùng khối với ô nhập rồi ĐÁNH DẤU (bên Node bấm bằng
 * locator, click tin cậy). CHẠY TRONG TRÌNH DUYỆT.
 * Trèo lên tổ tiên vì nút gửi là anh em của ô nhập, không lồng bên trong nó.
 * Giới hạn phạm vi để không bấm trúng nút "Bình luận" của bài khác trên trang.
 */
function markCommentSendButtonInPage({ mark, labels }: { mark: string; labels: string[] }): boolean {
  const isVisible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const box = document.querySelector(`[${mark}]`);
  if (!box) return false;
  for (let parent = box.parentElement, step = 0; parent && step < 6; parent = parent.parentElement, step++) {
    const button = Array.from(parent.querySelectorAll('div[role="button"], button'))
      .filter(isVisible)
      .find(e => labels.includes(String(e.getAttribute('aria-label') || (e as HTMLElement).innerText || '').trim()));
    if (button) {
      document.querySelectorAll('[data-maihub-target]').forEach(e => e.removeAttribute('data-maihub-target'));
      button.setAttribute('data-maihub-target', 'comment-send');
      return true;
    }
  }
  return false;
}

/**
 * Đếm khối bình luận đang có. CHẠY TRONG TRÌNH DUYỆT.
 * Bài đăng cũng là role="article" nhưng aria-label bắt đầu bằng "Bài viết"/
 * "Post" nên bị loại — cùng luật đã dùng khi đọc bình luận.
 */
function countCommentBlocksInPage(): number {
  const LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
  let count = 0;
  for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
    if (LABEL.test(el.getAttribute('aria-label') || '')) count += 1;
  }
  return count;
}

/** Có khối bình luận nào chứa đúng đoạn chữ này không. CHẠY TRONG TRÌNH DUYỆT. */
function commentTextVisibleInPage(snippet: string): boolean {
  const LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
  for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
    if (!LABEL.test(el.getAttribute('aria-label') || '')) continue;
    if (String((el as HTMLElement).innerText || '').includes(snippet)) return true;
  }
  return false;
}

/**
 * Đọc trạng thái bài trên trang link bài. CHẠY TRONG TRÌNH DUYỆT.
 * Trả về việc CÓ NHÌN THẤY nội dung bài hay không, và chữ trên trang có dấu
 * hiệu chờ duyệt hay không.
 */
function readPostStateInPage({ snippet, markers }: { snippet: string; markers: string[] }): { found: boolean; pendingMarker: string | null } {
  const pageText = String((document.body && document.body.innerText) || '').toLowerCase();
  let found = false;
  if (snippet) {
    for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
      const label = el.getAttribute('aria-label') || '';
      // Bỏ khối BÌNH LUẬN: nội dung bài có thể được ai đó trích lại trong bình
      // luận, và thấy nó ở đó không chứng minh bài đã hiện.
      if (/^(Bình luận|Phản hồi|Comment|Reply)/i.test(label)) continue;
      if (String((el as HTMLElement).innerText || '').includes(snippet)) { found = true; break; }
    }
  }
  const pendingMarker = (markers || []).find(t => pageText.includes(String(t).toLowerCase())) || null;
  return { found, pendingMarker };
}

/**
 * Kết luận trạng thái bài. HÀM THUẦN, test được không cần trình duyệt.
 *
 * Chỉ coi là ĐÃ DUYỆT khi NHÌN THẤY nội dung bài trên trang. Không suy ngược
 * từ việc "không thấy chữ chờ duyệt" — danh sách câu chữ đó chưa đo trên trang
 * thật và Facebook đổi câu lúc nào không ai biết; suy ngược là bình luận vào
 * một bài chưa hề hiện.
 */
export function evaluatePostState(
  { found, pendingMarker }: { found?: boolean; pendingMarker?: string | null } = {},
): { status: 'approved' | 'pending_approval' | 'post_not_found'; reason: string } {
  if (found) return { status: 'approved', reason: 'Bài đã hiện trên nhóm.' };
  if (pendingMarker) {
    return {
      status: 'pending_approval',
      reason: `Bài đang chờ quản trị viên nhóm phê duyệt ("${pendingMarker}") nên chưa bình luận được. Duyệt xong thì vào bình luận giúp.`,
    };
  }
  return {
    status: 'post_not_found',
    reason: 'Mở link bài nhưng không thấy nội dung bài trên trang — có thể đang chờ duyệt, bị gỡ, hoặc nhóm giới hạn xem. Chưa bình luận.',
  };
}

/**
 * Kết luận bình luận đã lên hay chưa. HÀM THUẦN, test được không cần trình duyệt.
 *
 * Đòi CẢ HAI dấu hiệu: số khối tăng, VÀ thấy đúng đoạn chữ mình vừa gõ.
 * - Chỉ đếm số: Facebook nạp thêm bình luận cũ trong lúc mình gõ là số cũng
 *   tăng, và công cụ sẽ báo thành công cho một bình luận chưa hề gửi.
 * - Chỉ tìm chữ: đoạn chữ có thể đã nằm sẵn trong bài hoặc trong bình luận của
 *   người khác trích lại.
 * Bấm được nút KHÔNG phải bằng chứng — cùng luật đang áp cho cả TopCV lẫn phần
 * đăng bài Facebook.
 */
export function evaluateComment(before: unknown, after: unknown, textFound: boolean): { ok: boolean; reason: string } {
  // Xét null/undefined TRƯỚC khi ép số: Number(null) ra 0 chứ không phải NaN,
  // nên một phép đếm hỏng trả null sẽ lọt qua thành "0 → 4" và được báo là
  // thành công cho một bình luận chưa hề gửi.
  const isValidCount = (v: unknown) => v != null && Number.isFinite(Number(v));
  if (!isValidCount(before) || !isValidCount(after)) {
    return { ok: false, reason: 'Không đếm được khối bình luận nên không xác minh được.' };
  }
  const beforeCount = Number(before);
  const afterCount = Number(after);
  if (afterCount <= beforeCount) {
    return { ok: false, reason: `Số bình luận không tăng (${beforeCount} → ${afterCount}) — bình luận chưa lên.` };
  }
  if (!textFound) {
    return { ok: false, reason: 'Số bình luận có tăng nhưng không thấy đúng nội dung vừa gõ.' };
  }
  return { ok: true, reason: 'Đã bình luận và thấy nội dung trên trang.' };
}

/**
 * Đoạn chữ dùng để đối chiếu. Lấy dòng đầu, cắt ngắn: Facebook thu gọn bình
 * luận dài thành "… Xem thêm" nên tìm cả đoạn sẽ trượt dù bình luận đã lên.
 */
export function matchSnippet(text: string | null | undefined): string {
  const lines = String(text == null ? '' : text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return (lines[0] || '').slice(0, 40);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Mở bài rồi đăng một bình luận. Trả về { status, reason }.
 *
 * status:
 *   'posted'           — đã lên VÀ nhìn thấy trên trang
 *   'no_post_url'      — không có link bài nên không tới được chỗ để bình luận
 *   'pending_approval' — bài đang chờ quản trị viên nhóm duyệt, chưa hiện
 *   'post_not_found'   — mở link nhưng không thấy bài (gỡ, giới hạn xem, …)
 *   'failed'           — bài đã hiện nhưng không bình luận được
 *
 * KHÔNG ném lỗi ra ngoài: bài đã đăng thành công rồi, một lỗi ở bước bình luận
 * không được phép làm cả lượt đăng tính là hỏng — báo hỏng sẽ khiến người dùng
 * đăng lại và thành hai bài trùng trong nhóm.
 */
export async function postFirstComment(
  page: Page,
  input: { postUrl: string | null; comment: string | null; text: string },
  deps: { sendLog?: TaskDeps['sendLog']; getIsStopping?: () => boolean } = {},
): Promise<CommentOutcome> {
  const { postUrl, comment, text } = input;
  const { sendLog = () => {}, getIsStopping = () => false } = deps;
  const body = String(comment == null ? '' : comment).trim();
  if (!body) return { status: 'not_requested', reason: 'Không có nội dung bình luận.' };
  if (!postUrl) {
    return {
      status: 'no_post_url',
      reason: 'Không lấy được link bài nên không tới được chỗ để bình luận. Vào nhóm dán tay giúp.',
    };
  }

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    if (getIsStopping()) return { status: 'failed', reason: 'Đã huỷ giữa chừng.' };

    // Bài có thể đang nằm trong hàng chờ duyệt của nhóm. Bình luận vào bài
    // chưa hiện là vô nghĩa, nên phải xác nhận bài đã lên TRƯỚC khi gõ gì.
    const postState = evaluatePostState(await page.evaluate(readPostStateInPage, {
      snippet: matchSnippet(text),
      markers: PENDING_APPROVAL_MARKERS,
    }));
    if (postState.status !== 'approved') {
      sendLog(`[Bình luận] ${postState.reason}`, 'warning');
      return { status: postState.status, reason: postState.reason };
    }

    const before = await page.evaluate(countCommentBlocksInPage);

    if (!(await page.evaluate(openCommentBoxInPage, OPEN_COMMENT_LABELS))) {
      return { status: 'failed', reason: 'Không thấy nút mở ô bình luận trên trang bài.' };
    }
    await sleep(3000);

    if (!(await page.evaluate(markCommentBoxInPage, { mark: COMMENT_BOX_MARK }))) {
      return { status: 'failed', reason: 'Đã bấm mở nhưng không thấy ô nhập bình luận.' };
    }

    try {
      const box = page.locator(`[${COMMENT_BOX_MARK}]`);
      await box.click();
      // Gõ từng đoạn, Enter giữa các đoạn: ô này là trình soạn thảo giàu định
      // dạng, nhét cả "\n" một lần là mất hết xuống dòng.
      const parts = body.split(/\r?\n/);
      for (let i = 0; i < parts.length; i++) {
        if (getIsStopping()) return { status: 'failed', reason: 'Đã huỷ giữa chừng.' };
        if (i > 0) await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(parts[i]);
      }
      await sleep(1200);

      if (!(await page.evaluate(markCommentSendButtonInPage, { mark: COMMENT_BOX_MARK, labels: SEND_COMMENT_LABELS }))) {
        return { status: 'failed', reason: 'Không thấy nút gửi bình luận cạnh ô nhập.' };
      }
      await page.locator('[data-maihub-target="comment-send"]').first().click({ timeout: 10000 });
    } finally {
      await page.evaluate(function clearCommentBoxMark(mark: string) {
        for (const e of Array.from(document.querySelectorAll(`[${mark}]`))) e.removeAttribute(mark);
      }, COMMENT_BOX_MARK).catch(() => {});
    }

    await sleep(4000);
    const after = await page.evaluate(countCommentBlocksInPage);
    const textFound = await page.evaluate(commentTextVisibleInPage, matchSnippet(body));
    const verdict = evaluateComment(before, after, textFound);
    sendLog(`[Bình luận] ${verdict.reason}`, verdict.ok ? 'success' : 'warning');
    return { status: verdict.ok ? 'posted' : 'failed', reason: verdict.reason };
  } catch (err) {
    return { status: 'failed', reason: `Lỗi khi bình luận: ${(err as Error).message}` };
  }
}
