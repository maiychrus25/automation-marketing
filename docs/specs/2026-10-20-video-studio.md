# Thiết kế: Sản xuất video bán hàng (HyperFrames + máy chủ render)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 20/10/2026 |
| Trạng thái | Đã phát hành 26.25.0 (20/10/2026); maihub-render 1.0.0 triển khai lên VPS 21/10/2026 (sau nginx sẵn có, không dùng Caddy) |
| Kế hoạch | `docs/plans/2026-10-20-video-studio.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-20-video-studio.md` (đã duyệt) |
| Spike | `docs/reports/2026-10-20-hyperframes-spike.md` |
| Nhánh | `feat/26.25-video-studio` |
| Phiên bản | 26.25.0 (MaiHub) và `maihub-render` 1.0.0 |
| Dùng lại | HyperFrames 0.8.181 (ghim phiên bản), Control API + `InboxMediaStore` (`/v1/media`), Soạn bài (`mediaPaths`), bridge Telegram |

## 1. Phạm vi

Trong phạm vi:
- dịch vụ `maihub-render`: API, worker cắt mạng, hàng đợi, 3 mẫu, 5 bản nhạc CC0, Docker Compose, Caddy (HTTPS);
- mục "Video" trong MaiHub và thư viện video;
- dùng video trong Soạn bài;
- Control API `videos.*`, sự kiện `videos.finished`, tin Telegram.

Ngoài phạm vi:
- giọng đọc AI, phụ đề, chỉnh video kéo thả;
- nhiều máy render;
- mở dịch vụ cho người ngoài;
- triển khai lên VPS (bước riêng, cần duyệt và cấp SSH).

## 2. `maihub-render` — tổng quan

- **Mã nguồn** ở `services/maihub-render/` trong repo này: TypeScript, `package.json` riêng, test riêng; **không** đóng gói vào app Electron.
- **Docker Compose** gồm 3 dịch vụ:

| Dịch vụ | Mạng | Vai trò |
|---|---|---|
| `caddy` | có | HTTPS (Let's Encrypt), chuyển tiếp tới `api`. Tên miền mặc định `render-<ip-gạch-ngang>.sslip.io`, hoặc tên miền của anh |
| `api` | có (chỉ ra Caddy) | nhận việc, kiểm khoá, hàng đợi, lưu tệp, trả kết quả. **Không** giữ quyền Docker |
| `worker` | **`network_mode: none`** | render bằng HyperFrames + Chrome + FFmpeg; root filesystem chỉ đọc; tmpfs `/tmp`; giới hạn 4 CPU / 3 GB RAM |

- **Thư mục dùng chung** (volume) giữa `api` và `worker`, chia theo vai trò:
  - `/shared/current/`: **chỉ một việc tại một thời điểm**. `api` chép tệp của việc vào đây; `worker` chỉ gắn thư mục này và `/shared/out/`;
  - `/shared/out/`: `worker` ghi `result.json`, `video.mp4`, `thumb.jpg`, `progress.json`;
  - `api` giữ kho việc ở `/data/` (không gắn vào `worker`).
- **Giao tiếp `api` ↔ `worker` bằng tệp, không qua mạng:**
  - `api` ghi `/shared/current/job.json` cuối cùng (sau khi đã chép xong tệp);
  - `worker` thấy `job.json` thì render, ghi `progress.json` (`{ percent }`) trong lúc chạy, rồi ghi `result.json` (`{ ok, error?, durationMs }`);
  - `api` đọc kết quả, chuyển tệp sang `/data/jobs/<id>/`, rồi xoá sạch `/shared/current` và `/shared/out`;
  - huỷ: `api` ghi `/shared/current/cancel`, `worker` dừng render và ghi `result.json` `{ ok: false, error: 'cancelled' }`.
- **Image `worker`:** `node:22-bookworm-slim`, FFmpeg, phông `fonts-noto-core` và `fonts-noto-color-emoji`, `hyperframes@0.8.181`, GSAP 3.14.2 đóng gói sẵn, `chrome-headless-shell` cài ở `/opt/hf`, `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, chạy bằng user không phải root.

## 3. An toàn

- **Khoá API:**
  - `RENDER_API_KEYS` dạng JSON `{ "<tên MaiHub>": "<sha256 của khoá>" }` trong `.env` (không commit);
  - khoá gốc dài 32 byte ngẫu nhiên, sinh bằng lệnh `npm run keygen -- <tên>`;
  - so sánh thời gian hằng;
  - mỗi khoá chỉ thấy việc của mình.
- **Giới hạn (vượt giới hạn → 400 kèm lỗi tiếng Việt):**

| Giới hạn | Giá trị |
|---|---|
| Thời lượng video | ≤ 120 giây |
| Khổ | ≤ 1080×1920 (hoặc 1920×1080) |
| fps | 24 / 30 |
| Số ảnh mỗi việc | ≤ 20 |
| Dung lượng mỗi ảnh / video nguồn | ≤ 20 MB |
| Nhạc | ≤ 15 MB |
| Tổng dung lượng mỗi việc | ≤ 200 MB |
| HTML tự viết | ≤ 512 KB |
| Thời gian render mỗi việc | ≤ 15 phút (quá → `failed: timeout`) |
| Hàng đợi | ≤ 20 việc chung, ≤ 5 việc đang chờ mỗi khoá |
| Tạo việc | ≤ 30 lần mỗi giờ mỗi khoá |
| Lưu trữ | việc và tệp xoá sau 7 ngày |

- **Loại tệp** kiểm theo **chữ ký nội dung** (magic bytes), không chỉ theo đuôi:
  - ảnh: JPEG / PNG / WebP;
  - nhạc: MP3 / M4A / WAV;
  - video nguồn: MP4 (tuỳ chọn).
- **Tên tệp** do `api` đặt lại (`img1.jpg`…); không dùng tên người gửi trong đường dẫn.
- **HTML tự viết** chỉ chạy trong `worker` (không mạng, chỉ thấy thư mục của việc đó). Các tài nguyên tham chiếu bằng đường dẫn tương đối trong thư mục việc. `api` kiểm có phần tử gốc `data-composition-id` và `data-duration` ≤ 120.
- **Log** không ghi khoá API hay nội dung HTML.

## 4. API của `maihub-render` (`/v1`, `Authorization: Bearer <khoá>`)

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/v1/health` | `{ ok, version, hyperframes, queue }` (không cần khoá) |
| GET | `/v1/templates` | danh sách mẫu (mục 5) và nhạc có sẵn `{ templates, music: [{ id, name, durationSec, license, source }] }` |
| POST | `/v1/jobs` | `multipart/form-data`: trường `spec` (JSON) + các tệp `files[]`. Trả `{ jobId, status: 'queued', position }` |
| GET | `/v1/jobs/:id` | `{ jobId, status: 'queued' \| 'rendering' \| 'done' \| 'failed' \| 'cancelled', progress 0–1, position?, error?, durationSec?, sizeBytes?, createdAt, finishedAt? }` |
| GET | `/v1/jobs/:id/video` | MP4 (khi `done`) |
| GET | `/v1/jobs/:id/thumb` | JPG khung giữa video |
| DELETE | `/v1/jobs/:id` | huỷ (đang chờ: bỏ khỏi hàng; đang chạy: báo `worker` dừng) |

`spec` có một trong hai dạng:
- **Mẫu:** `{ template: { id, aspect: '9:16' | '1:1' | '16:9', variables: {...}, images: ['<tên tệp trong files>'...], musicId?: '<id nhạc có sẵn>' | null, musicFile?: '<tên tệp>' }, fps?: 30, quality?: 'standard' | 'high' }`.
- **HTML tự viết:** `{ html: '<chuỗi>', width, height, fps?, quality? }`. Các tệp trong `files[]` được đặt vào thư mục việc với tên đã chuẩn hoá (`asset1.jpg`…) và trả về bảng đổi tên trong phản hồi. Trước khi gửi, bot dùng `videos.templates` để biết quy ước tên.

## 5. Mẫu

- Mỗi mẫu là một thư mục `services/maihub-render/templates/<id>/`, gồm `index.html` và `template.json`.
- `template.json`:
  - `{ id, name, description, aspects, durationSec: { min, max, default }, imageSlots: { min, max }, variables: { <key>: { type: 'string' | 'color' | 'number', label, maxLength?, default } } }`;
  - biến khai báo đồng thời trong `data-composition-variables` (HyperFrames);
  - ảnh đưa vào qua biến `images` (danh sách tên tệp).
- **Khổ:** một `index.html` dùng chung bố cục co giãn theo `data-width` / `data-height`. `api` đặt kích thước theo `aspect`: 1080×1920, 1080×1080 hoặc 1920×1080.
- **Ba mẫu:**

| id | Tên | Ảnh | Biến chính | Thời lượng |
|---|---|---|---|---|
| `product-slideshow` | Trình chiếu sản phẩm | 3–8 | `title`, `price`, `oldPrice?`, `cta`, `accent` | 6 giây/ảnh (15–48 giây) |
| `flash-sale` | Flash sale | 1–4 | `title`, `oldPrice`, `price`, `discountLabel`, `endsText`, `cta`, `accent` | 15–30 giây |
| `product-spotlight` | Nổi bật 1 sản phẩm | 1–3 | `title`, `benefit1..3`, `price`, `cta`, `accent` | 15–30 giây |

- Chữ dài được tự thu nhỏ để không tràn khung; chữ quá `maxLength` thì bị từ chối ở `api`.
- **Nhạc:**
  - 5 bản CC0 từ FreePD.com, lưu tên tác giả và nguồn trong `music/manifest.json`;
  - nhạc tự động lặp hoặc cắt theo thời lượng, có fade 1 giây đầu và cuối;
  - không có nhạc nếu `musicId` = `null`.

## 6. MaiHub

### 6.1 Cấu hình

- Cài đặt → **Máy chủ render video:** địa chỉ (`https://…`) và khoá API.
  - Khoá lưu mã hoá bằng `safeStorage` như khoá AI hiện có; giao diện chỉ hiện 4 ký tự cuối.
  - Có nút **Thử kết nối** (gọi `/v1/health` rồi `/v1/templates`).
- Chưa cấu hình → mục Video hiện hướng dẫn, các mục khác không ảnh hưởng.

### 6.2 Dữ liệu

Bảng `video_jobs` mới:

| Cột | Ghi chú |
|---|---|
| `id` TEXT PK | uuid cục bộ |
| `remote_id` TEXT | `jobId` của máy chủ |
| `name` TEXT | tên do người dùng hoặc bot đặt, ≤ 100 ký tự |
| `source` | `app` / `bot` |
| `template_id` TEXT NULL | `NULL` = HTML tự viết |
| `aspect` TEXT | |
| `spec_json` TEXT | spec đã gửi (không chứa đường dẫn máy) |
| `status` | `uploading` / `queued` / `rendering` / `done` / `failed` / `cancelled` |
| `progress` REAL | |
| `error` TEXT | |
| `file_path`, `thumb_path` TEXT NULL | trong `userData/videos/` |
| `size_bytes`, `duration_sec` | |
| `created_at`, `finished_at` | |

Video giữ cho đến khi người dùng xoá. Tệp nằm ở `userData/videos/<id>.mp4` và `.jpg`.

### 6.3 `VideoService` (tiến trình chính)

- **`render(input)`:** kiểm tra dữ liệu với `template.json` (lấy từ `/v1/templates`, cache 10 phút) → tải tệp lên → lưu dòng → theo dõi.
- **Theo dõi:** hỏi trạng thái mỗi 3 giây khi có việc chưa xong. Mở lại app thì tiếp tục theo dõi các việc dở. Máy chủ không trả lời → giữ trạng thái, thử lại; quá 30 phút không liên lạc được → `failed: 'Mất liên lạc với máy chủ render'`.
- **Xong:**
  - tải MP4 và ảnh bìa về `userData/videos/`;
  - phát sự kiện renderer `videos:changed`;
  - phát sự kiện Control `videos.finished`;
  - việc tạo bởi bot: chép MP4 vào hộp thư `/v1/media` (`InboxMediaStore.adopt`) và trả `mediaId` trong sự kiện.
- Không giới hạn số việc gửi đi phía MaiHub; máy chủ đã giới hạn (mục 3).

### 6.4 Giao diện — mục "Video" trong Đăng Facebook

- **Mẫu:** thẻ mẫu (tên, mô tả, khổ hỗ trợ). Chọn mẫu → form sinh từ `template.json`:
  - ảnh: chọn nhiều, kéo đổi thứ tự, xem trước nhỏ;
  - các ô chữ / giá / màu;
  - khổ;
  - nhạc: không nhạc / nhạc có sẵn (nghe thử) / tải tệp lên;
  - tên video.
- **Tạo video** → việc xuất hiện trong thư viện cùng tiến độ.
- **Thư viện:** lưới thẻ (ảnh bìa, tên, trạng thái, tiến độ, thời lượng, dung lượng) với các nút:
  - **Xem** (trình phát trong app);
  - **Dùng trong Soạn bài** (mở Soạn bài với video đã gắn);
  - **Tải về** (lưu tệp);
  - **Huỷ** (khi đang chờ / đang chạy);
  - **Xoá**.
- **Theo `DESIGN.md`:** sáng / tối, 1280 và 390 px, a11y.

### 6.5 Control API (chỉ thêm, 42 → 47)

| Thao tác | Tham số | Kết quả |
|---|---|---|
| `videos.templates` | — | `{ templates, music }` từ máy chủ |
| `videos.render` | `name`, và **một trong hai**: (`templateId`, `aspect`, `variables`, `imageIds` [mã tệp `/v1/media`], `musicId?` hoặc `musicMediaId?`) hoặc (`html`, `width`, `height`, `assetIds?`) | `{ videoId, status }` |
| `videos.status` | `videoId` | dòng `video_jobs` (bỏ đường dẫn máy) |
| `videos.list` | `status?`, `limit`, `offset` | `{ videos, total }` |
| `videos.cancel` | `videoId` | `{ cancelled }` |

- **Sự kiện** `videos.finished`: `{ videoId, name, ok, error?, durationSec?, sizeBytes?, mediaId? }`.
  - `mediaId` chỉ có với video do bot tạo; dùng ngay trong `drafts.create.mediaIds` (hết hạn sau 24 giờ như mọi tệp hộp thư).
- **Lỗi** (không thêm mã mới):
  - chưa cấu hình máy chủ → `INVALID_PARAMS` "Chưa cấu hình máy chủ render video";
  - hàng đợi máy chủ đầy / quá hạn mức (HTTP 429) → `LIMIT_REACHED`;
  - không liên lạc được máy chủ → `INTERNAL` "Không kết nối được máy chủ render";
  - không tìm thấy → `NOT_FOUND`;
  - sai tham số → `INVALID_PARAMS`.
- **Telegram** (bridge):
  - `"🎬 Video xong: <tên> (<giây>s)"`;
  - lỗi: `"⚠️ Video lỗi: <tên> — <lỗi cắt 120 ký tự>"`.

## 7. Kiểm thử

- **`maihub-render`:**
  - kiểm khoá (đúng / sai / thiếu, so sánh thời gian hằng);
  - giới hạn và loại tệp theo chữ ký;
  - hàng đợi (thứ tự, giới hạn mỗi khoá, huỷ khi chờ / khi chạy);
  - giao tiếp tệp `api` ↔ `worker` (giả `worker`);
  - dọn 7 ngày;
  - kiểm `spec` (mẫu / HTML);
  - mỗi khoá chỉ thấy việc của mình.
- **Kiểm tra tích hợp** (`docker compose`, chạy tay):
  - render 3 mẫu × 3 khổ;
  - HTML "xấu" (mạng, `file://`, leo thư mục) như spike;
  - đo thời gian.
- **MaiHub:**
  - `VideoService` (giả máy chủ HTTP): tải lên, theo dõi, mở lại app tiếp tục theo dõi, mất liên lạc, tải kết quả, `adopt` vào hộp thư;
  - IPC; Control API (5 thao tác, sự kiện, lỗi);
  - bridge;
  - giao diện 1280 / 390, sáng / tối với máy chủ giả.
- **Hồi quy:** toàn bộ jest, tsc, `check-docs`.

## 8. Rủi ro

- **Render tốn CPU, hàng đợi có thể dài:** chỉ chạy một việc mỗi lúc, giới hạn hàng đợi, hiện vị trí trong hàng.
- **HyperFrames đổi nhanh:** ghim 0.8.181. Nâng phiên bản là một việc riêng, chạy lại kiểm tra tích hợp.
- **Thoát khỏi Chrome sandbox:** `worker` không mạng, không bí mật, chỉ thấy việc hiện tại, filesystem chỉ đọc, user không root.
- **Facebook nén lại video:** dùng H.264 chất lượng `standard`; video 9:16 ≤ 60 giây cho reels.
- **Nhạc:** chỉ dùng CC0 có nguồn. Nhạc người dùng tải lên thuộc trách nhiệm người dùng (ghi trong giao diện).

## Ghi chú sau phát hành

- **Huỷ và `videos.finished`:** huỷ vẫn phát `videos.finished` nhưng kèm `cancelled: true` (`ok = false`, `error = "Đã huỷ"`); bridge không báo Telegram khi huỷ.
- **Nhạc của bot (`musicMediaId`):** `/v1/media` nhận thêm `mp3` / `m4a` / `wav` (≤ 15 MB); luồng đăng/bản nháp vẫn không nhận nhạc.
- **Biến tuỳ chọn:** `template.json` có `variables.<tên>.required` (mặc định `true`); `false` cho phép chuỗi trống (mẫu tự ẩn phần tử). Chỉ `product-slideshow.oldPrice` là tuỳ chọn.
- **Giới hạn lưu trữ:** tệp đầu vào bị xoá ngay khi việc kết thúc (đầu ra giữ 7 ngày); còn trống dưới 2 GB ở `data/` thì `POST /v1/jobs` trả 507 (`LIMIT_REACHED`, "Máy chủ render sắp hết dung lượng"). `api` không theo liên kết tượng trưng hay tệp đặc biệt trong `shared/out` (do worker ghi).
- **`api` đóng cả thư mục `music/`** (nghe thử qua `GET /v1/music/:id`).
- Sự kiện renderer đặt tên `video:changed` (không phải `videos:changed` như mục 6.3), cho đồng nhất với các kênh IPC `video:*`.
- `videos.status` trả `{ video }` và `videos.list` trả `{ total, videos }`; cả hai bỏ `filePath`, `thumbPath`, `specJson` cho bot.

## Ghi chú sau phát hành

- Bàn giao theo từng việc: `out/<jobId>.mp4`, `.jpg`, `.result.json`, `.progress.json`. Worker tự huỷ khi `current/job.json` đổi sang việc khác.
- `api` đọc tệp của worker với `O_NOFOLLOW|O_NONBLOCK`, kiểm `fstat` là tệp thường và giới hạn dung lượng.
- Mẫu dùng token của `buildWorkdir`: `{{width}}`, `{{height}}`, `{{durationSec}}`, `{{audio}}` và tuỳ chọn `secondsPerImage`.
- Biến mẫu hỗ trợ `required: false` (`product-slideshow.oldPrice`).
- Thêm endpoint `GET /v1/music/:id` để nghe thử nhạc (không có trong bảng mục 4 gốc).
- Tệp đầu vào bị xoá ở mọi đường kết thúc việc.
- Còn trống dưới 2 GB thì trả 507 (MaiHub báo `LIMIT_REACHED`, "Máy chủ render sắp hết dung lượng").
- Huỷ video phát `videos.finished` với `cancelled:true` (Telegram không báo).
- `/v1/media` nhận thêm mp3/m4a/wav; đăng bài vẫn từ chối tệp âm thanh.
- URL máy chủ render chỉ được dùng http với localhost, 127.0.0.1 hoặc [::1]; còn lại bắt buộc https.
- Nhạc nền: FreePD.com đã đóng; 5 bài lấy từ bản chụp Wayback Machine của chính các trang FreePD (khai báo public domain). Chủ sản phẩm cần xác nhận cách lấy này chấp nhận được.
- Đã kiểm tích hợp cục bộ bằng docker compose (không có Caddy): dựng video mẫu 1:1 dài 18 giây mất khoảng 52 giây; HTML độc hại bị chặn.
- Chưa kiểm Caddy/TLS và triển khai thật lên VPS.
- Cài đặt máy chủ render là một tab riêng trong Cài đặt.
- Thêm trong 26.26.0: bot tải video đã xong về bằng `GET /v1/videos/file` (tool `maihub_download_video`, lệnh `download-video`), và `watch` gửi kèm tệp video (≤ 50 MiB) cho tin `🎬 Video xong`. Không thêm thao tác hay mã lỗi.
- Triển khai thật: Caddy tắt bằng `docker-compose.override.yml` vì VPS đã có nginx giữ 80/443; `api` chỉ nghe `127.0.0.1:18080`, nginx làm TLS (Let's Encrypt).

## Ghi chú sau triển khai (21/10/2026)

- Video HTML 1920×1080 dài 40 giây do bot gửi bị lỗi sau 4 giây: worker 3 GB RAM khiến HyperFrames chụp từng khung và với 2 worker thì lưu mọi khung ra `/tmp` (cần ~1,99 GB, tmpfs chỉ 2 GB). Sửa bằng `HF_CAPTURE_PARALLEL_STREAM=true` cho `worker` (ghép thẳng vào video). Đo trên VPS: 960 khung 1080p xong trong 129 giây, 1200 khung trong 135 giây, `/tmp` gần như không dùng.
- `renderRunner` báo dòng lỗi thật của HyperFrames (dòng tiến độ `Failed: …`) thay vì dòng gợi ý chung cuối cùng (`Try --docker for containerized rendering`).
- Video HTML của bot dùng animation CSS (`animation … var(--start)`) nên render ra nền đứng yên: HyperFrames tua theo timeline GSAP, không chạy animation CSS; lint báo `root_missing_composition_id`, `root_missing_dimensions`, `missing_timeline_registry`. Sửa: việc HTML được cấp sẵn `gsap.min.js`, `worker` chạy `hyperframes lint --json` trước khi render và báo lỗi kèm mã; mô tả `videos.render` và `GUIDE` mục 7 có quy ước và khung mẫu (đã kiểm trên VPS: lint 0 lỗi, có hoạt ảnh).
- Việc HTML `a6c9b13a…` (21/10) bị chặn ở 80% với "Render blocked by 1 correctness warning:" mà không có chi tiết: trang gọi GSAP từ `cdn.jsdelivr.net`, worker không có mạng nên timeline lỗi (`sub_timeline_script_failure`); bot thử trên máy có mạng nên chạy được. Sửa: GSAP lõi từ CDN tự đổi sang `gsap.min.js` có sẵn, script mạng khác báo lỗi trước khi render, và lỗi "blocked" kèm các dòng `- …` chi tiết.
