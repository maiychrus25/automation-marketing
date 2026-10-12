# Thiết kế: Gửi tin từ Page qua tự động hóa Business Suite (đợt 1)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 05/10/2026 |
| Trạng thái | Đã phát hành 26.12.0 |
| Bối cảnh | Nối tiếp `docs/specs/2026-10-03-facebook-page-inbox.md` — tiêu chí "trả lời văn bản và ảnh với vai Page" của đợt đó CHƯA đạt vì gửi qua REST cổ điển không tới nơi. |
| Bằng chứng kỹ thuật | `docs/reports/2026-10-03-facebook-page-inbox-spike.md` (§1.3) + capture 05/10/2026 (mục 2 dưới đây) |

## Ghi chú sau phát hành (12/10/2026)

Thân tài liệu giữ nguyên như lúc viết. Các điểm dưới đây là chỗ mã nguồn bản 26.16.0 khác tài liệu:

- Mục 3.1 (hợp đồng): không có `static get()` và `close()` trên class. Class `FacebookPageBrowserSender` chỉ điều phối (hàng đợi nối tiếp, ánh xạ lỗi) với `driver` được truyền vào constructor (`src/services/facebook/FacebookPageBrowserSender.ts:50`). Factory và đóng phiên là hàm `getPageBrowserSender(pageAccountId, deps)` và `closePageBrowserSender(pageAccountId)` ở `src/services/facebook/pagePlaywrightDriver.ts:292`, `:339`, với `deps = { getCookie, delegatePageId }` (`:286-289`).
- Mục 3.2: thời gian rảnh trước khi đóng trình duyệt là 5 phút (`IDLE_CLOSE_MS`, `pagePlaywrightDriver.ts:25`).
- Mục 3.3 bước 3: đính kèm đi qua hộp chọn tệp (`filechooser`) bấm từ nút "Đính kèm file", rồi chờ cố định 7000 ms trước khi Enter (`pagePlaywrightDriver.ts:109-132`, `ATTACH_SETTLE_MS` ở `:24`).
- Mục 3.3 bước 4 (cách xác nhận): không chờ "bong bóng tin" mà chờ nút "Gửi lượt thích" quay lại sau khi Enter một lần, tối đa 20000 ms (`pagePlaywrightDriver.ts:134-146`, `:205`; `SENT_TIMEOUT_MS` ở `FacebookPageBrowserSender.ts:45`). Lý do ghi tại `waitSent`: đếm ảnh và tìm chữ hay báo hỏng giả, kéo theo gửi lại.
- Mục 3.4: nhánh Page của `sendMessage` không còn ở dòng ~2041 mà ở `src/services/facebook/FacebookService.ts:2131`; `replyToMessageId` được truyền nhưng driver không dùng.
- Mục 7 (roadmap): nhận ảnh, video và sticker đã làm bằng trích DOM (`FacebookService.ts:598`, `pagePlaywrightDriver.ts:148`); gửi sticker đã có (`pagePlaywrightDriver.ts:261`). Lịch sử tin cũ và thời gian gửi đúng vẫn chưa làm, nhận tin vẫn dựa vào thông báo MQTT của tài khoản cha chứ chưa chuyển sang GraphQL BizInbox.

## 1. Mục tiêu

Khi người dùng trả lời một hội thoại thuộc Page đã bật trong MaiHub, tin **đến được khách và hiển thị dưới danh nghĩa Page**. Bản 1 hỗ trợ **văn bản, ảnh và file**. Không đụng tới chat cá nhân (1:1/group/E2EE), reader/MQTT, hay bất kỳ đường gửi hiện có nào.

Đạt khi:
1. Gửi text từ một hội thoại Page → khách nhận được, đứng tên Page.
2. Gửi ảnh và file từ hội thoại Page → khách nhận được, đứng tên Page.
3. Mọi thất bại trả lỗi rõ ràng cho UI; **không bao giờ báo success khi tin chưa thực sự đi** (sửa đúng triệu chứng "gửi mà không tới").
4. Các đường gửi cá nhân (1:1/group/E2EE) và reader Page giữ nguyên hành vi.

## 2. Bằng chứng: vì sao phải tự động hóa Business Suite

Capture mạng khi gửi 1 tin thật từ Business Suite (công cụ throwaway, script playwright nạp cookie Page):
- **Không có HTTP request gửi tin nào.** 38 GraphQL bắt được đều là query tải trang (`BizInbox*`, `NorthStar*`), không mutation gửi.
- Tin đi qua **WebSocket nhị phân**: `gateway.facebook.com/ws/realtime`, `.../ws/streamcontroller`, `edge-chat.facebook.com/chat` — payload binary (MQTT/LightSpeed), không phải request port được.
- Bridge Go `messagix` sẵn có **không dựng được vai Page**: đăng nhập thuần bằng `c_user/xs` (tài khoản cá nhân), bỏ qua `i_user`; `socket.SendMessageTask` không có trường page/business/actor. Mở rộng bridge (Approach A) để sau.
- Khảo sát các thư viện ngoài (fbchat-v2, facebook-chat-api, họ fca-unofficial): tất cả chỉ lái **tài khoản cá nhân**, không cái nào gửi vai Page.

→ Đường khả thi và đúng danh tính nhất cho đợt 1: **điều khiển chính client Business Suite thật** bằng trình duyệt engine đã có.

## 3. Kiến trúc

### 3.1 Thành phần mới: `FacebookPageBrowserSender`
Một class (1 file `src/services/facebook/FacebookPageBrowserSender.ts`), tách biệt, không import electron để test được phần thuần.

Trách nhiệm: quản lý **một phiên trình duyệt headless cho mỗi Page** và gửi tin qua DOM của Business Suite.

Giao diện công khai (hợp đồng):
```ts
interface PageSendResult { success: boolean; messageId?: string; error?: string }
interface PageSendInput { text?: string; files?: { path: string; type: 'image'|'video'|'audio'|'file' }[]; replyToMessageId?: string }

class FacebookPageBrowserSender {
  // Lấy/khởi tạo instance theo pageAccountId (giống FacebookService.instances)
  static async get(pageAccountId: string, deps: PageSenderDeps): Promise<FacebookPageBrowserSender>;
  // Gửi 1 tin (text và/hoặc đính kèm) vào hội thoại threadId
  send(threadId: string, input: PageSendInput): Promise<PageSendResult>;
  // Đóng phiên trình duyệt (idle timeout hoặc khi tắt Page)
  close(): Promise<void>;
}
```
`deps` bơm vào (DIP, để test): đường dẫn engine (`resolveEngineExecutable`), userDataDir, hàm lấy cookie Page (`() => string`), delegatePageId, logger.

### 3.2 Vòng đời trình duyệt
- **Lazy + persistent:** lần `send` đầu mới `launchPersistentContext` (engine antidetect, headless), mở sẵn inbox Page; giữ sống để tái dùng. Idle quá N phút → `close()`.
- **Phiên đăng nhập:** `userDataDir = <userData>/page-browser/<pageAccountId>`. Lần đầu nạp cookie Page (cookie cha + `i_user`, dùng lại `buildPageCookie` của `FacebookPages.ts`). Phiên lưu trong userDataDir, lần sau không cần nạp lại.
- **Một send một lúc cho mỗi Page:** hàng đợi/mutex nội bộ để các thao tác DOM không chồng nhau. *(ponytail: mutex đơn giản per-page; nâng nếu cần thông lượng.)*

### 3.3 Cơ chế gửi (DOM thật)
1. Điều hướng tới đúng hội thoại của `threadId` (deep-link URL — **chốt ở Task 1 probe**).
2. Text: focus ô soạn → gõ `text` → gửi (Enter hoặc nút Gửi).
3. Đính kèm: set file vào `<input type=file>` của composer → chờ upload xong → (kèm caption nếu có) → gửi.
4. Xác nhận: chờ bong bóng tin vừa gửi xuất hiện trong khung chat (hoặc trạng thái "đã gửi"). Có → `success`. Không trong thời hạn → `error`.
5. `messageId`: nếu DOM không lộ mid thật → sinh id cục bộ `page:<otid>` để lưu DB/emit UI. *(ponytail: id tổng hợp; dedup self-echo MQTT dựa trên `markMessageLocallySent`, chấp nhận ca hiếm trùng, nâng khi có mid thật.)*

**Selector ô soạn / nút gửi / input file: chốt ở Task 1 (probe an toàn, KHÔNG gửi).** Spec cố ý không ghi cứng selector; chúng nằm sau một lớp "driver" nhỏ trong sender để dễ sửa khi Business Suite đổi DOM.

### 3.4 Tích hợp vào luồng hiện có
- `FacebookService.ts` nhánh Page (dòng ~2041 trong `sendMessage`): thay `sendMessageREST(...)` bằng gọi `FacebookPageBrowserSender.get(...).send(threadId, { text: body, replyToMessageId })`.
- Thêm phương thức Page cho đính kèm (vd `sendPageAttachment`) đi cùng sender; `requireSession`/`uploadAttachment` REST **không dùng cho Page nữa**.
- `electron/ipc/facebookIpc.ts` `fb:sendAttachment` + `fb:sendAttachments`: nhánh Page bỏ `uploadAttachment` (REST), chuyển thẳng **đường dẫn file local** cho sender (Business Suite tự upload qua composer).
- Lưu DB + emit UI vẫn do `FacebookSendService.persistSentMessage` lo như cũ — không đổi.

### 3.5 Không đụng tới
Đường 1:1/group/E2EE, bridge `messagix`, reader/MQTT của Page, cây Sidebar, bật/tắt Page. Nhánh `_isPage` trong `sendMessage` là ranh giới thay đổi duy nhất ở phía gửi.

## 4. Xử lý lỗi / xuống thang
- Không mở được hội thoại / không thấy ô soạn / gửi quá hạn → `{ success:false, error:'Chưa gửi được từ Page qua Business Suite: <lý do>' }`. UI báo lỗi, **không** fake success.
- Headless bị checkpoint/đăng xuất → lỗi rõ: yêu cầu mở headful đăng nhập 1 lần (cùng `userDataDir`). *(Tùy chọn: cờ env mở headful để anh xử lý.)*
- Engine chưa cài / launch lỗi → lỗi rõ, không crash tiến trình chính.

## 5. Kiểm thử
- **Unit (thuần, chạy trong `make test`):** builder deep-link URL từ `threadId`/`delegatePageId`; dựng cookie Page (`buildPageCookie`); phân loại file→type; parse kết quả gửi. Không cần trình duyệt.
- **Probe thủ công (Task 1):** harness headful quan sát URL hội thoại + selector, không gửi.
- **Nghiệm thu (2 vòng, desktop):** gửi text/ảnh/file vào hội thoại thật, kiểm phía khách nhận được + đứng tên Page; kiểm đường cá nhân không hồi quy.
- `make build` / `make test` / `make lint` xanh trước khi báo xong.

## 6. Phạm vi đợt sau (không làm bây giờ)
- Approach A (mở rộng bridge Go gửi vai Page qua task native) — thay thế Business Suite browser khi ổn định.
- Reaction/thu hồi/sửa tin, reply trích dẫn chính xác, nhiều Page gửi song song quy mô lớn.

## 7. Roadmap mở rộng Page (PO 06/10/2026)

Thứ tự ưu tiên PO đưa ra:
1. Nhận đủ media còn lại: video / file / voice (hiện mới có ảnh).
2. Sticker + icon (thả tim): gửi & nhận.
3. Gửi ảnh kèm chú thích (đã chạy; hoàn thiện UX).
4. Chất lượng / hiệu năng / ổn định như Facebook: **load lại tin nhắn cũ (history)**, **hiển thị time gửi đúng**.

### Ghi chú chiến lược (quan trọng)
Mục (1),(2) có thể làm tiếp bằng trích DOM Business Suite như ảnh, nhưng mục (4) —
**history + timestamp đúng** — thì **trích DOM KHÔNG kham nổi** (DOM virtualize, không phân
trang, không có mốc thời gian chuẩn). Hai yêu cầu này đòi **dữ liệu tin có cấu trúc**, tức
phải **dò ngược GraphQL BizInbox của Business Suite** (list hội thoại + get messages có
timestamp + phân trang) — chính "Approach B đầy đủ" đã nêu. Khi tới mục (4), nên chuyển
receive-side sang BizInbox GraphQL (thay cho scraping DOM), và cân nhắc làm sớm vì nó cũng
bao trọn (1),(2) một cách sạch sẽ. Đây là nền bền thật sự cho hộp thư Page.
