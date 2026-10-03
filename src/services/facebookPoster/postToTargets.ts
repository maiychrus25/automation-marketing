/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { BrowserContext, Page, Response } from 'playwright-core';
import type { TaskDeps } from './types';
import { delayRandom, humanClick } from './humanize';
import { normalizeTarget, pickDelaySeconds } from './targets';
import { FB_HOME, isLoggedIn } from './loginState';
import { postFirstComment, type CommentStatus } from './firstComment';

export const PUBLISH_LABELS = ['Đăng', 'Post', 'Chia sẻ', 'Share', 'Đăng ngay', 'Publish'];

// Composer của Page là luồng 2 bước: gõ chữ -> "Next" -> trang tuỳ chọn
// (Share to groups / Share to story / Boost post) -> "Post". Composer của
// group chỉ 1 bước và không có nút này, nên tìm không thấy thì bỏ qua.
const NEXT_LABELS = ['Next', 'Tiếp', 'Tiếp theo'];

// Sau khi bấm Đăng, Page hay chen một modal gợi ý ("Make it easier to contact
// you" — thêm nút WhatsApp). Nó cũng là div[role="dialog"], nên không đóng thì
// phép chờ "dialog biến mất" sẽ báo thất bại oan dù bài đã lên.
const DISMISS_LABELS = ['Not now', 'Để sau', 'Không phải bây giờ', 'Lúc khác', 'Bỏ qua'];

// Hộp soạn thảo bài viết của Facebook có HAI dạng, đo được ngày 2026-09-30:
// - Group (và trang cá nhân): một div[role="dialog"] tiêu đề "Create post".
// - PAGE: từ bản cập nhật cuối tháng 9/2026, bấm "What's on your mind" KHÔNG
//   mở dialog nữa mà chuyển hẳn sang trang facebook.com/post/create. Ô soạn
//   nằm trong div[role="form"][aria-label="Posts"], nút "Post" nằm NGOÀI form
//   ở thanh dưới, input[type=file] có sẵn trong form, và không còn bước "Next".
// Mọi thao tác PHẢI bị giới hạn trong một trong hai gốc đó. Ngoài gốc, trang
// group còn chứa ô bình luận của các bài đã có — cũng là contenteditable
// [role=textbox], cũng là lexical editor — và nút "Share" ở header. Cả hai
// đứng TRƯỚC nội dung dialog theo thứ tự DOM, nên tìm trên toàn document sẽ gõ
// chữ vào ô bình luận rồi click nhầm "Share".
const DIALOG_SELECTOR = 'div[role="dialog"]';
const FORM_SELECTOR = 'div[role="form"]';
// Đường dẫn trang soạn bài riêng của Page là /post/create. Không đặt thành hằng
// dùng chung: các hàm chạy trong trình duyệt phải tự chứa, nên chuỗi này được
// lặp lại ngay trong từng hàm cần nó.

export const EDITOR_SELECTORS = [
  'div[data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
  // Khớp "đang nghĩ gì" (không kèm "thế") để không phụ thuộc cách xếp câu.
  // ĐO ĐƯỢC 2026-09-30 với tài khoản đã đổi sang tiếng Việt: lời mời của Page
  // là "<Tên Page> ơi, bạn đang nghĩ gì thế?", của cá nhân là "<Tên> ơi, bạn
  // đang nghĩ gì thế?"; tiếng Anh là "What's on your mind, <Tên>?".
  '[aria-placeholder*="đang nghĩ gì"]',
  '[aria-placeholder*="viết gì đó"]',
];

// Input file trong dialog, HOẶC trong form của trang /post/create — ở đó nó có
// sẵn ngay khi trang mở, không phải bấm "Ảnh/Video" mới xuất hiện.
const FILE_INPUT_SELECTOR = `${DIALOG_SELECTOR} input[type="file"], ${FORM_SELECTOR} input[type="file"]`;

export function isPublishLabel(text: unknown): boolean {
  return PUBLISH_LABELS.includes(String(text ?? '').trim());
}

/**
 * Facebook không điều hướng sang bài mới sau khi đăng, nên phải tự tìm link.
 * Đường chính là nghe phản hồi GraphQL: id bài nằm trong thân phản hồi của
 * mutation tạo bài. Không phụ thuộc giao diện nên bền hơn đọc DOM.
 */
function extractPostIdFromBody(text: unknown): string | null {
  const m = String(text || '').match(/"post_id":"(\d+)"/) || String(text || '').match(/"story_fbid":"(\d+)"/);
  return m ? m[1] : null;
}

/** Ghép id bài thành link đầy đủ theo kiểu đích. */
function buildPostUrl(target: { url: string }, postId: string | null): string | null {
  if (!postId) return null;
  const g = String(target.url || '').match(/\/groups\/(\d+)/);
  if (g) return `https://www.facebook.com/groups/${g[1]}/posts/${postId}/`;
  const slug = String(target.url || '').replace(/^https?:\/\/[^/]+\//i, '').split(/[?#]/)[0].replace(/\/+$/, '');
  // "profile.php" không phải slug thật — id nằm ở query (?id=...), bị cắt mất
  // ở dòng trên. Ghép ra "facebook.com/profile.php/posts/N" là một URL không
  // tồn tại, sẽ bị Facebook chuyển hướng đi nơi khác khi quét bình luận.
  if (!slug || slug === 'profile.php') return null;
  return `https://www.facebook.com/${slug}/posts/${postId}`;
}

/**
 * Tìm link bài của CHÍNH MÌNH trong các bài đang hiện. CHẠY TRONG TRÌNH DUYỆT.
 * Có tên (không ẩn danh) vì test chạy thật hàm này trên một document giả để
 * chốt so sánh id thực sự được thực thi.
 */
function findOwnPostLinkInPage(selfId: string): string | null {
  for (const article of Array.from(document.querySelectorAll('[role="article"]'))) {
    const isOwn = Array.from(article.querySelectorAll('a')).some(a => {
      const h = a.getAttribute('href') || '';
      return h.includes(`/user/${selfId}`) || h.includes(`profile.php?id=${selfId}`);
    });
    if (!isOwn) continue;
    for (const a of Array.from(article.querySelectorAll('a'))) {
      const h = a.getAttribute('href') || '';
      // CHỈ nhận /posts/id/. Từng nhận cả "story_fbid=" rồi cắt bằng
      // split(/[?#]/)[0] — với href thật /permalink.php?story_fbid=1&id=2,
      // phép cắt vứt luôn phần chứa id, trả về link cụt
      // "https://www.facebook.com/permalink.php" không trỏ tới bài nào.
      // Không có link còn hơn có link rác dẫn cào nhầm bình luận của bài khác.
      if (!/\/posts\//.test(h)) continue;
      const link = h.startsWith('http') ? h : `https://www.facebook.com${h}`;
      return link.split(/[?#]/)[0];
    }
  }
  return null;
}

/**
 * Dự phòng khi không bắt được id qua mạng: tìm link bài trên trang, nhưng CHỈ
 * chấp nhận bài do chính mình đăng. Vớ nhầm bài ghim của người khác sẽ khiến
 * công cụ đi quét bình luận của người lạ — thà không có link còn hơn.
 */
async function findOwnPostUrl(page: Page, ctx: BrowserContext): Promise<string | null> {
  let selfId: string | null = null;
  try {
    const cookies = await ctx.cookies('https://www.facebook.com');
    const c = (cookies || []).find(x => x.name === 'c_user');
    selfId = c ? String(c.value) : null;
  } catch {
    return null;
  }
  if (!selfId) return null;

  const link = await page.evaluate(findOwnPostLinkInPage, selfId).catch(() => null);

  return link || null;
}

/**
 * Click nút "Ảnh/Video" BÊN TRONG hộp soạn thảo.
 * Tìm trên toàn trang sẽ bắt trúng nút đính kèm ảnh của ô BÌNH LUẬN
 * (aria-label "Attach a photo or video") — click nó mở file picker cho bình
 * luận và không bao giờ mở hộp soạn thảo bài viết.
 */
function clickMediaButtonInDialog(): boolean {
  const isMatch = (t: string) =>
    t.includes('ảnh/video') || t.includes('photo/video') ||
    t.includes('photo or video') || t.includes('ảnh hoặc video');
  for (const dialog of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
    const btn = Array.from(
      dialog.querySelectorAll('div[role="button"], div.x1i10hfl, span, img'),
    ).find(el => {
      const text = (el.textContent || '').toLowerCase().trim();
      const label = (el.getAttribute('aria-label') || '').toLowerCase().trim();
      const alt = (el.getAttribute('alt') || '').toLowerCase().trim();
      return isMatch(text) || isMatch(label) || isMatch(alt);
    });
    if (btn) {
      ((btn.closest('[role="button"]') || btn.closest('.x1i10hfl') || btn) as HTMLElement).click();
      return true;
    }
  }
  return false;
}

/**
 * Đọc lời mời soạn bài để biết ĐANG ĐỨNG DANH TÍNH NÀO. CHẠY TRONG TRÌNH DUYỆT.
 * Đo được trên hồ sơ Page thật: chuỗi là "What's on your mind, AHV Holding
 * Careers?" — tên sau dấu phẩy chính là danh tính sẽ đứng tên bài.
 *
 * Cần vì chế độ PAGE không còn ô nhập đích: người dùng không nhìn thấy đích
 * bằng mắt nữa, nên công cụ phải nói ra. Hồ sơ lỡ chưa chuyển sang Page thì
 * bài rơi vào trang cá nhân, và dòng log này là thứ duy nhất báo trước.
 */
// Lời mời mở ô soạn bài. Dùng chung cho hai hàm chạy trong trang bên dưới,
// truyền vào lúc gọi (hàm chạy trong trang không đọc được biến ở ngoài).
// ĐO ĐƯỢC trên trang thật:
// - nhóm, tiếng Việt (02/10/2026): "Bạn viết gì đi..." — trước đó là "Viết gì đó...".
// - Page/cá nhân, tiếng Việt (30/09/2026): "<Tên> ơi, bạn đang nghĩ gì thế?".
// - tiếng Anh: "What's on your mind, <Tên>?", "Write something...".
export const COMPOSER_INVITE = "đang nghĩ gì|what's on your mind|viết gì đó|viết gì đi|write something";

function readComposerIdentityInPage(pattern: string): string | null {
  const isVisible = (e: Element) => {
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const squash = (s: unknown) => String(s || '').replace(/\s+/g, ' ').trim();
  const el = Array.from(document.querySelectorAll('div,span'))
    .filter(isVisible)
    .filter(e => !e.querySelector('div,span'))
    .find(e => new RegExp(pattern, 'i').test(squash((e as HTMLElement).innerText)));
  return el ? squash((el as HTMLElement).innerText).slice(0, 80) : null;
}

/**
 * Tìm ô "Bạn đang nghĩ gì" và ĐÁNH DẤU nó (bên Node bấm bằng locator, click tin
 * cậy) để mở hộp soạn thảo thường. CHẠY TRONG TRÌNH DUYỆT.
 * Gỡ dấu cũ TRƯỚC khi tìm: locator `.first()` sẽ bấm nhầm phần tử còn dấu nếu
 * lần tìm này không thấy gì.
 */
export function markComposerInviteInPage(pattern: string): boolean {
  document.querySelectorAll('[data-maihub-target]').forEach(e => e.removeAttribute('data-maihub-target'));
  const btn = Array.from(
    document.querySelectorAll('div[role="button"], div.x1i10hfl'),
  ).find(el =>
    new RegExp(pattern, 'i').test(el.textContent || ''),
  );
  if (!btn) return false;
  btn.setAttribute('data-maihub-target', 'composer-invite');
  return true;
}

/** Hộp soạn thảo đã mở chưa: có dialog VÀ trong dialog có ô nhập đang hiện. */
export function composerIsOpenInPage(editorSelectors: string[]): boolean {
  // Gốc là dialog; không có dialog nào thì là form của trang /post/create
  // (composer Page dạng trang riêng). Lặp lại luật này trong từng hàm chạy
  // trong trình duyệt vì chúng không thấy được hàm dùng chung của Node.
  let roots: Element[] = Array.from(document.querySelectorAll('div[role="dialog"]'));
  if (!roots.length) roots = Array.from(document.querySelectorAll('div[role="form"]'));
  return roots.some(dialog =>
    editorSelectors.some(sel =>
      Array.from(dialog.querySelectorAll(sel)).some(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
    ),
  );
}

/** Focus ô nhập nội dung BÊN TRONG dialog, loại trừ ô tìm kiếm ở header. */
export function focusEditorInPage(editorSelectors: string[]): boolean {
  let roots: Element[] = Array.from(document.querySelectorAll('div[role="dialog"]'));
  if (!roots.length) roots = Array.from(document.querySelectorAll('div[role="form"]'));
  for (const root of roots) {
    for (const sel of editorSelectors) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (el.closest('header') || el.closest('[role="banner"]') ||
            el.closest('[role="navigation"]')) continue;
        (el as HTMLElement).focus();
        (el as HTMLElement).click();
        return true;
      }
    }
  }
  return false;
}

/** Bấm nút "Next" của composer Page nếu có. Group không có nút này. */
function clickNextInDialog(labels: string[]): boolean {
  for (const dialog of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
    const btn = Array.from(dialog.querySelectorAll('div[role="button"], button')).find(el => {
      const label = (el.getAttribute('aria-label') || '').trim();
      const text = ((el as HTMLElement).innerText || '').trim().split('\n')[0];
      return labels.includes(label) || labels.includes(text);
    });
    if (btn) { (btn as HTMLElement).click(); return true; }
  }
  return false;
}

/**
 * Đóng modal gợi ý chen ngang sau khi đăng, ưu tiên nút "Not now".
 * Phải quét MỌI dialog: lúc này trên trang có hai cái cùng lúc — composer vẫn
 * mở, còn modal gợi ý là cái thứ hai. querySelector chỉ trả về cái đầu tiên
 * nên sẽ tìm "Not now" trong composer và không bao giờ thấy.
 */
function dismissInterstitialInDialog(labels: string[]): boolean {
  for (const dialog of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
    const btn = Array.from(
      dialog.querySelectorAll('div[role="button"], button, span'),
    ).find(el => {
      const label = (el.getAttribute('aria-label') || '').trim();
      const text = ((el as HTMLElement).innerText || el.textContent || '').trim().split('\n')[0];
      return labels.includes(label) || labels.includes(text);
    });
    if (btn) {
      ((btn.closest('[role="button"]') || btn) as HTMLElement).click();
      return true;
    }
  }
  return false;
}

/**
 * Tìm nhãn đăng bài BÊN TRONG dialog rồi ĐÁNH DẤU phần tử nút bao ngoài nó
 * (bên Node bấm bằng locator, click tin cậy). CHẠY TRONG TRÌNH DUYỆT.
 * Gỡ dấu cũ TRƯỚC khi tìm, kể cả khi lần này không thấy gì.
 */
export function markPublishButtonInPage(labels: string[]): boolean {
  document.querySelectorAll('[data-maihub-target]').forEach(e => e.removeAttribute('data-maihub-target'));
  let roots: ParentNode[] = Array.from(document.querySelectorAll('div[role="dialog"]'));
  // Trang /post/create: nút "Post" nằm ở thanh dưới, NGOÀI div[role="form"]
  // (đo được), nên gốc tìm là cả trang. Trang đó chỉ có đúng một nút Post.
  if (!roots.length && location.pathname.startsWith('/post/create')) roots = [document];
  for (const root of roots) {
    const button = Array.from(root.querySelectorAll('div[role="button"], button')).find(b =>
      labels.includes((b.getAttribute('aria-label') || '').trim()),
    );
    if (button) { button.setAttribute('data-maihub-target', 'publish'); return true; }
    const span = Array.from(root.querySelectorAll('span')).find(s =>
      labels.includes((s.textContent || '').trim()),
    );
    if (span) {
      (span.closest('.x1ja2u2z') || span.closest('[role="button"]') || span).setAttribute('data-maihub-target', 'publish');
      return true;
    }
  }
  return false;
}

/**
 * Composer đang là trang riêng /post/create (Page) hay là dialog.
 * CHẠY TRONG TRÌNH DUYỆT. Có tên vì test chạy thật mọi hàm ẩn danh trên một
 * document giả không có `location`.
 */
function isStandaloneComposerInPage(): boolean {
  return location.pathname.startsWith('/post/create');
}

/**
 * Nút Đăng có đang TẮT không. CHẠY TRONG TRÌNH DUYỆT.
 * Đo được: nút "Post" mang aria-disabled="true" cho tới khi Facebook ghi nhận
 * chữ trong ô. Bấm một nút đang tắt thì không có gì xảy ra, dialog/trang không
 * đổi, và công cụ chờ 30 giây rồi báo hỏng — đúng triệu chứng "không click
 * nút đăng bài được". Kiểm trước để báo đúng nguyên nhân thay vì bấm hụt.
 */
export function isPublishDisabledInPage(labels: string[]): boolean {
  let roots: ParentNode[] = Array.from(document.querySelectorAll('div[role="dialog"]'));
  if (!roots.length && location.pathname.startsWith('/post/create')) roots = [document];
  for (const root of roots) {
    const button = Array.from(root.querySelectorAll('div[role="button"], button')).find(b =>
      labels.includes((b.getAttribute('aria-label') || '').trim()) ||
      labels.includes(((b as HTMLElement).innerText || '').trim()),
    );
    if (button) return button.getAttribute('aria-disabled') === 'true';
  }
  return false;
}

/** Đã rời trang /post/create chưa — bằng chứng bài đã đi ở composer Page. CHẠY TRONG TRÌNH DUYỆT. */
function hasLeftCreatePageInPage(): boolean {
  return !location.pathname.startsWith('/post/create');
}

/**
 * Bước 2 của composer nhiều bước đã sẵn sàng chưa: nhãn đăng bài xuất hiện
 * trong dialog. CHẠY TRONG TRÌNH DUYỆT.
 * Phải quét MỌI dialog, không lấy cái đầu tiên: Facebook mở kèm một dialog phụ
 * rỗng cùng tiêu đề "Create post". Lấy cái đầu tiên mà trúng cái rỗng thì chờ
 * hết 25s rồi báo "không hiện nút Đăng" oan, trong khi markPublishButtonInPage
 * ngay bên dưới lại tìm thấy nút.
 */
function publishLabelShownInDialogsInPage(labels: string[]): boolean {
  return Array.from(document.querySelectorAll('div[role="dialog"]')).some(dialog =>
    Array.from(dialog.querySelectorAll('span')).some(s =>
      labels.includes((s.textContent || '').trim()),
    ),
  );
}

interface SingleTargetOutcome {
  ok: boolean;
  postUrl: string | null;
  commentStatus?: CommentStatus;
  /** Danh tính đọc được từ lời mời soạn bài ('' nếu không đọc được). */
  identity: string;
}

async function postToSingleTarget(
  page: Page,
  ctx: BrowserContext,
  target: { url: string; kind: 'group' | 'page' },
  { text, mediaPath, comment }: { text: string; mediaPath: string | null; comment: string | null },
  deps: Pick<TaskDeps, 'getIsStopping' | 'sendLog'>,
): Promise<SingleTargetOutcome> {
  const { url, kind } = target;
  const { getIsStopping, sendLog } = deps;
  let identity = '';
  const failed = (): SingleTargetOutcome => ({ ok: false, postUrl: null, identity });

  sendLog(`[Đăng Bài] Đang truy cập: ${url}`, 'info');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await delayRandom(1000, 2000);
  if (getIsStopping()) return failed();

  // 1. Mở hộp soạn thảo — luôn luôn, kể cả khi có media. Lối tắt cũ (click
  // "Ảnh/Video" ngoài feed để mở thẳng composer kèm đính kèm) bắt trúng nút
  // đính kèm của ô bình luận và không mở được dialog nào.
  if (!(await page.evaluate(composerIsOpenInPage, EDITOR_SELECTORS))) {
    // Nói RÕ danh tính trước khi gõ chữ. Ở chế độ Page không còn ô nhập đích
    // nên đây là chỗ duy nhất người dùng thấy được bài sẽ đứng tên ai.
    const identityRead = await page.evaluate(readComposerIdentityInPage, COMPOSER_INVITE).catch(() => null);
    identity = typeof identityRead === 'string' ? identityRead : '';
    sendLog(identity
      ? `[Đăng Bài] Danh tính sẽ đứng tên bài: ${identity}`
      : '[Đăng Bài] Không đọc được danh tính đang dùng — kiểm lại bằng mắt trước khi chạy cả loạt.',
    identity ? 'info' : 'warning');
    sendLog('[Đăng Bài] Đang mở hộp soạn thảo bài viết...', 'info');
    if (await page.evaluate(markComposerInviteInPage, COMPOSER_INVITE)) {
      // Click tin cậy qua locator. Lỗi click không được làm hỏng luồng ngay:
      // chốt chặn "hộp soạn thảo đã mở chưa" ngay bên dưới mới là nơi quyết định.
      try {
        await page.locator('[data-maihub-target="composer-invite"]').first().click({ timeout: 10000 });
      } catch (e) {
        sendLog(`[Đăng Bài] Bấm ô mở soạn bài không được: ${(e as Error).message}`, 'warning');
      }
    } else {
      sendLog('[Đăng Bài] Không tìm thấy ô mở soạn bài ("Bạn viết gì đi", "Bạn đang nghĩ gì", "Write something").', 'warning');
    }
    // Chờ đúng điều kiện chứ không chờ "có dialog nào đó": Facebook mở KÈM một
    // dialog phụ rỗng cũng tiêu đề "Create post" (đo được: 500x60, 0 editor).
    // waitForSelector sẽ khớp cái rỗng đó rồi trả về ngay khi composer thật
    // chưa render xong.
    await page
      .waitForFunction(composerIsOpenInPage, EDITOR_SELECTORS, { timeout: 20000 })
      .catch(() => {});
    await delayRandom(800, 1500);
  }

  // Chốt chặn: thà báo lỗi còn hơn gõ nhầm vào ô bình luận của bài khác.
  if (!(await page.evaluate(composerIsOpenInPage, EDITOR_SELECTORS))) {
    sendLog(`[${kind}] [ERROR] Không mở được hộp soạn thảo: ${url}`, 'error');
    return failed();
  }
  if (getIsStopping()) return failed();

  // Composer Page dạng trang riêng: không có dialog, không có bước Next, và
  // bằng chứng đăng xong là RỜI TRANG /post/create chứ không phải dialog đóng.
  const isStandalonePage = await page.evaluate(isStandaloneComposerInPage).catch(() => false);
  if (isStandalonePage) {
    sendLog('[Đăng Bài] Facebook mở hộp soạn thảo dạng trang riêng (/post/create).', 'info');
  }

  // 2. Nạp media — input file phải nằm TRONG dialog (hoặc form của trang
  // /post/create), ngoài đó là input của ô bình luận.
  if (mediaPath) {
    let input = await page.$(FILE_INPUT_SELECTOR).catch(() => null);
    if (!input) {
      sendLog('[Đăng Bài] Đang mở phần đính kèm Ảnh/Video trong hộp soạn thảo...', 'info');
      if (!(await page.evaluate(clickMediaButtonInDialog))) {
        sendLog(`[${kind}] [ERROR] Không thấy nút Ảnh/Video trong hộp soạn thảo: ${url}`, 'error');
        return failed();
      }
      await page.waitForSelector(FILE_INPUT_SELECTOR, { state: 'attached', timeout: 20000 })
        .catch(() => {});
      input = await page.$(FILE_INPUT_SELECTOR).catch(() => null);
    }
    if (!input) {
      sendLog(`[${kind}] [ERROR] Không tìm thấy ô tải tệp trong hộp soạn thảo: ${url}`, 'error');
      return failed();
    }
    sendLog('[Đăng Bài] Đang nạp tệp media đính kèm...', 'warning');
    await input.setInputFiles(mediaPath);
    await delayRandom(4000, 6000);
  }
  if (getIsStopping()) return failed();
  await delayRandom(500, 1000);

  // 3. Gõ nội dung
  if (!(await page.evaluate(focusEditorInPage, EDITOR_SELECTORS))) {
    sendLog(`[${kind}] [ERROR] Không focus được ô nhập trong hộp soạn thảo: ${url}`, 'error');
    return failed();
  }
  for (const char of text) {
    if (getIsStopping()) return failed();
    await page.keyboard.type(char);
    await delayRandom(50, 140);
  }
  await delayRandom(1000, 2000);
  if (getIsStopping()) return failed();

  // 4. Bấm đăng. Composer DIALOG của Page (bản cũ) phải qua bước "Next" trước;
  // trang /post/create không có bước này (đo được) nên bỏ qua hẳn.
  if (!isStandalonePage && await page.evaluate(clickNextInDialog, NEXT_LABELS)) {
    sendLog('[Đăng Bài] Composer nhiều bước, đã bấm "Next", đang chờ bước cuối...', 'info');
    // Chờ theo điều kiện chứ không theo thời gian đoán: bước 2 chỉ sẵn sàng khi
    // nhãn đăng bài xuất hiện trong dialog. Chờ cứng 3-4.5s là chưa đủ và làm
    // click rơi vào lúc bước 2 đang render dở, dialog không bao giờ đóng.
    const ready = await page
      .waitForFunction(publishLabelShownInDialogsInPage, PUBLISH_LABELS, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      sendLog(`[${kind}] [ERROR] Bước cuối của composer không hiện nút Đăng: ${url}`, 'error');
      return failed();
    }
    await delayRandom(1000, 2000);
  }

  // Nghe trong đúng cửa sổ từ lúc bấm Đăng đến lúc dialog đóng, rồi gỡ ngay
  // trong finally — để sống qua bài sau sẽ gán nhầm link của bài trước.
  let capturedId: string | null = null;
  const listenToResponse = (response: Response) => {
    if (capturedId) return;
    if (!/\/api\/graphql/i.test(response.url())) return;
    // Đọc thân bất đồng bộ. Phản hồi đã bị huỷ thì text() ném — nuốt, vì
    // chuyện lấy link không được làm hỏng việc đăng.
    Promise.resolve()
      .then(() => response.text())
      .then(body => {
        // Phản hồi bảng tin cũng chứa "post_id", nhưng là của bài người
        // khác. Chỉ nhận phản hồi của mutation tạo bài — thà không có link
        // còn hơn lưu nhầm link bài người lạ rồi đi quét bình luận của họ.
        if (!/story_create|StoryCreate|create_story|"__typename":"Story"/i.test(body)) return;
        capturedId = capturedId || extractPostIdFromBody(body);
      })
      .catch(() => {});
  };
  page.on('response', listenToResponse);

  let published = false;
  let dialogClosed = false;
  try {
    // Nút Đăng đang tắt nghĩa là Facebook chưa ghi nhận chữ — bấm cũng vô ích.
    // Báo đúng nguyên nhân ngay, thay vì bấm hụt rồi chờ 30 giây báo mơ hồ.
    if (await page.evaluate(isPublishDisabledInPage, PUBLISH_LABELS).catch(() => false)) {
      sendLog(`[${kind}] [ERROR] Nút Đăng đang tắt — Facebook chưa ghi nhận nội dung trong ô soạn: ${url}`, 'error');
      return failed();
    }
    sendLog('[Đăng Bài] Đang click nút Đăng bài...', 'info');
    try {
      published = await page.evaluate(markPublishButtonInPage, PUBLISH_LABELS);
      // Click tin cậy qua locator. Nếu click ném lỗi thì published vẫn là true:
      // không có bằng chứng nào ở đây cả, quyết định nằm ở phép chờ dialog đóng
      // / rời /post/create bên dưới (bằng chứng dương), không phải ở việc click.
      if (published) await page.locator('[data-maihub-target="publish"]').first().click({ timeout: 10000 });
    } catch (e) {
      sendLog(`Lỗi tìm nút Đăng bằng evaluate: ${(e as Error).message}`, 'warning');
    }

    if (!published) {
      const root = isStandalonePage ? '' : `${DIALOG_SELECTOR} `;
      const fallback = PUBLISH_LABELS
        .map(l => `${root}div[role="button"][aria-label="${l}"]`)
        .join(', ');
      try {
        await humanClick(page, fallback);
        published = true;
      } catch (e) {
        sendLog(`[${kind}] Nút Đăng bài không phản hồi bằng selector dự phòng.`, 'warning');
      }
    }

    if (!published) {
      sendLog(`[${kind}] [ERROR] Không tìm thấy nút Đăng: ${url}`, 'error');
      return failed();
    }

    // Đóng modal gợi ý nếu Facebook chen vào, trước khi kết luận.
    await delayRandom(2000, 3000);
    if (await page.evaluate(dismissInterstitialInDialog, DISMISS_LABELS)) {
      sendLog('[Đăng Bài] Đã đóng modal gợi ý của Facebook.', 'info');
      await delayRandom(1500, 2500);
    }

    // Click được nút chưa chứng minh Facebook đã nhận bài. Tín hiệu thật:
    // - dialog: đóng lại; còn mở nghĩa là bài chưa đi (lỗi, chặn, click hụt).
    // - trang /post/create: RỜI khỏi trang đó. CHƯA đo được trên bài thật
    //   (đo là phải đăng thật); là suy luận từ việc trang này chỉ tồn tại để
    //   soạn. Sai thì công cụ báo hỏng oan, không bao giờ báo thành công oan.
    dialogClosed = isStandalonePage
      ? await page.waitForFunction(hasLeftCreatePageInPage, null, { timeout: 30000 })
        .then(() => true).catch(() => false)
      : await page.waitForSelector(DIALOG_SELECTOR, { state: 'hidden', timeout: 30000 })
        .then(() => true).catch(() => false);

    if (!dialogClosed) {
      sendLog(isStandalonePage
        ? `[${kind}] [ERROR] Đã click Đăng nhưng vẫn ở trang /post/create — bài chưa lên: ${url}`
        : `[${kind}] [ERROR] Đã click Đăng nhưng hộp soạn thảo không đóng — bài chưa lên: ${url}`, 'error');
      return failed();
    }
  } finally {
    page.off('response', listenToResponse);
  }

  sendLog(`[${kind}] [SUCCESS] Đã đăng thành công: ${url}`, 'success');

  // Nghỉ để các phản hồi GraphQL đang bay về kịp settle qua response.text() —
  // không đón được phản hồi đến muộn hơn khoảng nghỉ này, vì listener đã bị
  // gỡ (page.off) ở nhánh finally phía trên trước khi tới đây.
  await delayRandom(1500, 2500);

  let postUrl = buildPostUrl({ url }, capturedId);
  if (!postUrl) {
    postUrl = await findOwnPostUrl(page, ctx);
  }
  if (!postUrl) {
    sendLog(
      `[${kind}] Đã đăng nhưng không lấy được link bài — bài này sẽ không quét bình luận được: ${url}`,
      'warning',
    );
  }

  // Bình luận SAU khi bài đã lên, và KHÔNG bao giờ làm hỏng kết quả đăng: bài
  // đã nằm trên nhóm rồi, báo hỏng ở đây sẽ khiến người dùng đăng lại và thành
  // hai bài trùng. postFirstComment tự nuốt mọi lỗi và trả trạng thái.
  const outcome = await postFirstComment(page, { postUrl, comment, text }, { sendLog, getIsStopping });
  if (outcome.status !== 'not_requested' && outcome.status !== 'posted') {
    sendLog(`[${kind}] Bình luận chưa vào được (${url}): ${outcome.reason}`, 'warning');
  }

  return { ok: true, postUrl, commentStatus: outcome.status, identity };
}

export interface PostTargetResult {
  url: string;
  ok: boolean;
  error: string | null;
  postUrl: string | null;
  commentStatus: CommentStatus;
  /** Danh tính đọc được từ lời mời soạn bài của đích này ('' nếu không đọc được). */
  identity: string;
}

export interface PostInput {
  text: string;
  mediaPath?: string | null;
  comment?: string | null;
  targets: string[];
  /** Giây nghỉ tối thiểu giữa hai đích. */
  minDelay?: number;
  /** Giây nghỉ tối đa giữa hai đích. */
  maxDelay?: number;
}

export async function postToTargets(
  input: PostInput,
  deps: TaskDeps & { onResult?: (result: PostTargetResult) => void },
): Promise<{ posted: number; failed: number; results: PostTargetResult[] }> {
  const { text, mediaPath = null, comment = null, targets, minDelay = 30, maxDelay = 60 } = (input || {}) as Partial<PostInput>;
  const { getIsStopping, sendLog, updateProgress, onResult } = deps;

  if (!text || !String(text).trim()) {
    throw new Error('Nội dung bài viết không được để trống!');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('Danh sách nhóm/trang để đăng trống!');
  }
  const normalized = targets.map(normalizeTarget);

  const { ctx, page } = await deps.launch();
  const results: PostTargetResult[] = [];
  try {
    sendLog('Đang mở Facebook và kiểm tra phiên đăng nhập...', 'info');
    await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (!(await isLoggedIn(ctx))) {
      throw new Error('Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập.');
    }

    if (mediaPath) {
      page.on('filechooser', async chooser => {
        try {
          sendLog(`[Đăng Bài] Đã chặn hộp thoại file và nạp tệp: ${mediaPath}`, 'info');
          await chooser.setFiles(mediaPath);
        } catch (err) {
          sendLog(`Lỗi nạp tệp qua filechooser: ${(err as Error).message}`, 'warning');
        }
      });
    }

    let current = 0;
    for (const target of normalized) {
      if (getIsStopping()) break;
      current += 1;
      updateProgress(
        Math.round((current / normalized.length) * 100),
        `Đang đăng ${current}/${normalized.length}`,
      );

      let ok = false;
      let error: string | null = null;
      let postUrl: string | null = null;
      // 'not_requested' là mặc định đúng: không nhập bình luận thì không có gì
      // để báo, và lịch sử không được ghi thành "hỏng".
      let commentStatus: CommentStatus = 'not_requested';
      let identity = '';
      try {
        const single = await postToSingleTarget(page, ctx, target, { text, mediaPath, comment },
          { getIsStopping, sendLog });
        // postToSingleTarget trả ok:false mà không ném lỗi: lý do đã nằm trong nhật ký.
        // Nơi ghi lịch sử điền câu mặc định khi error là null (FB Poster: normalizeResults).
        ok = single.ok;
        postUrl = single.postUrl;
        identity = single.identity;
        if (single.commentStatus) commentStatus = single.commentStatus;
      } catch (err) {
        error = (err as Error).message;
        sendLog(`Lỗi khi đăng ${target.url}: ${(err as Error).message}`, 'error');
      }
      const entry: PostTargetResult = { url: target.url, ok, error, postUrl, commentStatus, identity };
      results.push(entry);
      // Báo ngay khi đích này xong để nơi gọi ghi lịch sử/hiển thị từng bước,
      // không đợi cả lượt.
      try {
        onResult?.(entry);
      } catch (err) {
        // Lỗi ở nơi nhận kết quả (ghi lịch sử...) không được làm dừng các đích còn lại.
        sendLog(`Lỗi khi báo kết quả ${target.url}: ${(err as Error).message}`, 'warning');
      }

      if (current < normalized.length && !getIsStopping()) {
        const secs = pickDelaySeconds(minDelay, maxDelay);
        sendLog(`Nghỉ ${secs} giây trước bài viết tiếp theo...`, 'info');
        await delayRandom(secs * 1000, secs * 1000);
      }
    }
    updateProgress(100, 'Hoàn tất');
  } finally {
    await ctx.close().catch(() => {});
  }

  const posted = results.filter(r => r.ok).length;
  return { posted, failed: results.length - posted, results };
}
