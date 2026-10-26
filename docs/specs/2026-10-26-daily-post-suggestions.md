# Thiết kế: Bot tự học Page và đề xuất bài hằng ngày theo nội dung hot

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 26/10/2026 |
| Trạng thái | Đã duyệt (26/10/2026) |
| Intent | `docs/intent/2026-10-26-facebook-growth-bot.md` (tính năng 1) |
| Kế hoạch | `docs/plans/2026-10-26-daily-post-suggestions.md` |
| Phiên bản dự kiến | 26.31.0 |
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
| `updated_at` | INTEGER | |

Tối đa 10 dòng `daily_briefs` mỗi workspace.

### 2.2 Luật chọn việc của `briefs.claimDue`

Chạy trong một giao dịch SQLite, nên hai lời gọi liên tiếp không nhận trùng một Page. Với `today` theo giờ máy, một dòng **đến lượt** khi đủ cả 5 điều kiện:

1. `enabled = 1`;
2. `last_run_date != today`;
3. giờ hiện tại ≥ `time`;
4. `attempts < 3` khi `attempt_date = today` (khác ngày thì coi `attempts = 0`);
5. `status = 'idle'`, **hoặc** `status = 'running'` và `claimed_at` cũ hơn 60 phút. Trường hợp này trước tiên được tính là một lượt lỗi (`attempts + 1`), sau đó mới xét lại điều kiện 4.

Dòng đến lượt được đổi sang `status = 'running'`, `claimed_at = now`.

Kết quả trả về: `{ briefs: [{ profileId, pageName, niche, keywords, groupIds, tone, notes, draftsPerDay }] }`.

`briefs.finish {profileId, ok, draftIds?, error?}`:
- yêu cầu `status = 'running'`, nếu không trả `INVALID_PARAMS`;
- `ok = true` → `last_run_date = today`;
- `ok = false` → `attempts + 1`;
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
