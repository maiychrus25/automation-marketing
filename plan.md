# Facebook Poster on Browser Profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This file is the source of truth** for implementing and reviewing the `feat/facebook-poster` PR. Any deviation from this plan during implementation MUST update this file **in the same commit** as the deviating change.

**Goal:** MaiHub gains a "Đăng Facebook" screen that posts one text (plus optional media and first comment) to Facebook Groups or a Page through several Browser Profiles in parallel, plus scan groups, join groups, collect comments and run history — all by porting the proven FB Poster tool onto MaiHub's antidetect Browser Profiles.

**Architecture:** `BrowserProfileService` gains `openForAutomation(id)`, which lets `playwright-core` launch the profile's antidetect Chromium over `--remote-debugging-pipe` (no TCP port) with exactly the flags a manual open uses. The FB Poster page-automation modules are ported to TypeScript under `src/services/facebookPoster/`, each receiving an injected `launch()` that returns that session. `FacebookPosterService` runs one job at a time across many profiles, writes every per-target result to four new SQLite tables through `FacebookPosterStore`, and streams progress to a new React screen over IPC.

**Tech Stack:** Electron 41 main process (TypeScript, CommonJS, ES2020), React 18 + Tailwind renderer, better-sqlite3, jest + ts-jest, `playwright-core` 1.62.1 (new dependency).

**Spec:** `docs/specs/2026-10-03-facebook-poster.md`. Also read `docs/intent/2026-10-02-facebook-poster.md` and `docs/reports/2026-10-03-browser-automation-pipe-spike.md`.

**Source being ported:** the FB Poster repository at `/home/maiychrus/Auto-Reup-Facebook`, **commit `c135379`**. Always read source with `git -C /home/maiychrus/Auto-Reup-Facebook show c135379:<path>` so later commits there cannot change what you port. If that directory is not present on your machine, clone `https://github.com/maiychrus25/tools-facebook` and check out `c135379`.

**Work location:** git worktree `~/deplao-builder/.worktrees/facebook-poster`, branch `feat/facebook-poster` (based on `origin/main` 843a156 plus the intent, spike report and spec commits). `npm ci` has been run there.

**Baseline (measured before Task 1):** `npx jest` → 8 suites, 184 tests, all pass. `npx tsc -p tsconfig.electron.json --noEmit` → exit 0. `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit` → exit 0.

## Global Constraints

- All new code identifiers are **English** (files, functions, variables, constants, types, DB columns, IPC channels, event names). Vietnamese is allowed only in user-facing strings and in comments. Do not rename existing MaiHub identifiers.
- Keep every FB Poster comment that records a measurement ("ĐO ĐƯỢC …", dates, why a rule exists) when porting; they may stay Vietnamese. Translate identifiers only.
- **In-page functions** (anything passed to `page.evaluate`) must be self-contained (no references to outer functions/constants), take at most **one** argument (use an object for several values), be **named** `function` declarations, and must **not** call `console.*` (`scripts/strip-console.js` regex-deletes `console.*(...)` from the production build and can corrupt them).
- **Never use `page.setContent`** (hangs on the 148 engine, measured 03/10/2026). Use `page.goto`.
- Find elements by **visible text / aria-label**, never by generated CSS classes, except where the FB Poster code already uses `div.x1i10hfl` as a fallback — keep exactly those.
- **Positive evidence only:** a post is done only when the group dialog closes or the URL leaves `/post/create`; a comment is done only when the comment-block count increases **and** the comment text is found.
- **Trusted clicks** for exactly four actions: open composer, Publish, send comment, join group. The in-page function marks the element with attribute `data-maihub-target="<name>"` and returns `true`; Node then runs `await page.locator('[data-maihub-target="<name>"]').first().click({ timeout: 10000 })`. Names: `composer-invite`, `publish`, `comment-send`, `join`. Every marking function first removes the attribute from any element that already has it.
- Automation browser launch: `chromium.launchPersistentContext(userDataDir, { executablePath, headless: false, viewport: null, ignoreDefaultArgs: true, args: ['--remote-debugging-pipe', ...buildLaunchArgs(...)], timeout: 60000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })`. Do not change `buildLaunchArgs`.
- IPC handlers return `{ success: true, ... }` or `{ success: false, error }` and reject in employee mode, using the same `handle()` wrapper pattern as `electron/ipc/browserProfileIpc.ts`.
- Limits (exact): text ≤ 63206 chars, comment ≤ 8000 chars, total targets per job ≤ 500, `concurrency` 1–10 (default 3), `minDelaySec` ≥ 0, `maxDelaySec` ≥ `minDelaySec` and ≤ 86400, join `limit` 1–200, profile start stagger random 30–90 s, default per-target delay 300–900 s, media extensions `jpg jpeg png gif webp mp4 mov webm`.
- One job at a time. Phase 1 is Boss/Standalone only.
- UI follows `DESIGN.md` tokens and existing components; light and dark; no page-level horizontal overflow at 375 px and 1440 px; no overlapping text.
- No real Facebook post, comment or group join during implementation or automated tests. Real-account checks happen only in Task 13 and only with the owner's explicit permission.
- Commit messages in English, conventional style (`feat(facebook-poster): …`), each ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A profile already open by hand** when a job starts → that profile's targets are recorded `failed` with "Profile đang mở. Đóng profile trước khi chạy tự động"; other profiles keep going. Pinned in Task 9 (`profile busy` test).
2. **User closes the automation browser window mid-job** → the current target becomes `failed`, the profile's remaining targets `skipped`, the job continues on other profiles, and the Browser Profiles screen stops showing that profile as running. Pinned in Task 1 (`releases on context close`) and Task 9 (`launch closed mid-run`).
3. **App quits or workspace switches during a job** → automation browsers close gracefully (cookies flushed), and on next start the run shows `failed` with "App đóng khi việc đang chạy" instead of `running` forever. Pinned in Task 1 (`closeAll closes automation sessions`) and Task 8 (`failInterruptedRuns`).
4. **Duplicate or malformed targets** (same group pasted twice, profile URLs, junk lines) → normalized and de-duplicated per profile before the job starts; invalid lines rejected by IPC validation with a clear message. Pinned in Task 10 (`validateStartParams`).
5. **Facebook UI string changes** (like "Bạn viết gì đi..." on 02/10/2026) → all recognized strings live in exported constants with dedicated tests, so a change is one constant edit plus one test line. Pinned in Task 4 (`COMPOSER_INVITE` test).

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/services/browser/automationLauncher.ts` | Only place that imports `playwright-core` at runtime; launches the persistent context with the exact options above |
| `src/services/facebookPoster/types.ts` | Shared types: `LogLevel`, `TaskDeps`, `LaunchedPage`, result row types |
| `src/services/facebookPoster/humanize.ts` | Port of `src/human.js` |
| `src/services/facebookPoster/targets.ts` | Port of `src/targets.js` |
| `src/services/facebookPoster/loginState.ts` | Port of `isLoggedIn` from `src/login.js` |
| `src/services/facebookPoster/firstComment.ts` | Port of `src/binh-luan-bai.js` |
| `src/services/facebookPoster/postToTargets.ts` | Port of `src/post.js` |
| `src/services/facebookPoster/scanGroups.ts` | Port of `src/groups.js` |
| `src/services/facebookPoster/joinGroups.ts` | Port of `src/join.js` |
| `src/services/facebookPoster/collectComments.ts` | Port of `src/comments.js` plus `keyOf` from `src/comments-store.js` |
| `src/services/facebookPoster/schema.ts` | `FB_POSTER_SCHEMA_SQL` constant (4 tables) |
| `src/services/facebookPoster/FacebookPosterStore.ts` | All SQL for the 4 tables, over a small `SqlDatabase` interface |
| `src/services/facebookPoster/FacebookPosterService.ts` | Job orchestration: one job, many profiles, concurrency, stagger, cancel, events |
| `src/services/facebookPoster/validateStartParams.ts` | Pure validation/normalization of `facebookPoster:start` input (Facebook-only https URLs via `parseFacebookUrl` in `targets.ts`) |
| `src/services/facebookPoster/runCsv.ts` | Pure `buildRunCsv` / `csvField` for the run CSV export (neutralises formula-injection cells) |
| `electron/ipc/facebookPosterIpc.ts` | IPC handlers `facebookPoster:*` |
| `src/models/facebookPoster.ts` | Types shared by renderer and main (run, result, group, comment rows, params) |
| `src/ui/features/facebookPoster/FacebookPosterView.tsx` | Screen shell: tabs + run panel |
| `src/ui/features/facebookPoster/RunPanel.tsx` | Progress bar, per-profile state, log |
| `src/ui/features/facebookPoster/PostTab.tsx` | Post tab |
| `src/ui/features/facebookPoster/JoinTab.tsx` | Join tab |
| `src/ui/features/facebookPoster/CommentsTab.tsx` | Comments tab |
| `src/ui/features/facebookPoster/HistoryTab.tsx` | History tab |
| `src/ui/features/facebookPoster/matchKeywords.ts` | Port of FB Poster `khopTuKhoa`/`boDau`: accent-insensitive, comma-separated multi-keyword group-name filter |
| `src/ui/features/facebookPoster/ProfilePicker.tsx` | Multi-select of browser profiles (used by Post tab; single-select mode for Join/Comments) |
| `scripts/dev/facebook-poster-dry-run.js` | Manual, non-posting integration check |
| `src/__tests__/facebookPoster/*.test.ts` | Ported and new tests |
| `src/__tests__/facebookPoster/helpers.ts` | `runWithFakeTimers`, fake page/context builders |

### Modified files

| Path | Change |
|---|---|
| `package.json`, `package-lock.json` | Add dependency `playwright-core` `1.62.1` (exact); add `node_modules/playwright-core/**` to `build.asarUnpack` |
| `src/services/browser/BrowserProfileService.ts` | `openForAutomation()`, automation-aware `close`/`closeAll`, injectable `launchAutomation` |
| `src/__tests__/browser/BrowserProfileService.test.ts` | New cases for automation sessions |
| `src/services/database/DatabaseService.ts` | Execute `FB_POSTER_SCHEMA_SQL` next to the browser-profile tables; `deleteBrowserProfile` also deletes that profile's `fb_poster_groups` rows |
| `electron/main.ts` | Register `registerFacebookPosterIpc()`; call `cancelFacebookPosterJobs()` in `before-quit` before `closeAllBrowserProfiles()` |
| `electron/ipc/workspaceIpc.ts` | `await cancelAndWaitFacebookPosterJobs()` before each `closeAllBrowserProfiles()` and the DB switch |
| `electron/preload.ts` | `facebookPoster` API block; 3 event channels in the allow-list |
| `src/ui/lib/ipc.ts` | Types for `facebookPoster`; `facebookPoster: window.electronAPI?.facebookPoster` in the `ipc` object |
| `src/ui/store/appStore.ts` | Add `'facebookPoster'` to `AppView` |
| `src/ui/components/layout/Sidebar.tsx` | Nav item + icon |
| `src/ui/App.tsx` | Render `FacebookPosterView` |
| `DESIGN.md` | Short section for the screen |

### Identifier rename table (applies to every port task)

| FB Poster | MaiHub |
|---|---|
| `batIdTuThan` | `extractPostIdFromBody` |
| `ghepLinkBai` | `buildPostUrl` |
| `timLinkBaiCuaMinh` | `findOwnPostUrl` |
| `docDanhTinhSoanBaiTrongTrang` | `readComposerIdentityInPage` |
| `clickComposerInPage` | `markComposerInviteInPage` (marks, no click) |
| `clickPublishInPage` | `markPublishButtonInPage` (marks, no click) |
| `composerLaTrangRiengInPage` | `isStandaloneComposerInPage` |
| `nutDangDangTatInPage` | `isPublishDisabledInPage` |
| `roiTrangTaoBaiInPage` | `hasLeftCreatePageInPage` |
| `postSingle` | `postToSingleTarget` |
| `NHAN_MO` | `OPEN_COMMENT_LABELS` |
| `NHAN_GUI` | `SEND_COMMENT_LABELS` |
| `DAU` | `COMMENT_BOX_MARK` (value `'data-maihub-comment-box'`) |
| `DAU_HIEU_CHO_DUYET` | `PENDING_APPROVAL_MARKERS` |
| `moODangBinhLuanTrongTrang` | `openCommentBoxInPage` |
| `danhDauOBinhLuanTrongTrang` | `markCommentBoxInPage` |
| `bamNutGuiTrongTrang` | `markCommentSendButtonInPage` (marks, no click) |
| `demKhoiBinhLuanTrongTrang` | `countCommentBlocksInPage` |
| `coChuTrongKhoiTrongTrang` | `commentTextVisibleInPage` |
| `docTrangThaiBaiTrongTrang` | `readPostStateInPage` |
| `danhGiaTrangThaiBai` | `evaluatePostState` |
| `danhGiaBinhLuan` | `evaluateComment` |
| `doanDoiChieu` | `matchSnippet` |
| `nghi` | `sleep` |
| `binhLuanVaoBai` | `postFirstComment` |
| `clickJoinInPage` | `markJoinButtonInPage` (marks, no click) |
| `layIdMinh` | `readOwnUserId` |
| `quetMotBai` | `collectFromPost` |
| `scanComments` | `collectComments` |
| `joinGroups` | `searchAndJoinGroups` (the search+join entry point) |
| option `kienNhan` (scanGroups/joinGroups) | `patience` |
| return field `trangThai` / `lyDo` | `status` / `reason` |
| return field `binhLuan` | `commentStatus` |
| result fields `chamTran`, `soVongCuon`, `loiCuon` | `hitScrollLimit`, `scrollRounds`, `scrollError` |
| comment status `khong-yeu-cau` | `not_requested` |
| `da-dang` | `posted` |
| `khong-co-link` | `no_post_url` |
| `cho-duyet` | `pending_approval` |
| `khong-thay-bai` | `post_not_found` |
| `hong` | `failed` |
| post state `da-duyet` | `approved` |
| in-page helpers `hien`, `cat` | `isVisible`, `squash` |

Every other Vietnamese local variable gets a plain English name chosen by the implementer (`chu` → `text`, `tacGia` → `author`, `ten` → `name`, `phan` → `parts`, `daCo` → `knownKeys`, `moi` → `fresh`, …). User-facing log strings stay Vietnamese and unchanged.

### Shared test helper (created in Task 2, used by Tasks 3–7)

FB Poster tests use `node:test` and its mock timers. In MaiHub use jest globals (`test`, `expect` not required — keep `import assert from 'node:assert'` and the original `assert.*` calls) and this helper instead of `t.mock.timers`:

```ts
// src/__tests__/facebookPoster/helpers.ts
/** Runs `run` with jest fake timers, ticking 5 s at a time until it settles (max 500 ticks), like FB Poster's runWithFakeTimers. */
export async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    jest.useFakeTimers();
    try {
        const promise = run();
        let settled = false;
        promise.then(() => { settled = true; }, () => { settled = true; });
        for (let i = 0; i < 500 && !settled; i++) {
            await jest.advanceTimersByTimeAsync(5000);
        }
        return await promise;
    } finally {
        jest.useRealTimers();
    }
}

/** Fake Playwright locator registry: records which data-maihub-target values were clicked. */
export function fakeLocators(clicked: string[]) {
    return (selector: string) => ({
        first: () => ({
            click: async () => {
                const m = /data-maihub-target="([^"]+)"/.exec(selector);
                clicked.push(m ? m[1] : selector);
            },
        }),
    });
}
```

A ported test that previously asserted an in-page `click*` returned true must now also assert that the matching name appears in `clicked` (fake page gets `locator: fakeLocators(clicked)`).

---

### Task 1: `playwright-core` + `openForAutomation`

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/services/browser/automationLauncher.ts`
- Modify: `src/services/browser/BrowserProfileService.ts`
- Test: `src/__tests__/browser/BrowserProfileService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // BrowserProfileService.ts
  export interface AutomationSession {
      context: BrowserContext;          // import type { BrowserContext } from 'playwright-core'
      close(): Promise<void>;           // idempotent
  }
  export type LaunchAutomation = (executablePath: string, userDataDir: string, args: string[]) => Promise<BrowserContext>;
  // BrowserProfileServiceDeps gains: launchAutomation?: LaunchAutomation
  // BrowserProfileService gains: openForAutomation(id: string): Promise<AutomationSession>
  ```

- [ ] **Step 1: Add the dependency**

```bash
cd ~/deplao-builder/.worktrees/facebook-poster
npm install --save-exact playwright-core@1.62.1
node -e "const p=require('./package.json');p.build.asarUnpack.push('node_modules/playwright-core/**');require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
git diff package.json
```
Expected: `"playwright-core": "1.62.1"` under `dependencies`; `asarUnpack` ends with `"node_modules/playwright-core/**"`. Do **not** run `npx playwright install` (MaiHub ships its own browser engine).

- [ ] **Step 2: Create the launcher**

```ts
// src/services/browser/automationLauncher.ts
import { chromium, type BrowserContext } from 'playwright-core';

/**
 * Lets Playwright launch the antidetect engine itself so it can drive it over --remote-debugging-pipe.
 * ignoreDefaultArgs: true drops Playwright's 38 default switches (measured 03/10/2026), so the browser
 * gets exactly the flags of a manual open plus the pipe. See docs/reports/2026-10-03-browser-automation-pipe-spike.md.
 */
export function launchAutomationBrowser(executablePath: string, userDataDir: string, args: string[]): Promise<BrowserContext> {
    return chromium.launchPersistentContext(userDataDir, {
        executablePath,
        headless: false,
        viewport: null,
        ignoreDefaultArgs: true,
        args,
        timeout: 60000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
    });
}
```

- [ ] **Step 3: Write the failing tests** — append to `src/__tests__/browser/BrowserProfileService.test.ts`. Read the top of that file first and reuse its existing fakes for `store`, `getExecutablePath`, `getProfilesDir`, `createForwarder`, `spawnBrowser` (their names in the file may differ; adapt the `makeService` call below to the file's existing factory, passing `launchAutomation`).

```ts
import { EventEmitter } from 'events';

function fakeContext() {
    const ctx = new EventEmitter() as any;
    ctx.closed = 0;
    ctx.close = async () => { ctx.closed++; ctx.emit('close'); };
    return ctx;
}

describe('openForAutomation', () => {
    test('launches over the pipe with exactly buildLaunchArgs plus --remote-debugging-pipe', async () => {
        const calls: any[] = [];
        const ctx = fakeContext();
        const service = makeService({ launchAutomation: async (exe: string, dir: string, args: string[]) => { calls.push({ exe, dir, args }); return ctx; } });
        const session = await service.openForAutomation(PROFILE_ID);
        expect(session.context).toBe(ctx);
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0]).toBe('--remote-debugging-pipe');
        expect(calls[0].args).toContain(`--user-data-dir=${calls[0].dir}`);
        expect(calls[0].args.some((a: string) => a.startsWith('--remote-debugging-port'))).toBe(false);
        expect(service.isRunning(PROFILE_ID)).toBe(true);
    });

    test('rejects when the profile is already open by hand', async () => {
        const service = makeService({ launchAutomation: async () => fakeContext() });
        await service.open(PROFILE_ID);
        await expect(service.openForAutomation(PROFILE_ID)).rejects.toThrow('Profile đang mở. Đóng profile trước khi chạy tự động');
    });

    test('manual open is rejected while automation runs', async () => {
        const service = makeService({ launchAutomation: async () => fakeContext() });
        await service.openForAutomation(PROFILE_ID);
        await expect(service.open(PROFILE_ID)).rejects.toThrow('Profile đang mở');
    });

    test('releases on context close', async () => {
        const statuses: string[][] = [];
        const ctx = fakeContext();
        const service = makeService({ launchAutomation: async () => ctx, onStatusChanged: (ids: string[]) => statuses.push(ids) });
        await service.openForAutomation(PROFILE_ID);
        ctx.emit('close');
        expect(service.isRunning(PROFILE_ID)).toBe(false);
        expect(statuses[statuses.length - 1]).toEqual([]);
    });

    test('session.close is idempotent and closes the context once', async () => {
        const ctx = fakeContext();
        const service = makeService({ launchAutomation: async () => ctx });
        const session = await service.openForAutomation(PROFILE_ID);
        await Promise.all([session.close(), session.close()]);
        expect(ctx.closed).toBe(1);
        expect(service.isRunning(PROFILE_ID)).toBe(false);
    });

    test('closeAll closes automation sessions', async () => {
        const ctx = fakeContext();
        const service = makeService({ launchAutomation: async () => ctx });
        await service.openForAutomation(PROFILE_ID);
        service.closeAll();
        expect(service.isRunning(PROFILE_ID)).toBe(false);
        await new Promise((r) => setImmediate(r));
        expect(ctx.closed).toBe(1);
    });

    test('close(id) from the Browser Profiles screen closes an automation session', async () => {
        const ctx = fakeContext();
        const service = makeService({ launchAutomation: async () => ctx });
        await service.openForAutomation(PROFILE_ID);
        service.close(PROFILE_ID);
        await new Promise((r) => setImmediate(r));
        expect(ctx.closed).toBe(1);
        expect(service.isRunning(PROFILE_ID)).toBe(false);
    });

    test('launch failure releases the slot and stops the forwarder', async () => {
        const service = makeService({ launchAutomation: async () => { throw new Error('boom'); } });
        await expect(service.openForAutomation(PROFILE_ID)).rejects.toThrow('Không mở được trình duyệt: boom');
        expect(service.isRunning(PROFILE_ID)).toBe(false);
    });

    test('counts toward MAX_RUNNING_PROFILES', async () => {
        // Use the file's existing way of creating MAX_RUNNING_PROFILES distinct profiles; open 30 by hand,
        // then openForAutomation on a 31st must reject with `Đã đạt giới hạn 30 profile mở cùng lúc`.
    });
});
```
For the last test, copy the body of the file's existing "limit 30" test and replace the final `open` with `openForAutomation`. If the file has no such test, build 31 profiles via the fake store and assert the rejection message.

- [ ] **Step 4: Run to see them fail**

Run: `npx jest src/__tests__/browser/BrowserProfileService.test.ts`
Expected: FAIL (`openForAutomation is not a function`).

- [ ] **Step 5: Implement in `BrowserProfileService.ts`**

1. Imports: `import type { BrowserContext } from 'playwright-core';`
2. Add exported `AutomationSession`, `LaunchAutomation` (Interfaces above) and `launchAutomation?: LaunchAutomation` to `BrowserProfileServiceDeps`.
3. `RunningEntry` gains `context: BrowserContext | null;` and `closing: Promise<void> | null;` (initialize both to `null` everywhere an entry is created).
4. Field + constructor:
   ```ts
   private readonly launchAutomation: LaunchAutomation;
   // in constructor:
   this.launchAutomation = deps.launchAutomation
       || ((exe, dir, args) => require('./automationLauncher').launchAutomationBrowser(exe, dir, args));
   ```
   (lazy `require` keeps `playwright-core` out of app start-up.)
5. Extract the checks at the top of `open()` into a private method used by both, keeping `open()`'s messages byte-identical:
   ```ts
   private prepareOpen(id: string, busyMessage: string): { profile: BrowserProfile; proxy: ProxyConfig | null; persona: Persona; executable: string } {
       if (this.running.has(id)) throw new Error(busyMessage);
       if (this.running.size >= MAX_RUNNING_PROFILES) throw new Error(`Đã đạt giới hạn ${MAX_RUNNING_PROFILES} profile mở cùng lúc`);
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
       return { profile, proxy, persona, executable };
   }
   ```
   `open()` calls `this.prepareOpen(id, 'Profile đang mở')`. Import `Persona` from `./fingerprint`.
6. Add:
   ```ts
   public async openForAutomation(id: string): Promise<AutomationSession> {
       const { profile, proxy, persona, executable } = this.prepareOpen(id, 'Profile đang mở. Đóng profile trước khi chạy tự động');
       const entry: RunningEntry = { child: null, forwarder: null, closeRequested: false, exited: false, forceKillTimer: null, context: null, closing: null };
       this.running.set(id, entry);
       let context: BrowserContext;
       try {
           let proxyPort: number | null = null;
           if (proxy) {
               entry.forwarder = this.createForwarder(proxy);
               proxyPort = await entry.forwarder.start();
               this.assertNotCancelled(id, entry);
           }
           const userDataDir = this.getProfileDir(id);
           fs.mkdirSync(userDataDir, { recursive: true });
           const args = ['--remote-debugging-pipe', ...buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort })];
           context = await this.launchAutomation(executable, userDataDir, args);
           if (this.running.get(id) !== entry) {
               await context.close().catch(() => undefined);
               entry.forwarder?.stop().catch(() => undefined);
               throw new Error('Đã hủy mở trình duyệt');
           }
           entry.context = context;
           context.on('close', () => {
               entry.exited = true;
               this.release(id, entry);
           });
       } catch (error: any) {
           this.release(id, entry);
           throw new Error(`Không mở được trình duyệt: ${error?.message || error}`);
       }
       try {
           this.deps.store.touchBrowserProfileOpened(id);
       } catch (error: any) {
           console.warn(`Không ghi được thời điểm mở profile ${id}:`, error?.message || error);
       }
       this.notify();
       const session: AutomationSession = { context, close: () => this.closeAutomation(id, entry) };
       if (entry.closeRequested) void session.close();
       return session;
   }

   /** Graceful context.close() so Chromium flushes cookies; never waits longer than FORCE_KILL_DELAY_MS. Idempotent. */
   private closeAutomation(id: string, entry: RunningEntry): Promise<void> {
       if (!entry.context) { entry.closeRequested = true; return Promise.resolve(); }
       if (!entry.closing) {
           const ctx = entry.context;
           entry.closing = Promise.race([
               ctx.close().catch(() => undefined),
               new Promise<void>((resolve) => { const t = setTimeout(resolve, FORCE_KILL_DELAY_MS); (t as any).unref?.(); }),
           ]).then(() => { this.release(id, entry); });
       }
       return entry.closing;
   }
   ```
   ponytail note to keep as a comment above `closeAutomation`: `// ponytail: a persistent context exposes no browser process, so a hung close() only releases our slot; the browser may linger until it exits by itself.`
7. `close(id)`: at the top after fetching `entry`, add `if (entry.context || entry.closing) { void this.closeAutomation(id, entry); return; }`. Leave the rest unchanged.
8. `closeAll()`: inside the loop, before the existing `if (entry.child)`, add `if (entry.context) void this.closeAutomation(id, entry);`. Keep `this.release(id, entry)` as is.

- [ ] **Step 6: Run tests**

Run: `npx jest src/__tests__/browser/` → all pass (existing + new). Then `npx tsc -p tsconfig.electron.json --noEmit` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/services/browser/automationLauncher.ts src/services/browser/BrowserProfileService.ts src/__tests__/browser/BrowserProfileService.test.ts
git commit -m "feat(browser): open profiles for automation over a pipe"
```

---

### Task 2: Shared types and small ports (`types`, `humanize`, `targets`, `loginState`, test helpers)

**Files:**
- Create: `src/services/facebookPoster/types.ts`, `humanize.ts`, `targets.ts`, `loginState.ts`
- Create: `src/__tests__/facebookPoster/helpers.ts` (content in "Shared test helper" above)
- Test: `src/__tests__/facebookPoster/targets.test.ts`, `src/__tests__/facebookPoster/loginState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  import type { BrowserContext, Page } from 'playwright-core';
  export type LogLevel = 'info' | 'success' | 'warning' | 'error';
  export interface LaunchedPage { ctx: BrowserContext; page: Page; }
  export interface TaskDeps {
      /** Opens the profile's automation browser. The task closes ctx itself when done (as FB Poster did). */
      launch: () => Promise<LaunchedPage>;
      getIsStopping: () => boolean;
      sendLog: (message: string, level: LogLevel) => void;
      updateProgress: (percent: number, label: string) => void;
  }
  // humanize.ts
  export function delayRandom(minMs: number, maxMs: number): Promise<void>;
  export function humanClick(page: Page, selector: string): Promise<void>;
  // targets.ts
  /** Throws 'Phần tử trong danh sách nhóm/trang bị rỗng' on empty input. Bare id/slug → group URL; http URL with /groups/ → group; other http URL → page. */
  export function normalizeTarget(raw: unknown): { url: string; kind: 'group' | 'page' };
  export function pickDelaySeconds(min: number, max: number): number;   // tolerates min > max
  // loginState.ts
  export function isLoggedIn(ctx: Pick<BrowserContext, 'cookies'>): Promise<boolean>;
  ```

- [ ] **Step 1:** Read `git -C /home/maiychrus/Auto-Reup-Facebook show c135379:src/human.js`, `…:src/targets.js`, `…:src/login.js` (only `FB_HOME` and `isLoggedIn`), `…:test/targets.test.js`, `…:test/login.test.js`.
- [ ] **Step 2: Port the tests first.** `targets.test.ts`: every `test(...)` of `test/targets.test.js`, same assertions. `loginState.test.ts`: only the `isLoggedIn` cases of `test/login.test.js` (cookie `c_user` with value → true; missing or empty → false). Imports: `import assert from 'node:assert';` and the module under test.
- [ ] **Step 3:** Run `npx jest src/__tests__/facebookPoster` → FAIL (modules missing).
- [ ] **Step 4:** Write `types.ts` exactly as in Interfaces. Port `human.js` → `humanize.ts`, `targets.js` → `targets.ts`, `isLoggedIn` → `loginState.ts` with types; logic unchanged. Create `helpers.ts`.
- [ ] **Step 5:** Run `npx jest src/__tests__/facebookPoster` → PASS; `npx tsc -p tsconfig.electron.json --noEmit` → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): add shared types, targets, humanize and login check`.

---

### Task 3: `firstComment.ts` (port of `src/binh-luan-bai.js`)

**Files:**
- Create: `src/services/facebookPoster/firstComment.ts`
- Test: `src/__tests__/facebookPoster/firstComment.test.ts`

**Interfaces:**
- Consumes: `TaskDeps` (only `sendLog`, `getIsStopping`) from Task 2.
- Produces:
  ```ts
  export type CommentStatus = 'not_requested' | 'posted' | 'no_post_url' | 'pending_approval' | 'post_not_found' | 'failed';
  export interface CommentOutcome { status: CommentStatus; reason: string; }
  export function postFirstComment(
      page: Page,
      input: { postUrl: string | null; comment: string | null; text: string },
      deps?: { sendLog?: TaskDeps['sendLog']; getIsStopping?: () => boolean },
  ): Promise<CommentOutcome>;   // never throws
  export const OPEN_COMMENT_LABELS: string[]; export const SEND_COMMENT_LABELS: string[];
  export const PENDING_APPROVAL_MARKERS: string[];
  export function evaluatePostState(x?: { found?: boolean; pendingMarker?: string | null }): { status: 'approved' | 'pending_approval' | 'post_not_found'; reason: string };
  export function evaluateComment(before: unknown, after: unknown, textFound: boolean): { ok: boolean; reason: string };
  export function matchSnippet(text: string | null | undefined): string;
  ```
  Field names inside `evaluatePostState`'s argument: FB Poster uses `thayBai` → `found`, `choDuyet` → `pendingMarker`.

- [ ] **Step 1:** Read `c135379:src/binh-luan-bai.js` and `c135379:test/binh-luan-bai.test.js` completely.
- [ ] **Step 2: Port the tests** to `firstComment.test.ts`: all 13 tests, same scenarios and messages, renamed per the table (e.g. `trangThai` → `status`, `'khong-co-link'` → `'no_post_url'`, `/dán tay/` regex unchanged because user-facing text is unchanged). Add one new test:
  ```ts
  test('send button is clicked through a trusted locator, not element.click()', async () => {
      // Build a fake page whose evaluate() returns: openCommentBoxInPage → true, markCommentBoxInPage → true,
      // countCommentBlocksInPage → 3 then 4, markCommentSendButtonInPage → true, commentTextVisibleInPage → true,
      // readPostStateInPage → { found: true, pendingMarker: null }; goto → resolves; locator: fakeLocators(clicked);
      // keyboard.type → resolves; waitForTimeout → resolves.
      const clicked: string[] = [];
      // ...build page as described (dispatch evaluate by fn.name)...
      const out = await runWithFakeTimers(() => postFirstComment(page, { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'Liên hệ 0900', text: 'Bài' }));
      assert.strictEqual(out.status, 'posted');
      assert.deepStrictEqual(clicked.filter((c) => c === 'comment-send'), ['comment-send']);
  });
  ```
  Read how `binhLuanVaoBai` types into the box (it uses a locator on the `DAU` attribute and `keyboard.type`/`fill`) and give the fake page exactly the methods it calls.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4: Port the module.** Rename per table. Change `bamNutGuiTrongTrang` into `markCommentSendButtonInPage({ mark, labels })`: same search, but instead of `nut.click()` do:
  ```js
  document.querySelectorAll('[data-maihub-target]').forEach((e) => e.removeAttribute('data-maihub-target'));
  nut.setAttribute('data-maihub-target', 'comment-send');
  return true;
  ```
  At the call site, after it returns true: `await page.locator('[data-maihub-target="comment-send"]').first().click({ timeout: 10000 });`. Everything else (count before/after, text check, pending-approval logic, never-throw) unchanged.
- [ ] **Step 5:** Run → PASS. `npx tsc -p tsconfig.electron.json --noEmit` → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): port first comment with trusted send click`.

---

### Task 4: `postToTargets.ts` (port of `src/post.js`)

**Files:**
- Create: `src/services/facebookPoster/postToTargets.ts`
- Test: `src/__tests__/facebookPoster/postToTargets.test.ts`, `src/__tests__/facebookPoster/composerInvite.test.ts`

**Interfaces:**
- Consumes: `TaskDeps`, `delayRandom`, `humanClick`, `normalizeTarget`, `pickDelaySeconds`, `isLoggedIn`, `postFirstComment`, `CommentStatus`.
- Produces:
  ```ts
  export const COMPOSER_INVITE: string;          // value copied verbatim from post.js
  export const PUBLISH_LABELS: string[];
  export function isPublishLabel(text: unknown): boolean;
  export interface PostTargetResult { url: string; ok: boolean; error: string | null; postUrl: string | null; commentStatus: CommentStatus; identity: string; }
  export interface PostInput { text: string; mediaPath?: string | null; comment?: string | null; targets: string[]; minDelay?: number; maxDelay?: number; }
  export function postToTargets(
      input: PostInput,
      deps: TaskDeps & { onResult?: (result: PostTargetResult) => void },
  ): Promise<{ posted: number; failed: number; results: PostTargetResult[] }>;
  ```
  `identity` is the string `readComposerIdentityInPage` returned for that target (`''` if none). `minDelay`/`maxDelay` are seconds between targets, as in FB Poster.
  Extra exports (for Task 13's dry-run script, which imports them from the compiled module): `markComposerInviteInPage`, `isPublishDisabledInPage`, `composerIsOpenInPage`, `focusEditorInPage`, `EDITOR_SELECTORS`.

- [ ] **Step 1:** Read `c135379:src/post.js`, `c135379:test/post.test.js`, `c135379:test/composer-invite.test.js` completely.
- [ ] **Step 2: Port the tests.** All 29 tests of `post.test.js` and the 2 of `composer-invite.test.js`. Replace `runWithFakeTimers(t, run)` with the helper's `runWithFakeTimers(run)`. FB Poster fakes `launch` as `async () => ({ ctx, page })` — keep that, it already matches `TaskDeps.launch`. Fake pages dispatch `evaluate(fn, arg)` on `fn.name`; rename the names they check per the table. Because `markComposerInviteInPage` and `markPublishButtonInPage` no longer click, give every fake page `locator: fakeLocators(clicked)` and, in each test that previously relied on the composer opening or the post publishing, assert `clicked` contains `'composer-invite'` / `'publish'`. Add two new tests:
  ```ts
  test('onResult is called once per target, in order, as soon as each target finishes', async () => { /* 2 targets, first ok second fails; assert onResult got 2 calls with ok true then false, and the first call happened before the second target's goto */ });
  test('identity read from the composer is stored on each result', async () => { /* readComposerIdentityInPage returns 'Media Soec ơi, bạn đang nghĩ gì thế?' → results[0].identity equals it */ });
  ```
  Write their bodies with the same fake-page style as the ported tests.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4: Port the module.** Rename per table. Specific changes:
  1. Signature: `postToTargets(input, deps)` where `deps` is `TaskDeps & { onResult? }`; drop the `env` parameter and `launchProfile` default; call `const { ctx, page } = await deps.launch();`.
  2. `markComposerInviteInPage(pattern)`: same search as `clickComposerInPage`, but clear old marks, set `data-maihub-target="composer-invite"` on the found element, return true. Call site: if it returns true, `await page.locator('[data-maihub-target="composer-invite"]').first().click({ timeout: 10000 });`, else keep FB Poster's warning log.
  3. `markPublishButtonInPage(labels)`: same search as `clickPublishInPage` (dialog roots, `/post/create` fallback, aria-label then span), but mark the element that FB Poster would have clicked (`nut`, or `span.closest('.x1ja2u2z') || span.closest('[role="button"]') || span`) with `data-maihub-target="publish"` and return true. Call site: `published = await page.evaluate(markPublishButtonInPage, PUBLISH_LABELS); if (published) await page.locator('[data-maihub-target="publish"]').first().click({ timeout: 10000 });`. Keep the existing `humanClick` fallback path unchanged.
  4. After `results.push(entry)`, call `deps.onResult?.(entry)`.
  5. Rename result field `binhLuan` → `commentStatus` with the new status values; add `identity`.
  6. Remove every `process.env` read; defaults come from `input`.
- [ ] **Step 5:** Run → PASS. `npx tsc -p tsconfig.electron.json --noEmit` → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): port group and page posting with trusted clicks`.

---

### Task 5: `scanGroups.ts` (port of `src/groups.js`)

**Files:**
- Create: `src/services/facebookPoster/scanGroups.ts`
- Test: `src/__tests__/facebookPoster/scanGroups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScannedGroup { id: string; name: string; url: string; }   // keep source field set if it differs, and update this line
  export function parseGroupLinks(raw: unknown): ScannedGroup[];
  /** Same options object as FB Poster's scanGroups({ launch, env, settleMs, scrollWaitMs, maxScrolls, kienNhan }) minus env, kienNhan renamed patience. */
  export function scanGroups(deps: TaskDeps & { settleMs?: number; scrollWaitMs?: number; maxScrolls?: number; patience?: number }): Promise<{ groups: ScannedGroup[]; hitScrollLimit: boolean; scrollRounds: number; scrollError: boolean }>;
  ```
- [ ] **Step 1:** Read `c135379:src/groups.js` and `c135379:test/groups.test.js`.
- [ ] **Step 2:** Port all 27 tests (rename fields per table; `launch` fake returns `{ ctx, page }`).
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Port the module: signature `scanGroups(deps)`; `deps.launch()` instead of `launch(env)`; not-logged-in path unchanged; rename result fields.
- [ ] **Step 5:** Run → PASS; electron tsc → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): port group scanning`.

---

### Task 6: `joinGroups.ts` (port of `src/join.js`)

**Files:**
- Create: `src/services/facebookPoster/joinGroups.ts`
- Test: `src/__tests__/facebookPoster/joinGroups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JoinOutcome = 'joined' | 'pending' | 'skipped' | 'failed' | 'unknown';
  export interface JoinResult { id: string; name: string; url: string; outcome: JoinOutcome; }
  export function buildSearchUrl(keyword: string): string;
  export function searchAndJoinGroups(
      input: { keywords: string[]; limit?: number; minDelay?: number; maxDelay?: number },   // defaults 10, 300, 900 as in join.js
      deps: TaskDeps & { onResult?: (r: JoinResult) => void; settleMs?: number; scrollWaitMs?: number; maxScrolls?: number; patience?: number;
          groupSettleMs?: number; pollMs?: number; joinWaitMs?: number; restCheckMs?: number;
          scan?: typeof scanGroups; search?: typeof searchGroupsByKeyword },
  ): Promise<{ joined: number; pending: number; skipped: number; failed: number; results: JoinResult[] }>;
  ```
  Note: `searchAndJoinGroups` first calls `scan(...)` (which calls `deps.launch()` and closes it), then calls `deps.launch()` **again** for the join loop. `launch` must therefore support being called more than once per task (Task 9 handles this).
- [ ] **Step 1:** Read `c135379:src/join.js` and `c135379:test/join.test.js`.
- [ ] **Step 2:** Port all 33 tests. Fake pages get `locator: fakeLocators(clicked)`; tests that expect a join click assert `clicked` contains `'join'`.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Port. `markJoinButtonInPage(arg)`: same search as `clickJoinInPage`, marks `data-maihub-target="join"` instead of `el.click()`; call site clicks the locator when it returns true. Call `deps.onResult?.(r)` after each `results.push`.
- [ ] **Step 5:** Run → PASS; electron tsc → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): port group search and join with trusted click`.

---

### Task 7: `collectComments.ts` (port of `src/comments.js` + `keyOf`)

**Files:**
- Create: `src/services/facebookPoster/collectComments.ts`
- Test: `src/__tests__/facebookPoster/collectComments.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CollectedComment { authorId: string; authorName: string; authorUrl: string; text: string; commentedAt: string; postUrl: string; }
  export function keyOf(c: Pick<CollectedComment, 'authorId' | 'postUrl' | 'text'>): string;   // `${authorId}\u0000${postUrl}\u0000${text}`
  export function collectComments(
      input: { posts: { postUrl: string }[]; minDelay?: number; maxDelay?: number; maxPerPost?: number; settleMs?: number },   // defaults 10, 20, 100, 3000 as in comments.js
      deps: TaskDeps & {
          loadKeys: () => Promise<Set<string>>;
          saveComments: (rows: CollectedComment[]) => Promise<number>;   // returns rows actually written
      },
  ): Promise<{ scanned: number; failed: number; added: number; results: { url: string; outcome: 'done' | 'failed'; error: string | null; added: number }[] }>;
  ```
  `readCommentsInPage` produces `authorId`, `authorUrl`, `text`, `commentedAt` and an author-name field — map that name field to `authorName`. Result rows: `url` = `p.postUrl`.
- [ ] **Step 1:** Read `c135379:src/comments.js`, `c135379:src/comments-store.js` (`keyOf`, `loadKeys`, `appendComments` semantics), `c135379:test/comments.test.js`.
- [ ] **Step 2:** Port all 35 tests. Replace the file-store fakes with in-memory `loadKeys`/`saveComments` fakes. Keep the test that proves a disk-write failure (`appendComments` returning 0) is reported, now as `saveComments` resolving 0.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Port with `deps.loadKeys()` / `deps.saveComments(fresh)` in place of `loadKeys({dataDir})` / `appendComments(fresh, {dataDir, mode})`. Rename per table.
- [ ] **Step 5:** Run → PASS; electron tsc → exit 0.
- [ ] **Step 6: Commit** `feat(facebook-poster): port comment collection`.

---

### Task 8: Schema and `FacebookPosterStore`

**Files:**
- Create: `src/services/facebookPoster/schema.ts`, `src/services/facebookPoster/FacebookPosterStore.ts`, `src/models/facebookPoster.ts`
- Modify: `src/services/database/DatabaseService.ts` (table block after the browser-profile tables ≈ line 1132; `deleteBrowserProfile` ≈ line 3072)
- Test: `src/__tests__/facebookPoster/FacebookPosterStore.test.ts`

**Interfaces:**
- Produces (`src/models/facebookPoster.ts`):
  ```ts
  export type FbPosterKind = 'post' | 'join' | 'scan_groups' | 'collect_comments';
  export type FbPosterMode = 'group' | 'page';
  export type FbPosterRunStatus = 'running' | 'done' | 'cancelled' | 'failed';
  export interface FbPosterRun { id: string; kind: FbPosterKind; mode: FbPosterMode | ''; params: Record<string, unknown>; status: FbPosterRunStatus; error: string; startedAt: number; finishedAt: number | null; }
  export interface FbPosterResult { id: number; runId: string; profileId: string; profileName: string; targetUrl: string; targetName: string; outcome: string; error: string; postUrl: string | null; commentStatus: string; identity: string; createdAt: number; }
  export interface FbPosterGroup { profileId: string; url: string; name: string; scannedAt: number; }
  export interface FbPosterComment { key: string; profileId: string; postUrl: string; authorId: string; authorName: string; authorUrl: string; text: string; commentedAt: string; collectedAt: number; }
  ```
- Produces (`FacebookPosterStore.ts`):
  ```ts
  export interface SqlDatabase {
      exec(sql: string): void;
      run(sql: string, params?: any[]): void;
      runInsert(sql: string, params?: any[]): number;
      transaction<T>(fn: () => T): T;
      query<T>(sql: string, params?: any[]): T[];
      queryOne<T>(sql: string, params?: any[]): T | null;   // check DatabaseService.queryOne's real return type and match it
  }
  export class FacebookPosterStore {
      constructor(db: SqlDatabase);
      ensureSchema(): void;                                         // db.exec(FB_POSTER_SCHEMA_SQL)
      createRun(run: { id: string; kind: FbPosterKind; mode: FbPosterMode | ''; params: Record<string, unknown>; startedAt: number }): void;  // status 'running'
      finishRun(id: string, status: Exclude<FbPosterRunStatus, 'running'>, error: string, finishedAt: number): void;
      failInterruptedRuns(now: number): number;                     // running → failed, error 'App đóng khi việc đang chạy'; returns count
      addResult(r: Omit<FbPosterResult, 'id'>): number;
      listRuns(opts: { limit: number; offset: number; kind?: FbPosterKind }): { runs: FbPosterRun[]; total: number };
      getRun(id: string): { run: FbPosterRun; results: FbPosterResult[] } | null;
      replaceGroups(profileId: string, groups: { url: string; name: string }[], scannedAt: number): void;   // one transaction
      listGroups(profileIds: string[]): Record<string, FbPosterGroup[]>;  // every requested id is a key, [] when none
      deleteGroupsOfProfile(profileId: string): void;
      loadCommentKeys(): Set<string>;
      saveComments(profileId: string, rows: CollectedComment[], collectedAt: number): number;   // INSERT OR IGNORE, returns inserted count
      listComments(opts: { postUrl?: string; limit: number; offset: number }): { comments: FbPosterComment[]; total: number };
      listPostedUrls(limit: number): { postUrl: string; profileId: string; profileName: string; targetUrl: string; createdAt: number }[];  // results with post_url NOT NULL, newest first, distinct post_url
  }
  ```

- [ ] **Step 1: Write `schema.ts`** — `export const FB_POSTER_SCHEMA_SQL = \`...\`` containing exactly the four `CREATE TABLE IF NOT EXISTS` and two `CREATE INDEX IF NOT EXISTS` statements from spec §5.
- [ ] **Step 2: Write the failing tests** with an in-memory adapter:
  ```ts
  import Database from 'better-sqlite3';
  import assert from 'node:assert';
  import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';

  function memoryDb(): SqlDatabase {
      const db = new Database(':memory:');
      return {
          exec: (sql) => { db.exec(sql); },
          run: (sql, p = []) => { db.prepare(sql).run(...p); },
          runInsert: (sql, p = []) => Number(db.prepare(sql).run(...p).lastInsertRowid),
          transaction: (fn) => db.transaction(fn)(),
          query: (sql, p = []) => db.prepare(sql).all(...p) as any,
          queryOne: (sql, p = []) => (db.prepare(sql).get(...p) as any) ?? null,
      };
  }
  function store() { const s = new FacebookPosterStore(memoryDb()); s.ensureSchema(); return s; }
  ```
  Tests (one `test` each): `ensureSchema` twice is harmless; `createRun`→`getRun` round-trips `params` JSON; `finishRun` sets status/error/finishedAt; `failInterruptedRuns` turns only `running` runs into `failed` with the exact error and returns the count; `addResult` + `getRun` returns results ordered by `id`; `listRuns` newest first with `total`, `kind` filter; `replaceGroups` replaces only that profile's rows and is atomic (throwing mid-way via a duplicate URL in the input leaves old rows intact — use two identical URLs so the PRIMARY KEY fails); `listGroups` returns `[]` for unknown ids; `deleteGroupsOfProfile`; `saveComments` ignores duplicates by `keyOf` and returns inserted count; `loadCommentKeys` contains saved keys; `listComments` filter by `postUrl` and paging; `listPostedUrls` distinct and newest first.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4: Implement `FacebookPosterStore`** (straightforward parameterized SQL; map snake_case columns to the camelCase model fields; `params_json` via `JSON.stringify/parse`; `listRuns` `ORDER BY started_at DESC LIMIT ? OFFSET ?` plus `SELECT COUNT(*)`).
- [ ] **Step 5: Wire into `DatabaseService`:**
  - `import { FB_POSTER_SCHEMA_SQL } from '../facebookPoster/schema';`
  - After the browser-profile `this.exec(\`...\`)` block: `this.exec(FB_POSTER_SCHEMA_SQL);` with comment `// ─── Facebook poster ──…`.
  - `deleteBrowserProfile(id)`: add `db!.prepare('DELETE FROM fb_poster_groups WHERE profile_id = ?').run(id);` after the existing delete.
- [ ] **Step 6:** Run `npx jest` (all) → PASS; both tsc commands → exit 0.
- [ ] **Step 7: Commit** `feat(facebook-poster): add run, result, group and comment storage`.

---

### Task 9: `FacebookPosterService` (orchestration)

**Files:**
- Create: `src/services/facebookPoster/FacebookPosterService.ts`
- Test: `src/__tests__/facebookPoster/FacebookPosterService.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  ```ts
  export interface ProfileInfo { id: string; name: string; }
  export type StartParams =
      | { kind: 'post'; mode: FbPosterMode; text: string; mediaPath: string | null; comment: string | null; profiles: { profileId: string; targets: string[] }[]; minDelaySec: number; maxDelaySec: number; concurrency: number }
      | { kind: 'scan_groups'; profileIds: string[]; concurrency: number }
      | { kind: 'join'; profileId: string; keywords: string[]; limit: number; minDelaySec: number; maxDelaySec: number }
      | { kind: 'collect_comments'; profileId: string; postUrls: string[] };
  export interface ProfileProgress { profileId: string; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; done: number; total: number; }
  export interface ProgressSnapshot { runId: string; done: number; total: number; profiles: ProfileProgress[]; }
  export interface FacebookPosterServiceDeps {
      store: FacebookPosterStore;
      getProfile: (id: string) => ProfileInfo | null;
      openForAutomation: (profileId: string) => Promise<AutomationSession>;
      emit: (channel: 'facebookPoster:log' | 'facebookPoster:progress' | 'facebookPoster:runFinished', data: unknown) => void;
      now?: () => number;
      random?: () => number;
      sleep?: (ms: number, isStopping: () => boolean) => Promise<void>;   // default: 500 ms slices, returns early when stopping
      newId?: () => string;                                               // default crypto.randomUUID
      tasks?: Partial<{ postToTargets: typeof postToTargets; scanGroups: typeof scanGroups; searchAndJoinGroups: typeof searchAndJoinGroups; collectComments: typeof collectComments }>;
  }
  export class FacebookPosterService {
      constructor(deps: FacebookPosterServiceDeps);
      start(params: StartParams): { runId: string };     // throws 'Đang có việc chạy' if busy; work continues in background
      cancel(): void;                                    // no-op when idle
      cancelAll(): void;                                 // same as cancel(); used on quit/workspace switch
      current(): { run: FbPosterRun; progress: ProgressSnapshot } | null;
      whenIdle(): Promise<void>;                         // resolves when the current run finished (tests)
  }
  ```

Behaviour (each bullet is at least one test):

1. `start` while a run is active throws `Đang có việc chạy`; after it finishes a new `start` works.
2. `createRun` is called before any profile opens; `finishRun(..., 'done' | 'cancelled' | 'failed', ...)` exactly once at the end; `facebookPoster:runFinished` emitted after `finishRun`.
3. `post`/`scan_groups`: at most `concurrency` profiles run at once (measure max simultaneous `openForAutomation` without `close`).
4. Stagger: profile k ≥ 1 starts only after a `sleep` of `30000 + random() * 60000` ms after profile k−1 started (assert the sleep durations passed to the injected `sleep`).
5. Per profile: the `launch` given to the task calls `openForAutomation(profileId)` **each time it is called** (join calls it twice: once inside its group scan, once for joining) and returns `{ ctx: session.context, page: session.context.pages()[0] ?? await session.context.newPage() }`. The service keeps every session it opened for that profile and closes all of them in `finally`, even if the task throws. On the **first** call for a profile, before returning, the wrapper runs the login check of bullet 6.
6. Login check: on the first `launch()` of a profile, `isLoggedIn(session.context)` false → close that session and throw `Error('Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập')`. The task fails with that error and the service records every target of that profile without a result as `failed` with that exact message (same path as bullet 9). No extra browser launch is spent on the check.
7. **profile busy:** `openForAutomation` rejects → every target of that profile `failed` with the rejection message; other profiles still run; run ends `done`.
8. `onResult` from `postToTargets` → `store.addResult` immediately with `outcome` `posted`/`failed`, `postUrl`, `commentStatus`, `identity`, `profileName` from `getProfile`; mode `page` passes targets `['https://www.facebook.com/']`.
9. **launch closed mid-run:** the task throws (as Playwright does when the window closes) → targets with no result yet for that profile become: the first one `failed` with the error message, the rest `skipped` with `Đã dừng`.
10. Cancel: `cancel()` makes `getIsStopping()` true for all tasks and the stagger/sleep loops; profiles not yet started record all targets `skipped`; run ends `cancelled`; all sessions closed.
11. `scan_groups` → `store.replaceGroups(profileId, groups, now)` per profile; one result row per profile with outcome `done` (target_url `https://www.facebook.com/groups/joins/`, target_name `"<n> nhóm"`) or `failed`.
12. `join` → results rows per group from `onResult` (`target_url` = group url, `target_name` = name, outcome as returned).
13. `collect_comments` → `loadKeys` = `store.loadCommentKeys()`, `saveComments` = rows → `store.saveComments(profileId, rows, now)`; one result row per post url.
14. Progress: after every result, emit `facebookPoster:progress` with correct `done/total` and per-profile states; `current()` returns the same snapshot.
15. `sendLog` from tasks → `facebookPoster:log` `{ runId, profileId, level, message, at }`.
16. If something unexpected throws outside a task (e.g. `store.addResult` throws), the run ends `failed` with that message and sessions are closed.

- [ ] **Step 1:** Write tests for bullets 1–16 with fakes: fake store (record calls, or a real `FacebookPosterStore` over the in-memory adapter from Task 8 — preferred), fake `openForAutomation` returning `{ context: fakeCtx, close }` where `fakeCtx = { cookies: async () => [{ name: 'c_user', value: '1' }], pages: () => [fakePage], newPage: async () => fakePage }`, fake tasks via `deps.tasks`, `sleep` that records durations and resolves immediately, `random: () => 0.5`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Concurrency with a simple worker pool:
  ```ts
  private async runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
      let next = 0;
      let lastStart = 0;
      const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
          while (next < items.length && !this.stopping) {
              const index = next++;
              if (index === 0) {
                  lastStart = this.now();
              } else {
                  // Reserve the start slot BEFORE sleeping so concurrent waiters are spaced from each other.
                  const gap = 30000 + this.random() * 60000;
                  const startAt = Math.max(this.now(), lastStart + gap);
                  lastStart = startAt;
                  await this.sleep(startAt - this.now(), () => this.stopping);
                  if (this.stopping) break;
              }
              await worker(items[index], index);
          }
      });
      await Promise.all(runners);
  }
  ```
  Bullet 4 is measured against this: the k-th start is reserved at `max(now, lastStart + gap)` before sleeping, so with concurrency > 1 successive starts are still 30–90 s apart (spec §7). A scan with `scrollError` keeps the stored groups and records `failed`; `hitScrollLimit` replaces them and records `done` with a warning in `error`. In tests `now` is a fake clock advanced by `sleep`. After the pool, any profile never started records its targets `skipped`.
- [ ] **Step 4:** Run → PASS; electron tsc → exit 0.
- [ ] **Step 5: Commit** `feat(facebook-poster): orchestrate jobs across profiles`.

---

### Task 10: Start-parameter validation + IPC + preload + main wiring

**Files:**
- Create: `src/services/facebookPoster/validateStartParams.ts`, `electron/ipc/facebookPosterIpc.ts`
- Modify: `electron/main.ts`, `electron/ipc/workspaceIpc.ts`, `electron/ipc/browserProfileIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`
- Test: `src/__tests__/facebookPoster/validateStartParams.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // validateStartParams.ts — pure, no electron import
  export function validateStartParams(
      input: { kind?: unknown; params?: unknown },
      env: { profileExists: (id: string) => boolean; fileExists: (path: string) => boolean },
  ): StartParams;   // throws Error with a Vietnamese message on invalid input
  // facebookPosterIpc.ts
  export function registerFacebookPosterIpc(): void;
  export function cancelFacebookPosterJobs(): void;
  export async function cancelAndWaitFacebookPosterJobs(timeoutMs?: number): Promise<void>;  // cancelAll + wait for whenIdle() (default 10 s); never throws; used by workspaceIpc
  ```

- [ ] **Step 1: Failing tests for `validateStartParams`** — one test per rule in spec §8 and Global Constraints, with these exact messages:

| Input | Message |
|---|---|
| unknown `kind` | `Loại việc không hợp lệ` |
| `mode` not group/page | `Chế độ đăng không hợp lệ` |
| empty/whitespace `text` | `Nội dung bài không được để trống` |
| `text` > 63206 | `Nội dung bài tối đa 63206 ký tự` |
| `comment` > 8000 | `Bình luận tối đa 8000 ký tự` |
| unknown profile id | `Không tìm thấy profile` |
| no profiles | `Chưa chọn profile` |
| group mode, a profile with 0 valid targets | `Profile "<id>" chưa có nhóm nào` |
| invalid target line (group mode: `normalizeTarget` throws, gives `kind !== 'group'`, or a bare id/slug with characters outside `A-Z a-z 0-9 . _ -`) | `Đích không hợp lệ: <line>` |
| > 500 targets total (after de-dup) | `Tối đa 500 đích cho một lần chạy` |
| `mediaPath` missing on disk | `Không tìm thấy tệp ảnh/video` |
| `mediaPath` bad extension | `Chỉ hỗ trợ ảnh/video: jpg, jpeg, png, gif, webp, mp4, mov, webm` |
| delays out of range | `Thời gian nghỉ không hợp lệ` |
| `concurrency` not integer 1–10 | `Số profile song song phải từ 1 đến 10` |
| join `limit` not integer 1–200 | `Giới hạn nhóm phải từ 1 đến 200` |
| join with no non-empty keyword | `Chưa nhập từ khóa` |
| collect with no post url | `Chưa chọn bài` |

  Plus: duplicate targets within one profile collapse to one (after `normalizeTarget`); page mode ignores `targets` and the result has `targets: ['https://www.facebook.com/']` per profile; defaults `minDelaySec 300`, `maxDelaySec 900`, `concurrency 3` when omitted; `comment` whitespace-only → `null`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `validateStartParams`. **Step 4:** Run → PASS.
- [ ] **Step 5: IPC module** `electron/ipc/facebookPosterIpc.ts`. Structure it like `browserProfileIpc.ts`:
  - Copy its `handle(channel, handler)` wrapper (employee-mode rejection, `{ success, ... }`, `Logger` on error).
  - `store()`: returns a `FacebookPosterStore` over `DatabaseService.getInstance()` (it satisfies `SqlDatabase`); keep `lastDbPath`; when `db().getDbPath()` differs from `lastDbPath`, call `failInterruptedRuns(Date.now())` once and remember the path.
  - `service()`: lazy singleton `FacebookPosterService` with `getProfile: (id) => { const p = db().getBrowserProfileById(id); return p ? { id: p.id, name: p.name } : null; }`, `openForAutomation: (id) => getBrowserProfileService().openForAutomation(id)`, `emit: (ch, data) => EventBroadcaster.emit(ch, data)`. Export a `getBrowserProfileService()` from `browserProfileIpc.ts` (rename its private `getProfileService` usage by adding `export function getBrowserProfileService() { return getProfileService(); }` — do not change the private function) so both IPC modules share one `BrowserProfileService` instance. Because the service binds to `store()`, recreate it when the DB path changes and no run is active.
  - Handlers per spec §8: `start` (refuse with `Chưa cài trình duyệt. Hãy tải trình duyệt ở màn hình Trình duyệt.` when `getEngineManager().getExecutablePath()` is null — export a small `isBrowserEngineInstalled()` from `browserProfileIpc.ts`), `cancel`, `current`, `listGroups`, `listRuns` (limit default 50, max 200), `getRun`, `listComments` (limit default 100, max 500), `listPostedUrls` (limit 200), `pickMedia` (`dialog.showOpenDialog` with filters `Ảnh/video` + the 8 extensions, `properties: ['openFile']`; return `{ path: null }` on cancel), `exportRunCsv` (`dialog.showSaveDialog` default name `facebook-poster-<runId>.csv`; columns `profile,target,name,outcome,error,post_url,comment_status,identity,time`; UTF-8 with BOM; quote every field, double inner quotes).
  - `cancelFacebookPosterJobs()`: `service?.cancelAll()` if created.
- [ ] **Step 6: Wire main + workspace:** in `electron/main.ts` import and call `registerFacebookPosterIpc()` right after `registerBrowserProfileIpc()`; in the `before-quit` handler call `cancelFacebookPosterJobs()` immediately before `closeAllBrowserProfiles()`. In `electron/ipc/workspaceIpc.ts` add `try { cancelFacebookPosterJobs(); } catch {}` immediately before both existing `closeAllBrowserProfiles()` calls.
- [ ] **Step 7: Preload + renderer types.** In `electron/preload.ts`: add `'facebookPoster:log'`, `'facebookPoster:progress'`, `'facebookPoster:runFinished'` to the allow-list under the browser-profile events; add after the `browserProfile` block:
  ```ts
  facebookPoster: {
    start:          (kind: string, params: any)  => ipcRenderer.invoke('facebookPoster:start', { kind, params }),
    cancel:         ()                            => ipcRenderer.invoke('facebookPoster:cancel'),
    current:        ()                            => ipcRenderer.invoke('facebookPoster:current'),
    listGroups:     (profileIds: string[])        => ipcRenderer.invoke('facebookPoster:listGroups', { profileIds }),
    listRuns:       (params?: any)                => ipcRenderer.invoke('facebookPoster:listRuns', params || {}),
    getRun:         (runId: string)               => ipcRenderer.invoke('facebookPoster:getRun', { runId }),
    listComments:   (params?: any)                => ipcRenderer.invoke('facebookPoster:listComments', params || {}),
    listPostedUrls: ()                            => ipcRenderer.invoke('facebookPoster:listPostedUrls'),
    pickMedia:      ()                            => ipcRenderer.invoke('facebookPoster:pickMedia'),
    exportRunCsv:   (runId: string)               => ipcRenderer.invoke('facebookPoster:exportRunCsv', { runId }),
  },
  ```
  In `src/ui/lib/ipc.ts`: add a matching `facebookPoster` member to the `electronAPI` type using the model types from `src/models/facebookPoster.ts` (each returns `Promise<{ success: boolean; error?: string; ... }>`), and `facebookPoster: window.electronAPI?.facebookPoster,` next to `browserProfile` in the `ipc` object.
- [ ] **Step 8:** `npx jest` → PASS; both tsc → exit 0; `npm run build:electron` → exit 0.
- [ ] **Step 9: Commit** `feat(facebook-poster): add IPC, validation and app wiring`.

---

### Task 11: UI — shell, run panel, Post tab, navigation

**Files:**
- Create: `src/ui/features/facebookPoster/FacebookPosterView.tsx`, `RunPanel.tsx`, `PostTab.tsx`, `ProfilePicker.tsx`
- Modify: `src/ui/store/appStore.ts`, `src/ui/components/layout/Sidebar.tsx`, `src/ui/App.tsx`, `DESIGN.md`

Read first: `DESIGN.md`, `src/ui/features/browser/BrowserProfilesView.tsx` (layout, table, toolbar, empty/loading states, `ipc.on` subscription, `showNotification`, `showConfirm`), `src/ui/components/common/icons`.

- [ ] **Step 1: Navigation.** `AppView` gains `'facebookPoster'`. In `Sidebar.tsx` add, directly after the "Trình duyệt" `NavItem` and inside the same `empMode !== 'employee' && !isSimulating` condition: `<NavItem icon="facebookPoster" label="Đăng Facebook" collapsed={collapsed} active={view === 'facebookPoster'} onClick={() => setView('facebookPoster')} />`, and a `case 'facebookPoster':` in `NavIcon` with a 16×16 stroke icon in the same style as `browser` (a paper-plane: `<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>`). In `App.tsx` import the view and render it like `BrowserProfilesView` (`view === 'facebookPoster'`).
- [ ] **Step 2: `FacebookPosterView`**: header with title "Đăng Facebook"; tab bar (Đăng bài, Tham gia nhóm, Bình luận, Lịch sử) with `role="tablist"`/`role="tab"`/`aria-selected`, keyboard arrows move between tabs; content area scrolls; `RunPanel` on the right at ≥1024 px, stacked below under 1024 px. On mount: `ipc.facebookPoster.current()` and subscribe to the three events (unsubscribe on unmount). Keep `{ run, progress, logs[] }` state here (logs capped at 500, newest last) and pass `busy = run?.status === 'running'` to tabs.
- [ ] **Step 3: `RunPanel`**: overall progress bar (`done/total`, percent text), per-profile rows (name, state chip, `done/total`), log list with level colors (info = secondary text, success = green, warning = orange, error = red tokens), timestamps `HH:mm:ss`, auto-scroll to bottom unless the user scrolled up; "Hủy" button (danger) enabled while busy, calls `cancel()` after `showConfirm`. Empty state: "Chưa có việc nào đang chạy."
- [ ] **Step 4: `ProfilePicker`** props `{ mode: 'multi' | 'single'; selected: string[]; onChange(ids): void; disabled?: boolean }`: loads `ipc.browserProfile.list()`; search box, group filter, rows with checkbox/radio, name, proxy label, "Đang mở" badge for `runningIds`; subscribes to `browserProfile:statusChanged`. Empty state with a button that `setView('browser')` and text "Chưa có profile. Tạo profile ở màn hình Trình duyệt."
- [ ] **Step 5: `PostTab`**: mode toggle Nhóm/Page; textarea "Nội dung bài" (counter `n/63206`); media row (button "Chọn ảnh/video" → `pickMedia`, file name, "Bỏ"); textarea "Bình luận đầu tiên (tuỳ chọn)"; `ProfilePicker` multi; when mode = Nhóm: shared keyword filter input (accent-insensitive, comma-separated, any keyword matches the group name — same rule as FB Poster `khopTuKhoa` in `public/common.js@c135379`), then per selected profile a collapsible block listing its scanned groups (`listGroups`) with checkboxes (default all filtered groups checked), counts "x/y nhóm", "Quét lại nhóm" button (starts a `scan_groups` run for that profile), and a textarea "Thêm link nhóm" for extra URLs; when mode = Page: note "Mỗi profile đăng lên Page mà nó đang đứng danh tính. Kiểm tra tên danh tính trong nhật ký." and no group lists; delay min/max (seconds) and concurrency (1–10) inputs; "Bắt đầu đăng" primary button → `start('post', params)`; disabled with reason when `busy`, no profile, empty text, or group mode with zero targets. Show IPC `error` via `showNotification(…, 'error')`.
- [ ] **Step 6: `DESIGN.md`**: add section "Màn hình Đăng Facebook" (≤ 15 lines): layout (tabs + run panel, breakpoint 1024 px), log level → color tokens mapping, state chips reuse, no new tokens.
- [ ] **Step 7:** `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit` → exit 0; `npm run build:renderer` → exit 0; `npx jest` → PASS.
- [ ] **Step 8: Commit** `feat(facebook-poster): add screen shell, run panel and post tab`.

---

### Task 12: UI — Join, Comments, History tabs

**Files:**
- Create: `src/ui/features/facebookPoster/JoinTab.tsx`, `CommentsTab.tsx`, `HistoryTab.tsx`
- Modify: `src/ui/features/facebookPoster/FacebookPosterView.tsx`

- [ ] **Step 1: `JoinTab`**: `ProfilePicker` single; textarea "Từ khóa (mỗi dòng một từ)"; "Giới hạn nhóm" (1–200, default 10); delay min/max (default 60–180); warning text "Xin vào nhiều nhóm liên tục dễ bị Facebook hạn chế tài khoản."; "Bắt đầu" → `start('join', …)`.
- [ ] **Step 2: `CommentsTab`**: top: `ProfilePicker` single + list from `listPostedUrls()` with checkboxes (profile name, target, time, link opens externally via `window.open`), "Thu bình luận" → `start('collect_comments', …)`. Bottom: table of `listComments` (author linked to `authorUrl`, text with line breaks preserved, post link, collected time), search box filtering client-side on the loaded page, paging 100 per page, filter by post.
- [ ] **Step 3: `HistoryTab`**: table of `listRuns` (time, kind label in Vietnamese, mode, status chip, counts by outcome computed from `getRun` lazily on expand), paging 50; expanding a run shows its results grouped by profile (target link, outcome chip, error, post link, comment status label, identity); button "Xuất CSV" → `exportRunCsv`. Refresh the list on `facebookPoster:runFinished`.
- [ ] **Step 4:** Wire tabs into `FacebookPosterView`. Status/outcome labels in Vietnamese: `posted` Đã đăng, `failed` Lỗi, `skipped` Bỏ qua, `joined` Đã vào, `pending` Chờ duyệt, `unknown` Không rõ, `done` Xong; comment status: `not_requested` —, `posted` Đã bình luận, `no_post_url` Không có link bài, `pending_approval` Bài chờ duyệt, `post_not_found` Không thấy bài, `failed` Lỗi bình luận.
- [ ] **Step 5:** Renderer tsc → exit 0; `npm run build:renderer` → exit 0; `npx jest` → PASS.
- [ ] **Step 6: Commit** `feat(facebook-poster): add join, comments and history tabs`.

---

### Task 13: Dry-run script, packaged-build check, docs, final verification

**Files:**
- Create: `scripts/dev/facebook-poster-dry-run.js`
- Modify: `plan.md` (record results), `docs/specs/2026-10-03-facebook-poster.md` (status line only, if approved)

- [ ] **Step 1: Dry-run script** (plain Node, run after `npm run build:electron`): args `--profile-dir <dir> --engine <chrome path> --group-url <url>`; imports `dist-electron/src/services/browser/automationLauncher.js` and `dist-electron/src/services/browser/fingerprint.js`; launches with `['--remote-debugging-pipe', ...buildLaunchArgs({ userDataDir, fingerprint: {seed:123456, hardwareConcurrency:8, language:'vi-VN', timezone:'Asia/Ho_Chi_Minh'}, persona: hostPersona(process.platform), proxyPort: null })]`; prints (a) the browser command-line flags (`ps`/`wmic`), (b) listening TCP ports of the browser pid (Linux `ss -ltnp`), (c) `navigator.webdriver`; then opens `--group-url`, runs the compiled `markComposerInviteInPage` + locator click, waits for the composer, types `thử khô, không đăng`, checks `isPublishDisabledInPage` is false, and **closes without clicking Publish**. Exit code 0 only if: no `--remote-debugging-port` flag, no listening port, webdriver false, publish enabled after typing.
- [ ] **Step 2:** Run it against a throwaway profile dir and a public group URL in **logged-out** state: expected flags/port/webdriver checks pass; composer step reports "not logged in" and the script exits 2 — record the output in `plan.md` § Verification log.
- [ ] **Step 3: Packaged build (Linux):** `npm run production` (or, if the E2EE bridge build fails for unrelated toolchain reasons, `npm run build:electron && node scripts/strip-console.js && npm run build:renderer && npx electron-builder --linux AppImage --publish never`). Then `npx asar list dist-electron-build/linux-unpacked/resources/app.asar | grep -c playwright-core` (path per `build.directories.output` in `package.json`) and confirm `resources/app.asar.unpacked/node_modules/playwright-core` exists. Also confirm `strip-console` left the in-page functions intact: `grep -c "data-maihub-target" dist-electron/src/services/facebookPoster/postToTargets.js` ≥ 2.
- [ ] **Step 4: Whole-suite verification:** `npx jest`, both tsc, `npm run build:electron`, `npm run build:renderer` — all pass. Record counts in `plan.md`.
- [ ] **Step 5: UI checks, two rounds** (desktop 1440×900 and mobile 375×812, light and dark each round): launch the built app (`npx electron dist-electron/electron/main.js`, or `npm run dev`), open "Đăng Facebook", go through all four tabs and the run panel; assert no page-level horizontal overflow (`document.documentElement.scrollWidth <= clientWidth`), no overlapping text, keyboard tab navigation works, empty states render. Save screenshots outside the repo; list what was checked in `plan.md`.
- [ ] **Step 6: Regression checks** (record evidence in `plan.md`): Browser Profiles open/close by hand, the 30 limit message, close-all on quit, workspace switch; Chat and CRM screens load; proxy assignment for a Zalo account screen loads.
- [ ] **Step 7: Commit** `chore(facebook-poster): add dry-run script and record verification`.
- [ ] **Step 8 (owner only, needs explicit permission):** real-account checks from spec §11 items 1–6 on a test group chosen by the owner. Not part of automated execution.

---

## Execution order and dependencies

```
1 ──► 2 ──► 3 ──► 4
            │
            ├──► 5
            ├──► 6
            └──► 7
4,5,6,7 ──► 8 ──► 9 ──► 10 ──► 11 ──► 12 ──► 13
```
Tasks run strictly in numeric order (one implementer at a time). Task 8 only needs Task 7's `CollectedComment`/`keyOf`.

## Impact analysis — what can break

| Area | How it could break | Guard |
|---|---|---|
| Browser Profiles manual open/close | `prepareOpen` refactor changes a message or order of checks | Existing `BrowserProfileService.test.ts` must stay green unchanged; messages byte-identical |
| Quit / workspace switch | `closeAll` now also closes automation contexts; an exception there could block quit | `closeAutomation` never throws; `cancelFacebookPosterJobs` wrapped in try/catch in workspace IPC |
| App start time / memory | Eager `playwright-core` import | Lazy `require` in `BrowserProfileService`; IPC imports the service module only |
| DB schema on every workspace | New `CREATE TABLE IF NOT EXISTS` statements | Idempotent; tested with `ensureSchema` twice |
| Deleting a browser profile | New `DELETE FROM fb_poster_groups` | Runs after existing delete; table always exists (schema runs at DB open) |
| Production build | `strip-console.js` corrupting in-page functions; `playwright-core` missing from asar | Global constraint (no console in in-page functions); Task 13 Step 3 checks both |
| Preload allow-list | Typo in channel names → UI never updates | Channel names are constants in the `emit` type of `FacebookPosterServiceDeps`; UI test in Task 13 Step 5 sees live progress |
| Facebook accounts | Trusted-click change alters measured behaviour | Unit tests assert the right element is marked; Task 13 dry-run on a real page; owner-only real post in Step 8 |

## Highest-risk step

**Task 4, Step 4 (porting `post.js` with trusted clicks)**, followed closely by Task 1's lifecycle changes. `post.js` encodes months of measured Facebook behaviour (dialog vs `/post/create`, disabled Publish button, interstitials, evidence rules). A subtle port mistake will not show in unit tests that fake the page and will silently stop real posting. Mitigations: port line by line with the source open, keep every measurement comment, port all 29 tests unchanged in meaning, review the diff side by side with `c135379:src/post.js`, and run the Task 13 dry-run on a real group page.

## Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Remote-debugging **port** on 127.0.0.1 + `connectOverCDP` | No authentication: any local program could drive a logged-in Facebook browser; also contradicts the Browser Profiles spec. The pipe gives the same control with no port (spike 03/10/2026). |
| Browser **extension** inside the profile | Full rewrite of the automation; extensions are themselves a fingerprint; no benefit over the pipe. |
| Keep Playwright's default launch args (only drop `--enable-automation`) | Adds 38 switches (`--disable-extensions`, `--disable-features=…`, …) that make the automated browser differ from the manually opened one. |
| **Patchright** instead of Playwright | Not needed: BrowserScan reports CDP "Normal" with plain Playwright over the pipe; Patchright evaluates in isolated worlds, which changes semantics FB Poster relies on. Kept as fallback. |
| Keep FB Poster as a separate HTTP service and call it from MaiHub | Two products to ship and patch; no fingerprint or per-profile proxy; contradicts the intent to retire FB Poster. |
| Rewrite posting over Facebook GraphQL (like MaiHub's Messenger code) | Unmeasured, brittle `doc_id`s, and posting from cookies without a browser is easier to flag; the browser path is already proven. |
| Put SQL directly in `DatabaseService` | `DatabaseService` imports `electron`, so it cannot run in jest; a separate store over the existing query helpers is testable and keeps the 400 KB file from growing much. |
| Different content per profile / spin syntax | Out of scope by owner decision (same content). |
| Attach automation to a manually opened profile | Only possible with a debugging port; rejected with the port. |

## Verification log

Date of all entries: 03/10/2026, Linux (Ubuntu 24.04, X11 :1), base commit 18ba9ad (feat(facebook-poster): add join, comments and history tabs); the Task 13 script is added in 66ed32a and hardened in the fix commit that follows it. Scratch/screenshots outside the repo in `/tmp/claude-1000/dryrun/`.

**Step 1-2: dry-run (logged-out throwaway profile, public group 783713308689243)**
- `npm run build:electron` -> exit 0. `node scripts/dev/facebook-poster-dry-run.js --profile-dir /tmp/claude-1000/dryrun/profile --engine <148.0.7778.215 chrome> --group-url https://www.facebook.com/groups/783713308689243/` -> **exit 2**, as expected.
- PASS main browser process found (flags: `--remote-debugging-pipe --user-data-dir=... --fingerprint=123456 --fingerprint-platform=linux --fingerprint-brand=Chrome --fingerprint-hardware-concurrency=8 --lang=vi-VN --accept-lang=vi-VN,vi --timezone=Asia/Ho_Chi_Minh --no-first-run --no-default-browser-check`); PASS no `--remote-debugging-port`; PASS `--remote-debugging-pipe` present; PASS no listening TCP port (`ss -ltnpH` over all 9 browser processes: none); PASS `navigator.webdriver === false`; then "NOT LOGGED IN: composer step skipped", exit 2. No Publish click, nothing posted. Leftover check: `ps -eo pid,args | grep -F -- "--user-data-dir=/tmp/claude-1000/dryrun/profile3" | grep -v grep` after exit -> no lines (grep exit 1).
- Re-run against the production-built (strip-console) `dist-electron`: identical result, exit 2.
- Fix round 1 (fail closed): the script now also requires `ss` to run (check "ss available"), requires a Publish-labelled button to exist (read-only in-page check, never marked or clicked) before "Publish enabled" can pass, resolves `--profile-dir`, matches `--user-data-dir=<dir>` as a whole argument, and launches inside the try. Re-run on profile3: same flags, PASS x6 incl. "ss available", NOT LOGGED IN, exit 2.
- NOT VERIFIED here: the composer-open / type / "Publish enabled" half of the script (needs a logged-in profile; owner-only, see Step 8).

**Step 3: packaged build**
- `npm run production` -> exit 0 (2m38s; E2EE bridge build and native rebuild worked, no fallback needed). Produced `dist-electron-build/MaiHub-26.9.0.AppImage`, `maihub_26.9.0_amd64.deb`, `linux-unpacked/`.
- `npx asar list dist-electron-build/linux-unpacked/resources/app.asar | grep -c playwright-core` -> 131. `resources/app.asar.unpacked/node_modules/playwright-core` exists (bin, browsers.json, cli.js, index.js, ...).
- `grep -c "data-maihub-target" dist-electron/src/services/facebookPoster/postToTargets.js` -> 7 (>= 2); same count (7) in the file extracted from app.asar; `grep -c "console\."` on it -> 0. In-page functions intact after strip-console.
- Side effect to note: `npm run production` runs `rebuild:native`, which rebuilds `node_modules/better-sqlite3` for the Electron ABI (NODE_MODULE_VERSION 145); plain `npx jest` then failed 48 tests ("compiled against a different Node.js version"). Restored with `npm rebuild better-sqlite3`; not a feature defect.

**Step 4: whole-suite (after restoring better-sqlite3)**
- `npx jest` -> 20 suites, 439 tests passed, 0 failed.
- `npx tsc -p tsconfig.electron.json --noEmit` -> exit 0. `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit` -> exit 0.
- `npm run build:electron` -> exit 0. `npm run build:renderer` -> exit 0 (vite, chunk-size warning only).

**Step 5: UI checks (packaged `linux-unpacked/maihub`, isolated `XDG_CONFIG_HOME=/tmp/claude-1000/dryrun/xdg`, driven by playwright-core `connectOverCDP` on the app's own DevTools port)**
- Playwright `_electron.launch` could not be used: the app exits when Playwright's `--inspect` is injected; the main process already opens `remote-debugging-port=0`, so the running window was driven over CDP instead. Note `ELECTRON_RUN_AS_NODE=1` is set in this shell and must be unset to run the app.
- Reached the main UI directly (no lock/onboarding gate; empty account list). Opened "Đăng Facebook" from the sidebar.
- Two rounds x {1440x900, 375x812} x {light, dark} (`page.setViewportSize`, theme via `localStorage.app_theme` + reload), each visiting all 4 tabs (Đăng bài, Tham gia nhóm, Bình luận, Lịch sử) plus the run panel ("Tiến độ"): 8 combinations, 32 tab views, 41 screenshots.
- Result for every view: `documentElement.scrollWidth <= clientWidth` true; 0 overlapping text pairs; 0 elements sticking out right (excluding the intentionally scrollable tablist); `data-theme` matched (light bg rgb(242,242,247), dark rgb(21,21,22)); 0 page errors / console errors.
- Keyboard: ArrowRight on the focused tab moves selection to "Tham gia nhóm" (8/8); Tab then moves focus into the tab panel (8/8).
- Empty states render: "Chưa có profile. Tạo profile ở màn hình Trình duyệt." + button, "Chưa có bài nào có link để thu bình luận.", "Chưa có lịch sử.", "Chưa có việc nào đang chạy.".
- Visual read of screenshots r2-mobile-dark-tab1 and r2-desktop-light-tab4: fine. At 375 px the 4th tab is clipped inside the horizontally scrollable tablist (by design).
- NOT VERIFIED: live progress events on the run panel (no profile logged in to Facebook, nothing is run).
- Screenshots: `/tmp/claude-1000/dryrun/ui/r{1,2}-{desktop,mobile}-{light,dark}-{tab1..tab4,runpanel}.png`, report `/tmp/claude-1000/dryrun/ui/ui-report.json`.

**Step 6: regression**
- Verified in the packaged app: Tổng quan, Chat, CRM, Báo cáo, Quản lý công việc, Trình duyệt, Cài đặt all load, no horizontal scroll, 0 console errors.
- Browser Profiles by hand (real engine linked into the isolated profile dir): created "reg-test", **Mở** -> 1 browser process, UI "1/30 đang mở", flags have no `--remote-debugging-port` and no `--remote-debugging-pipe`; **Đóng** -> 0 processes within 1.5 s, "0/30 đang mở", status "Đã dừng". Quit (SIGTERM to the app PID) with a profile open -> 0 browser processes afterwards and the app exited (close-all on quit).
- 30 limit message and workspace switch: NOT VERIFIED in the UI (would need 30 real browsers / a second workspace); covered by the unchanged `BrowserProfileService.test.ts` passing in the 439.
- Proxy assignment screen for a Zalo account: NOT VERIFIED (no Zalo account in the isolated environment).

**Step 8 (real-account checks, spec section 11 items 1-6):** PENDING, owner only; not performed.

### Final fix wave (whole-branch review, 03/10/2026)

- Facebook-only URLs (`parseFacebookUrl`, https and `facebook.com`/`*.facebook.com` only) in `normalizeTarget`, group targets and `collect_comments`; CSV formula-injection neutralised in `runCsv.ts`; workspace switch awaits `cancelAndWaitFacebookPosterJobs()`; `listPostedUrls` joins `fb_poster_runs`; run panel syncs a finished fast run via `getRun`, tabs call `current()` after `start()`; stale `comment-send` mark cleared before searching; exact not-logged-in message and separate Publish click-failure log; UI IPC errors caught; spec §5 `skipped` note.
- `npx jest` -> 21 suites, 450 tests passed. `npx tsc -p tsconfig.electron.json --noEmit` -> exit 0. `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.json --noEmit` -> exit 0. `npm run build:electron` -> exit 0. `npm run build:renderer` -> exit 0.
