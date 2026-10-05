# Gửi tin từ Page qua tự động hóa Business Suite — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Page đã bật trong MaiHub trả lời được khách (text + ảnh + file), tin đến nơi và đứng tên Page, bằng cách điều khiển client Business Suite thật qua trình duyệt engine.

**Architecture:** Một `FacebookPageBrowserSender` quản lý 1 phiên trình duyệt headless cho mỗi Page (cookie cha + `i_user`, phiên lưu ở `userDataDir`). Logic điều phối (mutex per-Page, ánh xạ lỗi, định dạng kết quả) tách sau interface `PageInboxDriver` để unit-test không cần trình duyệt; driver DOM thật dùng playwright-core. Nhánh `_isPage` trong `FacebookService.sendMessage` và nhánh Page trong `fb:sendAttachment(s)` định tuyến sang sender này; đường cá nhân/E2EE/reader không đổi.

**Tech Stack:** TypeScript, Electron, playwright-core 1.62.1 (đã cài), engine antidetect `ungoogled-chromium 148` (đã cài ở `<userData>/browser-engine/...`), Jest (`make test`).

**Spec:** `docs/specs/2026-10-05-facebook-page-send-business-suite.md`

## Global Constraints

- Định danh code chỉ tiếng Anh; copy/UI tiếng Việt được (AGENTS.md).
- Không thêm dependency mới — playwright-core, better-sqlite3 đã có; chỉ dùng chúng.
- Không đụng đường gửi 1:1/group/E2EE, bridge `messagix`, reader/MQTT Page, Sidebar, bật/tắt Page.
- Không bao giờ trả `success` khi tin chưa thực sự đi (spec §1.3, §4).
- `make build` ("Build succeeded"), `make test` (xanh), `make lint` (0 cảnh báo) phải qua trước khi báo xong; dán output.
- Máy dev 16GB: chạy tsc/jest/build lần lượt, không song song (memory `heavy-commands-on-dev-machine`).

## Review Focus

- **Phiên trình duyệt hết hạn / bị checkpoint khi gửi** → trả lỗi rõ, không treo, không fake success. *(Test ở Task 3 với fake driver ném lỗi auth.)*
- **threadId không mở được hội thoại** (sai id / hội thoại biến mất) → lỗi rõ nêu bước hỏng. *(Test ở Task 3.)*
- **Hai lệnh gửi cùng lúc tới một Page** → phải nối tiếp (mutex), không chồng thao tác DOM. *(Test ở Task 3.)*
- **File không tồn tại / loại không hỗ trợ** khi gửi đính kèm → lỗi rõ, không gửi tin rỗng. *(Test ở Task 4.)*
- **Gửi quá hạn chờ xác nhận** (không thấy bong bóng tin đã gửi) → lỗi timeout rõ. *(Test ở Task 3.)*

---

### Task 1: Probe khám phá DOM Business Suite (an toàn, KHÔNG gửi)

Khám phá 3 dữ kiện live rồi điền vào file hằng số: (a) URL deep-link mở đúng 1 hội thoại, (b) selector ô soạn + cách gửi, (c) selector `<input type=file>` đính kèm. Không unit test — đây là task khám phá; deliverable là file hằng số điền giá trị thật + ghi chú.

**Files:**
- Create: `src/services/facebook/pageBusinessSuiteSelectors.ts`
- Dùng (throwaway): harness capture trong scratchpad (mở rộng từ `capture-bizsuite-send.js`)

**Interfaces:**
- Produces: hằng số dùng cho Task 2–4:
  ```ts
  export interface PageBizSuiteSelectors {
    composer: string;        // selector ô soạn (contenteditable/textarea)
    sendButton: string | null; // selector nút gửi; null nếu gửi bằng Enter
    fileInput: string;       // selector <input type=file> đính kèm
    outgoingBubble: string;  // selector xác nhận tin vừa gửi đã lên khung
  }
  export const PAGE_BIZ_SUITE: PageBizSuiteSelectors;
  // Template URL mở 1 hội thoại; {asset} = delegatePageId, {thread} = threadId/threadKey
  export const THREAD_URL_TEMPLATE: string;
  ```

- [ ] **Step 1: Mở rộng harness probe (scratchpad, không gửi)**

Sửa `capture-bizsuite-send.js` thêm: khi anh mở 1 hội thoại, in ra `page.url()` hiện tại, và thử các ứng viên selector composer/file-input, dump cái nào khớp. Ví dụ chèn sau khi `page` mở:
```js
await page.exposeBinding('dumpDom', async () => {
  const probe = await page.evaluate(() => {
    const pick = (sels) => sels.find(s => document.querySelector(s)) || null;
    return {
      url: location.href,
      composer: pick(['div[contenteditable="true"][role="textbox"]','[aria-label*="Nhắn"] [contenteditable="true"]','textarea']),
      fileInput: pick(['input[type="file"]']),
      sendBtn: pick(['div[aria-label="Nhấn Enter để gửi"]','div[aria-label*="Gửi"]','button[type="submit"]']),
    };
  });
  console.log('DOM PROBE:', JSON.stringify(probe));
});
```
Và in nhắc anh bấm một phím/chạy `window.dumpDom()` trong console khi đã mở hội thoại + focus ô soạn.

- [ ] **Step 2: Chạy probe, mở 1 hội thoại, KHÔNG gửi, ghi lại kết quả**

Run (desktop, headful):
```bash
cd /home/maiychrus/deplao-builder
./node_modules/.bin/electron "<scratchpad>/capture-bizsuite-send.js" media
```
Mở 1 hội thoại, focus ô soạn, lấy dòng `DOM PROBE:` (url + 3 selector). Ghi cả `page.url()` của 1 hội thoại cụ thể để suy ra `THREAD_URL_TEMPLATE` (phần nào là delegate asset, phần nào là thread).

- [ ] **Step 3: Điền `pageBusinessSuiteSelectors.ts` bằng giá trị thật**

Tạo file với giá trị lấy được (ví dụ minh hoạ — THAY bằng giá trị probe trả về):
```ts
export interface PageBizSuiteSelectors { composer: string; sendButton: string | null; fileInput: string; outgoingBubble: string; }
export const PAGE_BIZ_SUITE: PageBizSuiteSelectors = {
  composer: 'div[contenteditable="true"][role="textbox"]',
  sendButton: null,                 // gửi bằng Enter nếu probe xác nhận
  fileInput: 'input[type="file"]',
  outgoingBubble: '[data-scope="messages"] [data-is-outgoing="true"]',
};
export const THREAD_URL_TEMPLATE =
  'https://business.facebook.com/latest/inbox/all?asset_id={asset}&selected_item_id={thread}&thread_type=FB_MESSAGE';
```

- [ ] **Step 4: Ghi chú probe + commit file hằng số**

Ghi 5–8 dòng kết quả probe (url mẫu, selector chốt) vào cuối spec mục "Bằng chứng". Commit:
```bash
git add src/services/facebook/pageBusinessSuiteSelectors.ts docs/specs/2026-10-05-facebook-page-send-business-suite.md
git commit -m "feat(facebook): discover Business Suite composer selectors + thread deep-link for Page send"
```

---

### Task 2: Helper thuần (URL hội thoại, phân loại file) — TDD

**Files:**
- Create: `src/services/facebook/pageSendHelpers.ts`
- Test: `src/__tests__/facebook/pageSendHelpers.test.ts`

**Interfaces:**
- Consumes: `THREAD_URL_TEMPLATE` (Task 1).
- Produces:
  ```ts
  export function buildThreadUrl(delegatePageId: string, threadId: string): string;
  export function classifyFile(path: string): 'image'|'video'|'audio'|'file';
  ```

- [ ] **Step 1: Viết test fail**

```ts
import { buildThreadUrl, classifyFile } from '../../services/facebook/pageSendHelpers';
describe('pageSendHelpers', () => {
  it('buildThreadUrl chèn asset + thread', () => {
    const u = buildThreadUrl('1254744041053955', '100032442095141');
    expect(u).toContain('asset_id=1254744041053955');
    expect(u).toContain('100032442095141');
  });
  it('classifyFile theo đuôi', () => {
    expect(classifyFile('/a/b.PNG')).toBe('image');
    expect(classifyFile('/a/b.mp4')).toBe('video');
    expect(classifyFile('/a/b.m4a')).toBe('audio');
    expect(classifyFile('/a/b.pdf')).toBe('file');
    expect(classifyFile('/a/b')).toBe('file');
  });
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx jest src/__tests__/facebook/pageSendHelpers.test.ts`
Expected: FAIL ("Cannot find module" / không có hàm).

- [ ] **Step 3: Viết implementation tối thiểu**

```ts
import { THREAD_URL_TEMPLATE } from './pageBusinessSuiteSelectors';
export function buildThreadUrl(delegatePageId: string, threadId: string): string {
  return THREAD_URL_TEMPLATE.replace('{asset}', encodeURIComponent(delegatePageId)).replace('{thread}', encodeURIComponent(threadId));
}
const EXT: Record<string, 'image'|'video'|'audio'|'file'> = {
  jpg:'image',jpeg:'image',png:'image',gif:'image',webp:'image',bmp:'image',
  mp4:'video',webm:'video',mov:'video',avi:'video',
  mp3:'audio',m4a:'audio',aac:'audio',ogg:'audio',wav:'audio',
};
export function classifyFile(p: string): 'image'|'video'|'audio'|'file' {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return (m && EXT[m[1].toLowerCase()]) || 'file';
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx jest src/__tests__/facebook/pageSendHelpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/facebook/pageSendHelpers.ts src/__tests__/facebook/pageSendHelpers.test.ts
git commit -m "feat(facebook): pure helpers for Page send (thread URL, file classify)"
```

---

### Task 3: `FacebookPageBrowserSender` — điều phối + driver interface (text), TDD với fake driver

**Files:**
- Create: `src/services/facebook/FacebookPageBrowserSender.ts`
- Test: `src/__tests__/facebook/FacebookPageBrowserSender.test.ts`

**Interfaces:**
- Consumes: `buildThreadUrl`, `classifyFile` (Task 2); `PAGE_BIZ_SUITE` (Task 1).
- Produces:
  ```ts
  export interface PageSendResult { success: boolean; messageId?: string; error?: string }
  export interface PageSendInput { text?: string; files?: { path: string; type: 'image'|'video'|'audio'|'file' }[]; replyToMessageId?: string }
  export interface PageInboxDriver {
    openThread(threadId: string): Promise<void>;     // ném nếu không mở được / auth fail
    sendText(text: string): Promise<void>;           // gõ + gửi
    attachFiles(paths: string[]): Promise<void>;      // set file input, chờ upload
    waitSent(timeoutMs: number): Promise<void>;       // ném nếu quá hạn
  }
  export class FacebookPageBrowserSender {
    constructor(deps: { driver: PageInboxDriver; delegatePageId: string });
    send(threadId: string, input: PageSendInput): Promise<PageSendResult>;  // nối tiếp per-instance
  }
  ```
  (Vòng đời trình duyệt thật + driver playwright thêm ở Task 5; Task 3 chỉ điều phối + fake driver.)

- [ ] **Step 1: Viết test fail (mutex, lỗi auth, timeout, empty input)**

```ts
import { FacebookPageBrowserSender, PageInboxDriver } from '../../services/facebook/FacebookPageBrowserSender';
class FakeDriver implements PageInboxDriver {
  calls: string[] = []; failOpen = false; failWait = false; active = 0; maxActive = 0;
  async openThread(id: string){ if(this.failOpen) throw new Error('auth'); this.calls.push('open:'+id); }
  async sendText(t: string){ this.active++; this.maxActive=Math.max(this.maxActive,this.active); await new Promise(r=>setTimeout(r,5)); this.active--; this.calls.push('text:'+t); }
  async attachFiles(p: string[]){ this.calls.push('files:'+p.length); }
  async waitSent(){ if(this.failWait) throw new Error('timeout chờ xác nhận'); this.calls.push('sent'); }
}
it('gửi text thành công', async () => {
  const d = new FakeDriver();
  const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
  const r = await s.send('123', { text: 'hi' });
  expect(r.success).toBe(true);
  expect(d.calls).toEqual(['open:123','text:hi','sent']);
});
it('lỗi auth → success=false, error rõ', async () => {
  const d = new FakeDriver(); d.failOpen = true;
  const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', { text:'a' });
  expect(r.success).toBe(false); expect(r.error).toMatch(/Business Suite/);
});
it('timeout chờ xác nhận → success=false', async () => {
  const d = new FakeDriver(); d.failWait = true;
  const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', { text:'a' });
  expect(r.success).toBe(false); expect(r.error).toMatch(/xác nhận|timeout/);
});
it('empty input → lỗi, không gọi driver gửi', async () => {
  const d = new FakeDriver();
  const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', {});
  expect(r.success).toBe(false); expect(d.calls).toEqual([]);
});
it('hai send song song nối tiếp (mutex)', async () => {
  const d = new FakeDriver();
  const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
  await Promise.all([s.send('1',{text:'a'}), s.send('2',{text:'b'})]);
  expect(d.maxActive).toBe(1);
});
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `npx jest src/__tests__/facebook/FacebookPageBrowserSender.test.ts`
Expected: FAIL (chưa có class).

- [ ] **Step 3: Viết implementation tối thiểu (điều phối + mutex + ánh xạ lỗi)**

```ts
import { classifyFile } from './pageSendHelpers';
export interface PageSendResult { success: boolean; messageId?: string; error?: string }
export interface PageSendInput { text?: string; files?: { path: string; type: 'image'|'video'|'audio'|'file' }[]; replyToMessageId?: string }
export interface PageInboxDriver {
  openThread(threadId: string): Promise<void>;
  sendText(text: string): Promise<void>;
  attachFiles(paths: string[]): Promise<void>;
  waitSent(timeoutMs: number): Promise<void>;
}
const SENT_TIMEOUT_MS = 20000;
export class FacebookPageBrowserSender {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: { driver: PageInboxDriver; delegatePageId: string }) {}
  send(threadId: string, input: PageSendInput): Promise<PageSendResult> {
    const run = this.queue.then(() => this.doSend(threadId, input), () => this.doSend(threadId, input));
    this.queue = run.catch(() => {});
    return run;
  }
  private async doSend(threadId: string, input: PageSendInput): Promise<PageSendResult> {
    const hasText = !!(input.text && input.text.trim());
    const files = input.files || [];
    if (!hasText && files.length === 0) return { success: false, error: 'Không có nội dung để gửi' };
    try {
      await this.deps.driver.openThread(threadId);
      if (files.length) await this.deps.driver.attachFiles(files.map(f => f.path));
      if (hasText || files.length) await this.deps.driver.sendText(input.text || '');
      await this.deps.driver.waitSent(SENT_TIMEOUT_MS);
      return { success: true, messageId: `page:${Date.now()}` };
    } catch (err: any) {
      return { success: false, error: `Chưa gửi được từ Page qua Business Suite: ${err?.message || err}` };
    }
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `npx jest src/__tests__/facebook/FacebookPageBrowserSender.test.ts`
Expected: PASS (cả 5 ca).

- [ ] **Step 5: Commit**

```bash
git add src/services/facebook/FacebookPageBrowserSender.ts src/__tests__/facebook/FacebookPageBrowserSender.test.ts
git commit -m "feat(facebook): Page browser sender orchestration (mutex, error mapping) with fake-driver tests"
```

---

### Task 4: Driver playwright thật + vòng đời trình duyệt (text + ảnh + file)

Driver DOM thật không unit-test được → kiểm bằng self-check chạy tay vào hội thoại thật; acceptance = khách nhận được.

**Files:**
- Modify: `src/services/facebook/FacebookPageBrowserSender.ts` (thêm `PlaywrightPageInboxDriver` + factory `FacebookPageBrowserSender.get(pageAccountId, deps)` khởi tạo context thật)
- Create (throwaway): `<scratchpad>/selfcheck-page-send.js` (Electron harness gọi sender thật)

**Interfaces:**
- Consumes: `PAGE_BIZ_SUITE`, `buildThreadUrl`, `classifyFile`.
- Produces:
  ```ts
  interface PageSenderDeps { engineExecutable: string; userDataDir: string; getCookie: () => string; delegatePageId: string; }
  static get(pageAccountId: string, deps: PageSenderDeps): Promise<FacebookPageBrowserSender>;
  close(): Promise<void>;
  ```

- [ ] **Step 1: Viết `PlaywrightPageInboxDriver`**

Dùng `chromium.launchPersistentContext(userDataDir, { executablePath: engineExecutable, headless: true })`, `addCookies` từ `getCookie()` (parse chuỗi → cookie `.facebook.com`), mở inbox. `openThread` = `page.goto(buildThreadUrl(delegate, threadId))` + `waitForSelector(PAGE_BIZ_SUITE.composer)` (ném nếu không có → auth/thread fail). `sendText` = `fill/type` ô `composer` rồi `press('Enter')` hoặc click `sendButton`. `attachFiles` = `setInputFiles(PAGE_BIZ_SUITE.fileInput, paths)` + chờ nút gửi/preview sẵn sàng. `waitSent` = `waitForSelector(PAGE_BIZ_SUITE.outgoingBubble, { timeout })`.

- [ ] **Step 2: `FacebookPageBrowserSender.get()` — instance per Page, lazy, giữ sống**

Map tĩnh `instances: Map<pageAccountId, sender>`; lần đầu tạo driver thật + mở inbox; idle timer gọi `close()`. `close()` đóng context.

- [ ] **Step 3: Self-check text (chạy tay, gửi THẬT vào hội thoại test)**

`<scratchpad>/selfcheck-page-send.js`: giải mã cookie Page (như `capture-bizsuite-send.js`), `FacebookPageBrowserSender.get('media', deps)`, `send(threadId, { text: 'selfcheck text ' + Date.now() })`. Run desktop; anh kiểm nick nhận.
Expected: `{ success: true }` và **khách nhận được text, đứng tên Page**.

- [ ] **Step 4: Self-check ảnh + file (gửi THẬT)**

Trong harness thêm `send(threadId, { files:[{path:'<ảnh>',type:'image'}] })` và `send(threadId, { files:[{path:'<pdf>',type:'file'}], text:'kèm caption' })`.
Expected: khách nhận được ảnh và file, đứng tên Page.

- [ ] **Step 5: Commit**

```bash
git add src/services/facebook/FacebookPageBrowserSender.ts
git commit -m "feat(facebook): real Business Suite DOM driver + browser lifecycle for Page send"
```

---

### Task 5: Tích hợp vào `FacebookService` + IPC đính kèm; bỏ đường REST cho Page

**Files:**
- Modify: `src/services/facebook/FacebookService.ts` (nhánh `_isPage` trong `sendMessage` ~2041; thêm `sendPageAttachment`; `close()` sender khi disconnect/remove instance)
- Modify: `electron/ipc/facebookIpc.ts` (`fb:sendAttachment` ~673, `fb:sendAttachments` ~755: nhánh Page → sender, bỏ `uploadAttachment` REST)

**Interfaces:**
- Consumes: `FacebookPageBrowserSender.get`, `PageSendInput/Result` (Task 3–4).
- Produces: `FacebookService.sendMessage` (Page) và `sendPageAttachment(threadId, filePath, body?)` trả `FBSendResult` như cũ (UI/DB không đổi).

- [ ] **Step 1: Thay nhánh Page trong `sendMessage`**

Tại `FacebookService.ts` nhánh `if (this._isPage)` (hiện gọi `sendMessageREST`): dựng deps (engine từ `BrowserEngineManager`/config, `userDataDir = <userData>/page-browser/<accountId>`, `getCookie = () => this.cookie`, `delegatePageId = this._delegatePageId`), gọi `FacebookPageBrowserSender.get(this.accountId, deps)` rồi `.send(threadId, { text: body, replyToMessageId: opts?.replyToMessageId })`. `success` → `markMessageLocallySent(messageId)`. Trả kết quả.

- [ ] **Step 2: Thêm `sendPageAttachment`**

Method mới trên `FacebookService`: `get(...).send(threadId, { text: body, files: [{ path: filePath, type: classifyFile(filePath) }] })`.

- [ ] **Step 3: Nhánh Page trong `fb:sendAttachment` / `fb:sendAttachments`**

Ở đầu hai handler, nếu `service.isPage()`: gọi `service.sendPageAttachment(threadId, filePath, body)` (và lặp cho `sendAttachments`), **bỏ qua** `uploadAttachment` REST + nhánh E2EE. Lưu DB/emit dùng `FacebookSendService.persistSentMessage` với `localPath` như nhánh hiện có.

- [ ] **Step 4: Đóng sender khi Page tắt/disconnect**

Trong `removeInstance`/`disconnect` của `FacebookService`: nếu `_isPage`, gọi `FacebookPageBrowserSender` close cho `accountId` (tránh rò trình duyệt).

- [ ] **Step 5: Build + lint**

Run: `make build` rồi `make lint` (lần lượt). Expected: "Build succeeded", 0 cảnh báo.

- [ ] **Step 6: Commit**

```bash
git add src/services/facebook/FacebookService.ts electron/ipc/facebookIpc.ts
git commit -m "feat(facebook): route Page text+attachment send through Business Suite browser, drop dead REST path"
```

---

### Task 6: Nghiệm thu + chống hồi quy

**Files:** không sửa code (chỉ chạy & kiểm). Sửa phát sinh nếu lỗi → quay lại task tương ứng.

- [ ] **Step 1: `make test` toàn bộ**

Run: `make test`. Expected: xanh toàn bộ (gồm test Task 2, 3). Dán output.

- [ ] **Step 2: Nghiệm thu Page (desktop) — vòng 1 & 2**

Trong app thật: từ hội thoại Page gửi (a) text, (b) ảnh, (c) file. Kiểm nick khách **nhận được, đứng tên Page**. Lặp 2 vòng. Ghi bằng chứng (ảnh chụp/nick nhận).

- [ ] **Step 3: Chống hồi quy đường cá nhân**

Gửi text + ảnh cho 1 hội thoại 1:1 và 1 group của tài khoản cá nhân → vẫn gửi được như trước (E2EE/MQTT không đổi). Ghi rõ đã kiểm cái gì.

- [ ] **Step 4: Dọn throwaway + xác nhận hoàn tất**

Xóa harness scratchpad (`capture-bizsuite-send.js`, `selfcheck-page-send.js`, logs, profile-*). `git worktree list` nếu dùng worktree → dọn. Báo cáo cuối: reuse gì, không thêm dep, verification nào đã chạy (W4).
