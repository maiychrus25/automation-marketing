# Intent: Nghiên cứu chủ đề trên Facebook để lên chiến dịch đăng bài

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (19/10/2026, duyệt thiết kế trong chat).

## Problem

Hiện chiến dịch đăng bài được lên theo cảm tính. Muốn biết chủ đề nào đang được quan tâm, kiểu nội dung nào được tương tác nhiều, nên đăng vào nhóm nào và giờ nào, người dùng phải tự lướt Facebook.

Bot AI (Claude/Codex trên VPS) phân tích tốt và đã điều khiển được MaiHub, nhưng nó **không có dữ liệu Facebook** để phân tích.

Repo `babyvibe/facebook-scan-data-extension` cho thấy có thể lấy dữ liệu theo từ khoá bằng API GraphQL nội bộ của Facebook với phiên đăng nhập sẵn có. Nhưng đó là extension Chrome chạy tay, chỉ xuất Excel, không lưu theo thời gian, không nối với bot. Repo này cũng không có license nên không chép code được.

## Proposed outcome

MaiHub có tính năng **Nghiên cứu chủ đề**:

- **Quét theo hướng babyvibe:** gọi API GraphQL ngay trong trình duyệt của **các profile sẵn có**, xoay vòng giữa các profile. `doc_id` được bắt tự động từ request thật của trang, nên Facebook đổi mã thì MaiHub tự cập nhật.
- **Bốn nguồn:**
  - bài viết theo từ khoá;
  - nhóm theo từ khoá;
  - fanpage theo từ khoá;
  - bài trong các nhóm đã tham gia.
- **Lưu kết quả** theo từng lần quét, kèm số tương tác tại thời điểm quét, để so sánh theo thời gian.
- **Bot tự quyết:** gọi thao tác quét, đọc kết quả, tự phân tích xu hướng và đề xuất chiến dịch, rồi tạo nháp và lịch bằng các thao tác đã có.
- **Trong app:** tab "Nghiên cứu" để quét tay, xem bảng kết quả sắp theo tương tác và xuất Excel.

## Constraints

- Mỗi bài lưu người đăng (tên, ID, link, kể cả người đăng là cá nhân) để truy vết, theo yêu cầu của anh (19/10/2026). Không quét danh sách thành viên nhóm hay danh sách người bình luận/thả cảm xúc. Dữ liệu cá nhân chỉ dùng nội bộ và tự xoá sau 180 ngày (Nghị định 13/2023).
- Giữ an toàn cho tài khoản:
  - giới hạn số mục mỗi lần quét và mỗi ngày;
  - nghỉ giữa các trang kết quả;
  - dừng ngay khi gặp checkpoint, chặn tạm thời hoặc hết phiên.
- Dùng các profile sẵn có, xoay vòng và chia nhỏ lượng quét để giảm rủi ro mỗi tài khoản (anh chọn 19/10/2026):
  - mỗi profile có trần ngày riêng;
  - không quét bằng profile đang bận đăng bài;
  - có danh sách loại trừ cho tài khoản quan trọng;
  - bài trong nhóm được quét bằng profile đã tham gia nhóm đó.
- Không chép code babyvibe. Tự viết, chỉ tham khảo cách tiếp cận và tên truy vấn GraphQL (là thông tin công khai của Facebook).
- Control API chỉ được thêm thao tác và sự kiện mới; bot cũ không ảnh hưởng.
- Test dùng dữ liệu mẫu đã làm sạch, không gọi Facebook thật. Bước thử thật chỉ đọc và cần anh cho phép.

## Success criteria

- Bot gọi `research.search` với từ khoá X và nhận được tối đa N bài, mỗi bài có nội dung, số cảm xúc, bình luận, chia sẻ, thời gian, nơi đăng, người đăng và link. Kết quả được lưu lại.
- Quét lại cùng từ khoá vài ngày sau thì so được sự thay đổi.
- Facebook đổi `doc_id` thì lần quét sau vẫn chạy (tự bắt lại), không phải phát hành bản mới.
- Gặp checkpoint thì dừng, báo lỗi rõ ràng, không quét tiếp.
