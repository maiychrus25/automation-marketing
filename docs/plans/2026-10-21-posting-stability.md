# Đăng bài ổn định hơn (Đợt 1) — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lượt Đăng Facebook dừng đúng lúc khi profile hỏng, để lại bằng chứng khi lỗi, không phí thời gian sau lỗi chưa đăng, không bị việc phụ chen giờ, lấy link bài chắc hơn — không thêm nguy cơ đăng trùng.

**Architecture:**
- Logic đăng (`postToTargets.ts`) thêm kiểm tra URL sau mỗi lần tải trang, hai lớp lỗi dừng profile, nghỉ ngắn và chờ link theo điều kiện. Ảnh chẩn đoán được gọi qua một hàm tiêm vào `TaskDeps`.
- `FacebookPosterService` dịch hai lớp lỗi thành mã kết quả, ghi trạng thái đăng nhập, thử mở trình duyệt lại một lần, và cài hàm chụp ảnh.
- `facebookPosterIpc.ts` nối thư mục chẩn đoán, dọn tệp cũ và cho việc phụ nhường khe.

**Tech Stack:** Electron 41 + TypeScript + Jest (`node:assert` trong test hiện có), Playwright-core API (`Page`).

**Spec:** `docs/specs/2026-10-21-posting-stability.md` (đã duyệt 21/10/2026).

## Global Constraints

- Không đổi điều kiện thử lại: chỉ lỗi trước cú bấm Đăng mới được thử lại. Mã mới `checkpoint`, `browser_closed` **không** nằm trong `RETRYABLE_POST_ERRORS`.
- Không đổi khoảng nghỉ sau bài thành công hoặc `uncertain_after_submit`.
- Hằng số (giá trị đúng như spec):
  - `SHORT_GAP_MIN_SEC = 20`, `SHORT_GAP_MAX_SEC = 60`;
  - `LINK_CAPTURE_MAX_WAIT_MS = 8000`, kiểm mỗi 250 ms;
  - `LAUNCH_RETRY_DELAY_MS = 10000`;
  - `SIDE_JOB_YIELD_MS = 10 * 60_000`;
  - `DIAGNOSTIC_RETENTION_MS = 7 * 86_400_000`, `DIAGNOSTIC_MAX_FILES = 500`.
- Trang giả trong test hiện có có thể **không có** `url()` / `isClosed()`. Mọi chỗ đọc hai hàm này phải chịu được việc thiếu, và coi như "không có vấn đề".
- Định danh tiếng Anh. Chú thích và thông báo tiếng Việt, theo giọng code xung quanh. Không refactor ngoài phạm vi.
- Người làm task **không commit, không `git add`, không sửa tài liệu và bridge**. Người điều phối (em) làm phần đó.
- Test: `npx jest <files> --runInBand`. better-sqlite3 báo sai `NODE_MODULE_VERSION` thì chạy `(cd node_modules/better-sqlite3 && npx prebuild-install)`. Typecheck: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi `-p tsconfig.json` (chạy lần lượt).

## Review Focus

1. Huỷ trong lúc trang đang đóng: phải ra `stopped` / `cancelled`, không phải `browser_closed` (Task 2).
2. Trình duyệt chết **sau** cú bấm Đăng: phải ra `uncertain_after_submit`, không phải `browser_closed` (Task 2).
3. Checkpoint xảy ra ngay ở lần thử lại thứ 2 của một nhóm: nhóm đó ghi `checkpoint`, không thử lần 3, các nhóm sau `failed` + `checkpoint` (Task 1).
4. Chụp ảnh treo hoặc ném lỗi (trang đang điều hướng): lượt đăng vẫn chạy tiếp, ảnh bị bỏ qua sau tối đa 5 giây (Task 4).
5. Người dùng đặt khoảng nghỉ 5–10 giây: sau lỗi vẫn nghỉ theo khoảng của người dùng, không bị kéo lên 20 giây (Task 3).

---

### Task 1: Phát hiện checkpoint / đăng xuất (spec §2, §3)

**Files:**
- Modify: `src/services/facebookPoster/loginCheck.ts`
  - thêm `loginProblemAt(url: string): 'checkpoint' | 'logged_out' | null`;
  - `classifyLogin` dùng lại hàm này.
- Modify: `src/services/facebookPoster/postToTargets.ts`
  - thêm vào `PostErrorCode`: `'checkpoint' | 'browser_closed'`;
  - thêm `export class LoginProblemError extends Error { constructor(readonly state: 'checkpoint' | 'logged_out', message: string) }`;
  - thêm hàm `currentUrl(page)`: an toàn, trả `''` nếu không đọc được;
  - kiểm tra lúc mở, sau `FB_HOME`;
  - kiểm tra sau `page.goto` trong `postToSingleTarget`, và cờ `loginProblem` trên `SingleTargetOutcome`;
  - vòng lặp đích: ghi kết quả rồi ném `LoginProblemError`.
- Modify: `src/services/facebookPoster/FacebookPosterService.ts`
  - `observeLogin` và `FacebookPosterServiceDeps.onLoginObserved` nhận `'ok' | 'logged_out' | 'checkpoint'`;
  - trong `runProfile`, bắt `LoginProblemError` trước nhánh lỗi chung: gọi `observeLogin(profileId, err.state)` và `failRemaining(active, plan, err.message, true, err.state === 'checkpoint' ? 'checkpoint' : 'not_logged_in')`.
- Modify: `electron/ipc/facebookPosterIpc.ts`, kiểu tham số chỗ nối `onLoginObserved`, nếu tsc đòi.
- Test:
  - `src/__tests__/facebookPoster/postToTargets.test.ts`;
  - `src/__tests__/facebookPoster/FacebookPosterService.test.ts`;
  - test của `loginCheck` hiện có (tìm bằng `grep -rl classifyLogin src/__tests__`).

**Interfaces:**
- Produces:
  - `loginProblemAt`;
  - `LoginProblemError`;
  - `currentUrl(page): string` (export để Task 2 và Task 4 dùng);
  - các mã `checkpoint`, `browser_closed` trong `PostErrorCode`.
- Thông báo:
  - checkpoint: `CHECKPOINT_MESSAGE = 'Facebook yêu cầu xác minh tài khoản (checkpoint). Mở profile để xác minh rồi đăng lại.'`;
  - đăng xuất: dùng lại thông báo "Profile chưa đăng nhập Facebook…" hiện có. Chuyển `NOT_LOGGED_IN_ERROR` sang `postToTargets.ts` hoặc `loginState.ts` và export, để hai file dùng chung một chuỗi.

- [ ] **Step 1: Viết test hỏng**
  - `loginProblemAt`:
    - `https://www.facebook.com/checkpoint/123` → `checkpoint`;
    - `/two_step_verification/x` → `checkpoint`;
    - `/auth_platform/` → `checkpoint`;
    - `https://www.facebook.com/login/?next=` → `logged_out`;
    - `https://www.facebook.com/groups/1` → `null`;
    - `'not a url'` → `null`.
  - `postToTargets`, trang giả có `url()` trả URL checkpoint ngay sau `FB_HOME` → ném `LoginProblemError` với `state = 'checkpoint'`, không mở nhóm nào.
  - `postToTargets`, `cookies` không có `c_user` sau `FB_HOME` → ném `LoginProblemError('logged_out')`.
  - 4 đích, nhóm 2 có `url()` trả `/checkpoint/…` sau `goto`:
    - `onResult` nhận nhóm 1 (thành công giả) và nhóm 2 (`errorCode = 'checkpoint'`, `attempts = 1`);
    - sau đó ném `LoginProblemError`;
    - `goto` không được gọi cho nhóm 3–4.
  - Cùng tình huống nhưng checkpoint xuất hiện ở lần thử 2 (lần 1 lỗi `composer_not_found`) → `attempts = 2`, không có lần 3.
  - `FacebookPosterService`:
    - task giả ném `LoginProblemError('checkpoint', …)` → mọi đích còn lại `failed` + `checkpoint`;
    - `onLoginObserved` được gọi với `(profileId, 'checkpoint')`;
    - với `'logged_out'` → mã `not_logged_in`.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt.** Test trang giả cũ không có `url()` vẫn phải đạt.
- [ ] **Step 4: Chạy các file test liên quan và tsc, xác nhận đạt.**

### Task 2: Trình duyệt chết, mở lại khi lỗi thoáng qua (spec §5)

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts`
  - thêm `export class BrowserClosedError extends Error`;
  - sau một lần thử không thành công: nếu `page.isClosed?.() === true` và `!getIsStopping()` thì đặt `errorCode = 'browser_closed'`, `error = 'Trình duyệt của profile đã đóng giữa chừng'`, ghi kết quả, rồi ném `BrowserClosedError`.
- Modify: `src/services/facebookPoster/FacebookPosterService.ts`
  - trong `runProfile`, bắt `BrowserClosedError` **sau** nhánh `wasCritical` (đã bấm Đăng vẫn là `uncertain_after_submit`) và sau kiểm Huỷ;
  - gọi `failRemaining(…, true, 'browser_closed')`;
  - thêm `LAUNCH_RETRY_DELAY_MS = 10000`;
  - trong `launch`, nếu `openForAutomation` ném lỗi thì thử lại một lần sau thời gian đó (dùng `this.sleep` có kiểm Huỷ), trừ khi đang Huỷ hoặc lỗi là `Không tìm thấy profile` / `ENGINE_MISSING_ERROR` / bắt đầu bằng `PROFILE_OPEN_PREFIX` (lấy từ `loginCheck.ts`).
- Test: `postToTargets.test.ts`, `FacebookPosterService.test.ts`.

**Interfaces:**
- Consumes: `currentUrl`, `PostErrorCode` (Task 1).
- Produces: `BrowserClosedError`, `LAUNCH_RETRY_DELAY_MS`.

- [ ] **Step 1: Viết test hỏng**
  - Trang giả: lần thử nhóm 1 ném lỗi và `isClosed()` trả `true` → nhóm 1 ghi `browser_closed`, không thử lại, ném `BrowserClosedError`.
  - Như trên nhưng `getIsStopping()` là `true` → không phải `browser_closed`; hành vi Huỷ cũ giữ nguyên.
  - Service:
    - task ném `BrowserClosedError` → các đích còn lại `failed` + `browser_closed`;
    - task ném sau `enterCritical` (lượt post) → vẫn `uncertain_after_submit`.
  - `openForAutomation` lỗi "proxy" lần 1, thành công lần 2 → lượt chạy bình thường, `sleep` được gọi với 10000.
  - Lỗi `Profile đang mở…` → chỉ gọi 1 lần, ra `launch_failed`.
  - Đang Huỷ → không thử lại.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt.**
- [ ] **Step 4: Chạy test liên quan và tsc, xác nhận đạt.**

### Task 3: Nghỉ ngắn sau lỗi chưa đăng, lấy link theo điều kiện (spec §6, §8)

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts`
  - thêm `export const SHORT_GAP_MIN_SEC = 20; export const SHORT_GAP_MAX_SEC = 60; export const LINK_CAPTURE_MAX_WAIT_MS = 8000;`;
  - vòng lặp đích giữ `afterSubmit` của lần thử cuối để quyết định khoảng nghỉ;
  - trong `postToSingleTarget`, chuyển `page.off('response', listenToResponse)` xuống sau bước chờ link, và mọi đường thoát vẫn gỡ (dùng `try/finally` bao cả hai đoạn).
- Test: `postToTargets.test.ts`.

**Interfaces:** không có interface mới cho task khác.

- [ ] **Step 1: Viết test hỏng.** Dùng fake timers và `sleepStoppable` giả, hoặc đo bằng nhật ký `Nghỉ … giây` như test hiện có:
  - `minDelay = 300`, `maxDelay = 900`, nhóm 1 lỗi `composer_not_found` qua đủ 3 lần → khoảng nghỉ trước nhóm 2 nằm trong 20–60 và nhật ký có "Nghỉ ngắn".
  - Nhóm 1 thành công → khoảng nghỉ trong 300–900.
  - Nhóm 1 `uncertain_after_submit` → khoảng nghỉ trong 300–900.
  - `minDelay = 5`, `maxDelay = 10`, nhóm 1 lỗi → khoảng nghỉ ≤ 10.
  - Link:
    - GraphQL mang `story_fbid` đến sau khi hộp soạn thảo đóng 5 giây → có `postUrl`, không gọi tìm link dự phòng;
    - không có phản hồi → sau 8 giây gọi `findOwnPostUrl`, tức hành vi cũ (kiểm qua trang giả);
    - `page.off('response', …)` được gọi đúng 1 lần ở cả đường thành công và đường `uncertain_after_submit`.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt.**
- [ ] **Step 4: Chạy test liên quan và tsc, xác nhận đạt.**

### Task 4: Ảnh chẩn đoán (spec §4)

**Files:**
- Create: `src/services/facebookPoster/diagnostics.ts`, gồm:
  - `DIAGNOSTIC_RETENTION_MS`, `DIAGNOSTIC_MAX_FILES`;
  - `diagnosticFileBase(profileId: string, targetIndex: number, attempt: number): string`, trả `` `${profileId.slice(0, 8)}-${targetIndex}-l${attempt}` ``;
  - `pruneDiagnostics(dir: string, now: number, fsImpl = fs): void`, dọn theo spec §4;
  - `async function saveDiagnosticFiles(dir: string, base: string, page: Page, meta: { targetUrl: string; attempt: number; errorCode: string; at: number }): Promise<string>`:
    - chụp `page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 })`;
    - ghi `<base>.jpg` và `<base>.txt` (URL trang, tiêu đề trang, đích, mã lỗi, lần thử, thời điểm ISO);
    - trả `<base>.jpg`.
- Modify: `src/services/facebookPoster/types.ts`, thêm `saveDiagnostic?` vào `TaskDeps` đúng chữ ký spec §4.
- Modify: `src/services/facebookPoster/postToTargets.ts`
  - gọi `deps.saveDiagnostic` sau mỗi lần thử không thành công (trừ `stopped`, trừ khi trang đã đóng), **trước** `discardDraft`;
  - lỗi thì nuốt và ghi cảnh báo;
  - có tên tệp thì ghi log `Đã lưu ảnh chẩn đoán: <tên>`.
- Modify: `src/services/facebookPoster/FacebookPosterService.ts`
  - `FacebookPosterServiceDeps` thêm `diagnosticsDir?: () => string | null`;
  - `taskDeps` của lượt post có `saveDiagnostic` khi có thư mục. Hàm này đếm số thứ tự đích theo `targetUrl` trong kế hoạch của profile, và lấy thư mục lượt `<dir>/<runId>`.
- Modify: `electron/ipc/facebookPosterIpc.ts`
  - nối `diagnosticsDir: () => path.join(scheduleBaseDir(), 'fb-poster-diagnostics')`;
  - gọi `pruneDiagnostics` (bọc try / `Logger.warn`) khi bắt đầu mỗi lượt kind `post`, ở chỗ start run.
- Test:
  - Create `src/__tests__/facebookPoster/diagnostics.test.ts`, thư mục tạm bằng `fs.mkdtempSync(os.tmpdir())`;
  - `postToTargets.test.ts`, `FacebookPosterService.test.ts`.

**Interfaces:**
- Consumes: `currentUrl` (Task 1).
- Produces: các export của `diagnostics.ts`; `TaskDeps.saveDiagnostic`.

- [ ] **Step 1: Viết test hỏng**
  - `diagnosticFileBase('abcdef123456', 3, 2) === 'abcdef12-3-l2'`.
  - `pruneDiagnostics`:
    - thư mục lượt có mtime 8 ngày trước bị xoá, 6 ngày thì giữ;
    - 3 thư mục × 200 tệp (600 > 500) → xoá thư mục cũ nhất, còn 400;
    - thư mục không tồn tại thì không ném.
  - `saveDiagnosticFiles` với trang giả (`screenshot` trả Buffer, `url()`, `title()`) → tạo `.jpg` và `.txt`; `.txt` có URL và mã lỗi.
  - `postToTargets`:
    - nhóm lỗi 3 lần → `saveDiagnostic` gọi 3 lần với `attempt` 1..3 và mã;
    - nhóm thành công → không gọi;
    - Huỷ → không gọi;
    - `saveDiagnostic` ném → lượt đăng vẫn chạy nhóm sau;
    - thứ tự gọi: `saveDiagnostic` trước `discardDraft` (ghi nhận thứ tự bằng mảng sự kiện của trang giả).
  - Service: có `diagnosticsDir` → `taskDeps.saveDiagnostic` được truyền cho task post; không có → không truyền.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt.**
- [ ] **Step 4: Chạy test liên quan và tsc, xác nhận đạt.**

### Task 5: Việc phụ nhường khe (spec §7)

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts`
  - thêm `export function scheduleWantsSlot(now: number, deps = { queued: () => scheduler?.queuedIds().length ?? 0, nextAt: () => store().nextScheduledAt() }): boolean`, theo spec §7;
  - đặt `SIDE_JOB_YIELD_MS = 10 * 60_000` trong file;
  - ba chỗ `isBusy` của tracker / collector / kiểm tra đăng nhập (khoảng dòng 464, 478, 493) thêm `|| scheduleWantsSlot(Date.now())`;
  - lỗi đọc store thì trả `false` (không chặn việc phụ vì lỗi đọc).
- Test: `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` hoặc một test thuần cho `scheduleWantsSlot` với deps giả.

- [ ] **Step 1: Viết test hỏng.** Các ca:
  - hàng chờ 1 lượt → `true`;
  - lịch kế tiếp sau 9 phút → `true`;
  - sau 11 phút → `false`;
  - `null` → `false`;
  - `nextAt` ném lỗi → `false`.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt.**
- [ ] **Step 4: Chạy test, rồi toàn bộ `npx jest --runInBand` và tsc cả hai cấu hình.**

### Task 6 (người điều phối): bridge, tài liệu, kiểm thật, review, commit

- [ ] Bridge `GUIDE` §6 thêm dòng `checkpoint` / `browser_closed`; chạy test bridge.
- [ ] Cập nhật tài liệu:
  - `SYSTEM_DOCUMENTATION.md`:
    - mã lỗi 13 → 15;
    - ảnh chẩn đoán và thư mục;
    - nghỉ ngắn;
    - việc phụ nhường khe;
    - chờ link 8 giây;
    - thêm dấu `docs-check` cho các hằng số mới;
  - `docs/protocol/maihub-control-protocol.md`: bảng `errorCode`;
  - Trạng thái spec.
- [ ] Kiểm thật với Chromium của app trên trang HTML cục bộ: `saveDiagnosticFiles` tạo ảnh JPEG hợp lệ và `.txt`; `loginProblemAt(page.url())` trên trang `/checkpoint/…` cục bộ.
- [ ] Chạy 2 vòng kiểm: toàn bộ jest, tsc, `check-docs`, test bridge.
- [ ] Opus review cuối (không chạy cùng app / Docker); sửa theo review.
- [ ] Commit (code + tài liệu cùng commit).
