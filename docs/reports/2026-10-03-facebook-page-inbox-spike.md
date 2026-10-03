# Báo cáo spike: đọc hộp thư Page Facebook qua phiên cá nhân

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 03/10/2026 |
| Câu hỏi | Phiên Facebook cá nhân đang có trong MaiHub có liệt kê được Page và đọc được hộp thư Page không? |
| Kết luận | Liệt kê Page: **được**. Chuyển vai sang Page: **được** (cookie `i_user`). Đọc hộp thư Page: **chưa kết luận** vì hộp thư Page thử nghiệm trống. |
| Cách làm | Script bỏ đi chạy trong Electron tên app `MaiHub` (để `safeStorage` giải mã được cookie), chỉ đọc, không gửi tin; và một phiên trình duyệt (nhân `fingerprint-chromium` của Browser Profiles, điều khiển bằng `playwright-core`) để quan sát Messenger web thật |

## 1. Những gì đã xác nhận

### 1.1 Liệt kê Page mà tài khoản quản trị
- Trang `https://www.facebook.com/bookmarks/pages` (GET với header của `fbHeaders(cookie)` trong `FacebookSession.ts`; header tối giản bị 400) trả HTML chứa JSON `additional_profiles_with_biz_tools`:
  - mỗi node có `id` (id profile của Page thế hệ mới, ví dụ `61592412314280`), `name` ("Media Soec"), `delegate_page_id` (`1254744041053955`), `profile_picture.uri`, `unseen_message_count`.
  - cùng trang có `profile_switcher_eligible_profiles.nodes[].profile` với `is_profile_plus: true`.
- Menu tài khoản trên Messenger web liệt kê đúng các Page này (Media Soec, AHV Holding Careers).

### 1.2 Chuyển vai sang Page
- Trong Messenger web, bấm tên Page ở menu tài khoản gửi mutation `CometProfileSwitchMutation`; hệ quả duy nhất về phía cookie là Facebook đặt thêm **`i_user=<id profile Page>`** (`c_user` giữ nguyên là tài khoản cá nhân).
- Tái tạo không cần trình duyệt: thêm `i_user=<id Page>` vào chuỗi cookie rồi gọi `initSession(cookie)` của app → trả `FacebookID = id Page` và `fb_dtsg` mới. Query thread list cũ (`getThreadList`, doc_id `3336396659757871`) với phiên này chạy không lỗi (`status 200`, không `errorSummary`).
- Các cách khác đều thất bại: đặt `av` hoặc `__user` = id Page/delegate id với phiên cá nhân → lỗi `1357032 "Đã xảy ra lỗi"`; dùng cookie `i_user` nhưng giữ `fb_dtsg` cá nhân → cùng lỗi. Phải khởi tạo lại phiên sau khi thêm cookie.
- URL `https://www.facebook.com/profile_plus/switch/?profile_id=…` không tồn tại (404).

### 1.3 Hộp thư Page trên web
- Khi đang là Page, `https://www.facebook.com/messages/t/` chuyển hướng sang **Meta Business Suite**: `https://business.facebook.com/latest/inbox/all?asset_id=<delegate_page_id>`. Hộp thư này dùng bộ GraphQL riêng trên `business.facebook.com` (các query `BizInbox*`, `NorthStar*`), khác hẳn Messenger. Không nên đi đường này trừ khi 1.2 thất bại.

## 2. Chưa kết luận
Hộp thư Page "Media Soec" không có hội thoại nào (ảnh chụp Business Suite trống), nên "0 thread" từ query thread list với `i_user` không phân biệt được "API không có dữ liệu Page" với "Page chưa có tin".

## 3. Bước tiếp theo (cho người nhận việc)
1. Nhắn một tin từ tài khoản khác vào Page Media Soec (hoặc AHV Holding Careers).
2. Chạy lại phép thử 1.2: cookie + `i_user`, `initSession`, `getThreadList(sess, ['INBOX'])`. Nếu thấy hội thoại → đọc được bằng cách hiện có; thử tiếp `getMessages` của thread đó.
3. Thử MQTT: `FacebookMQTTListener` với phiên `i_user` (cùng `sessionID`/`last_seq_id` của Page) xem tin Page có về không.
4. Thử gửi: `FacebookMessageSender` với phiên `i_user` vào thread Page (gửi vào thread thử nghiệm của chính mình).
5. Nếu bước 2 cho 0 thread dù Page có tin → phải dùng giao thức LightSpeed của Messenger web hoặc Business Suite; quan sát lại network bằng kịch bản trình duyệt (mục 4) khi mở một hội thoại Page.

## 4. Tái tạo spike
Hai script bỏ đi không nằm trong repo. Cách dựng lại:
- **Script gọi API** (Electron, `app.setName('MaiHub')`, `app.setPath('userData', <appData>/MaiHub)`): đọc `fb_accounts.id` từ `deplao-tool.db` (mở `readonly`), lấy `app_settings.value` với key `fb_cookie_<id>`, bỏ tiền tố `enc:` và `safeStorage.decryptString(base64)`; dùng `initSession`, `getThreadList`, `buildFormData`, `buildPostConfig` từ `dist-electron/src/services/facebook/*` (chạy `tsc -p tsconfig.electron.json` trước). Chạy: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/.bin/electron script.js`.
- **Script trình duyệt**: `playwright-core` `chromium.launchPersistentContext(udd, { executablePath: <chrome của browser-engine>, headless: false, args: ['--fingerprint=…', '--fingerprint-platform=linux', '--fingerprint-brand=Chrome'] })`, `addCookies` từ chuỗi cookie (domain `.facebook.com`), mở `/messages/t/`, bấm nút banner `aria-label="Trang cá nhân của bạn"`, bấm tên Page, đọc `document.cookie` để thấy `i_user`; ghi `context.on('request')` để lấy `x-fb-friendly-name`/`fb_api_req_friendly_name`.

## 5. Rủi ro
- Giao thức không chính thức: doc_id và cookie có thể đổi bất kỳ lúc nào; mỗi lần đổi là một lần sửa.
- Chuyển vai bằng `i_user` áp dụng cho cả tài khoản trong cùng phiên cookie: cần giữ hai chuỗi cookie (cá nhân và từng Page) tách biệt trong app, không ghi đè cookie cá nhân.
- Facebook có thể coi việc nhiều phiên song song (cá nhân + Page) từ cùng cookie là bất thường.
