<div align="center">

<img src="resources/icons/icon_128.png" alt="MaiHub" width="96" />

# MaiHub

**Một ứng dụng desktop để vận hành nhiều tài khoản Zalo, Facebook và Telegram**
Chat đa kênh, CRM, workflow tự động, đăng bài Facebook và trợ lý AI, dữ liệu lưu trên máy của bạn.

</div>

---

## Mục lục

- [Giới thiệu](#giới-thiệu)
- [Tính năng](#tính-năng)
- [Cài đặt](#cài-đặt)
- [Bắt đầu phát triển](#bắt-đầu-phát-triển)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Kiểm tra trước khi gửi thay đổi](#kiểm-tra-trước-khi-gửi-thay-đổi)
- [Đóng gói và phát hành](#đóng-gói-và-phát-hành)
- [Dữ liệu và quyền riêng tư](#dữ-liệu-và-quyền-riêng-tư)
- [Rủi ro và giới hạn](#rủi-ro-và-giới-hạn)
- [Tài liệu](#tài-liệu)
- [Hỗ trợ](#hỗ-trợ)
- [Giấy phép](#giấy-phép)

## Giới thiệu

MaiHub là ứng dụng desktop (Electron) dành cho người bán hàng, chăm sóc khách và làm
marketing trên Zalo, Facebook và Telegram. Mọi hội thoại, liên hệ, chiến dịch và lịch
đăng bài nằm trong một cửa sổ; dữ liệu lưu trong SQLite trên chính máy đang chạy.

Ứng dụng chạy theo ba chế độ:

| Chế độ | Dùng khi |
|---|---|
| `standalone` | Một máy vận hành độc lập |
| `boss` | Máy giữ kết nối tài khoản và chia việc cho nhân viên |
| `employee` | Máy nhân viên, làm việc qua workspace từ xa nối tới máy boss |

Một bản cài hỗ trợ tối đa 5 workspace, mỗi workspace có cơ sở dữ liệu và thư mục tệp riêng.

## Tính năng

| Nhóm | Nội dung chính |
|---|---|
| Chat đa kênh | Zalo cá nhân, Facebook cá nhân (kể cả chat mã hoá đầu cuối), Telegram (tài khoản và bot) trong một hộp thư |
| Hộp thư Page Facebook | Nhận và gửi tin, ảnh, tệp, nhãn dán, cảm xúc đứng tên Page; trạng thái đã nhận / đã xem; tải tin cũ và đồng bộ lịch sử |
| CRM | Liên hệ, nhãn, ghi chú, chiến dịch gửi tin có trần theo ngày |
| Workflow | Kịch bản tự động theo sự kiện, có nút AI và các kênh chat |
| Trợ lý AI | Soạn trả lời, tóm tắt, dùng nhà cung cấp AI bạn tự cấu hình |
| Đăng Facebook | Đăng nhóm và Page, 1–10 ảnh hoặc 1 video, lên lịch, bản nháp, bình luận đầu |
| Trình duyệt | Hồ sơ trình duyệt riêng cho từng tài khoản, có sandbox |
| Nghiên cứu và nội dung | Nghiên cứu chủ đề, Video Studio, video quảng cáo nhiều cảnh, đề xuất bài hằng ngày |
| Tự vận hành có giới hạn | Bot chuẩn bị nháp và chạy việc theo chính sách bạn đặt; không tự duyệt hay đăng khi chưa được cấp quyền |
| Điều khiển từ bot | Máy chủ HTTPS tắt theo mặc định để bot tạo nháp, tải ảnh, duyệt lịch |
| Nhân viên và workspace | Phân quyền, relay từ máy boss, tách dữ liệu theo workspace |
| Tích hợp | Bán hàng (KiotViet, Haravan, Sapo, Nhanh, Pancake), vận chuyển (GHN, GHTK), thanh toán (Casso, SePay), webhook |
| Tự cập nhật | Kiểm tra bản mới trên GitHub Releases |

Mô tả từng module, giới hạn và trạng thái kiểm chứng: [SYSTEM_DOCUMENTATION.md](./SYSTEM_DOCUMENTATION.md), mục 4.

## Cài đặt

Tải bộ cài tại [GitHub Releases](https://github.com/maiychrus25/automation-marketing/releases).

| Hệ điều hành | Tệp |
|---|---|
| Windows x64 | bộ cài `.exe` |
| macOS Apple Silicon / Intel | `.dmg` (`arm64` hoặc bản không có hậu tố cho Intel) |
| Linux x64 | `.AppImage` hoặc `.deb` |

Bản dựng **chưa ký số**, nên hệ điều hành sẽ cảnh báo khi cài. Trên macOS, lần mở đầu
hãy chuột phải vào ứng dụng rồi chọn **Open**, hoặc chạy `xattr -cr "/Applications/MaiHub.app"`.
Chỉ cài bản tải từ trang Releases của dự án.

### Tự cập nhật

Ứng dụng hỏi GitHub Releases 15 giây sau khi mở rồi mỗi 6 giờ. Có bản mới thì hiện thẻ
thông báo ở góc trên bên phải.

| Nền tảng | Cách cập nhật |
|---|---|
| Windows (bộ cài `.exe`), Linux AppImage | Bấm **Cập nhật**, tải trong ứng dụng, rồi **Khởi động lại để cập nhật** |
| macOS, Linux `.deb` | Bấm **Tải bản mới** để mở trang Release, tải và cài tay |

Khi đang có lượt đăng Facebook hoặc việc nền chưa xong, ứng dụng không khởi động lại để
cài; bản đã tải được giữ lại để thử sau.

## Bắt đầu phát triển

Yêu cầu: Node.js 24, npm, và Go 1.26 trở lên (để dựng cầu nối chat mã hoá đầu cuối;
thiếu Go thì ứng dụng vẫn chạy, chỉ không có chat mã hoá).

```bash
npm install     # cài phụ thuộc
npm run dev     # Vite + Electron ở chế độ phát triển
npm test        # chạy toàn bộ test (Jest)
```

Công nghệ chính: Electron 41, React 18, TypeScript 5, Vite 6, Tailwind CSS 3,
better-sqlite3, Jest. Kết nối kênh dùng `zca-js` (Zalo), MQTT (Facebook) và
`telegram` (Telegram).

## Cấu trúc dự án

```text
electron/                 Tiến trình chính: main.ts, preload.ts, các kênh IPC trong ipc/
src/
  ui/                     Giao diện React (components, hooks, store, lib)
  services/               Nghiệp vụ theo miền: zalo, facebook, telegram, crm, workflow, ai, ...
  models/                 Kiểu dữ liệu dùng chung
  utils/, configs/        Tiện ích và cấu hình
  bridge-e2ee/            Cầu nối Go cho chat Messenger mã hoá đầu cuối
  __tests__/              Test Jest, chia theo miền
services/maihub-render/   Máy chủ render video (Docker)
tools/maihub-bridge/      Cầu nối Python (CLI và MCP) để bot điều khiển MaiHub
scripts/                  Dựng icon, dựng cầu nối, kiểm tài liệu, ghi chú phát hành
resources/                Icon và tài nguyên đóng gói
docs/                     intent/, specs/, plans/, protocol/, reports/
```

Quy ước:

- Mã nghiệp vụ nằm trong `src/services/`, mỗi miền một thư mục; giao diện gọi nghiệp vụ qua IPC.
- Mỗi kênh IPC khai báo ở `electron/ipc/` và được mở cho giao diện qua `electron/preload.ts`.
- Tên định danh trong mã (tệp, hàm, biến, trường dữ liệu) dùng tiếng Anh; chữ hiển thị cho
  người dùng và tài liệu dùng tiếng Việt.
- Tính năng lớn có spec và plan trong `docs/specs/` và `docs/plans/` trước khi viết mã.

Quy tắc làm việc đầy đủ cho người và trợ lý AI: [AGENTS.md](./AGENTS.md).

## Kiểm tra trước khi gửi thay đổi

```bash
npx tsc -p tsconfig.electron.json --noEmit   # kiểm kiểu tiến trình chính
npx tsc -p tsconfig.json --noEmit            # kiểm kiểu giao diện
npm test                                     # toàn bộ test
node scripts/check-docs.js                   # tài liệu khớp với mã
```

Thay đổi hành vi, giới hạn, IPC hoặc schema phải cập nhật
[SYSTEM_DOCUMENTATION.md](./SYSTEM_DOCUMENTATION.md) trong cùng commit. Thay đổi giao diện
theo [DESIGN.md](./DESIGN.md).

## Đóng gói và phát hành

Bản cài được dựng bằng GitHub Actions
([`.github/workflows/build.yml`](./.github/workflows/build.yml)) trên runner của từng hệ
điều hành: Windows x64, macOS Apple Silicon, macOS Intel và Linux x64. Workflow chạy kiểm
kiểu và test trước khi đóng gói.

Phát hành một phiên bản:

1. Tăng `version` trong [package.json](./package.json) và `package-lock.json`.
2. Thêm mục mới vào Log phiên bản trong `src/ui/components/settings/ChangelogSettings.tsx`
   (ghi chú trên trang Releases lấy từ đây qua `scripts/release-notes.js`).
3. Cập nhật dòng phiên bản trong [SYSTEM_DOCUMENTATION.md](./SYSTEM_DOCUMENTATION.md).
4. Gắn thẻ `v<version>` và đẩy thẻ. CI dựng bốn bản và tạo GitHub Release.

Dựng trên máy (chỉ cho hệ điều hành đang chạy, không dựng chéo):

```bash
npm run production   # cầu nối Go, main, renderer, module native rồi đóng gói
```

Bản cài ra ở `dist-electron-build/`. Cấu hình đóng gói (appId `com.maihub.app`,
productName `MaiHub`, protocol `maihub://`) nằm ở khối `build` trong
[package.json](./package.json).

## Dữ liệu và quyền riêng tư

- Dữ liệu nằm hoàn toàn trên máy người dùng, trong thư mục dữ liệu của ứng dụng:
  `%AppData%\MaiHub` (Windows), `~/Library/Application Support/MaiHub` (macOS),
  `~/.config/MaiHub` (Linux). Cơ sở dữ liệu chính là tệp `deplao-tool.db`, cấu hình là
  `deplao-config.json`.
- **Không có sao lưu tự động.** Hãy tự sao lưu thư mục dữ liệu định kỳ và trước khi nâng cấp.
- Cookie, khoá API và mật khẩu tích hợp được mã hoá bằng kho khoá của hệ điều hành
  (Keychain, DPAPI, keyring).
- Ứng dụng không gửi dữ liệu sử dụng (telemetry) ra ngoài. Kết nối ra ngoài chỉ gồm các
  nền tảng chat bạn đăng nhập, GitHub (kiểm tra bản mới) và các dịch vụ bạn tự cấu hình
  (nhà cung cấp AI, webhook, tích hợp).

## Rủi ro và giới hạn

- Ứng dụng thao tác trên **tài khoản cá nhân** Zalo và Facebook qua các kết nối không
  chính thức. Việc này trái chính sách của các nền tảng và có thể dẫn tới khoá tài khoản.
  Hãy dùng tài khoản riêng cho công việc.
- Chiến dịch gửi tin chưa có giờ im lặng và cơ chế từ chối nhận thống nhất. Chưa nên dùng
  để gửi tin hàng loạt cho khách thật khi chưa có sự đồng ý của người nhận.
- **Không mở tunnel công khai** (Cloudflare, ngrok) cho webhook khi chưa có xác thực và
  tường lửa: tunnel trỏ thẳng vào máy đang giữ phiên đăng nhập.
- Lịch đăng bài chỉ chạy khi ứng dụng đang mở và máy thức.
- Trên Linux đang chặn user namespaces, trình duyệt của MaiHub chạy không sandbox; màn
  **Trình duyệt** hiện cảnh báo kèm lệnh khắc phục.
- Nhiều phần còn ghi "cần xác nhận vận hành" trong tài liệu hệ thống. Danh sách đầy đủ:
  [SYSTEM_DOCUMENTATION.md](./SYSTEM_DOCUMENTATION.md), mục 23 và 26.

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [SYSTEM_DOCUMENTATION.md](./SYSTEM_DOCUMENTATION.md) | Kiến trúc, module, mô hình dữ liệu, giới hạn, bảo mật |
| [DESIGN.md](./DESIGN.md) | Nhận diện và quy tắc giao diện |
| [AGENTS.md](./AGENTS.md) | Quy trình làm việc và quy ước mã |
| [docs/protocol/maihub-control-protocol.md](./docs/protocol/maihub-control-protocol.md) | Giao thức điều khiển MaiHub từ bot |
| [tools/maihub-bridge/README.md](./tools/maihub-bridge/README.md) | Cài cầu nối Python trên máy chạy bot |
| [services/maihub-render/README.md](./services/maihub-render/README.md) | Máy chủ render video |
| `docs/intent/`, `docs/specs/`, `docs/plans/` | Mục đích, thiết kế và kế hoạch của từng tính năng |

## Hỗ trợ

Báo lỗi tại mục [Issues](https://github.com/maiychrus25/automation-marketing/issues) của kho
GitHub, kèm ảnh chụp màn hình và log (trong ứng dụng: **Cài đặt → Nhật ký**). Trước khi gửi
log, hãy xoá cookie, token và nội dung tin nhắn riêng tư.

## Giấy phép

Phát hành theo giấy phép **MIT**. Toàn văn giấy phép và thông báo bản quyền:
[LICENSE](./LICENSE). Ghi nhận mã nguồn mở được sử dụng: [NOTICE.md](./NOTICE.md).
