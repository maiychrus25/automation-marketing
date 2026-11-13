# Chat Sync Reliability (chặng A–C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đồng bộ tin nhắn Zalo và Facebook cá nhân của MaiHub ổn định ngang Deplao 26.11.0: không trùng tin, tự nối lại, số chưa đọc đúng, mất mạng không bị coi là hết cookie, có mốc đã nhận/đã xem.

**Architecture:** Port bằng tay từng hành vi từ `babyvibe/deplao-builder@2162f07` vào đúng chỗ tương ứng của MaiHub; logic mới nằm trong các module nhỏ thuần (test được không cần mạng), các file lớn (`ZaloLoginHelper`, `EventBroadcaster`, `DatabaseService`, `FacebookService`) chỉ thêm lời gọi. Schema chỉ cộng thêm (một index, hai cột).

**Tech Stack:** TypeScript/Electron, React 18, better-sqlite3, Jest (ts-jest, node env, `src/__tests__/**/*.test.ts`), `zca-js` 2.1.2 (không nâng). Không dependency mới.

**Spec:** `docs/specs/2026-11-13-chat-sync-reliability.md` (anh duyệt 13/11/2026). Chặng D (Go: `markRead`, lưu thiết bị E2EE, không phát lại tin cũ) có plan riêng.

**Trạng thái:** Anh duyệt plan ngày 13/11/2026. Task 1–12 đã triển khai và gộp vào `main` (13/11/2026), chưa phát hành; chưa kiểm trên tài khoản Zalo/Facebook thật.

**Phương thức thực thi:** subagent-driven, subagent dùng Sonnet. Nhánh `feat/chat-sync-reliability` (từ `main` `f5a1bd4`), không commit/push khi anh chưa cho phép.

## Global Constraints

- Mã nguồn tham chiếu: clone chỉ đọc ở `$SCRATCH/upstream/deplao-builder` tại `2162f07` (thiếu thì `git clone https://github.com/babyvibe/deplao-builder.git` rồi `git checkout 2162f07`). **Chỉ đọc, không chạy, không copy nguyên file, không merge.** Mỗi task ghi rõ dòng nguồn để đối chiếu.
- Không lấy: mọi thứ gửi cookie/token/IMEI ra máy chủ ngoài Zalo/Facebook, tệp nhị phân, bridge đăng nhập, Cloudflare sync, Telegram, "đồng bộ từ điện thoại" (`mobileSync`), `FacebookMetrics`.
- Giữ điểm MaiHub cố ý khác bản gốc: cờ `manuallyDisconnectedAccounts`, hàng đợi theo nhóm (`runInGroupOrder`), luồng Page hiện có, `MAX_RECONNECT_ATTEMPTS = 5`.
- Giá trị cố định: watchdog nối lại Zalo `90_000` ms; thử lại khởi động Facebook `[15_000, 60_000, 180_000]` ms; backoff bridge E2EE từ `10_000` ms nhân đôi, trần `300_000` ms; hàng đợi sự kiện bridge `500` (sự kiện quan trọng tới `2000`), cửa sổ chống trùng `5000` ms; `ZALO_READ_SCOPE = 200`; cmd đọc-ở-máy-khác `504` / `524`.
- Host media Zalo: `zdn.vn`, `zadn.vn`, `zalo.me`, `zaloapp.com` (kể cả subdomain, không khớp tên miền giả dạng).
- Schema chỉ cộng thêm: index `idx_messages_cli ON messages(owner_zalo_id, cli_msg_id) WHERE cli_msg_id IS NOT NULL`; cột `contacts.peer_delivered_ts`, `contacts.peer_read_ts` (`INTEGER DEFAULT 0`, ms). Thêm ở cả khối tạo schema và khối migration. Không dọn dữ liệu cũ, không migration sửa nội dung.
- Test không gọi Zalo/Facebook thật; fixture tự dựng, không dùng tên/id thật. Không log cookie, token, khoá, nội dung frame.
- Identifier tiếng Anh, copy tiếng Việt; UI theo `DESIGN.md`. Cập nhật `SYSTEM_DOCUMENTATION.md` trong task sở hữu hành vi; `node scripts/check-docs.js` sạch.
- Không tăng version, không đụng `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`, không gỡ hai tệp `.exe` trong `src/bridge-e2ee/build/`, không đổi mã Go.
- TDD cho mọi task: viết test, xem nó đỏ đúng lý do, rồi mới viết code. Mỗi task kết thúc bằng "Inspect diff" thay cho commit.

**Lệnh kiểm chứng (như CI):**
```bash
TZ=UTC npx jest --runInBand
TZ=America/New_York npx jest --runInBand --randomize --seed=2707
TZ=Asia/Ho_Chi_Minh npx jest --runInBand --randomize --seed=3707
TMPDIR="$SCRATCH" python3 -m unittest discover -s tools/maihub-bridge/tests
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node scripts/check-docs.js
```
Baseline trên `main`: Jest 3915/3915, Python 408 OK, nhiễu console 12 error / 2 warn.

## Rulings

- **R1 — Hiển thị mốc:** nhãn "Đã nhận" / "Đã xem" hiện dưới **tin mình gửi cuối cùng** của hội thoại (chỗ khối "Đã xem" hiện có), không vẽ dấu ✓ trên từng bong bóng như bản gốc. Mốc chỉ tiến nên tin cuối đã nói đủ; tránh sửa sâu `ChatWindow.tsx`.
- **R2 — Tin mẫu (F6) thành chữ:** lưu là tin `text` với nội dung đọc được (tiêu đề, mô tả, tên nút kèm link). Không làm thẻ `FacebookTemplateCard` và kiểu `fb.template` của bản gốc.
- **R3 — Nửa nhận của F7 làm ở chặng C:** thông báo đã nhận / đã đọc từ MQTT ghi mốc ngay (thuần TypeScript). `markRead` gửi thật và receipt từ bridge để chặng D.
- **R4 — Ảnh JXL:** chặt hơn bản gốc — chỉ đổi URL thuộc host media Zalo. Không migration; tin cũ được sửa lúc hiển thị, file `.jxl` đã tải về máy bị bỏ qua khi hiển thị (dùng bản JPG từ CDN).
- **R5 — GraphQL (F4):** phản hồi không phân tích được (không phải JSON) coi là "không rõ" và giữ hành vi hiện tại; chỉ phản hồi phân tích được và có lỗi mới thành thất bại. Tránh biến thao tác đang chạy được thành lỗi.
- **R6 — Trong lúc zca-js tự nối lại:** không phát `event:disconnected`, không đổi trạng thái kết nối; chỉ đặt watchdog.
- **R7 — `unread_count` của Facebook (F3):** chỉ dùng khi tạo hội thoại lần đầu; hội thoại đã có giữ số trong máy.
- **R8 — Z5 có thể hoãn:** nếu `listener.ws` của zca-js 2.1.2 không nhận được `on('message')` ổn định thì dừng Task 4, ghi vào "Ghi chú sau triển khai" của spec, làm tiếp task khác.

## Review Focus

1. Tin mình gửi (bản dội lại qua `selfListen`, hoặc gửi từ app rồi nhận lại) không bị bộ lọc trùng bỏ nhầm; hai tin cùng `cli_msg_id` khác nội dung vẫn lưu cả hai. → test ở Task 1.
2. Bấm "Ngắt kết nối", xoá tài khoản hoặc đăng nhập lại trong lúc zca-js đang hẹn nối lại: không tự nối lại, không có hai listener cùng nhận tin. → test ở Task 2.
3. Một tin Facebook đi **đường thật** `handleIncomingMessage` tăng chưa đọc đúng 1; tin phát lại không thông báo, không chạy workflow lần hai; tin Page cũng vậy. → test ở Task 5.
4. Tài khoản Facebook bị tắt/xoá/ngắt tay trong lúc chờ thử lại khởi động thì không tự kết nối; cookie bị Facebook từ chối thật vẫn báo hết hạn. → test ở Task 6.
5. Mốc đã nhận/đã xem không lùi; receipt cho hội thoại chưa có dòng `contacts` hoặc id tin không có trong máy thì bỏ qua, không tạo dòng, không ném lỗi; mọi mốc là ms. → test ở Task 10.

## File structure

| Tệp | Trách nhiệm |
|---|---|
| `src/utils/zaloListenerRetry.ts` (mới) | Chặn listener cũ tự nối lại, trả lượt thử, watchdog 90 s |
| `src/utils/zaloImageUrl.ts` (mới) | Đổi URL JXL → JPG, dùng chung main/renderer |
| `src/services/zalo/zaloReadElsewhere.ts` (mới) | Giải mã frame 504/524, tính số chưa đọc còn lại |
| `src/services/facebook/FacebookGraphQLResult.ts` (mới) | Đọc phản hồi GraphQL, phát hiện lỗi |
| `src/services/facebook/facebookStartupRetry.ts` (mới) | Hẹn thử lại kết nối lúc khởi động |
| `src/services/facebook/FacebookEventPipeline.ts` (mới) | Hàng đợi sự kiện bridge có giới hạn + chống trùng |
| `src/services/facebook/facebookBridgeBackoff.ts` (mới) | Tính thời gian chờ nối lại bridge |
| `src/services/facebook/facebookTemplateText.ts` (mới) | Tin mẫu → chữ đọc được |
| `src/services/receipts/peerReceipts.ts` (mới) | Ghi mốc đã nhận/đã xem, phát `event:receipt` |
| `src/ui/lib/chat/messageReceipt.ts` (mới) | Tính nhãn cho tin gửi cuối |
| `ZaloLoginHelper.ts`, `EventBroadcaster.ts`, `DatabaseService.ts`, `FacebookService.ts`, `FacebookSession.ts`, `FacebookThreadManager.ts`, `FacebookMessageSender.ts`, `FacebookMQTTListener.ts`, `electron/ipc/facebookIpc.ts`, `electron/preload.ts`, `ChatWindow.tsx`, `useZaloEvents.ts`, `chatStore.ts` | Chỉ thêm lời gọi / sửa đúng chỗ nêu trong task |

---

## Chặng A — Zalo

### Task 1: Lọc tin Zalo giao trùng (Z2)

**Files:** Modify `src/services/database/DatabaseService.ts` (khối index ~547, khối migration ~1705, `saveMessage` 3249), `src/services/event/EventBroadcaster.ts` (ngay sau khối "Silent mode" ~275–281); Test `src/__tests__/database/zaloDuplicateDelivery.test.ts`. Nguồn đối chiếu: upstream `DatabaseService.ts:4256–4300`, `EventBroadcaster.ts:341–355`.

**Interfaces — Produces:** `DatabaseService.isDuplicateZaloDelivery(ownerZaloId: string, rawMessage: any): boolean`; index `idx_messages_cli`.

- [ ] **Step 1: Test** (DB tạm theo mẫu `src/__tests__/database/groupContactType.test.ts`; lưu bản đầu bằng `saveMessage` thật rồi hỏi bản sau):
  - `sameCliSameContentDifferentIdIsDuplicate` → `true`.
  - `differentContentIsNotDuplicate`, `differentSenderIsNotDuplicate`, `differentThreadIsNotDuplicate`, `differentAccountIsNotDuplicate` → `false`.
  - `sameMsgIdIsNotDuplicate` (cùng `msgId` — để `INSERT OR IGNORE` xử lý như nay) → `false`.
  - `missingCliOrMissingMsgIdIsNotDuplicate`; `syntheticIdIsNotDuplicate` (id dạng `mb_…`/`cli_…` ở một trong hai bên) → `false`.
  - `ownSentEchoIsKeptOnce`: lưu tin mình gửi theo đúng đường gửi hiện có của app, rồi đưa bản dội `isSelf` của chính tin đó → kết quả giống hệt trước khi có bộ lọc (viết test ghi lại hành vi hiện tại trước, rồi giữ nguyên): vẫn đúng một dòng, không mất tin.
  - `indexExistsAndLookupUsesIt`: `EXPLAIN QUERY PLAN` của câu tra chứa `idx_messages_cli`; index có sau khi mở DB cũ (chạy migration trên DB thiếu index).
- [ ] **Step 2:** chạy, đỏ vì chưa có hàm/index.
- [ ] **Step 3: Implement.** Thêm index ở hai khối. `isDuplicateZaloDelivery`: lấy `threadId`, `uidFrom`, `cliMsgId`, `content` **bằng đúng phép suy ra của `saveMessage`** (tách phần suy ra `content` trong `saveMessage` thành hàm private dùng chung, không viết lần hai); truy vấn chỉ `WHERE owner_zalo_id = ? AND cli_msg_id = ?`, lọc hội thoại/người gửi/kênh `zalo` trong code; trùng khi có dòng khác `msg_id`, cả hai id thật, cùng nội dung. Chưa `initialized` → `false`.
- [ ] **Step 4:** trong `EventBroadcaster`, bọc `try/catch`: trùng → ghi một dòng log (`msgId`, `cliMsgId`, `threadId`, không ghi nội dung) rồi `return`; lỗi kiểm tra → đi tiếp như tin mới. Đặt trước mọi bước lưu, phát giao diện, workflow, webhook, tải media.
- [ ] **Step 5:** chạy test xanh; `SYSTEM_DOCUMENTATION.md` thêm mô tả lọc trùng + index (lần mở đầu có thể lâu). **Step 6:** Inspect diff.

### Task 2: Tự nối lại websocket Zalo (Z3)

**Files:** Create `src/utils/zaloListenerRetry.ts`; Modify `src/utils/ZaloLoginHelper.ts` (1127–1197); Test `src/__tests__/zalo/zaloListenerRetry.test.ts`. Nguồn: upstream `src/utils/zalo/zaloListenerRetry.ts`, `ZaloLoginHelper.ts:1101–1211`.

**Interfaces — Produces:**
```ts
export const ZCA_RETRY_WATCHDOG_MS = 90_000;
export function wireZaloListenerLifecycle(listener: any, hooks: {
  isCurrent: () => boolean;      // còn là listener đang dùng: chưa ngắt tay, chưa xoá, chưa bị phiên mới thay
  onConnected: () => void;
  onGiveUp: (eventType: 'closed' | 'retry_timeout', code: number, reason: string) => void; // gọi tối đa một lần
  log?: (message: string) => void;
}): void;
```

- [ ] **Step 1: Test** với listener giả (`EventEmitter` có `canRetry`, `start`, `stop`, `retryCount`) và `jest.useFakeTimers()`:
  - `blocksCanRetryWhenNotCurrent` (không gọi `canRetry` gốc, trả `false`); `passesThroughWhenCurrent`.
  - `blocksScheduledStartOfStaleListener`: lần `start` đầu luôn chạy; lần sau khi `isCurrent() === false` không gọi `start` gốc.
  - `resetsRetryBudgetOnConnected`: `retryCount = { '1000': { count: 3, max: 5, times: [1] } }` → sau `connected` thì `count === 0`.
  - `staysQuietWhileRetrying`: `disconnected` → `onGiveUp` chưa gọi; tua `89_999` ms vẫn chưa; `connected` → tua thêm `200_000` ms không bao giờ gọi.
  - `givesUpAfterWatchdog`: `disconnected`, tua `90_000` ms → `onGiveUp('retry_timeout', code, reason)` đúng một lần và `listener.stop()` được gọi.
  - `closedGivesUpOnce`: `disconnected` rồi `closed` → `onGiveUp('closed', …)` một lần; tua qua watchdog không gọi lần hai.
  - `staleListenerThatReconnectsIsStopped`: `connected` khi `isCurrent() === false` → `listener.stop()`, không gọi `onConnected`.
  - `manualDisconnectDoesNotReconnect`: `isCurrent` trả `false` (đã ngắt tay) → `canRetry` bị chặn, `closed` → `onGiveUp('closed')` một lần, không `start` lại.
- [ ] **Step 2:** đỏ. **Step 3:** viết module (bọc `canRetry`/`start` trên đúng đối tượng listener, không sửa `zca-js`).
- [ ] **Step 4: Nối vào `ZaloLoginHelper`.** `isCurrent = !removedAccounts.has(zaloId) && !manuallyDisconnectedAccounts.has(zaloId) && ConnectionManager.getConnection(zaloId) === connection`. `onConnected` = thân handler `connected` hiện có. `onGiveUp` = `handleDisconnection` hiện có, với một sửa: **kiểm tra "bị phiên mới thay" chuyển lên trước** `setConnected(false)` / `broadcastDisconnected` (hiện listener cũ đóng làm phiên mới bị báo mất kết nối). Bỏ `listener.on("disconnected"|"closed")` cũ; giữ handler `error` chỉ ghi log. Đổi `listener.start()` → `listener.start({ retryOnClose: true })`. Không đổi `scheduleReconnect` / `MAX_RECONNECT_ATTEMPTS`.
- [ ] **Step 5:** test xanh; chạy lại các test Zalo/kết nối hiện có. Docs: mục kết nối Zalo. **Step 6:** Inspect diff.

### Task 3: Ảnh JPEG XL (Z4)

**Files:** Create `src/utils/zaloImageUrl.ts`; Modify `EventBroadcaster.ts` (đầu luồng tin Zalo, trước khối "Silent mode" và trước bước lọc trùng của Task 1), `DatabaseService.ts` (`extractImageUrlFromContent` 4689, `extractImageUrlFromQuote` 4717), và 9 chỗ lấy URL ảnh ở renderer: `ChatWindowBubbles.tsx:452,1282`, `ChatWindow.tsx:961,2249`, `MessageBubbles.tsx:443`, `hooks/useZaloEvents.ts:340,353`, `lib/chat/messageParser.ts:371`, `MessageInput.tsx:4407`; Test `src/__tests__/zalo/zaloImageUrl.test.ts`. Nguồn: upstream `src/utils/zalo/zaloImageUrl.ts`.

**Interfaces — Produces:** `toZaloJpgUrl(url: string): string`, `normalizeZaloPhotoContent<T>(content: T): T` (trả đúng tham chiếu cũ nếu không đổi), `normalizeZaloMessageImages(message: any): boolean`, `isJxlLocalPath(path: unknown): boolean`.

- [ ] **Step 1: Test:**
  - `https://photo-stal-1.zdn.vn/jxl/abc/123.jxl?jxlstatus=1&x=2` → `https://photo-stal-1.zdn.vn/jpg/abc/123.jpg?x=2`.
  - Giữ nguyên: URL có `?e2esession=…`; host ngoài (`https://example.com/jxl/a/1.jxl`); host giả dạng (`https://evilzdn.vn/jxl/a/1.jxl`, `https://zdn.vn.evil.com/jxl/a/1.jxl`); URL không phải JXL; chuỗi rỗng; giá trị không phải chuỗi.
  - `normalizeZaloPhotoContent`: object có `href`/`thumb`/`hd`; `params` là chuỗi JSON có dấu `/` bị escape (`https:\/\/…\/jxl\/…`) → đổi và vẫn là chuỗi; chuỗi văn bản thường chứa chữ "jxl" giữ nguyên tham chiếu; mảng giữ nguyên.
  - `normalizeZaloMessageImages`: đổi `data.content` và `data.quote.attach`, trả `true`; tin không có ảnh trả `false`.
  - `isJxlLocalPath`: `a/b.jxl`, `a/b.JXL` → `true`; `.jpg`, rỗng, `null` → `false`.
- [ ] **Step 2:** đỏ. **Step 3:** viết module (thêm kiểm tra host so với bản gốc — R4).
- [ ] **Step 4:** nối: `normalizeZaloMessageImages(message)` lúc nhận; hai hàm `extractImageUrl…` trả qua `toZaloJpgUrl`; 9 chỗ renderer bọc `toZaloJpgUrl(...)`; nơi bong bóng chọn file cục bộ thì bỏ qua đường dẫn `isJxlLocalPath` để rơi về URL từ CDN.
- [ ] **Step 5:** test xanh + tsc ×2. Docs một dòng. **Step 6:** Inspect diff.

### Task 4: Đọc ở máy khác (Z5) — có thể hoãn theo R8

**Files:** Create `src/services/zalo/zaloReadElsewhere.ts`; Modify `ZaloLoginHelper.ts` (gắn trước `listener.start`); Test `src/__tests__/zalo/zaloReadElsewhere.test.ts`. Nguồn: upstream `src/services/zalo/zaloReadElsewhere.ts`, `mobileSync/zcaMobileSync.ts` (chỉ hàm `decodeWsEventData`; đối chiếu với `node_modules/zca-js/dist/utils.js` `decodeEventData`).

**Interfaces — Produces:** `decodeWsEventData(parsed: any, cipherKey: string | null | undefined): any`; `extractClearUnreads(frame: Buffer, cipherKey): ZaloClearUnread[]` (`{ threadId, isGroup, lastMsgId }`); `applyZaloClearUnread(db: ZaloReadDb, ownerId: string, item: ZaloClearUnread): { unread?: number }`; `attachZaloReadElsewhere(zaloId: string, api: any, onItems: (items: ZaloClearUnread[]) => void): void`.

- [ ] **Step 0:** xác nhận trong `node_modules/zca-js/dist/apis/listen.js` rằng `listener.ws` là `WebSocket` của gói `ws` (có `.on('message')`) và `listener.cipherKey` đọc được. Không đúng → áp R8, dừng task.
- [ ] **Step 1: Test** (frame tự dựng: byte 0 = `1`, byte 1–2 = cmd LE, byte 3 = `0`, phần còn lại JSON `{ data, encrypt }`):
  - `encrypt: 0`; `encrypt: 1` (base64 + nén zlib); `encrypt: 2` (AES-GCM, khoá thử do test tự sinh, đóng gói `iv(16) | aad(16) | ciphertext | tag(16)`) → cùng ra danh sách.
  - cmd `504` → `isGroup: false`; cmd `524` → `isGroup: true`; cmd khác, frame ngắn, version ≠ 1 → `[]`.
  - Bỏ phần tử `type !== 0`, `idTo` là `-1`, `0`, không phải số.
  - Sai khoá / JSON hỏng: `attach…` nuốt lỗi, ghi một dòng cảnh báo không kèm nội dung frame.
  - `applyZaloClearUnread` (DB tạm): biết `lastMsgId` → chưa đọc = số tin **nhận** mới hơn tin đó trong `200` tin gần nhất; `lastMsgId` rỗng/không thấy → `0`; không bao giờ tăng (đang `2`, tính ra `5` → giữ `2`); không đổi → `unread` là `undefined`; không có dòng `contacts` → không tạo dòng.
- [ ] **Step 2:** đỏ. **Step 3:** viết module (Node `crypto` + `zlib`; không import gì từ `mobileSync`).
- [ ] **Step 4:** nối: mỗi phần tử → `applyZaloClearUnread`; có `unread` → `EventBroadcaster.emit('db:unreadChanged', { zaloId, contactId: threadId, unread })` (đúng hình dạng `HttpRelayService.ts:2025`). Không gửi "đã xem" lên Zalo. Gắn lại sau mỗi `connected`, gỡ listener của instance cũ.
- [ ] **Step 5:** test xanh. Docs. **Step 6:** Inspect diff.

## Chặng B — Facebook (TypeScript)

### Task 5: Số chưa đọc đúng một lần (F1)

**Files:** Modify `DatabaseService.ts` (`saveFBMessage` 8073–8210), `FacebookService.ts` (`handleIncomingMessage` 800–850, luồng Page 559–590, `saveIncomingPageMedia`), `electron/ipc/facebookIpc.ts` (`fb:fetchThreadMessages` 1650); Test `src/__tests__/database/fbSaveOutcome.test.ts`, `src/__tests__/facebook/incomingUnread.test.ts`. Nguồn: upstream `DatabaseService.ts:10255–10537`, `FacebookService.ts:756–780`.

**Interfaces — Produces:** `export type FbSaveOutcome = 'new' | 'repaired' | 'duplicate'`; `saveFBMessage(msg: {...; is_history?: boolean}): FbSaveOutcome` (Task 9 thêm nhánh `repaired`; ở task này chỉ trả `new`/`duplicate`).

- [ ] **Step 1: Test DB:** `newIncomingIncrementsOnce` (→ `'new'`, `contacts.unread_count === 1`, `fb_threads.unread_count === 1`); `replayIsDuplicate` (cùng id lần hai → `'duplicate'`, chưa đọc vẫn `1`, tin cuối/giờ cuối không đổi); `ownMessageNoUnread` (`is_self: 1` → `'new'`, chưa đọc `0`, tin cuối cập nhật); `historyRowIsSilent` (`is_history: true` → lưu được, chưa đọc và tin cuối không đổi); `gifPreviewKept` (tin `gif` → tin cuối `🖼️ GIF`).
- [ ] **Step 2: Test đường thật:** đưa một tin đến qua `handleIncomingMessage` trên DB tạm, spy `EventBroadcaster.emit`: chưa đọc `=== 1` (không phải 2); đưa lại cùng tin → chưa đọc vẫn `1`, không phát `fb:onMessage` lần hai, không chạy workflow/thông báo lần hai. Cùng hai kiểm tra cho luồng tin Page. Nếu `FacebookService` không dựng được trong Jest mà không gọi mạng thì tách phần "lưu + quyết định có phát" thành hàm trong cùng file và test hàm đó — test phải đi qua đúng code mà production gọi.
- [ ] **Step 3:** đỏ (hiện tăng 2 và phát lại).
- [ ] **Step 4: Implement.** `saveFBMessage`: xác định tin mới bằng tra `fb_messages(id, account_id)` trước khi chèn và số dòng `messages` thực chèn; khối cập nhật `fb_threads`/`contacts` chỉ chạy khi `!is_unsent && !is_history && mới`. `handleIncomingMessage`: xoá lần upsert `contacts` thứ hai (819–848), `duplicate` → ghi log rồi `return` trước mọi bước phát/thông báo/workflow/tải media. Luồng Page và `saveIncomingPageMedia`: `duplicate` → `return` trước `emit`. `fb:fetchThreadMessages` truyền `is_history: true`. Các nơi gọi khác (đường gửi, `is_self: 1`) không đổi hành vi.
- [ ] **Step 5:** test xanh + toàn bộ test Facebook/Page hiện có. Docs. **Step 6:** Inspect diff.

### Task 6: Mất mạng không phải hết hạn cookie (F2)

**Files:** Modify `src/services/facebook/FacebookSession.ts` (`checkCookieAlive` 131), `electron/ipc/facebookIpc.ts` (`reconnectAllFBAccounts` 2252 + các handler ngắt/xoá/tắt tài khoản); Create `src/services/facebook/facebookStartupRetry.ts`; Test `src/__tests__/facebook/cookieHealth.test.ts`, `src/__tests__/facebook/facebookStartupRetry.test.ts`. Nguồn: upstream `FacebookService.ts:563–585`, `electron/ipc/facebook/facebookIpc.ts:259–286`.

**Interfaces — Produces:** `isTransientFacebookError(err: unknown): boolean`; `checkCookieState(cookie: string, httpsAgent?: any): Promise<'alive' | 'expired' | 'unknown'>`; `checkCookieAlive` giữ chữ ký, trả `state !== 'expired'`; `createStartupRetry(opts: { delaysMs?: number[]; connect: (accountId: string) => Promise<void>; shouldRetry: (accountId: string) => boolean; log?: (m: string) => void }): { schedule(accountId: string): void; clear(accountId: string): void; clearAll(): void }`.

- [ ] **Step 1: Test:** `isTransientFacebookError` đúng với `getaddrinfo ENOTFOUND www.facebook.com`, `EAI_AGAIN`, `ECONNRESET`, `socket hang up`, `timeout of 15000ms exceeded`, `Request failed with status code 429`, `status code 503`; sai với `Cookie không hợp lệ`, `checkpoint`, chuỗi rỗng, `undefined`. `checkCookieState` (tiêm `initSession` giả): không ném → `alive`; ném lỗi mạng → `unknown`; ném lỗi khác → `expired`.
- [ ] **Step 2: Test retry** (đồng hồ giả): `connect` luôn lỗi → gọi tại `15_000`, `60_000`, `180_000` ms kể từ mỗi lần lỗi rồi dừng (đúng 3 lần); thành công ở lần 2 → không lần 3; `schedule` hai lần cho một tài khoản không nhân đôi; `clear` huỷ; `shouldRetry` trả `false` (đã tắt/xoá/ngắt tay/đã kết nối) → không gọi `connect`; timer được `unref`.
- [ ] **Step 3:** đỏ. **Step 4: Implement.** Tách thân vòng lặp của `reconnectAllFBAccounts` thành hàm kết nối một tài khoản; trạng thái `unknown` hoặc lỗi kết nối tạm thời → `schedule`; `expired` → bỏ qua như nay. Gọi `clear` ở handler ngắt/xoá/tắt tài khoản và khi đổi workspace (`clearAll`). `checkCookieHealth` trong `FacebookService` không đổi code (đã gọi `checkCookieAlive`).
- [ ] **Step 5:** test xanh. Docs. **Step 6:** Inspect diff.

### Task 7: Tên/ảnh hội thoại và kết quả GraphQL (F3, F4)

**Files:** Modify `src/services/facebook/FacebookThreadManager.ts` (`parseThreadNodes` 104–171; mutation `changeThreadName`, `changeThreadEmoji`, `changeNickname`, `addGroupAdmin`/`removeGroupAdmin`, `changeApprovalMode`, `approvePendingMember`, `setGroupLink`), `FacebookMessageSender.ts` (`unsendMessage`, `addReaction`, `editMessage`, `forwardMessage`, `pinMessage`, `unpinMessage`, `createPoll`, `votePoll`); Create `src/services/facebook/FacebookGraphQLResult.ts`; Test `src/__tests__/facebook/parseThreadNodes.test.ts`, `src/__tests__/facebook/graphQLResult.test.ts`. Nguồn: upstream `FacebookThreadManager.ts:174–252`, `FacebookGraphQLResult.ts:1–95`.

**Interfaces — Produces:** `parseFacebookResponse(body: unknown): any | null` (bỏ tiền tố `for (;;);`; không phân tích được cả khối thì thử dòng không rỗng đầu tiên; vẫn không được → `null`); `class FacebookOperationError extends Error { operation: string; code: 'api_error' | 'graphql_errors' | 'null_data' }`; `assertFacebookMutationSuccess(operation: string, body: unknown): void`.

- [ ] **Step 1: Test F3:** nhóm không tên và không có người khác → `Nhóm không tên`; chat riêng không có tên → `Không có tên`; chat riêng lấy tên + ảnh của người kia (không phải của mình, kể cả khi mình đứng đầu danh sách); thiếu ảnh người kia → dùng `image.uri` của hội thoại; `unread_count: 3` → `3`, `unreadCount: 2` → `2`, thiếu/âm/`NaN` → `0`, `2.9` → `2`.
- [ ] **Step 2: Test F4:** ném với `for (;;);{"error":1357004,"errorSummary":"Phiên hết hạn"}` (thông điệp chứa `Phiên hết hạn`), `{"errors":[{"message":"Rate limited"}]}`, `{"data":null}`; không ném với `{"data":{"x":{"id":"1"}}}`, với HTML, chuỗi rỗng, và với nhiều dòng JSON mà dòng đầu hợp lệ không lỗi (R5).
- [ ] **Step 3:** đỏ. **Step 4: Implement.** F3: sửa hai chuỗi, bỏ nhánh rơi về `participants[0]`, đọc `unread_count`; kiểm tra nơi ghi danh sách hội thoại vào `fb_threads`/`contacts` và chỉ dùng số này khi tạo dòng mới (R7). F4: mỗi mutation nêu trên gọi `assertFacebookMutationSuccess(<tên>, response.data)` trong `try` hiện có để lỗi rơi vào nhánh trả thất bại sẵn có; không đụng `sendMessage`.
- [ ] **Step 5:** test xanh. Docs. **Step 6:** Inspect diff.

### Task 8: Giám sát bridge E2EE (F5)

**Files:** Create `src/services/facebook/FacebookEventPipeline.ts`, `src/services/facebook/facebookBridgeBackoff.ts`; Modify `FacebookService.ts` (`startE2EEBridge` 1100–1175, heartbeat, đường dừng bridge); Test `src/__tests__/facebook/eventPipeline.test.ts`, `src/__tests__/facebook/bridgeBackoff.test.ts`. Nguồn: upstream `FacebookEventPipeline.ts`, `FacebookService.ts:1120–1144, 1285–1300, 1313–1330`.

**Interfaces — Produces:** `bridgeEventKey(evt: any): string`; `enum EventPriority { LOW, NORMAL, HIGH }`; `class FacebookEventPipeline { constructor(accountId: string); setGeneration(gen: number): void; enqueue(id: string, priority: EventPriority, generation: number, process: () => Promise<void>): boolean; isDuplicate(id: string): boolean; stop(cancel?: boolean): Promise<void> }`; `e2eeReconnectDelayMs(attempt: number): number`.

- [ ] **Step 1: Test:** `e2eeReconnectDelayMs(0..6)` = `10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000`; số âm/`NaN` → `10_000`.
- [ ] **Step 2: Test pipeline:** xử lý tuần tự theo thứ tự vào; cùng khoá trong `5000` ms bị bỏ, sau đó được nhận lại; `message` id X rồi `reaction`/`messageEdit`/`messageUnsend` cùng id X **đều được xử lý** (khoá gồm loại + id; reaction thêm người + emoji + thời điểm; sửa thêm số lần sửa + chữ mới); đầy `500` → bỏ một sự kiện `LOW` để nhận `HIGH`; toàn sự kiện quan trọng thì nhận tới `2000` rồi từ chối; sự kiện thuộc thế hệ cũ bị bỏ; một `process` ném lỗi không dừng hàng đợi; `stop(true)` xoá hàng đợi và dọn timer (không để handle treo Jest).
- [ ] **Step 3:** đỏ. **Step 4: Implement** hai module (không `metricInc`).
- [ ] **Step 5: Nối `FacebookService`.** Gắn `on('event')` **trước** `connect()` và đưa qua pipeline (bỏ sự kiện của instance/thế hệ cũ; sự kiện `HIGH` bị từ chối không phải vì trùng → đóng bridge để nối lại). Thay `setTimeout(…, 10000)` bằng một bộ hẹn duy nhất dùng `e2eeReconnectDelayMs(attempt++)`; đặt lại `attempt = 0` khi trạng thái thành `connected`; huỷ hẹn khi tắt E2EE, ngắt kết nối, hoặc bridge mới đã lên. Heartbeat hiện có giữ nguyên, khi phát hiện treo thì đi qua cùng bộ hẹn. Không đổi mã Go, không đổi `e2eeMemoryOnly`.
- [ ] **Step 6:** test xanh. Docs. **Step 7:** Inspect diff.

### Task 9: Tin mẫu từ Page/bot (F6)

**Files:** Create `src/services/facebook/facebookTemplateText.ts`; Modify `FacebookMQTTListener.ts` (phân tích đính kèm ~639–660), `DatabaseService.ts` (`saveFBMessage`), `FacebookService.ts` (xử lý kết quả `repaired`); Test `src/__tests__/facebook/templateText.test.ts`, bổ sung `fbSaveOutcome.test.ts`. Nguồn: upstream `src/shared/facebook/facebookTemplate.ts:61–192, 235–255`, `FacebookMQTTListener.ts:687–700`, `DatabaseService.ts:10364–10390`.

**Interfaces — Consumes:** `FbSaveOutcome` (Task 5). **Produces:** `unwrapFacebookRedirect(raw: unknown): string`; `templateTextFromStoryAttachment(ext: any): string` (`''` khi không có gì đọc được).

- [ ] **Step 1: Test:** `story_attachment` có `title_with_entities.text`, `description.text`, `action_links: [{ title: 'Xem ngay', url: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fa&h=x' }]` → ba dòng `tiêu đề`, `mô tả`, `• Xem ngay — https://example.com/a`; nút không có link → `• Tên nút`; có `subattachments` mà thẻ gốc rỗng → lấy thẻ con đầu; dòng trùng không lặp; mỗi trường cắt `2000` ký tự; tối đa `6` nút; đầu vào `null`/rỗng → `''`; link không phải `http(s)` bị bỏ.
- [ ] **Step 2: Test `repaired`:** dòng đã lưu rỗng (nội dung rỗng, không đính kèm), bản sau cùng id có nội dung → `'repaired'`, nội dung được điền, chưa đọc không tăng, tin cuối đang rỗng/`[Tệp đính kèm]` được thay; dòng đã có nội dung hoặc đã thu hồi → `'duplicate'`, không bị ghi đè.
- [ ] **Step 3:** đỏ. **Step 4: Implement.** MQTT: đính kèm chỉ có `mercury.extensible_attachment` (không blob, không sticker) và tin không có chữ → nội dung tin = chữ của tin mẫu, kiểu `text` (R2); có chữ sẵn thì giữ chữ. `saveFBMessage`: nhánh điền dòng rỗng. `handleIncomingMessage`: `repaired` → phát lại cho giao diện để nội dung hiện ra, **không** tăng chưa đọc, không thông báo, không workflow.
- [ ] **Step 5:** test xanh. Docs. **Step 6:** Inspect diff.

## Chặng C — Mốc đã nhận / đã xem

### Task 10: Lưu mốc và nối nguồn (mục 6, Z1, nửa nhận của F7)

**Files:** Create `src/services/receipts/peerReceipts.ts`; Modify `DatabaseService.ts` (schema + migration `contacts`), `ZaloLoginHelper.ts` (967–972), `FacebookMQTTListener.ts` (`processDelta` ~480), `FacebookService.ts` (`handleDeliveryReceipt`, đăng ký `readReceipt` ~326), `electron/preload.ts` (danh sách kênh ~762), nơi relay sự kiện cho chế độ nhân viên (theo đúng cách `event:seen` đang đi); Test `src/__tests__/database/peerReceipts.test.ts`, `src/__tests__/facebook/mqttReceipts.test.ts`. Nguồn: upstream `src/services/receipts/peerReceipts.ts`, `ZaloLoginHelper.ts:950–971`, `FacebookMQTTListener.ts:47–52, 491–503`, `FacebookService.ts:378–386, 995`.

**Interfaces — Produces:** `recordPeerReceipt(ownerId: string, threadId: string, update: { deliveredTs?: number; readTs?: number }): { deliveredTs: number; readTs: number } | null`; `messageTimestampById(ownerId: string, threadId: string, msgIds: Array<string | number | null | undefined>, channel: 'zalo' | 'facebook'): number`; `handleZaloReceiptEvents(zaloId: string, items: unknown, kind: 'read' | 'delivered'): void`; sự kiện `event:receipt` `{ zaloId, threadId, deliveredTs, readTs }`; sự kiện MQTT `readReceipt` `{ threadId: string; actorFbId: string; watermarkTimestampMs: number }`.

- [ ] **Step 1: Test `recordPeerReceipt`** (DB tạm): tiến mốc và phát `event:receipt` đúng một lần; đã xem kéo theo đã nhận; mốc nhỏ hơn/bằng → `null`, không phát, DB không đổi; hội thoại chưa có dòng `contacts` → `null`, **không tạo dòng**; giá trị `0`, âm, `NaN`, chuỗi rác → bỏ qua; DB cũ thiếu hai cột → sau migration có cột, giá trị `0`.
- [ ] **Step 2: Test Zalo:** `handleZaloReceiptEvents` với mảng gồm một phần tử hỏng (`null`, và một object có getter ném lỗi) + một phần tử tốt → phần tử tốt vẫn được ghi; đầu vào không phải mảng → không ném. `seen` chat riêng (`{ threadId, data: { msgId, realMsgId } }`) ghi mốc đã xem theo thời điểm tin tra bằng `msg_id`, không thấy thì `cli_msg_id`; `seen` nhóm (`data.seenUids` có một người) tính đã xem; `delivered` có `data.seen === 1` tính đã xem; `delivered` cho tin không có trong máy dùng `data.mSTs` khi `> 1e12`; id không có trong máy và không có `mSTs` → bỏ qua; sự kiện `isSelf` → bỏ qua cả mốc lẫn `broadcastSeen`. `seen` vẫn gọi `EventBroadcaster.broadcastSeen` một lần mỗi phần tử tốt.
- [ ] **Step 3: Test Facebook:** delta `{ class: 'ReadReceipt', actorFbId, threadKey: { otherUserFbId }, watermarkTimestampMs }` → phát `readReceipt`; delta nhóm dùng `threadKey.threadFbId`; thiếu `actorFbId` hoặc thread `0` → không phát. Tin trong DB có `timestamp` ms và receipt ms: tin gửi lúc `T`, receipt `T + 1` → mốc ≥ `T` (bắt lỗi lệch giây/ms). Receipt do chính mình phát (`actorFbId` = id tài khoản) → không ghi mốc.
- [ ] **Step 4:** đỏ. **Step 5: Implement** module + hai cột + nối: `ZaloLoginHelper` bỏ `listener.on("seen")` (và dòng log dump nguyên sự kiện), thêm `seen_messages` / `delivered_messages` gọi `handleZaloReceiptEvents`; Facebook: `handleDeliveryReceipt` ghi `deliveredTs`, `readReceipt` ghi `readTs`; thêm `event:receipt` vào preload và đường relay.
- [ ] **Step 6:** test xanh. Docs (bảng schema + luồng sự kiện). **Step 7:** Inspect diff.

### Task 11: Hiện "Đã nhận" / "Đã xem" trong khung chat

**Files:** Create `src/ui/lib/chat/messageReceipt.ts`; Modify `src/ui/store/chatStore.ts` (`ContactItem` thêm `peer_delivered_ts?`, `peer_read_ts?`), `src/ui/hooks/useZaloEvents.ts` (cạnh handler `event:seen` 1646), `src/ui/components/chat/ChatWindow.tsx` (khối "Seen indicator" ~3602), và câu truy vấn danh sách hội thoại nếu nó liệt kê cột thay vì `SELECT *`; Test `src/__tests__/ui/messageReceipt.test.ts`. Đọc `DESIGN.md` trước khi sửa UI. Nguồn: upstream `src/ui/lib/chat/messages/messageStatus.ts`.

**Interfaces — Consumes:** `event:receipt` (Task 10). **Produces:** `lastOutgoingReceipt(messages: ReadonlyArray<{ is_sent?: number | boolean | null; timestamp?: number | string | null; msg_id?: string | number; send_status?: string | null }>, receipt: { deliveredTs?: number | null; readTs?: number | null } | null | undefined, channel: string | null | undefined): 'delivered' | 'read' | null`; `receiptLabel(status: 'delivered' | 'read'): 'Đã nhận' | 'Đã xem'`.

- [ ] **Step 1: Test:** tin cuối là tin mình, `timestamp ≤ readTs` → `read`; chỉ `≤ deliveredTs` → `delivered`; lớn hơn cả hai → `null`; tin cuối là tin của người kia → `null`; tin đang gửi/lỗi (`send_status` `pending|sending|failed|timeout`, id `temp_…`) → `null`; kênh `zalo`, `facebook`, và kênh rỗng (mặc định Zalo) được hỗ trợ; `telegram_user`, `telegram_bot` → `null`; danh sách rỗng/`null` → `null`.
- [ ] **Step 2:** đỏ. **Step 3:** viết helper.
- [ ] **Step 4: Nối UI.** `event:receipt` → `updateContact(zaloId, { contact_id: threadId, peer_delivered_ts, peer_read_ts })` (lấy giá trị lớn hơn giá trị đang có). `ChatWindow`: khi khối "Đã xem" có avatar hiện có không hiển thị và `lastOutgoingReceipt` khác `null` → một dòng chữ căn phải cùng kiểu chữ/màu với nhãn "Đã xem" hiện có (token trong `DESIGN.md`, không thêm màu mới). Không hiện hai nhãn cùng lúc.
- [ ] **Step 5:** test xanh + tsc ×2. Chạy app dev, kiểm tra ở chiều rộng desktop và hẹp (~390 px), sáng và tối: nhãn không tràn ngang, không đè chữ, không đẩy ô nhập. **Step 6:** Inspect diff.

### Task 12: Tích hợp, ghi nhận, kiểm chứng

**Files:** Create `src/__tests__/zalo/chatSync.integration.test.ts`; Modify `NOTICE.md`, `SYSTEM_DOCUMENTATION.md`, spec (dòng Trạng thái + "Ghi chú sau triển khai").

- [ ] **Step 1: Test tích hợp** (DB tạm, không mạng): tin Zalo nhóm giao hai lần với id khác → một dòng, giao diện nhận một lần; tin ảnh JXL đi hết đường nhận → nội dung lưu là URL JPG; mình gửi tin → `delivered` → `seen` → `lastOutgoingReceipt` lần lượt `delivered`, `read`; đọc ở máy khác sau đó → chưa đọc về `0` và phát `db:unreadChanged`.
- [ ] **Step 2:** sửa chỗ nối nếu thiếu (không đổi hợp đồng đã review).
- [ ] **Step 3: Docs.** `NOTICE.md`: bảng "Port từ Deplao 26.9.0–26.11.0 (MaiHub, 11/2026)" — nhóm, commit/tệp nguồn, tệp đích, điểm MaiHub khác (R1–R7); đoạn ghi nhận sự việc bridge E2EE build từ `mautrix/meta` (AGPL-3.0) và `src/bridge-e2ee/bridge/` có mã gốc `meta-messenger.js` (AGPL-3.0), nêu rõ đây không phải kết luận pháp lý. Spec: trạng thái chặng A–C, tình trạng Z5 (làm hay hoãn), các ruling.
- [ ] **Step 4:** chạy đủ bộ lệnh kiểm chứng **hai vòng**; số test không giảm so với 3915, nhiễu không vượt 12/2; nêu tên các hành vi cũ đã kiểm (gửi/nhận Zalo, Page inbox, gửi Facebook, đăng nhóm) kèm bằng chứng.
- [ ] **Step 5:** Inspect diff toàn nhánh so `f5a1bd4`; xác nhận không có tệp ngoài phạm vi, không đổi `package.json`, không đổi mã Go.

## Kiểm tay sau khi cài (anh làm, không thuộc test tự động)

Mở Zalo PC rồi xem app tự nối lại trong ~90 s; bấm "Ngắt kết nối" không tự nối lại; nhắn vào nhóm đông không trùng; đọc trên điện thoại thì số chưa đọc mất; nhận ảnh gửi từ Zalo điện thoại; Facebook: nhận tin tăng đúng 1, mở app lúc tắt mạng rồi bật mạng thì tự kết nối, tin Page vẫn về; nhãn "Đã nhận"/"Đã xem" đổi đúng.
