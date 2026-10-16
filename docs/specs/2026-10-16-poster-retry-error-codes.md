# Thiết kế: Tự thử lại khi đăng bài lỗi và mã lỗi cụ thể

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 16/10/2026 |
| Trạng thái | Chờ duyệt |
| Kế hoạch | `docs/plans/2026-10-16-poster-retry-error-codes.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-16-poster-retry-error-codes.md` (đã duyệt) |
| Nhánh | `feat/poster-retry-error-codes` |
| Phiên bản dự kiến | 26.20.0 |

## 1. Phạm vi

- Chỉ áp dụng cho việc **đăng bài** (`kind = 'post'`), cả nhóm lẫn trang.
- Tham gia nhóm, quét nhóm, thu bình luận giữ nguyên.
- Bình luận đầu (`firstComment`) giữ nguyên; nó chỉ chạy sau khi bài đã đăng thành công.

## 2. Mã lỗi

Mỗi kết quả đăng bài có thêm `error_code` (chuỗi) và `attempts` (số lần đã thử, ≥ 1). `error` chứa lý do tiếng Việt cụ thể, không còn dùng câu chung "Không đăng được, xem nhật ký".

| Mã | Khi nào | Thử lại? | Câu `error` |
|---|---|---|---|
| `navigation_failed` | `page.goto` tới nhóm/trang ném lỗi (hết giờ, mất mạng) | Có | `Không tải được trang nhóm: <thông báo gốc, ≤ 200 ký tự>` |
| `composer_not_found` | Không mở được hộp soạn thảo | Có | `Không mở được hộp soạn thảo (không thấy ô "Bạn đang nghĩ gì…")` |
| `media_failed` | Không thấy nút Ảnh/Video, không thấy ô tải tệp, không gắn được ảnh thứ N, ảnh chưa tải xong | Có | Đúng câu tương ứng đang có trong nhật ký, bỏ phần `[kind] [ERROR]` và URL |
| `editor_not_focusable` | Không đặt được con trỏ vào ô nhập | Có | `Không đặt được con trỏ vào ô nhập nội dung` |
| `submit_not_ready` | Bước cuối không hiện nút Đăng, hoặc nút Đăng đang tắt | Có | Câu tương ứng trong nhật ký |
| `submit_not_found` | Không tìm thấy nút Đăng để bấm; **chưa có cú bấm nào** | Có | `Không tìm thấy nút Đăng` |
| `unexpected_error` | Lỗi bất ngờ (ném ngoại lệ) **trước** đoạn không quay lại | Có | `Lỗi bất ngờ: <thông báo gốc, ≤ 200 ký tự>` |
| `uncertain_after_submit` | Đã bấm Đăng nhưng hộp soạn thảo không đóng / vẫn ở `/post/create`; lỗi bất ngờ **sau** đoạn không quay lại; trình duyệt bị đóng cưỡng bức khi đang chờ kết quả | **Không** | Giữ câu hiện có, thêm `— có thể bài đã lên, kiểm tra trước khi đăng lại` |
| `draft_conflict` | Lần thử lại thấy hộp soạn thảo vẫn còn bản nháp không xoá được (mục 3.3) | **Không** | `Hộp soạn thảo còn bản nháp cũ, không thử lại để tránh đăng trùng` |
| `not_logged_in` | Profile chưa đăng nhập Facebook | Không | Câu hiện có |
| `launch_failed` | Không mở được trình duyệt/profile | Không | Thông báo gốc |
| `stopped` | Bị dừng do Huỷ (`outcome = skipped`) | Không | `Đã dừng` (như hiện tại) |
| `unknown` | Không xác định (mọi trường hợp còn lại) | Không | `Không đăng được, xem nhật ký` |

**Ghi chú:**
- Bài đăng thành công có `error_code = ''`.
- Bản ghi cũ trong DB có `error_code = ''` và `attempts = 1`.
- Kết quả của các loại việc khác `post` luôn có `error_code = ''` và `attempts = 1`.

## 3. Thử lại trong lượt đăng

### 3.1 Quy tắc

- Tối đa `MAX_POST_ATTEMPTS = 3` lần cho mỗi đích (tức thử lại 2 lần).
- Chỉ thử lại khi mã lỗi thuộc nhóm "Có" ở bảng mục 2, **và** không đang Huỷ.
- Giữa các lần, chờ ngẫu nhiên `RETRY_DELAY_MIN_SEC = 10` đến `RETRY_DELAY_MAX_SEC = 30` giây. Chờ bằng `sleepStoppable`, nên Huỷ cắt ngay.
- Nhật ký ghi `[Đăng Bài] Thử lại lần k/2 sau Xs: <câu error>` trước mỗi lần thử lại.
- Kết quả cuối của đích là kết quả của **lần cuối cùng**. `attempts` = số lần đã chạy.
- Khoảng nghỉ giữa hai đích tính như cũ, không cộng thời gian thử lại.

### 3.2 Ranh giới "đã bấm Đăng"

- `postToSingleTarget` phải báo được mỗi lần thất bại xảy ra trước hay sau khi đã thực sự bấm Đăng.
  - **Trước khi bấm:** mọi lỗi trước lời gọi `enterCritical()`, cộng với `submit_not_found`, vì trường hợp này không có cú bấm nào.
  - **Sau khi bấm:** mọi lỗi kể từ khi cú bấm đã được gửi đi (đã gọi click thành công, hoặc gọi click bị ném lỗi; với nút dự phòng là `humanClick` thành công). Các lỗi này luôn là `uncertain_after_submit`.
- Trước khi thử lại sau `submit_not_found`, gọi `leaveCritical()` để Huỷ đóng được trình duyệt như bình thường.

### 3.3 Dọn trước khi thử lại

Trước mỗi lần thử lại:

1. Nếu hộp soạn thảo còn mở: bấm `Escape`. Nếu Facebook hỏi bỏ bài, bấm nút có nhãn thuộc `DISCARD_LABELS = ['Bỏ', 'Bỏ bài viết', 'Discard', 'Discard post', 'Rời khỏi', 'Leave']`.
2. Chấp nhận hộp thoại `beforeunload` (nếu có) trong lúc tải lại trang. Chỉ đăng ký cho lần điều hướng của lần thử lại, rồi gỡ ngay.
3. Lần thử lại chạy lại toàn bộ `postToSingleTarget`, bắt đầu bằng `page.goto(url)`.
4. Ở lần thử lại, sau khi đặt được con trỏ vào ô nhập và **trước khi gõ**:
   - nếu ô nhập đã có chữ, chọn hết rồi xoá (`Control+A`, `Backspace`);
   - nếu xoá xong vẫn còn chữ, dừng với `draft_conflict`.

**Rủi ro chưa đo:** khi bài có ảnh, bản nháp có thể còn giữ ảnh của lần trước. Selector nhận diện ảnh trong bản nháp chưa đo trên trang thật, nên bước 1 (bỏ bản nháp) là cách chính để tránh trùng ảnh. Xem mục 6.

## 4. Dữ liệu và giao diện

### 4.1 DB

Thêm vào `FB_POSTER_MIGRATIONS`:
- `ALTER TABLE fb_poster_results ADD COLUMN error_code TEXT NOT NULL DEFAULT ''`
- `ALTER TABLE fb_poster_results ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1`

`FbPosterResult` có thêm `errorCode: string` và `attempts: number`.

### 4.2 Control API

`runs.get` trả thêm `errorCode` và `attempts` cho mỗi kết quả. Đây là thay đổi chỉ-thêm.

### 4.3 CSV

`CSV_COLUMNS` thêm `error_code` và `attempts` vào **cuối**.

### 4.4 Lịch sử (`HistoryTab`)

- Dòng kết quả hiện lý do lỗi như hiện tại (giờ là lý do thật).
- Thêm chip nhỏ `Thử N lần` khi `attempts > 1`.
- Mã `uncertain_after_submit` hiện chip màu cam `Chưa chắc`, title là câu `error`.
- Không đổi bố cục khác. Đúng ở sáng/tối, desktop và 390 px.

### 4.5 Thông báo `watch`

Không đổi code. Dòng `• <tên đích>: <lỗi>` tự dùng lý do cụ thể.

## 5. Kiểm thử

**Jest (giả lập trang, không vào Facebook):**
- `postToTargets`:
  - `composer_not_found` lần 1, thành công lần 2 → `ok`, `attempts = 2`, có dòng nhật ký "Thử lại lần 1/2".
  - Hỏng đủ 3 lần → `failed`, `attempts = 3`, mã đúng.
  - `uncertain_after_submit` → 1 lần, không thử lại.
  - `submit_not_found` → có `leaveCritical` trước khi thử lại.
  - Huỷ trong lúc chờ thử lại → dừng ngay, không thử tiếp.
  - Ô nhập còn chữ ở lần thử lại → được xoá trước khi gõ.
  - Xoá không được → `draft_conflict`, không thử tiếp.
  - Ngoại lệ trước đoạn quan trọng → thử lại; ngoại lệ sau → `uncertain_after_submit`.
  - Mỗi mã ở bảng mục 2 có ít nhất một test ánh xạ.
- `FacebookPosterService`:
  - `not_logged_in`, `launch_failed`, `stopped`, cưỡng bức đóng → `uncertain_after_submit`;
  - `errorCode`/`attempts` được ghi.
- Store và migration:
  - DB cũ được thêm cột với giá trị mặc định;
  - `getRun` trả trường mới.
- `runCsv`: hai cột mới ở cuối.
- `ControlMethods`/`runs.get`: có trường mới.

**Hồi quy:** toàn bộ jest; tham gia nhóm, quét nhóm, thu bình luận không đổi.

**Chạy thật ở dev:** chỉ kiểm tra giao diện Lịch sử (dữ liệu giả trong DB tách riêng). Không đăng thật.

## 6. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Đăng trùng do thử lại sau khi bài đã lên | Ranh giới mục 3.2: mọi lỗi sau cú bấm là `uncertain_after_submit`, không thử lại |
| Bản nháp giữ chữ/ảnh cũ, gây trùng nội dung | Bỏ bản nháp trước khi thử lại; xoá chữ còn sót; không xoá được thì `draft_conflict`. Ảnh trong nháp chưa đo được: anh theo dõi những lần thử lại đầu tiên trên bài có ảnh |
| Thử lại làm Facebook nghi ngờ (thao tác dồn dập) | Tối đa 2 lần, chờ 10–30 giây, chỉ cho lỗi trước khi bấm |
| Lượt đăng kéo dài hơn | Tối đa thêm khoảng 1 phút mỗi đích lỗi; lịch đến giờ vẫn xếp hàng như hiện tại |
