# Intent: Chiến dịch và biến thể A/B cho Đăng Facebook

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (20/10/2026, duyệt thiết kế trong chat).

## Problem

26.21 đã đo được hiệu quả từng bài, nhưng chưa trả lời được hai câu hỏi khi làm marketing:

- **Một đợt quảng bá hiệu quả đến đâu?** Một đợt thường gồm nhiều lịch đăng (nhiều nội dung, nhiều nhóm, nhiều ngày). Hiện các lịch rời rạc: không gom được, không bật/tắt cả đợt một lần, báo cáo chỉ xem theo từng lịch.
- **Nội dung nào hiệu quả hơn?** Mỗi lượt đăng dùng một nội dung cho mọi nhóm. Muốn thử hai cách viết thì phải tạo hai lịch, không chia đều được các nhóm và khó so sánh.

Đây là phần **B** và **C** của lộ trình đã duyệt:
- **26.22:** B (chiến dịch) + C (biến thể A/B).
- **26.23:** chấm điểm nhóm, khách tiềm năng từ bình luận, giờ đăng.

## Proposed outcome

- **Chiến dịch** là một "thư mục" có tên, mục tiêu, ngày bắt đầu/kết thúc tuỳ chọn và trạng thái (đang chạy / tạm dừng / lưu trữ):
  - Lịch đăng và bài nháp gắn được vào một chiến dịch.
  - Tạm dừng chiến dịch, hoặc khi ngoài thời gian chiến dịch, thì các lịch của nó không tự chạy.
  - Xem hiệu quả theo chiến dịch.
- **Biến thể A/B:** một bài có 2–5 cách viết (chỉ khác nội dung chữ):
  - Trong mỗi lượt, MaiHub xoay vòng đều các biến thể cho các nhóm.
  - Lịch lặp lại thì lần sau đổi biến thể cho từng nhóm.
  - Báo cáo so sánh tương tác từng biến thể, và báo "chưa đủ dữ liệu" khi còn ít bài.
- **Bot quyết định, MaiHub cung cấp thao tác:** bot tạo và quản lý chiến dịch, tạo bài có biến thể, đọc báo cáo để tự chọn hướng tiếp. MaiHub không tự sinh lịch, cũng không tự chọn biến thể thắng.

## Constraints

- **Giao thức chỉ thêm:** bot cũ gửi một `text` vẫn chạy như trước; dữ liệu cũ không đổi nghĩa.
- **An toàn đăng bài giữ nguyên:**
  - Biến thể không đổi luật thử lại của 26.21.
  - Lần thử lại đăng đúng biến thể đã chọn.
  - Theo dõi tìm bài theo đúng chữ đã đăng.
- **Chỉ thêm bảng và cột** (không đổi cột cũ); dữ liệu theo dõi cũ không có chiến dịch hoặc biến thể.
- **Tên định danh** dùng tiền tố `fb_poster_` để không đụng tính năng "chiến dịch" Zalo CRM có sẵn.

## Success criteria

- Lịch của một chiến dịch đang tạm dừng không tự chạy. Tiếp tục chiến dịch thì lịch chạy lại như cũ mà không phải bật lại từng lịch.
- Một lượt đăng 10 nhóm với 2 biến thể cho 5 bài mỗi biến thể. Lượt sau của cùng lịch thì mỗi nhóm nhận biến thể kia.
- Báo cáo cho ra số bài, số bài đã đo và tương tác trung bình theo chiến dịch và theo biến thể.
- Không hồi quy: Đăng Facebook, lịch đăng, bài nháp, theo dõi bài, Nghiên cứu, Control API cũ.
