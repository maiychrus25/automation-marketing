# Ghi nhận nguồn gốc — AHV Connect

**AHV Connect** là bản phái sinh nội bộ của Trung tâm Đào tạo Lái xe AHV, xây
dựng trên mã nguồn mở:

- **Deplao** — https://github.com/babyvibe/deplao-builder
- Tác giả: babyvibe
- Giấy phép: **MIT** (xem `LICENSE`, giữ nguyên không sửa đổi)

Bản quyền của tác giả gốc được giữ nguyên theo đúng điều khoản MIT.

## Những thay đổi so với bản gốc

| # | Thay đổi | Lý do |
|---|---|---|
| 1 | **Tắt `TrackingService`** | Bản gốc gửi `pageId` (zalo_id / facebook_id / telegram id của tài khoản đang đăng nhập) và `machineId` lên máy chủ thượng nguồn. Trung tâm không gửi dữ liệu tài khoản ra ngoài |
| 2 | **Chặn toàn bộ `backendService`** (premium, quét nhóm qua máy chủ, thanh toán, affiliate, chia sẻ nhóm) | Các chức năng này gửi dữ liệu nhóm và tài khoản ra máy chủ thượng nguồn; bản nội bộ không dùng gói premium |
| 3 | **Tắt kiểm tra cập nhật tự động** | Bản gốc lấy bản mới từ kho phát hành của tác giả; để nguyên thì bản nội bộ bị ghi đè. Bản nội bộ phát theo kênh riêng |
| 4 | **Gỡ 5 workflow CI và thư mục `landing/`** | Đây là hạ tầng phát hành và trang quảng bá của tác giả, không dùng cho bản nội bộ |
| 5 | **Đổi định danh ứng dụng** | `name` → `ahv-connect`, `appId` → `com.ahv.connect`, `productName` → `AHV Connect` |
| 6 | **Thêm nhà cung cấp AI `ahvchat`** | Tuỳ biến của trung tâm: thêm lựa chọn provider tương thích OpenAI, nhập tên mô hình tự do |
| 7 | **Sửa `tg.sendMessage` trong WorkflowEngineService** | Bản gốc đọc `segment.text` thay vì `segment.content`, khiến trả lời do AI soạn bị gửi thành tin rỗng qua Telegram |
| 8 | **Thay toàn bộ bộ biểu tượng** (`resources/icons/`) | Logo cũ là nhận diện của sản phẩm thượng nguồn. Bộ mới sinh tại chỗ: khung bo tròn xanh `#1D4ED8`, bong bóng chat chứa vô-lăng |
| 9 | **Đổi protocol deep link** `deplao://` → `ahvconnect://` | Hai nơi khai báo (`package.json` và `electron/main.ts`) phải khớp nhau; giữ scheme cũ thì bản nội bộ giành đăng ký với bản gốc trên cùng một máy |
| 10 | **Gỡ trang "Donate & Ủng hộ"** kèm ảnh `src/assets/donate/qr.png` | Trang này chứa **mã QR ngân hàng, Telegram và Facebook cá nhân của tác giả gốc** — nhân sự trung tâm có thể chuyển tiền nhầm |
| 11 | **Gỡ luồng affiliate** (`AffiliateIntroPopup`, nút "Kiếm tiền", chấm đỏ nhắc) | Chương trình hoa hồng của sản phẩm thượng nguồn, không áp dụng cho bản nội bộ |
| 12 | **Gỡ/đổi hướng mọi liên kết ra ngoài trỏ về tác giả gốc** | GitHub issues, fanpage `fb.com/deplaoapp`, `t.me/babyvibe9`, nút sao GitHub. Thay bằng hướng dẫn báo lỗi trong ứng dụng |
| 13 | **Rút gọn `UpdateNotification` thành component rỗng** | Hộp thoại chứa 6 liên kết tải thẳng từ kho phát hành của tác giả; bấm vào sẽ cài đè bản nội bộ |
| 14 | **Đổi thông tin sản phẩm nhúng vào bản dựng** | `CompanyName`/`LegalCopyright` (Windows exe), maintainer gói `.deb`, tên bot mặc định trong workflow, nhãn nguồn đơn gửi sang POS (`deplaoapp` → `ahvconnect`) |
| 15 | **Thay `README.md`, xoá `README.en.md`** | README gốc là trang quảng bá sản phẩm thượng nguồn (badge kho, link website, hướng dẫn tải bản phát hành của họ) |

Hai thay đổi 6–7 do phía trung tâm thực hiện trước; cách tắt telemetry cũng
lấy theo bản của trung tâm (trả về kết quả rỗng có thông báo, phủ đủ 7 hàm)
thay vì ném lỗi.

## Những chỗ CỐ Ý giữ nguyên tên "deplao"

Không phải sót — đổi sẽ gây mất dữ liệu hoặc phá tương thích:

| Chỗ giữ nguyên | Lý do |
|---|---|
| Tên tệp trên đĩa: `deplao-tool.db`, `deplao-config.json` | Bản cài đã có sẵn sẽ mất toàn bộ dữ liệu nếu đổi tên mà không viết bước di trú |
| Khoá `localStorage`: `deplao_employee_login`, `deplao_employee_password`, `deplao_forum_topics_*` | Đổi khoá là đăng xuất toàn bộ nhân viên và mất cache |
| Khoá nhận dạng tệp workflow xuất ra: `_deplaoWorkflow` | Đổi thì không nhập lại được các tệp workflow đã xuất trước đó |
| Thư mục tạm: `deplao-clipboard`, `deplao-videometa`, `deplao-workflow-images` | Nội bộ, không hiển thị cho người dùng |
| Chú thích mô tả dịch vụ đã tắt (`TrackingService`, `backendService`) | Ghi đúng những gì đã bị chặn — là tài liệu, không phải nhận diện thương hiệu |

## Lưu ý khi dùng

- Ứng dụng thao tác trên **tài khoản Zalo cá nhân** qua thư viện `zca-js`.
  Việc này **vi phạm chính sách của Zalo** và có thể dẫn tới khóa tài khoản.
  Dùng tài khoản riêng cho công việc, **không dùng tài khoản cá nhân của nhân
  viên**.
- Bản dựng **chưa ký số**; hệ điều hành sẽ cảnh báo khi cài. Chỉ cài bản do
  trung tâm phát, không tải bản trôi nổi.
- Bản gốc **không có** trần gửi theo ngày, giờ im lặng hay cơ chế từ chối
  nhận. Vì vậy bản này **chỉ dùng để trải nghiệm**, không dùng gửi tin hàng
  loạt cho học viên thật cho tới khi bổ sung các hàng rào đó.
- **Không bật tunnel Cloudflare** của webhook gateway: nó mở một địa chỉ công
  khai trỏ vào máy đang giữ phiên Zalo của trung tâm.
