# Đề xuất bài hằng ngày — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot trên VPS tự học các Page của khách, mỗi ngày tự tìm bài hot trên Facebook và tạo nháp cho từng Page. Khách duyệt bằng tin nhắn Telegram.

**Architecture:** MaiHub thêm hai bảng SQLite (`fb_page_identities`, `daily_briefs`), một việc nền chỉ đọc (`PageLearner`, giữ khe việc chung như `LoginChecker`), thao tác `research.trending` và các thao tác `pages.*` / `briefs.*` trên Control API. Bridge Python thêm `brief-tick` (timer systemd 15 phút chạy Claude CLI khi có việc), `install-brief`, và tin Telegram cho từng nháp.

**Tech Stack:** Electron main (TypeScript, CommonJS), better-sqlite3, jest + ts-jest, playwright-core; bridge Python 3.6+ chỉ dùng thư viện chuẩn, unittest.

**Spec:** `docs/specs/2026-10-26-daily-post-suggestions.md` (đọc kèm intent `docs/intent/2026-10-26-facebook-growth-bot.md`).

## Global Constraints

- **Control API chỉ thêm:**
  - không đổi hay bỏ thao tác, trường, sự kiện cũ;
  - không thêm mã lỗi: chỉ dùng `INVALID_PARAMS`, `NOT_FOUND`, `BUSY`, `LIMIT_REACHED`, `CONFIRMATION_REQUIRED`, `UNKNOWN_METHOD`.
- **Định danh trong code bằng tiếng Anh**; chữ hiện cho người dùng bằng tiếng Việt.
- **Bridge:** Python 3.6+, chỉ thư viện chuẩn.
- **Hằng số** (đúng tên, đúng giá trị):

  | Hằng số | Giá trị |
  |---|---|
  | `BRIEF_MAX_ATTEMPTS_PER_DAY` | `3` |
  | `BRIEF_STALE_MS` | `3600000` |
  | `BRIEF_MAX_ROWS` | `10` |
  | `TRENDING_MAX_AGE_MS` | `604800000` |
  | `LEARN_FRESH_MS` | `86400000` |
  | `LEARN_PAUSE_MIN_MS` / `LEARN_PAUSE_MAX_MS` | `20000` / `60000` |

- **Giới hạn trường brief:**

  | Trường | Giới hạn | Mặc định |
  |---|---|---|
  | `niche` | ≤300 ký tự | |
  | `keywords` | 1–10 chuỗi, mỗi chuỗi ≤80 ký tự | |
  | `groupIds` | 0–20 mã | |
  | `tone` | ≤500 ký tự | |
  | `notes` | ≤1000 ký tự | |
  | `time` | `HH:MM` | `07:00` |
  | `draftsPerDay` | 1–5 | 1 |

- **Danh tính Page:** `about` ≤1000 ký tự; `recentPosts` ≤10 bài, mỗi bài ≤500 ký tự.
- **Ngày và giờ theo giờ máy MaiHub** (`Date` cục bộ). Mọi mốc thời gian là ms epoch.
- **Chế độ nhân viên:** các thao tác mới bị chặn giống thao tác Control hiện có.
- **Test không gọi Facebook thật, không gọi Claude thật.** Chỉ Task 0 chạm Facebook thật, và chỉ khi anh cho phép.
- **Tài liệu đi cùng code trong cùng commit:** `SYSTEM_DOCUMENTATION.md` mục 4.15 (thêm dần theo task) và `docs/protocol/maihub-control-protocol.md`.
- **Mỗi commit phải sạch** với bốn lệnh (CI dùng Node 24):
  - `npx tsc -p tsconfig.electron.json --noEmit`
  - `NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit`
  - `node scripts/check-docs.js`
  - `npx jest --runInBand`
- **Lệch so với spec (ghi lại ở đây và sửa spec trong cùng commit của Task 1):** thêm cột `claimed_date` vào `daily_briefs`. Lý do: một lượt nhận lúc 23:50 và xong sau nửa đêm phải được tính cho ngày đã nhận, không phải ngày xong.

## Review Focus

Năm trường hợp spec không nói rõ nhưng dễ gây lỗi khi dùng thật nhất. Test của mỗi trường hợp nằm trong task sở hữu code đó:

1. **Lượt chạy qua nửa đêm:** `briefs.finish` lúc 00:10 cho lượt nhận lúc 23:50 phải ghi `last_run_date` là ngày hôm trước, và hôm sau vẫn đến lượt. → Task 1.
2. **Profile bị xoá, hoặc thôi là Page, sau khi đã có brief:** `claimDue` phải bỏ qua brief đó, không trả cho bot. → Task 1.
3. **Đổi workspace giữa lượt:** `briefs.finish` trả `INVALID_PARAMS` (không ở `running` trong DB mới). `brief-tick` phải ghi cảnh báo và đi tiếp, không văng lỗi. Brief ở DB cũ tự hồi sau 60 phút. → Task 6.
4. **Agent treo quá giờ** (Claude CLI sinh tiến trình con): phải giết **cả nhóm tiến trình**, không chỉ tiến trình cha. Dùng `start_new_session=True` + `os.killpg`. → Task 6.
5. **Từ khoá có lượt quét nhưng chưa lượt nào `done`**, hoặc chưa quét bao giờ: `research.trending` trả `items: []`, không lỗi. → Task 2.

---

### Task 0: Bước thử chỉ đọc — nhận ra danh tính Page (CẦN ANH CHO PHÉP TRƯỚC)

**Files:**
- Create: `docs/reports/2026-10-26-page-learn-spike.md`
- Create: `src/__tests__/dailyBrief/fixtures/` gồm `page-identity.html`, `person-identity.html`, `page-posts.json` (đã xoá tên người, mã người dùng, cookie)

**Interfaces:**
- Produces: các fixture và kết luận mà Task 4 dùng. Báo cáo phải trả lời:
  - (a) Dấu hiệu chắc chắn để biết `facebook.com/me` đang là Page hay người: URL sau chuyển hướng, thẻ meta, hay mục trong DOM.
  - (b) Selector hoặc trường cho tên Page, mã Page, hạng mục, giới thiệu.
  - (c) Cách đọc ≤10 bài gần nhất: `friendly_name` của truy vấn GraphQL và đường dẫn tới chữ / tương tác / thời gian; hoặc nói rõ là dùng DOM.

- [ ] **Step 1: Xin anh cho phép.** Ghi rõ: 1–2 profile nào, chỉ mở `facebook.com/me` và trang giới thiệu, không bấm, không gõ. Chưa có lời đồng ý thì dừng ở đây.
- [ ] **Step 2: Chạy thử.** Viết một script thử trong scratchpad (không đưa vào repo), mở profile bằng `getBrowserProfileService().openForAutomation`, rồi lưu HTML / JSON phản hồi.
- [ ] **Step 3: Làm sạch dữ liệu** thành fixture, rồi viết báo cáo với ba câu trả lời (a), (b), (c).
- [ ] **Step 4: Commit**

```bash
git add docs/reports/2026-10-26-page-learn-spike.md src/__tests__/dailyBrief/fixtures
git commit -m "docs(daily-brief): page identity read-only spike"
```

### Task 1: Kiểu dữ liệu + `DailyBriefStore` (hai bảng, nhận việc, kết thúc)

**Files:**
- Create: `src/models/dailyBrief.ts`
- Create: `src/services/dailyBrief/DailyBriefStore.ts`
- Test: `src/__tests__/dailyBrief/DailyBriefStore.test.ts`, dùng `memoryDb` từ `src/__tests__/facebookPoster/helpers.ts`
- Modify: `docs/specs/2026-10-26-daily-post-suggestions.md` mục 2.1 (thêm cột `claimed_date`) và 2.2 (`finish` dùng `claimed_date`)

**Interfaces:**
- Produces, trong `src/models/dailyBrief.ts`:

```ts
export type PageIdentityKind = 'page' | 'person' | 'unknown';
export interface PagePostSample { text: string; reactions: number | null; comments: number | null; shares: number | null; postedAt: number | null; url: string }
export interface PageIdentity { profileId: string; kind: PageIdentityKind; pageId: string; pageName: string; category: string; about: string; recentPosts: PagePostSample[]; learnedAt: number; errorCode: string; error: string }
export interface DailyBrief {
  profileId: string; niche: string; keywords: string[]; groupIds: string[]; tone: string; notes: string;
  time: string; draftsPerDay: number; enabled: boolean;
  lastRunDate: string | null; status: 'idle' | 'running'; attemptDate: string | null; attempts: number;
  claimedAt: number | null; claimedDate: string | null; updatedAt: number;
}
export type DailyBriefPatch = Partial<Pick<DailyBrief, 'niche' | 'keywords' | 'groupIds' | 'tone' | 'notes' | 'time' | 'draftsPerDay' | 'enabled'>>;
```

- Produces, trong `DailyBriefStore.ts`:
  - các hằng số `BRIEF_MAX_ATTEMPTS_PER_DAY`, `BRIEF_STALE_MS`, `BRIEF_MAX_ROWS`;
  - `export interface LocalClock { date(ms: number): string /* YYYY-MM-DD */; minutes(ms: number): number /* 0–1439 */ }` và `export const systemClock: LocalClock`;
  - `export class DailyBriefStore`, constructor `(db: SqlDatabase, clock: LocalClock = systemClock)`, với các method:

    | Method | Ghi chú |
    |---|---|
    | `ensureSchema(): void` | chạy lại nhiều lần được |
    | `upsertIdentity(i: PageIdentity): void` | |
    | `getIdentity(profileId: string): PageIdentity \| undefined` | |
    | `listIdentities(): PageIdentity[]` | |
    | `getBrief(profileId: string): DailyBrief \| undefined` | |
    | `listBriefs(): DailyBrief[]` | |
    | `countBriefs(): number` | |
    | `saveBrief(profileId: string, patch: DailyBriefPatch, now: number): DailyBrief` | chỉ ghi, kiểm tham số nằm ở Task 3 |
    | `deleteBrief(profileId: string): boolean` | |
    | `claimDue(now: number, isEligible: (profileId: string) => boolean): DailyBrief[]` | |
    | `finishBrief(profileId: string, ok: boolean, now: number): DailyBrief` | không ở `running` thì ném `new Error(BRIEF_NOT_RUNNING_ERROR)` |

  - `export const BRIEF_NOT_RUNNING_ERROR = 'Kế hoạch Page không ở trạng thái đang chạy'`.
- Consumes: kiểu `SqlDatabase` từ `src/services/facebookPoster/FacebookPosterStore.ts`.

- [ ] **Step 1: Viết test (đỏ).** Dùng một `LocalClock` giả lấy ngày và phút từ UTC để test không phụ thuộc múi giờ:
  - `ensureSchema` chạy hai lần không lỗi; cả hai bảng tồn tại.
  - `upsertIdentity` rồi `getIdentity` giữ nguyên `recentPosts` (JSON), ghi lại cùng `profileId` thì thay dòng cũ.
  - `saveBrief` lần đầu gán mặc định `time: '07:00'`, `draftsPerDay: 1`, `enabled: true`, `status: 'idle'`, `attempts: 0`. Lần sau chỉ đổi các trường có trong `patch`.
  - **claimDue cơ bản:** brief `time:'07:00'`. Lúc 06:59 nhận `[]`. Lúc 07:00 nhận 1 brief, gọi lại ngay nhận `[]` (đã `running`).
  - **Lỗi đủ 3 lần thì chờ ngày sau:** 3 lần `claimDue` → `finishBrief(ok:false)` cùng ngày thì lần thứ 4 nhận `[]`. Hôm sau nhận lại, `attempts` tính lại từ 0.
  - **Lượt treo:** brief `running` có `claimedAt` cũ 3600001 ms → `claimDue` nhận lại, `attempts` tăng 1. Cũ 3599999 ms thì không nhận.
  - **Đã xong hôm nay:** `finishBrief(ok:true)` → cùng ngày `claimDue` trả `[]`.
  - **(Review Focus 1)** nhận lúc 23:50 ngày D, `finishBrief(ok:true)` lúc 00:10 ngày D+1 → `lastRunDate === D`; lúc 07:00 ngày D+1 vẫn nhận được.
  - **(Review Focus 2)** `isEligible` trả false cho profile → brief không được nhận và vẫn ở `idle`.
  - `enabled:false` thì không bao giờ được nhận.
  - `finishBrief` khi brief đang `idle` ném `BRIEF_NOT_RUNNING_ERROR`.
- [ ] **Step 2: Chạy test, phải đỏ.** `npx jest src/__tests__/dailyBrief/DailyBriefStore.test.ts` → FAIL (chưa có module).
- [ ] **Step 3: Viết `DailyBriefStore`.** Cột theo spec mục 2.1, thêm `claimed_date TEXT`. `claimDue` chạy trong một giao dịch (`db.transaction` như `FacebookPosterStore`). Với mỗi dòng `enabled = 1`, theo thứ tự `profile_id`:

```
today = clock.date(now)
attempts = (attempt_date == today) ? attempts : 0
nếu status == 'running':
    nếu now - claimed_at < BRIEF_STALE_MS: bỏ qua
    attempts += 1; attempt_date = clock.date(claimed_at) (bằng today thì giữ attempts, khác thì đặt attempts = 0)
bỏ qua nếu last_run_date == today, hoặc clock.minutes(now) < phút(time), hoặc attempts >= BRIEF_MAX_ATTEMPTS_PER_DAY, hoặc !isEligible(profile_id)
UPDATE status='running', claimed_at=now, claimed_date=today, attempt_date=today, attempts=attempts
```

  `finishBrief` với `ok` thì đặt `last_run_date = claimed_date`; không `ok` thì `attempts + 1` và `attempt_date = claimed_date`. Cả hai trường hợp đều đặt `status = 'idle'`.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh → PASS.
- [ ] **Step 5: Commit.** Sửa spec mục 2.1 / 2.2 cho cột `claimed_date` trong cùng commit.

```bash
git add src/models/dailyBrief.ts src/services/dailyBrief/DailyBriefStore.ts src/__tests__/dailyBrief/DailyBriefStore.test.ts docs/specs/2026-10-26-daily-post-suggestions.md
git commit -m "feat(daily-brief): store for page identities and daily briefs"
```

### Task 2: `research.trending`

**Files:**
- Create: `src/services/research/trending.ts`
- Modify: `src/services/research/ResearchStore.ts` (thêm `trendingRows`), `electron/ipc/researchIpc.ts` (thêm `researchOperations.trending`), `src/services/control/ControlMethods.ts` (`ResearchPort.trending` + method `research.trending`), `electron/ipc/controlApiIpc.ts:128-134` (nối `trending`)
- Test: `src/__tests__/research/trending.test.ts`, `src/__tests__/research/ResearchStore.test.ts` (thêm case), `src/__tests__/control/ControlMethods.test.ts` (thêm case)
- Docs: `SYSTEM_DOCUMENTATION.md` mục 4.15 (mở mục, viết phần "Bài đang hot", thêm marker `<!-- docs-check: src/services/research/trending.ts#TRENDING_MAX_AGE_MS = 604800000 -->`), `docs/protocol/maihub-control-protocol.md` (thao tác `research.trending`)

**Interfaces:**
- Produces, trong `trending.ts`:
  - `export const TRENDING_MAX_AGE_MS = 604800000`;
  - `export interface TrendingRow { fbId: string; url: string; title: string; placeName: string; placeId: string; reactions: number | null; comments: number | null; shares: number | null; postedAt: number | null; capturedAt: number }`;
  - `export interface TrendingItem { fbId: string; url: string; text: string; placeName: string; placeId: string; engagement: number; score: number; basis: 'growth' | 'age'; seen: number; postedAt: number }`;
  - `export function rankTrending(rows: TrendingRow[], now: number, limit: number): TrendingItem[]` (hàm thuần);
  - `export function parseTrendingParams(p: any): { queries: string[]; groupIds: string[]; sinceHours: number; limit: number }`, ném `Error` tiếng Việt khi tham số sai.
- Produces: `ResearchStore.trendingRows(opts: { queries: string[]; groupIds: string[]; since: number }): TrendingRow[]`.
- Produces: `researchOperations.trending(p) → { items: TrendingItem[] }`.

- [ ] **Step 1: Viết test (đỏ).**
  - `rankTrending`:
    - bài thấy 2 lần (e 100→400 cách 3 giờ) → `score 100`, `basis 'growth'`, `seen 2`;
    - bài thấy 1 lần (e 50, đăng trước lúc quét 5 giờ) → `score 10`, `basis 'age'`;
    - hai lần cách nhau dưới 1 giờ tính như 1 lần (dùng lần cuối, `basis 'age'`);
    - `postedAt` null → bị loại;
    - đăng cách `now` hơn 7 ngày → bị loại;
    - NULL tính là 0;
    - sắp `score` giảm dần; `limit` cắt đúng số;
    - `text` cắt 500 ký tự.
  - `parseTrendingParams`:
    - thiếu cả `queries` lẫn `groupIds` → ném lỗi;
    - mặc định `sinceHours 72`, `limit 20`;
    - `sinceHours 169` → ném; `limit 101` → ném;
    - `queries` 11 chuỗi → ném;
    - `queries` được trim, giữ nguyên chữ hoa / thường.
  - `ResearchStore.trendingRows`:
    - lấy item `post` của scan `done` có `source 'posts'` và `query` khớp không phân biệt hoa thường (`'Serum'` khớp scan `'serum '`);
    - lấy item `source 'group_feed'` khi `place_id` nằm trong `groupIds`;
    - bỏ scan `failed` / `running` và scan cũ hơn `since`;
    - **(Review Focus 5)** từ khoá không có scan `done` → `[]`.
  - `ControlMethods`: `research.trending` có trong `describe`, gọi qua tới `deps.research.trending`.
- [ ] **Step 2: Chạy test, phải đỏ.** `npx jest src/__tests__/research src/__tests__/control/ControlMethods.test.ts` → FAIL.
- [ ] **Step 3: Viết code.**
  - `trendingRows`: một câu SQL JOIN `research_items` với `research_scans`, so khớp bằng `lower(trim(query)) IN (...)`.
  - `rankTrending`: gom theo `fbId`, lấy lần đầu và lần cuối theo `capturedAt`, rồi áp đúng công thức spec mục 2.4.
  - Schema tham số của method:
    - `queries`: mảng string, `maxItems 10`, mỗi chuỗi `maxLength 80`;
    - `groupIds`: mảng string, `maxItems 20`;
    - `sinceHours`: int 1–168;
    - `limit`: int 1–100.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh, rồi `node scripts/check-docs.js` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/services/research src/__tests__/research electron/ipc/researchIpc.ts electron/ipc/controlApiIpc.ts src/services/control/ControlMethods.ts src/__tests__/control/ControlMethods.test.ts SYSTEM_DOCUMENTATION.md docs/protocol/maihub-control-protocol.md
git commit -m "feat(research): research.trending ranks fast-growing posts"
```

### Task 3: `briefs.*` trên Control API + sự kiện `briefs.finished`

**Files:**
- Create: `src/services/dailyBrief/briefOperations.ts`
- Create: `electron/ipc/dailyBriefIpc.ts`:
  - store theo workspace, mẫu `store()` của `researchIpc.ts:40-55`: mỗi `dbPath` gọi `ensureSchema` một lần;
  - xuất `briefOperations` (bọc `createBriefOperations`) và `getDailyBriefStore()`.
- Modify: `src/services/control/ControlMethods.ts`:
  - `BriefPort`, `ControlMethodDeps.briefs`, các method `briefs.list/get/save/delete/claimDue/finish`;
  - `NOT_FOUND_MESSAGES` thêm `BRIEF_NOT_FOUND_ERROR`;
  - regex `LIMIT_REACHED` đổi thành `/Tối đa \d+ (lịch|kế hoạch Page)/`.
- Modify: `src/services/control/controlEvents.ts`: thêm `'briefs.finished'` vào `ControlEventType` và `buildBriefFinished`.
- Modify: `electron/ipc/controlApiIpc.ts`: nối `briefs`.
- Test: `src/__tests__/dailyBrief/briefOperations.test.ts`, `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`
- Docs: `SYSTEM_DOCUMENTATION.md` 4.15 (phần "Kế hoạch Page" và marker cho `BRIEF_MAX_ATTEMPTS_PER_DAY`, `BRIEF_STALE_MS`, `BRIEF_MAX_ROWS` trỏ tới `src/services/dailyBrief/DailyBriefStore.ts`); protocol (`briefs.*`, sự kiện `briefs.finished`).

**Interfaces:**
- Consumes: `DailyBriefStore` (Task 1).
- Produces, trong `briefOperations.ts`:
  - `export const BRIEF_NOT_FOUND_ERROR = 'Không tìm thấy kế hoạch Page'`;
  - `export interface BriefOperationsDeps { store: () => DailyBriefStore; now: () => number; profileExists: (id: string) => boolean; emitFinished: (payload: { profileId: string; pageName: string; ok: boolean; draftIds: string[]; error?: string }) => void }`;
  - `export function createBriefOperations(deps)` trả `{ list(), get(p), save(p), delete(p), claimDue(), finish(p) }`.
  - Kiểu trả về: mỗi brief là `DailyBrief & { pageName: string }`.
    - `list` → `{ briefs }`;
    - `get` → `{ brief }`;
    - `save` → `{ brief }`;
    - `delete` → `{ deleted: true }`;
    - `claimDue` → `{ briefs }`;
    - `finish` → `{ brief }`.
- Produces: `buildBriefFinished(e)`, chỉ giữ `profileId, pageName, ok, draftIds, error?`.

- [ ] **Step 1: Viết test (đỏ).**
  - `save`:
    - tạo mới thiếu `keywords` → lỗi;
    - `profileId` không có danh tính `kind 'page'` → `'… không phải Page …'` (thành `INVALID_PARAMS`);
    - dòng thứ 11 → thông báo `Tối đa 10 kế hoạch Page` (thành `LIMIT_REACHED`);
    - mỗi giới hạn ở Global Constraints vượt 1 đơn vị → ném lỗi;
    - `time` `'7:00'` / `'24:00'` → ném;
    - gửi `status` / `attempts` → bị bỏ qua, không ghi.
  - `get` / `delete` với mã lạ → `BRIEF_NOT_FOUND_ERROR`.
  - `claimDue`: `isEligible` = profile còn tồn tại **và** `getIdentity(id)?.kind === 'page'`.
  - `finish`:
    - `ok:true, draftIds:['d1']` → gọi `emitFinished` đúng payload;
    - `draftIds` không phải mảng chuỗi → ném lỗi;
    - `error` dài hơn 500 ký tự thì cắt còn 500.
  - `ControlMethods`:
    - `briefs.delete` là `destructive`, thiếu `confirm` → `CONFIRMATION_REQUIRED`;
    - `toControlError` đổi `BRIEF_NOT_FOUND_ERROR` → `NOT_FOUND`, `Tối đa 10 kế hoạch Page` → `LIMIT_REACHED`;
    - `describe` liệt kê đủ 6 thao tác.
  - `controlWiring`: `deps.briefs` được nối tới đúng `briefOperations`.
- [ ] **Step 2: Chạy test, phải đỏ.** `npx jest src/__tests__/dailyBrief src/__tests__/control` → FAIL.
- [ ] **Step 3: Viết code.** Kiểm tham số trong `briefOperations.ts` theo mẫu `campaignOperations.ts`, ném `new Error(<tiếng Việt>)`. `pageName` lấy từ `getIdentity`. `emitFinished` trong `dailyBriefIpc.ts` gọi `emitControlEvent('briefs.finished', buildBriefFinished(e))`.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh + `node scripts/check-docs.js` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/services/dailyBrief src/__tests__/dailyBrief electron/ipc/dailyBriefIpc.ts electron/ipc/controlApiIpc.ts src/services/control src/__tests__/control SYSTEM_DOCUMENTATION.md docs/protocol/maihub-control-protocol.md
git commit -m "feat(daily-brief): briefs.* control methods and briefs.finished event"
```

### Task 4: Bộ đọc danh tính Page (theo kết quả Task 0)

**Files:**
- Create: `src/services/dailyBrief/pageIdentity.ts`
- Test: `src/__tests__/dailyBrief/pageIdentity.test.ts`, dùng fixture của Task 0

**Interfaces:**
- Consumes: kết luận (a), (b), (c) trong `docs/reports/2026-10-26-page-learn-spike.md`.
- Produces:
  - `export interface PageIdentityRead { kind: PageIdentityKind; pageId: string; pageName: string; category: string; about: string; recentPosts: PagePostSample[] }`;
  - `export async function readPageIdentity(page: Page, opts?: { gotoTimeoutMs?: number }): Promise<PageIdentityRead>`:
    - `page` là kiểu `Page` của playwright-core;
    - `loginProblemAt(page.url())` khác null thì ném `new PageLoginProblem(state)`;
  - `export class PageLoginProblem extends Error { constructor(public readonly state: 'checkpoint' | 'logged_out') }`;
  - các hàm thuần để test bằng fixture: `export function parseIdentityHtml(html: string, finalUrl: string)` và `export function parsePagePosts(json: unknown): PagePostSample[]`.

- [ ] **Step 1: Viết test (đỏ).**
  - fixture Page → `kind 'page'`, tên / mã / hạng mục khớp báo cáo;
  - fixture người → `kind 'person'`, các trường Page rỗng;
  - HTML lạ → `kind 'unknown'`;
  - `parsePagePosts` trả tối đa 10 bài, mỗi bài cắt 500 ký tự;
  - `about` cắt 1000 ký tự;
  - URL `/checkpoint/…` → `readPageIdentity` ném `PageLoginProblem('checkpoint')`. Dùng `page` giả có `goto` và `url()`.
- [ ] **Step 2: Chạy test, phải đỏ.** `npx jest src/__tests__/dailyBrief/pageIdentity.test.ts` → FAIL.
- [ ] **Step 3: Viết code** theo đúng dấu hiệu và selector trong báo cáo. Nếu báo cáo chọn GraphQL thì dùng `GraphqlSession` như `groupFeed.ts`. Không bấm, không gõ, không cuộn quá mức báo cáo cho phép.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh → PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/services/dailyBrief/pageIdentity.ts src/__tests__/dailyBrief/pageIdentity.test.ts
git commit -m "feat(daily-brief): read page identity from facebook.com/me"
```

### Task 5: `PageLearner` + `pages.learn` / `pages.list` + sự kiện `pages.learnFinished`

**Files:**
- Create: `src/services/dailyBrief/PageLearner.ts`
- Modify: `electron/ipc/facebookPosterIpc.ts`:
  - thêm `getPageLearner()` theo mẫu `getChecker()` (`:160-190`);
  - `isFacebookPosterBusy()` (`:360`) tính thêm `learner?.isRunning()`;
  - `cancelFacebookPosterJobs()` (`:365`) gọi `learner?.stop()`;
  - hàm cancel-and-wait ngay sau đó cũng chờ learner;
  - xuất `learnPages(profileIds: string[] | null, force: boolean): { jobId: string; profileIds: string[] }`.
- Modify: `electron/ipc/dailyBriefIpc.ts`: `pageOperations = { learn(p), list() }`.
- Modify: `src/services/control/ControlMethods.ts`: `PagePort`, `deps.pages`, method `pages.learn`, `pages.list`.
- Modify: `src/services/control/controlEvents.ts`: `'pages.learnFinished'`, `buildPagesLearnFinished`.
- Modify: `electron/ipc/controlApiIpc.ts`.
- Test: `src/__tests__/dailyBrief/PageLearner.test.ts`, `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts`, `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`
- Docs: `SYSTEM_DOCUMENTATION.md` 4.15 (phần "Học Page", marker `LEARN_FRESH_MS`); protocol (`pages.*`, `pages.learnFinished`).

**Interfaces:**
- Consumes:
  - `readPageIdentity`, `PageLoginProblem` (Task 4);
  - `DailyBriefStore.upsertIdentity` / `getIdentity` (Task 1);
  - `PROFILE_OPEN_PREFIX` từ `src/services/facebookPoster/loginCheck.ts`;
  - `makeYieldingBusy` từ `facebookPosterIpc.ts:451`.
- Produces, trong `PageLearner.ts`:
  - các hằng số `LEARN_FRESH_MS`, `LEARN_PAUSE_MIN_MS`, `LEARN_PAUSE_MAX_MS`;
  - `export interface LearnResult { profileId: string; kind: PageIdentityKind | 'skipped'; pageName: string; error?: string }`;
  - `export interface PageLearnerDeps`:

    | Thành phần | Kiểu |
    |---|---|
    | `store` | `() => DailyBriefStore` |
    | `openForAutomation` | `(id: string) => Promise<AutomationSession>` |
    | `slot` | `{ acquire(): void; release(): void }` |
    | `shouldYield` | `() => boolean` |
    | `isResearchRunning` | `() => boolean` |
    | `observeLogin` | `(id: string, state: 'checkpoint' \| 'logged_out') => void` |
    | `onFinished` | `(e: { jobId: string; results: LearnResult[] }) => void` |
    | `read` | `typeof readPageIdentity` |
    | `now`, `sleep`, `random`, `newId` | |

  - `export class PageLearner` với `learn(profileIds: string[], force: boolean): { jobId; profileIds }`, `isRunning()`, `stop()`, `whenIdle()`.

- [ ] **Step 1: Viết test (đỏ)** với `openForAutomation` / `read` / `sleep` giả:
  - **Ba loại kết quả:** một profile Page, một người, một checkpoint → `upsertIdentity` đúng ba dòng. Dòng checkpoint có `errorCode 'checkpoint'` và giữ nguyên các trường đã học trước đó. `observeLogin('p3','checkpoint')` được gọi.
  - **Bỏ qua profile vừa học:** `learnedAt` trong 24 giờ → `skipped`, không mở profile. Với `force:true` thì mở.
  - **Đang bận:** `isResearchRunning()` true → `learn` ném `BUSY_ERROR` đồng bộ. `slot.acquire` ném → `learn` ném lại lỗi đó.
  - **Nhường lịch đăng:** `shouldYield()` chuyển sang true sau profile đầu → dừng, các profile còn lại là `skipped`, `slot.release` chỉ gọi một lần.
  - **Profile đang mở tay** (lỗi bắt đầu bằng `PROFILE_OPEN_PREFIX`) → `skipped`.
  - **Nghỉ giữa hai profile:** `sleep` nhận giá trị trong `[20000, 60000]`, không nghỉ sau profile cuối.
  - **Huỷ:** `stop()` giữa chừng → không mở profile kế tiếp, vẫn gọi `onFinished`.
  - **Wiring:**
    - `isFacebookPosterBusy()` true khi learner đang chạy;
    - `onFinished` phát `pages.learnFinished` và gọi `scheduler.onRunFinished()`.
  - **ControlMethods:** `pages.learn` với `profileIds` rỗng → `INVALID_PARAMS`; bỏ trống → `null` (mọi profile).
- [ ] **Step 2: Chạy test, phải đỏ.** `npx jest src/__tests__/dailyBrief src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts src/__tests__/control` → FAIL.
- [ ] **Step 3: Viết code.**
  - `PageLearner` theo khung `LoginChecker` (`src/services/facebookPoster/loginCheck.ts:50-125`): `learn` giành khe đồng bộ rồi chạy nền, `finally` nhả khe và gọi `onFinished`.
  - Trong wiring:
    - `shouldYield: makeYieldingBusy(() => false)`;
    - `isResearchRunning` lấy từ `researchIpc` (xuất thêm `isResearchRunning()` gọi `service?.isRunning() ?? false`);
    - `observeLogin` gọi `getChecker().observe(id, state, 'run')`.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh + `node scripts/check-docs.js` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add src/services/dailyBrief/PageLearner.ts src/__tests__/dailyBrief electron/ipc/facebookPosterIpc.ts electron/ipc/researchIpc.ts electron/ipc/dailyBriefIpc.ts electron/ipc/controlApiIpc.ts src/services/control src/__tests__/control src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts SYSTEM_DOCUMENTATION.md docs/protocol/maihub-control-protocol.md
git commit -m "feat(daily-brief): pages.learn reads page identities in the shared job slot"
```

### Task 6: Bridge `brief-tick`

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`:
  - hằng `ONBOARD_PROMPT`, `SUGGEST_PROMPT_TEMPLATE`;
  - hàm `agent_command(env)`, `run_agent(cmd, prompt, timeout, popen)`, `brief_tick(client, env, state_path, run_agent, clock)`, `cmd_brief_tick(args)`;
  - subcommand `brief-tick` trong `build_parser()` (`:1725`).
- Test: `tools/maihub-bridge/tests/test_bridge.py`, thêm `class BriefTickTests(unittest.TestCase)`.

**Interfaces:**
- Consumes: các thao tác `system.status`, `pages.list`, `briefs.claimDue`, `briefs.get`, `briefs.finish` (Task 3, Task 5), qua `MaiHubClient.call`.
- Produces:
  - `agent_command(env) -> list`: đọc `MAIHUB_AGENT_CMD` (tách bằng `shlex.split`), mặc định `["claude", "-p", "--allowedTools", "mcp__maihub"]`.
  - `run_agent(cmd, prompt, timeout_sec, popen=subprocess.Popen) -> (returncode_or_None, timed_out: bool)`:
    - lời nhắc đi qua stdin;
    - `start_new_session=True`;
    - quá giờ thì `os.killpg(pid, SIGTERM)`, sau 10 s mà chưa dừng thì `SIGKILL`.
  - `brief_tick(...) -> dict`: trả `{"onboarded": bool, "ran": [profileId...], "warnings": [str...]}`.
  - Tệp trạng thái lưu `{"lastOnboardAt": ms}`.
  - Khoá: `fcntl.flock(LOCK_EX | LOCK_NB)` trên `<state>.lock`. Không lấy được khoá thì trả `{"skipped": "locked"}`.
  - Hằng `ONBOARD_MIN_INTERVAL_SEC = 21600`, `AGENT_TIMEOUT_DEFAULT_SEC = 2700` (đọc từ `MAIHUB_AGENT_TIMEOUT_SEC`).

- [ ] **Step 1: Viết test (đỏ)** với `FakeMaiHub` / client giả và `run_agent` giả:
  - **MaiHub lỗi kết nối:** `system.status` lỗi → không gọi agent, trả về bình thường.
  - **Làm quen:** `pages.list` rỗng → gọi agent một lần với `ONBOARD_PROMPT`. Gọi lại trong 6 giờ thì không làm quen nữa.
  - **Đề xuất:** `claimDue` trả 2 brief → `run_agent` được gọi 2 lần theo thứ tự, lời nhắc chứa JSON của brief và `profileId`.
  - **Agent thoát mã 1** và `briefs.get` vẫn `running` → gọi `briefs.finish {ok:false, error:"agent thoát mã 1"}`.
  - **Agent quá giờ** → `briefs.finish {ok:false, error:"agent quá giờ"}`.
  - **(Review Focus 3)** `briefs.finish` trả `INVALID_PARAMS` → thêm vào `warnings`, brief sau vẫn chạy.
  - **MaiHub cũ:** `pages.list` trả `UNKNOWN_METHOD` → cảnh báo "MaiHub cần ≥ 26.31.0", không gọi agent.
  - **Chặn chạy chồng:** đang giữ khoá thì tick thứ hai trả `{"skipped": "locked"}`.
  - **(Review Focus 4)** `run_agent` với lệnh thật `["/bin/sh", "-c", "sleep 30 & sleep 30"]`, `timeout_sec=1` → trả `timed_out=True` trong 15 s, và tiến trình con `sleep` cũng chết (kiểm bằng `os.killpg(pgid, 0)` ném `ProcessLookupError`).
  - **Lệnh agent:** `agent_command({})` ra lệnh mặc định; `MAIHUB_AGENT_CMD="codex exec -"` ra `["codex", "exec", "-"]`.
- [ ] **Step 2: Chạy test, phải đỏ.** `cd tools/maihub-bridge && python3 -m unittest tests.test_bridge -k BriefTick` → FAIL.
- [ ] **Step 3: Viết code.** Hai lời nhắc viết tiếng Việt theo đúng các bước của spec mục 3.2. Lời nhắc đề xuất phải có:
  - câu "Không gọi maihub_drafts_approve";
  - câu "Không chép nguyên văn bài nguồn";
  - lệnh kết thúc bằng `maihub_briefs_finish`.
- [ ] **Step 4: Chạy test, phải xanh.** Cùng lệnh, rồi chạy toàn bộ: `cd tools/maihub-bridge && python3 -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add tools/maihub-bridge/maihub_bridge.py tools/maihub-bridge/tests/test_bridge.py
git commit -m "feat(bridge): brief-tick runs the agent for due page briefs"
```

### Task 7: Bridge `install-brief`

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`:
  - `render_brief_units(name, user, bridge, env_file, state_dir) -> (service_text, timer_text)`;
  - `install_brief(...)` theo mẫu `install_watch` (`:1154-1205`);
  - `cmd_install_brief(args, run, geteuid, systemd_dir, getpwnam)`;
  - subcommand `install-brief` (cờ giống `install-watch`, thêm `--agent-cmd`);
  - `brief-tick --dry-run`: gọi `system.status`, kiểm phần tử đầu của `agent_command` có trong `PATH` bằng `shutil.which`, rồi thoát.
- Modify: `tools/maihub-bridge/README.md` (mục cài `install-brief`, `MAIHUB_AGENT_CMD`, `MAIHUB_AGENT_TIMEOUT_SEC`)
- Test: `tools/maihub-bridge/tests/test_bridge.py`, thêm `class InstallBriefTests(InstallFixture)`

**Interfaces:**
- Consumes: `brief-tick` (Task 6); `_write_unit_atomic`, `SERVICE_NAME_RE`, `_require_safe_dir` đã có.
- Produces:
  - `maihub-brief-<name>.service`: `Type=oneshot`, `User=`, ExecStart `python3 -I <bridge> brief-tick --env-file <env> --state <state_dir>/brief-state.json`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=<state_dir>`, `PrivateTmp=yes`, `TimeoutStartSec=3600`;
  - `maihub-brief-<name>.timer`: `OnCalendar=*:0/15`, `Persistent=true`, `Unit=maihub-brief-<name>.service`, `WantedBy=timers.target`.

- [ ] **Step 1: Viết test (đỏ)** với `FakeRun` của `InstallFixture`:
  - hai unit có đúng các dòng nêu trên;
  - đường dẫn có khoảng trắng → `BridgeError('CONFIG')`;
  - dry-run lỗi (FakeRun trả mã 1) → không ghi unit, không `systemctl`;
  - thành công → `systemctl daemon-reload`, `systemctl enable --now maihub-brief-<name>.timer`;
  - `--agent-cmd` được ghi `MAIHUB_AGENT_CMD` vào `.env` qua `write_env_file` (giữ các khoá khác);
  - không chạy bằng root → `BridgeError`.
- [ ] **Step 2: Chạy test, phải đỏ.** `cd tools/maihub-bridge && python3 -m unittest tests.test_bridge -k InstallBrief` → FAIL.
- [ ] **Step 3: Viết code** theo đúng thứ tự của `install_watch`: kiểm tra → dry-run dưới `sudo -u <user>` → ghi unit → reload → enable.
- [ ] **Step 4: Chạy test, phải xanh.** Toàn bộ `python3 -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add tools/maihub-bridge/maihub_bridge.py tools/maihub-bridge/tests/test_bridge.py tools/maihub-bridge/README.md
git commit -m "feat(bridge): install-brief systemd timer"
```

### Task 8: `watch` gửi từng nháp + `GUIDE` mục 8

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py`:
  - `format_brief_messages(event, fetch_draft, fetch_brief) -> list` (hàm mới; **không** đổi chữ ký `format_event`). `fetch_draft(id)` gọi `drafts.get`, `fetch_brief(profileId)` gọi `briefs.get`;
  - `format_event` trả `None` cho `briefs.finished` và `pages.learnFinished`;
  - vòng `Watcher.step` (`:1675`): với `briefs.finished`, gửi lần lượt từng chuỗi của `format_brief_messages`;
  - `GUIDE` thêm mục "8. Đề xuất hằng ngày" (bảng xử lý tin nhắn của khách ở spec mục 3.4 và hai quy tắc đi kèm);
  - dòng phiên bản cuối `GUIDE` thêm "Cần MaiHub từ 26.31.0 cho pages.*, briefs.*, research.trending".
- Test: `tools/maihub-bridge/tests/test_bridge.py`, thêm `class FormatBriefTests(unittest.TestCase)` và một case cho `Watcher`.

**Interfaces:**
- Consumes:
  - payload `briefs.finished` (Task 3);
  - `drafts.get {id}` trả `{draft: {id, name, params: {text, ...}}, media: [{path}]}`. Media là video khi đuôi `.mp4` / `.mov` / `.webm`.
- Produces: `format_brief_messages`:
  - `ok:true` → mỗi `draftId` một chuỗi:

```
📝 <pageName> — bài <i>/<n> · mã #<4 ký tự cuối id>
<text, clip 800>
🎬 kèm video | 🖼 kèm <k> ảnh   (chỉ khi có media)
Nhắn: đăng #xxxx · sửa #xxxx … · bỏ #xxxx
```

  - `fetch_draft` ném lỗi → dòng nội dung là "(không đọc được nội dung, mở MaiHub để xem)".
  - `ok:false` → `[]`, trừ khi `briefs.get` cho thấy `attempts >= 3`. Khi đó gửi `["⚠️ <pageName>: hôm nay chưa tạo được bài đề xuất — <error clip 200>"]`.
  - `fetch_brief` ném lỗi → coi như chưa đủ 3 lần (không báo).

- [ ] **Step 1: Viết test (đỏ).**
  - 2 nháp → 2 chuỗi, có `bài 1/2` / `bài 2/2` và `#` + 4 ký tự cuối id;
  - text 1000 ký tự bị cắt còn 800 (theo `clip`);
  - nháp có `a.mp4` → `🎬 kèm video`; 3 ảnh → `🖼 kèm 3 ảnh`;
  - `fetch_draft` ném lỗi → dòng thay thế;
  - lỗi lần 1 → `[]`; lỗi lần 3 → 1 chuỗi ⚠️;
  - `format_event` với `briefs.finished` → `None`;
  - `Watcher.step` với một sự kiện `briefs.finished` có 2 nháp → `FakeSender` nhận 2 tin, cursor tiến tới `seq` của sự kiện;
  - `GUIDE` chứa `"8. Đề xuất hằng ngày"` và `"maihub_briefs_save"`.
- [ ] **Step 2: Chạy test, phải đỏ.** `cd tools/maihub-bridge && python3 -m unittest tests.test_bridge -k FormatBrief` → FAIL.
- [ ] **Step 3: Viết code.**
- [ ] **Step 4: Chạy test, phải xanh.** Toàn bộ `python3 -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit.**

```bash
git add tools/maihub-bridge/maihub_bridge.py tools/maihub-bridge/tests/test_bridge.py
git commit -m "feat(bridge): watch sends each suggested draft; guide covers daily suggestions"
```

### Task 9: Phát hành 26.31.0 + kiểm tra toàn bộ

**Files:**
- Modify: `package.json` (`version` → `26.31.0`)
- Modify: `SYSTEM_DOCUMENTATION.md`:
  - dòng phiên bản ở mục 0: thêm "26.31.0 thêm đề xuất bài hằng ngày (bot tự học Page, `research.trending`, timer `brief-tick`)";
  - mục 4.15 hoàn chỉnh.
- Modify: `README.md`: thêm một đoạn ngắn "Đề xuất bài hằng ngày" ở mục điều khiển từ bot.
- Modify: `docs/specs/2026-10-26-daily-post-suggestions.md`: dòng Trạng thái → "Đã phát hành 26.31.0 (<ngày>)", kèm "Ghi chú sau cài đặt" nếu code khác spec.

- [ ] **Step 1: Chạy toàn bộ kiểm tra** (mục Global Constraints) và bộ test bridge:

```bash
npx tsc -p tsconfig.electron.json --noEmit
NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit
node scripts/check-docs.js
npx jest --runInBand
python3 -m unittest discover -s tools/maihub-bridge/tests
```

  Kết quả phải là: `tsc` không in lỗi; `check-docs` báo sạch; jest báo toàn bộ suite pass (so số suite với lúc trước Task 1 và ghi lại); unittest báo `OK`.
- [ ] **Step 2: Kiểm thử không hồi quy bằng tay trên MaiHub dev.** Nếu chưa bật được bot thật thì gọi Control API qua `maihub_bridge.py call`:
  - `research.search` → `research.get` cũ vẫn trả như trước;
  - `drafts.create` → `drafts.approve` cũ vẫn chạy;
  - bridge cũ (bản 26.30.0) chạy `describe` / `call system.status` vẫn được với MaiHub mới;
  - `brief-tick --dry-run` với MaiHub 26.30.0 báo "MaiHub cần ≥ 26.31.0".
- [ ] **Step 3: Rà diff.** `git diff <commit trước Task 1>..HEAD --stat` và đọc lại toàn bộ thay đổi. Không có file ngoài danh sách trong các task.
- [ ] **Step 4: Commit.**

```bash
git add package.json SYSTEM_DOCUMENTATION.md README.md docs/specs/2026-10-26-daily-post-suggestions.md
git commit -m "chore(release): 26.31.0 — daily post suggestions"
```

  **Không** gắn tag và **không** push khi chưa có lời đồng ý của anh.
