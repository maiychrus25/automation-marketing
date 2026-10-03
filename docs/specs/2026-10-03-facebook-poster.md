# Thiết kế: Đăng bài Facebook trên Browser Profiles (đợt 1)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 03/10/2026 |
| Trạng thái | Chờ duyệt |
| Intent | `docs/intent/2026-10-02-facebook-poster.md` |
| Bằng chứng kỹ thuật | `docs/reports/2026-10-03-browser-automation-pipe-spike.md` |
| Kế hoạch triển khai | `plan.md` (thư mục gốc của nhánh `feat/facebook-poster`) |
| Mã nguồn được chuyển sang | Kho `maiychrus25/tools-facebook`, commit `c135379` |

## 1. Mục tiêu

Người dùng Boss/Standalone chọn nhiều browser profile đã đăng nhập Facebook, soạn một bài, và MaiHub tự đăng bài đó lên các nhóm hoặc Page bằng trình duyệt antidetect của từng profile. Kèm theo: bình luận đầu tiên, quét danh sách nhóm, tìm và xin vào nhóm, thu bình luận của bài đã đăng, lịch sử.

Đợt 1 đạt khi:

1. Một lượt đăng trên ít nhất hai profile song song: mỗi bài lên đúng nhóm, đúng tài khoản, đi qua proxy của profile đó.
2. Chế độ Page đăng lên đúng Page mà profile đang đứng danh tính, và nhật ký ghi danh tính đó trước khi đăng.
3. Bình luận đầu tiên lên đúng bài khi có link bài; bài chờ duyệt thì không bình luận và người dùng được báo.
4. Quét nhóm, xin vào nhóm và thu bình luận chạy được trên một profile.
5. Lịch sử ghi đúng kết quả từng nhóm của từng profile, xem lại được sau khi khởi động lại app.
6. Trình duyệt mở để tự động hóa có đúng tham số dòng lệnh như khi mở tay, cộng thêm `--remote-debugging-pipe`, và không mở cổng TCP nào.
7. Không tính năng hiện có nào của MaiHub thay đổi hành vi. Riêng Browser Profiles: mở tay, đóng, giới hạn 30, đóng khi thoát app và khi chuyển workspace vẫn như trước.

## 2. Ngoài phạm vi

- Bước workflow (`trigger.schedule`, `trigger.webhook`) và quyền cho nhân viên: đợt 2.
- Công cụ TopCV của FB Poster.
- Nhập lịch sử và bình luận cũ của FB Poster.
- Lấy link bài khi đăng Page. Giữ nguyên giới hạn của FB Poster: không có link thì không bình luận, trạng thái `no_post_url`.
- Đăng nhập Facebook tự động. Người dùng mở profile bằng tay ở màn hình Trình duyệt và đăng nhập.
- Nội dung khác nhau giữa các profile, cú pháp spin.
- Gắn tự động hóa vào một profile đang mở tay.

## 3. Kiến trúc

```
Renderer: FacebookPosterView (4 tab)
   │  window.electronAPI.facebookPoster.*      sự kiện facebookPoster:*
Preload (contextBridge)
   │  ipcMain 'facebookPoster:*'
facebookPosterIpc.ts ── kiểm tra input, chặn chế độ employee
   │
FacebookPosterService ── một việc tại một thời điểm, chạy nhiều profile song song, hủy, ghi lịch sử
   │      ├── tasks: postToTargets / scanGroups / searchAndJoinGroups / collectComments  (một profile)
   │      └── DatabaseService: fb_poster_runs, fb_poster_results, fb_poster_groups, fb_poster_comments
   │
BrowserProfileService.openForAutomation(id) ── chiếm chỗ trong map đang chạy, Playwright khởi chạy qua đường ống
   └── buildLaunchArgs + ProxyForwarder (đã có)
```

### 3.1 Các đơn vị

| Đơn vị | Vị trí | Trách nhiệm |
|---|---|---|
| `BrowserProfileService` (sửa) | `src/services/browser/BrowserProfileService.ts` | Thêm `openForAutomation(id)`. Mục đang chạy có thêm loại `manual` hoặc `automation` |
| `launchAutomationBrowser` | `src/services/browser/automationLauncher.ts` | Gọi `chromium.launchPersistentContext` của `playwright-core` với tham số ở mục 4; tiêm được để test |
| Hàm chạy trong trang và tác vụ | `src/services/facebookPoster/*.ts` | Chuyển từ FB Poster, xem mục 6 |
| `FacebookPosterService` | `src/services/facebookPoster/FacebookPosterService.ts` | Điều phối một việc trên nhiều profile, mục 7 |
| Kho dữ liệu | `DatabaseService` (sửa) | Bốn bảng và các hàm đọc ghi, mục 5 |
| `facebookPosterIpc.ts` | `electron/ipc/facebookPosterIpc.ts` | Handler `facebookPoster:*`, mục 8 |
| Giao diện | `src/ui/features/facebookPoster/` | Màn hình bốn tab, mục 9 |

## 4. Mở profile để tự động hóa

`BrowserProfileService.openForAutomation(id: string): Promise<AutomationSession>`

```ts
interface AutomationSession {
    context: import('playwright-core').BrowserContext;
    /** Đóng tử tế (context.close), chờ tối đa FORCE_KILL_DELAY_MS rồi mới giết cứng. Gọi nhiều lần không sao. */
    close(): Promise<void>;
}
```

Thứ tự kiểm tra giống `open(id)`: đang chạy (bất kể loại) thì lỗi "Profile đang mở. Đóng profile trước khi chạy tự động"; đủ 30 thì lỗi giới hạn; chưa có nhân, chưa có profile, proxy mất thì lỗi như `open`. Chiếm chỗ trong map trước `await` đầu tiên, giống `open`.

Tham số khởi chạy, đúng như spike đã đo (cách "bỏ hết cờ mặc định"):

```ts
chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    viewport: null,               // không ép kích thước, để giống lúc mở tay
    ignoreDefaultArgs: true,      // Playwright không thêm 38 cờ mặc định
    args: ['--remote-debugging-pipe', ...buildLaunchArgs({ userDataDir, fingerprint, persona, proxyPort })],
    timeout: 60000,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
});
```

`buildLaunchArgs` đã chứa `--user-data-dir`. Không sửa `buildLaunchArgs`.

Vòng đời:

- `context.on('close')` → giải phóng mục, dừng forwarder, phát `browserProfile:statusChanged`. Danh sách profile đang chạy ở màn hình Trình duyệt hiện cả profile đang tự động hóa.
- `close(id)` từ màn hình Trình duyệt với mục `automation` → gọi `session.close()`. Việc đang chạy trên profile đó sẽ lỗi ở bước kế tiếp và ghi kết quả `failed`.
- `closeAll()` (thoát app, chuyển workspace) → mục `automation` gọi `session.close()` không chờ; mục `manual` như cũ.
- Đóng tử tế bằng `context.close()` để cookie được ghi. Quá `FORCE_KILL_DELAY_MS` thì giết tiến trình của trình duyệt.

Không chạy được trong chế độ employee: `facebookPosterIpc` chặn trước khi tới đây.

## 5. Dữ liệu

Bốn bảng mới trong SQLite của workspace, tạo trong `DatabaseService` cùng chỗ với `browser_profiles`, theo mẫu `CREATE TABLE IF NOT EXISTS`.

```sql
CREATE TABLE IF NOT EXISTS fb_poster_runs (
    id           TEXT PRIMARY KEY,          -- uuid
    kind         TEXT NOT NULL,             -- 'post' | 'join' | 'scan_groups' | 'collect_comments'
    mode         TEXT NOT NULL DEFAULT '',  -- 'group' | 'page' với kind='post', rỗng với kind khác
    params_json  TEXT NOT NULL,             -- tham số việc, KHÔNG chứa mật khẩu proxy
    status       TEXT NOT NULL,             -- 'running' | 'done' | 'cancelled' | 'failed'
    error        TEXT NOT NULL DEFAULT '',
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS fb_poster_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL,          -- fb_poster_runs.id
    profile_id     TEXT NOT NULL,          -- browser_profiles.id
    profile_name   TEXT NOT NULL,          -- chụp lại tên lúc chạy, để lịch sử đọc được khi profile đã xóa
    target_url     TEXT NOT NULL,
    target_name    TEXT NOT NULL DEFAULT '',
    outcome        TEXT NOT NULL,          -- xem bảng bên dưới
    error          TEXT NOT NULL DEFAULT '',
    post_url       TEXT DEFAULT NULL,
    comment_status TEXT NOT NULL DEFAULT 'not_requested',
    identity       TEXT NOT NULL DEFAULT '',  -- danh tính đọc từ ô soạn bài
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_results_run ON fb_poster_results(run_id);

CREATE TABLE IF NOT EXISTS fb_poster_groups (
    profile_id   TEXT NOT NULL,
    url          TEXT NOT NULL,           -- dạng chuẩn https://www.facebook.com/groups/<id hoặc slug>/
    name         TEXT NOT NULL DEFAULT '',
    scanned_at   INTEGER NOT NULL,
    PRIMARY KEY (profile_id, url)
);

CREATE TABLE IF NOT EXISTS fb_poster_comments (
    key          TEXT PRIMARY KEY,        -- author_id + '\u0000' + post_url + '\u0000' + text, như keyOf của FB Poster
    profile_id   TEXT NOT NULL,           -- profile đã thu
    post_url     TEXT NOT NULL,
    author_id    TEXT NOT NULL DEFAULT '',
    author_name  TEXT NOT NULL DEFAULT '',
    author_url   TEXT NOT NULL DEFAULT '',
    text         TEXT NOT NULL DEFAULT '',
    commented_at TEXT NOT NULL DEFAULT '', -- chữ thời gian Facebook hiển thị, ví dụ "2 giờ"
    collected_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_comments_post ON fb_poster_comments(post_url);
```

Giá trị `outcome`: kind `post` dùng `posted`, `failed`, `skipped`; kind `join` dùng `joined`, `pending`, `skipped`, `failed`, `unknown` (đúng như `join.js`); kind khác dùng `done`, `failed`. Giá trị `comment_status`: `not_requested`, `posted`, `no_post_url`, `pending_approval`, `post_not_found`, `failed` (đổi từ `khong-yeu-cau`, `da-dang`, `khong-co-link`, `cho-duyet`, `khong-thay-bai`, `hong` của FB Poster).

- Quét lại nhóm của một profile thay thế toàn bộ dòng của profile đó trong `fb_poster_groups`, trong một transaction.
- Xóa browser profile: xóa luôn dòng của profile đó trong `fb_poster_groups`. Lịch sử và bình luận giữ lại.
- App khởi động: mọi run còn `status='running'` đổi thành `failed` với `error='App đóng khi việc đang chạy'`.

## 6. Mã chuyển từ FB Poster

Chuyển sang TypeScript, giữ nguyên logic và mọi chú thích ghi bằng chứng đo được. Đổi tên định danh sang tiếng Anh theo bảng trong `plan.md`. Chú thích giữ tiếng Việt.

| FB Poster | MaiHub | Ghi chú |
|---|---|---|
| `src/post.js` | `facebookPoster/postToTargets.ts` | Một profile, nhiều đích |
| `src/binh-luan-bai.js` | `facebookPoster/firstComment.ts` | |
| `src/join.js` | `facebookPoster/joinGroups.ts` | |
| `src/groups.js` | `facebookPoster/scanGroups.ts` | |
| `src/comments.js` | `facebookPoster/collectComments.ts` | Ghi vào `fb_poster_comments` thay vì tệp |
| `src/human.js`, `src/targets.js` | `facebookPoster/humanize.ts`, `facebookPoster/targets.ts` | |
| `src/login.js` (`isLoggedIn`) | `facebookPoster/loginState.ts` | Chỉ chuyển phần kiểm tra đã đăng nhập |
| `src/history.js`, `src/comments-store.js`, `src/jobs.js`, `src/app.js`, `server.js` | Không chuyển | Thay bằng bảng SQLite, `FacebookPosterService`, IPC |
| `src/browser.js` | Không chuyển | Thay bằng `openForAutomation` |
| `public/*` | Không chuyển | Thay bằng giao diện React |

Quy tắc bắt buộc khi chuyển:

1. **Hàm chạy trong trang** (truyền cho `page.evaluate`) phải tự chứa: không gọi hàm hay hằng ở ngoài, nhận dữ liệu qua đúng một tham số, có tên. Không gọi `console.*` trong các hàm này: bước dựng production (`scripts/strip-console.js`) xóa mọi `console.*(...)` bằng biểu thức chính quy và có thể cắt hỏng mã.
2. **Không dùng `page.setContent`** trên nhân trình duyệt này: spike đo được nó treo. Dùng `page.goto`.
3. **Tìm phần tử theo chữ hiển thị**, không theo class sinh tự động. Giữ các chuỗi đã đo ở cả tiếng Việt và tiếng Anh, gồm `COMPOSER_INVITE`.
4. **Chỉ tin bằng chứng dương**: đăng xong khi hộp soạn đóng (nhóm) hoặc rời `/post/create` (Page); bình luận xong khi số khối bình luận tăng và thấy đúng chữ.
5. **Cú bấm thật cho các nút quan trọng.** Bốn chỗ: mở ô soạn bài, nút Đăng, nút gửi bình luận, nút tham gia nhóm. Hàm trong trang chỉ tìm và gắn thuộc tính đánh dấu `data-maihub-target`; phía Node bấm bằng `page.locator('[data-maihub-target="…"]').click()`. Các cú bấm khác giữ `element.click()` như FB Poster.
6. Bỏ phần đọc `process.env` của FB Poster. Thời gian nghỉ đến từ tham số việc.

## 7. Điều phối việc

`FacebookPosterService` là singleton trong main process.

- **Một việc tại một thời điểm.** Bắt đầu việc mới khi đang có việc thì lỗi "Đang có việc chạy".
- **Loại việc:**

| kind | Tham số | Mỗi profile làm gì |
|---|---|---|
| `post` | `mode`, `text`, `mediaPath?`, `comment?`, `profiles[]` mỗi phần tử `{ profileId, targets[] }`, `minDelaySec`, `maxDelaySec`, `concurrency` | `postToTargets` qua các đích của profile đó; `mode='page'` thì đích là `https://www.facebook.com/` |
| `scan_groups` | `profileIds[]` | `scanGroups`, ghi đè `fb_poster_groups` của profile |
| `join` | `profileId`, `keywords[]`, `limit`, `minDelaySec`, `maxDelaySec` | `searchAndJoinGroups` |
| `collect_comments` | `profileId`, `postUrls[]` | `collectComments` |

- **Song song:** kind `post` và `scan_groups` chạy tối đa `concurrency` profile cùng lúc, mặc định 3, cho phép 1 đến 10. Kind `join` và `collect_comments` chạy một profile.
- **Lệch giờ:** profile thứ k (k ≥ 1) chỉ bắt đầu sau profile thứ k−1 một khoảng ngẫu nhiên từ 30 đến 90 giây. Trong một profile, giữa hai đích nghỉ ngẫu nhiên từ `minDelaySec` đến `maxDelaySec` (mặc định 300 và 900, như FB Poster).
- **Kiểm tra đăng nhập** trước khi làm gì trên một profile: chưa đăng nhập thì mọi đích của profile đó ghi `failed` với lỗi "Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập", và chuyển sang profile khác.
- **Hủy:** đặt cờ dừng; mỗi tác vụ kiểm tra cờ giữa các bước như FB Poster; đích chưa làm ghi `skipped`; mọi phiên tự động hóa đóng tử tế; run ghi `cancelled`.
- **Lỗi một profile không làm hỏng các profile khác.** Không mở được profile (đang mở tay, quá giới hạn, proxy mất) thì mọi đích của profile đó ghi `failed` với lỗi tương ứng.
- **Ghi kết quả** ngay sau mỗi đích, không đợi hết việc, để app sập vẫn còn phần đã làm.
- **Sự kiện tới renderer** qua `EventBroadcaster.emit`:

| Kênh | Dữ liệu |
|---|---|
| `facebookPoster:log` | `{ runId, profileId, level: 'info'|'success'|'warning'|'error', message, at }` |
| `facebookPoster:progress` | `{ runId, done, total, profiles: [{ profileId, state, done, total }] }` |
| `facebookPoster:runFinished` | `{ runId, status }` |

- **Thoát app và chuyển workspace:** gọi `cancelAll()` trước `closeAllBrowserProfiles()`.

## 8. IPC

Mọi handler trả `{ success, ... }` hoặc `{ success: false, error }` và từ chối khi `AppModeManager` ở chế độ employee, theo đúng hàm `handle` của `browserProfileIpc.ts`.

| Kênh | Tham số | Kết quả |
|---|---|---|
| `facebookPoster:start` | `{ kind, params }` | `{ runId }` |
| `facebookPoster:cancel` | — | — |
| `facebookPoster:current` | — | `{ run \| null, progress \| null }` |
| `facebookPoster:listGroups` | `{ profileIds[] }` | `{ groups: { [profileId]: { url, name, scannedAt }[] } }` |
| `facebookPoster:listRuns` | `{ limit?, offset?, kind? }` | `{ runs[], total }` |
| `facebookPoster:getRun` | `{ runId }` | `{ run, results[] }` |
| `facebookPoster:listComments` | `{ postUrl?, limit?, offset? }` | `{ comments[], total }` |
| `facebookPoster:pickMedia` | — | `{ path \| null }` (hộp chọn tệp ảnh/video của hệ điều hành) |
| `facebookPoster:exportRunCsv` | `{ runId }` | `{ path \| null }` (hộp lưu tệp) |

Kiểm tra input ở IPC:

- `kind` thuộc bốn giá trị; `mode` là `group` hoặc `page`.
- `text` không rỗng, tối đa 63.206 ký tự (giới hạn bài Facebook); `comment` tối đa 8.000 ký tự.
- Mỗi `profileId` phải tồn tại; mỗi đích phải chuẩn hóa được bằng `normalizeTarget`; tổng số đích tối đa 500.
- `mediaPath` nếu có phải tồn tại và có đuôi ảnh/video (`jpg`, `jpeg`, `png`, `gif`, `webp`, `mp4`, `mov`, `webm`).
- `minDelaySec` ≥ 0, `maxDelaySec` ≥ `minDelaySec`, tối đa 86.400; `concurrency` từ 1 đến 10; `limit` từ 1 đến 200.

## 9. Giao diện

- Thêm `'facebookPoster'` vào `AppView` (`src/ui/store/appStore.ts`), một `NavItem` "Đăng Facebook" ngay dưới "Trình duyệt" trong `Sidebar.tsx` với cùng điều kiện hiện (`empMode !== 'employee' && !isSimulating`), một biểu tượng mới trong `NavIcon`, và một nhánh trong `App.tsx` dựng `FacebookPosterView`.
- `FacebookPosterView` có bốn tab:
  1. **Đăng bài:** chọn chế độ Nhóm/Page; ô nội dung; chọn tệp ảnh/video; ô bình luận đầu tiên; chọn profile (danh sách browser profile, lọc theo nhóm profile, hiện trạng thái đang chạy); với chế độ Nhóm, mỗi profile đã chọn có danh sách nhóm đã quét kèm ô lọc từ khóa dùng chung và nút "Quét lại nhóm"; thời gian nghỉ tối thiểu/tối đa; số profile song song; nút Bắt đầu/Hủy.
  2. **Tham gia nhóm:** một profile, từ khóa (mỗi dòng một từ), giới hạn, thời gian nghỉ.
  3. **Bình luận:** chọn một profile và các link bài từ lịch sử (bài có `post_url`), nút thu; bảng bình luận đã thu có tìm kiếm.
  4. **Lịch sử:** danh sách run, xem chi tiết kết quả theo profile và đích, xuất CSV.
- Khung tiến độ dùng chung cho mọi tab: thanh tiến độ tổng, trạng thái từng profile, nhật ký cuộn có màu theo mức.
- Có việc đang chạy thì các nút Bắt đầu ở mọi tab bị tắt và hiện lý do.
- Dùng lại component và lớp Tailwind có sẵn (`ConfirmDialog`, `Spinner`, icon chung, `showNotification`) và token trong `DESIGN.md`. Thêm vào `DESIGN.md` một mục ngắn cho màn hình này, không thêm token mới nếu không cần.
- Trạng thái rỗng (chưa có profile, chưa quét nhóm, chưa có lịch sử), đang tải, lỗi.
- Hỗ trợ sáng/tối; không tràn ngang ở bề rộng 375 px và 1440 px; không chồng chữ.

## 10. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Profile đang mở tay | Đích của profile đó `failed`, lỗi "Profile đang mở. Đóng profile trước khi chạy tự động" |
| Chưa cài nhân trình duyệt | Không cho bắt đầu; IPC trả lỗi yêu cầu tải ở màn hình Trình duyệt |
| Facebook đổi giao diện, không tìm thấy ô soạn | Đích `failed`, lỗi ghi rõ chữ đang tìm, như FB Poster |
| Nút Đăng đang tắt | Không bấm, đích `failed`, "Facebook chưa ghi nhận nội dung trong ô soạn" |
| Người dùng đóng cửa sổ trình duyệt giữa chừng | Phiên đóng → đích đang làm `failed`, các đích còn lại của profile `skipped` |
| App thoát giữa chừng | Hủy việc; lần mở sau run còn `running` đổi thành `failed` |
| Bình luận hỏng | Không đổi `outcome` của bài; chỉ ghi `comment_status` |

## 11. Kiểm thử

**Unit test** (jest, `src/__tests__/facebookPoster/` và `src/__tests__/browser/`):

- Chuyển các test của FB Poster cho phần được chuyển: `post.test.js`, `binh-luan-bai.test.js`, `composer-invite.test.js`, `join.test.js`, `groups.test.js`, `comments.test.js`, `targets.test.js`. Giữ nguyên tình huống và kết luận, đổi tên theo bảng.
- `BrowserProfileService.test.ts`: thêm tình huống `openForAutomation` (chặn khi đang mở tay, chặn mở tay khi đang tự động hóa, giải phóng khi phiên đóng, `closeAll` đóng cả phiên tự động hóa, tham số khởi chạy có `--remote-debugging-pipe` và đúng bộ của `buildLaunchArgs`).
- `FacebookPosterService.test.ts`: với tác vụ và launcher giả, kiểm tra một việc tại một thời điểm, giới hạn song song, lệch giờ, hủy giữa chừng, lỗi một profile không lan, ghi kết quả từng đích.
- Hàm đọc ghi bảng mới trong `DatabaseService` với SQLite tạm.

**Kiểm tra tích hợp không đăng thật** (`scripts/dev/facebook-poster-dry-run.js`, chỉ chạy tay): mở một profile thật bằng `openForAutomation`, đo tham số dòng lệnh, xác nhận không có cổng TCP, mở ô soạn bài trong một nhóm, gõ chữ, kiểm nút Đăng bật, đóng mà không đăng.

**Kiểm tra tay trên dev** (Linux; Windows bằng bộ cài từ CI), hai vòng, mỗi vòng ở 1440 px và 375 px, cả sáng và tối:

1. Quét nhóm trên hai profile.
2. Đăng một bài thử lên một nhóm thử do người dùng chỉ định, trên hai profile song song, có bình luận đầu tiên. Chỉ đăng thật khi người dùng cho phép.
3. Đăng Page trên một profile đứng danh tính Page.
4. Hủy giữa chừng; đóng cửa sổ trình duyệt giữa chừng.
5. Xin vào nhóm theo một từ khóa với giới hạn 1; thu bình luận của bài vừa đăng.
6. Lịch sử và CSV.
7. Hồi quy: Browser Profiles mở/đóng tay, giới hạn 30, chuyển workspace, thoát app; Chat, CRM, Workflow, proxy cho account Zalo.

Lệnh kiểm chứng: `npx jest`, `npx tsc -p tsconfig.electron.json --noEmit`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit`, `npm run build:electron`, `npm run build:renderer`.

## 12. Rủi ro đã biết

- Facebook đổi giao diện thường xuyên; mọi chuỗi nhận dạng nằm ở hằng số có test riêng để sửa nhanh.
- Playwright `1.62.x` nhắm Chromium 151, nhân đang ở 148. Spike đo được khởi chạy, `goto`, `evaluate`, tải tệp chạy được; `setContent` treo.
- Bản Windows chưa được đo với Playwright qua đường ống.
- Bộ cài: `playwright-core` phải có trong gói. Cần kiểm trong bản đã dựng (mục 11) và thêm vào `asarUnpack` nếu khởi chạy lỗi.
- Đăng cùng một nội dung bằng nhiều tài khoản dễ bị Facebook coi là spam.
