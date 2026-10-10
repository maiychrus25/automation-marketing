# GĐ2 — Bản nháp và luồng duyệt: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng lưu nháp bài đăng Facebook, thấy nháp trên lịch, và chỉ khi duyệt thì nháp mới thành lịch thật (hẹn giờ hoặc đăng ngay).

**Architecture:** Nháp là một dòng `fb_poster_schedules` với cột mới `draft = 1`, luôn `enabled = 0`, `next_run_at = NULL`, nên scheduler (chỉ chạy `enabled = 1`) không bao giờ chạy nó. Logic nháp nằm trong module thuần `src/services/facebookPoster/drafts.ts` nhận phụ thuộc qua tham số (test được bằng SQLite trong bộ nhớ + thư mục tạm); handler IPC chỉ là lớp gọi mỏng. "Đăng ngay" đặt `next_run_at = now` rồi `scheduler.reschedule()` để đi qua hàng đợi sẵn có.

**Tech Stack:** Electron 41, TypeScript, React, better-sqlite3, jest (ts-jest), Tailwind + CSS token `--poster-*`.

**Spec:** `docs/specs/2026-10-10-poster-gd2-drafts-design.md` (approved). Intent: `docs/intent/intent.md`.

**Worktree:** `/home/maiychrus/deplao-builder-poster-ui`, nhánh `feat/poster-postiz-ui`. Mọi lệnh chạy từ thư mục này.

## Global Constraints

- Nháp chỉ bắt buộc **nội dung**; profile/nhóm/ảnh được thiếu; **duyệt** mới kiểm đầy đủ bằng `validateStartParams` (đã chốt ở spec).
- Bất biến: nháp luôn `enabled = 0`, `next_run_at = NULL`; scheduler lọc thêm `draft = 0`; `scheduleUpdate` không được bật nháp.
- Giờ dự kiến của nháp chỉ bị kiểm "≥ 1 phút sau hiện tại" khi **đổi giờ**.
- Định danh code tiếng Anh; chữ hiển thị tiếng Việt.
- Component không viết mã hex; màu mới là token `--poster-*` thêm ở **cả light và dark** trong `src/ui/index.css`.
- Giới hạn 200 lịch/workspace dùng chung cho cả nháp (`MAX_SCHEDULES`).
- Máy dev 16 GB: chạy `tsc` / `jest` / `vite build` **từng lệnh một**, không song song.
- **Không tạo lịch thật đã bật** trên máy khi thử UI. Nháp an toàn theo thiết kế; nếu cần lịch thật thì đặt xa trong tương lai, tạm dừng ngay, xoá sau khi xong. "Đăng ngay" chỉ thử tới hộp xác nhận rồi bấm Huỷ.
- Lệnh test:
  - Thường: `npx jest <đường dẫn> --silent`
  - Suite dùng SQLite (Store / Scheduler / Service / drafts): `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/jest/bin/jest.js <đường dẫn> --silent` (better-sqlite3 build cho ABI Electron; chạy bằng `npx jest` sẽ báo "did not self-register" — không phải lỗi code).

## Review Focus

1. **Sửa nháp đã quá giờ dự kiến mà không đổi giờ** → lưu được, giữ nguyên giờ cũ. Test: Task 3 "nháp đã quá giờ dự kiến vẫn lưu lại được".
2. **Nháp chưa chọn profile khi đang lọc theo kênh** → vẫn hiện trên lịch / dải "Nháp chưa xếp lịch", không biến mất. Test: Task 5.
3. **Lưu lại nháp giữ nguyên ảnh đã lưu của chính nó** (đường dẫn trỏ vào thư mục media của nháp) → ảnh còn nguyên, không lỗi, không bị xoá trước khi chép. Test: Task 2 `replaceScheduleMedia` + Task 3 "thay ảnh".
4. **Duyệt "Đăng ngay" khi đang có việc khác chạy** → không mở việc thứ hai, chờ trong hàng đợi rồi chạy khi xong. Test: Task 1 scheduler.
5. **Duyệt thất bại (thiếu profile/nhóm)** → nháp giữ nguyên là nháp, không nửa vời. Test: Task 3.

---

### Task 1: Cột `draft` — model, schema, store, scheduler

**Files:**
- Modify: `src/models/facebookPoster.ts` (interface `FbPosterSchedule`)
- Modify: `src/services/facebookPoster/schema.ts` (bảng `fb_poster_schedules`, `FB_POSTER_MIGRATIONS`)
- Modify: `src/services/facebookPoster/FacebookPosterStore.ts` (`mapSchedule`, `createSchedule`, `updateSchedule`, `listDueSchedules`, `nextScheduledAt`)
- Modify: `src/services/facebookPoster/FacebookPosterScheduler.ts` (`pumpQueue`)
- Modify (fixture): `src/__tests__/facebookPoster/scheduleUpdate.test.ts`, `src/__tests__/facebookPoster/calendarModel.test.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`, `src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts`

**Interfaces:**
- Produces: `FbPosterSchedule.draft: boolean`; `FacebookPosterStore.createSchedule(s: Omit<FbPosterSchedule, 'lastRunId' | 'updatedAt' | 'draft'> & { draft?: boolean })`; `updateSchedule(id, fields: Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt' | 'lastRunId' | 'kind' | 'draft' | 'params'>>, updatedAt)`.

- [ ] **Step 1: Viết test store (đỏ)** — thêm vào cuối `describe('schedules', …)` trong `FacebookPosterStore.test.ts`:

```ts
  test('draft: mặc định false, ghi/đọc được; updateSchedule đổi kind/draft/params', () => {
    const s = store();
    s.createSchedule(newSchedule('a'));
    assert.strictEqual(s.getSchedule('a')!.draft, false);
    s.createSchedule(newSchedule('d', { kind: 'once', days: [], time: '', runAt: null, enabled: false, nextRunAt: null, draft: true }));
    assert.strictEqual(s.getSchedule('d')!.draft, true);
    s.updateSchedule('d', { draft: false, kind: 'recurring', params: { kind: 'post', text: 'mới' } }, 5);
    const d = s.getSchedule('d')!;
    assert.deepStrictEqual([d.draft, d.kind, d.params], [false, 'recurring', { kind: 'post', text: 'mới' }]);
  });

  test('listDueSchedules/nextScheduledAt bỏ qua nháp kể cả khi dữ liệu lệch (enabled = 1)', () => {
    const s = store();
    s.createSchedule(newSchedule('d', { nextRunAt: 10, draft: true }));
    s.createSchedule(newSchedule('a', { nextRunAt: 20 }));
    assert.deepStrictEqual(s.listDueSchedules(100).map((x) => x.id), ['a']);
    assert.strictEqual(s.nextScheduledAt(), 20);
  });

  test('migration thêm cột draft cho bảng cũ chưa có cột', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE fb_poster_schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      params_json TEXT NOT NULL, run_at INTEGER DEFAULT NULL, days TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER DEFAULT NULL, last_run_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('old', 'x', 'once', '{}', 1, 1)`);
    const s = new FacebookPosterStore(db);
    s.ensureSchema();
    assert.strictEqual(s.getSchedule('old')!.draft, false);
  });
```

- [ ] **Step 2: Viết test scheduler (đỏ)** — thêm vào cuối `describe('FacebookPosterScheduler', …)` trong `FacebookPosterScheduler.test.ts`:

```ts
  test('draft schedules never start, even with inconsistent enabled/nextRunAt', () => {
    const { env, sched, add } = setup();
    add('d', { draft: true }); // add() mặc định enabled: true, nextRunAt: T0 — dữ liệu lệch có chủ đích
    sched.start();
    assert.deepStrictEqual(env.started, []);
  });

  test('a schedule due now (draft approved "now") waits while busy and starts after the run finishes', () => {
    const { env, sched, add } = setup();
    env.busy = true;
    add('n', { runAt: T0, nextRunAt: T0 });
    sched.start();
    assert.deepStrictEqual(env.started, []);
    assert.deepStrictEqual(sched.queuedIds(), ['n']);
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, ['n']);
  });
```

- [ ] **Step 3: Chạy để thấy đỏ**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/jest/bin/jest.js src/__tests__/facebookPoster/FacebookPosterStore.test.ts src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts --silent`
Expected: FAIL (`draft` undefined / lịch nháp bị chạy).

- [ ] **Step 4: Model** — trong `src/models/facebookPoster.ts`, interface `FbPosterSchedule`, ngay sau `enabled: boolean;` thêm:

```ts
    /** Bản nháp: luôn enabled = false, nextRunAt = null; chỉ thành lịch thật khi được duyệt. */
    draft: boolean;
```

- [ ] **Step 5: Schema + migration** — trong `src/services/facebookPoster/schema.ts`:
  - Trong `CREATE TABLE IF NOT EXISTS fb_poster_schedules`, ngay sau dòng `enabled       INTEGER NOT NULL DEFAULT 1,` thêm:

```sql
    draft         INTEGER NOT NULL DEFAULT 0, -- 1 = bản nháp: luôn enabled = 0, next_run_at = NULL, không bao giờ tự chạy
```

  - Trong `FB_POSTER_MIGRATIONS` thêm phần tử:

```ts
    'ALTER TABLE fb_poster_schedules ADD COLUMN draft INTEGER NOT NULL DEFAULT 0',
```

- [ ] **Step 6: Store** — trong `FacebookPosterStore.ts`:
  - `mapSchedule`: sau `enabled: row.enabled === 1,` thêm `draft: row.draft === 1,`.
  - Thay `createSchedule` bằng:

```ts
    createSchedule(s: Omit<FbPosterSchedule, 'lastRunId' | 'updatedAt' | 'draft'> & { draft?: boolean }): void {
        this.db.run(
            `INSERT INTO fb_poster_schedules
                (id, name, kind, params_json, run_at, days, time, enabled, draft, next_run_at, last_run_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [s.id, s.name, s.kind, JSON.stringify(s.params), s.runAt, s.days.join(','), s.time, s.enabled ? 1 : 0, s.draft ? 1 : 0, s.nextRunAt, s.createdAt, s.createdAt],
        );
    }
```

  - `updateSchedule`: đổi kiểu `fields` thành `Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt' | 'lastRunId' | 'kind' | 'draft' | 'params'>>` và thêm trước `set('updated_at', updatedAt);`:

```ts
        if (fields.kind !== undefined) set('kind', fields.kind);
        if (fields.draft !== undefined) set('draft', fields.draft ? 1 : 0);
        if (fields.params !== undefined) set('params_json', JSON.stringify(fields.params));
```

  - `listDueSchedules`: SQL thành `'SELECT * FROM fb_poster_schedules WHERE enabled = 1 AND draft = 0 AND next_run_at <= ? ORDER BY next_run_at, created_at'`.
  - `nextScheduledAt`: SQL thành `'SELECT MIN(next_run_at) AS t FROM fb_poster_schedules WHERE enabled = 1 AND draft = 0'`.

- [ ] **Step 7: Scheduler** — trong `pumpQueue` của `FacebookPosterScheduler.ts` đổi `if (!s || !s.enabled) continue;` thành:

```ts
            if (!s || !s.enabled || s.draft) continue;
```

- [ ] **Step 8: Cập nhật fixture có kiểu `FbPosterSchedule`** — thêm `draft: false,` vào:
  - `src/__tests__/facebookPoster/scheduleUpdate.test.ts`, object `base` (sau `enabled: true,`).
  - `src/__tests__/facebookPoster/calendarModel.test.ts`, hàm `schedule()` (sau `enabled: true,`).
  - Kiểm còn chỗ nào thiếu: `npx tsc -p tsconfig.json --noEmit` rồi `npx tsc -p tsconfig.electron.json --noEmit` (lần lượt). Expected: exit 0; lỗi "Property 'draft' is missing" nào còn thì thêm `draft: false` vào đúng literal đó.

- [ ] **Step 9: Chạy lại test (xanh)**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/jest/bin/jest.js src/__tests__/facebookPoster/FacebookPosterStore.test.ts src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts src/__tests__/facebookPoster/FacebookPosterService.test.ts --silent`
Expected: PASS toàn bộ. Rồi `npx jest src/__tests__/facebookPoster/scheduleUpdate.test.ts src/__tests__/facebookPoster/calendarModel.test.ts --silent` → PASS.

- [ ] **Step 10: Commit**

```bash
git add src/models/facebookPoster.ts src/services/facebookPoster/schema.ts src/services/facebookPoster/FacebookPosterStore.ts src/services/facebookPoster/FacebookPosterScheduler.ts src/__tests__/facebookPoster/
git commit -m "feat(fb-poster): draft column on schedules; scheduler never runs drafts"
```

---

### Task 2: Kiểm tra nháp, thay ảnh nháp, chặn bật nháp

**Files:**
- Modify: `src/services/facebookPoster/validateStartParams.ts` (thêm `validateDraftParams`)
- Modify: `src/services/facebookPoster/scheduleMedia.ts` (`sanitize`, thêm `replaceScheduleMedia`)
- Modify: `src/services/facebookPoster/scheduleUpdate.ts` (`planScheduleUpdate`, thêm `DRAFT_ENABLE_ERROR`)
- Test: `src/__tests__/facebookPoster/validateStartParams.test.ts`, `scheduleMedia.test.ts`, `scheduleUpdate.test.ts`

**Interfaces:**
- Consumes: `FbPosterSchedule.draft` (Task 1).
- Produces: `validateDraftParams(raw: unknown, env: StartParamsEnv): Record<string, unknown>` (trả `mediaPaths` tuyệt đối đã kiểm, `profiles: { profileId: string; targets: string[] }[]`); `replaceScheduleMedia(baseDir: string, scheduleId: string, sources: string[]): string[]`; `DRAFT_ENABLE_ERROR = 'Bản nháp phải được duyệt trước khi bật'`.

- [ ] **Step 1: Test `validateDraftParams` (đỏ)** — trong `validateStartParams.test.ts` đổi import thành `import { validateStartParams, validateDraftParams } from '../../services/facebookPoster/validateStartParams';` và thêm cuối file:

```ts
describe('validateDraftParams', () => {
  test('chỉ bắt buộc nội dung; profile, nhóm, ảnh được thiếu', () => {
    expect(validateDraftParams({ mode: 'group', text: 'hi' }, env)).toMatchObject({ mode: 'group', text: 'hi', mediaPaths: [], profiles: [] });
  });
  test('giữ profile và đích thô để duyệt sau, bỏ mục không hợp lệ và dòng trống', () => {
    const out = validateDraftParams({ mode: 'group', text: 'hi', profiles: [{ profileId: 'p1', targets: ['123', '  '] }, { nope: 1 }] }, env);
    expect(out.profiles).toEqual([{ profileId: 'p1', targets: ['123'] }]);
  });
  test('vẫn chặn nội dung rỗng, chế độ sai, ảnh không tồn tại', () => {
    expect(() => validateDraftParams({ mode: 'group', text: ' ' }, env)).toThrow('Nội dung bài không được để trống');
    expect(() => validateDraftParams({ mode: 'x', text: 'hi' }, env)).toThrow('Chế độ đăng không hợp lệ');
    expect(() => validateDraftParams({ mode: 'group', text: 'hi', mediaPaths: ['/missing.jpg'] }, env)).toThrow('Không tìm thấy tệp ảnh/video');
  });
});
```

- [ ] **Step 2: Test `replaceScheduleMedia` (đỏ)** — trong `scheduleMedia.test.ts` thêm `replaceScheduleMedia` vào import, rồi thêm trong `describe('scheduleMedia', …)` (dùng `base` và `makeSource` có sẵn của file):

```ts
  test('replaceScheduleMedia: giữ ảnh đang dùng (kể cả tệp nằm trong thư mục lịch), thêm ảnh mới, bỏ ảnh không dùng', () => {
    const first = copyScheduleMedia(base, 's1', [makeSource('a.jpg', 'A'), makeSource('b.jpg', 'B')]);
    assert.deepStrictEqual(first, ['01-a.jpg', '02-b.jpg']);
    const keep = resolveScheduleMedia(base, 's1', [first[1]]);
    const names = replaceScheduleMedia(base, 's1', [...keep, makeSource('c.jpg', 'C')]);
    assert.deepStrictEqual(names, ['01-b.jpg', '02-c.jpg']);
    const dir = scheduleMediaDir(base, 's1');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['01-b.jpg', '02-c.jpg']);
    assert.strictEqual(fs.readFileSync(path.join(dir, '01-b.jpg'), 'utf8'), 'B');
    assert.strictEqual(fs.existsSync(scheduleMediaDir(base, 's1-staging')), false);
  });
```

  Nếu `makeSource` trong file có chữ ký khác `(name, content) => string`, dùng đúng chữ ký sẵn có.

- [ ] **Step 3: Test chặn bật nháp (đỏ)** — trong `scheduleUpdate.test.ts` đổi import thành `import { planScheduleUpdate, LEAD_ERROR, DRAFT_ENABLE_ERROR } from '../../services/facebookPoster/scheduleUpdate';` và thêm trong `describe('planScheduleUpdate', …)`:

```ts
    it('a draft cannot be enabled through scheduleUpdate', () => {
        expect(() => planScheduleUpdate({ ...once, draft: true, enabled: false }, { enabled: true }, NOW)).toThrow(DRAFT_ENABLE_ERROR);
    });
    it('a draft can move its planned time and stays disabled', () => {
        expect(planScheduleUpdate({ ...once, draft: true, enabled: false }, { runAt: NOW + 3_600_000 }, NOW)).toEqual({ runAt: NOW + 3_600_000, nextRunAt: null });
    });
```

- [ ] **Step 4: Chạy để thấy đỏ**

Run: `npx jest src/__tests__/facebookPoster/validateStartParams.test.ts src/__tests__/facebookPoster/scheduleMedia.test.ts src/__tests__/facebookPoster/scheduleUpdate.test.ts --silent`
Expected: FAIL (hàm/hằng chưa có).

- [ ] **Step 5: `validateDraftParams`** — thêm cuối `validateStartParams.ts`:

```ts
/**
 * Bản nháp: chỉ bắt buộc nội dung (đã chốt ở spec GĐ2). Profile/nhóm/ảnh được thiếu; khi duyệt mới kiểm
 * đầy đủ bằng validateStartParams. Ảnh nếu có vẫn phải tồn tại và hợp lệ. Đích giữ nguyên dạng người dùng nhập.
 */
export function validateDraftParams(raw: unknown, env: StartParamsEnv): Record<string, unknown> {
    const p = asObject(raw);
    if (p.mode !== 'group' && p.mode !== 'page') throw new Error('Chế độ đăng không hợp lệ');
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) throw new Error('Nội dung bài không được để trống');
    if (text.length > MAX_TEXT) throw new Error(`Nội dung bài tối đa ${MAX_TEXT} ký tự`);
    const comment = typeof p.comment === 'string' ? p.comment : '';
    if (comment.length > MAX_COMMENT) throw new Error(`Bình luận tối đa ${MAX_COMMENT} ký tự`);
    const profiles = asArray(p.profiles).map(asObject)
        .filter((entry) => typeof entry.profileId === 'string' && entry.profileId !== '')
        .map((entry) => ({
            profileId: entry.profileId as string,
            targets: asArray(entry.targets).filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
        }));
    return { ...p, mode: p.mode, text, comment, mediaPaths: readMediaPaths(p, env), profiles };
}
```

- [ ] **Step 6: `replaceScheduleMedia`** — trong `scheduleMedia.ts`:
  - Đổi `sanitize` để không cộng dồn tiền tố số khi lưu lại nhiều lần:

```ts
function sanitize(name: string): string {
  return path.basename(name).replace(/^\d{2}-/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
}
```

  - Thêm cuối file:

```ts
/**
 * Ghi lại toàn bộ ảnh của một lịch (sửa nháp). Chép `sources` — có thể gồm chính tệp đang nằm trong thư mục
 * của lịch — sang thư mục tạm rồi mới tráo, nên tệp cũ không bị xoá trước khi chép xong; tệp không còn dùng biến mất.
 */
export function replaceScheduleMedia(baseDir: string, scheduleId: string, sources: string[]): string[] {
  assertValidId(scheduleId);
  const stagingId = `${scheduleId}-staging`;
  removeScheduleMedia(baseDir, stagingId);
  const names = copyScheduleMedia(baseDir, stagingId, sources);
  const dir = scheduleMediaDir(baseDir, scheduleId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(scheduleMediaDir(baseDir, stagingId), dir);
  return names;
}
```

- [ ] **Step 7: Chặn bật nháp** — trong `scheduleUpdate.ts` thêm sau `LEAD_ERROR`:

```ts
export const DRAFT_ENABLE_ERROR = 'Bản nháp phải được duyệt trước khi bật';
```

  và dòng đầu thân `planScheduleUpdate` (trước `const fields`):

```ts
    if (existing.draft && request.enabled !== undefined) throw new Error(DRAFT_ENABLE_ERROR);
```

- [ ] **Step 8: Chạy lại (xanh)** — cùng lệnh Step 4. Expected: PASS, kể cả các test cũ của `scheduleMedia` (nếu một test cũ dùng tên nguồn bắt đầu bằng `NN-` mà đổi kết quả, sửa expectation của đúng test đó cho khớp quy tắc không cộng dồn tiền tố và ghi lý do trong commit).

- [ ] **Step 9: Commit**

```bash
git add src/services/facebookPoster/validateStartParams.ts src/services/facebookPoster/scheduleMedia.ts src/services/facebookPoster/scheduleUpdate.ts src/__tests__/facebookPoster/
git commit -m "feat(fb-poster): draft validation, draft media replace, block enabling drafts"
```

---

### Task 3: Module `drafts.ts` — lưu, đọc, duyệt nháp

**Files:**
- Create: `src/services/facebookPoster/drafts.ts`
- Test: `src/__tests__/facebookPoster/drafts.test.ts`

**Interfaces:**
- Consumes: `FacebookPosterStore` (Task 1), `validateDraftParams` / `replaceScheduleMedia` (Task 2), `validateStartParams`, `copyScheduleMedia`, `resolveScheduleMedia`, `removeScheduleMedia`, `readName`, `readTiming`, `computeNextRun`.
- Produces:

```ts
export interface DraftDeps { store: FacebookPosterStore; env: StartParamsEnv; baseDir: string; now: () => number; newId: () => string; maxSchedules: number }
export interface SaveDraftInput { id?: unknown; name?: unknown; plannedAt?: unknown; params: unknown }
export interface DraftForEdit { draft: FbPosterSchedule; media: { path: string; size: number }[] }
export type ApproveDraftInput =
    | { id: unknown; when: 'now' }
    | { id: unknown; when: 'schedule'; kind: unknown; runAt?: unknown; days?: unknown; time?: unknown };
export function saveDraft(deps: DraftDeps, input: SaveDraftInput): FbPosterSchedule;
export function getDraft(deps: DraftDeps, id: unknown): DraftForEdit;
export function approveDraft(deps: DraftDeps, input: ApproveDraftInput): FbPosterSchedule;
```

- [ ] **Step 1: Viết test (đỏ)** — tạo `src/__tests__/facebookPoster/drafts.test.ts`:

```ts
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../services/facebookPoster/drafts';
import { scheduleMediaDir } from '../../services/facebookPoster/scheduleMedia';
import { memoryDb } from './helpers';

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();
const HOUR = 3_600_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-drafts-'));
  dirs.push(baseDir);
  let seq = 0;
  const deps: DraftDeps = {
    store, baseDir, maxSchedules: 200, now: () => NOW, newId: () => `d${++seq}`,
    env: { profileExists: (id) => id === 'p1', fileExists: (p) => fs.existsSync(p), fileSize: (p) => fs.statSync(p).size },
  };
  const file = (name: string, content = 'x') => { const p = path.join(baseDir, name); fs.writeFileSync(p, content); return p; };
  return { store, baseDir, deps, file };
}
const content = (over: Record<string, unknown> = {}) => ({ mode: 'group', text: 'Tuyển Sale', ...over });
const full = (over: Record<string, unknown> = {}) =>
  content({ profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }], ...over });

describe('drafts', () => {
  test('saveDraft chỉ cần nội dung; nháp tắt, không có giờ chạy, scheduler không thấy', () => {
    const { store, deps } = setup();
    const d = saveDraft(deps, { params: content() });
    assert.deepStrictEqual([d.draft, d.enabled, d.nextRunAt, d.kind, d.runAt, d.name], [true, false, null, 'once', null, 'Tuyển Sale']);
    assert.deepStrictEqual(store.listDueSchedules(NOW + 365 * 24 * HOUR), []);
  });

  test('saveDraft từ chối nội dung rỗng', () => {
    const { deps } = setup();
    assert.throws(() => saveDraft(deps, { params: content({ text: '  ' }) }), /Nội dung bài không được để trống/);
  });

  test('saveDraft ghi đè nội dung và thay ảnh: giữ ảnh cũ còn dùng, thêm ảnh mới, bỏ ảnh không dùng', () => {
    const { deps, file, baseDir } = setup();
    const d = saveDraft(deps, { params: content({ mediaPaths: [file('a.jpg', 'A'), file('b.jpg', 'B')] }) });
    const { media } = getDraft(deps, d.id);
    assert.strictEqual(media.length, 2);
    const again = saveDraft(deps, { id: d.id, params: content({ text: 'Mới', mediaPaths: [media[1].path, file('c.jpg', 'C')] }) });
    assert.strictEqual(again.params.text, 'Mới');
    assert.deepStrictEqual(again.params.mediaPaths, ['01-b.jpg', '02-c.jpg']);
    assert.deepStrictEqual(fs.readdirSync(scheduleMediaDir(baseDir, d.id)).sort(), ['01-b.jpg', '02-c.jpg']);
  });

  test('giờ dự kiến phải ở tương lai khi đổi; nháp đã quá giờ dự kiến vẫn lưu lại được nếu không đổi giờ', () => {
    const { deps, store } = setup();
    assert.throws(() => saveDraft(deps, { params: content(), plannedAt: NOW - HOUR }), /ít nhất 1 phút/);
    const d = saveDraft(deps, { params: content(), plannedAt: NOW + HOUR });
    store.updateSchedule(d.id, { runAt: NOW - HOUR }, NOW); // giả lập: giờ dự kiến đã trôi qua
    const kept = saveDraft(deps, { id: d.id, params: content({ text: 'sửa' }), plannedAt: NOW - HOUR });
    assert.strictEqual(kept.runAt, NOW - HOUR);
    assert.strictEqual(kept.params.text, 'sửa');
  });

  test('saveDraft không sửa được lịch đã duyệt, không nhận id không tồn tại', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    approveDraft(deps, { id: d.id, when: 'schedule', kind: 'once', runAt: NOW + HOUR });
    assert.throws(() => saveDraft(deps, { id: d.id, params: content() }), /Chỉ sửa được bản nháp/);
    assert.throws(() => saveDraft(deps, { id: 'nope', params: content() }), /Không tìm thấy bản nháp/);
  });

  test('saveDraft tôn trọng giới hạn số lịch', () => {
    const { deps } = setup();
    const small = { ...deps, maxSchedules: 1 };
    saveDraft(small, { params: content() });
    assert.throws(() => saveDraft(small, { params: content() }), /Tối đa 1 lịch/);
  });

  test('approve schedule: thành lịch thật đã bật, có giờ chạy', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    const s = approveDraft(deps, { id: d.id, when: 'schedule', kind: 'once', runAt: NOW + HOUR });
    assert.deepStrictEqual([s.draft, s.enabled, s.kind, s.runAt, s.nextRunAt], [false, true, 'once', NOW + HOUR, NOW + HOUR]);
  });

  test('approve schedule lặp lại: đặt thứ/giờ và tính lần chạy tới', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    const s = approveDraft(deps, { id: d.id, when: 'schedule', kind: 'recurring', days: [1, 3, 5], time: '09:30' });
    assert.deepStrictEqual([s.draft, s.enabled, s.kind, s.days, s.time], [false, true, 'recurring', [1, 3, 5], '09:30']);
    assert.ok(s.nextRunAt !== null && s.nextRunAt > NOW);
  });

  test('approve now: nextRunAt = now để scheduler chạy qua hàng đợi', () => {
    const { deps, store } = setup();
    const d = saveDraft(deps, { params: full() });
    approveDraft(deps, { id: d.id, when: 'now' });
    assert.deepStrictEqual(store.listDueSchedules(NOW).map((x) => x.id), [d.id]);
  });

  test('approve thất bại (thiếu profile) thì nháp giữ nguyên là nháp', () => {
    const { deps, store } = setup();
    const d = saveDraft(deps, { params: content() });
    assert.throws(() => approveDraft(deps, { id: d.id, when: 'now' }), /Chưa chọn profile/);
    const after = store.getSchedule(d.id)!;
    assert.deepStrictEqual([after.draft, after.enabled, after.nextRunAt], [true, false, null]);
  });

  test('getDraft chỉ trả nháp, kèm đường dẫn tuyệt đối và kích thước ảnh', () => {
    const { deps, file } = setup();
    const d = saveDraft(deps, { params: content({ mediaPaths: [file('a.jpg', 'AAA')] }) });
    const { media } = getDraft(deps, d.id);
    assert.ok(path.isAbsolute(media[0].path));
    assert.strictEqual(media[0].size, 3);
    assert.throws(() => getDraft(deps, 'nope'), /Không tìm thấy bản nháp/);
  });
});
```

- [ ] **Step 2: Chạy để thấy đỏ**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/jest/bin/jest.js src/__tests__/facebookPoster/drafts.test.ts --silent`
Expected: FAIL "Cannot find module '../../services/facebookPoster/drafts'".

- [ ] **Step 3: Viết `drafts.ts`**

```ts
import type { FbPosterSchedule } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { validateDraftParams, validateStartParams, type StartParamsEnv } from './validateStartParams';
import { copyScheduleMedia, replaceScheduleMedia, resolveScheduleMedia, removeScheduleMedia } from './scheduleMedia';
import { readName, readTiming } from './scheduleUpdate';
import { computeNextRun } from './scheduleTime';

/**
 * Bản nháp (GĐ2): một dòng fb_poster_schedules với draft = 1, luôn enabled = 0 và next_run_at = NULL nên scheduler
 * không bao giờ chạy. Chỉ approveDraft mới biến nó thành lịch thật. Module thuần, phụ thuộc truyền vào để test được.
 */
export interface DraftDeps {
    store: FacebookPosterStore;
    env: StartParamsEnv;
    baseDir: string;
    now: () => number;
    newId: () => string;
    maxSchedules: number;
}
export interface SaveDraftInput { id?: unknown; name?: unknown; plannedAt?: unknown; params: unknown }
export interface DraftForEdit { draft: FbPosterSchedule; media: { path: string; size: number }[] }
export type ApproveDraftInput =
    | { id: unknown; when: 'now' }
    | { id: unknown; when: 'schedule'; kind: unknown; runAt?: unknown; days?: unknown; time?: unknown };

const NOT_FOUND = 'Không tìm thấy bản nháp';

const mediaNames = (s: FbPosterSchedule): string[] =>
    (Array.isArray(s.params.mediaPaths) ? s.params.mediaPaths : []).filter((n): n is string => typeof n === 'string');

function requireDraft(deps: DraftDeps, id: unknown): FbPosterSchedule {
    const s = typeof id === 'string' && id ? deps.store.getSchedule(id) : null;
    if (!s || !s.draft) throw new Error(NOT_FOUND);
    return s;
}

/** Giờ dự kiến: null = chưa xếp lịch. Chỉ kiểm "ở tương lai" khi giờ đổi, để sửa nháp đã quá giờ dự kiến vẫn lưu được. */
function readPlannedAt(value: unknown, current: number | null, now: number): number | null {
    if (value === undefined || value === current) return current;
    if (value === null) return null;
    return readTiming('once', { runAt: value }, now).runAt;
}

export function saveDraft(deps: DraftDeps, input: SaveDraftInput): FbPosterSchedule {
    const { store, env, baseDir } = deps;
    const now = deps.now();
    const params = validateDraftParams(input.params, env);
    const name = readName(input.name) || String(params.text).trim().slice(0, 40);
    const sources = params.mediaPaths as string[];
    const id = typeof input.id === 'string' && input.id ? input.id : null;

    if (id) {
        const existing = store.getSchedule(id);
        if (!existing) throw new Error(NOT_FOUND);
        if (!existing.draft) throw new Error('Chỉ sửa được bản nháp');
        const runAt = readPlannedAt(input.plannedAt, existing.runAt, now);
        const names = replaceScheduleMedia(baseDir, id, sources);
        store.updateSchedule(id, { name, runAt, params: { ...params, mediaPaths: names } }, now);
        return store.getSchedule(id)!;
    }

    if (store.countSchedules() >= deps.maxSchedules) throw new Error(`Tối đa ${deps.maxSchedules} lịch cho một workspace`);
    const runAt = readPlannedAt(input.plannedAt, null, now);
    const newId = deps.newId();
    const names = copyScheduleMedia(baseDir, newId, sources);
    try {
        store.createSchedule({
            id: newId, name, kind: 'once', params: { ...params, mediaPaths: names },
            runAt, days: [], time: '', enabled: false, nextRunAt: null, createdAt: now, draft: true,
        });
    } catch (err) {
        removeScheduleMedia(baseDir, newId);
        throw err;
    }
    return store.getSchedule(newId)!;
}

export function getDraft(deps: DraftDeps, id: unknown): DraftForEdit {
    const draft = requireDraft(deps, id);
    const paths = resolveScheduleMedia(deps.baseDir, draft.id, mediaNames(draft));
    return { draft, media: paths.map((p) => ({ path: p, size: deps.env.fileExists(p) ? deps.env.fileSize(p) : 0 })) };
}

export function approveDraft(deps: DraftDeps, input: ApproveDraftInput): FbPosterSchedule {
    const { store, env, baseDir } = deps;
    const now = deps.now();
    const draft = requireDraft(deps, input.id);
    const names = mediaNames(draft);
    // Kiểm đầy đủ như đăng bài thật; lỗi thì ném trước khi ghi gì, nháp giữ nguyên.
    const checked = validateStartParams(
        { kind: 'post', params: { ...draft.params, mediaPaths: resolveScheduleMedia(baseDir, draft.id, names) } }, env);
    if (checked.kind !== 'post') throw new Error('Loại lịch không hợp lệ');
    const params = { ...checked, mediaPaths: names };

    if (input.when === 'now') {
        store.updateSchedule(draft.id, {
            kind: 'once', runAt: now, days: [], time: '', params, draft: false, enabled: true, nextRunAt: now,
        }, now);
    } else {
        if (input.kind !== 'once' && input.kind !== 'recurring') throw new Error('Loại lịch không hợp lệ');
        const kind: 'once' | 'recurring' = input.kind;
        const timing = readTiming(kind, input, now);
        store.updateSchedule(draft.id, {
            kind, ...timing, params, draft: false, enabled: true, nextRunAt: computeNextRun({ kind, ...timing }, now),
        }, now);
    }
    return store.getSchedule(draft.id)!;
}
```

  Kiểm `computeNextRun` nằm ở `./scheduleTime` (đúng như `scheduleTime.ts:8`) và `readName`/`readTiming` export từ `./scheduleUpdate` (đúng như `scheduleUpdate.ts:11,25`).

- [ ] **Step 4: Chạy lại (xanh)** — lệnh Step 2. Expected: PASS 11 test.

- [ ] **Step 5: Commit**

```bash
git add src/services/facebookPoster/drafts.ts src/__tests__/facebookPoster/drafts.test.ts
git commit -m "feat(fb-poster): drafts service (save, load, approve)"
```

---

### Task 4: IPC + preload + kiểu renderer

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts` (thêm 3 handler)
- Modify: `electron/preload.ts` (khối `facebookPoster`, cạnh `scheduleDelete` dòng ~905)
- Modify: `src/ui/lib/ipc.ts` (khối `facebookPoster`, cạnh `scheduleDelete` dòng ~690)

**Interfaces:**
- Consumes: `saveDraft`, `getDraft`, `approveDraft`, `DraftDeps` (Task 3).
- Produces (renderer): `ipc.facebookPoster.draftSave(params)`, `draftGet(id)`, `draftApprove(params)` — kiểu ở Step 3.

- [ ] **Step 1: Handler** — trong `facebookPosterIpc.ts` thêm import:

```ts
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../src/services/facebookPoster/drafts';
```

  thêm hàm (sau `const startEnv … ;`):

```ts
function draftDeps(): DraftDeps {
    return { store: store(), env: startEnv, baseDir: scheduleBaseDir(), now: () => Date.now(), newId: () => randomUUID(), maxSchedules: MAX_SCHEDULES };
}
```

  và ngay sau handler `facebookPoster:scheduleDelete`:

```ts
    handle('facebookPoster:draftSave', (params) => {
        const schedule = saveDraft(draftDeps(), params);
        emitSchedulesChanged();
        return { schedule };
    });

    handle('facebookPoster:draftGet', (params) => getDraft(draftDeps(), params.id));

    handle('facebookPoster:draftApprove', (params) => {
        const schedule = approveDraft(draftDeps(), params);
        scheduler?.reschedule(); // "Đăng ngay" đặt nextRunAt = now → scheduler chạy qua hàng đợi
        emitSchedulesChanged();
        return { schedule };
    });
```

  Nếu `store` / `scheduleBaseDir` / `MAX_SCHEDULES` được khai báo sau chỗ đặt `draftDeps`, đặt `draftDeps` sau chúng (hàm chỉ chạy lúc gọi nên thứ tự khai báo hàm không quan trọng, nhưng `const` phải đứng trước khi handler được gọi).

- [ ] **Step 2: Preload** — trong khối `facebookPoster` của `electron/preload.ts`, sau dòng `scheduleDelete`:

```ts
    draftSave:      (params: any)                 => ipcRenderer.invoke('facebookPoster:draftSave', params),
    draftGet:       (id: string)                  => ipcRenderer.invoke('facebookPoster:draftGet', { id }),
    draftApprove:   (params: any)                 => ipcRenderer.invoke('facebookPoster:draftApprove', params),
```

- [ ] **Step 3: Kiểu renderer** — trong `src/ui/lib/ipc.ts`, sau dòng `scheduleDelete: …;`:

```ts
        draftSave: (params: { id?: string; name?: string; plannedAt?: number | null; params: Record<string, unknown> }) => Promise<{ success: boolean; schedule?: FbPosterSchedule; error?: string }>;
        draftGet: (id: string) => Promise<{ success: boolean; draft?: FbPosterSchedule; media?: { path: string; size: number }[]; error?: string }>;
        draftApprove: (params: { id: string; when: 'now' } | { id: string; when: 'schedule'; kind: 'once' | 'recurring'; runAt?: number; days?: number[]; time?: string }) => Promise<{ success: boolean; schedule?: FbPosterSchedule; error?: string }>;
```

- [ ] **Step 4: Kiểm biên dịch** — `npx tsc -p tsconfig.electron.json --noEmit` rồi `npx tsc -p tsconfig.json --noEmit`. Expected: exit 0 cả hai.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/facebookPosterIpc.ts electron/preload.ts src/ui/lib/ipc.ts
git commit -m "feat(fb-poster): draftSave/draftGet/draftApprove IPC"
```

---

### Task 5: Mô hình lịch — lọc kênh cho nháp, nháp chưa xếp lịch

**Files:**
- Modify: `src/ui/features/facebookPoster/calendarModel.ts`
- Test: `src/__tests__/facebookPoster/calendarModel.test.ts`

**Interfaces:**
- Consumes: `FbPosterSchedule.draft` (Task 1).
- Produces: `matchesChannels(schedule: FbPosterScheduleView, selected: string[] | null): boolean`; `getUnscheduledDrafts(schedules: FbPosterScheduleView[], selected: string[] | null): FbPosterScheduleView[]`.

- [ ] **Step 1: Test (đỏ)** — đổi import đầu file thành `import { getCalendarDays, getScheduleOccurrences, buildMovePatch, canDragSchedule, matchesChannels, getUnscheduledDrafts } from '../../ui/features/facebookPoster/calendarModel';` và thêm trong `describe('poster calendar', …)`:

```ts
  it('drafts without a profile stay visible under a channel filter; unscheduled drafts are listed separately', () => {
    const planned = schedule({ id: 'p', draft: true, enabled: false, nextRunAt: null, runAt: at(13, 9), params: { profiles: [] } });
    const loose = schedule({ id: 'u', draft: true, enabled: false, nextRunAt: null, runAt: null, params: { profiles: [] } });
    const other = schedule({ id: 'o', params: { profiles: [{ profileId: 'pX', targets: [] }] } });
    const days = getCalendarDays(new Date(at(13)), 'week');
    expect(getScheduleOccurrences([planned, loose, other], days, ['p1'], at(12)).map((e) => e.schedule.id)).toEqual(['p']);
    expect(getUnscheduledDrafts([planned, loose, other], ['p1']).map((s) => s.id)).toEqual(['u']);
    expect(matchesChannels(other, ['p1'])).toBe(false);
    expect(matchesChannels(other, null)).toBe(true);
  });
```

- [ ] **Step 2: Chạy để thấy đỏ** — `npx jest src/__tests__/facebookPoster/calendarModel.test.ts --silent`. Expected: FAIL (hàm chưa có).

- [ ] **Step 3: Cài đặt** — trong `calendarModel.ts`:
  - Thêm sau `getCalendarDays`:

```ts
/** Kênh khớp bộ lọc. Nháp chưa chọn profile hiện ở mọi bộ lọc kênh, để không "biến mất" khỏi lịch. */
export function matchesChannels(schedule: FbPosterScheduleView, selected: string[] | null): boolean {
  if (selected === null) return true;
  const profiles = (schedule.params.profiles ?? []) as { profileId: string }[];
  if (schedule.draft && profiles.length === 0) return true;
  return profiles.some((p) => selected.includes(p.profileId));
}

/** Nháp chưa có giờ dự kiến — hiện ở dải "Nháp chưa xếp lịch". */
export function getUnscheduledDrafts(schedules: FbPosterScheduleView[], selected: string[] | null): FbPosterScheduleView[] {
  return schedules.filter((s) => s.draft && s.runAt === null && matchesChannels(s, selected));
}
```

  - Trong `getScheduleOccurrences`, thay hai dòng

```ts
    const profiles = (schedule.params.profiles ?? []) as { profileId: string }[];
    if (selected !== null && !profiles.some(p => selected.includes(p.profileId))) continue;
```

  bằng

```ts
    if (!matchesChannels(schedule, selected)) continue;
```

- [ ] **Step 4: Chạy lại (xanh)** — lệnh Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/features/facebookPoster/calendarModel.ts src/__tests__/facebookPoster/calendarModel.test.ts
git commit -m "feat(fb-poster): calendar model keeps profile-less drafts visible, lists unscheduled drafts"
```

---

### Task 6: Modal soạn bài — Lưu nháp và mở lại nháp

**Files:**
- Create: `src/ui/features/facebookPoster/draftForm.ts`
- Test: `src/__tests__/facebookPoster/draftForm.test.ts`
- Modify: `src/ui/features/facebookPoster/PostTab.tsx`
- Modify: `src/ui/features/facebookPoster/FacebookPosterView.tsx`

**Interfaces:**
- Consumes: `ipc.facebookPoster.draftSave` / `draftGet` (Task 4).
- Produces: `hydrateTargets(targets: string[], scannedUrls: string[]): { uncheckedUrls: string[]; extraLinks: string }`; prop `PostTab.draft?: { schedule: FbPosterSchedule; media: { path: string; size: number }[] }`; prop `ScheduleTab.onEditDraft: (id: string) => void` (Task 7 dùng; FacebookPosterView truyền ở task này).

- [ ] **Step 1: Test `hydrateTargets` (đỏ)** — tạo `src/__tests__/facebookPoster/draftForm.test.ts`:

```ts
import { hydrateTargets } from '../../ui/features/facebookPoster/draftForm';

describe('hydrateTargets', () => {
  it('unchecks scanned groups not in the draft and keeps unknown targets as manual links', () => {
    expect(hydrateTargets(['https://g/1', 'https://g/9', '123'], ['https://g/1', 'https://g/2']))
      .toEqual({ uncheckedUrls: ['https://g/2'], extraLinks: 'https://g/9\n123' });
  });
  it('a draft without targets unchecks every scanned group', () => {
    expect(hydrateTargets([], ['a', 'b'])).toEqual({ uncheckedUrls: ['a', 'b'], extraLinks: '' });
  });
});
```

- [ ] **Step 2: Chạy để thấy đỏ** — `npx jest src/__tests__/facebookPoster/draftForm.test.ts --silent`. Expected: FAIL (module chưa có).

- [ ] **Step 3: `draftForm.ts`**

```ts
/**
 * Đích của một nháp → trạng thái chọn nhóm của modal soạn bài: nhóm đã quét mà không nằm trong đích thì bỏ chọn;
 * đích không có trong danh sách đã quét (link nhập tay) thì đưa vào ô "link nhóm".
 */
export function hydrateTargets(targets: string[], scannedUrls: string[]): { uncheckedUrls: string[]; extraLinks: string } {
  const wanted = new Set(targets);
  const scanned = new Set(scannedUrls);
  return {
    uncheckedUrls: scannedUrls.filter((url) => !wanted.has(url)),
    extraLinks: targets.filter((url) => !scanned.has(url)).join('\n'),
  };
}
```

- [ ] **Step 4: Chạy lại (xanh)** — lệnh Step 2. Expected: PASS.

- [ ] **Step 5: `PostTab.tsx`**
  - Import: `import { hydrateTargets } from './draftForm';` và thêm `FbPosterSchedule` vào import kiểu từ `../../../models/facebookPoster`.
  - `interface Props` thêm `draft?: { schedule: FbPosterSchedule; media: { path: string; size: number }[] };` và thêm `draft` vào destructuring tham số hàm.
  - Ngay đầu thân hàm (trước các `useState`): `const dp = draft?.schedule.params as Record<string, any> | undefined;`
  - Đổi giá trị khởi tạo state:

```ts
  const [mode, setMode] = useState<FbPosterMode>(dp?.mode === 'page' ? 'page' : 'group');
  const [text, setText] = useState<string>(typeof dp?.text === 'string' ? dp.text : '');
  const [media, setMedia] = useState<MediaItem[]>(draft?.media ?? []);
  const [comment, setComment] = useState<string>(typeof dp?.comment === 'string' ? dp.comment : '');
  const [profileIds, setProfileIds] = useState<string[]>(
    dp ? ((dp.profiles ?? []) as { profileId: string }[]).map((p) => p.profileId) : initialProfileIds);
  const [minDelaySec, setMinDelaySec] = useState<number>(dp?.minDelaySec ?? 300);
  const [maxDelaySec, setMaxDelaySec] = useState<number>(dp?.maxDelaySec ?? 900);
  const [concurrency, setConcurrency] = useState<number>(dp?.concurrency ?? 3);
  const [staggerMinSec, setStaggerMinSec] = useState<number>(dp?.staggerMinSec ?? 30);
  const [staggerMaxSec, setStaggerMaxSec] = useState<number>(dp?.staggerMaxSec ?? 90);
  const [savingDraft, setSavingDraft] = useState(false);
  const hydrated = useRef(!dp);
```

  - Áp đích của nháp **một lần, ngay khi danh sách nhóm tải xong** (không làm trong effect riêng, vì lần render đầu chưa có nhóm). Trong effect `listGroups`, thay `if (res?.success) setGroupsByProfile(res.groups || {});` bằng:

```ts
      if (res?.success) {
        const groups: Record<string, FbPosterGroup[]> = res.groups || {};
        setGroupsByProfile(groups);
        if (!hydrated.current) {
          hydrated.current = true;
          const unchecked = new Set<string>();
          const links: Record<string, string> = {};
          for (const entry of (dp?.profiles ?? []) as { profileId: string; targets: string[] }[]) {
            const h = hydrateTargets(entry.targets ?? [], (groups[entry.profileId] || []).map((g) => g.url));
            for (const url of h.uncheckedUrls) unchecked.add(key(entry.profileId, url));
            if (h.extraLinks) links[entry.profileId] = h.extraLinks;
          }
          setUnchecked(unchecked);
          setExtraLinks(links);
        }
      }
```

    (`key` được khai báo sau effect trong file; vì callback chạy bất đồng bộ sau render nên dùng được. Nếu lint báo dùng trước khai báo, chuyển dòng `const key = …` lên trước effect.)

  - Thêm sau `handleStart`:

```ts
  const draftDisabledReason = !text.trim() ? 'Nhập nội dung bài.' : validateMediaSelection(media) ?? '';
  const handleSaveDraft = async () => {
    setSavingDraft(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.draftSave({
        id: draft?.schedule.id,
        plannedAt: draft ? draft.schedule.runAt : initialRunAt ?? null,
        params: postParams(),
      });
      if (!res?.success) reportError(res?.error || 'Không lưu được nháp');
      else { showNotification('Đã lưu nháp', 'success'); onClose(); }
    } catch (err: any) {
      reportError(err?.message || 'Không lưu được nháp');
    } finally {
      setSavingDraft(false);
    }
  };
```

  - Tiêu đề: đổi `<h2 id="poster-composer-title">Soạn bài</h2>` thành `<h2 id="poster-composer-title">{draft ? 'Sửa bản nháp' : 'Soạn bài'}</h2>`.
  - Footer: ngay sau nút "Hẹn giờ" thêm:

```tsx
        <button type="button" onClick={handleSaveDraft} disabled={!!draftDisabledReason || savingDraft}
          className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-60">
          {savingDraft ? 'Đang lưu...' : 'Lưu nháp'}
        </button>
```

- [ ] **Step 6: `FacebookPosterView.tsx`**
  - Import kiểu `FbPosterSchedule` từ `../../../models/facebookPoster`.
  - State: `const [editingDraft, setEditingDraft] = useState<{ schedule: FbPosterSchedule; media: { path: string; size: number }[] } | null>(null);`
  - Trong `compose` thêm dòng đầu `setEditingDraft(null);`.
  - Thêm hàm:

```ts
  const editDraft = async (id: string) => {
    const res = await ipc.facebookPoster?.draftGet(id);
    if (!res?.success || !res.draft) { showNotification(res?.error || 'Không mở được bản nháp', 'error'); return; }
    setChannelsOpen(false);
    setEditingDraft({ schedule: res.draft, media: res.media ?? [] });
    setComposeAt(undefined);
    setComposerMounted(true);
    setComposerOpen(true);
  };
```

    (nếu file chưa có `showNotification`, thêm `const showNotification = useAppStore(s => s.showNotification);`).
  - `<PostTab …>`: thêm `key={editingDraft?.schedule.id ?? 'new'}` và `draft={editingDraft ?? undefined}`.
  - `<ScheduleTab …>`: thêm `onEditDraft={editDraft}`.

- [ ] **Step 7: Biên dịch** — `npx tsc -p tsconfig.json --noEmit`. Expected: lỗi duy nhất còn lại (nếu có) là `onEditDraft` chưa có trong `Props` của `ScheduleTab` — Task 7 thêm. Để tránh commit đỏ, thêm ngay vào `ScheduleTab.tsx` `interface Props`: `onEditDraft: (id: string) => void;` và vào destructuring tham số. Chạy lại → exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/ui/features/facebookPoster/draftForm.ts src/__tests__/facebookPoster/draftForm.test.ts src/ui/features/facebookPoster/PostTab.tsx src/ui/features/facebookPoster/FacebookPosterView.tsx src/ui/features/facebookPoster/ScheduleTab.tsx
git commit -m "feat(fb-poster): save draft from composer, reopen a draft for editing"
```

---

### Task 7: Lịch — hiển thị nháp, dải nháp chưa xếp lịch, duyệt

**Files:**
- Modify: `src/ui/features/facebookPoster/ScheduleTab.tsx`
- Modify: `src/ui/features/facebookPoster/ScheduleDialog.tsx`
- Modify: `src/ui/index.css`

**Interfaces:**
- Consumes: `matchesChannels`, `getUnscheduledDrafts` (Task 5); `ipc.facebookPoster.draftApprove` (Task 4); prop `onEditDraft` (Task 6).
- Produces: prop `ScheduleDialog.approveDraftId?: string`.

- [ ] **Step 1: `ScheduleDialog.tsx` — chế độ duyệt**
  - `interface Props` thêm `/** Duyệt nháp: lưu bằng draftApprove thay vì tạo/sửa lịch. */ approveDraftId?: string;` và thêm vào destructuring.
  - Trong hàm lưu, bọc nhánh hiện có:

```ts
      if (approveDraftId) {
        res = await ipc.facebookPoster?.draftApprove({
          id: approveDraftId, when: 'schedule', kind,
          ...(kind === 'once' ? { runAt: runAt as number } : { days, time }),
        });
      } else if (edit) {
        // … giữ nguyên nhánh sửa giờ hiện có …
      } else {
        // … giữ nguyên nhánh scheduleCreate hiện có …
      }
```

  - Tiêu đề `{edit ? 'Sửa giờ' : 'Lên lịch đăng'}` thành `{approveDraftId ? 'Duyệt & hẹn giờ' : edit ? 'Sửa giờ' : 'Lên lịch đăng'}`.
  - Ô tên lịch đang hiện khi `!edit` → đổi điều kiện thành `!edit && !approveDraftId` (duyệt không đổi tên).

- [ ] **Step 2: `ScheduleTab.tsx`**
  - Import thêm `matchesChannels, getUnscheduledDrafts` từ `./calendarModel`.
  - `LABELS` thêm `draft: 'Nháp',`.
  - Hàm `status`:

```ts
  const status = (entry: ScheduleOccurrence) => entry.schedule.draft ? 'draft' : entry.historical ? entry.schedule.lastRun?.status || 'done'
    : !entry.schedule.enabled ? 'paused' : entry.queued ? 'queued' : 'scheduled';
```

  - Danh sách lọc trạng thái: `['scheduled', 'queued', …]` thành `['draft', 'scheduled', 'queued', 'paused', 'done', 'failed', 'missed', 'cancelled', 'running']`.
  - State duyệt: `const [approving, setApproving] = useState<FbPosterScheduleView | null>(null);`
  - Kéo-thả: trong `slot`, đổi `entry.schedule.enabled` của biến `draggable` thành `(entry.schedule.enabled || entry.schedule.draft)`.
  - Nhãn thời gian thẻ: `<span className="poster-post-time">{clock(entry.at)} · {LABELS[state]}</span>` thành

```tsx
            <span className="poster-post-time">{clock(entry.at)} · {entry.schedule.draft && entry.at < now ? 'Quá giờ dự kiến' : LABELS[state]}</span>
```

  - `visibleSchedules`: thay `const channelMatches = …;` bằng `const channelMatches = matchesChannels(schedule, selectedChannels);`.
  - Thêm sau `visibleSchedules`: `const unscheduledDrafts = getUnscheduledDrafts(schedules, selectedChannels).filter(() => stateFilter === 'all' || stateFilter === 'draft');`
  - Hàm duyệt ngay (sau `remove`):

```ts
  const approveNow = async (schedule: FbPosterScheduleView) => {
    const ok = await showConfirm({ title: 'Đăng ngay bản nháp?', message: `Bài "${schedule.name}" sẽ được đăng ngay khi không còn việc nào đang chạy.`, confirmText: 'Đăng ngay' });
    if (!ok) return;
    setSaving(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.draftApprove({ id: schedule.id, when: 'now' });
      if (!res?.success) throw new Error(res?.error || 'Không duyệt được nháp');
      showNotification('Đã duyệt — bài sẽ được đăng ngay', 'success');
      closeDetail();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Không duyệt được nháp');
    } finally {
      setSaving(false);
      load();
    }
  };
```

  - Dải nháp chưa xếp lịch: trong nhánh lưới (trước `<div ref={scrollRef} …>`), thêm:

```tsx
          {unscheduledDrafts.length > 0 && <div className="poster-draft-strip" aria-label="Nháp chưa xếp lịch">
            <span className="poster-muted text-xs">Nháp chưa xếp lịch</span>
            {unscheduledDrafts.map(s => <button key={s.id} type="button" className="poster-calendar-post is-draft"
              onClick={() => { setOperationError(''); setDetail({ schedule: s, at: now, historical: false }); }} aria-label={`${s.name}, nháp chưa xếp lịch`}>
              <span className="poster-post-time">Nháp</span><span className="poster-post-title">{s.name}</span>
            </button>)}
          </div>}
```

  - Hàng danh sách (`visibleSchedules.map`): khi `schedule.draft`, dòng mô tả là `Nháp · ${schedule.runAt ? 'Dự kiến ' + formatShort(schedule.runAt) : 'Chưa xếp lịch'}` và cụm nút là:

```tsx
            {schedule.draft ? <div className="flex flex-wrap gap-2 items-center">
              <button className="poster-button" onClick={() => onEditDraft(schedule.id)}>Sửa</button>
              <button className="poster-primary" disabled={saving} onClick={() => setApproving(schedule)}>Duyệt & hẹn giờ</button>
              <button className="poster-button text-red-400" disabled={saving} onClick={() => remove(schedule)}>Xoá</button>
            </div> : /* cụm nút hiện có: Tạm dừng/Bật lại, Sửa giờ, Xoá */}
```

  - Hộp chi tiết: dòng `{formatShort(detail.at)} · {LABELS[status(detail)]}` thành

```tsx
<p className="poster-muted">{detail.schedule.draft && detail.schedule.runAt === null ? 'Chưa xếp lịch' : formatShort(detail.at)} · {LABELS[status(detail)]}</p>
```

    và cụm nút: khi `detail.schedule.draft` hiển thị

```tsx
          {detail.schedule.draft ? <div className="flex flex-wrap gap-2">
            <button className="poster-button" onClick={() => { const id = detail.schedule.id; closeDetail(); onEditDraft(id); }}>Sửa</button>
            <button className="poster-primary" disabled={saving} onClick={() => { setApproving(detail.schedule); closeDetail(); }}>Duyệt & hẹn giờ</button>
            <button className="poster-button" disabled={saving} onClick={() => void approveNow(detail.schedule)}>Đăng ngay</button>
            <button className="poster-button text-red-400" disabled={saving} onClick={() => { const schedule = detail.schedule; closeDetail(); void remove(schedule); }}>Xoá</button>
          </div> : /* cụm nút hiện có */}
```

  - Hộp duyệt (cạnh `{editing && <ScheduleDialog …/>}`):

```tsx
      {approving && <ScheduleDialog approveDraftId={approving.id} defaultName={approving.name} initialRunAt={approving.runAt ?? undefined} onClose={() => setApproving(null)} onSaved={load} />}
```

- [ ] **Step 3: CSS** — trong `src/ui/index.css`:
  - Thêm token ngay sau dòng `--poster-highlight: …;` ở **khối light** (giá trị `#ab24b0`): `--poster-draft: #b45309;` và `--poster-on-draft: #ffffff;`
  - Thêm sau dòng `--poster-highlight: …;` ở **khối dark**: `--poster-draft: #f5a524;` và `--poster-on-draft: #0e0e0e;`
  - Thêm sau quy tắc `.poster-calendar-post.is-paused .poster-post-time { … }`:

```css
.poster-calendar-post.is-draft { border-style: dashed; border-color: var(--poster-draft); }
.poster-calendar-post.is-draft .poster-post-time { background: var(--poster-draft); color: var(--poster-on-draft); }
.poster-draft-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 20px; }
.poster-draft-strip .poster-calendar-post { width: auto; max-width: 220px; }
```

- [ ] **Step 4: Biên dịch + test token** — `npx tsc -p tsconfig.json --noEmit` rồi `npx jest src/__tests__/ui src/__tests__/facebookPoster/posterPreview.test.ts --silent`. Expected: exit 0 / PASS (test tương phản phải xanh; đỏ thì chỉnh giá trị token, không sửa test).

- [ ] **Step 5: Kiểm trên app thật** (Task 8 có kịch bản đầy đủ; ở đây chỉ chạy nhanh): mở app dev từ worktree (`env -u ELECTRON_RUN_AS_NODE`), Đăng Facebook → Soạn bài → nhập nội dung → **Lưu nháp** → nháp hiện ở dải "Nháp chưa xếp lịch"; bấm vào → hộp chi tiết có Sửa / Duyệt & hẹn giờ / Đăng ngay / Xoá. Xoá nháp thử.

- [ ] **Step 6: Commit**

```bash
git add src/ui/features/facebookPoster/ScheduleTab.tsx src/ui/features/facebookPoster/ScheduleDialog.tsx src/ui/index.css
git commit -m "feat(fb-poster): drafts on the calendar, unscheduled-draft strip, approve flow"
```

---

### Task 8: Tài liệu + kiểm chứng đầy đủ + 2 vòng UI

**Files:**
- Modify: `DESIGN.md` (mục "Màn hình Đăng Facebook")
- Create: `docs/intent/poster-gd2-verification.md`

- [ ] **Step 1: `DESIGN.md`** — trong mục "Màn hình Đăng Facebook" thêm gạch đầu dòng:

```markdown
- **Bản nháp (GĐ2).** Thẻ nháp viền nét đứt, dải giờ nền `--poster-draft`; nháp chưa có giờ dự kiến nằm ở dải "Nháp chưa xếp lịch" trên lưới; nháp quá giờ dự kiến hiện "Quá giờ dự kiến" và không tự chạy. Chi tiết nháp: Sửa · Duyệt & hẹn giờ · Đăng ngay (xác nhận) · Xoá (xác nhận).
```

  và trong khối YAML token `poster:` không cần thêm (token màu nằm ở `index.css`).

- [ ] **Step 2: Kiểm chứng tự động, từng lệnh một**

```bash
npx tsc -p tsconfig.electron.json --noEmit ; echo "exit=$?"
npx tsc -p tsconfig.json --noEmit ; echo "exit=$?"
npx jest --silent --testPathIgnorePatterns "FacebookPosterStore|FacebookPosterScheduler|FacebookPosterService|drafts.test" 2>&1 | grep -E "Tests:|Suites:|FAIL"
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/jest/bin/jest.js src/__tests__/facebookPoster/FacebookPosterStore.test.ts src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts src/__tests__/facebookPoster/FacebookPosterService.test.ts src/__tests__/facebookPoster/drafts.test.ts --silent 2>&1 | grep -E "Tests:|Suites:|FAIL"
npx vite build >/dev/null 2>&1 ; echo "exit=$?"
```

  Expected: tất cả exit 0, không có FAIL.

- [ ] **Step 3: Kịch bản UI trên app thật** (app dev từ worktree, CDP `--remote-debugging-port=9225`). Mỗi bước kiểm cả dark và light, desktop 1440 và mobile 390, đo `scrollWidth - clientWidth == 0`:
  1. Soạn bài chỉ có nội dung → Lưu nháp → nháp ở dải "Nháp chưa xếp lịch".
  2. Bấm ＋ ở một ô tương lai → nhập nội dung → Lưu nháp → nháp nằm đúng ô, viền nét đứt, nhãn "Nháp".
  3. Mở nháp → Sửa → đổi nội dung + thêm/bỏ ảnh → Lưu nháp → nội dung/ảnh mới; thư mục media chỉ còn ảnh đang dùng.
  4. Kéo nháp sang ô khác → giờ dự kiến đổi; nháp vẫn tắt (`enabled = 0`, `next_run_at` NULL — đọc DB bằng `python3 -I` chế độ `mode=ro`).
  5. Duyệt & hẹn giờ một nháp **thiếu profile** → báo lỗi, nháp còn nguyên.
  6. Nháp đủ profile/nhóm → Duyệt & hẹn giờ **xa trong tương lai** → thành lịch "Đã hẹn" → bấm **Tạm dừng ngay** → xoá.
  7. Đăng ngay → chỉ tới hộp xác nhận → **Huỷ** (không đăng thật).
  8. Lọc kênh khi có nháp chưa chọn profile → nháp vẫn hiện.
  9. Dọn sạch: DB không còn lịch/nháp thử (`select count(*) from fb_poster_schedules` về như trước).

- [ ] **Step 4: Ghi `docs/intent/poster-gd2-verification.md`** — liệt kê kết quả Step 2 (dán số liệu thật) và từng mục Step 3 (đạt/chưa, ảnh chụp ở đâu), cùng những gì chưa kiểm (đăng Facebook thật).

- [ ] **Step 5: Commit**

```bash
git add DESIGN.md docs/intent/poster-gd2-verification.md
git commit -m "docs(fb-poster): GĐ2 design notes and verification"
```
