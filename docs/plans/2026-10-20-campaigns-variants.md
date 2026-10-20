# Kế hoạch: Chiến dịch và biến thể A/B cho Đăng Facebook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gom lịch đăng thành chiến dịch có tạm dừng / khoảng ngày / báo cáo, và cho bài có 2–5 biến thể chữ được xoay vòng đều giữa các đích, kèm báo cáo so sánh.

**Architecture:**
- Bảng `fb_poster_campaigns`, cùng cột `campaign_id` (chụp lại ở lượt chạy và dòng theo dõi) và `variant`.
- Hai module thuần:
  - `campaigns.ts`: luật chạy được, kiểm tra đầu vào;
  - `variants.ts`: chia biến thể, kiểm tra.
- Phần nối vào code có sẵn: `FacebookPosterService` (chữ theo đích), `FacebookPosterScheduler` (chặn theo chiến dịch), `statsReport` (gom / lọc mới), IPC, Control API, UI.

**Tech Stack:** Electron 41, React 18, TypeScript, better-sqlite3, Jest.

**Spec:** `docs/specs/2026-10-20-campaigns-variants.md` (đã duyệt). Intent: `docs/intent/2026-10-20-campaigns-variants.md`.

## Global Constraints

- **Định danh:**
  - tiếng Anh, tiền tố `fb_poster_` cho bảng;
  - chữ hiển thị, log và docs tiếng Việt;
  - không đụng tên "campaign" của Zalo CRM (`src/models/crm.ts`, kênh `crm:*`).
- **Chỉ thêm bảng / cột / index**, bằng danh sách `FB_POSTER_MIGRATIONS` (`src/services/facebookPoster/schema.ts`), lỗi "cột đã có" bỏ qua như cũ.
- **Trạng thái chiến dịch:** `active` / `paused` / `archived`.
  - Tên 1–100 ký tự, không trùng (trim, không phân biệt hoa thường); mục tiêu ≤ 1000 ký tự.
  - `start_at <= end_at` khi cả hai có.
- **`isRunnable(c, t)`** = `status === 'active'` và `(start_at === null || t >= start_at)` và `(end_at === null || t <= end_at)`.
- **Lý do bỏ lỡ:** `Chiến dịch đang tạm dừng`, `Chiến dịch đã lưu trữ`, `Ngoài thời gian chiến dịch`.
- **Biến thể:**
  - `text` = A; `variants` gồm 1–4 chuỗi = B…E.
  - Mỗi chuỗi không rỗng, ≤ 63206 ký tự, không trùng `text` hay nhau (so sau trim).
  - `variant` = `''` khi không có biến thể.
- **Chia biến thể:**
  - xếp các cặp (profile, đích) theo `url` rồi `profileId`;
  - cặp thứ `i` nhận `(i + offset) mod n`;
  - `offset` = số lượt `running` / `done` / `cancelled` trước đó của cùng lịch, `0` khi đăng ngay.
- **`insufficient`** = `measured < 5` (`MIN_MEASURED_FOR_COMPARISON = 5`).
- **Control API:** chỉ thêm; 30 → 35 thao tác; không thêm mã lỗi mới (xoá còn lịch → `INVALID_PARAMS`).
- **Lỗi hiển thị:**
  - `Không tìm thấy chiến dịch`;
  - `Chiến dịch đã lưu trữ`;
  - `Chiến dịch còn N lịch/bài nháp, hãy chuyển hoặc xoá trước`;
  - `Tên chiến dịch đã tồn tại`.
- **An toàn đăng bài 26.21 giữ nguyên:** ranh giới gửi bài, luật thử lại, `draft_conflict`. Lần thử lại dùng đúng chữ của đích.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <paths>`; không chạy `rebuild:native` / `prebuild-install`.
  - tsc: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi `-p tsconfig.json`, **lần lượt**.
  - `node scripts/check-docs.js` sạch.
- **Tài liệu:** `SYSTEM_DOCUMENTATION.md` và `docs/protocol/maihub-control-protocol.md` cập nhật trong cùng commit với thay đổi hành vi.
- **Git:**
  - `git add` đúng đường dẫn;
  - commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
  - không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **Bài đăng với biến thể bị theo dõi nhầm chữ:** `text_head` phải lấy chữ đã đăng của đích đó, nếu không thì bài không bao giờ được gắn link. → Task 3.
2. **Chiến dịch bị tạm dừng trong lúc lịch đang chờ trong hàng đợi:** không được chạy, phải ghi `missed`. Lịch không có chiến dịch không đổi hành vi. → Task 4.
3. **Bot cũ không gửi `variants` / `campaignId`, và bài nháp cũ không có hai trường này:** vẫn đăng y như 26.21 (`variant = ''`, `campaign_id = NULL`). → Task 3, 7.
4. **Xoá hoặc lưu trữ chiến dịch khi còn lịch đang bật:** xoá bị từ chối; lưu trữ thì lịch không chạy. Báo cáo cũ vẫn đọc được, nhãn `(chiến dịch đã xoá)`. → Task 1, 4, 5.
5. **Thử lại (G) và huỷ giữa lượt có biến thể:** đích thử lại giữ biến thể; đích còn lại không bị chia lại. → Task 3.

---

### Task 1: Dữ liệu và store

**Files:**
- Modify: `src/services/facebookPoster/schema.ts`, `src/models/facebookPoster.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts` (thêm `describe('campaigns')`, test cột mới)

**Interfaces:**
- **Produces:**
  - Model `FbPosterCampaign { id; name; goal; status: CampaignStatus; startAt: number | null; endAt: number | null; createdAt; updatedAt }`, với `CampaignStatus = 'active' | 'paused' | 'archived'`.
  - `FbPosterSchedule.campaignId: string | null`; `FbPosterRun.campaignId: string | null`; `FbPosterResult.variant: string`; `PostTrackingRow.campaignId: string | null`, `PostTrackingRow.variant: string`.
  - Store:
    - `createCampaign(c: FbPosterCampaign)`, `getCampaign(id)`, `listCampaigns(opts?: { status?: CampaignStatus; includeArchived?: boolean })`, `updateCampaign(id, patch, at)`, `deleteCampaign(id)`;
    - `findCampaignByName(name): FbPosterCampaign | null` (trim, không phân biệt hoa thường);
    - `countCampaignSchedules(id): { schedules: number; drafts: number }`;
    - `countStartedRuns(scheduleId): number` (status `running` / `done` / `cancelled`);
    - `createSchedule` / `updateSchedule` nhận `campaignId`; `listSchedules(filter?: { campaignId?: string })` (`''` = không chiến dịch);
    - `createRun` nhận `campaignId?`; `addResult` nhận `variant`; `createTracking` nhận `campaignId`, `variant`.
- **Không đổi hành vi** khi các trường mới vắng: mặc định `NULL` / `''`.

- [ ] **Step 1:** Viết test:
  - CRUD chiến dịch (tạo, đọc, sửa, xoá; liệt kê mặc định bỏ `archived`, `includeArchived`, lọc `status`);
  - `findCampaignByName` (hoa thường, khoảng trắng);
  - `countCampaignSchedules` tách lịch và bài nháp;
  - `countStartedRuns` bỏ `missed` / `failed`;
  - `campaign_id` / `variant` đọc ghi đúng ở schedules / runs / results / tracking;
  - `listSchedules({ campaignId })` và `campaignId: ''`;
  - DB cũ (bảng có sẵn trước migration) mở lên vẫn chạy: ALTER chạy hai lần không lỗi.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code: schema (bảng mới + index `fb_poster_schedules(campaign_id)`, `fb_poster_post_tracking(campaign_id)`), migrations, model, store, mapper. Chạy test → PASS; chạy cả `src/__tests__/facebookPoster`.
- [ ] **Step 3:** Commit `feat(poster): campaign table and campaign/variant columns`.

### Task 2: Luật chiến dịch và chia biến thể (module thuần)

**Files:**
- Create: `src/services/facebookPoster/campaigns.ts`, `src/services/facebookPoster/variants.ts`
- Modify: `src/services/facebookPoster/validateStartParams.ts` (`validatePost` và hàm kiểm bản nháp ở cùng file nhận `variants`, `campaignId`)
- Test: `src/__tests__/facebookPoster/campaigns.test.ts`, `src/__tests__/facebookPoster/variants.test.ts`, thêm vào `src/__tests__/facebookPoster/validateStartParams.test.ts`

**Interfaces:**
- **Produces (`campaigns.ts`):**
  - `isCampaignRunnable(c, t): boolean`;
  - `campaignBlockReason(c, t): string | null`, trả một trong ba lý do ở Global Constraints;
  - `validateCampaignInput(input, { existing?: FbPosterCampaign; findByName }): { name; goal; startAt; endAt; status }`: ném `Error` tiếng Việt; kiểm tên trùng trừ chính nó.
- **Produces (`variants.ts`):**
  - `VARIANT_LABELS = ['A','B','C','D','E']`, `MAX_VARIANTS = 5`;
  - `readVariants(p): string[]`: kiểm `variants` theo Global Constraints, trả mảng đã kiểm (rỗng nếu vắng);
  - `assignVariants(pairs: { profileId: string; url: string }[], n: number, offset: number): Map<string, number>`, với key `variantKey(profileId, url)` = `` `${profileId}\u0000${url}` ``;
  - `variantText(params: { text: string; variants?: string[] }, index: number): string`.
- **`StartParams` (kind `post`)** thêm `variants?: string[]`, `campaignId?: string | null`. `validatePost` gọi `readVariants`; `campaignId` chỉ kiểm kiểu (chuỗi không rỗng hoặc `null`). Kiểm tồn tại ở Task 3.

- [ ] **Step 1:** Viết test:
  - `isCampaignRunnable` / `campaignBlockReason` cho từng trạng thái, biên `start_at` / `end_at` (bằng nhau), `null`;
  - `validateCampaignInput`: tên rỗng, 101 ký tự, trùng (hoa thường), sửa giữ tên cũ, `startAt > endAt`, mục tiêu 1001 ký tự;
  - `assignVariants`: 10 đích × 2 → 5/5; 7 × 3 → 3/2/2; đổi thứ tự đầu vào không đổi kết quả; `offset = 1` dịch mỗi đích sang biến thể kế; `n = 1` → toàn 0; hai profile cùng một đích được xếp theo `profileId`;
  - `readVariants`: vắng / rỗng → `[]`; 5 phần tử → lỗi; phần tử rỗng, quá dài, trùng `text`, trùng nhau → lỗi;
  - `validatePost` giữ nguyên kết quả cũ khi không có trường mới (so `deepStrictEqual` với một bộ tham số cũ).

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy test → PASS.
- [ ] **Step 3:** Commit `feat(poster): campaign rules and variant assignment`.

### Task 3: Đăng bài với biến thể và chiến dịch

**Files:**
- Modify: `src/services/facebookPoster/FacebookPosterService.ts` (`start`, `plan`, `runTask`, `record`, `trackPostedResult`), `src/services/facebookPoster/postToTargets.ts` (`PostInput`)
- Test: `src/__tests__/facebookPoster/FacebookPosterService.test.ts`, `src/__tests__/facebookPoster/postToTargets.test.ts`

**Interfaces:**
- **Consumes:** Task 1 (store), Task 2 (`assignVariants`, `variantText`, `VARIANT_LABELS`).
- **`PostInput`** thêm `textFor?: (url: string) => string`. `postToTargets` dùng `textFor?.(url) ?? text` cho **mọi** lần thử của đích đó (cả `draft_conflict` / đọc lại ô soạn).
- **`FacebookPosterService.start(params, scheduleId?)`:**
  - Nếu `params.campaignId`: `store.getCampaign` → không có thì ném `Không tìm thấy chiến dịch`; `archived` thì ném `Chiến dịch đã lưu trữ`.
  - `createRun({ ..., campaignId })`.
  - `offset = scheduleId ? store.countStartedRuns(scheduleId) : 0`, đếm **trước** khi tạo run.
  - Tính `assignVariants` một lần cho cả lượt, lưu trên `ActiveRun` (`variantIndex(profileId, url)`).
- **`runTask`** truyền `textFor` theo profile. `record()` ghi `variant` = `VARIANT_LABELS[i]` khi `params.variants?.length`, ngược lại `''`.
- **`trackPostedResult`:** `textHead = normalizeHead(variantText(params, i))`, `campaignId = active.run.campaignId`, `variant`.
- **Không có `variants`:** `textFor` không truyền, mọi thứ như cũ.

- [ ] **Step 1:** Viết test:
  - 2 profile × 3 nhóm, 2 biến thể → chữ đăng đúng theo `assignVariants`, `variant` ghi đúng;
  - lịch có 1 lượt đã `done` → `offset = 1`; lượt `missed` không tính;
  - đích thử lại (lỗi trước khi gửi rồi thành công) dùng cùng chữ;
  - `text_head` của dòng theo dõi lấy từ chữ biến thể;
  - `campaign_id` của run và dòng theo dõi;
  - chiến dịch không có / `archived` → `start` ném lỗi, không tạo run;
  - không có `variants` → chữ = `text`, `variant = ''` (giữ test cũ PASS không sửa).

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` → PASS.
- [ ] **Step 3:** Commit `feat(poster): post A/B variants per target and stamp campaign on runs`.

### Task 4: Lịch đăng theo chiến dịch

**Files:**
- Modify: `src/services/facebookPoster/FacebookPosterScheduler.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts`

**Interfaces:**
- **Consumes:** Task 2 (`campaignBlockReason`).
- **`SchedulerDeps`** thêm `campaignBlock: (s: FbPosterSchedule, t: number) => string | null`. Trả `null` khi lịch không có chiến dịch, hoặc chiến dịch chạy được. Nối thật ở Task 6 qua `store.getCampaign`.
- **`fire()`:** với lịch đến giờ có `reason = campaignBlock(s, t)`:
  - lịch `recurring` → không xếp hàng, không ghi (vẫn cập nhật `nextRunAt` như cũ);
  - lịch `once` → `recordMissed(s.id, reason, s.nextRunAt, s)`.
- **`pumpQueue()`:** trước `startRun`, nếu `campaignBlock(s, now())` → `recordMissed(s.id, reason, now())` rồi bỏ.
- **Mọi lỗi ném từ `campaignBlock`:** coi như không chặn (`null`) và ghi log, để lỗi đọc DB không làm lịch ngừng chạy.

- [ ] **Step 1:** Viết test:
  - lịch lặp của chiến dịch `paused` → không chạy, không ghi `missed`, `nextRunAt` sang lần sau;
  - lịch một lần → `missed` đúng lý do (ba lý do);
  - tạm dừng khi lịch đang trong hàng chờ (bận rồi rảnh) → `missed`;
  - tiếp tục → lần đến giờ sau chạy;
  - lịch không chiến dịch giữ test cũ;
  - `campaignBlock` ném lỗi → lịch vẫn chạy.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy test thư mục facebookPoster → PASS.
- [ ] **Step 3:** Commit `feat(poster): campaign pause and date window gate scheduled runs`.

### Task 5: Báo cáo theo chiến dịch và biến thể

**Files:**
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts` (`statsReport`, `listTracking`), `src/models/facebookPoster.ts` (`PostStatsGroupBy`, `PostStatsReportRow.insufficient`)
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`

**Interfaces:**
- **`PostStatsGroupBy`** thêm `'campaign' | 'variant'`.
- **`statsReport(opts)`:**
  - thêm `campaignId?: string` (`''` = không chiến dịch), `scheduleId?: string`;
  - nhãn: campaign → tên, `Không thuộc chiến dịch`, `(chiến dịch đã xoá)`; variant → `<tên lịch> · <nhãn>` / `<tên lịch>` / `Đăng ngay`;
  - key variant = `` `${schedule_id ?? ''}:${variant}` ``;
  - sắp xếp `campaign` / `variant` như `group` / `profile` / `schedule`.
- **`PostStatsReportRow.insufficient: boolean`** = `measured < MIN_MEASURED_FOR_COMPARISON`. Hằng số export từ `postTracking.ts`.
- **`listTracking(filter)`** thêm `campaignId?`, `scheduleId?`. `PostTrackingRow` đã có `campaignId`, `variant` từ Task 1.

- [ ] **Step 1:** Viết test:
  - gom campaign (có chiến dịch, không chiến dịch, chiến dịch đã xoá);
  - gom variant trong hai lịch khác nhau (A của lịch 1 ≠ A của lịch 2);
  - lọc `campaignId` (cả `''`) và `scheduleId` cho mọi `groupBy`;
  - `insufficient` ở 4 và 5 bài đã đo;
  - `listTracking` lọc mới.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy → PASS.
- [ ] **Step 3:** Commit `feat(poster): report by campaign and variant with insufficient-data flag`.

### Task 6: Nối Electron, IPC và tài liệu hệ thống

**Files:**
- Modify:
  - `electron/ipc/facebookPosterIpc.ts`:
    - `resolveParams` gán `campaignId = s.campaignId`;
    - scheduler `campaignBlock` qua `store.getCampaign` + `campaignBlockReason`;
    - `posterOperations.scheduleCreate` / `scheduleUpdate` / `scheduleList` nhận `campaignId`;
    - bài nháp (`drafts.ts`: `saveDraft` / `approveDraft`) lưu `campaignId` vào cột;
    - `trackingOperations.list` / `stats` nhận `campaignId`, `scheduleId`, `groupBy` mới;
  - `src/services/facebookPoster/drafts.ts`;
  - `electron/preload.ts`, `src/ui/lib/ipc.ts`;
  - `src/__tests__/http/relayChannelPolicy.test.ts`.
- Docs: `SYSTEM_DOCUMENTATION.md` (bảng, cột, luật chiến dịch với lịch, chia biến thể, IPC).

**Interfaces:**
- **Produces:**
  - `export const campaignOperations = { list(params), get(params), create(params), update(params), delete(params) }`: kiểm tham số tại đây bằng `validateCampaignInput`; trả đúng hình dạng spec §6 (`scheduleCount`, `draftCount`, `runnable`, `summary` từ `statsReport({ groupBy: 'campaign', campaignId: id, from: createdAt, to: now })`);
  - IPC `facebookPoster:campaignList|campaignGet|campaignCreate|campaignUpdate|campaignDelete` (Boss-only, không qua relay), gọi `campaignOperations`.
- **Gắn lịch vào chiến dịch `archived`** → `Chiến dịch đã lưu trữ`; mã lạ → `Không tìm thấy chiến dịch`.
- **Xoá** khi `countCampaignSchedules` > 0 → `Chiến dịch còn N lịch/bài nháp, hãy chuyển hoặc xoá trước`.
- **Đổi chiến dịch / trạng thái** gọi `scheduler.reschedule()` để lịch được tính lại.

- [ ] **Step 1:** Viết test cho `campaignOperations` (dùng store thật trên SQLite trong bộ nhớ như test store có sẵn, hoặc giả `db()` theo mẫu test IPC có sẵn): tạo / sửa / xoá còn lịch / gắn vào `archived` / `summary`. Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy lần lượt: 2 lệnh tsc, `npx jest --runInBand src/__tests__/facebookPoster src/__tests__/http src/__tests__/research`, `check-docs` → sạch.
- [ ] **Step 3:** Commit `feat(poster): wire campaigns, schedule campaign links and report filters`.

### Task 7: Control API

**Files:**
- Modify: `src/services/control/ControlMethods.ts`, `electron/ipc/controlApiIpc.ts`
- Test: `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`
- Docs: `docs/protocol/maihub-control-protocol.md` (5 thao tác mới, trường mới), `SYSTEM_DOCUMENTATION.md` (30 → 35), `tools/maihub-bridge/README.md` nếu có ghi số thao tác

**Interfaces:**
- **Consumes:** `campaignOperations` (Task 6) qua một port mới `CampaignPort`, theo mẫu `TrackingPort`.
- **Produces:**
  - `campaigns.list|get|create|update|delete` theo spec §6 (`campaigns.delete` `destructive: true`);
  - trường mới: `drafts.create/update` (`variants`, `campaignId` → đưa vào `DRAFT_PARAM_KEYS` hoặc xử lý riêng như `name`), `schedules.list` (`campaignId`), `schedules.update` (`campaignId`), `posts.stats` (`groupBy` + `campaignId`, `scheduleId`), `posts.list` (`campaignId`, `scheduleId`), `runs.get` (`campaignId`, `variant`).
- **Lỗi** đi qua `toControlError` có sẵn: không tìm thấy → `NOT_FOUND`, còn lại → `INVALID_PARAMS`.

- [ ] **Step 1:** Viết test:
  - danh sách describe thêm 5 thao tác (sửa đúng danh sách kỳ vọng, ghi trong báo cáo);
  - kiểm tham số từng thao tác;
  - `drafts.create` có `variants` / `campaignId`;
  - bot cũ không gửi trường mới → kết quả như cũ;
  - `posts.stats` `groupBy: 'variant'`.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy: 2 lệnh tsc, jest `src/__tests__/control src/__tests__/facebookPoster src/__tests__/http`, unittest bridge (`cd tools/maihub-bridge && python3 -m unittest discover -s tests`), `check-docs`.
- [ ] **Step 3:** Commit `feat(control): campaign methods and variant/campaign fields`.

### Task 8: Giao diện chiến dịch

**Files:**
- Create: `src/ui/features/facebookPoster/CampaignsTab.tsx`, `src/ui/features/facebookPoster/CampaignDialog.tsx`, `src/ui/features/facebookPoster/campaignFormat.ts` (+ test `src/__tests__/facebookPoster/campaignFormat.test.ts`)
- Modify: `src/ui/features/facebookPoster/FacebookPosterView.tsx` (mục "Chiến dịch" cạnh "Lịch đăng"), `src/ui/components/layout/Sidebar.tsx` (mục con của Đăng Facebook), `src/ui/features/facebookPoster/PerformancePanel.tsx` (prop tuỳ chọn `campaignId`, `scheduleId`; "Gom theo" thêm Chiến dịch / Biến thể; `insufficient` → `chưa đủ dữ liệu`), `src/ui/features/facebookPoster/trackingFormat.ts`

**Interfaces:**
- **Consumes:** IPC Task 6.
- **`campaignFormat.ts`:** `campaignStatusChip(c, now): { label; tone }`, với label `Đang chạy` / `Tạm dừng` / `Lưu trữ` / `Chưa bắt đầu` / `Đã kết thúc`; `formatCampaignRange(startAt, endAt)`; chuyển ngày ↔ `startAt` (00:00) / `endAt` (23:59:59.999).
- **Hành vi** theo spec §7:
  - danh sách thẻ, tạo / sửa (dialog), tạm dừng / tiếp tục, lưu trữ, xoá có xác nhận;
  - công tắc hiện lưu trữ;
  - chi tiết gồm lịch / bài nháp của chiến dịch và `PerformancePanel` lọc theo chiến dịch;
  - lỗi từ IPC hiện bằng thông báo.

- [ ] **Step 1:** Viết test cho `campaignFormat.ts` → FAIL → viết code → PASS.
- [ ] **Step 2:** Viết các component. Chạy tsc `-p tsconfig.json`. Không chạy app (controller kiểm tra trực tiếp).
- [ ] **Step 3:** Commit `feat(poster): campaigns tab with status, schedules and performance`.

### Task 9: Giao diện soạn bài, lịch đăng và lịch sử

**Files:**
- Modify: `src/ui/features/facebookPoster/PostTab.tsx`, `PostPreview.tsx`, `ScheduleDialog.tsx`, `ScheduleTab.tsx`, `HistoryTab.tsx`; `draftForm.ts` nếu cần đọc `variants` / `campaignId` khi mở bài nháp
- Test: thêm test cho hàm thuần nếu tách (ví dụ hàm dựng `params` có `variants` trong `draftForm.ts`)

**Interfaces:**
- **Soạn bài:**
  - ô chọn chiến dịch (chiến dịch chưa lưu trữ, có "Không thuộc chiến dịch");
  - tab A–E: "+ Biến thể" (tối đa 5), xoá tab B–E;
  - xem trước theo tab;
  - gợi ý "Các nhóm sẽ lần lượt nhận A, B, …";
  - `buildParams` thêm `variants` (bỏ tab rỗng → báo lỗi trước khi gửi), `campaignId`.
- **Lịch đăng:** lọc theo chiến dịch; chi tiết lịch hiện tên chiến dịch và các biến thể; `ScheduleDialog` (cả chế độ sửa) có ô chọn chiến dịch.
- **Lịch sử:** chip `Biến thể B` khi `variant` khác rỗng.
- **Mở lại bài nháp** có biến thể / chiến dịch: hiện đúng.

- [ ] **Step 1:** Viết code (và test hàm thuần nếu tách). Chạy tsc `-p tsconfig.json`, jest các test liên quan.
- [ ] **Step 2:** Commit `feat(poster): compose variants and pick campaigns in composer, schedules and history`.

### Task 10 (controller): Kiểm chứng và phát hành 26.22.0

- [ ] **Step 1:** Review toàn nhánh bằng Opus. Một lượt sửa, một re-review.
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, 2 lệnh tsc, unittest bridge, `check-docs`.
  - App dev với dữ liệu tách riêng và dữ liệu giả: Chiến dịch, Soạn bài (biến thể), Lịch đăng, Lịch sử, Hiệu quả ở 1280 và 390 px, sáng và tối.
  - Hồi quy: Đăng Facebook, lịch, bài nháp, theo dõi bài, Nghiên cứu.
  - **Không đăng bài thật.**
- [ ] **Step 3:**
  - Tăng version 26.22.0, thêm changelog, dòng phiên bản trong tài liệu.
  - Spec sang "Đã phát hành", thêm "Ghi chú sau phát hành"; plan thêm "Điều chỉnh khi triển khai".
  - Merge `main`, gắn tag; anh push; kiểm tra CI.
