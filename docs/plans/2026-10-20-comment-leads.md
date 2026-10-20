# Kế hoạch: Khách tiềm năng từ bình luận (26.24)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tự thu bình luận của bài nhóm đã có link theo mốc, lọc khách tiềm năng (từ khoá + số điện thoại, AI tuỳ chọn), quản lý danh sách khách, báo Telegram và mở cho bot qua Control API.

**Architecture:**
- **Module thuần:**
  - `commentTime.ts`: đổi nhãn thời gian tương đối;
  - `leadRules.ts`: cấu hình, từ khoá, số điện thoại, lịch mốc thu.
- **`LeadDetector`:** lọc bình luận mới, gọi AI qua cổng tiêm vào, tạo khách, phát sự kiện. Chạy cho **mọi** lần lưu bình luận, cả thu tay lẫn thu tự động.
- **`CommentCollector` + `CommentCollectScheduler`:** tự thu theo mốc. Theo mẫu `PostTracker` / `PostTrackScheduler`, dùng chung khe việc, gọi lại `collectComments` có sẵn và không tạo dòng Lịch sử.
- **Nối Electron:** IPC, Control API, bridge, UI.

**Tech Stack:** Electron 41, React 18, TypeScript, better-sqlite3, xlsx (đã có), Jest, Python bridge.

**Spec:** `docs/specs/2026-10-20-group-scores-times-leads.md` §6 (đã duyệt), cùng §1, §7–§8 cho phần E.

## Global Constraints

- **Cấu hình** `fb_poster_lead_config` (`app_settings`), mặc định:
  - `{ autoCollect: true, collectAtMinutes: [120, 1440, 4320], keywords: DEFAULT_LEAD_KEYWORDS, detectPhone: true, aiEnabled: false, aiMinScore: 60 }`;
  - `collectAtMinutes`: 1–10 phần tử, tăng dần, mỗi phần tử 30–20160;
  - `keywords`: 1–100 mục, mỗi mục 1–40 ký tự sau trim;
  - `aiMinScore`: 0–100.
- **`DEFAULT_LEAD_KEYWORDS`** = `giá, bao nhiêu, bn, ib, inbox, nhắn, ship, mua, đặt, order, còn hàng, còn không, sđt, số điện thoại, zalo, liên hệ, tư vấn, địa chỉ, size`.
- **Khớp từ khoá:** không dấu, không phân biệt hoa thường, theo ranh giới từ.
- **Số điện thoại:** bắt đầu `0` hoặc `+84`, tổng 9–11 chữ số sau khi bỏ dấu cách / chấm / gạch.
- **AI:**
  - Trợ lý AI mặc định của app, gửi theo lô ≤ 20, `structured`.
  - Trả `{ intent: 'buy' | 'question' | 'other', score: 0–100, reason }`; chỉ thành khách khi `score ≥ aiMinScore`.
  - AI lỗi hoặc chưa cấu hình → mọi bình luận khớp từ khoá thành khách, `ai_*` = `NULL`, cảnh báo 1 lần mỗi lượt.
- **Tự thu:**
  - `COMMENT_TICK_MINUTES = 15`, `MAX_COMMENT_POSTS = 10` mỗi lượt, nghỉ 10–20 s giữa hai bài;
  - dùng profile đã đăng và khe việc chung (`acquireExclusive` / `releaseExclusive`);
  - **không** tạo `fb_poster_runs` / `fb_poster_results`;
  - profile hết phiên hoặc bị checkpoint → `observeLogin`, bỏ các bài còn lại của profile đó, dời các bài đến hạn sang mốc kế tiếp (hết mốc → `next_comment_at = NULL`); không lặp mỗi 15 phút.
- **Trạng thái khách:** `new` / `contacted` / `won` / `ignored`. `note` ≤ 1000 ký tự. Dữ liệu giữ 180 ngày.
- **Chỉ đọc Facebook:** không đăng, không bình luận, không nhắn tin.
- **Control API:** chỉ thêm; 37 → 42 thao tác (`comments.collect`, `comments.list`, `leads.list`, `leads.update`, `leads.config`); sự kiện mới `leads.found` `{ count, samples (≤ 3: authorName, text, postUrl), auto }`.
- **Telegram:** `"🎯 <count> khách tiềm năng mới"` kèm tối đa 3 dòng `"<tên>: <nội dung cắt 80 ký tự>"`; chỉ gửi khi `count > 0`.
- **Định danh** tiếng Anh; chữ hiển thị, log và docs tiếng Việt.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <paths>`; không chạy `rebuild:native` / `prebuild-install`.
  - tsc: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi `-p tsconfig.json`, **lần lượt**.
  - `node scripts/check-docs.js` sạch.
- **Tài liệu:** `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md` và README của bridge cập nhật trong cùng commit với thay đổi hành vi.
- **Git:**
  - `git add` đúng đường dẫn;
  - commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
  - không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **Thu tay và thu tự động cùng một bài, hoặc thu lại nhiều lần:** không tạo khách trùng (`comment_key` UNIQUE), không gửi lại sự kiện cho bình luận cũ. → Task 2, 3.
2. **Profile hết phiên khi tự thu:** không mở lại trình duyệt mỗi 15 phút; lịch đăng đến giờ vẫn được xếp hàng và chạy sau. → Task 4, 5.
3. **AI lỗi, hết hạn mức hay trả JSON hỏng:** không mất khách, không làm hỏng lượt thu. → Task 3.
4. **Bình luận của chính mình và bình luận không có chữ** (chỉ ảnh hay sticker): không thành khách. → Task 1, 3.
5. **Thu bình luận tay (tab Thu bình luận) của 26.x vẫn chạy như cũ:** lịch sử, CSV, dữ liệu không đổi. → Task 2, 3, 5.

---

### Task 1: Module thuần — thời gian bình luận và luật lọc khách

**Files:**
- Create: `src/services/facebookPoster/commentTime.ts`, `src/services/facebookPoster/leadRules.ts`
- Test: `src/__tests__/facebookPoster/commentTime.test.ts`, `src/__tests__/facebookPoster/leadRules.test.ts`

**Interfaces:**
- **Produces (`commentTime.ts`):** `parseCommentTime(label: string, collectedAt: number): number | null`.
  - "Vừa xong", "Just now" → `collectedAt`;
  - "N phút", "Nm", "N mins" → trừ phút; "N giờ", "Nh", "N hrs" → trừ giờ;
  - "Hôm qua", "Yesterday" → trừ 1 ngày;
  - "N ngày", "Nd" → trừ ngày; "N tuần", "Nw" → trừ tuần;
  - ngày cụ thể "12 tháng 10", "October 12" (năm hiện tại, hoặc năm trước nếu rơi vào tương lai);
  - còn lại `null`.
- **Produces (`leadRules.ts`):**
  - `DEFAULT_LEAD_KEYWORDS`, `LEAD_CONFIG_SETTING_KEY = 'fb_poster_lead_config'`;
  - `LeadConfig`, `DEFAULT_LEAD_CONFIG`;
  - `parseLeadConfig(raw: unknown): LeadConfig` (sai → mặc định);
  - `validateLeadConfig(input: unknown): LeadConfig` (ném lỗi tiếng Việt);
  - `matchLead(text: string, config: Pick<LeadConfig, 'keywords' | 'detectPhone'>): string[] | null`: trả các từ khoá khớp, thêm `'phone'` nếu có số điện thoại; `null` khi không khớp hoặc text rỗng;
  - `computeNextCommentAt(postedAt: number, done: string[], config: Pick<LeadConfig, 'collectAtMinutes'>, now: number): number | null`: mốc đầu tiên chưa làm và **còn ở tương lai**, hoặc `null`; nhãn mốc dạng `"120m"`;
  - `overdueCommentLabels(postedAt, done, config, now): string[]`.

- [ ] **Step 1:** Viết test:
  - từng dạng nhãn thời gian (tiếng Việt và tiếng Anh), nhãn lạ → `null`;
  - `matchLead`:
    - không dấu ("gia bao nhieu");
    - ranh giới từ ("ib" khớp "ib em", không khớp "lib");
    - số điện thoại có dấu cách / chấm / gạch, `+84`;
    - số 8 chữ số → không khớp;
    - text rỗng → `null`;
  - `validateLeadConfig` các biên;
  - `computeNextCommentAt` (bỏ mốc đã qua, hết mốc → `null`).

  Chạy → FAIL.
- [ ] **Step 2:** Viết code (dùng lại cách bỏ dấu trong `src/ui/features/facebookPoster/matchKeywords.ts` bằng cách chép hàm thuần nhỏ sang service, **không** import từ `src/ui`). Chạy → PASS.
- [ ] **Step 3:** Commit `feat(poster): comment time parsing and lead matching rules`.

### Task 2: Dữ liệu và store

**Files:**
- Modify: `src/services/facebookPoster/schema.ts`, `src/models/facebookPoster.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`

**Interfaces:**
- **Migration** (`FB_POSTER_MIGRATIONS`):
  - `fb_poster_comments.commented_at_ms INTEGER DEFAULT NULL`;
  - `fb_poster_post_tracking.comments_done TEXT NOT NULL DEFAULT ''`, `next_comment_at INTEGER DEFAULT NULL`;
  - index `fb_poster_post_tracking(next_comment_at)`.
- **Bảng `fb_poster_leads`** đúng spec §6.3, kèm index `(status, detected_at)` và `(campaign_id)`.
- **Model:** `FbPosterLead`, `LeadStatus`; `FbPosterComment.commentedAtMs`; `PostTrackingRow.commentsDone: string[]`, `nextCommentAt: number | null`.
- **Store:**
  - `saveComments(profileId, rows, collectedAt)` **giữ nguyên chữ ký và giá trị trả về**; ghi thêm `commented_at_ms = parseCommentTime(...)`;
  - `insertCommentsReturningNew(profileId, rows, collectedAt): FbPosterComment[]`: trả các dòng **thực sự mới**. `saveComments` gọi lại hàm này và trả `.length`;
  - `trackingByPostUrls(postUrls: string[]): Map<string, PostTrackingRow>` (chia lô 500);
  - `createLeads(leads: Omit<FbPosterLead, 'id'>[]): FbPosterLead[]`: INSERT OR IGNORE theo `comment_key`, trả các dòng đã tạo;
  - `listLeads(filter: { status?; campaignId?; from?; to?; search?; limit; offset }): { leads; total }` (sắp `detected_at` giảm dần);
  - `updateLead(id, patch: { status?; note? }, at): FbPosterLead | null`;
  - `listDueCommentPosts(now, limit): PostTrackingRow[]`: `link_status = 'known'`, `post_url` khác rỗng, `next_comment_at <= now`, sắp `next_comment_at`;
  - `updateCommentSchedule(resultId, { commentsDone, nextCommentAt })`;
  - `pruneLeadsOlderThan(ms)`;
  - `leadCommentKeys(keys: string[]): Set<string>` (để đánh dấu cột "Khách" ở tab Thu bình luận).

- [ ] **Step 1:** Viết test:
  - migration trên DB cũ chạy được (ALTER hai lần không lỗi);
  - `insertCommentsReturningNew` chỉ trả dòng mới; `saveComments` vẫn trả số dòng;
  - `commented_at_ms`;
  - `createLeads` chống trùng;
  - `listLeads` lọc / tìm / phân trang;
  - `updateLead`;
  - `listDueCommentPosts`;
  - prune;
  - `trackingByPostUrls` > 500 mục.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` → PASS (test cũ không sửa).
- [ ] **Step 3:** Commit `feat(poster): lead table, comment schedule columns and store methods`.

### Task 3: `LeadDetector` và AI

**Files:**
- Create: `src/services/facebookPoster/LeadDetector.ts`, `src/services/facebookPoster/leadAi.ts`
- Modify: `src/services/facebookPoster/FacebookPosterService.ts` (đường lưu bình luận của `collect_comments` gọi `insertCommentsReturningNew` rồi `deps.onCommentsSaved?.(rows)`; lỗi trong callback chỉ ghi log)
- Test: `src/__tests__/facebookPoster/LeadDetector.test.ts`, `src/__tests__/facebookPoster/leadAi.test.ts`, thêm vào `FacebookPosterService.test.ts`

**Interfaces:**
- **`leadAi.ts`:**
  - `buildLeadPrompt(comments)`: system + user, yêu cầu JSON mảng `[{ i, intent, score, reason }]`;
  - `parseLeadVerdicts(text, count)`: bỏ phần thừa, chấp nhận JSON trong khối code, bỏ mục sai, `score` kẹp 0–100;
  - `type LeadClassifier = (comments: { text: string }[]) => Promise<{ intent; score; reason }[] | null>` (`null` = AI không dùng được).
- **`class LeadDetector(deps: { store; readConfig(): LeadConfig; classify?: LeadClassifier; emit(type, payload); now?; log(msg) })`:**
  - `process(comments: FbPosterComment[], opts: { auto: boolean }): Promise<FbPosterLead[]>`;
  - các bước: `matchLead` → (AI theo lô 20 nếu `aiEnabled` và có `classify`) → lấy ngữ cảnh từ `trackingByPostUrls` → `createLeads` → nếu có khách mới thì `emit('leads.found', { count, samples, auto })`.
  - Không bao giờ ném lỗi ra ngoài: lỗi AI thì rơi về từ khoá, lỗi ghi thì log.

- [ ] **Step 1:** Viết test:
  - chỉ bình luận khớp mới thành khách;
  - AI tắt → ai `NULL`;
  - AI bật: dưới ngưỡng bị loại, trên ngưỡng giữ, AI ném lỗi / trả `null` / JSON hỏng → rơi về từ khoá kèm một cảnh báo;
  - chia lô 20;
  - ngữ cảnh chiến dịch / biến thể / nhóm;
  - chống trùng khi chạy hai lần;
  - sự kiện có ≤ 3 mẫu, không phát khi 0;
  - service: lượt thu tay gọi `onCommentsSaved` với đúng dòng mới; callback ném lỗi thì lượt vẫn xong.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy → PASS.
- [ ] **Step 3:** Commit `feat(poster): detect sales leads in collected comments`.

### Task 4: Tự thu bình luận theo mốc

**Files:**
- Create: `src/services/facebookPoster/CommentCollector.ts`, `src/services/facebookPoster/CommentCollectScheduler.ts`
- Modify:
  - `src/services/facebookPoster/FacebookPosterService.ts` (`trackPostedResult`: dòng `known` có `next_comment_at` ban đầu);
  - `src/services/facebookPoster/PostTracker.ts` (khi gắn link cho bài chờ duyệt / thiếu link, đặt `next_comment_at` nếu chưa có).
- Test: `src/__tests__/facebookPoster/CommentCollector.test.ts`, `src/__tests__/facebookPoster/CommentCollectScheduler.test.ts`

**Interfaces:**
- **`class CommentCollector(deps: { store; launchFor(profileId): Promise<{ ctx; page; close() }>; collect: typeof collectComments; slot; observeLogin; detector: Pick<LeadDetector, 'process'>; readConfig; emit; now?; sleep?; random? })`:**
  - `collect({ postUrls?, auto? }): { jobId, posts }`;
  - `status()`, `cancel()`, `whenIdle()`, `stop()`;
  - `BUSY_ERROR` khi khe đang bận;
  - gom theo profile;
  - phát hiện hết phiên / checkpoint theo **đúng cách `collectComments` / `PostTracker` đang làm** (tìm và dùng lại);
  - lưu qua `store.insertCommentsReturningNew` → `detector.process(rows, { auto })`;
  - sau mỗi bài: `updateCommentSchedule` (đánh dấu mọi mốc đã quá hạn, tính mốc kế tiếp);
  - lỗi theo bài → dời sang mốc kế tiếp (không lặp);
  - sự kiện `comments.collectFinished` (chỉ cho UI, **không** vào Control API).
- **`class CommentCollectScheduler(deps: { now; setTimer; clearTimer; readConfig; isBusy; duePosts(now, limit); runCollect(rows): void; log })`:** cùng hành vi với `PostTrackScheduler` (tắt `autoCollect` → bỏ lượt; bận → bỏ lượt; `BUSY_ERROR` → bận).

- [ ] **Step 1:** Viết test (giả `launchFor` / `collect` / đồng hồ):
  - thu theo profile;
  - giữ khe việc (lượt đăng `BUSY` trong lúc thu);
  - huỷ;
  - hết phiên → `observeLogin`, bỏ bài còn lại của profile, dời mốc;
  - lỗi một bài không chặn bài khác;
  - không tạo run;
  - mốc cuối → `NULL`;
  - scheduler: tắt / bận / không việc / có việc ≤ 10 / `BUSY`;
  - `trackPostedResult` đặt `next_comment_at` cho bài `known`;
  - `PostTracker` đặt khi gắn link.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` → PASS.
- [ ] **Step 3:** Commit `feat(poster): collect comments automatically at milestones`.

### Task 5: Nối Electron, IPC và tài liệu

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/__tests__/http/relayChannelPolicy.test.ts`
- Test: `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` (thêm)
- Docs: `SYSTEM_DOCUMENTATION.md` (bảng, cột, cấu hình, bộ hẹn giờ, luồng lọc, IPC, sự kiện)

**Interfaces:**
- **Theo mẫu `getTracker` / `trackScheduler`:**
  - `LeadDetector` (classify = adapter `AIAssistantService.getInstance()` với trợ lý mặc định; không có trợ lý → `null`);
  - `CommentCollector` (`launchFor` = `openForAutomation`);
  - `CommentCollectScheduler` chạy và dừng cùng lịch đăng; `isBusy` gồm cả chuyển workspace;
  - `isFacebookPosterBusy` / `cancelAndWait` tính cả lượt thu;
  - prune khách 180 ngày cùng chỗ prune theo dõi;
  - lượt `collect_comments` thủ công truyền `onCommentsSaved` → `detector.process(rows, { auto: false })`.
- **`export const leadOperations`:**
  - `list`, `update`, `getConfig`, `setConfig`;
  - `exportXlsx` (hộp lưu tệp như Nghiên cứu);
  - `collect` (`postUrls?` ≤ 50 chuỗi), `collectStatus`, `collectCancel`;
  - `comments(params)` = danh sách bình luận có `since?`;
  - kiểm tham số tại đây.
- **IPC:** `facebookPoster:leadList|leadUpdate|leadConfigGet|leadConfigSet|leadExport|commentCollect|commentCollectStatus|commentCollectCancel`.
- **Sự kiện renderer:** `facebookPoster:leadsFound`, `facebookPoster:commentCollectProgress`, `facebookPoster:commentCollectFinished`.
- **Phát control event** `leads.found` (khai báo type ở Task 6; ở task này chỉ nối chỗ phát qua `emitControlEvent` nếu kiểu đã có, nếu chưa thì để Task 6 nối và ghi chú).

- [ ] **Step 1:** Viết test wiring (mẫu `facebookPosterIpcWiring.test.ts`): `leadOperations` kiểm tham số; lượt thu tay gọi detector; scheduler nhận `isBusy`. Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy lần lượt: 2 lệnh tsc, `npx jest --runInBand src/__tests__/facebookPoster src/__tests__/http src/__tests__/research`, `check-docs`.
- [ ] **Step 3:** Commit `feat(poster): wire lead detection, comment auto-collect and IPC`.

### Task 6: Control API và Telegram

**Files:**
- Modify: `src/services/control/ControlMethods.ts`, `src/services/control/controlEvents.ts`, `electron/ipc/controlApiIpc.ts`, `electron/ipc/facebookPosterIpc.ts` (phát `leads.found`), `tools/maihub-bridge/maihub_bridge.py`
- Test: `src/__tests__/control/*.test.ts`, `tools/maihub-bridge/tests/test_bridge.py`
- Docs: protocol doc (5 thao tác, sự kiện), `SYSTEM_DOCUMENTATION.md` (37 → 42), `tools/maihub-bridge/README.md`

**Interfaces:**
- **Thao tác mới:**
  - `comments.collect` (`postUrls?`): `{ jobId, posts }`, `BUSY` khi bận;
  - `comments.list` (`postUrl?`, `since?`, `limit` 1–500, `offset`);
  - `leads.list` (`status?`, `campaignId?`, `from?`, `to?`, `search?`, `limit`, `offset`);
  - `leads.update` (`id`, `status?`, `note?`; `NOT_FOUND` nếu không có);
  - `leads.config` (vắng `config` → đọc; có → ghi).
- **Sự kiện `leads.found`:** `buildLeadsFound`, phát một lần mỗi lượt có khách mới, cả thu tay và thu tự động.
- **Bridge `format_event`:** dòng `🎯` theo Global Constraints; không gửi khi `count = 0`.

- [ ] **Step 1:** Viết test:
  - describe thêm 5 thao tác (đổi đúng danh sách, ghi trong báo cáo);
  - kiểm tham số / `BUSY` / `NOT_FOUND`;
  - payload sự kiện;
  - bridge: có khách / không khách / tên dài.

  Chạy → FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy: 2 lệnh tsc, jest `src/__tests__/control src/__tests__/facebookPoster src/__tests__/http`, unittest bridge, `check-docs`.
- [ ] **Step 3:** Commit `feat(control): lead and comment methods with Telegram lead alerts`.

### Task 7: Giao diện

**Files:**
- Create: `src/ui/features/facebookPoster/LeadsTab.tsx`, `src/ui/features/facebookPoster/LeadConfigPopover.tsx`, `src/ui/features/facebookPoster/leadFormat.ts` (+ test `src/__tests__/facebookPoster/leadFormat.test.ts`)
- Modify: `src/ui/features/facebookPoster/FacebookPosterView.tsx`, `src/ui/components/layout/Sidebar.tsx`, `src/ui/store/appStore.ts` (mục "Khách tiềm năng" sau "Thu bình luận"), `src/ui/features/facebookPoster/CommentsTab.tsx` (cột "Khách")

**Interfaces:**
- **Consumes:** IPC Task 5.
- **`leadFormat.ts`:** `leadStatusChip(status)`, `formatLeadMatch(lead)` ("giá, ib · SĐT · AI 82"), `LEAD_STATUS_OPTIONS`.
- **`LeadsTab` theo spec §6.4:**
  - lọc trạng thái / chiến dịch / 7–30–90 ngày / tìm chữ;
  - bảng: người bình luận (link mở trình duyệt ngoài như các link khác), nội dung (cắt, `title` đầy đủ), nhóm, chiến dịch · biến thể, khớp / AI, thời gian (ước tính, có chữ "~"), trạng thái (select đổi tại chỗ), ghi chú (sửa inline, lưu khi rời ô);
  - nút "Thu ngay" (`commentCollect` các bài đến hạn) kèm tiến độ / huỷ;
  - "Xuất Excel";
  - ⚙ `LeadConfigPopover` (từ khoá dạng chữ cách dấu phẩy, công tắc số điện thoại, AI + ngưỡng, tự thu + mốc phút; lỗi tiếng Việt từ server);
  - tự làm mới khi có `leadsFound` / `commentCollectFinished`.
- **CommentsTab:** cột "Khách" (✓) cho bình luận đã thành khách.
- **Yêu cầu chung:** async an toàn (không setState sau unmount, không ghi đè bằng phản hồi cũ); sáng / tối; 390 px không tràn trang (bảng cuộn trong khung); a11y.

- [ ] **Step 1:** Test `leadFormat` → FAIL → viết → PASS.
- [ ] **Step 2:** Viết component. Chạy 2 lệnh tsc, jest test liên quan. Không chạy app.
- [ ] **Step 3:** Commit `feat(poster): leads tab, lead settings and comment lead markers`.

### Task 8 (controller): Kiểm chứng và phát hành 26.24.0

- [ ] **Step 1:** Review toàn nhánh bằng Opus (không chạy cùng app). Một lượt sửa, một re-review.
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, 2 lệnh tsc, unittest bridge, `check-docs`.
  - App dev với dữ liệu giả: bình luận và khách giả; tab Khách tiềm năng, cấu hình, Thu bình luận ở 1280 và 390 px, sáng và tối.
  - **Không** bấm thu thật vào bài người khác. Nếu chạy thử tự thu thì chỉ với profile chưa đăng nhập, để kiểm nhánh hết phiên.
  - Hồi quy: Đăng Facebook, lịch, theo dõi bài, chiến dịch, điểm nhóm, Thu bình luận tay, Nghiên cứu.
- [ ] **Step 3:**
  - Version 26.24.0, changelog, dòng phiên bản trong tài liệu.
  - Spec: Trạng thái "Đã phát hành 26.23.0 (D + F) và 26.24.0 (E)", ghi chú sau phát hành cho E.
  - Plan thêm "Điều chỉnh khi triển khai".
  - Merge `main`, tag; anh push; kiểm tra CI.

## Điều chỉnh khi triển khai

- Task 4: thêm `loginProblemOfUrl` và `stopOnLoginProblem` vào `collectComments`.
- Task 5: thêm bộ chuyển `leadWiring.ts` có timeout.
- Task 7: `listComments` trả thêm `leadKeys`.
- Vòng sửa 7f2297d: I1–I4 và các lỗi nhỏ.
- Sửa của controller 35a79e9: hoãn bài của profile đang bận.
- Sửa của controller b4d54a6: độ rộng popover.
- Sửa Task 7 375741a: link an toàn và giữ cài đặt chưa lưu.
