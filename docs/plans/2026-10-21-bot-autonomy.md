# Bot tự làm nhiều hơn (Đợt 2) — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm vào Control API và bridge những thứ giúp bot AI tự chạy vòng nghiên cứu → nháp → đăng → đo → thu khách với ít lượt gọi và ít kẹt hơn, không đổi hành vi cũ.

**Architecture:** Phía MaiHub (TypeScript) chỉ thêm trường vào `system.status` và sự kiện, cộng 2 thao tác thu bình luận nối vào `leadOperations` có sẵn. Phía bridge (Python stdlib) thêm gợi ý lỗi, văn bản hướng dẫn, tool chờ sự kiện và bớt ồn ở `watch`. Hai phía làm song song được vì chỉ gặp nhau ở giao thức đã ghi trong spec.

**Tech Stack:** Electron 41 + TypeScript + Jest + better-sqlite3; Python 3.6+ stdlib + unittest.

**Spec:** `docs/specs/2026-10-21-bot-autonomy.md` (đã duyệt 21/10/2026).

## Global Constraints

- Giao thức chỉ thêm: không đổi tên / bỏ trường cũ, không thêm mã lỗi, không đổi `destructive` / `confirm` của thao tác cũ.
- Định danh tiếng Anh; chú thích, thông báo, văn bản cho người dùng tiếng Việt, theo giọng code xung quanh.
- Bridge chỉ dùng thư viện chuẩn, chạy được trên Python 3.6 (không f-string, không API 3.7+).
- Control API: 47 → 49 thao tác. Sự kiện mới đúng tên `comments.collectFinished`.
- `maihub_wait_for`: `maxSec` 1–600, mặc định 50; mỗi vòng `events.wait` tối đa 25 giây.
- `leads.found.leadIds` và `campaignIds`: tối đa 20 phần tử mỗi danh sách.
- `comments.collectStatus.last.errors`: tối đa 10 dòng.
- Người làm từng task **không commit, không `git add`**. Người điều phối (em) review, viết tài liệu và commit; tài liệu đi cùng commit với code.

## Review Focus

1. Bot gọi `maihub_wait_for` cho một việc đã xong **trước** lời gọi nhưng **sau** khi phiên MCP bắt đầu → phải trả sự kiện đó ngay, không chờ hết giờ (Task 5).
2. MaiHub đổi workspace giữa lúc chờ → trả `workspaceChanged`, không lặp vô hạn hay trả sự kiện của workspace khác (Task 5).
3. Bridge mới nói chuyện với MaiHub 26.26.0: `system.status` không có `lastEventSeq` → vẫn chạy, tự tính mốc (Task 5); thiếu `details` / mã lạ → không có dòng `Gợi ý`, không lỗi (Task 4).
4. Lượt thu bình luận bị huỷ → `comments.collectFinished.cancelled = true`, `collectStatus.last.cancelled = true` (Task 2).
5. Danh sách khách có `campaignId` trùng hoặc `null`, hoặc > 20 khách → `campaignIds` bỏ trùng, bỏ `null`, cắt 20; `leadIds` mới nhất trước, cắt 20 (Task 3).

---

### Task 1: `system.status` có giờ, múi giờ và `lastEventSeq`

**Files:**
- Modify: `src/services/control/ControlStore.ts` (thêm `lastEventSeq()` cạnh `listEventsAfter`, khoảng dòng 140)
- Modify: `src/services/control/ControlMethods.ts` (`ControlMethodDeps.events` thêm `lastSeq(): number`; `system.status` khoảng dòng 248)
- Modify: `electron/ipc/controlApiIpc.ts:186` (nối `lastSeq: () => store.lastEventSeq()`)
- Test: `src/__tests__/control/ControlStore.test.ts`, `src/__tests__/control/ControlMethods.test.ts`

**Interfaces:**
- Produces: `ControlStore.lastEventSeq(): number` (0 khi bảng rỗng); `deps.events.lastSeq(): number`; kết quả `system.status` = kết quả cũ + `{ serverNowMs: number, timezone: string, utcOffsetMin: number, lastEventSeq: number }`.

- [ ] **Step 1: Viết test hỏng**
  - `ControlStore`: DB mới thì `lastEventSeq()` là 0; sau 3 lần `addEvent` thì bằng `seq` của sự kiện cuối.
  - `ControlMethods`: `system.status` trả đủ các trường cũ của `deps.systemStatus()` cộng 4 trường mới. Kiểm `typeof timezone === 'string'` và khác rỗng; `utcOffsetMin === -new Date().getTimezoneOffset()`; `serverNowMs` nằm trong khoảng [trước, sau] lời gọi; `lastEventSeq` bằng giá trị fake `lastSeq` trả về.
- [ ] **Step 2: Chạy test và xác nhận hỏng:** `npx jest src/__tests__/control/ControlStore.test.ts src/__tests__/control/ControlMethods.test.ts --runInBand`
- [ ] **Step 3: Cài đặt**
  - `lastEventSeq` dùng `SELECT MAX(seq) AS seq FROM control_events`.
  - `system.status.run` trả `{ ...(await deps.systemStatus()), serverNowMs: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', utcOffsetMin: -new Date().getTimezoneOffset(), lastEventSeq: deps.events.lastSeq() }`.
  - Sửa mọi fake `events` trong test hiện có cho đủ kiểu, nếu tsc đòi.
- [ ] **Step 4: Chạy lại test và xác nhận đạt.** Sau đó chạy `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`.

### Task 2: Thu bình luận — trạng thái, huỷ, sự kiện xong

**Files:**
- Modify: `src/services/facebookPoster/CommentCollector.ts:187` (payload `comments.collectFinished` thêm `cancelled`)
- Modify: `src/services/control/controlEvents.ts` (`ControlEventType` thêm `'comments.collectFinished'`; thêm `buildCollectFinished`)
- Modify: `src/services/control/ControlMethods.ts`
  - `LeadPort` thêm `collectStatus(): any; collectCancel(): any`;
  - thêm 2 thao tác ngay sau `comments.collect`.
- Modify: `electron/ipc/controlApiIpc.ts:153-160` (nối `collectStatus`, `collectCancel` vào `leadOperations` có sẵn)
- Modify: `electron/ipc/facebookPosterIpc.ts:289-292` (trong nhánh `comments.collectFinished`, thêm `safely('controlCollectFinished', () => emitControlEvent('comments.collectFinished', buildCollectFinished(payload as any)))`)
- Test: `src/__tests__/facebookPoster/CommentCollector.test.ts`, `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts` hoặc `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` (theo nơi đang kiểm `buildLeadsFound`)

**Interfaces:**
- Produces:
  - `buildCollectFinished(e: { jobId: string; auto: boolean; cancelled: boolean; posts: number; collected: number; leads: number; errors: number }): same shape`, chỉ giữ đúng các trường này.
  - Thao tác `comments.collectStatus`: `{ running, jobId, progress: { done, total }, last }`. `last` lấy từ `deps.leads.collectStatus()`; nếu có `last.errors` (mảng) thì cắt còn 10 dòng `{ postUrl, profileId, error }`.
  - Thao tác `comments.collectCancel`: `{ cancelled: boolean }`.
  - Cả hai `destructive: false`, `paramsSchema: obj({})`.

- [ ] **Step 1: Viết test hỏng**
  - `CommentCollector`: huỷ giữa lượt → `comments.collectFinished` có `cancelled: true`; lượt bình thường → `cancelled: false`.
  - `buildCollectFinished` bỏ trường lạ.
  - `describe` liệt kê đúng 49 tên: sửa danh sách kỳ vọng ở `ControlMethods.test.ts:246`, chèn `comments.collectStatus`, `comments.collectCancel` sau `comments.collect`.
  - `comments.collectStatus` cắt `last.errors` 12 dòng còn 10.
  - `comments.collectCancel` gọi `deps.leads.collectCancel` đúng một lần.
  - Wiring: khi collector phát `comments.collectFinished` thì có `emitControlEvent('comments.collectFinished', …)`.
- [ ] **Step 2: Chạy test và xác nhận hỏng:** `npx jest src/__tests__/facebookPoster/CommentCollector.test.ts src/__tests__/control --runInBand`
- [ ] **Step 3: Cài đặt.** Mô tả thao tác bằng tiếng Việt:
  - `comments.collectStatus`: "Trạng thái lượt thu bình luận đang chạy và lượt gần nhất (đã huỷ chưa, số bài, số bình luận, số khách, lỗi)."
  - `comments.collectCancel`: "Huỷ lượt thu bình luận đang chạy (nếu có); dừng sau bài đang đọc."
  - `comments.collect`: nối thêm vào cuối mô tả "Xong có sự kiện comments.collectFinished (lọc theo jobId)."
- [ ] **Step 4: Chạy lại test và xác nhận đạt;** chạy tsc cả hai cấu hình.

### Task 3: `leads.found` có `leadIds` / `campaignIds`, `run.finished` có `campaignId`

**Files:**
- Modify: `src/services/facebookPoster/LeadDetector.ts:32-36` (`buildLeadsFoundPayload` và kiểu `LeadsFoundPayload`)
- Modify: `src/services/control/controlEvents.ts` (`buildLeadsFound`, `buildRunFinished`)
- Modify: `electron/ipc/facebookPosterIpc.ts:247` (kiểu tham số `emitLeadsFound`) và `:330` (`buildRunFinished` đã nhận `found.run` có `campaignId`; chỉ cần `Pick` thêm `campaignId`)
- Test: `src/__tests__/facebookPoster/LeadDetector.test.ts`, test đang kiểm `buildLeadsFound` / `buildRunFinished`

**Interfaces:**
- Produces:
  - `LeadsFoundPayload` = cũ + `leadIds: number[]` (mới nhất trước, ≤ 20) + `campaignIds: string[]` (không trùng, không `null`, ≤ 20, theo thứ tự xuất hiện từ mới tới cũ);
  - `buildLeadsFound` giữ thêm hai trường đó; nếu thiếu (dữ liệu cũ) thì trả mảng rỗng;
  - `buildRunFinished(run: Pick<FbPosterRun, 'id' | 'kind' | 'status' | 'scheduleId' | 'campaignId'>, …)` trả thêm `campaignId` (`?? null`).

- [ ] **Step 1: Viết test hỏng**
  - 25 khách với `id` 1–25, `campaignId` xen kẽ `'c1'`, `null`, `'c2'`, `'c1'` → `leadIds` = [25..6] (20 mã), `campaignIds` = `['c1','c2']` hoặc thứ tự mới tới cũ, đúng theo cài đặt; kiểm bằng giá trị cụ thể.
  - `buildLeadsFound` không có `leadIds` → `[]`.
  - `buildRunFinished` có `campaignId: 'c9'`; run không có thì `null`.
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt** (lấy thứ tự "mới nhất trước" giống `samples`: `leads.slice().reverse()`).
- [ ] **Step 4: Chạy test liên quan và tsc, xác nhận đạt.**

### Task 4: Bridge — lỗi có gợi ý, hướng dẫn, kết quả gọn, `watch` bớt ồn

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`
- Test: `tools/maihub-bridge/tests/test_bridge.py` (`McpTests`, `FormatEventTests`)

**Interfaces:**
- Produces:
  - Hằng `GUIDE` (chuỗi) và `ERROR_HINTS` (dict mã → gợi ý, đúng bảng spec mục 2.1; `CONFIRMATION_REQUIRED` dùng `CONFIRM_GUIDANCE` hiện có).
  - Hằng `GUIDE_TOOL = "maihub_guide"`, `WAIT_TOOL = "maihub_wait_for"` (Task 5 dùng).
  - Hàm `format_tool_error(err) -> str`.
  - `initialize` trả thêm `"instructions": GUIDE`.

- [ ] **Step 1: Viết test hỏng**
  - Tool lỗi `NOT_FOUND` có `details {"missing":["p1"]}` → văn bản có 3 dòng: `NOT_FOUND: …`, `Chi tiết: {"missing":["p1"]}`, `Gợi ý: …`.
  - Mã lạ, không có details → đúng 1 dòng.
  - `CONFIRMATION_REQUIRED` vẫn chứa `CONFIRM_GUIDANCE`.
  - `initialize` có `instructions == GUIDE`.
  - `tools/list` có `maihub_guide`; gọi nó trả `GUIDE`.
  - `GUIDE` chứa các chuỗi `maihub_wait_for`, `maihub_upload_media`, `maihub_download_video`, `run.finished`, `comments.collectFinished`, `videos.finished`, `idempotencyKey`, `serverNowMs`, `uncertain_after_submit`.
  - Kết quả tool thành công không có `"\n  "` (JSON gọn).
  - `format_event` `run.finished` với `kind` = `join` / `scan_groups` / `collect_comments`, `status=done`, `failed=0` → `None`; cùng các kind đó có `failed>0` hoặc `status=cancelled` → vẫn có tin; `kind=post` thành công → vẫn có tin `✅`.
  - `format_event` `comments.collectFinished` → `None`.
  - Sửa các test hiện có đang đếm số tool, vì có thêm tool.
- [ ] **Step 2: Chạy test và xác nhận hỏng:** `cd tools/maihub-bridge && python3 -m unittest discover -s tests 2>&1 | tail -5`
- [ ] **Step 3: Cài đặt.** `GUIDE` viết theo đúng 6 ý của spec mục 2.2, khoảng 400–600 từ. Ghi rõ "Cần MaiHub ≥ 26.27.0 cho comments.collectFinished, comments.collectStatus/collectCancel, lastEventSeq".
- [ ] **Step 4: Chạy test, `python3 -m py_compile maihub_bridge.py`, kiểm Python 3.6** (`python3 -c "import ast;ast.parse(open('maihub_bridge.py').read(),feature_version=(3,6))"`).

### Task 5: Bridge — `maihub_wait_for` và mốc của phiên

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py` (`McpServer`)
- Test: `tools/maihub-bridge/tests/test_bridge.py` (lớp mới `WaitForTests`, dùng fake client có hàng sự kiện theo kịch bản và đồng hồ giả)

**Interfaces:**
- Consumes: `WAIT_TOOL`, `format_tool_error` (Task 4); `system.status.lastEventSeq` (Task 1, có thể vắng).
- Produces:
  - `McpServer.session_after`: `None` | `int`, đặt khi `initialize`, lỗi thì để `None`;
  - `McpServer.wait_for(args) -> dict`, trả một trong ba dạng: `{"event": {...}, "after": seq}` | `{"timedOut": True, "after": seq}` | `{"workspaceChanged": True}`;
  - `McpServer` nhận thêm `clock=time.time`, `sleep=time.sleep` để test được.

- [ ] **Step 1: Viết test hỏng.** Các ca:
  - (a) Sự kiện khớp đã có sẵn sau mốc phiên → trả ngay.
  - (b) Khớp ở vòng thứ 3.
  - (c) Không khớp, hết `maxSec` → `timedOut`, `after` = seq lớn nhất đã xét.
  - (d) `workspaceId` đổi → `workspaceChanged`.
  - (e) `after` truyền vào được dùng thay mốc phiên.
  - (f) `system.status` không có `lastEventSeq` → mốc tính bằng duyệt `events.wait timeoutSec=0` tới hết, ở lần `wait_for` đầu.
  - (g) `initialize` lỗi mạng → không làm hỏng `initialize`; mốc tính sau.
  - (h) Hai lần `wait_for` liên tiếp không `after` cùng xét lại từ mốc phiên: sự kiện B đến trong lúc chờ A vẫn được lần chờ B trả về.
  - (i) Tham số sai (`maxSec` 0 hoặc 601, `match` không phải dict, giá trị `match` là list, `types` không phải list chuỗi) → `INVALID_PARAMS`.
  - (j) `timeoutSec` mỗi lần gọi ≤ 25 và ≤ thời gian còn lại (làm tròn lên, tối thiểu 1).
- [ ] **Step 2: Chạy test và xác nhận hỏng.**
- [ ] **Step 3: Cài đặt** theo spec mục 2.3. Tool `maihub_wait_for` có `inputSchema` với 4 tham số (`types`, `match`, `after`, `maxSec`) và mô tả tiếng Việt. Mô tả ghi rõ: hết giờ thì gọi lại với `after` vừa nhận.
- [ ] **Step 4: Chạy toàn bộ test bridge, `py_compile`, kiểm Python 3.6.**

### Task 6 (người điều phối): tài liệu, review, kiểm tích hợp, commit

- [ ] Cập nhật tài liệu:
  - `SYSTEM_DOCUMENTATION.md`: số thao tác 47 → 49, sự kiện mới, các trường mới, bridge;
  - `docs/protocol/maihub-control-protocol.md`: bảng thao tác, mục 9 Sự kiện, `system.status`, phần bridge;
  - `tools/maihub-bridge/README.md`;
  - dòng Trạng thái của spec.
- [ ] Chạy `node scripts/check-docs.js`, toàn bộ jest, toàn bộ test bridge, tsc cả hai cấu hình.
- [ ] Kiểm tích hợp 2 vòng trên MaiHub dev theo spec mục 5. Ghi số lời gọi trước và sau.
- [ ] Review cuối bằng Opus (không chạy cùng lúc với app hay Docker), sửa các điểm review.
- [ ] Commit theo từng phần (MaiHub, bridge), tài liệu đi kèm commit tương ứng.
