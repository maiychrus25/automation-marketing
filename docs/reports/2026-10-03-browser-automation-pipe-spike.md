# Báo cáo spike: điều khiển Browser Profiles để tự động hóa mà không mở cổng

| Thuộc tính | Giá trị |
|---|---|
| Ngày thực hiện | 03/10/2026 |
| Câu hỏi | Tính năng đăng bài Facebook (`docs/intent/2026-10-02-facebook-poster.md`) cần điều khiển trình duyệt của profile. Có cách nào làm vậy mà không mở cổng remote-debugging (spec Browser Profiles cấm), và không làm profile dễ bị phát hiện hơn không? |
| Kết luận | **Có.** Để Playwright tự khởi chạy nhân `fingerprint-chromium` và điều khiển qua `--remote-debugging-pipe`. Không cổng mạng nào được mở, `navigator.webdriver` là false, BrowserScan chấm Normal ở mọi mục kể cả CDP |
| Phạm vi đã đo | Linux x86_64 (Ubuntu 24.04, có màn hình), nhân `fingerprint-chromium` 148.0.7778.215 do MaiHub cài sẵn, `playwright-core` 1.62.1, `patchright-core` 1.63.0 |
| Chưa đo | CreepJS, pixelscan, browserleaks; bản Windows của nhân trình duyệt; proxy thật; đăng bài thật trên tài khoản Facebook |

Mã thử nghiệm là đồ bỏ đi, nằm ngoài repo, chạy với hồ sơ tạm; không có thay đổi nào trong mã nguồn MaiHub.

## 1. Các cách điều khiển đã xét

| Cách | Mô tả | Kết quả |
|---|---|---|
| Đường ống | Playwright `launchPersistentContext` với `executablePath` trỏ vào nhân của MaiHub; Playwright tự thêm `--remote-debugging-pipe` | **Chọn** |
| Cổng cục bộ | MaiHub spawn nhân như hiện tại, thêm `--remote-debugging-port` trên `127.0.0.1`; Playwright `connectOverCDP` | Loại: cổng không có xác thực (mục 3) |
| Extension trong profile | Cài một extension để thao tác trang | Loại: phải viết lại toàn bộ phần tự động hóa, không được lợi gì thêm |

## 2. Kết quả đo

Mọi lần chạy dùng cùng bộ tham số mà `src/services/browser/fingerprint.ts` dựng: `--fingerprint=123456`, `--fingerprint-platform=linux`, `--fingerprint-brand=Chrome`, `--fingerprint-hardware-concurrency=8`, `--lang=vi-VN`, `--timezone=Asia/Ho_Chi_Minh`. Với Playwright, bỏ cờ mặc định `--enable-automation`.

| Đo | Đường ống (Playwright) | Đường ống (Patchright) | Cổng cục bộ |
|---|---|---|---|
| Cổng TCP của trình duyệt đang nghe | 0 | 0 | 1 |
| `navigator.webdriver` | false | false | false |
| Fingerprint áp dụng (`hardwareConcurrency`, múi giờ) | 8, `Asia/Saigon` | 8, `Asia/Saigon` | Không đo |
| Phép dò `Runtime.enable` (`console.debug` một `Error` có getter `stack`) | Không bị bắt | Không đọc được (xem dưới) | Không đo |
| BrowserScan bot-detection, tổng | Normal | Không đo | Normal |
| BrowserScan, mục CDP và Dev Tool | Normal | Không đo | Normal |
| bot.sannysoft.com, WebDriver và WebDriver Advanced | passed | Không đo | Không đo |

- `Asia/Saigon` là tên khác của `Asia/Ho_Chi_Minh` trong cơ sở dữ liệu múi giờ, không phải lệch.
- Patchright chạy `page.evaluate` trong ngữ cảnh cô lập, nên không đọc được biến mà mã dò ghi vào trang. Đó cũng chính là cách Patchright tránh `Runtime.enable`.
- Phép dò `Runtime.enable` chỉ là một biến thể phổ biến, tự viết. Kết quả "không bị bắt" chưa loại trừ được các biến thể khác.

## 3. Cổng cục bộ: trang web có dò được không, và vì sao vẫn loại

Cho một trang công khai (`example.com`) gọi `fetch` tới `http://127.0.0.1:<cổng>/json/version`:

- Quyền `local-network-access` của trang ở trạng thái `prompt`.
- `fetch` treo chờ người dùng cho phép, sau 8 giây vẫn chưa trả về.

Tức là Chromium 148 chặn trang web dò cổng cục bộ khi người dùng chưa cho phép, nên trang không biết cổng có mở hay không. Cổng cục bộ vẫn bị loại vì lý do khác: cổng không có xác thực, nên **mọi chương trình trên máy** nối vào được và điều khiển được trình duyệt đã đăng nhập Facebook. Đường ống không có bề mặt đó.

## 4. Hệ quả cho thiết kế

1. Mở profile bằng tay giữ nguyên: `BrowserProfileService` spawn nhân như hiện tại. Spec Browser Profiles không phải đảo quyết định "không mở cổng".
2. Chế độ tự động hóa là đường khởi chạy thứ hai: Playwright khởi chạy cùng nhân, cùng `--user-data-dir`, cùng tham số từ `buildLaunchArgs`, cùng `ProxyForwarder`.
3. Profile đang mở tay thì không nhận việc tự động; phải đóng trước. Đường ống chỉ tồn tại khi Playwright tự khởi chạy trình duyệt.
4. Đóng bằng `context.close()` để cookie được ghi, giống yêu cầu đóng tử tế của Browser Profiles.
5. Phụ thuộc mới: `playwright-core`, không kèm trình duyệt của Playwright. Patchright để dự phòng.

## 5. Rủi ro phát hiện nằm ngoài cách điều khiển

FB Poster bấm nhiều nút bằng `element.click()` chạy trong trang. Sự kiện sinh ra có `isTrusted = false`, khác với cú bấm của người thật. Trang nào kiểm tra thuộc tính này sẽ thấy, bất kể điều khiển qua cổng hay đường ống. Chưa đo Facebook có kiểm tra hay không. Khi chuyển sang MaiHub, các cú bấm quan trọng nên dùng cú bấm chuột của Playwright.

## 6. Việc còn lại

1. Chạy CreepJS, pixelscan, browserleaks; so sánh với cùng profile mở bằng tay.
2. Lặp lại trên bản Windows của nhân trình duyệt.
3. Chốt danh sách cờ mặc định của Playwright cần bỏ, vì chúng có thể làm lệch fingerprint so với lúc mở tay.
4. Đo tải tệp ảnh/video vào ô soạn bài trên Chromium 148, khi Playwright nhắm Chromium 151.
5. Đăng thật trên vài tài khoản và theo dõi checkpoint.

## Nguồn tham khảo

- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- [Rebrowser: sửa lỗi bị phát hiện qua Runtime.enable](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
- [So sánh Patchright và rebrowser-patches, 2026](https://dataresearchtools.com/patchright-vs-rebrowser-patches-stealth-playwright-patches-compared-2026/)
