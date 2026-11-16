# Hộp thư Page nối trực tiếp — kế hoạch đợt 1 (nhận tin, danh sách hội thoại, tin cũ)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tài khoản Page nhận tin đủ loại, có danh sách hội thoại lúc nối và tải được tin cũ, qua một kết nối MQTT lightspeed viết bằng TypeScript.

**Architecture:** `FacebookPageInbox` phát sự kiện cùng dạng với cầu nối Go (`{ type, data }`) và có `isAlive()` / `fetchMessages()` cùng chữ ký, nên `FacebookService.handleBridgeEvent` và `FacebookHistoryFetcher` dùng lại nguyên. Giải mã tách thành hai lớp hàm thuần: chương trình `step` → lời gọi thủ tục → dữ liệu có kiểu.

**Tech Stack:** TypeScript, `mqtt` + `ws` (đã có), `axios`, Jest. Không đụng Go.

**Spec:** `docs/specs/2026-11-16-facebook-page-inbox-direct.md`

## Global Constraints

- Nhánh `feat/page-inbox-direct`; không stage `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`.
- Kho công khai: fixture chỉ dùng id/chữ/URL giả; log không có nội dung tin, cookie, con trỏ, mã thiết bị.
- Số 64 bit đi qua JSON ở dạng chuỗi (`@big:` rồi bỏ nháy), không qua `number`.
- Đợt 1 chỉ đọc: không gửi tác vụ 21 (đã đọc), 46 (gửi tin).
- Không chép mã mautrix-meta; chỉ dùng số thứ tự trường (bảng dưới).
- Tắt bằng `MAIHUB_FB_PAGE_INBOX=0`; mặc định bật cho Page có `delegate_page_id`.
- Xác minh trước khi báo xong: `tsc` hai dự án, Jest ba lượt (UTC; NY seed 2707; HCM seed 3707), `node scripts/check-docs.js`.

## Giao thức (đã kiểm trên tài khoản thật, 26.37.13)

- Trang: `GET https://business.facebook.com/latest/inbox/all/?asset_id=<pageId>`, cookie cá nhân (`c_user, xs, datr, fr, sb`). Đọc: con trỏ 205, `version`, `bloks_version`, `MqttWebDeviceID.clientID`.
- MQTT: `wss://edge-chat.facebook.com/chat?region=eag&sid=<s>&cid=<deviceId>`, `MQIsdp` v3, clientId `mqttwsclient`, keepalive 15, `Origin: https://business.facebook.com`. Username: xem `pageInboxUsername` trong bản thử (`aid` 514771569228061, `p`, `aids.PAGE`, `d` = deviceId).
- Sau CONNECT: publish `/ls_app_settings {ls_fdid:"", ls_sv:<version>}` qos1; subscribe `/ls_foreground_state`, `/ls_resp`; `/ls_req` đồng bộ 205 loại 2 từ con trỏ; tác vụ 313 (danh sách hội thoại).
- `/ls_req`: `{app_id, payload:<json>, request_id, type}`; loại 1/2 = đồng bộ, loại 3 = tác vụ `{epoch_id, tasks:[{failure_count:null,label,payload:<json>,queue_name,task_id}], version_id}`.
- Tác vụ 228 (tin cũ): `{thread_key, direction:0, reference_timestamp_ms, reference_message_id, sync_group:205, cursor}`, queue `mrq.<thread>`. Trả lời đến bằng một phản hồi đẩy có `upsertMessage…` + `insertNewMessageRange` (còn tin) hoặc `updateExistingMessageRange` (hết tin).
- Phản hồi: `{request_id|null, payload:"{name, step}", sp, target}`. Bước dùng: 1 khối, 2 đọc biến, 3 ghi biến, 4 ghi mảng (đặt biến = giá trị thứ hai rồi chạy phần còn lại), 5 gọi thủ tục, 9 trống, 19 số 64 bit từ chuỗi, 23 điều kiện, 26 phủ định (trả nguyên giá trị, như thư viện tham chiếu: nhánh "chưa có thì chèn" luôn chạy).

### Số thứ tự trường (args của thủ tục, đếm từ 0)

| Thủ tục | Trường |
|---|---|
| `insertMessage`, `upsertMessage`, `deleteThenInsertMessage` | text 0, threadKey 3, timestampMs 5, messageId 8, offlineThreadingId 9, senderId 10, stickerId 11, isAdminMessage 12, isUnsent 17, replySourceId 23, replySnippet 27, replyToUserId 29 |
| `insertBlobAttachment` | filename 0, filesize 1, playableUrl 3, previewUrl 8, previewWidth 14, previewHeight 15, playableDurationMs 22, threadKey 27, attachmentType 29, mimeType 30, messageId 32, attachmentFbid 34 |
| `insertStickerAttachment` | previewUrl 4, previewWidth 9, previewHeight 10, threadKey 14, messageId 18, attachmentFbid 19 |
| `insertXmaAttachment` | threadKey 25, messageId 30, actionUrl 57, titleText 58 |
| `upsertReaction` | threadKey 0, timestampMs 1, messageId 2, actorId 3, reaction 4 |
| `deleteReaction` | threadKey 0, messageId 1, actorId 2 |
| `updateReadReceipt` | watermarkMs 0, threadKey 1, contactId 2 |
| `deleteThenInsertThread` | lastActivityMs 0, snippet 2, threadName 3, pictureUrl 4, threadKey 7, unreadCount 89 |
| `verifyContactRowExists`, `deleteThenInsertContact` | contactId 0, pictureUrl 2, name 3 |
| `insertNewMessageRange` | threadKey 0, minMessageId 3, minTimestampMs 5, hasMoreBefore 7 |
| `updateExistingMessageRange` | threadKey 0, timestampMs 1 (mốc của yêu cầu tin cũ mà nó trả lời; 0 hoặc bằng mốc đang chờ thì là trả lời, cùng quy tắc với `src/bridge-e2ee/bridge/history.go`) |
| `executeFirstBlockForSyncTransactionV4` | database 0, nextCursor 3, syncStatus 5 |
| `updateTypingIndicator` | threadKey 0, senderId 1, isTyping 2 |

Loại đính kèm (`attachmentType`): 2, 8 ảnh (URL = preview); 3 gif (playable, thiếu thì preview); 4, 9 video (playable); 5 audio; 12 voice → audio; 6 và còn lại tệp (playable, thiếu thì preview). Nhãn dán: `type: 'sticker'`, URL = previewUrl.

## Review Focus

1. Phản hồi có thủ tục lạ hoặc bước lạ: phần còn lại vẫn phải ra tin.
2. Một tin có nhiều đính kèm và đính kèm lặp `attachmentFbid`: không nhân đôi.
3. id hội thoại lớn hơn 2^53: không mất chữ số từ giải mã tới tác vụ 228.
4. Tin của chính Page (senderId = `delegate_page_id`) trong tin cũ: `is_self = 1`.
5. Kết nối mới đang sống mà thông báo của tài khoản cha vẫn tới: không lưu dòng chữ thay cho ảnh.

---

### Task 1: `lightspeedDecoder.ts`

**Files:** Create `src/services/facebook/lightspeedDecoder.ts`; Test `src/__tests__/facebook/lightspeedDecoder.test.ts`

**Interfaces — Produces:**
```ts
export type LsValue = string | number | boolean | null;         // số 64 bit là chuỗi chữ số
export interface LsCall { name: string; args: LsValue[] }
export function decodeLightspeed(step: unknown, onUnknownStep?: (type: number) => void): LsCall[];
```

- [ ] Test: khối lồng nhau giữ thứ tự gọi; `[19,"9007199254740993123"]` → chuỗi nguyên vẹn; `[9]` → null; mẫu thật `[4,1,1,[5,"checkAuthoritativeMessageExists",…]]` + `[23,[26,[2,1]],[1,[5,"insertMessage",…]]]` ra `insertMessage`; `[23,[2,0],then,else]` với biến 0 chạy `else`; bước lạ (số 99) gọi `onUnknownStep(99)` và các lời gọi sau nó vẫn có; đầu vào không phải mảng → `[]`.
- [ ] Chạy test: đỏ. Viết hàm. Chạy test: xanh.

### Task 2: `pageInboxTables.ts`

**Files:** Create `src/services/facebook/pageInboxTables.ts`; Test `src/__tests__/facebook/pageInboxTables.test.ts`

**Interfaces — Consumes:** `LsCall`. **Produces:**
```ts
export interface InboxAttachment { type: string; url: string | null; fileName?: string; mimeType?: string; fileSize?: number; width?: number; height?: number; duration?: number }
export interface InboxMessage { id: string; threadId: string; senderId: string; text: string; timestampMs: number; attachments: InboxAttachment[]; replyTo?: { messageId: string; senderId?: string; text?: string }; isHistory: boolean; isAdminMsg: boolean; isUnsent: boolean }
export interface InboxThread { id: string; name: string; pictureUrl: string; snippet: string; lastActivityMs: number; unreadCount: number }
export interface InboxContact { id: string; name: string; pictureUrl: string }
export interface InboxRange { threadId: string; hasMoreBefore: boolean; minTimestampMs: number; minMessageId: string }
export interface InboxBatch {
  cursor: string | null; syncStatus: string | null;
  messages: InboxMessage[]; threads: InboxThread[]; contacts: InboxContact[]; ranges: InboxRange[];
  reactions: Array<{ threadId: string; messageId: string; actorId: string; emoji: string }>;       // emoji '' = gỡ
  readReceipts: Array<{ threadId: string; contactId: string; watermarkMs: number }>;
  typing: Array<{ threadId: string; senderId: string; isTyping: boolean }>;
  calls: Record<string, number>;                                                                    // cho log
}
export function readInboxBatch(calls: LsCall[], database?: number): InboxBatch;
```
`isHistory` = thủ tục khác `insertMessage`. Tin thiếu `messageId` hoặc `threadKey` không phải chữ số bị bỏ. `updateExistingMessageRange` → range `{ hasMoreBefore: false, minTimestampMs: 0, minMessageId: '' }`.

- [ ] Test theo Review Focus 2–3 và mỗi loại đính kèm trong bảng; nhãn dán; trả lời; tin hệ thống; cảm xúc thêm/gỡ; đã xem; hội thoại + người liên hệ; con trỏ của cơ sở dữ liệu khác bị bỏ qua.
- [ ] Đỏ → viết → xanh.

### Task 3: `pageInboxProtocol.ts` (tách từ bản thử)

**Files:** Create `src/services/facebook/pageInboxProtocol.ts`; Test `src/__tests__/facebook/pageInboxProtocol.test.ts`. Chuyển từ `pageBridgeProbe.ts`: `pageInboxLogin`, `pageInboxUsername`, `syncRequest`, `threadListRequest`, `historyRequest`, `readInboxPage`, `fetchInboxPage`, `connectInbox`, hằng số. Test tương ứng chuyển theo (kể cả test gói CONNECT với máy chủ cục bộ).

- [ ] Chuyển mã và test; test xanh.

### Task 4: `FacebookPageInbox.ts`

**Files:** Create `src/services/facebook/FacebookPageInbox.ts`; Test `src/__tests__/facebook/facebookPageInbox.test.ts`

**Interfaces — Produces:**
```ts
export interface PageInboxDeps { accountId: string; pageId: string; getCookie: () => string; agent?: unknown;
  connect?: ConnectInbox; fetchPage?: FetchInboxPage; now?: () => number; setTimer?/clearTimer? (mặc định setTimeout/clearTimeout) }
export class FacebookPageInbox extends EventEmitter {
  start(): Promise<void>;            // không ném: lỗi → hẹn nối lại
  stop(): void;
  isAlive(): boolean;                // đã có trả lời đồng bộ và socket đang mở
  fetchMessages(p: { threadId: string; beforeTimestampMs: number; beforeMessageId: string }): Promise<BridgeHistoryPage>;
  // sự kiện: 'event' ({ type: 'message'|'reaction'|'seen'|'typing', data }), 'threads' (InboxThread[], InboxContact[]), 'status' ('connected'|'disconnected')
}
```
Quy tắc: `fetchMessages` thứ hai cùng hội thoại khi lần đầu chưa xong → lỗi chứa `history request already running`; quá 30 s → lỗi `Facebook không trả lời`; tin thuộc hội thoại đang chờ tin cũ không phát thành sự kiện `message` mà trả về qua promise. Nối lại: giãn cách theo `e2eeReconnectDelayMs` (10 s nhân đôi, trần 5 phút), dùng lại deviceId + con trỏ; không có trả lời đồng bộ trong 10 s hoặc 3 lần hỏng liên tiếp → tải lại trang. Sự kiện `message` mang `data` = `InboxMessage` (cùng tên trường với Message JSON của cầu nối).

- [ ] Test: trình tự lúc nối; tin mới thành sự kiện; `threads` phát một lần mỗi phản hồi có hội thoại; `fetchMessages` thành công / hết tin / trùng / quá hạn; nối lại dùng con trỏ mới nhất; 3 lần hỏng → gọi `fetchPage` lần nữa; `stop()` huỷ hẹn giờ và không nối lại.
- [ ] Đỏ → viết → xanh.

### Task 5: Nối vào `FacebookService`

**Files:** Modify `src/services/facebook/FacebookService.ts`, `src/services/facebook/FacebookHistoryFetcher.ts`; Test `src/__tests__/facebook/pageInboxService.test.ts` (và test fetcher sẵn có).

- [ ] `FacebookHistoryDeps.isOwnSender?: (senderId: string) => boolean`; `saveRows` dùng nó (mặc định so `facebookId()` như cũ). Test: tin cũ của Page có `is_self = 1`.
- [ ] Service Page: sau khi kết nối chính xong, nếu `_delegatePageId` và cờ không tắt → tạo `FacebookPageInbox`, `on('event', e => this.handleBridgeEvent(e))`, `on('threads', …)` lưu bằng `saveFBThreads` (tên/ảnh lấy từ người liên hệ cùng id khi hội thoại không có tên); `stop()` trong `disconnect()` (cùng chỗ đóng trình duyệt Page). `historyFetcher` của Page: `bridge: () => this.pageInbox`. `handleBridgeGroupMessage`: `type: this._isPage ? 'user' : 'group'`.
- [ ] `public isPageInboxLive(): boolean`; `handlePageMessageNotification` (tài khoản cha) trả về sớm khi `FacebookConnectionManager.get(page.id)?.isPageInboxLive()`. Test: Review Focus 5 cả hai chiều.
- [ ] Gỡ `pageBridgeProbe.ts`, test của nó, cờ thử, trường `pageBridgeProbe` trong service.

### Task 6: Tài liệu, kiểm tra, phát hành 26.38.0

- [ ] `SYSTEM_DOCUMENTATION.md` mục 4.11 (luồng mới, giới hạn đã biết, cờ tắt; gỡ đoạn bản thử, giữ kết quả), dòng phiên bản; `NOTICE.md` (nguồn gốc bộ giải mã); `ChangelogSettings.tsx`; `package.json` + lock; dòng Trạng thái của spec.
- [ ] Ba lượt Jest, hai lượt `tsc`, `check-docs`; rà diff; một lượt review độc lập (subagent Sonnet) trên diff; sửa phát hiện.
- [ ] Gộp `main`, tag `v26.38.0`, đẩy, chờ CI, cài, báo anh các bước thử theo spec mục 4.
