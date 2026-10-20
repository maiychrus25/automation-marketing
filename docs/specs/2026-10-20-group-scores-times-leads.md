# Thiết kế: Chấm điểm nhóm, giờ đăng tốt nhất và khách tiềm năng từ bình luận

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 20/10/2026 |
| Trạng thái | Đã phát hành 26.23.0 (D + F, 20/10/2026); E chờ 26.24 |
| Kế hoạch | `docs/plans/2026-10-20-group-scores-best-times.md` (26.23: D + F); E: `docs/plans/2026-10-20-comment-leads.md` |
| Intent | `docs/intent/2026-10-20-group-scores-times-leads.md` (đã duyệt) |
| Nhánh | `feat/26.23-group-scores-best-times` (D + F); E làm trên nhánh riêng |
| Phiên bản | 26.23.0 (D + F), 26.24.0 (E) |
| Dùng lại | Theo dõi bài 26.21 (`fb_poster_post_tracking`, `fb_poster_post_stats`, `statsReport`, `PostTracker` / `PostTrackScheduler`, khe việc), chiến dịch / biến thể 26.22, Thu bình luận (`collectComments`, `fb_poster_comments`), `matchKeywords.ts`, `AIAssistantService` |

## 1. Phạm vi

- **26.23:**
  - **D:** điểm nhóm.
  - **F:** báo cáo theo giờ / thứ, gợi ý giờ đăng.
  - Chỉ đọc dữ liệu đã có, không thêm lần mở Facebook nào.
- **26.24 — E:** tự thu bình luận theo mốc, lọc khách tiềm năng (từ khoá + AI tuỳ chọn), danh sách khách, Telegram, API.

Ngoài phạm vi:
- tự bỏ nhóm điểm thấp, tự đổi giờ lịch;
- tự nhắn khách;
- đẩy khách sang CRM Zalo;
- múi giờ riêng (mọi giờ đều theo giờ máy).

## 2. D — Điểm nhóm

### 2.1 Dữ liệu đầu vào

Mỗi nhóm (`group_url`) trong khoảng thời gian (mặc định 30 ngày; tuỳ chọn lọc `campaignId`):

| Đại lượng | Nguồn |
|---|---|
| `attempted` | kết quả đăng nhóm (`fb_poster_results` của lượt `kind = 'post'`, `mode = 'group'`) có `outcome` `posted` hoặc `failed`. Không tính `failed` có `error_code` `not_logged_in` / `launch_failed` / `stopped`, vì đó là lỗi của profile, không phải của nhóm. |
| `posted` | trong `attempted`, số có `outcome = 'posted'` |
| `failed` | `attempted - posted` |
| `held` | dòng theo dõi có `link_status` `pending_approval` hoặc `not_found` |
| `removed` | dòng theo dõi có `removed_suspected = 1` |
| `withLink` | dòng theo dõi có `link_status = 'known'` |
| `engagement` | như `statsReport` nhóm: `engagementRate` (theo số thành viên) nếu biết, ngược lại `avgEngagement`; kèm `measured` |

### 2.2 Công thức

Nhóm có `attempted < MIN_SCORE_POSTS` (= 3) → `score = null`, `grade = 'insufficient'`.

Ngược lại có bốn thành phần, mỗi thành phần trong khoảng 0–1:

| Thành phần | Công thức | Trọng số |
|---|---|---|
| `success` | `posted / attempted` | 20 |
| `published` | `1 - held / posted` (`posted = 0` → 0) | 25 |
| `survival` | `1 - removed / withLink` (`withLink = 0` → 1) | 20 |
| `engagement` | so với **trung vị** của các nhóm đủ điều kiện có `measured ≥ 1`, cùng đơn vị đo (ưu tiên `engagementRate`; nhóm nào thiếu số thành viên thì cả lượt dùng `avgEngagement`): `min(value / median / 2, 1)`. Nhóm chưa đo (`measured = 0`) hoặc `median = 0` → `0.5`. | 35 |

- `score = round(20·success + 25·published + 20·survival + 35·engagement)`.
- `grade`: `good` (≥ 70), `fair` (40–69), `poor` (< 40).
- Nhãn hiển thị: Tốt / Trung bình / Kém / Chưa đủ dữ liệu.

### 2.3 Lý do (`reasons`, tiếng Việt, theo thứ tự ảnh hưởng)

- `published < 0.7` → `"<held>/<posted> bài phải chờ duyệt hoặc không tìm thấy"`.
- `removed > 0` → `"<removed> bài nghi bị xoá"`.
- `success < 0.8` → `"<failed>/<attempted> lần đăng lỗi"`.
- `engagement < 0.35` (khi đã đo) → `"Tương tác thấp hơn mức giữa của các nhóm"`.
- `engagement ≥ 0.9` → `"Tương tác cao (gấp ~<x> lần mức giữa)"`.
- Chưa đo → `"Chưa có số đo tương tác"`.
- `insufficient` → `"Mới có <attempted> lượt đăng (cần ≥ 3)"`.

Hàm thuần `scoreGroups(rows: GroupScoreInput[]): GroupScore[]` nằm ở `src/services/facebookPoster/groupScores.ts`. Store chỉ gom số liệu đầu vào.

## 3. F — Giờ đăng

### 3.1 Báo cáo

`statsReport` / `posts.stats` thêm:
- `groupBy: 'hour'`: key `'00'`…`'23'` theo giờ máy của `posted_at`, nhãn `"09h"`;
- `groupBy: 'weekday'`: key `'1'`…`'7'` (Thứ 2 … Chủ nhật), nhãn `"Thứ 2"` … `"Chủ nhật"`.

Hai kiểu này sắp theo key, không theo số bài. Các bộ lọc có sẵn (`campaignId`, `scheduleId`) và cờ `insufficient` áp dụng như các kiểu gom khác.

### 3.2 Gợi ý (`bestTimes`)

Đầu vào: khoảng thời gian (mặc định **60 ngày**), tuỳ chọn `groupUrl`, `campaignId`.
- Lấy các khung giờ và các thứ có `measured ≥ MIN_MEASURED_FOR_COMPARISON` (5).
- Xếp theo `avgEngagement` giảm dần.
- Trả **tối đa 3 giờ** và **tối đa 2 thứ**: `{ hours: [{ hour, label, avgEngagement, measured }], weekdays: [...], insufficient }`.
- `insufficient = true` khi không có khung giờ nào đủ điều kiện.

Hàm thuần `pickBestTimes(hourRows, weekdayRows)` nằm ở `src/services/facebookPoster/bestTimes.ts`.

## 4. Control API (26.23)

Chỉ thêm. Tổng thao tác 35 → 37.

| Thao tác | Tham số | Kết quả |
|---|---|---|
| `posts.groupScores` | `from?`, `to?` (epoch ms; mặc định 30 ngày), `campaignId?` | `{ groups: [{ groupUrl, label, score, grade, attempted, posted, failed, held, removed, withLink, measured, engagement, reasons }] }`, sắp `score` giảm dần, `insufficient` xếp cuối |
| `posts.bestTimes` | `from?`, `to?` (mặc định 60 ngày), `groupUrl?`, `campaignId?` | như mục 3.2 |

`posts.stats.groupBy` thêm `hour`, `weekday`. Lỗi tham số → `INVALID_PARAMS`. Không có sự kiện mới.

## 5. Giao diện (26.23)

- **Hiệu quả:**
  - "Gom theo" thêm **Giờ**, **Thứ**.
  - Khi gom theo **Nhóm**, thêm cột **Điểm**: chip màu theo nhãn, rê chuột hoặc bấm để xem lý do; dòng `insufficient` hiện "chưa đủ dữ liệu".
  - Dưới bảng có dòng **"Giờ nên đăng: 9h, 20h, 21h · Thứ nên đăng: Thứ 7, Chủ nhật"**, hoặc "Chưa đủ dữ liệu để gợi ý giờ đăng". Dòng này theo đúng bộ lọc của bảng: chiến dịch, khoảng ngày.
- **Soạn bài:** danh sách nhóm của profile hiện chip điểm nhỏ cạnh tên nhóm (không hiện với nhóm chưa đủ dữ liệu). Rê chuột xem lý do.
- **Hộp hẹn giờ** (`ScheduleDialog`): dòng gợi ý "Giờ hiệu quả: 9h, 20h, 21h" khi có dữ liệu.
- **Theo `DESIGN.md`:** sáng/tối, 1280 và 390 px, a11y (chip có `aria-label` chứa điểm và nhãn).

## 6. E — Khách tiềm năng từ bình luận (26.24)

### 6.1 Tự thu bình luận

- **Cấu hình** `fb_poster_lead_config` ở `app_settings`, mặc định: `{ autoCollect: true, collectAtMinutes: [120, 1440, 4320], keywords: [...], detectPhone: true, aiEnabled: false, aiMinScore: 60 }`.
  - Mỗi mảng có 1–10 phần tử, tăng dần, mỗi phần tử trong khoảng 30–20160 phút.
  - `keywords` gồm 1–100 mục, mỗi mục 1–40 ký tự.
  - Từ khoá mặc định: `giá, bao nhiêu, bn, ib, inbox, nhắn, ship, mua, đặt, order, còn hàng, còn không, sđt, số điện thoại, zalo, liên hệ, tư vấn, địa chỉ, size`.
- **Chọn bài:** dòng theo dõi có `link_status = 'known'`, `post_url` khác rỗng, đến mốc thu kế tiếp. Cột mới `comments_done TEXT` (nhãn mốc, ví dụ `"120m"`) và `next_comment_at INTEGER NULL`.
- **Lượt thu:** bộ hẹn giờ `CommentCollectScheduler` chạy mỗi 15 phút.
  - Mỗi lượt tối đa 10 bài; nghỉ 10–20 s giữa hai bài.
  - Dùng khe việc chung (`acquireExclusive`) và đúng profile đã đăng.
  - Gọi `collectComments` có sẵn và **không** tạo dòng Lịch sử.
- **Khi profile hết phiên hoặc bị checkpoint:** ghi trạng thái đăng nhập, bỏ các bài còn lại của profile đó, rồi dời mốc như cách lùi lịch của 26.21. Không lặp lại mỗi 15 phút.
- **Thời điểm ước tính:**
  - Cột mới `commented_at_ms INTEGER NULL` trên `fb_poster_comments`, đổi từ nhãn tương đối: "Vừa xong", "N phút", "N giờ", "Hôm qua", "N ngày", "N tuần", và các dạng tiếng Anh tương ứng.
  - Dạng ngày tháng cụ thể thì đọc ngày; không đọc được thì `NULL`.

### 6.2 Lọc khách

Mỗi lần `saveComments` (thu tay hoặc thu tự động), các bình luận **mới** được lọc:

1. **Từ khoá:** khớp không dấu, theo ranh giới từ, với bất kỳ từ khoá nào; hoặc (`detectPhone`) có chuỗi giống số điện thoại Việt Nam (`0` / `+84`, 9–11 chữ số, cho phép dấu cách / chấm / gạch).
2. **AI** (khi `aiEnabled`):
   - Các bình luận khớp bước 1 được gửi theo lô ≤ 20 tới trợ lý AI mặc định (`structured`).
   - Mỗi bình luận nhận về `{ intent: 'buy' | 'question' | 'other', score: 0–100, reason }`. Chỉ thành khách khi `score ≥ aiMinScore`.
   - AI lỗi hoặc chưa cấu hình → mọi bình luận khớp bước 1 đều thành khách, `ai_*` để `NULL`, và log cảnh báo một lần mỗi lượt.

### 6.3 Bảng `fb_poster_leads`

| Cột | Ghi chú |
|---|---|
| `id` INTEGER PK | |
| `comment_key` TEXT UNIQUE | `fb_poster_comments.key`, dùng để chống trùng |
| `post_url`, `result_id` NULL, `group_url`, `campaign_id` NULL, `variant`, `profile_id` | lấy từ dòng theo dõi có cùng `post_url` (nếu có) |
| `author_id`, `author_name`, `author_url`, `text` | từ bình luận |
| `commented_at_ms` NULL | |
| `matched` TEXT | các từ khoá khớp, cách nhau bằng dấu phẩy; có thêm `phone` nếu khớp số điện thoại |
| `ai_intent`, `ai_score`, `ai_reason` NULL | |
| `status` | `new` / `contacted` / `won` / `ignored` |
| `note` TEXT | ≤ 1000 ký tự |
| `detected_at`, `updated_at` | ms |

Dữ liệu giữ 180 ngày, cùng nhịp dọn với dữ liệu theo dõi.

### 6.4 Giao diện, API, Telegram

- **Mục "Khách tiềm năng"** trong Đăng Facebook:
  - lọc theo trạng thái / chiến dịch / khoảng ngày / tìm chữ;
  - mỗi dòng: người bình luận (link), nội dung, nhóm, chiến dịch / biến thể, từ khoá khớp / điểm AI, thời gian, trạng thái (đổi tại chỗ), ghi chú;
  - mở bài, xuất Excel;
  - ⚙ cấu hình (mục 6.1).
- **Thu bình luận:** giữ như cũ. Thêm cột "Khách" đánh dấu bình luận đã thành khách.
- **Control API** (37 → 42):
  - `comments.collect` (`postUrls?` hoặc lấy các bài đến hạn; chạy nền giống `posts.track`);
  - `comments.list` (`postUrl?`, `since?`, `limit`, `offset`);
  - `leads.list` (`status?`, `campaignId?`, `from?`, `to?`, `limit`, `offset`);
  - `leads.update` (`id`, `status?`, `note?`);
  - `leads.config` (đọc / ghi).
- **Sự kiện** `leads.found` `{ count, samples: [{ authorName, text, postUrl }] (≤ 3), auto }`.
- **Telegram** (bridge): `"🎯 <count> khách tiềm năng mới"` kèm tối đa 3 dòng `"<tên>: <nội dung cắt 80 ký tự>"`. Chỉ gửi khi `count > 0`.

## 7. Kiểm thử

- **D:** `scoreGroups`
  - từng thành phần, trọng số, biên (`posted = 0`, `withLink = 0`, chưa đo, `median = 0`);
  - ngưỡng nhãn; lý do theo thứ tự;
  - dưới 3 lượt → không có điểm;
  - lỗi do profile không bị tính.
- **Store D:** gom `attempted` / `failed` theo nhóm từ kết quả, khớp `group_url`; lọc chiến dịch; khoảng thời gian.
- **F:**
  - `groupBy hour` / `weekday` (giờ máy, Chủ nhật = 7);
  - `pickBestTimes` (ngưỡng 5 bài đã đo, tối đa 3 giờ / 2 thứ, `insufficient`).
- **Control API:** 2 thao tác mới, `groupBy` mới, kiểm tham số; bot cũ không đổi.
- **Giao diện:** hai vòng 1280/390, sáng/tối, dữ liệu giả.
- **(26.24) E:**
  - đọc nhãn thời gian;
  - lọc từ khoá (không dấu, ranh giới từ, số điện thoại);
  - AI lỗi rơi về từ khoá;
  - chống trùng;
  - chọn bài đến mốc / lùi lịch khi lỗi;
  - khe việc;
  - sự kiện và tin Telegram.

## 8. Rủi ro

- **Điểm nhóm thiên lệch khi mẫu nhỏ.** Giảm bằng tối thiểu 3 lượt, nhãn "chưa đủ dữ liệu", và lý do hiện rõ.
- **Giờ máy khác giờ người xem.** Ghi rõ trong giao diện: "theo giờ máy".
- **(E) Đọc bình luận phụ thuộc giao diện Facebook; tự thu làm tăng số lần mở trang.** Giảm bằng mốc thưa, giới hạn mỗi lượt, khe việc chung, lùi lịch khi lỗi, có công tắc tắt.
- **(E) AI tốn token và có thể sai.** AI tắt sẵn, chỉ chấm bình luận đã khớp từ khoá, có ngưỡng điểm, và người dùng vẫn đổi trạng thái tay được.

## Ghi chú sau phát hành (26.23)

- `bestTimes` trả các mục với trường `key` (không phải `hour`), đúng như code và protocol.
- Kết quả được đếm theo `created_at` của kết quả (khớp `posted_at` của theo dõi); các thành phần điểm được chặn trong 0..1.
- Không có lý do "chờ duyệt" khi số bài đã đăng (posted) bằng 0.
- Dòng "Giờ nên đăng" và gợi ý ở hộp Hẹn giờ luôn dùng 60 ngày gần nhất (có nhãn trên màn hình), không theo khoảng 7/30 ngày của bảng, vì khoảng ngắn hiếm khi đủ 5 bài đã đo mỗi khung.
- Nhãn gom của bảng là "Giờ (giờ máy)" / "Thứ (giờ máy)".
- Cột Điểm đặt ngay sau tên nhóm.
- Nhóm có ~70% bài bị giữ vẫn rơi quanh "Trung bình" (≈55) vì trọng số thành công / sống sót giữ đầy đủ; có thể cần chỉnh trọng số sau khi có dữ liệu thật.
- Gợi ý trong ScheduleDialog không xét chiến dịch.
- Chip điểm trong Soạn bài chỉ hiện cho nhóm khớp đúng `group_url`.
