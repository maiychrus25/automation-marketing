# Zalo Phone History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anh bấm một nút, xác nhận trên điện thoại, và tin nhắn Zalo cũ trong khoảng thời gian đã chọn được ghép vào đúng hội thoại trong MaiHub, không sinh tin trùng.

**Architecture:** Module `src/services/zalo/mobileSync/` gồm các mảnh thuần (định dạng sao lưu, bảng `BinNet`, đổi dòng → tin, lệnh Zalo qua `api.custom`, tải file) và một dịch vụ điều phối phiên (`MobileSyncService`). Nhập tin đi qua `DatabaseService` bằng cùng hàm dựng dòng với đường nhận tin trực tiếp. Giao diện là một nút + hộp thoại trên thanh công cụ, nói chuyện qua ba lệnh IPC và một sự kiện.

**Tech Stack:** TypeScript/Electron, React 18, better-sqlite3, Jest (ts-jest, node env), `zca-js` 2.1.2 (không nâng), thêm `xz-decompress` 0.2.3.

**Spec:** `docs/specs/2026-11-13-zalo-phone-history-sync.md`.

**Trạng thái:** Đã triển khai xong 9/9 task và gộp vào `main` trên máy (13/11/2026), chưa phát hành, chưa thử với điện thoại thật.

**Phương thức thực thi:** subagent-driven, subagent dùng Sonnet. Không commit/push khi anh chưa cho phép.

## Global Constraints

- Tham chiếu: clone chỉ đọc `$SCRATCH/upstream/deplao-builder` tại `2162f07`, thư mục `src/services/zalo/mobileSync/`. **Chỉ đọc, không chạy, không import.** Phần giao thức (`zdbBackup`, `binNet`, `mobileMessageConverter`, `zcaMobileSync`) được port sát; mỗi file ghi một dòng nguồn ở đầu: `Port sát từ babyvibe/deplao-builder (MIT) src/services/zalo/mobileSync/<tên file> @2162f07`.
- Dependency: chỉ thêm `xz-decompress` ghim đúng `0.2.3` (`npm install --save-exact --ignore-scripts xz-decompress@0.2.3`). Không nâng `zca-js`. Không dependency nào khác.
- Hằng số: `pc_name` `'Web'`; chờ xác nhận `180_000` ms; chờ điện thoại chuẩn bị `1_800_000` ms; lô đổi ID `500`, thử `3` lần cách `1000`/`2000`/`3000` ms; lô nhập `1000` dòng; bổ sung hồ sơ theo lô `50`, tối đa `1000` người và `1000` nhóm; tiến độ tối đa một lần mỗi `300` ms; tải file ngắt sau `60_000` ms không có dữ liệu, tối đa `5` lần chuyển hướng; ZDB tối đa `200000` mục, tên mục tối đa `1024` byte và phải khớp `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}$`, không chứa `..`; khối mã hoá `65536` byte; `db_format` phải bằng `1`.
- Host Zalo (được nhận cookie): `zalo.me`, `zaloapp.com`, `zdn.vn`, `zadn.vn` và subdomain; so theo hostname đã phân tích, không khớp tên giả dạng.
- Schema chỉ cộng thêm: bảng `zalo_plain_id_map(owner_zalo_id TEXT, kind TEXT, plain_id TEXT, noise_id TEXT, updated_at INTEGER, PRIMARY KEY(owner_zalo_id, kind, plain_id))`; `kind` là `'user'` hoặc `'group'`.
- Tin nhập là lịch sử: không tăng chưa đọc, không thông báo, không workflow/webhook, không tải media. Mọi ghi DB chạy trên DB chính (`EventBroadcaster.runOnBossDb` / `withDbPath`).
- Không log nội dung tin, cookie, khoá, link tải. Khoá riêng không ghi ra đĩa.
- Test không gọi mạng; fixture tự dựng, không dùng dữ liệu thật. Mỗi test dùng DB thật tạm phải mock `Logger` như các test lân cận (nhiễu console giữ 12 error / 2 warn).
- Identifier tiếng Anh, copy tiếng Việt; UI theo `DESIGN.md`. Cập nhật `SYSTEM_DOCUMENTATION.md` trong task sở hữu hành vi; `node scripts/check-docs.js` sạch. Không tăng version, không đụng `sites/`, spec website, mã Go.
- TDD cho mọi task. Mỗi task kết thúc bằng "Inspect diff" thay cho commit.

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
Baseline `main` `07dfcb3`: Jest 4211/4211, Python 408 OK, nhiễu 12 error / 2 warn.

## Review Focus

1. Tin thật đến qua đường trực tiếp **sau** khi lịch sử đã nhập cùng tin đó dưới id tạm `mb_…` → vẫn đúng một dòng (dòng cũ được nâng lên id thật); và mọi tin trực tiếp bình thường lưu y như trước khi sửa. → Task 3.
2. Bản sao lưu xấu: tên mục có `..`, dấu `/`, đường dẫn tuyệt đối; file cắt cụt; 0 mục; số mục vượt trần → không ghi gì ra ngoài thư mục làm việc, lỗi rõ ràng, không treo. → Task 1.
3. Huỷ, hết hạn hoặc lỗi ở **mỗi** bước đều xoá khoá riêng và thư mục làm việc; phần còn sót do app bị tắt giữa chừng được dọn lúc mở app. → Task 6.
4. Cookie không bao giờ đi tới host không phải Zalo, kể cả sau chuyển hướng; link `http` bị từ chối. → Task 5.
5. Đang mở workspace khác → tin vẫn vào DB chính; bấm bắt đầu lần hai khi đang chạy bị từ chối; Zalo tự nối lại hoặc đăng nhập lại giữa lúc chờ (đối tượng `api`/`ws` mới) thì sự kiện từ điện thoại vẫn tới được phiên. → Task 6.

## File structure

| Tệp | Trách nhiệm |
|---|---|
| `src/services/zalo/mobileSync/types.ts` | Kiểu trạng thái/thống kê của phiên (Task 6 tạo). Kiểu riêng của từng mảnh nằm ngay trong module của mảnh đó |
| `…/zdbBackup.ts` | Cặp khoá RSA, giải khoá, đọc ZDB4.0, giải nén XZ, mã kiểm tra |
| `…/binNet.ts` | Phân tích blob TLV `BinNet` |
| `…/mobileMessageConverter.ts` | Tên file → hội thoại, truy vấn `ChatContent`, dòng → tin dạng `zca-js` |
| `…/zcaMobileSync.ts` | Ba lệnh Zalo qua `api.custom`, đọc sự kiện `syncmsgmb` từ websocket |
| `…/backupDownload.ts` | Tải file sao lưu an toàn |
| `…/MobileSyncService.ts` | Phiên đồng bộ: máy trạng thái, hẹn giờ, nhập, dọn dẹp |
| `electron/ipc/mobileSyncIpc.ts` | Ba lệnh IPC + chặn chế độ nhân viên |
| `src/ui/lib/chat/mobileSyncView.ts` | Hàm thuần của giao diện (khoảng thời gian, bước, tóm tắt) |
| `src/ui/components/layout/MobileSyncButton.tsx` | Nút + hộp thoại |
| `src/__tests__/zalo/helpers/zdbFixture.ts` | Dựng file XZ/ZDB giả cho test (Task 1) |
| `src/__tests__/zalo/helpers/chatContentFixture.ts` | Dựng blob `BinNet` và file SQLite `ChatContent` giả (Task 2) |
| `DatabaseService.ts`, `ZaloLoginHelper.ts`, `electron/main.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `TopBar.tsx` | Chỉ thêm đúng chỗ nêu trong task |

Task 1–5 độc lập nhau (file riêng), có thể làm song song; Task 6 cần 1–5; Task 7 cần 6; Task 8 cần 7.

---

### Task 1: Định dạng sao lưu (`zdbBackup`) và dependency giải nén

**Files:** Create `src/services/zalo/mobileSync/zdbBackup.ts` (kiểu của task này khai báo ngay trong file), `src/__tests__/zalo/helpers/zdbFixture.ts`; Modify `package.json`, `package-lock.json` (chỉ `xz-decompress`); Test `src/__tests__/zalo/zdbBackup.test.ts`. Nguồn: upstream `zdbBackup.ts` (439 dòng).

**Interfaces — Produces:**
```ts
export function generateSyncKeyPair(): { publicKey: string; privateKey: string }; // SPKI DER base64; PKCS#1 PEM
export function decryptBackupKey(encryptedKeyBase64: string, privateKeyPem: string): Buffer; // khoá AES 32 byte
export interface ExtractedFile { name: string; path: string; size: number }
export function extractZdbBackup(cryptPath: string, aesKey: Buffer, outDir: string, opts?: {
  isCancelled?: () => boolean; onProgress?: (processedBytes: number, totalBytes: number) => void;
}): Promise<{ files: ExtractedFile[]; skippedEntries: string[] }>;
export function verifyChecksum(filePath: string, expected: string | null | undefined): Promise<'ok' | 'mismatch' | 'skipped'>;
// helper test:
export function buildXzStored(data: Buffer): Buffer;   // file .xz hợp lệ, khối LZMA2 không nén
export function buildZdbBackup(files: Array<{ name: string; data: Buffer }>, aesKey: Buffer, opts?: { leadingBytes?: 0 | 4; trailingGarbage?: Buffer }): Buffer;
```

- [ ] **Step 0:** `npm install --save-exact --ignore-scripts xz-decompress@0.2.3`; kiểm `git diff package.json` chỉ thêm một dòng và lockfile chỉ thêm gói đó. Xác nhận `require('xz-decompress')` chạy được trong Jest (một test nhỏ giải `buildXzStored(Buffer.from('abc'))` ra `abc`).
- [ ] **Step 1: Helper + test.** `buildXzStored` viết container XZ chuẩn (magic, stream flags CRC32, một block LZMA2 với các chunk `0x01`/`0x02` không nén ≤ 65536 byte, index, footer; dùng `zlib.crc32`); nếu sau 1 giờ vẫn không qua được `xz-decompress` thì thay bằng fixture base64 sinh một lần bằng lệnh `xz` và ghi rõ trong báo cáo. `buildZdbBackup` dựng đúng bố cục spec §4.6 (magic `ZDB4.0`, số mục u32 BE ở offset 14, bảng `[nameLen][name][size]`, luồng XZ, mã hoá AES-256-CBC từng khối 64 KB với IV 0).
  Test: `roundTripsTwoFiles` (hai file, nội dung khớp từng byte, `files` đúng tên/kích thước); `acceptsCiphertextAtOffset4`; `rejectsWrongMagic`; `rejectsUnsupportedLayout` (số mục `200001` → lỗi, không ghi file); `skipsUnsafeNames` — các tên `../x.db`, `a/b.db`, `/abs.db`, `..`, tên dài 300 ký tự → nằm trong `skippedEntries`, **không có file nào ngoài `outDir`** (kiểm bằng liệt kê thư mục cha), các mục hợp lệ còn lại vẫn đúng; `truncatedFileFailsCleanly` (cắt nửa file → reject, không treo, không để file dở dang được tính là thành công); `emptyArchive` (0 mục → `files: []`); `cancelStopsEarly` (`isCancelled` trả true sau khối đầu → reject với lỗi huỷ); `toleratesTrailingGarbageAfterXz`; `keyPairAndBackupKeyRoundTrip` (mã hoá một khoá hex bằng `crypto.publicEncrypt` PKCS#1 v1.5 → `decryptBackupKey` trả đúng 32 byte theo quy tắc: hex viết hoa, lấy 32 ký tự đầu làm byte ASCII); `backupKeyFallbackMatchesNative` (gọi thẳng đường dự phòng BigInt, cùng kết quả); `checksum` (32 hex → MD5, 64 hex → SHA-256, khác → `skipped`, sai → `mismatch`).
- [ ] **Step 2:** chạy, đỏ. **Step 3:** viết `zdbBackup.ts` (giải mã và giải nén theo luồng, không nạp cả file vào bộ nhớ; ghi mỗi mục bằng `path.join(outDir, name)` sau khi tên đã qua kiểm tra).
- [ ] **Step 4:** test xanh; chạy đủ lệnh kiểm chứng ở common. **Step 5:** Inspect diff.

### Task 2: `BinNet` và đổi dòng sao lưu thành tin

**Files:** Create `src/services/zalo/mobileSync/binNet.ts`, `src/services/zalo/mobileSync/mobileMessageConverter.ts` (kiểu `SyncRange`, `MobileRow`, `PlainMessage`, `BinNetData` khai báo và export ngay trong hai file này), `src/__tests__/zalo/helpers/chatContentFixture.ts` (hàm dựng blob TLV và file SQLite `ChatContent` giả); Test `src/__tests__/zalo/mobileMessageConverter.test.ts`. Nguồn: upstream `binNet.ts` (268), `mobileMessageConverter.ts` (317), `types.ts`.

**Interfaces — Produces:**
```ts
export function parseBinNet(blob: Buffer | Uint8Array | null | undefined): BinNetData | null; // null = blob hỏng
export function parseBackupFileName(name: string): { kind: 'user' | 'group'; plainId: string } | null;
export interface SyncRange { fromTs: number | null; toTs: number | null }
export function iterateChatContent(db: import('better-sqlite3').Database, range: SyncRange): IterableIterator<MobileRow>;
export function countOutOfRange(db: import('better-sqlite3').Database, range: SyncRange): number;
export function rowToPlainMessage(row: MobileRow): PlainMessage | null;
export function collectPlainUserIds(messages: PlainMessage[]): string[];
export function toZaloMessage(plain: PlainMessage, ctx: {
  threadNoiseId: string; isGroup: boolean; ownNoiseId: string; resolveUser: (plainId: string) => string;
}): any | null; // cùng hình dạng tin mà DatabaseService.saveMessage nhận
```

- [ ] **Step 1: Test.** `parseBackupFileName`: `123456789.db` → user, `group_987654321.db` → group; `0123.db`, `abc.db`, `group_.db`, `x.txt` → `null`. Bảng kiểu tin đúng spec/bản gốc (0→`webchat`, 3/4/31→`chat.photo`, 6→`chat.voice`, 10→`chat.sticker`, 12→`chat.recommended`, 18→`chat.location.new`, 19→`chat.video.msg`, 22→`share.file`, 23→`chat.gif`, 36→`chat.undo`…); kiểu không có trong bảng → `null`. `iterateChatContent` trên file SQLite giả: bỏ `MsgStatus <= 0`, bỏ `CliMsgId` null, bỏ các kiểu bị loại (20, 21, 25, 26, 29, 32, 34, 35, 45, 51, 52), lọc `TimeStamp` hai đầu **bao gồm** biên; `countOutOfRange` đếm đúng phần còn lại; thiếu bảng `ChatContent` → không ném, không có dòng. `toZaloMessage`: tin chữ (`BinNet` rỗng); ảnh (nội dung là JSON của attach có `href`/`thumb`); có trích dẫn; có @mention (uid -1 giữ `'-1'`); danh thiếp có `params` đổi sang ID web; tin thu hồi (`isRecalled`, nội dung rỗng); `chat.delete` → `null`; `GlbMsgId` 0 → `msgId` `mb_<CliMsgId>`; `isSelf` khi người gửi là mình; `idTo`/`threadId`/`type` đúng cho chat riêng và nhóm; người gửi không đổi được ID → `null`; `BinNet` hỏng → `null`; số lớn hơn 2^53 (`GlbMsgId`, `CliMsgId` đọc bằng `safeIntegers`) giữ nguyên chữ số.
- [ ] **Step 2:** đỏ. **Step 3:** viết hai module (giá trị lọc trong SQL ép về số nguyên, không nối chuỗi từ dữ liệu ngoài). **Step 4:** test xanh + lệnh kiểm chứng. **Step 5:** Inspect diff.

### Task 3: DB — dựng dòng chung, id tạm, nhập hàng loạt, bảng đổi ID

**Files:** Modify `src/services/database/DatabaseService.ts` (`saveMessage` ~3296, `isDuplicateZaloDelivery` ~3276, khối schema + migration); Test `src/__tests__/database/zaloHistoryImport.test.ts`. Nguồn: upstream `DatabaseService.ts:4177–4428`, `3083–3093`.

**Interfaces — Produces:**
```ts
public static isSyntheticZaloMsgId(msgId: unknown): boolean;                    // /^(mb|cli)_/
public saveHistoryMessagesBulk(ownerZaloId: string, messages: any[]): { inserted: number; upgraded: number; skipped: number; threads: string[] };
public getPlainIdMap(ownerZaloId: string, kind: 'user' | 'group'): Map<string, string>;
public savePlainIdMap(ownerZaloId: string, kind: 'user' | 'group', entries: Array<[plainId: string, noiseId: string]>): void;
public getContactIdsWithoutProfile(ownerZaloId: string, limitPerKind: number): { users: string[]; groups: string[] };
```

- [ ] **Step 1: Test hồi quy trước (phải xanh ngay, ghi lại hành vi hiện tại):** `realtimeSaveUnchanged` — một loạt tin trực tiếp đa dạng (chữ, ảnh, có trích dẫn, nhóm, tin mình) lưu qua `saveMessage`; chụp toàn bộ dòng `messages` và `contacts` (snapshot nội tuyến). Sau khi refactor ở Step 3, snapshot phải giữ nguyên.
- [ ] **Step 2: Test mới (đỏ):** `bulkInsertsAndCounts` (3 tin mới → `inserted: 3`, `threads` có hội thoại); `bulkIsIdempotent` (chạy lại → `inserted: 0`, `skipped: 3`, DB không đổi); `bulkSkipsSameCliUnderOtherRealId` (đã có tin trực tiếp id thật A, lịch sử mang id thật B cùng hội thoại/người gửi/cliMsgId → bỏ qua); `bulkUpgradesSyntheticRow` (đã có `mb_X`, lịch sử mang id thật → `upgraded: 1`, vẫn một dòng, `msg_id` là id thật, `timestamp` theo dòng mới, `local_paths`/`status` cũ giữ nguyên); `realtimeAfterHistoryUpgrades` (**Review Focus 1**: lịch sử nhập `mb_X`; `saveMessage` nhận tin thật cùng hội thoại/người gửi/cliMsgId → một dòng, id thật); `bulkNeverIncrementsUnread` (chưa đọc giữ nguyên với tin của người khác); `previewOnlyMovesForward` (tin lịch sử cũ hơn không đè xem trước mới hơn; mới hơn thì cập nhật); `recalledImported` (`is_recalled = 1`); `createsContactForUnknownThread` (hội thoại chưa có → có dòng `contacts`, `unread_count` 0); `otherChannelNotTouched` (dòng Facebook cùng owner/thread/cli không bị coi là trùng, không bị nâng cấp); `plainIdMapRoundTrip` (lưu/đọc theo owner + kind, ghi đè cập nhật, hai owner tách nhau; bảng có sau migration trên DB cũ **và** khi gọi trong `withDbPath` tới DB phụ chưa migrate); `contactsWithoutProfile` (tên rỗng hoặc bằng `contact_id`, tách người/nhóm, tôn trọng `limitPerKind`, chỉ kênh Zalo).
- [ ] **Step 3: Implement.** Tách phần dựng dòng của `saveMessage` thành hàm private dùng chung cho `saveMessage` và `saveHistoryMessagesBulk` (không đổi cột, không đổi thứ tự tham số). `isDuplicateZaloDelivery` dùng `isSyntheticZaloMsgId`. `saveMessage` gọi nâng cấp id tạm trước khi chèn. `saveHistoryMessagesBulk` chạy trong một transaction; tra theo `(owner_zalo_id, cli_msg_id)` kèm `cli_msg_id IS NOT NULL` rồi lọc hội thoại/người gửi/kênh trong code; cuối cùng cập nhật xem trước một lần cho mỗi hội thoại bằng tin chưa thu hồi mới nhất, **không** tăng chưa đọc.
- [ ] **Step 4:** tất cả xanh, snapshot Step 1 không đổi; chạy lại `zaloDuplicateDelivery`, `chatSync.integration`, `bossDbWorkspace`. Docs (bảng mới, nhập lịch sử). **Step 5:** Inspect diff.

### Task 4: Lệnh Zalo và sự kiện từ điện thoại (`zcaMobileSync`)

**Files:** Create `src/services/zalo/mobileSync/zcaMobileSync.ts` (kiểu `SyncEvent`, `MobileSyncApi` khai báo ngay trong file); Test `src/__tests__/zalo/zcaMobileSync.test.ts`. Nguồn: upstream `zcaMobileSync.ts` (234). Dùng lại `decodeWsEventData` từ `src/services/zalo/zaloReadElsewhere.ts` (không viết bản thứ hai).

**Interfaces — Produces:**
```ts
export const DEFAULT_SYNC_PC_NAME = 'Web';
export interface MobileSyncApi {
  pullMobile(p: { public_key: string; pc_name: string; from_seq_id: number; min_seq_id: number }): Promise<unknown>;
  cancelPullMobile(p: { public_key: string; pc_name: string }): Promise<unknown>;
  getNoisedIds(p: { uids: string[]; gids: string[] }): Promise<{ uids: string[]; gids: string[] }>;
}
export function installMobileSyncApis(api: any): MobileSyncApi;         // gọi lại nhiều lần trên cùng api không lỗi
export function extractSyncEvents(frame: Buffer, cipherKey: string | null | undefined): SyncEvent[];
export function attachSyncEventListener(api: any, onEvent: (event: SyncEvent) => void): () => void;
```
`SyncEvent` = `{ type: 'user_confirm' | 'transfer_error' | 'syncmsg_info' | string; data: any }` với các trường spec §4.3.

- [ ] **Step 1: Test** (api giả có `custom(name, cb)` gắn hàm vào api, `zpwServiceMap`, `listener` là `EventEmitter` có `ws`/`cipherKey`; `utils.request` giả ghi lại URL và tham số; `utils.encodeAES` giả để đọc được payload): `pullMobile` gọi `<file[0]>/api/message/pull_mobile_msg` với `{ pc_name: 'Web', public_key, from_seq_id, is_retry: 0, min_seq_id, temp_key: '', imei }`; `cancelPullMobile` gọi `…/cancel_pull_mobile_msg`; `getNoisedIds` gửi `fids`/`gids` dạng số tới `<profile[0]>/api/znoise`, trả mảng cùng vị trí với `'0'`/thiếu → `''`, bỏ chữ `g` đầu ở nhóm, chuỗi JSON được parse; lỗi ở host chính → thử `https://zwid.api.zalo.me/api/znoise` bằng POST; cả hai lỗi → reject. `installMobileSyncApis` gọi hai lần không ném; `api.custom` thiếu → lỗi rõ ràng. `extractSyncEvents`: frame cmd 601 có `controls[].content.act_type === 'syncmsgmb'` → sự kiện (dữ liệu là chuỗi JSON cũng được parse); `act_type` khác, cmd khác, frame ngắn/hỏng → `[]`, không ném. `attachSyncEventListener`: nhận sự kiện qua `ws.on('message')`; sau `connected` với `ws` mới thì gắn vào socket mới và gỡ socket cũ; hàm trả về gỡ sạch; frame hỏng không làm rơi listener và log không chứa nội dung frame.
- [ ] **Step 2:** đỏ. **Step 3:** viết module. **Step 4:** xanh + lệnh kiểm chứng. **Step 5:** Inspect diff.

### Task 5: Tải file sao lưu (`backupDownload`)

**Files:** Create `src/services/zalo/mobileSync/backupDownload.ts`; Test `src/__tests__/zalo/backupDownload.test.ts`. Nguồn: upstream `backupDownload.ts` (177).

**Interfaces — Produces:**
```ts
export function isZaloHost(hostname: string): boolean;
export function downloadBackupFile(url: string, destPath: string, opts: {
  cookieFor: (url: string) => string; userAgent: string; agent?: unknown;
  isCancelled?: () => boolean; onProgress?: (received: number, total: number) => void;
  request?: typeof import('https').request;     // tiêm cho test
}): Promise<{ bytes: number }>;
```

- [ ] **Step 1: Test** (lớp `request` giả trả phản hồi theo kịch bản; không mở cổng mạng): `isZaloHost` đúng với `zalo.me`, `a.b.zdn.vn`, `ZADN.VN`; sai với `evilzalo.me`, `zalo.me.evil.com`, `''`. `rejectsHttp` (không gọi `request`). `sendsCookieOnlyToZaloHosts` (**Review Focus 4**): URL Zalo → có header `Cookie`; URL host khác → không có. `stripsCookieOnRedirectToOtherHost`: 302 từ Zalo sang host khác → lần gọi thứ hai không có `Cookie`; chuyển hướng sang `http` → reject. `followsAtMostFiveRedirects` (lần thứ 6 → reject). `retriesOnceWithoutCookieOn4xx` (403 có cookie → gọi lại không cookie → 200 thành công; 403 lần hai → reject). `writesFileAndReportsProgress` (nội dung file khớp, `bytes` đúng). `idleTimeoutAborts` (đồng hồ giả, 60 000 ms không có dữ liệu → reject, file dở bị xoá). `cancelAborts` (`isCancelled` → reject, file dở bị xoá). `errorMessagesHideUrl` (thông báo lỗi không chứa query của URL).
- [ ] **Step 2:** đỏ. **Step 3:** viết module (ghi theo luồng ra đĩa). **Step 4:** xanh + lệnh kiểm chứng. **Step 5:** Inspect diff.

### Task 6: Dịch vụ phiên đồng bộ (`MobileSyncService`)

**Files:** Create `src/services/zalo/mobileSync/MobileSyncService.ts`, `src/services/zalo/mobileSync/types.ts` (trạng thái, bước, thống kê; `SyncRange` lấy lại từ `mobileMessageConverter`); Modify `src/utils/ZaloLoginHelper.ts` (một dòng gắn, ngay trước `listener.start({ retryOnClose: true })`, cạnh `attachZaloReadElsewhere`); Test `src/__tests__/zalo/mobileSyncService.test.ts`. Nguồn: upstream `MobileSyncService.ts` (597).

**Interfaces — Consumes:** Task 1–5. **Produces:**
```ts
export const MOBILE_SYNC_EVENT = 'event:mobileSync';
export type MobileSyncStage = 'requesting' | 'waiting_confirm' | 'waiting_backup' | 'mobile_idle' | 'downloading' | 'decrypting' | 'resolving_ids' | 'importing' | 'completed' | 'failed' | 'cancelled';
export interface MobileSyncStats { conversations: number; conversationsResolved: number; conversationsUnresolved: number; messagesRead: number; messagesImported: number; messagesSkipped: number; messagesOutOfRange: number; durationMs: number }
export interface MobileSyncStatus { zaloId: string; stage: MobileSyncStage; progress: number; message: string; range?: SyncRange; error?: string; stats?: MobileSyncStats; startedAt?: number; updatedAt: number }
export default class MobileSyncService {
  static getInstance(): MobileSyncService;
  attachToApi(zaloId: string, api: any): void;
  start(zaloId: string, range: SyncRange): Promise<{ success: boolean; status?: MobileSyncStatus; error?: string }>;
  cancel(zaloId: string): Promise<{ success: boolean; status?: MobileSyncStatus }>;
  getStatus(zaloId: string): MobileSyncStatus | null;
  sweepLeftovers(): void;   // xoá userData/mobile-sync còn sót
}
```
Dịch vụ nhận phụ thuộc qua một đối tượng tiêm được trong test (lấy `api` đang kết nối của tài khoản, thư mục gốc làm việc, hàm tải file, hàm chạy trên DB chính, hàm phát sự kiện); mặc định dùng `ConnectionManager`, `app.getPath('userData')`, `downloadBackupFile`, `EventBroadcaster.runOnBossDb`, `EventBroadcaster.emit`.

- [ ] **Step 1: Test** (api giả + phát sự kiện giả + đồng hồ giả + bản sao lưu dựng bằng `buildZdbBackup` chứa file SQLite giả; DB tạm thật): 
  - `happyPath`: start → `requesting` → `waiting_confirm` → (`user_confirm` 1) `waiting_backup` → (`syncmsg_info`) `downloading` → `decrypting` → `resolving_ids` → `importing` → `completed` với thông điệp "Đã đồng bộ N tin nhắn mới từ M hội thoại…" và `stats` đúng; tin nằm đúng hội thoại (ID đã đổi), chưa đọc không tăng.
  - Thông điệp đúng nguyên văn spec cho: từ chối (`user_action` 0 → `cancelled`), đang khôi phục (2 → `failed`), `transfer_error` status 2 → `mobile_idle`, `error_code` khác 0 → `failed` kèm mã, `db_format` khác 1, `msg_total` 0 → `completed` không tải gì, khoảng sai (`fromTs > toTs`), tài khoản không online, đang có phiên chạy.
  - Hạn chờ: 180 000 ms không xác nhận → gọi `cancelPullMobile`, `failed` "Hết thời gian chờ xác nhận trên điện thoại"; 1 800 000 ms ở `waiting_backup` → `failed` "Hết thời gian chờ điện thoại gửi dữ liệu"; `transfer_error` status 1 đặt lại hạn.
  - Sự kiện có `public_key` khác bị bỏ; sự kiện đến sau khi phiên kết thúc bị bỏ.
  - `cancel` ở từng bước (`waiting_confirm`, `waiting_backup`, đang tải, đang giải mã, đang nhập) → `cancelled`; chỉ hai bước chờ mới gọi `cancelPullMobile`.
  - **Review Focus 3:** sau **mỗi** kết cục (xong, lỗi tải, lỗi giải mã, lỗi đổi ID, huỷ, hết hạn): thư mục làm việc không còn, khoá riêng của phiên đã bị xoá khỏi bộ nhớ, trạng thái cuối chỉ phát **sau** khi dọn xong. `sweepLeftovers` xoá thư mục còn sót và không ném khi thư mục không tồn tại.
  - Đổi ID: 1 200 ID → 3 lần gọi (500/500/200); một lô lỗi 2 lần rồi được → thành công; lỗi 3 lần → `failed` "Không đổi được ID hội thoại từ điện thoại: …"; ID đã có trong `zalo_plain_id_map` không hỏi lại; hội thoại không đổi được → `conversationsUnresolved`.
  - Khoảng thời gian: tin ngoài khoảng không nhập và được đếm `messagesOutOfRange`.
  - **Review Focus 5:** workspace khác đang mở → tin ở DB chính, DB đang mở không có; `start` lần hai khi đang chạy bị từ chối và phiên đầu không bị ảnh hưởng; `attachToApi` với `api` mới giữa lúc `waiting_confirm` → sự kiện phát trên `api` mới vẫn tới phiên; hai tài khoản chạy song song không lẫn sự kiện.
  - Tiến độ: nhiều cập nhật trong 300 ms chỉ phát một, đổi bước luôn phát.
  - Bổ sung hồ sơ: gọi `getUserInfo`/`getGroupInfo` theo lô 50 cho hội thoại thiếu tên; lỗi ở bước này không làm hỏng kết quả.
  - Mã kiểm tra sai chỉ cảnh báo, vẫn nhập.
- [ ] **Step 2:** đỏ. **Step 3:** viết dịch vụ; gắn vào `ZaloLoginHelper`. **Step 4:** xanh + toàn bộ test Zalo + lệnh kiểm chứng. Docs. **Step 5:** Inspect diff.

### Task 7: IPC, preload và khởi động

**Files:** Create `electron/ipc/mobileSyncIpc.ts`; Modify `electron/main.ts` (đăng ký cạnh `registerZaloIpc()`; gọi `sweepLeftovers()` một lần lúc khởi động), `electron/preload.ts` (`mobileSync: { start, cancel, getStatus }` + cho phép kênh `event:mobileSync`), `src/ui/lib/ipc.ts` (kiểu); Test `src/__tests__/zalo/mobileSyncIpc.test.ts`. Nguồn: upstream `electron/ipc/zalo/mobileSyncIpc.ts` (46).

**Interfaces — Produces:** kênh `zalo:mobileSync:start { zaloId, fromTs, toTs }`, `zalo:mobileSync:cancel { zaloId }`, `zalo:mobileSync:status { zaloId }`; renderer `ipc.mobileSync.start(zaloId, range)`, `.cancel(zaloId)`, `.getStatus(zaloId)`.

- [ ] **Step 1: Test** (theo cách các test IPC hiện có đăng ký handler với `ipcMain` giả): ba kênh chuyển đúng tham số tới dịch vụ; chế độ nhân viên → `{ success: false, error: 'Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại' }` và dịch vụ không được gọi; tham số thiếu/sai kiểu (`zaloId` rỗng, `fromTs` không phải số hay null) → lỗi, không ném; dịch vụ ném → `{ success: false, error }`.
- [ ] **Step 2:** đỏ. **Step 3:** viết; tìm cách các handler hiện có nhận biết chế độ nhân viên và dùng đúng cách đó. Không thêm `event:mobileSync` vào danh sách relay cho máy nhân viên. **Step 4:** xanh + tsc ×2. **Step 5:** Inspect diff.

### Task 8: Giao diện

**Files:** Create `src/ui/lib/chat/mobileSyncView.ts`, `src/ui/components/layout/MobileSyncButton.tsx`; Modify `src/ui/components/layout/TopBar.tsx` (đặt nút ngay sau nút "Tải tin nhắn cũ", cùng điều kiện ẩn với nhân viên, chỉ khi tài khoản đang chọn là Zalo); Test `src/__tests__/ui/mobileSyncView.test.ts`. Đọc `DESIGN.md` trước. Nguồn: upstream `MobileSyncButton.tsx` (366), `SyncRangePicker.tsx` (114).

**Interfaces — Consumes:** Task 7. **Produces:**
```ts
export type SyncPreset = 'week' | 'custom' | 'all';
export function resolveSyncRange(preset: SyncPreset, fromDate: string, toDate: string, now: number): { fromTs: number | null; toTs: number | null } | { error: string };
export function mobileSyncStep(stage: string | null | undefined): number;   // 0–4, -1 khi chưa chạy/đã xong
export function isMobileSyncRunning(stage: string | null | undefined): boolean;
export function mobileSyncNotes(stats: Partial<Record<string, number>> | null | undefined): string[];
```

- [ ] **Step 1: Test:** `week` → `fromTs` là 0 giờ địa phương của 7 ngày trước `now`, `toTs` null (kiểm ở ba múi giờ bằng cách tính từ `new Date(now)` trong test, không ghi cứng số); `all` → cả hai null; `custom` → đầu ngày `from` tới `23:59:59.999` của `to`; thiếu ngày → "Chọn đủ ngày bắt đầu và ngày kết thúc"; from sau to → "Ngày bắt đầu phải trước ngày kết thúc". `mobileSyncStep`: `requesting`/`waiting_confirm` → 0, `waiting_backup`/`mobile_idle` → 1, `downloading` → 2, `decrypting` → 3, `resolving_ids`/`importing` → 4, còn lại → -1. `isMobileSyncRunning` sai với `completed`/`failed`/`cancelled`/null. `mobileSyncNotes`: sinh đúng ba câu của spec §6 khi số > 0, không sinh khi 0.
- [ ] **Step 2:** đỏ. **Step 3:** viết helper, rồi component: trạng thái cục bộ; lúc mở lấy `getStatus`; nghe `event:mobileSync` (lọc theo `zaloId`); năm bước và nguyên văn copy của spec §6; thanh tiến độ ở bước 2–4; "Ẩn" đóng hộp thoại mà không huỷ; khi hộp thoại đóng thì kết thúc/lỗi hiện qua `showNotification` sẵn có; xong thì tải lại danh sách hội thoại và hội thoại đang mở bằng các hàm TopBar đang dùng cho "Tải tin nhắn cũ". Dùng lại lớp CSS của thanh công cụ và của các hộp thoại sẵn có; không thêm màu.
- [ ] **Step 4:** test xanh + tsc ×2. Không mở app thật (sẽ kết nối tài khoản thật); ghi rõ trong báo cáo phần giao diện chưa được nhìn bằng mắt và lý do tin rằng không tràn ngang (lớp CSS dùng lại). **Step 5:** Inspect diff.

### Task 9: Tích hợp, ghi nhận, kiểm chứng

**Files:** Create `src/__tests__/zalo/mobileSync.integration.test.ts`; Modify `NOTICE.md`, `SYSTEM_DOCUMENTATION.md`, spec (Trạng thái + "Ghi chú sau triển khai").

- [ ] **Step 1: Test tích hợp** (không mạng): một tài khoản có sẵn tin trực tiếp (một tin id thật trùng với lịch sử; một tin mình gửi đã lưu id thật mà lịch sử mang `mb_…`); bản sao lưu giả gồm một chat riêng + một nhóm + một hội thoại không đổi được ID; chạy cả phiên qua `MobileSyncService` thật với `api` giả → số dòng đúng, không trùng, hội thoại mới có dòng `contacts`, chưa đọc không đổi, thống kê khớp; chạy lại lần hai → 0 tin mới; sau đó một tin trực tiếp thật đến cho dòng `mb_…` → vẫn một dòng.
- [ ] **Step 2:** sửa chỗ nối nếu thiếu. **Step 3: Docs.** `NOTICE.md`: bảng port (file nguồn → file đích, điểm khác: D2–D7) và dòng dependency `xz-decompress` 0.2.3 (MIT). `SYSTEM_DOCUMENTATION.md`: mục tính năng (luồng, IPC, bảng mới, giới hạn). Spec: trạng thái + ghi chú.
- [ ] **Step 4:** đủ bộ lệnh kiểm chứng **hai vòng**; số test không giảm so với 4211, nhiễu không vượt 12/2, không có "did not exit". **Step 5:** Inspect diff toàn nhánh so `07dfcb3`: `package.json`/lockfile chỉ thêm `xz-decompress`; không file tạm trong repo; không `console.log` mới trong code chạy thật.

## Kiểm tay sau khi cài (anh làm, cần điện thoại thật)

"1 tuần gần nhất" trên một tài khoản; từ chối trên điện thoại; để điện thoại tắt màn hình giữa lúc chuẩn bị; chạy lại xem không trùng; kiểm một tin đã gửi từ MaiHub không bị nhân đôi; "Toàn bộ" trên tài khoản nhiều tin; thử khi đang mở workspace nhân viên (nút phải ẩn).
