# Intent: Đo hiệu quả bài đã đăng và lấy link bài chờ duyệt

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (19/10/2026, duyệt lộ trình 26.21 → 26.23 trong chat).

## Problem

Đăng Facebook đăng bài vào nhóm được, nhưng sau đó **không biết bài nào hiệu quả**:

- Bài vào hàng **chờ duyệt** vẫn được ghi là "đã đăng" nhưng không có link. Không ai quay lại lấy link khi admin duyệt, nên không theo dõi được bài.
- Không thu số **cảm xúc, bình luận, chia sẻ** của bài mình đăng. Bot AI không có dữ liệu để biết nhóm, giờ hay kiểu nội dung nào hiệu quả.
- Bài bị admin **xoá** thì không biết.

Đây là phần **A** của lộ trình anh đã duyệt:
- **26.21:** A + G (tự thử lại khi đăng lỗi).
- **26.22:** chiến dịch, biến thể A/B.
- **26.23:** chấm điểm nhóm, khách tiềm năng từ bình luận, giờ đăng.

Các phần sau đều dựa trên dữ liệu đo của phần này.

## Proposed outcome

- Mỗi bài đăng vào nhóm có một **bản ghi theo dõi**: link, trạng thái link (có link / chưa có link / chờ duyệt / không tìm thấy), nghi bị xoá, và các **lần đo** số tương tác.
- **Thao tác "Theo dõi bài"**: anh bấm trong app hoặc bot gọi khi muốn, theo đúng hướng "bot quyết định, MaiHub cung cấp thao tác". Mỗi lần chạy:
  - Dùng chính profile đã đăng để đọc bảng tin nhóm, bằng cơ chế GraphQL của Nghiên cứu.
  - Tìm lại bài của mình: lấy link cho bài chờ duyệt hoặc chưa có link, ghi số tương tác, và đánh dấu bài có thể đã bị xoá.
- **Báo cáo hiệu quả** theo nhóm, profile, lịch, ngày hoặc từng bài. Bot đọc báo cáo qua API để tự rút kinh nghiệm và báo cáo qua Telegram.
- Lúc đăng: nếu trang hiện thông báo "đang chờ phê duyệt" thì ghi nhận ngay là chờ duyệt.

## Constraints

- **Chỉ đọc:** không đăng, không bấm thích, không bình luận khi theo dõi.
- **Không tranh profile với lượt đăng:** dùng chung khe việc với lượt đăng (như kiểm tra đăng nhập), nên lịch đến giờ sẽ chờ.
- **Giới hạn để an toàn tài khoản:**
  - giới hạn số nhóm và số trang mỗi lần chạy;
  - nghỉ giữa các trang và giữa các nhóm;
  - dừng profile khi gặp hết phiên hoặc checkpoint (cập nhật trạng thái đăng nhập, báo 🔒).
- **Giao thức chỉ thêm:** Control API chỉ có thêm thao tác và sự kiện mới, bot cũ không ảnh hưởng.
- **Dữ liệu thử:** test dùng dữ liệu giả. Cách đọc bảng tin dùng lại bộ đọc của Nghiên cứu, và cũng chưa được đo trên trang thật.

## Success criteria

- Một bài chờ duyệt, sau khi admin duyệt, được gắn link ở lần "Theo dõi bài" kế tiếp.
- Mỗi lần theo dõi lưu một lần đo (cảm xúc, bình luận, chia sẻ) cho mỗi bài tìm thấy. Báo cáo cho ra tổng và trung bình theo nhóm và theo profile.
- Bài từng thấy mà nay không thấy, dù đã đọc qua mốc thời gian đăng của nó, được đánh dấu "có thể đã bị xoá".
- Không hồi quy Đăng Facebook, lịch đăng, kiểm tra đăng nhập và Nghiên cứu.
