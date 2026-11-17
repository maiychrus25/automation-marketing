# Hộp thư Page cho nhân viên (đợt 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhân viên được gán một Page Facebook dùng được hộp thư của Page đó từ máy mình: thấy hội thoại, nhận tin trong vài giây, gửi chữ / ảnh / tệp / nhãn dán, thả cảm xúc, tải tin cũ; boss thấy tin nào do nhân viên nào gửi. Tài khoản Facebook cá nhân vẫn không dùng được với nhân viên.

**Architecture:** Phiên Facebook chỉ chạy trên máy boss. Máy nhân viên gọi các handler `fb:*` như thường; một lớp bọc `ipcMain` ở máy nhân viên chuyển các lệnh thuộc nhóm "chuyển lên boss" tới `POST /api/proxy/action`, máy boss kiểm rồi chạy chính handler thật của nó. Sự kiện `fb:on*` đi qua bộ lọc người nhận đã có từ 26.45.0. Mọi quyết định cho/từ chối nằm trong tệp thuần.

**Tech Stack:** TypeScript 5, Electron 41, React 18, Socket.IO, better-sqlite3, Jest + ts-jest.

**Spec:** `docs/specs/2026-11-17-employee-shared-inbox.md` (mục 3.1, 3.3, 3.4, 3.5, 5).

## Global Constraints

- Nhánh `feat/employee-page-inbox`. Không push, không tag: người điều phối làm việc đó sau khi kiểm tra xong.
- Không bao giờ `git add` `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. Chỉ `git add` đúng các tệp của task.
- Định danh trong code bằng tiếng Anh. Chuỗi hiển thị cho người dùng bằng tiếng Việt, xưng "bạn". Comment theo ngôn ngữ của tệp đang sửa.
- Đóng mặc định: lệnh `fb:*` chưa được xếp nhóm thì không chuyển lên boss và máy boss từ chối.
- Không ghi vào log: cookie, token, nội dung tin, đường dẫn tải tệp, payload sự kiện. Log từ chối chỉ gồm mã nhân viên, tên lệnh, mã lý do.
- Kiểm thử không gọi Facebook, Zalo, Telegram thật; không đọc cơ sở dữ liệu thật; dữ liệu mẫu tổng hợp (`acc-a`, `page-1`, `fb-personal`, `emp-1`…).
- **Dữ liệu mẫu phải đúng hình dạng thật:** bảng `accounts` KHÔNG có cột `parent_zalo_id`; một Page là dòng `accounts` (`zalo_id` = `facebook_id` của Page, `channel = 'facebook'`) cộng một dòng `fb_accounts` có `parent_facebook_id`. Kiểm thử nào dựng tài khoản Facebook phải dựng đủ hai bảng, không tự viết `parent_zalo_id` vào dòng `accounts`.
- Hành vi của boss khi dùng một mình và của nhân viên dùng Zalo không đổi. Handler `fb:*` chạy trên máy boss cho boss giữ nguyên kết quả.
- Không sửa hai kiểm thử nhạy tải (`mobileSyncService.test.ts › longRunOfSkippedRowsYieldsAndHonoursCancel`, `pageCampaignAutonomy.integration.test.ts › 50 distinct contenders…`), không tăng timeout của chúng.
- Không thêm dependency. Không tái cấu trúc ngoài chỗ task nêu.
- Mỗi task kết thúc bằng: `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, `npx jest <các tệp test của task>` sạch, rồi commit. Chạy cả bộ `npx jest` một lần cuối mỗi task và ghi tên mọi kiểm thử đỏ vào báo cáo.
- Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. Tài khoản Facebook cá nhân lọt vào đâu đó dưới danh nghĩa Page: `accountId` là UUID của `fb_accounts`, là `facebook_id` của tài khoản cha, hoặc bị bỏ trống. Task 1, 2.
2. Lệnh `fb:*` chạy tại máy nhân viên thay vì lên boss (hoặc ngược lại, lệnh quản trị chạy được trên boss). Task 2, 3.
3. Gửi nhiều tệp mất hơn 30 giây; tải tin cũ mất tới 60 giây. Task 3.
4. Sự kiện của Page tới nhân viên không được gán Page đó; nhân viên mới nối nhận bù sự kiện của Page khác. Task 4.
5. Máy nhân viên coi Page là tài khoản Zalo (thiếu `channel`, `parent_zalo_id`) và gửi tin qua đường Zalo. Task 5.

---

### Task 1: Máy boss nhận ra Page; sửa quy tắc đang loại nhầm Page

Bản 26.45.0 gọi `allowedAccounts(assigned, db.getAccounts())`, mà dòng `accounts` không có `parent_zalo_id`, nên mọi tài khoản Facebook (kể cả Page) bị coi là cá nhân và bị loại.

**Files:**
- Create: `src/services/http/accountRows.ts`
- Modify: `src/services/http/HttpRelayService.ts` (`allowedAccountsFor` ~299, `buildEmployeeSnapshot` ~315–380), `electron/ipc/loginIpc.ts` (`login:getAccounts` ~232–270, dùng chung hàm mới), `src/__tests__/http/relayHarness.ts` (DB giả có `getFBAccounts`)
- Test: `src/__tests__/http/accountRows.test.ts`, `src/__tests__/http/relayPageAccounts.test.ts`

**Interfaces:**
- Produces (`accountRows.ts`, thuần):
  - `interface FbAccountRef { facebook_id?: string | null; parent_facebook_id?: string | null }`
  - `withFacebookParents<T extends { zalo_id: string; channel?: string | null }>(accounts: readonly T[], fbAccounts: readonly FbAccountRef[]): Array<T & { parent_zalo_id: string | null }>`: với dòng `channel === 'facebook'`, `parent_zalo_id` = `parent_facebook_id` của dòng `fb_accounts` có `facebook_id === zalo_id` (không có thì `null`); dòng kênh khác: `null`
  - `isAccountOnline(row: { zalo_id: string; channel?: string | null }, deps: { zaloConnected: (id: string) => boolean; facebookConnected: (facebookId: string) => boolean }): boolean`
- `HttpRelayService.allowedAccountsFor` và `buildEmployeeSnapshot` dùng `withFacebookParents(db.getAccounts(), db.getFBAccounts())`; `onlineAccounts` và `listener_active` của ảnh chụp trạng thái dùng `isAccountOnline` (Facebook: tài khoản đang có kết nối trong `FacebookConnectionManager`).

- [ ] **Step 1: Kiểm thử đỏ `accountRows.test.ts`**: Page (`fb_accounts` có `parent_facebook_id: 'fb-personal'`) → `parent_zalo_id: 'fb-personal'`; Facebook cá nhân → `null`; dòng Zalo → `null`; Page không có dòng `fb_accounts` tương ứng → `null` (đóng: bị coi là cá nhân); `isAccountOnline` cho cả hai kênh.
- [ ] **Step 2: Sửa `relayHarness.ts`** để DB giả có `getFBAccounts()` và các dòng `accounts` KHÔNG mang `parent_zalo_id`; các kiểm thử cũ dựng Page hay Facebook cá nhân chuyển sang dựng hai bảng (không đổi điều chúng khẳng định).
- [ ] **Step 3: Kiểm thử đỏ `relayPageAccounts.test.ts`** (qua harness): nhân viên được gán `page-1` (Page của `fb-personal`) và `fb-personal`: ảnh chụp trạng thái `accountsData` có đúng `page-1` với `channel: 'facebook'`, `parent_zalo_id: 'fb-personal'`, không có `fb-personal`; `GET /api/query/conversations?zaloId=page-1` → không 403; `?zaloId=fb-personal` → 403; Page đang nối thì `listener_active` đúng và có trong `onlineAccounts`.
- [ ] **Step 4: Chạy**, FAIL (hiện `page-1` bị loại).
- [ ] **Step 5: Viết `accountRows.ts`; sửa `HttpRelayService` và `loginIpc`** (loginIpc gọi `withFacebookParents`, kết quả cho giao diện boss giữ nguyên từng trường).
- [ ] **Step 6: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 7: Commit** `fix(relay): recognise Facebook Pages as accounts an employee may use`.

### Task 2: Phân loại lệnh `fb:*` và chạy lệnh của nhân viên trên máy boss

**Files:**
- Create: `src/services/http/employeeChannelRoutes.ts`
- Modify: `src/services/http/relayChannelPolicy.ts`, `src/services/http/HttpRelayService.ts` (`executeProxyAction` ~749–1150)
- Test: `src/__tests__/http/employeeChannelRoutes.test.ts`, `src/__tests__/http/relayFacebookProxy.test.ts`, `src/__tests__/http/relayChannelPolicy.test.ts` (sửa)

**Interfaces:**
- Produces (`employeeChannelRoutes.ts`, thuần):
  - `type EmployeeChannelRoute = 'proxy' | 'boss_only' | 'local'`
  - `interface EmployeeChannelSpec { route: EmployeeChannelRoute; modules?: readonly string[]; timeoutMs?: number; send?: boolean }`
  - `PROXY_DEFAULT_TIMEOUT_MS = 30000`, `PROXY_MEDIUM_TIMEOUT_MS = 60000`, `PROXY_SLOW_TIMEOUT_MS = 90000`
  - `FACEBOOK_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>>`
  - `employeeChannelSpec(channel: string): EmployeeChannelSpec | null`
  - `BOSS_ONLY_CHANNEL_ERROR = 'Thao tác này chỉ thực hiện được trên máy Boss'`, `BOSS_ONLY_CHANNEL_CODE = 'BOSS_ONLY'`
  - `employeeSendInfo(channel: string, params: unknown, result: unknown): { accountId: string; threadId: string; messageId: string } | null`: chỉ khác null khi lệnh có `send: true` và `result.success === true`; `messageId` = `result.messageId` (chuỗi, có thể rỗng khi lệnh không trả mã)
- `relayChannelPolicy.ts`: `EmployeeChannelRule.account` thêm giá trị `'required'` (bắt buộc có `accountId` trong tham số, không lấy tài khoản mặc định); mọi lệnh `proxy` của `FACEBOOK_CHANNEL_ROUTES` vào `EMPLOYEE_PROXY_CHANNELS` với `modules` của spec và `account: 'required'`.

**Phân loại (đóng, chính xác):**
- `proxy`, modules `['chat']`:
  - `fb:getThreads` (slow), `fb:getMessages`, `fb:fetchThreadMessages` (medium), `fb:fetchOlderMessages` (medium)
  - `fb:sendMessage` (medium, send), `fb:sendAttachment` (slow, send), `fb:sendAttachments` (slow, send), `fb:sendPageSticker` (medium, send), `fb:listPageStickers`
  - `fb:addReaction`, `fb:markAsRead`, `fb:sendSeen`, `fb:getUserInfoFacebookHtml`, `fb:refreshContactAvatar`
- `local`: `fb:saveScanLog`, `fb:getScanLogs`, `fb:scanResetCache`, `fb:scanSaveTab`, `fb:scanGetTabs`, `fb:scanGetTab`, `fb:scanUpdateTabStatus`, `fb:scanDeleteTab`, `fb:scanTouchTab`, `fb:scanSaveTabData`, `fb:scanGetTabData`, `fb:scanSaveRequestLog`, `fb:scanGetRequestLogs`, `fb:scanGetStats`
- `boss_only`: mọi handler `fb:*` còn lại trong `electron/ipc/facebookIpc.ts` và `electron/ipc/fbHistoryIpc.ts` (tài khoản, đăng nhập, cookie, kết nối, Page bật tắt, E2EE, đồng bộ lịch sử cả tài khoản, quét dữ liệu qua mạng, sửa / thu hồi / chuyển tiếp / ghim / bình chọn / nhóm / chặn / ghi chú).

- [ ] **Step 1: Kiểm thử đỏ `employeeChannelRoutes.test.ts`**:
  - Quét nguồn: mọi tên trong `ipcMain.handle('fb:…'` của hai tệp IPC phải có trong `FACEBOOK_CHANNEL_ROUTES`, và ngược lại không có tên thừa.
  - Từng lệnh `proxy` ở trên có đúng `modules`, `timeoutMs`, `send`.
  - `fb:updateCookie`, `fb:addAccount`, `fb:removeAccount`, `fb:connect`, `fb:setPageEnabled`, `fb:toggleE2EE`, `fb:historySync:start`, `fb:unsendMessage`, `fb:editMessage`, `fb:scanGroupMembers` → `boss_only`.
  - `employeeSendInfo('fb:sendMessage', { accountId: 'page-1', threadId: 't1' }, { success: true, messageId: 'mid.1' })` → đủ ba trường; kết quả `success: false` → null; `fb:addReaction` → null; `fb:sendAttachments` thành công không có `messageId` → `messageId: ''`.
- [ ] **Step 2: Kiểm thử đỏ `relayFacebookProxy.test.ts`** (qua harness, handler `fb:*` giả trong `ipcMain._invokeHandlers`, DB giả hai bảng):
  - `fb:sendMessage` `{ accountId: 'page-1', threadId: 't1', body: 'x' }` từ nhân viên được gán `page-1` → handler chạy một lần, nhận `_fromRelay: true`; kết quả của handler được trả nguyên.
  - `accountId: 'fb-personal'` (đã gán nhầm) → từ chối, handler không chạy. `accountId` là UUID nội bộ → từ chối. Thiếu `accountId` → từ chối với mã `ACCOUNT_REQUIRED` (không lấy tài khoản đầu tiên).
  - Nhân viên không có module `chat` → từ chối.
  - `fb:updateCookie`, `fb:removeAccount`, `fb:historySync:start` → từ chối, handler không chạy.
  - `fb:sendAttachment` với `filePath: '/etc/hosts'` → từ chối (quy tắc đường dẫn 26.45.0); với tệp trong thư mục media của `page-1` → chạy.
  - Sau `fb:sendMessage` thành công trả `messageId: 'mid.1'`: DB giả nhận `setMessageHandledByEmployee('page-1', 'mid.1', 'emp-1')` (hoặc hàm tương đương đang dùng cho Zalo), có một `logEmployeeAction` hành động `sent`, và `SocketIOService.publish` được gọi với `relay:messageSentByEmployee`, audience `accounts: ['page-1']`.
  - Sau `fb:sendAttachments` thành công không có `messageId`: tin mới nhất do Page gửi trong hội thoại đó được gắn nhân viên (nhánh dự phòng theo hội thoại đang dùng cho Zalo), không lỗi.
- [ ] **Step 3: Sửa `relayChannelPolicy.test.ts`**: bảng `bossOnly` thêm `fb:updateCookie`, `fb:addAccount`, `fb:removeAccount`, `fb:historySync:start`, `fb:toggleE2EE`; bảng "allows" thêm các lệnh `proxy`; kiểm thử quét nguồn hiện có vẫn xanh.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết `employeeChannelRoutes.ts`; sửa `relayChannelPolicy.ts` và `executeProxyAction`**: quy tắc `'required'`; sau khi handler của một lệnh `fb:*` trả về, gọi `employeeSendInfo` và ghi nhận người gửi bằng đúng các hàm đường Zalo đang dùng (không viết bản thứ hai của logic đó; tách phần dùng chung thành một hàm riêng trong `HttpRelayService` nếu cần).
- [ ] **Step 6: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 7: Commit** `feat(relay): run an employee's Page inbox commands on the boss`.

### Task 3: Máy nhân viên chuyển lệnh `fb:*` lên boss

**Files:**
- Modify: `electron/ipc/proxyHelper.ts`, `electron/ipc/zaloIpc.ts` (dùng `prepareLocalFilesForProxy` chung), `electron/ipc/facebookIpc.ts`, `electron/ipc/fbHistoryIpc.ts`, `src/services/http/HttpClientService.ts` (`proxyAction` ~213), `src/services/http/HttpConnectionManager.ts` (`proxyAction` ~193)
- Test: `src/__tests__/ipc/employeeRoutedIpc.test.ts`, `src/__tests__/facebook/fbHistoryIpc.test.ts` (sửa), `src/__tests__/facebook/pageSendIpc.test.ts` (giữ xanh)

**Interfaces:**
- Consumes: `employeeChannelSpec`, `BOSS_ONLY_CHANNEL_ERROR`, `BOSS_ONLY_CHANNEL_CODE`, các hằng timeout (Task 2).
- Produces (`proxyHelper.ts`):
  - `prepareLocalFilesForProxy(params: any, accountId?: string): Promise<any>` chuyển từ `zaloIpc.ts` sang đây và export (hành vi giữ nguyên; `zaloIpc.ts` import lại)
  - `proxyToBossWithResult(channel: string, params: any, opts?: { timeoutMs?: number }): Promise<any>`: không ném lỗi; mất kết nối trả `{ success: false, error: 'Chưa nối được máy Boss', code: 'NOT_CONNECTED' }`
  - `routeEmployeeChannel(channel: string, listener: (event: any, params: any) => any): (event: any, params: any) => any`: lệnh không có spec hoặc `local` → trả nguyên `listener`; còn lại trả hàm: nếu `params?._fromRelay` hoặc workspace đang dùng không phải `remote` → gọi `listener`; `boss_only` → `{ success: false, error: BOSS_ONLY_CHANNEL_ERROR, code: BOSS_ONLY_CHANNEL_CODE }`; `proxy` → tải tệp cục bộ lên boss (`prepareLocalFilesForProxy(params, params.accountId)`), rồi `proxyToBossWithResult(channel, prepared, { timeoutMs: spec.timeoutMs })`
  - `employeeRoutedIpcMain<T extends { handle: Function }>(target: T): T`: đối tượng có `handle(channel, listener)` gọi `target.handle(channel, routeEmployeeChannel(channel, listener))`, các thuộc tính khác chuyển thẳng tới `target`
- `HttpClientService.proxyAction(channel, params, timeoutMs?)` và `HttpConnectionManager.proxyAction(workspaceId, channel, params, timeoutMs?)`: tham số mới tuỳ chọn, mặc định 30000 như hiện nay.

- [ ] **Step 1: Kiểm thử đỏ `employeeRoutedIpc.test.ts`** (mock `WorkspaceManager`, `HttpConnectionManager`, `electron`):
  - Workspace cục bộ: listener gốc chạy cho cả ba nhóm.
  - Workspace `remote`: lệnh `proxy` → listener gốc KHÔNG chạy, `proxyAction` được gọi với đúng `channel`, `params` và `timeoutMs` của spec (`fb:sendAttachments` → 90000; `fb:addReaction` → 30000); kết quả của boss được trả nguyên.
  - `remote` + `boss_only` → trả lỗi `BOSS_ONLY`, không gọi listener, không gọi boss.
  - `remote` + `local` → listener gốc chạy.
  - `params._fromRelay` → listener gốc chạy dù đang `remote`.
  - `fb:sendAttachment` có `filePath` trỏ tới tệp tạm có thật → tệp được tải lên trước và `filePath` gửi đi là đường dẫn boss trả về; tải lên lỗi → `{ success: false, code: 'UPLOAD_FAILED' }`, không gọi boss.
  - Mất kết nối → `NOT_CONNECTED`, không ném.
  - `employeeRoutedIpcMain(fake).handle('fb:x', fn)` gọi `fake.handle` đúng một lần với cùng tên lệnh.
- [ ] **Step 2: Sửa kiểm thử `fbHistoryIpc.test.ts`**: ở workspace `remote`, `fb:fetchOlderMessages` được chuyển lên boss (không còn trả `NOT_CONNECTED` tại chỗ); `fb:historySync:start` trả `BOSS_ONLY`.
- [ ] **Step 3: Chạy**, FAIL.
- [ ] **Step 4: Viết các hàm trong `proxyHelper.ts`; sửa hai tệp IPC**: ngay sau import, `const ipcMain = employeeRoutedIpcMain(electronIpcMain);` (đổi tên import thành `electronIpcMain`), kể cả cho các handler đăng ký ở mức module cuối `facebookIpc.ts`. Bỏ nhánh chặn nhân viên của `fb:fetchOlderMessages` trong `fbHistoryIpc.ts` (lớp bọc lo việc đó); giữ nguyên `guardedSync` của ba lệnh đồng bộ lịch sử.
- [ ] **Step 5: Chạy lại**, PASS (kể cả `pageSendIpc.test.ts` và các test Facebook hiện có); kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(employee): route Page inbox commands from an employee machine to the boss`.

### Task 4: Sự kiện Facebook tới đúng nhân viên

**Files:**
- Modify: `src/services/http/HttpRelayService.ts` (`RELAY_CHANNELS` ~206), `src/services/http/HttpClientService.ts` (`FORWARD_CHANNELS` ~38), `electron/preload.ts` (`validChannels` ~751–881)
- Test: `src/__tests__/http/relayFacebookEvents.test.ts`, `src/__tests__/http/relayEventChannels.test.ts`

**Interfaces:**
- Produces: `FACEBOOK_RELAY_CHANNELS: readonly string[]` export từ `src/services/socket/relayAudience.ts` = `fb:onMessage`, `fb:onReaction`, `fb:onSeen`, `fb:onUnsend`, `fb:onEdit`, `fb:onContactUpdate`, `fb:onThreadInfoUpdate`, `fb:onConnectionStatus`. `RELAY_CHANNELS` (boss) và `FORWARD_CHANNELS` (nhân viên) đều lấy từ hằng này. `fb:onTyping` và `fb:onPresence` KHÔNG được chuyển tiếp.

- [ ] **Step 1: Kiểm thử đỏ `relayEventChannels.test.ts`**: mọi tên trong `FACEBOOK_RELAY_CHANNELS` có trong `RELAY_CHANNELS`, trong `FORWARD_CHANNELS` và trong `validChannels` của `electron/preload.ts` (đọc tệp bằng `fs`); `fb:onTyping`, `fb:onPresence` không có trong `RELAY_CHANNELS`.
- [ ] **Step 2: Kiểm thử đỏ `relayFacebookEvents.test.ts`** (theo mẫu `relayEventAudience.test.ts`, đi qua `relayEventToEmployees` thật): `fb:onMessage` với `fbAccountId: 'page-1'` tới nhân viên được dùng `page-1`, không tới nhân viên chỉ được dùng `page-2`, không tới nhân viên chỉ được gán `fb-personal`; sự kiện `fb:onMessage` với `fbAccountId: 'fb-personal'` không tới ai; `fb:onReaction` thiếu `fbAccountId` không tới ai; nhân viên mới nối gửi `catch-up { lastSeqId: 0 }` chỉ nhận sự kiện của Page mình được dùng.
- [ ] **Step 3: Chạy**, FAIL.
- [ ] **Step 4: Thêm hằng và dùng nó ở ba nơi.** Trước khi thêm tên vào `preload.ts`, đọc `src/ui/hooks/useChatEvents.ts` và ghi vào báo cáo: listener nào của `fb:on*` hiện không bao giờ chạy vì tên chưa có trong `validChannels`, và việc thêm tên có làm đổi hành vi trên máy boss không. Nếu việc thêm một tên làm bật một listener đang ngủ trên máy boss mà hành vi của nó chưa được kiểm thử, dừng ở tên đó và báo trong Concerns thay vì bật.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(relay): deliver Page inbox events to the employees who may use the Page`.

### Task 5: Giao diện máy nhân viên nhận ra Page

**Files:**
- Create: `src/ui/lib/employeeAccounts.ts`
- Modify: `src/ui/App.tsx` (`normalizeWorkspaceAccounts` ~74–95, kiểu `WorkspaceAccountCache` ~56), `src/ui/components/auth/EmployeeLoginScreen.tsx` (`normalizeAccounts` ~30–48), `src/utils/WorkspaceManager.ts` (~45), `src/ui/store/workspaceStore.ts` (~40), `src/services/http/handlers/RestApiHandlers.ts` (`getConversations`, `getMessages` ~141–290), `src/ui/lib/chat/fbOlderMessages.ts`, `src/ui/components/chat/ConversationList.tsx` (~1417), `src/ui/components/chat/ChatWindow.tsx` (các chỗ gọi `shouldFetchFbOlder` / `shouldFetchFbHistoryOnOpen`)
- Test: `src/__tests__/ui/employeeAccounts.test.ts`, `src/__tests__/ui/fbOlderMessages.test.ts` (sửa), `src/__tests__/http/relayRestChannel.test.ts`

**Interfaces:**
- Produces (`employeeAccounts.ts`, thuần): `normalizeEmployeeAccount(raw: any): { zalo_id: string; full_name: string; avatar_url: string; phone: string; is_business: number; is_active: number; listener_active: number; channel: string; parent_zalo_id: string | null; facebook_id?: string }`: giữ `channel` (mặc định `'zalo'`) và `parent_zalo_id` (mặc định `null`); với `channel === 'facebook'` thêm `facebook_id = zalo_id` (giống `login:getAccounts` của boss). Hai hàm chuẩn hoá hiện có trong `App.tsx` và `EmployeeLoginScreen.tsx` gọi hàm này; hai kiểu bộ nhớ đệm thêm hai trường.
- `shouldFetchFbOlder({ channel, isEmployee, isPage })` và `shouldFetchFbHistoryOnOpen({ … isEmployee, isPage … })`: nhân viên được tải khi `isPage` đúng; tài khoản Facebook cá nhân ở chế độ nhân viên vẫn không tải.
- REST: mỗi dòng hội thoại và tin nhắn trả cho nhân viên có thêm `channel` (lấy từ cột `channel` của dòng đã lưu; thiếu thì `'zalo'`).

- [ ] **Step 1: Kiểm thử đỏ `employeeAccounts.test.ts`**: dòng Page giữ `channel: 'facebook'`, `parent_zalo_id`, có `facebook_id`; dòng cũ không có hai trường → `channel: 'zalo'`, `parent_zalo_id: null`; mọi trường hiện có được giữ nguyên giá trị.
- [ ] **Step 2: Sửa kiểm thử đỏ `fbOlderMessages.test.ts`**: nhân viên + Page → true; nhân viên + Facebook cá nhân → false; boss giữ nguyên mọi ca hiện có.
- [ ] **Step 3: Kiểm thử đỏ `relayRestChannel.test.ts`** (qua harness với `RestApiHandlers` thật, DB giả trả dòng có `channel: 'facebook'`): `GET /api/query/conversations?zaloId=page-1` và `GET /api/query/messages?zaloId=page-1&threadId=t1` trả mỗi dòng kèm `channel: 'facebook'`; dòng Zalo kèm `channel: 'zalo'`.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết `employeeAccounts.ts`; sửa các tệp đã nêu.** `ConversationList.tsx` ~1417 thay `isEmployee: false` bằng giá trị thật. Không đổi giao diện nào khác.
- [ ] **Step 6: Rà một lượt và ghi vào báo cáo**: với một tài khoản Page ở chế độ nhân viên, mỗi lời gọi `ipc.fb.*` trong `MessageInput.tsx`, `ChatWindow.tsx`, `ConversationList.tsx`, `ChatHeader.tsx`, `ConversationInfo.tsx`, `FacebookAdapter.ts`, `MessageQueue.ts`, `fbInitUtils` đi tới lệnh nào và lệnh đó thuộc nhóm nào ở Task 2. Lời gọi nào rơi vào `boss_only` mà giao diện vẫn hiện nút cho nhân viên thì ẩn nút đó khi `isEmployee`; ghi rõ từng chỗ đã ẩn.
- [ ] **Step 7: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 8: Commit** `feat(ui): an employee machine treats an assigned Page as a Facebook Page`.

### Task 6: Màn hình gán tài khoản của boss

**Files:**
- Create: `src/ui/lib/employeeAssignableAccounts.ts`
- Modify: `src/ui/components/settings/EmployeeSettings.tsx` (~21, ~423, ~794–812, ~1079–1130)
- Test: `src/__tests__/ui/employeeAssignableAccounts.test.ts`

**Interfaces:**
- Produces (`employeeAssignableAccounts.ts`, thuần):
  - `type AssignableGroupKey = 'zalo' | 'facebook_page' | 'telegram' | 'facebook_personal'`
  - `interface AssignableGroup<T> { key: AssignableGroupKey; label: string; assignable: boolean; note?: string; accounts: T[] }`
  - `groupAssignableAccounts<T extends { zalo_id: string; channel?: string | null; parent_zalo_id?: string | null }>(accounts: readonly T[]): AssignableGroup<T>[]`: thứ tự nhóm `zalo`, `facebook_page`, `telegram`, `facebook_personal`; nhãn `'Zalo'`, `'Page Facebook'`, `'Telegram'`, `'Facebook cá nhân'`; nhóm rỗng bị bỏ; `facebook_personal` có `assignable: false` và `note: 'Chưa mở cho nhân viên'`
  - `assignableAccountIds<T …>(accounts: readonly T[]): string[]`: id của mọi tài khoản thuộc nhóm `assignable`

- [ ] **Step 1: Kiểm thử đỏ**: bốn loại tài khoản vào đúng nhóm và đúng thứ tự; `telegram_user` và `telegram_bot` cùng vào `telegram`; kênh lạ hoặc thiếu `channel` vào `zalo`; `assignableAccountIds` không chứa Facebook cá nhân.
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết tệp thuần; sửa `EmployeeSettings.tsx`**: danh sách gán vẽ theo nhóm với tiêu đề nhóm; dòng Facebook cá nhân bị khoá (ô chọn `disabled`, có `aria-disabled`, kèm ghi chú của nhóm); "chọn tất cả" chỉ chọn `assignableAccountIds`; khi mở một nhân viên đang được gán Facebook cá nhân, id đó bị bỏ khỏi lựa chọn lúc lưu; đổi các chuỗi "Tài khoản Zalo được quản lý" → "Tài khoản được quản lý", "Chưa có tài khoản Zalo nào" → "Chưa có tài khoản nào", "Quản lý TK Zalo" → "Quản lý tài khoản", "TK Zalo" trong dòng mô phỏng → "tài khoản". Dùng đúng các lớp màu, khoảng cách và trạng thái focus đang có trong tệp (đọc `DESIGN.md` trước); không thêm màu mới.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(ui): group accounts by channel when assigning them to an employee`.

### Task 7: Tài liệu, ghi chú phiên bản, 26.46.0

**Files:**
- Modify: `SYSTEM_DOCUMENTATION.md` (mục 3.4, 4.7, 4.11, 10.2, 22; dòng phiên bản và dòng trạng thái ở mục 0), `docs/specs/2026-11-17-employee-shared-inbox.md` (dòng Trạng thái; thêm "Ghi chú sau phát hành (26.46.0, đợt 2)"), `src/ui/components/settings/ChangelogSettings.tsx`, `package.json`, `package-lock.json` (hai chỗ `version` đầu tệp)

- [ ] **Step 1:** `SYSTEM_DOCUMENTATION.md`: mô tả luồng lệnh `fb:*` của nhân viên (ba nhóm, tệp `employeeChannelRoutes.ts`, lớp bọc `employeeRoutedIpcMain`), các sự kiện được chuyển tiếp, cách nhận ra Page (`accountRows.ts`), giới hạn thời gian chờ kèm dấu `<!-- docs-check: … -->` cho ba hằng timeout; ghi rõ ở mục 22: bản 26.45.0 loại nhầm cả Page với nhân viên (dòng `accounts` không có `parent_zalo_id`), sửa trong 26.46.0; ghi các giới hạn đã biết của đợt này (do người điều phối cung cấp trong `release-facts.md`).
- [ ] **Step 2:** Mục changelog `26.46.0` (tiếng Việt, xưng "bạn", cho người vận hành, không tên tệp hay tên lệnh). Sửa câu sai trong mục `26.45.0`: câu "Các Page không bị ảnh hưởng" thành "Trong bản 26.45.0, Page cũng tạm thời không dùng được với nhân viên; bản 26.46.0 mở lại".
- [ ] **Step 3:** Tăng version lên `26.46.0`; cập nhật dòng Trạng thái của spec và thêm ghi chú sau phát hành cho đợt 2.
- [ ] **Step 4:** `node scripts/check-docs.js` → `docs-check: OK`.
- [ ] **Step 5: Commit** `feat(release): 26.46.0 — employees can use the inbox of a Page assigned to them`.
