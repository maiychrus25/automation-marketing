# Intent: Chấm điểm nhóm, giờ đăng tốt nhất và khách tiềm năng từ bình luận

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (20/10/2026, duyệt thiết kế và cách chia bản trong chat).

## Problem

Từ 26.21 và 26.22, MaiHub đã đo được từng bài, theo chiến dịch và biến thể. Nhưng vẫn còn ba câu hỏi chưa có câu trả lời:

- **Nên đăng vào nhóm nào?** Có nhóm hay bắt chờ duyệt, hay xoá bài, hay tương tác thấp. Hiện phải tự dò từng dòng báo cáo.
- **Nên đăng lúc mấy giờ?** Chưa có báo cáo nào theo giờ hay theo thứ trong tuần.
- **Ai đang muốn mua?** Bình luận hỏi giá, xin inbox, để lại số điện thoại chỉ được thu khi bấm tay. Không có gì lọc ra người có ý định mua, cũng không có nơi theo dõi đã liên hệ hay chưa.

Đây là phần **D**, **E**, **F** của lộ trình đã duyệt. Theo thiết kế được duyệt, phát hành thành hai bản:
- **26.23:** D (chấm điểm nhóm) + F (giờ đăng).
- **26.24:** E (khách tiềm năng từ bình luận).

## Proposed outcome

- **D:**
  - Mỗi nhóm có điểm 0–100, nhãn (Tốt / Trung bình / Kém / Chưa đủ dữ liệu) và lý do dễ hiểu.
  - Điểm hiện ở báo cáo và cạnh tên nhóm khi soạn bài.
  - Bot đọc điểm qua API để tự chọn nhóm.
- **F:**
  - Báo cáo theo giờ và theo thứ.
  - Dòng gợi ý "Giờ nên đăng" (chung hoặc theo nhóm), hiện cả khi hẹn giờ.
  - Bot đọc qua API.
- **E:**
  - Bài trong nhóm đã có link được tự thu bình luận theo mốc. Bộ lọc từ khoá (và AI tuỳ chọn) tách ra khách tiềm năng.
  - Danh sách khách có trạng thái, ghi chú và xuất Excel.
  - Báo Telegram khi có khách mới; bot đọc và cập nhật qua API.
- **Bot quyết định, MaiHub cung cấp thao tác và gợi ý.** MaiHub không tự bỏ nhóm, không tự đổi giờ lịch, không tự nhắn khách.

## Constraints

- **Chỉ đọc Facebook:** không đăng, không bình luận, không nhắn tin khi thu bình luận. Dùng chung khe việc với lượt đăng, có giới hạn và nghỉ, dừng khi profile hết phiên hoặc bị checkpoint.
- **Giao thức chỉ thêm.** Chỉ thêm bảng và cột.
- **AI tắt sẵn.** Khi bật, dùng trợ lý AI mặc định của app. AI lỗi thì vẫn giữ kết quả lọc theo từ khoá.
- **Điểm và gợi ý luôn ghi rõ "chưa đủ dữ liệu"** khi mẫu nhỏ; không giả vờ chắc chắn.
- **Thời điểm bình luận là ước tính**, vì Facebook chỉ hiện nhãn tương đối.

## Success criteria

- Nhóm có ≥ 3 lượt đăng trong 30 ngày có điểm và lý do. Nhóm 8/10 bài phải chờ duyệt bị chấm thấp, kèm lý do đó.
- Báo cáo theo giờ cho ra khung giờ có tương tác trung bình cao nhất, chỉ tính khung giờ đủ ≥ 5 bài đã đo.
- (26.24) Bình luận "ib giá", "0912 345 678" thành khách mới. Lần thu sau không tạo trùng. Bot nhận sự kiện khách mới.
- Không hồi quy: Đăng Facebook, lịch, theo dõi bài, chiến dịch / biến thể, Thu bình luận, Nghiên cứu, Control API cũ.
