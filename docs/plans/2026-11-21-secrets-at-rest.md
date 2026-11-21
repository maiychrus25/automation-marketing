# Mã hoá bí mật lưu trên máy và bật sandbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bỏ bản cookie Facebook thô, mã hoá mật khẩu proxy và khoá phiên nhân viên bằng `safeStorage`, chuyển đổi dữ liệu cũ một lần, bật `sandbox: true` cho cửa sổ chính — bản 26.52.0.

**Architecture:** Một module thuần `secretCodec.ts` mã hoá/giải mã một giá trị (định dạng `enc:` + base64 như `SecureSettingsService` hiện dùng); `SecureSettingsService` và `DatabaseService` cùng dùng nó (tránh vòng import DatabaseService ↔ SecureSettingsService). `DatabaseService.migrateSecretsAtRest()` chạy sau mỗi lần mở một cơ sở dữ liệu, đánh dấu bằng khoá cài đặt.

**Tech Stack:** Electron 41 (`safeStorage`), better-sqlite3, TypeScript, Jest.

**Spec:** `docs/specs/2026-11-21-secrets-at-rest.md` (đọc cả mục 1 "sửa 21/11/2026": cookie Zalo đã mã hoá sẵn, Telegram để nguyên).

## Global Constraints

- Định dạng mã hoá: `enc:` + base64 của `safeStorage.encryptString(value)` — đúng như `SecureSettingsService` (`ENC_PREFIX`). Giá trị không có tiền tố `enc:` là dạng thô cũ, đọc nguyên.
- `safeStorage.isEncryptionAvailable()` sai → lưu thô như hiện nay, cảnh báo, không chuyển đổi.
- Giải mã thất bại → không bao giờ trả chuỗi `enc:` cho nơi dùng; nhật ký chỉ ghi tên bảng/cột/khoá và id nội bộ, không ghi giá trị.
- Khoá đánh dấu chuyển đổi: `secrets_at_rest_migrated` = `'done'` trong `app_settings`.
- Không đổi cách lưu `accounts.cookies` (Zalo đã mã hoá; Telegram cố ý thô), `accounts.imei`.
- Test dùng cơ sở dữ liệu thật trong thư mục tạm (mẫu `src/__tests__/database/markMessageRecalled.test.ts`) với `safeStorage` giả: `encryptString: (s) => Buffer.from('X' + s)`, `decryptString: (b) => { const s = b.toString(); if (!s.startsWith('X')) throw new Error('bad'); return s.slice(1); }`, `isEncryptionAvailable: () => true` (hoặc false cho ca không có).
- Định danh code tiếng Anh; không đụng `sites/` và `docs/specs/2026-10-30-ahv-modnix-website-foundation.md`.

## Review Focus

1. Sửa proxy trong giao diện mà không đổi mật khẩu: lưu lại đúng mật khẩu cũ (giao diện nhận bản đã giải mã), không mã hoá chồng `enc:enc:` (Task 1 test `savingAnAlreadyEncryptedValueDoesNotEncryptTwice`).
2. Mật khẩu proxy rỗng: vẫn rỗng, không thành `enc:` của chuỗi rỗng (Task 1).
3. Tài khoản Facebook có bản thô nhưng kho mã hoá hỏng/không có: chuyển bản thô vào kho rồi mới xoá, không mất phiên (Task 2).
4. Chạy chuyển đổi hai lần / mở lại app: không đổi gì thêm (Task 1, Task 2).
5. Khoá phiên nhân viên thô cũ: nhân viên đang đăng nhập vẫn dùng được sau khi chuyển sang lưu mã hoá (cùng giá trị) (Task 3).

---

### Task 1: Bộ mã hoá một giá trị, mật khẩu proxy, khung chuyển đổi

**Files:**
- Create: `src/services/secure/secretCodec.ts`
- Modify: `src/services/secure/SecureSettingsService.ts` (dùng codec, hành vi giữ nguyên)
- Modify: `src/services/database/DatabaseService.ts` (`saveProxy` ~3072, `updateProxy` ~3082, mọi hàm đọc `FROM proxies` ~3105-3135; thêm `migrateSecretsAtRest()`; gọi nó ngay sau mỗi cụm `this.migrate(); this.migrateFTS5(); this.migrateMediaLibrary();` khi mở cơ sở dữ liệu — các chỗ ~140, ~176, ~195, ~330)
- Test: `src/__tests__/secure/secretCodec.test.ts`, `src/__tests__/database/secretsAtRest.test.ts`

**Interfaces:**
- Produces (`secretCodec.ts`):
  - `export const ENC_PREFIX = 'enc:'`
  - `export function encryptSecret(value: string): string` — rỗng → rỗng; đã có tiền tố `enc:` → trả nguyên; không có mã hoá → trả nguyên (cảnh báo một lần); ngược lại `enc:`+base64.
  - `export function decryptSecret(stored: string | null | undefined): string | null` — null/rỗng → giữ nguyên (null hoặc `''`); không có tiền tố → trả nguyên (dạng thô cũ); có tiền tố → giải mã, lỗi → `null`.
- Produces (`DatabaseService`): `public migrateSecretsAtRest(): void` — trong một transaction: mã hoá mọi `proxies.password` khác rỗng chưa có tiền tố; (Task 2 bổ sung phần Facebook vào cùng hàm); đặt `secrets_at_rest_migrated='done'`. Bỏ qua nếu đã `done` hoặc không có mã hoá. Lỗi bị bắt và ghi cảnh báo (không chặn mở app).
- Đọc proxy: mọi dòng trả ra có `password = decryptSecret(row.password) ?? ''`; giải mã lỗi ghi `Logger.warn('[DatabaseService] proxy password could not be decrypted (id=<id>)')`.

- [ ] **Step 1: Test thất bại**
  - codec: `encryptsWithThePrefixAndDecryptsBack`, `emptyStaysEmpty`, `savingAnAlreadyEncryptedValueDoesNotEncryptTwice` (Review Focus 1), `legacyPlainValuesAreReadAsTheyAre`, `aValueThatCannotBeDecryptedReadsAsNull`, `withoutEncryptionValuesStayPlain`.
  - DB thật: `aSavedProxyPasswordIsStoredEncryptedAndReadBackPlain` (đọc thẳng `SELECT password FROM proxies` bắt đầu bằng `enc:`; `getProxyById` trả mật khẩu thật), `updatingAProxyWithItsShownPasswordKeepsIt`, `anEmptyProxyPasswordStaysEmpty` (Review Focus 2), `theMigrationEncryptsLegacyProxyPasswordsOnce` (chèn thô bằng SQL, chạy 2 lần, giá trị cột sau lần 2 giống lần 1 — Review Focus 4), `anUndecryptableProxyPasswordReadsAsEmpty`.
- [ ] **Step 2:** `npx jest src/__tests__/secure/secretCodec.test.ts src/__tests__/database/secretsAtRest.test.ts` — FAIL.
- [ ] **Step 3:** Viết codec; `SecureSettingsService.secureSet/secureGet` dùng `encryptSecret`/`decryptSecret` (giữ nguyên chữ cảnh báo hiện có nếu có thể, hành vi y như cũ); sửa `DatabaseService` như Interfaces.
- [ ] **Step 4:** Test PASS; `npx jest src/__tests__/secure src/__tests__/database src/__tests__/browser`; hai lệnh `tsc` sạch.
- [ ] **Step 5:** Commit `feat(security): mã hoá mật khẩu proxy lưu trên máy`.

### Task 2: Bỏ bản cookie Facebook thô

**Files:**
- Modify: `electron/ipc/facebookIpc.ts` (`_addFBAccountCommon` ~206 `cookie_encrypted: cookie`; `applyFbAccountCookie` câu `UPDATE fb_accounts SET cookie_encrypted = ?`)
- Modify: `src/services/database/DatabaseService.ts` (hai câu `INSERT INTO fb_accounts` ~8132, ~8190 và hàm nhận `cookie_encrypted`; `migrateSecretsAtRest()` thêm phần Facebook)
- Test: `src/__tests__/database/secretsAtRest.test.ts` (thêm ca), `src/__tests__/facebook/updateCookieIpc.test.ts` (thêm ca)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Task 1), `secureGet`/`secureSet` (key `fb_cookie_<id>`).
- Ghi: mọi chỗ ghi `fb_accounts.cookie_encrypted` ghi `''` (cột giữ nguyên trong lược đồ); cookie chỉ nằm trong kho `fb_cookie_<id>`.
- Chuyển đổi (trong `migrateSecretsAtRest`, cùng transaction và cùng khoá đánh dấu): với mỗi dòng `fb_accounts` có `cookie_encrypted` khác rỗng — nếu `secureGet('fb_cookie_<id>')` trả giá trị → đặt cột `''`; nếu không (không có hoặc giải mã lỗi) → `secureSet('fb_cookie_<id>', <bản thô>)` rồi đặt cột `''`. `readStoredCookie` (`FacebookAccountCookie.ts`) giữ nguyên.
- `secureGet`/`secureSet` nhận tham số `db` — trong `DatabaseService` truyền `this` để không gọi `getInstance()` vòng.

- [ ] **Step 1: Test thất bại:** `aNewFacebookAccountLeavesNoPlainCookieInItsRow`, `applyFbAccountCookieNoLongerWritesThePlainCopy` (trong updateCookieIpc.test: không có `UPDATE fb_accounts SET cookie_encrypted` với cookie), `theMigrationClearsThePlainCopyWhenTheStoreHasTheCookie`, `theMigrationMovesThePlainCopyIntoTheStoreWhenTheStoreCannotBeRead` (Review Focus 3: kho chứa `enc:` hỏng → sau chuyển đổi `secureGet` trả bản thô cũ, cột rỗng), `runningTheMigrationTwiceChangesNothing`.
- [ ] **Step 2:** Chạy — FAIL.
- [ ] **Step 3:** Sửa như Interfaces.
- [ ] **Step 4:** `npx jest src/__tests__/database src/__tests__/facebook`; `tsc` sạch.
- [ ] **Step 5:** Commit `feat(security): bỏ bản cookie Facebook dạng thô`.

### Task 3: Khoá phiên nhân viên lưu mã hoá

**Files:**
- Modify: `src/services/employee/EmployeeService.ts:28-45`
- Test: `src/__tests__/employee/jwtSecretAtRest.test.ts`

**Interfaces:**
- Consumes: `secureGet`/`secureSet` (`src/services/secure/SecureSettingsService.ts`).
- Đọc `employee_jwt_secret` bằng `secureGet` (dạng thô cũ trả nguyên); nếu giá trị đọc được là dạng thô (giá trị lưu chưa có `enc:`) → `secureSet` lại cùng giá trị. `secureGet` trả `null` vì giải mã lỗi → tạo khoá mới như nhánh "chưa có" hiện tại. Ghi khoá mới bằng `secureSet`. `employee_jwt_secret_version` giữ thô (không phải bí mật).

- [ ] **Step 1: Test thất bại** (`db` giả có `getSetting/setSetting`, `safeStorage` giả): `aLegacyPlainSecretIsKeptAndStoredEncrypted` (Review Focus 5: token ký trước khi chuyển vẫn `verify` được sau), `aNewSecretIsStoredEncrypted`, `anUndecryptableSecretIsReplaced`.
- [ ] **Step 2:** Chạy — FAIL.
- [ ] **Step 3:** Sửa EmployeeService.
- [ ] **Step 4:** `npx jest src/__tests__/employee`; `tsc` sạch.
- [ ] **Step 5:** Commit `feat(security): khoá phiên nhân viên lưu mã hoá`.

### Task 4: Sandbox cửa sổ chính, tài liệu, phiên bản

**Files:**
- Modify: `electron/main.ts:389` (`sandbox: false` → `true`)
- Modify (nếu cần): `electron/preload.ts` — chỉ khi preload dùng API ngoài sandbox (Node `fs`/`path`/`Buffer`/`__dirname`/`require` khác `electron`)
- Test: `src/__tests__/app/mainWindowSandbox.test.ts`
- Modify: `SYSTEM_DOCUMENTATION.md` (dòng phiên bản 26.52.0; dòng Trạng thái; một đoạn "Bí mật lưu trên máy (26.52.0)" mô tả: cookie Facebook chỉ trong kho mã hoá, mật khẩu proxy và khoá phiên nhân viên `enc:`, cookie Zalo đã mã hoá từ trước, phiên/token Telegram cố ý thô, khoá `secrets_at_rest_migrated`, quay về ≤ 26.51.0 phải nhập lại mật khẩu proxy, sandbox; marker `<!-- docs-check: src/services/secure/secretCodec.ts#ENC_PREFIX = 'enc:' -->`)
- Modify: `src/ui/components/settings/ChangelogSettings.tsx` (26.51.0 → mục mới 26.52.0, `type: 'minor'`, category `'security'`), `package.json`/`package-lock.json` (`npm version 26.52.0 --no-git-tag-version`), spec dòng Trạng thái.

- [ ] **Step 1: Test thất bại:** `theMainWindowRunsSandboxed` (đọc nguồn `electron/main.ts`, khối `new BrowserWindow` của `mainWindow` có `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`), `thePreloadOnlyRequiresElectron` (đọc `electron/preload.ts`: mọi `import` không phải `import type` đều từ `'electron'`; không có `require(`, `process.versions`, `__dirname`, `Buffer`).
- [ ] **Step 2:** Chạy — FAIL (sandbox đang false).
- [ ] **Step 3:** Bật sandbox; sửa preload nếu test thứ hai chỉ ra; tài liệu, changelog, phiên bản.
- [ ] **Step 4:** Test PASS; `npx jest src/__tests__/app src/__tests__/docs`; `tsc` sạch; `node scripts/check-docs.js` sạch.
- [ ] **Step 5:** Commit `feat(security): bật sandbox cho cửa sổ chính; tài liệu 26.52.0`.

## Kiểm chứng cuối (người điều phối)

- Hai lệnh `tsc`; Jest ×3 (`TZ=UTC`; `TZ=America/New_York --randomize --seed=2707`; `TZ=Asia/Ho_Chi_Minh --randomize --seed=3707`); `node scripts/check-docs.js`; unittest Python của bridge.
- Quét: `rg "FROM proxies" src electron` chỉ trong `DatabaseService`; không còn chỗ ghi cookie vào `fb_accounts.cookie_encrypted`.
- Sandbox chỉ xác nhận được trên app đã cài: xin anh đồng ý cài, rồi thử mở app, chat Zalo/Facebook, gửi và kéo thả tệp, cài đặt; đọc thẳng cơ sở dữ liệu (chỉ đọc) thấy mật khẩu proxy `enc:` và cột cookie Facebook rỗng.
