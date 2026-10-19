# Nghiên cứu chủ đề — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MaiHub quét bài, nhóm, fanpage theo từ khoá và bài trong nhóm đã tham gia, bằng API GraphQL gọi ngay trong trình duyệt của các profile sẵn có (xoay vòng). Kết quả được lưu để so sánh theo thời gian; bot đọc qua Control API, người dùng xem ở tab "Nghiên cứu".

**Architecture:**
- **Module mới** `src/services/research/`:
  - store và schema;
  - bộ đọc thuần (`parsers.ts`);
  - phiên GraphQL trong trang (`graphqlSession.ts`);
  - chọn profile xoay vòng (`profileRotation.ts`, thuần);
  - dịch vụ điều phối lượt quét (`ResearchService.ts`).
- **Lớp nối:** `electron/ipc/researchIpc.ts`.
- **Control API:** 5 thao tác mới và 1 sự kiện.
- **UI:** tab mới trong Đăng Facebook.

**Tech Stack:** TypeScript, playwright-core, better-sqlite3, React 18, `xlsx` (đã có), jest.

**Spec:** `docs/specs/2026-10-19-topic-research.md` (đã duyệt).

## Global Constraints

- **Hằng số:**
  - `limit` mặc định 200, tối đa 500;
  - `PER_PROFILE_CHUNK = 50`;
  - `perProfileDailyCap` mặc định 500, khoảng 50–5000;
  - nghỉ 2–5 s giữa hai trang kết quả, 5–10 s giữa hai nhóm;
  - `group_feed`: tối đa 20 nhóm, `limitPerGroup` 30 (tối đa 100), `sinceDays` 7 (khoảng 1–30);
  - dữ liệu giữ 180 ngày;
  - `profileIds` tối đa 50; `query` 1–100 ký tự; năm lọc từ 2010 tới năm hiện tại.
- **Cách gọi API:**
  - chỉ `fetch('/api/graphql/')` qua `page.evaluate` trong trang của profile;
  - **không** sửa header, **không** gọi API từ Node;
  - **không** chép code babyvibe.
- **Dữ liệu người đăng:** lưu tên, ID, link người đăng (kể cả cá nhân). Không quét danh sách thành viên hay người tương tác. Mẫu test trong repo chỉ dùng **dữ liệu giả**.
- **Mã lỗi:** đúng bảng spec §7.
- **Giao thức:** Control API chỉ thêm. Không đổi hành vi Đăng Facebook. Không đăng hay bấm gì trên Facebook.
- **Ngôn ngữ:** định danh tiếng Anh; chữ hiển thị, log và docs tiếng Việt.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <paths>`. Không chạy `rebuild:native` hay `prebuild-install` (controller lo).
  - tsc: hai lệnh chạy **riêng**: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit` và tương tự với `-p tsconfig.json`.
- **Tài liệu:** cập nhật `SYSTEM_DOCUMENTATION.md` và `docs/protocol/maihub-control-protocol.md` trong cùng commit với thay đổi hành vi. `node scripts/check-docs.js` phải sạch.
- **Git:**
  - `git add` đúng đường dẫn;
  - commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
  - không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **Cả profile bị checkpoint giữa lượt quét:** lượt quét chuyển profile, ghi `details_json`, gọi `observe` để báo 🔒. Không quét tiếp bằng profile đó. → Task 4, 5.
2. **Lượt Đăng Facebook bắt đầu đúng lúc profile đang bị dùng để quét:** lượt đăng nhận `launch_failed` / "Profile đang mở" cho đích đó. Lượt quét không bao giờ chọn profile đang có lượt đăng chạy. → Task 4, 6.
3. **Phản hồi có `for (;;);` và nhiều dòng JSON, trường thiếu, số dạng "1,2K":** đọc đúng, thiếu thì `null`, không sập. → Task 2.
4. **`doc_id` hết hạn:** bắt lại một lần; vẫn hỏng thì `query_changed`. Không lặp vô hạn. → Task 3.
5. **Huỷ lúc đang nghỉ giữa trang hoặc giữa nhóm:** dừng ngay, đóng trình duyệt, `status = cancelled`. → Task 5.

---

### Task 0 (controller, cần anh): Bước thử trên Facebook thật (chỉ đọc)

Không viết code sản phẩm. Dùng một profile đã đăng nhập do anh chỉ định, với mỗi nguồn quét khoảng 20 mục, và trả lời 5 câu ở spec §2.

**Đầu ra:**
- `docs/reports/2026-10-19-topic-research-spike.md`:
  - tên truy vấn, cách bắt `doc_id` và biến mẫu;
  - nguồn của trang đầu tiên (request hay HTML nhúng);
  - đường dẫn tới từng trường của spec §4.1;
  - dạng lỗi khi hết phiên, checkpoint, bị chặn, `doc_id` hỏng;
  - cách truyền bộ lọc.
- `src/__tests__/research/fixtures/{search-posts,search-groups,search-pages,group-feed,error-*}.json`: phản hồi thật đã **thay tên, ID, link, nội dung cá nhân bằng dữ liệu giả**, giữ nguyên cấu trúc.
- Ghi vào ledger mọi quyết định khác spec. Nguồn nào không lấy được ổn định thì ghi vào spec, mục "Nguồn hoãn".

### Task 1: Store, schema, cấu hình

**Files:**
- Create: `src/services/research/schema.ts`, `src/services/research/ResearchStore.ts`, `src/services/research/researchConfig.ts`
- Test: `src/__tests__/research/ResearchStore.test.ts`, `src/__tests__/research/researchConfig.test.ts`

**Interfaces:**
- Produces:
  - Bảng `research_scans`, `research_items`, `research_queries` đúng spec §4.1. Thêm index `research_items(scan_id)`, `research_items(kind, fb_id)`, `research_items(profile_id, captured_at)`.
  - Kiểu trong `src/models/research.ts`:
    - `ResearchSource = 'posts' | 'groups' | 'pages' | 'group_feed'`
    - `ResearchScan`, `ResearchItem`
    - `ResearchErrorCode`
  - `class ResearchStore(db: SqlDatabase)`, dùng chung interface với `FacebookPosterStore`:
    - `createScan`
    - `finishScan(id, status, errorCode, error, details, at)`
    - `addItems(scanId, items, profileId, at): number` (số mục mới, bỏ trùng theo `UNIQUE`)
    - `listScans({ limit, offset, source })`
    - `getScan(id)`
    - `listItems(scanId, { sort, limit, offset })`: tính `engagement` và `engagementRate` theo spec §8; `members` lấy từ lượt quét `groups` gần nhất có nhóm đó
    - `itemsCapturedSince(profileId, sinceMs): number`
    - `getQuery(name)` / `saveQuery(name, docId, template, at)`
    - `pruneOlderThan(ms)`
    - `failInterruptedScans(at)`: lượt `running` khi app tắt đột ngột thành `failed`
  - `parseResearchConfig(raw)` / `validateResearchConfig(input)` với `{ excludedProfileIds: string[]; perProfileDailyCap: number }` (mặc định `[]`, `500`, khoảng 50–5000). Có thêm hằng `RESEARCH_CONFIG_SETTING_KEY = 'research_config'`.

- [ ] **Step 1:** Viết test (memoryDb):
  - schema tạo được;
  - `addItems` bỏ trùng;
  - `listItems` sort `engagement` / `recent` / `members`;
  - `engagement` khi có giá trị `null`;
  - `engagementRate` dùng số thành viên của lượt quét nhóm gần nhất;
  - `itemsCapturedSince`;
  - `pruneOlderThan` xoá cả mục;
  - `failInterruptedScans`;
  - parse/validate config (mặc định, khoảng, JSON hỏng → mặc định).
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS. Chạy tsc.
- [ ] **Step 3:** Commit: `feat(research): store, schema and config`.

### Task 2: Bộ đọc thuần

**Files:**
- Create: `src/services/research/parsers.ts`
- Test: `src/__tests__/research/parsers.test.ts` (dùng fixtures của Task 0)

**Interfaces:**
- Produces:
  - `parseGraphqlChunks(text: string): unknown[]`: bỏ `for (;;);`, tách nhiều dòng JSON.
  - `parseCompactNumber(text): number | null`: hiểu "1,2K", "3 N", "1.5M", "12 Tr", "1.234".
  - `parseSearchPosts(text)` / `parseSearchGroups(text)` / `parseSearchPages(text)` / `parseGroupFeed(text)`, cùng kiểu trả về `{ items: ParsedItem[]; endCursor: string | null; errorCode: ResearchErrorCode | null }`.
    - `ParsedItem` có đúng các trường của `research_items` (trừ `id`, `scan_id`, `captured_at`, `profile_id`).
    - Đường dẫn trường và cách nhận diện lỗi theo báo cáo Task 0.

- [ ] **Step 1:** Viết test trên fixtures:
  - mỗi nguồn đọc đủ trường;
  - nhiều dòng JSON;
  - trường thiếu → `null`;
  - người đăng cá nhân và trang đọc đúng tên, ID, link (dữ liệu giả);
  - số dạng chữ;
  - fixtures lỗi → `errorCode` đúng;
  - mục thiếu ID bị bỏ.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(research): pure GraphQL response parsers`.

### Task 3: Phiên GraphQL trong trang

**Files:**
- Create: `src/services/research/graphqlSession.ts`
- Test: `src/__tests__/research/graphqlSession.test.ts` (trang giả)

**Interfaces:**
- Consumes: Task 1 (`getQuery`/`saveQuery`), Task 2 (`errorCode` từ bộ đọc).
- Produces `class GraphqlSession`:
  - `constructor(page: Page, store: Pick<ResearchStore, 'getQuery' | 'saveQuery'>, deps?: { now?; sleep? })`
  - `open(): Promise<void>`:
    - vào `facebook.com`;
    - đọc mã phiên theo Task 0;
    - bị chuyển tới `/login` → `ResearchError('logged_out')`; `/checkpoint` → `ResearchError('checkpoint')`.
  - `ensureQuery(friendlyName, triggerUrl): Promise<CapturedQuery>`:
    - lấy từ store;
    - chưa có thì mở `triggerUrl` và bắt request có tên đúng (cuộn nhẹ nếu cần, theo Task 0);
    - lưu lại.
  - `call(query, variables): Promise<string>`: `fetch` trong trang, trả text thô.
  - `recapture(friendlyName, triggerUrl)`: dùng khi bộ đọc báo truy vấn hỏng; tối đa 1 lần cho mỗi lượt.
  - `export class ResearchError extends Error { code: ResearchErrorCode }`

- [ ] **Step 1:** Viết test:
  - `open` đọc mã phiên;
  - chuyển tới `/login` / `/checkpoint` → mã đúng;
  - `ensureQuery` bắt từ request rồi lưu, lần sau không mở trang;
  - `call` gửi đúng `doc_id` / biến / mã phiên;
  - bắt lại đúng 1 lần.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(research): in-page GraphQL session with auto-captured doc_id`.

### Task 4: Chọn profile xoay vòng (thuần)

**Files:**
- Create: `src/services/research/profileRotation.ts`
- Test: `src/__tests__/research/profileRotation.test.ts`

**Interfaces:**
- Produces:
  - `eligibleProfiles(input: { profiles: { id; name }[]; excluded: string[]; busyIds: string[]; loginStates: ProfileLoginState[]; usedLast24h: Record<string, number>; lastUsedAt: Record<string, number>; cap: number; restrictTo?: string[]; failedInScan: string[] }): string[]`: đã sắp theo spec §5 (ít mục nhất, rồi lâu chưa dùng nhất).
  - `pickGroupProfile(groupUrl, membership: Record<string, string[]>, eligible: string[]): string | null`: ưu tiên profile đã tham gia nhóm, trong số đó chọn profile ít dùng nhất; không ai tham gia thì lấy profile đủ điều kiện đầu tiên.
  - `remainingToday(profileId, usedLast24h, cap): number`

- [ ] **Step 1:** Viết test:
  - loại trừ, đang bận, `logged_out`/`checkpoint`, chạm trần, đã hỏng trong lượt → bị loại;
  - `unknown` vẫn được;
  - thứ tự ưu tiên;
  - `restrictTo`;
  - `pickGroupProfile` thành viên / không ai tham gia.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(research): profile rotation rules`.

### Task 5: `ResearchService`

**Files:**
- Create: `src/services/research/ResearchService.ts`
- Test: `src/__tests__/research/ResearchService.test.ts` (giả trình duyệt, đồng hồ, sleep)

**Interfaces:**
- Consumes: Task 1–4; `LoginChecker.observe` (đã có, truyền qua deps).
- Produces `class ResearchService`:
  - `constructor(deps: { store; openForAutomation(id); listProfiles(); isProfileBusy(id): boolean; loginStates(); groupMembership(): Record<string,string[]>; observeLogin(profileId, state: 'logged_out' | 'checkpoint'): void; readConfig(); emit(channel, data); now?; sleep?; random?; newId? })`
  - `search({ source, query, recent?, year?, limit?, profileIds?, origin }): { scanId }`
  - `scanGroupFeeds({ groupUrls?, sinceDays?, limitPerGroup?, profileIds?, origin }): { scanId }`
  - `cancel(): boolean`, `isRunning(): boolean`, `whenIdle()`, `stop()`
- **Hành vi:**
  - Một lượt mỗi lúc; đang chạy thì ném `BUSY_ERROR` (dùng lại hằng của Đăng Facebook).
  - Xoay vòng theo spec §5: mỗi profile tối đa 50 mục, chuyển profile tiếp tục từ con trỏ hiện tại, không dùng được thì bắt đầu lại và bỏ mục trùng.
  - Lỗi ở một profile → ghi `details_json`, gọi `observeLogin` khi là `logged_out`/`checkpoint`, chuyển profile.
  - `group_feed` dừng một nhóm khi gặp bài cũ hơn `sinceDays`.
  - Mỗi trang kết quả lưu ngay.
  - Sự kiện:
    - `research:progress { scanId, items, profileId }`
    - `research:finished { scanId, source, query, status, errorCode, itemCount }`
  - Luôn đóng phiên trình duyệt trong `finally`.

- [ ] **Step 1:** Viết test:
  - chia 200 mục cho 4 profile (50/profile);
  - checkpoint ở profile 2 → chuyển profile, `observeLogin`, `details_json`;
  - hết profile → `no_profile_available` + `done`;
  - không có profile nào lúc bắt đầu → `failed`;
  - trần ngày;
  - nghỉ 2–5 s giữa trang (sleep giả ghi lại);
  - huỷ trong lúc nghỉ;
  - `BUSY`;
  - `group_feed` dùng profile thành viên, `not_member`, `sinceDays`;
  - `query_changed` → `failed`;
  - `parse_failed` trang đầu → `failed`, trang sau → `done`.
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS.
- [ ] **Step 3:** Commit: `feat(research): scan orchestration with profile rotation`.

### Task 6: Nối vào Electron

**Files:**
- Create: `electron/ipc/researchIpc.ts`
- Modify:
  - `electron/main.ts` (đăng ký, dừng khi thoát/đổi workspace, theo cách Đăng Facebook làm);
  - `electron/preload.ts`;
  - `src/ui/lib/ipc.ts` (typings);
  - `src/__tests__/http/relayChannelPolicy.test.ts` (thêm kênh vào danh sách boss-only, chỉ thêm).
- Docs: `SYSTEM_DOCUMENTATION.md` (mục Nghiên cứu chủ đề: bảng, cấu hình, xoay vòng, giới hạn, IPC)

**Interfaces:**
- Consumes: Task 5; `getBrowserProfileService().openForAutomation`; `isFacebookPosterBusy`; trạng thái đăng nhập (`listFacebookLoginStates`); observe đăng nhập (export một hàm từ `facebookPosterIpc.ts` gọi `checker.observe(id, state, 'run')`); `fb_poster_groups` cho membership.
- Produces:
  - IPC (có chặn chế độ nhân viên như các module khác): `research:getConfig`, `research:setConfig`, `research:search`, `research:scanGroupFeeds`, `research:list`, `research:get`, `research:cancel`, `research:exportXlsx` (hộp lưu tệp, dùng `xlsx`), `research:profileUsage` (số mục 24 giờ của từng profile).
  - Sự kiện broadcast `research:progress` / `research:finished`.
  - `export function researchOperations` dùng chung cho Control API.
- **Profile bận:**
  - Profile đang có lượt Đăng Facebook chạy = các `profileId` trong `current().progress.profiles`.
  - Lượt quét không bao giờ chọn profile đó.
  - Ngược lại, lượt đăng chạm phải profile đang bị quét thì nhận lỗi mở profile như hiện tại.

- [ ] **Step 1:** Viết code. Chạy cả 2 lệnh tsc, `npx jest --runInBand src/__tests__/research src/__tests__/http/relayChannelPolicy.test.ts`, `check-docs`.
- [ ] **Step 2:** Commit: `feat(research): electron wiring, IPC and export`.

### Task 7: Control API

**Files:**
- Modify:
  - `src/services/control/ControlMethods.ts`;
  - `src/services/control/controlEvents.ts`;
  - `electron/ipc/controlApiIpc.ts`;
  - `electron/ipc/researchIpc.ts` (phát sự kiện control).
- Docs: `docs/protocol/maihub-control-protocol.md` (5 thao tác, sự kiện, mã lỗi), `SYSTEM_DOCUMENTATION.md` (số thao tác 19 → 24)
- Test: `src/__tests__/control/ControlMethods.test.ts`, `controlWiring.test.ts` (chỉ thêm, hoặc sửa danh sách `describe`)

**Interfaces:**
- Produces:
  - `research.search`, `research.scanGroupFeeds`, `research.list`, `research.get`, `research.cancel`, đúng tham số và lỗi ở spec §8 (`profileIds` có mã lạ → `NOT_FOUND` + `details.missing`).
  - `ControlEventType` thêm `'research.finished'`; builder `buildResearchFinished`.

- [ ] **Step 1:** Viết test kiểm tham số, `BUSY`, `NOT_FOUND`, `describe` có 5 thao tác mới, payload sự kiện. Chạy test, xác nhận FAIL. Viết code. Chạy lại cho PASS. Chạy tsc, `check-docs`.
- [ ] **Step 2:** Commit: `feat(control): research methods and research.finished event`.

### Task 8: Tab "Nghiên cứu"

**Files:**
- Create: `src/ui/features/facebookPoster/ResearchTab.tsx`, và nếu file lớn thì tách thêm `ResearchProfilesPanel.tsx`, `ResearchResultsTable.tsx`.
- Modify: `src/ui/features/facebookPoster/FacebookPosterView.tsx` (thêm mục `research` vào danh sách section và điều hướng, như `history`).

**Interfaces:**
- Consumes: IPC của Task 6.
- Theo spec §9:
  - bảng profile (đã quét / trần, trạng thái đăng nhập, ô "Không dùng để quét", sửa trần);
  - form quét;
  - tiến độ và Huỷ;
  - danh sách lượt quét;
  - bảng kết quả sắp xếp được, có phân trang, cột người đăng có link;
  - nút xuất Excel.
- Bảng cuộn ngang trong khung riêng. Không tràn ngang ở 390 px. Sáng/tối dùng class có sẵn.

- [ ] **Step 1:** Viết code. Chạy tsc `-p tsconfig.json`, phải sạch.
- [ ] **Step 2:** Commit: `feat(research): research tab with profiles, scans and results`.

### Task 9 (controller): Kiểm chứng và phát hành

- [ ] **Step 1:** Review toàn nhánh bằng Opus. Một lượt sửa, một re-review.
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, cả 2 lệnh tsc, `check-docs`.
  - App dev chạy với dữ liệu tách riêng. Với profile thật anh chỉ định, mỗi nguồn quét `limit = 20` (chỉ đọc).
  - Giao diện ở 1280/390 px, sáng/tối. Xuất Excel.
  - Bot gọi `research.search` qua bridge (`maihub_bridge.py call`).
  - Hồi quy Đăng Facebook.
- [ ] **Step 3:** Cập nhật version, changelog, dòng phiên bản trong tài liệu, trạng thái spec cùng "Ghi chú sau phát hành", và "Điều chỉnh khi triển khai" của plan. Merge, tag; anh push; kiểm tra CI.
