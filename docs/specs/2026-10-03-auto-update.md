# Thiết kế và kế hoạch: Tự cập nhật MaiHub

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 03/10/2026 |
| Trạng thái | Đang triển khai |
| Nhánh | `feat/auto-update` |
| Quyết định của chủ dự án | Kho `maiychrus25/automation-marketing` để công khai; macOS giữ như hiện tại (không ký số) |

## 1. Mục tiêu

Khi có bản phát hành mới trên GitHub Releases, MaiHub hiện thông báo. Người dùng bấm **Cập nhật** thì app tải bản mới, xong thì bấm **Khởi động lại** để cài.

Đạt khi:

1. App tự kiểm tra bản mới 15 giây sau khi cửa sổ chính nạp xong, rồi mỗi 6 giờ.
2. Có bản mới hơn bản đang chạy thì hiện thông báo với số phiên bản và nút hành động. Không có thì không hiện gì.
3. Windows (bộ cài NSIS) và Linux AppImage: tải trong app, có thanh tiến độ, khởi động lại thì cài và mở lại app.
4. macOS (chưa ký số) và Linux `.deb`: thông báo có bản mới, nút **Tải bản mới** mở trang phát hành. Không tự cài.
5. Đang có việc Đăng Facebook chạy thì không cho khởi động lại để cài, báo lý do.
6. Lỗi mạng hoặc lỗi tải không làm app hỏng; thông báo hiện lỗi và cho thử lại.
7. Bộ cài của mỗi bản phát hành kèm đủ tệp mô tả phiên bản mà bộ cập nhật cần.

## 2. Ngoài phạm vi

- Ký số macOS và Windows.
- Kênh beta, cập nhật bắt buộc, hạ phiên bản.
- Nút "Kiểm tra cập nhật" thủ công trong Cài đặt (lõi có hàm `check()`, thêm nút sau nếu cần).
- Bản 26.10.0 đã cài: cơ chế cập nhật trong bản đó đang tắt, nên người dùng phải cài tay bản kế tiếp **một lần**.

## 3. Thiết kế

### 3.1 Kiểm tra bản mới

Gọi `GET https://api.github.com/repos/maiychrus25/automation-marketing/releases/latest` (không cần token vì kho công khai; giới hạn 60 lần/giờ/IP là dư với chu kỳ 6 giờ). So `tag_name` bỏ chữ `v` với `app.getVersion()` theo ba số `major.minor.patch`. Một đường kiểm tra cho mọi nền tảng, test được bằng hàm thuần.

Lý do không dùng `autoUpdater.checkForUpdates()` để kiểm tra: trên macOS chưa ký và Linux `.deb`, bộ cập nhật cần tệp mô tả riêng và có thể báo lỗi dù chỉ cần biết số phiên bản.

### 3.2 Tải và cài (Windows, AppImage)

Dùng `electron-updater` với `autoDownload = false`, `autoInstallOnAppQuit = false`. Khi người dùng bấm **Cập nhật**: `checkForUpdates()` rồi `downloadUpdate()`; tiến độ từ sự kiện `download-progress`; xong ở `update-downloaded`. Bấm **Khởi động lại**: kiểm việc đang chạy, rồi `quitAndInstall(false, true)`. `before-quit` hiện có đóng các profile và huỷ việc như cũ.

Nền tảng tự cài được: `process.platform === 'win32'`, hoặc `linux` khi có biến môi trường `APPIMAGE`.

### 3.3 Trạng thái

```ts
type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes: string; url: string; canInstall: boolean }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string; version: string | null };
```

`UpdateService` (thuần, không import `electron`) giữ trạng thái, phát `update:state` mỗi lần đổi. Không có bản mới thì trạng thái về `idle` (không hiện gì). Người dùng bấm **Để sau** thì ẩn thông báo ở renderer tới lần kiểm tra kế tiếp có bản mới hơn bản đã ẩn.

### 3.4 IPC

| Kênh | Kiểu | Ghi chú |
|---|---|---|
| `update:get-state` | invoke | trả `UpdateState` hiện tại |
| `update:download` | invoke | `{ success, error? }`; nền tảng không tự cài thì mở trang phát hành |
| `update:install` | invoke | `{ success, error? }`; từ chối khi đang có việc Đăng Facebook |
| `update:check` | invoke | kiểm tra ngay, trả `UpdateState` |
| `update:state` | sự kiện | `UpdateState` |

Gỡ các kênh cũ không ai dùng: `update:available`, `update:progress`, `update:downloaded`, `update:error`, `update:not-available`, `update:renderer-ready`.

### 3.5 Giao diện

Dùng lại `src/ui/store/updateStore.ts` có sẵn (Sidebar và Trung tâm thông báo đã đọc nó để hiện chấm báo và mục "Phiên bản mới", nhưng chưa ai nạp dữ liệu). Hàm thuần `toStorePatch` (`src/ui/store/updateMapping.ts`) ánh xạ `UpdateState` sang trường của store.

Thành phần `UpdateNotice` gắn ở gốc `App.tsx`, thẻ nhỏ **góc trên bên phải, dưới thanh công cụ** (thông báo chung của app nằm giữa đáy nên không đè nhau), theo token `DESIGN.md` (`.mac-toast`), `role="status"`. Nội dung theo trạng thái:

| Trạng thái | Nội dung | Nút |
|---|---|---|
| available, tự cài được | "Có bản MaiHub X mới" + 3 dòng đầu ghi chú | **Cập nhật**, Để sau |
| available, không tự cài | như trên + "Bản này cần tải bộ cài và cài tay" | **Tải bản mới**, Để sau |
| downloading | "Đang tải bản X… n%" + thanh tiến độ | — |
| downloaded | "Đã tải xong bản X" | **Khởi động lại để cập nhật**, Để sau |
| error | thông báo lỗi | Thử lại, Đóng |

Bề rộng tối đa 360 px, co lại theo màn hình hẹp, không che nút điều hướng.

### 3.6 Phát hành

- `package.json` `build.publish`: `[{ "provider": "github", "owner": "maiychrus25", "repo": "automation-marketing" }]`. Với `--publish never`, electron-builder vẫn sinh `app-update.yml` trong gói và `latest*.yml` trong thư mục kết quả, không cần token.
- Workflow `build.yml`: tải lên thêm `latest.yml`, `latest-linux.yml`, `latest-mac.yml`, `*.blockmap`. Job `macos-x64` không tải `latest-mac.yml` để không đè bản của `macos-arm64` (macOS chỉ dùng tệp này để tham khảo, không tự cài).

## 4. Tệp thay đổi

| Tệp | Thay đổi |
|---|---|
| `src/services/update/versionCompare.ts` (mới) | `isNewerVersion(remote, current)` |
| `src/services/update/UpdateService.ts` (mới) | trạng thái, kiểm tra, tải, cài, chặn khi bận |
| `src/__tests__/update/*.test.ts` (mới) | test hai tệp trên |
| `electron/main.ts` | thay khối cập nhật cũ bằng một lời gọi `registerUpdateIpc` |
| `electron/ipc/facebookPosterIpc.ts` | thêm `isFacebookPosterBusy()` |
| `electron/preload.ts` | API `update` mới, allow-list `update:state` |
| `src/ui/lib/ipc.ts` | kiểu `update` |
| `src/ui/components/common/UpdateNotice.tsx` (mới) | thẻ thông báo |
| `src/ui/store/updateStore.ts`, `src/ui/store/updateMapping.ts` (mới) | nạp store từ `update:state`; tải/cài báo lỗi |
| `electron/ipc/updateIpc.ts` (mới) | nối `UpdateService` với Electron, lịch kiểm tra |
| `src/ui/App.tsx` | gắn `UpdateNotice` |
| `package.json` | `build.publish`, phiên bản 26.11.0 |
| `.github/workflows/build.yml` | tải lên tệp mô tả phiên bản |
| `README.md`, `SYSTEM_DOCUMENTATION.md` | mô tả cơ chế cập nhật |

## 5. Thứ tự làm

1. `versionCompare` + test (TDD).
2. `UpdateService` + test (TDD): kiểm tra có/không bản mới, lỗi mạng, tải/tiến độ/xong, chặn cài khi bận, nền tảng không tự cài.
3. Nối vào `main.ts`, IPC, preload, kiểu renderer.
4. `UpdateNotice` + gắn vào `App.tsx`.
5. `build.publish`, workflow, tài liệu, phiên bản.
6. Kiểm chứng: jest, hai tsc, `npm run production`, kiểm `app-update.yml` và `latest-linux.yml`; chạy bản đóng gói với phiên bản giả thấp hơn để thấy thông báo thật từ GitHub; hai vòng kiểm giao diện 1440/375 px × sáng/tối.

## 6. Ảnh hưởng và rủi ro

| Phần | Có thể hỏng | Chặn bằng |
|---|---|---|
| Khởi động app | gọi mạng chậm làm treo | kiểm tra chạy nền sau 15 giây, có timeout 15 giây |
| Đăng Facebook | khởi động lại giữa lúc đăng | `isFacebookPosterBusy()` chặn cài |
| Bộ cài macOS | hai job ghi đè `latest-mac.yml` | chỉ arm64 tải lên |
| Kho riêng tư trở lại | kiểm tra trả 404 | trạng thái về `idle`, ghi log, không hiện lỗi cho người dùng |
| Phát hành | `fail_on_unmatched_files` khi thiếu `.yml` | `if-no-files-found: error` ở bước tải lên để lỗi sớm và rõ |

**Bước rủi ro cao nhất:** cài và mở lại trên Windows. Không kiểm được trên máy này; chỉ kiểm được thật khi có hai bản phát hành nối tiếp (26.11.0 rồi 26.11.1) và một máy Windows.

## 7. Phương án đã cân nhắc và không chọn

| Phương án | Lý do không chọn |
|---|---|
| Dùng `autoUpdater.checkForUpdates()` cho mọi nền tảng | macOS chưa ký và `.deb` có thể báo lỗi khi chỉ cần biết số phiên bản |
| Tự động tải ngầm rồi cài khi thoát | Chủ dự án muốn người dùng bấm Cập nhật; tải ngầm tốn băng thông không báo trước |
| Kho công khai riêng chỉ chứa bộ cài | Chủ dự án chọn công khai kho hiện tại |
| Máy chủ tệp riêng (provider `generic`) | Thêm hạ tầng phải duy trì |
| Cập nhật `.deb` qua `pkexec dpkg -i` của electron-updater | Cần quyền root và tệp mô tả riêng; chưa kiểm được |
