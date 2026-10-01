# Browser Profiles (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng Boss/Standalone tạo và quản lý các browser profile trong AHV Connect; mỗi profile mở một trình duyệt Chromium antidetect riêng với fingerprint cố định, dữ liệu đăng nhập cô lập và proxy riêng.

**Architecture:** Electron main process `spawn` một nhân Chromium đã vá sẵn (`fingerprint-chromium`) bằng tham số dòng lệnh, không mở cổng remote-debugging và không cài extension. Mỗi profile đang mở và có proxy sẽ đi qua một HTTP proxy cục bộ trên `127.0.0.1` do AHV Connect chạy, vì nhân trình duyệt không nhận username/password của proxy qua dòng lệnh. Dữ liệu profile nằm trong SQLite của workspace; trạng thái "đang chạy" chỉ nằm trong bộ nhớ.

**Tech Stack:** Electron 41 (main process Node.js, CommonJS, TypeScript `strict: false`), React 18 + Zustand + Tailwind (renderer), better-sqlite3, jest + ts-jest, `socks` 2.8.9 (đã có trong `node_modules`), `axios` (đã cài).

**Spec:** `docs/specs/2026-10-01-browser-profiles.md`. Intent: `docs/intent/2026-10-01-browser-profiles.md`. Bằng chứng kỹ thuật: `docs/reports/2026-10-01-antidetect-chromium-spike.md`.
Bốn tài liệu này được git theo dõi trên nhánh `feat/browser-profiles`. Tài liệu này tự chứa đủ thông tin để triển khai; ba tài liệu kia là bối cảnh.

**Tài liệu này là nguồn tham chiếu chính cho quá trình triển khai và review PR.** Nếu triển khai khác kế hoạch ở bất kỳ điểm nào, cập nhật file này trong cùng commit với thay đổi đó.

## Global Constraints

- Nhân trình duyệt: `adryfish/fingerprint-chromium` bản **148.0.7778.215**. SHA-256 bản `win32`: `9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579`. SHA-256 bản `linux`: `70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4`.
- Nền tảng MVP: Windows x64 và Linux x64. macOS phải hiện "chưa hỗ trợ", không được crash.
- Persona luôn trùng hệ điều hành máy thật; brand luôn là `Chrome`.
- Không mở cổng remote-debugging, không cài extension vào profile.
- Proxy lỗi thì trả `502`; không bao giờ tự chuyển sang kết nối trực tiếp.
- Forwarder chỉ lắng nghe trên `127.0.0.1`.
- Tối đa 30 profile mở đồng thời (`MAX_RUNNING_PROFILES`).
- Mặc định khi tạo profile: ngôn ngữ `vi-VN`, múi giờ `Asia/Ho_Chi_Minh`, số nhân CPU chọn ngẫu nhiên trong `[4, 8, 12, 16]`.
- Tính năng chỉ dùng được ở chế độ Boss/Standalone; mọi IPC `browserProfile:*` từ chối ở chế độ `employee`.
- Identifier, tên file, kênh IPC, cột DB: tiếng Anh. Chuỗi hiển thị cho người dùng: tiếng Việt.
- Không thêm dependency mới. Ngoại lệ duy nhất: khai báo tường minh `socks` (đã có sẵn trong `node_modules` qua `socks-proxy-agent`).
- Không sửa hành vi của tính năng hiện có. Không refactor ngoài phạm vi.
- Trong `docs/`, git chỉ theo dõi `docs/intent/`, `docs/specs/`, `docs/plans/` và riêng file báo cáo spike; các file khác trong `docs/reports/` vẫn bị ignore.
- Làm trên nhánh `feat/browser-profiles`, chạy ở dev trước. Không `git push`, không build production, không deploy khi chưa được chủ sản phẩm duyệt (`AGENTS.md`).
- Cây làm việc hiện có thay đổi chưa commit không thuộc tính năng này (`README.md`, `AGENTS.md`, `SYSTEM_DOCUMENTATION.md`). Luôn `git add` theo đường dẫn cụ thể như ghi trong từng task; không dùng `git add -A`.
- Lệnh kiểm chứng của repo (repo không có `Makefile`; `make build/test/lint` trong `AGENTS.md` không chạy được):
  - `npx tsc -p tsconfig.electron.json --noEmit` → không in gì, exit 0.
  - `npx tsc -p tsconfig.json --noEmit` → không in gì, exit 0.
  - `npx jest` → tất cả PASS. Lần chạy đầu mất khoảng 90 giây vì ts-jest biên dịch.
  - Cả ba lệnh đều sạch trên `main` tại thời điểm viết kế hoạch (commit `0c1fd3e`).

## Review Focus

Năm tình huống spec không nêu thành yêu cầu riêng nhưng dễ gây lỗi cho người dùng thật. Mỗi dòng đã có test ghim trong task sở hữu đoạn code đó.

1. **Mật khẩu proxy có ký tự đặc biệt** (`@`, `:`, `/`, dấu cách): proxy vẫn phải xác thực đúng. Test: `ProxyForwarder.test.ts` dùng `USER = 'ahv user'`, `PASS = 'p@ss:word/1'` (Task 2).
2. **Proxy chết hoặc đã bị xóa khi mở profile**: không được lộ IP thật. Test: "answers 502 ... when the upstream is down" kiểm tra máy đích không nhận request nào (Task 2); "refuses to open a profile whose proxy was deleted instead of going direct" (Task 4).
3. **Bấm Mở hai lần liên tiếp**: chỉ được có một trình duyệt. Test: "rejects a second open of the same profile, even while the first is still starting" (Task 4).
4. **Đóng profile làm mất phiên đăng nhập**: Chromium ghi cookie trễ; kill cứng sẽ mất cookie vừa đăng nhập. Test: "close() asks for a graceful exit first and force-kills only if the browser is still alive" (Task 4).
5. **Tải nhân trình duyệt bị đứt giữa chừng** (đã xảy ra thật khi spike: file 10,6 MB thay vì 189 MB): không được coi là đã cài, và phải thử lại được. Test: "rejects a download whose SHA-256 does not match", "treats an extraction without the marker file as not installed", "can retry after a failed download" (Task 3).

---

## 1. Bối cảnh cho người chưa biết dự án

- AHV Connect là ứng dụng Electron. Renderer (React) không có Node.js; nó gọi `window.electronAPI.*` do `electron/preload.ts` công khai qua `contextBridge`. Mỗi lời gọi là một `ipcRenderer.invoke('<kênh>')`, được xử lý bởi `ipcMain.handle('<kênh>')` trong `electron/ipc/*.ts`.
- Mọi IPC trả về `{ success: true, ... }` hoặc `{ success: false, error }`.
- Main process gửi sự kiện về renderer bằng `EventBroadcaster.emit(channel, data)`. Renderer chỉ nghe được kênh có tên trong mảng `validChannels` của `electron/preload.ts`.
- SQLite truy cập qua singleton `DatabaseService.getInstance()` (`src/services/database/DatabaseService.ts`, khoảng 8.000 dòng). Bảng được tạo trong `createTables()` bằng `CREATE TABLE IF NOT EXISTS`, chạy mỗi lần khởi động và mỗi lần chuyển workspace.
- Mỗi workspace có file DB riêng. `DatabaseService.getInstance().getDbPath()` (đã tồn tại) trả về đường dẫn DB đang dùng.
- Bảng `proxies` và kiểu `ProxyConfig` (`src/models/proxy.ts`) đã tồn tại: `{ id, name, type: 'http'|'https'|'socks4'|'socks5', host, port, username?, password? }`.
- Chế độ chạy: `AppModeManager.getInstance().isEmployeeMode()`.
- Renderer điều hướng bằng `view` trong `src/ui/store/appStore.ts`; `src/ui/App.tsx` render theo `view`; `src/ui/components/layout/Sidebar.tsx` chứa các nút điều hướng.
- Giao diện có dark và light. Light theme hoạt động bằng cách ghi đè các class Tailwind màu xám trong `src/ui/index.css` (`html[data-theme="light"] .bg-gray-900 { ... }`). Vì vậy dùng đúng các class xám đã có ghi đè thì light theme tự đúng.
- `better-sqlite3` trong `node_modules` được build cho Electron, **không nạp được dưới Node thường**. Do đó không viết được unit test jest cho `DatabaseService`; phần DB được kiểm chứng bằng type-check và kịch bản chạy trong app dev (Task 6).
- Toàn bộ code trong kế hoạch này đã được biên dịch thử và 50 unit test đã chạy qua trên một bản sao của repo (Linux). Một phép thử thật với nhân trình duyệt trên Linux đã xác nhận: trình duyệt → forwarder → proxy có mật khẩu hoạt động, và đóng êm mất khoảng 0,1 giây. **Chưa có gì được chạy thử trên Windows** (xem mục 4).

## 2. Danh sách file

### Tạo mới

| File | Trách nhiệm |
|---|---|
| `src/models/browserProfile.ts` | Kiểu `BrowserFingerprint`, `BrowserProfile`, `BrowserProfileGroup` |
| `src/configs/browserEngine.config.ts` | Phiên bản, URL tải, SHA-256, đường dẫn file chạy của nhân trình duyệt |
| `src/services/browser/fingerprint.ts` | Sinh fingerprint, dựng tham số dòng lệnh, kiểm tra ngôn ngữ/múi giờ (hàm thuần) |
| `src/services/browser/ProxyForwarder.ts` | HTTP proxy cục bộ chuyển tiếp tới proxy thật kèm xác thực |
| `src/services/browser/BrowserEngineManager.ts` | Tải, kiểm SHA-256, giải nén, định vị nhân trình duyệt |
| `src/services/browser/BrowserProfileService.ts` | Mở/đóng profile, giới hạn 30, trạng thái đang chạy |
| `electron/ipc/browserProfileIpc.ts` | Các handler `browserProfile:*`, kiểm tra input, chặn chế độ employee |
| `src/ui/features/browser/BrowserProfilesView.tsx` | Màn hình danh sách, thao tác hàng loạt, quản lý nhóm, tải nhân |
| `src/ui/features/browser/BrowserProfileForm.tsx` | Modal tạo/sửa profile |
| `src/__tests__/browser/fingerprint.test.ts` | 10 test |
| `src/__tests__/browser/ProxyForwarder.test.ts` | 11 test |
| `src/__tests__/browser/BrowserEngineManager.test.ts` | 11 test |
| `src/__tests__/browser/BrowserProfileService.test.ts` | 18 test |

### Sửa

| File | Thay đổi |
|---|---|
| `package.json` | Thêm script `test`; khai báo `socks` |
| `package-lock.json` | Cập nhật theo `npm install socks@^2.8.9` |
| `src/services/database/DatabaseService.ts` | Import kiểu; 2 bảng mới trong `createTables()`; 1 dòng trong `deleteProxy()`; 11 method mới |
| `electron/main.ts` | Import và đăng ký IPC; gọi `closeAllBrowserProfiles()` trong `before-quit` |
| `electron/ipc/workspaceIpc.ts` | Gọi `closeAllBrowserProfiles()` trước 2 chỗ chuyển DB |
| `electron/preload.ts` | Thêm API `browserProfile`; thêm 2 kênh sự kiện vào `validChannels` |
| `src/ui/lib/ipc.ts` | Khai báo kiểu và export `browserProfile` |
| `src/ui/store/appStore.ts` | Thêm `'browser'` vào `AppView` |
| `src/ui/App.tsx` | Render `BrowserProfilesView` khi `view === 'browser'` |
| `src/ui/components/layout/Sidebar.tsx` | Nút "Trình duyệt" và icon |
| `DESIGN.md` | Thêm phần token giao diện cho màn hình Trình duyệt |
| `SYSTEM_DOCUMENTATION.md` | Thêm mục 4.9 mô tả module |
| `docs/plans/2026-10-01-browser-profiles.md` | Cập nhật nếu triển khai khác kế hoạch |

## 3. Thứ tự thực hiện

```
Task 1  model + config + fingerprint        (không phụ thuộc)
Task 2  ProxyForwarder                      (không phụ thuộc)
Task 3  BrowserEngineManager                (cần config của Task 1)
Task 4  BrowserProfileService               (cần Task 1, 2)
Task 5  DatabaseService                     (cần model của Task 1)
Task 6  IPC + preload + main + workspace    (cần Task 3, 4, 5)   ← điểm nối vào app
Task 7  Giao diện                           (cần Task 6)
Task 8  Kiểm chứng tổng thể, tài liệu       (cần tất cả)
```

Task 1–4 là code độc lập với Electron, có unit test đầy đủ. Task 5–6 nối vào app và là nơi có thể gây hồi quy. Task 7 là giao diện. Task 8 là hai vòng kiểm thử tay trên Linux và Windows.

## 4. Bước rủi ro cao nhất

**Vòng đời tiến trình trình duyệt trên Windows** (code ở Task 4, nối vào app ở Task 6, kiểm chứng ở Task 8).

Lý do:

- Toàn bộ phần này mới chỉ được chạy thật trên Linux. Ba hành vi sau trên Windows chưa có bằng chứng:
  1. `taskkill /pid <pid> /T` (không có `/F`) có làm Chromium đóng êm và ghi cookie hay không.
  2. `tar -xf` (bsdtar có sẵn từ Windows 10 1803) có giải nén đúng file zip 189 MB hay không.
  3. Đường dẫn `ungoogled-chromium_148.0.7778.215-1.1_windows_x64/chrome.exe` sau khi giải nén. Đường dẫn này khớp với kết quả `Expand-Archive` trong spike, nhưng chưa thử với `tar`.
- Hậu quả nếu sai: trình duyệt mồ côi chạy ngầm sau khi thoát app, mất phiên đăng nhập, hoặc thư mục profile bị khóa không mở lại được.

Giảm thiểu đã có trong thiết kế: sau 5 giây không thoát thì kill cứng; trạng thái đang chạy không lưu DB nên không kẹt sau crash; `closeAllBrowserProfiles()` bọc trong `try/catch` ở `before-quit`.

Việc bắt buộc: chạy đủ kịch bản Windows ở Task 8 trước khi merge. Nếu bước 1 thất bại (cookie mất), phương án dự phòng là điều khiển đóng qua cửa sổ thay vì `taskkill`; cập nhật kế hoạch này trước khi làm.

## 5. Những phần có thể bị ảnh hưởng hoặc làm hỏng

| Vùng | Rủi ro | Cách kiểm tra |
|---|---|---|
| Khởi động app, chuyển workspace | `createTables()` chạy mỗi lần khởi động và mỗi lần chuyển workspace. SQL lỗi ở đây làm app không mở được DB | Chỉ thêm `CREATE ... IF NOT EXISTS`; Task 6 bước chạy dev; Task 8 chuyển workspace |
| Xóa proxy (Settings → Proxy) | `deleteProxy()` thêm một câu `UPDATE browser_profiles`. Nếu bảng chưa tồn tại thì xóa proxy sẽ lỗi | Bảng được tạo trong cùng `createTables()`; Task 6 kịch bản console bước 7 |
| Thoát app | `before-quit` thêm một bước. Nếu ném lỗi có thể chặn các bước dọn dẹp phía sau | Bọc `try/catch` như các bước khác; Task 8 kiểm tra app thoát hẳn |
| Chuyển/xóa workspace | Thêm lời gọi trước `switchToWorkspaceDb` | Task 8 chuyển workspace khi có profile đang mở |
| `electron/preload.ts` | File 66 KB, một object lớn; sai dấu phẩy làm hỏng toàn bộ `window.electronAPI` và app trắng màn hình | `npx tsc -p tsconfig.electron.json --noEmit`; Task 6 chạy dev |
| Sidebar | Thêm một nút vào cột điều hướng dưới; màn hình thấp có thể tràn | Task 7 kiểm tra ở chiều cao 720 px và ở chiều rộng mobile |
| Chế độ employee | Nút không được hiện; IPC phải từ chối | Task 7 xem thử nhân viên; Task 6 guard trong `handle()` |
| Đóng gói production | Code mới nằm trong `dist-electron/**` (đã thuộc `build.files`); `socks` là dependency khai báo nên được đóng gói | Không build production trong kế hoạch này; ghi chú cho đợt phát hành |
| Tài nguyên máy | 30 trình duyệt cần hơn 8,5 GB RAM | Chỉ chặn theo số lượng; ghi trong rủi ro đã biết |
| Bảo mật | Thư mục profile chứa cookie không mã hóa; forwarder mở cổng cục bộ không xác thực trong lúc profile chạy (mọi tiến trình trên máy dùng được proxy đó) | Chấp nhận ở MVP, đã ghi trong spec mục 13 và intent open question 5 |

Tính năng hiện có không bị sửa logic: Chat, CRM, Workflow, ERP, Tích hợp, proxy cho account Zalo. Danh sách hồi quy cụ thể nằm ở Task 8.

## 6. Phương án đã cân nhắc nhưng không chọn

| Phương án | Lý do không chọn |
|---|---|
| Dùng session partition của Electron và đổi user-agent/inject JS | Chỉ giả lập được lớp nông; các nền tảng lớn phát hiện được. Chủ sản phẩm đã chọn nhân trình duyệt ngoài |
| Tự fork và build Chromium | Cần đội C++ và hạ tầng build riêng; ngoài khả năng hiện tại |
| Camoufox (nền Firefox) | Chủ sản phẩm chốt nền Chromium |
| CloakBrowser, Wayfern | Binary đóng nguồn, giấy phép cấm phân phối lại |
| clearcote-browser | Bản mở chỉ cho 1 instance chạy đồng thời; yêu cầu là 30 |
| Điều khiển trình duyệt qua cổng remote-debugging (xử lý mật khẩu proxy bằng CDP) | Cổng debug là dấu hiệu automation; không xử lý được SOCKS có mật khẩu. Chỉ cần khi làm synchronizer/automation ở đợt sau |
| Extension xử lý mật khẩu proxy | Extension lạ là dấu hiệu nhận diện; không hỗ trợ SOCKS có mật khẩu |
| Dùng `https-proxy-agent` / `socks-proxy-agent` để mở tunnel (spec bản đầu ghi vậy) | Hai gói này là agent cho `http.request`, không có API công khai để lấy socket thô; bản đang cài là ESM. Thay bằng `CONNECT` của thư viện chuẩn Node cho proxy HTTP/HTTPS và gói `socks` (đã có sẵn, CommonJS) cho SOCKS. Spec đã được cập nhật |
| Đóng gói nhân trình duyệt vào bộ cài | Tăng bộ cài thêm khoảng 190 MB cho mọi người dùng kể cả người không dùng tính năng; tải lần đầu có kiểm SHA-256 là đủ |
| Thêm thư viện giải nén (`adm-zip`, `tar`) | `tar` của hệ điều hành đọc được `.tar.xz` trên Linux và `.zip` trên Windows 10+; không cần dependency mới |
| Lưu trạng thái "đang chạy" trong DB | Kẹt trạng thái sau khi app crash |
| Kill cứng khi đóng profile | Mất cookie chưa kịp ghi; chọn đóng êm rồi mới kill cứng sau 5 giây |
| Bảng ảo hóa (virtual list) cho 1.000 profile | Phân trang 50 dòng phía client đơn giản hơn và đủ dùng |
| Persona khác hệ điều hành máy thật | Spike cho thấy font máy thật lọt ra theo cả hai chiều |
| Unit test jest cho `DatabaseService` | `better-sqlite3` build cho Electron không nạp được dưới Node |

---

## Task 1: Model, cấu hình nhân trình duyệt và fingerprint

**Files:**
- Create: `src/models/browserProfile.ts`
- Create: `src/configs/browserEngine.config.ts`
- Create: `src/services/browser/fingerprint.ts`
- Test: `src/__tests__/browser/fingerprint.test.ts`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Consumes: không.
- Produces:
  - `BrowserFingerprint { seed: number; hardwareConcurrency: number; language: string; timezone: string }`
  - `BrowserProfile { id: string; name: string; group_id: number | null; proxy_id: number | null; fingerprint: BrowserFingerprint; note: string; last_opened_at: number | null; created_at: number; updated_at: number }`
  - `BrowserProfileGroup { id: number; name: string; color: string; sort_order: number; created_at: number }`
  - `BROWSER_ENGINE: BrowserEngineConfig`, `BrowserEngineConfig`, `BrowserEnginePackage`
  - `generateFingerprint(overrides?, random?): BrowserFingerprint`
  - `hostPersona(platform: NodeJS.Platform): 'windows' | 'linux' | null`
  - `buildLaunchArgs({ userDataDir, fingerprint, persona, proxyPort }): string[]`
  - `isValidTimezone(tz: string): boolean`, `isValidLanguage(lang: string): boolean`

- [ ] **Step 1: Tạo nhánh và thêm script test**

```bash
git checkout feat/browser-profiles
```

Nhánh này đã tồn tại và chứa sẵn tài liệu (intent, spec, kế hoạch, báo cáo spike). Nếu chưa có ở máy: `git fetch` rồi checkout.

Trong `package.json`, tìm dòng bắt đầu bằng `    "dev": "npm run build:electron` trong khối `"scripts"` và thêm dòng sau ngay phía trên nó:

```json
    "test": "jest",
```

- [ ] **Step 2: Tạo model**

Tạo `src/models/browserProfile.ts`:

```ts
export interface BrowserFingerprint {
    seed: number;
    hardwareConcurrency: number;
    language: string;
    timezone: string;
}

export interface BrowserProfile {
    id: string;
    name: string;
    group_id: number | null;
    proxy_id: number | null;
    fingerprint: BrowserFingerprint;
    note: string;
    last_opened_at: number | null;
    created_at: number;
    updated_at: number;
}

export interface BrowserProfileGroup {
    id: number;
    name: string;
    color: string;
    sort_order: number;
    created_at: number;
}
```

- [ ] **Step 3: Tạo cấu hình nhân trình duyệt**

Tạo `src/configs/browserEngine.config.ts`:

```ts
export interface BrowserEnginePackage {
    url: string;
    sha256: string;
    /** Path of the browser executable, relative to the extracted archive root. */
    executable: string;
}

export interface BrowserEngineConfig {
    version: string;
    packages: Partial<Record<NodeJS.Platform, BrowserEnginePackage>>;
}

const RELEASE_BASE = 'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215';

/** Pinned antidetect Chromium build. Changing the engine means changing only this file and buildLaunchArgs(). */
export const BROWSER_ENGINE: BrowserEngineConfig = {
    version: '148.0.7778.215',
    packages: {
        win32: {
            url: `${RELEASE_BASE}/ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip`,
            sha256: '9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579',
            executable: 'ungoogled-chromium_148.0.7778.215-1.1_windows_x64/chrome.exe',
        },
        linux: {
            url: `${RELEASE_BASE}/ungoogled-chromium-148.0.7778.215-1-x86_64_linux.tar.xz`,
            sha256: '70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4',
            executable: 'ungoogled-chromium-148.0.7778.215-1-x86_64_linux/chrome',
        },
    },
};
```

- [ ] **Step 4: Viết test trước**

Tạo `src/__tests__/browser/fingerprint.test.ts`:

```ts
import {
    buildLaunchArgs, generateFingerprint, hostPersona, isValidLanguage, isValidTimezone,
    HARDWARE_CONCURRENCY_CHOICES,
} from '../../services/browser/fingerprint';

describe('generateFingerprint', () => {
    it('produces values inside the allowed ranges with Vietnamese defaults', () => {
        for (let i = 0; i < 200; i++) {
            const fp = generateFingerprint();
            expect(Number.isInteger(fp.seed)).toBe(true);
            expect(fp.seed).toBeGreaterThanOrEqual(1);
            expect(fp.seed).toBeLessThanOrEqual(2147483647);
            expect(HARDWARE_CONCURRENCY_CHOICES).toContain(fp.hardwareConcurrency);
            expect(fp.language).toBe('vi-VN');
            expect(fp.timezone).toBe('Asia/Ho_Chi_Minh');
        }
    });

    it('stays in range at the extremes of the random source', () => {
        expect(generateFingerprint({}, () => 0).seed).toBe(1);
        const top = generateFingerprint({}, () => 0.9999999999);
        expect(top.seed).toBeLessThanOrEqual(2147483647);
        expect(top.hardwareConcurrency).toBe(16);
    });

    it('applies language and timezone overrides', () => {
        const fp = generateFingerprint({ language: 'en-US', timezone: 'America/New_York' });
        expect(fp.language).toBe('en-US');
        expect(fp.timezone).toBe('America/New_York');
    });
});

describe('hostPersona', () => {
    it('maps supported platforms and rejects the rest', () => {
        expect(hostPersona('win32')).toBe('windows');
        expect(hostPersona('linux')).toBe('linux');
        expect(hostPersona('darwin')).toBeNull();
    });
});

describe('validators', () => {
    it('accepts real timezones and rejects junk', () => {
        expect(isValidTimezone('Asia/Ho_Chi_Minh')).toBe(true);
        expect(isValidTimezone('Mars/Olympus')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
    });
    it('accepts BCP-47 style language tags only', () => {
        expect(isValidLanguage('vi-VN')).toBe(true);
        expect(isValidLanguage('en')).toBe(true);
        expect(isValidLanguage('vi-VN --no-sandbox')).toBe(false);
        expect(isValidLanguage('')).toBe(false);
    });
});

describe('buildLaunchArgs', () => {
    const fingerprint = { seed: 1234, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' };

    it('builds the full flag set without proxy', () => {
        expect(buildLaunchArgs({ userDataDir: '/data/p1', fingerprint, persona: 'linux', proxyPort: null })).toEqual([
            '--user-data-dir=/data/p1',
            '--fingerprint=1234',
            '--fingerprint-platform=linux',
            '--fingerprint-brand=Chrome',
            '--fingerprint-hardware-concurrency=8',
            '--lang=vi-VN',
            '--accept-lang=vi-VN,vi',
            '--timezone=Asia/Ho_Chi_Minh',
            '--no-first-run',
            '--no-default-browser-check',
        ]);
    });

    it('routes through the local forwarder and blocks non-proxied UDP when a proxy is set', () => {
        const args = buildLaunchArgs({ userDataDir: 'C:\\data\\p1', fingerprint, persona: 'windows', proxyPort: 45678 });
        expect(args).toContain('--fingerprint-platform=windows');
        expect(args).toContain('--proxy-server=http://127.0.0.1:45678');
        expect(args).toContain('--disable-non-proxied-udp');
    });

    it('never opens a remote debugging port', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint, persona: 'linux', proxyPort: 1 });
        expect(args.some((a) => a.startsWith('--remote-debugging'))).toBe(false);
    });

    it('does not duplicate a language that has no region', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint: { ...fingerprint, language: 'en' }, persona: 'linux', proxyPort: null });
        expect(args).toContain('--accept-lang=en');
    });
});
```

- [ ] **Step 5: Chạy test, xác nhận thất bại**

Run: `npx jest src/__tests__/browser/fingerprint.test.ts`
Expected: FAIL với `Cannot find module '../../services/browser/fingerprint'`.

- [ ] **Step 6: Viết implementation**

Tạo `src/services/browser/fingerprint.ts`:

```ts
import type { BrowserFingerprint } from '../../models/browserProfile';

export const HARDWARE_CONCURRENCY_CHOICES = [4, 8, 12, 16];
export const DEFAULT_LANGUAGE = 'vi-VN';
export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const MAX_SEED = 2147483647;

export type Persona = 'windows' | 'linux';

/** The persona always matches the host OS: the spike showed host fonts leak when they differ. */
export function hostPersona(platform: NodeJS.Platform): Persona | null {
    if (platform === 'win32') return 'windows';
    if (platform === 'linux') return 'linux';
    return null;
}

export function isValidTimezone(timezone: string): boolean {
    if (!timezone || typeof timezone !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

export function isValidLanguage(language: string): boolean {
    return typeof language === 'string' && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(language);
}

export function generateFingerprint(
    overrides: Partial<Pick<BrowserFingerprint, 'language' | 'timezone'>> = {},
    random: () => number = Math.random,
): BrowserFingerprint {
    return {
        seed: 1 + Math.floor(random() * (MAX_SEED - 1)),
        hardwareConcurrency: HARDWARE_CONCURRENCY_CHOICES[Math.floor(random() * HARDWARE_CONCURRENCY_CHOICES.length)],
        language: overrides.language || DEFAULT_LANGUAGE,
        timezone: overrides.timezone || DEFAULT_TIMEZONE,
    };
}

export interface LaunchOptions {
    userDataDir: string;
    fingerprint: BrowserFingerprint;
    persona: Persona;
    /** Port of the local ProxyForwarder, or null when the profile has no proxy. */
    proxyPort: number | null;
}

export function buildLaunchArgs(options: LaunchOptions): string[] {
    const { userDataDir, fingerprint, persona, proxyPort } = options;
    const baseLanguage = fingerprint.language.split('-')[0];
    const acceptLanguage = baseLanguage === fingerprint.language ? fingerprint.language : `${fingerprint.language},${baseLanguage}`;
    const args = [
        `--user-data-dir=${userDataDir}`,
        `--fingerprint=${fingerprint.seed}`,
        `--fingerprint-platform=${persona}`,
        '--fingerprint-brand=Chrome',
        `--fingerprint-hardware-concurrency=${fingerprint.hardwareConcurrency}`,
        `--lang=${fingerprint.language}`,
        `--accept-lang=${acceptLanguage}`,
        `--timezone=${fingerprint.timezone}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];
    if (proxyPort !== null) {
        args.push(`--proxy-server=http://127.0.0.1:${proxyPort}`, '--disable-non-proxied-udp');
    }
    return args;
}
```

- [ ] **Step 7: Chạy test, xác nhận qua**

Run: `npx jest src/__tests__/browser/fingerprint.test.ts`
Expected: PASS, `Tests: 10 passed, 10 total`.

- [ ] **Step 8: Commit**

```bash
git add package.json src/models/browserProfile.ts src/configs/browserEngine.config.ts src/services/browser/fingerprint.ts src/__tests__/browser/fingerprint.test.ts
git commit -m "feat(browser): add profile model, engine config and fingerprint builder"
```

---

## Task 2: ProxyForwarder

**Files:**
- Create: `src/services/browser/ProxyForwarder.ts`
- Test: `src/__tests__/browser/ProxyForwarder.test.ts`
- Modify: `package.json`, `package-lock.json` (khai báo `socks`)

**Interfaces:**
- Consumes: `ProxyConfig` từ `src/models/proxy.ts` (đã có).
- Produces:
  - `class ProxyForwarder { constructor(proxy: ProxyConfig); start(): Promise<number>; stop(): Promise<void> }`. `start()` trả về cổng đang lắng nghe trên `127.0.0.1`.
  - `openTunnel(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket>`
  - `splitHostPort(authority: string): { host: string; port: number } | null`

Ghi chú thiết kế:
- Trình duyệt gửi `CONNECT host:443` cho HTTPS và request có URL tuyệt đối cho HTTP thường. Forwarder xử lý cả hai.
- Proxy thật loại `http`/`https`: gửi `CONNECT` kèm header `Proxy-Authorization: Basic ...`. Loại `socks4`/`socks5`: dùng `SocksClient.createConnection` của gói `socks`.
- Với HTTP thường qua SOCKS, không truyền option `agent` cho `http.request`: Node chỉ dùng `createConnection` khi `agent` không được đặt (đã gặp lỗi này khi thử: request đi thẳng tới `127.0.0.1:80`).

- [ ] **Step 1: Khai báo dependency `socks`**

Gói `socks` 2.8.9 đã nằm trong `node_modules` (phụ thuộc của `socks-proxy-agent`). Khai báo tường minh để việc import không phụ thuộc vào hoisting:

```bash
npm install socks@^2.8.9
git diff --stat package.json package-lock.json
```

Expected: `package.json` có thêm dòng `"socks": "^2.8.9"` trong `dependencies`; không có gói nào mới được tải về.

- [ ] **Step 2: Viết test trước**

Tạo `src/__tests__/browser/ProxyForwarder.test.ts`. Test dựng ba máy chủ giả trên `127.0.0.1`: máy đích, proxy HTTP yêu cầu Basic auth, và proxy SOCKS5 yêu cầu username/password.

```ts
import * as http from 'http';
import * as net from 'net';
import { ProxyForwarder, splitHostPort } from '../../services/browser/ProxyForwarder';
import type { ProxyConfig } from '../../models/proxy';

const USER = 'ahv user';
const PASS = 'p@ss:word/1';
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

function listen(server: net.Server): Promise<number> {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}
function close(server: net.Server): Promise<void> {
    return new Promise((resolve) => {
        (server as any).closeAllConnections?.();
        server.close(() => resolve());
    });
}

/** Target web server: answers every request with "hello <path>". */
function createTarget(): http.Server {
    return http.createServer((req, res) => res.end(`hello ${req.url}`));
}

/** Fake upstream HTTP proxy that requires Basic auth and records what it saw. */
function createHttpUpstream(seen: { auth: string[] }): http.Server {
    const server = http.createServer((req, res) => {
        seen.auth.push(String(req.headers['proxy-authorization']));
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) { res.writeHead(407).end(); return; }
        const url = new URL(req.url!);
        const forward = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method }, (r) => {
            res.writeHead(r.statusCode!, r.headers); r.pipe(res);
        });
        req.pipe(forward);
    });
    server.on('connect', (req, socket) => {
        seen.auth.push(String(req.headers['proxy-authorization']));
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
        const [host, port] = req.url!.split(':');
        const target = net.connect(Number(port), host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            target.pipe(socket); socket.pipe(target);
        });
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
    });
    return server;
}

/** Minimal SOCKS5 server with username/password auth (RFC 1928 / 1929), CONNECT only. */
function createSocks5Upstream(seen: { credentials: string[] }): net.Server {
    return net.createServer((client) => {
        let stage = 0;
        client.on('error', () => undefined);
        client.on('data', function onData(chunk: Buffer) {
            if (stage === 0) { stage = 1; client.write(Buffer.from([5, 2])); return; }
            if (stage === 1) {
                const userLength = chunk[1];
                const user = chunk.subarray(2, 2 + userLength).toString();
                const pass = chunk.subarray(3 + userLength, 3 + userLength + chunk[2 + userLength]).toString();
                seen.credentials.push(`${user}:${pass}`);
                const ok = user === USER && pass === PASS;
                client.write(Buffer.from([1, ok ? 0 : 1]));
                if (!ok) client.end();
                stage = 2;
                return;
            }
            if (stage === 2) {
                stage = 3;
                let host: string; let offset: number;
                if (chunk[3] === 1) { host = Array.from(chunk.subarray(4, 8)).join('.'); offset = 8; }
                else { host = chunk.subarray(5, 5 + chunk[4]).toString(); offset = 5 + chunk[4]; }
                const port = chunk.readUInt16BE(offset);
                client.removeListener('data', onData);
                const target = net.connect(port, host, () => {
                    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                    target.pipe(client); client.pipe(target);
                });
                target.on('error', () => client.destroy());
            }
        });
    });
}

/** Sends CONNECT to the forwarder, then a raw GET through the tunnel. Resolves with status line + body. */
function connectThrough(forwarderPort: number, targetPort: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: forwarderPort, method: 'CONNECT', path: `127.0.0.1:${targetPort}` });
        req.once('connect', (res, socket) => {
            if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode!, body: '' }); return; }
            let body = '';
            socket.on('data', (d) => { body += d.toString(); });
            socket.on('end', () => resolve({ status: 200, body }));
            socket.on('error', reject);
            socket.write(`GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
        });
        req.once('error', reject);
        req.end();
    });
}

/** Plain HTTP request through the forwarder (absolute URL in the request line). */
function getThrough(forwarderPort: number, targetPort: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: forwarderPort, method: 'GET', path: `http://127.0.0.1:${targetPort}/plain?x=1` }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d.toString(); });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.once('error', reject);
        req.end();
    });
}

function proxyConfig(type: ProxyConfig['type'], port: number, password = PASS): ProxyConfig {
    return { id: 1, name: 'test', type, host: '127.0.0.1', port, username: USER, password };
}

describe('splitHostPort', () => {
    it('parses hostnames, IPv4 and bracketed IPv6', () => {
        expect(splitHostPort('example.com:443')).toEqual({ host: 'example.com', port: 443 });
        expect(splitHostPort('[::1]:8443')).toEqual({ host: '::1', port: 8443 });
    });
    it('rejects malformed authorities', () => {
        expect(splitHostPort('example.com')).toBeNull();
        expect(splitHostPort('example.com:0')).toBeNull();
        expect(splitHostPort('example.com:99999')).toBeNull();
        expect(splitHostPort('')).toBeNull();
    });
});

describe('ProxyForwarder', () => {
    let target: http.Server; let targetPort: number;
    let forwarder: ProxyForwarder | null = null;
    const servers: net.Server[] = [];

    beforeEach(async () => { target = createTarget(); targetPort = await listen(target); });
    afterEach(async () => {
        if (forwarder) { await forwarder.stop(); forwarder = null; }
        await close(target);
        while (servers.length) await close(servers.pop()!);
    });

    it('listens on loopback only', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        await forwarder.start();
        expect(((forwarder as any).server.address() as net.AddressInfo).address).toBe('127.0.0.1');
    });

    it('tunnels CONNECT through an HTTP upstream with credentials containing special characters', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const result = await connectThrough(await forwarder.start(), targetPort);
        expect(result.status).toBe(200);
        expect(result.body).toContain('hello /tunnel');
        expect(seen.auth).toEqual([EXPECTED_AUTH]);
    });

    it('relays plain HTTP through an HTTP upstream', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const result = await getThrough(await forwarder.start(), targetPort);
        expect(result).toEqual({ status: 200, body: 'hello /plain?x=1' });
        expect(seen.auth).toEqual([EXPECTED_AUTH]);
    });

    it('answers 502 and never connects directly when the upstream rejects the password', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream), 'wrong'));
        const port = await forwarder.start();
        expect((await connectThrough(port, targetPort)).status).toBe(502);
    });

    it('answers 502 for CONNECT and plain HTTP when the upstream is down', async () => {
        const dead = net.createServer(); const deadPort = await listen(dead); await close(dead);
        let targetHits = 0;
        target.on('request', () => { targetHits++; });
        forwarder = new ProxyForwarder(proxyConfig('http', deadPort));
        const port = await forwarder.start();
        expect((await connectThrough(port, targetPort)).status).toBe(502);
        expect((await getThrough(port, targetPort)).status).toBe(502);
        expect(targetHits).toBe(0);
    });

    it('tunnels CONNECT and plain HTTP through a SOCKS5 upstream with username/password', async () => {
        const seen = { credentials: [] as string[] };
        const upstream = createSocks5Upstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('socks5', await listen(upstream)));
        const port = await forwarder.start();
        const tunneled = await connectThrough(port, targetPort);
        expect(tunneled.body).toContain('hello /tunnel');
        expect(await getThrough(port, targetPort)).toEqual({ status: 200, body: 'hello /plain?x=1' });
        expect(seen.credentials).toEqual([`${USER}:${PASS}`, `${USER}:${PASS}`]);
    });

    it('answers 502 when the SOCKS5 upstream rejects the password', async () => {
        const seen = { credentials: [] as string[] };
        const upstream = createSocks5Upstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('socks5', await listen(upstream), 'wrong'));
        expect((await connectThrough(await forwarder.start(), targetPort)).status).toBe(502);
    });

    it('rejects a malformed CONNECT target with 400', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const port = await forwarder.start();
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: 'no-port' });
            req.once('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode!); });
            req.once('error', reject);
            req.end();
        });
        expect(status).toBe(400);
        expect(seen.auth).toEqual([]);
    });

    it('stop() closes the listener and open tunnels', async () => {
        const seen = { auth: [] as string[] };
        const upstream = createHttpUpstream(seen); servers.push(upstream);
        forwarder = new ProxyForwarder(proxyConfig('http', await listen(upstream)));
        const port = await forwarder.start();
        const closed = new Promise<void>((resolve) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${targetPort}` });
            req.once('connect', (_res, socket) => { socket.on('error', () => undefined); socket.once('close', () => resolve()); forwarder!.stop(); });
            req.end();
        });
        await closed;
        await expect(connectThrough(port, targetPort)).rejects.toThrow();
        forwarder = null;
    });
});
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

Run: `npx jest src/__tests__/browser/ProxyForwarder.test.ts`
Expected: FAIL với `Cannot find module '../../services/browser/ProxyForwarder'`.

- [ ] **Step 4: Viết implementation**

Tạo `src/services/browser/ProxyForwarder.ts`:

```ts
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { SocksClient } from 'socks';
import type { ProxyConfig } from '../../models/proxy';

const UPSTREAM_TIMEOUT_MS = 30000;

function proxyAuthorization(proxy: ProxyConfig): string | null {
    if (!proxy.username) return null;
    return 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
}

function isSocks(proxy: ProxyConfig): boolean {
    return proxy.type === 'socks4' || proxy.type === 'socks5';
}

/** Splits "host:port" / "[ipv6]:port" as sent in a CONNECT request line. */
export function splitHostPort(authority: string): { host: string; port: number } | null {
    const index = (authority || '').lastIndexOf(':');
    if (index <= 0) return null;
    const host = authority.slice(0, index).replace(/^\[|\]$/g, '');
    const port = Number(authority.slice(index + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
}

/** Opens a raw TCP tunnel to host:port through the upstream proxy, authenticating if needed. */
export function openTunnel(proxy: ProxyConfig, host: string, port: number): Promise<net.Socket> {
    if (isSocks(proxy)) {
        return SocksClient.createConnection({
            proxy: {
                host: proxy.host,
                port: proxy.port,
                type: proxy.type === 'socks5' ? 5 : 4,
                userId: proxy.username || undefined,
                password: proxy.password || undefined,
            },
            command: 'connect',
            destination: { host, port },
            timeout: UPSTREAM_TIMEOUT_MS,
        }).then((result) => result.socket);
    }

    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { Host: `${host}:${port}` };
        const auth = proxyAuthorization(proxy);
        if (auth) headers['Proxy-Authorization'] = auth;
        const request = (proxy.type === 'https' ? https : http).request({
            host: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers,
            timeout: UPSTREAM_TIMEOUT_MS,
        });
        request.once('connect', (response, socket, head) => {
            if (response.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`Upstream proxy refused CONNECT with status ${response.statusCode}`));
                return;
            }
            if (head && head.length) socket.unshift(head);
            resolve(socket);
        });
        request.once('response', (response) => {
            response.resume();
            reject(new Error(`Upstream proxy answered CONNECT with status ${response.statusCode}`));
        });
        request.once('timeout', () => request.destroy(new Error('Upstream proxy timed out')));
        request.once('error', reject);
        request.end();
    });
}

/**
 * Local HTTP proxy bound to 127.0.0.1 that relays every connection to one upstream proxy.
 * Exists because the browser engine cannot take proxy credentials on its command line.
 * It never falls back to a direct connection: an upstream failure is answered with 502.
 */
export class ProxyForwarder {
    private server: http.Server | null = null;
    private readonly sockets = new Set<net.Socket>();

    constructor(private readonly proxy: ProxyConfig) {}

    public start(): Promise<number> {
        const server = http.createServer((request, response) => this.handleRequest(request, response));
        server.on('connect', (request, socket, head) => this.handleConnect(request, socket as net.Socket, head));
        server.on('connection', (socket) => this.track(socket));
        this.server = server;
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
    }

    public stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (!server) return Promise.resolve();
        return new Promise((resolve) => server.close(() => resolve()));
    }

    private track(socket: net.Socket): void {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
    }

    private handleConnect(request: http.IncomingMessage, client: net.Socket, head: Buffer): void {
        client.on('error', () => undefined);
        const target = splitHostPort(request.url || '');
        if (!target) {
            client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        openTunnel(this.proxy, target.host, target.port).then((upstream) => {
            if (client.destroyed || !this.server) {
                upstream.destroy();
                return;
            }
            this.track(upstream);
            upstream.on('error', () => client.destroy());
            upstream.once('close', () => client.destroy());
            client.once('close', () => upstream.destroy());
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        }).catch(() => {
            if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
    }

    private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
        let target: URL;
        try {
            target = new URL(request.url || '');
        } catch {
            response.writeHead(400).end();
            return;
        }
        if (target.protocol !== 'http:') {
            response.writeHead(400).end();
            return;
        }
        const fail = () => {
            if (!response.headersSent) response.writeHead(502);
            response.end();
        };
        const headers = { ...request.headers };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];

        const relay = (options: http.RequestOptions, transport: typeof http | typeof https) => {
            const upstream = transport.request(options, (upstreamResponse) => {
                response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
                upstreamResponse.on('error', () => response.destroy());
                upstreamResponse.pipe(response);
            });
            upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('Upstream proxy timed out')));
            upstream.on('error', fail);
            request.pipe(upstream);
        };

        if (isSocks(this.proxy)) {
            const port = Number(target.port) || 80;
            openTunnel(this.proxy, target.hostname, port).then((socket) => {
                if (!this.server) {
                    socket.destroy();
                    fail();
                    return;
                }
                this.track(socket);
                relay({
                    method: request.method,
                    path: `${target.pathname}${target.search}`,
                    headers,
                    // No `agent` here: Node only honours createConnection when the agent option is unset.
                    createConnection: () => socket,
                }, http);
            }).catch(fail);
            return;
        }

        const auth = proxyAuthorization(this.proxy);
        if (auth) headers['proxy-authorization'] = auth;
        relay({
            host: this.proxy.host,
            port: this.proxy.port,
            method: request.method,
            path: request.url,
            headers,
            agent: false,
        }, this.proxy.type === 'https' ? https : http);
    }
}
```

> Lưu ý (post-review hardening): `upstream.on('error')` thay cho `once` để lỗi thứ hai không bị unhandled; `upstreamResponse` lỗi giữa chừng sẽ destroy response phía trình duyệt; nhánh SOCKS kiểm tra `this.server` sau handshake để không rò socket khi `stop()` đã chạy.

- [ ] **Step 5: Chạy test, xác nhận qua**

Run: `npx jest src/__tests__/browser/ProxyForwarder.test.ts`
Expected: PASS, `Tests: 11 passed, 11 total`. Chạy lại 3 lần để chắc không chập chờn.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/services/browser/ProxyForwarder.ts src/__tests__/browser/ProxyForwarder.test.ts
git commit -m "feat(browser): add local proxy forwarder with upstream authentication"
```

---

## Task 3: BrowserEngineManager

**Files:**
- Create: `src/services/browser/BrowserEngineManager.ts`
- Test: `src/__tests__/browser/BrowserEngineManager.test.ts`

**Interfaces:**
- Consumes: `BROWSER_ENGINE`, `BrowserEngineConfig`, `BrowserEnginePackage` từ `src/configs/browserEngine.config.ts` (Task 1).
- Produces:
  - `class BrowserEngineManager { constructor(baseDir: string, platform?: NodeJS.Platform, deps?: EngineDeps, config?: BrowserEngineConfig); getStatus(): EngineStatus; getExecutablePath(): string | null; install(onProgress?: (p: EngineProgress) => void): Promise<void> }`
  - `EngineStatus { supported: boolean; installed: boolean; version: string }`
  - `EngineProgress { received: number; total: number }`
  - `EngineDeps { download(url, destination, onProgress?): Promise<void>; extract(archive, directory): Promise<void> }`

Ghi chú thiết kế:
- Thư mục cài: `<baseDir>/<version>/`. File đánh dấu `installed.json` chỉ được ghi sau khi SHA-256 đúng, giải nén xong và file chạy tồn tại. Không có file đánh dấu thì coi như chưa cài.
- `download` và `extract` truyền vào được để test không cần mạng. Mặc định: tải bằng `axios` dạng stream; giải nén bằng lệnh `tar -xf` của hệ điều hành.
- Gia cố sau review: (1) trên Windows dùng bsdtar có sẵn tại `%SystemRoot%\System32\tar.exe`, không dùng `tar` đầu tiên trên PATH vì GNU tar của Git-for-Windows không đọc được .zip và hiểu sai `C:\...`; (2) `downloadFile` (export, nhận tham số idle timeout tùy chọn, mặc định 60 giây) hủy tải nếu không nhận được dữ liệu, kèm timeout socket của axios; (3) dùng `stream.pipeline` để khi lỗi hoặc đứt kết nối sớm thì đóng cả stream ghi và stream nhận, đợi file đóng hẳn trước khi trả lỗi để `rmSync(archive)` không bị EBUSY trên Windows; (4) `tar` ghi lại tối đa 500 ký tự stderr cuối vào thông báo lỗi và chờ sự kiện `close`.

- [ ] **Step 1: Viết test trước**

Tạo `src/__tests__/browser/BrowserEngineManager.test.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { BrowserEngineManager, EngineDeps, downloadFile } from '../../services/browser/BrowserEngineManager';
import type { BrowserEngineConfig } from '../../configs/browserEngine.config';

const ARCHIVE_BYTES = Buffer.from('fake engine archive');
const GOOD_SHA = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

function makeConfig(sha256 = GOOD_SHA): BrowserEngineConfig {
    return { version: '1.2.3', packages: { linux: { url: 'https://example.invalid/engine.tar.xz', sha256, executable: 'engine/chrome' } } };
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps & { downloads: number } {
    const deps = {
        downloads: 0,
        download: async (_url: string, destination: string, onProgress?: (p: { received: number; total: number }) => void) => {
            deps.downloads++;
            fs.writeFileSync(destination, ARCHIVE_BYTES);
            onProgress?.({ received: ARCHIVE_BYTES.length, total: ARCHIVE_BYTES.length });
        },
        extract: async (_archive: string, directory: string) => {
            fs.mkdirSync(path.join(directory, 'engine'), { recursive: true });
            fs.writeFileSync(path.join(directory, 'engine', 'chrome'), '#!/bin/sh\n');
        },
        ...overrides,
    };
    return deps;
}

describe('BrowserEngineManager', () => {
    let baseDir: string;
    beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-')); });
    afterEach(() => { fs.rmSync(baseDir, { recursive: true, force: true }); });

    it('reports an unsupported platform and refuses to install', async () => {
        const manager = new BrowserEngineManager(baseDir, 'darwin', makeDeps(), makeConfig());
        expect(manager.getStatus()).toEqual({ supported: false, installed: false, version: '1.2.3' });
        expect(manager.getExecutablePath()).toBeNull();
        await expect(manager.install()).rejects.toThrow('chưa được hỗ trợ');
    });

    it('installs, reports progress and returns the executable path', async () => {
        const progress: number[] = [];
        const manager = new BrowserEngineManager(baseDir, 'linux', makeDeps(), makeConfig());
        expect(manager.getStatus().installed).toBe(false);
        await manager.install((p) => progress.push(p.received));
        const executable = path.join(baseDir, '1.2.3', 'engine', 'chrome');
        expect(manager.getExecutablePath()).toBe(executable);
        expect(manager.getStatus().installed).toBe(true);
        expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
        expect(progress).toEqual([ARCHIVE_BYTES.length]);
        expect(fs.existsSync(path.join(baseDir, '1.2.3', 'engine.download'))).toBe(false);
    });

    it('rejects a download whose SHA-256 does not match and leaves nothing installed', async () => {
        let extracted = false;
        const deps = makeDeps({ extract: async () => { extracted = true; } });
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig('0'.repeat(64)));
        await expect(manager.install()).rejects.toThrow('SHA-256');
        expect(extracted).toBe(false);
        expect(manager.getExecutablePath()).toBeNull();
        expect(fs.existsSync(path.join(baseDir, '1.2.3', 'engine.download'))).toBe(false);
    });

    it('treats an extraction without the marker file as not installed and reinstalls cleanly', async () => {
        const versionDir = path.join(baseDir, '1.2.3');
        fs.mkdirSync(path.join(versionDir, 'engine'), { recursive: true });
        fs.writeFileSync(path.join(versionDir, 'engine', 'chrome'), 'half extracted');
        const deps = makeDeps();
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        expect(manager.getExecutablePath()).toBeNull();
        await manager.install();
        expect(deps.downloads).toBe(1);
        expect(fs.readFileSync(manager.getExecutablePath()!, 'utf8')).toBe('#!/bin/sh\n');
    });

    it('fails when the archive does not contain the expected executable', async () => {
        const manager = new BrowserEngineManager(baseDir, 'linux', makeDeps({ extract: async () => undefined }), makeConfig());
        await expect(manager.install()).rejects.toThrow('Không tìm thấy tệp chạy');
        expect(manager.getExecutablePath()).toBeNull();
    });

    it('shares one download between concurrent install calls and skips when already installed', async () => {
        const deps = makeDeps();
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        await Promise.all([manager.install(), manager.install()]);
        await manager.install();
        expect(deps.downloads).toBe(1);
    });

    it('can retry after a failed download', async () => {
        let attempt = 0;
        const good = makeDeps();
        const deps = makeDeps({
            download: async (url, destination, onProgress) => {
                if (attempt++ === 0) throw new Error('network down');
                await good.download(url, destination, onProgress);
            },
        });
        const manager = new BrowserEngineManager(baseDir, 'linux', deps, makeConfig());
        await expect(manager.install()).rejects.toThrow('network down');
        await manager.install();
        expect(manager.getExecutablePath()).not.toBeNull();
    });
});

describe('downloadFile', () => {
    let dir: string;
    let server: http.Server;
    let sockets: Set<import('net').Socket>;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-test-'));
        sockets = new Set();
    });
    afterEach(async () => {
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function serve(handler: http.RequestListener): Promise<string> {
        server = http.createServer(handler);
        server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}/engine`;
    }

    it('downloads a body and reports progress', async () => {
        const body = Buffer.from('hello engine');
        const url = await serve((_req, res) => { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); });
        const destination = path.join(dir, 'out');
        const reports: Array<{ received: number; total: number }> = [];
        await downloadFile(url, destination, (p) => reports.push(p), 5000);
        expect(fs.readFileSync(destination)).toEqual(body);
        expect(reports[reports.length - 1]).toEqual({ received: body.length, total: body.length });
    });

    it('rejects on an HTTP error status', async () => {
        const url = await serve((_req, res) => { res.writeHead(404); res.end(); });
        await expect(downloadFile(url, path.join(dir, 'out'), undefined, 5000)).rejects.toThrow();
    });

    it('rejects when the connection closes before Content-Length bytes arrive and releases the file', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { 'Content-Length': 1000 });
            res.write('partial', () => res.destroy());
        });
        const destination = path.join(dir, 'out');
        await expect(downloadFile(url, destination, undefined, 5000)).rejects.toThrow();
        expect(() => fs.rmSync(destination, { force: true })).not.toThrow();
    });

    it('rejects after the idle timeout when the server stalls mid-body', async () => {
        const url = await serve((_req, res) => {
            res.writeHead(200, { 'Content-Length': 1000 });
            res.write('first chunk');
        });
        const destination = path.join(dir, 'out');
        await expect(downloadFile(url, destination, undefined, 200)).rejects.toThrow('không nhận được dữ liệu');
        expect(() => fs.rmSync(destination, { force: true })).not.toThrow();
    });
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `npx jest src/__tests__/browser/BrowserEngineManager.test.ts`
Expected: FAIL với `Cannot find module '../../services/browser/BrowserEngineManager'`.

- [ ] **Step 3: Viết implementation**

Tạo `src/services/browser/BrowserEngineManager.ts`:

```ts
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { BROWSER_ENGINE, BrowserEngineConfig, BrowserEnginePackage } from '../../configs/browserEngine.config';

export interface EngineProgress {
    received: number;
    total: number;
}

export interface EngineStatus {
    supported: boolean;
    installed: boolean;
    version: string;
}

export interface EngineDeps {
    download: (url: string, destination: string, onProgress?: (progress: EngineProgress) => void) => Promise<void>;
    extract: (archive: string, directory: string) => Promise<void>;
}

const MARKER_FILE = 'installed.json';
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const SOCKET_TIMEOUT_GRACE_MS = 5_000;
const STDERR_TAIL_CHARS = 500;

export async function downloadFile(
    url: string,
    destination: string,
    onProgress?: (progress: EngineProgress) => void,
    idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
    // axios applies this as a socket idle timeout (connect/headers and body); the grace lets our idle timer report first.
    const response = await axios.get(url, { responseType: 'stream', maxRedirects: 5, timeout: idleTimeoutMs + SOCKET_TIMEOUT_GRACE_MS });
    const total = Number(response.headers['content-length']) || 0;
    const source: Readable = response.data;
    const file = fs.createWriteStream(destination);
    let received = 0;
    let timer: NodeJS.Timeout | undefined;
    const armIdleTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => source.destroy(new Error('Tải nhân trình duyệt bị ngắt: không nhận được dữ liệu')), idleTimeoutMs);
    };
    source.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress?.({ received, total });
        armIdleTimer();
    });
    armIdleTimer();
    try {
        // pipeline rejects on error or premature close, and destroys both streams.
        await pipeline(source, file);
    } finally {
        clearTimeout(timer);
        source.destroy();
        file.destroy();
        // Wait until the file handle is released so the caller can delete the archive on Windows.
        if (!file.closed) await new Promise<void>((resolve) => file.once('close', () => resolve()));
    }
}

/** Windows ships bsdtar in System32; a Git-for-Windows GNU tar earlier on PATH cannot read .zip. */
function tarCommand(): string {
    return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/** `tar` reads .tar.xz on Linux and .zip on Windows 10+ (bsdtar), so no archive dependency is needed. */
function extractArchive(archive: string, directory: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(tarCommand(), ['-xf', archive, '-C', directory], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS); });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) return resolve();
            const detail = stderr.trim();
            reject(new Error(`Giải nén thất bại (tar exit ${code})${detail ? `: ${detail}` : ''}`));
        });
    });
}

function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .once('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .once('end', () => resolve(hash.digest('hex')));
    });
}

/** Locates, downloads and verifies the pinned antidetect Chromium build under <baseDir>/<version>/. */
export class BrowserEngineManager {
    private installing: Promise<void> | null = null;

    constructor(
        private readonly baseDir: string,
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly deps: EngineDeps = { download: downloadFile, extract: extractArchive },
        private readonly config: BrowserEngineConfig = BROWSER_ENGINE,
    ) {}

    private get enginePackage(): BrowserEnginePackage | undefined {
        return this.config.packages[this.platform];
    }

    private get versionDir(): string {
        return path.join(this.baseDir, this.config.version);
    }

    public getStatus(): EngineStatus {
        return {
            supported: !!this.enginePackage,
            installed: this.getExecutablePath() !== null,
            version: this.config.version,
        };
    }

    /** Absolute path of the browser executable, or null when the engine is not fully installed. */
    public getExecutablePath(): string | null {
        const enginePackage = this.enginePackage;
        if (!enginePackage) return null;
        const executable = path.join(this.versionDir, enginePackage.executable);
        if (!fs.existsSync(path.join(this.versionDir, MARKER_FILE)) || !fs.existsSync(executable)) return null;
        return executable;
    }

    /** Concurrent callers share one installation. */
    public install(onProgress?: (progress: EngineProgress) => void): Promise<void> {
        if (!this.installing) {
            this.installing = this.doInstall(onProgress).finally(() => { this.installing = null; });
        }
        return this.installing;
    }

    private async doInstall(onProgress?: (progress: EngineProgress) => void): Promise<void> {
        const enginePackage = this.enginePackage;
        if (!enginePackage) throw new Error('Hệ điều hành này chưa được hỗ trợ');
        if (this.getExecutablePath()) return;

        // Wipe leftovers of an interrupted download or extraction.
        fs.rmSync(this.versionDir, { recursive: true, force: true });
        fs.mkdirSync(this.versionDir, { recursive: true });
        const archive = path.join(this.versionDir, 'engine.download');
        try {
            await this.deps.download(enginePackage.url, archive, onProgress);
            const actual = await sha256File(archive);
            if (actual !== enginePackage.sha256) {
                throw new Error('Tệp tải về không khớp mã kiểm tra SHA-256, đã hủy cài đặt');
            }
            await this.deps.extract(archive, this.versionDir);
            const executable = path.join(this.versionDir, enginePackage.executable);
            if (!fs.existsSync(executable)) throw new Error('Không tìm thấy tệp chạy của trình duyệt sau khi giải nén');
            if (this.platform !== 'win32') fs.chmodSync(executable, 0o755);
            fs.writeFileSync(
                path.join(this.versionDir, MARKER_FILE),
                JSON.stringify({ version: this.config.version, installedAt: Date.now() }),
            );
        } finally {
            fs.rmSync(archive, { force: true });
        }
    }
}
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `npx jest src/__tests__/browser/BrowserEngineManager.test.ts`
Expected: PASS, `Tests: 11 passed, 11 total`.

- [ ] **Step 5: Commit**

```bash
git add src/services/browser/BrowserEngineManager.ts src/__tests__/browser/BrowserEngineManager.test.ts
git commit -m "feat(browser): add engine manager with checksum-verified install"
```

---

## Task 4: BrowserProfileService

**Files:**
- Create: `src/services/browser/BrowserProfileService.ts`
- Test: `src/__tests__/browser/BrowserProfileService.test.ts`

**Interfaces:**
- Consumes: `buildLaunchArgs`, `hostPersona` (Task 1); `ProxyForwarder` (Task 2); `BrowserProfile`; `ProxyConfig`.
- Produces:
  - `MAX_RUNNING_PROFILES = 30`, `FORCE_KILL_DELAY_MS = 5000`
  - `class BrowserProfileService { constructor(deps: BrowserProfileServiceDeps); open(id: string): Promise<void>; close(id: string): void; closeAll(): void; getRunningIds(): string[]; isRunning(id: string): boolean; getProfileDir(id: string): string }`
  - `BrowserProfileServiceDeps { store: ProfileStore; getExecutablePath: () => string | null; getProfilesDir: () => string; platform?; spawnBrowser?; createForwarder?; terminate?; onStatusChanged?: (runningIds: string[]) => void }`
  - `ProfileStore { getBrowserProfileById(id: string): BrowserProfile | null; getProxyById(id: number): ProxyConfig | null; touchBrowserProfileOpened(id: string): void }`
  - `open()` ném `Error` với thông điệp tiếng Việt; IPC chuyển nguyên thông điệp cho giao diện.

Ghi chú thiết kế:
- `open()` đặt chỗ trong map **trước** lệnh `await` đầu tiên, để lần gọi thứ hai cho cùng profile bị từ chối ngay cả khi lần đầu còn đang khởi động.
- `open()` chờ sự kiện `spawn` của tiến trình con. Nếu file chạy không tồn tại, Node phát `error` bất đồng bộ; khi đó service dọn forwarder và ném lỗi.
- `close()` yêu cầu thoát êm (`SIGTERM` trên Linux; `taskkill /pid <pid> /T` trên Windows), sau `FORCE_KILL_DELAY_MS` nếu vẫn còn chạy mới kill cứng. Trạng thái chỉ được xóa khi tiến trình phát `exit`.
- `closeAll()` dùng khi thoát app hoặc chuyển workspace: yêu cầu thoát êm rồi xóa trạng thái ngay, không chờ; từng trình duyệt vẫn bị kill cứng sau `FORCE_KILL_DELAY_MS` nếu chưa thoát.

**Ghi chú sau review (Task 4):** `close()` khi profile còn đang khởi động trước đây bị bỏ qua âm thầm; nay đặt cờ `closeRequested` và `open()` đóng trình duyệt ngay sau khi spawn. `closeAll()` giữa lúc `open()` đang chờ forwarder/spawn nay hủy `open()` (ném `Đã hủy mở trình duyệt`, kill cứng trình duyệt vừa spawn, dừng forwarder, không ghi `last_opened_at` vào DB workspace mới). `closeAll()` có kill cứng dự phòng như `close()`; timer lưu trên entry nên gọi `close()` lặp lại không chồng timer. Lỗi `touchBrowserProfileOpened` chỉ ghi `console.warn`, không làm `open()` thất bại.

- [ ] **Step 1: Viết test trước**

Tạo `src/__tests__/browser/BrowserProfileService.test.ts`:

```ts
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BrowserProcess, BrowserProfileService, BrowserProfileServiceDeps, FORCE_KILL_DELAY_MS, MAX_RUNNING_PROFILES,
} from '../../services/browser/BrowserProfileService';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';

class FakeChild extends EventEmitter implements BrowserProcess {
    pid = 4242;
    kill(): boolean { return true; }
}

function makeProfile(id: string, proxyId: number | null = null): BrowserProfile {
    return {
        id, name: `Profile ${id}`, group_id: null, proxy_id: proxyId, note: '',
        fingerprint: { seed: 7, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
        last_opened_at: null, created_at: 0, updated_at: 0,
    };
}

const PROXY: ProxyConfig = { id: 5, name: 'p', type: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: 'p' };

interface Harness {
    service: BrowserProfileService;
    children: FakeChild[];
    spawned: Array<{ executable: string; args: string[] }>;
    forwarders: Array<{ started: boolean; stopped: boolean }>;
    terminated: Array<{ child: BrowserProcess; force: boolean }>;
    touched: string[];
    statuses: string[][];
    profilesDir: string;
}

function makeHarness(options: {
    profiles?: BrowserProfile[];
    proxies?: ProxyConfig[];
    executable?: string | null;
    platform?: NodeJS.Platform;
    spawnFails?: boolean;
    forwarderFails?: boolean;
} = {}): Harness {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
    const harness: Harness = {
        service: null as any, children: [], spawned: [], forwarders: [], terminated: [], touched: [], statuses: [], profilesDir,
    };
    const profiles = options.profiles || [makeProfile('a'), makeProfile('b')];
    const deps: BrowserProfileServiceDeps = {
        store: {
            getBrowserProfileById: (id) => profiles.find((p) => p.id === id) || null,
            getProxyById: (id) => (options.proxies || [PROXY]).find((p) => p.id === id) || null,
            touchBrowserProfileOpened: (id) => { harness.touched.push(id); },
        },
        getExecutablePath: () => (options.executable === undefined ? '/engine/chrome' : options.executable),
        getProfilesDir: () => profilesDir,
        platform: options.platform || 'linux',
        spawnBrowser: (executable, args) => {
            const child = new FakeChild();
            harness.children.push(child);
            harness.spawned.push({ executable, args });
            setImmediate(() => (options.spawnFails ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
            return child;
        },
        createForwarder: () => {
            const record = { started: false, stopped: false };
            harness.forwarders.push(record);
            return {
                start: async () => {
                    if (options.forwarderFails) throw new Error('EADDRINUSE');
                    record.started = true;
                    return 34567;
                },
                stop: async () => { record.stopped = true; },
            };
        },
        terminate: (child, force) => { harness.terminated.push({ child, force }); },
        onStatusChanged: (ids) => { harness.statuses.push(ids); },
    };
    harness.service = new BrowserProfileService(deps);
    return harness;
}

describe('BrowserProfileService', () => {
    const harnesses: Harness[] = [];
    const create = (options?: Parameters<typeof makeHarness>[0]) => {
        const harness = makeHarness(options);
        harnesses.push(harness);
        return harness;
    };
    afterEach(() => {
        jest.useRealTimers();
        while (harnesses.length) fs.rmSync(harnesses.pop()!.profilesDir, { recursive: true, force: true });
    });

    it('opens a profile without proxy: spawns the engine with the profile data dir and marks it running', async () => {
        const h = create();
        await h.service.open('a');
        expect(h.spawned).toHaveLength(1);
        expect(h.spawned[0].executable).toBe('/engine/chrome');
        expect(h.spawned[0].args).toContain(`--user-data-dir=${path.join(h.profilesDir, 'a')}`);
        expect(h.spawned[0].args).toContain('--fingerprint=7');
        expect(h.spawned[0].args.some((a) => a.startsWith('--proxy-server'))).toBe(false);
        expect(fs.existsSync(path.join(h.profilesDir, 'a'))).toBe(true);
        expect(h.forwarders).toHaveLength(0);
        expect(h.service.getRunningIds()).toEqual(['a']);
        expect(h.touched).toEqual(['a']);
        expect(h.statuses).toEqual([['a']]);
    });

    it('opens a profile with proxy through a local forwarder', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        await h.service.open('a');
        expect(h.forwarders).toEqual([{ started: true, stopped: false }]);
        expect(h.spawned[0].args).toContain('--proxy-server=http://127.0.0.1:34567');
        expect(h.spawned[0].args).toContain('--disable-non-proxied-udp');
    });

    it('refuses to open a profile whose proxy was deleted instead of going direct', async () => {
        const h = create({ profiles: [makeProfile('a', 99)] });
        await expect(h.service.open('a')).rejects.toThrow('Proxy của profile không còn tồn tại');
        expect(h.spawned).toHaveLength(0);
        expect(h.service.getRunningIds()).toEqual([]);
    });

    it('rejects a second open of the same profile, even while the first is still starting', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const first = h.service.open('a');
        await expect(h.service.open('a')).rejects.toThrow('Profile đang mở');
        await first;
        await expect(h.service.open('a')).rejects.toThrow('Profile đang mở');
        expect(h.spawned).toHaveLength(1);
    });

    it(`refuses to open more than ${MAX_RUNNING_PROFILES} profiles`, async () => {
        const profiles = Array.from({ length: MAX_RUNNING_PROFILES + 1 }, (_, i) => makeProfile(`p${i}`));
        const h = create({ profiles });
        for (let i = 0; i < MAX_RUNNING_PROFILES; i++) await h.service.open(`p${i}`);
        await expect(h.service.open(`p${MAX_RUNNING_PROFILES}`)).rejects.toThrow('giới hạn 30');
        expect(h.service.getRunningIds()).toHaveLength(MAX_RUNNING_PROFILES);
    });

    it('reports missing engine, unknown profile and unsupported platform', async () => {
        await expect(create({ executable: null }).service.open('a')).rejects.toThrow('Chưa cài trình duyệt');
        await expect(create().service.open('missing')).rejects.toThrow('Không tìm thấy profile');
        await expect(create({ platform: 'darwin' }).service.open('a')).rejects.toThrow('chưa được hỗ trợ');
    });

    it('cleans up the forwarder and the slot when the browser fails to start', async () => {
        const h = create({ profiles: [makeProfile('a', 5)], spawnFails: true });
        await expect(h.service.open('a')).rejects.toThrow('Không mở được trình duyệt: ENOENT');
        expect(h.forwarders).toEqual([{ started: true, stopped: true }]);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.touched).toEqual([]);
    });

    it('frees the slot when the forwarder cannot start', async () => {
        const h = create({ profiles: [makeProfile('a', 5)], forwarderFails: true });
        await expect(h.service.open('a')).rejects.toThrow('EADDRINUSE');
        expect(h.spawned).toHaveLength(0);
        expect(h.service.isRunning('a')).toBe(false);
    });

    it('releases the profile and stops the forwarder when the browser window is closed', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        await h.service.open('a');
        h.children[0].emit('exit', 0);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.statuses).toEqual([['a'], []]);
        await h.service.open('a');
        expect(h.service.getRunningIds()).toEqual(['a']);
    });

    it('close() asks for a graceful exit first and force-kills only if the browser is still alive', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.close('a');
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        expect(h.service.isRunning('a')).toBe(true);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('close() does not force-kill a browser that exited in time', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.close('a');
        h.children[0].emit('exit', 0);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toHaveLength(1);
    });

    it('close() on a profile that is not running does nothing', () => {
        const h = create();
        h.service.close('a');
        expect(h.terminated).toEqual([]);
    });

    it('closeAll() terminates every browser gracefully and clears state at once', async () => {
        const h = create({ profiles: [makeProfile('a', 5), makeProfile('b')] });
        await h.service.open('a');
        await h.service.open('b');
        h.service.closeAll();
        expect(h.terminated.map((t) => t.force)).toEqual([false, false]);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.forwarders[0].stopped).toBe(true);
    });

    it('closeAll() while open() waits for the forwarder: open() is cancelled, nothing is spawned or recorded', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const opening = h.service.open('a');
        h.service.closeAll();
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(h.spawned).toHaveLength(0);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.service.isRunning('a')).toBe(false);
        expect(h.touched).toEqual([]);
        expect(h.statuses.every((ids) => ids.length === 0)).toBe(true);
    });

    it('closeAll() while the browser is spawning: the browser is force-terminated and open() is cancelled', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const opening = h.service.open('a');
        await new Promise((resolve) => setImmediate(resolve)); // forwarder started, spawn event still pending
        expect(h.spawned).toHaveLength(1);
        h.service.closeAll();
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(h.terminated).toEqual([{ child: h.children[0], force: true }]);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.service.isRunning('a')).toBe(false);
        expect(h.touched).toEqual([]);
    });

    it('close() while the browser is starting closes it as soon as it has spawned, then force-kills if it lingers', async () => {
        const h = create();
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        const opening = h.service.open('a');
        h.service.close('a');
        expect(h.terminated).toEqual([]);
        await opening;
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('closeAll() force-kills a browser that ignores the graceful exit', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.closeAll();
        expect(h.service.isRunning('a')).toBe(false);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('closeAll() does not force-kill a browser that exited promptly', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.closeAll();
        h.children[0].emit('exit', 0);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
    });
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `npx jest src/__tests__/browser/BrowserProfileService.test.ts`
Expected: FAIL với `Cannot find module '../../services/browser/BrowserProfileService'`.

- [ ] **Step 3: Viết implementation**

Tạo `src/services/browser/BrowserProfileService.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { EventEmitter } from 'events';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';
import { buildLaunchArgs, hostPersona } from './fingerprint';
import { ProxyForwarder } from './ProxyForwarder';

export const MAX_RUNNING_PROFILES = 30;
/** How long close() waits for a graceful exit before force-killing the browser. */
export const FORCE_KILL_DELAY_MS = 5000;

export interface ProfileStore {
    getBrowserProfileById(id: string): BrowserProfile | null;
    getProxyById(id: number): ProxyConfig | null;
    touchBrowserProfileOpened(id: string): void;
}

export interface ForwarderLike {
    start(): Promise<number>;
    stop(): Promise<void>;
}

/** The part of ChildProcess the service relies on. */
export interface BrowserProcess extends EventEmitter {
    pid?: number;
    kill(signal?: NodeJS.Signals): boolean;
}

export interface BrowserProfileServiceDeps {
    store: ProfileStore;
    getExecutablePath: () => string | null;
    /** Directory that holds one sub-directory of browser data per profile (depends on the active workspace). */
    getProfilesDir: () => string;
    platform?: NodeJS.Platform;
    spawnBrowser?: (executable: string, args: string[]) => BrowserProcess;
    createForwarder?: (proxy: ProxyConfig) => ForwarderLike;
    /** Asks the browser to exit. force=false must let Chromium flush cookies to disk. */
    terminate?: (child: BrowserProcess, force: boolean) => void;
    onStatusChanged?: (runningIds: string[]) => void;
}

interface RunningEntry {
    /** Set only once the browser has actually spawned. */
    child: BrowserProcess | null;
    forwarder: ForwarderLike | null;
    /** close() was called while the browser was still starting; open() closes it right after the spawn. */
    closeRequested: boolean;
    exited: boolean;
    forceKillTimer: NodeJS.Timeout | null;
}

function defaultTerminate(platform: NodeJS.Platform): (child: BrowserProcess, force: boolean) => void {
    return (child, force) => {
        if (platform === 'win32') {
            // Without /F taskkill posts WM_CLOSE, which lets Chromium save the session.
            const args = ['/pid', String(child.pid), '/T'];
            if (force) args.push('/F');
            spawn('taskkill', args, { stdio: 'ignore' }).once('error', () => undefined);
            return;
        }
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
    };
}

/** Opens and closes browser profiles and tracks which ones are running. Running state lives in memory only. */
export class BrowserProfileService {
    private readonly running = new Map<string, RunningEntry>();
    private readonly platform: NodeJS.Platform;
    private readonly spawnBrowser: (executable: string, args: string[]) => BrowserProcess;
    private readonly createForwarder: (proxy: ProxyConfig) => ForwarderLike;
    private readonly terminate: (child: BrowserProcess, force: boolean) => void;

    constructor(private readonly deps: BrowserProfileServiceDeps) {
        this.platform = deps.platform || process.platform;
        this.spawnBrowser = deps.spawnBrowser || ((executable, args) => spawn(executable, args, { stdio: 'ignore' }));
        this.createForwarder = deps.createForwarder || ((proxy) => new ProxyForwarder(proxy));
        this.terminate = deps.terminate || defaultTerminate(this.platform);
    }

    public getRunningIds(): string[] {
        return Array.from(this.running.keys());
    }

    public isRunning(id: string): boolean {
        return this.running.has(id);
    }

    public getProfileDir(id: string): string {
        return path.join(this.deps.getProfilesDir(), id);
    }

    public async open(id: string): Promise<void> {
        if (this.running.has(id)) throw new Error('Profile đang mở');
        if (this.running.size >= MAX_RUNNING_PROFILES) {
            throw new Error(`Đã đạt giới hạn ${MAX_RUNNING_PROFILES} profile mở cùng lúc`);
        }
        const persona = hostPersona(this.platform);
        if (!persona) throw new Error('Hệ điều hành này chưa được hỗ trợ');
        const executable = this.deps.getExecutablePath();
        if (!executable) throw new Error('Chưa cài trình duyệt. Hãy tải trình duyệt trước.');
        const profile = this.deps.store.getBrowserProfileById(id);
        if (!profile) throw new Error('Không tìm thấy profile');
        let proxy: ProxyConfig | null = null;
        if (profile.proxy_id !== null && profile.proxy_id !== undefined) {
            proxy = this.deps.store.getProxyById(profile.proxy_id);
            if (!proxy) throw new Error('Proxy của profile không còn tồn tại. Hãy chọn proxy khác.');
        }

        // Reserve the slot before the first await so a second open() of the same profile is rejected.
        const entry: RunningEntry = { child: null, forwarder: null, closeRequested: false, exited: false, forceKillTimer: null };
        this.running.set(id, entry);
        try {
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
                this.assertNotCancelled(id, entry);
            }
            const userDataDir = this.getProfileDir(id);
            fs.mkdirSync(userDataDir, { recursive: true });
            const child = this.spawnBrowser(
                executable,
                buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort }),
            );
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', () => resolve());
                child.once('error', reject);
            });
            this.assertNotCancelled(id, entry, child);
            entry.child = child;
            child.once('exit', () => {
                entry.exited = true;
                if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
                this.release(id, entry);
            });
            child.on('error', () => undefined);
        } catch (error: any) {
            this.release(id, entry);
            throw new Error(`Không mở được trình duyệt: ${error?.message || error}`);
        }
        try {
            this.deps.store.touchBrowserProfileOpened(id);
        } catch (error: any) {
            // The browser is already running; failing to record the open time must not fail open().
            console.warn(`Không ghi được thời điểm mở profile ${id}:`, error?.message || error);
        }
        this.notify();
        if (entry.closeRequested) this.close(id);
    }

    /** Called after each await in open(): closeAll() may have released the entry meanwhile. */
    private assertNotCancelled(id: string, entry: RunningEntry, spawned?: BrowserProcess): void {
        if (this.running.get(id) === entry) return;
        if (spawned) this.terminate(spawned, true);
        // release() may have stopped the forwarder before its start() finished; stop() is idempotent.
        entry.forwarder?.stop().catch(() => undefined);
        throw new Error('Đã hủy mở trình duyệt');
    }

    /** Asks the browser to exit gracefully, then force-kills it if it is still alive after FORCE_KILL_DELAY_MS. */
    public close(id: string): void {
        const entry = this.running.get(id);
        if (!entry) return;
        if (!entry.child) {
            entry.closeRequested = true;
            return;
        }
        this.terminateWithFallback(entry, entry.child);
    }

    private terminateWithFallback(entry: RunningEntry, child: BrowserProcess): void {
        this.terminate(child, false);
        if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = setTimeout(() => {
            if (!entry.exited) this.terminate(child, true);
        }, FORCE_KILL_DELAY_MS);
        entry.forceKillTimer.unref?.();
    }

    /** Used on app quit and workspace switch: graceful exit (then force-kill if still alive) for every browser, state cleared immediately. */
    public closeAll(): void {
        const entries = Array.from(this.running.entries());
        for (const [id, entry] of entries) {
            if (entry.child) this.terminateWithFallback(entry, entry.child);
            this.release(id, entry);
        }
    }

    private release(id: string, entry: RunningEntry): void {
        if (this.running.get(id) !== entry) return;
        this.running.delete(id);
        entry.forwarder?.stop().catch(() => undefined);
        this.notify();
    }

    private notify(): void {
        this.deps.onStatusChanged?.(this.getRunningIds());
    }
}
```

- [ ] **Step 4: Chạy test, xác nhận qua**

Run: `npx jest`
Expected: PASS, `Test Suites: 4 passed, 4 total`, `Tests: 50 passed, 50 total`.

- [ ] **Step 5: Commit**

```bash
git add src/services/browser/BrowserProfileService.ts src/__tests__/browser/BrowserProfileService.test.ts
git commit -m "feat(browser): add profile service for opening and closing browsers"
```

---

## Task 5: Lưu trữ trong DatabaseService

**Files:**
- Modify: `src/services/database/DatabaseService.ts` (4 chỗ)

**Interfaces:**
- Consumes: `BrowserFingerprint`, `BrowserProfile`, `BrowserProfileGroup` (Task 1).
- Produces (method public mới của `DatabaseService`):
  - `getBrowserProfiles(): BrowserProfile[]`
  - `getBrowserProfileById(id: string): BrowserProfile | null`
  - `createBrowserProfile(profile: { id; name; group_id; proxy_id; fingerprint; note }): BrowserProfile`
  - `updateBrowserProfile(id: string, fields: { name?; group_id?; proxy_id?; fingerprint?; note? }): void`
  - `deleteBrowserProfile(id: string): void`
  - `setBrowserProfilesProxy(ids: string[], proxyId: number | null): number`
  - `touchBrowserProfileOpened(id: string): void`
  - `getBrowserProfileGroups(): BrowserProfileGroup[]`
  - `getBrowserProfileGroupById(id: number): BrowserProfileGroup | null`
  - `saveBrowserProfileGroup(group: { id?: number; name: string; color?: string }): BrowserProfileGroup`
  - `deleteBrowserProfileGroup(id: number): void`
- Đã tồn tại, dùng lại: `getDbPath(): string`, `getProxyById(id: number)`, `query`, `queryOne`, `run`, `runInsert`, `transaction`.

Phần này không có unit test jest (xem mục 1). Kiểm chứng bằng type-check ở task này và kịch bản console ở Task 6.

- [ ] **Step 1: Thêm import kiểu**

Tìm dòng import cuối cùng ở đầu file:

```ts
import { getTelegramMessagePreview } from '../telegram/TelegramMessagePreview';
```

Thêm ngay bên dưới:

```ts
import type { BrowserFingerprint, BrowserProfile, BrowserProfileGroup } from '../../models/browserProfile';
```

- [ ] **Step 2: Thêm hai bảng trong `createTables()`**

Tìm đoạn tạo bảng `proxies` (chú thích `// ─── Proxies ───`). Đoạn này kết thúc bằng:

```ts
                updated_at  INTEGER NOT NULL DEFAULT 0
            );
        `);

    }
```

Chèn khối sau vào giữa `        \`);` và `    }`:

```ts
        // ─── Browser profiles ────────────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS browser_profile_groups (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                color       TEXT NOT NULL DEFAULT '',
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS browser_profiles (
                id               TEXT PRIMARY KEY,
                name             TEXT NOT NULL,
                group_id         INTEGER DEFAULT NULL,
                proxy_id         INTEGER DEFAULT NULL,
                fingerprint_json TEXT NOT NULL,
                note             TEXT NOT NULL DEFAULT '',
                last_opened_at   INTEGER DEFAULT NULL,
                created_at       INTEGER NOT NULL DEFAULT 0,
                updated_at       INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_browser_profiles_group ON browser_profiles(group_id);
        `);
```

- [ ] **Step 3: Gỡ proxy khỏi profile khi xóa proxy**

Trong `deleteProxy(id: number)`, tìm:

```ts
        db!.prepare(`UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?`).run(id);
```

Thêm ngay bên dưới:

```ts
        db!.prepare(`UPDATE browser_profiles SET proxy_id = NULL WHERE proxy_id = ?`).run(id);
```

- [ ] **Step 4: Thêm các method**

Tìm dòng `    private decryptCookies(encrypted: string): string {` (ngay sau `getAccountProxy`). Chèn khối sau ngay phía trên dòng đó:

```ts
    // ─── Browser profiles ─────────────────────────────────────────────────────

    private mapBrowserProfileRow(row: any): BrowserProfile {
        return {
            id: row.id,
            name: row.name,
            group_id: row.group_id ?? null,
            proxy_id: row.proxy_id ?? null,
            fingerprint: JSON.parse(row.fingerprint_json) as BrowserFingerprint,
            note: row.note || '',
            last_opened_at: row.last_opened_at ?? null,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    public getBrowserProfiles(): BrowserProfile[] {
        return this.query<any>('SELECT * FROM browser_profiles ORDER BY created_at DESC, name ASC')
            .map((row) => this.mapBrowserProfileRow(row));
    }

    public getBrowserProfileById(id: string): BrowserProfile | null {
        const row = this.queryOne<any>('SELECT * FROM browser_profiles WHERE id = ?', [id]);
        return row ? this.mapBrowserProfileRow(row) : null;
    }

    public createBrowserProfile(profile: {
        id: string; name: string; group_id: number | null; proxy_id: number | null; fingerprint: BrowserFingerprint; note: string;
    }): BrowserProfile {
        const now = Date.now();
        db!.prepare(
            `INSERT INTO browser_profiles (id, name, group_id, proxy_id, fingerprint_json, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(profile.id, profile.name, profile.group_id, profile.proxy_id, JSON.stringify(profile.fingerprint), profile.note, now, now);
        return this.getBrowserProfileById(profile.id)!;
    }

    public updateBrowserProfile(id: string, fields: {
        name?: string; group_id?: number | null; proxy_id?: number | null; fingerprint?: BrowserFingerprint; note?: string;
    }): void {
        const sets: string[] = [];
        const vals: any[] = [];
        if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name); }
        if (fields.group_id !== undefined) { sets.push('group_id = ?'); vals.push(fields.group_id); }
        if (fields.proxy_id !== undefined) { sets.push('proxy_id = ?'); vals.push(fields.proxy_id); }
        if (fields.fingerprint !== undefined) { sets.push('fingerprint_json = ?'); vals.push(JSON.stringify(fields.fingerprint)); }
        if (fields.note !== undefined) { sets.push('note = ?'); vals.push(fields.note); }
        if (sets.length === 0) return;
        sets.push('updated_at = ?'); vals.push(Date.now());
        vals.push(id);
        db!.prepare(`UPDATE browser_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    public deleteBrowserProfile(id: string): void {
        db!.prepare('DELETE FROM browser_profiles WHERE id = ?').run(id);
    }

    /** Gắn/gỡ proxy cho nhiều profile, trả về số profile đã cập nhật */
    public setBrowserProfilesProxy(ids: string[], proxyId: number | null): number {
        const statement = db!.prepare('UPDATE browser_profiles SET proxy_id = ?, updated_at = ? WHERE id = ?');
        const now = Date.now();
        return this.transaction(() => ids.reduce((count, id) => count + statement.run(proxyId, now, id).changes, 0));
    }

    public touchBrowserProfileOpened(id: string): void {
        this.run('UPDATE browser_profiles SET last_opened_at = ? WHERE id = ?', [Date.now(), id]);
    }

    public getBrowserProfileGroups(): BrowserProfileGroup[] {
        return this.query<BrowserProfileGroup>('SELECT * FROM browser_profile_groups ORDER BY sort_order ASC, name ASC');
    }

    public getBrowserProfileGroupById(id: number): BrowserProfileGroup | null {
        return this.queryOne<BrowserProfileGroup>('SELECT * FROM browser_profile_groups WHERE id = ?', [id]) || null;
    }

    /** Tạo nhóm mới (không có id) hoặc cập nhật nhóm có sẵn */
    public saveBrowserProfileGroup(group: { id?: number; name: string; color?: string }): BrowserProfileGroup {
        let id = group.id;
        if (id) {
            this.run('UPDATE browser_profile_groups SET name = ?, color = ? WHERE id = ?', [group.name, group.color || '', id]);
        } else {
            id = this.runInsert(
                'INSERT INTO browser_profile_groups (name, color, sort_order, created_at) VALUES (?, ?, 0, ?)',
                [group.name, group.color || '', Date.now()],
            );
        }
        return this.getBrowserProfileGroupById(id)!;
    }

    /** Xóa nhóm; các profile trong nhóm trở về "không nhóm" */
    public deleteBrowserProfileGroup(id: number): void {
        db!.prepare('UPDATE browser_profiles SET group_id = NULL WHERE group_id = ?').run(id);
        db!.prepare('DELETE FROM browser_profile_groups WHERE id = ?').run(id);
    }
```

Không thêm `getDbPath()`: method này đã tồn tại trong file (thêm lần nữa sẽ lỗi `TS2393: Duplicate function implementation`).

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: không in gì, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/database/DatabaseService.ts
git commit -m "feat(browser): persist browser profiles and groups"
```

---

## Task 6: IPC, preload và nối vào vòng đời app

**Files:**
- Create: `electron/ipc/browserProfileIpc.ts`
- Modify: `electron/main.ts` (3 chỗ)
- Modify: `electron/ipc/workspaceIpc.ts` (3 chỗ)
- Modify: `electron/preload.ts` (2 chỗ)

**Interfaces:**
- Consumes: `BrowserEngineManager` (Task 3), `BrowserProfileService` (Task 4), các method DB (Task 5), `generateFingerprint`, `isValidLanguage`, `isValidTimezone` (Task 1), `EventBroadcaster.emit(channel, data)`, `AppModeManager.getInstance().isEmployeeMode()`.
- Produces:
  - `registerBrowserProfileIpc(): void`, `closeAllBrowserProfiles(): void`
  - Kênh IPC và giá trị trả về (mọi kênh trả thêm `success`, hoặc `{ success: false, error }`):

| Kênh | Tham số | Trả về |
|---|---|---|
| `browserProfile:list` | — | `profiles`, `groups`, `runningIds` |
| `browserProfile:create` | `{ name, groupId?, proxyId?, language?, timezone?, note? }` | `profile` |
| `browserProfile:update` | `{ id, name?, groupId?, proxyId?, language?, timezone?, note?, regenerateFingerprint? }` | `profile` |
| `browserProfile:delete` | `{ ids: string[] }` | `deleted`, `skippedRunning` |
| `browserProfile:setProxy` | `{ ids: string[], proxyId: number \| null }` | `updated` |
| `browserProfile:open` | `{ id }` | — |
| `browserProfile:close` | `{ id }` | — |
| `browserProfile:saveGroup` | `{ id?, name, color? }` | `group` |
| `browserProfile:deleteGroup` | `{ id }` | — |
| `browserProfile:engineStatus` | — | `supported`, `installed`, `version` |
| `browserProfile:installEngine` | — | `supported`, `installed`, `version` |

  - Sự kiện tới renderer: `browserProfile:statusChanged` `{ runningIds: string[] }`; `browserProfile:engineProgress` `{ received: number; total: number }`.
  - `window.electronAPI.browserProfile.{list, create, update, delete, setProxy, open, close, saveGroup, deleteGroup, engineStatus, installEngine}`

Quy tắc nghiệp vụ nằm ở IPC (không có trong spec bản đầu, đã bổ sung vào spec):
- Không đổi ngôn ngữ, múi giờ, fingerprint hay proxy của profile đang mở: thay đổi chỉ có hiệu lực ở lần mở sau và gây hiểu nhầm.
- Xóa nhiều profile: profile đang mở bị bỏ qua và trả về trong `skippedRunning`.
- Nhân trình duyệt cài tại `<userData>/browser-engine/<version>/`, dùng chung cho mọi workspace.
- Dữ liệu trình duyệt của profile nằm tại `<thư mục chứa DB của workspace>/browser-profiles/<profile id>/`.

- [ ] **Step 1: Tạo file IPC**

Tạo `electron/ipc/browserProfileIpc.ts`:

```ts
import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import { BrowserEngineManager } from '../../src/services/browser/BrowserEngineManager';
import { BrowserProfileService } from '../../src/services/browser/BrowserProfileService';
import { generateFingerprint, isValidLanguage, isValidTimezone } from '../../src/services/browser/fingerprint';

const MAX_NAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 1000;
const PROGRESS_INTERVAL_MS = 250;

let engineManager: BrowserEngineManager | null = null;
let profileService: BrowserProfileService | null = null;

function db(): DatabaseService {
    return DatabaseService.getInstance();
}

function getEngineManager(): BrowserEngineManager {
    if (!engineManager) {
        engineManager = new BrowserEngineManager(path.join(app.getPath('userData'), 'browser-engine'));
    }
    return engineManager;
}

/** Browser data lives next to the active workspace's database, so each workspace has its own profiles. */
function getProfilesDir(): string {
    return path.join(path.dirname(db().getDbPath()), 'browser-profiles');
}

function getProfileService(): BrowserProfileService {
    if (!profileService) {
        profileService = new BrowserProfileService({
            store: {
                getBrowserProfileById: (id) => db().getBrowserProfileById(id),
                getProxyById: (id) => db().getProxyById(id),
                touchBrowserProfileOpened: (id) => db().touchBrowserProfileOpened(id),
            },
            getExecutablePath: () => getEngineManager().getExecutablePath(),
            getProfilesDir,
            onStatusChanged: (runningIds) => EventBroadcaster.emit('browserProfile:statusChanged', { runningIds }),
        });
    }
    return profileService;
}

/** Closes every running browser. Called on app quit and before the workspace database is switched. */
export function closeAllBrowserProfiles(): void {
    profileService?.closeAll();
}

// ─── Input validation ────────────────────────────────────────────────────────

function requireName(value: any): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw new Error('Tên profile không được để trống');
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Tên profile tối đa ${MAX_NAME_LENGTH} ký tự`);
    return name;
}

function optionalNote(value: any): string {
    const note = typeof value === 'string' ? value : '';
    if (note.length > MAX_NOTE_LENGTH) throw new Error(`Ghi chú tối đa ${MAX_NOTE_LENGTH} ký tự`);
    return note;
}

function optionalProxyId(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !db().getProxyById(id)) throw new Error('Proxy không tồn tại');
    return id;
}

function optionalGroupId(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !db().getBrowserProfileGroupById(id)) throw new Error('Nhóm không tồn tại');
    return id;
}

function requireLanguage(value: any): string {
    if (!isValidLanguage(value)) throw new Error('Ngôn ngữ không hợp lệ');
    return value;
}

function requireTimezone(value: any): string {
    if (!isValidTimezone(value)) throw new Error('Múi giờ không hợp lệ');
    return value;
}

function requireIds(value: any): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id)) {
        throw new Error('Danh sách profile không hợp lệ');
    }
    return value;
}

function requireProfile(id: any) {
    const profile = typeof id === 'string' ? db().getBrowserProfileById(id) : null;
    if (!profile) throw new Error('Không tìm thấy profile');
    return profile;
}

/** Registers one handler with the shared employee-mode guard and error envelope. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (AppModeManager.getInstance().isEmployeeMode()) {
                return { success: false, error: 'Tính năng Trình duyệt chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            Logger.error(`[browserProfileIpc] ${channel} error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

export function registerBrowserProfileIpc(): void {
    handle('browserProfile:list', () => ({
        profiles: db().getBrowserProfiles(),
        groups: db().getBrowserProfileGroups(),
        runningIds: getProfileService().getRunningIds(),
    }));

    handle('browserProfile:create', (params) => {
        const overrides: { language?: string; timezone?: string } = {};
        if (params.language) overrides.language = requireLanguage(params.language);
        if (params.timezone) overrides.timezone = requireTimezone(params.timezone);
        const profile = db().createBrowserProfile({
            id: randomUUID(),
            name: requireName(params.name),
            group_id: optionalGroupId(params.groupId),
            proxy_id: optionalProxyId(params.proxyId),
            fingerprint: generateFingerprint(overrides),
            note: optionalNote(params.note),
        });
        return { profile };
    });

    handle('browserProfile:update', (params) => {
        const current = requireProfile(params.id);
        const changesFingerprint = params.regenerateFingerprint || params.language !== undefined || params.timezone !== undefined;
        if ((params.proxyId !== undefined || changesFingerprint) && getProfileService().isRunning(current.id)) {
            throw new Error('Hãy đóng profile trước khi đổi proxy hoặc fingerprint');
        }
        const fields: Parameters<DatabaseService['updateBrowserProfile']>[1] = {};
        if (params.name !== undefined) fields.name = requireName(params.name);
        if (params.groupId !== undefined) fields.group_id = optionalGroupId(params.groupId);
        if (params.proxyId !== undefined) fields.proxy_id = optionalProxyId(params.proxyId);
        if (params.note !== undefined) fields.note = optionalNote(params.note);

        if (changesFingerprint) {
            const language = params.language !== undefined ? requireLanguage(params.language) : current.fingerprint.language;
            const timezone = params.timezone !== undefined ? requireTimezone(params.timezone) : current.fingerprint.timezone;
            fields.fingerprint = params.regenerateFingerprint
                ? generateFingerprint({ language, timezone })
                : { ...current.fingerprint, language, timezone };
        }
        db().updateBrowserProfile(current.id, fields);
        return { profile: db().getBrowserProfileById(current.id) };
    });

    handle('browserProfile:delete', (params) => {
        const service = getProfileService();
        let deleted = 0;
        const skippedRunning: string[] = [];
        for (const id of requireIds(params.ids)) {
            const profile = db().getBrowserProfileById(id);
            if (!profile) continue;
            if (service.isRunning(profile.id)) {
                skippedRunning.push(profile.id);
                continue;
            }
            db().deleteBrowserProfile(profile.id);
            try {
                fs.rmSync(service.getProfileDir(profile.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            } catch (err: any) {
                Logger.warn(`[browserProfileIpc] Could not remove profile dir of ${profile.id}: ${err.message}`);
            }
            deleted++;
        }
        return { deleted, skippedRunning };
    });

    handle('browserProfile:setProxy', (params) => {
        const ids = requireIds(params.ids);
        const service = getProfileService();
        if (ids.some((id) => service.isRunning(id))) throw new Error('Hãy đóng các profile đang mở trước khi đổi proxy');
        return { updated: db().setBrowserProfilesProxy(ids, optionalProxyId(params.proxyId)) };
    });

    handle('browserProfile:open', async (params) => {
        await getProfileService().open(requireProfile(params.id).id);
    });

    handle('browserProfile:close', (params) => {
        getProfileService().close(requireProfile(params.id).id);
    });

    handle('browserProfile:saveGroup', (params) => {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name) throw new Error('Tên nhóm không được để trống');
        if (name.length > MAX_NAME_LENGTH) throw new Error(`Tên nhóm tối đa ${MAX_NAME_LENGTH} ký tự`);
        const id = params.id ? optionalGroupId(params.id) : null;
        const color = typeof params.color === 'string' ? params.color.slice(0, 20) : '';
        return { group: db().saveBrowserProfileGroup({ id: id || undefined, name, color }) };
    });

    handle('browserProfile:deleteGroup', (params) => {
        const id = optionalGroupId(params.id);
        if (id === null) throw new Error('Nhóm không tồn tại');
        db().deleteBrowserProfileGroup(id);
    });

    handle('browserProfile:engineStatus', () => getEngineManager().getStatus());

    handle('browserProfile:installEngine', async () => {
        let lastEmit = 0;
        await getEngineManager().install((progress) => {
            const now = Date.now();
            if (now - lastEmit < PROGRESS_INTERVAL_MS && progress.received !== progress.total) return;
            lastEmit = now;
            EventBroadcaster.emit('browserProfile:engineProgress', progress);
        });
        return getEngineManager().getStatus();
    });
}
```

- [ ] **Step 2: Đăng ký trong `electron/main.ts`**

(a) Tìm:

```ts
import { registerProxyIpc } from './ipc/proxyIpc';
```

Thêm ngay bên dưới:

```ts
import { registerBrowserProfileIpc, closeAllBrowserProfiles } from './ipc/browserProfileIpc';
```

(b) Tìm dòng `  registerProxyIpc();` trong khối "Register all IPC handlers". Thêm ngay bên dưới:

```ts
  registerBrowserProfileIpc();
```

(c) Trong `app.on('before-quit', ...)`, tìm:

```ts
  try {
    // Close DB completely — releases file handles so NSIS installer can update safely.
```

Chèn khối sau ngay phía trên (phải đứng trước bước đóng DB):

```ts
  try {
    // Ask every open browser profile to exit so cookies are flushed and no orphan keeps running
    closeAllBrowserProfiles();
  } catch {}

```

- [ ] **Step 3: Đóng profile trước khi chuyển workspace**

Trong `electron/ipc/workspaceIpc.ts`:

(a) Thêm vào cuối khối import ở đầu file:

```ts
import { closeAllBrowserProfiles } from './browserProfileIpc';
```

(b) Dòng `await DatabaseService.getInstance().switchToWorkspaceDb(newDbPath);` xuất hiện **đúng 2 lần** (trong handler xóa workspace đang active và trong `workspace:switch`). Ở **cả hai** chỗ, thêm hai dòng sau ngay phía trên, giữ nguyên mức thụt lề của dòng `await`:

```ts
// Browser profile data belongs to the workspace being left: close before its DB goes away
try { closeAllBrowserProfiles(); } catch {}
```

Kiểm tra: `grep -c "try { closeAllBrowserProfiles(); } catch {}" electron/ipc/workspaceIpc.ts` → `2`.

- [ ] **Step 4: Công khai API trong `electron/preload.ts`**

(a) Trong mảng `validChannels` của hàm `on`, tìm:

```ts
      'library:itemDeleted',
    ];
```

Thay bằng:

```ts
      'library:itemDeleted',
      // ─── Browser profile events ──────────────────────────────────
      'browserProfile:statusChanged',
      'browserProfile:engineProgress',
    ];
```

(b) Ở cuối file, tìm:

```ts
    test:          (proxy: any)                    => ipcRenderer.invoke('proxy:test', { proxy }),
  },
});
```

Thay bằng:

```ts
    test:          (proxy: any)                    => ipcRenderer.invoke('proxy:test', { proxy }),
  },

  // ─── Browser profiles ────────────────────────────────────────────────────
  browserProfile: {
    list:          ()                                  => ipcRenderer.invoke('browserProfile:list'),
    create:        (params: any)                       => ipcRenderer.invoke('browserProfile:create', params),
    update:        (id: string, params: any)           => ipcRenderer.invoke('browserProfile:update', { id, ...params }),
    delete:        (ids: string[])                     => ipcRenderer.invoke('browserProfile:delete', { ids }),
    setProxy:      (ids: string[], proxyId: number | null) => ipcRenderer.invoke('browserProfile:setProxy', { ids, proxyId }),
    open:          (id: string)                        => ipcRenderer.invoke('browserProfile:open', { id }),
    close:         (id: string)                        => ipcRenderer.invoke('browserProfile:close', { id }),
    saveGroup:     (group: { id?: number; name: string; color?: string }) => ipcRenderer.invoke('browserProfile:saveGroup', group),
    deleteGroup:   (id: number)                        => ipcRenderer.invoke('browserProfile:deleteGroup', { id }),
    engineStatus:  ()                                  => ipcRenderer.invoke('browserProfile:engineStatus'),
    installEngine: ()                                  => ipcRenderer.invoke('browserProfile:installEngine'),
  },
});
```

- [ ] **Step 5: Type-check và unit test**

Run: `npx tsc -p tsconfig.electron.json --noEmit && npx jest`
Expected: tsc không in gì; jest `Tests: 50 passed, 50 total`.

- [ ] **Step 6: Chạy app dev và kiểm chứng bằng console**

Run: `npm run dev`
Expected: app mở như bình thường, Dashboard hiển thị, không có lỗi mới trong terminal. (Nếu app trắng màn hình: gần như chắc chắn là lỗi cú pháp trong `preload.ts`.)

Mở DevTools của cửa sổ app (dev build tự mở; nếu không thấy, xem hằng `SHOW_DEV_TOOLS` trong `electron/main.ts`). Dán **toàn bộ** đoạn sau vào Console một lần. Điều kiện: chế độ Boss/Standalone, workspace mặc định, và **chưa tải nhân trình duyệt** trên máy này (bước 1 và 6 giả định `installed: false`).

```js
// 1. Trạng thái nhân trình duyệt
const api = window.electronAPI.browserProfile;
await api.engineStatus();
// Mong đợi: { success: true, supported: true, installed: false, version: '148.0.7778.215' }

// 2. Tạo profile: tên được cắt khoảng trắng, mặc định tiếng Việt
let r = await api.create({ name: '  Test 1  ' });
console.assert(r.success && r.profile.name === 'Test 1', 'create');
console.assert(r.profile.fingerprint.language === 'vi-VN' && r.profile.fingerprint.timezone === 'Asia/Ho_Chi_Minh', 'defaults');
console.assert([4, 8, 12, 16].includes(r.profile.fingerprint.hardwareConcurrency), 'cores');
const id1 = r.profile.id, seed1 = r.profile.fingerprint.seed;

// 3. Kiểm tra input
console.assert((await api.create({ name: '   ' })).error === 'Tên profile không được để trống', 'empty name');
console.assert((await api.create({ name: 'x'.repeat(101) })).success === false, 'long name');
console.assert((await api.create({ name: 'a', timezone: 'Mars/Olympus' })).error === 'Múi giờ không hợp lệ', 'timezone');
console.assert((await api.create({ name: 'a', language: 'vi-VN --no-sandbox' })).error === 'Ngôn ngữ không hợp lệ', 'language');
console.assert((await api.create({ name: 'a', proxyId: 999999 })).error === 'Proxy không tồn tại', 'proxy');

// 4. Sửa: đổi tên giữ nguyên seed; tạo lại fingerprint đổi seed
r = await api.update(id1, { name: 'Test 1b', timezone: 'Asia/Bangkok' });
console.assert(r.profile.name === 'Test 1b' && r.profile.fingerprint.timezone === 'Asia/Bangkok' && r.profile.fingerprint.seed === seed1, 'update');
r = await api.update(id1, { regenerateFingerprint: true });
console.assert(r.profile.fingerprint.seed !== seed1 && r.profile.fingerprint.timezone === 'Asia/Bangkok', 'regenerate');

// 5. Nhóm
r = await api.saveGroup({ name: 'Nhóm A' });
const groupId = r.group.id;
await api.update(id1, { groupId });
r = await api.list();
console.assert(r.profiles.find(p => p.id === id1).group_id === groupId && r.groups.length >= 1, 'group');
await api.deleteGroup(groupId);
console.assert((await api.list()).profiles.find(p => p.id === id1).group_id === null, 'group delete nulls profiles');

// 6. Mở khi chưa cài nhân
console.assert((await api.open(id1)).error.includes('Chưa cài trình duyệt'), 'open without engine');

// 7. Xóa proxy gỡ proxy khỏi profile (và không làm hỏng chức năng xóa proxy hiện có)
const px = await window.electronAPI.proxy.save({ name: 'tmp', type: 'http', host: '127.0.0.1', port: 9 });
await api.setProxy([id1], px.id);
console.assert((await api.list()).profiles.find(p => p.id === id1).proxy_id === px.id, 'set proxy');
console.assert((await window.electronAPI.proxy.delete(px.id)).success === true, 'proxy delete still works');
console.assert((await api.list()).profiles.find(p => p.id === id1).proxy_id === null, 'proxy delete nulls profiles');

// 8. Xóa
r = await api.delete([id1]);
console.assert(r.deleted === 1 && r.skippedRunning.length === 0, 'delete');
console.assert((await api.list()).profiles.every(p => p.id !== id1), 'gone');
```

Expected: không có dòng `Assertion failed` nào trong Console.

- [ ] **Step 7: Commit**

```bash
git add electron/ipc/browserProfileIpc.ts electron/main.ts electron/ipc/workspaceIpc.ts electron/preload.ts
git commit -m "feat(browser): expose browser profile IPC and wire lifecycle hooks"
```

> Ghi chú sau review: chặn đổi proxy khi profile đang mở (cùng fingerprint), xóa thư mục profile có retry và không làm hỏng cả lô khi bị khóa file, bọc `closeAllBrowserProfiles()` trong `try/catch` ở `workspaceIpc.ts`.

---

## Task 7: Giao diện

**Ghi chú sau review (Task 7):** modal tạo/sửa và Nhóm đóng bằng Escape và chỉ đóng khi nhấn chuột xuống đúng nền mờ; xóa nhóm đang lọc thì bộ lọc về "Tất cả"; chọn hàng loạt chỉ áp dụng cho dòng đang hiển thị và bị bỏ khi đổi tìm kiếm/bộ lọc; form khóa proxy khi profile đang mở; `load()` có `try/finally`, mở thành công thì làm mới "Mở gần nhất".

**Files:**
- Modify: `DESIGN.md`
- Modify: `src/ui/lib/ipc.ts` (3 chỗ)
- Modify: `src/ui/store/appStore.ts` (1 dòng)
- Modify: `src/ui/App.tsx` (2 chỗ)
- Modify: `src/ui/components/layout/Sidebar.tsx` (2 chỗ)
- Create: `src/ui/features/browser/BrowserProfileForm.tsx`
- Create: `src/ui/features/browser/BrowserProfilesView.tsx`

**Interfaces:**
- Consumes: `window.electronAPI.browserProfile.*` và hai sự kiện (Task 6); `ipc.proxy.list()`; `useAppStore(s => s.showNotification)`; `showConfirm` từ `@/components/common/ConfirmDialog`; `Spinner` từ `@/components/common/PageLoading`; icon từ `@/components/common/icons`; class `input-field`, `btn-primary` từ `src/ui/index.css`.
- Produces: `BrowserProfilesView` (default export), `BrowserProfileForm` (default export), `ProxyOption`.

- [ ] **Step 1: Bổ sung `DESIGN.md`**

`DESIGN.md` hiện chỉ mô tả logo. Sửa hai chỗ.

(a) Tìm đoạn:

```md
Tài liệu này chỉ nói về **dấu hiệu nhận diện (logo)**. Giao diện bên trong ứng
dụng được kế thừa nguyên trạng từ dự án nguồn (xem `NOTICE.md`) và chưa được
thiết kế lại; đừng coi file này là hệ thiết kế của toàn bộ giao diện.
```

Thay bằng:

```md
Tài liệu này nói về **dấu hiệu nhận diện (logo)** và, ở cuối file, bộ token tối
thiểu cho **màn hình Trình duyệt**. Giao diện các màn hình khác được kế thừa
nguyên trạng từ dự án nguồn (xem `NOTICE.md`) và chưa được thiết kế lại; đừng
coi file này là hệ thiết kế của toàn bộ giao diện.
```

(b) Thêm vào cuối file:

~~~~md
## Giao diện màn hình Trình duyệt

Phần này chỉ áp dụng cho `src/ui/features/browser/`. Nó ghi lại các token đang
dùng thật trong ứng dụng để màn hình mới trông như một phần của app, không đặt
ra hệ thiết kế mới.

```yaml
screen: browser-profiles
color:
  surface-page:    bg-gray-900      # nền màn hình
  surface-raised:  bg-gray-800      # modal, thanh thao tác hàng loạt
  border:          border-gray-700  # viền khối; border-gray-600 cho nút phụ và ô nhập
  text-primary:    text-gray-200    # text-white cho tiêu đề
  text-secondary:  text-gray-400
  action-primary:  btn-primary      # bg-blue-600, hover bg-blue-700
  status-running:  text-green-400
  status-stopped:  text-gray-400
  warning:         text-yellow-400  # "Không proxy", profile đang mở
  danger:          text-red-400     # xóa, lỗi
typography:
  title:   text-base font-semibold
  body:    text-sm
  meta:    text-xs
  hint:    text-[11px]
spacing:
  page-gutter: px-4
  block-gap:   py-3
  control-gap: gap-2
radius:
  control: rounded-lg
  dialog:  rounded-xl
layout:
  page-size: 50                     # dòng mỗi trang
  breakpoints:
    md: hiện cột Nhóm và Proxy
    lg: hiện cột Mở gần nhất
```

Lý do:

- **Chỉ dùng class xám đã có ghi đè light theme.** Light theme của app hoạt động
  bằng cách ghi đè các class `gray-*` trong `src/ui/index.css`. Dùng đúng các
  class này thì dark và light tự nhất quán; không viết màu hex trong component.
- **"Không proxy" dùng màu cảnh báo.** Profile không proxy lộ IP thật của máy;
  người vận hành phải nhìn thấy ngay trong danh sách.
- **Bảng thay vì thẻ.** Người dùng quản lý đến 1.000 profile và cần so sánh,
  chọn nhiều, thao tác hàng loạt. Ở chiều rộng hẹp, các cột phụ ẩn đi thay vì
  cuộn ngang cấp trang.
- **Xác nhận trước thao tác mất dữ liệu.** Xóa profile và tạo lại fingerprint
  đều qua `showConfirm`, nêu rõ hậu quả.
- **Trạng thái đầy đủ.** Màn hình có trạng thái đang tải, lỗi kèm nút thử lại,
  rỗng, không khớp bộ lọc, chưa cài nhân trình duyệt và hệ điều hành chưa hỗ trợ.
- **Truy cập.** Mọi nút chỉ có icon đều có `aria-label`; ô nhập có `label` hoặc
  `aria-label`; modal có `role="dialog"` và `aria-modal`; lỗi dùng `role="alert"`.
~~~~

- [ ] **Step 2: Khai báo kiểu và export trong `src/ui/lib/ipc.ts`**

(a) Tìm:

```ts
import type { TelegramForumTopicContext } from '../../models/telegram';
```

Thêm ngay bên dưới:

```ts
import type { BrowserProfile, BrowserProfileGroup } from '../../models/browserProfile';
```

(b) Trong `interface Window`, tìm dòng cuối của khối `proxy`:

```ts
        test:          (proxy: any) => Promise<{ success: boolean; ms?: number; status?: number; error?: string }>;
      };
```

Thêm ngay bên dưới:

```ts
      browserProfile: {
        list:          () => Promise<{ success: boolean; profiles?: BrowserProfile[]; groups?: BrowserProfileGroup[]; runningIds?: string[]; error?: string }>;
        create:        (params: { name: string; groupId?: number | null; proxyId?: number | null; language?: string; timezone?: string; note?: string }) => Promise<{ success: boolean; profile?: BrowserProfile; error?: string }>;
        update:        (id: string, params: { name?: string; groupId?: number | null; proxyId?: number | null; language?: string; timezone?: string; note?: string; regenerateFingerprint?: boolean }) => Promise<{ success: boolean; profile?: BrowserProfile; error?: string }>;
        delete:        (ids: string[]) => Promise<{ success: boolean; deleted?: number; skippedRunning?: string[]; error?: string }>;
        setProxy:      (ids: string[], proxyId: number | null) => Promise<{ success: boolean; updated?: number; error?: string }>;
        open:          (id: string) => Promise<{ success: boolean; error?: string }>;
        close:         (id: string) => Promise<{ success: boolean; error?: string }>;
        saveGroup:     (group: { id?: number; name: string; color?: string }) => Promise<{ success: boolean; group?: BrowserProfileGroup; error?: string }>;
        deleteGroup:   (id: number) => Promise<{ success: boolean; error?: string }>;
        engineStatus:  () => Promise<{ success: boolean; supported?: boolean; installed?: boolean; version?: string; error?: string }>;
        installEngine: () => Promise<{ success: boolean; supported?: boolean; installed?: boolean; version?: string; error?: string }>;
      };
```

(c) Trong object `export const ipc = {`, tìm:

```ts
  proxy: window.electronAPI?.proxy,
```

Thêm ngay bên dưới:

```ts
  browserProfile: window.electronAPI?.browserProfile,
```

- [ ] **Step 3: Thêm view `'browser'`**

Trong `src/ui/store/appStore.ts`, thay:

```ts
type AppView = 'chat' | 'friends' | 'settings' | 'dashboard' | 'crm' | 'workflow' | 'integration' | 'analytics' | 'erp';
```

bằng:

```ts
type AppView = 'chat' | 'friends' | 'settings' | 'dashboard' | 'crm' | 'workflow' | 'integration' | 'analytics' | 'erp' | 'browser';
```

- [ ] **Step 4: Tạo form**

Tạo `src/ui/features/browser/BrowserProfileForm.tsx`:

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { CloseIcon, RefreshIcon } from '@/components/common/icons';
import type { BrowserProfile, BrowserProfileGroup } from '../../../models/browserProfile';

export interface ProxyOption {
  id: number;
  name: string;
  type: string;
  host: string;
  port: number;
}

const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'vi-VN', label: 'Tiếng Việt (vi-VN)' },
  { value: 'en-US', label: 'English - US (en-US)' },
  { value: 'en-GB', label: 'English - UK (en-GB)' },
  { value: 'th-TH', label: 'ไทย (th-TH)' },
  { value: 'id-ID', label: 'Indonesia (id-ID)' },
  { value: 'zh-CN', label: '中文 (zh-CN)' },
  { value: 'ja-JP', label: '日本語 (ja-JP)' },
  { value: 'ko-KR', label: '한국어 (ko-KR)' },
];

const DEFAULT_LANGUAGE = 'vi-VN';
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

interface Props {
  /** Profile being edited; undefined when creating. */
  profile?: BrowserProfile;
  groups: BrowserProfileGroup[];
  proxies: ProxyOption[];
  /** Fingerprint fields are locked while the browser is open. */
  running: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function BrowserProfileForm({ profile, groups, proxies, running, onClose, onSaved }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [name, setName] = useState(profile?.name || '');
  const [groupId, setGroupId] = useState<string>(profile?.group_id != null ? String(profile.group_id) : '');
  const [proxyId, setProxyId] = useState<string>(profile?.proxy_id != null ? String(profile.proxy_id) : '');
  const [language, setLanguage] = useState(profile?.fingerprint.language || DEFAULT_LANGUAGE);
  const [timezone, setTimezone] = useState(profile?.fingerprint.timezone || DEFAULT_TIMEZONE);
  const [note, setNote] = useState(profile?.note || '');
  const [regenerate, setRegenerate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const timezones = useMemo<string[]>(() => {
    try {
      return (Intl as any).supportedValuesOf('timeZone');
    } catch {
      return [DEFAULT_TIMEZONE];
    }
  }, []);
  const languageOptions = LANGUAGES.some((l) => l.value === language) ? LANGUAGES : [...LANGUAGES, { value: language, label: language }];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleRegenerate = async () => {
    const confirmed = await showConfirm({
      title: 'Tạo lại fingerprint?',
      message: 'Các website sẽ thấy profile này như một thiết bị mới. Tài khoản đang đăng nhập có thể bị yêu cầu xác minh lại.',
      confirmText: 'Tạo lại',
      variant: 'warning',
    });
    if (confirmed) setRegenerate(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Tên profile không được để trống');
      return;
    }
    setSaving(true);
    setError('');
    const common = {
      name: name.trim(),
      groupId: groupId ? Number(groupId) : null,
      proxyId: proxyId ? Number(proxyId) : null,
      note,
    };
    let res;
    if (!profile) {
      res = await ipc.browserProfile?.create({ ...common, language, timezone });
    } else {
      const fingerprintChanged = language !== profile.fingerprint.language || timezone !== profile.fingerprint.timezone;
      res = await ipc.browserProfile?.update(profile.id, {
        ...common,
        ...(fingerprintChanged ? { language, timezone } : {}),
        ...(regenerate ? { regenerateFingerprint: true } : {}),
      });
    }
    setSaving(false);
    if (res?.success) {
      showNotification(profile ? 'Đã cập nhật profile' : 'Đã tạo profile', 'success');
      onSaved();
    } else {
      setError(res?.error || 'Lưu profile thất bại');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={profile ? 'Sửa profile' : 'Tạo profile'}
        className="w-full max-w-md max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">{profile ? `Sửa "${profile.name}"` : 'Tạo profile mới'}</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label htmlFor="bp-name" className="text-xs text-gray-400 mb-1 block">Tên profile</label>
            <input id="bp-name" className="input-field text-sm w-full" placeholder="VD: FB Sale 01" maxLength={100} autoFocus
              value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bp-group" className="text-xs text-gray-400 mb-1 block">Nhóm</label>
              <select id="bp-group" className="input-field text-sm w-full" value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={saving}>
                <option value="">Không nhóm</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bp-proxy" className="text-xs text-gray-400 mb-1 block">Proxy</label>
              <select id="bp-proxy" className="input-field text-sm w-full" value={proxyId} onChange={(e) => setProxyId(e.target.value)} disabled={saving || running}>
                <option value="">Không proxy (dùng mạng của máy)</option>
                {proxies.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.type.toUpperCase()} {p.host}:{p.port}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bp-language" className="text-xs text-gray-400 mb-1 block">Ngôn ngữ</label>
              <select id="bp-language" className="input-field text-sm w-full" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={saving || running}>
                {languageOptions.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bp-timezone" className="text-xs text-gray-400 mb-1 block">Múi giờ</label>
              <input id="bp-timezone" list="bp-timezones" className="input-field text-sm w-full" value={timezone}
                onChange={(e) => setTimezone(e.target.value)} disabled={saving || running} />
              <datalist id="bp-timezones">
                {timezones.map((tz) => <option key={tz} value={tz} />)}
              </datalist>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">Nên chọn ngôn ngữ và múi giờ khớp với vị trí của proxy.</p>

          <div>
            <label htmlFor="bp-note" className="text-xs text-gray-400 mb-1 block">Ghi chú</label>
            <textarea id="bp-note" className="input-field text-sm w-full" rows={2} maxLength={1000}
              value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} />
          </div>

          {profile && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-700 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs text-gray-200">Fingerprint</p>
                <p className="text-[11px] text-gray-400 truncate">
                  {regenerate ? 'Sẽ tạo fingerprint mới khi lưu' : `Seed ${profile.fingerprint.seed} · ${profile.fingerprint.hardwareConcurrency} nhân CPU`}
                </p>
              </div>
              <button type="button" onClick={handleRegenerate} disabled={saving || running || regenerate}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-600 text-gray-300 hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                <RefreshIcon className="w-3.5 h-3.5" /> Tạo lại
              </button>
            </div>
          )}
          {profile && running && (
            <p className="text-[11px] text-yellow-400">Profile đang mở: đóng trình duyệt để đổi proxy, ngôn ngữ, múi giờ hoặc fingerprint.</p>
          )}

          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:bg-gray-700">Hủy</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-1.5 text-white disabled:opacity-60">
              {saving ? 'Đang lưu...' : profile ? 'Lưu' : 'Tạo profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Tạo màn hình danh sách**

Tạo `src/ui/features/browser/BrowserProfilesView.tsx`:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { CloseIcon, DownloadIcon, EditIcon, FolderIcon, GlobeIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/common/icons';
import BrowserProfileForm, { ProxyOption } from './BrowserProfileForm';
import type { BrowserProfile, BrowserProfileGroup } from '../../../models/browserProfile';

const PAGE_SIZE = 50;
const MAX_RUNNING_PROFILES = 30;

type GroupFilter = 'all' | 'none' | number;

interface EngineState {
  supported: boolean;
  installed: boolean;
  version: string;
}

function formatTime(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString('vi-VN') : 'Chưa mở';
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// ─── Group manager ───────────────────────────────────────────────────────────
function GroupManager({ groups, onClose, onChanged }: { groups: BrowserProfileGroup[]; onClose: () => void; onChanged: () => void }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const res = await ipc.browserProfile?.saveGroup({ name: name.trim() });
    setSaving(false);
    if (res?.success) {
      setName('');
      onChanged();
    } else {
      showNotification(res?.error || 'Tạo nhóm thất bại', 'error');
    }
  };

  const handleDelete = async (group: BrowserProfileGroup) => {
    const confirmed = await showConfirm({
      title: `Xóa nhóm "${group.name}"?`,
      message: 'Các profile trong nhóm sẽ không bị xóa, chỉ trở về "Không nhóm".',
      confirmText: 'Xóa nhóm',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.browserProfile?.deleteGroup(group.id);
    if (res?.success) onChanged();
    else showNotification(res?.error || 'Xóa nhóm thất bại', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Quản lý nhóm"
        className="w-full max-w-sm max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">Quản lý nhóm</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <form onSubmit={handleAdd} className="flex gap-2">
            <input className="input-field text-sm flex-1 min-w-0" placeholder="Tên nhóm mới" maxLength={100} aria-label="Tên nhóm mới" autoFocus
              value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
            <button type="submit" disabled={saving || !name.trim()} className="btn-primary text-sm px-3 py-1.5 text-white disabled:opacity-60">Thêm</button>
          </form>
          {groups.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">Chưa có nhóm nào</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((group) => (
                <li key={group.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-900">
                  <span className="text-sm text-gray-200 truncate">{group.name}</span>
                  <button type="button" onClick={() => handleDelete(group)} aria-label={`Xóa nhóm ${group.name}`}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-900/20">
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main view ───────────────────────────────────────────────────────────────
export default function BrowserProfilesView() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [groups, setGroups] = useState<BrowserProfileGroup[]>([]);
  const [proxies, setProxies] = useState<ProxyOption[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [formTarget, setFormTarget] = useState<BrowserProfile | 'new' | null>(null);
  const [showGroups, setShowGroups] = useState(false);

  const load = useCallback(async () => {
    try {
      const [listRes, proxyRes, engineRes] = await Promise.all([
        ipc.browserProfile?.list(),
        ipc.proxy?.list(),
        ipc.browserProfile?.engineStatus(),
      ]);
      if (!listRes?.success) {
        setLoadError(listRes?.error || 'Không tải được danh sách profile');
        return;
      }
      setLoadError('');
      setProfiles(listRes.profiles || []);
      const nextGroups: BrowserProfileGroup[] = listRes.groups || [];
      setGroups(nextGroups);
      // A deleted group must not stay selected as the filter.
      setGroupFilter((prev) => (typeof prev === 'number' && !nextGroups.some((g) => g.id === prev) ? 'all' : prev));
      setRunningIds(new Set(listRes.runningIds || []));
      setProxies(proxyRes?.success ? proxyRes.proxies : []);
      if (engineRes?.success) {
        setEngine({ supported: !!engineRes.supported, installed: !!engineRes.installed, version: engineRes.version || '' });
      }
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Không tải được danh sách profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const offStatus = ipc.on?.('browserProfile:statusChanged', (data: { runningIds: string[] }) => {
      setRunningIds(new Set(data?.runningIds || []));
    });
    const offProgress = ipc.on?.('browserProfile:engineProgress', (data: { received: number; total: number }) => {
      setProgress(data);
    });
    return () => {
      offStatus?.();
      offProgress?.();
    };
  }, [load]);

  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const proxyNames = useMemo(() => new Map(proxies.map((p) => [p.id, p.name || `${p.host}:${p.port}`])), [proxies]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (groupFilter === 'none' && p.group_id !== null) return false;
      if (typeof groupFilter === 'number' && p.group_id !== groupFilter) return false;
      if (!keyword) return true;
      return p.name.toLowerCase().includes(keyword) || p.note.toLowerCase().includes(keyword);
    });
  }, [profiles, search, groupFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const allOnPageSelected = pageItems.length > 0 && pageItems.every((p) => selected.has(p.id));
  const selectedIds = filtered.filter((p) => selected.has(p.id)).map((p) => p.id);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of pageItems) {
        if (allOnPageSelected) next.delete(p.id); else next.add(p.id);
      }
      return next;
    });
  };

  const openProfile = async (id: string): Promise<boolean> => {
    setBusy(id, true);
    const res = await ipc.browserProfile?.open(id);
    setBusy(id, false);
    if (!res?.success) showNotification(res?.error || 'Không mở được profile', 'error');
    else load();
    return !!res?.success;
  };

  const closeProfile = async (id: string) => {
    setBusy(id, true);
    const res = await ipc.browserProfile?.close(id);
    setBusy(id, false);
    if (!res?.success) showNotification(res?.error || 'Không đóng được profile', 'error');
  };

  const handleBulkOpen = async () => {
    setBulkBusy(true);
    for (const id of selectedIds) {
      if (runningIds.has(id)) continue;
      // Stop at the first failure (limit reached, missing engine, dead proxy) instead of repeating the same error.
      if (!(await openProfile(id))) break;
    }
    setBulkBusy(false);
  };

  const handleBulkClose = async () => {
    setBulkBusy(true);
    for (const id of selectedIds) {
      if (runningIds.has(id)) await closeProfile(id);
    }
    setBulkBusy(false);
  };

  const deleteProfiles = async (ids: string[], label: string) => {
    const confirmed = await showConfirm({
      title: `Xóa ${label}?`,
      message: 'Toàn bộ dữ liệu trình duyệt của profile (cookie, phiên đăng nhập, lịch sử) sẽ bị xóa vĩnh viễn và không khôi phục được.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.browserProfile?.delete(ids);
    if (!res?.success) {
      showNotification(res?.error || 'Xóa profile thất bại', 'error');
      return;
    }
    const skipped = res.skippedRunning?.length || 0;
    showNotification(
      skipped > 0 ? `Đã xóa ${res.deleted} profile. ${skipped} profile đang mở nên chưa xóa.` : `Đã xóa ${res.deleted} profile`,
      skipped > 0 ? 'warning' : 'success',
    );
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    load();
  };

  const handleBulkProxy = async (value: string) => {
    if (value === '') return;
    const res = await ipc.browserProfile?.setProxy(selectedIds, value === 'none' ? null : Number(value));
    if (res?.success) {
      showNotification(`Đã cập nhật proxy cho ${res.updated} profile`, 'success');
      load();
    } else {
      showNotification(res?.error || 'Gán proxy thất bại', 'error');
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setProgress(null);
    const res = await ipc.browserProfile?.installEngine();
    setInstalling(false);
    if (res?.success) {
      setEngine({ supported: !!res.supported, installed: !!res.installed, version: res.version || '' });
      showNotification('Đã cài trình duyệt', 'success');
    } else {
      showNotification(res?.error || 'Tải trình duyệt thất bại', 'error');
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900">
        <Spinner size={6} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-gray-900 p-4 text-center">
        <p role="alert" className="text-sm text-red-400">{loadError}</p>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="btn-primary text-sm px-4 py-1.5 text-white">Thử lại</button>
      </div>
    );
  }

  const canOpen = !!engine?.installed;

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-200 min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-700">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-white flex items-center gap-2">
            <GlobeIcon className="w-4 h-4" /> Trình duyệt
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {profiles.length} profile · {runningIds.size}/{MAX_RUNNING_PROFILES} đang mở
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowGroups(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400">
            <FolderIcon className="w-4 h-4" /> Nhóm
          </button>
          <button type="button" onClick={() => setFormTarget('new')} className="btn-primary text-sm flex items-center gap-1.5 px-3 py-1.5 text-white">
            <PlusIcon className="w-4 h-4" /> Tạo profile
          </button>
        </div>
      </div>

      {/* Engine state */}
      {engine && !engine.supported && (
        <div role="alert" className="mx-4 mt-3 px-3 py-2 rounded-lg border border-yellow-500/40 bg-yellow-900/20 text-xs text-yellow-300">
          Hệ điều hành này chưa được hỗ trợ. Tính năng Trình duyệt hiện chỉ chạy trên Windows và Linux.
        </div>
      )}
      {engine && engine.supported && !engine.installed && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-blue-500/40 bg-blue-900/20 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-200">
            Cần tải nhân trình duyệt (phiên bản {engine.version}, khoảng 190 MB) trước khi mở profile.
          </p>
          <button type="button" onClick={handleInstall} disabled={installing}
            className="btn-primary text-xs flex items-center gap-1.5 px-3 py-1.5 text-white disabled:opacity-60">
            {installing ? <Spinner size={3} /> : <DownloadIcon className="w-3.5 h-3.5" />}
            {installing
              ? progress && progress.total > 0
                ? `Đang tải ${formatMb(progress.received)} / ${formatMb(progress.total)}`
                : 'Đang tải...'
              : 'Tải trình duyệt'}
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="relative flex-1 min-w-[180px]">
          <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input className="input-field text-sm w-full pl-8" placeholder="Tìm theo tên hoặc ghi chú" aria-label="Tìm profile"
            value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); setSelected(new Set()); }} />
        </div>
        <select className="input-field text-sm w-auto max-w-full" aria-label="Lọc theo nhóm"
          value={String(groupFilter)}
          onChange={(e) => {
            const value = e.target.value;
            setGroupFilter(value === 'all' || value === 'none' ? value : Number(value));
            setPage(0);
            setSelected(new Set());
          }}>
          <option value="all">Tất cả nhóm</option>
          <option value="none">Không nhóm</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {/* Bulk actions */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mx-4 mb-3 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700">
          <span className="text-xs text-gray-200">Đã chọn {selectedIds.length}</span>
          <button type="button" onClick={handleBulkOpen} disabled={bulkBusy || !canOpen}
            className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-blue-500 disabled:opacity-50">Mở</button>
          <button type="button" onClick={handleBulkClose} disabled={bulkBusy}
            className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-blue-500 disabled:opacity-50">Đóng</button>
          <select className="input-field text-xs w-auto max-w-full" aria-label="Gán proxy cho các profile đã chọn" value="" disabled={bulkBusy}
            onChange={(e) => handleBulkProxy(e.target.value)}>
            <option value="">Gán proxy...</option>
            <option value="none">Không proxy</option>
            {proxies.map((p) => <option key={p.id} value={p.id}>{p.name || `${p.host}:${p.port}`}</option>)}
          </select>
          <button type="button" onClick={() => deleteProfiles(selectedIds, `${selectedIds.length} profile`)} disabled={bulkBusy}
            className="px-3 py-1 rounded-lg text-xs border border-red-500/50 text-red-400 hover:bg-red-900/20 disabled:opacity-50">Xóa</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-400 hover:text-white">Bỏ chọn</button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-auto px-4">
        {profiles.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <GlobeIcon className="w-8 h-8 mx-auto mb-3" />
            <p className="text-sm font-medium">Chưa có profile nào</p>
            <p className="text-xs mt-1">Mỗi profile là một trình duyệt riêng với fingerprint, cookie và proxy riêng.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center py-16 text-sm text-gray-400">Không có profile nào khớp bộ lọc</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 text-xs text-gray-400">
              <tr className="border-b border-gray-700">
                <th className="w-8 py-2 text-left">
                  <input type="checkbox" aria-label="Chọn tất cả trên trang" checked={allOnPageSelected} onChange={togglePage} />
                </th>
                <th className="py-2 text-left font-medium">Tên</th>
                <th className="py-2 text-left font-medium hidden md:table-cell">Nhóm</th>
                <th className="py-2 text-left font-medium hidden md:table-cell">Proxy</th>
                <th className="py-2 text-left font-medium hidden lg:table-cell">Mở gần nhất</th>
                <th className="py-2 text-left font-medium">Trạng thái</th>
                <th className="py-2 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((profile) => {
                const running = runningIds.has(profile.id);
                const busy = busyIds.has(profile.id);
                return (
                  <tr key={profile.id} className="border-b border-gray-800 hover:bg-gray-800/60">
                    <td className="py-2">
                      <input type="checkbox" aria-label={`Chọn ${profile.name}`} checked={selected.has(profile.id)} onChange={() => toggleOne(profile.id)} />
                    </td>
                    <td className="py-2 pr-2 max-w-[100px] sm:max-w-[220px]">
                      <p className="text-gray-200 truncate" title={profile.name}>{profile.name}</p>
                      {profile.note && <p className="text-[11px] text-gray-400 truncate" title={profile.note}>{profile.note}</p>}
                    </td>
                    <td className="py-2 pr-2 hidden md:table-cell text-gray-400 truncate max-w-[140px]">
                      {profile.group_id !== null ? groupNames.get(profile.group_id) || '—' : '—'}
                    </td>
                    <td className="py-2 pr-2 hidden md:table-cell truncate max-w-[160px]">
                      {profile.proxy_id !== null
                        ? <span className="text-gray-200">{proxyNames.get(profile.proxy_id) || 'Proxy đã xóa'}</span>
                        : <span className="text-yellow-400">Không proxy</span>}
                    </td>
                    <td className="py-2 pr-2 hidden lg:table-cell text-gray-400 whitespace-nowrap">{formatTime(profile.last_opened_at)}</td>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1.5 text-xs ${running ? 'text-green-400' : 'text-gray-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-green-400' : 'bg-gray-500'}`} />
                        {running ? 'Đang mở' : 'Đã dừng'}
                      </span>
                    </td>
                    <td className="py-2 whitespace-nowrap text-right">
                      {running ? (
                        <button type="button" onClick={() => closeProfile(profile.id)} disabled={busy}
                          className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-red-500 hover:text-red-400 disabled:opacity-50">
                          Đóng
                        </button>
                      ) : (
                        <button type="button" onClick={() => openProfile(profile.id)} disabled={busy || !canOpen}
                          title={canOpen ? 'Mở trình duyệt' : 'Cần tải trình duyệt trước'}
                          className="btn-primary px-3 py-1 text-xs text-white disabled:opacity-50">
                          {busy ? 'Đang mở...' : 'Mở'}
                        </button>
                      )}
                      <button type="button" onClick={() => setFormTarget(profile)} aria-label={`Sửa ${profile.name}`}
                        className="ml-1 p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-900/20 align-middle">
                        <EditIcon className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => deleteProfiles([profile.id], `profile "${profile.name}"`)} disabled={running}
                        aria-label={`Xóa ${profile.name}`} title={running ? 'Đóng profile trước khi xóa' : 'Xóa'}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40 align-middle">
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-gray-700 text-xs text-gray-400">
          <span>{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}
              className="px-3 py-1 rounded-lg border border-gray-600 text-gray-200 disabled:opacity-40">Trước</button>
            <span>Trang {currentPage + 1}/{pageCount}</span>
            <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}
              className="px-3 py-1 rounded-lg border border-gray-600 text-gray-200 disabled:opacity-40">Sau</button>
          </div>
        </div>
      )}

      {formTarget && (
        <BrowserProfileForm
          profile={formTarget === 'new' ? undefined : formTarget}
          groups={groups}
          proxies={proxies}
          running={formTarget !== 'new' && runningIds.has(formTarget.id)}
          onClose={() => setFormTarget(null)}
          onSaved={() => { setFormTarget(null); load(); }}
        />
      )}
      {showGroups && <GroupManager groups={groups} onClose={() => setShowGroups(false)} onChanged={load} />}
    </div>
  );
}
```

- [ ] **Step 6: Render trong `src/ui/App.tsx`**

(a) Tìm:

```tsx
import ErpPage from './features/erp/ErpPage';
```

Thêm ngay bên dưới:

```tsx
import BrowserProfilesView from './features/browser/BrowserProfilesView';
```

(b) Tìm:

```tsx
          {view === 'erp' && (
            <div className="flex-1 h-full overflow-hidden">
              <ErpPage />
            </div>
          )}
```

Thêm ngay bên dưới:

```tsx
          {view === 'browser' && (
            <div className="flex-1 h-full overflow-hidden">
              <BrowserProfilesView />
            </div>
          )}
```

- [ ] **Step 7: Nút điều hướng trong `src/ui/components/layout/Sidebar.tsx`**

(a) Tìm:

```tsx
        <NavBtn icon="erp"        label="Quản lý công việc"   active={view === 'erp'}        onClick={() => setView('erp')} />
        )}
```

Thêm ngay bên dưới (`empMode` và `isSimulating` đã có sẵn trong component):

```tsx
        {/* Browser profiles - Boss/Standalone only; hidden while previewing an employee */}
        {empMode !== 'employee' && !isSimulating && (
        <NavBtn icon="browser"    label="Trình duyệt"  active={view === 'browser'}    onClick={() => setView('browser')} />
        )}
```

(b) `NavBtn` lấy icon từ object `icons` trong chính nó (không phải `NavIcon`). Trong object đó, tìm khóa `erp: (...)` ở cuối và thêm ngay bên dưới (trước `};`):

```tsx
    browser: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
```

- [ ] **Step 8: Type-check và build renderer**

Run: `npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.electron.json --noEmit && npm run build:renderer`
Expected: hai lệnh tsc không in gì; vite build kết thúc không lỗi.

- [ ] **Step 9: Kiểm tra giao diện trên dev**

Run: `npm run dev`. Kiểm tra từng mục; mục nào sai thì sửa rồi mới commit.

1. Sidebar có nút "Trình duyệt"; bấm vào hiện màn hình với trạng thái rỗng "Chưa có profile nào" và banner yêu cầu tải nhân.
2. Tạo profile: modal mở, ô tên được focus, để trống tên thì báo lỗi ngay trong modal, tạo thành công thì có thông báo và dòng mới xuất hiện.
3. Tạo nhóm trong "Nhóm", gán profile vào nhóm, lọc theo nhóm và tìm theo tên hoạt động.
4. Sửa profile; bấm "Tạo lại" fingerprint hiện hộp xác nhận.
5. Chọn nhiều dòng: thanh thao tác hàng loạt hiện; gán proxy và xóa hoạt động; hộp xác nhận xóa nêu rõ mất dữ liệu đăng nhập.
6. Chuyển dark/light (Settings → Giao diện): chữ, nền, viền, modal đều đọc được ở cả hai chế độ.
7. Thu cửa sổ về chiều rộng mobile (khoảng 400 px): không có thanh cuộn ngang cấp trang, không chồng chữ; cột Nhóm/Proxy/Mở gần nhất ẩn đi; modal vừa màn hình.
8. Chiều cao cửa sổ 720 px: các nút cuối Sidebar (Cài đặt) vẫn nhìn thấy và bấm được.
9. Settings → Nhân viên → xem thử một nhân viên: nút "Trình duyệt" biến mất.
10. Bàn phím: Tab đi được qua ô tìm kiếm, bộ lọc, nút, checkbox; vòng focus nhìn thấy được.

- [ ] **Step 10: Commit**

```bash
git add DESIGN.md src/ui/lib/ipc.ts src/ui/store/appStore.ts src/ui/App.tsx src/ui/components/layout/Sidebar.tsx src/ui/features/browser/BrowserProfileForm.tsx src/ui/features/browser/BrowserProfilesView.tsx
git commit -m "feat(browser): add browser profiles screen"
```

---

## Task 8: Kiểm chứng tổng thể và tài liệu

**Files:**
- Modify: `SYSTEM_DOCUMENTATION.md`
- Modify: `docs/plans/2026-10-01-browser-profiles.md` (nếu có sai khác)

Task này không thêm code. Nó chạy hai vòng kiểm thử trên Linux và Windows theo `AGENTS.md` (mỗi vòng gồm desktop và mobile, dark và light), rồi cập nhật tài liệu.

- [ ] **Step 1: Kiểm chứng tự động**

Run:

```bash
npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.json --noEmit
npx jest
npm run build:electron
npm run build:renderer
```

Expected: hai lệnh tsc không in gì; jest `Test Suites: 4 passed, 4 total`, `Tests: 50 passed, 50 total`; hai lệnh build không lỗi. Dán output vào mô tả PR.

- [ ] **Step 2: Vòng 1 trên Linux (`npm run dev`)**

1. **Tải nhân:** bấm "Tải trình duyệt". Tiến độ MB tăng dần; xong thì banner biến mất. Kiểm tra file đánh dấu tồn tại: `find ~/.config -maxdepth 4 -path '*browser-engine/148.0.7778.215/installed.json'` in ra đúng một đường dẫn (thư mục `userData` của app do `app.setName('AHV Connect')` trong `electron/main.ts` quyết định).
2. **Fingerprint khác nhau và ổn định:** tạo profile A và B, mở cả hai, vào `https://abrahamjuliot.github.io/creepjs/`. "FP ID" của A khác B. Đóng A, mở lại A: "FP ID" giống lần trước.
3. **Giữ phiên:** trong A, đăng nhập một trang bất kỳ (hoặc đặt cookie bằng cách đổi ngôn ngữ trên `https://www.google.com`). Bấm "Đóng" trong AHV Connect, mở lại: phiên còn nguyên.
4. **Trạng thái:** đóng cửa sổ trình duyệt bằng nút X của nó; trong vòng 2 giây dòng profile chuyển về "Đã dừng".
5. **Chặn mở trùng:** bấm "Mở" hai lần thật nhanh; chỉ có một cửa sổ trình duyệt.
6. **Proxy có mật khẩu:** thêm một proxy thật có username/password trong Settings → Proxy, gán cho B, mở B, vào `https://browserleaks.com/ip`: IP hiển thị là IP proxy. Vào `https://browserleaks.com/webrtc`: không hiện IP thật của máy.
7. **Proxy chết:** sửa cổng proxy thành cổng sai, mở lại B: trang báo lỗi proxy, không tải được trang nào bằng IP thật.
8. **Xóa:** xóa profile đang mở bị từ chối (nút xóa mờ); đóng rồi xóa: thư mục `browser-profiles/<id>` biến mất.
9. **Thoát app:** mở 2 profile rồi thoát AHV Connect. Sau 5 giây, `pgrep -f ungoogled-chromium` không trả về gì, và `pgrep -f "electron dist-electron"` không trả về gì.
10. **Chuyển workspace:** mở 1 profile, chuyển sang workspace khác: trình duyệt đóng; danh sách profile của workspace mới độc lập với workspace cũ.

- [ ] **Step 3: Vòng 1 trên Windows**

Lặp lại đủ 10 mục của Step 2 trên một máy Windows 10/11. Đây là bước rủi ro cao nhất (mục 4). Ghi lại riêng ba kết quả:

- Tải và giải nén bằng `tar` thành công: lệnh `dir /s /b "%APPDATA%\chrome.exe" | findstr browser-engine` in ra một đường dẫn kết thúc bằng `browser-engine\148.0.7778.215\ungoogled-chromium_148.0.7778.215-1.1_windows_x64\chrome.exe`.
- Mục 3 (giữ phiên sau khi bấm "Đóng" trong AHV Connect) đạt.
- Mục 9: sau khi thoát app, Task Manager không còn `chrome.exe` của nhân trình duyệt.

Nếu bất kỳ mục nào trong ba mục trên không đạt: dừng, không merge, ghi lại hiện tượng và cập nhật kế hoạch này với phương án sửa trước khi làm tiếp.

- [ ] **Step 4: Vòng 2 — tải nặng và hồi quy**

1. **1.000 profile:** trong DevTools Console chạy:

```js
for (let i = 1; i <= 1000; i++) await window.electronAPI.browserProfile.create({ name: `Load ${String(i).padStart(4, '0')}` });
```

   Mở lại màn hình Trình duyệt: danh sách hiện trong dưới 1 giây, phân trang 20 trang, tìm "Load 0999" ra đúng 1 dòng, chọn tất cả trên trang rồi xóa hoạt động. Kiểm tra ở cả chiều rộng desktop và mobile, cả dark và light.
2. **Giới hạn 30:** chọn 31 profile và bấm "Mở" hàng loạt (máy cần đủ RAM; nếu không đủ, tạm sửa `MAX_RUNNING_PROFILES` thành 3 trên máy dev để thử rồi hoàn lại). Profile vượt giới hạn báo "Đã đạt giới hạn ... profile mở cùng lúc" và việc mở hàng loạt dừng lại.
3. **Hồi quy** (mỗi mục phải hoạt động như trước khi có thay đổi):
   - Chat: mở một hội thoại Zalo, gửi và nhận một tin nhắn.
   - CRM: mở danh sách liên hệ.
   - Workflow: mở trình soạn workflow, mở một workflow có sẵn.
   - Settings → Proxy: thêm, sửa, test, xóa một proxy; gán proxy cho một account Zalo.
   - Chuyển workspace qua lại; app không báo lỗi DB.
   - Thoát app: tiến trình thoát hẳn trong vòng 5 giây.
   - Chế độ employee (nếu có workspace remote): không thấy nút "Trình duyệt"; trong Console, `await window.electronAPI.browserProfile.list()` trả `success: false`.
4. Xóa 1.000 profile thử nghiệm.

- [ ] **Step 5: Cập nhật `SYSTEM_DOCUMENTATION.md`**

Tìm tiêu đề `## 5. Mô hình dữ liệu theo nhóm`. Chèn khối sau ngay phía trên nó:

```md
### 4.9 Trình duyệt (Browser Profiles)

- Mỗi profile là một trình duyệt Chromium antidetect riêng (nhân `fingerprint-chromium` 148.0.7778.215) với fingerprint cố định, thư mục dữ liệu riêng và proxy riêng lấy từ kho proxy hiện có.
- Nhân trình duyệt không nằm trong bộ cài; người dùng tải lần đầu (khoảng 190 MB), có kiểm SHA-256, lưu tại `<userData>/browser-engine/`.
- Profile có proxy đi qua một proxy chuyển tiếp cục bộ trên `127.0.0.1` do main process chạy; proxy lỗi thì trình duyệt nhận `502`, không chuyển sang kết nối trực tiếp.
- Tối đa 30 profile mở đồng thời. Trạng thái đang chạy chỉ nằm trong bộ nhớ.
- Chỉ dùng được ở chế độ Boss/Standalone, trên Windows và Linux. Persona luôn trùng hệ điều hành máy thật.
- Dữ liệu trình duyệt (cookie, phiên đăng nhập) nằm tại `<thư mục DB của workspace>/browser-profiles/<id>/` và **chưa được mã hóa**.
- Chuyển workspace hoặc thoát app sẽ đóng mọi profile đang mở.

Nguồn: `src/services/browser/`, `electron/ipc/browserProfileIpc.ts`, `src/ui/features/browser/`, `src/configs/browserEngine.config.ts`, `docs/plans/2026-10-01-browser-profiles.md`.

```

- [ ] **Step 6: Rà lại diff và commit**

```bash
git diff main --stat
git diff main -- electron/main.ts electron/preload.ts electron/ipc/workspaceIpc.ts src/services/database/DatabaseService.ts
```

Xác nhận: không có file nào ngoài danh sách ở mục 2 bị thay đổi; không còn `console.log` gỡ lỗi; `MAX_RUNNING_PROFILES` vẫn là 30.

`SYSTEM_DOCUMENTATION.md` hiện chưa được git theo dõi và có nội dung không thuộc tính năng này. Hỏi chủ sản phẩm trước khi đưa file này vào commit.

Ghi kết quả kiểm chứng của Step 1–4 vào mô tả PR. Nếu kế hoạch có chỉnh sửa trong quá trình làm mà chưa commit:

```bash
git add docs/plans/2026-10-01-browser-profiles.md
git commit -m "docs(browser): update browser profiles plan after verification"
```

Không `git push` và không build production khi chưa được chủ sản phẩm duyệt.

---

## Rủi ro đã biết còn lại sau MVP

- Nhân trình duyệt đang chậm phiên bản so với Chrome chính thức (bản 148 từ 06/2026) và do một tác giả duy trì. Đổi nhân chỉ cần sửa `src/configs/browserEngine.config.ts` và `buildLaunchArgs`.
- Giả lập GPU (WebGL) trên Windows chưa được đo với GPU thật.
- 30 profile cần hơn 8,5 GB RAM; MVP chỉ chặn theo số lượng.
- Thư mục dữ liệu profile không mã hóa.
- Độ phân giải màn hình không được giả lập.
- Kill cứng dự phòng của `closeAll()` dựa trên timer 5 giây; khi thoát app, tiến trình có thể kết thúc trước khi timer chạy nên trình duyệt treo vẫn có thể còn sót lại.
- Nếu AHV Connect crash khi profile đang mở, trình duyệt con có thể còn chạy; mở lại profile đó sẽ không thành công cho đến khi cửa sổ cũ được đóng.
- Tiêu chí "nuôi tài khoản thật không bị khóa" trong intent phải do đội vận hành kiểm chứng bằng tài khoản thật; kế hoạch này không kiểm chứng được.
