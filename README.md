<div align="center">

<img src="resources/icons/icon_128.png" alt="MaiHub" width="96" />

# MaiHub

**Ứng dụng desktop cá nhân của Maiychrus**
Vận hành tài khoản Zalo / Facebook / Telegram, CRM, workflow tự động và trợ lý AI trong một ứng dụng.

</div>

> Trước đây có tên **AHV Connect**. Từ bản 26.9.0 đổi tên thành MaiHub; xem mục
> [Nâng cấp từ AHV Connect](#nâng-cấp-từ-ahv-connect). Đọc [NOTICE.md](./NOTICE.md) về nguồn gốc.

---

## Nhận diện

Logo là bông hoa mai năm cánh: "Mai" trong tên, năm cánh tỏa từ một tâm là
"hub" — một nơi, nhiều kênh. Nguồn gốc là `resources/icons/icon.svg`; mọi file PNG/ICO/ICNS
đều dựng ra từ đó bằng `npm run build:icons`. Lý do thiết kế và các ràng buộc
tỉ lệ: [DESIGN.md](./DESIGN.md).

## Nguồn gốc

MaiHub là bản phái sinh của dự án mã nguồn mở
[Deplao](https://github.com/babyvibe/deplao-builder) (tác giả: babyvibe), giấy
phép **MIT**. Bản quyền của tác giả gốc được giữ nguyên trong tệp
[LICENSE](./LICENSE). Danh sách đầy đủ những thay đổi so với bản gốc nằm ở
[NOTICE.md](./NOTICE.md).

## Đăng Facebook: nhiều ảnh và lên lịch

- Một bài có 1–10 ảnh (`jpg`, `jpeg`, `png`, `gif`, `webp`; mỗi ảnh tối đa 20 MB, tổng tối đa 100 MB) hoặc đúng 1 video; không trộn ảnh với video. Ảnh lên bài theo thứ tự đã sắp.
- Lên lịch một lần hoặc lặp lại theo thứ trong tuần và giờ cố định (giờ của máy, tối đa một lượt mỗi ngày mỗi lịch); tối đa 200 lịch mỗi workspace. Ảnh của lịch được chép vào `<thư mục DB của workspace>/facebook-poster-media/<scheduleId>/` và xoá cùng lịch.
- Lịch chỉ chạy khi app đang mở và máy thức. Quá giờ hẹn hơn 60 giây mà app chưa chạy thì lượt đó bị bỏ, ghi "Đã lỡ" vào Lịch sử và báo khi mở app; không đăng bù. Đang có việc khác thì lượt xếp hàng chờ tối đa 2 giờ.
- Sửa lịch chỉ đổi được tên và thời gian; muốn đổi nội dung hoặc ảnh thì xoá và lên lịch lại. Không xoá được lịch khi lượt của lịch đó đang chạy. Chế độ nhân viên chưa hỗ trợ.

## Giới hạn đang áp dụng

| Hạng mục | Trạng thái |
|---|---|
| Gửi dữ liệu telemetry ra ngoài | **Đã tắt** (`TrackingService`) |
| Máy chủ thượng nguồn: premium, quét nhóm, thanh toán, affiliate | **Đã chặn** (`backendService`) |
| Tự động kiểm tra & tải bản cập nhật | **Bật từ 26.11.0** — xem mục [Tự cập nhật](#tự-cập-nhật) |
| Trang donate / giới thiệu hoa hồng / link kho mã nguồn của tác giả | **Đã gỡ** |
| Trần gửi theo ngày, giờ im lặng, cơ chế từ chối nhận | **Chưa có** |

Vì chưa có hàng rào gửi tin ở dòng cuối, bản này **chỉ dùng để trải nghiệm và
đánh giá**, chưa dùng gửi tin hàng loạt cho khách thật.

## Rủi ro cần biết trước khi dùng

- Ứng dụng thao tác trên **tài khoản Zalo cá nhân** qua thư viện `zca-js`. Việc
  này **vi phạm chính sách của Zalo** và có thể dẫn tới khóa tài khoản. Dùng tài
  khoản riêng cho công việc.
- Bản dựng **chưa ký số**; Windows/macOS sẽ cảnh báo khi cài. Chỉ cài bản tải
  từ GitHub Releases của dự án.
- **Không bật tunnel Cloudflare** của webhook gateway: nó mở một địa chỉ công
  khai trỏ thẳng vào máy đang giữ phiên Zalo.

## Chạy ở môi trường phát triển

```bash
npm install          # cài phụ thuộc (chạy kèm scripts/patch-electron-icon.js trên Windows)
npm run dev          # Vite dev server + Electron
```

## Đóng gói

### Qua GitHub Actions (khuyến nghị)

Workflow [`.github/workflows/build.yml`](./.github/workflows/build.yml) build đủ
bốn bản trên runner của chính từng hệ điều hành: Linux x64 (AppImage, deb),
Windows x64 (bộ cài NSIS), macOS Apple Silicon và macOS Intel (dmg, zip).
Trước khi đóng gói, workflow chạy type-check và unit test.

- Chạy tay: tab **Actions** → **Build** → **Run workflow**, chọn nhánh.
- Hoặc đẩy một tag bắt đầu bằng `v`, ví dụ `git tag v26.9.0 && git push origin v26.9.0`.
- Tải bản cài ở mục **Artifacts** của lần chạy (giữ 14 ngày).

**Phát hành (Release):** sau khi build xong cả bốn bản, job "Phát hành" tạo một
GitHub Release kèm toàn bộ bản cài, khi:

- Run workflow có tick **Tạo Release**: tag là `v` + `version` trong
  [package.json](./package.json) (tăng `version` trước khi phát hành bản mới); hoặc
- đẩy tag `v*`: tag đó là tên Release.

Repo công khai, nên ai cũng tải được bản cài và app tự cập nhật được mà không cần token.

### Tự cập nhật

Từ 26.11.0, app hỏi GitHub Releases 15 giây sau khi mở rồi mỗi 6 giờ. Có bản mới thì hiện
thẻ thông báo ở góc trên bên phải (và chấm báo cạnh tên MaiHub ở Sidebar):

| Nền tảng | Cách cập nhật |
|---|---|
| Windows (bộ cài `.exe`) | Bấm **Cập nhật** → tải trong app → **Khởi động lại để cập nhật** |
| Linux AppImage | Như Windows |
| Linux `.deb`, macOS (chưa ký số) | Bấm **Tải bản mới** → mở trang Release, tải và cài tay |

- Đang có việc Đăng Facebook chạy thì app không cho khởi động lại để cài.
- Muốn bản mới đến được người dùng: tăng `version` trong `package.json`, gắn thẻ `v<version>`
  và đẩy thẻ. Release phải ở trạng thái đã công bố (không phải nháp, không phải pre-release).
- Bản 26.10.0 trở về trước chưa bật tự cập nhật: cài tay 26.11.0 một lần.
- Thiết kế: [docs/specs/2026-10-03-auto-update.md](./docs/specs/2026-10-03-auto-update.md).

Bản macOS chưa ký bằng chứng chỉ Apple (chỉ ký ad-hoc). Lần mở đầu, macOS sẽ
chặn: chuột phải vào app → **Open**, hoặc chạy
`xattr -cr "/Applications/MaiHub.app"`.

### Trên máy

```bash
npm run production   # build cầu nối Go E2EE, main, renderer, native module rồi đóng gói cho hệ điều hành đang chạy
```

Cần Go ≥ 1.26 cho cầu nối E2EE. Bản cài ra ở `dist-electron-build/`. Không build
chéo hệ điều hành: các thành phần native (better-sqlite3, ffmpeg, ngrok,
cloudflared, cầu nối E2EE) phải đúng nền tảng.

Cấu hình đóng gói (appId `com.maihub.app`, productName `MaiHub`, protocol
`maihub://`) nằm ở khối `build` trong [package.json](./package.json).

## Dữ liệu

Dữ liệu nằm hoàn toàn trên máy người dùng (SQLite trong thư mục `userData` của
ứng dụng). **Không có bản sao lưu tự động** — tự sao lưu định kỳ trước khi nâng
cấp phiên bản.

Thư mục dữ liệu là `%AppData%\MaiHub` (Windows), `~/.config/MaiHub` (Linux),
`~/Library/Application Support/MaiHub` (macOS). Tên tệp bên trong vẫn là
`deplao-tool.db` / `deplao-config.json` của dự án gốc: xem [NOTICE.md](./NOTICE.md).

## Nâng cấp từ AHV Connect

MaiHub có tên gói và appId khác, nên **cài song song** với AHV Connect chứ không
thay thế. Các bước:

1. Thoát AHV Connect hoàn toàn (kể cả biểu tượng ở khay hệ thống).
2. Cài và mở MaiHub. Lần đầu mở, MaiHub tự chuyển thư mục dữ liệu `AHV Connect`
   thành `MaiHub` (tin nhắn, CRM, workflow, proxy, profile trình duyệt đi theo).
   Nếu AHV Connect còn chạy, MaiHub báo và thoát; thoát AHV Connect rồi mở lại.
3. Kiểm tra dữ liệu đã có trong MaiHub, rồi gỡ AHV Connect.

**Linux và macOS:** khóa mã hóa trong kho khóa hệ điều hành gắn với tên ứng
dụng, nên sau khi chuyển phải **đăng nhập lại** các tài khoản Zalo/Facebook/
Telegram và nhập lại khóa API, mật khẩu tích hợp một lần. Windows không bị
ảnh hưởng.

## Hỗ trợ

Báo lỗi tại mục Issues của kho GitHub, kèm ảnh chụp màn hình và log (trong ứng
dụng: **Cài đặt → Nhật ký**).
