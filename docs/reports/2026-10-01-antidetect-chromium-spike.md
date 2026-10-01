# Báo cáo spike: chọn nhân Chromium antidetect cho Browser Profiles

| Thuộc tính | Giá trị |
|---|---|
| Ngày thực hiện | 01/10/2026 |
| Câu hỏi | Dự án Chromium đã patch nào dùng được làm nhân trình duyệt cho module Browser Profiles (`docs/intent/2026-10-01-browser-profiles.md`, open question 1)? |
| Điều kiện phải đạt | (1) có bản phát hành cho Windows và Linux; (2) vá fingerprint ở mức engine, không phải inject JS; (3) giấy phép cho phép đóng gói lại và bán ra ngoài |
| Kết luận | **`adryfish/fingerprint-chromium`** là ứng viên duy nhất đạt cả ba. Dùng được cho MVP, kèm 7 việc AHV Connect phải tự xử lý (mục 4) |
| Phạm vi đã đo | Bản Linux x86_64 (màn hình ảo Xvfb, GPU phần mềm) và bản Windows x64 (máy ảo Windows 10 Pro, không có GPU) |
| Chưa đo | WebGL trên Windows có GPU thật; rò IP qua proxy thật; CreepJS/pixelscan/browserleaks/iphey trên Windows; nuôi tài khoản Facebook/TikTok/Zalo thật |

Mã thử nghiệm là đồ bỏ đi, nằm ngoài repo; không có thay đổi nào trong mã nguồn AHV Connect.

## 1. Sàng lọc ứng viên

| Ứng viên | Windows + Linux | Vá ở engine | Giấy phép / phân phối lại | Kết quả |
|---|:---:|:---:|---|---|
| [adryfish/fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) | Có (và macOS) | Có | BSD-3-Clause; binary phát hành tự do; patch nguồn công bố trễ khoảng một phiên bản | **Đạt** |
| [clearcotelabs/clearcote-browser](https://github.com/clearcotelabs/clearcote-browser) | Có | Có | BSD-3-Clause, build được từ nguồn; nhưng bản mở **giới hạn 1 instance chạy đồng thời**, bản mới nhất nằm ở gói trả phí | Loại: không đáp ứng 30 profile đồng thời |
| [CloakHQ/CloakBrowser](https://github.com/CloakHQ/cloakbrowser) | Có | Có | Binary đóng nguồn, cấm phân phối lại; bản mới yêu cầu thuê bao Pro | Loại: giấy phép |
| Wayfern (nhân của [Donut Browser](https://github.com/zhom/donutbrowser)) | Có | Có | Độc quyền (chỉ vỏ Donut Browser là AGPL-3.0) | Loại: giấy phép |
| [lang315/camoucrome](https://github.com/lang315/camoucrome) | Chưa có bản phát hành | Có | — | Loại: chưa có binary |
| fury-antidetect-browser | Chưa rõ | Có (tự mô tả) | Cùng tên repo xuất hiện dưới hai tài khoản GitHub khác nhau | Loại: nguồn gốc không rõ ràng, không nên chạy binary |

## 2. Thông tin về `fingerprint-chromium`

- Nền ungoogled-chromium; 3.097 sao; tạo từ 12/2024; còn hoạt động (push gần nhất 28/09/2026).
- Bản mới nhất: **148.0.7778.215, phát hành 21/06/2026**. Các bản trước: 144 (02/2026), 142 (12/2025), 139 (09/2025). Nhịp phát hành 2–4 tháng một bản.
- Gói phát hành: Windows (installer, zip 189 MB), Linux (AppImage, tar.xz 141 MB), macOS (dmg).
- Cấu hình hoàn toàn bằng tham số dòng lệnh: `--fingerprint=<seed>`, `--fingerprint-platform`, `--fingerprint-brand`, `--fingerprint-hardware-concurrency`, `--timezone`, `--lang`, `--accept-lang`, `--proxy-server`. Phù hợp để Electron main process khởi chạy như tiến trình con.
- Tác giả tuyên bố không hỗ trợ kỹ thuật.

## 3. Kết quả đo trên Linux

Bản đo: `ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz`, SHA-256 khớp với giá trị GitHub công bố (`70d23983…17f4`).

### 3.1 Fingerprint theo seed

| Seed | Canvas | WebGL ảnh | Audio | GPU báo cáo | Cores / RAM |
|---|---|---|---|---|---|
| không có cờ | 27bf5eea | d7cddf5a | cc9fa7b6 | SwiftShader (thật) | 16 / 16 |
| 1 | 5fe999b2 | ea63b3fa | b4ffccb0 | Intel Iris Xe (46A6) | 10 / 16 |
| 1 (mở lại) | 5fe999b2 | ea63b3fa | b4ffccb0 | Intel Iris Xe (46A6) | 10 / 16 |
| 2 | 5624fb5e | 0397bbfc | c3dec176 | NVIDIA RTX 3060 Laptop | 12 / 32 |
| 3 | 441060ac | 88e8d919 | 46b5b4b3 | Intel Iris Xe (A7A0) | 14 / 8 |
| 4 | 8a995331 | a0338c1c | c3dec176 | Intel Iris Xe (A7A0) | 16 / 16 |
| 5 | fbc5bd82 | 610ca3cf | b23dbec0 | AMD Radeon Graphics | 18 / 32 |
| 6 | ee938610 | 1596bc77 | cc9fa7b6 | Intel UHD Graphics | 20 / 8 |

- **Ổn định:** cùng seed, hai lần mở với hai thư mục dữ liệu khác nhau cho kết quả giống hệt.
- **Khác biệt:** canvas, ảnh WebGL, GPU, số nhân CPU, RAM và số phiên bản phụ của trình duyệt thay đổi theo seed.
- **Audio** chỉ có 5 giá trị khác nhau trên 9 seed. Không dùng audio để phân biệt profile được, nhưng đây cũng là hành vi của máy thật (nhiều máy trùng audio hash).
- `navigator.webdriver` là `false` ở mọi lần chạy.

### 3.2 Persona Windows chạy trên máy Linux

Với `--fingerprint-platform=windows --fingerprint-brand=Chrome --timezone=Asia/Ho_Chi_Minh --lang=vi-VN`:

- User-agent, `navigator.platform` (Win32), client hints (Google Chrome 148, Windows), GPU dạng Direct3D11 và múi giờ đều nhất quán với nhau.
- CreepJS: **0% headless, 0% stealth**, không gắn cờ nói dối; "44% like headless" (do môi trường Xvfb không có GPU thật). WebRTC: kết nối host và STUN đều bị chặn, không lộ IP nội bộ.
- CreepJS thấy danh sách font Windows (Segoe, Nirmala UI, Bahnschrift…).

### 3.3 Bộ nhớ

10 profile mở đồng thời, mỗi profile một tab trang đăng nhập facebook.com: tổng 2.896 MB, **trung bình 290 MB mỗi profile**, 12 tiến trình mỗi profile. Ngoại suy 30 profile: khoảng 8,5 GB. Đây là mức sàn: trang đăng nhập nhẹ hơn nhiều so với bảng tin đã đăng nhập, và phép đo dùng GPU phần mềm.

### 3.4 Kết quả đo trên Windows

Máy đo: máy ảo Windows 10 Pro 10.0.19045, 4 nhân, 8 GB RAM, Microsoft Basic Display Adapter (không có GPU). Bản đo: `ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip`, SHA-256 khớp (`9ef3f471…2579`). Người vận hành tự chạy script trong máy ảo. Hash ở bảng này dùng thuật toán khác mục 3.1 nên không so sánh chéo được.

| Lần chạy | Canvas | Audio | Cores / RAM | Nền tảng báo cáo | Brand |
|---|---|---|---|---|---|
| không có cờ | 5535cbcf | 010a0fb7 | 4 / 8 (thật) | Win32, Windows 10.0.0 | Chromium |
| seed 1 | ffaeeef9 | …b5750b8 | 10 / 16 | Win32, Windows 19.0.0 | Google Chrome |
| seed 1 (mở lại) | ffaeeef9 | …b5750b8 | 10 / 16 | Win32, Windows 19.0.0 | Google Chrome |
| seed 2 | b5f03ae3 | 5e485264 | 12 / 32 | Win32, Windows 19.0.0 | Google Chrome |
| seed 3 | 5a917b15 | 8f657a56 | 14 / 8 | Win32, Windows 19.0.0 | Google Chrome |
| seed 4, ép 8 nhân, vi-VN | 446aa3fa | 5e485264 | 8 / 16 | Win32, Windows 19.0.0 | Google Chrome |
| seed 5, chỉ truyền seed | 2e78d02d | 7d2c70aa | 18 / 32 | Win32, Windows 10.0.0 | Chromium |
| seed 6, persona Linux | 7b1d6729 | 010a0fb7 | 20 / 8 | Linux x86_64, Linux 6.8.0 | Google Chrome |

- **Ổn định và khác biệt theo seed:** giống kết quả Linux. Seed 1 mở hai lần cho kết quả giống hệt; canvas khác nhau ở mọi seed.
- **Audio vẫn trùng:** seed 2 trùng seed 4; seed 6 trùng giá trị thật của máy.
- **Ngôn ngữ hoạt động đúng trên Windows:** với `--lang=vi-VN`, cả `navigator.languages` và `Intl` đều là tiếng Việt (trên Linux `Intl` ở trang chính vẫn là en-US).
- **Font máy thật lọt theo cả hai chiều:** persona Linux trên máy Windows vẫn lộ Calibri và Segoe UI. Persona Windows trên máy Windows thì nhất quán.
- **WebGL không đo được:** máy ảo không có GPU nên trình duyệt không tạo được ngữ cảnh WebGL ở mọi lần chạy. Phần giả lập GPU trên Windows vẫn chưa có bằng chứng.
- **Độ phân giải màn hình không được giả lập:** báo đúng 1866x989 của phiên remote.
- **Bộ nhớ:** 5 profile cùng mở facebook.com dùng 917 MB bộ nhớ riêng, trung bình 183 MB mỗi profile (35 tiến trình). Chỉ số này là private bytes, khác cách đo PSS ở mục 3.3, và máy không có GPU; vẫn chỉ nên coi là mức sàn.

## 4. Việc AHV Connect phải tự xử lý

1. **Luôn truyền `--fingerprint-platform`.** Nếu chỉ truyền seed trên máy Linux, trình duyệt báo nền tảng Linux nhưng GPU lại là Direct3D11 (chỉ có trên Windows) — mâu thuẫn dễ bị phát hiện.
2. **Luôn truyền `--fingerprint-brand=Chrome`.** Mặc định client hints báo "Chromium", không phải "Google Chrome".
3. **Tự chọn số nhân CPU.** Giá trị sinh theo seed có lúc không thực tế (28, 30 nhân đi kèm 8 GB RAM). Cờ `--fingerprint-hardware-concurrency` hoạt động đúng (đã thử với 8).
4. **Proxy có mật khẩu.** `--proxy-server` không nhận username/password, trong khi `ProxyConfig` của AHV Connect có hai trường này. Cần một proxy chuyển tiếp cục bộ cho từng profile hoặc xử lý xác thực qua giao thức điều khiển trình duyệt.
5. **Font của máy thật lọt ra khi persona khác hệ điều hành.** Persona Windows trên máy Linux có lần lộ font "Ubuntu"; persona Linux trên máy Windows lộ Calibri và Segoe UI. Persona trùng hệ điều hành máy thật thì nhất quán (đã xác nhận trên Windows). MVP nên chỉ cho phép persona trùng hệ điều hành máy thật.
6. **Độ phân giải màn hình không được giả lập** trên cả Linux và Windows (báo đúng màn hình thật).
7. **Trên Linux, `Intl` ở trang chính vẫn là en-US** khi đã đặt `--lang=vi-VN` (trong worker thì đúng vi-VN). Trên Windows không có lỗi này.

## 5. Rủi ro còn lại

- **Phiên bản chậm so với Chrome chính thức.** Bản mới nhất là 148 từ tháng 6/2026; đến tháng 10/2026 đã chậm hơn ba tháng. Phiên bản cũ vừa là dấu hiệu nhận diện, vừa thiếu bản vá bảo mật cho một trình duyệt đang giữ phiên đăng nhập thật.
- **Phụ thuộc một tác giả, không có hỗ trợ.** Patch nguồn công bố trễ, nên bản binary mới nhất không tự kiểm chứng hay tự build lại ngay được.
- **RAM:** máy 16 GB không đủ cho 30 profile đồng thời khi dùng thật; cần đo lại với tài khoản đã đăng nhập để chốt cấu hình tối thiểu.
- **Chưa có bằng chứng về tỉ lệ khóa tài khoản.** Qua CreepJS không đồng nghĩa với qua được hệ thống chống gian lận của Facebook/TikTok/Zalo.

## 6. Khuyến nghị

1. Chọn `fingerprint-chromium` làm nhân cho MVP, ghim phiên bản và kiểm tra SHA-256 khi tải.
2. Thiết kế lớp khởi chạy sao cho đổi được nhân khác (chỉ là đường dẫn binary và bộ tham số), vì rủi ro phụ thuộc một tác giả.
3. Còn thiếu trên Windows: đo WebGL trên một máy có GPU thật (máy văn phòng của đội), mở CreepJS/pixelscan/browserleaks/iphey, và kiểm tra rò IP qua một proxy thật. Các việc này không chặn việc viết spec, nhưng phải xong trước khi nghiệm thu MVP.
4. Nghiệm thu "không bị khóa" phải do đội AHV chạy với tài khoản thật, song song với tool đang thuê.
