# Spec — Gửi/Nhận sticker + icon cho Page (Business Suite)

- Ngày: 2026-10-07
- Trạng thái: Draft (chờ anh review)
- Liên quan: [2026-10-05-facebook-page-send-business-suite.md](./2026-10-05-facebook-page-send-business-suite.md)
- Nhánh dự kiến: `feat/facebook-page-sticker`

## 1. Bối cảnh & mục tiêu

Page (gửi qua Meta Business Suite bằng trình duyệt tự động) hiện gửi/nhận được text, ảnh (có caption),
video. Thiếu **sticker (nhãn dán)** và cần xác nhận **emoji/icon**. Mục tiêu:

1. **Nhận sticker**: khách gửi sticker vào Page → app hiển thị **ảnh sticker** (thay vì chữ "Đã gửi một nhãn dán").
2. **Gửi sticker**: từ app chọn sticker FB (search keyword → lưới → click) gửi vai Page.
3. **Emoji/icon**: xác nhận gửi/nhận chạy ổn (đi chung đường text). Không code mới trừ khi stress-test lộ lỗi.

### Feasibility đã xác nhận bằng spike (05–07/10)
- Mở picker: `div[aria-label="Đăng nhãn dán"][role="button"]`.
- Search: gõ keyword vào `input[placeholder="Tìm kiếm nhãn dán"]` → lưới sticker 4 cột.
- Mỗi sticker trong panel: `div[role="img"][aria-label$=" sticker"]` (ảnh qua `background-image`),
  bọc trong `div[role="button"] > td > tr > table`. **Real mouse click = gửi NGAY** (không cần Enter).
- Đã gửi thật 1 sticker tới khách test, xác nhận giao (danh sách hội thoại hiện "Bạn đã gửi một nhãn dán").
- Sticker trong khung (đã gửi/đã nhận) cũng là `div[role="img"][aria-label$=" sticker"]` với `background-image`
  chứa URL scontent → tải được.

## 2. Non-goals (cắt theo YAGNI)

- Không duyệt toàn bộ kho sticker FB (FB không expose; search là đường ổn định duy nhất).
- Không tái dùng `StickerPicker` Zalo (khoá chặt vào auth/DB Zalo) — làm component FB riêng, nhỏ.
- Không hỗ trợ GIF, avatar-sticker, hiệu ứng động riêng; sticker lưu & hiển thị như **ảnh** (type=`image`).
- Không làm "recent FB sticker" / cache kho sticker ở DB (phase sau nếu cần).
- Không đổi đường gửi/nhận text, ảnh, video đang chạy.

## 3. Kiến trúc

### 3.1 Nhận sticker (reuse đường nhận media)
`FacebookService.handlePageMessageNotification` hiện phân loại `wantType` từ body thông báo:
- Thêm nhánh: body khớp `/nhãn dán|sent a sticker/i` → `wantType = 'sticker'`.
- `saveIncomingPageMedia(...)` gọi `sender.readIncomingMedia(threadId, N)`; mở rộng để nhận `'sticker'`:
  driver quét thêm `div[role="img"][aria-label$=" sticker"]` **bên trái** (tin đến), lấy URL từ
  `getComputedStyle(el).backgroundImage` → trả `{type:'sticker', url}`.
- `saveIncomingPageMedia` lưu sticker **như ảnh**: `type='image'`, tải qua `FileStorageService.downloadImage`
  (cookie + referer business.facebook.com như ảnh hiện tại). Hiển thị dùng đúng đường ảnh đã chạy.

> Lý do type=image: sticker tĩnh/động đều là ảnh (webp/png); đường hiển thị ảnh đã verify. Giữ lazy,
> không thêm message-type mới xuyên DB/UI.

### 3.2 Gửi sticker (driver mới + IPC mới + UI nhỏ)

**Driver** (`pagePlaywrightDriver.ts` / `PageInboxDriver`):
- `listStickers(threadId, keyword, max)`: openThread → click "Đăng nhãn dán" → gõ `keyword` vào ô search
  → scrape cell trong vùng panel: `{ label, thumbUrl }` (thumbUrl = bg-image URL). Trả tối đa `max`.
- `sendSticker(threadId, keyword, index)`: openThread → mở picker → gõ `keyword` → **real mouse click**
  cell thứ `index` trong lưới panel (đúng ô user bấm; `index` = vị trí trong kết quả `listStickers` cùng
  `keyword`, thứ tự ổn định theo y→x). Xác nhận gửi bằng **tín hiệu dương**: xuất hiện sticker ĐI mới
  (`div[role=img][aria-label$=sticker]` hugs phải) so với mốc trước khi click. Không dùng Enter.

**IPC** (`electron/ipc/facebookIpc.ts`): 2 kênh mới, chỉ nhánh Page:
- `fb:listPageStickers { accountId, threadId, keyword }` → `{ success, stickers: [{label, thumbUrl}] }`
- `fb:sendPageSticker  { accountId, threadId, keyword, index, thumbUrl }` → gửi + `persistSentMessage`
  (type=image, attachments = sticker tải từ `thumbUrl` làm local) + emit `fb:onMessage` như ảnh gửi.

**Service** (`FacebookService.ts`): `listPageStickers`, `sendPageSticker` (lazy-require driver, un-gated,
chỉ cho `_isPage`). `sendPageSticker` sau khi driver xác nhận: tải thumbUrl về làm ảnh local để lưu/hiển thị
(đứng tên Page, is_self=1) — tái dùng `FileStorageService.downloadImage`.

**UI** (`MessageInput.tsx`): component mới `FbStickerPicker` (nhỏ, tách khỏi `StickerPicker` Zalo):
- ô search keyword → debounce → `ipc.fb.listPageStickers` → lưới thumbnail (`<img src=thumbUrl>`).
- click thumbnail → `ipc.fb.sendPageSticker` → đóng picker.
- Nút "Sticker" (`handleSendSticker`) rẽ nhánh: Page (`isFacebook && parent_zalo_id`) → `FbStickerPicker`;
  còn lại giữ `StickerPicker`/`TelegramStickerPicker` như cũ.

### 3.3 Emoji / icon
Không code mới. `insertEmoji` chèn unicode vào ô nhập → gửi qua `sendViaPageBrowser` → `composer.type()`.
Verify trong stress-test (gửi 1 emoji, nhận 1 emoji). Nếu `composer.type` rớt emoji multi-codepoint → fallback
`composer.insertText` (ghi chú, chỉ làm nếu lộ lỗi).

## 4. Interfaces (hợp đồng)

```ts
// PageInboxDriver (bổ sung)
listStickers(threadId: string, keyword: string, max: number): Promise<PageStickerThumb[]>;
sendSticker(threadId: string, keyword: string, index: number): Promise<void>; // throw nếu không xác nhận gửi
readIncomingMedia(threadId, max): Promise<{ type: 'image'|'video'|'sticker'; url: string }[]>; // +sticker

interface PageStickerThumb { label: string; thumbUrl: string; }
```

- Selector hằng số bổ sung vào `pageBusinessSuiteSelectors.ts`:
  `stickerButton='div[aria-label="Đăng nhãn dán"][role="button"]'`,
  `stickerSearch='input[placeholder="Tìm kiếm nhãn dán"]'`,
  `stickerCell='div[role="img"][aria-label$=" sticker"]'`.
- Vùng panel (lọc cell picker khỏi sticker trong khung): bounding box trong popover phía trên composer
  (x,y theo runtime, không hardcode tuyệt đối — lọc theo "nằm trên composer & dưới ô search").

## 5. Data flow

**Nhận**: MQTT parent → `handlePageMessageNotification` (body "nhãn dán") → `wantType=sticker`
→ `saveIncomingPageMedia` → `readIncomingMedia` (bg-image trái) → download → `saveFBMessage type=image`
→ emit `fb:onMessage` + `event:localPath` (y hệt nhận ảnh).

**Gửi**: UI `FbStickerPicker` → `fb:listPageStickers` (scrape) → user click → `fb:sendPageSticker`
→ driver click cell (xác nhận sticker đi mới) → tải thumb về local → `persistSentMessage type=image`
→ emit `fb:onMessage`.

## 6. Error handling & tín hiệu tin cậy

- `sendSticker`: xác nhận = **sticker ĐI mới xuất hiện** (đếm `div[role=img][aria-label$=sticker]` hugs phải
  trước/sau). Không false-fail → không kích hoạt MessageQueue retry (nguồn spam cũ). Quá hạn → throw rõ ràng.
- `listStickers` không ra cell → trả rỗng (UI hiện "không tìm thấy"), không throw.
- Picker không mở / logout → throw như `openThread` hiện tại ("cần đăng nhập lại").
- Dedupe nhận: tái dùng `_recentPageMsgIds` (sticker đến dùng chung cơ chế).

## 7. Testing / success criteria

- Unit (jest, không cần browser):
  - `pageBusinessSuiteSelectors` snapshot hằng số mới.
  - `FacebookPageBrowserSender` với FakeDriver: `sendSticker` gọi driver đúng thứ tự, `listStickers` trả qua.
  - `handlePageMessageNotification`: body "Đã gửi một nhãn dán" → chọn `wantType='sticker'` (tách hàm phân loại
    thuần để test, hoặc test qua nhánh).
- Thủ công (có browser, cần anh/thread thật): gửi 1 sticker (thấy ở máy khách, đứng tên Page); khách gửi
  sticker → app hiện ảnh; emoji gửi + nhận.
- Build `tsc -p tsconfig.electron.json` exit 0; jest suite trang 100% pass (2 suite better-sqlite3 ABI fail
  sẵn, không liên quan).
- 2 vòng stress-test, mỗi vòng desktop + mobile width; dark/light; không overflow ngang; không chồng chữ.

## 8. Rủi ro & trần (ceiling)

- **Thumbnail scontent có thể không load trong renderer** nếu CDN đòi cookie/referer → thumbnail vỡ.
  Trần: thử URL trực tiếp trước; nếu vỡ, fallback tải qua `FileStorageService` rồi hiện local (ghi chú,
  chỉ làm nếu thực sự vỡ). `ponytail:` dùng URL trực tiếp, proxy nếu đo thấy vỡ.
- **Gửi theo index** (vị trí trong kết quả search) → khớp đúng ô user bấm; yêu cầu lưới `listStickers` và
  lưới lúc `sendSticker` cùng `keyword` **ổn định thứ tự**. Trần: nếu FB đổi thứ tự giữa 2 lần search, có thể
  gửi lệch ô; giảm thiểu bằng gửi ngay sau list (cùng phiên picker) + verify label kỳ vọng nếu cần.
- **Picker đa cấp / lazy-load**: search là đường xác định nhất (đã verify) → tránh drill mood động.
- Sticker động (webp) tải về hiển thị tĩnh/động tuỳ renderer; chấp nhận.

## 9. Rollout
dev (test) → build artifact → deploy theo workflow. Không tự push/release. Changelog + version khi anh duyệt.
