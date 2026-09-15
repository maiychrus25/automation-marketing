# macOS Workbench Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved macOS Workbench design to the shared Electron shell and ship a functional Dashboard demo without changing account, workspace, navigation, or permission behavior.

**Architecture:** Add semantic CSS variables and a small set of reusable presentation classes in the existing global stylesheet. Keep the current React component boundaries and Zustand data flow; derive Dashboard summary values in one pure helper, then restyle the existing shell and Dashboard around those values.

**Tech Stack:** Electron 41, React 18, TypeScript 5.7, Tailwind CSS 3.4, Zustand 5, Jest 29 with ts-jest.

**Spec:** `DESIGN.md`

## Global Constraints

- The visual direction is `macOS Workbench` and macOS desktop is the primary platform.
- Preserve all navigation, RBAC, workspace, account, reconnect, drag/reorder, modal, and menu behavior.
- Use the installed framework and existing SVG icon set; add no dependency.
- Use English-only source identifiers and test names.
- Keep light and dark mode structurally identical and free of page-level horizontal overflow.
- Interactive targets are at least 44×44px where layout permits, with visible keyboard focus.
- Respect `prefers-reduced-motion`.
- Do not push, deploy, migrate data, or change production configuration.

---

### Task 1: Dashboard summary contract

**Files:**
- Create: `src/ui/components/dashboard/dashboardSummary.ts`
- Create: `src/__tests__/dashboardSummary.test.ts`

**Interfaces:**
- Consumes: account state fields `isOnline`, `isConnected`, and `listenerActive`; workspace type `local | remote`; employee mode boolean.
- Produces: `getDashboardSummary(accounts, workspaceType, employeeMode): DashboardSummary` with `total`, `online`, `attention`, and `workspaceLabel`.

- [ ] **Step 1: Write the failing behavior test**

```typescript
import { getDashboardSummary } from '../ui/components/dashboard/dashboardSummary';

describe('getDashboardSummary', () => {
  test('counts online and attention accounts without overlapping connection states', () => {
    const summary = getDashboardSummary([
      { isOnline: true, isConnected: true, listenerActive: true },
      { isOnline: false, isConnected: true, listenerActive: true },
      { isOnline: false, isConnected: true, listenerActive: false },
      { isOnline: false, isConnected: false },
    ], 'local', false);

    expect(summary).toEqual({
      total: 4,
      online: 1,
      attention: 2,
      workspaceLabel: 'Cục bộ',
    });
  });

  test('labels employee workspaces from either persisted or active mode', () => {
    expect(getDashboardSummary([], 'remote', false).workspaceLabel).toBe('Nhân viên');
    expect(getDashboardSummary([], 'local', true).workspaceLabel).toBe('Nhân viên');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx jest src/__tests__/dashboardSummary.test.ts --runInBand`

Expected: FAIL because `dashboardSummary.ts` does not exist.

- [ ] **Step 3: Implement the smallest pure helper**

```typescript
export interface DashboardAccountState {
  isOnline?: boolean;
  isConnected?: boolean;
  listenerActive?: boolean;
}

export interface DashboardSummary {
  total: number;
  online: number;
  attention: number;
  workspaceLabel: 'Cục bộ' | 'Nhân viên';
}

export function getDashboardSummary(
  accounts: DashboardAccountState[],
  workspaceType?: 'local' | 'remote',
  employeeMode = false,
): DashboardSummary {
  return {
    total: accounts.length,
    online: accounts.filter((account) => account.isOnline && account.listenerActive !== false).length,
    attention: accounts.filter((account) => !account.isConnected || account.listenerActive === false).length,
    workspaceLabel: workspaceType === 'remote' || employeeMode ? 'Nhân viên' : 'Cục bộ',
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx jest src/__tests__/dashboardSummary.test.ts --runInBand`

Expected: 2 tests pass, 0 failures.

---

### Task 2: Shared macOS Workbench material layer

**Files:**
- Modify: `src/ui/index.css`
- Modify: `src/ui/App.tsx:1395-1427`
- Modify: `src/ui/components/layout/TopBar.tsx:361-781`
- Modify: `src/ui/components/layout/Sidebar.tsx:97-416`

**Interfaces:**
- Consumes: existing `data-theme`, Electron `WebkitAppRegion`, `view`, `sidebarExpanded`, and existing navigation callbacks.
- Produces: semantic classes `app-shell`, `mac-titlebar`, `mac-sidebar`, `mac-content-canvas`, `mac-surface`, `mac-control`, `mac-button-primary`, `mac-button-secondary`, and `mac-focus-ring`.

- [ ] **Step 1: Add dark defaults and light overrides to the existing CSS variable blocks**

Add these semantic variables to `:root`, with matching values from `DESIGN.md`:

```css
--app-canvas: #111318;
--app-sidebar: rgba(25, 28, 35, 0.9);
--app-surface: #1c1f26;
--app-surface-raised: #252a33;
--app-surface-muted: #171a20;
--app-border: rgba(255, 255, 255, 0.09);
--app-border-strong: rgba(255, 255, 255, 0.15);
--app-text: #f5f5f7;
--app-text-secondary: #b4bac4;
--app-text-tertiary: #8a929e;
--app-accent: #2563eb;
--app-focus: #0a84ff;
--app-radius-control: 0.625rem;
--app-radius-card: 0.875rem;
--app-radius-panel: 1.125rem;
--app-motion-fast: 160ms;
--app-motion-standard: 220ms;
--app-easing: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Set the light equivalents under `html[data-theme="light"]` using the exact `DESIGN.md` tokens.

- [ ] **Step 2: Add reusable material and interaction classes**

```css
.app-shell { background: var(--app-canvas); color: var(--app-text); }
.mac-titlebar { min-height: 3.25rem; background: var(--app-sidebar); border-color: var(--app-border); backdrop-filter: blur(24px) saturate(1.2); }
.mac-sidebar { width: 4.5rem; background: var(--app-sidebar); border-color: var(--app-border); backdrop-filter: blur(24px) saturate(1.2); }
.mac-content-canvas { min-width: 0; background: var(--app-canvas); }
.mac-surface { background: var(--app-surface); border: 1px solid var(--app-border); border-radius: var(--app-radius-card); }
.mac-control { background: var(--app-surface-muted); border: 1px solid var(--app-border); border-radius: var(--app-radius-control); color: var(--app-text); }
.mac-focus-ring:focus-visible { outline: 2px solid var(--app-focus); outline-offset: 2px; }
```

Include reduced-motion rules that remove non-essential animation and transitions for `.app-shell` descendants.

- [ ] **Step 3: Apply shell classes without changing component state or event handlers**

- Change the two root shell containers in `App.tsx` from hard-coded `bg-gray-900` to `app-shell`.
- Add `mac-content-canvas` to the main content wrapper.
- Change only the root titlebar classes to `mac-titlebar` while retaining the drag region and platform padding.
- Change only the root sidebar width/material classes to `mac-sidebar`; retain every existing account and navigation branch.
- Add `mac-focus-ring` and accessible labels to icon-only shell controls touched by the class edit.

- [ ] **Step 4: Verify compilation after the shared shell slice**

Run: `npx tsc -p tsconfig.electron.json --noEmit && npx tsc -p tsconfig.json --noEmit`

Expected: both TypeScript checks exit 0.

---

### Task 3: Dashboard and account-card demo

**Files:**
- Modify: `src/ui/components/dashboard/Dashboard.tsx`
- Modify: `src/ui/components/dashboard/AccountCard.tsx`
- Use: `src/ui/components/dashboard/dashboardSummary.ts`

**Interfaces:**
- Consumes: existing `accounts`, `activeWs`, employee mode, search state, merge mode, reconnect handlers, navigation events, and account card callbacks.
- Produces: the approved header, four summary cards, action toolbar, responsive account grid, and macOS surface styling while preserving all existing actions.

- [ ] **Step 1: Derive summary data in Dashboard without new API calls**

```typescript
const summary = getDashboardSummary(accounts, activeWs?.type, empMode === 'employee');
```

Render summary items for total accounts, online accounts, accounts needing attention, and `workspaceLabel`. Each item must pair its color with a text label.

- [ ] **Step 2: Restructure only the Dashboard presentation**

- Wrap content in `mac-dashboard` with a centered `max-width: 1440px` inner container.
- Move the primary add-account action into the page header.
- Keep merge-account and workspace actions in a wrapping toolbar with the search input.
- Preserve simulation badge, employee-login action, bug-report navigation, modal rendering, search filtering, drag handlers, and `AccountCard` props.
- Use a one-column empty/search state and a responsive grid with `minmax(min(100%, 280px), 1fr)`.

- [ ] **Step 3: Restyle AccountCard without changing its handlers**

- Apply `mac-surface` to the card root.
- Keep avatar, channel badge, status, ID/phone, menu, chat, reconnect, disconnect, update, and delete behavior intact.
- Remove hover scaling; use border, background and shadow changes only.
- Add `aria-label="Tùy chọn tài khoản"` to the icon-only menu button and `mac-focus-ring` to touched buttons.

- [ ] **Step 4: Run focused and build verification**

Run: `npx jest src/__tests__/dashboardSummary.test.ts --runInBand`

Expected: 2 tests pass.

Run: `npx tsc -p tsconfig.electron.json --noEmit && npx tsc -p tsconfig.json --noEmit && npm run build:renderer`

Expected: all commands exit 0 and Vite produces `dist/`.

---

### Task 4: Visual stress tests, regression review, and commit

**Files:**
- Review only: every file listed in Tasks 1–3

**Interfaces:**
- Consumes: built renderer and the current Electron/Vite development harness.
- Produces: visual evidence for desktop/mobile and light/dark plus a scoped Conventional Commit.

- [ ] **Step 1: Stress-test round 1**

Run the renderer and inspect the Dashboard at 1440×900 and 375×812 in light mode. Verify:

- no page-level horizontal overflow;
- no text overlap or clipped primary action;
- navigation, add account, merge account, workspace navigation, search, account menu, reconnect, and drag state remain present;
- keyboard focus is visible;
- titlebar drag/no-drag regions remain assigned.

- [ ] **Step 2: Stress-test round 2**

Repeat at 1280×800 and 390×844 in dark mode. Verify the same behaviors plus readable surface separation and reduced-motion CSS presence.

- [ ] **Step 3: Review the actual diff and regression surface**

Run: `git diff --check && git diff --stat && git diff -- src/ui/index.css src/ui/App.tsx src/ui/components/layout/TopBar.tsx src/ui/components/layout/Sidebar.tsx src/ui/components/dashboard/Dashboard.tsx src/ui/components/dashboard/AccountCard.tsx src/ui/components/dashboard/dashboardSummary.ts src/__tests__/dashboardSummary.test.ts`

Confirm no service, database, IPC, RBAC, route, or production file changed.

- [ ] **Step 4: Commit only named files**

```bash
git add docs/superpowers/plans/2026-09-15-macos-workbench-dashboard.md src/ui/index.css src/ui/App.tsx src/ui/components/layout/TopBar.tsx src/ui/components/layout/Sidebar.tsx src/ui/components/dashboard/Dashboard.tsx src/ui/components/dashboard/AccountCard.tsx src/ui/components/dashboard/dashboardSummary.ts src/__tests__/dashboardSummary.test.ts
git -c user.name=maiychrus25 -c user.email=ninhkhuongpl7@gmail.com commit -m "feat(ui): add macOS dashboard demo"
```

Verify the commit body has no attribution trailer and do not push.
