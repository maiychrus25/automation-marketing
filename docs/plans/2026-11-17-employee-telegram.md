# Telegram cho nhân viên (đợt 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhân viên dùng được hộp thư Telegram (tài khoản người dùng và bot) của tài khoản được gán, ngay trên máy mình; phiên đăng nhập và token vẫn chỉ nằm ở máy boss.

**Architecture:** Lặp lại đúng đường đã dùng cho Page: bảng phân loại lệnh thuần (`employeeChannelRoutes.ts`) quyết định lệnh nào chuyển lên boss, máy chủ chuyển tiếp dựng danh sách đóng từ bảng đó, sự kiện đi theo `zaloId` của tài khoản. Máy nhân viên không ghi tin Telegram vào cơ sở dữ liệu tại máy; giao diện đọc từ boss.

**Tech Stack:** TypeScript 5, Electron 41, React 18, Socket.IO, better-sqlite3, Jest + ts-jest.

**Spec:** `docs/specs/2026-11-17-employee-reconnect-telegram-poster.md` (mục 4, 6).

## Global Constraints

- Nhánh `feat/employee-stages-3-5`. Không push, không tag, không tăng version: phát hành làm một lần sau đợt 5.
- Không bao giờ `git add` `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. Chỉ `git add` đúng các tệp của task.
- Định danh trong code bằng tiếng Anh. Chuỗi hiển thị bằng tiếng Việt, xưng "bạn". Comment theo ngôn ngữ của tệp đang sửa.
- Hành vi của boss dùng một mình không đổi. Lệnh Telegram do giao diện của boss gọi phải chạy y như trước.
- Chuỗi phiên Telegram và token bot (cột `accounts.cookies`) không bao giờ rời máy boss: không có trong phản hồi REST, snapshot, sự kiện hay log. Không ghi vào log: token, nội dung tin, payload sự kiện, đường dẫn tệp.
- Không gọi Telegram, Zalo, Facebook thật trong kiểm thử; dữ liệu mẫu tổng hợp và đúng hình dạng bảng thật (kênh của tài khoản Telegram là `'telegram_user'` hoặc `'telegram_bot'`; mọi sự kiện Telegram mang `zaloId` = mã tài khoản, không có `accountId`; tham số lệnh dùng `accountId` và `chatId`).
- Không bật một listener ở giao diện chưa từng chạy với dữ liệu của nhân viên mà không lần theo phần xử lý của nó; phần nào gọi thẳng cơ sở dữ liệu tại máy thì chặn ở chế độ nhân viên và báo trong Concerns.
- Giao diện: đọc `DESIGN.md` trước khi sửa JSX; không thêm màu, cỡ, component mới; sáng và tối nhất quán; không tràn ngang; giữ thao tác bàn phím.
- Không sửa hai kiểm thử nhạy tải (`mobileSyncService.test.ts › longRunOfSkippedRowsYieldsAndHonoursCancel`, `pageCampaignAutonomy.integration.test.ts › 50 distinct contenders…`). Không thêm dependency. Không tái cấu trúc ngoài chỗ task nêu.
- Mỗi task kết thúc bằng: `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, `npx jest <các tệp test của task>` sạch, rồi commit; chạy cả bộ `npx jest` một lần và ghi tên mọi kiểm thử đỏ vào báo cáo (kiểm thử nhạy tải đỏ thì chạy lại riêng tệp đó một lần và báo cả hai kết quả).
- Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. Lệnh Telegram nhận tham số không phải object (`sendCode(phone)`, `stopListener(accountId)`, `startBot(account)`…): bị trải thành ký tự khi chuyển tiếp. Mọi lệnh như vậy phải là `boss_only`. Task 1.
2. Trường đường dẫn của Telegram không nằm trong danh sách kiểm (`photoPath`, `audioPath`, `stickerPath`, `animPath`): nhân viên trỏ tới tệp bất kỳ trên máy boss. Task 2.
3. Mã tin Telegram lặp lại giữa các hội thoại: gắn nhân viên gửi theo mã tin mà không kèm hội thoại sẽ gắn nhầm tin của hội thoại khác. Task 2.
4. Tin Telegram được chuyển tới bị lưu vào cơ sở dữ liệu tại máy nhân viên bằng khuôn Zalo (`channel='zalo'`, tạo liên hệ ma). Task 3.
5. Nhân viên bấm nút chỉ boss làm được (kết nối, ngắt, đăng nhập, đồng bộ cả tài khoản) hoặc ứng dụng tự chạy kiểm tra phiên tại máy nhân viên. Task 4.

---

### Task 1: Phân loại lệnh Telegram và nối vào đường chuyển tiếp

**Files:**
- Modify: `src/services/http/employeeChannelRoutes.ts`, `src/services/http/relayChannelPolicy.ts`, `electron/ipc/telegramUserIpc.ts`, `electron/ipc/telegramIpc.ts`
- Test: `src/__tests__/http/employeeChannelRoutes.test.ts`, `src/__tests__/http/relayChannelPolicy.test.ts`

**Interfaces:**
- Produces (`employeeChannelRoutes.ts`):
  - `TELEGRAM_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>>`: đủ 68 lệnh `telegramUser:*` và 38 lệnh `telegram:*`.
  - `EMPLOYEE_CHANNEL_ROUTES` = `FACEBOOK_CHANNEL_ROUTES` + `TELEGRAM_CHANNEL_ROUTES`; `employeeChannelSpec(channel)` tra trong hằng gộp.
  - `employeeSendInfo`: hội thoại lấy từ `params.threadId`, không có thì `params.chatId`, không có nữa thì `params.toChatId`.
- `boss_only` (đúng danh sách này): `telegramUser:` `sendCode`, `signIn`, `signIn2FA`, `startListener`, `stopListener`, `isConnected`, `getActive`, `fetchSelfAvatar`, `checkForumForNewGroups`, `refreshMessages`; `telegram:` `validateBot`, `startBot`, `stopBot`, `isBotPolling`, `getActiveBots`.
- `proxy`: mọi lệnh còn lại. Quyền: `['friends', 'chat']` cho `telegramUser:blockUser`, `unblockUser`, `searchContacts`, `resolveUsername`, `getPeers`; `['chat']` cho phần còn lại. `send: true` cho `telegramUser:sendMessage`, `sendFile`, `sendTopicMessage`, `sendTopicFile`, `sendSticker`, `sendGif`, `forwardMessages` và `telegram:sendMessage`, `sendPhoto`, `sendVideo`, `sendDocument`, `sendAudio`, `sendVoice`, `sendSticker`, `sendAnimation`, `sendVideoNote`, `sendContact`, `sendLocation`, `sendPoll`, `forwardMessage`. Hạn chờ: lệnh gửi có tệp và `getMessages`, `getForumTopicMessages`, `repair*`, `getGroupMembers` dùng `PROXY_SLOW_TIMEOUT_MS`; lệnh gửi chữ, sửa, xoá, chuyển tiếp dùng `PROXY_MEDIUM_TIMEOUT_MS`; còn lại `PROXY_DEFAULT_TIMEOUT_MS`.
- `relayChannelPolicy.ts`: luật của danh sách đóng dựng từ mọi mục `proxy` của `EMPLOYEE_CHANNEL_ROUTES` với `account: 'required'` (như Page hiện nay).
- Hai tệp IPC: `const ipcMain = employeeRoutedIpcMain(electronIpcMain)` như `electron/ipc/facebookIpc.ts:8,28`.

- [ ] **Step 1: Kiểm thử đỏ** trong `employeeChannelRoutes.test.ts`: quét `telegramUserIpc.ts` và `telegramIpc.ts` (bỏ dòng comment) bằng `/ipcMain\.handle\(\s*'((?:telegramUser|telegram):[^']+)'/g`; số handler đúng 68 và 38; tập handler bằng đúng tập khoá của `TELEGRAM_CHANNEL_ROUTES` (cả hai chiều); mọi handler có tham số không phải `params` (quét chữ ký: tên tham số thứ hai khác `params`, hoặc không có tham số) là `boss_only`; `employeeSendInfo('telegramUser:sendMessage', {accountId:'t1', chatId:'c9'}, {success:true, messageId:'55'})` trả `{accountId:'t1', threadId:'c9', messageIds:['55']}`; `forwardMessages` với `toChatId` và kết quả `{success:true}` trả `messageIds: []`.
- [ ] **Step 2: Kiểm thử đỏ** trong `relayChannelPolicy.test.ts`: `telegramUser:sendMessage` và `telegram:sendPhoto` có luật `{modules:['chat'], account:'required'}`; `telegramUser:blockUser` có `modules:['friends','chat']`; `telegramUser:startListener`, `telegramUser:signIn`, `telegram:startBot`, `telegram:validateBot` bị từ chối. Dòng đang khẳng định `telegram:sendMessage` bị từ chối đổi thành `telegram:startBot`.
- [ ] **Step 3: Chạy**, FAIL.
- [ ] **Step 4: Viết bảng phân loại, gộp hằng, đổi `employeeSendInfo`, dựng luật từ hằng gộp, đổi `ipcMain` trong hai tệp IPC.** Sửa hai dòng log đếm handler cũ (59, 37) cho đúng hoặc bỏ số.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/http`; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(employee): classify Telegram commands for the relay`.

### Task 2: Máy boss: tệp, người gửi, trạng thái trực tuyến, dòng REST, media

**Files:**
- Modify: `src/services/http/bossFileAccess.ts`, `electron/ipc/proxyHelper.ts` (`prepareLocalFilesForProxy`), `src/services/http/HttpRelayService.ts` (ghi nhận người gửi ~1058–1090; snapshot tài khoản ~378–392; `online(a)` ~326), `src/services/http/accountRows.ts`, `src/services/http/handlers/RestApiHandlers.ts` (`conversationRow`, `messageRow`, `getBoot`), `src/services/http/handlers/MediaHandler.ts`, `src/services/DatabaseService.ts` (`setMessageHandledByEmployeeFlexible`)
- Test: `src/__tests__/http/bossFileAccess.test.ts`, `src/__tests__/http/accountRows.test.ts`, `src/__tests__/http/relayTelegramProxy.test.ts` (mới, dùng `relayHarness.ts`), kiểm thử hiện có của `MediaHandler` và `RestApiHandlers` (thêm ca)

**Interfaces:**
- Consumes: `EMPLOYEE_CHANNEL_ROUTES`, `employeeSendInfo` (Task 1).
- `bossFileAccess.ts`: `PROXY_FILE_PATH_FIELDS` thêm `'photoPath'`, `'audioPath'`, `'stickerPath'`, `'animPath'`; xuất `EMPLOYEE_UPLOAD_PATH_FIELDS` = `PROXY_FILE_PATH_FIELDS` trừ `'file_path'` (tệp đính kèm ERP giữ nguyên hành vi hiện tại). `prepareLocalFilesForProxy` dùng `EMPLOYEE_UPLOAD_PATH_FIELDS` thay cho danh sách tự viết.
- `accountRows.ts`: `isAccountOnline(row, deps)` thêm `deps.telegramUserConnected(id)`, `deps.telegramBotPolling(id)`; `channel === 'telegram_user'` và `'telegram_bot'` dùng hai hàm đó. Bên gọi truyền `TelegramUser.isConnected` và `TelegramBotChannelService.isBotPolling` (đều đồng bộ).
- `setMessageHandledByEmployeeFlexible(accountId, messageId, employeeId, threadId?)`: có `threadId` thì thêm `AND thread_id = ?`. Máy chủ chuyển tiếp truyền `threadId` khi kênh lệnh bắt đầu bằng `telegram`.
- Snapshot tài khoản thêm `username`. `getBoot`: tài khoản thêm `channel`; hội thoại đi qua `conversationRow`.
- `conversationRow` / `messageRow`: với dòng có `channel` bắt đầu bằng `telegram`, mang thêm các cột (lấy nguyên từ dòng lưu): hội thoại `telegram_folder_id`, `telegram_archived`, `telegram_can_send`, `telegram_send_reason`, `telegram_peer_type`, `telegram_members_count`, `telegram_online_count`, `telegram_state_updated_at`, `telegram_membership_state`, `telegram_join_action`, `is_cov_bot`, `menu_button`, `has_main_app`, `is_forum`, `is_in_others`, `has_mention`, `mute_until`, `peer_delivered_ts`, `peer_read_ts`, `last_message_type`; tin nhắn `reply_to_id`, `inline_buttons`, `is_edited`, `edit_history`, `status`, `thread_type`, `deleted_by`, `recalled_content`. Dòng Zalo và Facebook không đổi.
- `MediaHandler.ts`: tệp trong `<base>/_avatars/telegram/` được phục vụ cho nhân viên đã xác thực (trước bước kiểm thư mục tài khoản; vẫn qua kiểm đường dẫn nằm trong thư mục gốc). Bảng kiểu tệp thêm `.webm` `video/webm`, `.tgs` `application/x-tgsticker`, `.oga` và `.opus` `audio/ogg`, `.m4a` `audio/mp4`.

- [ ] **Step 1: Kiểm thử đỏ**: `bossFileAccess` (bốn trường mới bị kiểm; `EMPLOYEE_UPLOAD_PATH_FIELDS` là tập con của `PROXY_FILE_PATH_FIELDS` và không có `file_path`; quét hai tệp IPC Telegram: mọi tên tham số kết thúc bằng `Path` của lệnh `proxy` nằm trong `PROXY_FILE_PATH_FIELDS`); `accountRows` (Telegram người dùng và bot trực tuyến theo hàm tương ứng, không gọi hàm của Zalo); `relayTelegramProxy` (tài khoản không được gán bị từ chối; thiếu `accountId` bị từ chối; `photoPath` ngoài thư mục tải lên bị từ chối; lệnh gửi thành công gắn nhân viên đúng tin của đúng hội thoại khi hai hội thoại có cùng `msg_id`; `telegramUser:startListener` bị từ chối); `MediaHandler` (ảnh đại diện Telegram trả 200 cho nhân viên, tệp `_avatars/` khác vẫn 403, `../` vẫn bị chặn; kiểu tệp mới); `RestApiHandlers` (dòng Telegram mang cột mới, dòng Zalo không có khoá mới).
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết mã.** Với các cột REST: grep giao diện Telegram (`src/ui/`) xem còn cột nào được đọc từ dòng hội thoại hoặc tin nhắn mà danh sách trên thiếu; thêm cột đó và ghi vào báo cáo. Lần theo kết quả của các lệnh trả đường dẫn tệp trên máy boss (`telegramUser:downloadSticker`, `getStickerSetStickers`, `repairMessageMedia`): giao diện ở máy nhân viên đổi đường dẫn boss thành địa chỉ media bằng hàm nào (hàm đang dùng cho `local_paths` của Page); nếu kết quả không dùng được ở máy nhân viên thì ghi rõ trong Concerns, không tự thêm cơ chế mới.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/http`; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(relay): Telegram files, sender tagging, online state and rows for employees`.

### Task 3: Sự kiện Telegram ở máy nhân viên

**Files:**
- Create: `src/services/http/telegramRelayEvents.ts`
- Modify: `src/services/socket/relayChannels.ts`, `src/services/http/HttpClientService.ts` (`handlePushedEvent`, nhánh `event:message` và các nhánh ghi cơ sở dữ liệu tại máy)
- Test: `src/__tests__/http/telegramRelayEvents.test.ts`, `src/__tests__/socket/relayChannels.test.ts`, `src/__tests__/http/relayEventAudience.test.ts` (thêm ca)

**Interfaces:**
- `relayChannels.ts`: `RELAYED_EVENT_CHANNELS` thêm `event:telegramReaction`, `event:messageEdited`, `event:messagesDeleted`, `event:forumTopicsChanged`, `event:telegramEntityHydrated`, `event:groupMemberAvatar`, `event:telegramSync`, `event:userPresence` (kênh cuối đã nằm trong `EPHEMERAL_RELAY_CHANNELS`). Cả tám kênh đã có trong `validChannels` của `electron/preload.ts`.
- `telegramRelayEvents.ts` (thuần): `isTelegramChannelName(channel: unknown): boolean` (`'telegram_user'`, `'telegram_bot'`); `isTelegramRelayPayload(data: unknown, telegramAccountIds: ReadonlySet<string>): boolean`: đúng khi `data.channel`, `data.message.channel` hoặc `data.message.data.channel` là kênh Telegram, hoặc `data.zaloId` thuộc `telegramAccountIds`.
- `HttpClientService`: giữ tập mã tài khoản Telegram lấy từ danh sách tài khoản của snapshot (cập nhật mỗi lần nhận snapshot). Sự kiện mà `isTelegramRelayPayload` đúng: không ghi gì vào cơ sở dữ liệu tại máy, chuyển nguyên payload cho giao diện (`sendDirect(channel, data)`, giữ khoá `channel` ở mức ngoài cùng).

- [ ] **Step 1: Kiểm thử đỏ**: `telegramRelayEvents` (ba vị trí của `channel`; theo mã tài khoản; payload Zalo và Facebook trả false; `null`, chuỗi, mảng trả false); `relayChannels` (tám kênh có trong danh sách của cả hai phía và trong `validChannels`); `relayEventAudience` (tám kênh với `zaloId` của tài khoản Telegram chỉ tới nhân viên được gán tài khoản đó; thiếu `zaloId` thì không tới ai).
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết mã.** Lần từng nhánh của `handlePushedEvent` có ghi cơ sở dữ liệu (`saveRelayMessageToWorkspaceDb`, `persistRelayConversationEvent` và nhánh tương tự): thêm lối rẽ Telegram ở đầu, trước mọi nhánh ghi. Ghi vào báo cáo bảng: kênh, nhánh cũ làm gì, nay làm gì với payload Telegram.
- [ ] **Step 4: Lần phần xử lý ở giao diện** của `event:message` (payload Telegram) và tám kênh mới (`src/ui/hooks/`, `src/ui/App.tsx`): liệt kê mọi lệnh IPC mỗi phần xử lý gọi; lệnh nào đọc hoặc ghi cơ sở dữ liệu tại máy mà không đi qua `DataAccessor` hay đường chuyển lên boss thì ghi vào Concerns kèm file:line (Task 4 xử lý). Không sửa `src/ui/` trong task này.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/http src/__tests__/socket`; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(employee): relay Telegram events without writing them to the local database`.

### Task 4: Giao diện và tiến trình chính ở máy nhân viên

**Files:**
- Modify: `src/ui/lib/employeeAccounts.ts`, các tệp giao diện có nút chỉ boss làm được (`src/ui/lib/channels/TelegramUserAdapter.ts`, `TelegramBotAdapter.ts`, `AccountCard.tsx`, `TopBar.tsx`, nơi hiện nút kết nối / ngắt / đăng nhập Telegram), các phần xử lý sự kiện Task 3 đã nêu trong Concerns, `electron/main.ts` (`reconnectAllTelegramAccounts`, `startTelegramBotHealthCheck`)
- Test: `src/__tests__/ui/employeeAccounts.test.ts`, kiểm thử thuần cho hàm mới

**Interfaces:**
- Consumes: bảng phân loại (Task 1), trạng thái trực tuyến trong snapshot (Task 2), danh sách phần xử lý cần chặn (báo cáo Task 3).
- `employeeAccounts.ts`: `isTelegramChannel(channel?: string | null): boolean`; `withoutBossOnlyTelegramCaps(caps, isEmployee, channel)` theo đúng khuôn của `withoutBossOnlyFbCaps` (tắt các khả năng ứng với lệnh `boss_only` của Task 1); `telegramHealthForEmployee(account: { listener_active?: number | boolean }): { connected: boolean }` để adapter không gọi `isConnected` / `isBotPolling` ở chế độ nhân viên.
- `electron/main.ts`: hai hàm khởi động Telegram không chạy khi workspace đang hoạt động là `remote`.

- [ ] **Step 1: Kiểm thử đỏ** cho ba hàm thuần (boss giữ nguyên khả năng; nhân viên mất đúng các khả năng chỉ boss; kênh khác không bị ảnh hưởng; trạng thái lấy từ `listener_active`).
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết mã.** Ở chế độ nhân viên: ẩn nút kết nối, ngắt, đăng nhập lại, "làm mới ảnh đại diện" của chính tài khoản, đồng bộ lại tin của cả tài khoản (`refreshMessages`); `checkHealth` của hai adapter trả theo snapshot; các phần xử lý sự kiện đã nêu ở Task 3 không gọi cơ sở dữ liệu tại máy. Các lệnh gửi của Telegram trong `MessageInput.tsx` giữ `code` của kết quả để hàng đợi gửi lại phân biệt hết giờ với mất kết nối (`src/ui/lib/chat/sendRetry.ts`); kiểm từng chỗ gọi và ghi file:line vào báo cáo.
- [ ] **Step 4: Giảm tải `db:unreadChanged`** (`src/ui/hooks/useZaloEvents.ts` ~1591–1624, nhánh nguồn Telegram): ở chế độ nhân viên mỗi sự kiện đang tải lại 500 hội thoại qua mạng sau 300 ms và thay cả danh sách. Thêm hàm thuần `unreadReloadDelayMs(isEmployee: boolean): number` vào `employeeAccounts.ts` (boss `300`, nhân viên `2000`) và dùng nó cho thời gian chờ; ở chế độ nhân viên kết quả được trộn theo mã hội thoại (dùng đúng đường trộn mà việc tải lại sau gián đoạn của đợt 3 dùng), không thay cả danh sách. Kiểm thử cho hàm thuần. Hành vi của boss không đổi.
- [ ] **Step 5: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 6: Commit** `feat(employee): Telegram inbox without boss-only controls`.
