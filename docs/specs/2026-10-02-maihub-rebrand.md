# Thiết kế: Đổi thương hiệu sang MaiHub

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 02/10/2026 |
| Trạng thái | Đã duyệt trong hội thoại |
| Intent | `docs/intent/2026-10-02-maihub-rebrand.md` |
| Kế hoạch | `docs/plans/2026-10-02-maihub-rebrand.md` |
| Phiên bản phát hành | 26.9.0 |

## 1. Định danh

| Hạng mục | Cũ | Mới |
|---|---|---|
| Tên hiển thị (`productName`, `app.setName`, tiêu đề cửa sổ, khay, thông báo) | AHV Connect | MaiHub |
| Tên gói npm, tên gói deb, file chạy | `ahv-connect` | `maihub` |
| `appId`, AppUserModelId | `com.ahv.connect` | `com.maihub.app` |
| Liên kết mở app | `ahvconnect://` | `maihub://` |
| Thư mục dữ liệu (`userData`) | `AHV Connect` | `MaiHub` |
| Bộ cài Windows | `AHV Connect-Setup-<v>.exe` | `MaiHub-Setup-<v>.exe` |
| Artifact CI, tên Release | `ahv-connect-*`, "AHV Connect vX" | `maihub-*`, "MaiHub vX" |
| Tác giả, CompanyName, bản quyền | Trung tam Dao tao Lai xe AHV | MaiHub |
| Trang chủ | `https://cms-dev.ahvdtlx.com` | `https://github.com/maiychrus25/automation-marketing` |
| `deb.maintainer` | tên công ty + email công ty | `MaiHub <maiychrus25@users.noreply.github.com>` |
| Nguồn đơn hàng gửi sang POS | `ahvconnect`, tiền tố `AHVCONNECT-` | `maihub`, tiền tố `MAIHUB-` |

`deb.maintainer` bắt buộc có email theo electron-builder; dùng địa chỉ noreply của GitHub để không lộ email cá nhân.

Bộ lọc đơn hàng theo nguồn phải nhận cả `maihub` và `ahvconnect`, để các đơn đã tạo trước khi đổi tên vẫn hiện.

## 2. Giữ nguyên

- Nhà cung cấp AI `ahvchat` ("AHV Chat") và các mã mô hình `ahvholding/model/...`: là dịch vụ bên ngoài, đã lưu trong cấu hình trợ lý AI.
- Tên file DB (`deplao-tool.db`), khóa `localStorage`, tên bảng.
- `NOTICE.md`: giữ nguyên lịch sử nguồn gốc, thêm một dòng cho MaiHub.
- Các mục nhật ký phiên bản từ 26.8.6 trở về trước; tài liệu trong `docs/` của các tính năng trước.
- Hệ thiết kế, màu nhấn, bố cục.

## 3. Logo

- File gốc duy nhất vẫn là `resources/icons/icon.svg`, viewBox 100×100, nền bo góc 22 với dải màu `#1E40AF` → `#3B82F6`.
- Hình: hoa mai năm cánh màu trắng, năm cánh tròn tỏa đều quanh một tâm, tâm là một chấm cùng màu nền. Ý nghĩa: "Mai" và "hub" (một trung tâm, nhiều kênh).
- Giữ lớp `.unread-badge` ẩn sẵn (chấm đỏ góc trên phải) để script dựng biến thể `icon_dot.*`.
- Dựng lại bằng `node scripts/build-icons.mjs`; kiểm tra bằng mắt ở 16, 24, 32, 48, 64 px.
- Dấu hiệu rút gọn trong `Sidebar.tsx` vẽ lại theo cùng hình.

## 4. Chuyển dữ liệu

Chạy trong main process ngay sau `app.setName('MaiHub')` và trước khi xin single-instance lock.

1. Nếu thư mục `userData` mới đã tồn tại: không làm gì.
2. Nếu không có thư mục `<appData>/AHV Connect`: không làm gì.
3. Nếu bản AHV Connect cũ đang chạy (Linux/macOS: `SingletonLock` trỏ tới một tiến trình còn sống): không chuyển, hiện hộp thoại yêu cầu thoát AHV Connect rồi mở lại, và thoát.
4. Ngược lại: đổi tên thư mục cũ thành thư mục mới (`rename`, tức thời trên cùng ổ đĩa). Nếu `rename` lỗi (Windows đang khóa file, khác ổ đĩa): hiện hộp thoại như bước 3 và thoát.
5. Sau khi chuyển, xóa các file khóa của phiên cũ trong thư mục mới (`SingletonLock`, `SingletonCookie`, `SingletonSocket`).

Đường dẫn tuyệt đối đã lưu trong DB (ảnh đại diện, tệp đính kèm dạng `local-media:///…/AHV Connect/media/…`) được ánh xạ sang thư mục mới ngay trong bộ xử lý `local-media://`.

**Kho khóa hệ điều hành.** Trên Linux và macOS, khóa mã hóa của `safeStorage` gắn với tên ứng dụng (đã thử: dữ liệu mã hóa dưới tên "AHV Connect" không giải mã được dưới tên "MaiHub"). Chủ sản phẩm chọn đổi sạch: sau khi chuyển, các tài khoản và khóa API phải đăng nhập/nhập lại một lần. App không được crash khi gặp dữ liệu không giải mã được. Trên Windows khóa nằm trong `Local State` (DPAPI theo người dùng) và đi theo thư mục dữ liệu.

## 5. Cài đặt song song

Tên gói và `appId` đổi, nên MaiHub cài song song với AHV Connect; bản cũ phải gỡ bằng tay. README ghi rõ các bước.

## 6. Kiểm thử

- Unit test cho hàm quyết định chuyển dữ liệu (đủ 5 nhánh ở mục 4) và hàm ánh xạ đường dẫn cũ.
- Type-check hai cấu hình, toàn bộ jest.
- Bản cách ly: tạo dữ liệu bằng bản cũ dưới thư mục "AHV Connect" (có profile trình duyệt, workspace phụ, một giá trị mã hóa), chạy bản mới, xác nhận dữ liệu có mặt trong "MaiHub", thư mục cũ không còn, app khởi động không lỗi.
- Giao diện: không còn chữ "AHV Connect" ở màn hình đăng nhập nhân viên, khóa màn hình, Sidebar, Giới thiệu, Cài đặt; chụp ở light/dark, desktop và 400 px.
- Quét mã nguồn: không còn "AHV"/"ahv" ngoài danh sách giữ nguyên ở mục 2.
- CI build đủ Linux, Windows, macOS.

## 7. Rủi ro

- Người dùng phải đăng nhập lại trên Linux/macOS (đã chấp nhận).
- macOS: chưa thử chuyển dữ liệu; quyền truy cập Keychain của bundle mới chưa kiểm chứng.
- Windows: `rename` thư mục có thể bị khóa nếu bản cũ đang chạy; đã có hộp thoại hướng dẫn.
- Đơn hàng POS tạo sau khi đổi tên mang nguồn `maihub`; báo cáo bên POS lọc theo `ahvconnect` sẽ không thấy đơn mới.
