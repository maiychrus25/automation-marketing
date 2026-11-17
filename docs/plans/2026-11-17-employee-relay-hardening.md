# Vá kiểm soát truy cập của máy chủ chuyển tiếp (đợt 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trên máy boss, mọi yêu cầu của nhân viên (đọc, ghi, lệnh chuyển tiếp, tệp, sự kiện) chỉ chạm được tài khoản nhân viên đó được dùng; bí mật không rời máy boss; phiên đăng nhập thu hồi được.

**Architecture:** Các quyết định cho/từ chối nằm trong các tệp thuần (không import Electron, DB, mạng) và được `HttpRelayService` / `SocketIOService` gọi ở đúng các điểm điều phối. `HttpRelayService` (2826 dòng) chỉ được sửa ở các điểm gọi đó, không tái cấu trúc.

**Tech Stack:** TypeScript 5, Electron 41 (main process), `http` của Node, Socket.IO, better-sqlite3, jsonwebtoken, Jest + ts-jest.

**Spec:** `docs/specs/2026-11-17-employee-shared-inbox.md` (mục 2.1, 3.1, 3.2, 3.5, 5).

## Global Constraints

- Nhánh `feat/employee-relay-hardening`. Không push, không tag: người điều phối làm việc đó sau khi kiểm tra xong.
- Không bao giờ `git add` `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. Chỉ `git add` đúng các tệp của task.
- Định danh trong code bằng tiếng Anh. Chuỗi lỗi hiển thị cho người dùng bằng tiếng Việt, xưng "bạn". Comment theo ngôn ngữ của tệp đang sửa.
- Đóng mặc định: lệnh, khoá cài đặt, sự kiện, đường dẫn không có trong danh sách cho phép thì bị từ chối.
- Không ghi vào log: cookie, token, khoá ký, nội dung tin, đường dẫn tải tệp. Log từ chối chỉ gồm mã nhân viên, tên lệnh hoặc đường dẫn API, và mã lý do.
- Kiểm thử không gọi mạng thật, không đọc cơ sở dữ liệu thật của người dùng; dữ liệu mẫu tổng hợp (`acc-a`, `emp-1`…).
- Không sửa hai kiểm thử nhạy tải (`mobileSyncService.test.ts › longRunOfSkippedRowsYieldsAndHonoursCancel`, `pageCampaignAutonomy.integration.test.ts › 50 distinct contenders…`), không tăng timeout của chúng.
- Không thêm dependency.
- Mã tham khảo của dự án gốc (MIT) chỉ để đọc ý tưởng; không sao chép nguyên tệp; không chạy bất cứ thứ gì trong bản clone.
- Mỗi task kết thúc bằng: `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, và `npx jest <các tệp test của task>` đều sạch, rồi commit. Chạy cả bộ Jest (`npx jest`) một lần cuối mỗi task và ghi tên mọi kiểm thử đỏ vào báo cáo, kể cả cái không do mình gây ra.
- Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. Tham số tài khoản nằm ở chỗ không ngờ: `auth.zaloId`, mảng, chuỗi `"a,b"`, JSON trong query string. Task 1 và 3 có kiểm thử cho từng dạng.
2. Nhân viên không có tài khoản nào được dùng: không được rơi vào nhánh "không kiểm tra". Task 1, 3, 6.
3. Tên tệp tải lên có `../`, đường dẫn tuyệt đối, ký tự NUL, thư mục anh em cùng tiền tố (`media-x` so với `media`). Task 4.
4. Phiên phát hành cùng mili giây với mốc thu hồi; phiên cũ không có claim `ts`. Task 5.
5. Sự kiện gắn tài khoản nhưng thiếu mã tài khoản; nhận bù của một kết nối mới (`lastSeqId` = 0). Task 6.

---

### Task 1: `employeeAccess.ts`, quy tắc "tài khoản nhân viên được dùng"

**Files:**
- Create: `src/services/http/employeeAccess.ts`
- Test: `src/__tests__/http/employeeAccess.test.ts`

**Interfaces:**
- Produces:
  - `ACCOUNT_PARAM_KEYS: readonly string[]` = `zaloId, zalo_id, zaloIds, zalo_ids, ownerZaloId, owner_zalo_id, accountId, account_id, fbAccountId, sourceZaloId, targetZaloId`
  - `interface AccountRow { zalo_id: string; channel?: string | null; parent_zalo_id?: string | null }`
  - `isEmployeeUsableAccount(row: AccountRow): boolean`: false khi `channel === 'facebook'` và không có `parent_zalo_id` (Facebook cá nhân); true cho mọi dòng khác
  - `allowedAccounts(assigned: readonly string[], accounts: readonly AccountRow[]): string[]`: giữ thứ tự của `assigned`, chỉ giữ id có dòng trong `accounts` và `isEmployeeUsableAccount`
  - `requestedAccountIds(params: unknown): string[]`: gom mọi id ở các khoá `ACCOUNT_PARAM_KEYS` và ở `params.auth.zaloId`; nhận chuỗi, chuỗi `"a,b"`, mảng; bỏ rỗng; không trùng
  - `requiredModuleFor(pathname: string): string | undefined`
  - `interface AccessDenied { status: 403; code: 'ACCOUNT_FORBIDDEN' | 'MODULE_FORBIDDEN'; error: string }`
  - `checkEmployeeAccess(input: { allowed: readonly string[]; pathname: string; params: unknown; hasPermission: (module: string) => boolean }): AccessDenied | null`
  - `isEmployeeSettingReadable(key: string): boolean`, `isEmployeeSettingWritable(key: string): boolean`

- [ ] **Step 1: Viết kiểm thử đỏ** trong `src/__tests__/http/employeeAccess.test.ts`:
  - `isEmployeeUsableAccount`: `{channel:'facebook'}` → false; `{channel:'facebook', parent_zalo_id:'p'}` → true; `{channel:'zalo'}`, `{channel:'telegram_user'}`, `{}` → true.
  - `allowedAccounts(['b','x','a','fbp'], rows)` với rows gồm `a`, `b` (zalo), `fbp` (facebook cá nhân) → `['b','a']`.
  - `requestedAccountIds`: `{zaloId:'a'}`, `{zaloIds:['a','b']}`, `{zalo_ids:'a,b'}`, `{auth:{zaloId:'a'}}`, `{ownerZaloId:'a', accountId:'b'}`, `null`, `{zaloId:''}` → `[]`.
  - `checkEmployeeAccess`: id ngoài `allowed` ở bất kỳ khoá nào → `ACCOUNT_FORBIDDEN` (kể cả khi `allowed` rỗng: mọi id đều bị từ chối); không có id nào trong tham số → không từ chối vì tài khoản (handler tự báo thiếu tài khoản như hiện nay, nên nhân viên chỉ dùng ERP không bị ảnh hưởng); thiếu quyền module → `MODULE_FORBIDDEN`; chỉ kiểm các đường dẫn thuộc `/api/query/`, `/api/search/`, `/api/command/`, `/api/library/`, đường dẫn khác → `null`.
  - `requiredModuleFor`: `/api/query/analytics/…` → `analytics`; `/api/query/crm/…`, `/api/command/crm/…` → `crm`; `/api/query/erp/…`, `/api/command/erp/…` → `erp`; `/api/query/ai/…`, `/api/command/ai/…` → `ai_assistant`; `/api/query/workflows…`, `/api/command/workflows…` → `workflow`; `/api/query/integrations…`, `/api/command/integrations…` → `integration`; `/api/query/friends…`, `/api/query/friend-requests…`, `/api/command/friends…`, `/api/command/friend-requests…` → `friends`; `/api/query/messages…`, `/api/query/conversations…`, `/api/search/…` → `chat`; còn lại → `undefined`.
  - `isEmployeeSettingReadable('employee_jwt_secret')`, `('relay_ngrok_authtoken')`, `('sidebar_width')` → false (danh sách hiện rỗng: không chỗ nào trong giao diện nhân viên đọc cài đặt qua REST); `isEmployeeSettingWritable` tương tự.
- [ ] **Step 2: Chạy** `npx jest src/__tests__/http/employeeAccess.test.ts`, mong đợi FAIL vì chưa có module.
- [ ] **Step 3: Viết `employeeAccess.ts`** theo các chữ ký trên. Tệp không import gì ngoài kiểu. Hai hàm cài đặt đọc từ hai `ReadonlySet<string>` rỗng có tên `EMPLOYEE_READABLE_SETTING_KEYS`, `EMPLOYEE_WRITABLE_SETTING_KEYS`.
- [ ] **Step 4: Chạy lại**, mong đợi PASS.
- [ ] **Step 5: Commit** `feat(relay): rules for the accounts an employee may use`.

### Task 2: Gắn kiểm tra tài khoản và module vào các đường REST

**Files:**
- Create: `src/__tests__/http/relayHarness.ts` (tiện ích kiểm thử)
- Modify: `src/services/http/HttpRelayService.ts` (`authenticateRequest` ~2642, `handleRestApi` ~1266–1810, `executeRestCommand` ~1813, hai chỗ gọi thư viện ~565–570, `buildEmployeeSnapshot` ~285)
- Modify: `src/services/http/handlers/RestApiHandlers.ts` (`getSetting` ~516; dòng tích hợp)
- Test: `src/__tests__/http/relayRestAccess.test.ts`

**Interfaces:**
- Consumes: mọi export của Task 1.
- Produces:
  - `HttpRelayService.allowedAccountsFor(employeeId: string): string[]` (public): `allowedAccounts(EmployeeService.getAssignedAccounts(id), db.getAccounts())`, nhớ kết quả 5 giây theo nhân viên; `invalidateAllowedAccounts(employeeId?: string)` xoá bộ nhớ đó và được gọi trong `updateEmployeeRooms`, `refreshEmployeeState`, `kickEmployee`.
  - `authenticateRequest` gán `employee.assigned_accounts = allowedAccountsFor(employee.employee_id)` trên mọi yêu cầu, nên mọi chỗ sẵn có dùng `employee.assigned_accounts` tự dùng danh sách đã lọc.
  - Tiện ích kiểm thử `startRelay(opts: { employees: Array<{ id: string; assigned: string[]; modules: string[] }>; accounts: AccountRow[] }): Promise<{ url: string; tokenFor(id: string): string; handlerCalls: string[]; lastEmployeeArg(): any; close(): Promise<void> }>`: dựng `http.Server` gọi thẳng `handleHttpRequest` của `HttpRelayService`, với `jest.mock` cho `electron`, `DatabaseService`, `EmployeeService`, `SocketIOService`, `TunnelService`, `EventBroadcaster`, `ConnectionManager`, `FileStorageService`, và cho `handlers/RestApiHandlers` + `handlers/LibraryHandler` (mỗi handler ghi tên mình vào `handlerCalls` rồi trả `{ success: true, data: {} }`). Task 3, 4, 5 dùng lại.

- [ ] **Step 1: Viết `relayHarness.ts` và kiểm thử đỏ** `relayRestAccess.test.ts`:
  - Bảng đường dẫn: đọc `HttpRelayService.ts` bằng `fs`, lấy mọi chuỗi `'/api/query/…'`, `'/api/search/…'`, `'/api/command/…'`, `'/api/library/…'` xuất hiện trong so sánh `pathname ===` hoặc `startsWith(`. Với mỗi đường GET: nhân viên `emp-1` (được dùng `acc-a`, đủ mọi module) gọi kèm `?zaloId=acc-b` → HTTP 403, `code: 'ACCOUNT_FORBIDDEN'`, và `handlerCalls` không tăng. Với mỗi đường lệnh: gửi POST, PUT, PATCH, DELETE với body `{ zaloId: 'acc-b' }` → 403 ở phương thức mà đường đó nhận, và `handlerCalls` không tăng. Bảng phải có ít nhất 60 đường (chống việc regex quét hỏng âm thầm).
  - Cùng đường dẫn với `zaloId=acc-a` → không phải 403.
  - `emp-2` chỉ được gán một tài khoản Facebook cá nhân: `GET /api/query/conversations` kèm `zaloId` của tài khoản đó → 403 `ACCOUNT_FORBIDDEN`; không kèm `zaloId` → handler giả nhận một `employee` có `assigned_accounts` rỗng (tiện ích kiểm thử ghi lại đối số `employee` của lần gọi cuối).
  - `emp-3` không có module `analytics`: `GET /api/query/analytics/dashboard?zaloId=acc-a` → 403 `MODULE_FORBIDDEN`. Không có module `ai_assistant`: `POST /api/command/ai/chat` → 403.
  - `GET /api/query/settings` → 200 với `items` rỗng; `GET /api/query/settings/employee_jwt_secret` → 403; `PUT /api/command/settings/employee_jwt_secret` → 403 và `setSetting` của DB giả không được gọi.
  - `GET /api/query/settings/notif?zaloId=acc-a` → 200; `?zaloId=acc-b` → 403.
  - `GET /api/query/integrations` → không dòng nào có khoá `credentials_encrypted`.
  - Ảnh chụp trạng thái (`GET /api/sync/snapshot`) của `emp-1`: `employeesData` vẫn liệt kê mọi nhân viên (giao diện dùng để hiện tên người đã gửi tin) nhưng dòng của người khác chỉ còn `employee_id`, `display_name`, `avatar_url`; không dòng nào của người khác có `permissions`, `assigned_accounts`, `username`, `password_hash`; `accountsData` chỉ có `acc-a`, mỗi dòng có thêm `channel` và `parent_zalo_id`; không dòng nào có `cookies`, `imei`, `user_agent`.
- [ ] **Step 2: Chạy**, mong đợi FAIL (các yêu cầu sai tài khoản hiện trả 200).
- [ ] **Step 3: Sửa `HttpRelayService`**: thêm `allowedAccountsFor` / `invalidateAllowedAccounts`; gọi `checkEmployeeAccess` một lần ngay sau khi phân tích tham số trong `handleRestApi` (GET) và một lần ở đầu `executeRestCommand` (trên body đã phân tích, mọi phương thức), và trước khi gọi `libraryHandlers` cần đăng nhập; trả `this.json(res, 403, { success: false, error, code })`. Đường `/api/query/settings` (cả bảng) lọc qua `isEmployeeSettingReadable`; `/api/query/settings/:key` và `/api/command/settings/:key` từ chối khoá không được phép; đường `settings/notif` giữ nguyên nhưng đi qua kiểm tra tài khoản. Sửa `buildEmployeeSnapshot`: `employeesData` rút gọn dòng của nhân viên khác như trên; `accountsData` thêm `channel`, `parent_zalo_id`.
- [ ] **Step 4: Sửa `RestApiHandlers`**: dòng tích hợp trả cho nhân viên bỏ `credentials_encrypted`.
- [ ] **Step 5: Chạy lại** các test của task, mong đợi PASS; chạy kiểm kiểu và cả bộ Jest.
- [ ] **Step 6: Commit** `fix(relay): check assigned accounts and modules on every REST route`.

### Task 3: Danh sách đóng cho lệnh chuyển tiếp

**Files:**
- Modify: `src/services/http/relayChannelPolicy.ts`
- Modify: `src/services/http/HttpRelayService.ts` (`executeProxyAction` ~698–724, `channelToModule` ~2705; nhánh dự phòng `_invokeHandlers` ~1076)
- Test: `src/__tests__/http/relayChannelPolicy.test.ts` (sửa), `src/__tests__/http/relayProxyAccess.test.ts` (mới)

**Interfaces:**
- Consumes: `requestedAccountIds`, `relayHarness`.
- Produces:
  - `interface EmployeeChannelRule { modules: readonly string[]; account: 'default' | 'none' }` (`modules` rỗng = không cần module; nhân viên cần MỘT trong các module; `account: 'default'` = dùng tài khoản trong tham số, thiếu thì tài khoản được dùng đầu tiên, nhân viên không có tài khoản nào thì từ chối)
  - `employeeChannelRule(channel: unknown): EmployeeChannelRule | null`
  - `isEmployeeChannelAllowed(channel: unknown): boolean` giữ nguyên chữ ký (= `employeeChannelRule(channel) !== null`)
  - `EMPLOYEE_PROXY_CHANNELS: readonly string[]` (mọi tên lệnh được phép)

**Danh sách lệnh (đóng, chính xác):**
- `login:connect` → modules `[]`, account `default`.
- `zalo:*`: đúng tập handler đăng ký trong `electron/ipc/zaloIpc.ts` (90 lệnh qua `wrap(` cộng `zalo:getContext`, `zalo:getLabels`, `zalo:updateLabels`), viết tường minh từng tên → modules `['chat']`, riêng các lệnh kết bạn (`acceptFriendRequest`, `rejectFriendRequest`, `sendFriendRequest`, `undoFriendRequest`, `removeFriend`, `getFriends`, `getFriendRecommendations`, `getFriendRequestStatus`, `getSentFriendRequests`, `findUser`, `blockUser`, `unblockUser`, `changeFriendAlias`, `getAliasList`) → `['friends','chat']`; account `default`.
- `crm:saveNote`, `crm:deleteNote`, `crm:saveCampaign`, `crm:deleteCampaign`, `crm:cloneCampaign`, `crm:updateCampaignStatus`, `crm:addCampaignContacts` → `['crm']`, `default`.
- `ai:listAssistants`, `ai:getAssistant`, `ai:getDefault`, `ai:saveAssistant`, `ai:deleteAssistant`, `ai:testAssistant`, `ai:getFiles`, `ai:uploadFile`, `ai:removeFile`, `ai:getAccountAssistant`, `ai:setAccountAssistant`, `ai:getAccountAssistants`, `ai:getUsageLogs`, `ai:getUsageStats` → `['ai_assistant']`, account `none` trừ ba lệnh `…AccountAssistant…` là `default`.
- `integration:save`, `integration:delete`, `integration:toggle` → `['integration']`, `none`.
- `db:`: đúng các tên xuất hiện dưới dạng chuỗi trong lời gọi `proxyToBoss('db:…'` ở `electron/` → `['chat']`, `default`; riêng `db:addFriend`, `db:removeFriend`, `db:removeFriendRequest`, `db:saveFriends`, `db:upsertFriendRequest` → `['friends','chat']`.

- [ ] **Step 1: Sửa kiểm thử đỏ** `relayChannelPolicy.test.ts`:
  - Giữ nguyên bảng `bossOnly` hiện có; thêm vào đó `db:setStoragePath`, `db:saveAccount`, `db:selectStorageFolder`, `db:getSetting`, `db:setSetting`, `ai:chat`, `ai:generateImage`, `zalo:`, `db:`.
  - Kiểm thử quét nguồn: mọi chuỗi kênh trong `proxyToBoss('…'`, `proxyToBossWithResult('…'`, `proxyAction('…'` (kể cả đối số thứ hai) ở `electron/**/*.ts` và `src/ui/**/*.{ts,tsx}` phải có trong `EMPLOYEE_PROXY_CHANNELS`.
  - Kiểm thử quét nguồn: tập `zalo:*` trong `EMPLOYEE_PROXY_CHANNELS` bằng đúng tập handler `zalo:*` đăng ký trong `electron/ipc/zaloIpc.ts`.
  - Bỏ bốn tên `db:saveStickers`, `db:upsertGroupMember`, `db:saveFriendRequests`, `db:upsertBankCard` khỏi bảng "allows" nếu kiểm thử quét không tìm thấy chỗ nào gửi chúng; nếu tìm thấy thì thêm vào danh sách và ghi vào báo cáo.
- [ ] **Step 2: Viết kiểm thử đỏ** `relayProxyAccess.test.ts` (qua `relayHarness`, `POST /api/proxy/action`, handler IPC giả đăng ký trong `ipcMain._invokeHandlers` của mock `electron`):
  - `db:setStoragePath` → từ chối, handler giả không chạy.
  - `zalo:sendMessage` với `{ auth: { zaloId: 'acc-b' } }`, với `{ ownerZaloId: 'acc-b' }`, với `{ zaloId: 'acc-a', targetZaloId: 'acc-b' }` → từ chối cả ba.
  - Nhân viên không có tài khoản nào được dùng gọi `zalo:sendMessage` không kèm id → từ chối (trước đây lọt).
  - Nhân viên không có module `crm` gọi `crm:saveNote`; không có module `chat` gọi `db:markAsRead` → từ chối.
  - `zalo:sendMessage` với `{ zaloId: 'acc-a' }` → handler giả chạy đúng một lần.
- [ ] **Step 3: Chạy**, mong đợi FAIL.
- [ ] **Step 4: Viết lại `relayChannelPolicy.ts`** theo danh sách trên; sửa `executeProxyAction`: lấy `rule`; `requestedAccountIds(params)` phải nằm trọn trong `employee.assigned_accounts`; `account: 'default'` mà không có id và không có tài khoản nào → từ chối; kiểm `rule.modules`; xoá `channelToModule`. Nhánh dự phòng `_invokeHandlers` chỉ chạy cho lệnh đã qua `employeeChannelRule`.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `fix(relay): closed list of channels an employee may run on the boss`.

### Task 4: Tệp tải lên, đường dẫn tệp trong lệnh, media và thư viện

**Files:**
- Create: `src/services/http/bossFileAccess.ts`
- Modify: `src/services/http/HttpRelayService.ts` (`handleMediaUploadMultipart` ~1217, nhánh media ~1270, thư viện ~1294, `executeProxyAction`)
- Modify: `src/services/http/handlers/MediaHandler.ts` (so sánh tiền tố ~86)
- Modify: `electron/main.ts` (gắn phiên vào yêu cầu tới máy boss)
- Create: `src/services/http/bossRequestAuth.ts`
- Test: `src/__tests__/http/bossFileAccess.test.ts`, `src/__tests__/http/relayFileAccess.test.ts`, `src/__tests__/http/bossRequestAuth.test.ts`

**Interfaces:**
- Produces (`bossFileAccess.ts`, thuần, chỉ import `path`):
  - `safeUploadName(raw: unknown): string | null`: `path.basename` của tên đã đổi `\` thành `/`; null khi rỗng, là `.` hoặc `..`, chứa NUL, hoặc dài hơn 255
  - `isInside(root: string, target: string): boolean`: `target === root` hoặc bắt đầu bằng `root + path.sep` (cả hai đã `path.resolve`)
  - `mediaAccountOf(mediaRoot: string, absolutePath: string): string | null`: thư mục con đầu tiên dưới `mediaRoot` (mã tài khoản), null khi ngoài `mediaRoot`
  - `PROXY_FILE_PATH_FIELDS: readonly string[]` = `filePath, videoPath, thumbPath, voicePath, avatarPath, mediaPath` và trường mảng `filePaths`
  - `checkProxyFilePaths(params: unknown, ctx: { mediaRoot: string; uploadsRoot: string; allowed: readonly string[]; realpath: (p: string) => string }): { ok: true } | { ok: false; code: 'PATH_FORBIDDEN' | 'ACCOUNT_FORBIDDEN' }`: mọi đường dẫn phải, sau `realpath`, nằm trong `uploadsRoot` hoặc trong `mediaRoot/<id thuộc allowed>`
- Produces (`bossRequestAuth.ts`, thuần):
  - `bossAuthHeaderFor(requestUrl: string, workspace: { bossUrl?: string; token?: string } | null): string | null`: trả `Bearer <token>` khi `requestUrl` cùng origin với `bossUrl` và đường dẫn bắt đầu bằng `/api/media/` hoặc `/api/library/`; còn lại null

- [ ] **Step 1: Kiểm thử đỏ `bossFileAccess.test.ts`**: `safeUploadName('../../x.png')` → `'x.png'`; `'..'`, `''`, `'a\0b'`, chuỗi 300 ký tự → null; `'C:\\Users\\a\\b.jpg'` → `'b.jpg'`. `isInside('/m/media', '/m/media-x/a')` → false; `('/m/media','/m/media/a')` → true. `checkProxyFilePaths`: đường dẫn trong `mediaRoot/acc-a` với allowed `['acc-a']` → ok; trong `mediaRoot/acc-b` → `ACCOUNT_FORBIDDEN`; `/etc/passwd` → `PATH_FORBIDDEN`; liên kết tượng trưng trỏ ra ngoài (qua `realpath` giả) → `PATH_FORBIDDEN`; `filePaths` có một phần tử xấu → từ chối.
- [ ] **Step 2: Kiểm thử đỏ `relayFileAccess.test.ts`** (qua `relayHarness`, thư mục tạm thật trong `os.tmpdir()`):
  - Tải lên với `X-Filename: ../../evil.txt`, `X-Zalo-Id: acc-a` → 200, tệp nằm trong thư mục của `acc-a`, không có tệp nào ngoài thư mục tạm của tài khoản.
  - Tải lên với `X-Zalo-Id: acc-b` hoặc `X-Zalo-Id: ../x` → 403, không tệp nào được ghi.
  - `GET /api/media/acc-a/…` không token → 401; token của nhân viên chỉ được dùng `acc-b` → 403; đúng nhân viên → 200.
  - `GET /api/library/file/<uuid>` không token → 401.
  - `POST /api/proxy/action` `zalo:sendFile` với `filePath: '/etc/hosts'` → từ chối, handler giả không chạy.
  - (Thêm sau review Task 2) `X-Zalo-Id` của `/api/media/upload` là chuỗi `"acc-a,acc-b"` hoặc rỗng khi nhân viên không có tài khoản nào → 403.
- [ ] **Step 3: Kiểm thử đỏ `bossRequestAuth.test.ts`**: cùng origin + `/api/media/x` → `Bearer t`; khác origin, khác cổng, `/api/query/x`, workspace null hoặc thiếu token, URL hỏng → null.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết hai tệp thuần; sửa `HttpRelayService`** (tải lên dùng `safeUploadName`, id phải thuộc `employee.assigned_accounts`, đường ghi cuối phải `isInside` thư mục tài khoản; nhánh không có id ghi vào `_uploads` với tên đã làm sạch; media và thư viện gọi `authenticateRequest`, media kiểm `mediaAccountOf` thuộc danh sách được dùng; `executeProxyAction` gọi `checkProxyFilePaths` trước khi chạy handler). Sửa `MediaHandler` dùng `isInside`.
- [ ] **Step 6: Sửa `electron/main.ts`**: một lần sau khi tạo cửa sổ chính, đăng ký `session.defaultSession.webRequest.onBeforeSendHeaders` gọi `bossAuthHeaderFor(details.url, activeWorkspace)` và gắn header `Authorization` khi có giá trị; không đổi yêu cầu nào khác. Nếu `electron/main.ts` đã có một `onBeforeSendHeaders`, gộp vào hàm đó (Electron chỉ giữ một listener).
- [ ] **Step 7: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 8: Commit** `fix(relay): confine uploads and file paths, require login for media`.

### Task 5: Phiên đăng nhập thu hồi được

**Files:**
- Create: `src/services/employee/employeeTokenPolicy.ts`
- Modify: `src/services/employee/EmployeeService.ts` (`authenticate` ~264, `validateToken` ~299, `updateEmployee` ~138, `deleteEmployee` ~170, khởi tạo khoá ~28)
- Modify: `src/services/http/HttpRelayService.ts` (`authenticateRequest`, `kickEmployee`, `handleLogin`), `src/services/socket/SocketIOService.ts` (ngắt socket khi thu hồi)
- Test: `src/__tests__/employee/employeeTokenPolicy.test.ts`, `src/__tests__/employee/employeeTokenRevocation.test.ts`, `src/__tests__/http/relayLoginLimit.test.ts`

**Interfaces:**
- Produces (`employeeTokenPolicy.ts`, thuần):
  - `JWT_SECRET_VERSION = 2`
  - `planJwtSecretInit(existing: string | null, version: number | null): 'create' | 'rotate' | 'keep'`: không có khoá → create; version < 2 hoặc null → rotate; còn lại keep
  - `tokenIssuedAtMs(claims: { ts?: unknown; iat?: unknown }): number`: `ts` (ms) nếu là số hữu hạn, không thì `iat * 1000`, không có cả hai → 0
  - `evaluateEmployeeToken(input: { issuedAtMs: number; employee: { is_active: number } | null; validAfterMs: number }): 'ok' | 'unavailable' | 'inactive' | 'revoked'`: `revoked` khi `issuedAtMs <= validAfterMs`
  - `nextRevocationMark(nowMs: number, currentMark: number, lastIssuedMs: number): number` = `max(nowMs, currentMark + 1, lastIssuedMs)`
  - `LoginThrottle` (lớp thuần, nhận `now()`): `isLocked(username): boolean`, `recordFailure(username)`, `recordSuccess(username)`; khoá 15 phút sau 5 lần sai trong 15 phút; khoá theo tên đăng nhập viết thường
- Produces (`EmployeeService`):
  - `validateToken(token)` trả thêm `reason?: 'invalid' | 'unavailable' | 'inactive' | 'revoked'`; chỉ nhận HS256; `valid` chỉ true khi `evaluateEmployeeToken` là `ok`
  - `revokeEmployeeTokens(employeeId: string): void`: ghi mốc vào `app_settings` khoá `employee_tokens_valid_after_<id>`; `authenticate` ghi `employee_tokens_last_issued_<id>` và thêm claim `ts: Date.now()`
  - `updateEmployee` gọi `revokeEmployeeTokens` khi `is_active` chuyển về 0 hoặc đổi mật khẩu; `deleteEmployee` luôn gọi

- [ ] **Step 1: Kiểm thử đỏ `employeeTokenPolicy.test.ts`**: bảng cho `planJwtSecretInit`; `tokenIssuedAtMs({ts:5})` → 5, `({iat:2})` → 2000, `({})` → 0; `evaluateEmployeeToken`: nhân viên null → `unavailable`, `is_active: 0` → `inactive`, phát hành đúng mili giây của mốc → `revoked`, sau mốc 1 ms → `ok`; `nextRevocationMark(100, 100, 100)` → 101; `LoginThrottle`: 5 lần sai → khoá, sau 15 phút mở, thành công xoá bộ đếm, `'Admin'` và `'admin'` chung bộ đếm.
- [ ] **Step 2: Kiểm thử đỏ `employeeTokenRevocation.test.ts`** (EmployeeService thật với DB giả trong bộ nhớ theo mẫu sẵn có trong `src/__tests__/`; không mạng): đăng nhập → token hợp lệ; đổi mật khẩu → token cũ `revoked`, đăng nhập lại ngay trong cùng mili giây → token mới hợp lệ; tắt nhân viên → `inactive`; xoá → `unavailable`; token ký bằng `alg: none` hoặc HS384 → `invalid`; DB có khoá cũ không có `employee_jwt_secret_version` → khoá được đổi một lần, token ký bằng khoá cũ → `invalid`, lần khởi tạo thứ hai không đổi nữa.
- [ ] **Step 3: Kiểm thử đỏ `relayLoginLimit.test.ts`** (qua `relayHarness`): 5 lần `POST /api/auth/login` sai → lần thứ 6 trả 429 kể cả khi mật khẩu đúng; yêu cầu với token của nhân viên vừa bị `kickEmployee` → 401; nhân viên đã có trong bộ nhớ của relay rồi bị tắt → yêu cầu kế tiếp 401.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết `employeeTokenPolicy.ts`; sửa `EmployeeService`, `HttpRelayService`** (`authenticateRequest` dùng `validateToken` mới trên mọi yêu cầu, không tin bản ghi trong bộ nhớ; `kickEmployee` gọi `revokeEmployeeTokens` và `SocketIOService.disconnectEmployee(employeeId)`; `handleLogin` dùng `LoginThrottle`) **và `SocketIOService`** (`disconnectEmployee(employeeId: string): void` ngắt mọi socket trong phòng `emp:<id>`).
- [ ] **Step 6: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 7: Commit** `fix(employee): revocable login tokens, rotated signing key, login throttle`.

### Task 6: Sự kiện chỉ tới đúng người

**Files:**
- Create: `src/services/socket/relayAudience.ts`
- Modify: `src/services/socket/EventBuffer.ts`, `src/services/socket/SocketIOService.ts` (`emitToEmployee` ~165, `catch-up` ~119), `src/services/http/HttpRelayService.ts` (`relayEventToEmployees` ~2491, phát `relay:messageSentByEmployee` ~1057)
- Test: `src/__tests__/socket/relayAudience.test.ts`, `src/__tests__/socket/eventBufferAudience.test.ts`, `src/__tests__/socket/socketCatchUp.test.ts`

**Interfaces:**
- Produces (`relayAudience.ts`, thuần):
  - `type RelayAudience = { kind: 'everyone' } | { kind: 'nobody' } | { kind: 'accounts'; ids: string[] } | { kind: 'employees'; ids: string[] }`
  - `GLOBAL_RELAY_CHANNELS: ReadonlySet<string>` = `library:itemAdded`, `library:itemUpdated`, `library:itemDeleted`
  - `classifyRelayEvent(channel: string, data: unknown): RelayAudience`: kênh trong `GLOBAL_RELAY_CHANNELS` → everyone; id tài khoản lấy từ `zaloId`, `zalo_id`, `ownerZaloId`, `owner_zalo_id`, `accountId`, `account_id`, `fbAccountId`, `message.zaloId` → accounts; không có id → **nobody**
  - `canReceiveRelayEvent(audience: RelayAudience, employeeId: string, allowed: readonly string[]): boolean`
- Produces (`EventBuffer`): `push(channel, data, audience)` lưu `audience` kèm sự kiện; `getSince(seqId)` giữ nguyên.
- Produces (`SocketIOService`): `publish(channel: string, data: unknown, audience: RelayAudience): void` (lưu bộ đệm một lần, phát tới từng phòng nhân viên đang nối mà `canReceiveRelayEvent` đúng); `setAllowedAccountsResolver(fn: (employeeId: string) => string[]): void`; handler `catch-up` lọc bằng `canReceiveRelayEvent`. `emitToEmployee` còn lại cho sự kiện ERP đích danh, lưu với audience `employees: [id]`.

- [ ] **Step 1: Kiểm thử đỏ `relayAudience.test.ts`**: mỗi khoá id cho ra `accounts`; `event:message` không có id → `nobody`; `crm:campaignChanged`, `workflow:executed`, `integration:payment` không có id → `nobody`; `library:itemAdded` → `everyone`; `canReceiveRelayEvent`: `accounts ['a']` với allowed `[]` → false, allowed `['a']` → true; `nobody` → false; `employees ['e1']` → chỉ `e1`.
- [ ] **Step 2: Kiểm thử đỏ `eventBufferAudience.test.ts` và `socketCatchUp.test.ts`** (SocketIOService thật trên cổng tạm của `127.0.0.1`, client `socket.io-client` sẵn có trong repo, `EmployeeService.validateToken` giả): `publish` ba sự kiện cho `acc-a`, `acc-b`, và một sự kiện `nobody`; nhân viên chỉ được dùng `acc-a` nối mới và gửi `catch-up { lastSeqId: 0 }` → chỉ nhận sự kiện của `acc-a`; sự kiện phát trực tiếp cho `acc-b` không tới socket đó; nhân viên không có tài khoản nào không nhận gì.
- [ ] **Step 3: Chạy**, FAIL.
- [ ] **Step 4: Viết `relayAudience.ts`; sửa ba tệp**. `relayEventToEmployees` gọi `classifyRelayEvent` rồi `SocketIOService.publish` (giữ nguyên nhánh ERP `shouldRelayErpEventToEmployee`, đổi nó sang audience `employees`). `relay:messageSentByEmployee` phát qua `publish` với audience `accounts: [zaloId]` thay vì gửi cho mọi nhân viên. `HttpRelayService.start` gọi `setAllowedAccountsResolver(id => this.allowedAccountsFor(id))`.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `fix(relay): deliver and replay events only to employees who may use the account`.

### Task 8: Bản ghi gọi theo mã phải thuộc tài khoản được dùng

Thêm ngày 17/11/2026 sau review của Task 2: các lệnh gọi một bản ghi theo mã riêng (xoá nhãn `labels/:id`, sửa nhãn với `label.id` của tài khoản khác, mục thư viện theo uuid…) không mang mã tài khoản, nên phép kiểm của Task 2 và 3 không thấy. Chạy sau Task 6, trước Task 7.

**Files:**
- Create: `src/services/http/recordOwnership.ts`
- Modify: `src/services/http/HttpRelayService.ts` (`denyRest`, `executeProxyAction`), `src/services/http/handlers/LibraryHandler.ts`
- Test: `src/__tests__/http/recordOwnership.test.ts`, `src/__tests__/http/relayRecordOwnership.test.ts`

**Interfaces:**
- Produces (`recordOwnership.ts`, thuần):
  - `interface RecordRef { table: string; idColumn: string; ownerColumn: string; id: string }`
  - `recordRefsFor(target: { kind: 'rest'; method: string; pathname: string; params: unknown } | { kind: 'proxy'; channel: string; params: unknown }): RecordRef[]`: bảng tra tĩnh từ đường dẫn REST hoặc tên lệnh sang bản ghi mà yêu cầu đó đọc, sửa hoặc xoá theo mã
  - `isRecordAllowed(ownerValue: unknown, allowed: readonly string[]): boolean`: `ownerValue` là một mã tài khoản, chuỗi `"a,b"` hoặc mảng (nhãn áp cho nhiều tài khoản); đúng khi MỌI mã đều thuộc `allowed`; bản ghi không tìm thấy (`undefined`) → đúng (handler tự báo không có); chủ rỗng (`''`, `null`) → sai

**Quy tắc:** bản ghi thuộc bảng có cột tài khoản chủ chỉ được đọc, sửa, xoá khi chủ thuộc danh sách được dùng. Bảng không có cột tài khoản chủ (trợ lý AI, workflow, tích hợp, ERP) chỉ kiểm quyền module như hiện nay và không nằm trong bảng tra.

- [ ] **Step 1: Liệt kê.** Đọc `executeRestCommand`, các nhánh GET của `handleRestApi`, `RestApiHandlers.ts`, `LibraryHandler.ts` và mọi handler của các lệnh trong `EMPLOYEE_PROXY_CHANNELS` có tiền tố `db:` và `crm:`. Ghi vào báo cáo một bảng: đường dẫn hoặc lệnh, tham số mang mã bản ghi, bảng SQL, cột mã, cột tài khoản chủ. Chỉ đưa vào bảng tra những dòng mà handler dùng mã bản ghi mà KHÔNG ràng thêm `WHERE <cột chủ> = <tài khoản đã kiểm>` trong câu SQL; ghi rõ những dòng đã được SQL ràng sẵn.
- [ ] **Step 2: Kiểm thử đỏ `recordOwnership.test.ts`**: mỗi dòng của bảng tra có một ca; `isRecordAllowed('a', ['a'])` đúng, `('b', ['a'])` sai, `('a,b', ['a'])` sai, `(['a'], ['a','b'])` đúng, `(undefined, ['a'])` đúng, `('', ['a'])` sai, `(null, [])` sai.
- [ ] **Step 3: Kiểm thử đỏ `relayRecordOwnership.test.ts`** (qua `relayHarness`, DB giả trả chủ theo bảng): với mỗi dòng của bảng tra, nhân viên chỉ được dùng `acc-a` gọi bản ghi của `acc-b` → 403 `ACCOUNT_FORBIDDEN` và handler không chạy; bản ghi của `acc-a` → không phải 403. Riêng thư viện: `GET /api/library/items/<uuid>`, `DELETE`, và tệp + ảnh thu nhỏ của mục thuộc `acc-b` → 403.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết `recordOwnership.ts`; gọi nó** trong `denyRest` (sau kiểm tài khoản và module) và trong `executeProxyAction` (trước khi chạy handler): với mỗi `RecordRef`, đọc chủ bằng một câu `SELECT <ownerColumn> FROM <table> WHERE <idColumn> = ?` (tên bảng và cột chỉ lấy từ bảng tra tĩnh, không bao giờ từ yêu cầu), từ chối khi `isRecordAllowed` sai. `LibraryHandler` kiểm chủ của mục trước khi trả mục, tệp, ảnh thu nhỏ hoặc xoá.
- [ ] **Step 6: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 7: Commit** `fix(relay): records addressed by id must belong to an account the employee may use`.

### Task 7: Tài liệu, ghi nhận nguồn, phiên bản

**Files:**
- Modify: `SYSTEM_DOCUMENTATION.md` (mục 3.4, 4.7, 10.2, 22; dòng phiên bản), `NOTICE.md`, `docs/specs/2026-11-17-employee-shared-inbox.md` (dòng Trạng thái), `src/ui/components/settings/ChangelogSettings.tsx` (mục 26.45.0 trên cùng), `package.json`, `package-lock.json` (hai chỗ `version` đầu tệp)

- [ ] **Step 1:** `SYSTEM_DOCUMENTATION.md`: mục 3.4 và 4.7 mô tả các quy tắc mới (tài khoản được dùng, Facebook cá nhân không dùng được ở chế độ nhân viên, danh sách lệnh đóng, tệp, phiên thu hồi được, người nhận sự kiện), kèm dấu `<!-- docs-check: … -->` cho `JWT_SECRET_VERSION = 2`; mục 10.2 bỏ câu "enforcement thực tế phải được kiểm tra thêm" và thay bằng nơi kiểm tra; cập nhật dòng phiên bản `26.45.0`.
- [ ] **Step 2:** `NOTICE.md`: thêm một dòng vào bảng thay đổi: các quy tắc kiểm soát truy cập của nhân viên được viết lại theo thiết kế của bản gốc 26.11.1 (commit `515f1dc`), chuyển bằng tay.
- [ ] **Step 3:** Mục changelog 26.45.0 (tiếng Việt, xưng "bạn"): nhân viên phải đăng nhập lại một lần; máy boss và máy nhân viên phải cùng cập nhật; nhân viên không còn dùng được tài khoản Facebook cá nhân.
- [ ] **Step 4:** Tăng version lên `26.45.0`; dòng Trạng thái của spec: anh duyệt 17/11/2026, đợt 1 triển khai trong 26.45.0.
- [ ] **Step 5:** `node scripts/check-docs.js` → `docs-check: OK`.
- [ ] **Step 6: Commit** `feat(release): 26.45.0 — employee access control on the boss relay`.
