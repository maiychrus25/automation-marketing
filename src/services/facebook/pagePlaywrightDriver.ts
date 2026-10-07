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
import { FacebookPageBrowserSender, PageInboxDriver, PageStickerThumb } from './FacebookPageBrowserSender';
import { PAGE_BIZ_SUITE } from './pageBusinessSuiteSelectors';
import { buildThreadUrl, isSendableThreadId } from './pageSendHelpers';

const OPEN_TIMEOUT_MS = 25000;
const STAGE_TIMEOUT_MS = 30000; // chờ đính kèm hiện lên khung
const ATTACH_SETTLE_MS = 7000;  // chờ upload đính kèm xong trước khi Enter (Enter sớm làm rớt ảnh)
const IDLE_CLOSE_MS = 5 * 60 * 1000;
// Vùng lưới sticker trong bảng chọn (popover trên composer), để loại sticker nằm trong khung chat.
const STICKER_PANEL = { minY: 520, maxY: 815, minX: 660, maxX: 965 };

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
  private currentThreadId = '';
  private lastSendHadFiles = false;

  constructor(private page: Page, private delegatePageId: string) {}

  /** true nếu đang CÓ nội dung chờ gửi (nút "Gửi lượt thích" vắng mặt). */
  private async hasPendingContent(): Promise<boolean> {
    return (await this.page.locator(PAGE_BIZ_SUITE.likeButton).count()) === 0;
  }

  /** Số ảnh ĐI (outgoing, lệch phải) trong khung — mốc để xác nhận ảnh GỬI đã lên khung. */
  private async imageCount(): Promise<number> {
    return this.page.evaluate(() => {
      const W = window.innerWidth;
      let n = 0;
      document.querySelectorAll('img').forEach((im) => {
        const el = im as HTMLImageElement; const r = el.getBoundingClientRect(); const src = el.src || '';
        if (!/fbcdn|scontent/.test(src)) return;
        if (r.width < 60 || r.height < 60 || r.x < 480) return;
        if ((r.x + r.width) < (W - 150)) return;   // chỉ đếm ảnh ĐI (hugs phải)
        n++;
      });
      return n;
    });
  }

  async openThread(threadId: string): Promise<void> {
    this.lastSendHadFiles = false; // reset đầu mỗi lần gửi
    if (!this.delegatePageId) throw new Error('thiếu delegate page id của Page');
    if (!isSendableThreadId(threadId)) throw new Error(`threadId không hợp lệ: ${threadId}`);
    const composer = this.page.locator(PAGE_BIZ_SUITE.composer).first();

    // Tối ưu trễ: nếu đang ở ĐÚNG hội thoại và ô soạn còn đó → khỏi tải lại trang.
    if (threadId === this.currentThreadId && !/loginpage/.test(this.page.url())) {
      if (await composer.count()) {
        try { await composer.waitFor({ state: 'visible', timeout: 3000 }); return; } catch { /* tải lại bên dưới */ }
      }
    }

    const url = buildThreadUrl(this.delegatePageId, threadId);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/loginpage/.test(this.page.url())) {
      this.currentThreadId = '';
      throw new Error('phiên Business Suite đã đăng xuất — cần đăng nhập lại 1 lần cho Page này');
    }
    try {
      await composer.waitFor({ state: 'visible', timeout: OPEN_TIMEOUT_MS });
    } catch {
      this.currentThreadId = '';
      throw new Error('không mở được hội thoại (không thấy ô soạn tin)');
    }
    this.currentThreadId = threadId;
  }

  async attachFiles(paths: string[]): Promise<void> {
    this.lastSendHadFiles = true;
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

  async readIncomingMedia(_threadId: string, max: number): Promise<{ type: 'image' | 'video' | 'sticker'; url: string }[]> {
    // openThread đã do caller (doRead) gọi. Cuộn đáy rồi lấy media-tin ĐẾN (khách gửi).
    try {
      await this.page.evaluate(() => {
        document.querySelectorAll('*').forEach((el) => {
          if ((el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 50) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
        });
      });
      await this.page.waitForTimeout(1200);
    } catch { /* ignore */ }
    return this.page.evaluate((limit) => {
      const W = window.innerWidth;
      const out: { type: 'image' | 'video' | 'sticker'; url: string; y: number }[] = [];
      // ảnh đến: hugs trái, đủ lớn (bỏ avatar/emoji), cột phải (bỏ danh sách)
      document.querySelectorAll('img').forEach((im) => {
        const el = im as HTMLImageElement; const r = el.getBoundingClientRect(); const src = el.src || '';
        if (!/fbcdn|scontent/.test(src)) return;
        if (r.width < 60 || r.height < 60 || r.x < 480) return;
        if ((r.x + r.width) >= (W - 150)) return;          // hugs phải = ảnh đi
        out.push({ type: 'image', url: src, y: r.y });
      });
      // video đến: <video src=fbcdn>, hugs trái
      document.querySelectorAll('video').forEach((v) => {
        const el = v as HTMLVideoElement; const r = el.getBoundingClientRect();
        const src = el.src || el.currentSrc || '';
        if (!/fbcdn|scontent/.test(src) || r.x < 480) return;
        if ((r.x + r.width) >= (W - 150)) return;
        out.push({ type: 'video', url: src, y: r.y });
      });
      // sticker đến: div[role=img][aria-label$=" sticker"], hugs trái, ảnh qua background-image
      document.querySelectorAll('div[role="img"][aria-label$=" sticker"]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 50 || r.x < 480) return;
        if ((r.x + r.width) >= (W - 150)) return;          // hugs phải = đi → bỏ
        const bg = getComputedStyle(el as HTMLElement).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && /fbcdn|scontent/.test(m[1])) out.push({ type: 'sticker', url: m[1], y: r.y });
      });
      out.sort((a, b) => b.y - a.y);                       // mới (dưới) → cũ
      const seen = new Set<string>();
      const res: { type: 'image' | 'video' | 'sticker'; url: string }[] = [];
      for (const o of out) { if (!seen.has(o.url)) { seen.add(o.url); res.push({ type: o.type, url: o.url }); } if (res.length >= limit) break; }
      return res;
    }, max);
  }

  async waitSent(timeoutMs: number): Promise<void> {
    // Xác nhận bằng "nội dung đã được tiêu thụ" (nút "Gửi lượt thích" quay lại) cho MỌI loại.
    // Tin cậy cho text/emoji và ảnh-có-caption → KHÔNG fail giả → KHÔNG kích hoạt queue retry
    // (retry là nguồn spam vì trình duyệt thật ra đã gửi). getByText/đếm-ảnh hay fail giả nên bỏ.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.hasPendingContent())) return;
      await this.page.waitForTimeout(400);
    }
    throw new Error('quá hạn chờ xác nhận đã gửi');
  }

  /** Mở bảng chọn sticker và gõ keyword; trả về khi lưới kết quả đã render (hoặc hết chờ). */
  private async openStickerSearch(keyword: string): Promise<void> {
    const search = this.page.locator(PAGE_BIZ_SUITE.stickerSearch).first();
    // Nút sticker là TOGGLE: chỉ click MỞ khi picker chưa mở (ô search chưa có),
    // tránh click khi đang mở (list để mở sẵn) làm ĐÓNG picker rồi gửi hụt.
    if ((await search.count()) === 0) {
      await this.page.locator(PAGE_BIZ_SUITE.stickerButton).first().click({ timeout: 8000 });
      await this.page.waitForTimeout(1500);
    }
    await search.click({ timeout: 6000 });
    await search.fill('');
    if (keyword) await search.type(keyword, { delay: 30 });
    // Chờ lưới sticker thật render (poll thay vì sleep cố định — cold-load render chậm,
    // sleep cố định hay trả rỗng ở lần đầu). Hết hạn vẫn trả (keyword có thể không có kết quả).
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await this.panelStickerCells()).length > 0) return;
      await this.page.waitForTimeout(400);
    }
  }

  /** Các ô sticker TRONG panel (loại sticker trong khung chat), thứ tự y→x. */
  private async panelStickerCells(): Promise<{ cx: number; cy: number; label: string; thumbUrl: string }[]> {
    return this.page.evaluate((P) => {
      const out: { cx: number; cy: number; label: string; thumbUrl: string }[] = [];
      document.querySelectorAll('div[role="img"][aria-label$=" sticker"]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.y < P.minY || r.y > P.maxY || r.x < P.minX || r.x > P.maxX || r.width < 40) return;
        const bg = getComputedStyle(el as HTMLElement).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        out.push({ cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2),
          label: (el.getAttribute('aria-label') || '').slice(0, 80), thumbUrl: m ? m[1] : '' });
      });
      out.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
      return out;
    }, STICKER_PANEL);
  }

  async listStickers(_threadId: string, keyword: string, max: number): Promise<PageStickerThumb[]> {
    await this.openStickerSearch(keyword);
    const cells = await this.panelStickerCells();
    return cells.slice(0, max).map((c) => ({ label: c.label, thumbUrl: c.thumbUrl }));
  }

  async sendSticker(_threadId: string, keyword: string, index: number): Promise<void> {
    await this.openStickerSearch(keyword);
    const cells = await this.panelStickerCells();
    const cell = cells[index] || cells[0];
    if (!cell) throw new Error('không tìm thấy sticker để gửi');
    await this.page.mouse.move(cell.cx, cell.cy);
    await this.page.waitForTimeout(200);
    await this.page.mouse.down(); await this.page.waitForTimeout(70); await this.page.mouse.up();
    // Xác nhận gửi (độc lập vị trí bong bóng): click ô sticker hợp lệ → Business Suite ĐÓNG
    // bảng chọn (ô search biến mất). Pane hội thoại không full-width nên không đếm "hugs phải"
    // được; picker-đóng là tín hiệu dương tin cậy (đã kiểm: searchOpen→false sau khi gửi).
    const search = this.page.locator(PAGE_BIZ_SUITE.stickerSearch);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await search.count()) === 0) return; // picker đóng = đã gửi
      await this.page.waitForTimeout(300);
    }
    throw new Error('quá hạn chờ xác nhận gửi sticker');
  }
}

interface Live { ctx: BrowserContext; sender: FacebookPageBrowserSender; idleTimer: NodeJS.Timeout | null; }
const live = new Map<string, Live>();
const launching = new Map<string, Promise<FacebookPageBrowserSender>>();

export interface PageBrowserSenderDeps {
  getCookie: () => string;
  delegatePageId: string;
}

/** Lấy/khởi tạo sender trình duyệt cho một Page; giữ sống & tái dùng, tự đóng khi idle. */
export async function getPageBrowserSender(pageAccountId: string, deps: PageBrowserSenderDeps): Promise<FacebookPageBrowserSender> {
  if (!deps.delegatePageId) throw new Error('Page thiếu delegate page id — không gửi được qua Business Suite');
  const existing = live.get(pageAccountId);
  if (existing) { armIdle(pageAccountId); return existing.sender; }
  // Chống mở trình duyệt đồng thời (thông báo Page hay bị phát trùng) trên cùng userDataDir.
  const pending = launching.get(pageAccountId);
  if (pending) return pending;
  const p = launchSender(pageAccountId, deps).finally(() => launching.delete(pageAccountId));
  launching.set(pageAccountId, p);
  return p;
}

async function launchSender(pageAccountId: string, deps: PageBrowserSenderDeps): Promise<FacebookPageBrowserSender> {
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
