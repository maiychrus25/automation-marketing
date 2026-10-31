# Thiết kế: Bot tự học Page và đề xuất bài hằng ngày theo nội dung hot

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 26/10/2026 |
| Trạng thái | Phát hành trong 26.32.0 (31/10/2026); kiểm chứng live/vận hành bot trên VPS còn chờ |
| Intent | `docs/intent/2026-10-26-facebook-growth-bot.md` (tính năng 1) |
| Kế hoạch | `docs/plans/2026-10-26-daily-post-suggestions.md` |
| Phiên bản dự kiến | 26.32.0 |
| Dùng lại | Control API (`ControlMethods.ts`, `controlEvents.ts`), Nghiên cứu chủ đề (`src/services/research/`, `graphqlSession.ts`), khoá việc của Đăng Facebook (`acquireExclusive`), `loginProblemAt`, `posts.bestTimes`, `drafts.*`, bridge `tools/maihub-bridge/maihub_bridge.py` (`watch`, `install-watch`, `GUIDE`) |

## 0. Bối cảnh đã chốt khi phỏng vấn (26/10/2026)

- **Người dùng là khách dùng MaiHub**, không rành kỹ thuật, **chỉ nhắn tin với bot Telegram**. Khách không cấu hình gì và không mở app để duyệt.
- **Bot tự biết mỗi Page về gì**, ví dụ một Page dạy lái xe và một Page bán quần áo, rồi chủ động đề xuất bài cho từng Page.
- **Bộ não là bot AI trên VPS** (Claude CLI) gọi Control API. MaiHub chỉ thêm thao tác và giữ giới hạn an toàn.
- **Bot tạo nháp, khách duyệt bằng tin nhắn.** Bot không bao giờ tự đăng.
- **Nguồn bài hot chỉ lấy từ Facebook.**
- **`watch` dùng chính token bot (`TG_TOKEN`) và chat của bot (`ALLOWED_CHAT_ID`)** (`maihub_bridge.py:1276`), nên khách trả lời ngay trong chat đó.

## 1. Phạm vi

Làm (Control API chỉ thêm, không đổi thao tác hay sự kiện cũ):

| # | Việc | Nơi sửa |
|---|---|---|
| A | `pages.learn` / `pages.list`: đọc danh tính từng profile (Page hay người), tên, hạng mục, giới thiệu, ~10 bài gần nhất | MaiHub |
| B | `daily_briefs`, trí nhớ của bot cho từng Page: `briefs.list/get/save/delete/claimDue/finish` | MaiHub |
| C | `research.trending`: bài đang tăng tương tác nhanh, tính từ các lần quét đã lưu | MaiHub |
| D | Sự kiện `pages.learnFinished`, `briefs.finished` | MaiHub |
| E | `brief-tick` + `install-brief`: timer systemd 15 phút chạy Claude khi có việc | bridge |
| F | `watch` gửi từng nháp mới vào Telegram; `GUIDE` thêm mục "Đề xuất hằng ngày" | bridge |

Không làm trong đợt này:
- màn hình trong app (khách chỉ dùng tin nhắn);
- nút bấm Telegram (inline button);
- tự đăng khi khách im lặng;
- chấm điểm có trọng số hoặc chấm bằng AI trong MaiHub;
- nguồn ngoài Facebook;
- tính năng 2 và 3 của intent (spec riêng).

## 2. MaiHub

### 2.1 Bảng mới (database của workspace, `CREATE TABLE IF NOT EXISTS`)

**`fb_page_identities`**, do `pages.learn` ghi:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `profile_id` | TEXT PK | |
| `kind` | TEXT | `page` \| `person` \| `unknown` |
| `page_id`, `page_name`, `category` | TEXT | rỗng khi `kind != page` |
| `about` | TEXT | cắt 1000 ký tự |
| `recent_posts_json` | TEXT | ≤10 mục `{text (≤500 ký tự), reactions, comments, shares, postedAt, url}` |
| `learned_at` | INTEGER | ms epoch |
| `error_code`, `error` | TEXT | lỗi lần học gần nhất |

**`daily_briefs`**, trí nhớ của bot:

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `profile_id` | TEXT PK | phải có dòng `fb_page_identities.kind = 'page'` lúc `save` |
| `niche` | TEXT | ≤300 ký tự |
| `keywords_json` | TEXT | 1–10 chuỗi, mỗi chuỗi ≤80 ký tự |
| `group_ids_json` | TEXT | 0–20 mã nhóm nguồn |
| `tone` | TEXT | ≤500 ký tự |
| `notes` | TEXT | ≤1000 ký tự (lời khách dặn) |
| `time` | TEXT | `HH:MM`, giờ máy MaiHub, mặc định `07:00` |
| `drafts_per_day` | INTEGER | 1–5, mặc định 1 |
| `enabled` | INTEGER | 0/1, mặc định 1 |
| `last_run_date` | TEXT | `YYYY-MM-DD` theo giờ máy, ngày có lượt thành công |
| `status` | TEXT | `idle` \| `running` |
| `attempt_date`, `attempts` | TEXT, INTEGER | số lượt lỗi trong ngày |
| `claimed_at` | INTEGER | |
| `claimed_date` | TEXT | `YYYY-MM-DD` theo giờ máy, ngày nhận lượt chạy |
| `updated_at` | INTEGER | |

Tối đa 10 dòng `daily_briefs` mỗi workspace.

### 2.2 Luật chọn việc của `briefs.claimDue`

Chạy trong một giao dịch SQLite, nên hai lời gọi liên tiếp không nhận trùng một Page. Với `today` theo giờ máy, một dòng **đến lượt** khi đủ cả 5 điều kiện:

1. `enabled = 1`;
2. `last_run_date != today`;
3. giờ hiện tại ≥ `time`;
4. `attempts < 3` khi `attempt_date = today` (khác ngày thì coi `attempts = 0`);
5. `status = 'idle'`, **hoặc** `status = 'running'` và `claimed_at` cũ hơn 60 phút. Trường hợp này trước tiên được tính là một lượt lỗi (`attempts + 1`), sau đó mới xét lại điều kiện 4.

Dòng đến lượt được đổi sang `status = 'running'`, `claimed_at = now`, `claimed_date = today`.

Kết quả trả về: `{ briefs: [{ profileId, pageName, niche, keywords, groupIds, tone, notes, draftsPerDay, claimedAt }] }`.

`briefs.finish {profileId, claimedAt, ok, draftIds?, error?}`:
- yêu cầu `status = 'running'` và `claimed_at = claimedAt`, với `claimedAt` là mốc nhận lượt do `briefs.claimDue` trả về; nếu không trả `INVALID_PARAMS` và giữ nguyên lượt hiện tại. Khi lượt treo được nhận lại, completion của lượt cũ bị từ chối, không kết thúc lượt mới;
- `ok = true` → `last_run_date = claimed_date` (ngày nhận lượt, kể cả khi xong sau nửa đêm);
- `ok = false` → `attempts + 1`, `attempt_date = claimed_date`;
- luôn đặt `status = 'idle'` và phát `briefs.finished`.

Hằng số (có dấu `docs-check`): `BRIEF_MAX_ATTEMPTS_PER_DAY = 3`, `BRIEF_STALE_MS = 3600000`, `BRIEF_MAX_ROWS = 10`.

### 2.3 `pages.learn`

- **Tham số:** `{ profileIds?: string[], force?: boolean }`. Bỏ trống `profileIds` nghĩa là tất cả profile.
- **Trả về:** `{ jobId }` ngay, rồi chạy nền. Xong thì phát `pages.learnFinished { jobId, results: [{profileId, kind, pageName, error?}] }`.
- **Khoá việc:** giữ khoá chung bằng `acquireExclusive` như `PostTracker`, và nhường lịch đăng sắp đến giờ giống `makeYieldingBusy`.
  - Đang có việc dùng trình duyệt thì trả `BUSY`.
  - Không chạy song song với Nghiên cứu: `ResearchService.isRunning()` đúng thì cũng trả `BUSY`.
- **Thứ tự:** mỗi lần chỉ mở một profile, nghỉ ngẫu nhiên 20–60 s giữa hai profile.
  - Bỏ qua profile có `learned_at` trong 24 giờ qua, trừ khi `force: true`.
- **Đọc** (chỉ đọc, không bấm, không gõ):
  1. `goto https://www.facebook.com/me`, kiểm `loginProblemAt`. Có vấn đề thì ghi `error_code` (`checkpoint` / `not_logged_in`), phát `profile.loginProblem`, rồi sang profile sau.
  2. Xác định danh tính (Page hay người), tên và mã.
  3. Nếu là Page: đọc hạng mục và giới thiệu, rồi ≤10 bài gần nhất bằng `fetch('/api/graphql/')` trong trang (cách của `graphqlSession.ts`, tự bắt `doc_id`).
- **Chưa kiểm chứng:** cách nhận biết danh tính Page và truy vấn bài của Page. Phải có bước thử chỉ đọc trên 1–2 profile thật, cần anh cho phép, trước khi viết parser. Báo cáo ghi ở `docs/reports/2026-10-26-page-learn-spike.md`. Nếu GraphQL không đọc được thì đọc DOM.

`pages.list` trả về mọi dòng `fb_page_identities` (camelCase, `recentPosts` đã parse).

### 2.4 `research.trending`

**Tham số:**

| Tham số | Kiểu | Mặc định |
|---|---|---|
| `queries` | string[] | 1–10 chuỗi |
| `groupIds` | string[] | tuỳ chọn |
| `sinceHours` | 1–168 | 72 |
| `limit` | 1–100 | 20 |

Phải có ít nhất một trong hai `queries` / `groupIds`, nếu không trả `INVALID_PARAMS`.

**Nguồn:** `research_items` có `kind = 'post'`, thuộc các lượt quét `status = 'done'` trong `sinceHours` gần nhất và khớp một trong hai điều kiện:
- `source = 'posts'` với `query` khớp một trong `queries` (so khớp không phân biệt hoa thường, bỏ khoảng trắng đầu cuối);
- `source = 'group_feed'` với `place_id` thuộc `groupIds`.

**Tính:**
- **Tương tác** `e` = `reactions + comments + shares` (giá trị NULL tính là 0).
- Gom theo `fb_id`, lấy lần đầu và lần cuối theo `captured_at`.
  - **Có ≥2 lần cách nhau ≥1 giờ:** `score = (e_last − e_first) / giờ_giữa_hai_lần`, `basis = 'growth'`.
  - **Chỉ có 1 lần:** `score = e / max(1, (captured_at − posted_at) / 3600000)`, `basis = 'age'`. Không có `posted_at` thì loại.
- Loại bài có `posted_at` cũ hơn 7 ngày tính tới hiện tại.
- Sắp `score` giảm dần.

**Trả về:** `{ items: [{ fbId, url, text (title cắt 500 ký tự), placeName, placeId, engagement: e_last, score, basis, seen, postedAt }] }`.

Hằng số: `TRENDING_MAX_AGE_MS = 604800000`.

### 2.5 `briefs.*` khác

- `briefs.list` / `briefs.get {profileId}`: đọc. Kèm `pageName` lấy từ `fb_page_identities`.
- `briefs.save {profileId, niche?, keywords?, groupIds?, tone?, notes?, time?, draftsPerDay?, enabled?}`:
  - tạo mới thì bắt buộc có `keywords`; sửa thì chỉ đổi các trường được gửi;
  - không sửa được các cột trạng thái (`last_run_date`, `status`, `attempts`…);
  - vượt `BRIEF_MAX_ROWS` thì trả `LIMIT_REACHED`;
  - `briefs.get` / `briefs.delete` với `profileId` chưa có brief thì trả `NOT_FOUND`.
- `briefs.delete {profileId, confirm}`: `destructive: true`.
- **Chế độ nhân viên:** mọi thao tác trả 503 giống các thao tác Control hiện có (`ControlApiServer.ts:252`).

### 2.6 Sự kiện

Thêm vào `ControlEventType`, mỗi sự kiện có hàm `build…` riêng và chỉ giữ các trường đã công bố:
- `pages.learnFinished { jobId, results }`;
- `briefs.finished { profileId, pageName, ok, draftIds, error? }`.

## 3. Bridge (`maihub_bridge.py`, chỉ thư viện chuẩn Python 3.6+)

### 3.1 `brief-tick`

Một lượt chạy (không phải tiến trình chạy mãi):

1. Gọi `system.status`. Lỗi kết nối thì thoát mã 0, không gọi Claude.
2. **Làm quen:** nếu `pages.list` rỗng, hoặc mọi `learned_at` đã cũ hơn 7 ngày, hoặc có profile `kind = 'page'` chưa có brief, thì chạy agent với lời nhắc làm quen.
   - Claude gọi `pages.learn`, chờ `pages.learnFinished` bằng `maihub_wait_for`, rồi đọc `pages.list` và `posts.bestTimes`.
   - Claude gọi `briefs.save` cho từng Page mới và nhắn giới thiệu cho khách.
   - Tối đa một lượt làm quen mỗi 6 giờ: dấu thời gian lưu trong tệp trạng thái của tick.
3. **Đề xuất:** gọi `briefs.claimDue`. Với **từng** brief, lần lượt:
   - chạy agent với lời nhắc đề xuất bài (mục 3.2), tối đa `MAIHUB_AGENT_TIMEOUT_SEC` (mặc định 2700);
   - sau khi tiến trình thoát, gọi `briefs.get`. Vẫn `status = 'running'` thì gọi `briefs.finish {ok:false, error:"agent thoát mã X"}` (hoặc "quá giờ").
4. Chặn chạy chồng: khoá tệp `fcntl.flock` trên tệp trạng thái. Tick trước chưa xong thì tick sau thoát ngay.

**Lệnh agent:** `MAIHUB_AGENT_CMD` trong `.env` của MaiHub, mặc định `claude -p`. Lời nhắc truyền qua stdin, không đặt vào dòng lệnh để không lộ trong `ps`.

### 3.2 Lời nhắc (hằng trong bridge, tiếng Việt)

- **Làm quen:** mô tả bước 2 ở mục 3.1.
  - Bot tự viết `niche` / `keywords` / `tone` từ hạng mục, giới thiệu và các bài gần nhất của Page.
  - `time` lấy từ giờ tốt nhất của `posts.bestTimes`, không có thì dùng `07:00`.
  - `draftsPerDay = 1`.
- **Đề xuất bài:** chèn JSON của brief. Các bước:
  1. `research.search` cho từng từ khoá, `limit` ≤ 30, chờ `research.finished`.
  2. `research.trending {queries, groupIds}`.
  3. Chọn chủ đề hợp với `niche` và `notes`. Viết `draftsPerDay` bài, không chép nguyên văn bài nguồn.
  4. `drafts.create {mode:'page', profiles:[{profileId}], text, plannedAt}`. Có thể render video trước nếu chủ đề hợp.
  5. Gọi `briefs.finish {ok:true, draftIds}`.
  6. Lỗi thì gọi `briefs.finish {ok:false, error}`.
  - **Không** gọi `drafts.approve`.

### 3.3 `install-brief`

Giống `install-watch`:
1. Kiểm tệp.
2. Chạy thử `brief-tick --dry-run` dưới quyền user của bot. Dry-run gọi `system.status` và kiểm lệnh agent có trong `PATH`, không gọi Claude.
3. Ghi `maihub-brief-<bot>.service` (oneshot) và `maihub-brief-<bot>.timer` (`OnCalendar=*:0/15`, `Persistent=true`).
4. `enable --now` timer.

Unit giữ các ràng buộc `NoNewPrivileges`, `PrivateTmp`, `ReadWritePaths=<state_dir>`.

### 3.4 `watch` và `GUIDE`

`format_event` cho `briefs.finished`:
- `ok = true`: với mỗi `draftId`, gọi `drafts.get` (giống `fetch_run`) rồi gửi **một tin cho mỗi nháp**:
  - `📝 <pageName> — bài i/n · mã #<4 ký tự cuối id>`
  - nội dung (≤800 ký tự)
  - dòng `🎬 kèm video` / `🖼 kèm N ảnh` nếu có
  - `Nhắn: đăng #xxxx · sửa #xxxx … · bỏ #xxxx`
- `ok = false` và đã đủ 3 lần: `⚠️ <pageName>: hôm nay chưa tạo được bài đề xuất — <error>`. Các lần lỗi trước đó không báo.

`pages.learnFinished`: không báo. Bot tự nhắn ở lượt làm quen; lỗi đăng nhập đã có `profile.loginProblem`.

`GUIDE` thêm mục "8. Đề xuất hằng ngày", hướng dẫn bot trong chat:

| Khách nhắn | Bot làm |
|---|---|
| đăng | `drafts.approve` vào giờ `plannedAt`, hoặc giờ tốt nhất kế tiếp |
| đăng luôn | đăng ngay |
| sửa … | `drafts.update` rồi gửi lại nội dung |
| bỏ | `drafts.delete` với `confirm: true` (lời khách là sự đồng ý) |
| lời dặn về Page | `briefs.save {notes}` |
| tạm dừng / chạy lại | `briefs.save {enabled}` |
| có page mới | `pages.learn {force:true}`, rồi làm như lượt làm quen |

Thêm hai quy tắc:
- Không ghi mã thì tìm nháp đang chờ bằng `drafts.list`; có từ 2 nháp trở lên thì hỏi lại.
- Nháp quá 24 giờ chưa duyệt thì nhắc khách một lần trong lượt đề xuất sau. Không bao giờ tự duyệt.

## 4. Tương thích

- Bot cũ và bridge cũ: không gọi thao tác mới thì không có gì thay đổi. `describe` liệt kê thêm thao tác.
- Bridge mới với MaiHub cũ (<26.31.0): `brief-tick` gặp `UNKNOWN_METHOD` ở `pages.list` thì in cảnh báo một lần và thoát mã 0. `install-brief --dry-run` báo "MaiHub cần ≥ 26.31.0".
- Không đổi schema cũ. Hai bảng mới tạo bằng `IF NOT EXISTS`.

## 5. Kiểm thử

Không gọi Facebook thật, không gọi Claude thật:

- **Store `daily_briefs`:**
  - `claimDue` gọi hai lần liên tiếp không trả trùng;
  - 3 lần lỗi thì chờ sang ngày sau;
  - lượt `running` quá 60 phút thì tính là lỗi và nhận lại được;
  - chưa tới `time` thì không nhận;
  - `last_run_date` đổi theo ngày giờ máy;
  - `save` từ chối `profileId` không phải Page (`INVALID_PARAMS`) và từ chối dòng thứ 11 (`LIMIT_REACHED`).
- **`research.trending`:**
  - bài thấy 1 lần và bài thấy 2 lần ra đúng `basis` và `score`;
  - loại bài quá 7 ngày và bài không có `posted_at`;
  - so khớp `queries` không phân biệt hoa thường;
  - lọc theo `groupIds`;
  - thiếu cả hai tham số thì `INVALID_PARAMS`.
- **`pages.learn`** (fake driver như test `postToTargets`):
  - nhận ra danh tính Page và danh tính người;
  - checkpoint thì ghi lỗi, phát `profile.loginProblem`, học tiếp profile khác;
  - bỏ qua profile đã học trong 24 giờ, `force` thì học lại;
  - `BUSY` khi đang có việc đăng hoặc đang Nghiên cứu;
  - nhường lịch đăng sắp đến giờ.
- **Control API:** schema và `describe` của các thao tác mới; chế độ nhân viên trả 503; `briefs.delete` cần `confirm`.
- **Bridge (unittest):**
  - `brief-tick` với client giả và agent giả (thành công, thoát mã ≠ 0, quá giờ) gọi `briefs.finish` đúng;
  - khoá `flock` chặn chạy chồng;
  - MaiHub cũ thì thoát êm;
  - `format_event` cho `briefs.finished` (thành công, lỗi lần 1, lỗi lần 3);
  - `render_brief_unit`.
- **Không hồi quy:** `npx jest --runInBand`, `python3 -m unittest discover -s tools/maihub-bridge/tests`, hai lệnh `tsc --noEmit`, `node scripts/check-docs.js` đều sạch.

## 6. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Không đọc được danh tính Page, hoặc Facebook đổi giao diện | Bước thử thật trước khi viết parser; DOM làm phương án dự phòng; lỗi ghi vào `error` chứ không làm hỏng lượt học |
| Mỗi lượt tốn token Claude | `brief-tick` không gọi Claude khi không có việc; mỗi Page tối đa 1 lượt thành công và 3 lượt lỗi mỗi ngày |
| Quét theo từ khoá mỗi sáng làm tăng rủi ro tài khoản | Dùng lại giới hạn và xoay vòng profile của Nghiên cứu chủ đề; `limit` ≤ 30 mỗi từ khoá |
| Bài viết gần giống bài nguồn (bản quyền) | Lời nhắc cấm chép nguyên văn; khách luôn duyệt trước khi đăng |
| Khách trả lời mơ hồ, đăng nhầm nháp | Mã `#xxxx` trong từng tin; có ≥2 nháp mà không ghi mã thì bot phải hỏi lại |
| Lệnh agent khác nhau giữa các bot | `MAIHUB_AGENT_CMD` cấu hình được; `install-brief --dry-run` kiểm trước khi bật |

## 7. Tài liệu (cùng commit với code)

- `SYSTEM_DOCUMENTATION.md`: mục 4.15 "Đề xuất bài hằng ngày", dấu `docs-check` cho `BRIEF_MAX_ATTEMPTS_PER_DAY`, `BRIEF_STALE_MS`, `BRIEF_MAX_ROWS`, `TRENDING_MAX_AGE_MS`, và dòng phiên bản 26.31.0.
- `docs/protocol/maihub-control-protocol.md`: thao tác `pages.*`, `briefs.*`, `research.trending`, sự kiện mới.
- `tools/maihub-bridge/README.md`: `brief-tick`, `install-brief`, `MAIHUB_AGENT_CMD`, `MAIHUB_AGENT_TIMEOUT_SEC`.
- Intent: đã thêm ghi chú (26/10/2026) rằng người dùng là khách chỉ dùng tin nhắn, bot tự học Page.

## Ghi chú triển khai/kiểm chứng 27/10/2026 — Task 4, chưa phát hành

Giữ nguyên nội dung thiết kế lịch sử phía trên. Theo rulings 10–13 và báo cáo `docs/reports/2026-10-26-page-learn-spike.md`, bộ đọc Task 4 trong `src/services/dailyBrief/pageIdentity.ts` dùng **JSON đã tải trong DOM**, thay cho bước chủ động `fetch('/api/graphql/')` ở mục 2.3. Không phát minh `doc_id`, variables hoặc phân trang; `ProfileCometTimelineFeedQuery` chỉ là tên query đã quan sát. Không thực hiện thử Facebook/browser thật trong Task 4. Chưa nối bộ đọc vào `pages.learn` (Task 5), chưa tăng phiên bản hoặc triển khai; 26.31.0 vẫn **chưa phát hành**.

- Danh tính: đối chiếu active `CurrentUserInitialData.USER_ID` với User ở đúng ngữ cảnh menu/header/feed và actor có `is_profile_plus` rõ ràng. Page cần cờ `true` cùng `delegate_page.id` nhất quán, khác active profile ID; người cần cờ `false` khớp và không có bằng chứng Page trái ngược. Thiếu/mâu thuẫn → `unknown`. Header/tên/`__typename` riêng lẻ, switcher, actor lạ và actor của bài chia sẻ không được dùng làm bằng chứng. Fixture người là **giả lập, chưa kiểm chứng thật**.
- Bài mẫu: chỉ `timeline_list_feed_units.edges[*].node` của User/Page đã chọn; actor trực tiếp phải khớp active USER_ID (bài mẫu quan sát dùng ID này, không dùng delegated Page ID). Không gom story lồng nhau, không lấy text/metrics từ bài chia sẻ hay homepage news feed. Khử trùng mã bài/permalink và giữ thứ tự có sẵn, tối đa 10 bài, 500 ký tự mỗi bài; giới thiệu tối đa 1000 ký tự. Bằng chứng chỉ hỗ trợ một bài, không xác nhận đủ 10 hay 10 bài mới nhất.
- Dữ liệu: kiểm kiểu và số nguyên an toàn không âm cho tương tác; thiếu/sai/mâu thuẫn là `null`, số 0 thật vẫn là 0. Timestamp giây hợp lệ đổi sang ms trong miền Date, sai/thiếu là `null`. Chỉ nhận URL HTTPS đúng origin `www.facebook.com`, không có credentials; permalink bỏ query/fragment để không trả token/tracking. Tên Page lấy từ delegate hoặc header đúng ngữ cảnh; các trường không có giữ rỗng.
- Chỉ đọc: một `goto('https://www.facebook.com/me', {waitUntil:'load', timeout})` có timeout dương hữu hạn, mặc định 45000 ms, rồi `page.content()`. Dùng lại `loginProblemAt` sau chuyển hướng và khi điều hướng thất bại sau chuyển hướng; ném `PageLoginProblem` với `checkpoint`/`logged_out`, giữ nguyên lỗi điều hướng khác. Không bấm/gõ/cuộn, không chủ động fetch, chỉ `JSON.parse`, không ghi HTML/token/log.
- Kiểm chứng: `src/__tests__/dailyBrief/pageIdentity.test.ts` dùng fixtures cũ và biến thể trong bộ nhớ, TDD RED → GREEN; hai vòng stress offline, focus regression, hai cấu hình `tsc --noEmit` và `node scripts/check-docs.js`. Không thêm fixture/dependency, không mở raw capture/Downloads/credentials, không nới sandbox. Controller chạy toàn bộ suites; live DOM timing, chuyển hướng thật, macOS browser, nhận dạng người thật và phân trang vẫn chưa được xác nhận.

### Bổ sung sau review 27/10/2026 — sáu cơ chế lỗi của Task 4

- Correction `2026-10-27` trong báo cáo spike làm rõ outer transport đã quan sát: `["ScheduledServerJS","handle",null,[{"__bbox": B}]]`, CurrentUser tại `B.define[i]`, Relay tại `B.require[i]`. Cập nhật **fixture Page hiện có** giữ lớp này, giữ nguyên toàn bộ payload/giá trị tổng hợp bên trong; helper của các test cũ chỉ mở đúng lớp đó để tiếp tục các phép biến đổi có sẵn. Reader vẫn nhận root/minimized, chỉ mở wrapper nhận diện được, tối đa 4 lớp/1024 envelope (budget hiệu chỉnh ở fix round 2 bên dưới); vượt giới hạn trả `unknown`, không dùng kết quả một phần hoặc tìm sâu actor bất kỳ.
- Đọc comment theo ngữ cảnh HTML/script: bỏ comment HTML thật, giữ nguyên `<!--...-->` hoặc `<!--` literal trong JSON. Không thực thi script.
- Permalink chỉ nhận path có định danh bài độc lập: `/reel/<id>`, `/posts/<id>`, `/permalink/<id>`, `/<profile>/posts/<id>`; bỏ query/fragment trên path hợp lệ để không trả token/tracking. Loại URL phụ thuộc query (`story.php`, `watch`, `photo.php`...) và path tùy ý thay vì tạo link mất định danh/gộp nhầm bài. Các path ngoài reel là trường hợp validation tổng hợp, không phải capture mới.
- HTTP status ≥400 sau `goto` giữ là lỗi; checkpoint/logged_out có ưu tiên. Kiểm lại login/origin sau khi `content()` resolve; khi `goto`/`content()` reject, kiểm lại login rồi ném nguyên lỗi khác.
- So sánh độc lập mọi tên hợp lệ từ header và delegate, không dùng fallback che mâu thuẫn. Các behavioral assertions cũ được giữ nguyên, thêm regression RED → GREEN riêng từng finding và chạy lại hai vòng focus cùng cả hai tsc/docs-check.
- Không có dependency, external call, Git state change, version bump hay release. Wrapper delivery/timing, chuyển hướng/live Facebook, người thật và phân trang vẫn chưa kiểm chứng; controller thực hiện private offline-capture/full suites.

### Hiệu chỉnh budget 27/10/2026 — fix round 2

Số đếm controller cung cấp từ kiểm tra capture riêng là **176** và **241** script `application/json` hợp lệ trước khi mở wrapper. Budget 100 của round 1 không phù hợp kích thước đã quan sát. Dùng budget hữu hạn **1024 envelope tổng**, gồm mọi JSON root và `__bbox` của transport được nhận diện: mô hình test 241 root + một wrapper/root = 482 envelope, còn **542** envelope dự phòng. Đây là headroom theo mô hình tổng hợp, không suy đoán nội dung capture hay cam kết mọi cấu trúc tương lai đều vừa budget.

Chỉ đổi constant budget; giữ depth **4**, không đổi selector transport, kiểm kiểu, identity/ownership/malformed/URL/metrics hoặc cách xử lý lỗi. Regression mới có 176/241 script với foreign actors/switcher trong noise không liên quan, đúng tổng 1024, vượt budget ban đầu/khi mở wrapper, và depth 4/5; hostile fixture 200 nhánh cũ tăng lên **1025** để giữ ý nghĩa vượt bound mới, không bỏ assertion. Không đổi fixture hoặc thêm dependency trong round 2. Chạy riêng pageIdentity, DailyBriefStore, briefOperations và các login/parser/trending suites hai lần; không quét directory dailyBrief khi Task 5 đang sửa test. Controller kiểm lại actual capture/full suites; live timing/person/pagination vẫn chưa được xác nhận.

## Ghi chú triển khai/kiểm chứng 27/10/2026 — Task 9, chuẩn bị local 26.31.0

Theo Ruling 13, trạng thái là **chuẩn bị local, chưa phát hành**; yêu cầu “Đã phát hành” trong plan/brief Task 9 được thay thế. T0–T8 đã triển khai và review tại BASE `82326ad8a862274fbeae30067fa558367427098e`. Task 9 chỉ tăng `package.json.version`, root `package-lock.json.version` và `packages[""].version` lên `26.31.0`, đồng bộ mục 0/4.15 của `SYSTEM_DOCUMENTATION.md` và đoạn bot trong `README.md`; không npm install, đổi dependency hay cấu hình production. Nội dung thiết kế và các ghi chú Task 4 phía trên được giữ như lịch sử; các điểm khác triển khai hiện tại:

- `pages.learn` đã nối reader với learner/lifecycle. `pages.list` trả **`{ identities: PageIdentity[] }`** (Ruling 4). Mỗi job giữ store/workspace và khe browser chung, chặn hai chiều với Nghiên cứu, nhường scheduler; huỷ/đổi workspace chờ đóng session, không ghi/phát completion cũ vào context mới; Control API chặn nhân viên bằng 503 `BUSY`. Bản sửa pacing T5 chỉ nghỉ ngẫu nhiên 20–60 giây **giữa các lần thử browser đủ điều kiện**, không nghỉ với profile fresh, trước lần thử đầu hoặc sau lần cuối.
- Mục 2.3 dùng **JSON đã nhúng trong DOM**, không chủ động GraphQL, không đoán `doc_id`/variables/phân trang (Ruling 11). Chỉ trả tối đa 10 mẫu tự đăng đang có, không khẳng định đủ 10/mới nhất. Controller xác nhận offline một bài Page; fixture người là **synthetic**, không phải capture người thật (Rulings 10–12). Live Facebook/Page/person, pagination, DOM/login timing và browser macOS chưa xác minh.
- `briefs.finish` bắt buộc **`claimedAt`** từ `briefs.claimDue`; store và bridge từ chối/bỏ completion của claim cũ sau reclaim (Ruling 6). Các API mới, sự kiện, giới hạn attempts/stale/rows/learn/trending và docs-check markers được mô tả đầy đủ tại mục 4.15.
- Mục 3.1: agent thực tế mặc định **`claude -p --allowedTools mcp__maihub`**, không phải chỉ `claude -p`; `MAIHUB_AGENT_CMD` được tách argv, prompt qua stdin, không shell. Timeout mặc định 2700 giây mỗi agent; quá giờ dừng cả process group bằng TERM rồi KILL sau tối đa 10 giây nếu còn sống, kể cả cha thoát trước con. `flock` chặn tick chồng; không cần onboarding/không có brief đến giờ thì không gọi Claude. Onboarding cooldown 6 giờ được ghi trước agent nên lỗi vẫn bị giãn lượt.
- Mục 3.3: `install-brief` có `--env-file`, `--user`, `--name`, `--state-dir`, `--agent-cmd`; không có cờ `install-brief --dry-run`. Trình cài tự chạy **`brief-tick --dry-run`** dưới user bot, dùng `.env` ứng viên khi đổi agent; chỉ sau preflight thành công mới ghi `.env` thật/state/unit và gọi systemctl. Service oneshot có hạn tổng 3600 giây, timer mỗi 15 phút và `Persistent=true`. `pair --install` không tự cài timer brief.
- Mục 4/Task 9 brief: tick thường nhận `UNKNOWN_METHOD` từ `pages.list` thì cảnh báo “MaiHub cần ≥ 26.31.0” một lần **mỗi tick**, thoát 0, không gọi agent. **Dry-run hiện chỉ gọi `system.status` và kiểm executable bằng `shutil.which`; không kiểm phiên bản hay methods mới**, nên có thể thành công với 26.30.0. Không khẳng định dry-run trên bản cũ đã báo lỗi phiên bản; giới hạn này được ghi nhận, không sửa runtime T6/T7 đã review trong Task 9.
- Mục 3.4: `Watcher.step` xử lý `briefs.finished` qua `format_brief_messages`, còn `format_event` trả `None` cho cả hai sự kiện mới. Gửi một tin chữ mỗi nháp (nội dung ≤800 ký tự, mã #xxxx, nhãn media), lỗi chỉ báo khi đọc brief có attempts ≥3; xử lý cả sự kiện rồi lưu cursor nên crash có thể gửi trùng. `GUIDE` hướng dẫn agent xử lý đăng/sửa/bỏ, phân biệt mã trùng hoặc nhiều nháp không có mã; không phải parser Telegram hay scheduler nhắc độc lập. Không tự duyệt/đăng nháp.

**Kiểm chứng local thực chạy trong Task 9:** hai `tsc --noEmit` (electron và renderer với `NODE_OPTIONS=--max-old-space-size=4096`) exit 0; `node scripts/check-docs.js` OK. Hai vòng test tập trung dùng cùng bộ test hiện có: **13 Jest suites/556 tests mỗi vòng**, **92 bridge unittest mỗi vòng, OK, không skip**; gồm process-group timeout local, no-work/cooldown/flock, install ứng viên, watch, store/reader/learner/trending và wiring Control/research/poster/workspace/drafts. Không thêm/sửa test vì không thêm logic và chưa thấy gap tích hợp cụ thể cần test mới. Kiểm JSON xác nhận đúng ba version root `26.31.0`, mọi dữ liệu package/lock khác giữ nguyên; đã rà actual diff trong phạm vi.

**Chưa chạy trong Task 9:** full Jest/Python và production TypeScript → strip-console → renderer builds (controller phụ trách), Electron dev/manual regression `research.search → research.get`, `drafts.create → drafts.approve`, bridge 26.30.0 thật gọi `describe`/`system.status`, dry-run với app 26.30.0 thật, Facebook/Telegram/Claude live, cài/status/journal systemd VPS và bot tương tác thật. Baseline controller T0–T8 là 107 suites/2296 tests Jest; không coi đó là full run của Task 9. Renderer warnings và console noise baseline được giữ, không che/sửa. Không có migration, git mutation, push/tag/deploy hoặc phát hành. Lệnh, output và phần việc controller còn lại: `.superpowers/sdd/2026-10-26-daily-post-suggestions/task-9-report.md`.


## Ghi chú triển khai/kiểm chứng 27/10/2026 — Final fix wave BASE4a6c762, chưa phát hành

Các mục thiết kế và ghi chú Task 9 ở trên giữ nguyên làm lịch sử. Rulings 17–18 thay thế hành vi batch-agent và cảnh báo từ counter hiện tại:

- `briefs.claimDue {profileId?}` thêm filter chuỗi không rỗng trong BriefPort/schema/run/operations/store; bỏ qua vẫn trả batch `{briefs}` như cũ. Bridge đọc candidates một lần, mỗi profile tối đa một attempt/tick, claim JIT từng Page rồi kiểm `status + claimedAt` trước agent. Claim bị thay thế running/idle, mất hoặc hoàn tất không chạy agent/không stale finish; không có lease xếp hàng trong tick.
- Budget tick đo bằng monotonic là 3300 giây, giữ 180 giây headroom cho TERM/KILL và API cleanup. Onboarding và agent dùng chung budget; timeout mặc định 2700 được clamp theo phần dư, tối đa 3120, kể cả override >3600. Hết budget không claim thêm; hết sau claim thì xác minh và finish lỗi ownership còn giữ. Không heartbeat hay so đồng hồ tường hai máy làm guard. API/OS treo vẫn là giới hạn của deadline admission này; cảnh báo cleanup lỗi, expiry vẫn là recovery.
- Store settle lease hết hạn thành idle + attempts/ngày nhận cũ trước kiểm re-eligibility, kể cả exhausted, disabled, đổi giờ hoặc mất eligibility. Callback `onExpired` chỉ chạy sau transaction thành công; mỗi settlement phát `briefs.finished` lỗi một lần, kể cả lần ba không trả claim mới. Rollback/poll lại không phát sai/trùng. Ngày mới reset khi nhận lượt mới; `claimedAt` ownership, capacity và finish guards giữ nguyên.
- Mọi completion lỗi mới có snapshot additive `attempts`, `attemptDate`, gồm expiry. Event builder chỉ project trường công bố. Formatter mới dùng snapshot, không fetch mutable current counter: delayed 1/2/3 chỉ một warning, delayed third sau reset vẫn warning. Legacy thiếu snapshot giữ best-effort fetch counter hiện tại; không thể phục dựng độ chính xác lịch sử từ payload cũ. Không migration; success/media/#suffix/approval giữ nguyên.
- Learner chỉ quan sát `ok` sau Page/person read + close + store thành công, chưa huỷ; tái dùng wiring `LoginChecker.observe(..., 'run')`. Không quan sát khi fresh skip, unknown, read/close/store lỗi hay cancel; listener lỗi không làm hỏng success/slot. Regression kiểm error checkpoint/logged_out → forced learn thành công → hàm chọn profile Nghiên cứu thật.
- Test resistant-child bỏ probe PermissionError self-skip; giữ process-group/cleanup/assertions thật. Nếu sandbox từ chối, test fail công khai để controller chạy ngoài sandbox.

RED/GREEN từng finding, hai focused stress rounds, exact commands/output, actual-diff review và giới hạn còn lại được ghi trong `.superpowers/sdd/2026-10-26-daily-post-suggestions/final-fix-report.md`. Full socket suites/build do controller phụ trách; không phát hành, không live service, không Git mutation.


### Kết quả controller cuối 27/10/2026 — chưa phát hành

Sau final fix và follow-up Ruling 19: **full Jest 107 suites/2309 tests ×2; full bridge 297 tests ×5, đều OK và không skip**. Hai tsc, docs-check, production Electron compile/strip-console và renderer build đều exit 0. Review các finding liên thông và fix EPERM đã approve. Race EPERM khi signal-0 gặp nhóm đang thoát trên Darwin được sửa bằng cách tiếp tục poll/reap dưới deadline cũ; không coi EPERM là biến mất và không nuốt lỗi TERM/KILL thật. Những lượt test đỏ trước sửa vẫn được giữ trong report, không lấy retry xanh để che lỗi.

`make build/test/lint` không có target (exit 2); renderer vẫn có cảnh báo Vite. Chưa đóng gói installer/native/E2EE, chưa kiểm chứng live Facebook/person/pagination/Telegram/Claude/VPS hoặc manual compatibility. Không tag/push/deploy, không tuyên bố phát hành. Bằng chứng và các quyết định còn lại được giữ trong ledger của plan; không sửa lại các ghi chú lịch sử phía trên.

### Đồng bộ bản video remote 27/10/2026

Remote `origin/main` tại `b07b4ea` đã có tag `v26.31.0` cho video quảng cáo AI; số 26.31.0 dự kiến cho daily-brief trước đó không còn sử dụng được. Nhánh dev gộp cả hai tính năng dùng **26.32.0, chưa phát hành**. Giữ hướng dẫn daily-brief ở GUIDE mục 8, thêm hướng dẫn video mục 9; Control API có 59 thao tác, không bỏ API của bên nào. `SYSTEM_DOCUMENTATION.md` chuyển daily-brief từ mục 4.15 sang **4.16**, giữ video ở 4.15. Cảnh báo thiếu daily-brief yêu cầu ≥26.32.0; không đổi hợp đồng dry-run chỉ kiểm system.status/PATH. Các mốc 26.31.0 và số test phía trên là lịch sử trước gộp, không phải bằng chứng cho nhánh mới. Không thay đổi hoặc triển khai dịch vụ production/AHV.

**Kiểm chứng nhánh tích hợp:** Jest111 suites/2376 tests ×2, bridge297 tests ×2 OK không skip; cả hai tsc/docs-check và production Electron/renderer build exit0. VideoTab với IPC giả đạt hai vòng desktop/mobile và light/dark, validation/sắp cảnh/submit/quay lại HyperFrames; không dùng DB người dùng hoặc gọi dịch vụ thật. Make targets chưa có, Vite warnings còn; full installer/live chưa kiểm chứng. Các giới hạn quyền duyệt của runner, metrics Page và video dài được ghi ở SYSTEM_DOCUMENTATION.md §4.16, không coi các test xanh là bằng chứng tự vận hành hoàn toàn.
