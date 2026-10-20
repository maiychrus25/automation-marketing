# Intent: Sản xuất video bán hàng bằng HyperFrames

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (20/10/2026, duyệt thiết kế trong chat).

## Problem

Bài có video được Facebook ưu tiên hiển thị hơn bài chỉ có ảnh. Nhưng hiện nay:

- Làm một video bán hàng ngắn (ảnh sản phẩm, giá, lời kêu gọi, nhạc) phải dùng công cụ ngoài, làm tay từng video.
- Bot AI không có cách nào tự tạo video để đăng, dù đã điều khiển được việc đăng bài, chiến dịch và biến thể A/B.
- Render video tốn CPU. Nếu chạy trên VPS Windows đang chạy MaiHub thì có thể tranh tài nguyên với lượt đăng bài.

## Proposed outcome

- **Máy chủ render riêng** (`maihub-render`) trên một VPS Linux, chạy Docker, dùng **HyperFrames** (mã nguồn mở của HeyGen, Apache-2.0).
  - Các MaiHub của anh dùng chung, mỗi MaiHub một khoá API.
  - Việc render chạy trong **container cắt mạng**.
- **3 mẫu video bán hàng:** Trình chiếu sản phẩm, Flash sale, Nổi bật 1 sản phẩm. Mỗi mẫu có khổ 9:16 / 1:1 / 16:9, đi kèm **5 bản nhạc CC0**; có thể dùng nhạc tự tải lên hoặc không dùng nhạc.
- **Mục "Video" trong Đăng Facebook:**
  - chọn mẫu, điền ảnh / chữ / giá / màu / nhạc rồi tạo video;
  - thư viện video;
  - "Dùng trong Soạn bài" (kết hợp được với chiến dịch và biến thể A/B có sẵn).
- **Bot AI:**
  - tạo video bằng mẫu + dữ liệu, hoặc bằng **HTML tự viết** (chạy trong khu cách ly);
  - dùng video vừa tạo để đăng bài;
  - nhận tin Telegram khi video xong.

## Constraints

- **An toàn:**
  - HTML của bot chỉ chạy trong container không mạng, chỉ thấy tệp của đúng việc đó, không có khoá API hay bí mật nào;
  - có giới hạn thời lượng, kích thước, thời gian render;
  - dịch vụ API không giữ quyền Docker.
- **HyperFrames:** ghim phiên bản và tắt telemetry.
- **Bản quyền nhạc:** chỉ đóng gói nhạc CC0 có nguồn rõ ràng.
- **Triển khai:** đưa lên VPS là bước riêng, cần anh duyệt và cấp SSH. Không đổi cấu hình máy chủ nào khi chưa được duyệt.
- **Giao thức Control API chỉ thêm.** MaiHub vẫn chạy bình thường khi chưa cấu hình máy chủ render.

## Success criteria

- Từ mẫu "Trình chiếu sản phẩm" với 5 ảnh, tạo được video 9:16 dài 30 giây, chữ tiếng Việt đúng dấu, trong khoảng ≤ 3 phút trên VPS 4 CPU.
- Video tạo xong dùng được ngay trong Soạn bài: đăng nhóm / fanpage như video thường.
- Bot gọi `videos.render` → nhận `videos.finished` → dùng `mediaId` trong `drafts.create`, không cần thao tác tay.
- HTML tự viết của bot không gọi được mạng, không đọc được tệp ngoài thư mục của việc.
- Không hồi quy Đăng Facebook, Control API và các mục khác.

## Spike

`docs/reports/2026-10-20-hyperframes-spike.md`: render được trong Docker cắt mạng, khoảng 112 giây cho 30 giây video 9:16 trên 4 CPU; khu cách ly chặn mạng, `file://` và leo thư mục.
