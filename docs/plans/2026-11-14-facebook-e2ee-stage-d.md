# Facebook E2EE Stage D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn tất chặng D của spec độ ổn định: thiết bị mã hoá đầu cuối Facebook được giữ lại giữa các lần mở app (F8), mở hội thoại thì gửi "đã đọc" thật lên Facebook (F7), tin cũ bridge phát lại lúc kết nối được lưu im lặng (F9).

**Architecture:** Bridge Go đã có sẵn chế độ nhận/trả trạng thái thiết bị dạng chuỗi JSON (`deviceData`, sự kiện `deviceDataChanged`); chặng này bật chế độ đó, bỏ bước đăng ký khi thiết bị được khôi phục, và báo khi Facebook đăng xuất thiết bị. Phía TypeScript, một lớp nhỏ `FacebookE2EEDeviceStore` lưu chuỗi đó vào bảng settings của DB boss, mã hoá bằng `safeStorage` qua `SecureSettingsService` (cùng cách đang lưu cookie Facebook). Chuỗi này chứa khoá riêng nên bị chặn trước hàng đợi sự kiện và không bao giờ đi qua log. `markRead` là lệnh mới của bridge (đã có hàm Go `MarkRead`). Tin từ lô upsert mang cờ `isHistory` và đi đường lưu lịch sử sẵn có.

**Tech Stack:** Go 1.26 + `mautrix/meta` ghim `e012f9f` (không đổi), Electron/TypeScript, better-sqlite3, Jest. Không thêm dependency.

**Spec:** `docs/specs/2026-11-13-chat-sync-reliability.md` (mục F7, F8, F9, mục 9, mục 11)

**Trạng thái:** Cả 4 task đã triển khai, gộp vào `main` và phát hành trong 26.37.0 (14/11/2026); lỗi nhận tin mã hoá lộ ra ở lần chạy thật được sửa trong 26.37.1 (xem cuối tài liệu).

## Global Constraints

- Không commit, không push, không tăng version, không chạm `sites/` và `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. File tạm chỉ nằm trong scratchpad.
- Repo là PUBLIC: không đưa cookie, khoá, id tài khoản thật, nội dung tin thật vào code, test hay tài liệu. Dữ liệu test dựng tay.
- Không gọi Facebook thật trong test. Không chạy app Electron.
- Trạng thái thiết bị (`deviceData`) chứa khoá riêng: không ghi log (kể cả một phần, kể cả độ dài kèm nội dung), không đưa vào thông báo lỗi, không gửi ra ngoài tiến trình app, không ghi ra file ngoài DB.
- Không thêm dependency (npm lẫn Go). `go.mod`, `go.sum`, `META_COMMIT` không đổi.
- Không port `FacebookHumanPacer` hay thứ gì ngẫu nhiên hoá nhịp gọi.
- Định danh trong code bằng tiếng Anh; chú thích theo lệ của file đang sửa; chữ hiển thị bằng tiếng Việt.
- Code lấy ý từ bản gốc (`<scratchpad>/upstream/deplao-builder`, chỉ đọc, không chạy) ghi nguồn tại chỗ: `Ported from babyvibe/deplao-builder @2162f07 (MIT)`.
- Không đổi hành vi gửi tin, tải lịch sử (`fetchMessages`), Page, MQTT. Tin mã hoá (`e2eeMessage`) luôn đi luồng tin mới, không xét thời điểm.
- Lệnh Go chạy sau `source <scratchpad>/goenv.sh`, trong `src/bridge-e2ee`: `go vet . ./bridge/...`, `go test -race -count=1 . ./bridge/...`, `go build -o <scratchpad>/bridge-out .`.
- Lệnh TypeScript: `TZ=UTC npx jest --runInBand <đường dẫn test>` cho test của task; `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` và `-p tsconfig.json`.

## Review Focus

1. **Khoá lọt vào log.** `handleBridgeEvent` ghi 200 ký tự đầu của mọi sự kiện, và stderr của bridge được chép vào log app. Sự kiện `deviceDataChanged` phải bị chặn trước hàng đợi; Go không in nội dung thiết bị ra stderr. (Task 1, Task 2)
2. **Thiết bị đã lưu bị Facebook từ chối.** Người dùng gỡ thiết bị trong cài đặt Facebook, hoặc Facebook đăng xuất nó: app phải xoá trạng thái đã lưu và đăng ký thiết bị mới, không kẹt mãi. (Task 1, Task 2)
3. **Trạng thái sống lại sau khi xoá.** Bản chụp đến muộn hoặc hẹn ghi đang chờ không được ghi lại sau `clear()` hay sau khi xoá tài khoản. (Task 1, Task 2)
4. **Tin mới bị coi là tin cũ.** Tin đến trong lô upsert nhưng mới hơn 5 phút vẫn phải đi luồng tin mới (thông báo, chưa đọc). (Task 3)
5. **Mã hội thoại lớn hơn 2^53 và mã không phải số.** `markRead` truyền mã dạng chuỗi; mã có `@…`, mã rỗng, tài khoản Page không gọi bridge. (Task 1, Task 3)

---

### Task 1: Bridge Go — khôi phục thiết bị, `markRead`, cờ `isHistory`

**Files:**
- Modify: `src/bridge-e2ee/bridge/client.go` (`NewClient`, `ConnectE2EE`, `DeviceStore`, `Save`)
- Modify: `src/bridge-e2ee/bridge/store.go` (`DeleteDevice`)
- Modify: `src/bridge-e2ee/bridge/events.go` (`Message`, `handleTable`, `handleE2EEEvent`)
- Modify: `src/bridge-e2ee/main.go` (lệnh `markRead`, `parseMarkReadParams`)
- Modify: `src/bridge-e2ee/README.md` (bảng lệnh/sự kiện)
- Test: `src/bridge-e2ee/bridge/device_test.go` (mới), `src/bridge-e2ee/bridge/history_test.go`, `src/bridge-e2ee/main_test.go`

**Interfaces:**
- Consumes: không.
- Produces (Task 2, 3 dựa vào):
  - `newClient` với `e2eeMemoryOnly: false`, không có `devicePath`: thiết bị nằm trong bộ nhớ và mỗi lần đổi trạng thái phát sự kiện `deviceDataChanged` `{ "deviceData": "<json>" }`. Có thêm `deviceData` thì khôi phục từ chuỗi đó; chuỗi hỏng thì tạo thiết bị mới (không báo lỗi).
  - `connectE2EE` bỏ bước đăng ký khi thiết bị đã có danh tính máy chủ.
  - Sự kiện `disconnected` `{ "isE2EE": true, "loggedOut": true }` khi Facebook đăng xuất thiết bị; sau đó không còn `deviceDataChanged`.
  - Lệnh `markRead` `{ "threadId": "<chuỗi số>", "watermarkTs": <ms> }` → `{}`.
  - Sự kiện `message` phát từ lô upsert mang `"isHistory": true`.

- [ ] **Step 1: Viết test hỏng** trong `bridge/device_test.go`:

```go
func TestNeedsE2EERegistration(t *testing.T) {
	fresh, _ := NewDeviceStoreMemoryOnly()
	if !needsE2EERegistration(fresh.Device) { t.Fatal("a fresh device must register") }
	fresh.Device.ID = &waTypes.JID{User: "100", Device: 7, Server: waTypes.MessengerServer}
	if needsE2EERegistration(fresh.Device) { t.Fatal("a device with a server identity must not register again") }
	fresh.Device.ID.Device = 0
	if !needsE2EERegistration(fresh.Device) { t.Fatal("device id 0 is not registered") }
	if !needsE2EERegistration(nil) { t.Fatal("nil device must register") }
}

func TestDeviceDataRoundTripKeepsIdentityAndSessions(t *testing.T) {
	// fresh store -> set ID {User:"100", Device:7} -> PutSession(ctx, "peer.1", []byte{1,2,3})
	// -> GetDeviceData() -> NewDeviceStoreFromData(data)
	// expect: same NoiseKey.Priv, IdentityKey.Priv, RegistrationID, ID.User, ID.Device; GetSession("peer.1") == {1,2,3}
}

func TestSavePublishesSnapshotAndStopsAfterDeleteDevice(t *testing.T) {
	// memory store; setOnDataChanged(func(s string){ got = append(got, s) })
	// Save() -> len(got) == 1; DeleteDevice(ctx, ds.Device) -> Save() -> len(got) still 1
}

func TestNewClientFallsBackToNewDeviceOnBadDeviceData(t *testing.T) {
	// NewClient(&ClientConfig{Cookies: map[string]string{}, DeviceData: "{not json", LogLevel: "none"})
	// expect: err == nil, client.DeviceStore.Device != nil, needsE2EERegistration(...) == true
}

func TestNewClientPublishesSnapshotsWithoutDevicePath(t *testing.T) {
	// NewClient(&ClientConfig{Cookies: map[string]string{}, LogLevel: "none"}) (E2EEMemoryOnly false, DevicePath "")
	// client.DeviceStore.Save() -> one deviceDataChanged event on client.Events() whose data["deviceData"] is non-empty
	// and no file named e2ee_device.json is created in the working directory
	// E2EEMemoryOnly: true -> Save() emits nothing
}
```

Trong `bridge/history_test.go`, đổi `TestHandleTableWithoutCollectorEmitsUpserts` để kiểm thêm: tin phát từ upsert có `IsHistory == true`; thêm `TestHandleTableInsertIsNotHistory` (tin từ `insert` có `IsHistory == false`). Trong `main_test.go` thêm `TestParseMarkReadParams`: `{"threadId":"100000000000000001","watermarkTs":5}` → `(100000000000000001, 5, nil)`; thiếu `watermarkTs` → `0`; `threadId` rỗng, `"12@msgr"`, `"-1"`, `"0"`, kiểu số JSON, `watermarkTs` âm → lỗi.

- [ ] **Step 2: Chạy** `go test -race -count=1 . ./bridge/...` — phải FAIL vì thiếu `needsE2EERegistration`, `setOnDataChanged`, `parseMarkReadParams`, `IsHistory`.

- [ ] **Step 3: Sửa `bridge/client.go`**
  - `func needsE2EERegistration(device *store.Device) bool`: `true` khi `device == nil`, `device.ID == nil`, `ID.User == ""` hoặc `ID.Device == 0`.
  - `DeviceStore`: thêm `saveMu sync.Mutex`, `deleted bool` (đọc/ghi dưới `saveMu`); `func (ds *DeviceStore) setOnDataChanged(fn func(string))`.
  - `Save()`: giữ `saveMu` suốt lượt chụp + phát (bản chụp ra theo đúng thứ tự); `deleted` thì trả `nil` không làm gì; phần còn lại như cũ.
  - `NewClient`: thứ tự chọn kho thiết bị: `E2EEMemoryOnly` → bộ nhớ, không phát; `DeviceData != ""` → `NewDeviceStoreFromData`, lỗi thì `logger.Warn().Msg("Stored E2EE device is unusable, creating a new one")` (không kèm nội dung, không kèm `err` nếu `err` chứa dữ liệu) rồi `NewDeviceStoreMemoryOnly`; `DevicePath == ""` → `NewDeviceStoreMemoryOnly`; còn lại → file như cũ. Gắn `setOnDataChanged` phát `EventDeviceDataChanged` khi `!cfg.E2EEMemoryOnly && (cfg.DeviceData != "" || cfg.DevicePath == "")`.
  - `ConnectE2EE`: sau `PrepareE2EEClient`, chỉ gọi `RegisterE2EE` + `Save` khi `needsE2EERegistration(c.DeviceStore.Device)`; lỗi của `Save` trả về. Gọi `AddEventHandler(c.handleE2EEEvent)` **trước** `Connect()` (tin xếp hàng lúc app đóng được giao ngay khi nối).
  - Kiểm tra trong `meta/pkg/messagix` rằng `RegisterE2EE` gán `device.ID`. Nếu ID được gán ở chỗ khác khiến thiết bị khôi phục không có ID, dừng và báo BLOCKED kèm tên hàm.

- [ ] **Step 4: Sửa `bridge/store.go`** — `DeleteDevice`: đặt `deleted = true` dưới `saveMu`; nếu `ds.path != ""` thì `os.Remove(ds.path)` (bỏ qua lỗi không tồn tại). whatsmeow gọi hàm này khi máy chủ đăng xuất thiết bị.

- [ ] **Step 5: Sửa `bridge/events.go`**
  - `Message`: thêm `IsHistory bool` với tag `json:"isHistory,omitempty"`.
  - `handleTable`, vòng upsert chưa được yêu cầu lịch sử nhận: đặt `IsHistory = true` trên tin trước khi phát. Vòng `insert` và `LSInsertMessage` không đổi.
  - `handleE2EEEvent`: thêm `case *events.LoggedOut:` phát `EventTypeDisconnected` với `map[string]any{"isE2EE": true, "loggedOut": true}`.

- [ ] **Step 6: Sửa `main.go`** — `func parseMarkReadParams(raw json.RawMessage) (threadID int64, watermarkTs int64, err error)` theo kiểu `parseFetchMessagesParams` (mã hội thoại là chuỗi số dương); `case "markRead":` gọi `client.MarkRead(threadID, watermarkTs)` (đã có trong `bridge/messages.go`), trả `{}`; `client == nil` → lỗi `client not initialised`.

- [ ] **Step 7: Chạy** `go vet . ./bridge/...`, `go test -race -count=1 . ./bridge/...`, `go build -o <scratchpad>/bridge-out .` — tất cả phải qua.

- [ ] **Step 8: Cập nhật `src/bridge-e2ee/README.md`**: lệnh `markRead`, tham số `deviceData`, sự kiện `deviceDataChanged`, `disconnected.loggedOut`, trường `isHistory`.

---

### Task 2: Lưu thiết bị mã hoá phía TypeScript (F8)

**Files:**
- Create: `src/services/facebook/FacebookE2EEDeviceStore.ts`
- Modify: `src/services/secure/SecureSettingsService.ts` (tham số `db` tuỳ chọn)
- Modify: `src/services/facebook/FacebookE2EEBridge.ts` (`newClient` nhận `deviceData`)
- Modify: `src/services/facebook/FacebookService.ts` (`startE2EEBridge`, `stopE2EEBridge`, `handleBridgeEvent` nhánh `disconnected`)
- Modify: `electron/ipc/facebookIpc.ts` (2 chỗ `secureDelete(fbCookieKey(…))`), `electron/ipc/loginIpc.ts` (1 chỗ `secureDelete(\`fb_cookie_…\`)`)
- Test: `src/__tests__/facebook/e2eeDeviceStore.test.ts` (mới); test nối dây vào file test bridge sẵn có phù hợp nhất (`bridgeSupervision.test.ts` hoặc `bridgeFetchMessages.test.ts`), theo đúng cách các test đó dựng `FacebookService`/bridge giả.

**Interfaces:**
- Consumes (Task 1): `newClient` nhận `deviceData`; sự kiện `deviceDataChanged { deviceData }`; sự kiện `disconnected { isE2EE: true, loggedOut: true }`.
- Produces:

```ts
// SecureSettingsService.ts
export type SettingsDb = Pick<DatabaseService, 'getSetting' | 'setSetting'>;
export function secureSet(key: string, value: string, db?: SettingsDb): void;
export function secureGet(key: string, db?: SettingsDb): string | null;
export function secureDelete(key: string, db?: SettingsDb): void;   // db mặc định DatabaseService.getInstance()

// FacebookE2EEDeviceStore.ts
export const DEVICE_SAVE_DEBOUNCE_MS = 1_000;
export function fbE2EEDeviceKey(accountId: string): string;          // `fb_e2ee_device_${accountId}`
export interface E2EEDeviceStoreDeps {
  runOnBossDb?: (fn: (db: SettingsDb) => void) => void;              // mặc định EventBroadcaster.runOnBossDb (nạp muộn bằng require)
  get?: typeof secureGet; set?: typeof secureSet; remove?: typeof secureDelete;
}
export class FacebookE2EEDeviceStore {
  constructor(accountId: string, deps?: E2EEDeviceStoreDeps);
  load(): string | null;            // null khi chưa có, không giải mã được, hoặc lỗi DB
  save(deviceData: string): void;   // giữ bản mới nhất, ghi sau DEVICE_SAVE_DEBOUNCE_MS
  flush(): void;                    // ghi ngay bản đang chờ (nếu có)
  clear(): void;                    // bỏ bản đang chờ, xoá bản đã lưu
}
export function clearFbE2EEDeviceState(accountId: string): void;     // dùng ở các chỗ xoá tài khoản
```

- [ ] **Step 1: Viết test hỏng** `src/__tests__/facebook/e2eeDeviceStore.test.ts` (đồng hồ giả, `get/set/remove/runOnBossDb` giả ghi lại lời gọi; chuỗi thiết bị dựng tay như `'{"k":"synthetic"}'`):
  - `load()` trả đúng chuỗi `get` trả; `get` ném lỗi → `null`.
  - `save('a'); save('b')` → chưa gọi `set`; tua `DEVICE_SAVE_DEBOUNCE_MS` → `set` gọi đúng một lần với khoá `fb_e2ee_device_acc1` và `'b'`, qua `runOnBossDb`.
  - `save('a'); flush()` → `set` gọi ngay một lần; tua đồng hồ không gọi thêm.
  - `save('a'); clear()` → `remove` gọi với khoá; tua đồng hồ → `set` không được gọi.
  - `set` ném lỗi → không ném ra ngoài; thông báo log không chứa chuỗi thiết bị (spy `Logger.warn`, kiểm mọi tham số không chứa `'synthetic'`).
  - `save('')` và `save` với giá trị không phải chuỗi → bỏ qua.

- [ ] **Step 2: Chạy test** — FAIL vì chưa có module.

- [ ] **Step 3: Viết `FacebookE2EEDeviceStore.ts` và thêm tham số `db` vào `SecureSettingsService.ts`** (mọi lời gọi cũ giữ nguyên hành vi). Log chỉ ghi mã tài khoản và `err.message`.

- [ ] **Step 4: Chạy test của Step 1** — PASS.

- [ ] **Step 5: Viết test hỏng cho phần nối dây** (bridge giả, không tiến trình thật):
  - `startE2EEBridge` gọi `newClient` với `e2eeMemoryOnly: false`; có bản đã lưu thì kèm `deviceData` đúng chuỗi đó, chưa có thì không có khoá `deviceData`.
  - Bridge phát `{ type: 'deviceDataChanged', data: { deviceData: '{"k":"synthetic"}' } }` → kho nhận `save` với chuỗi đó; `handleBridgeEvent` không được gọi cho sự kiện này; không lời gọi `Logger.*` nào chứa `'synthetic'`.
  - Bridge phát `{ type: 'disconnected', data: { isE2EE: true, loggedOut: true } }` → kho nhận `clear()`, bridge bị đóng, có hẹn nối lại. `disconnected` không có `loggedOut` → hành vi cũ (chỉ ghi log).
  - `stopE2EEBridge()` gọi `flush()`.

- [ ] **Step 6: Nối dây**
  - `FacebookE2EEBridge.newClient`: thêm `deviceData?: string`, truyền xuống khi có. Rà cả file: không lời gọi `Logger` nào in tham số của `newClient` hay dữ liệu của sự kiện `deviceDataChanged`.
  - `FacebookService`: trường `private e2eeDeviceStore: FacebookE2EEDeviceStore | null = null` (tạo lười theo `this.accountId`, cho phép test tiêm). Trong `startE2EEBridge`: `load()` trước `newClient`, truyền `e2eeMemoryOnly: false` và `deviceData` nếu có. Trong listener `'event'`, ngay sau kiểm tra thế hệ và **trước** `bridgeEventKey`: sự kiện `deviceDataChanged` → `save(evt.data.deviceData)` rồi `return`.
  - `stopE2EEBridge`: sau khi đóng bridge gọi `flush()`.
  - `handleBridgeEvent` nhánh `disconnected`: khi `data?.isE2EE && data?.loggedOut` → `clear()` rồi dọn và hẹn nối lại **đúng như nhánh heartbeat hỏng** (`_clearE2EEHeartbeat`, đóng bridge, `this.e2eeBridge = null`, `_scheduleE2EEReconnect(fbId, 'device logged out')`), ghi một dòng `Logger.warn`.
  - Ba chỗ xoá khoá cookie Facebook: gọi thêm `clearFbE2EEDeviceState(<cùng id>)` ngay cạnh.

- [ ] **Step 7: Chạy** test của task, cả thư mục `src/__tests__/facebook`, và `tsc` hai cấu hình — tất cả phải qua.

---

### Task 3: Gửi "đã đọc" thật (F7) và lưu im lặng tin cũ (F9)

**Files:**
- Modify: `src/services/facebook/FacebookE2EEBridge.ts` (`BRIDGE_METHODS`, `markRead`)
- Modify: `src/services/facebook/FacebookService.ts` (`markReadOnServer`, `handleBridgeGroupMessage`)
- Test: `src/__tests__/facebook/bridgeMarkRead.test.ts` (mới), `src/__tests__/facebook/bridgeHistoryReplay.test.ts` (mới) — dựng `FacebookService` theo cách của `bridgeSeenReceipt.test.ts` / `incomingUnread.test.ts`.

**Interfaces:**
- Consumes (Task 1): lệnh `markRead { threadId: string, watermarkTs: number }`; trường `isHistory` trên sự kiện `message`. Sẵn có: `FacebookHistoryFetcher.persistBridgeMessages(messages, range?, threadId?)`, `HISTORY_LIVE_WINDOW_MS` (5 phút), `EventBroadcaster.runOnBossDb`.
- Produces:

```ts
// FacebookE2EEBridge.ts
public async markRead(params: { threadId: string; watermarkTs: number }): Promise<void>;  // call('markRead', params, 15_000)
// FacebookService.ts — chữ ký giữ nguyên
public async markReadOnServer(threadId: string): Promise<void>;
```

- [ ] **Step 1: Viết test hỏng** `bridgeMarkRead.test.ts`:
  - Hội thoại `'100000000000000001'`, DB có tin Facebook mới nhất của hội thoại ở `1_700_000_000_000` → bridge nhận `markRead({ threadId: '100000000000000001', watermarkTs: 1_700_000_000_000 })`.
  - Mã `'100000000000000001@msgr'` → bridge nhận mã đã bỏ phần `@…`.
  - Hội thoại không có tin trong DB → `watermarkTs` là `Date.now()` (đồng hồ giả).
  - Gọi lần hai khi mốc không đổi → bridge không được gọi lại; có tin mới hơn → gọi lại với mốc mới.
  - Không gọi bridge khi: bridge không sống (`isAlive()` sai hoặc `null`), tài khoản Page (`_delegatePageId` có giá trị), mã không phải chuỗi số.
  - `markRead` của bridge ném lỗi → `markReadOnServer` không ném; lần gọi sau với cùng mốc được thử lại.

- [ ] **Step 2: Viết test hỏng** `bridgeHistoryReplay.test.ts` (đồng hồ giả tại `now`):
  - Sự kiện `message` có `isHistory: true`, `timestampMs = now - 6 phút` → `persistBridgeMessages` nhận `[data]`, `undefined`, mã hội thoại; `handleIncomingMessage` không được gọi.
  - `isHistory: true`, `timestampMs = now - 1 phút` → đi `handleIncomingMessage` (luồng tin mới).
  - Không có `isHistory`, `timestampMs = now - 1 giờ` → đi `handleIncomingMessage`.
  - `isAdminMsg: true` kèm `isHistory: true` → vẫn đi nhánh tin hệ thống như hiện nay.
  - `persistBridgeMessages` ném lỗi → không ném ra ngoài, không rơi xuống luồng tin mới.
  - Sự kiện `e2eeMessage` cũ 1 giờ → vẫn đi `handleE2EEMessage` như hiện nay.

- [ ] **Step 3: Chạy hai test** — FAIL.

- [ ] **Step 4: Cài đặt**
  - `FacebookE2EEBridge`: thêm `'markRead'` vào `BRIDGE_METHODS` và hàm `markRead`.
  - `markReadOnServer`: bỏ qua khi `this._delegatePageId`, khi bridge không sống, khi mã (sau khi bỏ `@…`) không khớp `/^\d+$/`. Mốc = `MAX(timestamp)` của `messages` với `owner_zalo_id = <facebook id>`, `thread_id = <mã>`, `channel = 'facebook'`, đọc qua `runOnBossDb`; không có thì `Date.now()`. Nhớ mốc đã gửi thành công theo hội thoại (`Map<string, number>`), mốc không lớn hơn thì không gửi. Lỗi: `Logger.warn` với mã hội thoại đã che (4 số cuối) và `err.message`.
  - `handleBridgeGroupMessage`: sau nhánh `isAdminMsg`, nếu `data.isHistory` và `0 < timestampMs <= Date.now() - HISTORY_LIVE_WINDOW_MS` → `this.historyFetcher.persistBridgeMessages([data], undefined, threadId)` trong `try/catch` rồi `return`.

- [ ] **Step 5: Chạy** hai test, cả thư mục `src/__tests__/facebook`, và `tsc` hai cấu hình — tất cả phải qua.

---

### Task 4: Tài liệu (người điều phối làm)

- `SYSTEM_DOCUMENTATION.md`: phần bridge E2EE (lưu thiết bị, nơi lưu, khi nào xoá, đăng ký lại khi bị đăng xuất), `markRead`, tin cũ lưu im lặng, giới hạn đã biết; dấu `docs-check` liên quan.
- `docs/specs/2026-11-13-chat-sync-reliability.md`: dòng Trạng thái và "Ghi chú sau triển khai" cho chặng D (các ruling dưới đây).
- `NOTICE.md`: thêm dòng port chặng D.
- `node scripts/check-docs.js` sạch.

## Ruling đã chốt khi viết plan

- **R-D1 (F8 lưu ở đâu):** spec ghi "thư mục dữ liệu của workspace, ghi nguyên tử". Plan lưu vào bảng settings của DB boss, mã hoá bằng `safeStorage`, như cookie Facebook: DB nằm trong thư mục dữ liệu, ghi SQLite là nguyên tử, và khoá không nằm dạng chữ thường trên đĩa (thư mục dữ liệu có thể là ổ đồng bộ/chia sẻ). Bản gốc cũng dùng `safeStorage`.
- **R-D2 (F7 một đường):** spec ghi bridge cho hội thoại mã hoá, MQTT/GraphQL cho hội thoại thường. Plan làm như bản gốc: mọi hội thoại đi lệnh `markRead` của bridge (`ThreadMarkReadTask`). Sai thì chỉ mất dấu "đã xem" phía người kia, không mất tin.
- **R-D3 (F9 phạm vi):** chỉ tin từ lô upsert của LightSpeed và cũ hơn 5 phút được lưu im lặng. Tin mã hoá giao sau khi nối lại (kể cả tin xếp hàng lúc app đóng) là tin mới: tăng chưa đọc, thông báo, chạy workflow — như bản gốc; đây là tin app chưa từng nhận, và không có dấu hiệu tin cậy nào khác ngoài đồng hồ máy.
- **R-D4 (thiết bị bị từ chối):** bản gốc không xử lý. Plan thêm: máy chủ đăng xuất thiết bị → xoá bản đã lưu và đăng ký thiết bị mới theo backoff sẵn có.

## Sửa sau review toàn nhánh (14/11/2026)

- **Chuỗi đăng xuất:** `connected` đặt lại backoff chung nên thiết bị bị đăng xuất liên tiếp sẽ đăng ký lại mỗi 10 giây. Thêm bộ đếm riêng: 10, 20, 40, 80, 160 giây rồi dừng hẳn ở lần thứ sáu trong 15 phút (`E2EE_LOGOUT_MAX_STREAK`, `E2EE_LOGOUT_STREAK_WINDOW_MS`).
- **Thoát app:** `cleanupBeforeQuit` gọi `flushFBE2EEDevices()` trước khi đóng DB, để không mất bản thiết bị của giây cuối.
- **Gom bản chụp ở bridge:** `saveSoon()` phát tối đa một bản mỗi 100 ms (`deviceSnapshotDelay`), để loạt tin dồn dập không làm đầy hàng đợi sự kiện 100 chỗ và rơi tin.
- **Không có keychain thì không lưu:** `app_settings` được đồng bộ sang máy nhân viên; `FacebookE2EEDeviceStore` không ghi khi `safeStorage` không dùng được.
- **Tin cũ không rõ hội thoại:** bỏ, không lưu vào hội thoại `0`.
- **Để nguyên, đã ghi nhận:** mã hội thoại trên 2^53 trong sự kiện `message` của bridge mất chính xác khi `JSON.parse` (có từ trước, cả luồng tin mới); cửa sổ rất hẹp gửi vào kênh đã đóng lúc ngắt bridge (có từ trước); `app_settings` gồm cookie đã mã hoá được đồng bộ nguyên bảng sang nhân viên (có từ trước, cần task riêng).

## Ghi chú sau phát hành: lỗi nhận tin mã hoá của 26.37.0 (sửa trong 26.37.1)

- **Triệu chứng:** gửi tin mã hoá từ MaiHub được, tin gửi tới không hiện; kho khoá thay đổi đúng kiểu "xin gửi lại" mà không có phiên mới.
- **Nguyên nhân:** khoá dùng một lần sinh ngẫu nhiên trong bridge và chỉ tới DB qua bản chụp gửi sau (gom 100 ms ở bridge, 1 giây ở app). Bridge bị đóng trong khoảng đó thì Facebook giữ các khoá mà thiết bị khôi phục không còn. Review và test của plan này không có ca "mất bản chụp sau khi tải khoá lên".
- **Sửa:** khoá dùng một lần tính từ hạt giống theo id (`derivePreKey`), id đã dùng được ghi lại; bản lưu không có hạt giống bị từ chối; bản chụp đầu tiên ghi ngay; thiết bị khôi phục giải mã hỏng bốn lần liên tiếp thì bị thay (`reason: "undecryptable"`).
- **Test:** `src/bridge-e2ee/bridge/device_crypto_test.go` chạy kho khoá qua libsignal như thư viện làm (không mạng), gồm ca dựng lại đúng lỗi này.

## Ghi chú sau phát hành: 26.37.1 không sửa được lỗi (26.37.2 thêm chẩn đoán)

- **Kết quả chạy thật 15/11/2026 (26.37.1):** tin mã hoá gửi tới vẫn không giải mã được. Thiết bị khôi phục hỏng bốn lần rồi bị thay; thiết bị mới đăng ký ngay sau đó (không khôi phục) hỏng mười lần liên tiếp với cùng người gửi. Nguyên nhân "mất khoá dùng một lần" ở ghi chú trên vì vậy sai hoặc chưa đủ: nó được suy ra từ kích thước bản lưu, không phải từ log của bridge.
- **Chưa biết:** lý do giải mã hỏng. Bản phát hành chạy bridge ở mức `error` nên dòng lỗi của whatsmeow không có trong Nhật ký. Kho khoá lưu/khôi phục chạy đúng qua libsignal ngoài mạng (kể cả ca MaiHub nhắn trước, khởi động lại, bên kia trả lời).
- **26.37.2:** gỡ việc thay thiết bị khi giải mã hỏng (không giúp gì, lại đăng ký thêm thiết bị), thêm `diagLog` đưa lý do giải mã hỏng, biên nhận xin gửi lại và số khoá dùng một lần vào Nhật ký. Bản này không sửa lỗi nhận tin.
- **Kết quả 26.37.2 (15/11/2026):** lỗi là `no valid sessions` cho cả tin mở phiên lẫn tin thường. Mỗi lần gửi lại, bên gửi lấy bộ khoá từ máy chủ (kho giảm 1 mỗi lần). Kho cũ về 0, tải 50 khoá mới của thiết bị hiện tại: vẫn hỏng. MaiHub tự mở phiên, bên kia nhận và đọc được, trả lời bằng tin thường trên phiên đó: vẫn hỏng. Luồng này chạy đúng ngoài mạng qua libsignal (kể cả bộ đệm phiên của whatsmeow). Chưa có nguyên nhân.
- **26.37.3:** hứng cảnh báo/lỗi của libsignal (`signalDiag`; trước đó chúng bị in ra stdout và bỏ đi) và ghi dấu vết lưu/đọc phiên, danh tính, khoá dùng một lần (`DeviceStore.trace`). Vẫn chưa sửa lỗi nhận tin.
- **Kết quả 26.37.3 (15/11/2026):** lỗi là sai MAC ở mọi trạng thái phiên; phiên đọc ra lúc giải mã đúng là phiên đã lưu lúc gửi (cùng mã băm); bên gửi lấy khoá dùng một lần đúng của thiết bị hiện tại theo thứ tự (101, 102, …) và không dùng khoá trong biên nhận xin gửi lại; hai mã thiết bị 95 và 96 của bên gửi có cùng khoá định danh.
- **26.37.4:** `GetSession` trả thêm trạng thái phiên của các mã thiết bị anh em chung khoá định danh (dựng lại ngoài mạng cho đúng lỗi `no valid sessions` với tin thường, có test); thêm dòng tự so khoá với máy chủ. Chưa xác nhận với Facebook thật; tin mở phiên mới vẫn chưa có lời giải.
