# Facebook Poster — Multi-image Posts and Scheduled Posting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Source of truth** for implementing and reviewing this feature. Any deviation during implementation updates this file **in the same commit**.

**Goal:** A Facebook post in MaiHub can carry 1–10 images (or one video), and posts can be scheduled once, recurring on weekdays at a fixed time, or queued as many one-time schedules.

**Architecture:** `mediaPath: string | null` becomes `mediaPaths: string[]` end to end; `postToTargets` attaches all files in one `setInputFiles` call when the composer's file input is `multiple`, else one by one. Schedules live in a new SQLite table per workspace with their own copy of the images; a pure `FacebookPosterScheduler` (injected clock and timers) fires due schedules into a queue that feeds the existing one-job-at-a-time `FacebookPosterService`, and records missed runs. IPC, preload and a new "Lịch đăng" tab expose it.

**Tech Stack:** Electron 41 main (TypeScript, CommonJS, ES2020), React 18 + Tailwind renderer, better-sqlite3, jest + ts-jest, playwright-core 1.62.1.

**Spec:** `docs/specs/2026-10-07-facebook-poster-multi-image-schedule.md` (read it first; also its intent `docs/intent/2026-10-07-facebook-poster-multi-image-schedule.md`). Background of the existing feature: `docs/specs/2026-10-03-facebook-poster.md`.

**Work location:** a git worktree from `origin/main` on branch `feat/poster-multi-image-schedule` (create with superpowers:using-git-worktrees, then `npm ci`). Baseline on `origin/main` before Task 1: record `npx jest` totals and both tsc exit codes in the ledger.

## Global Constraints

- Code identifiers in English; user-facing strings and comments in Vietnamese where the module already does so. Do not rename existing identifiers.
- Limits (exact): images per post 1–10; image extensions `jpg jpeg png gif webp`; video extensions `mp4 mov webm`; one video per post, never mixed with images; each image ≤ 20 MB (20 × 1024 × 1024 bytes); total ≤ 100 MB (100 × 1024 × 1024 bytes); `QUEUE_MAX_WAIT_MS = 2 * 60 * 60 * 1000`; missed-run grace `GRACE_MS = 60 * 1000`; timer cap `MAX_TIMER_MS = 24 * 60 * 60 * 1000`; schedule name ≤ 100 chars; ≤ 200 schedules per workspace; a one-time schedule must be ≥ 60 s in the future when saved.
- Exact messages: `Tối đa 10 ảnh mỗi bài`; `Một bài chỉ có 1 video, không kèm ảnh khác`; `Ảnh "<tên tệp>" lớn hơn 20 MB`; `Tổng dung lượng ảnh vượt 100 MB`; `Không tìm thấy tệp ảnh/video` (existing); `Không đính kèm được ảnh thứ <k>`; `Ảnh chưa tải lên xong`; missed reasons `App tắt lúc đến giờ`, `Chờ quá 2 giờ vì đang có việc khác`, `App đóng khi lượt đang chờ`.
- In-page functions (passed to `page.evaluate`): named, self-contained, one argument, no `console.*` (production `strip-console` now fails the build if a strip breaks syntax).
- Never `page.setContent`. No real Facebook post/comment/join during implementation or tests; real-page checks are dry runs that close without clicking Đăng, and real posting needs the owner's explicit permission.
- One job at a time stays; scheduled runs go through the queue, never in parallel.
- Phase 1 users are Boss/Standalone only; every new IPC handler goes through the existing `handle()` wrapper in `electron/ipc/facebookPosterIpc.ts` (employee-mode rejection).
- Schedules are per workspace (stored in the workspace DB; media under `<path.dirname(db().getDbPath())>/facebook-poster-media/<scheduleId>/`).
- Recurrence uses the machine's local time zone; at most one run per schedule per day (weekday checkboxes + `HH:mm`; no cron input).
- UI follows `DESIGN.md` tokens and existing components; light and dark; no page-level horizontal overflow at 375 and 1440 px; no overlapping text.
- `AGENTS.md` asks for `make build/test/lint`; this repo has no Makefile and no lint script. Use: `npx jest`, `npx tsc -p tsconfig.electron.json --noEmit`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit`, `npm run build:electron`, `npm run build:renderer`, and (final task) `npm run production`. Report "no linter configured". Paste outputs in reports.
- `npm run production` rebuilds `better-sqlite3` for Electron; run `npm rebuild better-sqlite3` before `npx jest` afterwards.
- Do not push, merge or release without the owner's approval. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deleting a schedule while its run is queued** → the queued item is skipped silently, no run is created. Pinned in Task 7 (`deleted while queued`).
2. **Machine sleeps through a schedule and wakes later while the app is open** → the first timer fire after waking records `missed` (`App tắt lúc đến giờ`) for runs older than 60 s instead of posting late. Pinned in Task 7 (`fires late after sleep`).
3. **Workspace switch while items are queued** → each queued item gets a `missed` run (`App đóng khi lượt đang chờ`) in the workspace being left, and the new workspace's schedules are loaded. Pinned in Task 7 (`stop records queued as missed`) and Task 8 (wiring order).
4. **User deletes or renames the original image files after scheduling** → the schedule still runs from its own copies. Pinned in Task 6 (`copies survive source deletion`).
5. **Re-picking images appends and re-validates** (11th image, mixing in a video) → the UI blocks Start and Lên lịch with the exact message before any IPC call. Pinned in Task 3 (`validateMediaSelection` tests).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/services/facebookPoster/mediaRules.ts` | Pure media-selection rules shared by main validation and the renderer (limits, extensions, messages) |
| `src/services/facebookPoster/scheduleTime.ts` | `computeNextRun`, `describeRecurrence` (pure) |
| `src/services/facebookPoster/scheduleMedia.ts` | Copy/resolve/remove a schedule's image copies (fs only) |
| `src/services/facebookPoster/FacebookPosterScheduler.ts` | Queue, timers, missed detection (pure; injected clock/timers) |
| `src/ui/features/facebookPoster/MediaPicker.tsx` | Thumbnail grid with reorder/remove for the Post tab |
| `src/ui/features/facebookPoster/ScheduleDialog.tsx` | "Lên lịch" dialog (once / recurring) |
| `src/ui/features/facebookPoster/ScheduleTab.tsx` | "Lịch đăng" tab |
| `src/__tests__/facebookPoster/mediaRules.test.ts`, `scheduleTime.test.ts`, `scheduleMedia.test.ts`, `FacebookPosterScheduler.test.ts` | Tests |

### Modified files

| Path | Change |
|---|---|
| `src/services/facebookPoster/validateStartParams.ts` | `mediaPaths` via `mediaRules`; env gains `fileSize` |
| `src/services/facebookPoster/FacebookPosterService.ts` | `StartParams.post.mediaPaths`; `start(params, scheduleId?)` |
| `src/services/facebookPoster/postToTargets.ts` | `PostInput.mediaPaths`; multi-file attach; wait for upload |
| `src/services/facebookPoster/schema.ts` | `fb_poster_schedules` table; `FB_POSTER_MIGRATIONS` |
| `src/services/facebookPoster/FacebookPosterStore.ts` | schedule CRUD; `scheduleId` on runs; `recordScheduleRun` |
| `src/services/database/DatabaseService.ts` | run `FB_POSTER_MIGRATIONS` after `FB_POSTER_SCHEMA_SQL` |
| `src/models/facebookPoster.ts` | `FbPosterSchedule`, `'missed'`, `FbPosterRun.scheduleId` |
| `electron/ipc/facebookPosterIpc.ts` | multi pickMedia; schedule IPC; scheduler lifecycle; `takeMissed` |
| `electron/main.ts`, `electron/ipc/workspaceIpc.ts` | start/stop scheduler |
| `electron/preload.ts`, `src/ui/lib/ipc.ts` | new API + events |
| `src/ui/features/facebookPoster/PostTab.tsx` | uses `MediaPicker`, "Lên lịch" button |
| `src/ui/features/facebookPoster/FacebookPosterView.tsx` | new tab "Lịch đăng" at index 1 |
| `src/ui/features/facebookPoster/HistoryTab.tsx` | `missed` label, "Theo lịch" marker |
| `src/ui/App.tsx` | root listener for missed-schedule notices |
| Existing tests | updated for `mediaPaths` and new env |
| `README.md`, `SYSTEM_DOCUMENTATION.md`, `DESIGN.md`, `src/ui/components/settings/ChangelogSettings.tsx`, `package.json`, `package-lock.json` | docs, changelog, version 26.13.0 (Task 10) |

---

### Task 1: `mediaRules` + `mediaPaths` through validation and the service

**Files:**
- Create: `src/services/facebookPoster/mediaRules.ts`
- Modify: `src/services/facebookPoster/validateStartParams.ts`, `src/services/facebookPoster/FacebookPosterService.ts` (type + the `postToTargets` call that passes `mediaPath`), `electron/ipc/facebookPosterIpc.ts` (only the `validateStartParams` env: add `fileSize`)
- Test: `src/__tests__/facebookPoster/mediaRules.test.ts`, update `src/__tests__/facebookPoster/validateStartParams.test.ts` and any test constructing `StartParams` with `mediaPath`

**Interfaces:**
- Produces:
  ```ts
  // mediaRules.ts (pure; imported by main AND renderer — no node/electron imports)
  export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
  export const MAX_IMAGES = 10;
  export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
  export interface MediaItem { path: string; size: number; }
  /** Returns null when valid, else the exact Vietnamese message. Order of checks: extension, video mixing, count, per-image size, total size. */
  export function validateMediaSelection(items: MediaItem[]): string | null;
  /** De-duplicates by path keeping first occurrence. */
  export function dedupePaths(paths: string[]): string[];
  export function extensionOf(path: string): string; // lower-case, '' when none
  export function isVideo(path: string): boolean;
  // validateStartParams.ts
  export interface StartParamsEnv { profileExists(id: string): boolean; fileExists(path: string): boolean; fileSize(path: string): number; }
  // StartParams 'post' now has `mediaPaths: string[]` instead of `mediaPath`.
  ```
- [ ] **Step 1: failing tests** — `mediaRules.test.ts`: empty → null; 10 images → null; 11 images → `Tối đa 10 ảnh mỗi bài`; 1 video → null; video + image → `Một bài chỉ có 1 video, không kèm ảnh khác`; 2 videos → same message; `.txt` → `Chỉ hỗ trợ ảnh/video: jpg, jpeg, png, gif, webp, mp4, mov, webm`; image of `MAX_IMAGE_BYTES + 1` named `/a/b/big.jpg` → `Ảnh "big.jpg" lớn hơn 20 MB`; 6 images of 18 MB → `Tổng dung lượng ảnh vượt 100 MB`; `dedupePaths(['a','b','a'])` → `['a','b']`; `extensionOf('/x/Y.JPG')` → `jpg`. `validateStartParams.test.ts` (extend): `mediaPaths` with 10 existing files passes; legacy `mediaPath: '/x.jpg'` becomes `mediaPaths: ['/x.jpg']`; `mediaPath: null` and missing both → `[]`; missing file → `Không tìm thấy tệp ảnh/video`; duplicate paths collapse; env provides `fileSize`.
- [ ] **Step 2:** `npx jest src/__tests__/facebookPoster/mediaRules.test.ts src/__tests__/facebookPoster/validateStartParams.test.ts` → FAIL.
- [ ] **Step 3: implement.** `mediaRules.ts` as above (the unsupported-extension message reuses the existing text `Chỉ hỗ trợ ảnh/video: ${[...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(', ')}`). In `validateStartParams.ts` replace `readMediaPath` with:
  ```ts
  function readMediaPaths(p: Record<string, any>, env: StartParamsEnv): string[] {
      const raw: unknown[] = Array.isArray(p.mediaPaths) ? p.mediaPaths : (typeof p.mediaPath === 'string' && p.mediaPath ? [p.mediaPath] : []);
      const paths = dedupePaths(raw.filter((v): v is string => typeof v === 'string' && v.length > 0));
      for (const path of paths) if (!env.fileExists(path)) throw new Error('Không tìm thấy tệp ảnh/video');
      const problem = validateMediaSelection(paths.map((path) => ({ path, size: env.fileSize(path) })));
      if (problem) throw new Error(problem);
      return paths;
  }
  ```
  and set `mediaPaths: readMediaPaths(p, env)` in `validatePost`. Remove the now-unused `MEDIA_EXTENSIONS` constant there. In `FacebookPosterService.ts` change the `post` member of `StartParams` to `mediaPaths: string[]` and pass `mediaPaths: params.mediaPaths` to `postToTargets` (Task 2 changes `PostInput`; until then add `mediaPaths?: string[]` to `PostInput` and map `mediaPath = mediaPaths?.[0] ?? null` inside `postToTargets` so this task compiles and existing behaviour holds). In `facebookPosterIpc.ts` pass `fileSize: (p) => fs.statSync(p).size` in the `facebookPoster:start` env.
- [ ] **Step 4:** focused tests PASS; `npx jest` all pass; electron tsc exit 0.
- [ ] **Step 5: commit** `feat(facebook-poster): accept up to 10 images per post in validation`.

---

### Task 2: Multi-file attach in `postToTargets`

**Files:**
- Modify: `src/services/facebookPoster/postToTargets.ts`
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts`

**Interfaces:**
- Consumes: `mediaPaths` from Task 1.
- Produces: `PostInput.mediaPaths?: string[]` (remove `mediaPath` and the Task 1 shim); exported named in-page function `readUploadStateInPage({ editorSelectors, labels })` (same root selection as the module's other in-page functions) returning `{ progress: number; publishDisabled: boolean | null }`.

Behaviour (spec §4.2):
1. Find the file input exactly as now (including the "Ảnh/video" button step). Read `multiple` via `input.evaluate((el) => (el as HTMLInputElement).multiple)`.
2. `multiple` → `await input.setInputFiles(mediaPaths)` once.
3. Not `multiple` → for k = 1..n: re-query `FILE_INPUT_SELECTOR`; missing → log and fail the target with `Không đính kèm được ảnh thứ ${k}`; else `setInputFiles(mediaPaths[k-1])`, then `delayRandom(1500, 2500)`.
4. Wait for upload: settle wait `delayRandom(4000 + 1000 * (n - 1), 6000 + 1000 * (n - 1))` after attaching (once after the `multiple` call, or once after the one-by-one loop), then poll every 1000 ms up to `15000 + 5000 * n` ms until the composer root has no `[role=progressbar]` (Đăng stays disabled until text is typed, so it is not a stop condition; it is only logged). Timeout → fail the target with `Ảnh chưa tải lên xong`.
5. The `filechooser` fallback (`page.on('filechooser', …)`) calls `chooser.setFiles(mediaPaths)` when `chooser.isMultiple()`, else `chooser.setFiles(mediaPaths[0])` and logs a warning that only the first image could be attached through the native chooser.

- [ ] **Step 1: failing tests** (fake page dispatches `evaluate` by `fn.name`; fake input element object with `evaluate` and `setInputFiles` recorders):
  - multiple input: one `setInputFiles` call with the full array in order.
  - non-multiple input: n calls, one path each, `$` called again before each.
  - non-multiple, input disappears before image 3 → target `failed`, log contains `Không đính kèm được ảnh thứ 3`, Publish never clicked.
  - progress never reaches 0 → target `failed`, log contains `Ảnh chưa tải lên xong`, Publish never clicked (use `runWithFakeTimers`).
  - empty `mediaPaths` → no input lookup at all (existing no-media path unchanged).
  - existing media tests updated from `mediaPath: '/tmp/x.jpg'` to `mediaPaths: ['/tmp/x.jpg']`, same assertions.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** all jest pass; electron tsc 0.
- [ ] **Step 5: commit** `feat(facebook-poster): attach several images in one post and wait for upload`.

---

### Task 3: Multi-image picker in the Post tab

**Files:**
- Create: `src/ui/features/facebookPoster/MediaPicker.tsx`
- Modify: `electron/ipc/facebookPosterIpc.ts` (`pickMedia`), `electron/preload.ts` (no signature change), `src/ui/lib/ipc.ts` (`pickMedia` return type), `src/ui/features/facebookPoster/PostTab.tsx`
- Test: `mediaRules` tests from Task 1 cover the rules; no renderer unit tests exist for components here (visual checks in Task 10).

**Interfaces:**
- Produces: `facebookPoster:pickMedia` returns `{ items: { path: string; size: number }[] }` (empty when cancelled), using `properties: ['openFile', 'multiSelections']`, filters `[{ name: 'Ảnh/video', extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] }]`, sizes from `fs.statSync`. `MediaPicker` props `{ items: MediaItem[]; onChange(items: MediaItem[]): void; disabled?: boolean }`.

- [ ] **Step 1:** IPC + typings change (`pickMedia: () => Promise<{ success: boolean; items?: { path: string; size: number }[]; error?: string }>`).
- [ ] **Step 2:** `MediaPicker.tsx`: button "Chọn ảnh/video" (appends picked items to the current list, then `dedupe` by path); grid of 72×72 thumbnails via `toLocalMediaUrl(path)` from `@/lib/localMedia` (video → file-name tile); each tile shows its 1-based index, buttons "Lên" / "Xuống" / "Bỏ" with `aria-label`s `Đưa ảnh <k> lên`, `Đưa ảnh <k> xuống`, `Bỏ ảnh <k>`; summary line `<n>/10 ảnh · <MB> MB` (or `1 video`). Error line from `validateMediaSelection(items)` in red with `role="alert"`.
- [ ] **Step 3:** `PostTab.tsx`: replace `mediaPath` state with `media: MediaItem[]`; render `MediaPicker`; `disabledReason` adds `validateMediaSelection(media)` when non-null; extract `const postParams = () => ({ mode, text, mediaPaths: media.map((m) => m.path), comment, profiles: …, minDelaySec, maxDelaySec, concurrency, staggerMinSec, staggerMaxSec })` and use it in `handleStart`.
- [ ] **Step 4:** renderer tsc 0; `npm run build:renderer` 0; jest all pass.
- [ ] **Step 5: commit** `feat(facebook-poster): pick, reorder and preview up to 10 images`.

---

### Task 4: Schedules in the schema, model and store; `scheduleId` on runs

**Files:**
- Modify: `src/services/facebookPoster/schema.ts`, `src/models/facebookPoster.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`, `src/services/database/DatabaseService.ts` (after `this.exec(FB_POSTER_SCHEMA_SQL);` ≈ line 1136), `src/services/facebookPoster/FacebookPosterService.ts` (`start(params, scheduleId?)`)
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`, `src/__tests__/facebookPoster/FacebookPosterService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // models
  export type FbPosterRunStatus = 'running' | 'done' | 'cancelled' | 'failed' | 'missed';
  // FbPosterRun gains: scheduleId: string | null;
  export interface FbPosterSchedule {
      id: string; name: string; kind: 'once' | 'recurring';
      params: Record<string, unknown>;   // 'post' StartParams; mediaPaths hold stored file NAMES (see Task 6)
      runAt: number | null; days: number[]; time: string;
      enabled: boolean; nextRunAt: number | null; lastRunId: string | null;
      createdAt: number; updatedAt: number;
  }
  export interface FbPosterScheduleView extends FbPosterSchedule { lastRun: { status: FbPosterRunStatus; startedAt: number; error: string } | null; }
  // schema.ts
  export const FB_POSTER_MIGRATIONS: string[] = ["ALTER TABLE fb_poster_runs ADD COLUMN schedule_id TEXT DEFAULT NULL"];
  // store
  ensureSchema(): void;                      // exec schema, then each migration inside try/catch
  createRun(run: {…existing…; scheduleId?: string | null }): void;
  recordScheduleRun(r: { id: string; scheduleId: string; params: Record<string, unknown>; at: number; status: 'missed' | 'failed'; reason: string }): void; // kind 'post', mode from params.mode, started_at = finished_at = at
  createSchedule(s: Omit<FbPosterSchedule, 'lastRunId' | 'updatedAt'>): void;
  getSchedule(id: string): FbPosterSchedule | null;
  listSchedules(): FbPosterScheduleView[];   // ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, created_at
  updateSchedule(id: string, fields: Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt' | 'lastRunId'>>, updatedAt: number): void;
  deleteSchedule(id: string): void;
  countSchedules(): number;
  listDueSchedules(atOrBefore: number): FbPosterSchedule[]; // enabled AND next_run_at <= ? ORDER BY next_run_at, created_at
  nextScheduledAt(): number | null;          // MIN(next_run_at) of enabled
  // service
  start(params: StartParams, scheduleId?: string): { runId: string };
  ```
  `days` is stored as text `"1,3,5"` (`''` for once); `enabled` as 0/1.
- [ ] **Step 1: DDL** — append to `FB_POSTER_SCHEMA_SQL` the `fb_poster_schedules` table and index exactly as spec §5.1; add `FB_POSTER_MIGRATIONS`. In `DatabaseService` after the schema exec: `for (const sql of FB_POSTER_MIGRATIONS) { try { this.exec(sql); } catch { /* column already exists */ } }`.
- [ ] **Step 2: failing store tests** (reuse the file's `memoryDb()`): ensureSchema twice still fine and `schedule_id` exists (insert a run with scheduleId and read it back via `getRun`); create/get/list/update/delete schedule round-trip (days array, enabled bool, params JSON); `listDueSchedules` returns only enabled with `next_run_at <= t`, ordered; `nextScheduledAt` ignores disabled and null; `recordScheduleRun` creates a `missed` run with `scheduleId`, `error = reason`, no results; `listSchedules` includes `lastRun` from `last_run_id`; `countSchedules`.
- [ ] **Step 3: failing service test**: `start(params, 'sch-1')` → stored run has `scheduleId 'sch-1'`; `start(params)` → `null`.
- [ ] **Step 4:** implement; map `schedule_id` in `mapRun`. **Step 5:** jest all pass; both tsc 0.
- [ ] **Step 6: commit** `feat(facebook-poster): store schedules and link runs to them`.

---

### Task 5: `scheduleTime.ts`

**Files:** Create `src/services/facebookPoster/scheduleTime.ts`; Test `src/__tests__/facebookPoster/scheduleTime.test.ts`

**Interfaces:**
```ts
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Next run strictly after `after` (ms), local time zone; null when none. */
export function computeNextRun(s: { kind: 'once' | 'recurring'; runAt: number | null; days: number[]; time: string }, after: number): number | null;
/** "T2, T4, T6 lúc 08:00"; Sunday is "CN"; days sorted Monday-first. */
export function describeRecurrence(days: number[], time: string): string;
```
Implementation for `recurring`: parse `HH:mm`; for d = 0..7, candidate = local date of `after` + d days at HH:mm:00.000 (`new Date(y, m, day + d, hh, mm)`); return the first candidate `> after` whose `getDay()` is in `days`; invalid time or empty days → null.
Clarifications: `days` uses `getDay()` numbering (0 = CN … 6 = T7) and is treated as a set (duplicates/out-of-range ignored); `once` returns `runAt` only when `runAt > after`, else null, ignoring `days`/`time`; `describeRecurrence` returns `Hằng ngày lúc HH:mm` when all 7 days are present.

- [ ] **Step 1: failing tests** — run under a fixed zone: set `process.env.TZ = 'Asia/Ho_Chi_Minh'` at the top of the test file **before** any Date use. Cases: once in future → runAt; once in past/equal → null; recurring daily (all 7 days) before today's time → today; after today's time → tomorrow; only Monday from a Saturday → next Monday; across month end (Jan 31 → Feb 1); `days` empty → null; bad time `25:00` → null; `describeRecurrence([1,3,5],'08:00')` → `T2, T4, T6 lúc 08:00`; `[0,6]` → `T7, CN lúc …`; all 7 days → `Hằng ngày lúc …`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: commit** `feat(facebook-poster): compute next run times for schedules`.

---

### Task 6: `scheduleMedia.ts`

**Files:** Create `src/services/facebookPoster/scheduleMedia.ts`; Test `src/__tests__/facebookPoster/scheduleMedia.test.ts`

**Interfaces:**
```ts
export const SCHEDULE_MEDIA_DIR = 'facebook-poster-media';
export function scheduleMediaDir(baseDir: string, scheduleId: string): string;      // baseDir/facebook-poster-media/<id>
/** Copies sources in order to "<NN>-<sanitized basename>" (NN = 01..10); returns the stored names. On any error removes the directory and rethrows. */
export function copyScheduleMedia(baseDir: string, scheduleId: string, sources: string[]): string[];
export function resolveScheduleMedia(baseDir: string, scheduleId: string, names: string[]): string[];
export function removeScheduleMedia(baseDir: string, scheduleId: string): void;     // rm -rf, never throws
```
Sanitize: `path.basename` then replace `[^A-Za-z0-9._-]` with `_`; empty → `file`. `scheduleId` must match `/^[A-Za-z0-9-]+$/` or throw `Mã lịch không hợp lệ` (prevents path traversal).

- [ ] **Step 1: failing tests** with `fs.mkdtempSync(os.tmpdir())`: copies keep order and names `01-a.jpg`, `02-b_c.png`; **copies survive source deletion** (delete sources, files still readable); missing source → throws and directory removed; `../x` id → throws; `removeScheduleMedia` on a missing dir does not throw; `resolveScheduleMedia` joins correctly.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `fs.mkdirSync(recursive)`, `fs.copyFileSync`, `fs.rmSync(recursive, force)`. **Step 4:** PASS.
- [ ] **Step 5: commit** `feat(facebook-poster): keep a copy of each schedule's images`.

**Clarifications:** `resolveScheduleMedia` also validates `scheduleId` (same error) and applies `path.basename` to each stored name; `removeScheduleMedia` with an invalid id is a no-op (never throws, no rm); NN is `String(i + 1).padStart(2, '0')`; module imports only `fs` and `path`.

---

### Task 7: `FacebookPosterScheduler`

**Files:** Create `src/services/facebookPoster/FacebookPosterScheduler.ts`; Test `src/__tests__/facebookPoster/FacebookPosterScheduler.test.ts`

**Interfaces:**
```ts
export const GRACE_MS = 60 * 1000;
export const QUEUE_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
export const MISSED_APP_CLOSED = 'App tắt lúc đến giờ';
export const MISSED_QUEUE_TIMEOUT = 'Chờ quá 2 giờ vì đang có việc khác';
export const MISSED_APP_QUIT = 'App đóng khi lượt đang chờ';
export interface MissedNotice { scheduleId: string; name: string; reason: string; at: number; }
export interface SchedulerDeps {
    store: FacebookPosterStore;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    isBusy: () => boolean;
    /** Resolves media + validates; throws Error with a user-facing message (e.g. 'Không tìm thấy tệp ảnh/video'). */
    resolveParams: (schedule: FbPosterSchedule) => StartParams;
    startRun: (params: StartParams, scheduleId: string) => { runId: string };
    newId: () => string;
    onMissed: (notice: MissedNotice) => void;
    onChanged: () => void;
}
export class FacebookPosterScheduler {
    constructor(deps: SchedulerDeps);
    start(): void;              // = fire(); used on app start and after switching to this workspace
    stop(): void;               // clear timers; every queued item → recordScheduleRun(missed, MISSED_APP_QUIT) + onMissed; empty queue
    reschedule(): void;         // after create/update/delete: re-arm timers only
    onRunFinished(): void;      // pump()
    queuedIds(): string[];      // for tests and the tab
}
```
Algorithm:
- `fire()`: `t = now()`; for each `s` in `store.listDueSchedules(t)`: if `s.nextRunAt < t - GRACE_MS` → missed (`MISSED_APP_CLOSED`, at = `s.nextRunAt`); else push `{ scheduleId, enqueuedAt: t }` unless already queued. Then `updateSchedule(s.id, { nextRunAt: computeNextRun(s, t) }, t)` (once → null). Then `pump()`, `arm()`, `onChanged()`.
- `pump()`: drop items with `now - enqueuedAt > QUEUE_MAX_WAIT_MS` → missed (`MISSED_QUEUE_TIMEOUT`, at = now). If `isBusy()` or queue empty → `arm()` and return. Shift oldest; `s = getSchedule`; missing or disabled → skip and loop. `try { params = resolveParams(s); runId = startRun(params, s.id).runId; updateSchedule(s.id, { lastRunId: runId }) } catch (err)`: if message is `Đang có việc chạy` → unshift back and return; else `recordScheduleRun({ status: 'failed', reason: err.message })`, set `lastRunId`, `onChanged()`, continue loop.
- missed helper: `id = newId()`; `recordScheduleRun({ id, scheduleId, params: s.params, at, status: 'missed', reason })`; `updateSchedule(s.id, { lastRunId: id }, now)`; `onMissed({ scheduleId, name, reason, at })`.
- `arm()`: clear existing timer; candidates = `store.nextScheduledAt()` and (queue non-empty) `oldest.enqueuedAt + QUEUE_MAX_WAIT_MS`; none → return; `delay = min(max(0, next - now), MAX_TIMER_MS)`; `setTimer(() => this.fire(), delay)`.

- [ ] **Step 1: failing tests** (real `FacebookPosterStore` over the in-memory adapter; fake clock `let t`; fake timers recording `{fn, ms}`; `isBusy` toggled by the test; `startRun` records calls and returns ids):
  1. start() with a once schedule 5 min in the past → one `missed` run (`App tắt lúc đến giờ`), `onMissed` called, schedule `nextRunAt` null, `startRun` not called.
  2. start() with a schedule due 30 s ago (within grace) → `startRun` called once with its id.
  3. arm(): next schedule in 10 min → timer for 600000 ms; 3 days away → timer for `MAX_TIMER_MS`.
  4. Timer fires at the right time while idle → `startRun` called; recurring schedule's `nextRunAt` moves to the next weekday occurrence.
  5. Busy at fire time → nothing started; queue has the id; `onRunFinished()` after `isBusy=false` → started.
  6. Busy for > 2 h → `missed` (`Chờ quá 2 giờ vì đang có việc khác`) via the queue-timeout timer.
  7. **deleted while queued** → item skipped silently, no run created, no `onMissed`.
  8. disabled while queued → skipped.
  9. Two schedules due at the same time → started one after another, in `next_run_at, created_at` order.
  10. `resolveParams` throws `Không tìm thấy tệp ảnh/video` → `failed` run with that error, queue continues.
  11. `startRun` throws `Đang có việc chạy` (race) → item stays first in queue.
  12. **fires late after sleep** → a timer fire at `t = due + 10 min` records `missed` (`App tắt lúc đến giờ`) instead of starting.
  13. **stop records queued as missed** → queued item becomes `missed` (`App đóng khi lượt đang chờ`), timers cleared.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS; electron tsc 0.
- Implementation notes: `BUSY_ERROR` is now exported from `FacebookPosterService.ts` and compared by the scheduler; `memoryDb()` moved from `FacebookPosterStore.test.ts` to `src/__tests__/facebookPoster/helpers.ts`; `pump()` loops `while queue non-empty and !isBusy()` (stops after a successful start because the service becomes busy); every `updateSchedule` passes `now()`; every missed/failed run uses `newId()` and sets `lastRunId`; a `stopped` flag (reset by `start()`) makes stale timer callbacks no-ops; `reschedule()`/`onRunFinished()` are no-ops while stopped; `fire()`/`pump()` log store exceptions with `Logger.error` and always `arm()` in `finally`; a `lastRunId` write failing after a successful `startRun` is logged only and never recorded as a failed run.
- [ ] **Step 5: commit** `feat(facebook-poster): run schedules through a queue and record missed runs`.

---

### Task 8: Schedule IPC, scheduler lifecycle, preload and typings

**Files:**
- Modify: `electron/ipc/facebookPosterIpc.ts`, `electron/main.ts`, `electron/ipc/workspaceIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`

**Interfaces:**
- Produces (main): `export function startFacebookPosterScheduler(): void; export function stopFacebookPosterScheduler(): void;`
- IPC (all through `handle()`):
  | Channel | Params | Result |
  |---|---|---|
  | `facebookPoster:scheduleCreate` | `{ name?, kind, runAt?, days?, time?, params }` | `{ schedule }` |
  | `facebookPoster:scheduleList` | — | `{ schedules: FbPosterScheduleView[], queuedIds: string[] }` |
  | `facebookPoster:scheduleUpdate` | `{ id, name?, enabled?, runAt?, days?, time? }` | `{ schedule }` |
  | `facebookPoster:scheduleDelete` | `{ id }` | — |
  | `facebookPoster:takeMissed` | — | `{ notices: MissedNotice[] }` (returns and clears notices not yet delivered) |
- Events: `facebookPoster:scheduleMissed` (`MissedNotice`), `facebookPoster:schedulesChanged` (no payload). Add both to the preload allow-list.

Steps:
- [ ] **Step 1: create.** `baseDir = path.dirname(db().getDbPath())` (the active workspace's DB folder) everywhere in this task. Validate `params` with `validateStartParams({ kind: 'post', params }, env)` (real paths); `kind` once → `runAt` integer ≥ `now + 60000` else `Giờ đăng phải sau thời điểm hiện tại ít nhất 1 phút`; recurring → `days` unique integers 0–6, non-empty (`Chọn ít nhất một ngày trong tuần`), `time` matches `TIME_RE` (`Giờ không hợp lệ`); name trimmed ≤ 100 (`Tên lịch tối đa 100 ký tự`), default `text.trim().slice(0, 40)`; `countSchedules() < 200` (`Tối đa 200 lịch cho một workspace`). `id = randomUUID()`; `names = copyScheduleMedia(baseDir, id, startParams.mediaPaths)`; store params with `mediaPaths: names`; `nextRunAt = computeNextRun(…, now)`; `createSchedule`; on DB error `removeScheduleMedia` and rethrow. Then `scheduler.reschedule()` and emit `schedulesChanged`.
- [ ] **Step 2: update/delete/list/takeMissed.** Update recomputes `nextRunAt = enabled ? computeNextRun(merged, now) : null` (for once with a new `runAt`, enforce the 1-minute rule). Delete: `deleteSchedule` then `removeScheduleMedia`. All three call `reschedule()` and emit `schedulesChanged`.
- [ ] **Step 3: scheduler wiring.** One scheduler per DB path, created in `startFacebookPosterScheduler()` with `store()`, `Date.now`, `setTimeout`/`clearTimeout` (call `.unref?.()` on handles), `isBusy: () => !!service?.current()`, `resolveParams` = clone params with `mediaPaths: resolveScheduleMedia(baseDir, s.id, names)` then `validateStartParams({ kind: 'post', params }, env)`, `startRun: (p, id) => getService().start(p, id)`, `onMissed` = push into a pending list (max 50) **and** `EventBroadcaster.emit('facebookPoster:scheduleMissed', notice)`, `onChanged` = emit `schedulesChanged`. Wrap the service `emit` in `getService()` so `runFinished` also calls `scheduler?.onRunFinished()`. `stopFacebookPosterScheduler()` calls `scheduler.stop()` and drops it.
- [ ] **Step 4: lifecycle.** `electron/main.ts`: call `startFacebookPosterScheduler()` right after `registerFacebookPosterIpc()`; in `before-quit` call `stopFacebookPosterScheduler()` (in its own `try {} catch {}`) immediately before `cancelFacebookPosterJobs()`. `workspaceIpc.ts` (both switch paths): `try { stopFacebookPosterScheduler(); } catch {}` immediately before `cancelAndWaitFacebookPosterJobs()`, and `try { startFacebookPosterScheduler(); } catch {}` right after `FileStorageService.resetBaseDir()`.
- [ ] **Step 5: preload + typings** for the five channels and two events; `pickMedia` type from Task 3 unchanged.
- [ ] **Step 6:** jest all pass; both tsc 0; `npm run build:electron` 0.
- [ ] **Step 7: commit** `feat(facebook-poster): schedule IPC and scheduler lifecycle`.

---

### Task 9: Schedule UI

**Files:**
- Create: `src/ui/features/facebookPoster/ScheduleDialog.tsx`, `src/ui/features/facebookPoster/ScheduleTab.tsx`
- Modify: `PostTab.tsx`, `FacebookPosterView.tsx`, `HistoryTab.tsx`, `src/ui/App.tsx`

- [ ] **Step 1: `ScheduleDialog`** (modal, `role="dialog"`, `aria-modal`, Escape closes, focus first field): name input (placeholder = first 40 chars of text); radio "Một lần" / "Lặp lại"; once → `<input type="datetime-local">` (min = now + 1 min); recurring → 7 checkboxes labelled T2…T7, CN (values 1..6, 0) + `<input type="time">`; fixed warning line `Đăng cùng một nội dung lặp lại bằng nhiều tài khoản dễ bị Facebook hạn chế.`; preview `Chạy lần đầu: <date>` using `computeNextRun` (imported from `scheduleTime.ts`, it is pure); buttons Huỷ / Lưu lịch. On save: `ipc.facebookPoster.scheduleCreate({ name, kind, runAt | days+time, params: postParams() })`; success → `showNotification('Đã lên lịch — chạy lúc …', 'success')`, close; error → show inline.
- [ ] **Step 2: PostTab** — button "Lên lịch" next to "Bắt đầu đăng", disabled by the same `disabledReason` **minus** the busy clause (scheduling is allowed while a run is active).
- [ ] **Step 3: ScheduleTab** — loads `scheduleList`; table: name, kind (`Một lần` / `describeRecurrence`), next run (`—` when null; `Đang chờ` badge when in `queuedIds`), last run (status chip using the History labels + time), switch Bật/Tạm dừng (`scheduleUpdate({ id, enabled })`), "Sửa giờ" (small dialog with only name + time fields, note `Muốn đổi nội dung thì xoá và lên lịch lại.`), "Xoá" with `showConfirm`. Refresh on `facebookPoster:schedulesChanged` and `facebookPoster:runFinished`. Empty state `Chưa có lịch đăng nào. Soạn bài ở tab Đăng bài rồi bấm Lên lịch.`; loading; error. Table in an `overflow-x-auto` container.
- [ ] **Step 4: View** — `TABS = ['Đăng bài', 'Lịch đăng', 'Tham gia nhóm', 'Bình luận', 'Lịch sử']`; update the index-based rendering accordingly.
- [ ] **Step 5: History** — `STATUS_LABEL.missed = { label: 'Đã lỡ', cls: 'text-orange-400' }`; runs with `scheduleId` show a small "Theo lịch" marker.
- [ ] **Step 6: App root listener** — in `App.tsx`, one effect: on mount `ipc.facebookPoster?.takeMissed?.()` and show each notice; subscribe to `facebookPoster:scheduleMissed`; message `Lịch "<name>" đã lỡ lúc <HH:mm dd/MM>: <reason>`, type `warning`. Unsubscribe on unmount.
- [ ] **Step 7:** renderer tsc 0; `npm run build:renderer` 0; jest all pass.
- [ ] **Step 8: commit** `feat(facebook-poster): schedule dialog, schedules tab and missed-run notices`.

---

### Task 10: Docs, changelog, version, and verification

**Files:** `README.md`, `SYSTEM_DOCUMENTATION.md` (section 4.10 Đăng Facebook: multi-image + schedules; data tables), `DESIGN.md` (short note on MediaPicker grid and the new tab; no new tokens), `src/ui/components/settings/ChangelogSettings.tsx` (new entry `26.13.0` at the top, same shape as `26.12.0`), `package.json` + `package-lock.json` version `26.13.0` (only the version lines), this plan's Verification log.

- [ ] **Step 1:** docs + changelog + version; commit `docs(facebook-poster): document multi-image posts and schedules; 26.13.0`.
- [ ] **Step 2: full checks** (paste outputs): `npx jest`; both tsc; `npm run build:electron`; `npm run build:renderer`; `npm run production` (must print `[strip-console] Done`), then `npm rebuild better-sqlite3` and `npx jest` again. No linter configured — say so.
- [ ] **Step 3: real-page dry runs (owner's logged-in profiles; never click Đăng):** with a throwaway script modelled on the spike (`docs/specs/2026-10-07-…` §1), attach the 10 numbered images to (a) a group composer and (b) the Page composer `/post/create`. Record: `multiple` attribute, preview count/order, progress bars, Đăng enabled after typing. If a composer is not `multiple`, verify the one-by-one path reaches 10 previews. Record results in the Verification log; if a profile is logged out, record `NOT VERIFIED` with the reason.
- [ ] **Step 4: UI rounds** — two rounds × 1440×900 and 375×812 × light/dark on the packaged app with isolated `XDG_*` dirs: Post tab with 10 images (grid, reorder, remove, limit errors), schedule dialog (once/recurring), Lịch đăng tab (rows, toggle, edit time, delete), History "Đã lỡ". Check no page overflow, no overlap, 0 console errors.
- [ ] **Step 5: scheduler end-to-end without posting:** in the packaged app with an isolated profile that is **not logged in**, create a one-time schedule 2 minutes ahead; confirm a run starts on time and fails with the not-logged-in message, linked to the schedule. Create another for 2 minutes ahead, quit the app, reopen 5 minutes later: confirm `Đã lỡ` in History and the warning toast.
- [ ] **Step 6:** commit the Verification log update `chore(facebook-poster): record verification`.

## Execution order

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` (strictly sequential). Tasks 5 and 6 are independent of 4 but are kept in order for a single implementer stream.

## Impact analysis

| Area | Risk | Guard |
|---|---|---|
| Manual posting | `mediaPath` → `mediaPaths` rename breaks existing callers | Legacy `mediaPath` still accepted by the validator; all tests updated; tsc |
| Existing History | New `missed` status and `schedule_id` column | Additive column via `ALTER … ADD COLUMN` with try/catch; label added |
| Quit / workspace switch | Scheduler timers firing during switch | `stop()` before cancelling jobs; `start()` after the new DB is active |
| One-job-at-a-time | Scheduler starting during a manual run | `isBusy` + busy-error re-queue (Task 7 test 11) |
| Disk | Image copies per schedule | 100 MB/post, 200 schedules/workspace; delete removes copies |
| Production build | `strip-console` corrupting new code | Build-time syntax guard; no `console.*` in expression position |

## Highest-risk step

**Task 2 + Task 10 Step 3** — attaching several files to the group and Page composers. The spike only measured the personal-timeline dialog; groups and Pages are unmeasured. Mitigation: the non-`multiple` fallback path, unit tests for both paths, and mandatory real-page dry runs before release.

## Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Use the Workflow engine's `trigger.schedule` for phase 2 | Workflow has no Facebook-poster step yet (phase 3); scheduling from the poster screen is what users asked for first |
| Cron expressions for recurrence | Hard for staff; allows sub-daily repetition that raises spam risk |
| Keep image paths pointing at the user's originals | Moving/deleting originals silently breaks schedules |
| Catch-up posting after missed times | Owner chose "skip and notify"; late posts miss the intended time slot |
| Keep the machine awake (`powerSaveBlocker`) | Unrequested power cost; missed runs are reported instead |
| A separate "queue" schedule kind | A queue is just many one-time schedules; one model is simpler |

## Verification log

(Filled in during Task 10.)
