# Facebook Page Sticker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gửi & nhận sticker (nhãn dán) vai Page qua Meta Business Suite, và xác nhận emoji/icon chạy ổn.

**Architecture:** Tái dùng hạ tầng trình duyệt Page sẵn có (`FacebookPageBrowserSender` + `pagePlaywrightDriver`). Nhận sticker đi chung đường nhận ảnh (lưu `type=image`). Gửi sticker = mở picker Business Suite → search keyword → click ô sticker thứ `index`. UI thêm `FbStickerPicker` nhỏ riêng (không nhồi vào `StickerPicker` Zalo).

**Tech Stack:** TypeScript, Electron IPC, playwright-core, better-sqlite3, React (renderer), jest.

**Spec:** `docs/specs/2026-10-07-facebook-page-sticker.md`

## Global Constraints

- Code identifiers English-only; copy/UI tiếng Việt OK.
- Page detect ở service: `FacebookService.isPage()`; ở UI: `isFacebook(channel) && !!account.parent_zalo_id`.
- Không đổi đường gửi/nhận text/ảnh/video đang chạy; không thêm message-type DB mới (sticker lưu `type='image'`).
- Xác nhận gửi bằng **tín hiệu dương** (không false-fail → tránh MessageQueue retry spam).
- Build: `npx tsc -p tsconfig.electron.json` exit 0. Test: jest. Không tự push/release.
- Driver DOM dùng **real mouse click** cho ô sticker (React cần mouse event thật; `element.click()` không ăn).

## Review Focus

- **Body thông báo 2 ngôn ngữ**: "Đã gửi một nhãn dán" và "sent a sticker" đều phải ra `wantType='sticker'` → test ở Task 1.
- **Search không có kết quả**: `listStickers` trả `[]` (không throw), UI hiện "không tìm thấy" → test Task 2, xử lý Task 3/5.
- **Index drift**: thứ tự lưới lúc list và lúc send phải khớp → Task 3 gửi ngay sau khi list trong **cùng phiên picker** cùng keyword.
- **Thumbnail scontent vỡ trong renderer** (CDN đòi cookie) → `<img onError>` fallback (ẩn hoặc placeholder) → Task 5.
- **Sticker đến chỉ bên trái**: `readIncomingMedia` sticker chỉ lấy ô hugs-trái (bỏ sticker mình gửi bên phải) → Task 3.

---

### Task 1: Selectors + bộ phân loại thông báo (pure, TDD)

**Files:**
- Modify: `src/services/facebook/pageBusinessSuiteSelectors.ts`
- Modify: `src/services/facebook/pageSendHelpers.ts`
- Test: `src/__tests__/facebook/pageSendHelpers.test.ts`

**Interfaces:**
- Produces: `PAGE_BIZ_SUITE.stickerButton | stickerSearch | stickerCell` (string selectors);
  `classifyPageNotification(body: string): 'image' | 'video' | 'sticker' | null`

- [ ] **Step 1: Thêm selector sticker** vào `pageBusinessSuiteSelectors.ts` (bổ sung 3 field vào interface + object):

```ts
// trong interface PageBizSuiteSelectors, thêm:
  /** Nút mở bảng chọn nhãn dán. */
  stickerButton: string;
  /** Ô tìm kiếm nhãn dán trong bảng chọn. */
  stickerSearch: string;
  /** Một ô sticker (ảnh qua background-image) trong bảng chọn hoặc trong khung. */
  stickerCell: string;

// trong PAGE_BIZ_SUITE, thêm:
  stickerButton: 'div[aria-label="Đăng nhãn dán"][role="button"]',
  stickerSearch: 'input[placeholder="Tìm kiếm nhãn dán"]',
  stickerCell: 'div[role="img"][aria-label$=" sticker"]',
```

- [ ] **Step 2: Viết test failing** cho `classifyPageNotification` (thêm vào cuối `pageSendHelpers.test.ts`):

```ts
import { classifyPageNotification } from '../../services/facebook/pageSendHelpers';

describe('classifyPageNotification', () => {
  it('ảnh', () => {
    expect(classifyPageNotification('Đã gửi một ảnh')).toBe('image');
    expect(classifyPageNotification('sent a photo')).toBe('image');
  });
  it('video', () => {
    expect(classifyPageNotification('Đã gửi một tin nhắn video')).toBe('video');
    expect(classifyPageNotification('sent a video')).toBe('video');
  });
  it('sticker 2 ngôn ngữ', () => {
    expect(classifyPageNotification('Đã gửi một nhãn dán')).toBe('sticker');
    expect(classifyPageNotification('sent a sticker')).toBe('sticker');
  });
  it('text thường → null', () => {
    expect(classifyPageNotification('chào shop')).toBeNull();
    expect(classifyPageNotification('')).toBeNull();
  });
});
```

- [ ] **Step 3: Chạy test → fail** (`classifyPageNotification` chưa có):

Run: `npx jest src/__tests__/facebook/pageSendHelpers.test.ts -t classifyPageNotification`
Expected: FAIL "classifyPageNotification is not a function"

- [ ] **Step 4: Thêm hàm** vào `pageSendHelpers.ts`:

```ts
/**
 * Phân loại media từ body thông báo Page (thông báo không kèm nội dung thật).
 * Thứ tự: sticker trước (vì "nhãn dán" không trùng ảnh/video), rồi video, rồi ảnh.
 */
export function classifyPageNotification(body: string): 'image' | 'video' | 'sticker' | null {
  const b = body || '';
  if (/nhãn dán|sent a sticker/i.test(b)) return 'sticker';
  if (/tin nhắn video|đã gửi.*video|sent .*video/i.test(b)) return 'video';
  if (/đã gửi.*ảnh|sent .*photo/i.test(b)) return 'image';
  return null;
}
```

- [ ] **Step 5: Chạy test → pass**

Run: `npx jest src/__tests__/facebook/pageSendHelpers.test.ts`
Expected: PASS (cả test cũ lẫn mới)

- [ ] **Step 6: Commit**

```bash
git add src/services/facebook/pageBusinessSuiteSelectors.ts src/services/facebook/pageSendHelpers.ts src/__tests__/facebook/pageSendHelpers.test.ts
git commit -m "feat(facebook): sticker selectors + page notification classifier"
```

---

### Task 2: Orchestrator — listStickers/sendSticker (pure, TDD, FakeDriver)

**Files:**
- Modify: `src/services/facebook/FacebookPageBrowserSender.ts`
- Test: `src/__tests__/facebook/FacebookPageBrowserSender.test.ts`

**Interfaces:**
- Consumes: `PageInboxDriver` (Task cũ).
- Produces:
  - `interface PageStickerThumb { label: string; thumbUrl: string }`
  - `PageInboxDriver.listStickers(threadId, keyword, max): Promise<PageStickerThumb[]>`
  - `PageInboxDriver.sendSticker(threadId, keyword, index): Promise<void>`
  - `PageIncomingMedia.type` mở rộng thành `'image' | 'video' | 'sticker'`
  - `FacebookPageBrowserSender.listStickers(threadId, keyword, max?): Promise<PageStickerThumb[]>`
  - `FacebookPageBrowserSender.sendSticker(threadId, keyword, index): Promise<PageSendResult>`

- [ ] **Step 1: Mở rộng interface + type** trong `FacebookPageBrowserSender.ts`:

```ts
export interface PageStickerThumb { label: string; thumbUrl: string; }

export interface PageIncomingMedia { type: 'image' | 'video' | 'sticker'; url: string; }

// trong interface PageInboxDriver, thêm:
  /** Liệt kê sticker theo keyword (scrape bảng chọn). */
  listStickers(threadId: string, keyword: string, max: number): Promise<PageStickerThumb[]>;
  /** Gửi sticker thứ `index` trong kết quả search `keyword`. Ném nếu không xác nhận gửi. */
  sendSticker(threadId: string, keyword: string, index: number): Promise<void>;
```

- [ ] **Step 2: Cập nhật FakeDriver + viết test failing** trong `FacebookPageBrowserSender.test.ts`.
  Thêm vào FakeDriver (giữ các method cũ):

```ts
  stickers: { label: string; thumbUrl: string }[] = [{ label: 'a sticker', thumbUrl: 'u1' }];
  async listStickers(id: string, kw: string): Promise<{ label: string; thumbUrl: string }[]> {
    this.calls.push('list:' + id + ':' + kw);
    return this.stickers;
  }
  async sendSticker(id: string, kw: string, index: number): Promise<void> {
    if (this.failWait) throw new Error('timeout chờ xác nhận');
    this.calls.push('sticker:' + id + ':' + kw + ':' + index);
  }
```

  Thêm test:

```ts
  it('listStickers: open ngầm + trả danh sách', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.listStickers('123', 'vui', 20);
    expect(r).toEqual([{ label: 'a sticker', thumbUrl: 'u1' }]);
    expect(d.calls).toContain('list:123:vui');
  });

  it('sendSticker: open → sticker, success', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.sendSticker('123', 'vui', 0);
    expect(r.success).toBe(true);
    expect(d.calls).toEqual(['open:123', 'sticker:123:vui:0']);
  });

  it('sendSticker lỗi → success=false, error Business Suite', async () => {
    const d = new FakeDriver(); d.failWait = true;
    const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).sendSticker('1', 'vui', 0);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Business Suite/);
  });
```

- [ ] **Step 3: Chạy test → fail**

Run: `npx jest src/__tests__/facebook/FacebookPageBrowserSender.test.ts -t sticker`
Expected: FAIL (`s.sendSticker is not a function`)

- [ ] **Step 4: Thêm method** vào class `FacebookPageBrowserSender` (dùng mutex như `send`/`readIncomingMedia`):

```ts
  listStickers(threadId: string, keyword: string, max = 24): Promise<PageStickerThumb[]> {
    const run = this.queue.then(
      () => this.doListStickers(threadId, keyword, max),
      () => this.doListStickers(threadId, keyword, max),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  sendSticker(threadId: string, keyword: string, index: number): Promise<PageSendResult> {
    const run = this.queue.then(
      () => this.doSendSticker(threadId, keyword, index),
      () => this.doSendSticker(threadId, keyword, index),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  private async doListStickers(threadId: string, keyword: string, max: number): Promise<PageStickerThumb[]> {
    try {
      await this.deps.driver.openThread(threadId);
      return await this.deps.driver.listStickers(threadId, keyword, max);
    } catch {
      return [];
    }
  }

  private async doSendSticker(threadId: string, keyword: string, index: number): Promise<PageSendResult> {
    try {
      await this.deps.driver.openThread(threadId);
      await this.deps.driver.sendSticker(threadId, keyword, index);
      return { success: true, messageId: `page:${Date.now()}` };
    } catch (err: any) {
      return { success: false, error: `Chưa gửi được sticker từ Page qua Business Suite: ${err?.message || err}` };
    }
  }
```

- [ ] **Step 5: Chạy test → pass**

Run: `npx jest src/__tests__/facebook/FacebookPageBrowserSender.test.ts`
Expected: PASS (11 cũ + 3 mới)

- [ ] **Step 6: Commit**

```bash
git add src/services/facebook/FacebookPageBrowserSender.ts src/__tests__/facebook/FacebookPageBrowserSender.test.ts
git commit -m "feat(facebook): orchestrator listStickers/sendSticker (mutex, FakeDriver tests)"
```

---

### Task 3: Real driver DOM — listStickers, sendSticker, readIncomingMedia(sticker)

**Files:**
- Modify: `src/services/facebook/pagePlaywrightDriver.ts`

**Interfaces:**
- Consumes: `PAGE_BIZ_SUITE.stickerButton|stickerSearch|stickerCell` (Task 1); `PageStickerThumb`, `PageIncomingMedia` (Task 2).
- Produces: hiện thực `listStickers`, `sendSticker` trong `PlaywrightPageInboxDriver`; mở rộng `readIncomingMedia` thêm sticker.

> Không có unit test (cần trình duyệt). Selector + cơ chế đã verify bằng spike 07/10 (gửi thật 1 sticker OK). Verify thủ công ở Task 6.

- [ ] **Step 1: Thêm helper mở picker + search + scrape** trong `PlaywrightPageInboxDriver` (thêm hằng số đầu file: `const STICKER_PANEL = { minY: 520, maxY: 815, minX: 660, maxX: 965 };`):

```ts
  /** Mở bảng chọn sticker và gõ keyword; trả về khi lưới kết quả đã render (hoặc hết chờ). */
  private async openStickerSearch(keyword: string): Promise<void> {
    await this.page.locator(PAGE_BIZ_SUITE.stickerButton).first().click({ timeout: 8000 });
    await this.page.waitForTimeout(1500);
    const search = this.page.locator(PAGE_BIZ_SUITE.stickerSearch).first();
    await search.click({ timeout: 6000 });
    await search.fill('');
    if (keyword) await search.type(keyword, { delay: 30 });
    await this.page.waitForTimeout(2500); // chờ lưới sticker load
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
```

- [ ] **Step 2: Hiện thực `listStickers`**:

```ts
  async listStickers(_threadId: string, keyword: string, max: number): Promise<PageStickerThumb[]> {
    await this.openStickerSearch(keyword);
    const cells = await this.panelStickerCells();
    return cells.slice(0, max).map((c) => ({ label: c.label, thumbUrl: c.thumbUrl }));
  }
```

- [ ] **Step 3: Hiện thực `sendSticker`** (real mouse click + xác nhận dương):

```ts
  /** Số sticker ĐI (hugs phải) trong khung — mốc xác nhận gửi sticker. */
  private async outgoingStickerCount(): Promise<number> {
    return this.page.evaluate(() => {
      const W = window.innerWidth, H = window.innerHeight; let n = 0;
      document.querySelectorAll('div[role="img"][aria-label$=" sticker"]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 50 || r.x < 480 || r.y > H - 130) return;
        if ((r.x + r.width) < (W - 220)) return; // hugs phải = đi
        n++;
      });
      return n;
    });
  }

  async sendSticker(_threadId: string, keyword: string, index: number): Promise<void> {
    const before = await this.outgoingStickerCount();
    await this.openStickerSearch(keyword);
    const cells = await this.panelStickerCells();
    const cell = cells[index] || cells[0];
    if (!cell) throw new Error('không tìm thấy sticker để gửi');
    await this.page.mouse.move(cell.cx, cell.cy);
    await this.page.waitForTimeout(200);
    await this.page.mouse.down(); await this.page.waitForTimeout(70); await this.page.mouse.up();
    // xác nhận dương: sticker ĐI mới xuất hiện
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if ((await this.outgoingStickerCount()) > before) return;
      await this.page.waitForTimeout(400);
    }
    throw new Error('quá hạn chờ xác nhận gửi sticker');
  }
```

- [ ] **Step 4: Mở rộng `readIncomingMedia`** để lấy sticker ĐẾN (bên trái). Trong `page.evaluate` của `readIncomingMedia`, sau khối quét video, thêm quét sticker trái:

```ts
      // sticker đến: div[role=img][aria-label$=" sticker"], hugs trái, bg-image
      document.querySelectorAll('div[role="img"][aria-label$=" sticker"]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 50 || r.x < 480) return;
        if ((r.x + r.width) >= (W - 150)) return; // hugs phải = đi → bỏ
        const bg = getComputedStyle(el as HTMLElement).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && /fbcdn|scontent/.test(m[1])) out.push({ type: 'sticker', url: m[1], y: r.y });
      });
```

- [ ] **Step 5: tsc check**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/services/facebook/pagePlaywrightDriver.ts
git commit -m "feat(facebook): real driver listStickers/sendSticker + receive sticker in readIncomingMedia"
```

---

### Task 4: FacebookService + IPC + preload

**Files:**
- Modify: `src/services/facebook/FacebookService.ts` (handlePageMessageNotification, saveIncomingPageMedia, +2 method)
- Modify: `electron/ipc/facebookIpc.ts` (2 handler)
- Modify: `electron/preload.ts` (2 channel)

**Interfaces:**
- Consumes: `classifyPageNotification` (Task 1); `FacebookPageBrowserSender.listStickers/sendSticker` (Task 2).
- Produces:
  - `FacebookService.listPageStickers(threadId, keyword): Promise<PageStickerThumb[]>`
  - `FacebookService.sendPageSticker(threadId, keyword, index): Promise<FBSendResult>`
  - IPC `fb:listPageStickers`, `fb:sendPageSticker`; preload `ipc.fb.listPageStickers/sendPageSticker`.

- [ ] **Step 1: Dùng classifier trong `handlePageMessageNotification`.** Thay khối `wantType` inline bằng:

```ts
const { classifyPageNotification } = require('./pageSendHelpers');
const wantType = classifyPageNotification(n.body || '');
```

- [ ] **Step 2: Cho `saveIncomingPageMedia` nhận sticker.** Đổi tham số `wantType` thành `'image' | 'video' | 'sticker'`.
  Trong hàm: `readIncomingMedia` nay trả cả `'sticker'`; map sticker → lưu như ảnh:

```ts
    const hit = media.find((m) => m.type === wantType) || media[0];
    if (!hit) return false;
    // sticker lưu & hiển thị như ảnh (webp/png)
    const type: 'image' | 'video' = hit.type === 'video' ? 'video' : 'image';
```

  (giữ nguyên phần còn lại: ext theo `type`, download, saveFBMessage type=`type`.)

- [ ] **Step 3: Thêm 2 method** vào `FacebookService` (gần `sendPageAttachment`):

```ts
  /** Liệt kê sticker FB theo keyword (vai Page, qua Business Suite). */
  public async listPageStickers(threadId: string, keyword: string): Promise<{ label: string; thumbUrl: string }[]> {
    if (!this._isPage) return [];
    const { getPageBrowserSender } = require('./pagePlaywrightDriver');
    const sender = await getPageBrowserSender(this.accountId, {
      getCookie: () => this.cookie, delegatePageId: this._delegatePageId || '',
    });
    return sender.listStickers(threadId, keyword, 24);
  }

  /** Gửi sticker FB thứ `index` (kết quả search `keyword`) vai Page. */
  public async sendPageSticker(threadId: string, keyword: string, index: number): Promise<FBSendResult> {
    if (!this._isPage) return { success: false, error: 'Chỉ Page mới gửi sticker qua Business Suite' };
    const { getPageBrowserSender } = require('./pagePlaywrightDriver');
    const sender = await getPageBrowserSender(this.accountId, {
      getCookie: () => this.cookie, delegatePageId: this._delegatePageId || '',
    });
    const result = await sender.sendSticker(threadId, keyword, index);
    if (result.success && result.messageId) this.markMessageLocallySent(result.messageId);
    return result;
  }
```

- [ ] **Step 4: IPC handlers** trong `facebookIpc.ts` (gần `fb:sendAttachments`):

```ts
  ipcMain.handle('fb:listPageStickers', async (_event, params: { accountId: string; threadId: string; keyword: string }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service || !service.isPage()) return { success: false, stickers: [] };
      const stickers = await service.listPageStickers(params.threadId, params.keyword);
      return { success: true, stickers };
    } catch (e: any) { return { success: false, stickers: [], error: e?.message }; }
  });

  ipcMain.handle('fb:sendPageSticker', async (_event, params: { accountId: string; threadId: string; keyword: string; index: number; thumbUrl?: string }) => {
    try {
      const internalId = resolveInternalId(params.accountId);
      const service = await getFBServiceOrReconnect(internalId);
      if (!service || !service.isPage()) return { success: false, error: 'Tài khoản không phải Page.' };
      const r = await service.sendPageSticker(params.threadId, params.keyword, params.index);
      if (!r.success || !r.messageId) return { success: false, error: r.error || 'Gửi sticker thất bại' };
      // Lưu + hiển thị như ảnh gửi (đứng tên Page). Tải thumbUrl về làm ảnh local.
      try {
        const { FacebookSendService } = require('../../src/services/facebook/FacebookSendService');
        const fbId = resolveRealFacebookId(internalId, service);
        let localRelPath: string | undefined;
        if (params.thumbUrl) {
          const abs = await FileStorageService.downloadImage(fbId, params.thumbUrl, `sticker_${r.messageId.slice(-8)}_${Date.now()}.webp`, '', undefined, 'https://business.facebook.com/');
          if (abs) localRelPath = FileStorageService.toRelativePath(abs);
        }
        await FacebookSendService.persistSentMessage({
          accountId: internalId, threadId: params.threadId, messageId: r.messageId,
          body: null, fbSenderId: fbId, timestamp: r.timestamp || Date.now(),
          type: 'image', isUserMessage: true,
          attachments: JSON.stringify([{ type: 'image', name: 'sticker.webp', ...(localRelPath ? { localPath: localRelPath } : {}) }]),
          ...(localRelPath ? { localPath: localRelPath } : {}),
        });
      } catch (e: any) { Logger.warn(`[facebookIpc] sticker persist error: ${e.message}`); }
      return { success: true, messageId: r.messageId };
    } catch (e: any) { return { success: false, error: e?.message }; }
  });
```

- [ ] **Step 5: Preload channels** trong `electron/preload.ts` (khối `fb:`, cạnh `sendAttachments`):

```ts
    listPageStickers:    (params: any) => ipcRenderer.invoke('fb:listPageStickers', params),
    sendPageSticker:     (params: any) => ipcRenderer.invoke('fb:sendPageSticker', params),
```

- [ ] **Step 6: tsc check**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/services/facebook/FacebookService.ts electron/ipc/facebookIpc.ts electron/preload.ts
git commit -m "feat(facebook): service+IPC for page sticker list/send; receive sticker as image"
```

---

### Task 5: UI — FbStickerPicker + nhánh Page trong MessageInput

**Files:**
- Modify: `src/ui/components/chat/MessageInput.tsx` (component mới `FbStickerPicker` + nhánh `handleSendSticker`/render)

**Interfaces:**
- Consumes: `ipc.fb.listPageStickers`, `ipc.fb.sendPageSticker` (Task 4).
- Produces: component `FbStickerPicker` (nội bộ file).

- [ ] **Step 1: Thêm component `FbStickerPicker`** (cuối file, cạnh `StickerPicker`):

```tsx
function FbStickerPicker({ accountId, threadId, onClose, showNotification }: {
  accountId: string; threadId: string; onClose: () => void;
  showNotification: (msg: string, type: 'warning' | 'error' | 'success') => void;
}) {
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Array<{ label: string; thumbUrl: string }>>([]);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [onClose]);

  const doSearch = (kw: string) => {
    if (!kw.trim()) { setResults([]); return; }
    setLoading(true);
    (window as any).electron?.fb?.listPageStickers({ accountId, threadId, keyword: kw.trim() })
      .then((r: any) => setResults(r?.success ? (r.stickers || []) : []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  };

  const onType = (v: string) => {
    setKeyword(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(v), 500);
  };

  const pick = async (index: number) => {
    if (sending) return;
    setSending(true);
    try {
      const r = await (window as any).electron?.fb?.sendPageSticker({
        accountId, threadId, keyword: keyword.trim(), index, thumbUrl: results[index]?.thumbUrl,
      });
      if (r?.success) onClose();
      else showNotification(r?.error || 'Gửi sticker thất bại', 'error');
    } catch (e: any) { showNotification('Gửi sticker lỗi: ' + (e?.message || ''), 'error'); }
    finally { setSending(false); }
  };

  return (
    <div ref={ref} className="absolute bottom-14 left-0 z-50 w-80 rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800">
      <input autoFocus value={keyword} onChange={(e) => onType(e.target.value)} placeholder="Tìm nhãn dán (vd: vui, yêu, buồn)..."
        className="mb-2 w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
      {loading && <div className="py-6 text-center text-sm text-gray-400">Đang tìm…</div>}
      {!loading && keyword.trim() && results.length === 0 && <div className="py-6 text-center text-sm text-gray-400">Không tìm thấy nhãn dán</div>}
      <div className="grid max-h-64 grid-cols-4 gap-2 overflow-y-auto">
        {results.map((s, i) => (
          <button key={i} disabled={sending} onClick={() => pick(i)} title={s.label}
            className="flex aspect-square items-center justify-center rounded-lg p-1 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700">
            <img src={s.thumbUrl} alt={s.label} loading="lazy"
              onError={(e) => { (e.currentTarget.style.display = 'none'); }}
              className="max-h-full max-w-full object-contain" />
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rẽ nhánh Page khi render sticker picker.** Tại khối render `showStickerPicker` (quanh dòng ~3463), bọc nhánh Page trước `TelegramStickerPicker`/`StickerPicker`:

```tsx
{showStickerPicker && (
  (isFacebook(activeContact?.channel) && !!getActiveAccount()?.parent_zalo_id && activeThreadId && activeAccountId)
    ? <FbStickerPicker
        accountId={activeAccountId}
        threadId={activeThreadId}
        onClose={() => setShowStickerPicker(false)}
        showNotification={showNotification}
      />
    : (/* nhánh Telegram/Zalo hiện có giữ nguyên */ ... )
)}
```

  (Giữ nguyên toàn bộ nhánh cũ trong nhánh else.)

- [ ] **Step 3: Đảm bảo nút Sticker hiện cho Page.** Kiểm `handleSendSticker` (dòng ~2548) chỉ toggle `showStickerPicker` — không chặn Facebook. Nếu có guard Zalo-only (vd `getAuth`), thêm điều kiện cho Page toggle bình thường (không gọi Zalo auth).

- [ ] **Step 4: Build renderer check**

Run: `npx tsc --noEmit -p tsconfig.json` (hoặc lệnh typecheck renderer của dự án)
Expected: exit 0 (không lỗi type ở MessageInput)

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/chat/MessageInput.tsx
git commit -m "feat(facebook): FbStickerPicker UI + Page branch for sticker send"
```

---

### Task 6: Build, verify thủ công, stress-test, emoji

**Files:** (không sửa code trừ khi lộ lỗi)

- [ ] **Step 1: Build toàn bộ**

Run: `npx tsc -p tsconfig.electron.json --noEmit && npx jest src/__tests__/facebook/`
Expected: tsc exit 0; jest các suite page PASS (2 suite better-sqlite3 ABI fail sẵn, không liên quan).

- [ ] **Step 2: Chạy dev, verify GỬI sticker** (cần anh/thread thật): mở hội thoại Page → nút Sticker → gõ "vui" → lưới hiện → click 1 ô → xác nhận máy khách nhận, đứng tên Page, app hiện ảnh sticker đã gửi.

- [ ] **Step 3: Verify NHẬN sticker**: khách gửi 1 sticker → app hiện ảnh sticker (không phải chữ "Đã gửi một nhãn dán").

- [ ] **Step 4: Verify EMOJI**: gửi 1 emoji (😀) từ ô nhập → khách nhận đúng; khách gửi emoji → app hiện đúng. Nếu emoji rớt → thêm fallback `composer.insertText` trong `sendText` (ghi chú ceiling), chạy lại.

- [ ] **Step 5: Stress-test 2 vòng** (mỗi vòng desktop + mobile width): gửi liên tiếp 3 sticker (không spam/trùng), gửi sticker + text + ảnh xen kẽ, dark/light, không overflow ngang, không chồng chữ, picker đóng/mở mượt.

- [ ] **Step 6: Review diff + báo cáo** (reuse `superpowers:requesting-code-review`). Không tự release.

## Self-Review

**Spec coverage:** Nhận sticker (Task 1 classifier + Task 3 readIncomingMedia + Task 4 save) ✓; Gửi sticker (Task 2 orchestrator + Task 3 driver + Task 4 service/IPC + Task 5 UI) ✓; Emoji verify (Task 6) ✓; Non-goals tôn trọng (type=image, không đụng text/ảnh/video, không StickerPicker Zalo) ✓.

**Placeholder scan:** Task 5 Step 2 dùng `...` để chỉ "giữ nguyên nhánh cũ" (không phải code mới cần viết — nhánh else là code hiện có, không được sửa). Mọi code mới đều đầy đủ.

**Type consistency:** `listStickers`/`sendSticker`/`PageStickerThumb`/`PageIncomingMedia('sticker')` nhất quán Task 2→3→4; IPC `fb:listPageStickers`/`fb:sendPageSticker` nhất quán Task 4→5; `index` xuyên suốt.

**Review Focus:** 2 ngôn ngữ (Task 1 test) ✓; search rỗng (Task 2 test + Task 5 UI) ✓; index drift (Task 3 cùng phiên) ✓; thumbnail vỡ (Task 5 onError) ✓; sticker đến trái (Task 3) ✓.
