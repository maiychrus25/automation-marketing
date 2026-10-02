# Intent: Đổi thương hiệu AHV Connect thành MaiHub
Author: Maiychrus. Status: approved.

## Problem
Sản phẩm đang mang tên, logo và thông tin nhà phát hành của Trung tâm Đào tạo Lái xe AHV, trong khi đây là dự án cá nhân của tác giả. Tên "AHV Connect", logo con đường hình chữ A, email và trang chủ của công ty xuất hiện trong bộ cài, trong giao diện và trong tài liệu.

## Proposed outcome
Ứng dụng mang thương hiệu **MaiHub** ở mọi nơi người dùng nhìn thấy: tên, logo hoa mai năm cánh, bộ cài, thư mục dữ liệu, liên kết mở app, chữ trong giao diện, tài liệu. Hệ thiết kế macOS và bố cục giữ nguyên. Dữ liệu hiện có tự chuyển sang thư mục mới khi mở MaiHub lần đầu.

## Affected users and systems
- Người dùng hiện tại (tác giả): dữ liệu được chuyển; phải đăng nhập lại các tài khoản trên Linux và macOS vì kho khóa hệ điều hành gắn với tên ứng dụng.
- Bộ cài và CI (`package.json`, `.github/workflows/build.yml`, `scripts/`).
- Main process (`electron/main.ts`), giao diện (`src/ui/`), logo (`resources/icons/`), tài liệu.

## Constraints
- Chỉ đổi thương hiệu; không đổi hệ thiết kế, bố cục hay hành vi tính năng.
- Giữ thông báo nguồn gốc và giấy phép trong `NOTICE.md` (yêu cầu của giấy phép MIT của dự án gốc).
- Giữ các định danh đã lưu trong dữ liệu người dùng: nhà cung cấp AI `ahvchat`, tên file DB.
- Không ghi email cá nhân trong bộ cài; nhà phát hành ghi "MaiHub".
- Không sửa tài liệu lịch sử (intent, spec, plan của tính năng trước) và các mục nhật ký phiên bản cũ.

## Open questions
- Tên miền và đăng ký nhãn hiệu "MaiHub" chưa được kiểm tra.
- macOS chưa có máy để thử việc chuyển dữ liệu.
