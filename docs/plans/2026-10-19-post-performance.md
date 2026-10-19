# Đo hiệu quả bài đã đăng và lấy link bài chờ duyệt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi bài đăng nhóm được theo dõi. MaiHub tự quay lại lấy link bài chờ duyệt và đo cảm xúc/bình luận/chia sẻ theo mốc, nhận ra bài có thể đã bị xoá, và có báo cáo hiệu quả cho anh và bot.

**Architecture:**
- **Thuần TS:** `postTracking.ts` (chuẩn hoá chữ, đối chiếu bài, tính mốc kế tiếp, cấu hình).
- **Lưu trữ:** bảng mới trong `schema.ts` và các hàm trong `FacebookPosterStore`.
- **`PostTracker`:** đọc bảng tin nhóm bằng `GraphqlSession` và `parseGroupFeed` của Nghiên cứu, dùng chung khe việc của Đăng Facebook.
- **`PostTrackScheduler`:** tự chạy mỗi 15 phút.
- **Nối Electron và Control API:** như các tính năng trước.

**Tech Stack:** TypeScript, playwright-core, better-sqlite3, React 18, jest, Python stdlib (`watch`).

**Spec:** `docs/specs/2026-10-19-post-performance.md` (đã duyệt). Làm **sau** phần G (`docs/plans/2026-10-16-poster-retry-error-codes.md`, Task 1–4) trên cùng nhánh `feat/26.21-retry-and-stats`. Task phát hành chung là Task 8 của plan này; Task 5 của plan G được gộp vào đây.

## Global Constraints

- **Hằng số:**
  - `MAX_TRACK_GROUPS = 30`, `AUTO_TRACK_GROUPS = 10`, `MAX_TRACK_PAGES_PER_GROUP = 10`, `TRACK_TICK_MINUTES = 15`;
  - nghỉ 3–6 s giữa hai trang, 8–15 s giữa hai nhóm;
  - `sinceDays` mặc định 3, khoảng 1–14;
  - đối chiếu: ±2 giờ và 60 ký tự đầu; `text_head` lưu 200 ký tự;
  - `not_found` sau 7 ngày;
  - giữ dữ liệu 180 ngày.
- **Cấu hình mặc định:** `{ autoEnabled: true, linkRetryMinutes: [30,120,360,1440,2880,4320,10080], statsAtMinutes: [60,1440,4320] }`. Mỗi mảng 1–10 phần tử, tăng dần, mỗi phần tử trong khoảng 5–20160.
- **Chỉ đọc Facebook:** không đăng, không bấm. Gọi API trong trang của profile, không giả header, không gọi từ Node.
- **Khe việc:** dùng chung khe với lượt đăng (`acquireExclusive` / `releaseExclusive`), giống kiểm tra đăng nhập.
- **Giao thức:** Control API chỉ thêm thao tác, sự kiện và trường mới. Không đổi hành vi đăng bài, trừ việc ghi nhận "chờ duyệt" (spec §3).
- **Lỗi khi ghi dữ liệu theo dõi:** không bao giờ làm hỏng lượt đăng.
- **Ngôn ngữ:** định danh tiếng Anh; chữ hiển thị, log và docs tiếng Việt.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <paths>`. Không chạy `rebuild:native` / `prebuild-install` (controller lo).
  - tsc: hai lệnh chạy **riêng, lần lượt** (máy ít RAM): `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi lệnh tương tự với `-p tsconfig.json`.
- **Tài liệu:** cập nhật `SYSTEM_DOCUMENTATION.md` và `docs/protocol/maihub-control-protocol.md` trong cùng commit với thay đổi hành vi. `node scripts/check-docs.js` phải sạch.
- **Git:**
  - `git add` đúng đường dẫn;
  - commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
  - không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **Đối chiếu nhầm bài người khác** (cùng chữ mở đầu, khác tác giả, hoặc lệch giờ): không được gắn link. → Task 1, 3.
2. **Lịch đăng đến giờ khi bộ hẹn giờ đang theo dõi:** lịch vào hàng đợi rồi chạy sau. Bộ hẹn giờ không chạy khi đang có lượt đăng. → Task 3, 4, 5.
3. **Dừng sớm vì giới hạn trang:** không được kết luận "bị xoá" hay "không tìm thấy". → Task 3.
4. **Bài chờ duyệt qua mốc cuối:** chuyển sang `not_found` và `next_check_at = NULL`. Không có vòng lặp kiểm tra vô hạn. → Task 1, 4.
5. **Lỗi ghi bảng theo dõi trong lúc đăng:** lượt đăng vẫn chạy bình thường. → Task 2.

---

### Task 1: Hàm thuần, bảng và lưu trữ

**Files:**
- Create: `src/services/facebookPoster/postTracking.ts`
- Modify:
  - `src/services/facebookPoster/schema.ts`: 2 bảng mới theo spec §2.1–§2.2, có cột `next_check_at` và `stats_done`; index `(next_check_at)`, `(profile_id, group_url)`, `(result_id, captured_at)`;
  - `src/services/facebookPoster/FacebookPosterStore.ts`;
  - `src/models/facebookPoster.ts`.
- Test: `src/__tests__/facebookPoster/postTracking.test.ts`, `FacebookPosterStore.test.ts` (chỉ thêm)

**Interfaces (Produces):**
- **Kiểu:**
  - `LinkStatus = 'known' | 'missing' | 'pending_approval' | 'not_found'`
  - `PostTrackingRow`
  - `PostStatsSnapshot`
  - `PostTrackingConfig`
- **Cấu hình:** `DEFAULT_POST_TRACKING_CONFIG`, `parsePostTrackingConfig(raw)`, `validatePostTrackingConfig(input)`, `POST_TRACKING_SETTING_KEY = 'fb_poster_post_tracking_config'`.
- **Hàm thuần:**
  - `normalizeHead(text): string`: chữ thường, gộp khoảng trắng, cắt 200 ký tự.
  - `matchesOwnPost(row, item, userId): boolean`: theo spec §4.3, trùng `author_id`, ±2 giờ, 60 ký tự đầu.
  - `pickBestMatch(row, items, userId)`: lấy mục gần thời gian nhất.
  - `computeNextCheckAt(row, config, now): number | null`: theo spec §4.5.
  - `dueStatsMilestone(row, config, now): string | null`.
- **Store:**
  - `createTracking(row)` (INSERT OR IGNORE)
  - `listTracking(filter)`
  - `listDuePairs(now, limit)`: các cặp (profile, nhóm) có dòng đến hạn, ưu tiên `pending_approval` / `missing`
  - `listTrackingForPair(profileId, groupUrl, sinceMs)`
  - `updateTracking(resultId, patch)`
  - `addPostStats(resultId, snap)`
  - `latestStats(resultIds)`
  - `statsReport({ from, to, groupBy, limit })`: theo spec §5; số thành viên lấy từ bảng `research_items` nếu có, bảng không tồn tại thì `null`
  - `pruneTrackingOlderThan(ms)`

- [ ] **Step 1:** Viết test:
  - `normalizeHead`;
  - `matchesOwnPost` cho các trường hợp khớp, khác tác giả, lệch quá 2 giờ, khác chữ;
  - `pickBestMatch`;
  - `computeNextCheckAt`:
    - bài chờ duyệt tại từng mốc;
    - qua mốc cuối → `null`;
    - bài đã có link → các mốc 1h/24h/72h;
    - `removed_suspected` → `null`;
  - parse/validate cấu hình;
  - store: tạo dòng, `listDuePairs` có ưu tiên, `latestStats`, `statsReport` cho từng `groupBy`, prune.

  Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS. Chạy cả 2 lệnh tsc.
- [ ] **Step 2:** Commit: `feat(poster): post tracking model, store and pure matching rules`.

### Task 2: Tạo dòng theo dõi khi đăng, và ghi nhận "chờ duyệt"

**Files:**
- Modify:
  - `src/services/facebookPoster/postToTargets.ts`: sau khi đăng thành công mà không có link, đọc chữ trên trang tìm `PENDING_APPROVAL_MARKERS` (dùng lại từ `firstComment.ts`); `PostTargetResult` thêm `pendingApproval: boolean`;
  - `src/services/facebookPoster/FacebookPosterService.ts`: `record()` gọi `createTracking` cho kết quả `posted` khi `mode = 'group'`, bọc try/catch rồi ghi log; điền `next_check_at` bằng `computeNextCheckAt`.
- Test: `postToTargets.test.ts`, `FacebookPosterService.test.ts` (chỉ thêm)

- [ ] **Step 1:** Viết test:
  - trang có câu chờ duyệt → `pendingApproval` và dòng `pending_approval`;
  - có link → `known`;
  - không link, không có câu chờ duyệt → `missing`;
  - đăng trang (`mode = 'page'`) → không tạo dòng;
  - store ném lỗi → lượt đăng vẫn ghi kết quả.

  Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 2:** Commit: `feat(poster): create tracking rows and detect pending approval at post time`.

### Task 3: `PostTracker`

**Files:**
- Create: `src/services/facebookPoster/PostTracker.ts`
- Modify: `src/services/research/graphqlSession.ts` (thêm getter `userId()`, chỉ đọc)
- Test: `src/__tests__/facebookPoster/PostTracker.test.ts`

**Interfaces:**
- Consumes: Task 1; `GraphqlSession`, `parseGroupFeed`, `describeShape`, `buildGroupFeedVariables` và cách xử lý link nhóm dạng tên của Nghiên cứu (dùng lại hàm có sẵn trong `ResearchService.ts` nếu đã export được; nếu không thì tách hàm dùng chung sang `src/services/research/groupFeed.ts` mà **không** đổi hành vi Nghiên cứu, kèm test).
- Produces:
  - `class PostTracker(deps: { store; openSession(profileId); slot: { acquire(); release() }; observeLogin(profileId, state); emit(type, payload); now?; sleep?; random?; newId? })`
  - `track({ sinceDays?, groupUrls?, profileIds?, auto?: boolean, pairs?: Pair[] }): { jobId, pairs }`, chạy nền
  - `status(): { running, jobId, progress, last }`
  - `cancel(): boolean`
  - `whenIdle()`, `stop()`
- **Hành vi:** đúng spec §4.2–§4.4, kèm các mốc đo §4.5 (`stats_done`). Sự kiện `posts.trackFinished` có cờ `auto`.

- [ ] **Step 1:** Viết test (giả phiên, đồng hồ, sleep):
  - gắn link cho bài chờ duyệt khi thấy;
  - đo theo `post_id`;
  - `removed_suspected` chỉ khi đã đọc qua mốc thời gian;
  - dừng sớm → không kết luận;
  - `not_found` sau 7 ngày;
  - giới hạn 30 nhóm / 10 trang, thời gian nghỉ;
  - giữ khe việc (lượt đăng `BUSY` trong lúc theo dõi);
  - huỷ;
  - checkpoint → `observeLogin`, bỏ các nhóm còn lại của profile đó;
  - sự kiện kết thúc.

  Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 2:** Commit: `feat(poster): post tracker reads group feeds to link and measure posts`.

### Task 4: `PostTrackScheduler`

**Files:**
- Create: `src/services/facebookPoster/PostTrackScheduler.ts`
- Test: `src/__tests__/facebookPoster/PostTrackScheduler.test.ts`

**Interfaces:**
- Produces `class PostTrackScheduler(deps: { now; setTimer; clearTimer; readConfig; isBusy; duePairs(now, limit); runTrack(pairs): void; log })`, với `start()`, `stop()`, `tickNow()` (cho test). Mỗi `TRACK_TICK_MINUTES`:
  - tắt `autoEnabled` → không làm gì;
  - đang bận → bỏ lượt;
  - có cặp đến hạn → `runTrack(pairs)` (tối đa 10 cặp), với `auto = true`;
  - `runTrack` ném `BUSY_ERROR` → coi như đang bận.

- [ ] **Step 1:** Viết test cho: tắt, bận, không có việc, có việc (≤ 10 cặp), BUSY, `stop`. Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 2:** Commit: `feat(poster): automatic post tracking scheduler`.

### Task 5: Nối vào Electron

**Files:**
- Modify:
  - `electron/ipc/facebookPosterIpc.ts`:
    - tạo `PostTracker` gắn với store theo DB như checker;
    - `openSession` = `openForAutomation` + `new GraphqlSession(page, researchStore)`, trong đó `researchStore` dùng chung `research_queries` của Nghiên cứu (lấy qua hàm đã export ở `researchIpc.ts`);
    - `PostTrackScheduler` chạy và dừng cùng lịch đăng;
    - `isFacebookPosterBusy` tính cả theo dõi;
    - `cancelAndWait` dừng cả theo dõi;
    - dọn dữ liệu 180 ngày mỗi DB một lần;
  - `electron/preload.ts`, `src/ui/lib/ipc.ts`;
  - `src/__tests__/http/relayChannelPolicy.test.ts` (thêm kênh vào danh sách boss-only).
- Docs: `SYSTEM_DOCUMENTATION.md` (bảng, cấu hình, bộ hẹn giờ, IPC, sự kiện)

**Produces:**
- IPC: `facebookPoster:trackPosts`, `facebookPoster:trackStatus`, `facebookPoster:trackCancel`, `facebookPoster:listTracking`, `facebookPoster:postStats`, `facebookPoster:getTrackConfig`, `facebookPoster:setTrackConfig`.
- Sự kiện renderer: `facebookPoster:trackProgress`, `facebookPoster:trackFinished`.
- `export const trackingOperations`, dùng chung cho Control API (kiểm tra tham số đặt ở đây).

- [ ] **Step 1:** Viết code. Chạy lần lượt: 2 lệnh tsc, `npx jest --runInBand src/__tests__/facebookPoster src/__tests__/research src/__tests__/http`, `check-docs`.
- [ ] **Step 2:** Commit: `feat(poster): wire post tracking, scheduler and IPC`.

### Task 6: Control API và tin Telegram

**Files:**
- Modify:
  - `src/services/control/ControlMethods.ts`, `controlEvents.ts`, `electron/ipc/controlApiIpc.ts`;
  - `tools/maihub-bridge/maihub_bridge.py` (`format_event` cho `posts.trackFinished`: chỉ khi `linked > 0` hoặc `removedSuspected > 0`, đúng câu ở spec §6, có cả lần tự chạy);
  - tests.
- Docs: protocol doc (6 thao tác, sự kiện), `SYSTEM_DOCUMENTATION.md` (số thao tác 24 → 30), bridge README

**Produces:** `posts.track`, `posts.trackStatus`, `posts.trackCancel`, `posts.list`, `posts.stats`, `posts.trackConfig` theo spec §6; sự kiện `posts.trackFinished`.

- [ ] **Step 1:** Viết test:
  - `describe` có 6 thao tác mới (sửa đúng danh sách kỳ vọng);
  - kiểm tham số, `BUSY`, `NOT_FOUND`;
  - payload sự kiện;
  - bridge: định dạng tin khi có link / không có gì.

  Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS, kèm tsc, unittest của bridge, `check-docs`.
- [ ] **Step 2:** Commit: `feat(control): post tracking methods and Telegram summary`.

### Task 7: Giao diện

**Files:**
- Create: `src/ui/features/facebookPoster/PerformancePanel.tsx`, `TrackConfigPopover.tsx`
- Modify: `src/ui/features/facebookPoster/HistoryTab.tsx` (chip trạng thái link, số đo mới nhất, gắn `PerformancePanel` ở đầu)

**Hành vi:** theo spec §7, dùng class màu có sẵn, không tràn ngang ở 390 px, có a11y, dọn các subscription khi unmount.

- [ ] **Step 1:** Viết code. Chạy tsc `-p tsconfig.json`; chạy jest cho các hàm thuần (nếu tách ra).
- [ ] **Step 2:** Commit: `feat(poster): performance panel, link status chips and tracking settings`.

### Task 8 (controller): Kiểm chứng và phát hành 26.21.0 (gồm G)

- [ ] **Step 1:** Review toàn nhánh bằng Opus (G + A). Một lượt sửa, một re-review.
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, cả 2 lệnh tsc, unittest của bridge, `check-docs`.
  - App dev chạy với dữ liệu tách riêng. Kiểm Lịch sử / Hiệu quả / cài đặt ở 1280 và 390 px, sáng và tối, với dữ liệu giả.
  - Hồi quy: Đăng Facebook, lịch, kiểm tra đăng nhập, Nghiên cứu.
- [ ] **Step 3:**
  - Tăng version lên 26.21.0, thêm changelog (G + A).
  - Cập nhật dòng phiên bản trong tài liệu.
  - Đổi trạng thái 2 spec sang "Đã phát hành", thêm "Ghi chú sau phát hành" và "Điều chỉnh khi triển khai".
  - Merge vào `main`, gắn tag; anh push; kiểm tra CI.
