# Mã hoá bí mật đăng nhập lưu trên máy và bật sandbox cho cửa sổ app

**Ngày:** 21/11/2026
**Trạng thái:** Anh duyệt thiết kế 21/11/2026 (cách 1; phạm vi sửa cùng ngày). Đã triển khai trong 26.52.0 (21/11/2026); sandbox chưa thử trên app đã cài.
**Tài liệu liên quan:** `src/services/secure/SecureSettingsService.ts`, `src/services/facebook/FacebookAccountCookie.ts`, `electron/main.ts` (cửa sổ chính).

## 1. Vì sao

Anh muốn MaiHub chặt hơn để thông tin không lọt ra ngoài (21/11/2026). Khảo sát chỉ đọc trên máy anh cùng ngày cho thấy ai đọc được thư mục dữ liệu của MaiHub (phần mềm độc hại chạy dưới tài khoản của anh, bản sao lưu, ổ đĩa bị lấy) sẽ lấy được ngay:

- cookie Facebook: bản chính đã mã hoá bằng `safeStorage`, nhưng còn bản dự phòng thô trong `fb_accounts.cookie_encrypted`;
- ~~cookie và imei Zalo~~ — **sửa 21/11/2026:** cookie Zalo trong `accounts.cookies` đã được `saveAccount` mã hoá bằng `safeStorage` từ trước (base64 không có tiền tố `enc:`, nên lần khảo sát đầu nhận nhầm là dạng thô). `imei` vẫn thô nhưng vô dụng nếu không có cookie. Phiên Telegram người dùng và token bot trong cùng cột được cố ý để thô từ 26.8.0 ("tránh DPAPI mismatch khi restart" trên Windows); việc này giữ nguyên, ngoài phạm vi;
- mật khẩu proxy trong `proxies.password`;
- khoá ký phiên nhân viên `employee_jwt_secret` trong `app_settings`.

Bản dự phòng thô của Facebook được thêm vì lo Keychain không giải mã được sau khi cập nhật app ký ad-hoc. Trong 4 lần mở app gần nhất (có một lần ngay sau cập nhật 26.50.0) không có lần giải mã nào thất bại.

Cửa sổ chính chạy với `contextIsolation: true`, `nodeIntegration: false` nhưng `sandbox: false`; preload biên dịch chỉ `require("electron")`.

## 2. Mục tiêu, không làm, không được xảy ra

- **Mục tiêu:** bản cookie Facebook thô bị bỏ, mật khẩu proxy và khoá phiên nhân viên được lưu dạng `enc:` (mã hoá bằng `safeStorage`: Keychain trên macOS, DPAPI trên Windows, libsecret trên Linux); dữ liệu thô cũ được chuyển đổi một lần rồi xoá; cửa sổ chính chạy `sandbox: true`.
- **Không làm:** chứng chỉ ký app (Apple Developer ID / Windows Authenticode) và 2FA GitHub là việc của anh; không đổi việc giao diện nhận cookie tài khoản (phiên Telegram vẫn được gửi sang giao diện như hiện nay — để một việc riêng); không mã hoá nội dung tin nhắn trong cơ sở dữ liệu; không đổi cách lưu cookie Zalo, imei, phiên/token Telegram.
- **Không được xảy ra:** tài khoản đang chạy bị mất đăng nhập sau khi cập nhật trong trường hợp bình thường; chuỗi `enc:` bị dùng như cookie thật; bí mật xuất hiện trong nhật ký.

## 3. Các cách đã xét

1. **Mã hoá toàn bộ bí mật đăng nhập + bật sandbox** — anh chọn (21/11/2026).
2. Chỉ bỏ bản cookie Facebook thô — nhỏ hơn nhưng để Zalo, proxy, khoá phiên nhân viên nằm thô.

## 4. Hành vi

1. Mã hoá và giải mã nằm ở một chỗ: `SecureSettingsService` có thêm hai hàm thuần cho một giá trị (`enc:` + base64 như hiện nay). Giá trị thô cũ đọc được như trước (chưa chuyển đổi).
2. `proxies.password` được mã hoá ở mọi chỗ ghi (`saveProxy`, `updateProxy`) và giải mã ở mọi chỗ đọc (mọi câu `FROM proxies` đều nằm trong `DatabaseService`). Phần còn lại của app vẫn thấy giá trị thật như trước.
3. Giải mã thất bại → coi như không có phiên (tài khoản cần đăng nhập lại), nhật ký chỉ ghi tên bảng/cột và mã tài khoản nội bộ; không bao giờ trả chuỗi `enc:` cho nơi dùng.
4. Facebook: thôi ghi `fb_accounts.cookie_encrypted`; khi chuyển đổi, xoá giá trị thô nếu bản mã hoá trong kho giải mã được; nếu kho không có hoặc không giải mã được thì chuyển bản thô vào kho (mã hoá) rồi mới xoá.
5. `employee_jwt_secret` đọc/ghi qua `secureGet`/`secureSet`. Nếu không giải mã được thì tạo khoá mới (nhân viên phải đăng nhập lại).
6. Chuyển đổi chạy một lần mỗi cơ sở dữ liệu lúc mở (mỗi không gian làm việc có cơ sở dữ liệu riêng), trong một transaction, đánh dấu bằng khoá `secrets_at_rest_migrated` trong `app_settings`; chỉ chạy khi `safeStorage.isEncryptionAvailable()`. Không có thì giữ nguyên dạng thô như hiện nay và ghi cảnh báo một lần.
7. Cửa sổ chính: `sandbox: true`. Nếu preload hay giao diện cần API không có trong sandbox, sửa cho dùng IPC chứ không tắt sandbox.

## 5. Rủi ro đã cân nhắc

- **Quay về bản cũ:** sau khi chuyển đổi, bản ≤ 26.51.0 đọc phải chuỗi `enc:` ở mật khẩu proxy → phải nhập lại mật khẩu proxy (cookie Facebook không ảnh hưởng: bản cũ đọc kho mã hoá trước). Ghi rõ trong ghi chú phát hành.
- **Linux không có keyring:** `safeStorage` dùng khoá cố định (`basic_text`) — không kém hơn dạng thô; giữ như cách `SecureSettingsService` đang làm.
- **Windows:** DPAPI gắn với tài khoản Windows; không hỏi mật khẩu; chép cơ sở dữ liệu sang máy/tài khoản khác thì không giải mã được (đúng ý đồ).
- **Sandbox** chỉ kiểm chứng được trên app đã cài: cần anh đồng ý cài để thử các luồng chính (mở app, chat, gửi tệp, kéo thả tệp, cài đặt).

## 6. Kiểm chứng

- Test: hàm mã hoá/giải mã một giá trị (có `safeStorage` giả); ghi rồi đọc tài khoản và proxy qua cơ sở dữ liệu thật trong test cho ra giá trị thật, còn cột trong bảng là `enc:`; chuyển đổi một cơ sở dữ liệu có dữ liệu thô (chạy hai lần không đổi gì thêm; giải mã lỗi không làm mất dữ liệu đang đọc được); Facebook không còn ghi bản thô; khoá phiên nhân viên; cờ sandbox của cửa sổ chính.
- Quét mã: không còn câu SQL đọc `cookies`/`imei`/`password` mà bỏ qua bước giải mã.
- Sau khi cài (có anh đồng ý): Zalo và Facebook vẫn kết nối, proxy vẫn chạy, đọc thẳng cơ sở dữ liệu chỉ thấy `enc:`.
