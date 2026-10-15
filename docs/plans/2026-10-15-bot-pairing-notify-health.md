# Ghép nối bot, thông báo chủ động, sức khoẻ tài khoản — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng tự ghép nối bot ↔ MaiHub bằng một lệnh, bot tự nhắn Telegram khi có chuyện, và MaiHub biết profile Facebook nào hết phiên hoặc bị checkpoint.

**Architecture:**
- **Phần A — Ghép nối:**
  - `PairingTickets` giữ vé trong bộ nhớ ở mức module của `controlApiIpc.ts`, để vé sống qua các lần server khởi động lại.
  - `ControlApiServer` có thêm 2 route `/v1/pair` và `/v1/bridge.py`, đặt trước bước xác thực khoá.
  - Bridge có thêm lệnh `pair`.
- **Phần B — Sức khoẻ tài khoản:**
  - `LoginChecker` (file mới `loginCheck.ts`) lấy "khe việc" độc quyền từ `FacebookPosterService`.
  - Trạng thái lưu ở bảng mới. `LoginCheckScheduler` lo việc kiểm tra hằng ngày.
  - Control API có thêm `profiles.check` và 2 sự kiện mới.
- **Phần C — Thông báo:** bridge có thêm `watch` và `install-watch`, gửi tin bằng token Telegram của chính bot.

**Tech Stack:** Electron 41, TypeScript, Node `https`/`crypto`/`os`, better-sqlite3, React 18, Python ≥ 3.6 stdlib. Không thêm dependency.

**Spec:** `docs/specs/2026-10-15-bot-pairing-notify-health.md` (đọc kèm spec gốc `docs/specs/2026-10-14-maihub-control-protocol.md`).

## Global Constraints

- **Vé ghép nối:**
  - 32 byte ngẫu nhiên, base64url (43 ký tự); chỉ lưu SHA-256;
  - sống `15` phút, dùng một lần, gắn với `botIp`;
  - tối đa `5` vé còn hiệu lực; mỗi IP chỉ có 1 vé;
  - thân `/v1/pair` ≤ `1024` byte.
- **Mã ghép nối:** `mhp1.` + base64url (không padding) của JSON `{"u","f","t","n"}`.
- **Kiểm tra đăng nhập:**
  - `goto` hết giờ sau `45000` ms; kiểm tra lần lượt từng profile;
  - mặc định `{ enabled: true, time: "07:00" }`, khoá setting `fb_poster_login_check`;
  - khi bận thì thử lại mỗi `5` phút, quá `2` giờ thì bỏ lượt;
  - `profiles.check` nhận tối đa `50` mã.
- **`watch`:**
  - `events.wait` với `timeoutSec = 25`; lỗi kết nối thì thử lại sau `15` s;
  - cảnh báo mất liên lạc sau `300` s; khoá bị từ chối thì thử lại mỗi `300` s;
  - gửi Telegram lỗi thì thử lại sau `2`, `10`, `30` s;
  - chuỗi lấy từ MaiHub cắt còn `200` ký tự, cả tin cắt còn `3500` ký tự.
- **Giao thức v1 chỉ được THÊM:** thao tác, sự kiện, trường. Không đổi nghĩa trường cũ. Bot dùng `.env` cũ vẫn chạy.
- **Không vào Facebook thật trong test.** Mạng trong test chỉ dùng `127.0.0.1`. Không in API key hay `TG_TOKEN` ra bất kỳ đâu.
- **Ngôn ngữ:** định danh tiếng Anh; chữ hiển thị, log và docs tiếng Việt; khớp phong cách file đang sửa.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <đường dẫn>`. Suite SQLite cần chạy `(cd node_modules/better-sqlite3 && npx prebuild-install)` trước và `npm run rebuild:native` sau.
  - tsc: chạy **riêng từng lệnh**: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi lệnh tương tự với `-p tsconfig.json`.
  - Bridge: `python3 -m unittest discover -s tools/maihub-bridge/tests -v`.
- **Tài liệu:** thay đổi hành vi thì cập nhật `SYSTEM_DOCUMENTATION.md` và `docs/protocol/maihub-control-protocol.md` **trong cùng commit**. `node scripts/check-docs.js` phải sạch.
- **Git:** `git add` đúng đường dẫn, không dùng `-A`. Commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **UI:** theo `DESIGN.md` (token màu `red`, `green`, `orange`). Đúng ở sáng và tối, desktop và 390 px, không tràn ngang, không chồng chữ.

## Review Focus

1. **Vé bị dùng lại hoặc dùng từ IP khác.** Lần thứ hai trả `401` và tính vào khoá lỗi; vé gửi từ IP khác `botIp` cũng `401`, không tạo khoá. → Task 2.
2. **Lịch đăng đến giờ khi đang kiểm tra đăng nhập.** Lịch vào hàng đợi rồi chạy sau khi kiểm tra xong; `drafts.approve now` và `start()` trả `BUSY`, không hỏng. → Task 5, 7.
3. **Lỗi mạng hoặc proxy khi kiểm tra.** `state` giữ nguyên, chỉ ghi `last_error`, không phát `profile.loginProblem`. → Task 5.
4. **`watch` khởi động lần đầu hoặc đổi workspace.** Không gửi lại sự kiện cũ. Tiến trình chết rồi chạy lại thì không mất tin chưa gửi (có thể trùng một tin, không được thiếu). → Task 13.
5. **VPS có nhiều bot hoặc không có bot AHV.** `pair --install` dừng với thông báo rõ ràng kèm danh sách unit, không sửa gì. → Task 12.

---

### Task 1: Vé ghép nối và dựng mã/lệnh cài

**Files:**
- Create: `src/services/control/PairingTickets.ts`
- Modify: `src/services/control/controlConfig.ts` (thêm `publicHost` vào `ControlConfig`, `parseStoredConfig`, `validateConfigInput`; thêm các hàm bên dưới)
- Test: `src/__tests__/control/PairingTickets.test.ts`, `src/__tests__/control/controlConfig.test.ts` (tạo mới nếu chưa có)

**Interfaces:**
- Produces:
  - `class PairingTickets { constructor(now?: () => number, randomBytes?: (n: number) => Buffer); create(name: string, botIp: string): { ticket: string; expiresAt: number }; consume(ticket: string, ip: string): { name: string; botIp: string } | null; cancel(botIp: string): void; pending(): { name: string; botIp: string; expiresAt: number }[] }`
  - `PAIRING_TTL_MS = 900_000`, `MAX_PENDING_TICKETS = 5`.
  - `ControlConfig.publicHost: string | null` (mặc định `null`).
  - `detectPublicIpv4(interfaces: NodeJS.Dict<import('os').NetworkInterfaceInfo[]>): string | null`: bỏ `internal`, dải private (10/8, 172.16/12, 192.168/16), 100.64/10, 169.254/16, 127/8.
  - `validatePublicHost(host: string): string`: IPv4 hoặc tên miền (`[a-z0-9.-]`, ≤ 253 ký tự); sai thì ném `ControlConfigError`.
  - `buildPairingCode(input: { url: string; fingerprint: string; ticket: string; name: string }): string`
  - `buildInstallCommand(input: { host: string; port: number; sha256: string; code: string }): string`: đúng mẫu ở spec §2.4. Mã được bọc nháy đơn; mã base64url không chứa `'`.

- [ ] **Step 1:** Viết test cho `PairingTickets`:
  - `consume` đúng IP thì trả `{ name, botIp }`, gọi lần 2 trả `null`;
  - sai IP trả `null` nhưng vé vẫn còn (người đúng IP vẫn dùng được);
  - quá `15` phút trả `null`;
  - tạo vé mới cho cùng IP thì vé cũ hết hiệu lực;
  - vé thứ 6 đẩy vé cũ nhất ra;
  - `pending()` không chứa vé thô;
  - `::ffff:1.2.3.4` khớp `1.2.3.4` (dùng `normalizeIp`).
- [ ] **Step 2:** Viết test cho `controlConfig`:
  - `detectPublicIpv4` bỏ đúng các dải private;
  - `validatePublicHost`;
  - `buildPairingCode` giải ngược ra đúng JSON;
  - `buildInstallCommand` khớp chuỗi mẫu;
  - `parseStoredConfig` với JSON cũ (không có `publicHost`) cho `publicHost: null`.
- [ ] **Step 3:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 4:** Commit: `feat(control): pairing tickets and pairing code builders`.

### Task 2: Route `/v1/pair` và `/v1/bridge.py` trong `ControlApiServer`

**Files:**
- Modify: `src/services/control/ControlApiServer.ts`
- Test: `src/__tests__/control/ControlApiServer.test.ts`
- Docs: `docs/protocol/maihub-control-protocol.md` (mục "Ghép nối" và 2 điểm cuối mới), `SYSTEM_DOCUMENTATION.md` (Control API)

**Interfaces:**
- Consumes: `PairingTickets.consume`, `ControlStore.createKey(name)`.
- Produces: các trường mới trong `ControlApiServerOptions`:
  - `pairing?: { consume(ticket: string, ip: string): { name: string } | null; onPaired(info: { keyId: string; keyName: string; ip: string }): void }`
  - `bridgeScript?: () => Buffer | null`

**Hành vi:**
- Cả 2 route đặt **sau** bước kiểm tra khoá lỗi IP và `/v1/health`, **trước** bước xác thực Bearer.
- `/v1/pair` chỉ nhận `POST`:
  - `isBlocked()` (chế độ nhân viên) → `503 BUSY`.
  - Thân request lớn hơn 1024 byte → `413`.
  - JSON hỏng hoặc thiếu `ticket` → `401` (không phải 400, để không cho biết gì).
  - `consume` trả `null` → `lockout.recordFailure(ip)`, ghi audit bị từ chối với `method = "pair"`, trả `401` với thông báo `Mã ghép nối không hợp lệ hoặc đã hết hạn`.
  - Thành công → `createKey`, ghi audit `ok` với `method = "pair"` và `keyName`, trả `200 { ok, result: { apiKey, keyName } }`, rồi gọi `onPaired`.
- `auditRejected` hiện chỉ ghi cho `/v1/call`; mở rộng để ghi cả `/v1/pair`.
- `/v1/bridge.py` chỉ nhận `GET`, trả `200 text/x-python; charset=utf-8`. Khi `bridgeScript()` trả `null` thì `404`.

- [ ] **Step 1:** Viết test (dùng server thật trên `127.0.0.1` như các test hiện có):
  - `pair: valid ticket returns a working key` (khoá trả về gọi được `/v1/describe` ngay);
  - `pair: reused or wrong-ip ticket is 401 and counts toward lockout` (10 lần sai thì IP bị chặn);
  - `pair: employee mode is 503`;
  - `pair: body over 1 KiB is 413`;
  - `pair: audited`;
  - `pair: no Authorization header needed`;
  - `bridge.py: served with python mime`;
  - `bridge.py: 404 when script missing`;
  - `non-allow-listed ip is closed before TLS for /v1/pair`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy toàn bộ `src/__tests__/control` cho PASS.
- [ ] **Step 3:** Cập nhật docs. Chạy `node scripts/check-docs.js`. Commit: `feat(control): /v1/pair and /v1/bridge.py endpoints`.

### Task 3: Nối ghép nối vào Electron và đóng gói bridge

**Files:**
- Modify:
  - `electron/ipc/controlApiIpc.ts`
  - `electron/preload.ts`: thêm `controlApi.createPairing(input)`, `controlApi.cancelPairing(botIp)`; thêm `controlApi:paired` vào danh sách kênh được nghe.
  - `package.json` `build.extraResources`: thêm `{ "from": "tools/maihub-bridge/maihub_bridge.py", "to": "maihub-bridge/maihub_bridge.py" }`.
- Test: `src/__tests__/control/controlWiring.test.ts` (nếu test được phần thuần); phần còn lại kiểm bằng tay ở Task 15.
- Docs: `SYSTEM_DOCUMENTATION.md` (IPC mới, đóng gói bridge)

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces:
  - IPC `controlApi:createPairing({ name, botIp, publicHost })` trả `{ code, command, firewall, expiresAt, ...configView }`.
  - IPC `controlApi:cancelPairing({ botIp })`.
  - Sự kiện broadcast `controlApi:paired { keyName, ip }`.
  - `getConfigView()` trả thêm `publicHost`, `detectedPublicHost`, `bridgeSha256`.

**Hành vi của `createPairing`:**
1. Kiểm tra `name` (1–60 ký tự), `botIp` (đúng một IPv4, không phải CIDR) và `publicHost`.
2. Thêm `botIp` vào allow-list, đặt `enabled: true` và `publicHost`, lưu qua `validateConfigInput`, rồi `await apply()`.
3. Nếu `runtime` vẫn `null` thì ném `lastError`.
4. Gọi `pairing.create`, rồi dựng mã (lấy fingerprint từ `certStoreOf()`), lệnh cài và lệnh tường lửa.

**Đường dẫn file bridge:** bản đóng gói đọc từ `path.join(process.resourcesPath, 'maihub-bridge', 'maihub_bridge.py')`; chạy dev đọc từ gốc repo (cùng cách `appVersion` dò `package.json`) + `tools/maihub-bridge/maihub_bridge.py`. Đọc một lần khi `startRuntime`, giữ `Buffer` và SHA-256 hex.

**`PairingTickets`:** một instance ở mức module, không tạo lại khi `apply()`.

- [ ] **Step 1:** Viết code. Chạy cả 2 lệnh tsc riêng rẽ, phải sạch.
- [ ] **Step 2:** Chạy `npx jest --runInBand src/__tests__/control` cho PASS.
- [ ] **Step 3:** Commit: `feat(control): pairing IPC and bundled bridge`.

### Task 4: Giao diện "Ghép nối bot mới"

**Files:**
- Create: `src/ui/components/settings/PairingPanel.tsx`
- Modify: `src/ui/components/settings/ControlApiSettings.tsx` (gắn panel lên đầu, chỉ đổi những gì cần)

**Interfaces:** Consumes IPC của Task 3.

**Hành vi:**
- **Form:** tên bot, IP VPS bot, địa chỉ MaiHub (điền sẵn `publicHost ?? detectedPublicHost`).
- **Nút "Tạo mã ghép nối":** trước khi tạo, hộp xác nhận ghi rõ "Sẽ bật API và thêm IP này vào danh sách được phép".
- **Kết quả:**
  - Bước 1: lệnh tường lửa (`CodeBox`).
  - Bước 2: lệnh cài (`CodeBox`), kèm đồng hồ đếm ngược mm:ss. Hết giờ thì hiện "Mã đã hết hạn — tạo mã mới".
  - Nút "Huỷ mã".
  - Ghi chú: "Khởi động lại MaiHub sẽ làm mã mất hiệu lực."
- **Nghe `controlApi:paired`:** hiện "Đã ghép nối: <tên>" và tải lại danh sách khoá.
- **Luồng tạo khoá tay cũ giữ nguyên.**

- [ ] **Step 1:** Viết panel. Chạy tsc `-p tsconfig.json`, phải sạch.
- [ ] **Step 2:** Mở app dev và kiểm tra: tạo mã với allow-list rỗng thì API được bật; đếm ngược chạy; huỷ mã được. Kiểm ở desktop và 390 px, sáng và tối; không tràn ngang; chuỗi lệnh dài cuộn trong `CodeBox`.
- [ ] **Step 3:** Commit: `feat(control): pairing panel in bot control settings`.

### Task 5: Trạng thái đăng nhập: bảng, phân loại, `LoginChecker`, khe việc

**Files:**
- Modify:
  - `src/services/facebookPoster/schema.ts`: bảng `fb_poster_login_state` theo spec §3.1.
  - `src/services/facebookPoster/FacebookPosterStore.ts`
  - `src/models/facebookPoster.ts`: thêm kiểu.
  - `src/services/facebookPoster/FacebookPosterService.ts`: khe việc và cập nhật bị động.
- Create: `src/services/facebookPoster/loginCheck.ts`
- Test:
  - `src/__tests__/facebookPoster/loginCheck.test.ts`
  - `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`
  - `src/__tests__/facebookPoster/FacebookPosterService.test.ts`

**Interfaces:**
- Produces:
  - Kiểu:
    - `type LoginState = 'ok' | 'logged_out' | 'checkpoint'`
    - `type LoginCheckOutcome = LoginState | 'error' | 'skipped'`
    - `type LoginCheckSource = 'manual' | 'api' | 'daily'`
    - `interface ProfileLoginState { profileId: string; state: LoginState | 'unknown'; checkedAt: number | null; source: 'check' | 'run' | null; lastError: string | null; lastErrorAt: number | null }`
  - Store:
    - `listLoginStates(): ProfileLoginState[]`
    - `setLoginState(profileId: string, state: LoginState, source: 'check' | 'run', at: number): LoginState | null` — trả trạng thái cũ, xoá `last_error`.
    - `setLoginError(profileId: string, error: string, at: number): void`
  - `classifyLogin(session: Pick<AutomationSession, 'context'>, timeoutMs?: number): Promise<LoginState>` — theo spec §3.2; lỗi điều hướng thì ném.
  - `class LoginChecker`:
    - `constructor(deps: LoginCheckerDeps)`
    - `check(profileIds: string[], source: LoginCheckSource): { checkId: string; profileIds: string[] }` — đồng bộ: giành khe việc hoặc ném `BUSY_ERROR`, rồi chạy nền.
    - `observe(profileId: string, state: LoginState, source: 'check' | 'run'): void`
    - `isRunning(): boolean`, `stop(): void`, `whenIdle(): Promise<void>`
  - `LoginCheckerDeps`:
    - `{ store; getProfile(id): ProfileInfo | null; openForAutomation(id): Promise<AutomationSession>; slot: { acquire(): void; release(): void }; onProblem(e: { profileId; profileName; state; source }): void; onFinished(e: { checkId; source; results: { profileId; profileName; outcome: LoginCheckOutcome; error?: string }[] }): void; onProgress(p: { done: number; total: number } | null): void; onStatesChanged(): void; now?; newId?; classify?: typeof classifyLogin }`
  - `FacebookPosterService`:
    - `acquireExclusive(): void` — ném `BUSY_ERROR` nếu đang có lượt đăng hoặc đang giữ khe.
    - `releaseExclusive(): void`
    - `isBusy(): boolean`
    - `start()` ném `BUSY_ERROR` khi khe đang bị giữ.
    - Dep tuỳ chọn `onLoginObserved?: (profileId: string, state: 'ok' | 'logged_out') => void`:
      - lần kiểm tra cookie đầu lượt không thấy `c_user` thì gọi `logged_out`;
      - kết thúc một profile có ít nhất một kết quả `posted` thì gọi `ok`;
      - bọc try/catch, không bao giờ làm hỏng lượt đăng.
- `LoginChecker.observe` chỉ gọi `onProblem` khi trạng thái mới là `logged_out` hoặc `checkpoint` **và** khác trạng thái cũ.
- Khi `classify` lỗi: gọi `setLoginError` và outcome là `error`.
- Khi mở profile báo "Profile đang mở…": outcome là `skipped`.

- [ ] **Step 1:** Viết test cho `classifyLogin` với context/page giả:
  - `no c_user → logged_out without navigation`;
  - `/checkpoint/… → checkpoint`;
  - `/login.php → logged_out`;
  - `cookie vanishes after load → logged_out`;
  - `home → ok`;
  - `goto timeout throws`.
- [ ] **Step 2:** Viết test store:
  - `setLoginState returns previous`;
  - `setLoginError keeps state`;
  - `list maps rows`.
- [ ] **Step 3:** Viết test `LoginChecker`:
  - `sequential, closes session on error`;
  - `profile open → skipped, no write`;
  - `problem emitted once per transition`;
  - `error keeps state, no problem event`;
  - `BUSY when slot taken`;
  - `stop() halts after current profile`;
  - `onFinished results`.
- [ ] **Step 4:** Viết test service:
  - `start throws BUSY while exclusive held`;
  - `acquireExclusive throws BUSY while run active`;
  - `isBusy covers both`;
  - `no c_user at launch → onLoginObserved logged_out`;
  - `posted result → ok`;
  - `observer throwing does not fail run`.
- [ ] **Step 5:** Chạy test, xác nhận FAIL. Viết code. Chạy toàn bộ `src/__tests__/facebookPoster` cho PASS (không có hồi quy).
- [ ] **Step 6:** Commit: `feat(poster): login state, classifier and exclusive login checker`.

### Task 6: `LoginCheckScheduler`

**Files:**
- Create: `src/services/facebookPoster/LoginCheckScheduler.ts`
- Test: `src/__tests__/facebookPoster/LoginCheckScheduler.test.ts`

**Interfaces:**
- Produces:
  - `interface LoginCheckConfig { enabled: boolean; time: string }`
  - `DEFAULT_LOGIN_CHECK_CONFIG = { enabled: true, time: '07:00' }`
  - `parseLoginCheckConfig(raw: string | null): LoginCheckConfig`
  - `validateLoginCheckConfig(input: any): LoginCheckConfig` — `time` khớp `^([01]\d|2[0-3]):[0-5]\d$`.
  - `nextDailyAt(time: string, now: number): number` — giờ máy, luôn > `now`.
  - `class LoginCheckScheduler`:
    - `constructor(deps: { now; setTimer; clearTimer; readConfig(): LoginCheckConfig; isBusy(): boolean; runCheck(): void; log(msg: string): void })`
    - `start()`, `stop()`, `reschedule()`
- Timer tối đa 24 giờ (giống `MAX_TIMER_MS` của scheduler đăng), quá thì đặt lại timer.

- [ ] **Step 1:** Viết test (đồng hồ và timer giả; mốc giờ dựng bằng `new Date(y, m, d, h, mi).getTime()` để không phụ thuộc múi giờ):
  - `before 07:00 → today`, `after → tomorrow`;
  - `busy → retries every 5 min, gives up after 2 h and arms next day`;
  - `disabled → no run`;
  - `reschedule after config change`;
  - `runCheck throwing BUSY counts as busy`;
  - `stop clears timer`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(poster): daily login check scheduler`.

### Task 7: Nối kiểm tra đăng nhập vào Electron

**Files:**
- Modify:
  - `electron/ipc/facebookPosterIpc.ts`
  - `electron/preload.ts`: `facebookPoster.checkLogins(profileIds?)`, `getLoginStates()`, `getLoginCheckConfig()`, `setLoginCheckConfig(cfg)`; thêm kênh nghe `facebookPoster:loginStateChanged` và `facebookPoster:loginCheckProgress`.
- Docs: `SYSTEM_DOCUMENTATION.md` (Đăng Facebook: bảng mới, IPC, kiểm tra hằng ngày, khe việc)

**Interfaces:**
- Consumes: Task 5, Task 6, `emitControlEvent`.
- Produces:
  - `src/services/control/controlEvents.ts`:
    - `ControlEventType` thêm `'profile.loginProblem' | 'profiles.checkFinished'`;
    - `buildLoginProblem(e)` và `buildCheckFinished(e)`: payload theo đúng spec §3.5.
  - `onProblem` và `onFinished` của checker gọi `emitControlEvent` với 2 builder trên, đồng thời broadcast `facebookPoster:loginStateChanged`.
  - `export function checkFacebookLogins(profileIds: string[] | null, source: LoginCheckSource): { checkId: string; profileIds: string[] }` — `null` nghĩa là mọi profile. Dùng chung cho IPC và Control API.
  - `export function listFacebookLoginStates(): ProfileLoginState[]`
- **Khi đổi database:** `LoginChecker` bind theo store giống service: DB đổi và checker đang rảnh thì tạo lại.
- **Các hàm hiện có phải tính cả việc kiểm tra:**
  - `isBusy` của scheduler đăng và `isFacebookPosterBusy()` (dùng bởi updater) trả `service.isBusy()`.
  - `cancelAndWaitFacebookPosterJobs()` gọi thêm `checker.stop()` rồi chờ `whenIdle()` có giới hạn thời gian.
- **`startFacebookPosterScheduler` / `stopFacebookPosterScheduler`** bật/tắt `LoginCheckScheduler` cùng lúc. Chế độ nhân viên thì không chạy.
- **`setLoginCheckConfig`** lưu `app_settings` rồi gọi `reschedule()`.
- **`onFinished` của checker:** gọi `scheduler?.onRunFinished()` để hàng đợi lịch chạy ngay.

- [ ] **Step 1:** Viết code. Chạy cả 2 lệnh tsc, phải sạch. Chạy `src/__tests__/facebookPoster` và `src/__tests__/control` cho PASS.
- [ ] **Step 2:** Commit: `feat(poster): wire login checks, daily scheduler and IPC`.

### Task 8: Control API: `profiles.check`, trường đăng nhập, sự kiện mới

**Files:**
- Modify:
  - `src/services/control/ControlMethods.ts`
  - `src/services/control/controlEvents.ts` (`scheduleName`)
  - `src/services/control/controlProfiles.ts`
  - `electron/ipc/controlApiIpc.ts`
  - `electron/ipc/facebookPosterIpc.ts`: thêm `scheduleName` khi build `run.finished`.
- Test: `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`
- Docs: `docs/protocol/maihub-control-protocol.md` (thao tác, trường, sự kiện), `SYSTEM_DOCUMENTATION.md`

**Interfaces:**
- Consumes: Task 7 (`checkFacebookLogins`, `listFacebookLoginStates`, 2 builder sự kiện).
- Produces:
  - `buildRunFinished(run, results, scheduleName: string | null = null)`.
  - `toSafeProfiles(..., loginStates: ProfileLoginState[] = [])` thêm `loginState`, `loginCheckedAt`, `loginError`.
  - `ControlMethodDeps.checkLogins(profileIds: string[] | null): { checkId: string; profileIds: string[] }`
  - `profiles.check`:
    - `destructive: false`;
    - tham số `profileIds` tuỳ chọn, mảng chuỗi tối đa 50 phần tử;
    - mã lạ thì `NOT_FOUND` với `details.missing` (kiểm tra qua `deps.listProfiles()`);
    - `BUSY` qua `toControlError`.

- [ ] **Step 1:** Viết test:
  - `profiles.check: starts and returns checkId`;
  - `missing ids → NOT_FOUND with details.missing`;
  - `>50 ids → INVALID_PARAMS`;
  - `BUSY mapped`;
  - `describe lists profiles.check`;
  - `profiles.list has login fields with unknown default`;
  - `run.finished carries scheduleName`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS. Chạy cả 2 lệnh tsc.
- [ ] **Step 3:** Cập nhật docs và chạy `check-docs`. Commit: `feat(control): profiles.check, login fields and login events`.

### Task 9: Giao diện huy hiệu và kiểm tra đăng nhập

**Files:**
- Create: `src/ui/features/facebookPoster/LoginStateBadge.tsx`, `src/ui/features/facebookPoster/LoginCheckControls.tsx`
- Modify: `src/ui/features/facebookPoster/ProfilePicker.tsx` (chỉ gắn huy hiệu vào từng dòng và controls vào đầu danh sách)

**Interfaces:** Consumes IPC của Task 7.

**Hành vi:** theo spec §3.6.
- Chip "Hết phiên" màu `orange`, "Checkpoint" màu `red`, chấm `green` cho `ok`. Chữ không tràn trên dòng hẹp: chip `whitespace-nowrap`, tên profile vẫn `truncate`.
- Nút "Kiểm tra đăng nhập":
  - chạy `checkLogins(selected.length ? selected : undefined)`;
  - khi chạy hiện "Đang kiểm tra… (d/t)";
  - bị khoá khi `facebookPoster:progress` báo có lượt đang chạy;
  - lỗi `BUSY` hiện bằng toast.
- Popover ⚙ "Tự kiểm tra mỗi ngày" gồm checkbox và `<input type="time">`, đóng bằng Esc hoặc bấm ra ngoài, có focus ring.

- [ ] **Step 1:** Viết component. Chạy tsc `-p tsconfig.json`, phải sạch.
- [ ] **Step 2:** Mở app dev, kiểm tra các tab Đăng / Lịch / Tham gia nhóm / Bình luận: huy hiệu đúng; nút bị khoá khi đang đăng; popover lưu và giữ được giá trị sau khi tải lại. Kiểm ở desktop và 390 px, sáng và tối.
- [ ] **Step 3:** Commit: `feat(poster): login state badges and check controls`.

### Task 10 (controller, cần anh): Xác minh đường tới Telegram trên VPS bot

Không code. Anh chạy lệnh dưới đây trên `.38`, hoặc cấp SSH cho em, rồi cho em biết kết quả:

```sh
sed -E 's#(//)[^@/]*@#\1***@#' /opt/bot/telegram-proxy.url
```

Nếu được, chạy thêm lệnh này để xem bot dùng URL đó thế nào:

```sh
grep -rn "telegram-proxy.url" /opt/bot/releases/*/current/ | head
```

Ghi kết luận vào mục "Điều chỉnh khi triển khai" của plan. Kết luận chọn một trong 2 dạng: (a) URL gốc thay cho `https://api.telegram.org`, hoặc (b) proxy chuyển tiếp. Task 13 dùng đúng dạng này. Các Task 11–12 không phụ thuộc vào kết luận này.

### Task 11: Bridge `pair` (không `--install`)

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py` (thêm route `/v1/pair` vào `FakeMaiHub`), `tools/maihub-bridge/README.md`

**Interfaces:**
- Produces:
  - `decode_pairing_code(code) -> dict(url, pin, ticket, name)`: sai tiền tố, base64 hoặc JSON hỏng, thiếu trường → `BridgeError("CONFIG", …)`.
  - `MaiHubClient.request(..., auth=True)`: với `auth=False` không gửi `Authorization`.
  - `MaiHubClient.pair(ticket) -> dict(apiKey, keyName)`.
  - `write_env_file(path, values, uid=None, gid=None)`: ghi file tạm quyền `0600` rồi `os.replace`; chỉ `chown` khi có uid.
  - `cmd_pair(args, run=subprocess.run) -> int`: giải mã → `pair` (đã ghim chứng chỉ trước khi gửi vé) → ghi `.env` → `doctor`. In khối `.env` với khoá đã `mask_key`.
- `Config.load` không đổi. `pair` tự dựng `Config(url, None, pin)` để gọi `/v1/pair`.

- [ ] **Step 1:** Viết test:
  - `test_decode_pairing_code_roundtrip_and_errors`;
  - `test_pair_sends_no_authorization_and_pins_first` (sai ghim thì vé không bao giờ được gửi);
  - `test_pair_writes_env_0600`;
  - `test_pair_output_masks_key`;
  - `test_pair_401_exit_code`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy toàn bộ suite bridge cho PASS (test cũ giữ xanh).
- [ ] **Step 3:** Commit: `feat(bridge): pair command`.

### Task 12: Bridge `pair --install`

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py`, `tools/maihub-bridge/README.md`

**Interfaces:**
- Consumes: Task 11.
- Produces:
  - `find_ahv_bots(systemd_dir="/etc/systemd/system") -> [dict(service, user, data_dir)]`: đọc `User=` và `Environment=AHV_BOT_DATA_DIR=`; chỉ giữ unit có `<data_dir>/.env` chứa `TG_TOKEN`.
  - `infer_cli(bot, explicit=None) -> "claude" | "codex"`: ném `BridgeError("CONFIG")` khi không suy ra được.
  - `register_mcp(cli, user, bridge_path, env_path, run)`: chạy `remove` (bỏ qua lỗi) rồi `add`, đúng lệnh ở spec §2.5, qua `sudo -u <user> -H` với `cwd` là home của user.
  - `backup_cli_config(cli, home, install_dir)`: chỉ sao lưu nếu chưa có bản `.before-maihub`.
  - `install_layout(install_dir, user)`: tạo thư mục, chép bridge (`shutil.copyfile` từ `__file__`), đặt quyền theo spec §2.5.
- `--install` khi `os.geteuid() != 0` → `BridgeError("CONFIG", "Cần chạy bằng root")`.
- Cuối lệnh in tóm tắt và lệnh gỡ.

- [ ] **Step 1:** Viết test (thư mục systemd giả, hàm `run` giả, `chown` được tiêm vào hoặc bỏ qua khi không phải root):
  - `find_ahv_bots` với 0, 1 và 2 unit;
  - `infer_cli` từ user, từ tên service, và khi không suy ra được;
  - `register_mcp` dựng đúng lệnh cho Claude và cho Codex;
  - `backup` không ghi đè bản cũ;
  - `install` không phải root bị từ chối;
  - nhiều bot mà không có `--bot` thì không sửa gì.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(bridge): pair --install finds the bot, registers MCP`.

### Task 13: Bridge `watch`

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py`, `tools/maihub-bridge/README.md`

**Interfaces:**
- Consumes: kết luận Task 10; sự kiện ở Task 8.
- Produces:
  - `resolve_notify_target(maihub_env, bot_env) -> dict(token, chat_id, thread_id)`: thứ tự ưu tiên chat theo spec §4.2.
  - `resolve_telegram_route(maihub_env, proxy_file_text) -> dict(api_base, proxy)`: theo kết luận Task 10; `TELEGRAM_API_BASE` luôn được ưu tiên.
  - `class TelegramSender(target, route, sleep=time.sleep, opener=None)`, có `send(text) -> bool`:
    - thử lại sau 2, 10, 30 giây;
    - HTTP 429 thì chờ `retry_after`;
    - không bao giờ đưa token vào thông điệp lỗi.
  - `format_event(event, fetch_run) -> str | None`: bảng tin ở spec §4.5; `fetch_run(runId)` có thể ném lỗi.
  - `class Watcher(client, sender, state_path, clock=time.time, sleep=time.sleep)`, có `step()` (một vòng `events.wait` hoặc một lần lỗi) và `run_forever()`.
  - File trạng thái `{cursor, workspaceId, downSince, downAlerted, authAlerted}`, ghi nguyên tử.
  - `cmd_watch(args)`: `--dry-run` dùng sender in ra stdout.

- [ ] **Step 1:** Viết test (đồng hồ giả, client giả, sender giả):
  - `format` cho từng loại sự kiện: nhãn theo kind, `failed > 0` kèm tối đa 3 dòng lỗi, `runs.get` lỗi thì gửi tin không chi tiết, cắt độ dài;
  - `first run skips history`;
  - `cursor saved after each send` và `crash between send and save resends`;
  - `workspace change jumps to latest + one notice`;
  - `unreachable 299 s no alert, 300 s one alert, recovery one message`;
  - `UNAUTHORIZED one alert`;
  - `sender 429 retry_after`;
  - `drops after 3 failures`;
  - `token never in stderr`;
  - `notify target priority`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(bridge): watch sends MaiHub events to Telegram`.

### Task 14: Bridge `install-watch` và nối vào `pair --install`

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`, `tools/maihub-bridge/tests/test_bridge.py`, `tools/maihub-bridge/README.md`, `docs/protocol/maihub-control-protocol.md` (mục `watch`)

**Interfaces:**
- Produces:
  - `render_watch_unit(name, user, bridge, env_file, notify_env, state_dir) -> str`: đúng các dòng ở spec §4.4.
  - `cmd_install_watch(args, run=subprocess.run) -> int`:
    1. chạy `watch --dry-run` khoảng 5 giây dưới quyền user;
    2. ghi unit;
    3. `daemon-reload`;
    4. `enable --now`.
- `pair --install` gọi `cmd_install_watch`, trừ khi có `--no-watch`.

- [ ] **Step 1:** Viết test:
  - `unit content` (có `NoNewPrivileges`, `ReadWritePaths`, `User=`);
  - `dry-run failure aborts before writing unit`;
  - `install-watch requires root`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(bridge): install-watch systemd service`.

### Task 15 (controller): Phát hành 26.19.0 và kiểm chứng

- [ ] **Step 1:** Tăng `package.json` lên `26.19.0`; thêm mục `ChangelogSettings.tsx`; cập nhật dòng phiên bản trong `SYSTEM_DOCUMENTATION.md`; ghi "Điều chỉnh khi triển khai" vào plan; chạy `check-docs`.
- [ ] **Step 2:** Chạy toàn bộ: jest `--runInBand`, cả 2 lệnh tsc, unittest của bridge, build prod (`tsc -p tsconfig.electron.prod.json` + `strip-console` + vite + `electron-builder --linux dir`). Xác nhận `resources/maihub-bridge/maihub_bridge.py` có trong bản build, và `/v1/bridge.py` của bản đóng gói trả đúng SHA-256 (kiểm qua `ELECTRON_RUN_AS_NODE`).
- [ ] **Step 3:** Chạy thật ở dev:
  1. MaiHub dev với allow-list `127.0.0.1` và `publicHost = 127.0.0.1`.
  2. Chạy lệnh cài do UI dựng, nhưng dùng `pair` không `--install`, trong thư mục scratchpad.
  3. Chạy `watch --dry-run`.
  4. Kích hoạt `run.finished` bằng một lượt quét nhóm (chỉ đọc) hoặc một sự kiện giả, và `schedule.missed`.
  5. Tắt MaiHub hơn 5 phút để thấy cảnh báo mất liên lạc, rồi bật lại.
  6. Kiểm tra đăng nhập trên một profile thật (chỉ tải trang).
- [ ] **Step 4:** Hai vòng stress, mỗi vòng gồm UI desktop và 390 px, sáng và tối:
  - Ghép nối: tạo, huỷ, hết hạn, ghép thành công.
  - Kiểm tra đăng nhập: chạy trong lúc lịch đến giờ.
  - Hồi quy: tạo khoá tay, `doctor`/`mcp` với `.env` cũ, Đăng ngay, lên lịch, huỷ lượt.
- [ ] **Step 5:** Review toàn nhánh bằng Opus. Merge vào `main`, gắn tag `v26.19.0`; anh push.
- [ ] **Step 6 (cần anh duyệt và cấp SSH):** cài `watch` cho `.164` và `.38` bằng `install-watch` (spec §8).
