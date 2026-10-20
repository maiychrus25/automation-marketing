# Kế hoạch: Chấm điểm nhóm và giờ đăng tốt nhất (26.23)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho mỗi nhóm một điểm 0–100 kèm nhãn và lý do; thêm báo cáo theo giờ / thứ và gợi ý giờ đăng. Hiện ở app và mở cho bot qua Control API.

**Architecture:**
- Hai module thuần:
  - `groupScores.ts` (`scoreGroups`);
  - `bestTimes.ts` (`pickBestTimes`).
- Store gom số liệu đầu vào: `statsReport` thêm `hour` / `weekday`; `groupScoreInputs` gom lượt đăng theo nhóm.
- `trackingOperations` thêm `groupScores` / `bestTimes`, dùng chung cho IPC và Control API.
- UI chỉ đọc. Không thêm lần mở Facebook nào.

**Tech Stack:** Electron 41, React 18, TypeScript, better-sqlite3, Jest.

**Spec:** `docs/specs/2026-10-20-group-scores-times-leads.md` §2–§5 (đã duyệt). Phần E (§6) làm ở kế hoạch 26.24 sau.

## Global Constraints

- **Điểm nhóm:**
  - `MIN_SCORE_POSTS = 3`; trọng số `success` 20, `published` 25, `survival` 20, `engagement` 35;
  - nhãn `good` ≥ 70, `fair` 40–69, `poor` < 40, `insufficient` khi `attempted < 3`;
  - nhãn hiển thị Tốt / Trung bình / Kém / Chưa đủ dữ liệu;
  - khoảng mặc định 30 ngày.
- **Không tính vào `attempted`:** `failed` có `error_code` `not_logged_in` / `launch_failed` / `stopped`. Chỉ tính kết quả của lượt `kind = 'post'`, `mode = 'group'`.
- **`engagement`:**
  - So với **trung vị** của các nhóm đủ điều kiện có `measured ≥ 1`: `min(value / median / 2, 1)`.
  - Đơn vị đo: `engagementRate` nếu mọi nhóm được so đều có, ngược lại `avgEngagement` cho cả lượt.
  - Chưa đo hoặc `median = 0` → `0.5`.
- **Lý do** (đúng câu chữ spec §2.3):
  - `"<held>/<posted> bài phải chờ duyệt hoặc không tìm thấy"` (`published < 0.7`);
  - `"<removed> bài nghi bị xoá"`;
  - `"<failed>/<attempted> lần đăng lỗi"` (`success < 0.8`);
  - `"Tương tác thấp hơn mức giữa của các nhóm"` (`< 0.35`, đã đo);
  - `"Tương tác cao (gấp ~<x> lần mức giữa)"` (`≥ 0.9`);
  - `"Chưa có số đo tương tác"`;
  - `"Mới có <attempted> lượt đăng (cần ≥ 3)"`.
- **Giờ / thứ:**
  - giờ máy;
  - key giờ `'00'`…`'23'`, nhãn `"09h"`;
  - key thứ `'1'`…`'7'` (Thứ 2 … Chủ nhật), nhãn `"Thứ 2"` … `"Chủ nhật"`;
  - sắp theo key.
- **`bestTimes`:** mặc định 60 ngày; ngưỡng `measured ≥ MIN_MEASURED_FOR_COMPARISON` (5); tối đa 3 giờ và 2 thứ; xếp theo `avgEngagement` giảm dần; `insufficient` khi không có giờ nào đủ.
- **Control API:** chỉ thêm, 35 → 37 thao tác (`posts.groupScores`, `posts.bestTimes`); `posts.stats.groupBy` thêm `hour`, `weekday`; lỗi tham số → `INVALID_PARAMS`.
- **Định danh** tiếng Anh; chữ hiển thị, log và docs tiếng Việt.
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

1. **Nhóm bị chấm thấp oan vì profile hết phiên** (lỗi `not_logged_in` / `launch_failed` / `stopped`): những lỗi này không được tính. → Task 1, 2.
2. **Một nhóm có link dạng tên và dạng số:** kết quả và dòng theo dõi phải ghép đúng `group_url`; không được nhân đôi hay mất số. → Task 2.
3. **Ít dữ liệu:** dưới 3 lượt đăng → không có điểm; không có giờ nào đủ 5 bài đã đo → không gợi ý. Không được hiện điểm hay giờ "giả chắc chắn". → Task 1, 5.
4. **Giờ gần nửa đêm và Chủ nhật** (`getDay() = 0` → key `'7'`): xếp đúng khung. → Task 2.
5. **Bảng Hiệu quả theo chiến dịch / khoảng ngày:** dòng gợi ý giờ và cột điểm phải dùng đúng bộ lọc của bảng. → Task 5.

---

### Task 1: Module thuần điểm nhóm và giờ đăng

**Files:**
- Create: `src/services/facebookPoster/groupScores.ts`, `src/services/facebookPoster/bestTimes.ts`
- Test: `src/__tests__/facebookPoster/groupScores.test.ts`, `src/__tests__/facebookPoster/bestTimes.test.ts`

**Interfaces:**
- **Produces (`groupScores.ts`):**
  - `MIN_SCORE_POSTS = 3`;
  - `GroupScoreInput { groupUrl; label; attempted; posted; failed; held; removed; withLink; measured; engagementRate: number | null; avgEngagement: number | null }`;
  - `GroupGrade = 'good' | 'fair' | 'poor' | 'insufficient'`;
  - `GroupScore = GroupScoreInput & { score: number | null; grade: GroupGrade; engagement: number | null; reasons: string[] }`, với `engagement` là thành phần 0–1, `null` khi `insufficient`;
  - `scoreGroups(rows: GroupScoreInput[]): GroupScore[]`: sắp `score` giảm dần, `insufficient` xếp cuối (theo `attempted` giảm dần).
- **Produces (`bestTimes.ts`):**
  - `BestTimeSlot { key: string; label: string; avgEngagement: number; measured: number }`;
  - `pickBestTimes(hourRows: PostStatsReportRow[], weekdayRows: PostStatsReportRow[]): { hours: BestTimeSlot[]; weekdays: BestTimeSlot[]; insufficient: boolean }`.

- [ ] **Step 1:** Viết test:
  - từng thành phần và tổng điểm với số tính tay;
  - biên: `posted = 0`, `withLink = 0`, không nhóm nào đo, `median = 0`, một nhóm có `engagementRate = null` → cả lượt dùng `avgEngagement`;
  - ngưỡng 69/70 và 39/40;
  - lý do đúng câu chữ và thứ tự;
  - `attempted = 2` → `insufficient` kèm lý do;
  - `pickBestTimes`: lọc `measured < 5`, tối đa 3 / 2, thứ tự, `insufficient`.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy → PASS.
- [ ] **Step 3:** Commit `feat(poster): group score and best posting time rules`.

### Task 2: Store — giờ / thứ và số liệu chấm điểm

**Files:**
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts` (`statsReport` thêm `hour` / `weekday`; method mới `groupScoreInputs`), `src/models/facebookPoster.ts` (`PostStatsGroupBy`)
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`

**Interfaces:**
- **`PostStatsGroupBy`** thêm `'hour' | 'weekday'`. Trong `statsReport`:
  - key / nhãn theo Global Constraints (`new Date(posted_at).getHours()` / `getDay()` với Chủ nhật → `'7'`);
  - sắp theo key tăng dần; các bộ lọc có sẵn áp dụng;
  - `insufficient` tính như các kiểu gom khác.
- **`groupScoreInputs(opts: { from: number; to: number; campaignId?: string }): GroupScoreInput[]`:**
  - `attempted` / `posted` / `failed` lấy từ `fb_poster_results` JOIN `fb_poster_runs` (`kind = 'post'`, `mode = 'group'`, `started_at` trong khoảng, lọc `campaign_id` của run khi có), gom theo `target_url`, bỏ lỗi do profile;
  - `held` / `removed` / `withLink` / `measured` / `engagementRate` / `avgEngagement` / `label` lấy từ `statsReport({ groupBy: 'group', from, to, campaignId, limit: 100000 })` (key = `group_url`);
  - ghép theo `group_url` = `target_url`. Nhóm chỉ có ở một phía vẫn có dòng, phía thiếu tính 0. Nhóm chỉ có ở phía theo dõi thì `attempted` = số bài của nó.

- [ ] **Step 1:** Viết test:
  - `groupBy hour` (23:59 và 00:00 vào hai khung khác nhau);
  - `groupBy weekday` (Chủ nhật = `'7'`, Thứ 2 = `'1'`), sắp theo key;
  - `groupScoreInputs`: bỏ lỗi `not_logged_in` / `launch_failed` / `stopped`, chỉ tính lượt `mode` `group`, lọc chiến dịch, ghép hai phía, nhóm chỉ có lỗi.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` → PASS.
- [ ] **Step 3:** Commit `feat(poster): hour and weekday reports and group score inputs`.

### Task 3: Nối IPC và tài liệu hệ thống

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts` (`trackingOperations.groupScores`, `trackingOperations.bestTimes`, `STATS_GROUP_BY` thêm `hour`, `weekday`; kênh `facebookPoster:groupScores`, `facebookPoster:bestTimes`), `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/__tests__/http/relayChannelPolicy.test.ts`
- Test: `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` (thêm)
- Docs: `SYSTEM_DOCUMENTATION.md` (điểm nhóm, giờ / thứ, gợi ý, IPC)

**Interfaces:**
- **Consumes:** Task 1, Task 2.
- **`trackingOperations.groupScores(params)`:**
  - `from?` / `to?` (mặc định 30 ngày; kiểm như `parseTimeRange` có sẵn), `campaignId?` (chuỗi, kể cả `''`);
  - trả `{ groups: scoreGroups(store.groupScoreInputs(...)) }`.
- **`trackingOperations.bestTimes(params)`:**
  - `from?` / `to?` (mặc định **60 ngày**), `groupUrl?` (chuỗi không rỗng), `campaignId?`;
  - gọi `statsReport` `hour` và `weekday` (thêm lọc `groupUrl` nếu cần: thêm tham số `groupUrl?` vào `statsReport` theo đúng cách lọc trong SQL như `scheduleId`);
  - trả `pickBestTimes(...)`.
- **Kênh IPC** chỉ dành cho Boss, không qua relay.

- [ ] **Step 1:** Viết test wiring (dùng store bộ nhớ như test có sẵn): `groupScores` / `bestTimes` trả đúng hình dạng; kiểm tham số sai; `stats` nhận `hour` / `weekday`. Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy lần lượt: 2 lệnh tsc, `npx jest --runInBand src/__tests__/facebookPoster src/__tests__/http`, `check-docs`.
- [ ] **Step 3:** Commit `feat(poster): group scores and best times over IPC`.

### Task 4: Control API

**Files:**
- Modify: `src/services/control/ControlMethods.ts` (`TrackingPort` thêm `groupScores`, `bestTimes`), `electron/ipc/controlApiIpc.ts`
- Test: `src/__tests__/control/ControlMethods.test.ts`, `src/__tests__/control/controlWiring.test.ts`
- Docs: `docs/protocol/maihub-control-protocol.md` (2 thao tác, `groupBy` mới), `SYSTEM_DOCUMENTATION.md` (35 → 37)

**Interfaces:**
- `posts.groupScores` (`from?`, `to?`, `campaignId?`) và `posts.bestTimes` (`from?`, `to?`, `groupUrl?`, `campaignId?`), `destructive: false`. Kết quả theo spec §4.
- `posts.stats.groupBy` enum thêm `hour`, `weekday`.

- [ ] **Step 1:** Viết test:
  - danh sách describe thêm 2 thao tác (đổi đúng danh sách kỳ vọng, ghi trong báo cáo);
  - kiểm tham số;
  - `posts.stats` `groupBy: 'hour'`;
  - yêu cầu cũ không đổi.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy: 2 lệnh tsc, jest `src/__tests__/control src/__tests__/facebookPoster src/__tests__/http`, unittest bridge (`cd tools/maihub-bridge && python3 -m unittest discover -s tests`), `check-docs`.
- [ ] **Step 3:** Commit `feat(control): group scores and best posting times for bots`.

### Task 5: Giao diện

**Files:**
- Modify:
  - `src/ui/features/facebookPoster/PerformancePanel.tsx`: "Gom theo" thêm Giờ / Thứ; cột **Điểm** khi gom theo Nhóm; dòng gợi ý giờ dưới bảng;
  - `src/ui/features/facebookPoster/trackingFormat.ts`: `GROUP_BY_OPTIONS`, `gradeChip(grade)` → `{ label, tone }`, `formatBestTimes(result)` → chuỗi;
  - `src/ui/features/facebookPoster/PostTab.tsx`: chip điểm cạnh tên nhóm trong danh sách nhóm của profile;
  - `src/ui/features/facebookPoster/ScheduleDialog.tsx`: dòng "Giờ hiệu quả: …".
- Test: `src/__tests__/facebookPoster/trackingFormat.test.ts`

**Interfaces:**
- **Consumes:** IPC Task 3 (`ipc.facebookPoster.groupScores`, `ipc.facebookPoster.bestTimes`).
- **Cột Điểm:**
  - gọi `groupScores` với cùng khoảng ngày và `campaignId` của bảng, ghép theo key `group_url`;
  - chip có `aria-label` "Điểm 82, Tốt"; `title` / popover là các lý do;
  - dòng `insufficient` hiện "chưa đủ dữ liệu".
- **Dòng gợi ý:**
  - gọi `bestTimes` với cùng `campaignId` (khoảng mặc định 60 ngày);
  - hiện "Giờ nên đăng: 9h, 20h, 21h · Thứ nên đăng: Thứ 7, Chủ nhật (theo giờ máy)" hoặc "Chưa đủ dữ liệu để gợi ý giờ đăng".
- **Soạn bài:** tải `groupScores` một lần khi mở; chip nhỏ chỉ cho nhóm có điểm; không làm chậm việc chọn nhóm (lỗi tải thì im lặng bỏ qua chip).
- **Hộp hẹn giờ:** tải `bestTimes` một lần, chỉ hiện khi có giờ.
- Mọi lần tải bất đồng bộ phải tránh ghi trạng thái sau khi unmount hoặc ghi đè bằng phản hồi cũ.

- [ ] **Step 1:** Viết test `gradeChip` / `formatBestTimes` → FAIL → viết → PASS.
- [ ] **Step 2:** Viết component. Chạy tsc `-p tsconfig.json`, electron tsc, jest test liên quan. Không chạy app (controller kiểm tra trực tiếp).
- [ ] **Step 3:** Commit `feat(poster): group score chips and best posting time hints`.

### Task 6 (controller): Kiểm chứng và phát hành 26.23.0

- [ ] **Step 1:** Review toàn nhánh bằng Opus. Một lượt sửa, một re-review. Không chạy app cùng lúc với review (máy ít RAM).
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, 2 lệnh tsc, unittest bridge, `check-docs`.
  - App dev với dữ liệu giả: Hiệu quả (Điểm, Giờ / Thứ, gợi ý), Soạn bài (chip), Hẹn giờ ở 1280 và 390 px, sáng và tối.
  - Hồi quy: Đăng Facebook, lịch, theo dõi bài, chiến dịch / biến thể, Nghiên cứu.
- [ ] **Step 3:**
  - Version 26.23.0, changelog, dòng phiên bản trong tài liệu.
  - Spec: dòng Trạng thái ghi "Đã phát hành 26.23.0 (D + F)"; phần E vẫn chờ.
  - Plan thêm "Điều chỉnh khi triển khai".
  - Merge `main`, gắn tag; anh push; kiểm tra CI.
