/**
 * pagePlaywrightDriver.ts
 * Driver DOM thật + vòng đời trình duyệt cho gửi tin vai Page qua Meta Business Suite.
 * Tách khỏi FacebookPageBrowserSender.ts để file điều phối không kéo theo playwright khi test.
 *
 * Phiên đăng nhập nằm trong userDataDir (đăng nhập 1 lần headful; sau đó headless dùng lại).
 * Cookie app được inject thêm nhưng KHÔNG đủ tự đăng nhập web — userDataDir là nguồn phiên chính.
 */

import { chromium, BrowserContext, Page } from 'playwright-core';
import path from 'path';
import { FacebookPageBrowserSender, PageInboxDriver } from './FacebookPageBrowserSender';
import { PAGE_BIZ_SUITE } from './pageBusinessSuiteSelectors';
import { buildThreadUrl } from './pageSendHelpers';

const OPEN_TIMEOUT_MS = 25000;
const UPLOAD_WAIT_MS = 4000;
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
  return cookieStr.split(';').map((p) => p.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: '.facebook.com', path: '/', secure: true };
  });
}

/** Driver điều khiển một BrowserContext đã mở trên inbox Business Suite của một Page. */
class PlaywrightPageInboxDriver implements PageInboxDriver {
  constructor(private page: Page, private delegatePageId: string) {}

  async openThread(threadId: string): Promise<void> {
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
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      this.page.locator(PAGE_BIZ_SUITE.attachButton).first().click({ timeout: 8000 }),
    ]);
    await chooser.setFiles(paths);
    await this.page.waitForTimeout(UPLOAD_WAIT_MS); // ponytail: chờ upload cố định; đổi sang chờ preview nếu flaky
  }

  async sendText(text: string): Promise<void> {
    const composer = this.page.locator(PAGE_BIZ_SUITE.composer).first();
    await composer.click();
    if (text) await composer.type(text, { delay: 15 });
    await composer.press('Enter');
    // Fallback: nếu Enter không gửi (composer vẫn còn chữ), bấm nút Gửi
    await this.page.waitForTimeout(800);
    const remaining = (await composer.innerText().catch(() => '')).trim();
    if (text && remaining.includes(text.trim())) {
      const btn = this.page.locator(PAGE_BIZ_SUITE.sendButton).last();
      if (await btn.count()) await btn.click({ timeout: 5000 }).catch(() => {});
    }
  }

  async waitSent(timeoutMs: number): Promise<void> {
    const composer = this.page.locator(PAGE_BIZ_SUITE.composer).first();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const txt = (await composer.innerText().catch(() => '')).trim();
      if (txt === '') return; // composer trống = đã gửi
      await this.page.waitForTimeout(400);
    }
    throw new Error('quá hạn chờ xác nhận đã gửi');
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
  const existing = live.get(pageAccountId);
  if (existing) { armIdle(pageAccountId); return existing.sender; }

  const ctx = await chromium.launchPersistentContext(resolveUserDataDir(pageAccountId), {
    executablePath: resolveEngineExecutable(),
    headless: process.env.FB_PAGE_HEADLESS === '0' ? false : true,
    viewport: { width: 1400, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
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
