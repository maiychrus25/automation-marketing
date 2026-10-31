# Page Publish Proof, Page Metrics and Notification Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bài đăng lên Page qua app có ID/link được xác minh đúng chủ Page, có số liệu theo mốc 1 giờ / 1 ngày / 3 ngày, số người theo dõi theo ngày, số liệu thật cho chiến dịch Page, báo cáo 📊 theo lịch và tin 🎯 được gom.

**Architecture:** Mở rộng đúng một cơ chế theo dõi sẵn có (`fb_poster_post_tracking` + `PostTracker` + `PostTrackScheduler`) bằng cột `target_kind/page_id` và một nhánh đọc Page dùng `readPageIdentity`; bài nhóm giữ nguyên đường đi. Chiến dịch gắn bài qua một hàm bind duy nhất gọi từ lúc tạo dòng và lúc tracker xác nhận; số liệu chiến dịch đọc từ `fb_poster_post_stats`. Báo cáo/gom tin là một scheduler 60 giây cạnh `PostTrackScheduler`, trạng thái lưu trong `app_settings` và phát sự kiện Control API trong cùng transaction SQLite.

**Tech Stack:** TypeScript/Electron, React 18, SQLite/better-sqlite3, Jest (ts-jest isolatedModules), Playwright-core có sẵn cho harness UI trong scratch, Python stdlib bridge. Không dependency mới.

**Spec:** `docs/specs/2026-10-31-page-publish-proof-metrics.md` — anh duyệt ngày 31/10/2026; là nguồn thẩm quyền khi plan và spec lệch nhau.

**Trạng thái:** Anh duyệt plan ngày 31/10/2026. Đã triển khai ở dev (2026-10-31) trên nhánh `feat/26.33-page-publish-proof-metrics`, chưa kiểm trên app Electron/Facebook thật, chưa phát hành; version không đổi.

**Phương thức thực thi:** subagent-driven (anh đã chọn). Mỗi task một implementer mới + một reviewer mới, review toàn nhánh ở cuối.

## Global Constraints

- Bắt link lúc đăng giữ `LINK_CAPTURE_MAX_WAIT_MS = 8000` (kiểm mỗi 250 ms); đường bắt link bài nhóm không đổi.
- Lịch dùng chung với bài nhóm: `linkRetryMinutes` 30, 120, 360, 1440, 2880, 4320, 10080; `statsAtMinutes` 60, 1440, 4320; mốc trễ quá 24 giờ thì bỏ (`STATS_OVERDUE_LIMIT_MS`); tick theo dõi 15 phút (`TRACK_TICK_MINUTES`).
- Tìm lại bài Page: đầu nội dung khớp `text_head` (60 ký tự đầu sau `normalizeHead`) **và** `postedAt` trong ±15 phút, nhận khi khớp **đúng một**; 0 hoặc > 1 thì giữ chờ, hết lịch 7 ngày thì `not_found`. Bộ đọc Page tối đa `MAX_POSTS = 10` bài.
- Cấu hình thông báo mặc định `{ reportCadence: 'weekly', reportHour: 8, reportWeekday: 1 (thứ Hai), leadDigestMinutes: 60 }`; `reportCadence` ∈ `off|daily|weekly`, `reportHour` 0–23, `reportWeekday` 1–7 (1 = thứ Hai … 7 = Chủ nhật), `leadDigestMinutes` ∈ 0|15|30|60|120|240, `0` = gửi ngay như trước.
- Người theo dõi: tối đa một bản ghi mỗi Page mỗi ngày địa phương (`UNIQUE(page_id, captured_on)`); trường chưa xác minh bằng mẫu phản hồi thật đã lọc token/cookie thì là `null`, không đoán.
- Không ghi số 0 giả, không đoán bài, không đăng lại; mọi thay đổi chiến dịch không tạo lượt đăng mới. `protectedWritesEnabled` cấu hình thật vẫn `false`.
- Schema chỉ thêm qua `FB_POSTER_SCHEMA_SQL` / `FB_POSTER_MIGRATIONS` trong `ensureSchema` hiện có; không xóa/sửa dữ liệu cũ. Dòng cũ tự là `target_kind = 'group'`.
- Hành vi bài nhóm không đổi: mọi test nhóm hiện có giữ xanh; chỉ được sửa test hiện có khi spec đổi hợp đồng (liệt kê rõ ở từng task).
- Test không phụ thuộc giờ thật hay múi giờ máy: inject `now`, `timeZone`, `localDate`; mọi ca múi giờ truyền zone tường minh (`America/New_York`, `Asia/Ho_Chi_Minh`). Không dựng composition IPC có `LoginCheckScheduler` 07:00 trong test mới.
- Không gọi Facebook/Telegram thật; fixture không chứa cookie, token, `fb_dtsg` hay HTML thô chưa lọc. Identifier tiếng Anh, copy UI/tin tiếng Việt; UI dùng token `DESIGN.md`.
- Không thêm dependency, không tăng `version`, không đụng `docs/specs/2026-10-30-ahv-modnix-website-foundation.md` hay `sites/`. Không stage/commit/push khi anh chưa cho phép: bước "Commit" của skill thay bằng kiểm diff so baseline.
- `RULES.md`, `WORKFLOW.md`, `~/.codex/rules/core/file-creation.md` và `Makefile` không tồn tại lúc lập plan: ghi nhận, không tạo bản thay thế; `make build/test/lint` chỉ được ghi là blocker.
- Đổi hành vi/giới hạn/IPC/schema phải cập nhật `SYSTEM_DOCUMENTATION.md` (kèm dấu `docs-check` cho hằng số mới) ngay trong task sở hữu; `node scripts/check-docs.js` sạch trước khi báo xong.

## Review Focus

1. **Dòng Page lọt vào đường bài nhóm** (điểm nhóm, `listDuePairs` nhóm, bộ đọc feed nhóm, thu bình luận): người dùng chỉ đăng nhóm phải thấy điểm/báo cáo nhóm y như trước, không có "nhóm" `https://www.facebook.com/` — test ở Task 1 (`groupScoreInputsIgnorePageRows`, `groupPairsNeverIncludePageRows`) và Task 3 (`pageRowsGetNoCommentSchedule`).
2. **Múi giờ / DST / máy ở múi khác cấu hình**: báo cáo tuần qua đêm đổi giờ Mỹ (1/11/2026) vẫn đúng một kỳ, khóa kỳ theo ngày lịch địa phương — test Task 5 (`weeklyKeyAcrossUsDstEnd`, `processTimezoneDoesNotChangeKey`).
3. **Hai bài/dòng cùng nội dung trong 15 phút** (đăng lặp, A/B cùng câu đầu): không gắn nhầm; chỉ gắn khi bài↔dòng khớp một-một — test Task 3 (`twoMissingRowsSameHeadStayMissing`, `twoCandidatePostsStayMissing`).
4. **Crash/lỗi ghi giữa phát sự kiện và ghi trạng thái**: không mất, không trùng tin 📊/🎯 — test Task 5 (`failedPublishLeavesStateForRetry`, `digestSurvivesRestartWithoutLossOrDuplicate`).
5. **Facebook đổi dạng ID/chủ bài hoặc profile đổi Page**: `postId` khác định dạng (pfbid ↔ số), owner thiếu, bộ đọc trả Page khác `page_id` của dòng → "không có dữ liệu"/giữ chờ, không ghi số của bài khác — test Task 1 (`pageModeRejectsForeignMissingOrConflictingOwner`) và Task 3 (`readerPageMismatchConcludesNothing`, `knownPostAbsentFromRecentTenMarksMilestoneWithoutStats`).

---

## File structure và quyết định tích hợp

| Trách nhiệm | File mới | File hiện có cần sửa |
|---|---|---|
| Bắt link + xác minh chủ Page | — | `src/services/facebookPoster/postToTargets.ts`, `types.ts` |
| Dòng theo dõi Page, schema, store | — | `FacebookPosterService.ts`, `schema.ts`, `FacebookPosterStore.ts`, `src/models/facebookPoster.ts` |
| Bộ đọc Page | — | `src/services/dailyBrief/pageIdentity.ts`, `src/models/dailyBrief.ts` |
| Nguồn Page của tracker | — | `PostTracker.ts`, `postTracking.ts` (hằng số + matcher thuần) |
| Chiến dịch | — | `PageCampaignExecutionStore.ts`, `PageCampaignStore.ts`, `PageCampaignTracker.ts` |
| Thông báo | `src/services/facebookPoster/notificationRules.ts` (cấu hình, kỳ báo cáo — thuần), `src/services/facebookPoster/NotificationScheduler.ts` (timer, báo cáo, gom tin) | `src/services/control/controlEvents.ts` |
| API/IPC | — | `ControlMethods.ts`, `electron/ipc/facebookPosterIpc.ts`, `electron/ipc/controlApiIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts` |
| Bridge | — | `tools/maihub-bridge/maihub_bridge.py`, `tests/test_bridge.py`, `README.md` |
| UI | — | `PerformancePanel.tsx`, `TrackConfigPopover.tsx`, `trackingFormat.ts`, `HistoryTab.tsx` (chỉ chip/lý do) |
| Tích hợp | `src/__tests__/facebookPoster/pagePublishProof.integration.test.ts` | docs |

`PostTrackScheduler.ts` không cần sửa: cặp Page đi qua `duePairs` sẵn có. Không thêm bảng hàng chờ khách: hàng chờ là các dòng `fb_poster_leads` sau con trỏ bền `(detected_at, id)` (xem Task 5), vì `leads.found` chỉ mang tối đa 20 `leadIds`.

**Quy ước mọi task:** Step 0 chụp baseline `git status --porcelain > "$SCRATCH/tN.status"` và `git diff HEAD > "$SCRATCH/tN.base.diff"` (`$SCRATCH` = scratchpad phiên, ngoài repo). Bước cuối là **Inspect diff**: `git diff HEAD > "$SCRATCH/tN.after.diff" && diff "$SCRATCH/tN.base.diff" "$SCRATCH/tN.after.diff"` cộng đọc trọn file mới trong `git status --porcelain`; xác nhận chỉ file của task đổi, không đụng thay đổi sẵn có của anh, không commit.

---

### Task 1: Publish proof, dòng theo dõi Page và schema

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts:59-92` (extract/build), `:777-797` (listener), `:911-928` (nhánh `autonomyGuard` + fallback DOM)
- Modify: `src/services/facebookPoster/types.ts:7-21` (`TaskDeps`)
- Modify: `src/services/facebookPoster/FacebookPosterService.ts:33-55` (deps), `:398-406` (`taskDeps`), `:602-631` (`trackPostedResult`)
- Modify: `src/services/facebookPoster/schema.ts:162-182`, `src/services/facebookPoster/FacebookPosterStore.ts:97-121,156-160,581-630,776-818,883-899`, `src/models/facebookPoster.ts:142-179`
- Modify: `electron/ipc/facebookPosterIpc.ts:340-358` (truyền `resolvePageId`)
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts`, `FacebookPosterService.test.ts`, `FacebookPosterStore.test.ts`

**Interfaces:**
- Consumes: `DailyBriefStore.getIdentity(profileId)` (đã có).
- Produces:
  - `src/models/facebookPoster.ts`: `export type TrackTargetKind = 'group' | 'page';` `PostTrackingRow` thêm `targetKind: TrackTargetKind; pageId: string;`.
  - `TaskDeps.expectedPageId?: string` — chỉ có khi `mode === 'page'`; `''` = chưa học được Page → không nhận link.
  - `export function pageCaptureTarget(captured: { postId: string | null; story: { ownerId: string; postId: string } | null; ownerField: string | null }, expectedPageId: string): { postId: string; postUrl: string } | null` trong `postToTargets.ts`.
  - `FacebookPosterServiceDeps.resolvePageId?: (profileId: string) => string` và `onPagePostKnown?: (row: PostTrackingRow) => void`.
  - `FacebookPosterStore.createTracking(row)` nhận thêm `targetKind?` (mặc định `'group'`), `pageId?` (mặc định `''`); `listDuePairs(now, limit): { profileId: string; groupUrl: string; pageId?: string }[]` (chỉ có khóa `pageId` với dòng Page); `listTrackingForPair(profileId: string, groupUrl: string, sinceMs: number, pageId?: string): PostTrackingRow[]`.

- [ ] **Step 0: Baseline** theo quy ước.
- [ ] **Step 1: Viết test đỏ**

```ts
// postToTargets.test.ts — dùng pageSuccessful/makeDeps sẵn có, đích 'https://www.facebook.com/'
test('pageModeAcceptsOnlyOwnerMatchingPage', …) // story_id base64 S:_I1254744041053955:122131435821413743, expectedPageId '1254744041053955'
  expect(r.postUrl).toBe('https://www.facebook.com/1254744041053955/posts/122131435821413743');
test('pageModeRejectsForeignMissingOrConflictingOwner', …)
  // expectedPageId '999' | '' | body không có owner | hai "owner_id" khác nhau | story.postId ≠ "post_id"
  expect(r.postUrl).toBeNull(); expect(evaluated).not.toContain('findOwnPostLinkInPage');
test('pageModeAcceptsUniqueOwnerIdFallback', …) // '{"data":{"story_create":{"post_id":"555","owner_id":"777"}}}', expectedPageId '777'
  expect(r.postUrl).toBe('https://www.facebook.com/777/posts/555');
// Sửa test autonomy hiện có (~:438-456) theo spec 4.1: body có chủ = expectedPageId → postUrl khác null,
// vẫn không có 'comment-send'/'Enter', commentStatus giữ 'no_post_url'; body thiếu chủ → postUrl null.
// FacebookPosterService.test.ts
test('pageModeCreatesPageTrackingRowForLearnedPage') // resolvePageId → '777', postUrl 'https://www.facebook.com/777/posts/555'
  expect(row).toMatchObject({ targetKind:'page', pageId:'777', groupUrl:'https://www.facebook.com/', postId:'555',
    linkStatus:'known', nextCheckAt:1_000_000 + 60*60_000, nextCommentAt:null });
test('pageModeWithoutLinkIsMissingWithFirstRetryAt30Min')  // nextCheckAt 1_000_000 + 30*60_000; pageId '' khi chưa học → missing, postUrl null
test('passesExpectedPageIdOnlyInPageMode')                 // page → '777'; group → undefined
test('onPagePostKnownFiresOnceForKnownPageRowNeverForGroup')
test('campaignUncertainPageResultCreatesMissingRowOwnerUncertainDoesNot') // errorCode 'uncertain_after_submit' + autonomyGuard
// Tách test hiện có 'page mode, failed posts and non-post kinds create no rows' thành 'failed posts and non-post kinds create no rows' (bỏ phần page — spec đổi hợp đồng).
// FacebookPosterStore.test.ts
test('migrationsDefaultExistingRowsToGroup')  // bảng cũ không cột → ensureSchema → targetKind 'group', pageId ''
test('groupPairsNeverIncludePageRows')        // group pair không có khóa pageId; 2 Page cùng profile → 2 pair có pageId
test('listTrackingForPairSeparatesKinds')     // không pageId → chỉ group; có pageId → chỉ Page đó
test('groupScoreInputsIgnorePageRows')        // statsReport groupBy 'group' và groupScoreInputs không có key 'https://www.facebook.com/'
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/facebookPoster/postToTargets.test.ts src/__tests__/facebookPoster/FacebookPosterService.test.ts src/__tests__/facebookPoster/FacebookPosterStore.test.ts`. Kỳ vọng: các ca mới FAIL (postUrl khác null với chủ lạ / không có dòng Page / thiếu `targetKind`), ca nhóm hiện có PASS.
- [ ] **Step 3: Cài đặt**
  - Schema: thêm vào `FB_POSTER_MIGRATIONS` `ALTER TABLE fb_poster_post_tracking ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'group'`, `ADD COLUMN page_id TEXT NOT NULL DEFAULT ''`, `CREATE INDEX IF NOT EXISTS idx_fb_poster_post_tracking_page ON fb_poster_post_tracking(profile_id, target_kind, page_id)`. `mapTracking`/`createTracking` đọc-ghi hai cột.
  - Listener giữ `capturedStory` (từ `extractStoryOwnerFromBody`) và `capturedOwnerField` (giá trị `"owner_id":"(\d+)"` chỉ khi mọi lần xuất hiện trong thân mutation bằng nhau). Khi `typeof deps.expectedPageId === 'string'`: `postUrl = pageCaptureTarget(...)?.postUrl ?? null`, **không** gọi `findOwnPostUrl`; `pendingApproval` giữ nguyên. Khi `expectedPageId` vắng: giữ nguyên đường cũ (test nhóm/đích Page cũ không đổi).
  - `pageCaptureTarget`: owner = `story?.ownerId ?? ownerField`; null nếu `!expectedPageId`, owner ≠ `expectedPageId`, thiếu `postId`, hoặc `story && story.postId !== postId`; URL chuẩn `https://www.facebook.com/${expectedPageId}/posts/${postId}`.
  - Nhánh `autonomyGuard` (`:911-916`): không còn trả `postUrl:null` cố định — dùng `postUrl` đã xác minh; vẫn return sớm, không bình luận (sub-project B), `commentStatus` như cũ.
  - `taskDeps.expectedPageId = this.deps.resolvePageId?.(profileId) ?? ''` chỉ khi `params.mode === 'page'`.
  - `trackPostedResult`: nhận `mode === 'page'` (`targetKind 'page'`, `pageId` = `resolvePageId`, `groupId ''`, `postId` từ URL; URL chỉ được giữ khi `pageId !== ''`), kể cả `errorCode === 'uncertain_after_submit'` khi `active.autonomyGuard` có (`linkStatus 'missing'`); dòng Page **không** đặt `nextCommentAt`. Sau `createTracking` dòng Page `known` gọi `deps.onPagePostKnown?.(row)` trong try/catch log như cũ. Nhánh nhóm giữ nguyên từng dòng.
  - Store: `listDuePairs` GROUP BY thêm `target_kind, page_id`; `listTrackingForPair` không có `pageId` thêm `AND target_kind = 'group'`, có thì `AND target_kind = 'page' AND page_id = ?`; `statsReport` với `groupBy 'group'` thêm `t.target_kind = 'group'`.
  - Composition `facebookPosterIpc.ts:340-358`: `resolvePageId: (id) => { const i = new DailyBriefStore(boundDb).getIdentity(id); return i?.kind === 'page' && !i.errorCode ? i.pageId : ''; }`.
  - `SYSTEM_DOCUMENTATION.md`: mục theo dõi bài — cột mới, quy tắc xác minh chủ Page, dòng Page không thu bình luận.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS toàn bộ; thêm `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Inspect diff** theo quy ước.

### Task 2: Bộ đọc Page giữ postId, người theo dõi và kho người theo dõi

**Files:**
- Modify: `src/models/dailyBrief.ts:3-10`, `src/services/dailyBrief/pageIdentity.ts:13-20,92-104,160-200`
- Modify: `src/services/facebookPoster/schema.ts:13-159` (bảng mới trong `FB_POSTER_SCHEMA_SQL`), `FacebookPosterStore.ts`, `src/models/facebookPoster.ts`
- Test: `src/__tests__/dailyBrief/pageIdentity.test.ts`, `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`

**Interfaces:**
- Produces:
  - `PagePostSample.postId: string` (= `story.post_id`, đã được kiểm tại `postsFromFeeds`).
  - `PageIdentityRead.followers?: number | null` — vắng/`null` = chưa xác minh.
  - `export interface PageFollowerRow { pageId: string; profileId: string; capturedOn: string; capturedAt: number; followers: number }` (models/facebookPoster).
  - `FacebookPosterStore.recordPageFollowers(row: PageFollowerRow): boolean` (INSERT OR IGNORE; true khi ghi mới), `hasPageFollowersOn(pageId: string, capturedOn: string): boolean`, `listPageFollowers(filter: { pageId?: string; sinceDay: string }): PageFollowerRow[]` (sắp `page_id, captured_on`).

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```ts
// pageIdentity.test.ts — cập nhật hằng expectedPost thêm postId theo fixture page-posts.json
it('keepsPostIdOnEachSample', () => expect(parsePagePosts(feed())[0].postId).toBe('300000000000301'));
it('followersStayNullUntilVerifiedFixture', () => expect(parseIdentityHtml(pageHtml, url).followers ?? null).toBeNull());
it('capsRecentPostsAtTen', …) // feed 12 story hợp lệ → length 10
// FacebookPosterStore.test.ts
test('followersAtMostOneRowPerPagePerLocalDay', () => {
  expect(s.recordPageFollowers({pageId:'777',profileId:'p1',capturedOn:'2026-10-31',capturedAt:1,followers:1200})).toBe(true);
  expect(s.recordPageFollowers({…same day, followers:1300})).toBe(false);
  expect(s.listPageFollowers({sinceDay:'2026-10-01'})).toEqual([{…followers:1200}]);
  expect(s.hasPageFollowersOn('777','2026-10-31')).toBe(true);
});
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/dailyBrief/pageIdentity.test.ts src/__tests__/facebookPoster/FacebookPosterStore.test.ts`. Kỳ vọng FAIL: thiếu `postId`, thiếu method store.
- [ ] **Step 3: Cài đặt**
  - `postsFromFeeds` đưa `postId` vào mẫu (giá trị đã đọc ở `:174`). `MAX_POSTS` giữ 10.
  - Người theo dõi: **không đoán đường dẫn trường.** Thêm comment `// shortcut: followers chưa có mẫu phản hồi thật đã lọc; giữ undefined tới khi có fixture page-followers.html` tại chỗ trả kết quả Page. Nếu anh cung cấp mẫu thật đã lọc (`src/__tests__/dailyBrief/fixtures/page-followers.html`, không cookie/token/`fb_dtsg`), mới thêm `pageFollowersFromPayloads(payloads, pageId): number | null` đọc đúng đường trong mẫu đó (chỉ số nguyên an toàn ≥ 0, mâu thuẫn → null) và test với fixture. Chưa có mẫu → ghi blocker trong báo cáo task, không coi là xong phần đọc trường.
  - `FB_POSTER_SCHEMA_SQL` thêm `CREATE TABLE IF NOT EXISTS fb_poster_page_followers (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, profile_id TEXT NOT NULL, captured_on TEXT NOT NULL, captured_at INTEGER NOT NULL, followers INTEGER NOT NULL, UNIQUE(page_id, captured_on))`.
  - Sửa fixture test kiểu `PagePostSample` mà `tsc` báo thiếu `postId`. Mẫu cũ đã lưu trong `fb_page_identities` không có `postId` — chấp nhận (không consumer nào đọc `postId` từ bản lưu); ghi vào `SYSTEM_DOCUMENTATION.md` cùng bảng mới.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS; `npm test -- --runInBand src/__tests__/dailyBrief/PageLearner.test.ts` PASS; `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Inspect diff.**

### Task 3: PostTracker đọc nguồn Page

**Files:**
- Modify: `src/services/facebookPoster/PostTracker.ts:35-43` (`TrackPair`), `:68-83` (deps), `:160-180` (`selectPairs`), `:206-226` (catch), `:249-267` (`trackPair`), thêm nhánh Page cạnh `applyReading` `:338-392`
- Modify: `src/services/facebookPoster/postTracking.ts` (hằng + matcher thuần)
- Modify: `electron/ipc/facebookPosterIpc.ts:515-555` (`getTracker`)
- Test: `src/__tests__/facebookPoster/PostTracker.test.ts`, `src/__tests__/facebookPoster/postTracking.test.ts`

**Interfaces:**
- Consumes: Task 1 `listDuePairs`/`listTrackingForPair(…, pageId)`/`onPagePostKnown`; Task 2 `PageIdentityRead`, `recordPageFollowers`, `hasPageFollowersOn`.
- Produces:
  - `TrackPair { profileId: string; groupUrl: string; pageId?: string }` — có `pageId` (kể cả `''`) là cặp Page.
  - `postTracking.ts`: `export const PAGE_MATCH_WINDOW_MS = 15 * 60_000;` `export function matchPagePosts(rows: Pick<PostTrackingRow, 'resultId' | 'postId' | 'linkStatus' | 'postedAt' | 'textHead'>[], posts: PagePostSample[]): Map<number, PagePostSample>`.
  - `PostTrackerDeps` thêm `readPage?(profileId: string, context: ProfileTaskContext): Promise<PageIdentityRead>`, `localDate?: (ms: number) => string` (mặc định `systemClock.date`), `onPagePostKnown?: (row: PostTrackingRow) => void`; `store` Pick thêm `recordPageFollowers | hasPageFollowersOn`.

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ** (đồng hồ `now` inject, `localDate: ms => new Date(ms).toISOString().slice(0,10)`)

```ts
// postTracking.test.ts — matchPagePosts
test('knownRowMatchesByPostIdOnly')
test('missingRowMatchesExactlyOneWithinFifteenMinutes')   // |Δ| = 15*60_000 khớp; 15*60_000+1 không
test('twoCandidatePostsStayMissing')                      // 2 bài cùng head trong cửa sổ → không khớp
test('twoMissingRowsSameHeadStayMissing')                 // 1 bài, 2 dòng cùng head → không khớp dòng nào
test('postClaimedByKnownRowIsNotReusedForMissingRow')
// PostTracker.test.ts — readPage giả trả { kind:'page', pageId:'777', recentPosts, followers }
test('pagePairReadsPageOnceAndWritesStatsAtDueMilestone')  // 2 dòng cùng (p1,'777') → readPage gọi 1 lần; addPostStats đúng counts
test('pageRowLinkedOnUniqueMatchUsesCanonicalUrl')         // postUrl 'https://www.facebook.com/777/posts/<postId>', onPagePostKnown 1 lần
test('pageMissingPastLastRetryBecomesNotFound')            // postedAt + 10080*60_000 đã qua → 'not_found'
test('knownPostAbsentFromRecentTenMarksMilestoneWithoutStats') // statsDone gồm '60m', không addPostStats, removedSuspected false
test('readerPageMismatchConcludesNothing')                 // pageId đọc ≠ '777' hoặc kind ≠ 'page' → backOff, không đổi linkStatus/stats
test('pageLoginProblemObservesLoginAndSkipsProfile')       // readPage ném PageLoginProblem('checkpoint') → observeLogin('p1','checkpoint')
test('followersRecordedOncePerLocalDay')                   // 2 lượt cùng ngày → recordPageFollowers ghi 1; followers null/undefined → không ghi
test('emptyPageIdPairNeverOpensBrowser')                   // pair pageId '' → readPage không được gọi
test('pageRowsGetNoCommentSchedule')                       // dòng Page vừa linked → updateCommentSchedule không được gọi
// Toàn bộ test nhóm hiện có của PostTracker.test.ts giữ nguyên, không sửa.
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/facebookPoster/PostTracker.test.ts src/__tests__/facebookPoster/postTracking.test.ts`. Kỳ vọng ca mới FAIL (`matchPagePosts` chưa có, `readPage` không được gọi).
- [ ] **Step 3: Cài đặt**
  - `matchPagePosts` (thuật toán không suy ra được từ signature):

```text
claimed = {}; byId = posts theo postId
mỗi dòng có postId: hit = byId[postId] → map, claimed += postId
pending = dòng chưa có hit và linkStatus ∈ {missing, pending_approval}
cand(row) = posts ∉ claimed, postedAt ≠ null, |postedAt − row.postedAt| ≤ PAGE_MATCH_WINDOW_MS,
            row.textHead[0..60] ≠ '' và normalizeHead(text)[0..60] == row.textHead[0..60]
nhận cặp (row, post) chỉ khi cand(row) = {post} và post thuộc cand của đúng một dòng pending
```

  - `trackPair`: cặp có `pageId` đi `trackPagePair`; `pageId === ''` → `backOffPair`. Đọc: dòng `listTrackingForPair(profileId, groupUrl, sinceMs, pageId)`, làm nguội dòng > 14 ngày như nhóm; `readPage` một lần; `kind !== 'page' || pageId !== pair.pageId` → ném `Error('page_mismatch')` (đi `backOffPair`). Ghi người theo dõi khi `typeof followers === 'number'` và `!hasPageFollowersOn(pageId, localDate(now))`. Áp `matchPagePosts`: hit → `addPostStats` từ mẫu, patch giống `foundPatch` (URL chuẩn, `markOverdueStatsDone`), dòng mới thành `known` → `onPagePostKnown`; miss → `known`: `statsDone = markOverdueStatsDone` (không `removedSuspected`), chờ: `linkRetryExhausted` → `not_found`, không thì chỉ tính lịch kế tiếp. Không gọi `updateCommentSchedule` cho dòng Page.
  - Catch trong `run`: `PageLoginProblem` → code = `e.state` (cùng nhánh `observeLogin` + skip profile).
  - `selectPairs` (track tay): khóa thêm `pageId`, giữ cap `MAX_TRACK_GROUPS` và thứ tự ưu tiên.
  - `readPage` nhận đúng `ProfileTaskContext` mà `trackPair` đang dựng (`priority: 'background'`, cùng `signal`/`assertCurrent`), nên đi qua hàng chờ profile, giới hạn một job và nhường giờ đăng sắp tới như bài nhóm.
  - Composition `getTracker`: `readPage` mở `binding.openForAutomation`, lấy page, `readPageIdentity(page, { assertCurrent: binding.assertCurrent })`, đóng session ở `finally`; truyền `recordPageFollowers/hasPageFollowersOn` qua `trackerStore`; `onPagePostKnown` để Task 4 nối (tạm `undefined`).
  - `SYSTEM_DOCUMENTATION.md`: nhánh Page của tracker + `<!-- docs-check: src/services/facebookPoster/postTracking.ts#PAGE_MATCH_WINDOW_MS = 15 * 60_000 -->`.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS; `npm test -- --runInBand src/__tests__/facebookPoster/PostTrackScheduler.test.ts src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` PASS; `node scripts/check-docs.js`.
- [ ] **Step 5: Inspect diff.**

### Task 4: Gắn bài vào chiến dịch, uncertain → posted, số liệu chiến dịch từ stats

**Files:**
- Modify: `src/services/dailyBrief/PageCampaignExecutionStore.ts:119-140`
- Modify: `src/services/dailyBrief/PageCampaignStore.ts:148-175` (`registerPostedResult`), `:200-215` (`observationSourceAvailable`)
- Modify: `src/services/facebookPoster/PageCampaignTracker.ts:39-98`
- Modify: `electron/ipc/facebookPosterIpc.ts:96-112` (`runDueCampaignTracking`), `:340-358` và `getTracker` (nối `onPagePostKnown`)
- Test: `src/__tests__/dailyBrief/PageCampaignExecutionStore.test.ts`, `PageCampaignStore.test.ts`, `pageCampaignMetrics.test.ts`, `src/__tests__/facebookPoster/PageCampaignTracker.test.ts`

**Interfaces:**
- Consumes: Task 1/3 `onPagePostKnown(row)`, `PostTrackingRow.targetKind/pageId`.
- Produces:
  - `PageCampaignExecutionStore.settle(scheduleId: string, outcome: 'posted' | 'uncertain', resultId: number | null, now: number, target?: { postId: string; postUrl: string; sourceRef: string }): void` (tham số cuối tùy chọn, truyền vào `recordMeasurement`).
  - `PageCampaignExecutionStore.bindTrackedPost(row: Pick<PostTrackingRow, 'resultId' | 'runId' | 'scheduleId' | 'targetKind' | 'pageId' | 'postId' | 'postUrl' | 'linkStatus'>, now: number): 'bound' | 'settled' | 'skipped'`.
  - `sourceRef` của bài gắn = `post-tracking:<resultId>`; observation/measurement scan id = `post-stats:<resultId>:<milestone>`.
  - `PageCampaignTracker.ts`: `export function trackedMilestone(db: SqlDatabase, post: CampaignPublishedPost, milestoneMinutes: 60 | 1440 | 4320, now: number): { status: 'pending' } | { status: 'unavailable'; reason: string } | { status: 'ready'; snapshot: PostStatsSnapshot }` và `export function hasDueCampaignMilestone(db: SqlDatabase, post: CampaignPublishedPost, measurements: CampaignMeasurement[], now: number): boolean`.

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```ts
// PageCampaignExecutionStore.test.ts
test('bindTrackedPostRegistersTargetForPostedExecution')
  // execution posted + dòng Page known → listPublished: { postId:'555', postUrl:'https://www.facebook.com/777/posts/555', sourceRef:'post-tracking:<id>', reason:'' }
test('bindTrackedPostSettlesUncertainToPostedWithoutNewRun')
  // execution uncertain, result failed/uncertain_after_submit → status 'posted', resultId giữ; COUNT(fb_poster_runs) không đổi
test('bindTrackedPostSkipsForeignPageRunOrResult')         // pageId/runId/resultId lệch hoặc không có execution → 'skipped', không ghi
test('uncertainResultWithoutTargetStaysUnconfirmed')       // registerPostedResult không target với result failed → vẫn ném như cũ
// PageCampaignTracker.test.ts (test research hiện có giữ nguyên)
test('statsSourceRecordsMeasuredObservationAt4320')
  // stats captured_at = publishedAt + 4320*60_000 + 5 phút → observation sourceRef 'post-stats:<id>:4320', status 'measured'
test('statsSourcePendingUntilTrackerMarksMilestone')        // chưa có '4320m' trong statsDone và chưa quá 24h → collect trả {checked:0,…}, không reserve
test('statsSourceUnavailableWhenMilestoneDoneWithoutSnapshot') // reason 'exact_post_not_found'
test('nullCountsStayUnavailable')                           // reactions null → status 'unavailable', reason 'missing_counts'
// pageCampaignMetrics.test.ts
test('reportHasRealTotalsFromPostStats')                    // eligible 1, measured 1, totalEngagement = r+c+s, sourceAvailable true
test('deletedStatsRowMakesSourceUnavailable')               // xóa stats → sourceAvailable false, missingReasons gồm 'source_unavailable'
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/dailyBrief/PageCampaignExecutionStore.test.ts src/__tests__/dailyBrief/PageCampaignStore.test.ts src/__tests__/dailyBrief/pageCampaignMetrics.test.ts src/__tests__/facebookPoster/PageCampaignTracker.test.ts`. Kỳ vọng ca mới FAIL.
- [ ] **Step 3: Cài đặt**
  - `bindTrackedPost`: bảng `page_campaign_executions` chưa có → `'skipped'`; cần `row.targetKind === 'page'`, `linkStatus === 'known'`, `campaignPostTarget(row.postUrl)?.postId === row.postId`, execution theo `row.scheduleId` có `runId === row.runId`, `resultId === row.resultId`, `pageId === row.pageId`. `posted` → `new PageCampaignStore(db).registerPostedResult(execution, target)` → `'bound'`; `uncertain` → `settle(…, 'posted', row.resultId, now, target)` → `'settled'`. Không có nhánh nào tạo schedule/run.
  - `registerPostedResult`: chấp nhận `result.outcome === 'failed' && result.error_code === 'uncertain_after_submit'` **chỉ khi** có `target`; mọi kiểm tra scope/run/schedule/target_url giữ nguyên.
  - `observationSourceAvailable`: `sourceRef` bắt đầu `post-stats:` → kiểm `post.sourceRef === 'post-tracking:' + post.resultId`, measurement.scan_id khớp, dòng tracking `target_kind 'page'`, `page_id === post.pageId`, `post_id === post.postId`, và tồn tại `fb_poster_post_stats` cùng `result_id`, `captured_at === observedAt`, đúng ba counts. Nhánh research giữ nguyên.
  - `PageCampaignTracker.run`: bài có `sourceRef` `post-tracking:` dùng `trackedMilestone` (DB-only, không research): snapshot = stats sớm nhất có `captured_at ∈ [publishedAt + m·60000, publishedAt + m·60000 + 24h]`; không có và (`statsDone` gồm `${m}m` hoặc dòng `not_found` hoặc đã quá cửa sổ) → `unavailable 'exact_post_not_found'`; còn lại `pending` (không reserve). `.find` mốc đến hạn và `runDueCampaignTracking` cùng dùng `hasDueCampaignMilestone`, để mốc `pending` không chiếm lượt timer.
  - Composition: `onPagePostKnown: (row) => safely('bindCampaignPost', () => new PageCampaignExecutionStore(boundDb).bindTrackedPost(row, Date.now()))` cho cả service và tracker.
  - `SYSTEM_DOCUMENTATION.md` mục chiến dịch: nguồn stats, `post-tracking:`/`post-stats:`, uncertain → posted không đăng lại.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS; `npm test -- --runInBand src/__tests__/dailyBrief/pageCampaignAutonomy.integration.test.ts src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts` PASS.
- [ ] **Step 5: Inspect diff.**

### Task 5: Cấu hình thông báo, báo cáo 📊 theo kỳ và gom 🎯

**Files:**
- Create: `src/services/facebookPoster/notificationRules.ts`, `src/services/facebookPoster/NotificationScheduler.ts`
- Modify: `src/services/control/controlEvents.ts:43,119-125,148-166`
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts` (đọc lead sau con trỏ)
- Modify: `electron/ipc/facebookPosterIpc.ts:562-566` (`emitLeadsFound`), `:990-1052` (start/stop scheduler)
- Test: Create `src/__tests__/facebookPoster/notificationRules.test.ts`, `src/__tests__/facebookPoster/NotificationScheduler.test.ts`; modify `src/__tests__/control/ControlEventRecorder.test.ts` (đã import `controlEvents`), `src/__tests__/facebookPoster/LeadDetector.test.ts` nếu đổi chữ ký `buildLeadsFound`

**Interfaces:**
- Consumes: Task 2 `listPageFollowers`; `FacebookPosterStore.listTracking/latestStats`; `buildLeadsFoundPayload(leads, auto)` (`LeadDetector.ts:33`).
- Produces (`notificationRules.ts`):
  - `NOTIFICATION_SETTING_KEY = 'fb_poster_notification_config'`, `REPORT_PERIOD_SETTING_KEY = 'fb_poster_report_last_period'`, `LEAD_DIGEST_CURSOR_SETTING_KEY = 'fb_poster_lead_digest_cursor'`, `NOTIFICATION_TICK_MS = 60_000`, `LEAD_DIGEST_MINUTES = [0, 15, 30, 60, 120, 240] as const`.
  - `interface NotificationConfig { reportCadence: 'off' | 'daily' | 'weekly'; reportHour: number; reportWeekday: number; leadDigestMinutes: 0 | 15 | 30 | 60 | 120 | 240 }`; `DEFAULT_NOTIFICATION_CONFIG`.
  - `validateNotificationConfig(input: unknown): NotificationConfig` (ném `Error` có tên trường, từ chối khóa lạ), `mergeNotificationConfig(current: NotificationConfig, patch: unknown): NotificationConfig`, `parseNotificationConfig(raw: string | null): NotificationConfig`.
  - `interface ReportPeriod { key: string; from: number; to: number; label: string }`; `latestReportPeriod(config: NotificationConfig, now: number, timeZone: string): ReportPeriod | null`; `clockLabel(from: number, to: number, timeZone: string): string` (`HH:mm–HH:mm`).
  - `type LeadCursor = { at: number; id: number }`.
- Produces (`NotificationScheduler.ts`): `class NotificationScheduler { constructor(deps: NotificationSchedulerDeps); start(): void; stop(): void; tickNow(): void }` với deps `{ now(): number; timeZone(): string; setTimer(fn, ms): unknown; clearTimer(h): void; readConfig(): NotificationConfig; readSetting(key): string | null; writeSetting(key, value): void; atomically<T>(fn: () => T): T; canPublish(): boolean; publish(type: 'metrics.report' | 'leads.digest', payload: unknown): void; buildReport(period: ReportPeriod, cadence: 'daily' | 'weekly'): MetricsReportPayload; leadsAfter(cursor: LeadCursor): FbPosterLead[]; latestLeadCursor(): LeadCursor | null; log(msg: string): void }`; `buildMetricsReport(store, period, cadence, pageName: (pageId: string) => string): MetricsReportPayload`.
  - `MetricsReportPayload = { cadence; periodKey; from; to; label; posts; measured; engagement; notFound; top: { resultId; targetKind; text; postUrl; engagement }[] (≤ 3); followers: { pageId; pageName; current: number | null; change: number | null }[] }`.
- Produces (`controlEvents.ts`): `ControlEventType` thêm `'metrics.report' | 'leads.digest'`; `buildLeadsFound` nhận `deferred?: boolean` → payload có `deferred: true` chỉ khi true; `buildLeadsDigest(e: LeadsFoundPayload & { from: number; to: number; label: string })`; `recordControlEvent(type, payload): void` ném khi không có sink hoặc sink ném (giữ `emitControlEvent` nuốt lỗi như cũ).
- Produces (store): `listLeadsAfter(cursor: LeadCursor): FbPosterLead[]` (sắp `detected_at, id` tăng), `latestLeadCursor(): LeadCursor | null`.

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```ts
// notificationRules.test.ts — mọi ca truyền zone tường minh
test('defaults', () => expect(DEFAULT_NOTIFICATION_CONFIG).toEqual({ reportCadence:'weekly', reportHour:8, reportWeekday:1, leadDigestMinutes:60 }));
test('validatesDomains')  // reportHour -1|24|1.5, reportWeekday 0|8, leadDigestMinutes 45, khóa lạ → throw; [0,15,30,60,120,240] hợp lệ
test('weeklyKeyInHoChiMinh', () => {
  expect(latestReportPeriod(DEF, Date.UTC(2026,9,26,1,0), 'Asia/Ho_Chi_Minh')).toMatchObject({ key:'weekly:2026-10-26', to:Date.UTC(2026,9,26,1,0), from:Date.UTC(2026,9,19,1,0) });
  expect(latestReportPeriod(DEF, Date.UTC(2026,9,26,0,59), 'Asia/Ho_Chi_Minh')!.key).toBe('weekly:2026-10-19');
});
test('weeklyKeyAcrossUsDstEnd', () => {           // DST Mỹ kết thúc 1/11/2026
  expect(latestReportPeriod(DEF, Date.UTC(2026,10,2,13,0), 'America/New_York')!.key).toBe('weekly:2026-11-02');
  expect(latestReportPeriod(DEF, Date.UTC(2026,10,2,12,59), 'America/New_York')!.key).toBe('weekly:2026-10-26');
});
test('dailyAndOff')                                // daily 07:59 HCM → key ngày hôm trước; 'off' → null
test('processTimezoneDoesNotChangeKey')            // cùng now/zone, tính khi process.env.TZ khác → cùng key (không dùng Date#getHours)
// NotificationScheduler.test.ts — fake settings Map, fake publish, timeZone 'America/New_York'
test('firstRunInitializesWithoutSending')          // không có state → ghi key/cursor hiện tại, publish 0 lần
test('metricsReportsAreOncePerPeriodAcrossRestart') // qua giờ gửi → 1 'metrics.report'; tick lại / scheduler mới cùng Map → vẫn 1
test('catchUpSendsExactlyOneForLatestPeriod')       // tắt 3 tuần → đúng 1 tin, periodKey của kỳ gần nhất
test('failedPublishLeavesStateForRetry')            // publish ném → state không đổi; tick sau → đúng 1 tin
test('offSendsNothing') ; test('noSinkDoesNothing') // canPublish false → không ghi state
test('leadDigestWaitsForWindowThenSendsOne')        // lead đầu detectedAt t0, 60 phút: t0+59 phút → 0; t0+60 phút → 1 'leads.digest' gộp mọi lead
test('digestSurvivesRestartWithoutLossOrDuplicate') // scheduler mới sau restart: count đủ, 1 tin
test('zeroMinutesAdvancesCursorWithoutDigest')
test('reportPayloadCountsOnlyMeasuredEngagement')   // bài chưa đo không cộng 0; top ≤ 3; notFound đếm; follower change null khi thiếu mốc đầu kỳ
// controlEvents
test('leadsFoundMarksDeferredOnlyWhenDigesting') ; test('recordControlEventThrowsWithoutSink')
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/facebookPoster/notificationRules.test.ts src/__tests__/facebookPoster/NotificationScheduler.test.ts src/__tests__/control/ControlEventRecorder.test.ts`. Kỳ vọng FAIL "Cannot find module" rồi, sau skeleton rỗng, FAIL assertion.
- [ ] **Step 3: Cài đặt**
  - `latestReportPeriod` (thuật toán):

```text
p = Intl.DateTimeFormat('en-US', {timeZone, hourCycle:'h23', year,month,day,hour,minute,second,weekday}).formatToParts(now)
mins = hour*60 + minute; due = mins >= reportHour*60
daily : back = due ? 0 : 1
weekly: d = (isoWeekday − reportWeekday + 7) % 7; back = (d == 0 && !due) ? 7 : d
sendDate = lùi `back` ngày trên lịch (Y-M-D, toán UTC thuần)
to   = now − ((mins − reportHour*60) + back*1440)*60000 − (second*1000 + now%1000)
     // shortcut: to/from lệch ≤ 1 giờ quanh DST; key theo ngày lịch nên vẫn đúng một kỳ
from = to − (daily ? 1 : 7) * 86_400_000
key = `${cadence}:${sendDate}`; label = `dd/MM(from)–dd/MM(to − 1)` theo zone
```

  - `tickNow` (mỗi phần try/catch + log riêng): `canPublish()` false → return. Báo cáo: state vắng → ghi key, không gửi; khác key → `atomically(() => { publish('metrics.report', buildReport(...)); writeSetting(REPORT, key) })`. Gom tin: cursor vắng → ghi `latestLeadCursor() ?? { at: now, id: 0 }`; `pending = leadsAfter(cursor)`; `leadDigestMinutes === 0` → chỉ dời cursor; `now >= pending[0].detectedAt + minutes·60000` → `atomically(publish('leads.digest', buildLeadsDigest({...buildLeadsFoundPayload(pending, true), from, to: now, label: clockLabel(...)})); writeSetting(CURSOR, last))`.
  - `buildMetricsReport`: dòng `listTracking({ sinceMs: from, untilMs: to - 1, limit: 5000 })` mọi loại; engagement chỉ từ `latestStats` có số (null coi như không đo, không cộng 0); top 3 theo engagement rồi `postedAt` mới hơn; người theo dõi: current = bản ghi cuối `capturedAt < to`, base = bản ghi cuối `capturedAt < from`, `change = base ? current − base : null`.
  - Composition (`facebookPosterIpc.ts` cạnh `trackScheduler`, dừng trong `stopFacebookPosterScheduler`): `canPublish = () => { try { binding.assertCurrent(); } catch { return false; } return hasControlEventSink(); }`, `publish = recordControlEvent`, `atomically = (fn) => boundDb.transaction(fn)`, settings qua `boundDb.getSetting/setSetting`, `timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone`, `pageName` từ `DailyBriefStore.getIdentity` theo `pageId`. Thêm `readNotificationConfig()` = `parseNotificationConfig(db().getSetting(NOTIFICATION_SETTING_KEY))` cạnh `readTrackingConfig` (`:510`). `emitLeadsFound` truyền `deferred: readNotificationConfig().leadDigestMinutes > 0` chỉ vào `buildLeadsFound` (sự kiện UI không đổi).
  - `SYSTEM_DOCUMENTATION.md`: khóa settings, sự kiện mới, quy tắc kỳ/khởi tạo/bù; `<!-- docs-check: src/services/facebookPoster/notificationRules.ts#NOTIFICATION_TICK_MS = 60_000 -->`.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS; `npm test -- --runInBand src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts src/__tests__/facebookPoster/leadWiring.test.ts src/__tests__/control` PASS; `node scripts/check-docs.js`.
- [ ] **Step 5: Inspect diff.**

### Task 6: Control API, IPC/preload/types và "Gom theo Page"

**Files:**
- Modify: `src/services/control/ControlMethods.ts:143-157` (ports), `:191-200` (deps), sau `pages.list` (`:658`) và sau `leads.config` (`:947-966`)
- Modify: `electron/ipc/facebookPosterIpc.ts:181` (`STATS_GROUP_BY`), `:1274-1350` (`trackingOperations`), `:1480-1492` (handlers); `electron/ipc/controlApiIpc.ts:210-260`
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts:776-818` (`groupBy 'page'`), `src/models/facebookPoster.ts:179`
- Modify: `electron/preload.ts:980-992`, `src/ui/lib/ipc.ts:761-769`
- Modify: `docs/protocol/maihub-control-protocol.md` §7, §9
- Test: `src/__tests__/control/ControlMethods.test.ts`, `controlAuthorization.test.ts`, `src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts`, `FacebookPosterStore.test.ts`

**Interfaces:**
- Consumes: Task 2 `listPageFollowers`, Task 5 `mergeNotificationConfig`, `latestReportPeriod`, `latestLeadCursor`.
- Produces:
  - Trong `electron/ipc/facebookPosterIpc.ts`: `export const MAX_PAGE_METRICS_DAYS = 90;` và `trackingOperations.pageMetrics(params: { pageId?: string; days?: number }): { pages: { pageId: string; pageName: string; posts: { resultId: number; postId: string; postUrl: string | null; postedAt: number; linkStatus: LinkStatus; text: string; snapshots: PostStatsSnapshot[] }[]; followers: PageFollowerRow[] }[] }` (`days` nguyên 1–90, mặc định 30; chỉ dòng Page có `pageId !== ''`).
  - `notificationOperations = { getConfig(): { config: NotificationConfig }; setConfig(patch: unknown): { config: NotificationConfig } }` — `setConfig` trong một transaction ghi config, `REPORT_PERIOD_SETTING_KEY = latestReportPeriod(next, now, zone)?.key` (lịch mới bắt đầu từ kỳ sau) và cursor gom = `latestLeadCursor()`.
  - `TrackingPort.pageMetrics(params: any): any`; `interface NotificationPort { getConfig(): any; setConfig(params: any): any }`; `ControlMethodDeps.notifications?: NotificationPort`.
  - IPC `facebookPoster:pageMetrics`, `facebookPoster:getNotificationConfig`, `facebookPoster:setNotificationConfig`; preload `pageMetrics`, `getNotificationConfig`, `setNotificationConfig`; `PostStatsGroupBy` thêm `'page'`.

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```ts
// ControlMethods.test.ts — sửa hằng đếm và danh sách describe (spec thêm thao tác)
expect(methods).toHaveLength(63);                       // 60 + pages.metrics + notifications.config + notifications.setConfig
// describe: 'pages.metrics' ngay sau 'pages.list'; 'notifications.config', 'notifications.setConfig' ngay sau 'leads.config'
it('pagesMetricsValidatesDays')           // days 0|91|1.5 → INVALID_PARAMS; mặc định 30
it('setConfigRejectsOutOfDomain')         // leadDigestMinutes 45 → INVALID_PARAMS; config hiện hành không đổi
// controlAuthorization.test.ts — mở rộng it.each owner-only sẵn có (~:46)
it.each(['pages.metrics','notifications.config','notifications.setConfig'])('owner-only %s …')  // runner/receiver: không visible, authorize → FORBIDDEN
it('runnerHasNoMetricsOrNotificationWrite', () =>   // spec §8: runner tự khai số liệu / đổi cấu hình bị từ chối
  expect(visibleMethods(runner, methods).map(m => m.name).filter(n => /^(pages\.metrics|notifications\.|posts\.)/.test(n))).toEqual([]));
// FacebookPosterStore.test.ts
test('statsReportGroupByPageUsesPageRowsOnly')  // key = page_id, label = tên Page hoặc page_id; dòng nhóm không vào
// facebookPosterIpcWiring.test.ts
test('setNotificationConfigResetsReportPeriodAndDigestCursor')
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/control/ControlMethods.test.ts src/__tests__/control/controlAuthorization.test.ts src/__tests__/facebookPoster/FacebookPosterStore.test.ts src/__tests__/facebookPoster/facebookPosterIpcWiring.test.ts`. Kỳ vọng FAIL (`toHaveLength(63)` nhận 60…).
- [ ] **Step 3: Cài đặt** — ba method `destructive: false`, schema params đúng miền giá trị; không thêm tên nào vào `READ_METHODS`/`RUNNER_MUTATIONS`/`RECEIVER_METHODS` (chỉ owner). `pageCampaigns.report` không đổi shape. `statsReport` `groupBy 'page'`: `t.target_kind = 'page'`, nhãn lấy `page_name` từ `fb_page_identities` trong try/catch như `groupMemberCount`. Thêm `'page'` vào `STATS_GROUP_BY` và enum `posts.stats`. Protocol §7 (ba hàng thao tác, quyền chỉ owner), §9 (`metrics.report`, `leads.digest`, trường `deferred` của `leads.found`), cập nhật số thao tác ở `SYSTEM_DOCUMENTATION.md`; `<!-- docs-check: electron/ipc/facebookPosterIpc.ts#MAX_PAGE_METRICS_DAYS = 90 -->`.
- [ ] **Step 4: Chạy xanh** — lệnh Step 2 PASS; `npm test -- --runInBand src/__tests__/control` PASS; `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json`; `node scripts/check-docs.js`.
- [ ] **Step 5: Inspect diff.**

### Task 7: Bridge `watch` — nhãn tin, 📊, 🎯 gom, bỏ 📈

**Files:**
- Modify: `tools/maihub-bridge/maihub_bridge.py:1697-1743` (`format_event`), `:1746-1764` (`format_brief_messages` lỗi)
- Modify: `tools/maihub-bridge/tests/test_bridge.py:1409-1440,1478-1560,1613-1628,1630-1662,1861-1875,2080`
- Modify: `tools/maihub-bridge/README.md` (mục `watch`)

**Interfaces:**
- Consumes: Task 5 payload `metrics.report`, `leads.digest`, `leads.found.deferred`.
- Produces: chuỗi tin cố định dưới đây (bridge chỉ hiển thị `label` app đã định dạng, không tự đổi múi giờ).

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```python
# FormatEventTests — sửa kỳ vọng nhóm 'post' theo spec §6 (join/scan giữ nguyên)
self.assertEqual(lines[0], "⚠️ Đăng bài lỗi: Đăng ngay — xong 1/6, lỗi 5")
self.assertEqual(text, "⚠️ Đăng bài lỗi: Đăng ngay — xong 0/2, lỗi 2")
self.assertTrue(self.fmt(finished(1, status="failed", posted=0)).startswith("⚠️ Đăng bài lỗi: Đăng ngay — "))
self.assertEqual(self.fmt(finished(1, kind="join", failed=1, posted=1)).split("\n")[0], "⚠️ Tham gia nhóm: xong 1/2, lỗi 1")
# FormatTrackFinishedTests → test_never_sent_per_run: mọi payload → None
# FormatLeadsFoundTests: deferred True → None; vắng deferred → như cũ "🎯 2 khách tiềm năng mới…"
# FormatLeadsDigestTests
self.assertEqual(fmt(count=3, label="08:00–09:00").split("\n")[0], "🎯 3 khách tiềm năng mới · 08:00–09:00")  # + ≤ 3 dòng mẫu như leads.found; count 0 → None
# FormatMetricsReportTests
self.assertEqual(lines[0], "📊 Báo cáo hiệu quả · 24/10–30/10")
self.assertEqual(lines[1], "Bài: 12 · Tương tác: 340 (10 bài đã đo) · Không tìm thấy link: 1")
# "Nổi bật:" + "1. <text cắt 60> — 120"; "Người theo dõi:" + "<pageName>: 1234 (+12)" / "(chưa đủ dữ liệu)"
# FormatBriefTests/WatcherTests: "⚠️ Đề xuất lỗi: Mai Shop — Lỗi nghiên cứu" (clip 200 như cũ)
# FormatVideoFinishedTests giữ nguyên "⚠️ Video lỗi: …"
```

- [ ] **Step 2: Chạy đỏ** — `python3 -m unittest discover -s tools/maihub-bridge/tests -k Format -v`. Kỳ vọng FAIL ở nhãn mới.
- [ ] **Step 3: Cài đặt** — `format_event`: `run.finished` lỗi với `kind` vắng hoặc `post` dùng tiền tố `⚠️ Đăng bài lỗi: <label> — …`; `posts.trackFinished` → `None`; `leads.found` có `deferred is True` → `None`; thêm nhánh `leads.digest`, `metrics.report` (dùng `clip`, `_one_line`, `MAX_FIELD_CHARS`, `MAX_LEAD_SAMPLES`, `MAX_MESSAGE_CHARS` sẵn có; trường thiếu/sai kiểu thì bỏ dòng đó, không ném). `format_brief_messages` lỗi → `⚠️ Đề xuất lỗi: <tên> — <lỗi>`. Cursor `watch` không đổi. README mục `watch`: bảng nhãn mới.
- [ ] **Step 4: Chạy xanh** — `python3 -m unittest discover -s tools/maihub-bridge/tests -v` toàn bộ OK.
- [ ] **Step 5: Inspect diff.**

### Task 8: UI "Hiệu quả" — Page, chip link, người theo dõi, lịch báo cáo

**Files:**
- Modify: `src/ui/features/facebookPoster/trackingFormat.ts`, `PerformancePanel.tsx`, `TrackConfigPopover.tsx`, `HistoryTab.tsx:12,182-185`
- Test: `src/__tests__/facebookPoster/trackingFormat.test.ts`; harness Vite + playwright-core trong `$SCRATCH/ui-harness` (không có gì của harness trong repo)

**Interfaces:**
- Consumes: Task 6 IPC `pageMetrics`, `getNotificationConfig`, `setNotificationConfig`, `postStats` với `groupBy 'page'`.
- Produces (`trackingFormat.ts`): `GROUP_BY_OPTIONS` thêm `{ value: 'page', label: 'Page' }`; `linkChip(linkStatus: LinkStatus, removedSuspected: boolean, targetKind: TrackTargetKind = 'group'): LinkChip | null`; `missingStatsReason(row: Pick<PostTrackingRow, 'linkStatus' | 'targetKind' | 'statsDone'>, latest: PostStatsSnapshot | null): string | null`; `followerSummary(series: PageFollowerRow[]): { current: number | null; change7: number | null; change30: number | null }`; `REPORT_CADENCE_OPTIONS`, `WEEKDAY_OPTIONS` (1 = Thứ 2 … 7 = Chủ nhật), `LEAD_DIGEST_OPTIONS` (`0` = Gửi ngay, 15/30/60/120/240 phút).

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test đỏ**

```ts
test('pageChipsUseSpecLabels', () => {
  expect(linkChip('missing', false, 'page')!.label).toBe('Đang tìm link');
  expect(linkChip('not_found', false, 'page')!.label).toBe('Không tìm thấy');
  expect(linkChip('missing', false)!.label).toBe('Chưa có link');      // nhóm giữ nguyên
});
test('missingStatsReason')   // page known + statsDone ['60m'] + latest null → 'Không có trong 10 bài gần nhất của Page'; có số → null
test('followerSummary', () => {
  expect(followerSummary([])).toEqual({ current:null, change7:null, change30:null });
  // 2026-10-01:1000, 2026-10-24:1100, 2026-10-31:1150 → { current:1150, change7:50, change30:150 }
  // chỉ 2026-10-28, 2026-10-31 → change7 null, change30 null
});
test('optionLists')          // LEAD_DIGEST_OPTIONS values [0,15,30,60,120,240]; WEEKDAY_OPTIONS 7 mục bắt đầu 1
```

- [ ] **Step 2: Chạy đỏ** — `npm test -- --runInBand src/__tests__/facebookPoster/trackingFormat.test.ts` FAIL; dựng harness trong `$SCRATCH/ui-harness` (Vite có sẵn, alias `@` → `src/ui`, stub `@/lib/ipc` trước khi module load trả fixture có Page/không Page/lỗi; chặn mọi network ngoài localhost), chạy Playwright trên bản trước sửa, lưu failure "không có tùy chọn Page / không có ô Người theo dõi".
- [ ] **Step 3: Cài đặt** — `PerformancePanel`: tùy chọn "Page"; ô **Người theo dõi** theo Page (hiện tại, 7 ngày, 30 ngày; thiếu → "chưa đủ dữ liệu"; tải lỗi → ẩn ô, không chặn bảng) từ `pageMetrics({ days: 31 })`. `TrackConfigPopover`: thêm khối **Báo cáo qua bot** (select Tắt / Hằng ngày / Hằng tuần; giờ 0–23; thứ chỉ hiện khi Hằng tuần) và **Gom tin khách tiềm năng** (Gửi ngay / 15 / 30 / 60 / 120 / 240 phút), lưu ngay khi đổi như checkbox hiện có, lỗi map tên trường → nhãn qua `fieldLabels`. `HistoryTab`: truyền `targetKind` vào `linkChip`, hiện "—" + `title` lý do khi `missingStatsReason` có giá trị. Chỉ class/token sẵn có trong `DESIGN.md`/`index.css`; focus ring `FOCUS` hiện có; select có `<label>`.
- [ ] **Step 4: Chạy xanh + kiểm hiển thị** — `npm test -- --runInBand src/__tests__/facebookPoster/trackingFormat.test.ts` PASS. Harness: 1280×800 và 390×844 × light (không `data-theme`) / dark (`html[data-theme="dark"]`): `document.documentElement.scrollWidth <= innerWidth`; popover nằm trong viewport; nhãn ô người theo dõi không chồng nhau (bounding box); Tab đi qua cadence → giờ → (thứ khi tuần) → gom tin; Escape đóng và trả focus về nút ⚙; lưu screenshot trong scratch. `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Inspect diff** (xác nhận không có file harness trong repo).

### Task 9: Tích hợp, tài liệu và kiểm chứng như CI

**Files:**
- Create: `src/__tests__/facebookPoster/pagePublishProof.integration.test.ts`
- Modify: `SYSTEM_DOCUMENTATION.md` (rà toàn bộ mục đã đổi), `docs/specs/2026-10-31-page-publish-proof-metrics.md` (chỉ dòng Trạng thái + "Ghi chú sau triển khai" nếu code khác spec), dòng Trạng thái của plan này

**Interfaces:**
- Consumes: tất cả interfaces Task 1–8; composition thật của `FacebookPosterService` (tasks giả), `PostTracker` với `openSession`/`readPage` đi qua `ProfileJobQueue` thật trên `BrowserProfileService` có native launch/Playwright page giả (theo mẫu `backgroundJobs.integration.test.ts`), `PageCampaign*Store`, `NotificationScheduler` (deps thật trên `memoryDb`, publish ghi vào `ControlStore` thật), clock biến số; không dựng `facebookPosterIpc` composition (tránh timer đăng nhập 07:00).

- [ ] **Step 0: Baseline.**
- [ ] **Step 1: Viết test tích hợp**

```ts
test('pagePostKnownThenMeasuredAtThreeMilestonesAndFollowersOncePerDay')
  // đăng Page (owner = Page) → known; tickNow ở +60, +1440, +4320 phút → 3 stats; followers 2 lượt cùng ngày → 1 dòng
test('uncertainCampaignPostReconciledToPostedWithoutRepost')
  // execution uncertain → tracker khớp đúng 1 bài → status 'posted'; postToTargets gọi đúng 1 lần, COUNT(runs) không đổi
test('campaignReportUsesPostStats')        // buildCampaignReport: measured 1, totalEngagement khác null
test('groupAndPageRowsInOneTickWithoutCrossTalk') // cặp nhóm qua session giả nhóm, cặp Page qua readPage; điểm nhóm không có FB_HOME
test('weeklyReportAndDigestExactlyOnceAcrossRestart') // events 'metrics.report' = 1, 'leads.digest' = 1 sau 2 lần dựng scheduler
```

- [ ] **Step 2: Chạy** — `npm test -- --runInBand src/__tests__/facebookPoster/pagePublishProof.integration.test.ts`. Ca nào xanh ngay là regression verification (ghi rõ); ca đỏ → `superpowers:systematic-debugging`, sửa ở module của task sở hữu, chạy lại suite task đó.
- [ ] **Step 3: Hai vòng kiểm chứng độc lập** (mỗi vòng ghi log vào `$SCRATCH`, `TMPDIR="$SCRATCH"`):
  - Vòng 1: `TZ=America/New_York npm test -- --runInBand --no-cache --cacheDirectory="$SCRATCH/jest-cache" --randomize --seed=2707 --showSeed`
  - Vòng 2: như trên với `TZ=Asia/Ho_Chi_Minh` và `--seed=3707`
  - Mỗi vòng thêm: `python3 -m unittest discover -s tools/maihub-bridge/tests -v`; `npx tsc --noEmit -p tsconfig.json`; `npx tsc --noEmit -p tsconfig.electron.json`; `node scripts/check-docs.js`; `git diff --check`; ma trận harness UI Task 8 (desktop/mobile × light/dark).
  - Thứ tự chuẩn như CI: `TZ=UTC npm test -- --runInBand`.
  - Kỳ vọng: mọi lệnh exit 0; liệt kê số suite/test, console.error/warn so baseline; không skip/xóa test đỏ.
- [ ] **Step 4: Cổng Make** — chạy `make build`, `make test`, `make lint`, dán output (dự kiến exit 2 vì không có `Makefile`); ghi blocker, không thêm target, không coi tsc/Jest là thay thế.
- [ ] **Step 5: Tài liệu** — `SYSTEM_DOCUMENTATION.md` khớp hành vi cuối (cột/bảng, nhánh Page, chiến dịch, sự kiện, method, settings, nhãn Telegram); cập nhật dòng Trạng thái spec/plan (đã triển khai dev, chưa kiểm app Electron/Facebook thật, chưa phát hành, version không đổi). `ChangelogSettings.tsx` và tăng `version` để dành lúc phát hành có phép riêng.
- [ ] **Step 6: Inspect diff toàn nhánh** — `git diff HEAD --stat` và đọc từng file so baseline Task 1; xác nhận không đụng `sites/`, spec website, không commit; liệt kê hành vi cũ đã kiểm (test nhóm PostTracker, postToTargets nhóm, groupScores, bridge join/video, leads.found khi digest 0) kèm bằng chứng lệnh.
