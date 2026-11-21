# Lấy cookie Facebook bằng cách đăng nhập trong trình duyệt

**Ngày:** 21/11/2026
**Trạng thái:** Anh duyệt thiết kế 21/11/2026. Đã triển khai trong 26.51.0 (21/11/2026); chưa thử trên tài khoản thật.
**Tài liệu liên quan:** `electron/ipc/facebookIpc.ts` (`fb:updateCookie`), `src/services/browser/BrowserProfileService.ts`, `src/services/facebookPoster/loginState.ts`.

## 1. Vì sao

Ngày 19/11/2026 Facebook thu hồi phiên của tài khoản: MaiHub và cả trình duyệt của anh đều bị đăng xuất. Cookie MaiHub tự gia hạn từ 26.40.0 không cứu được phiên đã bị thu hồi, nên phải đăng nhập lại. Hiện nay việc đó nghĩa là đăng nhập trong trình duyệt rồi tự chép cookie dán vào "Cập nhật cookie".

Anh muốn: ở bước cập nhật cookie, MaiHub mở trình duyệt để anh đăng nhập; đăng nhập xong MaiHub tự lấy cookie cần dùng.

## 2. Mục tiêu, không làm, không được xảy ra

- **Mục tiêu:** từ thẻ tài khoản Facebook cá nhân (máy Boss), một nút mở cửa sổ trình duyệt đăng nhập; khi đăng nhập đúng tài khoản xong, MaiHub tự lưu cookie, kết nối lại và đóng cửa sổ.
- **Không làm:** không tự động đăng nhập; không lưu mật khẩu hay mã 2FA; không tự mở cửa sổ khi phiên chết (anh bấm nút); không áp dụng cho Page (Page dùng cookie của tài khoản cha); không có trên máy nhân viên; không đọc cookie từ Chrome anh dùng hằng ngày.
- **Không được xảy ra:** lưu cookie của một tài khoản Facebook khác vào tài khoản đang cập nhật; ghi giá trị cookie vào nhật ký; yêu cầu tới Facebook đi qua IP khác với proxy của tài khoản.

## 3. Các cách đã xét

1. **Dùng bộ mở trình duyệt có sẵn của "Hồ sơ trình duyệt"** (nhân Chromium MaiHub tải về, mở qua Playwright, proxy riêng từng hồ sơ). Anh chọn cách này (21/11/2026): là trình duyệt thật, dùng lại phần tính năng đăng bài đang chạy, đi đúng proxy.
2. Cửa sổ đăng nhập nhúng trong MaiHub (Electron): không cần nhân trình duyệt, nhưng Facebook hay nghi kiểu cửa sổ nhúng và proxy phải làm theo cách khác.
3. Đọc cookie từ Chrome hằng ngày của anh: loại, vì khi Facebook thu hồi phiên thì Chrome đó cũng đã đăng xuất, và cách này làm MaiHub dùng chung phiên với trình duyệt cá nhân.

## 4. Hành vi

1. Trong hộp thoại "Cập nhật cookie" của thẻ tài khoản Facebook cá nhân có thêm nút **"Đăng nhập bằng trình duyệt"** (chỉ máy Boss).
2. Bấm nút: tiến trình chính tìm hồ sơ trình duyệt đăng nhập dành riêng cho tài khoản này (ánh xạ lưu trong `app_settings`, khoá `fb_login_profile_<id tài khoản>`). Chưa có hoặc hồ sơ đã bị xoá thì tạo hồ sơ mới tên "Đăng nhập Facebook – <tên tài khoản>", vân tay mới như khi tạo hồ sơ thường. Mỗi lần mở, proxy của hồ sơ được đặt bằng proxy hiện tại của tài khoản (`resolveFBProxyId`).
3. Mở hồ sơ bằng `openForAutomation`, vào `https://www.facebook.com/`. Nếu hồ sơ vẫn còn đăng nhập đúng tài khoản thì lấy cookie ngay.
4. Trong lúc chờ, cứ 2 giây đọc cookie của `facebook.com`:
   - Có `c_user` và `xs`, `c_user` trùng `facebook_id` của tài khoản → ghép cookie, đi qua đúng bước kiểm tra và lưu của `fb:updateCookie` (kiểm phiên sống, lưu mã hoá, cập nhật hồ sơ, kết nối lại Page con), ghi sự kiện phiên `cookie_updated by=browser`, đóng cửa sổ, báo thành công.
   - `c_user` là tài khoản khác → không lưu; báo "Đang đăng nhập tài khoản Facebook khác" và tiếp tục chờ.
   - Bước kiểm tra cookie thất bại → báo lỗi, giữ cửa sổ mở để anh thử lại.
5. Dừng chờ khi anh đóng cửa sổ (báo "Đã đóng trình duyệt, chưa lấy được cookie"), khi anh bấm Huỷ trong hộp thoại, hoặc sau 10 phút.
6. Lỗi rõ ràng, không treo: chưa cài nhân trình duyệt (chỉ tới màn "Hồ sơ trình duyệt" để cài), hồ sơ đang mở sẵn, đang có một lần đăng nhập khác của cùng tài khoản, tài khoản là Page, proxy của tài khoản không còn.
7. Sau khi xong, hồ sơ vẫn giữ phiên đăng nhập để lần sau lấy nhanh; anh có thể xoá hồ sơ đó ở màn "Hồ sơ trình duyệt" như mọi hồ sơ khác.

## 5. Cách làm (gợi ý cho người viết kế hoạch)

- Tách thân `fb:updateCookie` thành một hàm dùng chung (nhận id tài khoản, cookie, nguồn `user`/`browser`); IPC cũ giữ nguyên hành vi.
- Một hàm thuần chọn cookie từ danh sách cookie trình duyệt và quyết định: chờ / sai tài khoản / sẵn sàng (kèm chuỗi cookie). Phần chờ nhận đồng hồ và trình duyệt giả qua tham số để test không mở trình duyệt thật.
- IPC mới `fb:loginWithBrowser` và `fb:cancelBrowserLogin`, chỉ Boss; tiến độ gửi về giao diện bằng sự kiện.
- Nhật ký chỉ ghi tên cookie và trạng thái, không ghi giá trị.

## 6. Kiểm chứng

- Test: chọn cookie (thiếu `xs`, sai tài khoản, đúng), vòng chờ (đóng cửa sổ, huỷ, quá giờ, lỗi kiểm tra rồi thành công), tạo lại hồ sơ khi ánh xạ trỏ tới hồ sơ đã xoá, `fb:updateCookie` cũ vẫn như trước. Không gọi Facebook thật trong test.
- Thử thật trên máy anh sau khi cài: đăng nhập trong cửa sổ, thấy tài khoản kết nối lại; đăng nhập nhầm tài khoản thì không lưu.
