/**
 * pagePlaywrightDriver.ts
 * Driver DOM thật + vòng đời trình duyệt cho gửi tin vai Page qua Meta Business Suite.
 * Tách khỏi FacebookPageBrowserSender.ts để file điều phối không kéo theo playwright khi test.
 *
 * Phiên đăng nhập nằm trong userDataDir (đăng nhập 1 lần headful; sau đó headless dùng lại).
 * Cookie app được inject thêm nhưng KHÔNG đủ tự đăng nhập web — userDataDir là nguồn phiên chính.
 *
 * Xác nhận đã gửi (tín hiệu dương, không phải "composer trống"): Business Suite hiện nút
 * "Gửi lượt thích" khi KHÔNG có nội dung chờ gửi; có text/đính kèm → nút biến mất; gửi xong
 * → quay lại. Vậy: trước gửi phải thấy "có nội dung" (nút vắng), sau gửi phải thấy nút quay lại.
 */

import { chromium, BrowserContext, Page } from 'playwright-core';
import path from 'path';
import fs from 'fs';
import { FacebookPageBrowserSender, PageInboxDriver } from './FacebookPageBrowserSender';
import { PAGE_BIZ_SUITE } from './pageBusinessSuiteSelectors';
import { buildThreadUrl, isSendableThreadId } from './pageSendHelpers';

const OPEN_TIMEOUT_MS = 25000;
const STAGE_TIMEOUT_MS = 30000; // chờ đính kèm hiện lên khung
const ATTACH_SETTLE_MS = 7000;  // chờ upload đính kèm xong trước khi Enter (Enter sớm làm rớt ảnh)
const IDLE_CLOSE_MS = 5 * 60 * 1000;

function resolveEngineExecutable(): string {
  if (process.env.FB_PAGE_BROWSER_ENGINE) return process.env.FB_PAGE_BROWSER_ENGINE;
  const { app } = require('electron');
  const { BrowserEngineManager } = require('../browser/BrowserEngineManager');
  const mgr = new BrowserEngineManager(path.join(app.getPath('userData'), 'browser-engine'));
  const exe = mgr.getExecutablePath();
  if (!exe) throw new Error('Engine trình duyệt chưa cài (Browser Profiles). Hãy cài engine rồi thử lại.');
  return exe;
}

function resolveUserDataDir(pageAccountId: string): string {
  if (process.env.FB_PAGE_PROFILE_DIR) return process.env.FB_PAGE_PROFILE_DIR;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'page-browser', pageAccountId);
}

function parseCookiePairs(cookieStr: string) {
  return cookieStr.split(';').map((p) => p.trim()).filter(Boolean)
    .map((pair) => { const i = pair.indexOf('='); return i < 0 ? null : { name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.facebook.com', path: '/', secure: true }; })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

/** Driver điều khiển một BrowserContext đã mở trên inbox Business Suite của một Page. */
class PlaywrightPageInboxDriver implements PageInboxDriver {
  private lastText = '';
  private imgBaseline = 0;

  constructor(private page: Page, private delegatePageId: string) {}

  /** true nếu đang CÓ nội dung chờ gửi (nút "Gửi lượt thích" vắng mặt). */
  private async hasPendingContent(): Promise<boolean> {
    return (await this.page.locator(PAGE_BIZ_SUITE.likeButton).count()) === 0;
  }

  /** Số ảnh trong trang (avatar + ảnh tin); dùng mốc so sánh để xác nhận ảnh đã lên khung. */
  private async imageCount(): Promise<number> {
    return this.page.evaluate(() =>
      document.querySelectorAll('img[src*="fbcdn"],img[src*="scontent"],img[src^="blob:"]').length);
  }

  async openThread(threadId: string): Promise<void> {
    if (!this.delegatePageId) throw new Error('thiếu delegate page id của Page');
    if (!isSendableThreadId(threadId)) throw new Error(`threadId không hợp lệ: ${threadId}`);
    const url = buildThreadUrl(this.delegatePageId, threadId);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/loginpage/.test(this.page.url())) {
      throw new Error('phiên Business Suite đã đăng xuất — cần đăng nhập lại 1 lần cho Page này');
    }
    try {
      await this.page.locator(PAGE_BIZ_SUITE.composer).first().waitFor({ state: 'visible', timeout: OPEN_TIMEOUT_MS });
    } catch {
      throw new Error('không mở được hội thoại (không thấy ô soạn tin)');
    }
  }

  async attachFiles(paths: string[]): Promise<void> {
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`file không tồn tại: ${p}`);
    }
    this.imgBaseline = await this.imageCount(); // mốc ảnh trước khi đính kèm
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      this.page.locator(PAGE_BIZ_SUITE.attachButton).first().click({ timeout: 8000 }),
    ]);
    await chooser.setFiles(paths);
    // Chờ đính kèm LÊN KHUNG (nút "Gửi lượt thích" biến mất = có nội dung chờ gửi).
    const deadline = Date.now() + STAGE_TIMEOUT_MS;
    let staged = false;
    while (Date.now() < deadline) {
      if (await this.hasPendingContent()) { staged = true; break; }
      await this.page.waitForTimeout(400);
    }
    if (!staged) throw new Error('đính kèm chưa sẵn sàng để gửi (không thấy nội dung chờ gửi)');
    // QUAN TRỌNG: bấm Enter TRƯỚC khi upload xong sẽ làm Business Suite BỎ ảnh.
    // Chưa có tín hiệu "upload xong" rõ ràng → chờ settle cố định.
    // ponytail: settle cố định ATTACH_SETTLE_MS; thay bằng dò trạng thái ready nếu file lớn flaky.
    await this.page.waitForTimeout(ATTACH_SETTLE_MS);
  }

  async sendText(text: string): Promise<void> {
    this.lastText = text || '';
    const composer = this.page.locator(PAGE_BIZ_SUITE.composer).first();
    await composer.click();
    if (text) await composer.type(text, { delay: 15 });
    // Bắt buộc có nội dung chờ gửi trước khi gửi (chặn gửi rỗng / đính kèm hụt).
    if (!(await this.hasPendingContent())) {
      throw new Error('không có nội dung để gửi');
    }
    // Gửi bằng Enter MỘT lần. KHÔNG bấm nút "Gửi" và KHÔNG lặp Enter/re-click:
    // Enter sớm (trước khi upload xong) hoặc click nút đều làm Business Suite BỎ đính kèm.
    await composer.press('Enter');
  }

  async waitSent(timeoutMs: number): Promise<void> {
    // Xác nhận GIAO HÀNG bằng tín hiệu dương, không phải "composer trống":
    //  - có text/caption → chờ đúng chữ hiện thành bong bóng trong khung.
    //  - không caption (ảnh/file) → chờ số ảnh trong khung tăng so với mốc trước khi đính kèm.
    const text = this.lastText.trim();
    if (text) {
      try {
        await this.page.locator('div[dir="auto"]', { hasText: text }).first()
          .waitFor({ state: 'visible', timeout: timeoutMs });
        return;
      } catch {
        throw new Error('không xác nhận được tin đã lên khung (có thể chưa gửi được)');
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.imageCount()) > this.imgBaseline) return;
      await this.page.waitForTimeout(500);
    }
    throw new Error('không xác nhận được đính kèm đã lên khung (có thể chưa gửi được)');
  }
}

interface Live { ctx: BrowserContext; sender: FacebookPageBrowserSender; idleTimer: NodeJS.Timeout | null; }
const live = new Map<string, Live>();

export interface PageBrowserSenderDeps {
  getCookie: () => string;
  delegatePageId: string;
}

/** Lấy/khởi tạo sender trình duyệt cho một Page; giữ sống & tái dùng, tự đóng khi idle. */
export async function getPageBrowserSender(pageAccountId: string, deps: PageBrowserSenderDeps): Promise<FacebookPageBrowserSender> {
  if (!deps.delegatePageId) throw new Error('Page thiếu delegate page id — không gửi được qua Business Suite');
  const existing = live.get(pageAccountId);
  if (existing) { armIdle(pageAccountId); return existing.sender; }

  const ctx = await chromium.launchPersistentContext(resolveUserDataDir(pageAccountId), {
    executablePath: resolveEngineExecutable(),
    headless: process.env.FB_PAGE_HEADLESS === '0' ? false : true,
    viewport: { width: 1400, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    try {
      const cookie = deps.getCookie();
      if (cookie) await ctx.addCookies(parseCookiePairs(cookie));
    } catch { /* cookie phụ trợ; phiên chính nằm ở userDataDir */ }

    const page = ctx.pages()[0] || await ctx.newPage();
    const driver = new PlaywrightPageInboxDriver(page, deps.delegatePageId);
    const sender = new FacebookPageBrowserSender({ driver, delegatePageId: deps.delegatePageId });
    live.set(pageAccountId, { ctx, sender, idleTimer: null });
    armIdle(pageAccountId);
    return sender;
  } catch (err) {
    try { await ctx.close(); } catch { /* ignore */ }
    throw err;
  }
}

function armIdle(pageAccountId: string): void {
  const l = live.get(pageAccountId);
  if (!l) return;
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(() => { closePageBrowserSender(pageAccountId).catch(() => {}); }, IDLE_CLOSE_MS);
}

/** Đóng trình duyệt của một Page (idle hoặc khi Page tắt/disconnect). */
export async function closePageBrowserSender(pageAccountId: string): Promise<void> {
  const l = live.get(pageAccountId);
  if (!l) return;
  live.delete(pageAccountId);
  if (l.idleTimer) clearTimeout(l.idleTimer);
  try { await l.ctx.close(); } catch { /* ignore */ }
}
