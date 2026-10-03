# Intent: Chat với hộp thư Page Facebook qua tài khoản cá nhân
Author: Maiychrus. Status: draft (đã chốt hướng A trong hội thoại 03/10/2026).

## Problem
MaiHub kết nối Facebook bằng tài khoản cá nhân (mật khẩu hoặc cookie) và chỉ đọc/trả lời Messenger cá nhân. Tài khoản của chủ sản phẩm quản trị các Page (Media Soec, AHV Holding Careers) nhưng tin nhắn khách gửi vào Page không xuất hiện trong MaiHub; muốn trả lời phải mở Meta Business Suite.

## Proposed outcome
Mỗi Page mà tài khoản cá nhân quản trị xuất hiện trong MaiHub như một **tài khoản con** dưới tài khoản cá nhân đó, bật/tắt từng Page. Hộp thư Page có hội thoại riêng, nhận tin thời gian thực, trả lời văn bản và ảnh. Vì Workflow, CRM, nhãn và AI làm việc theo "tài khoản + hội thoại", các mảng này đi theo gần như tự động: trigger "Khi nhận tin nhắn" chạy cho tin Page, khách nhắn Page thành liên hệ CRM. Nhiều tài khoản cá nhân thì mỗi tài khoản có bộ Page riêng.

Đợt sau (tách riêng): bình luận trên bài đăng của Page.

Hướng kỹ thuật đã chốt: **giao thức không chính thức qua phiên cá nhân** (như Messenger web), không dùng Graph API/Page Access Token. Chủ sản phẩm chấp nhận rủi ro chính sách và chi phí bảo trì khi Facebook đổi giao thức.

## Affected users and systems
- Người dùng Boss/Standalone có tài khoản Facebook quản trị Page.
- `src/services/facebook/*` (session, thread list, MQTT listener, sender), `fb_accounts`/`fb_threads`/`fb_messages`, màn Chat, Workflow trigger Facebook, CRM Facebook.

## Constraints
- Không tạo app Facebook Developers; không dùng webhook công khai.
- Không đổi hành vi Messenger cá nhân đang chạy.
- Page thế hệ mới ("profile plus", id dạng 6159…) là loại phải hỗ trợ; Page cổ điển (delegate_page_id) hỗ trợ nếu cùng cơ chế.

## Open questions
1. Query thread list cũ (doc_id 3336396659757871) có trả về hội thoại của Page khi phiên mang cookie `i_user` không? (Spike dừng ở đây vì hộp thư Page trống; xem báo cáo.)
2. MQTT `edge-chat.facebook.com` có phát tin Page khi kết nối với phiên `i_user` không, hay Page dùng kênh khác?
3. Gửi tin với vai Page có dùng được mutation gửi hiện tại không?
4. Hộp thư Page trong Business Suite có cả Instagram/WhatsApp; MaiHub chỉ làm Messenger của Page ở đợt này.
