# Đăng Facebook cho nhân viên (đợt 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhân viên có quyền "Đăng Facebook" soạn, lên lịch, chạy và xem kết quả đăng bài bằng các hồ sơ trình duyệt được gán cho mình, từ máy của mình; mọi lượt chạy vẫn diễn ra trên máy boss.

**Architecture:** Máy chủ chuyển tiếp là nơi duy nhất quyết định: nó kiểm quyền `fb_poster`, kiểm mọi hồ sơ và bản ghi mà lệnh nhắc tới, rồi gắn phạm vi hồ sơ (`_profileScope`) vào tham số; handler của Đăng Facebook lọc danh sách và số liệu theo phạm vi đó. Sự kiện mang nội dung đi theo loại người nhận mới "hồ sơ"; sự kiện báo thay đổi đi theo quyền với payload đã rút gọn. Luật nằm trong tệp thuần.

**Tech Stack:** TypeScript 5, Electron 41, React 18, Socket.IO, better-sqlite3, Jest + ts-jest.

**Spec:** `docs/specs/2026-11-17-employee-reconnect-telegram-poster.md` (mục 5, 6).

## Global Constraints

- Nhánh `feat/employee-stages-3-5`. Không push, không tag, không tăng version: phát hành làm một lần sau đợt này.
- Không bao giờ `git add` `sites/` hay `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`. Chỉ `git add` đúng các tệp của task.
- Định danh trong code bằng tiếng Anh. Chuỗi hiển thị bằng tiếng Việt, xưng "bạn". Comment theo ngôn ngữ của tệp đang sửa.
- Hành vi của boss dùng một mình không đổi: lệnh do giao diện của boss hoặc Control API gọi không có `_profileScope` và chạy y như trước.
- `_profileScope` chỉ do máy chủ chuyển tiếp đặt. Giá trị nhân viên gửi lên dưới tên đó bị bỏ. Handler không bao giờ tin `_profileScope` từ nguồn khác ngoài lệnh có `_fromRelay`.
- Mặc định từ chối: lệnh `facebookPoster:*` chưa xếp nhóm không tới được; bản ghi không xác định được hồ sơ thì nhân viên không dùng được (trừ chiến dịch rỗng, xem Task 2); sự kiện không xác định được hồ sơ thì không tới ai.
- Không mở cho nhân viên: `engagement:*`, `autonomy:*`, `research:*`, `video:*`, `proxy:*`, mọi `browserProfile:*` trừ `list`, xuất tệp, cấu hình kiểm tra đăng nhập, cấu hình thông báo, `facebookPoster:takeMissed`.
- Không ghi vào log: nội dung bài, bình luận, khách tiềm năng, đường dẫn tệp, payload sự kiện. Không gọi Facebook thật và không mở trình duyệt trong kiểm thử; dữ liệu mẫu tổng hợp và đúng hình dạng bảng thật (`fb_poster_schedules` và `fb_poster_runs` không có cột hồ sơ, hồ sơ nằm trong `params_json`; `fb_poster_results`, `fb_poster_comments`, `fb_poster_leads`, `fb_poster_lead_replies`, `fb_poster_post_tracking`, `fb_poster_groups`, `fb_poster_login_state` có cột `profile_id`; `fb_poster_campaigns` không có chủ).
- Giao diện: đọc `DESIGN.md` trước khi sửa JSX; không thêm màu, cỡ, component mới; sáng và tối nhất quán; không tràn ngang; giữ thao tác bàn phím.
- Không sửa hai kiểm thử nhạy tải (`mobileSyncService.test.ts › longRunOfSkippedRowsYieldsAndHonoursCancel`, `pageCampaignAutonomy.integration.test.ts › 50 distinct contenders…`). Không thêm dependency. Không tái cấu trúc ngoài chỗ task nêu.
- Mỗi task kết thúc bằng: `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, `npx jest <các tệp test của task>` sạch, rồi commit; chạy cả bộ `npx jest` một lần và ghi tên mọi kiểm thử đỏ vào báo cáo (kiểm thử nhạy tải đỏ thì chạy lại riêng tệp đó một lần và báo cả hai kết quả).
- Thông điệp commit kết thúc bằng `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. Lệnh không mang hồ sơ lẫn mã bản ghi (`scheduleList`, `listRuns`, `leadList`, `postStats`, `active`, `getLoginStates`…): trả dữ liệu của mọi hồ sơ nếu handler quên lọc theo `_profileScope`. Task 3.
2. Lệnh coi "không truyền hồ sơ" là "mọi hồ sơ" (`checkLogins`, `trackPosts`, `commentCollect`): nhân viên chạy việc trên hồ sơ của người khác. Task 2, 3.
3. Lịch đăng hoặc lượt chạy dùng nhiều hồ sơ, trong đó có hồ sơ nhân viên không được dùng: phải bị từ chối cả khi xem, sửa, xoá, chạy, huỷ. Task 2, 3.
4. `mediaPaths` (kể cả lồng trong `params.params`) trỏ tới tệp bất kỳ trên máy boss, hoặc tệp của máy nhân viên không được tải lên. Task 3, 4.
5. Màn hình sửa quyền này xoá khoá quyền của màn hình kia khi lưu; xoá hồ sơ hoặc nhân viên để lại dòng gán mồ côi. Task 1.

---

### Task 1: Quyền `fb_poster` và gán hồ sơ cho nhân viên

**Files:**
- Create: `src/ui/lib/employeeModules.ts`
- Modify: `src/services/DatabaseService.ts` (bảng mới; `setEmployeePermissions` ~7679; `deleteEmployee` ~7646; `deleteBrowserProfile` ~3173), `src/services/employee/EmployeeService.ts`, `electron/ipc/employeeIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/services/http/HttpRelayService.ts` (`buildEmployeeSnapshot` ~317; hàm mới `allowedProfilesFor`), `src/ui/store/employeeStore.ts`, `src/ui/components/settings/EmployeeSettings.tsx`, `src/ui/pages/…/HrmPage.tsx`
- Test: `src/__tests__/ui/employeeModules.test.ts`, kiểm thử cơ sở dữ liệu hiện có của nhân viên (thêm ca), `src/__tests__/http/relayHarness.ts` (thêm `profiles` cho nhân viên)

**Interfaces:**
- Bảng (tạo vô điều kiện, không nằm trong khối chỉ chạy khi chưa có bảng `employees`): `employee_profile_access(id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, profile_id TEXT NOT NULL, UNIQUE(employee_id, profile_id))`.
- `DatabaseService`: `getEmployeeProfileAccess(employeeId): string[]`, `setEmployeeProfileAccess(employeeId, profileIds: string[]): void` (thay cả danh sách, bỏ trùng, bỏ giá trị không phải chuỗi không rỗng); `deleteEmployee` và `deleteBrowserProfile` xoá các dòng liên quan.
- `setEmployeePermissions`: ghi kiểu trộn (`INSERT … ON CONFLICT(employee_id, module) DO UPDATE SET can_access = excluded.can_access`), không xoá các khoá không có trong lần lưu.
- `EmployeeService`: `assignProfiles(employeeId, profileIds)`, `getAssignedProfiles(employeeId): string[]`.
- IPC (chỉ boss, cùng khuôn `employee:assignAccounts`): `employee:assignProfiles` `{ employeeId, profileIds }` → sau khi lưu gọi `HttpRelayService.refreshEmployeeState(employeeId, 'profiles-assigned')`; `employee:getAssignedProfiles` `{ employeeId }` → `{ success, profileIds }`.
- `HttpRelayService.allowedProfilesFor(employeeId): string[]` = hồ sơ được gán và còn tồn tại trong `browser_profiles`; rỗng khi nhân viên không có quyền `fb_poster`. Snapshot thêm `assigned_profiles: string[]` (cùng giá trị).
- `employeeModules.ts` (thuần): `EMPLOYEE_MODULE_OPTIONS: ReadonlyArray<{ key: string; label: string }>` = hợp của hai danh sách đang có ở `EmployeeSettings.tsx:12-24` và `HrmPage.tsx:28-37` (giữ nguyên nhãn đang dùng) cộng `{ key: 'fb_poster', label: 'Đăng Facebook' }`; `permissionPatch(edited: Record<string, boolean>): Array<{ module: string; can_access: boolean }>`. Cả hai màn hình dùng hằng này.
- `employeeStore`: `assignedProfiles: string[]`, đặt từ snapshot.
- `EmployeeSettings.tsx`: mục "Hồ sơ đăng Facebook" (danh sách hồ sơ từ `browserProfile:list`, chọn nhiều, cùng kiểu trình bày với "Tài khoản được quản lý"), chỉ hiện khi `fb_poster` đang bật; lưu bằng `employee:assignProfiles`.

- [ ] **Step 1: Kiểm thử đỏ**: lưu quyền từ một màn hình không làm mất khoá chỉ màn hình kia biết (ghi `{chat:true}` sau khi đã có `fb_poster:true` → `fb_poster` vẫn true); gán hồ sơ đọc lại đúng, bỏ trùng; xoá nhân viên và xoá hồ sơ dọn dòng gán; `EMPLOYEE_MODULE_OPTIONS` có đủ khoá của cả hai danh sách cũ và `fb_poster`, không trùng khoá; `allowedProfilesFor` bỏ hồ sơ đã xoá và trả rỗng khi thiếu quyền.
- [ ] **Step 2: Chạy**, FAIL.
- [ ] **Step 3: Viết mã.**
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(employee): fb_poster permission and browser profiles assigned per employee`.

### Task 2: Luật thuần: phân loại lệnh và kiểm hồ sơ

**Files:**
- Create: `src/services/facebookPoster/profileScope.ts`, `src/services/http/posterAccess.ts`
- Modify: `src/services/http/employeeChannelRoutes.ts`, `src/services/http/relayChannelPolicy.ts`
- Test: `src/__tests__/facebookPoster/profileScope.test.ts`, `src/__tests__/http/posterAccess.test.ts`, `src/__tests__/http/employeeChannelRoutes.test.ts`, `src/__tests__/http/relayChannelPolicy.test.ts`

**Interfaces:**
- `profileScope.ts` (thuần, không import):
  - `PROFILE_SCOPE_PARAM = '_profileScope'`
  - `profileIdsOfStartParams(kind: unknown, params: unknown): string[]`: `post` → `params.profiles[].profileId`; `scan_groups` → `params.profileIds`; `join`, `collect_comments` → `params.profileId`; dạng khác → `[]`
  - `profileIdsOfStoredParams(paramsJson: unknown): string[]`: nhận chuỗi JSON hoặc object của một lịch đăng / lượt chạy; hợp của `profiles[].profileId`, `profileIds`, `profileId`; JSON hỏng → `[]`
  - `isWithinScope(profileIds: readonly string[], scope: readonly string[] | undefined): boolean`: `scope` undefined → true; `profileIds` rỗng → false; còn lại: mọi mã thuộc `scope`
  - `scopeRows<T>(rows: readonly T[], profilesOf: (row: T) => readonly string[], scope: readonly string[] | undefined): T[]`
  - `readProfileScope(params: unknown): string[] | undefined`: chỉ trả mảng khi `params._fromRelay === true` và `params._profileScope` là mảng chuỗi
- `employeeChannelRoutes.ts`: `POSTER_CHANNEL_ROUTES` cho mọi lệnh đăng ký trong `electron/ipc/facebookPosterIpc.ts` và `electron/ipc/browserProfileIpc.ts`; gộp vào `EMPLOYEE_CHANNEL_ROUTES`. `modules: ['fb_poster']` cho lệnh `proxy`.
  - `proxy`: `facebookPoster:` `start`, `cancel`, `active`, `scheduleCreate`, `scheduleList`, `scheduleUpdate`, `scheduleDelete`, `campaignList`, `campaignGet`, `campaignCreate`, `campaignUpdate`, `campaignDelete`, `draftSave`, `draftGet`, `draftApprove`, `listGroups`, `listRuns`, `getRun`, `listComments`, `listPostedUrls`, `checkLogins`, `getLoginStates`, `trackPosts`, `trackStatus`, `trackCancel`, `listTracking`, `postStats`, `groupScores`, `bestTimes`, `getTrackConfig`, `setTrackConfig`, `pageMetrics`, `leadList`, `leadUpdate`, `leadConfigGet`, `leadConfigSet`, `commentCollect`, `commentCollectStatus`, `commentCollectCancel`, `listLeadReplies`; và `browserProfile:list`. Hạn chờ `PROXY_SLOW_TIMEOUT_MS` cho `start`, `draftApprove`, `scheduleCreate`, `draftSave`, `checkLogins`, `trackPosts`, `commentCollect`; còn lại `PROXY_DEFAULT_TIMEOUT_MS`.
  - `local`: `facebookPoster:pickMedia`.
  - `boss_only`: mọi lệnh còn lại của hai tệp (`current`, `takeMissed`, `exportRunCsv`, `leadExport`, `getLoginCheckConfig`, `setLoginCheckConfig`, `getNotificationConfig`, `setNotificationConfig`, `engagement:*`, `autonomy:*`, các `browserProfile:*` khác).
- `relayChannelPolicy.ts`: `EmployeeChannelRule` thêm `scope?: 'profiles'`. Lệnh `proxy` của `POSTER_CHANNEL_ROUTES` có luật `{ modules: ['fb_poster'], account: 'none', scope: 'profiles' }`.
- `posterAccess.ts` (thuần):
  - `interface PosterLookup { scheduleProfiles(id: string): string[] | null; runProfiles(id: string): string[] | null; campaignProfiles(id: string): string[] | null; leadProfiles(id: string): string[] | null; trackedPostUrls(profileIds: readonly string[]): string[] }` (`null` = không có bản ghi)
  - `type PosterCheck = { ok: true; params: Record<string, unknown> } | { ok: false; code: 'PROFILE_FORBIDDEN' | 'RECORD_FORBIDDEN' | 'PARAMS_INVALID' }`
  - `checkPosterRequest(channel: string, params: unknown, allowed: readonly string[], lookup: PosterLookup): PosterCheck`. Luật theo thứ tự:
    1. `params` phải là object thường; bỏ khoá `_profileScope` nhân viên gửi.
    2. Hồ sơ nêu trong tham số phải thuộc `allowed`: `profileId`, `profileIds` ở mức ngoài; với `start`, `scheduleCreate`, `draftSave` dùng `profileIdsOfStartParams(kind, params.params)` (`scheduleCreate` và `draftSave` luôn là `post`), và danh sách này không được rỗng với `start`, `scheduleCreate`.
    3. Bản ghi theo mã: `scheduleUpdate`, `scheduleDelete`, `draftGet`, `draftApprove`, `draftSave` (khi có `id`) → `scheduleProfiles(id)`; `getRun`, `cancel` (khi có `runId`) → `runProfiles`; `campaignGet`, `campaignUpdate`, `campaignDelete` và mọi tham số `campaignId` → `campaignProfiles`; `leadUpdate` → `leadProfiles`. `null` thì cho qua (handler tự báo không tìm thấy). Lịch đăng, lượt chạy, khách tiềm năng: `isWithinScope(profiles, allowed)`. Chiến dịch: mọi hồ sơ của nó thuộc `allowed`; chiến dịch chưa có hồ sơ nào (rỗng) được phép.
    4. `cancel` không có `runId` → `PARAMS_INVALID`.
    5. Điền mặc định thay cho "mọi hồ sơ": `checkLogins`, `trackPosts`, `listGroups` không có `profileIds` (hoặc rỗng) → `profileIds = allowed`; `commentCollect`: `postUrls` = phần giao của giá trị gửi lên với `trackedPostUrls(allowed)`, không gửi thì bằng `trackedPostUrls(allowed)`; kết quả rỗng → `PARAMS_INVALID`.
    6. Trả `params` đã chuẩn hoá kèm `_profileScope: [...allowed]`.
  - `filterBrowserProfileList(result: unknown, allowed: readonly string[]): unknown`: giữ hồ sơ thuộc `allowed`, mỗi hồ sơ chỉ còn `id`, `name`, `group_id`, `note`; `runningIds` lọc theo `allowed`; `groups` giữ nguyên tên nhóm.

- [ ] **Step 1: Kiểm thử đỏ** `profileScope.test.ts`: bốn dạng `kind`; JSON hỏng; `isWithinScope` (undefined, rỗng, đủ, thiếu một); `readProfileScope` bỏ qua khi không có `_fromRelay`.
- [ ] **Step 2: Kiểm thử đỏ** `posterAccess.test.ts`: mỗi luật 1–6 một ca được và một ca bị từ chối, gồm: lịch đăng dùng hai hồ sơ mà nhân viên chỉ có một → `RECORD_FORBIDDEN`; `start` với `profiles` rỗng → `PROFILE_FORBIDDEN`; nhân viên gửi `_profileScope: ['x']` → kết quả mang `_profileScope` bằng `allowed`; `checkLogins` không tham số → `profileIds` bằng `allowed`; `commentCollect` với địa chỉ ngoài danh sách → bị loại; chiến dịch rỗng được, chiến dịch có lịch của hồ sơ khác bị từ chối; `filterBrowserProfileList` bỏ `fingerprint`, `proxy_id`.
- [ ] **Step 3: Kiểm thử đỏ** phân loại: quét `facebookPosterIpc.ts` (mẫu `handle\(\s*'([a-zA-Z]+:[A-Za-z]+)'`) và `browserProfileIpc.ts`; tập lệnh đăng ký bằng đúng tập khoá của `POSTER_CHANNEL_ROUTES`; `engagement:approve`, `autonomy:stop`, `facebookPoster:leadExport`, `browserProfile:open` là `boss_only`; trong `relayChannelPolicy.test.ts`: `facebookPoster:start` có luật `{modules:['fb_poster'], account:'none', scope:'profiles'}`, `proxy:list` và `engagement:approve` bị từ chối.
- [ ] **Step 4: Chạy**, FAIL. **Viết mã.** **Chạy lại**, PASS; kiểm kiểu; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(employee): poster command routes and profile rules`.

### Task 3: Máy boss thực thi: kiểm ở máy chủ chuyển tiếp, lọc trong handler, tệp

**Files:**
- Modify: `src/services/http/HttpRelayService.ts` (`executeProxyAction` ~761–830; `checkFilePaths` ~1396), `src/services/http/bossFileAccess.ts`, `electron/ipc/facebookPosterIpc.ts` (các operation trả danh sách và số liệu), các tệp store của `src/services/facebookPoster/` mà các operation đó gọi
- Test: `src/__tests__/http/relayPosterAccess.test.ts` (mới, dùng `relayHarness.ts`), `src/__tests__/http/bossFileAccess.test.ts`, kiểm thử store hiện có của Đăng Facebook (thêm ca lọc theo hồ sơ)

**Interfaces:**
- Consumes: `checkPosterRequest`, `PosterLookup`, `filterBrowserProfileList` (Task 2); `readProfileScope`, `scopeRows`, `isWithinScope`, `profileIdsOfStoredParams` (Task 2); `allowedProfilesFor` (Task 1).
- `executeProxyAction`: với luật có `scope: 'profiles'`, sau bước kiểm quyền: `allowed = allowedProfilesFor(employee)`; `checkPosterRequest` với `PosterLookup` đọc cơ sở dữ liệu của boss (lịch đăng và lượt chạy: `profileIdsOfStoredParams(params_json)`, lượt chạy hợp thêm `SELECT DISTINCT profile_id FROM fb_poster_results WHERE run_id = ?`; chiến dịch: hợp hồ sơ của các lịch đăng, lượt chạy, `fb_poster_post_tracking`, `fb_poster_leads` có `campaign_id` đó; khách tiềm năng: `profile_id`; `trackedPostUrls`: địa chỉ bài trong `fb_poster_post_tracking` của các hồ sơ đó); bị từ chối thì `refuseProxy` với mã của kết quả. Tham số chuyển cho handler là `params` của kết quả. `browserProfile:list`: kết quả handler đi qua `filterBrowserProfileList`.
- `bossFileAccess.ts`: `PROXY_FILE_PATH_LIST_FIELDS` thêm `'mediaPaths'`. `ProxyFileContext` thêm `posterMediaRoot?: string` và `posterScheduleAllowed?: (scheduleId: string) => boolean`: đường dẫn nằm trong `<posterMediaRoot>/<scheduleId>/…` được phép khi hàm trả true (sửa lại bản nháp giữ tệp đã lưu). Máy chủ chuyển tiếp truyền hai giá trị này cho lệnh có `scope: 'profiles'`.
- Handler (`facebookPosterIpc.ts`): mỗi operation dưới đây đọc `scope = readProfileScope(params)` và khi `scope` có giá trị thì:
  - `scheduleList`: chỉ lịch đăng có `isWithinScope(profileIdsOfStoredParams(params), scope)`; `queuedIds` chỉ còn mã của các lịch đó.
  - `campaignList`: chỉ chiến dịch mà mọi hồ sơ của nó thuộc `scope` (chiến dịch rỗng được giữ); `campaignGet` chỉ trả lịch đăng trong `scope`.
  - `listRuns`: lấy tối đa `RUN_SCOPE_WINDOW = 1000` lượt mới nhất theo `kind`, lọc bằng hồ sơ trong `params_json`, rồi mới áp `limit` / `offset`; `total` là số sau lọc.
  - `listComments`, `listPostedUrls`, `leadList`, `listLeadReplies`, `listTracking`, `postStats`, `groupScores`, `bestTimes`, `pageMetrics`, `getLoginStates`, `listGroups`: thêm điều kiện `profile_id IN (scope)` ở câu truy vấn của store (tham số tuỳ chọn `profileIds?: readonly string[]`, không truyền thì như cũ); `total` và các số tổng tính sau lọc.
  - `active`: chỉ lượt chạy có mọi hồ sơ thuộc `scope`. `trackStatus`, `commentCollectStatus`: trả như cũ (chỉ số đếm của việc đang chạy).
  - `setTrackConfig`, `leadConfigSet`: bỏ `_fromRelay` và `_profileScope` trước khi lưu (xác nhận bằng kiểm thử rằng cấu hình đã lưu không có hai khoá này).
  - `draftGet`: với lệnh từ máy chủ chuyển tiếp, `media[].path` giữ nguyên (đường dẫn trong thư mục media của lịch); không thêm trường mới.
- Tối đa lượt chạy cùng lúc không đổi (`MAX_ACTIVE_POSTER_RUNS = 2`, chung cho boss và nhân viên).

- [ ] **Step 1: Kiểm thử đỏ** `relayPosterAccess.test.ts` (mở rộng `relayHarness.ts`: nhân viên có `profiles`, bảng giả `browser_profiles`, `fb_poster_schedules`, `fb_poster_runs`, `fb_poster_results`, `fb_poster_leads`, `fb_poster_post_tracking`, `fb_poster_campaigns` đúng cột thật): thiếu quyền `fb_poster` → `MODULE_FORBIDDEN`; `start` với hồ sơ không được gán → `PROFILE_FORBIDDEN` và handler không được gọi; `scheduleDelete` lịch của hồ sơ khác → `RECORD_FORBIDDEN`; handler nhận `_profileScope` bằng hồ sơ được dùng dù nhân viên gửi giá trị khác; `browserProfile:list` chỉ trả hồ sơ được gán, không có `fingerprint`; `mediaPaths` (ở mức ngoài và trong `params.params`) ngoài thư mục tải lên → `PATH_FORBIDDEN`; đường dẫn trong thư mục media của lịch thuộc phạm vi được phép, của lịch ngoài phạm vi bị từ chối; `engagement:approve`, `autonomy:stop`, `facebookPoster:leadExport`, `browserProfile:open`, `proxy:list` → `CHANNEL_NOT_ALLOWED`.
- [ ] **Step 2: Kiểm thử đỏ** cho từng operation có lọc (gọi operation đã xuất, cơ sở dữ liệu SQLite trong bộ nhớ với lược đồ thật `FB_POSTER_SCHEMA_SQL` + `FB_POSTER_MIGRATIONS`): hai hồ sơ, dữ liệu của cả hai; với `_fromRelay: true, _profileScope: ['p1']` chỉ thấy dữ liệu `p1` (danh sách, `total`, số liệu gộp); không có `_profileScope` thấy cả hai; có `_profileScope` nhưng thiếu `_fromRelay` thấy cả hai (lệnh của boss).
- [ ] **Step 3: Chạy**, FAIL. **Viết mã.** Ghi vào báo cáo bảng: lệnh `proxy` nào được lọc ở đâu (file:line), lệnh nào không cần lọc và vì sao.
- [ ] **Step 4: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/http src/__tests__/facebookPoster`; cả bộ Jest.
- [ ] **Step 5: Commit** `feat(relay): run poster commands for employees inside their assigned profiles`.

### Task 4: Máy nhân viên: chuyển lệnh, tải tệp, sự kiện

**Files:**
- Create: `src/services/http/posterRelayEvents.ts`
- Modify: `electron/ipc/facebookPosterIpc.ts` (hàm `handle` ~1300), `electron/ipc/browserProfileIpc.ts` (hàm `handle` ~182), `electron/ipc/proxyHelper.ts` (`prepareLocalFilesForProxy`), `src/services/socket/relayAudience.ts`, `src/services/socket/SocketIOService.ts`, `src/services/socket/relayChannels.ts`, `src/services/http/HttpRelayService.ts` (`relayEventToEmployees` ~2714; nối resolver ~422)
- Test: `src/__tests__/http/posterRelayEvents.test.ts`, `src/__tests__/socket/relayAudience.test.ts`, `src/__tests__/http/relayEventAudience.test.ts`, `src/__tests__/socket/relayChannels.test.ts`, kiểm thử của `proxyHelper` (thêm ca)

**Interfaces:**
- Consumes: `POSTER_CHANNEL_ROUTES` (Task 2), `allowedProfilesFor` (Task 1).
- Hai hàm `handle` cục bộ: đăng ký qua `routeEmployeeChannel(channel, listener)`; bộ chặn chế độ nhân viên không áp dụng cho lệnh có `route === 'local'` (để `pickMedia` mở hộp thoại trên máy nhân viên). Lệnh `boss_only` và chưa xếp nhóm vẫn bị chặn như cũ.
- `prepareLocalFilesForProxy`: tải lên cả `mediaPaths` ở mức ngoài và trong `params.params` (mảng đường dẫn; tệp không có trên máy thì giữ nguyên giá trị, như các trường khác). Tệp vượt giới hạn tải lên của máy chủ chuyển tiếp trả lỗi `UPLOAD_FAILED` sẵn có.
- `relayAudience.ts`: `RelayAudience` thêm `{ kind: 'profiles'; ids: string[] }`; `canReceiveRelayEvent(audience, employeeId, allowed, hasModule?, allowedProfiles?: readonly string[])`: loại `profiles` nhận khi `ids` không rỗng và mọi mã thuộc `allowedProfiles`. `MODULE_RELAY_CHANNELS` thêm các kênh báo thay đổi bên dưới với quyền `fb_poster`.
- `SocketIOService`: `setAllowedProfilesResolver(fn: (employeeId: string) => string[])`; dùng ở cả phát trực tiếp lẫn phát lại khi nhận bù.
- `posterRelayEvents.ts` (thuần): `posterRelayEvent(channel: string, data: unknown): { audience: RelayAudience; data: unknown } | null`:
  - `facebookPoster:log` → `profiles` `[data.profileId]`, payload nguyên.
  - `facebookPoster:progress` → `profiles` mọi `data.profiles[].profileId`, payload nguyên.
  - `facebookPoster:runFinished` → quyền `fb_poster`, `{ runId, status }`.
  - `facebookPoster:schedulesChanged` → quyền, `undefined`.
  - `facebookPoster:loginStateChanged` → quyền, `[]` (giao diện tự tải lại).
  - `facebookPoster:leadsFound` → quyền, `{ count: 0, samples: [], auto: data.auto === true, leadIds: [], campaignIds: [] }`.
  - `facebookPoster:trackProgress`, `commentCollectProgress`, `loginCheckProgress` → quyền, chỉ các khoá số và `jobId`.
  - `facebookPoster:trackFinished`, `commentCollectFinished` → quyền, `{ jobId, auto, cancelled }`.
  - Kênh khác (`scheduleMissed`, `browserProfile:*`) → `null` (không chuyển).
  - Payload không đúng dạng (thiếu `profileId`, `profiles` rỗng) → `null`.
- `relayChannels.ts`: `RELAYED_EVENT_CHANNELS` thêm đúng các kênh `posterRelayEvent` có xử lý. `relayEventToEmployees` dùng `posterRelayEvent` cho kênh `facebookPoster:*` (không qua `classifyRelayEvent`).

- [ ] **Step 1: Kiểm thử đỏ**: `posterRelayEvents` (mỗi kênh một ca; payload rút gọn không còn chữ của nhật ký, mẫu bình luận, tên hồ sơ; dạng sai → `null`); `relayAudience` (loại `profiles`: đủ, thiếu một, rỗng, không có resolver → không nhận); `relayEventAudience` (nhật ký của hồ sơ `p1` chỉ tới nhân viên được gán `p1` và có quyền; nhân viên bị bỏ gán giữa chừng không nhận lại khi nhận bù); `relayChannels` (các kênh mới có trong `validChannels`); `proxyHelper` (`mediaPaths` lồng được tải lên, thứ tự giữ nguyên).
- [ ] **Step 2: Chạy**, FAIL. **Viết mã.**
- [ ] **Step 3: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/http src/__tests__/socket`; cả bộ Jest.
- [ ] **Step 4: Commit** `feat(employee): route poster commands, upload post media and relay poster events`.

### Task 5: Giao diện Đăng Facebook cho nhân viên

**Files:**
- Create: `src/ui/lib/employeePoster.ts`
- Modify: `src/ui/App.tsx` (`VIEW_PERM_MAP` ~296; `takeMissed` và `scheduleMissed` ~550), `src/ui/components/layout/Sidebar.tsx` (~142–159, ~281), `src/ui/features/facebookPoster/` (`FacebookPosterView.tsx`, `ProfilePicker.tsx`, `LoginCheckControls.tsx`, `TrackConfigPopover.tsx`, `HistoryTab.tsx`, `LeadsTab.tsx`, `PerformancePanel.tsx`, `MediaPicker.tsx` và tab có nghe sự kiện)
- Test: `src/__tests__/ui/employeePoster.test.ts`

**Interfaces:**
- Consumes: `employeeStore.hasPermission('fb_poster')`, `assignedProfiles` (Task 1); payload rút gọn (Task 4).
- `employeePoster.ts` (thuần):
  - `EMPLOYEE_POSTER_SECTIONS: readonly string[]` = `['schedule', 'campaigns', 'join', 'comments', 'leads', 'history']`
  - `visiblePosterSections<T extends { id: string }>(sections: readonly T[], isEmployee: boolean): T[]`
  - `posterSectionFor(section: string, isEmployee: boolean): string`: mục bị ẩn đổi thành `'schedule'`
  - `canOpenView(view: string, isEmployee: boolean, hasPermission: (m: string) => boolean): boolean`: `facebookPoster` cần `fb_poster` ở chế độ nhân viên; `browser` không bao giờ mở ở chế độ nhân viên; view khác trả true (bộ chặn hiện có lo)
- Ở chế độ nhân viên: mục Đăng Facebook hiện trong thanh bên khi có quyền, chỉ gồm sáu mục trên; mục Trình duyệt không hiện; ẩn nút "Xuất CSV", "Xuất Excel", phần cấu hình kiểm tra đăng nhập (giữ nút "Kiểm tra đăng nhập"), phần cấu hình thông báo trong `TrackConfigPopover`; không gọi `takeMissed`, `engagementList`, `proxy.list`; khi nhận `loginStateChanged`, `leadsFound`, `trackFinished`, `commentCollectFinished`, `schedulesChanged` thì tải lại danh sách tương ứng thay vì đọc payload. Ảnh xem trước của tệp đã lưu ở máy boss không hiện được ở máy nhân viên: hiện tên tệp và dung lượng.
- Thêm một dòng nhắc cố định ở đầu màn hình cho nhân viên (kiểu chữ phụ sẵn có): "Lượt chạy diễn ra trên máy Boss, dùng hồ sơ được gán cho bạn."

- [ ] **Step 1: Kiểm thử đỏ** cho bốn hàm thuần (nhân viên thấy đúng sáu mục theo thứ tự gốc; boss thấy đủ; mục ẩn đổi về `schedule`; `browser` bị chặn với nhân viên kể cả khi có mọi quyền; `facebookPoster` cần `fb_poster`).
- [ ] **Step 2: Chạy**, FAIL. **Viết mã.** Ghi vào báo cáo từng chỗ JSX đã sửa (file:line) và từng lời gọi IPC trong `src/ui/features/facebookPoster/` cùng nhóm của nó (`proxy` / `local` / `boss_only`); lời gọi `boss_only` nào còn chạy ở chế độ nhân viên là lỗi phải sửa trong task này.
- [ ] **Step 3: Chạy lại**, PASS; kiểm kiểu; `npx jest src/__tests__/ui`; cả bộ Jest.
- [ ] **Step 4: Commit** `feat(ui): Facebook poster for employees with the fb_poster permission`.
