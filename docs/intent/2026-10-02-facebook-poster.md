# Intent: Đăng bài Facebook tự động trên Browser Profiles của MaiHub
Author: Maiychrus. Status: draft.

## Problem

Việc đăng tin lên Facebook Group và Page hiện chạy trên một công cụ riêng, **FB Poster** (kho `maiychrus25/tools-facebook`). Công cụ này dùng Playwright điều khiển Chromium có giao diện, đã chạy thật với: đăng bài kèm ảnh/video vào nhiều nhóm, đăng lên Page, bình luận đầu tiên (bỏ qua khi bài còn chờ duyệt), tìm và xin tham gia nhóm theo từ khóa, thu bình luận của các bài đã đăng, lịch sử và thống kê.

Tách riêng như vậy gây ra bốn vấn đề:

1. **Mỗi lượt chỉ chạy được một tài khoản.** FB Poster có đúng hai hồ sơ trình duyệt (một cho Group, một cho Page). Muốn đăng bằng nhiều tài khoản thì phải chạy nhiều bản, không có cách quản lý chung.
2. **Không có fingerprint và proxy riêng cho từng tài khoản.** Mọi hồ sơ của FB Poster dùng chung một proxy cấu hình toàn cục và fingerprint thật của máy. Chạy nhiều tài khoản trên một máy thì dễ bị Facebook liên kết và khóa chéo.
3. **Trùng lặp với MaiHub.** MaiHub đã có Browser Profiles (mỗi profile một Chromium antidetect với fingerprint, proxy và dữ liệu đăng nhập riêng), kho proxy, mô hình nhân viên và phân quyền, workflow engine có lịch và webhook. FB Poster phải tự làm lại những thứ đó ở mức kém hơn.
4. **Hai sản phẩm phải bảo trì song song.** Facebook đổi giao diện thường xuyên (gần nhất 02/10/2026, lời mời soạn bài trong nhóm đổi thành "Bạn viết gì đi..."). Mỗi lần như vậy phải sửa, dựng và phát hành riêng FB Poster.

## Proposed outcome

MaiHub có tính năng đăng bài Facebook chạy **bên trong Browser Profiles**: người dùng chọn nhiều profile đã đăng nhập Facebook, soạn một bài, và MaiHub điều khiển các trình duyệt antidetect đó để đăng. Sau khi tính năng chạy ổn, **FB Poster ngừng dùng**; kho cũ chỉ giữ để tham khảo.

### Tính năng mang sang

Toàn bộ các tính năng đang chạy của FB Poster, trừ công cụ TopCV:

- **Đăng Group:** đăng bài kèm ảnh/video vào danh sách nhóm, nghỉ ngẫu nhiên giữa các lượt, quét danh sách nhóm đã tham gia, lọc nhóm theo từ khóa.
- **Đăng Page:** đăng lên Page mà profile đang đứng danh tính, ghi rõ danh tính trước khi đăng.
- **Bình luận đầu tiên:** bình luận link hoặc số điện thoại sau khi bài lên; bài còn chờ duyệt thì không bình luận mà báo cho người dùng.
- **Tham gia nhóm và thu bình luận:** tìm và xin vào nhóm theo từ khóa; thu bình luận của các bài đã đăng; lịch sử và thống kê.

### Cách chạy

- **Nhiều profile song song.** Một lượt chọn N profile, mỗi profile chạy danh sách nhóm của nó cùng lúc, trong giới hạn số trình duyệt mở đồng thời của Browser Profiles (hiện 30).
- **Nội dung giống hệt nhau** giữa các profile trong một lượt.
- **Điều khiển trình duyệt qua cổng điều khiển cục bộ.** Khi chạy việc, MaiHub mở profile với cổng remote-debugging chỉ nghe trên `127.0.0.1`, rồi Playwright nối vào. Cách này tái dùng gần nguyên logic đã kiểm chứng của FB Poster (tìm phần tử theo chữ hiển thị, bằng chứng đăng thành công, chống bấm nút Đăng đang tắt).

### Nơi thao tác

- **Màn hình riêng** trên Sidebar để chạy tay: soạn bài, chọn profile, chọn nhóm, xem tiến độ và nhật ký từng profile.
- **Bước trong workflow** để tự động hóa, kích hoạt theo **lịch** (`trigger.schedule`) và theo **sự kiện** (`trigger.webhook` và các trigger sẵn có).

### Đợt triển khai

| Đợt | Nội dung | Người dùng |
|---|---|---|
| 1 | Đăng Group, đăng Page, bình luận đầu tiên, tham gia nhóm, thu bình luận, lịch sử; màn hình riêng; nhiều profile song song | Boss/Standalone |
| 2 | Bước workflow theo lịch và sự kiện; nhân viên dùng theo quyền module, đăng trên profile được gán | Boss và Employee, sau khi Browser Profiles xong đợt chia sẻ cho nhân viên |

### Tiêu chí nghiệm thu

1. Một lượt đăng trên ít nhất hai profile song song: mỗi bài lên đúng nhóm, đúng tài khoản, đi qua proxy của profile đó.
2. Đăng Page lên đúng Page mà profile đang đứng danh tính.
3. Bình luận đầu tiên lên đúng bài; bài chờ duyệt thì không bình luận và người dùng được báo.
4. Thu được bình luận của các bài đã đăng; lịch sử ghi đúng kết quả từng nhóm.
5. Mở profile để đăng không làm tăng tỉ lệ checkpoint so với mở profile để dùng tay (xem câu hỏi mở 1).
6. Không tính năng hiện có nào của MaiHub thay đổi hành vi, kể cả mở Browser Profiles để dùng tay.

## Affected users and systems

### Người dùng

- **Boss/Standalone:** người dùng chính của đợt 1.
- **Employee:** từ đợt 2, đăng trên profile được gán, theo quyền module mới.
- **Người đang dùng FB Poster:** chuyển sang MaiHub; lịch sử cũ không chuyển.

### Hệ thống trong MaiHub

| Thành phần | Ảnh hưởng |
|---|---|
| Browser Profiles (`src/services/browser/BrowserProfileService.ts`, `fingerprint.ts`) | Thêm chế độ mở có cổng điều khiển cục bộ; biết profile nào đang bị một việc tự động chiếm |
| Dịch vụ đăng bài mới (`src/services/`, `electron/ipc/`) | Chuyển logic FB Poster từ JavaScript sang TypeScript theo cấu trúc dịch vụ và IPC của MaiHub |
| SQLite (`src/services/database/DatabaseService.ts`) | Bảng lịch sử đăng bài và bình luận thu được, thay cho tệp `jsonl` của FB Poster |
| Renderer (`src/ui/`) | Màn hình đăng bài mới, mục mới trên Sidebar, theo `DESIGN.md` |
| Quyền module (`src/models/employee.ts`, `ALL_MODULES`) | Thêm module đăng bài (đợt 2) |
| Workflow engine (`src/services/workflow/WorkflowEngineService.ts`) | Thêm bước đăng bài (đợt 2) |
| Kho proxy | Dùng qua profile, không đổi |
| Facebook tầng giao thức (`src/services/facebook/`) | Không đụng: Messenger, quét nhóm, quét bình luận giữ nguyên |
| Đóng gói (`package.json`) | Thêm phụ thuộc điều khiển trình duyệt (dự kiến `playwright-core`, không kèm trình duyệt của Playwright) |

### Hệ thống bên ngoài

- Facebook: giao diện web đổi thường xuyên; công cụ phải nhận được cả giao diện tiếng Việt và tiếng Anh.
- Nhân trình duyệt `fingerprint-chromium` mà Browser Profiles đang dùng.
- Kho `maiychrus25/tools-facebook`: ngừng phát triển sau khi tính năng chạy ổn.

## Constraints

- **Đảo một quyết định của Browser Profiles.** Spec Browser Profiles ghi "không mở cổng remote-debugging, không cài extension". Tính năng này cần mở cổng đó, chỉ trên `127.0.0.1`, chỉ trong lúc chạy việc. Cần cập nhật spec Browser Profiles cho khớp.
- **Không được lộ dấu hiệu tự động hóa hơn mức đang có.** Cổng điều khiển và các lệnh Playwright gửi qua nó có thể bị trang phát hiện. Phải đo trước khi chốt (câu hỏi mở 1).
- **Trình duyệt có giao diện.** FB Poster luôn chạy có giao diện; Browser Profiles cũng vậy. Không chuyển sang chạy ẩn.
- **Một profile một việc.** Profile đang được người dùng mở tay hoặc đang chạy việc khác thì không được nhận việc mới, để không giành phiên đăng nhập.
- **Đóng tử tế.** Profile phải đóng đúng cách sau khi chạy để cookie được ghi, như Browser Profiles đã làm (SIGINT, rồi mới giết cứng).
- **Tìm phần tử theo chữ hiển thị**, không theo class sinh tự động; giữ quy tắc "chỉ tin bằng chứng dương" của FB Poster.
- **Không đăng thật khi kiểm thử** nếu chưa được phép; thử khô dừng trước khi bấm Đăng.
- **Lịch sử bắt đầu mới** trong SQLite của workspace, không nhập dữ liệu cũ.
- **Quy tắc dự án (`AGENTS.md`):** identifier bằng tiếng Anh (mã FB Poster đang dùng tên tiếng Việt, phải đổi khi chuyển sang), thay đổi nhỏ nhất an toàn, tái dùng pattern có sẵn, không regress, làm ở dev trước, production chỉ chạy artifact đã build.
- **Chính sách nền tảng:** đăng cùng một nội dung bằng nhiều tài khoản cùng lúc dễ bị Facebook coi là spam và khóa tài khoản.

## Open questions

1. **Cổng điều khiển có làm profile dễ bị phát hiện không?** Cần một spike: mở profile có và không có cổng, nối Playwright, chạy các trang kiểm tra (CreepJS, pixelscan, browserleaks) và so sánh. Nếu bị lộ rõ, phương án thay thế là extension trong profile, đổi lại phải viết lại phần tự động hóa.
2. **Playwright có điều khiển được `fingerprint-chromium` không?** Nhân trình duyệt đang ở Chromium 148, còn Playwright mới nhất nhắm Chromium 151. Cần đo `connectOverCDP` chạy ổn với phiên bản đó, gồm tải tệp ảnh/video vào ô soạn bài.
3. **Mở profile chạy việc khác gì mở tay?** Dùng chung cửa sổ người dùng đang nhìn thấy, hay mở riêng? Người dùng có được thao tác vào trình duyệt trong lúc việc đang chạy không?
4. **Giới hạn song song cho đăng bài** là bao nhiêu trên một máy thường? Giới hạn 30 của Browser Profiles tính cho dùng tay, đăng bài tốn tài nguyên hơn.
5. **Nghỉ giữa các profile:** các profile chạy song song có cần lệch giờ nhau để Facebook không thấy nhiều tài khoản cùng đăng một nội dung trong một phút không?
6. **Liên kết profile với nhóm:** danh sách nhóm lưu theo từng profile (quét từ chính tài khoản đó), hay một danh sách chung cho cả lượt?
7. **Quan hệ với Facebook tầng giao thức:** MaiHub đã quét được thành viên nhóm, bình luận và cảm xúc qua GraphQL. Thu bình luận của bài đã đăng nên dùng lại dịch vụ đó hay giữ cách đọc trang của FB Poster?
8. **Lấy link bài trên Page:** FB Poster hiện không lấy được link bài khi đăng Page, nên bình luận đầu tiên trên Page không tự chạy. Có giải quyết trong đợt 1 không?
9. **Đợt 2, mô hình quyền:** quyền đăng bài dùng mô hình module nhân viên hay mô hình vai trò ERP, khi hai mô hình này chưa thống nhất?
10. **Thời điểm ngừng FB Poster:** cần chạy song song bao lâu, và ai xác nhận MaiHub đã thay thế được?
