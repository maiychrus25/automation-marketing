# maihub-render: máy chủ render video cho MaiHub

Nhận việc từ MaiHub (mẫu có sẵn hoặc HTML tự viết), render bằng HyperFrames + Chrome + FFmpeg, trả MP4. Thiết kế đầy đủ: `docs/specs/2026-10-20-video-studio.md`.

Ba dịch vụ trong `docker-compose.yml`:

| Dịch vụ | Mạng | Vai trò |
|---|---|---|
| `caddy` | có | HTTPS tự động (Let's Encrypt), chuyển tiếp tới `api` |
| `api` | chỉ nội bộ, ra ngoài qua Caddy | nhận việc, kiểm khoá, hàng đợi, lưu tệp. Không có quyền Docker |
| `worker` | **không có mạng** | render. Root filesystem chỉ đọc, chạy bằng user `node` |

## 1. Yêu cầu máy chủ

- VPS Ubuntu/Debian, **≥ 4 CPU, ≥ 8 GB RAM**, ổ trống ≥ 20 GB (image khoảng 2 GB, video giữ 7 ngày).
- Mỗi lần render một video; tham khảo: 30 giây video 9:16 mất khoảng 2 phút.
- IP công khai, mở cổng 80 và 443.

## 2. Cài Docker (Ubuntu/Debian)

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # đăng xuất rồi đăng nhập lại
docker compose version
```

Tường lửa: chỉ mở **22, 80, 443** (cổng 80 để Caddy xin chứng chỉ).

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw enable
```

Lưu ý: Docker tự mở cổng đã công bố qua iptables, bỏ qua ufw. Compose này chỉ công bố 80 và 443 của Caddy; `api` chỉ `expose` trong mạng nội bộ.

## 3. Triển khai

```bash
git clone <repo> maihub && cd maihub/services/maihub-render

# Thư mục dùng chung và dữ liệu. api và worker đều chạy bằng user node (uid 1000)
mkdir -p data shared/current shared/out
sudo chown -R 1000:1000 data shared
chmod 750 data shared

cp .env.example .env
```

Sửa `.env`:

- `RENDER_DOMAIN`: mặc định `render-<ip-gạch-ngang>.sslip.io`, ví dụ IP `203.0.113.10` thành `render-203-0-113-10.sslip.io` (không cần mua tên miền, sslip.io trỏ về đúng IP đó). Muốn dùng tên miền riêng thì tạo bản ghi A trỏ về IP máy chủ rồi điền vào đây.
- `RENDER_API_KEYS`: xem mục sau.

### Tạo khoá API

Chạy ở máy có Node 22 (không cần trên VPS):

```bash
cd services/maihub-render && npm ci
npm run keygen -- maihub-1
```

Lệnh in ra **khoá gốc** (đưa cho MaiHub, chỉ hiện một lần) và cặp `"tên":"sha256"`. Chỉ băm được lưu trên máy chủ:

```
RENDER_API_KEYS='{"maihub-1":"<sha256 hex>"}'
```

Mỗi khoá chỉ thấy việc của chính nó. Không commit `.env`.

### Khởi chạy

```bash
docker compose up -d --build
docker compose ps
```

Lần build đầu mất vài phút (tải Chrome và phông chữ). Caddy xin chứng chỉ ở lần truy cập đầu, có thể chờ vài chục giây.

### Kiểm tra

```bash
RENDER_URL=https://render-203-0-113-10.sslip.io RENDER_KEY=<khoá gốc> scripts/smoke.sh
```

Script gọi API thật: health, một video từ mẫu, rồi một HTML "xấu" (gọi mạng, đọc `file://`, leo thư mục). Việc HTML xấu phải render xong, và khung hình `evil.png` phải ghi `BLOCKED` cho cả ba dòng.

## 4. Vận hành

**Xem log**

```bash
docker compose logs -f api worker
docker compose logs --tail 200 caddy
```

Log không ghi khoá API hay nội dung HTML.

**Cập nhật**

```bash
git pull
docker compose up -d --build
```

Việc đang render lúc khởi động lại sẽ thành `failed`; MaiHub thấy và có thể gửi lại.

**Ghim phiên bản.** Image dựng từ `node:22-bookworm-slim`, `caddy:2`, `hyperframes@0.8.181` và GSAP 3.14.2 (đóng trong từng mẫu). Muốn đổi phiên bản HyperFrames: sửa `Dockerfile.worker` và biến `HYPERFRAMES_VERSION` hiển thị ở `/v1/health` (mặc định 0.8.181), thử kỹ rồi mới build lại. Muốn ghim chặt hơn thì thay `caddy:2` bằng thẻ cụ thể (ví dụ `caddy:2.10`).

**Sao lưu.** Chỉ cần `data/` (kho việc), và `.env` (cất riêng, an toàn). `shared/` là thư mục tạm, không cần sao lưu. Chứng chỉ nằm trong volume `caddy_data`, mất cũng được cấp lại.

```bash
tar czf render-data-$(date +%F).tgz data
```

Việc và tệp đầu ra tự xoá sau 7 ngày. Tệp đầu vào (ảnh, nhạc tải lên) bị xoá ngay khi việc kết thúc (xong, lỗi hoặc huỷ), chỉ `video.mp4` và `thumb.jpg` được giữ. Khi ổ `data/` còn trống dưới 2 GB, `POST /v1/jobs` trả 507 (`LIMIT_REACHED`, "Máy chủ render sắp hết dung lượng") cho tới khi dọn bớt.

**Xoay khoá**

1. `npm run keygen -- maihub-2` rồi thêm cặp mới vào `RENDER_API_KEYS` (giữ khoá cũ để chuyển dần).
2. `docker compose up -d` (đọc lại `.env`).
3. Đổi khoá trong MaiHub, kiểm tra chạy được.
4. Xoá cặp cũ khỏi `RENDER_API_KEYS`, `docker compose up -d` lần nữa.

Nghi lộ khoá: xoá cặp đó ngay rồi khởi động lại.

## 5. An toàn

**HTML tự viết.** Thư mục render của việc HTML được cấp sẵn `gsap.min.js` (bản đã ghim của mẫu đầu tiên có tệp này), vì `worker` không có mạng. Trước khi render, `worker` chạy `hyperframes lint <dir> --json` (`lintHtml` ở `src/renderRunner.ts`): có lỗi mức `error` thì việc thất bại ngay với "HTML chưa đúng quy ước HyperFrames: <mã> (<thông báo>); …" (tối đa 3 lỗi), để bot sửa thay vì nhận video đứng yên; lint không chạy được hoặc đầu ra hỏng thì vẫn render. Mẫu có sẵn không qua lint (còn các ô `{{…}}` chưa điền). Trước lint, `localizeRemoteScripts` (`src/buildWorkdir.ts`) đổi `<script src>` trỏ tới GSAP lõi trên CDN (`…/gsap.min.js`, `…/gsap.js`) sang `gsap.min.js` có sẵn; script nào khác gọi từ mạng (`http(s)://`, `//`) thì việc thất bại ngay với "HTML gọi script từ mạng nhưng máy render không có mạng: …", vì nếu cứ render thì HyperFrames chụp xong mọi khung rồi mới chặn do timeline lỗi. Lượt render bị chặn vì "correctness warning" báo kèm các dòng `- <mã>: …` chi tiết.

**Cách ly.** HTML do bot viết là mã không tin cậy, chạy trong `worker`:

- `network_mode: none`: không có mạng (không gọi ra ngoài, không tới metadata cloud, không tới `api`);
- `read_only: true`, tmpfs `/tmp` (2 GB), `cap_drop: ALL`, `no-new-privileges`, user `node` không phải root;
- `HF_CAPTURE_PARALLEL_STREAM=true`: với 3 GB RAM, HyperFrames chụp từng khung hình; không có cờ này thì 2 worker lưu mọi khung ra `/tmp` (1080p 40 giây cần khoảng 2 GB, vượt tmpfs, render dừng ngay với lỗi "Disk capture may need …"). Bật thì khung được ghép thẳng vào video;
- chỉ gắn `shared/current` (chỉ đọc, chỉ có việc hiện tại) và `shared/out` (ghi kết quả). **Không** có `data/`, `.env`, khoá API hay việc của khoá khác;
- `api` không gắn Docker socket, và `worker` không nói chuyện với `api` qua mạng: hai bên trao đổi bằng tệp trong `shared/`;
- `api` coi `shared/out` là dữ liệu không tin cậy: chỉ đọc đúng tên `<jobId>.mp4|jpg|progress.json|result.json`, không theo liên kết tượng trưng (`O_NOFOLLOW`), chỉ nhận tệp thường trong giới hạn kích thước, sai thì việc `failed`;
- worker chạy lâu dài giữa các việc nên một worker bị chiếm quyền vẫn thấy các việc về sau (rủi ro còn lại đã biết; khởi động lại `worker` định kỳ nếu cần);
- Chrome chạy trong container worker; trang chỉ nạp được tệp trong thư mục việc đó (máy chủ nội bộ của HyperFrames gốc tại thư mục việc).

**Giới hạn** (vượt thì 400 kèm lỗi tiếng Việt):

| Giới hạn | Giá trị |
|---|---|
| Thời lượng video | ≤ 120 giây |
| Khổ | 1080×1920, 1080×1080, 1920×1080 |
| fps | 24 hoặc 30 |
| Số ảnh mỗi việc | ≤ 20 |
| Mỗi ảnh / video nguồn | ≤ 20 MB |
| Nhạc | ≤ 15 MB |
| Tổng mỗi việc | ≤ 200 MB |
| HTML tự viết | ≤ 512 KB |
| Thời gian render | ≤ 15 phút (quá thì `failed: timeout`) |
| Hàng đợi | ≤ 20 việc chung, ≤ 5 việc chờ mỗi khoá |
| Tạo việc | ≤ 30 lần mỗi giờ mỗi khoá |
| Lưu trữ | đầu ra 7 ngày; đầu vào xoá ngay khi việc kết thúc |
| Dung lượng ổ | còn trống < 2 GB thì từ chối việc mới (507) |

Loại tệp kiểm theo chữ ký nội dung (JPEG, PNG, WebP, MP3, M4A, WAV, MP4), không tin đuôi tệp; `api` đặt lại tên tệp. Worker bị giới hạn 4 CPU, 3 GB RAM, 512 tiến trình. Khoá so sánh bằng `crypto.timingSafeEqual`; việc của khoá khác trả 404.

Nên làm thêm: bật cập nhật bảo mật tự động của hệ điều hành, đăng nhập SSH bằng khoá.

## 6. Mẫu video và dấu thay thế

Mẫu nằm trong `templates/<id>/` (đóng sẵn vào image `worker`, chỉ đọc): `index.html`, `template.json`, `gsap.min.js` (bản chép của `vendor/gsap.min.js`, GSAP 3.14.2). `buildWorkdir` chỉ chép đúng thư mục mẫu vào thư mục việc, nên mẫu phải tự chứa, không gọi mạng.

**Hợp đồng dấu trong `index.html`** (HyperFrames đọc khổ và thời lượng từ HTML tĩnh, không chạy script; chỉ số do hệ thống tính được điền, không bao giờ là chữ của người dùng):

| Dấu | Giá trị |
|---|---|
| `{{width}}`, `{{height}}` | khổ theo `aspect` (9:16 = 1080×1920, 1:1 = 1080×1080, 16:9 = 1920×1080) |
| `{{durationSec}}` | thời lượng sau khi kẹp vào khoảng của mẫu |
| `{{audio}}` | thẻ `<audio id="bgm" src="assets/music.m4a" ...>` nếu có nhạc, rỗng nếu không (thẻ audio trỏ tệp thiếu làm render hỏng nên phải dùng dấu này) |

Biến người dùng (`variables`) và danh sách ảnh (`images`) được ghi vào `variables.json` cạnh `index.html` cùng `width`, `height`, `durationSec`; mẫu đọc qua `data-composition-variables` của HyperFrames. Ảnh nằm ở `assets/`.

**Thời lượng.** `durationSec` trong `template.json` là `{ min, max, default }`. Nếu mẫu có `secondsPerImage` (ví dụ `product-slideshow` = 6) thì thời lượng = số ảnh × giây mỗi ảnh, kẹp vào `[min, max]`. Ngược lại dùng biến số `durationSec` (nếu có) hoặc `default`; luôn kẹp, nên giá trị 9999 không làm render vô hạn.

**Thêm mẫu mới**

1. Tạo `templates/<id>/` với `index.html`, `template.json`, và chép `vendor/gsap.min.js` vào (`cp vendor/gsap.min.js templates/<id>/`). Có test kiểm bản chép khớp.
2. `template.json`: `id`, `name`, `description`, `aspects`, `durationSec`, `imageSlots {min,max}`, `variables` (kiểu `string` có `maxLength` và tuỳ chọn `required: false` để cho phép bỏ trống — mặc định bắt buộc không trống, mẫu phải tự ẩn phần tử khi rỗng; `color` dạng `#rrggbb`; `number`), tuỳ chọn `secondsPerImage`.
3. Trong `index.html` dùng các dấu ở trên; không dùng `http(s)://`; phông "Noto Sans" rồi phông hệ thống; chừa vùng an toàn trên/dưới cho khổ 9:16.
4. `npm test`, rồi render thử và xem khung hình ở cả ba khổ trước khi build image.

## 7. Nhạc

Nhạc đóng sẵn trong `music/` (kèm `manifest.json` có giấy phép, tác giả, nguồn). Năm bản lấy từ FreePD.com (bản lưu Wayback Machine ngày 2025-01-06, trang ghi miền công cộng, dùng thương mại được): Advertime, Happy Whistling Ukulele, Inspiration (Rafael Krux); City Sunshine, Fresh Focus (Kevin MacLeod). Đã mã hoá lại 128 kbps. Thêm nhạc: chỉ dùng nhạc CC0/miền công cộng, đặt tệp `<id>.mp3` vào `music/` và thêm một mục vào `manifest.json` (cả `api` lẫn `worker` đóng nguyên thư mục `music/` vào image — `api` để phục vụ nghe thử, `worker` để trộn nhạc — nên cần build lại cả hai).

Nghe thử: `GET /v1/music/<id>` (cần khoá API) phát tệp MP3 của bản nhạc có trong `manifest.json` (hỗ trợ Range); mã lạ trả 404.

| Endpoint | Ghi chú |
|---|---|
| `GET /v1/health` | không cần khoá |
| `GET /v1/templates` | mẫu và danh sách nhạc |
| `GET /v1/music/:id` | phát nhạc có sẵn (audio/mpeg) |
| `POST /v1/jobs`, `GET /v1/jobs/:id[/video\|/thumb]`, `DELETE /v1/jobs/:id` | việc render |

## 8. Phát triển cục bộ

```bash
npm ci
npm test            # Jest riêng của service
npm run typecheck
```

Mã nguồn này không đi vào app MaiHub (loại khỏi tsconfig và electron-builder gốc).
