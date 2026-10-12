# Intent: Hủy việc Đăng Facebook dừng ngay, chỉ tắt sandbox khi máy bắt buộc, tài liệu khớp code
Author: Maiychrus. Status: approved.

Khảo sát trên mã nguồn bản 26.16.0 (commit `e347b8b`), ngày 12/10/2026.

## Problem

Ba vấn đề độc lập, phát hiện khi đọc lại toàn bộ dự án sau 163 commit (26.8.6 → 26.16.0).

### 1. Bấm Hủy không dừng việc Đăng Facebook đang nghỉ giữa hai đích

- Nút Hủy (`src/ui/features/facebookPoster/RunPanel.tsx`) gọi `facebookPoster:cancel`, nhưng `FacebookPosterService.cancel()` chỉ đặt cờ `stopping` (`src/services/facebookPoster/FacebookPosterService.ts:120-122`). Việc chỉ dừng khi code tự kiểm tra cờ đó.
- Khoảng nghỉ giữa hai đích trong việc đăng bài là một lệnh chờ duy nhất, không kiểm tra cờ: `await delayRandom(secs * 1000, secs * 1000)` (`src/services/facebookPoster/postToTargets.ts:825`). Khoảng nghỉ mặc định 300–900 giây, người dùng được đặt tối đa 86400 giây (`validateStartParams.ts:14`). Bấm Hủy lúc đang nghỉ thì việc vẫn treo đến hết khoảng nghỉ: trình duyệt của profile vẫn mở, bảng Tiến độ vẫn báo đang chạy, không bắt đầu được việc khác (mỗi lúc chỉ một việc).
- Các việc khác đã dừng được giữa chừng: tham gia nhóm và thu bình luận dùng `sleepStoppable`; chờ bình luận đầu "sau X phút" kiểm tra cờ mỗi giây (`postToTargets.ts:686-699`); gõ nội dung kiểm tra cờ từng ký tự. Riêng khoảng nghỉ giữa các đích của việc đăng bài thì không.
- **Chuyển workspace:** app chỉ chờ việc dừng tối đa 10 giây (`cancelAndWaitFacebookPosterJobs`, `electron/ipc/facebookPosterIpc.ts:88-102`), quá thì vẫn đóng trình duyệt và đổi DB dù việc còn chạy. Việc lúc đó có thể ghi kết quả sau khi DB đã đổi (**cần xác nhận** việc đó ghi vào DB nào hay mất).
- **Thoát app:** `cancelFacebookPosterJobs()` trong `before-quit` (`electron/main.ts`) chỉ đặt cờ, không chờ; trình duyệt bị đóng ngay sau đó.
- **Cập nhật app:** nút "Khởi động lại để cập nhật" bị từ chối khi có việc Đăng Facebook (`updateIpc.ts`), nên một việc đang nghỉ dài mà không hủy được thì cũng chặn cập nhật.

### 2. Cờ `--no-sandbox` bật cho mọi trình duyệt profile trên Linux

- Commit `0320d35` (10/10/2026) thêm `--no-sandbox` cho **mọi** profile trên Linux, cả mở tay lẫn mở cho tự động hóa (`src/services/browser/BrowserProfileService.ts:151`, `:195`; `src/services/browser/fingerprint.ts:74`). Lý do: trên một máy Linux khác (không phải máy dev), Chromium dừng ngay với `FATAL: No usable sandbox` vì AppArmor chặn unprivileged user namespaces (Ubuntu 23.10+), nên profile không mở được.
- Máy dev (Ubuntu 26.04) có `/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 0` và `unprivileged_userns_clone = 1`, tức **không chặn**; sandbox chạy được nhưng vẫn bị tắt.
- Nhân trình duyệt `fingerprint-chromium` đã cài không kèm `chrome-sandbox` (bộ sandbox setuid), nên sandbox chỉ chạy khi hệ điều hành cho phép user namespaces.
- **Trình duyệt Business Suite của Hộp thư Page** (`src/services/facebook/pagePlaywrightDriver.ts:304-309`) khởi chạy bằng `chromium.launchPersistentContext` với tham số mặc định của Playwright. Theo tài liệu Playwright, `chromiumSandbox` mặc định là `false`, nghĩa là Chromium chạy `--no-sandbox` trên **mọi** hệ điều hành, kể cả Windows (**cần xác nhận** bằng cách đọc tham số dòng lệnh của tiến trình khi chạy). Đường mở profile cho Poster không bị vì dùng `ignoreDefaultArgs: true` (`src/services/browser/automationLauncher.ts`).
- Hậu quả: profile duyệt web tùy ý khi đang đăng nhập tài khoản thật. Sandbox là lớp chặn để một lỗ hổng trong trình duyệt không chạm được tới tài khoản hệ điều hành, cookie của các profile khác và DB của MaiHub. Tắt sandbox không có lý do trên máy không cần là mở rộng bề mặt tấn công không cần thiết.

### 3. Tài liệu lệch so với code

Lệch đã xác nhận bằng cách đối chiếu mã nguồn:

- `SYSTEM_DOCUMENTATION.md`:
  - Ghi khảo sát bản `26.10.0`; mục 4.11 "Hộp thư Page Facebook (đang thiết kế)" ghi "chưa có mã trong sản phẩm", trong khi Page inbox đã phát hành từ 26.12.0 (nhận/gửi qua Business Suite, sticker 26.13.0). Có hai mục cùng số 4.11.
  - Thiếu bản nháp/duyệt, giao diện Postiz, bình luận đầu sau X phút (26.16.0), AI tạo ảnh còn ở backend.
  - Dòng 331 "thư mục `MaiHub` cũ được đổi tên thành `MaiHub`" (lỗi thay chữ hàng loạt; code đổi `AHV Connect` → `MaiHub`); dòng 332 và TD-14 ghi "không tự chuyển, copy tay" trái với code tự đổi tên thư mục (`src/services/app/legacyDataMigration.ts`).
- `NOTICE.md:36-49` còn mô tả việc chuyển dữ liệu kiểu cũ (không tự chuyển).
- `DESIGN.md` ghi "Bỏ AI theo brief" và "chưa có draft DB" trong khi đã có bản nháp; hành vi kéo-thả lịch lặp mô tả khác code (code không cho kéo lịch lặp).
- Spec:
  - `docs/specs/2026-10-03-facebook-poster.md:241` ghi tổng đích tối đa 500; code là 10000 (`validateStartParams.ts:13`, hotfix `82a5085`). `pickMedia` mô tả `{ path | null }`, code trả `{ items }`.
  - `docs/specs/2026-10-03-auto-update.md` trạng thái "Đang triển khai" dù đã phát hành 26.11.0.
  - `docs/specs/2026-10-03-facebook-page-inbox.md` §11 (gửi qua REST) đã bị thay bởi `2026-10-05-facebook-page-send-business-suite.md` nhưng vẫn "Đã duyệt"; spec sticker mô tả cách xác nhận gửi và vùng sticker khác code.
  - Spec và plan AI (`2026-10-09-ai-facebook-content-assistant.md`) mô tả endpoint, kiểu trả về và mẫu poster khác code; giao diện AI đã bị gỡ ở 26.16.0.
- Comment trong code: `FacebookService.ts:25` ("gửi qua REST"), comment `sendPageAttachment` (cách xác nhận cũ), `handlePageMessageNotification` ("chỉ tin văn bản"), `schema.ts:8` (thiếu trạng thái `missed`), JSDoc lạc chỗ trên `fb:listPageStickers` trong `electron/ipc/facebookIpc.ts`.

Nguyên nhân: không có quy tắc bắt buộc cập nhật tài liệu cùng thay đổi hành vi, và không có kiểm tra tự động.

## Proposed outcome

Gộp vào bản tính năng kế tiếp (không ra bản vá riêng).

### 1. Hủy dừng trong vài giây, an toàn

- Bấm Hủy thì việc dừng trong vài giây ở **mọi** bước chờ: khoảng nghỉ giữa các đích, giãn cách khởi động giữa các profile, chờ bình luận đầu, các bước chờ khác trong đăng bài, quét nhóm, tham gia nhóm, thu bình luận.
- Nếu đã bấm nút Đăng của một đích thì chờ bằng chứng kết quả của bài đó (thời gian chờ hiện có, tối đa khoảng 30 giây) rồi mới dừng, để Lịch sử ghi đúng và không có bài "đã lên mà không ghi". Các đích còn lại ghi "Bỏ qua — Đã dừng"; run kết thúc trạng thái `cancelled`.
- Áp dụng như nhau cho việc chạy tay và lượt chạy từ lịch hẹn.
- **Chuyển workspace:** chờ việc dừng êm tối đa khoảng 30 giây; quá thời gian thì đóng cứng các trình duyệt của việc đó, chắc chắn việc đã dừng hẳn và kết quả đã ghi vào DB của workspace cũ, rồi mới đổi DB.
- **Thoát app:** cùng nguyên tắc, có giới hạn thời gian để không treo việc thoát.
- Có test tự động chứng minh: hủy trong lúc nghỉ dài dừng trong vài giây; hủy sau khi đã bấm Đăng vẫn ghi kết quả bài đó; chuyển workspace không đổi DB khi việc còn chạy.

### 2. Sandbox bật mặc định, chỉ tắt khi máy bắt buộc

- Mọi Chromium do MaiHub khởi chạy (profile mở tay, profile tự động hóa, trình duyệt Business Suite của Page) chạy **có sandbox** theo mặc định trên mọi hệ điều hành.
- Chỉ trên Linux, và chỉ khi máy thật sự chặn user namespaces, mới chạy `--no-sandbox`. App tự phát hiện điều này, không dựa vào persona của profile.
- Khi phải chạy không sandbox: màn hình Trình duyệt hiện dải cảnh báo rõ ràng "Máy đang chặn sandbox của trình duyệt; profile chạy không sandbox", kèm hướng dẫn cấu hình để bật lại (ví dụ cấu hình AppArmor cho nhân trình duyệt, cần quyền quản trị). Profile vẫn mở được như hiện nay.
- Máy dev hiện tại (không chặn) chạy có sandbox; máy Linux đã gặp lỗi `No usable sandbox` vẫn mở được profile.

### 3. Tài liệu khớp code và giữ khớp

- Cập nhật cho khớp bản phát hành tiếp theo: `SYSTEM_DOCUMENTATION.md` (phiên bản, Page inbox, bản nháp, Postiz, AI, chuyển dữ liệu MaiHub, số mục trùng), `NOTICE.md`, `DESIGN.md`, `README.md` nếu cần, các spec nêu trên (giới hạn, trạng thái, phần đã bị thay thế), comment cũ trong code.
- **Quy tắc trong `AGENTS.md`:** mọi thay đổi hành vi phải cập nhật `SYSTEM_DOCUMENTATION.md` và spec liên quan trong cùng commit; spec phải cập nhật trạng thái khi tính năng phát hành hoặc bị thay thế.
- **Kiểm tra tự động trong CI, chặn build khi lệch:** chỉ kiểm những điều máy kiểm chắc chắn được (không báo sai), ví dụ: phiên bản ghi trong `SYSTEM_DOCUMENTATION.md` khớp `package.json`; các hằng số giới hạn ghi trong tài liệu khớp hằng số trong code; đường dẫn file được tài liệu nhắc tới còn tồn tại.

## Affected users and systems

### Người dùng

- Boss/Standalone dùng Đăng Facebook (chạy tay và lịch hẹn): hành vi nút Hủy, chuyển workspace, thoát app.
- Người dùng Linux: profile chạy có sandbox khi máy cho phép; có cảnh báo khi máy chặn.
- Người dùng Hộp thư Page trên mọi hệ điều hành: trình duyệt Business Suite chạy có sandbox.
- Người phát triển và AI agent: quy tắc tài liệu và kiểm tra CI mới.

### Hệ thống trong MaiHub

| Thành phần | Ảnh hưởng |
|---|---|
| `src/services/facebookPoster/FacebookPosterService.ts`, `postToTargets.ts`, `humanize.ts`, `scanGroups.ts`, `joinGroups.ts`, `collectComments.ts`, `firstComment.ts` | Mọi bước chờ phải dừng được khi hủy |
| `src/services/facebookPoster/FacebookPosterScheduler.ts` | Hủy lượt chạy từ lịch; hàng chờ khi chuyển workspace/thoát |
| `electron/ipc/facebookPosterIpc.ts`, `electron/ipc/workspaceIpc.ts`, `electron/main.ts` | Chờ việc dừng hẳn, đóng cứng khi quá hạn, trước khi đổi DB hoặc thoát |
| `src/services/browser/BrowserProfileService.ts`, `fingerprint.ts`, `automationLauncher.ts` | Phát hiện máy chặn sandbox; chỉ thêm `--no-sandbox` khi cần |
| `src/services/facebook/pagePlaywrightDriver.ts` | Bật sandbox cho trình duyệt Business Suite |
| `src/ui/features/browser/BrowserProfilesView.tsx` (và IPC liên quan) | Dải cảnh báo sandbox |
| `src/ui/features/facebookPoster/RunPanel.tsx` | Phản hồi trạng thái khi đang dừng |
| `SYSTEM_DOCUMENTATION.md`, `NOTICE.md`, `DESIGN.md`, `README.md`, `docs/specs/*`, `AGENTS.md` | Cập nhật nội dung và quy tắc |
| `.github/workflows/build.yml`, script kiểm tra mới trong `scripts/` | Bước kiểm tra tài liệu chặn build |

### Hệ thống bên ngoài

- Facebook (không đổi cách tương tác; chỉ đổi thời điểm dừng).
- Linux: AppArmor/user namespaces của từng bản phân phối.
- Playwright `playwright-core` 1.62.1 (tùy chọn sandbox).
- GitHub Actions.

## Constraints

- Theo `AGENTS.md`: làm ở dev trước; không hồi quy chức năng đang chạy; identifier tiếng Anh, chữ hiển thị tiếng Việt; không thêm dependency mới; thay đổi nhỏ nhất an toàn; không push/deploy khi chưa được duyệt.
- Không đăng bài, bình luận hay xin vào nhóm thật trong lúc phát triển và test tự động; kiểm tra bằng tài khoản thật chỉ khi chủ sản phẩm cho phép rõ ràng.
- Giữ nguyên các luật đã có của Poster: một việc tại một thời điểm, bằng chứng dương, click tin cậy, không đăng bù lượt lỡ.
- Không được để việc hủy tạo ra bài "đã đăng nhưng không ghi Lịch sử".
- Profile phải vẫn mở được trên máy Linux chặn user namespaces (không quay lại lỗi `No usable sandbox`).
- Kiểm tra tài liệu trong CI phải xác định (deterministic), không báo sai; chỉ kiểm điều kiểm được bằng máy.
- Máy dev ít RAM: test chạy `--runInBand`. Máy dev hiện thiếu `playwright-core` trong `node_modules` (cần `npm ci` + `npm run rebuild:native`).
- Không có máy Windows và macOS để kiểm chứng trong lúc phát triển.
- Phát hành gộp vào bản tính năng kế tiếp.

## Open questions

1. **Cách phát hiện máy chặn sandbox:** đọc `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` và `unprivileged_userns_clone`, hay thử khởi chạy nhân trình duyệt một lần và đọc lỗi `No usable sandbox`? Có cần xét SELinux, Flatpak, các bản phân phối không phải Ubuntu? Kết quả lưu một lần hay kiểm mỗi lần mở app?
2. **Hướng dẫn khắc phục** cụ thể cho máy chặn: tạo profile AppArmor cho đường dẫn nhân trình duyệt (`<userData>/browser-engine/...`) hay đổi sysctl? Đường dẫn nhân thay đổi theo phiên bản.
3. **Thời gian chờ cụ thể:** chờ dừng êm khi chuyển workspace (đề xuất khoảng 30 giây) và khi thoát app; thời gian tối đa chờ bằng chứng sau khi bấm Đăng.
4. **Ghi kết quả khi đóng cứng:** đích đang dở lúc đóng cứng ghi `failed` hay một trạng thái riêng ("không rõ, kiểm tra trên Facebook")?
5. **Lượt chạy từ lịch khi bị hủy:** các lượt khác đang xếp hàng có tiếp tục không? Lịch lặp có giữ lượt kế tiếp như bình thường không?
6. **Bật sandbox cho trình duyệt Business Suite** có làm hỏng phiên đăng nhập Business Suite đã lưu của các Page hiện có không? Cần thử trên Linux và Windows.
7. **Tài liệu lịch sử:** spec/plan cũ sửa thẳng nội dung, hay giữ nguyên và thêm mục "Cập nhật sau phát hành" ở đầu? (Intent đổi thương hiệu từng đặt ràng buộc không sửa tài liệu lịch sử.)
8. **Danh sách kiểm tra CI cụ thể:** những hằng số nào và tài liệu nào được kiểm; cách khai báo để script đọc chắc chắn mà không báo sai.
9. Trên Windows và macOS chưa có máy để kiểm hành vi hủy và sandbox; ai kiểm và khi nào?
