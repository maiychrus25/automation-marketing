# Intent: Tự thử lại khi đăng bài lỗi và lưu lý do lỗi cụ thể

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (16/10/2026, duyệt thiết kế trong chat).

## Problem

Khi Đăng Facebook đăng vào nhóm, nhiều lỗi xảy ra **trước khi bấm Đăng**: Facebook tải chậm, không thấy ô "Bạn đang nghĩ gì…", ảnh tải lên chưa xong, nút Đăng đang tắt. Bài chắc chắn chưa lên, nhưng Poster bỏ qua nhóm đó luôn. Người dùng hoặc bot phải tự đăng lại bằng tay.

Lý do lỗi chỉ nằm trong nhật ký. Lịch sử, CSV, Control API (`runs.get`) và tin Telegram đều chỉ thấy câu chung "Không đăng được, xem nhật ký". Lỗi cũng không được phân loại, nên không ai biết lỗi nào đăng lại an toàn, lỗi nào bài có thể đã lên (đăng lại sẽ trùng).

Đây là phần 1/3 của nhóm yêu cầu:
1. Tự thử lại và phân loại lỗi (phần này).
2. Phát hiện bài chờ duyệt và lấy link khi bài được duyệt.
3. Thống kê tương tác.

Phần 2 và 3 sẽ là thao tác cho bot gọi, có intent riêng.

## Proposed outcome

- Trong lúc đăng, mỗi nhóm gặp lỗi **trước khi bấm Đăng** được tự thử lại tối đa 2 lần nữa. Trước mỗi lần: tải lại trang nhóm, chờ ngẫu nhiên 10–30 giây.
- Lỗi **sau khi đã bấm Đăng** (bài có thể đã lên) không thử lại. Loại này được đánh dấu "chưa chắc" để phần 2 kiểm tra.
- Mỗi kết quả lưu **lý do cụ thể**, **mã lỗi** cố định và **số lần đã thử**. Lịch sử, CSV, `runs.get` và tin Telegram đều thấy được.

## Affected users and systems

- Người dùng Đăng Facebook: đăng ngay và theo lịch.
- Bot AI qua Control API: `runs.get` có thêm trường; tin `watch` dùng lý do cụ thể.
- Mã nguồn: `postToTargets.ts`, `FacebookPosterService.ts`, store/schema của Đăng Facebook, `runCsv.ts`, `HistoryTab.tsx`, tài liệu.

## Constraints

- Không bao giờ thử lại sau cú bấm Đăng. Đăng trùng bài vào nhóm là lỗi nặng hơn bỏ sót.
- Huỷ (Cancel) dừng ngay, kể cả khi đang chờ để thử lại.
- Chỉ **thêm** trường vào Control API và CSV; không đổi nghĩa trường cũ.
- Không đăng thật lên Facebook trong test.
- Các loại việc khác (tham gia nhóm, quét nhóm, thu bình luận) giữ nguyên hành vi.

## Success criteria

- Một nhóm bị lỗi "không thấy ô soạn bài" ở lần 1 nhưng lần 2 đăng được thì được ghi là đã đăng, kèm `attempts = 2`.
- Lỗi "đã bấm Đăng nhưng hộp soạn thảo không đóng" không bao giờ được thử lại, và được ghi mã `uncertain_after_submit`.
- Lịch sử và `runs.get` hiện lý do thật thay cho "xem nhật ký".
- Toàn bộ test cũ vẫn xanh.
