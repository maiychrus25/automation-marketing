# Thiết kế: Browser Profiles (MVP)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 01/10/2026 |
| Trạng thái | Chờ duyệt |
| Kế hoạch triển khai | `docs/plans/2026-10-01-browser-profiles.md` |
| Intent | `docs/intent/2026-10-01-browser-profiles.md` |
| Bằng chứng kỹ thuật | `docs/reports/2026-10-01-antidetect-chromium-spike.md` |

## 1. Mục tiêu

Người dùng Boss/Standalone tạo và quản lý các **browser profile** trong AHV Connect. Mỗi profile mở một trình duyệt Chromium antidetect riêng, có fingerprint cố định, dữ liệu đăng nhập cô lập và proxy riêng.

MVP đạt khi:

1. Hai profile khác nhau cho fingerprint khác nhau; cùng một profile cho fingerprint giống hệt ở mọi lần mở.
2. Đóng rồi mở lại một profile vẫn giữ phiên đăng nhập.
3. Profile có proxy (kể cả proxy có mật khẩu, loại http/https/socks4/socks5) đi ra Internet bằng IP của proxy, không lộ IP thật qua WebRTC.
4. Quản lý được 1.000 profile và mở đồng thời 30 profile trên một máy.
5. Không tính năng hiện có nào của AHV Connect thay đổi hành vi.

## 2. Ngoài phạm vi

- Chia sẻ profile cho nhân viên, module quyền mới, log mở/đóng theo nhân viên (đợt 2).
- Đồng bộ thao tác, automation trên profile (đợt 3 trở đi).
- Nhập/xuất cookie; nhân bản profile kèm dữ liệu trình duyệt.
- Tự suy múi giờ/ngôn ngữ từ IP proxy.
- Mã hóa thư mục dữ liệu profile (open question 5 của intent).
- macOS; persona khác hệ điều hành máy thật.
- License, gói cước.

## 3. Kiến trúc

```
Renderer (màn hình Trình duyệt)
   │  window.api.browserProfile.*
Preload (contextBridge)
   │  ipcMain 'browserProfile:*'
browserProfileIpc.ts ── kiểm tra input, chặn chế độ employee
   │
BrowserProfileService ── điều phối mở/đóng, giới hạn 30, trạng thái đang chạy
   ├── BrowserEngineManager   tải, kiểm SHA-256, định vị binary
   ├── fingerprint.ts         sinh fingerprint, dựng tham số dòng lệnh (hàm thuần)
   ├── ProxyForwarder         proxy cục bộ 127.0.0.1 cho từng profile đang mở
   └── DatabaseService        bảng browser_profiles, browser_profile_groups, proxies
```

Cách điều khiển trình duyệt: main process `spawn` binary với tham số dòng lệnh. Không mở cổng remote-debugging, không cài extension.

### 3.1 Các đơn vị

| Đơn vị | Vị trí | Trách nhiệm | Phụ thuộc |
|---|---|---|---|
| `BrowserEngineManager` | `src/services/browser/BrowserEngineManager.ts` | Trả về đường dẫn binary; tải về và giải nén nếu chưa có; từ chối nếu SHA-256 sai | `userData`, mạng |
| `fingerprint.ts` | `src/services/browser/fingerprint.ts` | `generateFingerprint()` và `buildLaunchArgs(profile, proxyPort, hostPlatform)`; hàm thuần, không I/O | Không |
| `ProxyForwarder` | `src/services/browser/ProxyForwarder.ts` | Mở một HTTP proxy trên `127.0.0.1:<cổng ngẫu nhiên>`, chuyển mọi kết nối tới proxy thật kèm xác thực | `http`/`https` của Node, gói `socks` (đã có trong `node_modules`) |
| `BrowserProfileService` | `src/services/browser/BrowserProfileService.ts` | `open(id)`, `close(id)`, `closeAll()`, `getRunningIds()`; giữ map profile đang chạy | Ba đơn vị trên, `DatabaseService` |
| `browserProfileIpc.ts` | `electron/ipc/browserProfileIpc.ts` | Các handler `browserProfile:*`, đăng ký trong `electron/main.ts` như `registerProxyIpc()` | `BrowserProfileService` |
| Model | `src/models/browserProfile.ts` | Kiểu `BrowserProfile`, `BrowserProfileGroup`, `BrowserFingerprint` | Không |
| UI | `src/ui/features/browser/` | Màn hình danh sách và form | `window.api.browserProfile` |

## 4. Nhân trình duyệt

- Nhân: `adryfish/fingerprint-chromium` bản **148.0.7778.215**.
- Cấu hình ghim trong `src/configs/browserEngine.config.ts`: phiên bản, và với mỗi nền tảng (`win32`, `linux`) một URL tải, SHA-256 và đường dẫn tương đối tới file thực thi.

| Nền tảng | Gói | SHA-256 |
|---|---|---|
| `win32` x64 | `ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip` | `9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579` |
| `linux` x64 | `ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz` | `70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4` |

- Không đóng gói vào bộ cài. Lần đầu người dùng mở màn hình Trình duyệt mà chưa có nhân, UI hiện nút "Tải trình duyệt (khoảng 190 MB)" kèm tiến độ.
- Thư mục cài: `<userData>/browser-engine/<version>/`. Dùng chung cho mọi workspace.
- Quy trình tải: tải vào file tạm → tính SHA-256 → sai thì xóa file và trả lỗi → đúng thì giải nén → ghi file đánh dấu `installed.json`. Thiếu file đánh dấu thì coi như chưa cài (xử lý trường hợp tải hoặc giải nén dở).
- Nền tảng không có trong cấu hình (macOS): màn hình báo "chưa hỗ trợ", không cho tải.

## 5. Dữ liệu

Hai bảng mới trong SQLite của workspace, tạo trong `DatabaseService` theo pattern `CREATE TABLE IF NOT EXISTS` hiện có.

```sql
CREATE TABLE IF NOT EXISTS browser_profile_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS browser_profiles (
    id               TEXT PRIMARY KEY,            -- uuid, cũng là tên thư mục dữ liệu
    name             TEXT NOT NULL,
    group_id         INTEGER DEFAULT NULL,        -- browser_profile_groups.id
    proxy_id         INTEGER DEFAULT NULL,        -- proxies.id
    fingerprint_json TEXT NOT NULL,               -- BrowserFingerprint
    note             TEXT NOT NULL DEFAULT '',
    last_opened_at   INTEGER DEFAULT NULL,
    created_at       INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_browser_profiles_group ON browser_profiles(group_id);
```

- Xóa nhóm: các profile trong nhóm chuyển `group_id` về `NULL`.
- Xóa proxy đang được profile dùng: `proxy_id` của các profile đó về `NULL` (thêm một câu `UPDATE` vào `DatabaseService.deleteProxy()`, cạnh câu đang làm việc này cho `accounts.proxy_id`).
- Thư mục dữ liệu trình duyệt: `<thư mục chứa DB của workspace>/browser-profiles/<profile id>/`. Xóa profile thì xóa cả thư mục này.
- Trạng thái "đang chạy" chỉ nằm trong bộ nhớ của `BrowserProfileService`, không lưu DB, để không bị kẹt trạng thái sau khi app crash.

## 6. Fingerprint

```ts
interface BrowserFingerprint {
    seed: number;                 // 1 .. 2^31-1, ngẫu nhiên khi tạo
    hardwareConcurrency: number;  // chọn ngẫu nhiên trong [4, 8, 12, 16]
    language: string;             // ví dụ "vi-VN"
    timezone: string;             // ví dụ "Asia/Ho_Chi_Minh"
}
```

- Sinh một lần khi tạo profile; không tự đổi về sau. Người dùng sửa được ngôn ngữ, múi giờ và bấm "Tạo lại fingerprint" (sinh seed mới) trong form sửa.
- Mặc định khi tạo: `vi-VN`, `Asia/Ho_Chi_Minh`.
- Nền tảng persona không lưu trong profile: luôn lấy theo hệ điều hành máy đang chạy (`win32` → `windows`, `linux` → `linux`). Lý do: spike cho thấy font máy thật lọt ra khi persona khác hệ điều hành.

Tham số dòng lệnh do `buildLaunchArgs` dựng:

| Tham số | Giá trị |
|---|---|
| `--user-data-dir` | thư mục dữ liệu của profile |
| `--fingerprint` | `seed` |
| `--fingerprint-platform` | theo hệ điều hành máy thật |
| `--fingerprint-brand` | `Chrome` |
| `--fingerprint-hardware-concurrency` | `hardwareConcurrency` |
| `--lang`, `--accept-lang` | `language` |
| `--timezone` | `timezone` |
| `--proxy-server` | `http://127.0.0.1:<cổng forwarder>` (chỉ khi profile có proxy) |
| `--disable-non-proxied-udp` | luôn bật khi profile có proxy, để WebRTC không đi vòng qua proxy |
| `--no-first-run`, `--no-default-browser-check` | luôn bật |

## 7. Proxy

- Dùng bảng `proxies` và màn hình quản lý proxy hiện có; không thêm kho proxy mới.
- Nhân trình duyệt không nhận username/password qua `--proxy-server`. Vì vậy mỗi profile đang mở và có proxy sẽ có một `ProxyForwarder`:
  - Lắng nghe trên `127.0.0.1`, cổng do hệ điều hành cấp (`listen(0)`), không lắng nghe trên địa chỉ khác.
  - Xử lý cả yêu cầu `CONNECT` (HTTPS) và HTTP thường.
  - Mở kết nối tới proxy thật bằng yêu cầu `CONNECT` của thư viện chuẩn Node kèm header `Proxy-Authorization` (loại http/https), hoặc bằng `SocksClient` của gói `socks` (socks4/socks5). Hai gói `https-proxy-agent`/`socks-proxy-agent` không dùng được cho việc này vì không có API công khai để lấy socket thô.
  - Proxy thật lỗi: trả `502` cho trình duyệt; không bao giờ tự chuyển sang kết nối trực tiếp.
- Profile không có proxy: không dựng forwarder, trình duyệt đi mạng trực tiếp. Danh sách hiển thị rõ nhãn "Không proxy".

## 8. Vòng đời

**Mở profile (`open(id)`):**

1. Profile đang chạy → trả lỗi "Profile đang mở".
2. Đã có 30 profile đang chạy → trả lỗi "Đã đạt giới hạn 30 profile mở cùng lúc".
3. Nhân trình duyệt chưa cài → trả lỗi yêu cầu tải.
4. Có `proxy_id` → khởi động `ProxyForwarder`. Proxy không còn tồn tại trong DB → trả lỗi, không mở.
5. `spawn` binary với tham số ở mục 6, không gắn stdio.
6. Ghi vào map đang chạy, cập nhật `last_opened_at`, phát sự kiện `browserProfile:statusChanged` tới renderer.

**Đóng:**

- Người dùng đóng cửa sổ trình duyệt → sự kiện `exit` của tiến trình → dừng forwarder, xóa khỏi map, phát `statusChanged`.
- `close(id)` từ UI → yêu cầu trình duyệt thoát êm để kịp ghi cookie (`SIGTERM` trên Linux, `taskkill /T` không kèm `/F` trên Windows); sau 5 giây nếu còn chạy mới kill cứng. Dọn dẹp diễn ra khi tiến trình phát `exit`.
- App thoát: gọi `closeAll()` trong handler `before-quit` hiện có của `electron/main.ts`.
- Chuyển workspace: gọi `closeAll()` trước khi `DatabaseService` đổi DB.

**Giới hạn 30** là hằng số `MAX_RUNNING_PROFILES` trong `BrowserProfileService`.

## 9. IPC

Tất cả handler trả `{ success, ... }` hoặc `{ success: false, error }` như các IPC hiện có. Mọi handler từ chối khi `AppModeManager` đang ở chế độ `employee`.

| Kênh | Tham số | Kết quả |
|---|---|---|
| `browserProfile:list` | — | `profiles`, `groups`, `runningIds` |
| `browserProfile:create` | `name`, `groupId?`, `proxyId?`, `language?`, `timezone?`, `note?` | `profile` |
| `browserProfile:update` | `id`, các trường sửa được, `regenerateFingerprint?` | `profile` |
| `browserProfile:delete` | `ids[]` | số đã xóa; profile đang chạy bị từ chối |
| `browserProfile:setProxy` | `ids[]`, `proxyId \| null` | số đã cập nhật |
| `browserProfile:open` | `id` | — |
| `browserProfile:close` | `id` | — |
| `browserProfile:saveGroup` / `deleteGroup` | nhóm | `group` |
| `browserProfile:engineStatus` | — | `installed`, `version`, `supported` |
| `browserProfile:installEngine` | — | tiến độ phát qua `browserProfile:engineProgress` |

Không cho đổi ngôn ngữ, múi giờ, fingerprint hoặc proxy của profile đang mở; xóa hàng loạt bỏ qua profile đang mở và trả về danh sách bị bỏ qua.

Kiểm tra input ở IPC: `name` không rỗng và tối đa 100 ký tự; `id` phải tồn tại; `proxyId`/`groupId` nếu có phải tồn tại; `timezone` phải là giá trị `Intl` chấp nhận.

## 10. Giao diện

- Thêm `'browser'` vào `AppView` trong `src/ui/store/appStore.ts` và một `NavBtn` "Trình duyệt" trong `Sidebar.tsx`, chỉ hiện khi `empMode !== 'employee'` và không ở chế độ xem thử nhân viên.
- Một màn hình `src/ui/features/browser/BrowserProfilesView.tsx`:
  - Thanh trên: tìm theo tên, lọc theo nhóm, nút "Tạo profile".
  - Bảng: ô chọn, tên, nhóm, proxy, lần mở gần nhất, trạng thái (đang chạy/đã dừng), nút Mở/Đóng, menu sửa/xóa.
  - Chọn nhiều dòng: thanh thao tác hàng loạt (mở, đóng, gán proxy, xóa).
  - Danh sách cuộn trong khung, phân trang phía client 50 dòng mỗi trang để chịu được 1.000 profile.
  - Trạng thái rỗng, đang tải, lỗi; trạng thái "chưa cài trình duyệt" kèm nút tải và tiến độ.
- Form tạo/sửa (modal): tên, nhóm, proxy (chọn từ kho proxy), ngôn ngữ, múi giờ, ghi chú; ở chế độ sửa có nút "Tạo lại fingerprint" kèm xác nhận.
- Xóa profile yêu cầu xác nhận, nêu rõ dữ liệu đăng nhập sẽ mất.
- Dùng lại component, class Tailwind và hỗ trợ dark/light hiện có. Trước khi làm UI, bổ sung vào `DESIGN.md` phần token giao diện tối thiểu cho màn hình này (màu, khoảng cách, bảng, trạng thái), không thiết kế lại các màn hình khác.
- Kiểm tra ở chiều rộng desktop và mobile: không tràn ngang cấp trang, không chồng chữ.

## 11. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Tải nhân thất bại hoặc SHA-256 sai | Xóa file tạm, báo lỗi, cho thử lại |
| Binary không chạy được (thiếu thư viện hệ thống, bị antivirus chặn) | `spawn` lỗi → dọn forwarder, báo lỗi kèm thông điệp hệ điều hành |
| Proxy thật chết | Trình duyệt nhận `502`; không rò sang kết nối trực tiếp |
| Trình duyệt crash | Xử lý như đóng bình thường qua sự kiện `exit` |
| App crash khi profile đang mở | Trình duyệt con có thể còn chạy; lần khởi động sau map rỗng. Chromium tự khóa thư mục dữ liệu nên mở lại profile đó sẽ thất bại cho đến khi cửa sổ cũ đóng; thông báo lỗi nêu rõ điều này |
| Xóa profile đang chạy | Từ chối, yêu cầu đóng trước |

## 12. Kiểm thử

Unit test (jest, đặt tại `src/__tests__/browser/`):

- `fingerprint.test.ts`: `generateFingerprint` cho giá trị trong miền hợp lệ; `buildLaunchArgs` dựng đúng tham số cho các trường hợp có/không proxy, `win32`/`linux`.
- `ProxyForwarder.test.ts`: với một proxy giả cục bộ yêu cầu mật khẩu, yêu cầu `CONNECT` và HTTP thường đi qua được và mang đúng xác thực; proxy giả tắt thì nhận `502`.
- `BrowserProfileService.test.ts`: với hàm spawn giả, kiểm tra chặn mở trùng, chặn vượt giới hạn 30, dọn dẹp khi tiến trình thoát.
- `BrowserEngineManager.test.ts`: SHA-256 sai thì xóa file và báo lỗi; thiếu file đánh dấu thì coi như chưa cài.

Kiểm tra tay trên dev (Linux và Windows), hai vòng, mỗi vòng ở chiều rộng desktop và mobile, cả dark và light:

1. Tải nhân, tạo 2 profile, mở cả hai, so sánh fingerprint trên một trang kiểm tra.
2. Đăng nhập một trang trong profile, đóng, mở lại, phiên còn nguyên.
3. Gán proxy có mật khẩu, xác nhận IP ra ngoài là IP proxy và không lộ IP thật qua WebRTC.
4. Tạo 1.000 profile bằng script dev, kiểm tra danh sách tìm/lọc/phân trang.
5. Hồi quy: Chat, CRM, Workflow, quản lý proxy cho account Zalo, chuyển workspace, thoát app vẫn hoạt động như trước.

Repo hiện không có `Makefile` và `package.json` không có script `test` (TD-12). Lệnh kiểm chứng: `npm run build:electron`, `npm run build:renderer`, `npx jest`.

## 13. Rủi ro đã biết

- Nhân trình duyệt chậm phiên bản so với Chrome chính thức và do một tác giả duy trì. Giảm thiểu: phiên bản, URL, SHA-256 nằm trong một file cấu hình; đổi nhân chỉ cần đổi cấu hình và `buildLaunchArgs`.
- Giả lập GPU trên Windows chưa được đo với GPU thật.
- Mở 30 profile cần hơn 8,5 GB RAM; MVP chỉ chặn theo số lượng, không đo RAM.
- Dữ liệu phiên đăng nhập trong thư mục profile không được mã hóa.
- Độ phân giải màn hình không được giả lập.
