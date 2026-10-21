# Intent: Đăng bài ổn định hơn (Đợt 1 tối ưu)

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (21/10/2026).

## Problem

Khảo sát code ngày 21/10/2026 (luồng Đăng Facebook) cho thấy:

- **Checkpoint không được phát hiện khi đang đăng.**
  - Profile bị Facebook bắt xác minh vẫn còn cookie, nên lượt đăng vẫn mở từng nhóm.
  - Mỗi nhóm báo "không mở được hộp soạn thảo" và được thử lại 3 lần, tức là mở thêm nhiều trang trên một tài khoản đang bị nghi ngờ.
  - Trạng thái checkpoint không được ghi và không báo Telegram.
- **Không có dữ liệu chẩn đoán khi đăng lỗi.** Không có ảnh chụp, không có địa chỉ trang lúc lỗi; chỉ có câu báo lỗi cắt 200 ký tự.
- **Trình duyệt chết giữa lượt nhưng vẫn chạy tiếp.** Lượt đăng vẫn thử lại và nghỉ đủ giờ cho từng nhóm còn lại. Mở trình duyệt lỗi thoáng qua cũng không được thử lại.
- **Lỗi trước khi kịp đăng vẫn nghỉ đủ khoảng nghỉ dài** (thường 5–15 phút) trước nhóm kế tiếp, dù chưa có gì được đăng.
- **Việc phụ giành khe chạy ngay trước giờ đăng.** Theo dõi bài, thu bình luận và kiểm tra đăng nhập dùng chung khe chạy với lượt đăng, nên có thể chiếm khe sát giờ lịch đăng khiến lịch phải chờ.
- **Lấy link bài vừa đăng chỉ chờ cố định khoảng 2 giây.** Phản hồi của Facebook đến muộn hơn thì mất link, kéo theo bình luận đầu và theo dõi bài bị hỏng.

## Proposed outcome

- Phát hiện checkpoint hoặc bị đá ra trang đăng nhập (lúc mở và sau mỗi lần vào nhóm), rồi:
  - dừng profile đó ngay;
  - ghi trạng thái đăng nhập;
  - báo Telegram 🔒;
  - các nhóm còn lại nhận mã lỗi rõ ràng.
- Mỗi lần đăng lỗi lưu một ảnh chụp kèm địa chỉ trang trên máy MaiHub; tự dọn sau 7 ngày.
- Trình duyệt chết thì dừng profile đó ngay. Mở trình duyệt lỗi thoáng qua thì thử lại một lần.
- Lỗi khi chưa đăng được gì chỉ nghỉ ngắn (20–60 giây).
- Việc phụ nhường khe chạy khi sắp tới giờ đăng (10 phút).
- Lấy link bài: chờ tới khi có link, tối đa 8 giây, thay vì chờ cố định.

## Constraints

- Không thay đổi gì có thể gây **đăng trùng**: luật "chỉ thử lại lỗi trước cú bấm Đăng" giữ nguyên.
- Không đổi nhịp đăng thành công (khoảng nghỉ của người dùng giữ nguyên sau bài đăng được, và sau bài "chưa chắc").
- Mã lỗi mới chỉ thêm vào danh sách; Control API không đổi cấu trúc.
- Không đăng thật lên Facebook để thử. Kiểm bằng test giả lập và trình duyệt thật trên trang cục bộ; đo hiệu quả thật sau khi triển khai.
- Ảnh chẩn đoán chỉ lưu trên máy MaiHub, không gửi đi đâu.

## Success criteria

- Profile bị checkpoint: lượt đăng dừng profile đó ngay sau lần tải trang đầu tiên, có `profile.loginProblem`, các nhóm còn lại mang mã `checkpoint`.
- Mỗi lần đăng lỗi có đúng một ảnh chụp và một tệp ghi chú trong thư mục chẩn đoán; tên tệp nằm trong nhật ký.
- Thời gian một lượt có nhiều nhóm lỗi trước khi đăng giảm rõ (đo bằng test với đồng hồ giả: tổng thời gian nghỉ).
- Không hồi quy: toàn bộ test hiện có đạt; đăng thành công, thử lại, Huỷ, đóng cưỡng bức vẫn như cũ.
