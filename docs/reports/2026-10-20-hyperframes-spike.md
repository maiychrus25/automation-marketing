# Spike: HyperFrames cho sản xuất video bán hàng

Ngày: 20/10/2026. Người làm: Claude (em). Code spike để ở `~/.cache/hf-spike`; đây là code thử, **không** đưa vào sản phẩm.

## Câu hỏi

1. HyperFrames có render được video bán hàng 9:16 từ ảnh + chữ tiếng Việt, với dữ liệu điền theo biến không?
2. Render trong Docker **cắt mạng hoàn toàn** có chạy không, mất bao lâu, tốn bao nhiêu tài nguyên?
3. HTML do bot tự viết có thoát được khu cách ly không: gọi mạng, đọc tệp, leo thư mục?

## Môi trường

- Máy dev: 4 CPU, 16 GB RAM, Docker 29.7, FFmpeg 8.0.
- HyperFrames **0.8.181**, ghim phiên bản; gói npm được cập nhật gần như hằng ngày.
- Chrome dùng để render: `chrome-headless-shell` 152, tự tải về, khoảng 262 MB.

## Kết quả

### 1. Mẫu + biến

- HyperFrames hỗ trợ biến sẵn:
  - khai báo `data-composition-variables` (kiểu và giá trị mặc định) trên phần tử gốc;
  - truyền `--variables '<json>'`, `--variables-file` hoặc `--batch` (nhiều dòng → nhiều video);
  - đọc trong trang bằng `window.__hyperframes.getVariables()`.
- Video thử 30 giây, 1080×1920, 30 fps, 5 ảnh, tên / giá / lời kêu gọi điền từ biến: chữ tiếng Việt có dấu hiển thị đúng; tệp ra H.264, khoảng 5,6 MB.
- Mẫu mặc định nạp GSAP từ CDN, nên phải **đóng gói GSAP cục bộ** để chạy được khi cắt mạng.

### 2. Thời gian và tài nguyên

| Cách chạy | 30 giây video 9:16 |
|---|---|
| Trên máy, có Chrome sẵn | khoảng **70 giây**, CPU khoảng 2 nhân, tiến trình chính khoảng 580 MB RAM (mỗi worker Chrome khoảng 256 MB) |
| Docker `--network none --cpus 4 --memory 3g --read-only` | khoảng **112 giây**, chạy được |

- Image Docker thử (node 22 + FFmpeg + phông Noto + Chrome) nặng khoảng **1,7 GB**.
- Gợi ý cấu hình VPS render: **≥ 4 CPU, 8 GB RAM**, mỗi lần một video. Ước tính khoảng 2 phút cho mỗi video 30 giây; video 60 giây khoảng 4 phút.

### 3. Khu cách ly (HTML "xấu")

Chạy trong Docker cắt mạng, thư mục mẫu chỉ đọc, hệ thống tệp chỉ đọc:

| Thử | Kết quả |
|---|---|
| `fetch('https://example.com')` | bị chặn ("Failed to fetch") |
| `<img src="https://…">` | không tải được, render vẫn xong và cảnh báo `media_load_failed` |
| `fetch('file:///etc/passwd')`, `<iframe src="file:///etc/hostname">` | bị chặn / trống |
| `<iframe src="http://169.254.169.254/…">` (metadata cloud) | trống, vì không có mạng |
| Leo thư mục qua máy chủ nội bộ (`/..%2f..%2fetc%2fpasswd`) | "Not found" |

Trang được HyperFrames phục vụ qua một máy chủ nội bộ `http://localhost:<port>/` gốc tại thư mục mẫu, nên mọi tài nguyên phải nằm trong thư mục của việc đó.

### 4. Lưu ý khác

- **Telemetry:** HyperFrames gửi số liệu ẩn danh về PostHog (`us.i.posthog.com`). Tắt bằng `HYPERFRAMES_NO_TELEMETRY=1` và `DO_NOT_TRACK=1`; trong container cắt mạng cũng không gửi đi được.
- **Chrome:** cài vào thư mục ai cũng đọc được và trỏ `HYPERFRAMES_BROWSER_PATH` tới đó. Ở chế độ chạy, user `node` không đọc được `/root/.cache`.
- **Sau render**, HyperFrames ghi `.hyperframes/` vào thư mục mẫu; với thư mục chỉ đọc thì chỉ ra cảnh báo. Khi làm thật, mỗi việc chép mẫu sang thư mục riêng có quyền ghi.
- **Build Docker trên máy dev** cần `--network host` vì DNS của Docker trên máy này lỗi; đây là vấn đề của máy, không phải của HyperFrames.
- **Giấy phép** Apache-2.0, dùng thương mại được.

## Kết luận

Dùng được. Kiến trúc đề xuất:
- `render-api` có mạng, nhận việc và giữ khoá API;
- `render-worker` cắt mạng, mỗi việc chạy một container `docker run --network none --read-only` chỉ gắn thư mục của việc đó, nên việc này không đọc được tệp của việc khác hay khoá API;
- ghim HyperFrames, GSAP và phông chữ trong image;
- tắt telemetry.

Phần còn phải chốt trong spec: cách `render-api` khởi chạy container cho từng việc mà không trao quyền Docker quá rộng (xem spec §3).
