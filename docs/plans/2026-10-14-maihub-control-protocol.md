# MaiHub Control Protocol v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho bot AI trên VPS Linux điều khiển Đăng Facebook và profile của MaiHub qua một API HTTPS có xác thực, cùng một bridge Python stdlib (MCP server + CLI) phía bot.

**Architecture:**
- **Lõi thuần TypeScript** trong `src/services/control/`: khoá, IP, giới hạn tốc độ, idempotency, sự kiện, nhật ký, bảng thao tác, máy chủ HTTPS. Phụ thuộc vào bên ngoài được nhận qua constructor, nên test bằng jest không cần Electron.
- **Lớp nối** `electron/ipc/controlApiIpc.ts`: chứng chỉ, vòng đời máy chủ, Cài đặt.
- **Thao tác:** gọi chung các hàm `posterOperations` tách ra từ `facebookPosterIpc.ts`.
- **Bridge** đặt ở `tools/maihub-bridge/`.

**Tech Stack:** Electron 41, TypeScript, Node `https`, better-sqlite3, React 18; dependency mới `selfsigned` (tạo chứng chỉ); Python ≥ 3.6 stdlib.

**Spec:** `docs/specs/2026-10-14-maihub-control-protocol.md`.

## Global Constraints

- Hằng số:
  - cổng mặc định `47321`; thân `/v1/call` ≤ `1048576` byte;
  - `idempotencyKey` ≤ 64 ký tự, giữ 24 giờ;
  - chặn IP sau `10` lần sai khoá trong `600` s, chặn `900` s;
  - `60` lời gọi/phút/khoá;
  - `events.wait` `timeoutSec` ≤ `25`;
  - sự kiện giữ 7 ngày / tối đa `5000` dòng; nhật ký giữ 30 ngày;
  - inbox media xoá sau 24 giờ.
- Khoá: `mh_` + 32 byte ngẫu nhiên base64url. Chỉ lưu SHA-256 (hex). Hiện đúng một lần lúc tạo. So sánh bằng `crypto.timingSafeEqual`.
- Mã lỗi đúng danh sách spec §3.2. Thông báo lỗi tiếng Việt; định danh tiếng Anh.
- Danh sách IP được phép **bắt buộc khác rỗng** mới bật được API. Máy chủ không chạy trong chế độ nhân viên.
- Không đổi hành vi IPC Đăng Facebook hiện có; toàn bộ test cũ phải xanh.
- Không đăng thật lên Facebook trong test. Không gọi mạng ngoài trong test (chỉ `127.0.0.1`).
- jest: `npx jest --runInBand`; suite SQLite cần `(cd node_modules/better-sqlite3 && npx prebuild-install)` trước và `npm run rebuild:native` sau.
- tsc: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` và `-p tsconfig.json`; chạy **riêng từng lệnh** (máy dev ít RAM).
- `node scripts/check-docs.js` sạch.
- `git add` đúng đường dẫn; commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. Khoá sai, khoá đã thu hồi, thiếu header, `Bearer` viết khác hoa/thường → `UNAUTHORIZED`, không lộ thời gian so sánh. (Task 2)
2. IP ngoài danh sách bị từ chối trước khi đọc thân, cả với `/v1/health`. IPv4 dạng `::ffff:1.2.3.4` vẫn khớp. (Task 2, Task 4)
3. Thao tác `destructive` thiếu `confirm: true` không thay đổi gì (kiểm DB không đổi). (Task 3)
4. Hai lời gọi cùng `idempotencyKey` gần như đồng thời chỉ chạy hàm một lần. (Task 2/3)
5. Đổi workspace khi API đang chạy: thao tác sau đó dùng DB workspace mới; khoá của workspace cũ không còn hiệu lực. (Task 5)

---

### Task 1: Tách `posterOperations` khỏi `facebookPosterIpc.ts`

**Files:** Modify `electron/ipc/facebookPosterIpc.ts`.

**Interfaces — Produces:** `export const posterOperations` gồm:
- `start`, `scheduleCreate`, `scheduleList`, `scheduleUpdate`, `scheduleDelete`;
- `draftSave`, `draftGet`, `draftApprove`;
- `cancel`, `current`;
- `listGroups`, `listRuns`, `getRun`, `listPostedUrls`.

Mỗi hàm có kiểu `(params: any) => Promise<Record<string, any> | void> | Record<string, any> | void` và chứa nguyên thân handler hiện có. `registerFacebookPosterIpc` gọi `handle('<channel>', posterOperations.<name>)`. Thêm `export function isFacebookPosterEmployeeBlocked(): boolean` để API dùng chung điều kiện chặn chế độ nhân viên.

- [ ] Step 1: Tách nguyên văn, không đổi logic, thứ tự hay thông báo lỗi.
- [ ] Step 2: Hai tsc sạch; `npx jest --runInBand src/__tests__/facebookPoster` xanh như trước.
- [ ] Step 3: Commit `refactor(fb-poster): expose IPC handler bodies as posterOperations`.

### Task 2: Lõi bảo mật và lưu trữ của Control API

**Files:**
- Create `src/services/control/ControlStore.ts`: bảng, thao tác DB; dùng `SqlDatabase` như `FacebookPosterStore`.
- Create `src/services/control/controlSecurity.ts`: `hashKey`, `generateKey`, `ipAllowed(ip, list)` có CIDR IPv4 và IPv4 ánh xạ IPv6, `RateLimiter`, `AuthLockout`.
- Create `src/services/control/IdempotencyCache.ts`.
- Modify `src/services/database/DatabaseService.ts`: tạo bảng trong khối schema và migration như các bảng khác.
- Test `src/__tests__/control/controlSecurity.test.ts`, `ControlStore.test.ts`, `IdempotencyCache.test.ts` (dùng `memoryDb()` của `src/__tests__/facebookPoster/helpers.ts`).

**Interfaces — Produces:**
- Bảng:
  - `control_keys(id TEXT PK, name TEXT, key_hash TEXT UNIQUE, created_at INT, last_used_at INT, revoked_at INT)`
  - `control_audit(id INTEGER PK AUTOINCREMENT, at INT, key_name TEXT, ip TEXT, method TEXT, params_summary TEXT, ok INT, error_code TEXT, duration_ms INT)`
  - `control_events(seq INTEGER PK AUTOINCREMENT, type TEXT, payload TEXT, created_at INT)`
  - `control_idempotency(key_id TEXT, idem_key TEXT, result TEXT, created_at INT, PRIMARY KEY(key_id, idem_key))`
- `ControlStore`:
  - `createKey(name): { id, name, key }` (key chỉ trả ở đây);
  - `listKeys()` (không có hash), `revokeKey(id)`;
  - `findActiveKeyByHash(hash): { id, name } | null`, `touchKey(id, at)`;
  - `addAudit(row)`, `listAudit(limit)`;
  - `addEvent(type, payload): number` (trả `seq`), `listEventsAfter(seq, limit)`;
  - `pruneOld(now)`: theo các mốc ở Global Constraints;
  - `getIdempotent(keyId, idem)`, `putIdempotent(keyId, idem, resultJson, now)`.
- `IdempotencyCache.run(keyId, idemKey | undefined, fn: () => Promise<T>): Promise<T>`: cùng khoá đang chạy thì chờ chung một promise; đã có kết quả (24 giờ) thì trả lại.
- `RateLimiter(limitPerMinute, now)`: `take(keyId): boolean`.
- `AuthLockout`:
  - `isBlocked(ip, now)`;
  - `recordFailure(ip, now)`;
  - `recordSuccess(ip)`.

- [ ] Step 1: Test đỏ cho các hành vi:
  - băm và so khớp;
  - thu hồi;
  - CIDR `/32`, `/24`, `::ffff:`, IP ngoài danh sách;
  - giới hạn 60 lời gọi/phút và chặn sau 10 lần sai;
  - idempotency (đồng thời, hết hạn);
  - `pruneOld`.
- [ ] Step 2: Cài đặt; test xanh; tsc sạch.
- [ ] Step 3: Commit `feat(control): keys, IP allow-list, rate limits, idempotency, audit and event store`.

### Task 3: Bảng thao tác `ControlMethods`

**Files:**
- Create `src/services/control/ControlMethods.ts`.
- Test `src/__tests__/control/ControlMethods.test.ts`.

**Interfaces — Produces:**
- `interface ControlMethod { name: string; description: string; destructive: boolean | ((params) => boolean); paramsSchema: object; resultSchema: object; run(params, ctx): Promise<unknown> }`.
- `createControlMethods(deps: ControlMethodDeps): ControlMethod[]`. Các thao tác đúng spec §3.4.
  - `deps` gồm:
    - `poster` (đúng chữ ký `posterOperations`);
    - `listProfiles()`;
    - `systemStatus()`;
    - `resolveMedia(mediaIds[]): string[]`;
    - `events` (`listEventsAfter`, `waitForEvent(afterSeq, timeoutMs)`).
  - `drafts.approve` destructive khi `when === 'now'`; `profiles.scanGroups` gọi `poster.start({ kind: 'scan_groups', … })`.
- `describe(methods): { protocol: 1, methods: [{ name, description, destructive, paramsSchema, resultSchema }] }`.
- `ControlError(code, message, details?)`. Lỗi `Error` thường từ `posterOperations` thành `INVALID_PARAMS`, giữ thông báo gốc. Hai lỗi có mã riêng:
  - lỗi có chữ "Đang có việc chạy" (`BUSY_ERROR`) thành `BUSY`;
  - lỗi `ENGINE_MISSING_ERROR` thành `ENGINE_MISSING`.

- [ ] Step 1: Test đỏ:
  - mỗi thao tác gọi đúng hàm `deps` với đúng tham số;
  - `drafts.delete`, `schedules.delete`, `runs.cancel`, `drafts.approve{when:'now'}` thiếu `confirm` thì trả `CONFIRMATION_REQUIRED` và không gọi `deps`;
  - ánh xạ lỗi;
  - `describe` liệt kê đủ và có schema.
- [ ] Step 2: Cài đặt; test xanh.
- [ ] Step 3: Commit `feat(control): method table, schemas and error mapping`.

### Task 4: Máy chủ HTTPS `ControlApiServer`

**Files:**
- Create `src/services/control/ControlApiServer.ts`.
- Test `src/__tests__/control/ControlApiServer.test.ts`: máy chủ thật trên `127.0.0.1:0`, chứng chỉ tạo trong test bằng `selfsigned`.
- Modify `package.json`/`package-lock.json`: thêm `selfsigned` (ghim phiên bản chính xác).

**Interfaces — Produces:**
- `new ControlApiServer({ tls: { key, cert }, port, host, allowList, store, methods, idempotency, rateLimiter, lockout, saveMedia(name, contentType, stream): Promise<{ mediaId, name, size, kind }>, now? })`.
- Phương thức `start(): Promise<{ port }>` và `stop(): Promise<void>`.
- Điểm cuối và quy tắc đúng spec §3.1–3.3:
  - IP bị chặn thì đóng socket trước khi đọc thân; giới hạn thân cũng áp trước khi đọc;
  - mọi lời gọi `/v1/call` ghi `control_audit`;
  - `events.wait` long-poll, huỷ sạch khi client đóng kết nối.
- Hàm thuần `createCertificate(): Promise<{ key, cert, fingerprintSha256 }>` trong `src/services/control/certificate.ts` (dùng `selfsigned`, RSA-2048, CN `maihub-control`, hạn 10 năm).

- [ ] Step 1: Test đỏ qua HTTPS thật (`rejectUnauthorized: false` + so dấu vân tay):
  - health;
  - describe;
  - call thành công và lỗi;
  - thiếu/sai khoá;
  - IP ngoài danh sách (giả `allowList` không chứa `127.0.0.1`);
  - vượt 1 MB → `PAYLOAD_TOO_LARGE`;
  - `RATE_LIMITED`;
  - upload media (tên, loại, kích thước);
  - `events.wait` trả ngay / chờ rồi trả / hết giờ.
- [ ] Step 2: Cài đặt; test xanh; tsc sạch.
- [ ] Step 3: Commit `feat(control): HTTPS server with auth, allow-list, media upload and long-poll events`.

### Task 5: Nối vào Electron

**Files:**
- Create `electron/ipc/controlApiIpc.ts`.
- Modify:
  - `electron/main.ts`: đăng ký IPC, khởi động API nếu đã bật, dừng khi `before-quit`;
  - `electron/ipc/facebookPosterIpc.ts`: phát sự kiện `run.started`/`run.finished`/`schedule.missed`/`draft.approved` vào `ControlStore` tại đúng các điểm đang phát `EventBroadcaster`, chỉ ghi thêm;
  - `electron/ipc/workspaceIpc.ts`: khởi động lại API sau khi đổi DB;
  - `electron/preload.ts`, `src/ui/lib/ipc.ts`.

**Interfaces — Produces:** IPC qua `handle()` có chặn chế độ nhân viên:
- `controlApi:getConfig` → `{ enabled, port, allowList, fingerprint, running, error? }`;
- `controlApi:setConfig({ enabled, port, allowList })`;
- `controlApi:createKey({ name })` → `{ key }`, chỉ lúc này;
- `controlApi:listKeys`, `controlApi:revokeKey({ id })`;
- `controlApi:listAudit({ limit })`;
- `controlApi:firewallCommand` → chuỗi `netsh advfirewall firewall add rule name="MaiHub Control API" dir=in action=allow protocol=TCP localport=<port> remoteip=<allowList>`.

Cấu hình lưu trong `app_settings` của workspace. Chứng chỉ và khoá riêng lưu ở `userData/control-api/`; khoá riêng mã hoá bằng `safeStorage` khi có. Có thể tạo lại chứng chỉ, và dấu vân tay đổi theo.

- [ ] Step 1:
  - `systemStatus()` dùng dữ liệu sẵn có: `app.getVersion()`, workspace đang mở, `getEngineManager().getStatus()`, `sandboxStatus`, scheduler, `posterOperations.current`;
  - `listProfiles()` dùng `db().getBrowserProfiles()`, `getBrowserProfileGroups()`, `getRunningIds()`;
  - `saveMedia` kiểm loại và kích thước bằng `mediaRules`;
  - dọn inbox mỗi giờ.
- [ ] Step 2: Không chạy khi chế độ nhân viên; lỗi bind cổng hiện trong `getConfig().error`, không làm crash app.
- [ ] Step 3: Hai tsc sạch; toàn bộ jest xanh.
- [ ] Step 4: Commit `feat(control): wire the control API into the app lifecycle and settings IPC`.

### Task 6: Màn Cài đặt "Điều khiển từ bot"

**Files:**
- Create `src/ui/components/settings/ControlApiSettings.tsx`.
- Modify `src/ui/components/settings/Settings.tsx`: thêm mục `NAV_ITEMS` id `controlApi`, nhãn `Điều khiển từ bot`, chỉ Boss/Standalone.

Theo `DESIGN.md` (token màu, sáng/tối, không tràn ngang). Màn gồm:
- bật/tắt;
- cổng, danh sách IP (một dòng một IP/CIDR, bắt buộc có ít nhất một);
- trạng thái chạy và lỗi;
- địa chỉ `https://<IP máy>:<cổng>` và dấu vân tay, có nút sao chép;
- tạo khoá (hộp hiện khoá một lần, nút sao chép, cảnh báo "chỉ hiện một lần");
- danh sách khoá, có nút thu hồi kèm xác nhận;
- lệnh `netsh`, có nút sao chép;
- đoạn `.env` mẫu cho bot (`MAIHUB_URL`, `MAIHUB_CERT_SHA256`, `MAIHUB_API_KEY=<khoá>`);
- bảng 100 lệnh gần nhất.

- [ ] Step 1: Cài đặt; hai tsc sạch.
- [ ] Step 2: Commit `feat(control): settings screen for the bot control API`.

### Task 7: Bridge Python `tools/maihub-bridge/`

**Files:**
- Create `tools/maihub-bridge/maihub_bridge.py`;
- Create `tools/maihub-bridge/README.md`;
- Create `tools/maihub-bridge/tests/test_bridge.py`.

**Interfaces — Produces:** CLI theo spec §4:
- `describe`;
- `call <method> [json]`;
- `upload <path>`;
- `wait [--after N] [--timeout S]`;
- `doctor`;
- `mcp`.

Đọc `MAIHUB_URL`, `MAIHUB_API_KEY`, `MAIHUB_CERT_SHA256` từ môi trường hoặc `--env-file`. Ghim chứng chỉ: `ssl.SSLContext` không kiểm CA và tên miền, so `hashlib.sha256(getpeercert(binary_form=True))`. MCP stdio (JSON-RPC 2.0, NDJSON):
- `initialize` (protocolVersion `2024-11-05`, capabilities `tools`);
- `tools/list`, sinh từ `/v1/describe`, cache trong phiên;
- `tools/call`;
- thêm tool `maihub_upload_media`.

Lỗi trả về `isError: true` kèm mã. Với `CONFIRMATION_REQUIRED`, bridge kèm câu hướng dẫn: hỏi người dùng rồi gọi lại với `confirm: true`.

- [ ] Step 1: Test `unittest` với máy chủ HTTPS giả (`http.server` + `ssl`, chứng chỉ mẫu trong `tests/fixtures/`):
  - ghim đúng và sai;
  - describe thành tool;
  - `tools/call` thành công và lỗi;
  - upload;
  - CLI `call`.
- [ ] Step 2: Chạy `python3 -m unittest discover -s tools/maihub-bridge/tests` xanh. Thêm bước CI ở job `verify` trong `.github/workflows/build.yml`.
- [ ] Step 3: Commit `feat(control): Python stdlib bridge (MCP server + CLI) for bots`.

### Task 8: Tài liệu

- `docs/protocol/maihub-control-protocol.md`: dành cho người viết bot; ví dụ `curl` và CLI; luồng mẫu "ý tưởng → nháp → duyệt → chờ kết quả".
- `SYSTEM_DOCUMENTATION.md`: mục API điều khiển, kèm dấu `docs-check` cho cổng mặc định (`DEFAULT_CONTROL_PORT = 47321`) và các giới hạn.
- `NOTICE.md`: giấy phép `selfsigned` và các dependency của nó.
- `README.md`: một đoạn ngắn kèm liên kết.
- `check-docs` sạch.
- Commit `docs(control): protocol reference, bridge setup and system docs`.

### Task 9 (controller): Kiểm chứng tích hợp

1. Chạy hai tsc riêng, toàn bộ jest, unittest Python, `check-docs`.
2. App dev:
   - bật API (allow-list `127.0.0.1`), tạo khoá;
   - từ máy dev chạy `maihub_bridge.py doctor`, `call system.status`, `upload`, `call drafts.create` (profile và nhóm giả nếu không có), `drafts.approve` hẹn xa, `events.wait`, `drafts.delete` (có `confirm`);
   - MCP qua stdio: `tools/list`, `tools/call`.
   - Không đăng thật.
3. Màn Cài đặt: desktop/mobile, sáng/tối, không tràn.
4. Chạy hai vòng stress theo `AGENTS.md`.
5. Kiểm thử thật trên VPS Windows `.230` và bot `.164`: chờ anh duyệt việc cài trên 164 và mở cổng trên Windows.

---

## Điều chỉnh khi triển khai (14/10/2026)

1. **Mã lỗi:** `toControlError` chỉ trả `NOT_FOUND` cho đúng ba thông báo tài nguyên (nháp, lịch, lần chạy). Lỗi không phải `Error` thường thành `INTERNAL`, kèm thông báo cố định. Có thêm trường `destructiveWhen` cho `drafts.approve`.
2. **Máy chủ:**
   - ghi nhật ký cả các lời gọi bị từ chối (401 mỗi lần; 429 tối đa một dòng/60 s cho mỗi khoá và mỗi IP);
   - tối đa 64 kết nối và 4 long-poll mỗi khoá;
   - `selfsigned` nạp lười;
   - thư mục tải lên giới hạn 2 GiB / 200 tệp;
   - tải lên bị từ chối vẫn đọc hết thân để client không bị treo.
3. **Idempotency:** khoá gắn với tên thao tác. Dùng lại cho thao tác khác thì trả `INVALID_PARAMS`.
4. **Sự kiện:** ghi khi API được bật, không phụ thuộc máy chủ có bind được cổng hay không. Bộ ghi được gắn đồng bộ trước khi scheduler chạy. `events.wait` trả thêm `workspaceId`.
5. **Chế độ nhân viên:** mỗi lời gọi bị từ chối bằng `BUSY` (503). Lúc thoát app, API dừng sau scheduler và trước khi đóng DB.
6. **Bản build phát hành:** `scripts/strip-console.js` thay lời gọi `console` bị xoá bằng `void 0;` để giữ nguyên câu lệnh; code của API dùng `Logger` nên bản phát hành vẫn còn log chẩn đoán.
7. **Bridge:** `--env-file` nhận được cả trước lẫn sau lệnh con; loại tệp lấy từ bảng cố định; stdio dùng UTF-8.
