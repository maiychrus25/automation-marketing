# Approved Engagement Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot đưa gợi ý bình luận góp ý/giải đáp vào hàng chờ trong MaiHub; anh duyệt từng gợi ý bằng nút trong app; app chỉ đăng nguyên văn câu đã duyệt.

**Architecture:** Bảng hàng chờ `fb_poster_engagement_items` + `engagementOperations` (kiểm tra, hết hạn, quyết định). Control API chỉ có `suggest/list/withdraw/readComments`; duyệt/bỏ chỉ qua IPC boss-only của renderer. Gợi ý đã duyệt chạy bằng side job `EngagementPoster` (mẫu `LeadReplier`) trên `ProfileJobQueue`, dùng lại `postFirstComment`; giới hạn qua `AutonomyLimiter` với hai action mới.

**Tech Stack:** TypeScript/Electron, React 18, better-sqlite3, Jest (ts-jest, node env), Python stdlib bridge. Không dependency mới.

**Spec:** `docs/specs/2026-11-02-approved-engagement-comments.md` (anh duyệt 02/11/2026); nền: `docs/specs/2026-11-01-bounded-autonomous-operation.md`.

**Trạng thái:** Anh duyệt plan ngày 02/11/2026. Đã triển khai, gộp vào `main` và phát hành trong 26.34.0 (03/11/2026); chưa kiểm trên app Electron/Facebook thật.

**Phương thức thực thi:** subagent-driven (như đợt trước). Nhánh `feat/approved-engagement`, không commit khi anh chưa cho phép.

## Global Constraints

- Trần mặc định: `engagementSuggestionsPerDay = 20` (theo profile), `engagementCommentsPerDay = 10` (theo profile, tính vào `facebookActionsPerDay`); gợi ý hết hạn 24 giờ (`ENGAGEMENT_TTL_MS = 86_400_000`); bộ đếm `engagementSlots` chỉ > 0 khi profile có < 10 gợi ý `pending` (`ENGAGEMENT_MAX_PENDING = 10`).
- Câu bình luận: 1–600 ký tự sau trim, không chứa link (URL, `www.`, tên miền dạng `x.y`) — sai thì `INVALID_PARAMS`.
- Mỗi `(profile_id, post_key)` tối đa một dòng ở `pending|approved|posting|posted|failed|uncertain`; trùng → `CONFLICT`.
- **Control API không có thao tác duyệt/sửa/đăng**; không method nào ghi `approved_text` hay chuyển sang `approved`. Duyệt/bỏ chỉ qua IPC `engagement:approve` / `engagement:reject`, boss-only (không cho nhân viên, không relay).
- Không duyệt hàng loạt: mỗi lệnh duyệt đúng một `id`.
- Đăng: chịu giờ im lặng (chờ nếu còn trong 24 giờ kể từ lúc duyệt, quá thì `skipped: expired_after_approval`) và profile đang dừng (`skipped`, trả chỗ); **không** phụ thuộc `enabled` và `protectedWritesEnabled`.
- Giữ chỗ `engagement_comment` lúc duyệt; trả chỗ khi dừng trước khi bấm gửi; giữ chỗ nếu đã bấm gửi; không thử lại.
- `engagement.suggest` dùng action `engagement_suggest` (đếm cả khi `enabled=false`, không gate công tắc); `engagement.readComments` là đọc Facebook nên chịu giờ im lặng và profile đang dừng.
- Không log nội dung của người khác ngoài trích đoạn đã lưu; không log cookie/token/HTML. Không cơ chế né phát hiện.
- Identifier tiếng Anh, copy tiếng Việt; UI theo `DESIGN.md`; schema chỉ cộng thêm; cập nhật `SYSTEM_DOCUMENTATION.md` + protocol trong task sở hữu; `node scripts/check-docs.js` sạch.
- Không thêm dependency, không tăng version, không đụng `sites/` hay spec website; không commit/push.

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
Nhiễu console baseline 12 error / 2 warn.

## Rulings

- **R1 — Trả lời bình luận (kiểu `reply`) chờ mẫu HTML thật.** Task 5 chỉ bắt đầu khi có file mẫu anh lưu (bài công khai có bình luận). Nếu chưa có lúc tới Task 5: `engagement.suggest` từ chối `kind:'reply'` bằng `INVALID_PARAMS` "Trả lời bình luận chưa hỗ trợ", Task 5 hoãn, các task khác vẫn chạy.
- **R2 — Khoá bài** dùng hàm chuẩn hoá URL bài đang dùng cho chống trùng lead/bình luận (`collectComments.ts`); không viết bộ chuẩn hoá mới.
- **R3 — Hai action mới không theo quy tắc `origin`**: luôn đếm, không gate `enabled`/`master`; `engagement_comment` chịu giờ im lặng + profile dừng và tính vào `facebookActionsPerDay`; `engagement_suggest` không phải thao tác Facebook.

## Review Focus

1. **Bot tìm được đường duyệt** (method Control API mới, relay IPC, sửa `approved_text` qua `suggest`/`withdraw`): không được. Test ở Task 2 (`controlApiCannotApproveOrEdit`) và Task 3 (`approveChannelIsBossOnly`).
2. **Duyệt gợi ý đã hết hạn / đã quyết / bị rút giữa chừng** (anh mở thẻ lâu rồi bấm): từ chối rõ ràng, không đăng. Test Task 2 (`approveRejectsExpiredDecidedOrWithdrawn`).
3. **App khởi động lại khi đang đăng**: `posting` → `uncertain`, giữ chỗ, không đăng lại. Test Task 3 (`postingBecomesUncertainAfterRestart`).
4. **Câu anh sửa có link hoặc rỗng**: bị chặn như câu của bot. Test Task 2 (`editedTextIsValidatedLikeSuggestion`).
5. **Bài đã bị xoá / nhóm chưa tham gia / tắt bình luận**: `skipped` với lý do, trả chỗ, không thử lại. Test Task 3 (`unavailablePostSkipsAndReleases`).

---

## File structure

| Trách nhiệm | File mới | File sửa |
|---|---|---|
| Giới hạn | — | `src/services/autonomy/autonomyPolicy.ts`, `AutonomyLimiter.ts` |
| Hàng chờ + quyết định | `src/services/facebookPoster/engagementRules.ts` (kiểm câu, khoá, hết hạn — thuần), `src/services/facebookPoster/engagementOperations.ts` | `schema.ts`, `FacebookPosterStore.ts`, `src/models/facebookPoster.ts` |
| Control API | — | `ControlMethods.ts`, `controlEvents.ts`, `electron/ipc/controlApiIpc.ts`, protocol doc |
| Đăng | `src/services/facebookPoster/EngagementPoster.ts` | `electron/ipc/facebookPosterIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/services/http/relayChannelPolicy.ts` (nếu danh sách cần tên kênh) |
| Đọc bình luận | — | `collectComments.ts` (chế độ chỉ đọc nếu cần), `facebookPosterIpc.ts` |
| Trả lời bình luận (R1) | `src/services/facebookPoster/commentReply.ts` + fixture | `EngagementPoster.ts` |
| Bridge/báo cáo | — | `autonomyDueWork.ts`, `NotificationScheduler.ts`, `maihub_bridge.py`, bridge tests/README |
| UI | `src/ui/features/facebookPoster/EngagementTab.tsx`, `src/ui/features/facebookPoster/engagementView.ts` | `FacebookPosterView.tsx` |

**Quy ước mọi task:** baseline snapshot trước, "Inspect diff" thay cho commit (như plan 2026-11-01).

---

### Task 1: Giới hạn cho gợi ý và bình luận được duyệt

**Files:** Modify `src/services/autonomy/autonomyPolicy.ts`, `src/services/autonomy/AutonomyLimiter.ts`, `SYSTEM_DOCUMENTATION.md`. Test: bổ sung `src/__tests__/autonomy/autonomyPolicy.test.ts`, `AutonomyLimiter.test.ts`.

**Interfaces:**
- Produces: `AutonomyPolicy` thêm `engagementSuggestionsPerDay` (mặc định 20) và `engagementCommentsPerDay` (mặc định 10), cả hai trong `COUNT_FIELDS`; `AutonomyAction` thêm `'engagement_suggest' | 'engagement_comment'`; `AutonomyUsage.profiles[id]` thêm `engagementSuggestions`, `engagementComments`; `AutonomySummary` thêm `engagementSuggested`, `engagementPosted`.
- Quy tắc (R3): hai action luôn đếm bất kể `origin`; không kiểm `master_off`/`stopped`; `engagement_comment` kiểm `quiet_hours`, `profile_paused`, trần riêng và `facebookActionsPerDay`; `engagement_suggest` chỉ kiểm trần riêng.

- [ ] **Step 0:** baseline.
- [ ] **Step 1: Test hỏng** — `engagementDefaultsMatchSpec` (20, 10), `suggestCountsWhenAutonomyDisabled`, `suggestCapIsPerProfile` (lượt 21 → `LIMIT_REACHED` `quota`), `engagementCommentIgnoresSwitchesButRespectsQuietAndPause`, `engagementCommentCountsTowardFacebookActions` (đủ 12 thao tác → bị từ chối dù trần riêng còn), `summaryCountsEngagement`.
- [ ] **Step 2:** chạy → FAIL. **Step 3:** cài đặt; dấu `docs-check` cho hai mặc định mới. **Step 4:** chạy `src/__tests__/autonomy` (UTC + New_York) → PASS. **Step 5:** docs + `check-docs`. **Step 6:** Inspect diff.

### Task 2: Hàng chờ, quyết định và Control API (không có duyệt)

**Files:** Create `src/services/facebookPoster/engagementRules.ts`, `src/services/facebookPoster/engagementOperations.ts`; Modify `schema.ts` (bảng theo spec §4 + index `(profile_id, post_key)`, `(status, expires_at)`), `FacebookPosterStore.ts`, `src/models/facebookPoster.ts`, `ControlMethods.ts` (port `EngagementPort`), `controlEvents.ts`, `electron/ipc/controlApiIpc.ts`, `ControlMethods.test.ts` (đếm method), protocol doc, `SYSTEM_DOCUMENTATION.md`. Test: `src/__tests__/facebookPoster/engagementOperations.test.ts`, `src/__tests__/control/engagementMethods.test.ts`.

**Interfaces:**
- Produces (`engagementRules.ts`, thuần): `ENGAGEMENT_TTL_MS = 86_400_000`; `ENGAGEMENT_MAX_PENDING = 10`; `validateEngagementText(text: unknown): string` (trim, 1–600, ném `Error` tiếng Việt khi có link); `containsLink(text: string): boolean`.
- Produces (`engagementOperations.ts`): `createEngagementOperations(deps: { store; limiter(): AutonomyLimiter; now(): number; emit(type, payload): void; profileExists(id: string): boolean; enqueuePost(id: number): void })` trả `{ suggest(params); list(params); withdraw(params); approve(id: number, text?: string); reject(id: number, reason?: string); expireDue(): number }`. `approve`/`reject` chỉ được nối vào IPC (Task 3), không vào Control API.
- `suggest` kiểm như spec §5 (R1: `reply` bị từ chối nếu `deps.replySupported !== true`), giữ chỗ `engagement_suggest` + `commit` ngay (gợi ý không có "trước/sau bấm"), INSERT `pending`, `expires_at = now + TTL`, phát `engagement.suggested`.
- `approve(id, text?)`: chỉ `pending` chưa hết hạn; `text ?? suggested_text` qua `validateEngagementText`; `reserve({action:'engagement_comment', origin:'app', profileId})`; ghi `approved_text`, `decided_at`, `reservation_id`, `approved`; phát `engagement.decided`; gọi `enqueuePost(id)`.
- `reject` → `rejected`; `withdraw` chỉ `pending` → `rejected` với `reject_reason='withdrawn_by_bot'`.
- Control methods (chỉ owner): `engagement.suggest`, `engagement.list`, `engagement.withdraw` (`engagement.readComments` ở Task 4).

- [ ] **Step 0:** baseline.
- [ ] **Step 1: Test hỏng** — `suggestValidatesTextLinksAndLength`, `suggestRejectsDuplicatePostForProfile`, `suggestStopsAtTwenty`, `replyRejectedUntilSupported`, `pendingExpiresAfter24h`, `approveUsesEditedTextAndReserves`, `editedTextIsValidatedLikeSuggestion`, `approveRejectsExpiredDecidedOrWithdrawn`, `approveStopsAtTenPerProfile`, `controlApiCannotApproveOrEdit` (không method nào trong `createControlMethods` có tên chứa `approve`/`reject`/`edit`/`post` cho engagement; `suggest`/`withdraw` không nhận trường `approvedText`/`status` → `INVALID_PARAMS`), `engagementMethodsAreOwnerOnly`.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt. **Step 4:** chạy `src/__tests__/facebookPoster src/__tests__/control` → PASS. **Step 5:** docs. **Step 6:** Inspect diff.

### Task 3: Đăng gợi ý đã duyệt (bình luận mới) và IPC duyệt

**Files:** Create `src/services/facebookPoster/EngagementPoster.ts`; Modify `electron/ipc/facebookPosterIpc.ts` (dựng như `LeadReplier`, đăng ký cancel/wait/busy, `recover()` lúc start scheduler; IPC `engagement:list`, `engagement:approve`, `engagement:reject`), `electron/preload.ts`, `src/ui/lib/ipc.ts`, relay policy nếu cần, `SYSTEM_DOCUMENTATION.md`. Test: `src/__tests__/facebookPoster/EngagementPoster.test.ts`, bổ sung `src/__tests__/http/relayChannelPolicy.test.ts`.

**Interfaces:**
- Consumes: Task 2 `createEngagementOperations` (`enqueuePost`), Task 1 limiter, `postFirstComment(page, { postUrl, comment, text }, { sendLog, getIsStopping })`.
- Produces: `EngagementPoster { enqueue(id: number): void; recover(): void; cancel(): void; isRunning(): boolean; whenIdle(): Promise<void> }` — học đúng các sửa của `LeadReplier` (reset `cancelled` khi idle, `recover()` chỉ khi không có job đang chạy).
- Job: `posting` → kiểm lại `approved`, đúng profile/post, `now - decided_at < TTL` → `limiter.assertEffect(reservation)` (giờ im lặng: đặt lại chờ tới `retryAt` nếu còn trong TTL, không thì `skipped: expired_after_approval` + `release`) → `postFirstComment` với `comment = approved_text`, `text = post_excerpt` → `posted` (`commit`) | `post_not_found`/`pending_approval`/`no_post_url` → `skipped` (`release`) | `failed` → `failed` (`commit`) | ném → `uncertain`. Phát `engagement.finished`.
- IPC duyệt boss-only: `isEmployeeChannelAllowed('engagement:approve') === false` (tương tự cho `reject`).

- [ ] **Step 0:** baseline.
- [ ] **Step 1: Test hỏng** — `approvedItemPostsExactApprovedText`, `unavailablePostSkipsAndReleases`, `failedAfterClickKeepsReservationNoRetry`, `quietHoursDefersThenExpires`, `pausedProfileSkipsAndReleases`, `postingBecomesUncertainAfterRestart`, `approveChannelIsBossOnly`.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt. **Step 4:** chạy `src/__tests__/facebookPoster src/__tests__/http src/__tests__/autonomy` → PASS. **Step 5:** docs. **Step 6:** Inspect diff.

### Task 4: Đọc bình luận của bài ứng viên (`engagement.readComments`)

**Files:** Modify `collectComments.ts` (chỉ nếu cần một tuỳ chọn trả kết quả mà không lưu), `electron/ipc/facebookPosterIpc.ts`, `ControlMethods.ts`, protocol doc, `SYSTEM_DOCUMENTATION.md`. Test: `src/__tests__/facebookPoster/engagementReadComments.test.ts`.

**Interfaces:**
- Produces: method `engagement.readComments { profileId: string; postUrl: string }` → `{ comments: Array<{ authorName: string; text: string; commentedAt: string }> }` (tối đa 50, `text` cắt 500 ký tự; không trả `authorId`/`authorUrl`); dùng `collectComments` với một bài, `maxPerPost: 50`, `stopOnLoginProblem: true`, chạy như side job nền trên profile (BUSY nếu profile đang bận theo cơ chế hàng đợi hiện có). Không ghi `fb_poster_comments`/`fb_poster_leads`.
- Gate: `limiter.check` cho giờ im lặng và profile dừng (không đếm trần); checkpoint/đăng xuất → `observeLogin` như các job khác.

- [ ] **Step 0:** baseline.
- [ ] **Step 1: Test hỏng** — `readCommentsReturnsTrimmedListWithoutSaving`, `readCommentsRefusedInQuietHoursOrPaused`, `readCommentsLoginProblemPausesProfile`.
- [ ] **Step 2:** FAIL. **Step 3:** cài đặt. **Step 4:** chạy liên quan → PASS. **Step 5:** docs. **Step 6:** Inspect diff.

### Task 5: Trả lời một bình luận (`kind: 'reply'`) — chờ mẫu HTML (R1)

**Điều kiện bắt đầu:** có file mẫu thật do anh lưu (bài công khai có bình luận). Controller làm fixture tối thiểu đã lọc (không tên/ảnh/ID thật) trong `src/__tests__/facebookPoster/fixtures/comment-reply.html`. Không có mẫu → hoãn task, giữ R1.

**Files:** Create `src/services/facebookPoster/commentReply.ts` + fixture; Modify `EngagementPoster.ts`, `engagementOperations.ts` (`replySupported: true`), docs. Test: `src/__tests__/facebookPoster/commentReply.test.ts`.

**Interfaces:**
- Produces: `postCommentReply(page: Page, input: { postUrl: string; target: { commentId?: string; author?: string; excerpt?: string }; text: string }, deps: { sendLog?; getIsStopping? }): Promise<{ status: 'posted' | 'target_not_found' | 'post_not_found' | 'failed'; reason: string }>` — không ném; tìm đúng **một** bình luận khớp (`commentId`, hoặc tác giả + trích đoạn), bấm "Trả lời", gõ, gửi, đọc lại xác nhận câu nằm dưới đúng bình luận; nhiều hoặc không khớp → `target_not_found` trước khi gõ.
- `EngagementPoster`: `kind='reply'` dùng hàm này; `target_not_found` → `skipped` + `release`.

- [ ] **Step 1: Test hỏng** (fixture + fake page) — `replyFindsUniqueTargetAndVerifies`, `ambiguousOrMissingTargetSkipsBeforeTyping`, `replyResultMapsToItemStatus`.
- [ ] **Step 2–6:** như các task khác.

### Task 6: Vòng `auto-tick`, tin 🗂 và báo cáo 📊

**Files:** Modify `src/services/autonomy/autonomyDueWork.ts` (`engagementSlots`), `NotificationScheduler.ts` (summary có engagement), `tools/maihub-bridge/maihub_bridge.py` (prompt, 🗂, `_metrics_lines`), bridge tests/README, `SYSTEM_DOCUMENTATION.md`. Test: bổ sung `autonomyOperations.test.ts`, `NotificationScheduler.test.ts`, `tools/maihub-bridge/tests/test_bridge.py`.

**Interfaces:**
- `AutonomyDueWork.engagementSlots: number` = tổng theo profile Page đã học, không dừng, của `min(engagementSuggestionsPerDay − đã dùng hôm nay, ENGAGEMENT_MAX_PENDING − số pending)` khi > 0.
- `build_auto_prompt`: thêm mục khi `engagementSlots > 0` — tìm bài/bình luận đáng góp ý hoặc giải đáp theo chủ đề Page bằng `research.*` và `engagement_readComments`, soạn câu hữu ích không link, gửi bằng `engagement_suggest`; nêu "anh sẽ duyệt trong app; bot không đăng được bình luận vào bài của người khác".
- Sau agent, nếu `autonomy.status` mới cho thấy số `pending` tăng (hoặc dùng `engagement.list` `status:'pending'` với `suggestedAt` sau lúc bắt đầu tick), bridge gửi đúng một tin: `🗂 Có N gợi ý bình luận mới chờ anh duyệt trong MaiHub:` + mỗi dòng `• <profile>: <trích đoạn 80 ký tự>` (tối đa 10 dòng, phần còn lại `… và K gợi ý khác`).
- `_metrics_lines`: `Bình luận góp ý: N gợi ý, A đã duyệt, P đã đăng, R đã bỏ, E hết hạn.` khi payload có `engagement`.

- [ ] **Step 1: Test hỏng** — Jest: `engagementSlotsRespectCapAndPendingLimit`, `metricsReportIncludesEngagement`; Python: `test_auto_prompt_engagement_has_no_posting_tool`, `test_auto_tick_sends_one_pending_digest`, `test_metrics_lines_engagement`.
- [ ] **Step 2–6:** như các task khác (chạy cả Python).

### Task 7: Giao diện "Chờ duyệt"

**Files:** Create `src/ui/features/facebookPoster/EngagementTab.tsx`, `src/ui/features/facebookPoster/engagementView.ts`; Modify `FacebookPosterView.tsx` (section `'engagement'`, nhãn "Chờ duyệt" + số đếm; ẩn ở chế độ nhân viên), `SYSTEM_DOCUMENTATION.md`. Test: `src/__tests__/ui/engagementView.test.ts` (logic thuần, như Task 10 đợt trước) + harness Playwright-core trong scratch.

**Interfaces:**
- Consumes: IPC `engagement:list/approve/reject` (Task 3), `browserProfile.list()` cho tên profile.
- Thẻ theo spec §10; nút **Duyệt** chỉ gửi đúng một `id` (có `text` nếu anh sửa); **Bỏ** hỏi lý do tuỳ chọn; lỗi `INVALID_PARAMS` hiện dưới ô câu; đếm ngược hết hạn; bộ lọc trạng thái.

- [ ] **Step 1: Test hỏng** — `cardRowsShowExpiryAndKind`, `approvePayloadCarriesSingleIdAndEditedText`, `linkInEditedTextShowsFieldError`, `filtersByStatus`.
- [ ] **Step 2–4:** cài đặt; harness 1280/390 × sáng/tối: không tràn ngang, không chữ đè, Duyệt/Bỏ bấm được. **Step 5:** docs. **Step 6:** Inspect diff.

### Task 8: Tích hợp, tài liệu, kiểm chứng

**Files:** Create `src/__tests__/facebookPoster/approvedEngagement.integration.test.ts`; Modify protocol doc, `SYSTEM_DOCUMENTATION.md`, spec (Trạng thái + "Ghi chú sau triển khai", gồm tình trạng R1).

- [ ] **Step 1: Test tích hợp** — `suggestApprovePostEndToEnd` (suggest qua method → approve qua operations → job đăng → 📊), `botPathNeverReachesApproved` (gọi mọi method Control API engagement với mọi tham số hợp lệ, không dòng nào thành `approved`), `expiryAndCapsShareLedger`.
- [ ] **Step 2:** sửa chỗ nối nếu thiếu (không đổi hợp đồng đã review). **Step 3:** docs. **Step 4:** chạy đủ bộ lệnh kiểm chứng hai vòng; nhiễu không vượt 12/2. **Step 5:** Inspect diff toàn nhánh so `e4a6dc7`.
