# GĐ2 — Bản nháp và luồng duyệt cho Đăng Facebook

Status: approved (2026-10-10) · Intent: [docs/intent/intent.md](../intent/intent.md) · Nhánh: `feat/poster-postiz-ui` (sau GĐ1 `e6d9a5b`)

## Mục tiêu

Người dùng soạn bài, **lưu nháp**, xem nháp trên lịch, **duyệt** rồi mới hẹn giờ hoặc đăng ngay.
Không bài nào tự chạy khi chưa được duyệt — đây là cổng "duyệt trước khi đăng" đã chốt ở intent
(và là chỗ để các luồng tự động sau này, ví dụ sinh nội dung theo tuần, đổ bài vào chờ duyệt).

## Hiện trạng liên quan

- `fb_poster_schedules`: `kind` once/recurring, `params_json` (StartParams kiểu post; `mediaPaths` là
  tên tệp trong thư mục media của lịch), `run_at`, `days`, `time`, `enabled`, `next_run_at`.
- Scheduler chỉ chạy lịch `enabled = 1 AND next_run_at <= now` (`listDueSchedules`), một việc một lúc,
  ghi lịch sử chạy kèm `schedule_id`.
- `scheduleUpdate` chỉ sửa tên/giờ/bật-tắt — **chưa sửa được nội dung + ảnh**.
- Migration: danh sách `FB_POSTER_MIGRATIONS` chạy `ALTER TABLE` trong try/catch.
- GĐ1 modal soạn bài chỉ giữ nội dung trong phiên, chưa có nháp lưu DB.

## Thiết kế

### Dữ liệu

- Thêm cột: `ALTER TABLE fb_poster_schedules ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`.
- Một bản nháp là một dòng lịch với: `draft = 1`, `kind = 'once'`, `enabled = 0`, `next_run_at = NULL`,
  `run_at` = **giờ dự kiến** để đặt trên lịch (có thể `NULL` = chưa xếp lịch).
- Bất biến an toàn: bản nháp luôn `enabled = 0` và `next_run_at = NULL`. Vì scheduler (kể cả bản app cũ
  dùng chung DB) chỉ chạy `enabled = 1`, nháp không bao giờ tự chạy. Thêm phòng thủ:
  `listDueSchedules`/`nextDue` lọc thêm `draft = 0`; `pumpQueue` bỏ qua lịch có `draft`.
- Model `FbPosterSchedule` thêm `draft: boolean`.

### IPC (main)

| Kênh | Việc làm |
|---|---|
| `facebookPoster:draftSave({ id?, name?, plannedAt?, params })` | Tạo mới hoặc ghi đè nội dung nháp. Chép ảnh mới vào thư mục media của lịch, xoá ảnh không còn dùng. Kiểm `params` (xem "Mức kiểm tra"). `plannedAt` nếu có phải ở tương lai. |
| `facebookPoster:draftGet({ id })` | Trả nháp kèm `mediaPaths` **đường dẫn tuyệt đối** để mở lại trong modal soạn (GĐ1 ghi nhận API chỉ trả tên tệp). |
| `facebookPoster:draftApprove({ id, when: 'schedule', kind, runAt \| days+time })` | Kiểm đầy đủ `params` + giờ (≥ 1 phút), chuyển thành lịch thật: `draft = 0`, `enabled = 1`, tính `next_run_at`. Lịch lặp được phép tại bước này. |
| `facebookPoster:draftApprove({ id, when: 'now' })` | Kiểm đầy đủ `params`, đặt `draft = 0`, `enabled = 1`, `kind = 'once'`, `run_at = next_run_at = now`, gọi `scheduler.reschedule()` → đi qua hàng đợi sẵn có (tôn trọng "một việc một lúc", có lịch sử, media xử lý như lịch thường). |
| `scheduleUpdate` | Chặn đổi `enabled` của nháp (không được bật nháp mà bỏ qua duyệt). Cho phép đổi `runAt` (kéo-thả trên lịch = đổi giờ dự kiến). |
| `scheduleDelete` | Dùng lại, xoá cả media. |

### Giao diện

- **Modal soạn bài**: thêm nút **Lưu nháp** cạnh *Hẹn giờ* / *Đăng ngay*. Mở từ một ô trên lịch thì giờ ô đó
  là giờ dự kiến. Mở một nháp có sẵn thì nạp lại nội dung, ảnh, profile, nhóm; Lưu nháp ghi đè.
- **Lịch**: nháp hiện ở giờ dự kiến, trạng thái **Nháp** (màu cam, viền nét đứt để khác bài đã hẹn).
  Nháp chưa có giờ dự kiến hiện ở dải **"Nháp chưa xếp lịch"** phía trên lưới và trong chế độ Danh sách.
  Bộ lọc trạng thái thêm "Nháp". Kéo-thả nháp đổi giờ dự kiến.
  Nháp đã **quá giờ dự kiến** mà chưa duyệt vẫn là nháp, không tự chạy; hiện nhãn "Quá giờ dự kiến" để người dùng hẹn lại.
- **Chi tiết nháp**: *Sửa* (mở modal) · *Duyệt & hẹn giờ* (mở hộp hẹn giờ một lần/lặp) ·
  *Đăng ngay* (hỏi xác nhận) · *Xoá* (hỏi xác nhận).
- Nhãn chữ tiếng Việt, mã định danh tiếng Anh, theo token màu Postiz của GĐ1, dark/light, mobile.

### Mức kiểm tra nội dung nháp (đã chốt: phương án đề xuất)

- **Đề xuất:** nháp chỉ bắt buộc **nội dung**; profile/nhóm/ảnh được phép thiếu. Khi **duyệt** mới kiểm
  đầy đủ như đăng bài hiện tại (`validateStartParams`). Lý do: nháp là chỗ chuẩn bị dần, và luồng tự động
  sau này sẽ sinh nội dung trước, người dùng chọn nhóm sau.
- Phương án đơn giản hơn: nháp phải hợp lệ đầy đủ ngay từ đầu (ít code, nhưng nháp kém linh hoạt).

## Ngoài phạm vi

Phân quyền ai được duyệt; thông báo duyệt qua Zalo; sinh nội dung tự động/AI; nháp cho tác vụ tham gia
nhóm hoặc thu bình luận; sửa nội dung của lịch đã duyệt (vẫn xoá rồi tạo lại như hiện tại).

## Rủi ro

- **Đăng nhầm khi chưa duyệt** — chặn bằng bất biến `enabled = 0` + lọc `draft = 0` ở scheduler + chặn bật
  nháp qua `scheduleUpdate`. Có test cho cả ba.
- **Bản app cũ dùng chung DB** thấy nháp như lịch tạm dừng; nếu bấm "Bật" ở bản cũ thì nháp thành lịch
  thật. Chấp nhận được (chỉ xảy ra khi chạy song song bản cũ), ghi chú ở changelog.
- **Media**: sửa nháp phải xoá đúng ảnh không còn dùng, không đụng ảnh của lịch khác. Có test.
- Không tạo lịch thật trên máy người dùng khi kiểm thử UI; dùng nháp (an toàn theo thiết kế) hoặc lịch
  xa trong tương lai đã tạm dừng, xoá sau khi xong.

## Kiểm thử

- Unit: migration thêm cột (chạy lại không lỗi); store đọc/ghi `draft`; `listDueSchedules` bỏ nháp;
  scheduler không chạy nháp kể cả khi dữ liệu lệch; `draftSave` tạo/ghi đè/dọn media; `draftApprove`
  schedule/now (kiểm giờ, kiểm params, `now` đi qua hàng đợi); `scheduleUpdate` từ chối bật nháp.
- UI trên app thật: lưu nháp từ modal và từ ô lịch, mở lại sửa, kéo đổi giờ dự kiến, duyệt & hẹn giờ,
  đăng ngay (chỉ thử tới bước xác nhận, không đăng thật), xoá; 2 vòng desktop/mobile × dark/light.
- `tsc` electron + renderer, `jest`, `vite build`, chạy từng lệnh một.
