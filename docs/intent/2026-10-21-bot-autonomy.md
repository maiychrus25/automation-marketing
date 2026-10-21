# Intent: Bot AI tự làm được nhiều hơn với các tính năng đã có

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (21/10/2026).

## Problem

Bot AI trên VPS Linux điều khiển MaiHub qua Control API + bridge MCP. Khảo sát code ngày 21/10/2026 cho thấy bot vẫn hay bị kẹt hoặc tốn lượt gọi:

- Lỗi trả về cho bot mất phần `details` (trường nào sai, profile nào lạ), không có gợi ý cách xử lý.
- Bot không nhận được hướng dẫn dùng: thứ tự vòng làm việc, quan hệ giữa các mã, ý nghĩa mã lỗi, quy tắc chống gọi trùng chỉ nằm trong tài liệu bot không đọc.
- Chờ việc chạy nền (quét, render, thu bình luận) phải gọi `events.wait` lặp lại mỗi 25 giây.
- Thu bình luận xong mà không có khách thì bot không biết; không xem được trạng thái, không huỷ được qua API.
- Sự kiện thiếu mã để làm bước tiếp theo (mã khách, chiến dịch), nên bot phải gọi thêm.
- Bot không biết giờ và múi giờ của máy MaiHub, dễ đặt lịch lệch giờ.
- Tin Telegram báo cả các lượt việc phụ thành công, gây ồn.

## Proposed outcome

Chỉ thêm vào giao thức, bridge và `watch`; không đổi hành vi của thao tác nào đang có (bot cũ chạy y như trước):

- Lỗi kèm chi tiết và gợi ý xử lý.
- Hướng dẫn vòng làm việc gửi ngay khi bot kết nối, và có tool đọc lại.
- Tool chờ một việc xong trong một lần gọi.
- Thu bình luận có sự kiện xong, xem trạng thái, huỷ.
- Sự kiện có thêm mã cho bước tiếp theo; `system.status` có giờ / múi giờ của máy.
- Tin Telegram bớt ồn.

## Constraints

- Giao thức chỉ thêm (trường mới, thao tác mới, sự kiện mới); không đổi tên, không bỏ trường, không thêm mã lỗi.
- Không đổi luật xác nhận (`confirm`) hay luật đăng: phần chính sách (giới hạn bài, xác nhận khi duyệt lịch) để anh quyết riêng.
- Bridge vẫn chỉ dùng thư viện chuẩn Python 3.6+.

## Success criteria

- Một vòng mẫu "quét nghiên cứu → tạo nháp → render video → chờ xong → thu bình luận → đọc khách" chạy được bằng ít lượt gọi hơn hiện nay (đo trên MaiHub dev; ghi số lượt trước / sau trong báo cáo).
- Mọi lỗi có `details` hiện đủ trong kết quả tool MCP.
- Bot cũ (bridge cũ) vẫn chạy với MaiHub mới; bridge mới vẫn chạy với MaiHub 26.26.0 (các tính năng mới tự tắt khi máy chủ chưa có).
- Không hồi quy: toàn bộ test hiện có đạt.
