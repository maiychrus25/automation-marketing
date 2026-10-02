<div align="center">

<img src="resources/icons/icon_128.png" alt="AHV Connect" width="96" />

# AHV Connect

**Ứng dụng desktop nội bộ — Trung tâm Đào tạo Lái xe AHV**
Vận hành tài khoản Zalo / Facebook / Telegram, CRM, workflow tự động và trợ lý AI trong một ứng dụng.

</div>

> ⚠️ **Bản dùng nội bộ.** Không phát hành công khai, không phân phối ra ngoài
> trung tâm. Đọc [NOTICE.md](./NOTICE.md) trước khi cài đặt hoặc phát cho nhân sự.

---

## Nhận diện

Logo được vẽ riêng cho trung tâm: con đường thu xa, hai mép đường chụm thành
chữ "A" của AHV. Nguồn gốc là `resources/icons/icon.svg`; mọi file PNG/ICO/ICNS
đều dựng ra từ đó bằng `npm run build:icons`. Lý do thiết kế và các ràng buộc
tỉ lệ: [DESIGN.md](./DESIGN.md).

## Nguồn gốc

AHV Connect là bản phái sinh nội bộ của dự án mã nguồn mở
[Deplao](https://github.com/babyvibe/deplao-builder) (tác giả: babyvibe), giấy
phép **MIT**. Bản quyền của tác giả gốc được giữ nguyên trong tệp
[LICENSE](./LICENSE). Danh sách đầy đủ những thay đổi của trung tâm so với bản
gốc nằm ở [NOTICE.md](./NOTICE.md).

## Giới hạn đang áp dụng cho bản nội bộ

| Hạng mục | Trạng thái |
|---|---|
| Gửi dữ liệu telemetry ra ngoài | **Đã tắt** (`TrackingService`) |
| Máy chủ thượng nguồn: premium, quét nhóm, thanh toán, affiliate | **Đã chặn** (`backendService`) |
| Tự động kiểm tra & tải bản cập nhật | **Đã tắt** — phát hành theo kênh riêng của trung tâm |
| Trang donate / giới thiệu hoa hồng / link kho mã nguồn của tác giả | **Đã gỡ** |
| Trần gửi theo ngày, giờ im lặng, cơ chế từ chối nhận | **Chưa có** |

Vì chưa có hàng rào gửi tin ở dòng cuối, bản này **chỉ dùng để trải nghiệm và
đánh giá**, chưa dùng gửi tin hàng loạt cho học viên thật.

## Rủi ro cần biết trước khi dùng

- Ứng dụng thao tác trên **tài khoản Zalo cá nhân** qua thư viện `zca-js`. Việc
  này **vi phạm chính sách của Zalo** và có thể dẫn tới khóa tài khoản. Dùng tài
  khoản riêng cho công việc, **không dùng tài khoản cá nhân của nhân viên**.
- Bản dựng **chưa ký số**; Windows/macOS sẽ cảnh báo khi cài. Chỉ cài bản do
  trung tâm phát hành.
- **Không bật tunnel Cloudflare** của webhook gateway: nó mở một địa chỉ công
  khai trỏ thẳng vào máy đang giữ phiên Zalo của trung tâm.

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
- Hoặc đẩy một tag bắt đầu bằng `v`, ví dụ `git tag v26.8.5 && git push origin v26.8.5`.
- Tải bản cài ở mục **Artifacts** của lần chạy (giữ 14 ngày).

**Phát hành (Release):** sau khi build xong cả bốn bản, job "Phát hành" tạo một
GitHub Release kèm toàn bộ bản cài, khi:

- Run workflow có tick **Tạo Release**: tag là `v` + `version` trong
  [package.json](./package.json) (tăng `version` trước khi phát hành bản mới); hoặc
- đẩy tag `v*`: tag đó là tên Release.

Repo private nên Release chỉ người có quyền vào repo thấy.

Bản macOS chưa ký bằng chứng chỉ Apple (chỉ ký ad-hoc). Lần mở đầu, macOS sẽ
chặn: chuột phải vào app → **Open**, hoặc chạy
`xattr -cr "/Applications/AHV Connect.app"`.

### Trên máy

```bash
npm run production   # build cầu nối Go E2EE, main, renderer, native module rồi đóng gói cho hệ điều hành đang chạy
```

Cần Go ≥ 1.26 cho cầu nối E2EE. Bản cài ra ở `dist-electron-build/`. Không build
chéo hệ điều hành: các thành phần native (better-sqlite3, ffmpeg, ngrok,
cloudflared, cầu nối E2EE) phải đúng nền tảng.

Cấu hình đóng gói (appId `com.ahv.connect`, productName `AHV Connect`, protocol
`ahvconnect://`) nằm ở khối `build` trong [package.json](./package.json).

## Dữ liệu

Dữ liệu nằm hoàn toàn trên máy người dùng (SQLite trong thư mục `userData` của
ứng dụng). **Không có bản sao lưu tự động** — tự sao lưu định kỳ trước khi nâng
cấp phiên bản.

⚠️ Thư mục dữ liệu là `%AppData%\AHV Connect`, **không phải** `%AppData%\Deplao`.
Máy nào đã dùng Deplao từ trước sẽ thấy cơ sở dữ liệu rỗng khi mở AHV Connect —
dữ liệu cũ không mất, chỉ nằm ở thư mục khác. Cách chuyển và lý do giữ nguyên
tên tệp `deplao-tool.db` / `deplao-config.json`: xem [NOTICE.md](./NOTICE.md).

## Hỗ trợ

Bản nội bộ không dùng kênh issue công khai. Báo lỗi gửi cho bộ phận CNTT của
trung tâm kèm ảnh chụp màn hình và log (trong ứng dụng: **Cài đặt → Nhật ký**).
