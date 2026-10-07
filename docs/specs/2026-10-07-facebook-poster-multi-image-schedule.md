# Thiết kế: Đăng Facebook — nhiều ảnh và lên lịch đăng (đợt 1 và 2)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 07/10/2026 |
| Trạng thái | Chờ duyệt |
| Intent | `docs/intent/2026-10-07-facebook-poster-multi-image-schedule.md` |
| Nền | Tính năng Đăng Facebook hiện có: `docs/specs/2026-10-03-facebook-poster.md` |
| Ngoài phạm vi spec này | Đợt 3 (bước Đăng Facebook trong Workflow): spec riêng sau khi đợt 2 chạy ổn |

## 1. Bằng chứng đo được (spike 07/10/2026, thử khô, không bấm Đăng)

Đo trên hộp **"Tạo bài viết"** của trang cá nhân, giao diện tiếng Việt, bằng hồ sơ đã đăng nhập:

| Đo | Kết quả |
|---|---|
| `input[type=file]` trong hộp soạn | có sẵn, thuộc tính `multiple = true`, `accept` gồm `image/*` và nhiều loại video |
| Đưa 10 ảnh `jpg` đánh số 1–10 bằng **một** lần `setInputFiles` | xong sau dưới 100 ms, không lỗi |
| Lưới xem trước | 4 ô ảnh 1, 2, 3, 4 và ô thứ năm có lớp phủ `+6` → đủ 10 ảnh, **đúng thứ tự tệp đưa vào** |
| Thanh tải (`[role=progressbar]`) trong hộp | 0 suốt 60 giây theo dõi |
| Nút "Đăng" sau khi gõ chữ | bật (`aria-disabled` không có) |

**Chưa đo được:** hộp soạn trong **nhóm** (hồ sơ cá nhân trên máy đo đã bị đăng xuất) và trang soạn **Page** `/post/create` (hồ sơ Page đang đứng tên cá nhân). Thiết kế ở mục 4.2 có đường dự phòng cho trường hợp ô chọn tệp ở đó không có `multiple`. Bước kiểm chứng (mục 11) bắt buộc đo lại cả hai trước khi phát hành.

## 2. Mục tiêu

**Đợt 1 — nhiều ảnh:**

1. Một bài có 1 đến 10 ảnh (`jpg`, `jpeg`, `png`, `gif`, `webp`), hoặc đúng 1 video (`mp4`, `mov`, `webm`) như hiện nay. Không trộn ảnh với video.
2. Ảnh lên bài đúng thứ tự người dùng sắp, ở cả chế độ Nhóm và Page.
3. Người dùng chọn nhiều ảnh một lần, xem trước dạng lưới, đổi thứ tự, bỏ từng ảnh.

**Đợt 2 — lên lịch:**

4. Đặt lịch **một lần** (ngày giờ cụ thể) hoặc **lặp lại** (các thứ trong tuần, một giờ cố định) cho một bài, từ tab Đăng bài.
5. **Hàng đợi nhiều bài** = nhiều lịch một lần, mỗi lịch một bài và một giờ; tab "Lịch đăng" liệt kê theo giờ chạy.
6. Đến giờ thì chạy đúng như bấm "Bắt đầu đăng" với tham số đã lưu; kết quả vào Lịch sử, ghi rõ chạy từ lịch nào.
7. Đến giờ mà đang có việc khác: xếp hàng, chạy ngay khi việc trước xong; chờ quá 2 giờ thì bỏ lượt và báo.
8. App tắt hoặc máy ngủ lúc đến giờ: bỏ lượt, ghi "Đã lỡ" vào Lịch sử, báo khi mở app. Không đăng bù.
9. Không tính năng hiện có nào đổi hành vi (đăng tay, quét nhóm, xin vào nhóm, thu bình luận, Lịch sử, CSV, Browser Profiles).

## 3. Quyết định cho các câu hỏi mở của intent

| # | Câu hỏi | Quyết định | Lý do |
|---|---|---|---|
| 1 | Facebook nhận 10 ảnh một lần? | Có ở hộp "Tạo bài viết" (mục 1); dự phòng tải lần lượt nếu ô chọn tệp không `multiple` | Đo được một nửa, nửa còn lại đo ở bước kiểm chứng |
| 2 | Ảnh của lịch lưu đâu | Chép vào `<thư mục DB của workspace>/facebook-poster-media/<scheduleId>/` lúc lưu lịch; xoá cùng lịch | Người dùng xoá/đổi tên ảnh gốc thì lịch vẫn chạy; theo workspace như dữ liệu khác |
| 3 | Giới hạn chờ trong hàng | 2 giờ (hằng số `QUEUE_MAX_WAIT_MS`) | Quá 2 giờ thì "giờ vàng" đã qua |
| 4 | Nhập lịch lặp lại | Chọn các thứ trong tuần + giờ `HH:mm`; **không** cho nhập cron | Dễ dùng; tối đa một lượt/ngày/lịch, giảm rủi ro spam |
| 4b | Múi giờ | Múi giờ của máy | App desktop; người dùng đặt theo đồng hồ họ thấy |
| 5 | Báo "đã lỡ" | Thông báo nổi (`showNotification`) khi mở app + dòng "Đã lỡ" trong Lịch sử + trạng thái trong tab Lịch đăng | Thấy ngay, xem lại được |
| 6 | Giữ máy không ngủ | **Không** làm ở đợt này | Tốn điện, ngoài ý muốn người dùng; lỡ giờ đã được báo rõ |
| 7 | Rủi ro spam khi lặp | Tối đa một lượt/ngày/lịch (do kiểu nhập); dòng cảnh báo cố định trong hộp lên lịch | Không chặn cứng, nhưng không cho lặp dày hơn ngày |
| 8 | Đầu vào bước Workflow | Để spec đợt 3 | Ngoài phạm vi |
| 9 | Đổi workspace | Lịch thuộc từng workspace; đổi workspace thì dừng hẹn giờ cũ, nạp lịch của workspace mới và dò lượt đã lỡ | Giống dữ liệu Đăng Facebook hiện có |
| 10 | Dung lượng ảnh | Mỗi ảnh tối đa 20 MB; tổng tối đa 100 MB/bài | Chặn ổ đĩa đầy vì bản sao của lịch; dư cho ảnh tuyển dụng thường gặp |

## 4. Đợt 1 — nhiều ảnh

### 4.1 Tham số

`StartParams` kiểu `post` đổi `mediaPath: string | null` thành `mediaPaths: string[]` (rỗng = không đính kèm). `validateStartParams`:

- Vẫn nhận `mediaPath` (chuỗi) từ phiên bản cũ của giao diện và quy về `mediaPaths: [mediaPath]`.
- 0–10 tệp; mọi tệp phải tồn tại; đuôi thuộc danh sách ảnh hoặc video ở mục 2.
- Có video thì chỉ được đúng 1 tệp: lỗi `Một bài chỉ có 1 video, không kèm ảnh khác`.
- Quá 10 tệp: `Tối đa 10 ảnh mỗi bài`. Tệp ảnh quá 20 MB: `Ảnh "<tên>" lớn hơn 20 MB`. Tổng quá 100 MB: `Tổng dung lượng ảnh vượt 100 MB`.
- Trùng đường dẫn thì bỏ bản trùng, giữ thứ tự xuất hiện đầu tiên.

### 4.2 Đính kèm trong `postToTargets`

- Tìm `input[type=file]` trong hộp soạn như hiện nay (kể cả bước bấm "Ảnh/video" khi chưa có).
- Ô có `multiple` → `setInputFiles(mediaPaths)` một lần.
- Ô không có `multiple` → đưa lần lượt từng tệp; sau mỗi lần, tìm lại ô chọn tệp trong cùng gốc (Facebook có thể dựng lại ô). Không tìm thấy ô cho tệp thứ k thì đích đó `failed` với `Không đính kèm được ảnh thứ k`.
- Đợi tải xong: lặp mỗi 1 giây, tối đa `15 s + 5 s × số tệp`, cho tới khi trong hộp soạn không còn `[role=progressbar]`. Không chờ nút Đăng bật ở bước này vì ảnh được gắn **trước** khi gõ chữ, và nút Đăng tắt cho tới khi có chữ (đo được). Quá hạn thì đích `failed` với `Ảnh chưa tải lên xong`.
- Các bước sau (gõ nội dung, bấm Đăng, bằng chứng dương, bình luận đầu tiên) không đổi.

### 4.3 Giao diện tab Đăng bài

- Nút "Chọn ảnh/video" mở hộp chọn **nhiều** tệp (`properties: ['openFile', 'multiSelections']`). Chọn thêm lần nữa thì nối vào danh sách hiện có, rồi kiểm lại các giới hạn ở 4.1 ngay trên giao diện.
- Lưới xem trước ảnh nhỏ 72×72 px qua giao thức `local-media://` có sẵn; mỗi ô có số thứ tự, nút "Lên" / "Xuống" và nút bỏ (có `aria-label`). Video hiện tên tệp thay ảnh nhỏ.
- Đếm `n/10 ảnh` và tổng dung lượng. Vi phạm giới hạn thì tắt nút "Bắt đầu đăng" và "Lên lịch", hiện lý do.

## 5. Đợt 2 — dữ liệu

### 5.1 Bảng mới

```sql
CREATE TABLE IF NOT EXISTS fb_poster_schedules (
    id            TEXT PRIMARY KEY,          -- uuid
    name          TEXT NOT NULL,             -- người dùng đặt, mặc định 40 ký tự đầu nội dung
    kind          TEXT NOT NULL,             -- 'once' | 'recurring'
    params_json   TEXT NOT NULL,             -- StartParams kiểu 'post'; mediaPaths là tên tệp trong thư mục media của lịch
    run_at        INTEGER DEFAULT NULL,      -- 'once': mốc giờ chạy (ms)
    days          TEXT NOT NULL DEFAULT '',  -- 'recurring': danh sách thứ "1,3,5" (0 = Chủ nhật)
    time          TEXT NOT NULL DEFAULT '',  -- 'recurring': "HH:mm"
    enabled       INTEGER NOT NULL DEFAULT 1,
    next_run_at   INTEGER DEFAULT NULL,      -- null khi đã xong ('once') hoặc tạm dừng
    last_run_id   TEXT DEFAULT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fb_poster_schedules_next ON fb_poster_schedules(enabled, next_run_at);
```

### 5.2 Sửa bảng có sẵn

- `fb_poster_runs` thêm cột `schedule_id TEXT DEFAULT NULL`, theo mẫu `try { ALTER TABLE … ADD COLUMN … } catch {}` đang dùng trong `DatabaseService`.
- `FbPosterRunStatus` thêm `'missed'`. Lượt đã lỡ ghi một run `kind='post'`, `status='missed'`, `error` là lý do (`App tắt lúc đến giờ` hoặc `Chờ quá 2 giờ vì đang có việc khác`), không có kết quả đích nào.

### 5.3 Thư mục ảnh của lịch

`<path.dirname(dbPath)>/facebook-poster-media/<scheduleId>/<NN>-<tên gốc đã làm sạch>`; `NN` là thứ tự 01–10. Lưu lịch: chép ảnh, rồi mới ghi DB; chép lỗi thì xoá thư mục vừa tạo và báo lỗi. Xoá lịch: xoá dòng DB rồi xoá thư mục. Sửa lịch chỉ đổi thời gian và tên (mục 7.3), không đổi ảnh, nên không chép lại.

## 6. Đợt 2 — bộ hẹn giờ

### 6.1 Tính giờ chạy kế tiếp

Hàm thuần `computeNextRun(schedule, after: number): number | null` trong `src/services/facebookPoster/scheduleTime.ts`:

- `once`: `run_at` nếu `run_at > after`, ngược lại `null`.
- `recurring`: lần gần nhất **sau** `after` rơi vào một thứ trong `days` lúc `time` theo giờ máy; `days` rỗng → `null`.
- Xử lý đúng chuyển ngày, chuyển tuần, cuối tháng, và ngày chuyển giờ mùa hè/đông (không có ở Việt Nam, nhưng hàm không được ném lỗi).

### 6.2 `FacebookPosterScheduler`

Lớp thuần trong `src/services/facebookPoster/FacebookPosterScheduler.ts`, phụ thuộc tiêm vào: `store`, `now()`, `setTimer`/`clearTimer`, `isBusy()`, `startRun(params, scheduleId) → runId`, `notify(event)`.

| Sự kiện | Hành vi |
|---|---|
| `start()` (mở app, đổi sang workspace này) | **Dò lượt đã lỡ:** mọi lịch bật có `next_run_at < now − 60 s` → ghi run `missed` (`App tắt lúc đến giờ`), báo, tính lại `next_run_at` từ `now` (`once` → `next_run_at = null`, lịch vẫn còn để xem lại). Rồi hẹn giờ cho lịch gần nhất. |
| Hẹn giờ nổ | Mọi lịch bật có `next_run_at ≤ now` vào hàng chờ (kèm thời điểm vào hàng), tính lại `next_run_at` ngay (để lượt kế tiếp không bị mất nếu lượt này chờ lâu), rồi chạy hàng. |
| Chạy hàng | Không bận → lấy mục cũ nhất, đọc lại lịch từ DB (đã xoá hoặc tắt thì bỏ), gọi `startRun`. Bận → chờ sự kiện `runFinished`. Mục chờ quá 2 giờ → run `missed` (`Chờ quá 2 giờ vì đang có việc khác`) và báo. |
| `runFinished` của bất kỳ run nào | Chạy hàng. |
| `stop()` (thoát app, rời workspace) | Huỷ mọi hẹn giờ. Mỗi mục còn trong hàng chờ được ghi run `missed` (`App đóng khi lượt đang chờ`) rồi mới xoá hàng, vì `next_run_at` của chúng đã chuyển sang lượt sau nên lần `start()` kế tiếp không dò ra được. |

Hàng chờ không rỗng thì có thêm một hẹn giờ cho thời điểm mục cũ nhất tròn 2 giờ, để mục quá hạn được ghi `missed` ngay cả khi việc đang chạy chưa xong.

Hẹn giờ dùng `setTimeout` một lần cho lịch gần nhất (tối đa 24 giờ một lần, rồi hẹn lại), để không phụ thuộc đồng hồ máy bị chỉnh giữa chừng. Máy ngủ dậy trễ hơn giờ hẹn: lần nổ đầu tiên sau khi dậy coi các lịch có `next_run_at < now − 60 s` là đã lỡ, như `start()`.

### 6.3 Nối vào app

- `facebookPosterIpc.ts` tạo scheduler cùng lúc với `FacebookPosterService`, gắn `isBusy` = có run đang chạy, `startRun` = `service.start(...)` kèm `scheduleId`.
- `FacebookPosterService.start` nhận thêm `scheduleId?: string` và ghi vào `fb_poster_runs.schedule_id`.
- Thoát app và đổi workspace gọi `scheduler.stop()` trước `cancelFacebookPosterJobs()` / `cancelAndWaitFacebookPosterJobs()`; sau khi đổi workspace thì `start()` cho DB mới.
- Sự kiện mới `facebookPoster:scheduleMissed` `{ scheduleId, name, reason, at }` và `facebookPoster:schedulesChanged`.

## 7. Đợt 2 — IPC và giao diện

### 7.1 IPC (cùng `handle()` chặn chế độ nhân viên)

| Kênh | Tham số | Kết quả |
|---|---|---|
| `facebookPoster:scheduleCreate` | `{ name?, kind, runAt? \| { days, time }, params }` | `{ schedule }` |
| `facebookPoster:scheduleList` | — | `{ schedules[] }` gồm `nextRunAt`, `lastRun` (trạng thái, giờ) |
| `facebookPoster:scheduleUpdate` | `{ id, name?, enabled?, runAt?, days?, time? }` | `{ schedule }` |
| `facebookPoster:scheduleDelete` | `{ id }` | — |
| `facebookPoster:takeMissed` | — | `{ notices[] }`: các lượt đã lỡ phát hiện lúc giao diện chưa sẵn sàng (vd. lúc khởi động); lấy xong thì xoá |

Kiểm tra: `params` qua đúng `validateStartParams` kiểu `post`; `once` cần `runAt` sau `now + 60 s`; `recurring` cần ít nhất một thứ và `time` dạng `HH:mm` hợp lệ; tên tối đa 100 ký tự; tối đa 200 lịch mỗi workspace.

### 7.2 Tab Đăng bài

- Nút **"Lên lịch"** cạnh "Bắt đầu đăng", cùng điều kiện bật/tắt (trừ điều kiện "đang có việc chạy" — đặt lịch được cả khi đang chạy).
- Bấm mở hộp thoại: tên lịch; chọn **Một lần** (ô `datetime-local`) hoặc **Lặp lại** (7 ô chọn thứ + ô giờ); dòng cảnh báo cố định "Đăng cùng một nội dung lặp lại bằng nhiều tài khoản dễ bị Facebook hạn chế". Lưu thì chép ảnh, tạo lịch, báo "Đã lên lịch — chạy lúc …".

### 7.3 Tab mới "Lịch đăng" (giữa "Đăng bài" và "Tham gia nhóm")

- Bảng sắp theo giờ chạy kế tiếp: tên, kiểu (Một lần / Lặp lại "T2, T4, T6 lúc 08:00"), giờ chạy kế tiếp, lần chạy gần nhất (trạng thái + link sang Lịch sử), công tắc Bật/Tạm dừng, nút Sửa giờ, nút Xoá (có xác nhận).
- Sửa chỉ đổi tên và thời gian; muốn đổi nội dung thì xoá và lên lịch lại (ghi rõ trong hộp sửa).
- Trạng thái rỗng, đang tải, lỗi; làm mới khi có `facebookPoster:schedulesChanged` hoặc `runFinished`.

### 7.4 Báo lượt đã lỡ

- Một bộ lắng nghe duy nhất ở gốc app (`App.tsx`), để báo cả khi người dùng ở màn khác và không bị trùng: lúc mở app gọi `takeMissed`, sau đó nghe `facebookPoster:scheduleMissed`; hiện `showNotification('Lịch "<tên>" đã lỡ lúc <giờ>: <lý do>', 'warning')`.
- Lịch sử hiện nhãn "Đã lỡ" cho run `missed`, kèm tên lịch.

## 8. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Chép ảnh khi lưu lịch lỗi (ổ đầy, mất quyền) | Không tạo lịch; báo lỗi; xoá thư mục dở |
| Ảnh trong thư mục lịch bị xoá tay | Lượt đó `failed` mọi đích với `Không tìm thấy tệp ảnh/video` (kiểm tra của `validateStartParams` khi chạy) |
| Profile hoặc nhóm của lịch đã bị xoá | Các đích đó `failed` như đăng tay; lịch vẫn giữ |
| Chưa cài nhân trình duyệt lúc đến giờ | Lượt `failed` với thông báo hiện có |
| Hai lịch cùng giờ | Vào hàng theo thứ tự `next_run_at` rồi `created_at`; chạy lần lượt |
| Đồng hồ máy bị chỉnh lùi | Hẹn lại tối đa 24 giờ một lần nên tự đúng lại; không chạy lặp |

## 9. Ngoài phạm vi

Bước Workflow (đợt 3); lên lịch quét nhóm, xin vào nhóm, thu bình luận; giữ máy không ngủ; nội dung khác nhau giữa các lượt lặp; sửa nội dung/ảnh của lịch đã tạo; nhân viên đặt lịch; lặp nhiều lần trong một ngày.

## 10. Tệp dự kiến thay đổi

| Tệp | Thay đổi |
|---|---|
| `src/services/facebookPoster/validateStartParams.ts` | `mediaPaths`, giới hạn ảnh |
| `src/services/facebookPoster/postToTargets.ts` | đính kèm nhiều tệp, đợi tải xong |
| `src/services/facebookPoster/FacebookPosterService.ts` | `scheduleId`; phát `runFinished` cho scheduler |
| `src/services/facebookPoster/scheduleTime.ts` (mới) | `computeNextRun` |
| `src/services/facebookPoster/FacebookPosterScheduler.ts` (mới) | hàng chờ, hẹn giờ, dò lượt đã lỡ |
| `src/services/facebookPoster/FacebookPosterStore.ts`, `schema.ts` | bảng lịch, cột `schedule_id`, `missed` |
| `src/services/database/DatabaseService.ts` | `ALTER TABLE` thêm `schedule_id` |
| `src/models/facebookPoster.ts` | kiểu lịch, `missed` |
| `electron/ipc/facebookPosterIpc.ts` | chọn nhiều tệp, IPC lịch, vòng đời scheduler |
| `electron/main.ts`, `electron/ipc/workspaceIpc.ts` | dừng/khởi động scheduler khi thoát và đổi workspace |
| `electron/preload.ts`, `src/ui/lib/ipc.ts` | API và sự kiện mới |
| `src/ui/features/facebookPoster/PostTab.tsx` | lưới ảnh, nút Lên lịch, hộp thoại lên lịch |
| `src/ui/features/facebookPoster/ScheduleTab.tsx` (mới) | tab Lịch đăng |
| `src/ui/features/facebookPoster/FacebookPosterView.tsx`, `HistoryTab.tsx` | tab mới, nhãn "Đã lỡ", báo lượt đã lỡ |
| `src/__tests__/facebookPoster/*` | test mới (mục 11) |
| `README.md`, `SYSTEM_DOCUMENTATION.md`, `DESIGN.md` | mô tả và mục giao diện |

## 11. Kiểm thử

**Unit test (jest):**

- `validateStartParams`: 0/1/10/11 ảnh; video kèm ảnh; 2 video; ảnh > 20 MB; tổng > 100 MB; trùng đường dẫn; `mediaPath` cũ quy về `mediaPaths`.
- `postToTargets`: ô `multiple` → một lần `setInputFiles` với cả mảng, đúng thứ tự; ô không `multiple` → lần lượt, tìm lại ô mỗi lần; quá hạn đợi tải → `failed` đúng thông báo.
- `computeNextRun`: một lần trong quá khứ/tương lai; lặp lại cùng ngày trước/sau giờ hẹn; qua tuần; `days` rỗng.
- `FacebookPosterScheduler` với đồng hồ và hẹn giờ giả: dò lượt đã lỡ khi `start()`; nổ đúng giờ khi rảnh; xếp hàng khi bận và chạy khi `runFinished`; quá 2 giờ → `missed`; `stop()` ghi `missed` cho mục còn chờ; lịch bị xoá/tắt khi đang chờ thì bỏ; hai lịch cùng giờ chạy lần lượt.
- `FacebookPosterStore`: tạo/đọc/sửa/xoá lịch; `schedule_id` trên run; run `missed`.

**Kiểm tra trên trang thật (thử khô, không bấm Đăng), bắt buộc trước khi phát hành:**

1. Hộp soạn trong **nhóm** với 10 ảnh: số ảnh, thứ tự, nút Đăng bật.
2. Trang soạn **Page** `/post/create` với 10 ảnh: như trên; ghi nhận ô chọn tệp có `multiple` hay không.

**Kiểm tra tay trên bản dựng (hai vòng, 1440 px và 375 px, sáng và tối):** lưới ảnh, hộp lên lịch, tab Lịch đăng; một lịch một lần đặt sau 2 phút chạy đúng giờ với hồ sơ thử (chỉ đăng thật khi anh cho phép); tắt app qua giờ hẹn rồi mở lại thấy "Đã lỡ".

**Lệnh kiểm chứng:** `npx jest`, `npx tsc -p tsconfig.electron.json --noEmit`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit`, `npm run build:electron`, `npm run build:renderer`, và `npm run production` (bước `strip-console` tự kiểm cú pháp).

## 12. Rủi ro

- **Nhóm và Page chưa đo nhiều ảnh.** Có đường dự phòng tải lần lượt; kiểm chứng bắt buộc ở mục 11.
- **Lịch chỉ chạy khi app mở và máy thức.** Đã báo "Đã lỡ"; người dùng cần để máy không ngủ vào giờ hẹn.
- **Bản sao ảnh chiếm ổ đĩa.** Giới hạn 100 MB/bài, 200 lịch/workspace; xoá lịch là xoá ảnh.
- **Đăng lặp lại cùng nội dung dễ bị coi là spam.** Tối đa một lượt/ngày/lịch, có cảnh báo.
