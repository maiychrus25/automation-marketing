# Thiết kế: Chiến dịch và biến thể A/B cho Đăng Facebook

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 20/10/2026 |
| Trạng thái | Đã duyệt (20/10/2026) |
| Kế hoạch | `docs/plans/2026-10-20-campaigns-variants.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-20-campaigns-variants.md` (đã duyệt) |
| Nhánh | `feat/26.22-campaigns-variants` |
| Phiên bản | 26.22.0 |
| Dùng lại | Lịch đăng và bài nháp (`fb_poster_schedules`), `FacebookPosterScheduler`, theo dõi bài 26.21 (`fb_poster_post_tracking`, `statsReport`, `PerformancePanel`), Control API `drafts.*` / `schedules.*` / `posts.*` |

## 1. Phạm vi

Trong phạm vi:
- **B. Chiến dịch:** gom lịch đăng và bài nháp; tạm dừng hoặc giới hạn thời gian; báo cáo theo chiến dịch.
- **C. Biến thể A/B:** 2–5 cách viết nội dung chữ cho một bài; xoay vòng đều cho các đích; báo cáo so sánh.

Ngoài phạm vi (để sau):
- MaiHub tự sinh lịch theo kế hoạch.
- Tin Telegram khi chiến dịch kết thúc.
- Tự chọn biến thể thắng.
- Biến thể khác ảnh/video hoặc khác bình luận đầu.

Bot đọc báo cáo và tự quyết, đúng hướng "bot quyết định, MaiHub cung cấp thao tác".

## 2. Dữ liệu

Chỉ thêm bảng và cột. Cột mới thêm bằng `ALTER TABLE` trong danh sách migration có sẵn, theo đúng cách cũ: lỗi "cột đã có" thì bỏ qua.

### 2.1 Bảng mới `fb_poster_campaigns`

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | TEXT PK | uuid |
| `name` | TEXT | 1–100 ký tự, không trùng (so sánh sau khi bỏ khoảng trắng hai đầu, không phân biệt hoa thường) |
| `goal` | TEXT | mục tiêu / ghi chú, tối đa 1000 ký tự, mặc định `''` |
| `status` | TEXT | `active` / `paused` / `archived` |
| `start_at` | INTEGER NULL | ms; `NULL` = không giới hạn |
| `end_at` | INTEGER NULL | ms; `NULL` = không giới hạn; nếu cả hai có thì `start_at <= end_at` |
| `created_at`, `updated_at` | INTEGER | ms |

Giao diện chọn ngày: `start_at` = 00:00 của ngày bắt đầu, `end_at` = 23:59:59.999 của ngày kết thúc (giờ máy).

### 2.2 Cột mới

| Bảng | Cột | Ghi chú |
|---|---|---|
| `fb_poster_schedules` | `campaign_id TEXT DEFAULT NULL` | chiến dịch của lịch / bài nháp |
| `fb_poster_runs` | `campaign_id TEXT DEFAULT NULL` | chụp lại lúc lượt chạy bắt đầu |
| `fb_poster_results` | `variant TEXT NOT NULL DEFAULT ''` | `''` khi bài không có biến thể; `'A'`…`'E'` khi có |
| `fb_poster_post_tracking` | `campaign_id TEXT DEFAULT NULL`, `variant TEXT NOT NULL DEFAULT ''` | chụp lại từ lượt chạy và kết quả |

Thêm index `fb_poster_schedules(campaign_id)` và `fb_poster_post_tracking(campaign_id)`.

Chiến dịch được **chụp lại** vào lượt chạy và dòng theo dõi. Chuyển một lịch sang chiến dịch khác chỉ ảnh hưởng các lượt sau; số liệu cũ vẫn thuộc chiến dịch cũ.

### 2.3 Tham số bài đăng (`StartParams` kind `post`)

Thêm hai trường tuỳ chọn:
- `variants?: string[]`: 1–4 đoạn chữ, là biến thể B…E. `text` vẫn bắt buộc và là biến thể A.
  - Mỗi đoạn kiểm tra như `text`: không rỗng, tối đa 63206 ký tự.
  - Không đoạn nào trùng hoàn toàn với `text` hay với nhau (so sánh sau khi bỏ khoảng trắng hai đầu).
  - `variants` rỗng hoặc vắng = bài không có biến thể (như hiện nay).
- `campaignId?: string | null`: chiến dịch của lượt chạy.
  - Khi chạy từ lịch, scheduler điền giá trị này từ `fb_poster_schedules.campaign_id`. Cột của lịch là nguồn đúng; giá trị trong `params_json` của lịch bị bỏ qua.
  - Khi đăng ngay, lấy theo tham số.
  - Mã không tồn tại → lỗi `Không tìm thấy chiến dịch`. Chiến dịch `archived` → lỗi `Chiến dịch đã lưu trữ`.

Bài nháp và lịch lưu `variants` trong `params_json` như các trường khác.

## 3. Chiến dịch

### 3.1 Khi nào lịch của chiến dịch được tự chạy

`isRunnable(c, t)` = `c.status === 'active'` và `(c.start_at === null || t >= c.start_at)` và `(c.end_at === null || t <= c.end_at)`.

Scheduler (`FacebookPosterScheduler`) kiểm tra ở hai chỗ, với lịch có `campaign_id`:

**1. Khi lịch đến giờ (`fire`)**, nếu chiến dịch không chạy được:
- **Lịch lặp lại:** bỏ qua lần này, không ghi gì. `next_run_at` vẫn tính sang lần kế tiếp như hiện nay.
- **Lịch một lần:** ghi lượt `missed` với lý do:
  - `Chiến dịch đang tạm dừng` khi `paused`;
  - `Chiến dịch đã lưu trữ` khi `archived`;
  - `Ngoài thời gian chiến dịch` khi nằm ngoài khoảng ngày.

  Ghi theo cùng đường `recordMissed` và thông báo bỏ lỡ có sẵn.

**2. Khi lấy lịch khỏi hàng chờ (`pumpQueue`):** nếu lúc này chiến dịch không chạy được (ví dụ vừa bị tạm dừng trong lúc lịch đang chờ) thì bỏ lượt khỏi hàng chờ, ghi `missed` với lý do như trên.

Chiến dịch không có thì không chặn gì (lịch không có `campaign_id` chạy như hiện nay).

Không đổi cờ `enabled` của từng lịch. Tiếp tục chiến dịch (`paused` → `active`) thì các lịch đang bật chạy lại từ lần đến giờ kế tiếp.

**Đăng ngay** (anh bấm trong app, hoặc bot `drafts.approve` với `when = "now"`) không bị chặn bởi trạng thái tạm dừng hay khoảng ngày, vì đó là lệnh trực tiếp. Chỉ chặn chiến dịch `archived` (mục 2.3).

### 3.2 Quản lý chiến dịch

- **Tạo:** tên bắt buộc, mặc định `active`.
- **Sửa:** tên, mục tiêu, khoảng ngày, trạng thái. Mọi chuyển trạng thái giữa `active` / `paused` / `archived` đều được phép.
- **Gắn lịch / bài nháp:**
  - Ở lúc tạo/sửa bài nháp, lúc tạo lịch, hoặc sửa lịch có sẵn.
  - `campaignId = null` để bỏ gắn.
  - Không gắn được vào chiến dịch `archived`.
- **Xoá:**
  - Chỉ khi không còn lịch hay bài nháp nào gắn vào; nếu còn → lỗi `Chiến dịch còn N lịch/bài nháp, hãy chuyển hoặc xoá trước`.
  - Lượt chạy và dòng theo dõi cũ giữ `campaign_id`; báo cáo hiện nhãn `(chiến dịch đã xoá)`.

## 4. Biến thể A/B

### 4.1 Chia biến thể cho đích

Với `n = 1 + variants.length` biến thể (nhãn `A`… theo thứ tự `text`, `variants[0]`, …), trong một lượt chạy:

1. Gom mọi cặp (profile, đích) của lượt.
2. Xếp theo thứ tự cố định: link đích, rồi `profileId`.
3. Cặp thứ `i` (từ 0) nhận biến thể `(i + offset) mod n`.
   - `offset` = số lượt **đã bắt đầu** trước đó của cùng lịch (trạng thái `running`, `done`, `cancelled`).
   - Đăng ngay không thuộc lịch thì `offset = 0`.

Hệ quả:
- Trong một lượt, số đích của mỗi biến thể chênh nhau tối đa 1.
- Lịch lặp lại thì mỗi lượt sau, mỗi đích dịch sang biến thể kế tiếp.

Việc chia xong trước khi đăng. Mọi lần thử lại (26.21) của một đích dùng **đúng** biến thể đã chia. Huỷ hay lỗi không làm đổi cách chia của các đích còn lại.

Chế độ `page` (fanpage) cũng chia như trên; chỉ bài trong nhóm được đo (giống 26.21).

### 4.2 Ghi nhận

- `fb_poster_results.variant` = nhãn đã đăng (`''` nếu bài không có biến thể).
- Dòng theo dõi: `variant` và `campaign_id` lấy từ kết quả và lượt chạy. `text_head` lấy từ **chữ của biến thể đã đăng**, không phải `text`. Nhờ vậy việc tìm lại bài trên bảng tin vẫn khớp.
- CSV Lịch sử thêm cột `variant` ở **cuối** (chỉ thêm cột).
- `runs.get` (Control API) trả thêm `variant` cho từng kết quả và `campaignId` cho lượt chạy.

## 5. Báo cáo

`statsReport` / `posts.stats` thêm:
- **`groupBy: 'campaign'`:**
  - key = `campaign_id` (`''` cho bài không thuộc chiến dịch);
  - nhãn = tên chiến dịch; `Không thuộc chiến dịch` khi key rỗng; `(chiến dịch đã xoá)` khi mã không còn trong bảng.
- **`groupBy: 'variant'`:**
  - key = `schedule_id + ':' + variant`; nhãn = `<tên lịch> · <nhãn>`.
  - Bài không có biến thể thì nhãn chỉ là `<tên lịch>`, hoặc `Đăng ngay` khi không có lịch.
  - Biến thể chỉ so sánh trong cùng một lịch.
- **Bộ lọc tuỳ chọn:** `campaignId` (`''` = bài không thuộc chiến dịch) và `scheduleId`, áp dụng cho mọi `groupBy` và cho `posts.list`.
- **Dòng báo cáo** thêm `insufficient: boolean` = `measured < 5`. Giao diện hiện `chưa đủ dữ liệu` thay cho kết luận.

Các chỉ số khác giữ như 26.21: số bài, có link, chờ duyệt, nghi xoá, cảm xúc / bình luận / chia sẻ của lần đo mới nhất, trung bình trên bài đã đo, tỉ lệ trên số thành viên.

## 6. Control API

Chỉ thêm. Tổng số thao tác: 30 → 35.

| Thao tác | Tham số | Kết quả |
|---|---|---|
| `campaigns.list` | `status?` (`active`/`paused`/`archived`; mặc định mọi trạng thái trừ `archived`) | `{ campaigns: [{ id, name, goal, status, startAt, endAt, createdAt, updatedAt, scheduleCount, draftCount, runnable, summary }] }`. `summary` = dòng báo cáo `groupBy campaign` từ lúc tạo chiến dịch (hoặc `null` nếu chưa có bài). |
| `campaigns.get` | `id` | một chiến dịch như trên, kèm `schedules` (id, name, kind, enabled, draft, nextRunAt) |
| `campaigns.create` | `name`, `goal?`, `startAt?`, `endAt?` | `{ campaign }` |
| `campaigns.update` | `id`, và tuỳ chọn `name`, `goal`, `status`, `startAt`, `endAt` (`null` để bỏ giới hạn) | `{ campaign }` |
| `campaigns.delete` | `id` | `{ deleted: true }`; lỗi `INVALID_PARAMS` nếu còn lịch / bài nháp (mục 3.2) |

Trường mới ở thao tác có sẵn:
- `drafts.create` / `drafts.update`: `variants` (mảng 1–4 chuỗi), `campaignId` (chuỗi hoặc `null`).
- `drafts.get` / `drafts.list`: trả thêm `campaignId`; `params.variants` có sẵn trong params.
- `schedules.list`: tham số tuỳ chọn `campaignId` (`''` = lịch không thuộc chiến dịch); mỗi lịch trả thêm `campaignId`.
- `schedules.update`: `campaignId` (chuỗi hoặc `null`).
- `posts.stats`: `groupBy` thêm `campaign`, `variant`; thêm `campaignId?`, `scheduleId?`; dòng thêm `insufficient`.
- `posts.list`: thêm `campaignId?`, `scheduleId?`; dòng thêm `variant`, `campaignId`.
- `runs.get`: xem mục 4.2.

Lỗi:
- `NOT_FOUND`: chiến dịch / lịch không có.
- `INVALID_PARAMS`: tên trùng, khoảng ngày sai, biến thể sai, chiến dịch `archived` khi gắn, xoá chiến dịch còn lịch / bài nháp. Không thêm mã lỗi mới.

Không có sự kiện mới.

## 7. Giao diện

- **Mục "Chiến dịch"** trong Đăng Facebook (đặt cạnh Lịch đăng):
  - Danh sách thẻ chiến dịch: tên, trạng thái (chip: Đang chạy / Tạm dừng / Lưu trữ / Chưa bắt đầu / Đã kết thúc theo khoảng ngày), khoảng ngày, số lịch, số bài, có link, tương tác TB/bài.
  - Nút **Tạo chiến dịch**; trên mỗi thẻ: Tạm dừng / Tiếp tục, Sửa, Lưu trữ, Xoá (khi được phép, có xác nhận).
  - Lọc: mặc định ẩn lưu trữ, có công tắc hiện.
- **Chi tiết chiến dịch:**
  - Mục tiêu, danh sách lịch / bài nháp của chiến dịch (bấm mở lịch như ở Lịch đăng).
  - `PerformancePanel` đã lọc theo chiến dịch, gom theo nhóm / lịch / biến thể.
- **Soạn bài:**
  - Ô chọn chiến dịch (tuỳ chọn; chỉ hiện chiến dịch chưa lưu trữ).
  - Nút **+ Biến thể** thêm tab B…E, mỗi tab một ô nội dung; xoá được từng tab.
  - Xem trước theo tab đang chọn; dòng gợi ý "Các nhóm sẽ lần lượt nhận A, B, …".
- **Lịch đăng:** bộ lọc theo chiến dịch; chi tiết lịch hiện chiến dịch và các biến thể; hộp sửa lịch có ô chọn chiến dịch.
- **Lịch sử:** chip `Biến thể B` trên kết quả có biến thể.
- **Hiệu quả:**
  - "Gom theo" thêm Chiến dịch và Biến thể.
  - Dòng `insufficient` hiện chữ xám `chưa đủ dữ liệu` ở cột TB/bài.
- **Theo `DESIGN.md`:** sáng/tối, 1280 và 390 px, không tràn ngang, có a11y.

## 8. Kiểm thử

- **Chia biến thể:**
  - 10 đích × 2 biến thể → 5/5;
  - 7 đích × 3 → 3/2/2;
  - thứ tự cố định không phụ thuộc thứ tự nhập;
  - `offset` theo số lượt đã bắt đầu của lịch (bỏ qua `missed` / `failed`);
  - thử lại giữ biến thể;
  - bài không có biến thể giữ `variant = ''` và chữ `text`.
- **Kiểm tham số:** `variants` 0–4, rỗng, trùng, quá dài; `campaignId` lạ hoặc `archived`.
- **Scheduler:**
  - lịch lặp của chiến dịch `paused` / ngoài khoảng → không chạy, không ghi;
  - lịch một lần → `missed` đúng lý do;
  - tạm dừng khi đang trong hàng chờ → `missed`;
  - tiếp tục → chạy lần kế tiếp;
  - lịch không chiến dịch không đổi.
- **Ghi nhận:** `text_head` theo biến thể; `campaign_id` chụp lại, không đổi khi chuyển lịch sau đó.
- **Báo cáo:** `groupBy campaign` / `variant`, lọc `campaignId` / `scheduleId`, `insufficient`, nhãn `(chiến dịch đã xoá)`.
- **Control API:**
  - danh sách thao tác thêm 5;
  - lỗi `NOT_FOUND` / `INVALID_PARAMS` / xoá còn lịch;
  - bot cũ gửi `text` không có trường mới vẫn chạy như trước.
- **Hồi quy:** toàn bộ jest; lịch đăng, bài nháp, theo dõi bài, Nghiên cứu.
- **Giao diện:** hai vòng kiểm tra 1280/390, sáng/tối, với dữ liệu giả.

## 9. Rủi ro

- **Chia biến thể làm lệch so sánh** vì nhóm lớn/nhỏ khác nhau. Giảm bằng xoay vòng qua các lượt, tỉ lệ trên số thành viên, và nhãn `chưa đủ dữ liệu`. Không cam kết ý nghĩa thống kê.
- **Hai biến thể giống nhau ở 60 ký tự đầu:** không ảnh hưởng đối chiếu, vì đối chiếu cần đúng tác giả. Trong một nhóm, một profile chỉ đăng một biến thể mỗi lượt, và các lượt của cùng lịch thường cách nhau xa hơn ±2 giờ.
- **Chiến dịch tạm dừng làm lỡ lịch một lần.** Đây là cố ý và có ghi `missed`. Anh có thể "Đăng ngay" thủ công.
- **Đổi luồng đăng** (chọn chữ theo đích) chạm vào `runTask` / `postToTargets`. Giữ nguyên ranh giới gửi bài và luật thử lại của 26.21; test hồi quy toàn bộ bộ test Đăng Facebook.
