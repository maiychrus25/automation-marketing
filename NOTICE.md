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
