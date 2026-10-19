# Tự thử lại khi đăng lỗi và mã lỗi cụ thể — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đăng Facebook tự thử lại lỗi xảy ra trước khi bấm Đăng (tối đa 3 lần cho mỗi đích), và mỗi kết quả lưu lý do cụ thể, mã lỗi, số lần thử.

**Architecture:**
- `postToSingleTarget` trả về một lần thất bại có cấu trúc: mã lỗi, câu lỗi, và cờ "đã bấm Đăng chưa".
- Vòng lặp từng đích trong `postToTargets` quyết định thử lại, dọn bản nháp, rồi chạy lại.
- `FacebookPosterService` ánh xạ các lỗi ở mức dịch vụ (chưa đăng nhập, mở trình duyệt hỏng, dừng, đóng cưỡng bức) ra mã lỗi.
- Store thêm 2 cột. `runs.get`, CSV và Lịch sử hiển thị các trường mới.

**Tech Stack:** TypeScript, Playwright (playwright-core), better-sqlite3, React 18, jest.

**Spec:** `docs/specs/2026-10-16-poster-retry-error-codes.md` (đã duyệt).

## Global Constraints

- **Hằng số:**
  - `MAX_POST_ATTEMPTS = 3`
  - `RETRY_DELAY_MIN_SEC = 10`, `RETRY_DELAY_MAX_SEC = 30`
  - `DISCARD_LABELS = ['Bỏ', 'Bỏ bài viết', 'Discard', 'Discard post', 'Rời khỏi', 'Leave']`
- **Mã lỗi:** đúng 13 mã ở bảng spec §2. Câu `error` tiếng Việt theo đúng bảng đó. Thông báo gốc cắt còn ≤ 200 ký tự.
- **Không bao giờ thử lại sau cú bấm Đăng.** Ranh giới đúng như spec §3.2. Huỷ cắt ngang mọi lúc chờ.
- **Dữ liệu cũ:** cột mới có mặc định `error_code = ''` và `attempts = 1`. Kết quả không phải `post` luôn dùng giá trị mặc định này.
- **Chỉ thêm, không đổi:** chỉ thêm trường vào Control API và CSV. Hai cột CSV mới đặt ở **cuối**.
- **Không đăng thật lên Facebook trong test.** Giữ nguyên hành vi tham gia nhóm, quét nhóm, thu bình luận và bình luận đầu.
- **Ngôn ngữ:** định danh tiếng Anh, chữ hiển thị và log tiếng Việt, theo phong cách file đang sửa.
- **Lệnh chạy:**
  - jest: `npx jest --runInBand <paths>`. better-sqlite3 đã build cho Node: **không** chạy `rebuild:native` hay `prebuild-install`.
  - tsc: chạy **riêng từng lệnh**: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi lệnh tương tự với `-p tsconfig.json`.
- **Tài liệu:** cập nhật `SYSTEM_DOCUMENTATION.md` và `docs/protocol/maihub-control-protocol.md` trong cùng commit với thay đổi hành vi. `node scripts/check-docs.js` phải sạch.
- **Git:** `git add` đúng đường dẫn. Commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **Lỗi bất ngờ ngay sau cú bấm Đăng** (ví dụ trang đóng): phải là `uncertain_after_submit`, không thử lại. → Task 1, 2.
2. **Huỷ đúng lúc đang chờ 10–30 giây để thử lại:** dừng ngay, kết quả là `stopped`/`skipped`, không mở lại trang. → Task 2.
3. **Lần thử lại gặp ô nhập còn chữ của lần trước:** xoá trước khi gõ; xoá không được thì `draft_conflict`. → Task 2.
4. **`submit_not_found` sau `enterCritical`:** phải `leaveCritical` trước khi chờ thử lại, để Huỷ đóng được trình duyệt. → Task 2.
5. **DB cũ chưa có cột mới:** migration chạy được, `getRun` trả `errorCode = ''`, `attempts = 1`. → Task 3.

---

### Task 1: Thất bại có cấu trúc trong `postToSingleTarget`

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts`
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts` (chỉ thêm test)

**Interfaces:**
- Produces:
  - `export type PostErrorCode = 'navigation_failed' | 'composer_not_found' | 'media_failed' | 'editor_not_focusable' | 'submit_not_ready' | 'submit_not_found' | 'unexpected_error' | 'uncertain_after_submit' | 'draft_conflict' | 'not_logged_in' | 'launch_failed' | 'stopped' | 'unknown'`
  - `export const RETRYABLE_POST_ERRORS: ReadonlySet<PostErrorCode>`: đúng 7 mã "Có" ở bảng spec §2.
  - `SingleTargetOutcome` thêm `errorCode?: PostErrorCode`, `error?: string`, `afterSubmit?: boolean`.
  - `PostTargetResult` thêm `errorCode: PostErrorCode | ''` và `attempts: number`.
- Mỗi điểm `return failed()` hiện có được gán mã và câu lỗi theo bảng spec §2.
  - Các điểm `getIsStopping()` → `stopped`.
  - "Đã click Đăng nhưng…" → `uncertain_after_submit`, `afterSubmit: true`.
- Ngoại lệ trong `postToSingleTarget`: vòng lặp bắt được thì phân loại theo việc `enterCritical` đã được gọi trong lần thử đó chưa (bọc `deps.enterCritical` để ghi nhận).
  - Lỗi `page.goto` lúc đầu → `navigation_failed`.
  - Ngoại lệ khác trước khi bấm → `unexpected_error`.
  - Ngoại lệ sau khi bấm → `uncertain_after_submit`.
- Ở task này chưa có thử lại: `attempts` luôn là 1.

- [ ] **Step 1:** Viết test ánh xạ mã:
  - `maps each failure point to its error code and message`, chạy trên trang giả: không thấy composer; không có nút Ảnh; không có ô tải tệp; ảnh chưa tải xong; không focus được ô nhập; bước cuối không có nút Đăng; nút Đăng tắt; không tìm thấy nút Đăng; dialog không đóng.
  - `goto throwing → navigation_failed`
  - `exception after enterCritical → uncertain_after_submit`
  - `success → errorCode ''`
  - `attempts is 1`
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` cho PASS (test cũ giữ nguyên).
- [ ] **Step 3:** Commit: `feat(poster): structured post failures with error codes`.

### Task 2: Vòng thử lại và dọn bản nháp

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts`
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts` (thêm test)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - Các hằng số `MAX_POST_ATTEMPTS`, `RETRY_DELAY_MIN_SEC`, `RETRY_DELAY_MAX_SEC`, `DISCARD_LABELS` (export để test dùng).
  - Vòng lặp từng đích chạy tối đa `MAX_POST_ATTEMPTS` lần theo spec §3.1.
- **Trước mỗi lần thử lại** (spec §3.3):
  1. `deps.leaveCritical?.()`.
  2. Ghi log `[Đăng Bài] Thử lại lần k/2 sau Xs: <error>`.
  3. `sleepStoppable(X)`.
  4. Huỷ trong lúc chờ → dừng, mã `stopped`.
  5. Bỏ bản nháp: `Escape`, rồi bấm nút có nhãn trong `DISCARD_LABELS` nếu thấy.
  6. Đăng ký `page.once('dialog', d => d.accept())` chỉ cho lần điều hướng này, rồi gỡ.
- **Ở lần thử ≥ 2,** trong `postToSingleTarget` sau khi focus được ô nhập: nếu ô có chữ thì `Control+A` + `Backspace`. Vẫn còn chữ → `draft_conflict`.
  - Truyền `attempt` vào `postToSingleTarget` qua `deps`.
  - Hàm đọc chữ trong ô nhập là hàm in-page mới, có test như các hàm `*InPage` khác.
- `onResult` chỉ gọi **một lần** cho mỗi đích, với kết quả của lần cuối và `attempts`.

- [ ] **Step 1:** Viết test (trang giả, `sleep` giả, không chờ thật):
  - `composer missing once then success → ok, attempts 2, retry log line`
  - `fails 3 times → failed, attempts 3`
  - `uncertain_after_submit → no retry`
  - `submit_not_found → leaveCritical called before retry`
  - `cancel during retry wait → stopped, no further goto`
  - `leftover editor text cleared before typing on retry`
  - `uncleared text → draft_conflict, no further retry`
  - `not retryable codes are not retried`
  - `onResult called once per target`
  - `delay between targets unchanged`
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster` cho PASS.
- [ ] **Step 3:** Commit: `feat(poster): retry pre-submit failures up to 3 attempts`.

### Task 3: Mã lỗi mức dịch vụ, lưu trữ, `runs.get`, CSV

**Files:**
- Modify:
  - `src/services/facebookPoster/FacebookPosterService.ts`
  - `src/services/facebookPoster/schema.ts`: 2 lệnh `ALTER` trong `FB_POSTER_MIGRATIONS`.
  - `src/services/facebookPoster/FacebookPosterStore.ts`
  - `src/models/facebookPoster.ts`
  - `src/services/facebookPoster/runCsv.ts`
- Docs: `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md` (`runs.get`: `errorCode`, `attempts`, bảng mã).
- Test: `FacebookPosterService.test.ts`, `FacebookPosterStore.test.ts`, `runCsv.test.ts`, `src/__tests__/control/ControlMethods.test.ts` (chỉ thêm, hoặc sửa kỳ vọng `toEqual` cho trường mới).

**Interfaces:**
- Consumes: Task 1–2 (`PostTargetResult.errorCode`, `attempts`).
- Produces:
  - `FbPosterResult.errorCode: string`, `FbPosterResult.attempts: number`. `addResult` ghi, `getRun` đọc.
  - Service: `record()` nhận `errorCode`/`attempts`.
  - Ánh xạ mức dịch vụ:
    - `NOT_LOGGED_IN_ERROR` → `not_logged_in`;
    - lỗi mở trình duyệt/profile → `launch_failed`;
    - `skipped` vì dừng → `stopped`;
    - đóng cưỡng bức (`FORCED_CLOSE_ERROR`) → `uncertain_after_submit`;
    - lỗi không mã → `unknown` với câu mặc định cũ.
  - Các loại việc khác `post` ghi `''`/`1`.
  - `CSV_COLUMNS` thêm `'error_code', 'attempts'` ở cuối.

- [ ] **Step 1:** Viết test:
  - `migration adds error_code/attempts with defaults to an old DB`
  - `getRun returns errorCode/attempts`
  - Service map not_logged_in / launch_failed / stopped / forced close
  - `post results carry errorCode/attempts from the task`
  - `join/scan results default`
  - `csv has two new trailing columns`
  - `runs.get exposes errorCode and attempts`
- [ ] **Step 2:** Chạy test, xác nhận FAIL. Viết code. Chạy `npx jest --runInBand src/__tests__/facebookPoster src/__tests__/control`, cả 2 lệnh tsc và `check-docs`.
- [ ] **Step 3:** Commit: `feat(poster): store error codes and attempts, expose in runs.get and CSV`.

### Task 4: Lịch sử hiển thị "Thử N lần" và "Chưa chắc"

**Files:**
- Modify: `src/ui/features/facebookPoster/HistoryTab.tsx` (chỉ phần dòng kết quả)

**Interfaces:**
- Consumes: Task 3 (`errorCode`, `attempts` trong kết quả `getRun`).
- Theo spec §4.4:
  - chip `Thử N lần` khi `attempts > 1`;
  - chip cam `Chưa chắc` khi `errorCode = 'uncertain_after_submit'`, title là câu lỗi.
- Màu dùng các class đã có trong thư mục (đã remap cho chế độ sáng). Chip `whitespace-nowrap`, không tràn ngang ở 390 px.

- [ ] **Step 1:** Viết code. Chạy tsc `-p tsconfig.json`, phải sạch.
- [ ] **Step 2:** Commit: `feat(poster): show retry count and uncertain chip in history`.

### Task 5 (controller): Kiểm chứng và phát hành 26.20.0

- [ ] **Step 1:** Review toàn nhánh bằng Opus. Một lượt sửa, một re-review.
- [ ] **Step 2:** Hai vòng stress:
  - Toàn bộ jest, cả 2 lệnh tsc, `check-docs`.
  - Chạy app dev với dữ liệu tách riêng (`XDG_CONFIG_HOME`) và kết quả giả trong DB. Kiểm Lịch sử ở 1280/390 px, sáng/tối (chip, lý do lỗi, CSV có 2 cột mới).
  - Hồi quy: Lịch sử cũ hiển thị bình thường với bản ghi cũ.
- [ ] **Step 3:**
  - Tăng `package.json` lên 26.20.0, thêm changelog.
  - Cập nhật dòng phiên bản trong `SYSTEM_DOCUMENTATION.md`.
  - Đổi trạng thái spec sang "Đã phát hành", thêm "Ghi chú sau phát hành" nếu code khác spec.
  - Ghi "Điều chỉnh khi triển khai" vào plan.
  - Merge `main` (fast-forward), tag `v26.20.0`; anh push; kiểm tra CI.
