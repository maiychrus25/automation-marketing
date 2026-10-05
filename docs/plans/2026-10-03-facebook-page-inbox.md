# Facebook Page Inbox — kế hoạch bàn giao

> Trạng thái: **chưa có spec**. Việc đầu tiên của người nhận là hoàn tất spike (bước 0) rồi viết spec theo `docs/specs/` và kế hoạch chi tiết theo mẫu của `docs/plans/2026-10-01-browser-profiles.md`. Intent: `docs/intent/2026-10-03-facebook-page-inbox.md`. Bằng chứng: `docs/reports/2026-10-03-facebook-page-inbox-spike.md`.

## Bước 0: Kết luận spike (0,5–1 ngày)
Làm đúng mục 3 của báo cáo spike. Kết quả cần ghi lại vào báo cáo:
- [ ] Thread list với phiên `i_user` có trả hội thoại Page không.
- [ ] MQTT có phát tin Page không; nếu không, kênh nào.
- [ ] Gửi tin với vai Page có hoạt động không.
Nếu cả ba đạt → đi tiếp theo kiến trúc dưới. Nếu thread list không đạt → dừng, báo chủ sản phẩm; lựa chọn còn lại là Graph API chính thức (hướng B, đã bị từ chối) hoặc port LightSpeed/Business Suite (chi phí lớn, chưa ước lượng).

## Kiến trúc đề xuất (áp dụng khi bước 0 đạt)
- **Mô hình dữ liệu:** `fb_accounts` thêm `parent_account_id` (NULL với tài khoản cá nhân) và `page_profile_id`, `delegate_page_id`, `enabled`. Một dòng cho mỗi Page được bật. Cookie của Page = cookie cá nhân + `i_user`; **không lưu riêng**, dựng lúc chạy từ cookie của tài khoản cha, để đổi cookie cá nhân thì Page theo luôn.
- **Phiên:** `FacebookSession.initSession` được gọi riêng cho từng Page (vì `fb_dtsg` khác). Giữ `FBSessionData` theo account id như hiện nay.
- **Nghe tin:** một `FacebookMQTTListener` cho mỗi Page bật, cùng cơ chế với tài khoản cá nhân. Nếu bước 0 cho thấy một kết nối MQTT nhận cả tin Page thì gộp, tránh nhiều kết nối.
- **Gửi:** `FacebookMessageSender` nhận `FBSessionData` của Page; không đổi giao diện gọi.
- **Giao diện:** trong Thêm tài khoản → Facebook, sau khi kết nối tài khoản cá nhân, hiện danh sách Page quản trị (từ `bookmarks/pages`) với công tắc bật/tắt. Ở Sidebar, Page hiện như tài khoản con dưới tài khoản cá nhân (tên Page, ảnh Page). Chat/CRM/Workflow coi Page là một `accountId` bình thường.
- **Workflow:** trigger Facebook chọn được Page trong danh sách account. Không cần loại node mới.

## Thứ tự công việc
1. Bước 0 (spike) → cập nhật báo cáo.
2. Spec + plan chi tiết, duyệt với chủ sản phẩm.
3. DB + model + `listManagedPages()` trong `FacebookService` (unit test cho hàm parse HTML `bookmarks/pages`).
4. Phiên theo Page + thread list + messages (kiểm tay với Page có tin).
5. MQTT theo Page; sự kiện vào `EventBroadcaster` như tài khoản cá nhân.
6. Gửi tin với vai Page.
7. Giao diện Thêm tài khoản + Sidebar.
8. Hồi quy: Messenger cá nhân, workflow Facebook, CRM Facebook; hai vòng light/dark, desktop/mobile.

## Rủi ro cao nhất
Bước 0 không đạt (API cũ không phục vụ hộp thư Page). Mọi thứ phía sau phụ thuộc vào đó; không bắt đầu bước 3 trước khi bước 0 có kết quả bằng tin nhắn thật.
