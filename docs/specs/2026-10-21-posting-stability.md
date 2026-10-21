# Thiết kế: Đăng bài ổn định hơn (Đợt 1 tối ưu)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 21/10/2026 |
| Trạng thái | Đã duyệt 21/10/2026; đã cài đặt (chờ phát hành 26.28.0) |
| Intent | `docs/intent/2026-10-21-posting-stability.md` |
| Kế hoạch | `docs/plans/2026-10-21-posting-stability.md` |
| Phiên bản dự kiến | 26.28.0 |
| Dùng lại | `CHECKPOINT_PATHS` (`loginCheck.ts`), `LoginChecker.observe` (sự kiện `profile.loginProblem`), `failRemaining`, `RETRYABLE_POST_ERRORS`, `pickDelaySeconds` / `sleepStoppable`, `store.nextScheduledAt()` |

## 1. Phạm vi

| # | Việc | Nơi sửa chính |
|---|---|---|
| A | Phát hiện checkpoint / bị đá ra đăng nhập lúc mở và sau mỗi lần vào nhóm; dừng profile, ghi trạng thái, báo 🔒 | `postToTargets.ts`, `FacebookPosterService.ts`, `facebookPosterIpc.ts` |
| B | Ảnh chụp + ghi chú cho mỗi lần đăng lỗi, tự dọn | `postToTargets.ts`, `FacebookPosterService.ts`, `facebookPosterIpc.ts` |
| C | Trình duyệt chết thì dừng profile ngay; mở trình duyệt lỗi thoáng qua thì thử lại 1 lần | `postToTargets.ts`, `FacebookPosterService.ts` |
| D | Nghỉ ngắn sau lỗi khi chưa đăng được gì | `postToTargets.ts` |
| E | Việc phụ nhường khe khi sắp tới giờ đăng | `facebookPosterIpc.ts` |
| F | Lấy link bài: chờ theo điều kiện, tối đa 8 giây | `postToTargets.ts` |

Chỉ áp dụng cho lượt **đăng bài** (`kind = post`), trừ:
- **E** áp dụng cho các việc phụ (theo dõi bài, thu bình luận, kiểm tra đăng nhập);
- **A (lúc mở)** áp dụng mọi loại việc có dùng `launch`, vì kiểm tra chung ở `FacebookPosterService`.

Không làm trong đợt này:
- tách mã `composer_not_found` thành "chưa là thành viên / nhóm đóng". Cần xem ảnh chẩn đoán thật trước rồi mới làm;
- đổi `QUEUE_MAX_WAIT_MS` (2 giờ). Đây là chính sách, anh quyết riêng;
- giới hạn số bài mỗi profile và độ lệch giờ ngẫu nhiên (chính sách);
- gõ chữ nhanh hơn (đánh đổi với an toàn tài khoản);
- xem ảnh chẩn đoán qua Control API (để sau, khi biết ảnh có ích).

## 2. Mã lỗi

Thêm 2 mã vào `PostErrorCode`. Cả hai **không** thử lại (không nằm trong `RETRYABLE_POST_ERRORS`):

| Mã | Khi nào | Thông báo |
|---|---|---|
| `checkpoint` | Trang đang ở `/checkpoint`, `/two_step_verification` hoặc `/auth_platform` | "Facebook yêu cầu xác minh tài khoản (checkpoint). Mở profile để xác minh rồi đăng lại." |
| `browser_closed` | Trang hoặc trình duyệt đã đóng giữa lượt mà không phải do người dùng Huỷ | "Trình duyệt của profile đã đóng giữa chừng" |

- Bị chuyển sang `/login`, hoặc mất cookie `c_user` sau khi tải trang, thì dùng mã có sẵn `not_logged_in`.
- Tổng số mã: 13 → 15. Bot cũ bỏ qua mã lạ được (giao thức đã ghi "chỉ thêm").

## 3. A — Phát hiện checkpoint / đăng xuất

**Hàm thuần mới** trong `loginCheck.ts`:

```ts
export function loginProblemAt(url: string): 'checkpoint' | 'logged_out' | null
```

- Đường dẫn bắt đầu bằng một trong `CHECKPOINT_PATHS` → `'checkpoint'`.
- Đường dẫn bắt đầu bằng `/login` → `'logged_out'`.
- Còn lại, kể cả URL hỏng, → `null`.
- `classifyLogin` dùng lại hàm này (giữ nguyên kết quả cũ).

**Lỗi mới** trong `postToTargets.ts`:

```ts
export class LoginProblemError extends Error { constructor(readonly state: 'checkpoint' | 'logged_out', message: string) }
```

**Lúc mở**, trong `postToTargets` sau khi tải `FB_HOME`:
- `loginProblemAt(page.url())` khác `null` → ném `LoginProblemError`.
- Câu kiểm tra `isLoggedIn` hiện có (ném `Error` thường, nên hiện bị ghi thành `unknown`) đổi sang ném `LoginProblemError('logged_out', NOT_LOGGED_IN_ERROR)`.

**Sau mỗi lần vào nhóm**, trong `postToSingleTarget`, ngay sau `page.goto` thành công:
- `loginProblemAt(page.url())` khác `null` → trả `failed('checkpoint' | 'not_logged_in', …)`, kèm cờ `loginProblem: state`.
- Vòng lặp đích: khi kết quả có `loginProblem`, ghi kết quả của nhóm đó như mọi nhóm khác (`onResult`), **không** thử lại, rồi ném `LoginProblemError(state, error)` để dừng profile.

**`FacebookPosterService.runProfile`**, khi bắt được `LoginProblemError`:
- gọi `observeLogin(profileId, err.state)`, mở rộng kiểu thành `'ok' | 'logged_out' | 'checkpoint'` (đổi cả `onLoginObserved` trong deps; `LoginChecker.observe` đã nhận `checkpoint`);
- gọi `failRemaining(active, plan, err.message, true, err.state === 'checkpoint' ? 'checkpoint' : 'not_logged_in')`: **mọi** nhóm còn lại ghi `failed` với mã đó, không phải `skipped`.

Như vậy `profile.loginProblem` (source `run`) phát qua đường có sẵn, và Telegram báo 🔒.

Không tự bỏ qua profile đã biết là hỏng trước lượt: người dùng có thể vừa đăng nhập lại bằng tay. Lần tải `FB_HOME` đầu lượt sẽ tự phát hiện.

## 4. B — Ảnh chẩn đoán

**`TaskDeps`** thêm trường tuỳ chọn:

```ts
saveDiagnostic?: (page: Page, info: { targetUrl: string; attempt: number; errorCode: string }) => Promise<string | null>
```

Hàm trả về **tên tệp** (không kèm đường dẫn) hoặc `null`.

**Khi nào gọi:**
- `postToTargets` gọi sau **mỗi lần thử không thành công**, trừ `stopped`. Gồm cả `uncertain_after_submit`, `checkpoint`, `not_logged_in`, và trước khi `discardDraft`, để ảnh còn giữ đúng màn hình lúc lỗi.
- Trang đã đóng thì bỏ qua.
- Lỗi khi chụp không được làm hỏng lượt đăng: nuốt lỗi, ghi một dòng cảnh báo.

**`FacebookPosterService`** cài hàm này khi deps có `diagnosticsDir?: () => string | null`:
- **Thư mục:** `<diagnosticsDir>/<runId>/`.
- **Tên tệp:** `<8 ký tự đầu profileId>-<số thứ tự đích>-l<lần thử>.jpg`, kèm `.txt` cùng tên.
- **Ảnh:** `page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })`, chỉ vùng đang nhìn thấy.
- **Tệp `.txt`:** URL trang, tiêu đề trang, đích, mã lỗi, lần thử, thời điểm. **Không** ghi nội dung trang.
- **Nhật ký lượt:** thêm dòng `Đã lưu ảnh chẩn đoán: <tên tệp>`.

**`facebookPosterIpc.ts`:**
- `diagnosticsDir` = `<thư mục workspace>/fb-poster-diagnostics` (cạnh DB, giống `scheduleBaseDir()`).
- **Dọn khi bắt đầu mỗi lượt đăng** (hàm thuần `pruneDiagnostics(dir, now)`, lỗi chỉ ghi log):
  - xoá thư mục lượt cũ hơn `DIAGNOSTIC_RETENTION_MS` = 7 ngày;
  - nếu tổng số tệp còn vượt `DIAGNOSTIC_MAX_FILES` = 500 thì xoá các thư mục lượt cũ nhất cho tới khi đủ.

## 5. C — Trình duyệt chết, mở lại khi lỗi thoáng qua

**Trình duyệt chết.** Trong vòng lặp đích, sau một lần thử không thành công: nếu `page.isClosed()` và **không** đang Huỷ (`getIsStopping()` false) thì:
- ghi kết quả nhóm hiện tại với `browser_closed`;
- ném `BrowserClosedError` (lớp mới).

`runProfile` bắt lỗi này và gọi `failRemaining(…, true, 'browser_closed')`. Thứ tự kiểm tra hiện có giữ nguyên:
- đã qua cú bấm Đăng (`wasCritical`) thì vẫn ra `uncertain_after_submit`;
- đang Huỷ thì vẫn ra `stopped` / `cancelled`.

**Mở trình duyệt lỗi.** Trong `launch` của `runProfile`, nếu `openForAutomation` ném lỗi thì thử lại **đúng 1 lần** sau `LAUNCH_RETRY_DELAY_MS` = 10 giây (ngủ có kiểm Huỷ), chỉ khi:
- không đang Huỷ;
- lỗi **không** phải `Không tìm thấy profile`, `ENGINE_MISSING_ERROR`, hay lỗi bắt đầu bằng `PROFILE_OPEN_PREFIX` ("Profile đang mở").

Thử lại vẫn lỗi thì giữ hành vi cũ (`launch_failed` cho mọi đích).

## 6. D — Nghỉ ngắn sau lỗi khi chưa đăng được gì

Trong vòng lặp đích, khoảng nghỉ trước nhóm kế tiếp:
- **Mặc định:** như cũ, `pickDelaySeconds(minDelay, maxDelay)` trừ thời gian đã chờ để bình luận.
- **Khi nhóm vừa xong có `ok = false`, `afterSubmit = false` và mã khác `stopped`:**
  - khoảng nghỉ = `min(khoảng mặc định, pickDelaySeconds(SHORT_GAP_MIN_SEC, SHORT_GAP_MAX_SEC))`, với `SHORT_GAP_MIN_SEC` = 20 và `SHORT_GAP_MAX_SEC` = 60;
  - nhật ký ghi rõ: `Nghỉ ngắn <n> giây (chưa đăng được bài ở nhóm trước)`.

Sau bài đăng thành công hoặc bài "chưa chắc" (`uncertain_after_submit`), khoảng nghỉ giữ nguyên như hiện nay.

## 7. E — Việc phụ nhường khe

`facebookPosterIpc.ts` có hàm mới:

```ts
scheduleWantsSlot(now): boolean
```

Trả `true` khi hàng chờ của scheduler có lượt đang chờ (`scheduler.queuedIds().length > 0`), hoặc khi `store.nextScheduledAt()` khác `null` và `≤ now + SIDE_JOB_YIELD_MS` (10 phút).

`isBusy` truyền cho `PostTrackScheduler`, `CommentCollectScheduler` và `LoginCheckScheduler` thêm `|| scheduleWantsSlot(Date.now())`. Hệ quả:
- hai bộ tự chạy 15 phút một lần sẽ bỏ lượt đó và thử lại lần sau;
- kiểm tra đăng nhập buổi sáng đã có sẵn cơ chế "bận thì thử lại sau".

Lượt bấm tay và lượt do bot gọi **không** bị ảnh hưởng.

## 8. F — Lấy link bài theo điều kiện

Sau khi xác nhận đăng xong, giữ listener phản hồi thêm, chờ tới khi có `capturedId` hoặc hết `LINK_CAPTURE_MAX_WAIT_MS` = 8000 ms (kiểm mỗi 250 ms), rồi mới gỡ listener.
- Có link sớm thì đi tiếp ngay.
- Hết giờ thì dùng `findOwnPostUrl` như cũ.

Tức là bỏ câu chờ cố định 1,5–2,5 giây, và chuyển `page.off('response', …)` từ khối `finally` hiện tại xuống sau bước chờ. Mọi đường thoát vẫn phải gỡ listener.

## 9. Tương thích

- **Control API:** không đổi cấu trúc. `runs.get` có thể trả thêm 2 giá trị mới của `errorCode`.
- **Bridge:**
  - `watch` hiện đã liệt kê dòng lỗi theo đích, không phụ thuộc mã;
  - `GUIDE` §6 thêm một dòng: "checkpoint: báo người dùng xác minh tài khoản; browser_closed: thử lại sau".
- **CSV xuất lịch sử:** giữ nguyên cột. Cột `error_code` có thể có mã mới.
- **Giao diện:** không cần sửa. Lịch sử hiện thông báo lỗi dạng chữ; nhãn "Chưa chắc" chỉ gắn với `uncertain_after_submit`.

## 10. Kiểm thử

**Jest, theo kiểu của `postToTargets.test.ts` và `FacebookPosterService.test.ts`:**
- `loginProblemAt`: các đường dẫn checkpoint, `/login`, đường dẫn thường, URL hỏng.
- Lúc mở ở `/checkpoint` → mọi đích `failed` + `checkpoint`; `onLoginObserved('checkpoint')` gọi đúng 1 lần.
- Nhóm thứ 2 / 4 bị chuyển sang `/checkpoint`:
  - nhóm 1 giữ kết quả;
  - nhóm 2 `checkpoint`, không thử lại;
  - nhóm 3–4 `failed` + `checkpoint`.
- Bị chuyển sang `/login` giữa lượt → `not_logged_in` tương tự.
- Mất `c_user` lúc mở → `not_logged_in` (trước đây là `unknown`).
- `saveDiagnostic`:
  - gọi đúng số lần thử lỗi, kèm số lần thử và mã;
  - không gọi khi `stopped`, khi thành công, hay khi trang đã đóng;
  - lỗi chụp không làm hỏng lượt đăng;
  - gọi trước `discardDraft`.
- `pruneDiagnostics`: thư mục > 7 ngày bị xoá; vượt 500 tệp thì xoá cũ nhất trước.
- Trang đóng giữa lượt (không Huỷ) → `browser_closed` cho nhóm đó và các nhóm sau.
- Huỷ đóng trang → vẫn `stopped` / `cancelled` như cũ.
- Đóng sau cú bấm Đăng → vẫn `uncertain_after_submit`.
- Mở trình duyệt lỗi lần 1, được lần 2 → lượt chạy bình thường. Lỗi "Profile đang mở" → không thử lại.
- Nghỉ ngắn:
  - lỗi trước khi đăng → khoảng nghỉ ≤ 60 giây;
  - sau bài thành công và sau `uncertain_after_submit` → khoảng nghỉ theo `minDelay` / `maxDelay`;
  - khoảng của người dùng nhỏ hơn 20 giây → giữ khoảng của người dùng.
- `scheduleWantsSlot`: hàng chờ có lượt; lịch đến hạn trong 9 phút / 11 phút; không có lịch.
- Link: `capturedId` về ở giây thứ 5 → có link, không gọi `findOwnPostUrl`; không về → gọi `findOwnPostUrl` sau 8 giây; listener luôn được gỡ.
- Toàn bộ test hiện có phải đạt.

**Trình duyệt thật, không dùng Facebook:**
- Chạy `saveDiagnostic` (bản cài ở service) với Chromium của app trên một trang HTML cục bộ, kiểm ảnh JPEG và tệp `.txt` được tạo.
- Chạy `loginProblemAt` trên `page.url()` sau khi tải trang cục bộ có đường dẫn `/checkpoint/…`.

**Đo sau khi triển khai** (cần quyền đọc số liệu thật), trước và sau:
- tỷ lệ `composer_not_found` có `attempts = 3`;
- số `checkpoint` / `not_logged_in`;
- thời gian trung bình mỗi lượt;
- số lịch bị lỡ do "Chờ quá 2 giờ".

## 11. Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Đăng trùng do đổi luồng thử lại | Không đổi điều kiện thử lại. Mã mới đều không thử lại. Kiểm tra trang chết chỉ chạy sau lần thử **không** thành công. |
| Ảnh chụp chứa nội dung người khác trên Facebook | Chỉ lưu trên máy MaiHub, tự xoá sau 7 ngày, tối đa 500 tệp, không gửi qua API hay Telegram. |
| Nghỉ ngắn làm nhịp mở trang dày hơn | Chỉ áp khi chưa đăng được gì. Tối thiểu vẫn 20 giây giữa hai nhóm, cộng 10–30 giây giữa các lần thử lại. |
| Giữ listener lâu hơn 8 giây | Listener chỉ đọc phản hồi; luôn được gỡ ở mọi đường thoát (test riêng). |
| Facebook đổi đường dẫn checkpoint | Danh sách `CHECKPOINT_PATHS` dùng chung với kiểm tra đăng nhập, sửa một chỗ. Ảnh chẩn đoán giúp phát hiện đường dẫn mới. |

## Ghi chú sau cài đặt

- Kiểm tra checkpoint lúc mở nằm trong `postToTargets` nên chỉ áp cho lượt đăng bài; các loại việc khác (quét nhóm, tham gia, thu bình luận) giữ kiểm tra riêng của chúng. Thử mở lại trình duyệt (`openWithRetry`) thì áp mọi loại việc.
- `NOT_LOGGED_IN_ERROR` và `CHECKPOINT_MESSAGE` chuyển vào `loginState.ts` để dùng chung.
- Chụp ảnh chẩn đoán có chặn cứng 6 giây (`Promise.race`) ngoài `timeout` 5 giây của Playwright; tên tệp thay ký tự lạ trong mã profile bằng `_`.
- Khi bắt đầu lượt mà service trả BUSY, việc dọn ảnh vẫn đã chạy một lần (vô hại).
- Kiểm thật với Chromium trên trang HTML cục bộ: `loginProblemAt` nhận đúng `/checkpoint/…`, ảnh JPEG 1280×800 và tệp ghi chú được tạo, dọn thư mục > 7 ngày đúng.
- Sau Opus review: (F1) đăng được bài rồi mới gặp checkpoint thì không ghi đè trạng thái thành `ok` cuối lượt; (F2) `.jpg` ghi trước, tiêu đề trang đọc với hạn 1 giây; (F3) không chụp ảnh khi đang Huỷ; (F4) dọn ảnh chạy sau khi lượt bắt đầu thành công, giữ thư mục của lượt đó và thư mục mới nhất; (F5) nhận lỗi "Chưa cài trình duyệt" theo tiền tố; (F6) mỗi việc phụ chỉ nhường liên tục tối đa 60 phút (`makeYieldingBusy`), tránh bị bỏ đói khi lịch đăng dày. Review không tìm thấy đường nào có thể gây đăng trùng.
