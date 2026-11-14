# Facebook History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tải lịch sử tin nhắn Facebook cá nhân theo cách của bản gốc: khi mở hội thoại, khi kéo lên, và đồng bộ hàng loạt theo khoảng ngày.

**Architecture:** Bridge Go nhận lệnh mới `fetchMessages` (LightSpeed `FetchMessagesTask`) và trả từng trang; lô tin của hội thoại đang chờ không bị phát thành tin mới. Phía TypeScript, `FacebookHistoryFetcher` (phụ thuộc tiêm vào) chọn mốc, gọi GraphQL cho trang mới nhất hoặc bridge cho trang cũ hơn, lưu dạng lịch sử, dưới một bộ giới hạn tốc độ cho mỗi tài khoản. `FacebookHistorySyncService` dùng chính hàm đó để đồng bộ theo khoảng ngày. Giao diện thêm nhánh Facebook vào hai chỗ tải tin sẵn có và một nút đồng bộ cạnh nút Zalo.

**Tech Stack:** Go 1.26 + `mautrix/meta` ghim `e012f9f` (không đổi), Electron/TypeScript, better-sqlite3, React, Jest. Không thêm dependency.

**Spec:** `docs/specs/2026-11-14-facebook-history-sync.md`

**Trạng thái:** Cả 9 task đã triển khai và gộp vào `main` trên máy (14/11/2026), chưa phát hành, chưa thử với tài khoản Facebook thật.

## Global Constraints

- Không commit, không push, không tăng version, không chạm `sites/` và `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. File tạm chỉ nằm trong scratchpad.
- Không gọi Facebook thật trong test; dữ liệu test dựng tay. Không ghi log cookie, token, nội dung tin, URL đính kèm.
- Không thêm dependency (npm lẫn Go). `go.mod`, `go.sum`, `META_COMMIT` không đổi.
- Không port `FacebookHumanPacer` hay bất cứ thứ gì ngẫu nhiên hoá nhịp gọi để giống người dùng. Giới hạn tốc độ dùng hằng số cố định: `HISTORY_MIN_GAP_MS = 2_000`, `HISTORY_MAX_PAGES_PER_HOUR = 120`, `HISTORY_COOLDOWN_MS = 1_800_000`, `HISTORY_INTERACTIVE_MAX_WAIT_MS = 5_000`.
- Định danh trong code bằng tiếng Anh; chữ hiển thị bằng tiếng Việt, gọi người dùng là "bạn".
- Code port từ bản gốc (`<scratchpad>/upstream/deplao-builder`, chỉ đọc, không chạy) ghi nguồn ở đầu file: `Ported from babyvibe/deplao-builder @2162f07 (MIT)`.
- Không đổi hành vi nhận/gửi tin hiện có. `handleTable` chỉ đổi cho hội thoại đang có yêu cầu lịch sử chờ.
- Lệnh Go chạy sau `source <scratchpad>/goenv.sh`, trong `src/bridge-e2ee`: `go vet . ./bridge/...`, `go test . ./bridge/...`, `go build -o <scratchpad>/bridge-out .`. Thư mục `meta/` đã được clone sẵn ở bản ghim.
- Kiểm chứng TypeScript: `TZ=UTC npx jest --runInBand <files>`; cuối task chạy `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` và `-p tsconfig.json`.
- Thay đổi hành vi phải cập nhật `SYSTEM_DOCUMENTATION.md`; `node scripts/check-docs.js` phải sạch.

## Review Focus

1. Tin cũ trả về trong lúc một yêu cầu lịch sử đang chờ **không** được phát thành sự kiện tin mới (thông báo, chưa đọc, workflow). Test: Task 1 (Go), Task 4 (lưu `is_history`, `unread_count` không đổi).
2. Tin cũ nhất đang hiển thị là tin mã hoá hoặc tin tạm (không phải `mid.$…`): mốc phải lùi về tin `mid.$…` gần nhất trong máy; không có thì dùng trang GraphQL. Test: Task 4.
3. Facebook trả lại đúng trang cũ (mốc không lùi): vòng lặp phải dừng. Test: Task 2 (`nextHistoryAnchor`), Task 4 (`syncThread`).
4. Bridge chết, ngắt kết nối hoặc hết giờ giữa chừng: không còn bộ thu treo, không còn promise treo; lượt đồng bộ kết thúc với lý do. Test: Task 1, Task 4, Task 5.
5. Khoảng kết thúc trong quá khứ: phải lùi qua các trang mới hơn mà không lưu chúng; tin trước đầu khoảng không lưu. Test: Task 4.

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/bridge-e2ee/bridge/history.go` (mới) | Bộ thu trang lịch sử, `FetchThreadHistory` |
| `src/bridge-e2ee/bridge/history_test.go` (mới) | Test bộ thu |
| `src/bridge-e2ee/bridge/events.go`, `client.go`, `main.go` | Nối bộ thu, lệnh `fetchMessages` |
| `src/services/facebook/facebookHistory.ts` (mới) | Kiểu và hàm thuần dùng chung main ↔ giao diện |
| `src/services/facebook/FacebookHistoryLimiter.ts` (mới) | Giới hạn tốc độ cho mỗi tài khoản |
| `src/services/facebook/FacebookHistoryFetcher.ts` (mới) | Chọn mốc, tải một trang, lưu, lùi theo khoảng |
| `src/services/facebook/FacebookHistorySyncService.ts` (mới) | Lượt đồng bộ hàng loạt |
| `src/services/facebook/FacebookThreadManager.ts` | Đọc tin GraphQL đầy đủ hơn, `getThreadListPage` |
| `src/services/facebook/FacebookE2EEBridge.ts`, `FacebookService.ts` | `fetchMessages`, các hàm uỷ quyền mỏng |
| `electron/ipc/fbHistoryIpc.ts` (mới) | 4 kênh IPC |
| `src/ui/lib/chat/fbOlderMessages.ts`, `fbHistorySyncView.ts` (mới) | Hàm thuần của giao diện |
| `src/ui/components/layout/FacebookSyncButton.tsx` (mới) | Hộp thoại đồng bộ |

---

### Task 1: Bridge Go — lệnh `fetchMessages`

**Files:** Create `src/bridge-e2ee/bridge/history.go`, `src/bridge-e2ee/bridge/history_test.go`; Modify `src/bridge-e2ee/bridge/events.go` (`handleTable`), `src/bridge-e2ee/bridge/client.go` (struct `Client`, `Disconnect`), `src/bridge-e2ee/main.go`, `src/bridge-e2ee/README.md`, `.github/workflows/build.yml`. Nguồn: upstream `src/bridge-e2ee/bridge/history.go` (242), `main.go:232-270`.

**Interfaces — Produces:**

```go
type HistoryPage struct {
	ThreadID       string     `json:"threadId"`
	Messages       []*Message `json:"messages"`       // newest first, never nil
	HasMoreBefore  bool       `json:"hasMoreBefore"`
	MinTimestampMs int64      `json:"minTimestampMs"`
	MinMessageID   string     `json:"minMessageId,omitempty"`
}
func (c *Client) FetchThreadHistory(ctx context.Context, threadID, beforeTs int64, beforeID string, timeout time.Duration) (*HistoryPage, error)
// deliverHistory feeds range-backed upserts and existing-range answers to waiting collectors;
// returns the thread keys whose upserts were consumed (must not be emitted as live messages).
func (c *Client) deliverHistory(tbl *table.LSTable, upsert map[int64]*table.UpsertMessages) map[int64]bool
```

Lệnh stdin: `{"method":"fetchMessages","params":{"threadId":"123","beforeTimestampMs":0,"beforeMessageId":"","timeoutMs":25000}}` → `data` là `HistoryPage`. Lỗi (chuỗi chính xác, phía TS dựa vào): `threadId is required`, `invalid threadId "<x>"`, `client not initialised`, `Messenger client is not initialised`, `history request already running for thread <id>`, `timed out waiting for Messenger history`, `bridge disconnected`.

- [ ] **Step 1: Viết test trước** (`history_test.go`, dựng `Client` tối thiểu không cần mạng và `table.LSTable` bằng tay). Tách `FetchThreadHistory` thành ba phần để test được phần không cần socket: đăng ký bộ thu (`registerHistoryCollector(threadID, beforeTs) (*historyCollector, func(), error)`), `deliverHistory`, và chờ kết quả (`awaitHistoryPage(ctx, collector, threadID) (*HistoryPage, error)`). Các ca:
  - `TestDeliverHistoryRangePage`: upsert có `Range{HasMoreBefore:true, MinTimestampMs:1000, MinMessageId:"mid.$a"}` và 3 tin → trang 3 tin sắp mới nhất trước, `HasMoreBefore=true`, `MinTimestampMs=1000`, `MinMessageID="mid.$a"`; hàm trả `claimed[thread]=true`.
  - `TestDeliverHistoryDeduplicates`: cùng `MessageId` giao hai lần → một tin.
  - `TestDeliverHistoryExistingRangeEndsChat`: `LSUpdateExistingMessageRange{ThreadKey, TimestampMS: beforeTs}` khi chưa có tin → trang rỗng, `HasMoreBefore=false`, `Messages` là mảng rỗng không phải `nil`.
  - `TestDeliverHistoryIgnoresOtherAnchor`: `TimestampMS` khác `beforeTs` → bộ thu chưa xong.
  - `TestDeliverHistoryNoCollectorClaimsNothing`: không có bộ thu → `claimed` rỗng (hành vi cũ giữ nguyên).
  - `TestDeliverHistoryOtherThreadUntouched`: bộ thu cho hội thoại A, upsert của B → B không bị nhận.
  - `TestRegisterRejectsSecondRequest`: đăng ký lần hai cùng hội thoại → lỗi `history request already running for thread`.
  - `TestAwaitTimesOutAndReleases`: context hết hạn → lỗi `timed out waiting for Messenger history`; sau khi gọi hàm giải phóng, đăng ký lại được.
  - `TestAwaitWithoutRangeUsesOldestMessage`: có tin nhưng không có `Range` → `MinTimestampMs`/`MinMessageID` lấy từ tin cũ nhất, `HasMoreBefore=true`.
- [ ] **Step 2:** `go test ./bridge/...` → FAIL (chưa có symbol).
- [ ] **Step 3: `history.go`** theo bản gốc, chỉnh cho `Client` của mình: không có `lifecycleError`, `regularConnected`, `tableExtras`; `convertWrappedMessage(msg)` một tham số. `FetchThreadHistory`: `threadID == 0` → lỗi; `c.Messagix == nil` → lỗi; `beforeTs <= 0` → `time.Now().UnixMilli()`; `timeout <= 0` → 25 s; gửi `socket.FetchMessagesTask{ThreadKey, Direction: 0, ReferenceTimestampMs, ReferenceMessageId, SyncGroup: 1, Cursor: c.Messagix.GetCursor(1)}`; đưa bảng trả về trực tiếp qua `deliverHistory`; chờ bộ thu, hết giờ, hoặc `c.ctx.Done()` (→ `bridge disconnected`). Luôn gỡ bộ thu khi thoát. Dòng log `History page` chỉ có: thread, reference_ts, có/không reference_id, số tin, range, has_more_before, ended_by.
- [ ] **Step 4: `client.go`**: thêm `historyMu sync.Mutex`, `historyCollectors map[int64]*historyCollector`. **`events.go`**: đầu `handleTable`, sau `WrapMessages`, gọi `claimed := c.deliverHistory(tbl, upsert)`; trong vòng phát upsert bỏ qua `chatUpsert` có thread key nằm trong `claimed`. Không đổi gì khác.
- [ ] **Step 5: `main.go`**: `case "fetchMessages"` như bản gốc — cắt hậu tố `@…` của `threadId`, `strconv.ParseInt`, chạy `FetchThreadHistory` trong goroutine với `recover` (trả `internal bridge error in fetchMessages: …`), giữ biến `client` hiện tại trong closure.
- [ ] **Step 6:** `go test . ./bridge/...` → PASS; `go vet . ./bridge/...` → sạch; `go build -o <scratchpad>/bridge-out .` → exit 0; `git status --porcelain src/bridge-e2ee` không có `go.mod`/`go.sum`.
- [ ] **Step 7:** `README.md` của bridge: thêm `fetchMessages` vào danh sách lệnh và một đoạn ngắn về test (`go test . ./bridge/...`). `.github/workflows/build.yml`: ngay sau bước `npm run build:bridge-e2ee`, thêm bước `Bridge vet and tests` với `working-directory: src/bridge-e2ee`, `run: go vet . ./bridge/... && go test . ./bridge/...` (chạy được trên cả ba hệ điều hành của ma trận; dùng `shell: bash`).

### Task 2: Hàm thuần và bộ giới hạn tốc độ

**Files:** Create `src/services/facebook/facebookHistory.ts`, `src/services/facebook/FacebookHistoryLimiter.ts`; Test `src/__tests__/facebook/facebookHistory.test.ts`, `src/__tests__/facebook/historyLimiter.test.ts`. Nguồn: upstream `src/shared/facebook/facebookHistorySync.ts` (port sát, trừ `pauseReason`).

**Interfaces — Produces:**

```ts
// facebookHistory.ts
export interface FbHistoryRange { fromTs: number | null; toTs: number | null }
export interface FbHistoryAnchor { timestampMs: number; messageId: string }
export type FbHistoryCode = 'NOT_CONNECTED' | 'BRIDGE_DOWN' | 'BRIDGE_OLD' | 'E2EE' | 'FETCH' | 'RISK' | 'COOLDOWN' | 'BUSY' | 'CANCELLED';
export type FbHistorySource = 'lightspeed' | 'graphql';
export type FbHistoryPageResult =
  | { success: true; saved: number; received: number; stored: number; count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string; source: FbHistorySource }
  | { success: false; code: FbHistoryCode; error: string; source?: FbHistorySource };
export type FbHistorySyncStage = 'idle' | 'listing' | 'syncing' | 'completed' | 'failed' | 'cancelled';
export interface FbHistorySyncStatus {
  accountId: string; stage: FbHistorySyncStage; range: FbHistoryRange; message: string; error?: string;
  threadsTotal: number; threadsDone: number; currentThreadName?: string;
  messagesSaved: number; messagesReceived: number; skippedE2EE: number; failedThreads: number;
  startedAt: number; finishedAt?: number; pausedUntil?: number;
}
export const FB_HISTORY_SYNC_EVENT = 'event:fbHistorySync';
export function activityMs(value: unknown): number;                       // seconds or ms → ms; invalid → 0
export function isLightSpeedMessageId(id: unknown): boolean;              // /^mid\.\$./
export function messageInRange(timestampMs: unknown, range: FbHistoryRange): boolean;   // unknown ts → true
export function threadActiveInRange(lastActivity: unknown, range: FbHistoryRange): boolean; // unknown → true
export function nextHistoryAnchor(page: { count: number; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string }, previous: FbHistoryAnchor, range: FbHistoryRange): FbHistoryAnchor | null;
export function isFbHistorySyncActive(status?: Pick<FbHistorySyncStatus, 'stage'> | null): boolean; // listing | syncing
export function emptyFbHistorySyncStatus(accountId: string, range?: FbHistoryRange): FbHistorySyncStatus;

// FacebookHistoryLimiter.ts
export const HISTORY_MIN_GAP_MS = 2_000;
export const HISTORY_MAX_PAGES_PER_HOUR = 120;
export const HISTORY_COOLDOWN_MS = 30 * 60_000;
export const HISTORY_INTERACTIVE_MAX_WAIT_MS = 5_000;
export function isFacebookRiskError(error: unknown): boolean; // /checkpoint|login_required|not logged in|1357001|1357004|1390008/i
export class FacebookHistoryLimiter {
  constructor(now?: () => number);
  cooldownRemaining(): number;                 // ms, 0 when not cooling down
  waitMs(): number;                            // ms until the next request may go (gap + hourly budget), 0 = now
  recordRequest(): void;
  recordResult(ok: boolean, error?: unknown): 'ok' | 'risk'; // risk → cooldown starts
}
```

- [ ] **Step 1: Test trước.** `facebookHistory.test.ts`: `activityMs(1700000000) === 1700000000000`, `activityMs(1700000000123) === 1700000000123`, `activityMs('x') === 0`; `isLightSpeedMessageId('mid.$abc')` true, `'123456'`/`'temp_1'`/`''`/`'mid.$'` false; `messageInRange` ở hai biên (bao gồm biên) và với `null`; `threadActiveInRange(0, …)` true; `nextHistoryAnchor`: `hasMoreBefore=false` → null, `count=0` → null, `minTimestampMs=0` → null, `minTs < fromTs` → null, mốc không lùi (cùng ts và cùng id) → null, bình thường → `{timestampMs, messageId}`. `historyLimiter.test.ts` (đồng hồ giả): yêu cầu đầu `waitMs()===0`; ngay sau `recordRequest` → 2000; sau 2 s → 0; 120 yêu cầu trong một giờ → `waitMs()` bằng thời gian tới khi yêu cầu cũ nhất tròn một giờ; `recordResult(false, 'checkpoint required')` → `'risk'` và `cooldownRemaining()===1_800_000`, hết sau 30 phút; `recordResult(false, 'socket hang up')` → `'ok'`, không cooldown; `isFacebookRiskError` cho từng mẫu và cho `Error`.
- [ ] **Step 2:** chạy → FAIL. **Step 3:** cài đặt. **Step 4:** chạy → PASS; `tsc` hai cấu hình sạch.

### Task 3: Đọc GraphQL — tin đầy đủ hơn và danh sách hội thoại theo trang

**Files:** Modify `src/services/facebook/FacebookThreadManager.ts`; Test `src/__tests__/facebook/graphqlThreadMessages.test.ts`, `src/__tests__/facebook/threadListPage.test.ts`. Nguồn: upstream `FacebookThreadManager.ts` — `fetchThreadMessages` (420-550), `getThreadListPage`, `graphQLBlobType`, `templateFromStoryAttachment`.

**Interfaces — Produces:**

```ts
/** Pure: one GraphQL message node → the message shape fetchThreadMessages returns. */
export function parseGraphQLMessageNode(node: any): {
  id: string; body: string | null; isAdmin: boolean; timestampMs: number; timestamp: number;
  senderId: string; senderName: string;
  attachments: Array<{ id?: string; type: string; url: string | null; name?: string; fileSize?: number; mimeType?: string; [k: string]: any }>;
  reactions: Array<{ userId: string; emoji: string }>; isUnsent: boolean;
  replyToMessageId?: string; replyToSenderId?: string;
};
/** Pure: parsed batch response → page. */
export function parseThreadListPage(dataGet: string, accountId: string, fbUserId: string | undefined, limit: number):
  { threads: Array<FBThread & { lastActivityMs: number }>; nextBefore: number | null; error?: string };
export async function getThreadListPage(dataFB: FBSessionData, accountId: string, before: number | null, limit?: number, httpsAgent?: any, tags?: string[]):
  Promise<{ threads: Array<FBThread & { lastActivityMs: number }>; nextBefore: number | null; error?: string }>;
```

`fetchThreadMessages` giữ nguyên chữ ký và yêu cầu gửi đi; phần `map` chuyển sang `parseGraphQLMessageNode`. Loại đính kèm: `MessageImage`→`image`, `MessageAnimatedImage`→`gif`, `MessageVideo`→`video`, `MessageAudio`→`audio`, `MessageFile`→`file`; video/ghi âm lấy `playable_url`, gif lấy `animated_image.uri`; `node.sticker` → đính kèm `type: 'sticker'`; `extensible_attachment` → thẻ chia sẻ (nếu `facebookTemplateText.ts` hiện có đã có hàm tương đương thì dùng lại, không tạo bản thứ hai); tin hệ thống (`__typename` chứa `AdminText`) lấy chữ từ `snippet`, `isAdmin: true`.

- [ ] **Step 1: Test trước** với node dựng tay: tin chữ; ảnh; video có `playable_url`; ghi âm; gif; sticker; tin hệ thống (`body` từ `snippet`, `isAdmin`); tin thu hồi (`message_type: 'unsent'`); trả lời (`replied_to_message`); thẻ chia sẻ; node thiếu trường → không ném lỗi. `parseThreadListPage`: 50 node → `nextBefore = updated_time_precise` của node cuối trừ 1, `lastActivityMs` theo từng hội thoại; 3 node → `nextBefore: null`; `o0.error` → `error`; JSON hỏng → `error`, không ném.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt; `getThreadList` hiện có không đổi. **Step 4:** PASS + `src/__tests__/facebook/parseThreadNodes.test.ts` vẫn PASS; `tsc` sạch.

### Task 4: `FacebookHistoryFetcher` — tải và lưu một trang, lùi theo khoảng

**Files:** Create `src/services/facebook/FacebookHistoryFetcher.ts`; Modify `src/services/facebook/FacebookE2EEBridge.ts` (thêm `fetchMessages`), `src/services/facebook/FacebookService.ts` (trường `historyLimiter`, `historyFetcher`, các hàm uỷ quyền), `electron/ipc/facebookIpc.ts` (`fb:fetchThreadMessages` lưu qua cùng hàm); Test `src/__tests__/facebook/historyFetcher.test.ts`. Nguồn: upstream `FacebookService.ts` — `resolveHistoryAnchor`, `fetchGraphQLHistoryPage`, `fetchHistoryPage`, `syncThreadHistory`, `persistBridgeMessages`, `persistGraphQLHistory`.

**Interfaces — Consumes:** Task 2 (toàn bộ), Task 3 (`parseGraphQLMessageNode` qua `fetchThreadMessages`), lệnh bridge của Task 1. **Produces:**

```ts
export interface BridgeHistoryPage { threadId: string; messages: any[]; hasMoreBefore: boolean; minTimestampMs: number; minMessageId?: string }
// FacebookE2EEBridge
public fetchMessages(params: { threadId: string; beforeTimestampMs: number; beforeMessageId: string; timeoutMs?: number }): Promise<BridgeHistoryPage>; // call('fetchMessages', {...timeoutMs: 25_000}, 30_000)

export const HISTORY_GRAPHQL_PAGE = 20;
export const HISTORY_TOP_GAP_MS = 60_000;
export const HISTORY_RISK_TEXT = 'Facebook có dấu hiệu hạn chế — đã tạm dừng tải tin cũ 30 phút để bảo vệ tài khoản';
export interface FacebookHistoryDeps {
  accountId: string;                         // fb_accounts.id
  facebookId: () => string;                  // owner_zalo_id in the unified messages table
  bridge: () => { isAlive(): boolean; fetchMessages(p: { threadId: string; beforeTimestampMs: number; beforeMessageId: string }): Promise<BridgeHistoryPage> } | null;
  fetchGraphQLPage: (threadId: string, limit: number) => Promise<{ success: boolean; messages?: any[]; cursor?: { hasMore?: boolean }; error?: string }>;
  limiter: FacebookHistoryLimiter;
  sleep?: (ms: number) => Promise<void>;     // injectable for tests
}
export interface FetchPageOptions { mode?: 'interactive' | 'background'; shouldStop?: () => boolean; onWait?: (ms: number) => void; latestKnownMs?: number }
export class FacebookHistoryFetcher {
  constructor(deps: FacebookHistoryDeps);
  isE2EEThread(threadId: string): boolean;   // fb_threads.is_e2ee = 1 for this account
  persistBridgeMessages(messages: any[], range?: FbHistoryRange): { stored: number; fresh: number; received: number };
  persistGraphQLMessages(threadId: string, messages: any[], range?: FbHistoryRange): { stored: number; fresh: number; received: number };
  fetchPage(threadId: string, anchor: FbHistoryAnchor, range?: FbHistoryRange, opts?: FetchPageOptions): Promise<FbHistoryPageResult>;
  syncThread(threadId: string, range: FbHistoryRange, opts?: { shouldStop?: () => boolean; onPage?: (p: { saved: number; received: number }) => void; onWait?: (ms: number) => void; latestKnownMs?: number }):
    Promise<{ saved: number; received: number; pages: number; complete: boolean; error?: string; code?: FbHistoryCode }>;
}
// FacebookService (thin delegates)
public isPage(): boolean;
public isE2EEThread(threadId: string): boolean;
public historyLimiterFor(): FacebookHistoryLimiter;
public fetchHistoryPage(threadId: string, anchor: FbHistoryAnchor, range?: FbHistoryRange, opts?: FetchPageOptions): Promise<FbHistoryPageResult>;
public syncThreadHistory(...): ReturnType<FacebookHistoryFetcher['syncThread']>;
public getThreadListPage(before: number | null): ReturnType<typeof getThreadListPage>;
public persistGraphQLHistory(threadId: string, messages: any[]): { stored: number; fresh: number; received: number };
```

Quy tắc `fetchPage` (thứ tự cố định):
1. `limiter.cooldownRemaining() > 0` → `COOLDOWN`, lỗi `Đang tạm dừng tải lịch sử Facebook để bảo vệ tài khoản (còn N phút)`.
2. Bỏ hậu tố `@…`; không phải toàn chữ số → `FETCH` `Mã hội thoại không hợp lệ`.
3. `isE2EEThread` → `E2EE` `Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ`.
4. Chọn mốc: mã của người gọi nếu `isLightSpeedMessageId` và `timestampMs > 0`; nếu không, tin `mid.$…` mới nhất trong `messages` (`owner_zalo_id = facebookId()`, `channel = 'facebook'`, `thread_id`, `timestamp <= anchor.timestampMs` hoặc không giới hạn khi mốc là 0); nếu `latestKnownMs` có và tin tìm được cũ hơn `latestKnownMs - HISTORY_TOP_GAP_MS` → coi như không có mốc. Không có mốc → đường GraphQL.
5. Có mốc mà bridge `null`/`!isAlive()` → `BRIDGE_DOWN` `Bridge Facebook chưa chạy (đang kết nối lại) — thử lại sau ít phút`.
6. Giới hạn tốc độ: `interactive` — `waitMs() > HISTORY_INTERACTIVE_MAX_WAIT_MS` → `BUSY` `Đang tải nhiều tin cũ — thử lại sau ít phút`, ngược lại ngủ `waitMs()`; `background` — ngủ `waitMs()` theo từng lát ≤ 1 s, kiểm `shouldStop` giữa các lát (→ `CANCELLED` `Đã huỷ`), gọi `onWait(ms)` một lần khi `ms >= 4_000`.
7. `recordRequest()`, gọi GraphQL (`HISTORY_GRAPHQL_PAGE`) hoặc bridge. Lỗi: `recordResult(false, message) === 'risk'` → `RISK` với `HISTORY_RISK_TEXT`; thông báo khớp `/unknown method/i` → `BRIDGE_OLD` `Bridge Facebook bản cũ chưa hỗ trợ tải lịch sử — khởi động lại MaiHub sau khi cập nhật`; khớp `/not initiali[sz]ed|bridge disconnected|BridgeNotReady/i` hoặc là `BridgeNotReadyError` → `BRIDGE_DOWN`; còn lại → `FETCH` với thông báo gốc.
8. Thành công: lưu (chỉ tin `messageInRange` khi có `range`), trả `saved` = hàng mới, `stored` = mới + được vá, `received` = tin trong khoảng, `count` = tổng tin của trang. GraphQL: `hasMoreBefore` = có tin `mid.$…` và (`count >= HISTORY_GRAPHQL_PAGE` hoặc `cursor.hasMore`), `minTimestampMs`/`minMessageId` = tin `mid.$…` cũ nhất. Bridge: lấy từ trang; `minTimestampMs` thiếu thì lấy nhỏ nhất của các tin.

Lưu: `DatabaseService.saveFBMessage({ …, is_history: true })`; `is_self` = người gửi là `facebookId()`; `type` từ đính kèm đầu (`image|video|audio|sticker|gif|file`), tin hệ thống `'system'`, còn lại `'text'`; `thread_id` đã bỏ hậu tố. Dùng lại cách `handleBridgeGroupMessage` ánh xạ đính kèm của bridge. `fresh`/`stored` suy từ `FbSaveOutcome` (`'new'`, `'repaired'`, `'duplicate'`).

`syncThread`: mốc đầu `{ timestampMs: range.toTs ?? 0, messageId: '' }`; lặp `fetchPage(mode: 'background')`; `CANCELLED` → `complete: false` không lỗi; `FETCH` thử lại đúng một lần liên tiếp; lỗi khác → trả `error` + `code`; sau mỗi trang gọi `onPage`, tính `nextHistoryAnchor`; null → `complete: true`. `latestKnownMs` chỉ truyền ở trang đầu và khi `range.toTs == null`.

- [ ] **Step 1: Test trước** (DB tạm thật như các test database khác, bridge giả, GraphQL giả, đồng hồ giả, `sleep` giả):
  - cooldown → `COOLDOWN`, không gọi mạng; mã hội thoại xấu → `FETCH`; hội thoại `is_e2ee=1` → `E2EE`.
  - không có tin `mid.$…` trong máy → gọi GraphQL với 20, không gọi bridge; `source: 'graphql'`.
  - mốc người gọi `mid.$x` → bridge nhận đúng `beforeTimestampMs`/`beforeMessageId`.
  - mốc người gọi là mã số (tin mã hoá) nhưng máy có `mid.$y` cũ hơn → bridge được gọi với `mid.$y` và thời điểm của nó.
  - `latestKnownMs` mới hơn tin trong máy quá 60 s → GraphQL.
  - bridge `null` → `BRIDGE_DOWN`; ném `unknown method: fetchMessages` → `BRIDGE_OLD`; ném `bridge disconnected` → `BRIDGE_DOWN`; ném `checkpoint` → `RISK` và lần gọi sau → `COOLDOWN`; ném `timed out waiting for Messenger history` → `FETCH`.
  - `interactive` khi `waitMs` > 5 s → `BUSY`; `background` chờ rồi gọi, `shouldStop` trong lúc chờ → `CANCELLED`.
  - lưu: trang 3 tin → 3 hàng `messages` kênh facebook, `fb_threads.unread_count` không đổi, `last_message_preview` không đổi; gọi lại cùng trang → `saved: 0`, không hàng trùng.
  - khoảng: `fromTs`/`toTs` chỉ lưu tin trong khoảng; `received` đếm tin trong khoảng; `count` đếm cả trang.
  - `syncThread`: ba trang rồi `hasMoreBefore=false` → `pages: 3`, `complete: true`; tin cũ nhất trước `fromTs` → dừng; bridge trả lại đúng trang cũ → dừng, không lặp vô hạn; `FETCH` một lần rồi thành công → tiếp tục; `FETCH` hai lần liên tiếp → `error`, `code: 'FETCH'`; khoảng kết thúc trong quá khứ → các trang mới hơn `toTs` được duyệt nhưng không lưu.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt `FacebookHistoryFetcher`, `fetchMessages` của bridge, và các hàm uỷ quyền trong `FacebookService` (tạo `historyLimiter` và `historyFetcher` một lần cho mỗi service; `bridge: () => this.e2eeBridge`, `fetchGraphQLPage: (id, limit) => this.fetchThreadMessages(id, limit)`). `fb:fetchThreadMessages` trong `facebookIpc.ts`: thay vòng `saveFBMessage` bằng `service.persistGraphQLHistory(threadId, result.messages)`; kết quả trả về không đổi.
- [ ] **Step 4:** PASS; toàn bộ `src/__tests__/facebook` PASS; `tsc` hai cấu hình sạch.

### Task 5: `FacebookHistorySyncService` — đồng bộ theo khoảng ngày

**Files:** Create `src/services/facebook/FacebookHistorySyncService.ts`; Test `src/__tests__/facebook/historySyncService.test.ts`. Nguồn: upstream `src/services/facebook/history/FacebookHistorySyncService.ts` (354); mẫu phát sự kiện và ngắt quãng: `src/services/zalo/mobileSync/MobileSyncService.ts`.

**Interfaces — Consumes:** Task 2, Task 4. **Produces:**

```ts
export interface FbHistorySyncTarget {
  isConnected(): boolean;
  getStatus(): string;                        // 'cookie_expired' stops the run
  getAccountId(): string;                     // fb_accounts.id
  isPage(): boolean;
  isE2EEThread(threadId: string): boolean;
  historyLimiterFor(): FacebookHistoryLimiter;
  getThreadListPage(before: number | null): Promise<{ threads: Array<{ id: string; name?: string; lastActivityMs: number; [k: string]: any }>; nextBefore: number | null; error?: string }>;
  syncThreadHistory(threadId: string, range: FbHistoryRange, opts: { shouldStop: () => boolean; onPage: (p: { saved: number; received: number }) => void; onWait: (ms: number) => void; latestKnownMs?: number }):
    Promise<{ saved: number; received: number; pages: number; complete: boolean; error?: string; code?: FbHistoryCode }>;
}
export const MAX_THREAD_PAGES = 400;
export default class FacebookHistorySyncService {
  static getInstance(): FacebookHistorySyncService;
  getStatus(accountId: string): FbHistorySyncStatus | null;
  start(accountId: string, range: FbHistoryRange, getService: () => Promise<FbHistorySyncTarget | null>): { success: boolean; status: FbHistorySyncStatus; error?: string };
  cancel(accountId: string): { success: boolean; status: FbHistorySyncStatus | null };
}
```

`accountId` ở đây là `facebook_id` (khoá phía giao diện). Sự kiện `FB_HISTORY_SYNC_EVENT` mang bản sao trạng thái, tối đa một lần mỗi 400 ms trừ khi đổi bước/kết thúc; phát theo cùng cách `MobileSyncService` phát `event:mobileSync` (không chuyển tiếp cho nhân viên). Chữ hiển thị:

- bắt đầu: `Đang lấy danh sách hội thoại…`; trong lúc liệt kê: `Đang lấy danh sách hội thoại… (N)`; tải: `Đang tải tin nhắn N hội thoại…`; không có hội thoại: `Không có hội thoại nào trong khoảng thời gian này`; đang dừng: `Đang dừng…`.
- xong: `Đã đồng bộ N hội thoại, M tin mới`; huỷ: `Đã dừng — đã lưu M tin mới`.
- lỗi: `Đang đồng bộ tài khoản này` (start khi đang chạy); `Tài khoản Facebook chưa kết nối — kết nối lại rồi đồng bộ`; `Tài khoản Page chưa hỗ trợ đồng bộ lịch sử`; `Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản`; `Tài khoản Facebook mất kết nối — đã dừng đồng bộ`; `Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản`.

Liệt kê hội thoại: trước mỗi trang chờ `limiter.waitMs()` (ngắt được), `recordRequest`, `getThreadListPage(before)`; lỗi → `recordResult(false, error)`; `'risk'` hoặc `isFacebookRiskError` → kết thúc `failed`; lỗi thường → dừng liệt kê, dùng những gì đã có. Lưu trang bằng `DatabaseService.saveFBThreads(internalId, threads)` (bỏ trường `lastActivityMs`). Dừng khi `nextBefore == null`, khi hội thoại cũ nhất của trang trước `range.fromTs`, hoặc đủ `MAX_THREAD_PAGES`. Gộp thêm `fb_threads` (id, name, last_message_at, is_e2ee) và `contacts` kênh facebook của chủ. Lọc `threadActiveInRange`, sắp mới nhất trước.

Từng hội thoại: kiểm `getStatus()`/`isConnected()` trước; mã hoá → `skippedE2EE += 1`, `threadsDone += 1`; ngược lại `syncThreadHistory`; `code` thuộc `BRIDGE_DOWN|BRIDGE_OLD|RISK|COOLDOWN` → kết thúc `failed` với `error` đó; `E2EE` → `skippedE2EE`; lỗi khác → `failedThreads`; không huỷ → `threadsDone += 1`. `onWait(ms)` đặt `pausedUntil = now + ms` và phát; `onPage` cộng dồn, xoá `pausedUntil`, phát. Log mỗi hội thoại: id, số trang, received, saved, code — không tên, không nội dung.

- [ ] **Step 1: Test trước** (dịch vụ giả, đồng hồ giả, bắt sự kiện bằng spy trên bộ phát; DB tạm thật): start khi dịch vụ `null`/chưa kết nối → `failed` đúng chữ; Page → `failed`; hai `start` cùng tài khoản → lần hai `success:false`, `Đang đồng bộ tài khoản này`; liệt kê hai trang rồi `nextBefore:null`; dừng liệt kê khi hội thoại cũ nhất trước `fromTs`; gộp hội thoại trong máy, không trùng id; lọc theo khoảng và thứ tự mới nhất trước; hội thoại mã hoá được đếm và bỏ qua, `syncThreadHistory` không được gọi cho nó; hội thoại lỗi `FETCH` → `failedThreads`, lượt vẫn `completed`; `RISK` → `failed`, các hội thoại sau không được gọi; `cookie_expired` giữa chừng → `failed`; huỷ giữa hội thoại → `cancelled`, chữ `Đã dừng — đã lưu M tin mới`; lỗi rủi ro khi liệt kê → `failed`; trạng thái cuối luôn được phát (không bị giới hạn 400 ms nuốt); `getStatus` sau khi xong trả trạng thái cuối; chạy lại sau khi xong được.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt. **Step 4:** PASS; `tsc` sạch; không còn timer treo (Jest không báo "did not exit").

### Task 6: IPC, preload, kiểu phía giao diện

**Files:** Create `electron/ipc/fbHistoryIpc.ts`; Modify `electron/ipc/facebookIpc.ts` (chỉ `export` hai hàm `resolveInternalId`, `getFBServiceOrReconnect` nếu chưa export), `electron/main.ts` (đăng ký cạnh `registerMobileSyncIpc`), `electron/preload.ts`, `src/ui/lib/ipc.ts`; Test `src/__tests__/facebook/fbHistoryIpc.test.ts`. Mẫu: `electron/ipc/mobileSyncIpc.ts` và `src/__tests__/zalo/mobileSyncIpc.test.ts`.

**Interfaces — Consumes:** Task 4, Task 5. **Produces:**

```ts
export function registerFbHistoryIpc(): void;
// channels
'fb:fetchOlderMessages'  { accountId: string; threadId: string; beforeTimestampMs?: number; beforeMessageId?: string } → FbHistoryPageResult
'fb:historySync:start'   { accountId: string; fromTs: number | null; toTs: number | null } → { success: boolean; status?: FbHistorySyncStatus; error?: string }
'fb:historySync:cancel'  { accountId: string } → { success: boolean; status?: FbHistorySyncStatus | null; error?: string }
'fb:historySync:status'  { accountId: string } → { success: true; status: FbHistorySyncStatus | null }
// preload / ipc.ts
ipc.fb.fetchOlderMessages(params)
ipc.fbHistorySync: { start(accountId, range: FbHistoryRange), cancel(accountId), getStatus(accountId) }
// 'event:fbHistorySync' added to the preload allow-list
```

Quy tắc: workspace đang mở là `remote` → `{ success: false, code: 'NOT_CONNECTED', error: 'Chỉ chủ tài khoản (máy đang đăng nhập Facebook) mới tải được lịch sử tin nhắn' }` (các kênh đồng bộ trả cùng `error`, không có `code`). `accountId` phải là chuỗi 1–64 ký tự `[A-Za-z0-9_-]`; `threadId` sau khi bỏ `@…` phải toàn chữ số; `beforeTimestampMs` số hữu hạn ≥ 0 hoặc vắng; `beforeMessageId` chuỗi ≤ 256 hoặc vắng; `fromTs`/`toTs` là `null` hoặc số hữu hạn ≥ 0 → sai thì `Tham số không hợp lệ` (`fetchOlderMessages` kèm `code: 'FETCH'`). Dịch vụ không lấy được → `code: 'NOT_CONNECTED'`, `Tài khoản chưa kết nối. Vui lòng kết nối lại Facebook.`. `service.isPage()` → `code: 'NOT_CONNECTED'`, `Tài khoản Page chưa hỗ trợ tải lịch sử`. `fetchOlderMessages` gọi `service.fetchHistoryPage(threadId, { timestampMs, messageId }, undefined, { mode: 'interactive' })`. Handler không bao giờ ném ra giao diện.

- [ ] **Step 1: Test trước** theo mẫu `mobileSyncIpc.test.ts` (mock `electron`, dịch vụ giả): từ chối nhân viên ở cả 4 kênh; từng tham số xấu; không có dịch vụ; Page; đường thành công truyền đúng mốc và `mode: 'interactive'`; `start` chuẩn hoá khoảng và gọi `FacebookHistorySyncService.start` với `facebook_id` người gọi đưa vào; handler nuốt lỗi ném ra.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt + preload + kiểu trong `ipc.ts` (import kiểu từ `../../services/facebook/facebookHistory`). **Step 4:** PASS; `tsc` hai cấu hình sạch.

### Task 7: Giao diện — tải khi mở hội thoại và khi kéo lên

**Files:** Create `src/ui/lib/chat/fbOlderMessages.ts`; Modify `src/ui/components/chat/ConversationList.tsx` (nhánh "DB trống", cạnh nhánh Telegram ~1397-1410), `src/ui/components/chat/ChatWindow.tsx` (`handleLoadMore` bước 2; xoá `probeFbOlderMessages`, `fbCursorRef`, `fbHasMoreRef` và mọi chỗ gọi; dòng ghi chú mã hoá); Test `src/__tests__/ui/fbOlderMessages.test.ts`.

**Interfaces — Consumes:** `ipc.fb.fetchOlderMessages` (Task 6), `FbHistoryPageResult` (Task 2). **Produces:**

```ts
export const FB_E2EE_HISTORY_NOTE = 'Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ';
export function shouldFetchFbHistoryOnOpen(input: { channel?: string; isEmployee: boolean; localCount: number; alreadyTried: boolean }): boolean;
export function shouldFetchFbOlder(input: { channel?: string; isEmployee: boolean }): boolean;
export function fbOlderAnchor(messages: Array<{ msg_id: string; timestamp?: number }>): { beforeTimestampMs: number; beforeMessageId: string } | null; // oldest non-temp message
export type FbOlderOutcome = { kind: 'loaded'; hasMore: boolean } | { kind: 'stop'; note?: string; warn?: string } | { kind: 'retry' };
export function interpretFbOlderResult(res: FbHistoryPageResult | null | undefined): FbOlderOutcome;
export function fbHistoryTriedKey(accountId: string, threadId: string): string;
```

`interpretFbOlderResult`: thành công → `loaded`, `hasMore = hasMoreBefore && stored > 0`; `E2EE` → `stop` kèm `note: FB_E2EE_HISTORY_NOTE`; `RISK` → `stop` kèm `warn` = `error`; `NOT_CONNECTED|BRIDGE_DOWN|BRIDGE_OLD|BUSY|COOLDOWN|CANCELLED` → `stop`; `FETCH`, `null`, `undefined` → `retry`.

Hành vi:
- **Mở hội thoại** (không phải nhân viên, kênh Facebook, DB trả 0 tin, chưa thử trong lần chạy app này — `Set` ở cấp module theo `fbHistoryTriedKey`): gọi `fetchOlderMessages({ accountId, threadId })`; thành công thì đọc lại DB và `setMessages` như nhánh Telegram. Không chặn việc mở hội thoại; lỗi chỉ `console.warn` không kèm nội dung.
- **Kéo lên** (`handleLoadMore`, sau khi DB trả rỗng, trước "Step 3"): kênh Facebook và không phải nhân viên → `fbOlderAnchor`; gọi IPC; `loaded` → đọc lại DB với `before` như nhánh Telegram và `prependMessages`, `hasMore=false` khi kết quả báo hết hoặc DB không có gì thêm; `stop` → `setHasMore(false)`, có `note` thì hiện dòng ghi chú ở đầu danh sách tin, có `warn` thì `showNotification(warn, 'warning')`; `retry` → `setLoadError(true)` (nút "Lỗi - Thử lại" sẵn có), giữ `hasMore`. `LOAD_MORE_TIMEOUT_MS` (10 s) ngắn hơn thời gian chờ của bridge (25–30 s): với nhánh Facebook, dùng bộ hẹn an toàn 35 s.
- Dòng ghi chú: một dòng chữ nhỏ, căn giữa, ở đầu danh sách tin, dùng màu chữ phụ sẵn có của khung chat (đọc `DESIGN.md` nếu có); xoá khi đổi hội thoại.

- [ ] **Step 1: Test trước** cho mọi hàm thuần (từng kênh, nhân viên, đã thử, `localCount > 0`; `fbOlderAnchor` bỏ `temp_…`, chọn tin có thời điểm nhỏ nhất, danh sách rỗng → null; `interpretFbOlderResult` cho thành công có/không còn tin, từng mã lỗi, `null`).
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt hàm thuần rồi nối vào hai component; không đổi nhánh Zalo/Telegram. **Step 4:** PASS; `tsc -p tsconfig.json` sạch; `grep -n "probeFbOlderMessages\|fbCursorRef\|fbHasMoreRef" src/ui` rỗng.

### Task 8: Giao diện — hộp thoại "Đồng bộ tin nhắn Facebook"

**Files:** Create `src/ui/lib/chat/fbHistorySyncView.ts`, `src/ui/components/layout/FacebookSyncButton.tsx`; Modify `src/ui/components/layout/TopBar.tsx` (một import, một dòng JSX cạnh `MobileSyncButton`); Test `src/__tests__/ui/fbHistorySyncView.test.ts`. Mẫu để theo sát (bố cục, bàn phím, sáng/tối, hẹp/rộng): `src/ui/components/layout/MobileSyncButton.tsx` và `src/ui/lib/chat/mobileSyncView.ts`.

**Interfaces — Consumes:** `ipc.fbHistorySync`, `event:fbHistorySync` (Task 6); `resolveSyncRange`, `refreshPlan`, `mergeThreadMessages`, `nextFocusIndex`, `tabStopIndexes`, kiểu `SyncPreset` từ `mobileSyncView.ts`. **Produces:**

```ts
export const FB_SYNC_TITLE = 'Đồng bộ tin nhắn Facebook';
export const FB_SYNC_ALL_WARNING = 'Tải toàn bộ lịch sử gửi nhiều yêu cầu nhất tới Facebook và có thể chạy nhiều giờ. Chỉ chọn khi thật sự cần.';
export const FB_SYNC_WAITING = 'Đang chờ để không gửi quá nhiều yêu cầu tới Facebook…';
export function isFbSyncRunning(status?: FbHistorySyncStatus | null): boolean;
export function isFbSyncTerminal(status?: FbHistorySyncStatus | null): boolean;       // completed | failed | cancelled
export function fbSyncProgress(status: FbHistorySyncStatus): number;                   // 0–100 by threadsDone/threadsTotal; listing → 0; completed → 100
export function fbSyncNotes(status: FbHistorySyncStatus): string[];                    // 'K hội thoại mã hoá đầu cuối được bỏ qua', 'J hội thoại không tải được'
export function isFbSyncWaiting(status: FbHistorySyncStatus, now: number): boolean;    // running && pausedUntil > now
export function reduceFbSyncStatus(prev: FbHistorySyncStatus | null, next: FbHistorySyncStatus, accountId: string): FbHistorySyncStatus | null; // ignores other accounts and stale events (older startedAt)
```

Hiển thị: nút chỉ hiện khi tài khoản đang chọn là kênh Facebook và `empMode !== 'employee'` (điều kiện nhân viên ở `TopBar` như nút Zalo). Tài khoản Page: nếu bản ghi tài khoản phía giao diện có dấu hiệu Page thì ẩn nút; nếu không có, giữ nút và hiện lỗi main trả về. Hộp thoại theo mục 9 của spec: ba lựa chọn khoảng (mặc định "1 tuần gần nhất"), cảnh báo dưới "Toàn bộ", nút "Bắt đầu đồng bộ"; đang chạy — `status.message`, tên hội thoại đang tải, thanh tiến độ, "M tin mới", dòng chờ khi `isFbSyncWaiting`, nút "Ẩn" và "Dừng đồng bộ"; kết thúc — thông điệp cuối, các ghi chú, nút "Đóng" và "Đồng bộ lại". Mở lại hộp thoại khi đang chạy thì lấy `getStatus`. Khi kết thúc (`completed`/`cancelled`, và `failed` nếu `messagesSaved > 0`): tải lại danh sách hội thoại của tài khoản đó và gộp tin vào hội thoại đang mở bằng `refreshPlan` + `mergeThreadMessages`, đúng như `MobileSyncButton`. Biểu tượng: dùng một icon sẵn có trong `@/components/common/icons` (không thêm thư viện icon).

- [ ] **Step 1: Test trước** cho hàm thuần: chạy/kết thúc theo từng stage; tiến độ 0 khi `threadsTotal=0`, 50 khi 5/10, 100 khi `completed`; ghi chú khi 0 và khi khác 0; đang chờ khi `pausedUntil` ở tương lai và stage đang chạy; `reduceFbSyncStatus` bỏ sự kiện của tài khoản khác và sự kiện có `startedAt` cũ hơn.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt hàm thuần, component, dòng trong `TopBar`. **Step 4:** PASS; `src/__tests__/ui/mobileSyncView.test.ts` vẫn PASS; `tsc -p tsconfig.json` sạch.

### Task 9: Tài liệu, test tích hợp, hai vòng kiểm chứng

**Files:** Create `src/__tests__/facebook/historySync.integration.test.ts`; Modify `SYSTEM_DOCUMENTATION.md`, `NOTICE.md`, `docs/specs/2026-11-14-facebook-history-sync.md` (dòng Trạng thái + "Ghi chú sau triển khai"), plan này (dòng Trạng thái).

- [ ] **Step 1: Test tích hợp** (DB tạm thật, `FacebookHistoryFetcher` thật, `FacebookHistorySyncService` thật, bridge giả trả trang theo mốc, GraphQL giả): tài khoản có 3 hội thoại — một thường có 45 tin (3 trang), một mã hoá, một rỗng; chạy khoảng "toàn bộ" → `completed`, `threadsDone: 3`, `skippedE2EE: 1`, `messagesSaved: 45`, 45 hàng `messages` kênh facebook, `unread_count` mọi hội thoại không đổi; chạy lại → `messagesSaved: 0`, vẫn 45 hàng; một tin đến trực tiếp sau đó (đường lưu thường) vẫn tăng chưa đọc như cũ.
- [ ] **Step 2:** `SYSTEM_DOCUMENTATION.md`: mục mới cho tải lịch sử Facebook (luồng, giới hạn tốc độ và các hằng số, mã lỗi, kênh IPC, sự kiện, lệnh bridge, giới hạn đã biết). `NOTICE.md`: mục "Port từ Deplao 26.11.0 — tải lịch sử Facebook" liệt kê file port (`history.go` port sát; `facebookHistory.ts` port sát; phần còn lại viết lại) và ghi rõ không port `FacebookHumanPacer`.
- [ ] **Step 3: Vòng 1:** `TZ=UTC npx jest --runInBand`; `TZ=America/New_York npx jest --runInBand --randomize --seed=2707`; `TMPDIR=<scratchpad> python3 -m unittest discover -s tools/maihub-bridge/tests`; `tsc` hai cấu hình; `node scripts/check-docs.js`; Go: `go vet`, `go test`, `go build`. Ghi số liệu vào báo cáo.
- [ ] **Step 4: Vòng 2:** `TZ=Asia/Ho_Chi_Minh npx jest --runInBand --randomize --seed=3707` + lặp lại `tsc`, `check-docs`, Go. So với mốc trước đợt: 187 suites / 4500 tests, nhiễu console 12 `console.error` / 2 `console.warn` (UTC), Python 408 OK. Không được có suite hay test nào mất đi.
- [ ] **Step 5:** Soát phạm vi: `git status --porcelain` chỉ gồm file của plan này; `package.json`, `package-lock.json`, `go.mod`, `go.sum`, `scripts/build-bridge-e2ee.js` không đổi; không có file kiểu `.bak`/`-v2`.
