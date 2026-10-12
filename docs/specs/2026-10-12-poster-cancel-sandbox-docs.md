# Thiết kế: Hủy việc Đăng Facebook dừng ngay, sandbox chỉ tắt khi máy bắt buộc, tài liệu khớp code

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 12/10/2026 |
| Trạng thái | Đã duyệt (12/10/2026) |
| Intent | `docs/intent/2026-10-12-poster-cancel-sandbox-docs.md` (đã duyệt) |
| Mã nguồn khảo sát | 26.16.0, commit `e347b8b` |
| Kế hoạch | `docs/plans/2026-10-12-poster-cancel-sandbox-docs.md` |
| Phát hành | Gộp vào bản tính năng kế tiếp |

## 1. Mục tiêu

1. Bấm **Hủy** thì việc Đăng Facebook dừng trong vài giây ở mọi bước, không để lại bài "đã lên mà không ghi Lịch sử".
2. Chuyển workspace không bao giờ để việc cũ ghi kết quả sang DB của workspace mới.
3. Mọi Chromium do MaiHub khởi chạy chạy **có sandbox**, trừ Linux đang chặn user namespaces; khi đó báo người dùng kèm cách khắc phục.
4. Tài liệu khớp code bản phát hành, và CI chặn build khi những điều máy kiểm được bị lệch.

## 2. Ngoài phạm vi

- Gõ nội dung theo cụm thay vì từng ký tự (đề xuất riêng, chưa có intent).
- Đổi cách hủy cho các tính năng khác ngoài Đăng Facebook.
- Sandbox của chính cửa sổ Electron (`sandbox: false` trong `electron/main.ts`).
- Viết lại nội dung các spec/plan/intent cũ (xem mục 5.2).
- Kiểm chứng trên Windows và macOS (chưa có máy; ghi checklist cho chủ sản phẩm).

## 3. Hủy việc Đăng Facebook

### 3.1 Hiện trạng đo được

| Bước | Có dừng khi hủy? | Nguồn |
|---|---|---|
| Giãn cách khởi động giữa profile | Có (`defaultSleep` cắt lát 500 ms) | `FacebookPosterService.ts:54-61` |
| Gõ nội dung | Có, kiểm từng ký tự | `postToTargets.ts:541-545` |
| Chờ bình luận đầu "sau X phút" | Có, kiểm mỗi giây | `postToTargets.ts:686-699` |
| **Nghỉ giữa hai đích (đăng bài)** | **Không** — một `delayRandom` 300–900 s mặc định, tối đa 86400 s | `postToTargets.ts:825` |
| **Quét nhóm (cuộn tối đa 200 × 2,5 s)** | **Không** — `scanGroups.ts` không kiểm cờ dừng | `scanGroups.ts:77-144` |
| Tham gia nhóm, thu bình luận | Có (`sleepStoppable`) | `joinGroups.ts:186`, `collectComments.ts:176` |
| Chờ trang (`goto` 45 s, `waitFor*` 20–30 s) | Không dừng bằng cờ; hết hạn mới thoát | `postToTargets.ts:416-650` |

Hệ quả phụ:

- `FacebookPosterStore` ghi qua `DatabaseService` dùng chung, tức ghi vào **DB đang active lúc ghi** (`facebookPosterIpc.ts:42-56`). Chuyển workspace chỉ chờ 10 giây (`cancelAndWaitFacebookPosterJobs`), quá thì vẫn đổi DB: kết quả muộn của việc cũ **ghi sang DB của workspace mới**.
- Thoát app: `before-quit` gọi `cancelFacebookPosterJobs()` rồi đóng DB ngay; việc dở không ghi được kết quả, run còn `running` và được đổi thành `failed` "App đóng khi việc đang chạy" ở lần mở sau (`FacebookPosterStore.ts:23`, `122-131`).

### 3.2 Thiết kế: dừng bằng đóng phiên, trừ đoạn không thể quay lại

**Đoạn không thể quay lại** (critical section) là khoảng từ lúc thực hiện một thao tác không hoàn tác được tới lúc đọc xong bằng chứng kết quả của nó:

| Đoạn | Bắt đầu | Kết thúc | Thời gian tối đa hiện có |
|---|---|---|---|
| Đăng bài (gồm bình luận đầu nếu có) | Ngay trước click Đăng (`postToTargets.ts:~603`, sau lần kiểm cờ dừng cuối) | Hết đích đó: `leaveCritical` ở `finally` sau khi kết quả đã được báo (`postToTargets.ts:~827`), nên bao cả bắt link bài và bình luận đầu | ~40 s cho phần đăng (click 10 s + chờ đóng/rời trang 30 s) + ~10 s gửi bình luận; chờ "sau X phút" thoát trong 1 s khi Hủy |
| Xin vào nhóm | Ngay trước click Tham gia (`joinGroups.ts:~308`, sau lần kiểm cờ dừng cuối) | Đọc xong kết quả, `leaveCritical` ở `finally` (`joinGroups.ts:~357`; tối đa `joinWaitMs` 20 s) | ~30 s |

(sửa theo plan, 12/10/2026: bình luận đầu nằm trong đoạn của bài, không có đoạn riêng trong `firstComment.ts`; chỉ có hai đoạn.)

Hành vi khi hủy:

1. `FacebookPosterService.cancel()` đặt `stopping = true` như hiện nay, **và** với mỗi profile đang chạy:
   - nếu profile **không** ở đoạn không thể quay lại → đóng ngay mọi phiên trình duyệt của profile đó (`session.close()`). Mọi thao tác Playwright đang chờ của profile đó lỗi ngay, nên profile dừng trong vài giây bất kể đang chờ trang hay đang nghỉ;
   - nếu profile **đang** ở đoạn không thể quay lại → không đóng; khi đoạn kết thúc, profile tự đóng phiên của mình (kiểm `stopping` ngay sau đoạn).
2. Mọi khoảng nghỉ dùng một hàm ngủ dừng được (cắt lát ≤ 500 ms, kiểm `stopping`) truyền qua `TaskDeps`, thay cho `delayRandom` dài và `setTimeout` trơn ở `postToTargets.ts:825`, `scanGroups.ts` (`settleMs`, `scrollWaitMs`). `scanGroups` kiểm `stopping` mỗi vòng cuộn. Các `delayRandom` ngắn (≤ 3 s) giữ nguyên.
3. `TaskDeps` thêm `enterCritical(): void` và `leaveCritical(): void`. Các module việc gọi chúng quanh đúng hai đoạn ở bảng trên (đăng bài và xin vào nhóm) (`try/finally`, để lỗi giữa đoạn vẫn rời đoạn).

**Ghi kết quả khi hủy:**

| Tình huống | Kết quả ghi |
|---|---|
| Đích đang làm bị dừng **trước** click Đăng (phiên bị đóng) | `skipped`, lỗi "Đã dừng" (không phải `failed`: chưa có gì không hoàn tác) |
| Đích đang ở đoạn không thể quay lại khi hủy | Kết quả thật của bài đó (`posted`/`failed` theo bằng chứng), rồi dừng |
| Các đích chưa làm | `skipped`, "Đã dừng" (như hiện nay) |
| Run | `cancelled` |

Việc phân biệt "lỗi do phiên bị đóng vì hủy" với lỗi thật: trong `runProfile`, lỗi xảy ra khi `stopping === true` **và** profile không ở đoạn không thể quay lại được ghi `skipped` "Đã dừng", không phải `failed`.

**Lượt chạy từ lịch:** hủy chỉ dừng lượt đang chạy (như chạy tay). Các lượt khác đang xếp hàng vẫn chạy sau đó; lịch lặp vẫn giữ lượt kế tiếp. Không đổi hành vi scheduler.

### 3.3 Chuyển workspace

`cancelAndWaitFacebookPosterJobs` đổi thành ba bước, tổng tối đa khoảng 55 giây:

1. `cancel()` (mục 3.2) rồi chờ việc kết thúc tối đa **45 giây** (đủ cho đoạn không thể quay lại dài nhất ~40 s).
2. Quá hạn: **đóng cứng** — `closeAllBrowserProfiles()` đóng mọi phiên, kể cả profile đang ở đoạn không thể quay lại, rồi chờ thêm tối đa **10 giây**. Đích đang ở đoạn đó ghi `failed` với lỗi "Đã đóng khi đang chờ kết quả — kiểm tra bài trên Facebook" (việc Tham gia nhóm: "… kiểm tra yêu cầu vào nhóm trên Facebook") (sửa sau review cuối, 12/10/2026).
3. Nếu sau đó việc vẫn chưa kết thúc (không mong đợi): **không đổi workspace**, trả lỗi "Việc Đăng Facebook chưa dừng được. Thử lại sau." Đảm bảo tuyệt đối không ghi sang DB mới.

Áp dụng cho cả hai đường đổi DB trong `electron/ipc/workspaceIpc.ts` (`workspace:switch` và xóa workspace đang active). Xóa workspace chỉ dừng việc sau khi `WorkspaceManager.canDeleteWorkspace` chấp nhận (xóa bị từ chối thì việc chạy tiếp), scheduler luôn chạy lại trong `finally`, và cờ `switchInProgress` từ chối lần chuyển/xóa-đang-hoạt động chồng lên với "Đang chuyển workspace, thử lại sau." (sửa sau review cuối, 12/10/2026). Trong lúc chờ, giao diện nhận sự kiện để hiện "Đang dừng việc Đăng Facebook…" (toast hiện có).

### 3.4 Thoát app

Giữ luồng `before-quit` đồng bộ như hiện nay, **không thêm thời gian chờ**:

- `cancelFacebookPosterJobs()` giờ đóng ngay phiên của mọi profile không ở đoạn không thể quay lại (mục 3.2), nên trình duyệt tắt cùng app thay vì chạy tới hết khoảng nghỉ.
- Thông báo cho run bị dở ở lần mở sau đổi thành "App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook."

Lý do không chờ: `before-quit` còn được gọi khi cài bản cập nhật và có bộ đếm ép thoát 5 giây ở `window:quit` (`electron/main.ts:492-501`); chuyển sang bất đồng bộ là thay đổi luồng thoát rủi ro hồi quy cao hơn lợi ích. Việc cài cập nhật đã bị chặn khi có việc chạy.

## 4. Sandbox

### 4.1 Hiện trạng đo được (máy dev, Ubuntu 26.04, 12/10/2026)

- `/proc/sys/kernel/apparmor_restrict_unprivileged_userns = 0`, `unprivileged_userns_clone = 1`: máy **không chặn**.
- Chạy nhân `fingerprint-chromium 148.0.7778.215` **có** sandbox (`--headless=new --dump-dom about:blank`): thoát mã 0 sau ~1,1 s.
- Tiến trình renderer khi có sandbox ở user namespace riêng (`user:[4026532527]`, tiến trình chính `user:[4026531837]`); với `--no-sandbox` dùng chung namespace của tiến trình chính. Code hiện tại (`--no-sandbox` cho mọi profile Linux) **thật sự tắt sandbox** trên máy này.
- Nhân không kèm `chrome-sandbox` (setuid), nên sandbox chỉ có khi hệ điều hành cho phép user namespaces.
- Trình duyệt Business Suite của Page (`pagePlaywrightDriver.ts:304-309`) dùng tham số mặc định của Playwright; `chromiumSandbox` mặc định `false` ⇒ `--no-sandbox` trên mọi hệ điều hành (**sẽ đo lại** bằng tham số dòng lệnh tiến trình ở bước plan).
- Lỗi `FATAL: No usable sandbox` đã xảy ra trên một máy Linux khác (theo chủ sản phẩm).

### 4.2 Thiết kế

**Module mới `src/services/browser/sandboxSupport.ts`** (hàm thuần, tiêm phụ thuộc để test):

- `probeSandbox(enginePath, deps): Promise<'enabled' | 'disabled'>` (`deps.platform` thay tham số `platform`; lớp `SandboxSupport` giữ cache)
  - `deps.platform !== 'linux'` → `'enabled'`.
  - Linux → **chạy thử** nhân: `<engine> --headless=new --no-first-run --user-data-dir=<thư mục tạm> --dump-dom about:blank`, không có `--no-sandbox`, timeout 20 s.
    - Thoát mã 0 → `'enabled'`.
    - stderr chứa `No usable sandbox` → `'disabled'`.
    - Thoát lỗi khác (không phải quá hạn) → chạy lại một lần với `--no-sandbox` (thư mục tạm mới, xóa như lần đầu); mã 0 → `'disabled'` (sửa sau review cuối, 12/10/2026).
    - Còn lại (hai lần lỗi, quá hạn, hoặc chạy ném lỗi) → dự phòng theo cấu hình hệ thống: `apparmor_restrict_unprivileged_userns = 1`, hoặc `unprivileged_userns_clone = 0`, hoặc `user.max_user_namespaces = 0` → `'disabled'`; còn lại `'enabled'`.
  - Thư mục tạm nằm trên đĩa, cạnh tệp thực thi của nhân (`mkdtemp` tên `.sandbox-probe-*` trong thư mục chứa `chrome`, tức `<userData>/browser-engine/<phiên bản>/<bản dựng>/`), xóa ngay sau khi chạy (không dùng `/tmp`, là RAM trên máy dev).
  - Kết quả **lưu trong bộ nhớ theo `enginePath`** cho đến khi app tắt hoặc người dùng bấm "Kiểm tra lại".
- Chạy thử lần đầu khi cần mở profile (lazy) hoặc khi màn Trình duyệt hỏi trạng thái; các lần mở sau dùng kết quả đã lưu.

**Dùng kết quả:**

| Nơi khởi chạy | Thay đổi |
|---|---|
| `BrowserProfileService.open` và `openForAutomation` | `noSandbox: (await sandbox()) === 'disabled'` thay `this.platform === 'linux'` |
| `pagePlaywrightDriver.launchSender` | Thêm `chromiumSandbox: (await sandbox()) === 'enabled'` (Windows/macOS luôn `true`) |
| `buildLaunchArgs` | Không đổi (vẫn nhận `noSandbox`) |

**Báo người dùng:**

- Kênh mới `browserProfile:sandboxStatus({ recheck })` trả `{ sandbox: 'enabled' | 'disabled', apparmorPath }`, hoặc `{ sandbox: 'unknown' }` khi chưa cài nhân; `recheck: true` xóa kết quả đã lưu và chạy thử lại. `browserProfile:engineStatus` giữ nguyên, để danh sách profile không phải chờ lần chạy thử (sửa theo plan, 12/10/2026).
- Màn Trình duyệt (`BrowserProfilesView.tsx`), khi `sandbox === 'disabled'`: dải cảnh báo cùng kiểu dải "Cần tải nhân" hiện có:
  - "Máy đang chặn sandbox của trình duyệt (AppArmor/user namespaces). Profile vẫn mở được nhưng chạy không sandbox, kém an toàn hơn."
  - Hướng dẫn có nút sao chép (giống profile `/etc/apparmor.d/chrome` Ubuntu cấp sẵn). Đường dẫn gắn profile **không cố định** trong tài liệu: giao diện điền vị trí nhân thật trên máy, đặt trong dấu nháy kép, lấy từ `browserProfile:sandboxStatus().apparmorPath` (`<thư mục browser-engine>/*/*/<tên tệp thực thi>`, ký tự đại diện khớp mọi phiên bản nhân). Lý do: thư mục dữ liệu không phải lúc nào cũng là `~/.config/MaiHub` (bản dev hoặc bản cũ có thể dùng `AHV Connect`, và đường dẫn có thể chứa khoảng trắng). Mẫu lệnh, với `<ĐƯỜNG DẪN NHÂN>` do giao diện điền:

```bash
sudo tee /etc/apparmor.d/maihub-browser-engine >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile maihub-browser-engine "<ĐƯỜNG DẪN NHÂN>" flags=(unconfined) {
  userns,
  include if exists <local/maihub-browser-engine>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/maihub-browser-engine
```

  - Nút "Kiểm tra lại" gọi `sandboxStatus({ recheck: true })`; thành công thì dải cảnh báo biến mất. Profile đang mở giữ trạng thái cũ cho đến khi mở lại.
- Không có cảnh báo trên Windows/macOS.

## 5. Tài liệu

### 5.1 Nội dung cập nhật

| Tài liệu | Cập nhật |
|---|---|
| `SYSTEM_DOCUMENTATION.md` | Phiên bản khảo sát = `version` trong `package.json`; mục Hộp thư Page theo code (Business Suite, sticker, nhận qua MQTT tài khoản cha, giới hạn); sửa hai mục trùng số 4.11; thêm bản nháp/duyệt, giao diện Postiz, bình luận sau X phút, AI chỉ còn backend; mục 5.1 và TD-14 theo code chuyển dữ liệu `AHV Connect` → `MaiHub`; hủy và sandbox theo spec này; dấu kiểm hằng số (mục 5.3) |
| `NOTICE.md` | Bỏ mô tả chuyển dữ liệu kiểu cũ hoặc ghi rõ đó là chuyện Deplao → AHV Connect; nêu MaiHub tự chuyển |
| `DESIGN.md` | Bỏ "Bỏ AI theo brief"/"chưa có draft DB"; mô tả đúng: lịch lặp không kéo-thả được |
| `README.md` | Rà theo bản mới (Linux/macOS phải đăng nhập lại sau khi chuyển dữ liệu) |
| Comment trong code | `FacebookService.ts:25`, comment `sendPageAttachment`, `handlePageMessageNotification`, `schema.ts:8` (thêm `missed`), JSDoc lạc chỗ trong `electron/ipc/facebookIpc.ts` |
| `AGENTS.md` | Thêm quy tắc mục 5.4 |

### 5.2 Spec/plan/intent cũ: không viết lại nội dung

Giữ nguyên thân tài liệu (tôn trọng ràng buộc "không sửa tài liệu lịch sử" của intent đổi thương hiệu). Với mỗi spec lệch, chỉ:

1. Sửa dòng **Trạng thái** cho đúng (ví dụ "Đã phát hành 26.11.0", "Đã thay thế bởi `2026-10-05-…`").
2. Thêm ngay dưới bảng thuộc tính một mục **"Ghi chú sau phát hành (12/10/2026)"** liệt kê điểm code khác với tài liệu, kèm `file:dòng`.

Áp dụng cho: `2026-10-03-facebook-poster.md` (500 → 10000 đích; `pickMedia`), `2026-10-03-auto-update.md`, `2026-10-03-facebook-page-inbox.md` (§11 REST đã thay), `2026-10-05-facebook-page-send-business-suite.md` (factory/close, cách xác nhận), `2026-10-07-facebook-page-sticker.md` (xác nhận gửi, vùng sticker cố định), `2026-10-09-ai-facebook-content-assistant.md` (endpoint, kiểu trả về, giao diện đã gỡ).

### 5.3 Kiểm tra tự động trong CI (chặn build)

Script mới `scripts/check-docs.js` (Node thuần, không dependency), chạy ở job `verify` của `.github/workflows/build.yml` sau type-check; lỗi thì exit 1 và in từng điểm lệch. Chỉ ba loại kiểm tra, đều xác định:

1. **Phiên bản:** dòng "Phiên bản ứng dụng được khảo sát" trong `SYSTEM_DOCUMENTATION.md` phải chứa đúng `version` của `package.json`. Hệ quả: mỗi lần tăng version phải cập nhật tài liệu tổng thể trong cùng commit.
2. **Hằng số:** tài liệu đặt dấu ẩn cạnh câu nêu giới hạn, dạng `<!-- docs-check: src/services/facebookPoster/validateStartParams.ts#MAX_TARGETS = 10000 -->`. Script đọc file nguồn, tìm `const MAX_TARGETS = <biểu thức số>` (chỉ chữ số, khoảng trắng, `* + _`), tính giá trị và so với số trong dấu. Không tìm thấy hằng hoặc khác giá trị → lỗi. Bộ dấu ban đầu (ở `SYSTEM_DOCUMENTATION.md`): `MAX_TEXT`, `MAX_COMMENT`, `MAX_TARGETS`, `MAX_DELAY_SEC`, `MAX_STAGGER_SEC` (`validateStartParams.ts`); `MAX_IMAGES`, `MAX_IMAGE_BYTES`, `MAX_TOTAL_BYTES` (`mediaRules.ts`); `MAX_SCHEDULES` (`facebookPosterIpc.ts`); `MAX_RUNNING_PROFILES` (`BrowserProfileService.ts`); `GRACE_MS`, `QUEUE_MAX_WAIT_MS` (`FacebookPosterScheduler.ts`); `CHECK_INTERVAL_MS`, `FIRST_CHECK_DELAY_MS` (`updateIpc.ts`). Nếu hằng chưa được `export`, script vẫn đọc được vì đọc văn bản nguồn.
3. **Đường dẫn:** mọi đường dẫn đặt trong dấu backtick bắt đầu bằng `src/`, `electron/`, `scripts/`, `docs/`, `resources/`, `public/`, `.github/` trong `SYSTEM_DOCUMENTATION.md`, `README.md`, `DESIGN.md`, `AGENTS.md` phải tồn tại. Bỏ qua đường dẫn có `* < > { }` (mẫu). Không kiểm `NOTICE.md` (cố ý nêu file đã gỡ) và `docs/**` (tài liệu lịch sử). Đo ngày 12/10/2026: bốn tài liệu trên hiện có 0 đường dẫn hỏng.

Các hàm phân tích nằm trong `scripts/check-docs.js` và được export để test bằng jest (`src/__tests__/docs/checkDocs.test.ts`).

### 5.4 Quy tắc trong `AGENTS.md`

Thêm mục "Tài liệu đi cùng code":

- Thay đổi hành vi, giới hạn, IPC, schema hoặc luồng phát hành phải cập nhật `SYSTEM_DOCUMENTATION.md` (và dấu `docs-check` liên quan) trong **cùng commit**.
- Khi tính năng phát hành hoặc bị thay thế: cập nhật dòng Trạng thái của spec và thêm "Ghi chú sau phát hành" nếu code khác spec; không viết lại thân tài liệu lịch sử.
- Tăng `version` thì cập nhật dòng phiên bản trong `SYSTEM_DOCUMENTATION.md`.
- `node scripts/check-docs.js` phải sạch trước khi báo xong.

## 6. Kiểm thử

| Loại | Nội dung |
|---|---|
| Unit (jest, `--runInBand`) | `FacebookPosterService`: hủy lúc nghỉ dài dừng < 2 s (sleep giả); hủy trước click Đăng ghi `skipped` "Đã dừng" và đóng phiên; hủy trong đoạn không thể quay lại chờ hết đoạn rồi ghi kết quả thật; lỗi do phiên bị đóng khi đang dừng không thành `failed` |
| Unit | `postToTargets`: khoảng nghỉ giữa đích dùng sleep dừng được; `enterCritical/leaveCritical` bao đúng click Đăng → bằng chứng (kể cả khi lỗi) |
| Unit | `scanGroups`: dừng giữa vòng cuộn |
| Unit | `cancelAndWaitFacebookPosterJobs`: hết 45 s → đóng cứng → chờ 10 s → còn chạy thì trả lỗi, không gọi đổi DB (thời gian giả) |
| Unit | `sandboxSupport`: non-Linux; probe thoát 0; stderr `No usable sandbox`; lỗi khác + mỗi sysctl; cache theo `enginePath`; recheck xóa cache; xóa thư mục tạm |
| Unit | `checkDocs`: đọc phiên bản; tính biểu thức hằng; dấu sai giá trị/không tìm thấy hằng; đường dẫn mẫu bị bỏ qua |
| Tích hợp trên máy dev (Linux) | Mở profile tay và cho tự động: renderer ở user namespace riêng (đo như mục 4.1); trình duyệt Business Suite không có `--no-sandbox` trong tham số tiến trình |
| Tích hợp | Chạy việc đăng trên profile thử với nhóm giả/không đăng thật (dry-run): bấm Hủy trong lúc nghỉ → bảng Tiến độ "Đã hủy" trong vài giây, trình duyệt đóng |
| Thủ công (chủ sản phẩm) | Máy Linux đang chặn: profile mở được, có dải cảnh báo; làm theo hướng dẫn rồi "Kiểm tra lại" → dải biến mất. Windows: Page và profile mở có sandbox, hủy hoạt động |
| CI | `node scripts/check-docs.js` sạch |

## 7. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Đóng phiên lúc hủy để lại trạng thái nửa vời trên Facebook (ví dụ khung soạn đang mở) | Chỉ đóng ngoài đoạn không thể quay lại; khung soạn chưa đăng thì Facebook không lưu gì ngoài nháp của chính Facebook |
| Đoạn không thể quay lại khai báo thiếu → đóng phiên ngay sau click Đăng, bài lên mà không ghi | Test bắt buộc cho đúng hai đoạn; review tập trung vào vị trí `enterCritical` |
| Chạy thử sandbox chậm hoặc treo trên máy yếu | Timeout 20 s, chạy một lần mỗi phiên app, dự phòng theo sysctl |
| Bật sandbox cho Business Suite làm hỏng phiên đăng nhập Page đã lưu | Sandbox không đổi dữ liệu profile; đo trên Linux ở plan; Windows giao chủ sản phẩm kiểm |
| AppArmor profile mẫu sai cú pháp trên bản Ubuntu khác | Lấy theo `/etc/apparmor.d/chrome` của Ubuntu; ghi rõ là hướng dẫn, app không tự chạy `sudo` |
| CI chặn build vì quên cập nhật tài liệu khi tăng version | Là chủ đích; thông báo lỗi chỉ rõ dòng cần sửa |
| Chuyển workspace chờ tới ~55 s | Chỉ khi đang ở đoạn không thể quay lại; có thông báo "Đang dừng việc Đăng Facebook…" |

## 8. Quyết định đã chốt (12/10/2026)

1. Chuyển workspace: chờ 45 s → đóng cứng → chờ 10 s → còn chạy thì hủy việc chuyển (mục 3.3).
2. Thoát app: không chờ; hủy đóng phiên ngay và thông báo run dở ở lần mở sau (mục 3.4). Đây là điều chỉnh có chủ đích so với intent.
