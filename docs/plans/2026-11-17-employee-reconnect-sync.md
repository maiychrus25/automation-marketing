# Nối lại, nhận bù và đồng bộ nền (đợt 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Máy nhân viên tự đúng dữ liệu trở lại sau khi mất kết nối, máy ngủ hoặc boss khởi động lại; việc đồng bộ lâu không chặn màn hình.

**Architecture:** Máy chủ chuyển tiếp gắn mã phiên (`bootId`) vào luồng sự kiện và trả lời yêu cầu nhận bù bằng "đã phát lại" hoặc "phải tải lại". Máy nhân viên biến "phải tải lại" và các tín hiệu gián đoạn thành một sự kiện `employee:resync`; giao diện tải lại qua REST. Quyết định nằm trong tệp thuần.

**Tech Stack:** TypeScript 5, Electron 41, React 18, Socket.IO, Jest + ts-jest.

**Spec:** `docs/specs/2026-11-17-employee-reconnect-telegram-poster.md` (mục 3, 6).

## Global Constraints

- Nhánh `feat/employee-stages-3-5`. Không push, không tag, không tăng version: phát hành làm một lần sau đợt 5.
- Không bao giờ `git add` `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. Chỉ `git add` đúng các tệp của task.
- Định danh trong code bằng tiếng Anh. Chuỗi hiển thị bằng tiếng Việt, xưng "bạn". Comment theo ngôn ngữ của tệp đang sửa.
- Hành vi của boss dùng một mình không đổi, trừ chỗ task nói rõ (Task 6 áp dụng cho cả boss). Máy nhân viên bản cũ (yêu cầu `catch-up` không có `proto`) vẫn được phát lại có lọc như hiện nay.
- Không ghi vào log: token, nội dung tin, payload sự kiện, đường dẫn tệp. Không gọi Zalo, Facebook, Telegram thật trong kiểm thử; dữ liệu mẫu tổng hợp và đúng hình dạng bảng thật (bảng `accounts` không có `parent_zalo_id`; một Page là dòng `accounts` cộng dòng `fb_accounts` có `parent_facebook_id`).
- Không bật một listener ở giao diện chưa từng chạy mà không có kiểm thử cho phần xử lý của nó; gặp trường hợp đó thì để tắt và báo trong Concerns.
- Giao diện: đọc `DESIGN.md` trước khi sửa JSX; không thêm màu, cỡ, component mới; sáng và tối nhất quán; không tràn ngang; giữ thao tác bàn phím.
- Không sửa hai kiểm thử nhạy tải (`mobileSyncService.test.ts › longRunOfSkippedRowsYieldsAndHonoursCancel`, `pageCampaignAutonomy.integration.test.ts › 50 distinct contenders…`). Không thêm dependency. Không tái cấu trúc ngoài chỗ task nêu.
- Mỗi task kết thúc bằng: `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, `npx jest <các tệp test của task>` sạch, rồi commit; chạy cả bộ `npx jest` một lần và ghi tên mọi kiểm thử đỏ vào báo cáo (kiểm thử nhạy tải đỏ thì chạy lại riêng tệp đó một lần và báo cả hai kết quả).
- Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. Boss khởi động lại trong lúc máy nhân viên vẫn mở: máy nhân viên đang giữ số lớn hơn số của luồng mới. Task 1, 2.
2. Nhân viên bị rút quyền hoặc tài khoản giữa hai lần nối: không được nhận lại sự kiện cũ qua nhận bù. Task 1.
3. Nhiều tín hiệu gián đoạn đến dồn (heartbeat, socket, máy thức dậy): chỉ một lượt tải lại, không chồng nhau, không vòng lặp. Task 2, 4.
4. Tải lại ghi đè thứ người dùng đang làm: tin đang soạn, hội thoại đang mở, vị trí cuộn. Task 4.
5. Đồng bộ nền mất kết nối giữa chừng: báo lỗi rõ, không treo tiến độ mãi. Task 5, 6.

---

### Task 1: Mã phiên, số thứ tự và trả lời nhận bù (máy boss)

**Files:**
- Create: `src/services/socket/catchUpProtocol.ts`
- Modify: `src/services/socket/EventBuffer.ts`, `src/services/socket/SocketIOService.ts` (`publish` ~216, handler `catch-up` ~142–160, `stop` ~266), `src/services/socket/relayAudience.ts` (thêm hằng)
- Test: `src/__tests__/socket/catchUpProtocol.test.ts`, `src/__tests__/socket/eventBufferStream.test.ts`, `src/__tests__/socket/socketCatchUp.test.ts` (mở rộng)

**Interfaces:**
- Produces (`catchUpProtocol.ts`, thuần):
  - `CATCH_UP_PROTO = 2`, `CATCH_UP_MAX_REPLAY = 500`
  - `type CatchUpRequest = { proto?: number; bootId?: string | null; lastSeqId?: number | null }`
  - `type CatchUpPlan = { mode: 'replay'; sinceSeqId: number } | { mode: 'reset'; reason: 'boss-restart' | 'gap' | 'fresh' } | { mode: 'legacy'; sinceSeqId: number }`
  - `planCatchUp(req: CatchUpRequest, stream: { bootId: string; oldestSeqId: number | null; newestSeqId: number | null; countAfter: (seqId: number) => number }): CatchUpPlan`: không có `proto` (hoặc < 2) → `legacy` với `sinceSeqId = lastSeqId || 0`; `proto >= 2`: không có `bootId` hoặc `lastSeqId` không phải số dương → `reset fresh`; `bootId` khác → `reset boss-restart`; bộ đệm rỗng → `replay` (không có gì để phát); `lastSeqId < oldestSeqId - 1` hoặc `lastSeqId > newestSeqId` → `reset gap`; `countAfter(lastSeqId) > CATCH_UP_MAX_REPLAY` → `reset gap`; còn lại → `replay` với `sinceSeqId = lastSeqId`
  - `type CatchUpAck = { proto: 2; bootId: string; status: 'replayed' | 'reset'; reason?: 'boss-restart' | 'gap' | 'fresh'; lastSeqId: number | null }`
- Produces (`relayAudience.ts`): `EPHEMERAL_RELAY_CHANNELS: ReadonlySet<string>` = `event:typing`, `event:userPresence`, `fb:onTyping`, `fb:onPresence`
- `EventBuffer`: constructor nhận `{ now?: () => number; bootId?: string }`; `bootId: string` (UUID ngẫu nhiên nếu không truyền); số đầu tiên = `now() * 1000 + 1`; `oldestSeqId(): number | null`, `newestSeqId(): number | null`, `countAfter(seqId: number): number`; `reset()` tạo luồng mới (bootId mới, số mới theo `now()`).
- `SocketIOService`: mỗi lần `start`/`attach` gọi `buffer.reset()`; mỗi envelope `event` có thêm `bootId`; `publish` không đưa kênh thuộc `EPHEMERAL_RELAY_CHANNELS` vào bộ đệm (vẫn phát trực tiếp); handler `catch-up` nhận `(req, ack?)`, làm theo `planCatchUp`, phát lại qua bộ lọc người nhận hiện có, rồi gọi `ack(CatchUpAck)` nếu client truyền ack; `legacy` phát lại như hiện nay và không cần ack.

- [ ] **Step 1: Kiểm thử đỏ `catchUpProtocol.test.ts`**: mỗi nhánh của `planCatchUp` ở trên một ca (kể cả `lastSeqId` đúng bằng `oldestSeqId - 1` → `replay`; `lastSeqId` bằng `newestSeqId` → `replay` không phát gì; `lastSeqId` lớn hơn `newestSeqId` → `reset gap`; yêu cầu không có `proto` với `lastSeqId: 0` → `legacy`).
- [ ] **Step 2: Kiểm thử đỏ `eventBufferStream.test.ts`**: hai bộ đệm tạo cách nhau 1 ms có `bootId` khác nhau và số của bộ sau lớn hơn mọi số của bộ trước sau 100 lần `push`; `reset()` đổi `bootId` và xoá sự kiện; `oldestSeqId`/`newestSeqId`/`countAfter` đúng sau khi bộ đệm cắt đầu.
- [ ] **Step 3: Mở rộng `socketCatchUp.test.ts`** (SocketIOService thật trên cổng tạm, `socket.io-client`): client `proto 2` đúng `bootId` nhận đúng phần thiếu và ack `replayed`; sai `bootId` → ack `reset boss-restart`, không nhận sự kiện nào; kết nối mới (`lastSeqId` 0, không `bootId`) → ack `reset fresh`, không nhận gì; client cũ (không `proto`) vẫn nhận phát lại có lọc; sự kiện `event:typing` phát trực tiếp tới client đang nối nhưng không có trong phát lại; nhân viên bị rút tài khoản giữa hai lần nối không nhận lại sự kiện của tài khoản đó; mỗi envelope có `bootId`.
- [ ] **Step 4: Chạy**, FAIL.
- [ ] **Step 5: Viết `catchUpProtocol.ts`; sửa `EventBuffer`, `SocketIOService`, `relayAudience.ts`.**
- [ ] **Step 6: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 7: Commit** `feat(relay): boot id, monotonic sequence and an explicit catch-up answer`.

### Task 2: Máy nhân viên nhận biết gián đoạn và phát `employee:resync`

**Files:**
- Create: `src/services/http/employeeConnection.ts`
- Modify: `src/services/socket/SocketIOClient.ts`, `src/services/http/HttpClientService.ts` (heartbeat ~855–903, xử lý sự kiện đẩy), `src/services/http/HttpConnectionManager.ts`, `electron/main.ts` (đăng ký `powerMonitor`), `electron/preload.ts` (`validChannels`: thêm `employee:resync`)
- Test: `src/__tests__/http/employeeConnection.test.ts`, `src/__tests__/socket/socketClientCatchUp.test.ts`

**Interfaces:**
- Consumes: `CATCH_UP_PROTO`, `CatchUpAck` (Task 1).
- Produces (`employeeConnection.ts`, thuần):
  - `type ResyncReason = 'boss-restart' | 'gap' | 'fresh' | 'catchup-unverified' | 'heartbeat-recovered' | 'system-resume'`
  - `CATCH_UP_ACK_TIMEOUT_MS = 10000`
  - `resyncReasonForAck(ack: CatchUpAck | null): ResyncReason | null`: `null` (hết giờ, boss bản cũ) → `catchup-unverified`; `status: 'reset'` → lý do của ack; `replayed` → `null`
  - `class StreamPosition { bootId: string | null; lastSeqId: number; track(envelope: { bootId?: string; seqId?: number }): void; request(): { proto: 2; bootId: string | null; lastSeqId: number } }`: `track` với `bootId` khác thì đặt lại `lastSeqId` theo envelope mới; cùng `bootId` thì chỉ tăng
  - `shouldResyncAfterHeartbeat(wasFailing: boolean, nowOk: boolean): boolean`
- `SocketIOClient`: dùng `StreamPosition`; sau mỗi lần `connect` gửi `catch-up` kèm ack với hạn `CATCH_UP_ACK_TIMEOUT_MS`; gọi `onResync(reason)` khi `resyncReasonForAck` khác null; báo `onSocketStatus(connected: boolean)`.
- `HttpClientService`: chuyển `onResync` và heartbeat hồi phục thành `EventBroadcaster.sendDirect('employee:resync', { reason })`; gộp trạng thái socket vào trạng thái kết nối đưa lên giao diện (`workspace:connectionStatus` hiện có), không đổi tên trường đang có. `notifySystemResume()`: gửi heartbeat ngay và phát `employee:resync` lý do `system-resume`.
- `electron/main.ts`: `powerMonitor.on('resume', …)` gọi `HttpConnectionManager.getInstance().notifySystemResume()` (bọc try/catch; trên máy boss không có client thì không làm gì).

- [ ] **Step 1: Kiểm thử đỏ `employeeConnection.test.ts`**: `resyncReasonForAck` cho ba dạng ack; `StreamPosition` (cùng luồng chỉ tăng; đổi `bootId` thì nhận số nhỏ hơn; envelope không có `seqId` bị bỏ qua); `shouldResyncAfterHeartbeat` (hỏng → được: true; được → được: false; hỏng → hỏng: false).
- [ ] **Step 2: Kiểm thử đỏ `socketClientCatchUp.test.ts`** (SocketIOClient thật nối vào SocketIOService thật trên cổng tạm): lần nối đầu → `onResync('fresh')`; ngắt rồi nối lại cùng luồng → không `onResync`, nhận đủ sự kiện đã lỡ; boss dừng và khởi động lại (luồng mới) → `onResync('boss-restart')`; boss giả không bao giờ gọi ack → `onResync('catchup-unverified')` sau hạn (dùng hạn rút ngắn truyền qua tham số tạo client, mặc định 10000).
- [ ] **Step 3: Chạy**, FAIL.
- [ ] **Step 4: Viết `employeeConnection.ts`; sửa các tệp đã nêu.** Thêm `employee:resync` vào `validChannels` của `preload.ts`.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(employee): detect gaps and ask the renderer to resync`.

### Task 3: Một danh sách sự kiện chung cho hai phía

**Files:**
- Create: `src/services/socket/relayChannels.ts`
- Modify: `src/services/http/HttpRelayService.ts` (`RELAY_CHANNELS` ~209–280), `src/services/http/HttpClientService.ts` (`FORWARD_CHANNELS` ~39–99, `handlePushedEvent`)
- Test: `src/__tests__/socket/relayChannels.test.ts`

**Interfaces:**
- Produces (`relayChannels.ts`, thuần): `RELAYED_EVENT_CHANNELS: readonly string[]` (đúng nội dung `RELAY_CHANNELS` hiện tại, gồm cả `FACEBOOK_RELAY_CHANNELS`); `EMPLOYEE_CONTROL_CHANNELS: readonly string[]` (các kênh điều khiển chỉ có ở phía nhân viên trong `FORWARD_CHANNELS` hiện tại: `relay:*`, `workspace:*`…); `RENDERER_DORMANT_CHANNELS: ReadonlySet<string>` (kênh được chuyển tiếp nhưng giao diện chưa bật listener; khởi đầu gồm `fb:onSeen`, `fb:onContactUpdate`, `fb:onThreadInfoUpdate`).
- `HttpRelayService.RELAY_CHANNELS` = `RELAYED_EVENT_CHANNELS`; `HttpClientService.FORWARD_CHANNELS` = `RELAYED_EVENT_CHANNELS` + `EMPLOYEE_CONTROL_CHANNELS`.

- [ ] **Step 1: Kiểm thử đỏ**: mọi kênh của boss có trong danh sách chuyển tiếp của nhân viên (đọc hai hằng); sáu kênh đang bị bỏ (`db:unreadChanged`, `db:conversationDeleted`, `db:contactProfileUpdated`, `crm:tagChanged`, `library:itemAdded` / `itemUpdated` / `itemDeleted`, `erp:event:employeeProfileDeleted`) nay có trong danh sách của nhân viên; mọi kênh trong `RELAYED_EVENT_CHANNELS` hoặc có trong `validChannels` của `electron/preload.ts`, hoặc nằm trong `RENDERER_DORMANT_CHANNELS` (đọc tệp bằng `fs`).
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Tạo hằng và dùng ở hai phía.** Với từng kênh trong sáu kênh: đọc listener ở giao diện (`src/ui/hooks/`, `src/ui/App.tsx`) và nhánh tương ứng trong `handlePushedEvent`. Kênh nào đã có trong `validChannels` và listener đang chạy trên boss thì chuyển thẳng (`sendDirect`); kênh nào cần ghi vào cơ sở dữ liệu tại máy nhân viên giống các kênh cùng loại thì thêm nhánh tương tự (không viết khuôn mới); kênh nào listener chưa từng chạy thì thêm vào `RENDERER_DORMANT_CHANNELS` và báo trong Concerns. Ghi vào báo cáo quyết định cho từng kênh kèm file:line.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `fix(relay): one shared list of relayed events for boss and employee`.

### Task 4: Giao diện tải lại sau khi gián đoạn

**Files:**
- Create: `src/ui/lib/employeeResync.ts`, `src/ui/hooks/useEmployeeResync.ts`
- Modify: `src/ui/App.tsx` (gắn hook; hàm tải hội thoại nhận tuỳ chọn tải lại cả khi đã có), `src/ui/components/layout/TopBar.tsx` (dòng trạng thái)
- Test: `src/__tests__/ui/employeeResync.test.ts`

**Interfaces:**
- Produces (`employeeResync.ts`, thuần):
  - `RESYNC_DEBOUNCE_MS = 500`
  - `class ResyncScheduler { constructor(deps: { run: (reasons: string[]) => Promise<void>; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void }); request(reason: string): void; readonly running: boolean }`: gom mọi `request` trong 500 ms thành một lần `run`; đang chạy mà có `request` mới thì chạy đúng một lượt nữa sau khi lượt hiện tại xong; `run` ném lỗi thì không kẹt
  - `resyncSteps(state: { accountIds: string[]; activeAccountId: string | null; activeThreadId: string | null }): Array<{ kind: 'conversations'; accountId: string } | { kind: 'messages'; accountId: string; threadId: string }>`: hội thoại cho mọi tài khoản (tài khoản đang mở trước), rồi tin của hội thoại đang mở nếu có
  - `resyncStatusText(running: boolean, failed: boolean): string | null`: `'Đang cập nhật dữ liệu từ máy Boss…'`, `'Chưa cập nhật được dữ liệu từ máy Boss'`, hoặc `null`
- `useEmployeeResync()`: chỉ hoạt động ở chế độ nhân viên; nghe `employee:resync`; thực hiện `resyncSteps` bằng các hàm tải dữ liệu hiện có (`DataAccessor`), trộn kết quả vào store mà không xoá tin đang soạn, không đổi hội thoại đang mở, không cuộn.

- [ ] **Step 1: Kiểm thử đỏ**: ba `request` trong 500 ms → một lần `run` với đủ ba lý do; `request` trong lúc đang chạy → đúng một lượt nữa; `run` ném lỗi → lần `request` sau vẫn chạy; `resyncSteps` đúng thứ tự và bỏ bước tin nhắn khi không có hội thoại mở; `resyncStatusText` ba trường hợp.
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết hai tệp; gắn vào `App.tsx` và `TopBar.tsx`.** Hàm tải hội thoại hiện có (`loadEmployeeConversationsForAccounts` hoặc hàm nó gọi) nhận tuỳ chọn `force` để tải cả khi danh sách không trống; tải lại tin của hội thoại đang mở dùng đúng hàm mà `ChatWindow` dùng khi mở hội thoại. Ghi vào báo cáo: tin đang soạn và vị trí cuộn được giữ như thế nào, chỉ ra dòng mã.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(ui): reload data from the boss after a gap`.

### Task 5: Đăng nhập nhân viên không chờ tải hội thoại

**Files:**
- Create: `src/ui/lib/backgroundLoad.ts`
- Modify: `src/ui/components/auth/EmployeeLoginScreen.tsx` (~35–67, ~160), `src/ui/App.tsx` (`loadEmployeeConversationsForAccounts` ~106; chỗ gọi `checkAccountInitNeeds` ~518–536), `src/ui/components/layout/TopBar.tsx`
- Test: `src/__tests__/ui/backgroundLoad.test.ts`

**Interfaces:**
- Produces (`backgroundLoad.ts`, thuần):
  - `runWithConcurrency<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>, onProgress: (done: number, total: number, failed: number) => void): Promise<{ done: number; failed: number }>`: không ném; một mục lỗi không dừng các mục khác
  - `EMPLOYEE_BOOTSTRAP_CONCURRENCY = 3`
  - `bootstrapProgressText(done: number, total: number, failed: number): string | null`: đang chạy → `` `Đang tải hội thoại ${done}/${total}` ``; xong và có lỗi → `` `Chưa tải được hội thoại của ${failed} tài khoản` ``; xong không lỗi hoặc `total` 0 → `null`
  - `shouldRunZaloInit(isEmployee: boolean): boolean` = `!isEmployee`

- [ ] **Step 1: Kiểm thử đỏ**: không quá 3 worker cùng lúc (đếm đỉnh); một worker lỗi → `failed` 1 và các mục khác vẫn xong; `onProgress` gọi sau mỗi mục; ba dạng chuỗi tiến độ; `shouldRunZaloInit`.
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Sửa**: `EmployeeLoginScreen` vào app ngay sau khi xác thực thành công (nút đăng nhập chỉ khoá trong lúc xác thực); việc tải hội thoại chạy nền bằng `runWithConcurrency`, tiến độ lưu vào store sẵn có gần nhất (không tạo store mới nếu `employeeStore` hoặc `appStore` chứa được hai số) và hiện ở `TopBar` cùng chỗ với dòng trạng thái của Task 4. Bảng khởi tạo tài khoản Zalo không mở khi `shouldRunZaloInit(isEmployee)` sai.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(ui): employee login no longer waits for conversations to load`.

### Task 6: Đồng bộ thành viên nhóm chạy trong bảng nổi

**Files:**
- Create: `src/ui/lib/groupSyncSession.ts`
- Modify: `src/ui/components/crm/groups/GroupMembersTab.tsx` (~265–300, lớp phủ ~1773–1870), nơi gắn bảng nổi ở mức app (`src/ui/App.tsx`, cạnh `AccountInitPanel`)
- Test: `src/__tests__/ui/groupSyncSession.test.ts`

**Interfaces:**
- Produces (`groupSyncSession.ts`, thuần, không React): 
  - `interface GroupSyncState { status: 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed'; done: number; total: number; currentName: string; error: string | null; minimized: boolean }`
  - `class GroupSyncSession { getState(): GroupSyncState; subscribe(fn: (s: GroupSyncState) => void): () => void; start(run: (ctl: { shouldStop(): boolean; progress(done: number, total: number, currentName: string): void }) => Promise<void>): boolean; stop(): void; setMinimized(v: boolean): void; dismiss(): void }`: `start` trả false nếu đang chạy; lỗi của `run` thành `failed` kèm `error`; `stop` chuyển `stopping` rồi `stopped` khi `run` kết thúc
  - `groupSyncSession` (một thể hiện dùng chung, sống ngoài vòng đời component)
  - `groupSyncSummary(s: GroupSyncState): string`: `running` → `` `Đang đồng bộ nhóm ${done}/${total}` ``; `stopping` → `'Đang dừng…'`; `done` → `` `Đã đồng bộ ${total} nhóm` ``; `stopped` → `` `Đã dừng ở ${done}/${total}` ``; `failed` → `` `Đồng bộ nhóm lỗi: ${error}` ``

- [ ] **Step 1: Kiểm thử đỏ**: vòng đời `idle → running → done`; `start` lần hai khi đang chạy trả false; `stop` giữa chừng → `stopping` → `stopped` và `shouldStop()` đúng; `run` ném → `failed` kèm thông điệp; người nghe nhận mọi thay đổi và ngừng nhận sau khi huỷ đăng ký; năm chuỗi tóm tắt.
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Sửa giao diện**: vòng lặp đồng bộ hiện có trong `GroupMembersTab` chạy qua `groupSyncSession.start(...)` (thân vòng lặp giữ nguyên, chỉ đổi cách báo tiến độ và cách hỏi dừng). Bỏ lớp phủ `fixed inset-0`; thay bằng một bảng nổi gắn ở mức app, dùng đúng khung, lớp màu và nút của `AccountInitPanel` (đọc tệp đó và `DESIGN.md`), có: dòng `groupSyncSummary`, thanh tiến độ, nút "Dừng", nút thu nhỏ / mở lại, nút đóng khi đã xong. Bảng vẫn hiện và tiếp tục chạy khi chuyển tab hay chuyển màn hình. Nút "Đồng bộ" trong tab bị khoá khi đang chạy.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(ui): group member sync runs in a floating panel instead of a full-screen overlay`.
