# Thiết kế: Đo hiệu quả bài đã đăng và lấy link bài chờ duyệt

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 19/10/2026 |
| Trạng thái | Chờ duyệt |
| Kế hoạch | `docs/plans/2026-10-19-post-performance.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-19-post-performance.md` (đã duyệt) |
| Nhánh | `feat/26.21-retry-and-stats` (cùng phần G: `docs/specs/2026-10-16-poster-retry-error-codes.md`) |
| Phiên bản | 26.21.0 |
| Dùng lại | Nghiên cứu chủ đề 26.20: `GraphqlSession`, `parseGroupFeed`, `describeShape`; khe việc của Đăng Facebook; `LoginChecker.observe` |

## 1. Phạm vi

- Chỉ áp dụng cho bài **đăng vào nhóm** (`mode = 'group'`) có `outcome = 'posted'`.
- Bài đăng lên trang (fanpage) để bản sau.
- Không đổi cách đăng bài, trừ việc ghi nhận "chờ duyệt" lúc đăng (mục 3).

## 2. Dữ liệu

### 2.1 `fb_poster_post_tracking`

Mỗi kết quả đăng nhóm thành công có một dòng.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `result_id` | INTEGER PK | `fb_poster_results.id` |
| `run_id` | TEXT | |
| `schedule_id` | TEXT NULL | lấy từ lượt chạy |
| `profile_id` | TEXT | profile đã đăng |
| `group_url` | TEXT | dạng chuẩn `https://www.facebook.com/groups/<id hoặc slug>/` |
| `group_id` | TEXT | ID số nếu biết; `''` nếu chưa |
| `post_id` | TEXT | `''` nếu chưa biết |
| `post_url` | TEXT NULL | |
| `posted_at` | INTEGER | thời điểm ghi kết quả (ms) |
| `text_head` | TEXT | 200 ký tự đầu nội dung đã chuẩn hoá (chữ thường, gộp khoảng trắng), dùng để đối chiếu |
| `link_status` | TEXT | `known` / `missing` / `pending_approval` / `not_found` |
| `removed_suspected` | INTEGER | 0/1 |
| `last_seen_at` | INTEGER NULL | lần cuối thấy bài trong bảng tin |
| `last_checked_at` | INTEGER NULL | lần cuối kiểm tra nhóm này cho bài này |
| `check_count` | INTEGER | số lần đã kiểm tra mà chưa thấy |

### 2.2 `fb_poster_post_stats`

| Cột | Kiểu |
|---|---|
| `id` | INTEGER PK |
| `result_id` | INTEGER |
| `captured_at` | INTEGER |
| `reactions` | INTEGER NULL |
| `comments` | INTEGER NULL |
| `shares` | INTEGER NULL |

Index trên `(result_id, captured_at)`.

### 2.3 Tạo dòng theo dõi

`FacebookPosterService.record()` tạo dòng theo dõi cho mỗi kết quả `posted` khi `mode = 'group'`:
- `link_status = 'known'` nếu có `post_url`;
- `'pending_approval'` nếu lúc đăng đã thấy dấu hiệu chờ duyệt (mục 3), hoặc `comment_status = 'pending_approval'`;
- còn lại `'missing'`.

Lỗi khi ghi bảng theo dõi chỉ được ghi log, **không** làm hỏng lượt đăng.

### 2.4 Dọn dữ liệu

Dòng theo dõi và lần đo có `posted_at` quá 180 ngày bị xoá khi khởi động (giống Nghiên cứu).

## 3. Ghi nhận "chờ duyệt" lúc đăng

Sau khi đăng thành công mà **không lấy được link**, `postToTargets` đọc chữ trên trang hiện tại, không điều hướng thêm. Nếu có một trong các câu ở `PENDING_APPROVAL_MARKERS` (dùng lại từ `firstComment.ts`), kết quả đánh dấu `pendingApproval = true`. Các câu này chưa đo trên trang thật; không khớp thì kết quả chỉ là `missing`, không sai.

## 4. Thao tác "Theo dõi bài" (`PostTracker`)

### 4.1 Chọn việc

Tham số:
- `sinceDays`: mặc định 3, khoảng 1–14;
- `groupUrls?`: tối đa 30 nhóm;
- `profileIds?`.

Lấy các dòng theo dõi có `posted_at` trong khoảng `sinceDays`, trừ dòng `not_found`, rồi gom theo cặp (profile đã đăng, nhóm).
- Tối đa `MAX_TRACK_GROUPS = 30` cặp mỗi lượt.
- Ưu tiên cặp có bài `pending_approval` hoặc `missing`, rồi đến cặp lâu chưa kiểm tra nhất.

### 4.2 Chạy

1. Giành **khe việc của Đăng Facebook**, giống kiểm tra đăng nhập. Đang có lượt đăng hoặc đang kiểm tra thì báo `BUSY`. Lịch đến giờ trong lúc theo dõi sẽ vào hàng đợi rồi chạy sau.
2. Với từng cặp:
   - Mở profile đã đăng (`openForAutomation`) rồi `GraphqlSession.open()`.
   - Lấy truy vấn bảng tin nhóm qua `ensureQuery('group_feed', …)`, cùng cách xử lý link nhóm dạng tên như Nghiên cứu 26.20.
   - Đọc bảng tin theo thứ tự thời gian bằng `parseGroupFeed`.
   - **Dừng nhóm** khi gặp một trong các điều kiện:
     - mục cũ hơn `posted_at` nhỏ nhất của các bài cần tìm trong nhóm trừ 1 giờ;
     - hết con trỏ;
     - tối đa `MAX_TRACK_PAGES_PER_GROUP = 10` trang;
     - lặp con trỏ, hoặc 2 trang liền không có mục.
3. Nghỉ ngẫu nhiên 3–6 giây giữa hai trang và 8–15 giây giữa hai nhóm. Đóng phiên trong `finally`.
4. Gặp `logged_out` / `checkpoint`: gọi `observe` (cập nhật trạng thái đăng nhập, báo 🔒), bỏ các nhóm còn lại của profile đó.
   Gặp `rate_limited`: bỏ các nhóm còn lại của profile đó.

### 4.3 Đối chiếu bài

Mã người dùng của profile lấy từ `GraphqlSession` khi mở trang (mã phiên).

1. Bài **đã có `post_id`**: mục có `fb_id` bằng `post_id` được coi là tìm thấy.
2. Bài **chưa có link** (`missing` / `pending_approval`): mục được coi là bài của mình khi thoả **cả ba** điều kiện sau. Nhiều mục cùng khớp thì chọn mục có thời gian gần nhất.
   - `author_id` bằng mã người dùng của profile;
   - `posted_at` cách thời điểm đăng không quá 2 giờ;
   - `text_head` của mục, chuẩn hoá cùng cách, trùng với `text_head` của bài ở **60 ký tự đầu**.
3. **Tìm thấy:**
   - ghi `post_id`, `post_url` (nếu trước đó chưa có), `link_status = 'known'`, `last_seen_at`;
   - đặt `check_count = 0`, bỏ `removed_suspected`;
   - thêm một lần đo vào `fb_poster_post_stats`.
4. **Không thấy**, dù bảng tin đã được đọc qua mốc thời gian đăng của bài:
   - `link_status = 'known'` và đã từng thấy (`last_seen_at` khác null) → `removed_suspected = 1`;
   - `missing` / `pending_approval` → tăng `check_count`; quá 7 ngày kể từ lúc đăng → `link_status = 'not_found'`.
5. Bảng tin **chưa** đọc tới mốc thời gian của bài (dừng sớm vì giới hạn trang): không kết luận gì, chỉ cập nhật `last_checked_at`.

### 4.4 Kết thúc

- Phát sự kiện `posts.trackFinished`: `{ jobId, groups, checked, found, linked, removedSuspected, notFound, errors }`.
- Kết quả của lần chạy gần nhất (gồm lỗi từng nhóm và `shape` chẩn đoán khi đọc hỏng) giữ trong bộ nhớ để xem bằng `posts.trackStatus`.
- Huỷ: `posts.trackCancel`. Dừng sau trang đang đọc và đóng phiên ngay, giống Nghiên cứu.

## 5. Báo cáo (`posts.stats`)

**Tham số:**
- `from?`, `to?` (ms; mặc định 30 ngày gần nhất);
- `groupBy`: `group` / `profile` / `schedule` / `day` / `post`;
- `limit?` (≤ 500).

**Mỗi dòng gồm:**
- khoá nhóm, kèm tên nhóm, tên profile hoặc tên lịch;
- `posts`, `withLink`, `pending`, `notFound`, `removedSuspected`;
- `reactions`, `comments`, `shares`: tổng của **lần đo mới nhất** của mỗi bài;
- `avgEngagement` = tổng tương tác chia số bài đã đo;
- `engagementRate` = tương tác trung bình chia số thành viên nhóm. Số thành viên lấy từ lượt quét nhóm gần nhất của Nghiên cứu; không có thì `null`. Với `groupBy` khác `group` là trung bình theo bài.

Với `groupBy = 'post'`, mỗi dòng là một bài, có thêm link, nhóm, nội dung (cắt), thời gian đăng, trạng thái link và chuỗi các lần đo.

## 6. Control API (chỉ thêm)

| Thao tác | Tham số | Kết quả |
|---|---|---|
| `posts.track` | `sinceDays?`, `groupUrls?`, `profileIds?` | `{ jobId, pairs }`, chạy nền |
| `posts.trackStatus` | không | `{ running, jobId, progress, last }` |
| `posts.trackCancel` | không | `{ cancelled }` |
| `posts.list` | `from?`, `to?`, `linkStatus?`, `groupUrl?`, `profileId?`, `limit?` (≤ 500), `offset?` | các dòng theo dõi kèm lần đo mới nhất |
| `posts.stats` | như mục 5 | `{ rows[] }` |

**Lỗi:** `BUSY` (đang đăng, đang kiểm tra hoặc đang theo dõi), `INVALID_PARAMS`, `NOT_FOUND` (`profileIds` lạ).

**Sự kiện mới:** `posts.trackFinished`. `watch` gửi Telegram 1 dòng: `📈 Theo dõi bài: kiểm tra X nhóm, lấy được Y link, Z bài có thể đã bị xoá`. Lần chạy không có link mới và không có bài bị xoá thì không gửi.

## 7. Giao diện

- **Lịch sử, mỗi kết quả đăng nhóm:**
  - chip trạng thái link: `Chờ duyệt` (cam), `Chưa có link` (xám), `Có thể đã bị xoá` (đỏ), `Không tìm thấy` (xám);
  - số đo mới nhất `👍 n · 💬 n · ↗ n`, kèm tooltip thời điểm đo.
- **Mục "Hiệu quả"** đầu tab Lịch sử:
  - chọn khoảng (7/30 ngày) và gom theo (nhóm / profile / lịch);
  - bảng báo cáo theo mục 5;
  - nút **Cập nhật số liệu** (chạy `posts.track`), kèm tiến độ và nút Huỷ.
- Theo `DESIGN.md`: sáng/tối, 1280 và 390 px, bảng cuộn ngang trong khung riêng.

## 8. Kiểm thử

**Jest (giả trang, dữ liệu giả):**
- **Tạo dòng theo dõi:** đủ 3 trạng thái `known` / `missing` / `pending_approval`; lỗi ghi bảng không làm hỏng lượt đăng.
- **Đối chiếu:**
  - khớp theo `post_id`;
  - khớp theo tác giả + thời gian + 60 ký tự đầu;
  - không khớp khi khác tác giả, lệch quá 2 giờ, hoặc khác chữ;
  - nhiều mục khớp → lấy mục gần nhất.
- **Kết luận:**
  - `removed_suspected` khi đã đọc qua mốc thời gian;
  - không kết luận khi dừng sớm;
  - `not_found` sau 7 ngày.
- **`PostTracker`:**
  - khe việc: `BUSY` khi đang đăng, và lượt đăng chờ khi đang theo dõi;
  - giới hạn nhóm, trang và thời gian nghỉ;
  - huỷ;
  - checkpoint → `observe`;
  - sự kiện kết thúc.
- **Báo cáo:** từng kiểu `groupBy`; lần đo mới nhất mỗi bài; trung bình; tỉ lệ với số thành viên từ Nghiên cứu.
- **Control API:** tham số, `BUSY`, sự kiện; định dạng tin `watch`.

**Chạy thật ở dev:** giao diện với dữ liệu giả. Phần đọc Facebook thật cùng điều kiện với Nghiên cứu: kiểm chứng khi anh đăng nhập hoặc chạy trên VPS.

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Đối chiếu nhầm bài người khác | Bắt buộc trùng mã tác giả, ±2 giờ và 60 ký tự đầu |
| Bảng tin nhóm sắp xếp khác thứ tự thời gian | Dùng `sorting_setting=CHRONOLOGICAL`; dừng theo giới hạn trang; chỉ kết luận "bị xoá" khi đã đọc qua mốc thời gian |
| Theo dõi chiếm profile lúc đến giờ đăng | Chung khe việc với lượt đăng; lịch vào hàng đợi (tối đa 2 giờ); mỗi lượt giới hạn 30 nhóm × 10 trang |
| Facebook đổi cấu trúc | Dùng lại bộ đọc và chẩn đoán `shape` của Nghiên cứu |
| Đọc nhiều làm tài khoản bị giới hạn | Nghỉ giữa trang/nhóm; dừng profile khi gặp tín hiệu; bot quyết định tần suất (gợi ý 1h, 24h, 72h sau khi đăng) |
