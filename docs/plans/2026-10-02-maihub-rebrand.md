# MaiHub Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ứng dụng mang thương hiệu MaiHub ở mọi nơi người dùng nhìn thấy, dữ liệu cũ tự chuyển sang thư mục mới; hệ thiết kế và tính năng giữ nguyên.

**Architecture:** Đổi định danh ở `package.json`/`electron/main.ts`/scripts/CI; thêm một module thuần `src/services/app/legacyDataMigration.ts` quyết định việc đổi tên thư mục dữ liệu, gọi từ `main.ts` trước single-instance lock; vẽ lại `resources/icons/icon.svg` và dựng icon; thay chữ trong renderer và tài liệu.

**Tech Stack:** Electron 41, React, electron-builder, jest (ts-jest transpile-only), `scripts/build-icons.mjs` (cần Chrome).

**Spec:** `docs/specs/2026-10-02-maihub-rebrand.md`. Intent: `docs/intent/2026-10-02-maihub-rebrand.md`.

## Global Constraints

- Tên hiển thị `MaiHub`; gói `maihub`; `appId` `com.maihub.app`; scheme `maihub`; thư mục dữ liệu `MaiHub`; phiên bản `26.9.0`.
- Giữ nguyên: `ahvchat`/`ahvholding/model/*`, tên file DB, `NOTICE.md` (chỉ thêm), nhật ký phiên bản cũ, `docs/` của tính năng trước, test fixture `'ahv user'`.
- Không viết email cá nhân vào bộ cài. `deb.maintainer` dùng `MaiHub <maiychrus25@users.noreply.github.com>`.
- Không sửa hành vi tính năng; không refactor ngoài phạm vi.
- Lệnh kiểm chứng (chạy từng lệnh, có giới hạn RAM như ghi trong `docs/plans/2026-10-01-browser-profiles.md`): `tsc -p tsconfig.electron.json --noEmit`, `tsc -p tsconfig.json --noEmit`, `npx jest`.

## Review Focus

1. Mở MaiHub khi AHV Connect cũ đang chạy: không được đổi tên thư mục đang dùng. Test: `legacyDataMigration.test.ts` "refuses while legacy instance is alive".
2. Chạy lần thứ hai sau khi đã chuyển: không được đụng gì. Test: "no-op when new dir exists".
3. Giá trị mã hóa cũ không giải mã được (Linux/macOS): app vẫn mở, tài khoản hiện là cần đăng nhập lại, không crash. Kiểm tay ở Task 6 (các điểm gọi `decryptString` đều đã bọc `try/catch`, xác nhận bằng grep).
4. Đường dẫn ảnh tuyệt đối cũ trong DB: handler `local-media://` đã có fallback về thư mục hiện tại khi file không tồn tại; kiểm tay ở Task 6 bằng một avatar Telegram.
5. Người dùng Windows: `rename` thất bại vì file bị khóa → hộp thoại rõ ràng, không mất dữ liệu. Test: "reports failure when rename throws".

---

## Task 1: Định danh trong package, main process, scripts, CI

**Files:** Modify `package.json`, `package-lock.json` (2 dòng version + name), `electron/main.ts`, `electron/ipc/lockScreenIpc.ts`, `scripts/patch-electron-icon.js`, `scripts/after-pack.js`, `scripts/build-icons.mjs`, `.github/workflows/build.yml`, `index.html`, `.gitignore`.

- [x] Thay theo bảng mục 1 của spec. Trong `main.ts`: `app.setName('MaiHub')`, AUMID `com.maihub.app`, scheme `maihub` (6 chỗ), chuỗi khay/thông báo/menu, chú thích.
- [x] `package.json`: `name` `maihub`, `version` `26.9.0`, `description` bỏ "cá nhân"? (giữ), `author` `MaiHub`, `homepage` kho GitHub, `build.appId`, `productName`, `protocols.name` `MaiHub Deep Link`, `schemes` `maihub`, `dmg.title`, `deb.maintainer`.
- [x] `tsc -p tsconfig.electron.json --noEmit` sạch. Commit `chore(brand): rename app identifiers to MaiHub`.

## Task 2: Chuyển dữ liệu cũ

**Files:** Create `src/services/app/legacyDataMigration.ts`, `src/__tests__/app/legacyDataMigration.test.ts`; Modify `electron/main.ts`.

**Interfaces:** `planLegacyMigration({ legacyDir, newDir, exists, isLegacyRunning }): 'skip' | 'migrate' | 'blocked'`; `migrateLegacyUserData({ legacyDir, newDir, fs, platform }): { status: 'skipped'|'migrated'|'blocked'|'failed', error? }`.

- [x] Test trước: skip khi newDir tồn tại; skip khi legacyDir không tồn tại; blocked khi legacy đang chạy (SingletonLock trỏ tới pid sống); migrated khi rename thành công và xóa `SingletonLock/SingletonCookie/SingletonSocket`; failed khi rename ném lỗi (thư mục cũ còn nguyên).
- [x] Implement. Trong `main.ts`, ngay sau `app.setName`: gọi `migrateLegacyUserData` với `legacyDir = path.join(app.getPath('appData'), 'AHV Connect')`, `newDir = app.getPath('userData')`. `blocked`/`failed` → `dialog.showErrorBox` ("Hãy thoát AHV Connect rồi mở lại MaiHub" / lỗi), `app.exit(1)`.
- [x] jest + tsc sạch. Commit `feat(brand): migrate AHV Connect user data into MaiHub on first launch`.

## Task 3: Logo

**Files:** Modify `resources/icons/icon.svg`, dựng lại `resources/icons/*` qua `node scripts/build-icons.mjs`; `src/ui/components/layout/Sidebar.tsx` (dấu hiệu rút gọn); `DESIGN.md` (phần logo).

- [x] Vẽ hoa mai năm cánh (cánh tròn bán kính ~22, tâm cách gốc 24, chấm tâm bán kính 9 màu nền), giữ `.unread-badge` ẩn. Dựng icon; mở PNG 16/24/32 soi mắt.
- [x] Commit `feat(brand): MaiHub plum-blossom logo`.

## Task 4: Chữ trong giao diện và mã nguồn renderer

**Files:** `src/ui/components/{auth/EmployeeLoginScreen,auth/LockScreen,layout/Sidebar,layout/TopBar,settings/Settings,settings/TunnelSettings,settings/LogViewer,settings/IntroductionSettings,workflow/*,integration/platformOrderAdapters,common/UpdateNotification}.tsx|ts`, `src/ui/features/erp/hrm/HrmPage.tsx`, `src/services/workflow/WorkflowEngineService.ts`, `src/ui/components/settings/ChangelogSettings.tsx` (mục 26.9.0).

- [x] Thay "AHV Connect" → "MaiHub"; bỏ "Trung tâm Đào tạo Lái xe AHV"; `IntroductionSettings` viết lại đoạn giới thiệu (dự án cá nhân, mã nguồn mở, nguồn gốc xem NOTICE). Nguồn đơn hàng `maihub`/`MAIHUB-`; bộ lọc `order_sources: ['maihub', 'ahvconnect']`.
- [x] Thêm mục nhật ký 26.9.0. `tsc -p tsconfig.json --noEmit` sạch. Commit `feat(brand): MaiHub strings in the interface`.

## Task 5: Tài liệu

**Files:** `README.md`, `NOTICE.md` (thêm dòng), `DESIGN.md` (brand/owner, logo), `SYSTEM_DOCUMENTATION.md` (tên và nhà phát hành, mục chuyển dữ liệu).

- [x] README: tên, mô tả, cài song song và gỡ bản cũ, đăng nhập lại trên Linux/macOS. Commit `docs(brand): MaiHub documentation`.

## Task 6: Kiểm chứng

- [x] Ba lệnh kiểm chứng sạch. `grep -rIn -i "ahv"` ngoài danh sách giữ nguyên = 0 kết quả.
- [x] Bản cách ly: tạo `<cfg>/AHV Connect` bằng cách chạy bản cũ (hoặc copy dữ liệu nhỏ), chạy bản mới → `<cfg>/MaiHub` có DB, thư mục cũ không còn, app mở được, Sidebar hiện MaiHub và logo mới; chụp light/dark, 1440 và 400 px.
- [x] CI build-only trên nhánh. Ghi kết quả vào mục dưới.

## Kết quả kiểm chứng (02/10/2026, Linux)

- `tsc` hai cấu hình sạch; `npx jest` 8 suites, 184 test qua; build main + renderer qua.
- Quét mã nguồn: "AHV" chỉ còn ở danh sách giữ nguyên, trong code chuyển dữ liệu, ghi chú nâng cấp của README/NOTICE/nhật ký phiên bản.
- Bản cách ly (`XDG_CONFIG_HOME` tạm, bản sao DB thật 16 MB, thư mục browser-profiles, media, SingletonLock trỏ pid chết): lần mở đầu in `[main] Đã chuyển dữ liệu AHV Connect → MaiHub`; thư mục `AHV Connect` biến mất, `MaiHub` có đủ DB, browser-profiles, media, workspaces.json; lần mở thứ hai không chuyển lại. Trong app: 4 tài khoản, 12 workflow, 1 profile trình duyệt; tài khoản hiện "Reconnect"/"Cập nhật Cookie" (khóa mã hóa đổi theo tên app, đúng như spec).
- Giao diện: tiêu đề cửa sổ MaiHub, logo hoa mai ở sidebar, v26.9.0; không còn chữ "AHV" ở Tổng quan, Cài đặt, Giới thiệu; light/dark, 1440 và 400 px không tràn ngang.
- Logo: soi 16/24/32/48/64/128 px, hoa và chấm đỏ đọc được ở 16 px.

**Phát hiện và sửa trong lúc kiểm chứng:** `app.getPath('userData')` ngay sau `app.setName()` vẫn trả thư mục mặc định (`Electron`) nên bước chuyển dữ liệu bị bỏ qua. Sửa: `app.setPath('userData', <appData>/MaiHub)` tường minh trước khi chuyển. Lưu ý cho người kiểm thử: chạy app với `--remote-debugging-port` làm Chromium tạo thư mục userData trước khi mã JS chạy, nên bước chuyển dữ liệu sẽ bị bỏ qua; kiểm chuyển dữ liệu bằng lần chạy không có cờ đó.

**Chưa làm:** Windows (rename khi file bị khóa) và macOS (Keychain) chưa thử; chỉ có unit test cho nhánh lỗi.
