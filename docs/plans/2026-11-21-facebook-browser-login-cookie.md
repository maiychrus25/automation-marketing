# Lấy cookie Facebook bằng đăng nhập trong trình duyệt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nút "Đăng nhập bằng trình duyệt" trong hộp thoại cập nhật cookie mở hồ sơ trình duyệt riêng của tài khoản, chờ anh đăng nhập đúng tài khoản rồi tự lưu cookie qua đúng đường `fb:updateCookie`.

**Architecture:** Thân `fb:updateCookie` tách thành hàm dùng chung `applyFbAccountCookie`. Một module thuần đọc cookie trình duyệt; một vòng chờ (nhận mọi phụ thuộc qua tham số) mở phiên, thăm dò cookie mỗi 2 s và gọi hàm lưu. IPC mới chỉ Boss nối vòng chờ với `BrowserProfileService.openForAutomation` (Playwright, nhân trình duyệt MaiHub tải về).

**Tech Stack:** Electron 41, TypeScript, playwright-core 1.62.1 (đã có), React 18, Jest.

**Spec:** `docs/specs/2026-11-21-facebook-browser-login-cookie.md`

## Global Constraints

- Chỉ tài khoản Facebook cá nhân (`parent_facebook_id` rỗng), chỉ máy Boss: `p?._fromRelay === true || isEmployeeMode()` → `{ success:false, code: BOSS_ONLY_CHANNEL_CODE, error: BOSS_ONLY_CHANNEL_ERROR }` (như `electron/ipc/fbHistoryIpc.ts:51`).
- Không lưu mật khẩu/2FA; không tự mở cửa sổ; không đọc Chrome cá nhân.
- Không bao giờ lưu cookie khi `c_user` khác `facebook_id` của tài khoản.
- Không ghi giá trị cookie vào log, sự kiện hay kết quả IPC; chỉ tên cookie / trạng thái.
- Hồ sơ đăng nhập đi qua proxy hiện tại của tài khoản (`resolveFBProxyId`).
- Hằng số: thăm dò `BROWSER_LOGIN_POLL_MS = 2000`, chờ tối đa `BROWSER_LOGIN_TIMEOUT_MS = 600000`; khoá ánh xạ `fb_login_profile_<internalId>`; tên hồ sơ `Đăng nhập Facebook – <tên tài khoản>`; sự kiện phiên `cookie_updated` detail `by=browser` (đường cũ giữ `by=user`).
- Test không gọi Facebook thật, không mở trình duyệt thật. Định danh code bằng tiếng Anh; chữ hiển thị tiếng Việt.
- Không đụng `sites/` và `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`.

## Review Focus

1. Lần kiểm tra cookie thất bại rồi cửa sổ vẫn mở: không được gọi Facebook mỗi 2 s với cùng cookie — chỉ kiểm tra lại khi chuỗi cookie đổi (Task 2 test `aFailedCheckIsNotRetriedUntilTheCookieChanges`).
2. Anh đóng cửa sổ giữa lúc đang lưu: kết quả lưu vẫn được trả, không báo "đã đóng" sai (Task 2 test `closingTheWindowWhileSavingKeepsTheSaveResult`).
3. Bấm nút hai lần / hai thẻ cùng tài khoản: lần hai bị từ chối `IN_PROGRESS`, không mở hai trình duyệt (Task 3).
4. Hồ sơ trong ánh xạ đã bị xoá ở màn Hồ sơ trình duyệt: tạo hồ sơ mới, không lỗi (Task 3).
5. Cookie trình duyệt có `c_user` nhưng thiếu `xs` (đang giữa bước 2FA): tiếp tục chờ, không lưu (Task 2).

---

### Task 1: Tách bước lưu cookie dùng chung

**Files:**
- Modify: `electron/ipc/facebookIpc.ts:324-393` (handler `fb:updateCookie`)
- Test: `src/__tests__/facebook/updateCookieIpc.test.ts` (mới; mock theo mẫu `src/__tests__/facebook/pageSendIpc.test.ts`: `electron`, `uuid`, `FacebookLoginHelper`, `Logger`, `DatabaseService`, `FacebookSession`, `SecureSettingsService`, `fbSessionEvents`)

**Interfaces:**
- Produces: `export async function applyFbAccountCookie(accountId: string, rawCookie: string, by: 'user' | 'browser'): Promise<{ success: boolean; error?: string; problem?: string }>` trong `electron/ipc/facebookIpc.ts` — đúng thân handler hiện tại (resolveInternalId, từ chối Page, `stripPageCookie`, `initSession` qua proxy, `recordCookieCheck`, kiểm `fbId`, `secureSet`, cập nhật DB, `reconnectPageChildren`), chỉ khác detail sự kiện là `by=${by}`. Handler `fb:updateCookie` gọi `applyFbAccountCookie(accountId, cookie, 'user')`.

- [ ] **Step 1: Viết test đặc tả hành vi hiện tại** (chạy được trên code cũ cho các ca `fb:updateCookie`, rồi thêm ca `by=browser`):
  - `aPageAccountIsRefused` → `success:false`, error chứa `tài khoản cá nhân`, `secureSet` không được gọi.
  - `anExpiredCookieReturnsTheProblemAndStoresNothing` (`initSession` ném lỗi có `fbSessionProblem:'checkpoint'`) → `{ success:false, problem:'checkpoint' }`, `secureSet` không gọi.
  - `aLiveCookieIsStoredAndRecordedAsByUser` → `secureSet(fbCookieKey, cookie)` và `recordFbSessionEvent` với `{ kind:'cookie_updated', detail:'by=user' }`.
  - `theSharedStepRecordsByBrowser`: `applyFbAccountCookie(id, cookie, 'browser')` → detail `'by=browser'`.
- [ ] **Step 2:** `npx jest src/__tests__/facebook/updateCookieIpc.test.ts` — ba ca đầu PASS, ca cuối FAIL (`applyFbAccountCookie` chưa có).
- [ ] **Step 3:** Tách thân handler thành `applyFbAccountCookie` như Interfaces; không đổi gì khác.
- [ ] **Step 4:** Chạy lại test — PASS cả bốn; `npx tsc -p tsconfig.electron.json --noEmit` sạch.
- [ ] **Step 5:** Commit `refactor(facebook): tách bước lưu cookie dùng chung cho đăng nhập bằng trình duyệt`.

### Task 2: Đọc cookie trình duyệt và vòng chờ đăng nhập

**Files:**
- Create: `src/services/facebook/browserLogin/browserLoginCookie.ts`
- Create: `src/services/facebook/browserLogin/runBrowserLogin.ts`
- Test: `src/__tests__/facebook/browserLogin.test.ts`

**Interfaces:**
- Produces (`browserLoginCookie.ts`):
  - `export interface BrowserCookie { name: string; value: string; domain: string }`
  - `export function readLoginCookie(cookies: BrowserCookie[], expectedFacebookId: string): { state: 'waiting' } | { state: 'wrong_account' } | { state: 'ready'; cookie: string }` — chỉ cookie có domain `facebook.com` hoặc kết thúc bằng `.facebook.com`; thiếu `c_user` hoặc `xs` (giá trị rỗng coi như thiếu) → `waiting`; `c_user` ≠ expected → `wrong_account`; ngược lại `cookie` = các cặp `name=value` nối bằng `'; '` theo thứ tự nhận được, mỗi tên một lần (lấy lần xuất hiện đầu).
- Produces (`runBrowserLogin.ts`):
  - `export const BROWSER_LOGIN_POLL_MS = 2000; export const BROWSER_LOGIN_TIMEOUT_MS = 600000;`
  - `export type BrowserLoginStatus = 'opening' | 'waiting' | 'wrong_account' | 'check_failed' | 'saving';`
  - `export type BrowserLoginResult = { success: true } | { success: false; code: 'CLOSED' | 'CANCELLED' | 'TIMEOUT' | 'OPEN_FAILED'; error: string };`
  - `export interface BrowserLoginWindow { readCookies(): Promise<BrowserCookie[]>; isClosed(): boolean; close(): Promise<void> }`
  - `export async function runBrowserLogin(deps: { open(): Promise<BrowserLoginWindow>; expectedFacebookId: string; applyCookie(cookie: string): Promise<{ success: boolean; error?: string }>; onStatus(status: BrowserLoginStatus, detail?: string): void; signal: AbortSignal; sleep(ms: number): Promise<void>; now(): number }): Promise<BrowserLoginResult>`
- Hành vi vòng chờ: `onStatus('opening')`; `open()` ném → `OPEN_FAILED` với `error` = message. Sau đó mỗi vòng: nếu `signal.aborted` → đóng cửa sổ, `CANCELLED`; nếu `isClosed()` → `CLOSED`; quá `BROWSER_LOGIN_TIMEOUT_MS` tính từ lúc mở → đóng, `TIMEOUT`; đọc cookie (lỗi đọc khi cửa sổ đã đóng → `CLOSED`), `readLoginCookie`: `waiting` → `onStatus('waiting')`; `wrong_account` → `onStatus('wrong_account')`; `ready` và chuỗi cookie khác lần kiểm tra thất bại trước → `onStatus('saving')`, `applyCookie`: thành công → `close()` (lỗi đóng bị nuốt), `{success:true}`; thất bại → `onStatus('check_failed', error)` và nhớ chuỗi đó. Giữa các vòng `sleep(BROWSER_LOGIN_POLL_MS)`. `onStatus` chỉ gọi khi trạng thái (hoặc detail) đổi.
- Thông điệp lỗi (đúng chữ): CLOSED `Đã đóng trình duyệt, chưa lấy được cookie`; CANCELLED `Đã huỷ đăng nhập bằng trình duyệt`; TIMEOUT `Quá 10 phút chưa đăng nhập xong, đã đóng trình duyệt`.

- [ ] **Step 1: Viết test thất bại** (cửa sổ giả: danh sách cookie theo từng lần đọc; `sleep` tăng đồng hồ giả):
  - `readLoginCookie`: `ignoresCookiesOfOtherSites`, `waitsWhileXsIsMissing` (Review Focus 5), `refusesAnotherAccount`, `buildsTheCookieStringOncePerName` (`'c_user=1; xs=a; datr=d'`).
  - `aMatchingLoginIsSavedAndTheWindowClosed` → `{success:true}`, `applyCookie` gọi đúng 1 lần, `close` gọi.
  - `aWrongAccountIsNeverSaved` → `applyCookie` không gọi, có status `wrong_account`.
  - `aFailedCheckIsNotRetriedUntilTheCookieChanges` (Review Focus 1): lần đầu `applyCookie` trả lỗi, 3 vòng cùng cookie → vẫn chỉ 1 lần gọi; cookie đổi `xs` → gọi lần 2 và thành công.
  - `closingTheWindowEndsWithClosed`, `cancellingEndsWithCancelledAndClosesTheWindow`, `afterTenMinutesItTimesOut` (đồng hồ vượt `600000`).
  - `closingTheWindowWhileSavingKeepsTheSaveResult` (Review Focus 2): `isClosed()` thành true trong lúc `applyCookie` chạy, `applyCookie` thành công → `{success:true}`.
  - `aWindowThatCannotOpenIsReported` → `OPEN_FAILED`.
- [ ] **Step 2:** `npx jest src/__tests__/facebook/browserLogin.test.ts` — FAIL vì module chưa có.
- [ ] **Step 3:** Viết hai module theo Interfaces.
- [ ] **Step 4:** Test PASS; `npx tsc -p tsconfig.json --noEmit` sạch.
- [ ] **Step 5:** Commit `feat(facebook): vòng chờ đăng nhập bằng trình duyệt và đọc cookie`.

### Task 3: Hồ sơ đăng nhập và kênh IPC

**Files:**
- Create: `src/services/facebook/browserLogin/loginProfile.ts`
- Modify: `electron/ipc/facebookIpc.ts` (đăng ký `fb:loginWithBrowser`, `fb:cancelBrowserLogin`)
- Modify: `electron/preload.ts` (hai hàm trong nhóm `fb` cạnh `updateCookie`; thêm `'fb:browserLoginStatus'` vào danh sách sự kiện cho phép, gần các sự kiện Facebook)
- Modify: `src/ui/lib/ipc.ts` (kiểu cho hai hàm)
- Test: `src/__tests__/facebook/browserLoginIpc.test.ts`, thêm ca vào `src/__tests__/facebook/browserLogin.test.ts` cho `ensureLoginProfile`

**Interfaces:**
- Consumes: `applyFbAccountCookie` (Task 1); `runBrowserLogin`, `BrowserLoginWindow` (Task 2); `getBrowserProfileService()`, `isBrowserEngineInstalled()` từ `electron/ipc/browserProfileIpc.ts` (require muộn trong handler); `generateFingerprint()` từ `src/services/browser/fingerprint.ts`; `resolveFBProxyId` từ `src/services/facebook/FacebookAccountCookie.ts`.
- Produces (`loginProfile.ts`):
  - `export const loginProfileKey = (internalId: string) => \`fb_login_profile_${internalId}\`;`
  - `export function ensureLoginProfile(deps: { db: { getSetting(k: string): string | null; setSetting(k: string, v: string): void; getBrowserProfileById(id: string): { id: string; proxy_id: number | null } | null; createBrowserProfile(p: { id: string; name: string; group_id: null; proxy_id: number | null; fingerprint: BrowserFingerprint; note: string }): { id: string }; updateBrowserProfile(id: string, f: { proxy_id: number | null }): void }; internalId: string; accountName: string; proxyId: number | null; newId(): string }): string` — dùng hồ sơ trong ánh xạ nếu còn (đặt lại `proxy_id` nếu khác), ngược lại tạo mới tên `Đăng nhập Facebook – ${accountName}`, note `Hồ sơ MaiHub dùng để lấy cookie Facebook`, lưu ánh xạ.
- Produces (IPC): `fb:loginWithBrowser({ accountId })` → `BrowserLoginResult` hoặc `{ success:false, code, error }` với code thêm: `BOSS_ONLY` (mã chung), `PAGE_ACCOUNT`, `IN_PROGRESS`, `ENGINE_MISSING` (`Chưa cài trình duyệt của MaiHub. Vào mục Hồ sơ trình duyệt để cài.`), `PROFILE_BUSY` (`Hồ sơ đăng nhập đang mở. Đóng cửa sổ đó rồi thử lại.`, khi `isRunning(profileId)`), `INVALID`. `fb:cancelBrowserLogin({ accountId })` → `{ success:true }` (abort nếu đang chạy). Sự kiện `EventBroadcaster.emit('fb:browserLoginStatus', { accountId, status, detail? })` với `accountId` đúng như renderer gửi.
- `open()` trong IPC: `openForAutomation(profileId)` → trang đầu (`context.pages()[0] ?? await context.newPage()`) `goto('https://www.facebook.com/')` (lỗi goto bị nuốt: anh vẫn đăng nhập được); `readCookies` = `context.cookies('https://www.facebook.com')`; `isClosed` theo sự kiện `close` của context; `close` = `session.close()`.
- Một lần chạy mỗi tài khoản: `Map<internalId, AbortController>`, xoá trong `finally`.

- [ ] **Step 1: Viết test thất bại:**
  - `ensureLoginProfile`: `createsAProfileOnFirstUseAndRemembersIt`, `reusesTheRememberedProfileAndFollowsTheAccountProxy`, `recreatesAProfileThatWasDeleted` (Review Focus 4).
  - IPC (mock `browserProfileIpc` với service giả trả context giả): `employeesAreRefused`, `pagesAreRefused`, `missingEngineIsExplained`, `aRunningLoginProfileIsReported`, `aSecondLoginForTheSameAccountIsRefusedWhileTheFirstRuns` (Review Focus 3), `aMatchingLoginStoresTheCookieByBrowser` (kiểm `secureSet` được gọi và sự kiện `by=browser`; context giả trả cookie hợp lệ ngay lần đọc đầu nên không có lần chờ nào), `cancelStopsTheRunningLogin` (context giả chưa có cookie; gọi `fb:cancelBrowserLogin` → lần chạy kết thúc `CANCELLED` ngay, không đợi hết 2 s).
- `sleep` mà IPC truyền cho `runBrowserLogin`: `setTimeout` nhưng kết thúc sớm khi `signal` bị abort (gỡ timer), để Huỷ có hiệu lực ngay.
- [ ] **Step 2:** Chạy hai tệp test — FAIL.
- [ ] **Step 3:** Viết `loginProfile.ts`, hai handler, preload, kiểu `ipc.ts`.
- [ ] **Step 4:** Test PASS; cả hai lệnh `tsc` sạch.
- [ ] **Step 5:** Commit `feat(facebook): kênh đăng nhập bằng trình duyệt dùng hồ sơ riêng của tài khoản`.

### Task 4: Giao diện, tài liệu, phiên bản

**Files:**
- Modify: `src/ui/components/dashboard/AccountCard.tsx` (`FBUpdateCookieModal`)
- Modify: `SYSTEM_DOCUMENTATION.md` (dòng phiên bản; mục "Ổn định phiên đăng nhập Facebook" thêm điểm (5) kèm `<!-- docs-check: src/services/facebook/browserLogin/runBrowserLogin.ts#BROWSER_LOGIN_TIMEOUT_MS = 600000 -->`)
- Modify: `src/ui/components/settings/ChangelogSettings.tsx` (mục 26.51.0), `package.json`/`package-lock.json` → `26.51.0` (`npm version 26.51.0 --no-git-tag-version`)
- Modify: `docs/specs/2026-11-21-facebook-browser-login-cookie.md` (dòng Trạng thái)
- Test: `src/__tests__/ui/` — chỉ nếu tách được hàm thuần cho chữ trạng thái (`browserLoginStatusText(status, detail?)`), đặt ở `src/ui/lib/facebook/browserLoginView.ts`

**Interfaces:**
- Consumes: `ipc.fb.loginWithBrowser`, `ipc.fb.cancelBrowserLogin`, sự kiện `fb:browserLoginStatus` (Task 3).
- Chữ trạng thái: opening `Đang mở trình duyệt…`; waiting `Hãy đăng nhập Facebook trong cửa sổ trình duyệt vừa mở`; wrong_account `Đang đăng nhập tài khoản Facebook khác. Hãy đăng nhập đúng tài khoản này.`; check_failed `Chưa dùng được phiên này: <detail>`; saving `Đang lưu cookie…`.

- [ ] **Step 1: Test thất bại** cho `browserLoginStatusText` (năm trạng thái, detail ghép vào check_failed).
- [ ] **Step 2:** Chạy — FAIL.
- [ ] **Step 3:** Viết `browserLoginView.ts`; trong modal thêm nút "Đăng nhập bằng trình duyệt" phía trên ô dán cookie, ẩn khi `useEmployeeStore(s => s.mode) === 'employee'`. Khi chạy: khoá ô dán và nút Lưu, hiện chữ trạng thái (lọc sự kiện theo `accountId`), nút Hủy gọi `cancelBrowserLogin` trước khi đóng. Thành công → giống `handleSave` (thông báo, `ipc.fb.connect`, đóng). Thất bại → hiện `error`, `CANCELLED` không hiện lỗi. Đóng modal khi đang chạy cũng gọi `cancelBrowserLogin`.
- [ ] **Step 4:** Test PASS; tài liệu, changelog (minor, 1 mục "added"), phiên bản; `node scripts/check-docs.js` sạch.
- [ ] **Step 5:** Commit `feat(facebook): nút đăng nhập bằng trình duyệt trong hộp thoại cập nhật cookie`.

## Kiểm chứng cuối (người điều phối)

- `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.electron.json --noEmit`.
- Jest ×3 dưới `caffeinate -i`: `TZ=UTC`; `TZ=America/New_York --randomize --seed=2707`; `TZ=Asia/Ho_Chi_Minh --randomize --seed=3707`.
- `node scripts/check-docs.js`.
- Rà soát toàn nhánh bằng subagent; quét diff không có bí mật / id thật trước khi đẩy.
