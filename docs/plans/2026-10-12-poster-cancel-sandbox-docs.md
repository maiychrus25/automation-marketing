# Hủy dừng ngay, sandbox khi cần, tài liệu khớp code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bấm Hủy làm việc Đăng Facebook dừng trong vài giây (trừ đoạn không thể quay lại), chuyển workspace không bao giờ ghi sang DB mới, Chromium chạy có sandbox trừ khi Linux chặn, tài liệu khớp code và CI chặn khi lệch.

**Architecture:** `FacebookPosterService` giữ phiên trình duyệt và cờ "đoạn không thể quay lại" theo từng profile; `cancel()` đóng phiên của profile ngoài đoạn đó, `stopAndWait()` thêm bước đóng cứng có hạn giờ. Module thuần `sandboxSupport.ts` chạy thử nhân một lần (cache theo đường dẫn nhân) và được dùng ở mọi nơi khởi chạy Chromium. `scripts/check-docs.js` (Node thuần) kiểm phiên bản, hằng số, đường dẫn trong tài liệu và chạy ở job `verify`.

**Tech Stack:** Electron 41, TypeScript, React 18, playwright-core 1.62, jest 29 + ts-jest (`--runInBand`), GitHub Actions.

**Spec:** `docs/specs/2026-10-12-poster-cancel-sandbox-docs.md` (intent: `docs/intent/2026-10-12-poster-cancel-sandbox-docs.md`).

## Global Constraints

- Định danh code tiếng Anh; chữ hiển thị tiếng Việt, đúng nguyên văn trong plan.
- Không thêm dependency.
- Không đăng/bình luận/xin vào nhóm thật trong khi phát triển hay test.
- Chạy jest bằng `npx jest --runInBand <files>`. Suite SQLite cần better-sqlite3 bản Node: `(cd node_modules/better-sqlite3 && npx prebuild-install)` trước khi chạy, `npm run rebuild:native` sau khi xong.
- Type-check: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` và `... -p tsconfig.json --noEmit` (tsconfig.json bao cả `src/__tests__`).
- Không dùng `git add -A`; add đúng đường dẫn. Commit kết thúc bằng `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- File tạm để ngoài repo và ngoài `/tmp` (RAM): dùng thư mục scratchpad của phiên.
- Lý do dừng: `'Đã dừng'` (hằng `STOPPED_REASON` sẵn có trong `FacebookPosterService.ts`).
- Thời gian: chờ êm `45000` ms, chờ sau đóng cứng `10000` ms, chạy thử sandbox timeout `20000` ms, lát ngủ `500` ms.

## Review Focus

1. Hủy đúng lúc profile đang mở trình duyệt (`openForAutomation` chưa trả) → phiên mở xong phải bị đóng ngay, không chạy tiếp tới `goto` 45 s. (Task 2, test `closes a session that finishes opening after cancel`.)
2. Hủy khi đang ở đoạn không thể quay lại rồi lỗi thật xảy ra trong đoạn → giữ `failed` với lỗi thật, không đổi thành `skipped`. (Task 2, test `keeps a real failure inside a critical section`.)
3. Thu bình luận: các bài lỗi thật trước khi bấm Hủy không bị đổi thành "Đã dừng"; chỉ bài cuối (đang dở) được đổi. (Task 2, test `only the last collect result becomes stopped`.)
4. Nhân trình duyệt treo khi chạy thử sandbox → hết 20 s, dự phòng sysctl, thư mục tạm vẫn bị xóa. (Task 4, test `times out and falls back to sysctl`.)
5. Xóa workspace đang active khi việc không dừng được → workspace KHÔNG bị xóa, scheduler chạy lại. (Task 3, kiểm bằng đọc diff + tsc; không có harness test cho `workspaceIpc`.)

---

### Task 1: Chờ dừng được và đánh dấu đoạn không thể quay lại trong các module việc

**Files:**
- Modify: `src/services/facebookPoster/types.ts` (TaskDeps)
- Modify: `src/services/facebookPoster/humanize.ts` (thêm `sleepStoppable`)
- Modify: `src/services/facebookPoster/postToTargets.ts:403-411` (deps của `postToSingleTarget`), `:590-600` (vào đoạn), `:778-827` (vòng đích: rời đoạn, nghỉ dừng được)
- Modify: `src/services/facebookPoster/scanGroups.ts:77,92-158`
- Modify: `src/services/facebookPoster/joinGroups.ts:300-352`
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts`, `scanGroups.test.ts`, `joinGroups.test.ts`

**Interfaces:**
- Produces:
  - `TaskDeps.enterCritical?: () => void` và `TaskDeps.leaveCritical?: () => void` (tùy chọn để fixture test cũ vẫn hợp lệ). JSDoc: "Bao thao tác không hoàn tác được (bấm Đăng, bấm Tham gia) tới khi có kết quả; Hủy không đóng trình duyệt trong đoạn này."
  - `export async function sleepStoppable(ms: number, getIsStopping: () => boolean, sliceMs = 500): Promise<void>` trong `humanize.ts` (ngủ theo lát, trả ngay khi `getIsStopping()`).
  - `scanGroups` ném `new Error('Đã dừng')` khi `getIsStopping()` đúng ở đầu mỗi vòng cuộn hoặc sau khi chờ ổn định trang.

- [ ] **Step 1: Viết test hỏng**
  - `postToTargets.test.ts`:
    - `rest between targets ends within a second of cancel`: 2 đích, `minDelay = maxDelay = 600`, `getIsStopping` chuyển `true` sau khi `onResult` của đích 1 chạy; dùng `runWithFakeTimers`; đo thời gian giả từ lúc dừng tới lúc hàm trả ≤ 1000 ms (hoặc: tổng số lần `advanceTimersByTimeAsync(5000)` ≤ 2 sau khi dừng). Kỳ vọng đích 2 không được mở (`goto` không gọi URL đích 2).
    - `wraps publish click to result in a critical section`: ghi chuỗi sự kiện `enter`, `click:publish`, `onResult`, `leave` vào mảng; kỳ vọng thứ tự đúng như vậy và `enter`/`leave` mỗi thứ đúng 1 lần.
    - `leaves the critical section when publishing throws`: làm `waitForSelector` của bước chờ dialog ném lỗi; kỳ vọng `leave` vẫn được gọi đúng 1 lần.
    - `does not enter a critical section when stopped before publishing`: `getIsStopping` đúng trước bước gõ; kỳ vọng `enterCritical` không được gọi.
  - `scanGroups.test.ts`: `stops scrolling when cancelled`: `getIsStopping` đúng sau 2 vòng cuộn; kỳ vọng promise reject với message `'Đã dừng'` và số lần `scrollToBottom` ≤ 3.
  - `joinGroups.test.ts`: `wraps the join click in a critical section`: chuỗi sự kiện `enter` → `click:join` → `leave` → `onResult`.

- [ ] **Step 2: Chạy test, thấy hỏng**
  Run: `npx jest --runInBand src/__tests__/facebookPoster/postToTargets.test.ts src/__tests__/facebookPoster/scanGroups.test.ts src/__tests__/facebookPoster/joinGroups.test.ts`
  Expected: các test mới FAIL.

- [ ] **Step 3: Cài đặt**
  - `postToSingleTarget` nhận thêm `enterCritical` trong deps; gọi `deps.enterCritical?.()` ngay sau khi kiểm "Nút Đăng đang tắt" (trước log `'[Đăng Bài] Đang click nút Đăng bài...'`).
  - Trong vòng `for (const target of normalized)` của `postToTargets`: bọc phần từ gọi `postToSingleTarget` tới hết `onResult` trong `try { … } finally { deps.leaveCritical?.() }` (gọi `leaveCritical` dù có vào đoạn hay không — idempotent ở phía service). Khoảng nghỉ giữa đích dùng `sleepStoppable(secs * 1000, getIsStopping)` thay `delayRandom`.
  - `scanGroups`: thay `sleep` cục bộ bằng `sleepStoppable(…, deps.getIsStopping)` cho `settleMs` và `scrollWaitMs`; kiểm dừng sau `settleMs` và đầu mỗi vòng `for`, dừng thì ném `Error('Đã dừng')`. Xóa hàm `sleep` cục bộ nếu không còn dùng.
  - `joinGroups`: `deps.enterCritical?.()` ngay trước `page.locator('[data-maihub-target="join"]')…click`, `deps.leaveCritical?.()` trong `finally` bao từ click tới hết khối đọc kết quả (trước `onResult`).
  - Không đổi `sleepStoppable` cục bộ sẵn có trong `joinGroups.ts`/`collectComments.ts` (ngoài phạm vi).

- [ ] **Step 4: Chạy lại test, thấy qua** (cùng lệnh Step 2). Expected: PASS toàn bộ ba file.

- [ ] **Step 5: Commit**
  ```bash
  git add src/services/facebookPoster/types.ts src/services/facebookPoster/humanize.ts src/services/facebookPoster/postToTargets.ts src/services/facebookPoster/scanGroups.ts src/services/facebookPoster/joinGroups.ts src/__tests__/facebookPoster/postToTargets.test.ts src/__tests__/facebookPoster/scanGroups.test.ts src/__tests__/facebookPoster/joinGroups.test.ts
  git commit -m "fix(fb-poster): stoppable rests and critical sections in poster tasks"
  ```

### Task 2: Hủy đóng phiên ngoài đoạn không thể quay lại, dừng có hạn giờ

**Files:**
- Modify: `src/services/facebookPoster/FacebookPosterService.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterService.test.ts`

**Interfaces:**
- Consumes: `TaskDeps.enterCritical/leaveCritical` (Task 1).
- Produces:
  - `FacebookPosterService.stopAndWait(graceMs = 45000, forceMs = 10000): Promise<boolean>` — `true` khi không còn việc chạy. Không có việc → `true` ngay.
  - `cancel()` / `cancelAll()` giữ chữ ký, thêm hành vi đóng phiên.

- [ ] **Step 1: Viết test hỏng** (dùng `tasks` giả và `openForAutomation` giả trả `{ context, close: jest.fn() }`, như các test hiện có trong file)
  - `cancel closes sessions of profiles outside a critical section`: task giả mở `launch()` rồi chờ một promise không bao giờ xong cho tới khi `session.close` được gọi (close giả làm reject promise đó); gọi `cancel()`; kỳ vọng `close` được gọi trước khi `whenIdle()` xong, run `cancelled`, đích đang làm ghi `skipped` / `'Đã dừng'`.
  - `cancel waits for a critical section`: task giả gọi `enterCritical()`, chờ promise `release`; `cancel()` → `close` CHƯA được gọi; resolve `release`, task báo `onResult({ ok: true, … })` rồi `leaveCritical()` → kết quả `posted`, run `cancelled`.
  - `keeps a real failure inside a critical section`: trong đoạn, `onResult({ ok: false, error: 'X' })` sau `cancel()` → ghi `failed` / `'X'`.
  - `failure after cancel outside a critical section is stopped`: `onResult({ ok: false, error: 'Target closed' })` sau `cancel()`, không vào đoạn → `skipped` / `'Đã dừng'`.
  - `closes a session that finishes opening after cancel`: `openForAutomation` resolve SAU khi `cancel()`; kỳ vọng `close` của phiên đó được gọi, task giả không chạy tiếp sau `launch()` (launch reject), các đích ghi `skipped` / `'Đã dừng'`.
  - `only the last collect result becomes stopped`: task `collectComments` giả trả `results` `[failed 'A', failed 'Target closed']` sau `cancel()` → hàng 1 `failed`/`'A'`, hàng 2 `skipped`/`'Đã dừng'`.
  - `stopAndWait force-closes after the grace period`: task giả ở đoạn không thể quay lại không bao giờ tự xong trừ khi phiên bị đóng; với fake timers, `stopAndWait(45000, 10000)`: trước 45 s `close` chưa gọi; sau 45 s `close` được gọi; kết quả `failed` với lỗi `'Đã đóng khi đang chờ kết quả — kiểm tra bài trên Facebook'`; trả `true`.
  - `stopAndWait returns false when the job never ends`: task giả bỏ qua cả việc đóng phiên; sau 55 s trả `false`.
  - `stopAndWait with no job returns true`.

- [ ] **Step 2: Chạy test, thấy hỏng**
  Run: `npx jest --runInBand src/__tests__/facebookPoster/FacebookPosterService.test.ts` (cần better-sqlite3 bản Node nếu file dùng `memoryDb`). Expected: test mới FAIL.

- [ ] **Step 3: Cài đặt**
  - `ProfilePlan` thêm `sessions: AutomationSession[]`, `critical: boolean`, `reachedCritical: boolean` (đặt ở `plan()`); `runProfile` dùng `plan.sessions` thay mảng cục bộ.
  - `taskDeps` thêm `enterCritical: () => { plan.critical = true; plan.reachedCritical = true; }`, `leaveCritical: () => { plan.critical = false; }`.
  - `launch()`: sau `sessions.push(session)`, nếu `this.stopping` → `await session.close()` rồi ném `Error(STOPPED_REASON)`.
  - `cancel()`: đặt `stopping`; với mỗi plan `!critical` → `closeSessions(plan)` (không await, `Promise.allSettled`).
  - `private forced = false` (reset trong `start()`); `forceStop()` (private): `forced = true`, đóng phiên mọi plan.
  - `stopAndWait`: không có `active` → `true`; `cancel()`; chờ `idle` tối đa `graceMs`; chưa xong → `forceStop()`, chờ tối đa `forceMs`; trả việc đã xong hay chưa. Xóa timer sau khi chờ.
  - `record()` áp `stopAware(plan, row)` trước khi ghi, rồi `plan.reachedCritical = plan.critical`:
    - `failed` + `stopping` + `!reachedCritical` → `skipped` / `STOPPED_REASON`;
    - `failed` + `forced` + `reachedCritical` → giữ `failed`, lỗi `FORCED_CLOSE_ERROR = 'Đã đóng khi đang chờ kết quả — kiểm tra bài trên Facebook'`.
  - Nhánh `collect_comments`: chỉ hàng cuối của `results` đi qua `stopAware`; các hàng trước ghi nguyên (thêm tham số `{ stopAware: boolean }` cho `record`, mặc định `true`).

- [ ] **Step 4: Chạy lại test** — toàn bộ `FacebookPosterService.test.ts` PASS (test cũ không đổi kỳ vọng).

- [ ] **Step 5: Commit**
  ```bash
  git add src/services/facebookPoster/FacebookPosterService.ts src/__tests__/facebookPoster/FacebookPosterService.test.ts
  git commit -m "fix(fb-poster): cancel closes idle browsers at once, bounded stop with force close"
  ```

### Task 3: Chuyển/xóa workspace và thoát app dùng dừng có hạn giờ

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts:82-104`
- Modify: `electron/ipc/workspaceIpc.ts:148-185` (xóa), `:192-215` (chuyển)
- Modify: `electron/preload.ts:735-781` (thêm kênh `workspace:waitingForJobs`)
- Modify: `src/ui/components/common/WorkspaceSwitcher.tsx:46-88`
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts:23`
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts:59`

**Interfaces:**
- Consumes: `FacebookPosterService.stopAndWait()` (Task 2).
- Produces: `cancelAndWaitFacebookPosterJobs(): Promise<boolean>` (bỏ tham số `timeoutMs`); hằng `POSTER_NOT_STOPPED_ERROR = 'Việc Đăng Facebook chưa dừng được. Thử lại sau.'` export từ `facebookPosterIpc.ts`.

- [ ] **Step 1: Sửa kỳ vọng test** `FacebookPosterStore.test.ts:59` thành `'App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook.'`; chạy, thấy FAIL.
- [ ] **Step 2: Cài đặt**
  - `INTERRUPTED_RUN_ERROR` = chuỗi ở Step 1.
  - `cancelAndWaitFacebookPosterJobs`: không có service → `true`; ngược lại `return service.stopAndWait()` bọc try/catch (lỗi → `false`).
  - `workspace:switch`: nếu `isFacebookPosterBusy()` → gửi `mainWindow.webContents.send('workspace:waitingForJobs', {})`; `stopFacebookPosterScheduler()`; `if (!(await cancelAndWaitFacebookPosterJobs())) { startFacebookPosterScheduler(); throw new Error(POSTER_NOT_STOPPED_ERROR); }` — nhánh `catch` sẵn có khôi phục workspace cũ và trả `{ success: false, error }`.
  - `workspace:delete`: nếu `wasActive`, làm bước dừng (cùng sự kiện + kiểm như trên) **trước** `wm().deleteWorkspace(id)`; không dừng được → khởi động lại scheduler, trả `{ success: false, error: POSTER_NOT_STOPPED_ERROR }`, không xóa. `deleteWorkspace` thất bại sau khi đã dừng → khởi động lại scheduler. Sửa thụt lề dòng `closeAllBrowserProfiles()` trong khối này.
  - Thoát app (`electron/main.ts` `before-quit`): không đổi code (spec §3.4).
  - Preload: thêm `'workspace:waitingForJobs'` vào `validChannels` cạnh `'workspace:switched'`.
  - `WorkspaceSwitcher`: nghe `workspace:waitingForJobs` → `showNotification('Đang dừng việc Đăng Facebook trước khi chuyển workspace…', 'info')`; tăng safety timer từ `10000` lên `70000` (đủ 55 s chờ).
- [ ] **Step 3: Kiểm**: `npx jest --runInBand src/__tests__/facebookPoster/FacebookPosterStore.test.ts` PASS; hai lệnh tsc sạch.
- [ ] **Step 4: Commit**
  ```bash
  git add electron/ipc/facebookPosterIpc.ts electron/ipc/workspaceIpc.ts electron/preload.ts src/ui/components/common/WorkspaceSwitcher.tsx src/services/facebookPoster/FacebookPosterStore.ts src/__tests__/facebookPoster/FacebookPosterStore.test.ts
  git commit -m "fix(workspace): never switch the database while a poster job still runs"
  ```

### Task 4: Module `sandboxSupport`

**Files:**
- Create: `src/services/browser/sandboxSupport.ts`
- Test: `src/__tests__/browser/sandboxSupport.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SandboxState = 'enabled' | 'disabled';
  export interface ProbeResult { code: number | null; stderr: string; timedOut: boolean }
  export interface SandboxProbeDeps {
      platform: NodeJS.Platform;
      run(executable: string, args: string[], timeoutMs: number): Promise<ProbeResult>;
      readSysctl(path: string): string | null;   // trả nội dung đã trim, null nếu không đọc được
      makeTempDir(parent: string): string;
      removeDir(dir: string): void;
  }
  export const PROBE_TIMEOUT_MS = 20000;
  export function probeSandbox(enginePath: string, deps: SandboxProbeDeps): Promise<SandboxState>;
  export class SandboxSupport {
      constructor(deps: SandboxProbeDeps);
      get(enginePath: string): Promise<SandboxState>;      // cache Promise theo enginePath
      recheck(enginePath: string): Promise<SandboxState>;  // xóa cache rồi get
  }
  export function getSandboxSupport(): SandboxSupport;     // singleton với deps Node thật
  ```
- `probeSandbox`: `platform !== 'linux'` → `'enabled'` (không chạy gì). Linux: `dir = makeTempDir(path.dirname(enginePath))`; `run(enginePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${dir}`, '--dump-dom', 'about:blank'], PROBE_TIMEOUT_MS)`; `finally removeDir(dir)`. `code === 0` → `'enabled'`; `stderr` khớp `/No usable sandbox/i` → `'disabled'`; còn lại → sysctl: `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` = `'1'`, hoặc `/proc/sys/kernel/unprivileged_userns_clone` = `'0'`, hoặc `/proc/sys/user/max_user_namespaces` = `'0'` → `'disabled'`, ngược lại `'enabled'`. `run` ném → xử lý như "còn lại".
- Deps thật: `run` dùng `child_process.spawn` (stdio `['ignore','ignore','pipe']`, giữ tối đa 4000 ký tự stderr cuối, timeout → `kill('SIGKILL')`, `timedOut: true`); `makeTempDir` = `fs.mkdtempSync(path.join(parent, '.sandbox-probe-'))`; `removeDir` = `fs.rmSync(dir, { recursive: true, force: true })` bọc try.

- [ ] **Step 1: Viết test hỏng**: `returns enabled without probing on win32/darwin`; `enabled when the probe exits 0`; `disabled on "No usable sandbox"`; `times out and falls back to sysctl` (một ca cho từng sysctl → `disabled`, ca không sysctl nào chặn → `enabled`); `run throwing falls back to sysctl`; `always removes the temp dir` (cả khi `run` ném); `caches per engine path` (`get` hai lần → `run` 1 lần; path khác → thêm 1 lần); `recheck probes again`; kiểm `args` không chứa `--no-sandbox`.
- [ ] **Step 2: Chạy** `npx jest --runInBand src/__tests__/browser/sandboxSupport.test.ts` — FAIL (module chưa có).
- [ ] **Step 3: Cài đặt** theo Interfaces.
- [ ] **Step 4: Chạy lại** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add src/services/browser/sandboxSupport.ts src/__tests__/browser/sandboxSupport.test.ts
  git commit -m "feat(browser): detect whether the Linux sandbox is usable"
  ```

### Task 5: Dùng sandbox ở mọi nơi khởi chạy và báo người dùng

**Files:**
- Modify: `src/services/browser/BrowserProfileService.ts:40-53,134-160,180-196`
- Modify: `electron/ipc/browserProfileIpc.ts:36-50,229-242`
- Modify: `src/services/facebook/pagePlaywrightDriver.ts:28-36,303-309`
- Modify: `electron/preload.ts:883-884`, `src/ui/lib/ipc.ts:670-671`
- Modify: `src/ui/features/browser/BrowserProfilesView.tsx:132-160,346-366`
- Test: `src/__tests__/browser/BrowserProfileService.test.ts`

**Interfaces:**
- Consumes: `getSandboxSupport()`, `SandboxState` (Task 4).
- Produces:
  - `BrowserProfileServiceDeps.resolveSandbox?: (executable: string) => Promise<SandboxState>`; mặc định `async () => (this.platform === 'linux' ? 'disabled' : 'enabled')` (giữ hành vi cho test cũ).
  - IPC `browserProfile:sandboxStatus` nhận `{ recheck?: boolean }`, trả `{ sandbox: 'enabled' | 'disabled' | 'unknown' }` (`unknown` khi chưa cài nhân). Preload `sandboxStatus: (recheck?: boolean) => ipcRenderer.invoke('browserProfile:sandboxStatus', { recheck: !!recheck })`; kiểu trong `ipc.ts`: `sandboxStatus: (recheck?: boolean) => Promise<{ success: boolean; sandbox?: 'enabled' | 'disabled' | 'unknown'; error?: string }>`.
  - **Lệch spec có chủ đích:** spec §4.2 ghi `engineStatus` trả thêm `sandbox` và kênh `recheckSandbox`. Plan dùng một kênh riêng `sandboxStatus({ recheck })` và giữ nguyên `engineStatus`, để danh sách profile không phải chờ lần chạy thử (tới 20 s). Spec được cập nhật trong cùng commit với plan.

- [ ] **Step 1: Viết test hỏng** trong `BrowserProfileService.test.ts`: `passes --no-sandbox only when the sandbox is disabled` — với `platform: 'linux'`, `resolveSandbox: async () => 'enabled'` → args của `open()` và `openForAutomation()` không chứa `--no-sandbox`; `'disabled'` → có; kiểm `resolveSandbox` nhận đúng `executable`.
- [ ] **Step 2: Chạy** `npx jest --runInBand src/__tests__/browser/BrowserProfileService.test.ts` — FAIL.
- [ ] **Step 3: Cài đặt**
  - `open`/`openForAutomation`: `const noSandbox = (await this.resolveSandbox(executable)) === 'disabled';` ngay trước `buildLaunchArgs`, rồi `this.assertNotCancelled(id, entry)` như sau các await khác.
  - `browserProfileIpc`: truyền `resolveSandbox: (exe) => getSandboxSupport().get(exe)`; thêm handler `browserProfile:sandboxStatus` (`exe = getEngineManager().getExecutablePath()`; null → `{ sandbox: 'unknown' }`; ngược lại `recheck ? recheck(exe) : get(exe)`).
  - `pagePlaywrightDriver.launchSender`: `const executablePath = resolveEngineExecutable();` rồi thêm `chromiumSandbox: (await getSandboxSupport().get(executablePath)) === 'enabled'` vào options `launchPersistentContext`.
  - `BrowserProfilesView`: state `sandbox`; sau `load()` khi `engine.installed` gọi `sandboxStatus()` (không nằm trong `Promise.all` của danh sách). Khi `sandbox === 'disabled'`: dải `role="alert"` cùng kiểu dải "chưa được hỗ trợ" (viền vàng), nội dung:
    - đoạn: `Máy đang chặn sandbox của trình duyệt (AppArmor/user namespaces). Profile vẫn mở được nhưng chạy không sandbox, kém an toàn hơn.`
    - khối `<pre>` chứa đúng lệnh ở spec §4.2, nút `Sao chép lệnh` (`navigator.clipboard.writeText`, báo `Đã sao chép`), nút `Kiểm tra lại` gọi `sandboxStatus(true)` (có trạng thái đang chạy, khóa nút khi đang chạy).
    - `<pre>` cuộn ngang trong khối (`overflow-x-auto`), không làm tràn trang.
- [ ] **Step 4: Chạy lại** test file + hai lệnh tsc — PASS/sạch.
- [ ] **Step 5: Commit**
  ```bash
  git add src/services/browser/BrowserProfileService.ts electron/ipc/browserProfileIpc.ts src/services/facebook/pagePlaywrightDriver.ts electron/preload.ts src/ui/lib/ipc.ts src/ui/features/browser/BrowserProfilesView.tsx src/__tests__/browser/BrowserProfileService.test.ts
  git commit -m "feat(browser): run Chromium sandboxed unless Linux blocks it, and say how to fix"
  ```

### Task 6: Cập nhật tài liệu theo code

**Files:**
- Modify: `SYSTEM_DOCUMENTATION.md`, `NOTICE.md`, `DESIGN.md`, `README.md`
- Modify (chỉ dòng Trạng thái + mục "Ghi chú sau phát hành (12/10/2026)"): `docs/specs/2026-10-03-facebook-poster.md`, `docs/specs/2026-10-03-auto-update.md`, `docs/specs/2026-10-03-facebook-page-inbox.md`, `docs/specs/2026-10-05-facebook-page-send-business-suite.md`, `docs/specs/2026-10-07-facebook-page-sticker.md`, `docs/specs/2026-10-09-ai-facebook-content-assistant.md`
- Modify (comment): `src/services/facebook/FacebookService.ts:25`, comment `sendPageAttachment` và `handlePageMessageNotification` (tìm bằng grep), `src/services/database/schema.ts:8` (thêm `missed`), JSDoc lạc chỗ trên handler `fb:listPageStickers` trong `electron/ipc/facebookIpc.ts`

- [ ] **Step 1:** Đọc spec §5.1–5.2 và code tương ứng; sửa nội dung theo bảng §5.1. `SYSTEM_DOCUMENTATION.md`: dòng "Phiên bản ứng dụng được khảo sát" = `` `26.16.0` `` (bằng `version` của `package.json`), ngày cập nhật 2026-10-12; gộp/đánh lại số hai mục 4.11; mục Hộp thư Page theo code; mô tả hủy (§3) và sandbox (§4) của spec này; đặt các dấu `<!-- docs-check: <file>#<CONST> = <value> -->` của spec §5.3 cạnh câu nêu giới hạn tương ứng (giá trị là số đã tính, ví dụ `MAX_IMAGE_BYTES = 20971520`).
- [ ] **Step 2:** Spec lịch sử: chỉ sửa dòng Trạng thái và thêm mục ghi chú (liệt kê điểm khác kèm `file:dòng`), không sửa thân.
- [ ] **Step 3:** Comment code: chỉ sửa comment, không đổi code. Hai lệnh tsc sạch.
- [ ] **Step 4: Commit** (add từng file đã sửa)
  `git commit -m "docs: bring system docs, notices and specs in line with 26.16.0 code"`

### Task 7: Kiểm tài liệu tự động trong CI và quy tắc trong AGENTS.md

**Files:**
- Create: `scripts/check-docs.js`
- Create: `src/__tests__/docs/checkDocs.test.ts`
- Modify: `.github/workflows/build.yml` (job `verify`, sau "Type-check renderer")
- Modify: `AGENTS.md` (mục "Tài liệu đi cùng code" theo spec §5.4)

**Interfaces:**
- Produces (CommonJS, `module.exports`; chạy `node scripts/check-docs.js [repoRoot]`, exit 0 sạch / 1 lệch, in mỗi lỗi một dòng `docs-check: <file>: <mô tả>`):
  - `evaluateNumber(expr: string): number | null` — chỉ nhận chữ số, khoảng trắng, `_`, `*`, `+`; ngoài ra `null`.
  - `findConstant(source: string, name: string): number | null` — khớp `(export )?const NAME = <expr>;`.
  - `checkVersion(docText: string, version: string): string[]`
  - `checkConstantMarkers(docFile: string, docText: string, readFile: (rel: string) => string | null): string[]`
  - `checkPaths(docFile: string, docText: string, exists: (rel: string) => boolean): string[]` — đường dẫn trong backtick bắt đầu bằng `src/`, `electron/`, `scripts/`, `docs/`, `resources/`, `public/`, `.github/`; bỏ qua chuỗi có `*`, `<`, `>`, `{`, `}`; bỏ hậu tố `:dòng` hoặc `#…` trước khi kiểm.
  - `runChecks(root: string): string[]` — version trên `SYSTEM_DOCUMENTATION.md`; marker trên `SYSTEM_DOCUMENTATION.md`; path trên `SYSTEM_DOCUMENTATION.md`, `README.md`, `DESIGN.md`, `AGENTS.md`.
- Test import bằng `const checkDocs = require('../../../scripts/check-docs.js');`.

- [ ] **Step 1: Viết test hỏng**: `evaluateNumber('20 * 1024 * 1024') === 20971520`, `evaluateNumber('86_400') === 86400`, `evaluateNumber('process.env.X') === null`; `findConstant` cho `const` và `export const`, không thấy → `null`; `checkVersion` khớp → `[]`, lệch → 1 lỗi chứa cả hai phiên bản; marker sai giá trị → 1 lỗi; marker hằng không tồn tại → 1 lỗi; `checkPaths` bỏ qua `` `src/**/*.ts` `` và `` `docs/specs/<tên>.md` ``, nhận `` `src/a.ts:12` `` là `src/a.ts`, đường dẫn thiếu → 1 lỗi; `runChecks(repoRoot) ` trên repo thật → `[]`.
- [ ] **Step 2: Chạy** `npx jest --runInBand src/__tests__/docs/checkDocs.test.ts` — FAIL.
- [ ] **Step 3: Cài đặt** script; thêm bước CI:
  ```yaml
      - name: Kiểm tài liệu khớp code
        run: node scripts/check-docs.js
  ```
  và mục AGENTS.md (bốn gạch đầu dòng của spec §5.4).
- [ ] **Step 4: Chạy lại** test + `node scripts/check-docs.js` → exit 0, không in lỗi. Thử đổi tạm marker sai trong bản sao ở scratchpad (`node scripts/check-docs.js <thư mục bản sao>`) → exit 1.
- [ ] **Step 5: Commit**
  ```bash
  git add scripts/check-docs.js src/__tests__/docs/checkDocs.test.ts .github/workflows/build.yml AGENTS.md
  git commit -m "ci: block the build when docs drift from code"
  ```

### Task 8 (controller): Kiểm chứng tích hợp trên máy dev

Không giao subagent. Sau Task 7:
1. `npm ci` + `npm run rebuild:native` (node_modules đang thiếu `playwright-core`).
2. Hai lệnh tsc sạch; `npx jest --runInBand` toàn bộ (với better-sqlite3 bản Node, rồi `npm run rebuild:native`); `node scripts/check-docs.js`.
3. Script ở scratchpad gọi `getSandboxSupport().get(<engine>)` → `'enabled'` trên máy này.
4. Mở một profile tự động qua Playwright với args từ `buildLaunchArgs({ noSandbox: false })`: renderer ở user namespace khác tiến trình chính (so `/proc/<pid>/ns/user`); `launchPersistentContext` với `chromiumSandbox: true`: `/proc/<pid>/cmdline` không có `--no-sandbox`.
5. Chạy app dev, màn Trình duyệt desktop + hẹp (mobile), sáng/tối: không có dải cảnh báo (máy không chặn), không tràn ngang. Giả lập `disabled` (env tạm trong phiên dev, không commit) để chụp dải cảnh báo ở hai chế độ màu và hai bề rộng.
6. Hai vòng stress test theo AGENTS.md; không đăng thật.

---

## Điều chỉnh khi triển khai (12/10/2026)

Các điểm code khác văn bản plan ở trên, đã được review và có test:

1. **Cờ đoạn không thể quay lại (Task 2):** `record()` đặt `reachedCritical = false` sau mỗi kết quả; quy tắc đổi kết quả coi `critical || reachedCritical` là đang trong đoạn (plan ghi `reachedCritical = critical`, làm cờ dính sang đích sau).
2. **Kiểm dừng ngay trước click (Task 1/2):** `postToTargets` và `joinGroups` kiểm `getIsStopping()` ngay trước `enterCritical`, để Hủy rơi sát lúc bấm vẫn ghi "Đã dừng" và không bấm.
3. **Trạng thái profile sau Hủy:** hiện `cancelled` (không phải `failed`) khi lỗi do Hủy, trừ khi đóng cứng.
4. **Chạy thử sandbox (Task 4):** `makeTempDir` nằm trong `try`; Promise lỗi không bị cache; `runProcess` chạy nhóm tiến trình riêng, hết hạn thì giết cả nhóm và trả ngay. Sau review cuối: lần chạy đầu thoát mã khác 0 mà không phải "No usable sandbox" thì chạy lại có `--no-sandbox`; chạy được → `disabled`.
5. **Lệnh AppArmor (Task 5):** `browserProfile:sandboxStatus` trả thêm `apparmorPath` = `<thư mục browser-engine>/*/*/<tên file nhân>` tính ở tiến trình chính, đặt trong ngoặc kép trong lệnh (thư mục dữ liệu có thể là `AHV Connect`, có dấu cách).
6. **Workspace (Task 3, sau review cuối):** `WorkspaceManager.canDeleteWorkspace` kiểm điều kiện xóa trước khi dừng việc; cờ `switchInProgress` từ chối chuyển/xóa chồng nhau (`Đang chuyển workspace, thử lại sau.`); bước sau khi dừng nằm trong `try/finally` khởi động lại scheduler; có `src/__tests__/app/workspaceIpc.test.ts`.
7. **Đóng cứng việc xin vào nhóm:** lỗi riêng `Đã đóng khi đang chờ kết quả — kiểm tra yêu cầu vào nhóm trên Facebook`.
8. **check-docs (Task 7):** báo dấu `docs-check` sai định dạng, báo lỗi khi tài liệu không còn dấu nào, `package.json` hỏng ra dòng lỗi thay vì stack trace.
