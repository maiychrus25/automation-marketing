# Facebook Page Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi Page mà tài khoản Facebook cá nhân quản trị được bật thành tài khoản con trong MaiHub, có hộp thư riêng (đọc, nhận thời gian thực, trả lời văn bản và ảnh) qua phiên cá nhân + cookie `i_user`.

**Architecture:** Page là một dòng `fb_accounts` + một dòng `accounts` với `facebook_id` = id profile Page, nối cha bằng `parent_facebook_id`. Cookie Page không lưu, dựng lúc chạy từ cookie cha (`buildPageCookie`). Mỗi Page có `FacebookService`, phiên và MQTT listener riêng; Page không chạy E2EE bridge và gửi mọi tin qua REST. Renderer coi Page là tài khoản Facebook thường, chỉ thêm sắp xếp cây ở Sidebar và bảng bật/tắt Page.

**Tech Stack:** Electron + TypeScript, better-sqlite3 (`DatabaseService`), axios, React + zustand + Tailwind, jest (ts-jest, transpile-only).

**Spec:** `docs/specs/2026-10-03-facebook-page-inbox.md` (đã duyệt 05/10/2026). Intent: `docs/intent/2026-10-03-facebook-page-inbox.md`. Bằng chứng: `docs/reports/2026-10-03-facebook-page-inbox-spike.md`. Bản này thay bản kế hoạch bàn giao cùng tên; Git giữ lịch sử.

## Global Constraints

- Hướng A: giao thức không chính thức qua phiên cá nhân. KHÔNG dùng Graph API, Page Access Token, app Facebook Developers, webhook.
- Không đổi hành vi Messenger cá nhân đang chạy. Mọi thay đổi ở đường chung phải giữ nguyên kết quả với tài khoản có `parent_facebook_id` rỗng.
- Định danh code, cột DB, kênh IPC, trường request/response: tiếng Anh. Chữ hiển thị cho người dùng và comment: tiếng Việt, như code xung quanh.
- Cột mới trên `fb_accounts`: `parent_facebook_id TEXT NULL`, `delegate_page_id TEXT NULL`, `enabled INTEGER NOT NULL DEFAULT 1`. Không thêm `page_profile_id`.
- Kênh IPC mới: `fb:listPages`, `fb:setPageEnabled`. Trường mới trong `login:getAccounts` và `AccountInfo`: `parent_zalo_id`.
- Cookie Page không gọi `secureSet`, `cookie_encrypted = ''`.
- UI theo `DESIGN.md`: dùng lại lớp `.app-account`, không mã hex trong component mới, công tắc có `role="switch"` + `aria-checked` + `aria-label`, focus `focus-visible:ring-[3px] focus-visible:ring-blue-500/35`.
- Máy dev 16 GB: chạy lệnh nặng từng lệnh một, bọc `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 <cmd>` (renderer tsc: `MemoryMax=6G` + `NODE_OPTIONS=--max-old-space-size=4096`).
- Repo không có `Makefile`. Lệnh kiểm chứng: `npx jest <path>`, `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`, `npx vite build`.
- Mốc test: `npx jest` trên `main` có sẵn 51 test lỗi trong 2 suite `src/__tests__/facebookPoster/FacebookPosterStore.test.ts` và `FacebookPosterService.test.ts` do `better-sqlite3` build cho ABI Electron (145) còn jest chạy Node (137). Không sửa, không xóa; tiêu chí là không thêm lỗi mới ngoài 2 suite này. Hai lệnh `tsc` đều sạch trên `main`.
- `git add` từng file theo tên. Không `git add -A` / `git add .` (worktree có symlink `node_modules`).
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Người dùng dán cookie đã có `i_user` khi thêm tài khoản cá nhân → phải thành tài khoản cá nhân, không thành "Page giả" và không xóa nhầm dòng Page. Test: `stripPageCookie` (Task 1) + bước gọi trong `_addFBAccountCommon` (Task 4).
2. Thêm lại tài khoản cá nhân làm đổi uuid của cha → Page con vẫn lấy được cookie cha qua `facebook_id`. Test: `pickFBCookie` tra cha bằng `facebook_id` (Task 1).
3. Tài khoản mất quyền quản trị một Page đang bật → Page vẫn hiện trong danh sách với `enabled: true` để tắt được. Test: `mergePageList` (Task 1).
4. HTML `bookmarks/pages` có tên Page chứa ngoặc nhọn, dấu nháy escape, khóa xuất hiện nhiều lần, đoạn JSON hỏng → parser không ném, không trùng. Test: `parseManagedPages` (Task 1).
5. Tin do chính Page gửi về qua MQTT mang id Page cổ điển (`delegate_page_id`) → vẫn là `isSelf`. Test: `isOwnSender` (Task 1). Sidebar với Page mồ côi, quan hệ vòng → không mất dòng nào. Test: `orderAccountsWithChildren` (Task 5).

---

### Task 1: Hàm thuần cho Page (`FacebookPages.ts`)

**Files:**
- Create: `src/services/facebook/FacebookPages.ts`
- Test: `src/__tests__/facebook/FacebookPages.test.ts`

**Interfaces:**
- Consumes: `fbHeaders(cookie)` từ `src/services/facebook/FacebookSession.ts`.
- Produces (các task sau dùng đúng tên này):
  - `interface ManagedPage { profileId: string; name: string; delegatePageId: string | null; avatarUrl: string | null }`
  - `type PageListItem = ManagedPage & { enabled: boolean }`
  - `interface FBAccountCookieRow { id: string; facebook_id: string; cookie_encrypted?: string | null; parent_facebook_id?: string | null }`
  - `interface PageChildRow { facebook_id: string; name?: string | null; avatar_url?: string | null; delegate_page_id?: string | null; enabled?: number | null }`
  - `stripPageCookie(cookie: string): string`
  - `buildPageCookie(cookie: string, profileId: string): string`
  - `parseManagedPages(html: string): ManagedPage[]`
  - `fetchManagedPages(cookie: string, httpsAgent?: any): Promise<ManagedPage[]>`
  - `mergePageList(remote: ManagedPage[], children: PageChildRow[]): PageListItem[]`
  - `pickFBCookie(account, findByFacebookId, readStoredCookie): string | null`
  - `isOwnSender(userId: string | undefined | null, facebookId: string | undefined | null, delegatePageId?: string | null): boolean`

- [ ] **Step 1: Write the failing test**

Tạo `src/__tests__/facebook/FacebookPages.test.ts`:

```ts
import {
  stripPageCookie, buildPageCookie, parseManagedPages, mergePageList, pickFBCookie, isOwnSender,
  FBAccountCookieRow, ManagedPage,
} from '../../services/facebook/FacebookPages';

const node = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, profile_picture: { uri: `https://cdn.example/${id}.jpg` }, unseen_message_count: 0, ...extra,
});

describe('stripPageCookie', () => {
  it('trả nguyên chuỗi khi không có i_user', () => {
    expect(stripPageCookie('c_user=100; xs=abc;')).toBe('c_user=100; xs=abc;');
  });
  it('bỏ mọi cặp i_user, giữ các cặp khác', () => {
    expect(stripPageCookie('c_user=100;i_user=615; xs=abc; i_user=999')).toBe('c_user=100; xs=abc');
  });
});

describe('buildPageCookie', () => {
  it('nối i_user vào cookie không có i_user', () => {
    expect(buildPageCookie('c_user=100; xs=abc', '61592412314280')).toBe('c_user=100; xs=abc; i_user=61592412314280');
  });
  it('thay i_user cũ, xử lý dấu ; cuối và khoảng trắng', () => {
    expect(buildPageCookie(' c_user=100 ; i_user=1;xs=abc; ', '61592412314280')).toBe('c_user=100; xs=abc; i_user=61592412314280');
  });
});

describe('parseManagedPages', () => {
  it('lấy Page từ nhiều chỗ xuất hiện khóa, khử trùng theo id, chịu được ngoặc và nháy trong tên', () => {
    const media = node('61592412314280', 'Media Soec', { delegate_page_id: '1254744041053955' });
    const ahv = node('61500000000001', 'AHV {Holding} "Careers"');
    const html = '<html><script type="application/json">'
      + `{"require":[["x",{"additional_profiles_with_biz_tools":{"edges":[{"node":${JSON.stringify(media)}},{"node":${JSON.stringify(ahv)}}]}}]]}`
      + '</script><script>'
      + `{"additional_profiles_with_biz_tools" : {"nodes":[${JSON.stringify(media)}]}}`
      + '</script></html>';
    expect(parseManagedPages(html)).toEqual<ManagedPage[]>([
      { profileId: '61592412314280', name: 'Media Soec', delegatePageId: '1254744041053955', avatarUrl: 'https://cdn.example/61592412314280.jpg' },
      { profileId: '61500000000001', name: 'AHV {Holding} "Careers"', delegatePageId: null, avatarUrl: 'https://cdn.example/61500000000001.jpg' },
    ]);
  });
  it('trả [] khi không có khóa', () => {
    expect(parseManagedPages('<html>không có gì</html>')).toEqual([]);
  });
  it('bỏ qua khóa không có dấu : theo sau', () => {
    expect(parseManagedPages('["additional_profiles_with_biz_tools",{"id":"1","name":"x"}]')).toEqual([]);
  });
  it('bỏ qua đoạn JSON hỏng nhưng vẫn đọc đoạn lành phía sau', () => {
    const html = '{"additional_profiles_with_biz_tools":{"edges":[{"node":{"id":"1","name":"x"]}}'
      + `<p>{"additional_profiles_with_biz_tools":{"nodes":[${JSON.stringify(node('615', 'Lành'))}]}}</p>`;
    expect(parseManagedPages(html).map((p) => p.profileId)).toEqual(['615']);
  });
  it('JSON bị cắt cụt thì trả []', () => {
    expect(parseManagedPages('{"additional_profiles_with_biz_tools":{"edges":[{"node":{"id":"1","name":"x"}')).toEqual([]);
  });
});

describe('mergePageList', () => {
  const remote: ManagedPage[] = [
    { profileId: '1', name: 'A', delegatePageId: null, avatarUrl: null },
    { profileId: '2', name: 'B', delegatePageId: 'd2', avatarUrl: 'u2' },
  ];
  it('đánh dấu enabled theo dòng con enabled = 1', () => {
    const out = mergePageList(remote, [{ facebook_id: '2', enabled: 1 }, { facebook_id: '1', enabled: 0 }]);
    expect(out.map((p) => [p.profileId, p.enabled])).toEqual([['1', false], ['2', true]]);
  });
  it('giữ Page đang bật đã mất quyền quản trị, lấy tên/ảnh từ DB', () => {
    const out = mergePageList(remote, [{ facebook_id: '9', name: 'Cũ', avatar_url: 'u9', delegate_page_id: 'd9', enabled: 1 }]);
    expect(out[2]).toEqual({ profileId: '9', name: 'Cũ', delegatePageId: 'd9', avatarUrl: 'u9', enabled: true });
  });
  it('không thêm Page đã tắt mà Facebook không còn trả', () => {
    expect(mergePageList(remote, [{ facebook_id: '9', enabled: 0 }])).toHaveLength(2);
  });
});

describe('pickFBCookie', () => {
  const parent: FBAccountCookieRow = { id: 'uuid-parent', facebook_id: '100', cookie_encrypted: 'c_user=100; xs=abc' };
  const page: FBAccountCookieRow = { id: 'uuid-page', facebook_id: '615', cookie_encrypted: '', parent_facebook_id: '100' };
  const read = (a: FBAccountCookieRow) => a.cookie_encrypted || null;
  const find = (rows: FBAccountCookieRow[]) => (fbId: string) => rows.find((r) => r.facebook_id === fbId);

  it('tài khoản cá nhân: đọc cookie đã lưu', () => {
    expect(pickFBCookie(parent, find([parent]), read)).toBe('c_user=100; xs=abc');
  });
  it('Page: dựng từ cookie cha tra bằng facebook_id (uuid cha đổi vẫn được)', () => {
    const reAdded = { ...parent, id: 'uuid-new' };
    expect(pickFBCookie(page, find([reAdded]), read)).toBe('c_user=100; xs=abc; i_user=615');
  });
  it('Page: không có cha hoặc cha không có cookie thì null', () => {
    expect(pickFBCookie(page, find([]), read)).toBeNull();
    expect(pickFBCookie(page, find([{ ...parent, cookie_encrypted: '' }]), read)).toBeNull();
  });
  it('Page: cha cũng là Page thì null', () => {
    expect(pickFBCookie(page, find([{ ...parent, parent_facebook_id: '1' }]), read)).toBeNull();
  });
});

describe('isOwnSender', () => {
  it('khớp FacebookID', () => expect(isOwnSender('615', '615', null)).toBe(true));
  it('khớp delegate_page_id', () => expect(isOwnSender('125', '615', '125')).toBe(true));
  it('không khớp', () => expect(isOwnSender('777', '615', '125')).toBe(false));
  it('userId rỗng không bao giờ là mình', () => {
    expect(isOwnSender('', '', '')).toBe(false);
    expect(isOwnSender(undefined, undefined, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/facebook/FacebookPages.test.ts`
Expected: FAIL, "Cannot find module '../../services/facebook/FacebookPages'".

- [ ] **Step 3: Write minimal implementation**

Tạo `src/services/facebook/FacebookPages.ts`:

```ts
/**
 * FacebookPages.ts
 * Page mà tài khoản cá nhân quản trị: liệt kê từ bookmarks/pages, dựng cookie vai Page (i_user).
 * Không import electron/DB để test được; phần đọc DB nằm ở FacebookAccountCookie.ts.
 */

import axios from 'axios';
import { fbHeaders } from './FacebookSession';

export interface ManagedPage {
  /** id profile Page thế hệ mới (dạng 6159…), cũng là facebook_id của dòng Page */
  profileId: string;
  name: string;
  /** id Page cổ điển */
  delegatePageId: string | null;
  avatarUrl: string | null;
}

export type PageListItem = ManagedPage & { enabled: boolean };

export interface FBAccountCookieRow {
  id: string;
  facebook_id: string;
  cookie_encrypted?: string | null;
  parent_facebook_id?: string | null;
}

export interface PageChildRow {
  facebook_id: string;
  name?: string | null;
  avatar_url?: string | null;
  delegate_page_id?: string | null;
  enabled?: number | null;
}

const BOOKMARKS_PAGES_URL = 'https://www.facebook.com/bookmarks/pages';
const PAGES_KEY = '"additional_profiles_with_biz_tools"';
const HAS_I_USER = /(^|;)\s*i_user=/i;

/** Các cặp cookie đã trim, bỏ cặp rỗng và mọi cặp i_user. */
function cookiePartsWithoutPage(cookie: string): string[] {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^i_user=/i.test(part));
}

/** Bỏ mọi cặp i_user khỏi cookie. Không có i_user thì trả nguyên chuỗi. */
export function stripPageCookie(cookie: string): string {
  return HAS_I_USER.test(cookie) ? cookiePartsWithoutPage(cookie).join('; ') : cookie;
}

/** Cookie vai Page = cookie cá nhân + i_user=<id profile Page> (spike §1.2). */
export function buildPageCookie(cookie: string, profileId: string): string {
  return [...cookiePartsWithoutPage(cookie), `i_user=${profileId}`].join('; ');
}

/** Cắt giá trị JSON object/array bắt đầu tại `start`, bỏ qua ngoặc nằm trong chuỗi. */
function sliceBalancedJson(text: string, start: number): string | null {
  if (text[start] !== '{' && text[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function collectPages(value: unknown, out: Map<string, ManagedPage>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPages(item, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, any>;
  if (typeof obj.id === 'string' && typeof obj.name === 'string') {
    if (!out.has(obj.id)) {
      out.set(obj.id, {
        profileId: obj.id,
        name: obj.name,
        delegatePageId: obj.delegate_page_id != null && obj.delegate_page_id !== '' ? String(obj.delegate_page_id) : null,
        avatarUrl: typeof obj.profile_picture?.uri === 'string' ? obj.profile_picture.uri : null,
      });
    }
    return;
  }
  Object.values(obj).forEach((item) => collectPages(item, out));
}

/** Đọc danh sách Page từ HTML bookmarks/pages (JSON additional_profiles_with_biz_tools). */
export function parseManagedPages(html: string): ManagedPage[] {
  const out = new Map<string, ManagedPage>();
  let from = 0;
  for (;;) {
    const at = html.indexOf(PAGES_KEY, from);
    if (at < 0) break;
    from = at + PAGES_KEY.length;
    const colon = /^\s*:\s*/.exec(html.slice(from, from + 16));
    if (!colon) continue;
    const raw = sliceBalancedJson(html, from + colon[0].length);
    if (!raw) continue;
    try {
      collectPages(JSON.parse(raw), out);
    } catch {
      // Đoạn JSON hỏng: bỏ qua, đọc tiếp chỗ khác
    }
  }
  return [...out.values()];
}

/** GET bookmarks/pages với vai tài khoản cá nhân. Header đầy đủ: header tối giản bị 400 (spike §1.1). */
export async function fetchManagedPages(cookie: string, httpsAgent?: any): Promise<ManagedPage[]> {
  try {
    const res = await axios.get(BOOKMARKS_PAGES_URL, {
      headers: fbHeaders(stripPageCookie(cookie)),
      timeout: 60000,
      responseType: 'text',
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    return parseManagedPages(String(res.data));
  } catch (err: any) {
    throw new Error(`Không tải được danh sách Page (HTTP ${err.response?.status ?? '?'}): ${err.message}`);
  }
}

/** Gộp Page từ Facebook với các dòng con trong DB; Page đang bật mà mất quyền vẫn hiện để tắt được. */
export function mergePageList(remote: ManagedPage[], children: PageChildRow[]): PageListItem[] {
  const enabledIds = new Set(children.filter((c) => c.enabled === 1).map((c) => c.facebook_id));
  const items: PageListItem[] = remote.map((page) => ({ ...page, enabled: enabledIds.has(page.profileId) }));
  const remoteIds = new Set(remote.map((page) => page.profileId));
  for (const child of children) {
    if (child.enabled !== 1 || remoteIds.has(child.facebook_id)) continue;
    items.push({
      profileId: child.facebook_id,
      name: child.name || child.facebook_id,
      delegatePageId: child.delegate_page_id || null,
      avatarUrl: child.avatar_url || null,
      enabled: true,
    });
  }
  return items;
}

/**
 * Chọn cookie cho một dòng fb_accounts. Cá nhân: cookie đã lưu.
 * Page: cookie của cha (tra theo facebook_id, vì thêm lại tài khoản cha đổi uuid) + i_user.
 */
export function pickFBCookie(
  account: FBAccountCookieRow,
  findByFacebookId: (facebookId: string) => FBAccountCookieRow | undefined,
  readStoredCookie: (account: FBAccountCookieRow) => string | null,
): string | null {
  if (!account.parent_facebook_id) return readStoredCookie(account);
  const parent = findByFacebookId(account.parent_facebook_id);
  if (!parent || parent.parent_facebook_id) return null;
  const parentCookie = readStoredCookie(parent);
  return parentCookie ? buildPageCookie(parentCookie, account.facebook_id) : null;
}

/** Người gửi là chính tài khoản: khớp FacebookID, hoặc id Page cổ điển với Page. */
export function isOwnSender(
  userId: string | undefined | null,
  facebookId: string | undefined | null,
  delegatePageId?: string | null,
): boolean {
  if (!userId) return false;
  return userId === facebookId || (!!delegatePageId && userId === delegatePageId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/facebook/FacebookPages.test.ts`
Expected: PASS, tất cả test trong file.

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0, không lỗi.

- [ ] **Step 5: Commit**

```bash
git add src/services/facebook/FacebookPages.ts src/__tests__/facebook/FacebookPages.test.ts
git commit -m "feat(facebook): parse managed Pages and build Page cookies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: DB cho Page + một chỗ đọc cookie/proxy

**Files:**
- Modify: `src/services/database/DatabaseService.ts` (migration ngay sau khối `// ── fb_messages.edit_history` khoảng dòng 2473-2482; hàm mới ngay sau `deleteFBAccount` khoảng dòng 7832-7837)
- Create: `src/services/facebook/FacebookAccountCookie.ts`
- Modify: `electron/ipc/facebookIpc.ts` (các chỗ đọc cookie: `getFBServiceOrReconnect` ~dòng 67, `fb:refreshProfile` ~319, `fb:refreshContactAvatar` ~358, `fb:getUserInfoFacebookHtml` ~388, `fb:connect` ~430-440, `reconnectAllFBAccounts` ~2014-2035)
- Modify: `src/services/facebook/FacebookService.ts:141-165` (`getInstance`)
- Modify: `src/services/facebook/FacebookScanService.ts:313-317` (`getCookie`)

**Interfaces:**
- Consumes: `pickFBCookie`, `FBAccountCookieRow` (Task 1).
- Produces:
  - `DatabaseService.getFBPageChildren(parentFacebookId: string): any[]` — mọi dòng con, kể cả đã tắt, theo `created_at`.
  - `DatabaseService.saveFBPageAccount(page: { id: string; facebook_id: string; name: string; avatar_url: string; parent_facebook_id: string; delegate_page_id: string | null; proxy_id: number | null }): void` — upsert `fb_accounts` (enabled = 1, cookie rỗng) + `accounts` (is_active = 1).
  - `DatabaseService.setFBPageEnabled(id: string, enabled: boolean): void` — chỉ tác dụng với dòng có `parent_facebook_id`.
  - `resolveFBCookie(account: FBAccountCookieRow): string | null`
  - `resolveFBProxyId(account: { id: string; facebook_id?: string | null; parent_facebook_id?: string | null }): number | null`

Hàm ở task này đọc DB/`safeStorage` nên không unit test được trong jest (module native build cho Electron). Logic rẽ nhánh đã được test qua `pickFBCookie` ở Task 1. Kiểm chứng task này bằng `tsc` + grep.

- [ ] **Step 1: Migration ba cột**

Trong `DatabaseService.ts`, ngay sau khối `// ── fb_messages.edit_history ...` (kết thúc bằng `Logger.warn(\`[DatabaseService] edit_history migration: ...\`)` và `}`), thêm:

```ts
        // ── fb_accounts: Page con (parent_facebook_id, delegate_page_id, enabled) ──
        try {
            const fbAccCols = this.query<any>(`PRAGMA table_info(fb_accounts)`);
            const hasCol = (name: string) => fbAccCols.some((c: any) => c.name === name);
            const added: string[] = [];
            if (!hasCol('parent_facebook_id')) { db!.exec(`ALTER TABLE fb_accounts ADD COLUMN parent_facebook_id TEXT DEFAULT NULL`); added.push('parent_facebook_id'); }
            if (!hasCol('delegate_page_id')) { db!.exec(`ALTER TABLE fb_accounts ADD COLUMN delegate_page_id TEXT DEFAULT NULL`); added.push('delegate_page_id'); }
            if (!hasCol('enabled')) { db!.exec(`ALTER TABLE fb_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`); added.push('enabled'); }
            if (added.length > 0) {
                this.save();
                Logger.log(`[DatabaseService] Migration: added ${added.join(', ')} to fb_accounts`);
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] fb_accounts Page columns migration: ${err.message}`);
        }
```

- [ ] **Step 2: Hàm đọc ghi Page**

Ngay sau `public deleteFBAccount(id: string): void { ... }`, thêm:

```ts
    /** Các Page con của một tài khoản cá nhân, kể cả Page đã tắt. */
    public getFBPageChildren(parentFacebookId: string): any[] {
        return this.query<any>(
            `SELECT * FROM fb_accounts WHERE parent_facebook_id = ? ORDER BY created_at ASC`,
            [parentFacebookId]
        );
    }

    /** Ghi dòng fb_accounts + accounts cho một Page đang bật. Cookie Page không lưu (dựng từ cookie cha lúc chạy). */
    public saveFBPageAccount(page: {
        id: string; facebook_id: string; name: string; avatar_url: string;
        parent_facebook_id: string; delegate_page_id: string | null; proxy_id: number | null;
    }): void {
        const now = Date.now();
        this.run(`
            INSERT INTO fb_accounts (id, facebook_id, name, avatar_url, cookie_encrypted, session_data, status, last_cookie_check,
                                     created_at, updated_at, parent_facebook_id, delegate_page_id, enabled)
            VALUES (?, ?, ?, ?, '', '', 'disconnected', 0, ?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, avatar_url = excluded.avatar_url,
              parent_facebook_id = excluded.parent_facebook_id, delegate_page_id = excluded.delegate_page_id,
              enabled = 1, updated_at = excluded.updated_at
        `, [page.id, page.facebook_id, page.name, page.avatar_url, now, now, page.parent_facebook_id, page.delegate_page_id]);
        this.run(
            `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, channel, proxy_id, created_at)
             VALUES (?, ?, ?, '', 0, '', '', '', 1, 'facebook', ?, datetime('now'))
             ON CONFLICT(zalo_id) DO UPDATE SET
               full_name = excluded.full_name, avatar_url = excluded.avatar_url,
               channel = 'facebook', is_active = 1, proxy_id = excluded.proxy_id`,
            [page.facebook_id, page.name, page.avatar_url, page.proxy_id]
        );
    }

    /** Bật/tắt Page: tắt thì giữ dữ liệu, ẩn khỏi danh sách tài khoản (getAccounts lọc is_active = 1). */
    public setFBPageEnabled(id: string, enabled: boolean): void {
        const acc = this.getFBAccount(id);
        if (!acc?.parent_facebook_id) return;
        this.run(`UPDATE fb_accounts SET enabled = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, Date.now(), id]);
        this.run(`UPDATE accounts SET is_active = ? WHERE zalo_id = ?`, [enabled ? 1 : 0, acc.facebook_id]);
    }
```

- [ ] **Step 3: `FacebookAccountCookie.ts`**

Tạo `src/services/facebook/FacebookAccountCookie.ts`:

```ts
/**
 * FacebookAccountCookie.ts
 * Chỗ duy nhất đọc cookie + proxy của một dòng fb_accounts.
 * Page con không có cookie riêng: dựng từ cookie tài khoản cha + i_user lúc chạy.
 */

import DatabaseService from '../database/DatabaseService';
import { secureGet } from '../secure/SecureSettingsService';
import { pickFBCookie, FBAccountCookieRow } from './FacebookPages';

function readStoredCookie(account: FBAccountCookieRow): string | null {
  return secureGet(`fb_cookie_${account.id}`) || account.cookie_encrypted || null;
}

export function resolveFBCookie(account: FBAccountCookieRow): string | null {
  return pickFBCookie(
    account,
    (facebookId) => DatabaseService.getInstance().getFBAccountByFacebookId(facebookId),
    readStoredCookie,
  );
}

/** Proxy của Page = proxy của tài khoản cha, để Page đi cùng IP với cookie cha. */
export function resolveFBProxyId(account: { id: string; facebook_id?: string | null; parent_facebook_id?: string | null }): number | null {
  try {
    const owner = account.parent_facebook_id || account.facebook_id || account.id;
    const row = DatabaseService.getInstance().queryOne<any>('SELECT proxy_id FROM accounts WHERE zalo_id = ?', [owner]);
    return row?.proxy_id ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Đổi mọi chỗ đọc cookie trong `facebookIpc.ts`**

Thêm import cạnh các import `../../src/services/facebook/...`:

```ts
import { resolveFBCookie, resolveFBProxyId } from '../../src/services/facebook/FacebookAccountCookie';
```

`getFBServiceOrReconnect` — thay khối từ `const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;` tới hết khối `try { const accRow = ... } catch { proxyId = null; }` bằng:

```ts
  const cookie = resolveFBCookie(account);
  if (!cookie) return null;

  const proxyId = resolveFBProxyId(account);
```

`fb:refreshProfile` — thay `const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;` bằng `const cookie = resolveFBCookie(account);`.

`fb:refreshContactAvatar` — thay `const cookie = secureGet(fbCookieKey(internalId));` bằng:

```ts
      const fbAcc = DatabaseService.getInstance().getFBAccount(internalId);
      const cookie = fbAcc ? resolveFBCookie(fbAcc) : null;
```

`fb:getUserInfoFacebookHtml` — thay `const cookie = secureGet(fbCookieKey(internalId));` bằng đúng hai dòng như trên.

`fb:connect` — thay khối `let proxyId ... catch { proxyId = null; }` bằng `const proxyId = resolveFBProxyId(account);` và thay `const cookie = secureGet(fbCookieKey(internalId)) || account.cookie_encrypted;` bằng `const cookie = resolveFBCookie(account);`.

`reconnectAllFBAccounts` — ngay sau khối "Bỏ qua account đã connected" thêm:

```ts
        // Page đã tắt: không kết nối
        if (acc.enabled === 0) {
          Logger.log(`[facebookIpc] reconnectAllFBAccounts ${acc.id}: Page disabled, skipping`);
          continue;
        }
```

rồi thay `const cookie = secureGet(fbCookieKey(acc.id)) || acc.cookie_encrypted;` bằng `const cookie = resolveFBCookie(acc);`, và thay khối `let proxyId ... catch { proxyId = null; }` bằng `const proxyId = resolveFBProxyId(acc);`.

Giữ nguyên `secureGet` import nếu còn chỗ dùng; nếu `tsc` báo import thừa thì không có lỗi (dự án không bật `noUnusedLocals`) — giữ nguyên, không dọn.

- [ ] **Step 5: `FacebookService.getInstance`**

Trong `src/services/facebook/FacebookService.ts`, thêm import `import { resolveFBCookie } from './FacebookAccountCookie';` cạnh `import { secureGet } from '../secure/SecureSettingsService';`. Thay khối trong `if (!cookie) { try { ... } catch {} }` bằng:

```ts
      if (!cookie) {
        try {
          // Sử dụng instanceKey (đã resolve) để lookup cookie; Page dựng từ cookie cha
          const acc = DatabaseService.getInstance().getFBAccount(instanceKey);
          if (acc) cookie = resolveFBCookie(acc) || undefined;
        } catch {}
      }
```

- [ ] **Step 6: Chặn quét dữ liệu cho Page**

Trong `src/services/facebook/FacebookScanService.ts`, thay thân `getCookie`:

```ts
  private getCookie(accountId: string): string | null {
    const acc = DatabaseService.getInstance().getFBAccount(accountId);
    if (acc?.parent_facebook_id) throw new Error('Tính năng quét chưa hỗ trợ tài khoản Page');
    return secureGet(fbCookieKey(accountId));
  }
```

Nếu file chưa import `DatabaseService`, thêm `import DatabaseService from '../database/DatabaseService';`. Kiểm `getCookie` được gọi bên trong `try` của mọi hàm gọi nó (grep `this.getCookie(`); nếu có chỗ gọi ngoài `try`, báo lại trong report, không tự bọc thêm.

- [ ] **Step 7: Kiểm chứng**

Run: `grep -rn "secureGet(fbCookieKey" electron src --include=*.ts`
Expected: chỉ còn `src/services/facebook/FacebookScanService.ts` (trong `getCookie`). `FacebookAccountCookie.ts` dùng chuỗi `fb_cookie_` trực tiếp.

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0.

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/facebook`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/database/DatabaseService.ts src/services/facebook/FacebookAccountCookie.ts electron/ipc/facebookIpc.ts src/services/facebook/FacebookService.ts src/services/facebook/FacebookScanService.ts
git commit -m "feat(facebook): store Page child accounts and resolve their cookie from the parent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `FacebookService` chạy với vai Page

**Files:**
- Modify: `src/services/facebook/FacebookService.ts` (field + constructor ~dòng 86-91; `_doConnect` ngay sau `this.dataFB = await initSession(...)` ~dòng 252; `handleIncomingMessage` ~dòng 485; `retryE2EE` ~dòng 1686; `sendMessage` ngay sau khối "Ensure connection is alive" ~dòng 1950; cạnh `getRealFacebookId` ~dòng 2419)
- Modify: `electron/ipc/facebookIpc.ts` (`fb:sendAttachment` ~dòng 547, `fb:sendAttachments` ~dòng 755)

**Interfaces:**
- Consumes: `isOwnSender` (Task 1); cột `parent_facebook_id`, `delegate_page_id` (Task 2).
- Produces: `FacebookService.isPage(): boolean`.

- [ ] **Step 1: Field và constructor**

Thêm import `import { isOwnSender } from './FacebookPages';`. Thêm field cạnh `private _facebookId: string | null = null;`:

```ts
  /** Dòng này là Page con (có parent_facebook_id): không E2EE bridge, gửi qua REST */
  private _isPage = false;
  /** id Page cổ điển: tin của Page có thể mang id này thay vì id profile */
  private _delegatePageId: string | null = null;
```

Trong constructor, sau `this.httpsAgent = this.resolveProxyAgent();`:

```ts
    try {
      const acc = DatabaseService.getInstance().getFBAccount(accountId);
      this._isPage = !!acc?.parent_facebook_id;
      this._delegatePageId = acc?.delegate_page_id || null;
    } catch {}
    // E2EE bridge dùng c_user + xs, tức là vai tài khoản cá nhân → Page không chạy bridge
    if (this._isPage) this.e2eeEnabled = false;
```

Cạnh `public getRealFacebookId()`:

```ts
  public isPage(): boolean { return this._isPage; }
```

- [ ] **Step 2: Kiểm chuyển vai khi kết nối**

Trong `_doConnect`, ngay sau dòng `this.dataFB = await initSession(this.cookie, this.httpsAgent);`:

```ts
      // Page: Facebook phải trả actorID = id Page, nếu không là chưa chuyển vai (mất quyền quản trị)
      if (this._isPage && this.dataFB.FacebookID !== this.getFacebookId()) {
        const acc = DatabaseService.getInstance().getFBAccount(this.accountId);
        throw new Error(`Không chuyển được sang Page ${acc?.name || this.getFacebookId()}. Kiểm tra quyền quản trị Page.`);
      }
```

- [ ] **Step 3: `isSelf` tính cả id Page cổ điển**

Trong `handleIncomingMessage`, thay

```ts
    const isSelf = this.dataFB?.FacebookID && msg.userID === this.dataFB.FacebookID ? 1 : 0;
```

bằng

```ts
    const isSelf = isOwnSender(msg.userID, this.dataFB?.FacebookID, this._delegatePageId) ? 1 : 0;
```

Không sửa dòng `isSelf` ở đường E2EE (~dòng 1425): Page không có bridge.

- [ ] **Step 4: `retryE2EE` không làm gì với Page**

Dòng đầu thân `public async retryE2EE(): Promise<void> {`:

```ts
    if (this._isPage) return; // Page không có E2EE bridge; caller kiểm isE2EEConnected() và đi REST
```

- [ ] **Step 5: `sendMessage` của Page luôn qua REST**

Trong `sendMessage`, ngay sau khối

```ts
    const ready = await this.ensureConnected();
    if (!ready) {
      return { success: false, error: 'Mất kết nối Facebook. Vui lòng kết nối lại tài khoản.' };
    }
```

thêm:

```ts
    // Page: không có E2EE bridge → mọi thread gửi REST, người gửi = dataFB.FacebookID = id Page
    if (this._isPage) {
      const pageResult = await sendMessageREST(this.requireSession(), threadId, body, opts, agent);
      if (pageResult.success && pageResult.messageId) this.markMessageLocallySent(pageResult.messageId);
      return pageResult;
    }
```

- [ ] **Step 6: Gửi tệp của Page đi đường REST**

Trong `electron/ipc/facebookIpc.ts`, ở cả `fb:sendAttachment` và `fb:sendAttachments`, thay

```ts
      const isUserMessage = params.typeChat === 'user';
```

bằng

```ts
      // Page không có E2EE bridge → 1:1 cũng đi đường upload + REST như nhóm
      const isUserMessage = params.typeChat === 'user' && !service.isPage();
```

- [ ] **Step 7: Kiểm chứng**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0.

Run: `grep -n "isPage()\|_isPage" src/services/facebook/FacebookService.ts electron/ipc/facebookIpc.ts`
Expected: field, constructor, `_doConnect`, `retryE2EE`, `sendMessage`, `isPage()` và hai chỗ trong IPC.

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/facebook`
Expected: PASS (`isOwnSender` giữ đúng hành vi cũ khi `delegatePageId` rỗng).

- [ ] **Step 8: Commit**

```bash
git add src/services/facebook/FacebookService.ts electron/ipc/facebookIpc.ts
git commit -m "feat(facebook): run Page accounts without the E2EE bridge and send via REST

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: IPC Page + vòng đời theo tài khoản cha

**Files:**
- Modify: `electron/ipc/facebookIpc.ts` (helper mới cạnh `getFBServiceOrReconnect`; `_addFBAccountCommon` ~dòng 100-166; `fb:removeAccount` ~242; `fb:updateCookie` ~259; handler mới ngay sau `fb:getAccounts`)
- Modify: `electron/ipc/loginIpc.ts` (`login:getAccounts` ~219-260, `login:removeAccount` ~268-312)
- Modify: `electron/preload.ts` (khối `fb: {` ~dòng 465)
- Modify: `src/ui/lib/ipc.ts` (khối kiểu `fb: {` ~dòng 493)

**Interfaces:**
- Consumes: `fetchManagedPages`, `mergePageList`, `stripPageCookie`, `buildPageCookie`, `PageListItem` (Task 1); `getFBPageChildren`, `saveFBPageAccount`, `setFBPageEnabled`, `resolveFBCookie`, `resolveFBProxyId` (Task 2); `FacebookService.removeInstance` (có sẵn).
- Produces:
  - IPC `fb:listPages({ accountId }) → { success: true; pages: PageListItem[] } | { success: false; error: string }`
  - IPC `fb:setPageEnabled({ accountId, profileId, enabled }) → { success: boolean; error?: string }`
  - `export async function removePageChildren(parentFacebookId: string, mode: 'delete' | 'deleteWithData' | 'deactivate'): Promise<void>` trong `facebookIpc.ts`
  - `login:getAccounts` thêm `parent_zalo_id: string | null` cho dòng Facebook.
  - Renderer: `ipc.fb.listPages`, `ipc.fb.setPageEnabled`.

Ruling đã chốt: spec §8 bước 2 ("dựng cookie Page và chạy `initSession`, kiểm `FacebookID === profileId`") được thực hiện bên trong `FacebookConnectionManager.getOrCreate` → `FacebookService._doConnect` (Task 3 Step 2), không gọi `initSession` thêm một lần trong handler. Cùng phép kiểm, bớt một request tới Facebook.

- [ ] **Step 1: Helper**

Trong `facebookIpc.ts`, thêm import:

```ts
import { fetchManagedPages, mergePageList, stripPageCookie, buildPageCookie } from '../../src/services/facebook/FacebookPages';
```

Ngay sau hàm `getFBServiceOrReconnect`, thêm:

```ts
/** Proxy agent từ proxyId (null nếu không có proxy hoặc lỗi). */
function proxyAgentFor(proxyId: number | null | undefined): any {
  if (!proxyId) return undefined;
  try {
    const proxy = DatabaseService.getInstance().getProxyById(proxyId);
    if (proxy) {
      const { createProxyAgent } = require('../../src/utils/ProxyHelper');
      return createProxyAgent(proxy);
    }
  } catch {}
  return undefined;
}

/** Kết nối lại các Page con đang bật sau khi cookie tài khoản cha đổi. */
async function reconnectPageChildren(parentFacebookId: string): Promise<void> {
  for (const child of DatabaseService.getInstance().getFBPageChildren(parentFacebookId)) {
    if (child.enabled !== 1) continue;
    try {
      await FacebookConnectionManager.disconnect(child.id).catch(() => {});
      FacebookService.removeInstance(child.id);
      const cookie = resolveFBCookie(child);
      if (!cookie) continue;
      await FacebookConnectionManager.getOrCreate(child.id, cookie, resolveFBProxyId(child));
    } catch (err: any) {
      Logger.warn(`[facebookIpc] reconnect Page ${child.facebook_id} failed: ${err.message}`);
    }
  }
}

/**
 * Xóa các Page con (kể cả đã tắt) cùng tài khoản cha.
 * delete: như fb:removeAccount. deleteWithData / deactivate: như login:removeAccount có / không xóa dữ liệu.
 */
export async function removePageChildren(parentFacebookId: string, mode: 'delete' | 'deleteWithData' | 'deactivate'): Promise<void> {
  const db = DatabaseService.getInstance();
  for (const child of db.getFBPageChildren(parentFacebookId)) {
    await FacebookConnectionManager.disconnect(child.id).catch(() => {});
    FacebookService.removeInstance(child.id);
    if (mode === 'delete') {
      db.deleteFBAccount(child.id);
      db.deleteAccount(child.facebook_id);
    } else if (mode === 'deleteWithData') {
      db.deleteAccountData(child.facebook_id);
      FileStorageService.deleteAccountMedia(child.facebook_id);
    } else {
      db.setFBPageEnabled(child.id, false);
    }
  }
}
```

Trong `_addFBAccountCommon`, thay khối `let httpsAgent: any = undefined; if (proxyId) { try { ... } catch {} }` bằng `const httpsAgent = proxyAgentFor(proxyId);`.

Kiểm `FileStorageService.deleteAccountMedia` là static method (đang được gọi kiểu này ở `loginIpc.ts:300`); nếu không, báo lại.

- [ ] **Step 2: `_addFBAccountCommon`: bỏ `i_user`, nối lại Page con**

Đổi chữ ký sang `async function _addFBAccountCommon(rawCookie: string, proxyId: number | null | undefined)` và dòng đầu thân hàm:

```ts
    // Cookie dán vào có i_user (đang đứng vai Page) → bỏ, để luôn thêm tài khoản cá nhân
    const cookie = stripPageCookie(rawCookie);
```

Ngay trước `const account = DatabaseService.getInstance().getFBAccount(accountId);` ở cuối hàm:

```ts
    // Thêm lại cùng tài khoản: Page con gắn theo facebook_id nên vẫn còn, kết nối lại bằng cookie mới
    reconnectPageChildren(fbId).catch(() => {});
```

- [ ] **Step 3: `fb:removeAccount` xóa cả Page con**

Thay thân `try` của `fb:removeAccount` bằng:

```ts
      const internalId = resolveInternalId(accountId);
      const fbAcc = DatabaseService.getInstance().getFBAccount(internalId);
      if (fbAcc && !fbAcc.parent_facebook_id) await removePageChildren(fbAcc.facebook_id, 'delete');
      await FacebookConnectionManager.disconnect(internalId);
      secureDelete(fbCookieKey(internalId));
      DatabaseService.getInstance().deleteFBAccount(internalId);
      // Also remove from unified accounts table (zalo_id = fbId)
      DatabaseService.getInstance().deleteAccount(accountId);
      return { success: true };
```

- [ ] **Step 4: `fb:updateCookie`**

Ngay sau `if (!account) return { success: false, error: 'Tài khoản không tồn tại' };`:

```ts
      if (account.parent_facebook_id) {
        return { success: false, error: 'Page dùng cookie của tài khoản cha. Hãy cập nhật cookie ở tài khoản cá nhân.' };
      }
      cookie = stripPageCookie(cookie);
```

(`cookie` là tham số destructure của handler nên gán lại được; không đổi chữ ký.)

Ngay trước `Logger.log(\`[facebookIpc] fb:updateCookie success for ${internalId}\`);`:

```ts
      reconnectPageChildren(account.facebook_id).catch(() => {});
```

- [ ] **Step 5: Handler `fb:listPages` và `fb:setPageEnabled`**

Ngay sau handler `fb:getAccounts`, thêm:

```ts
  /**
   * Danh sách Page mà tài khoản cá nhân quản trị, kèm trạng thái bật trong MaiHub
   */
  ipcMain.handle('fb:listPages', async (_event, { accountId }: { accountId: string }) => {
    try {
      const db = DatabaseService.getInstance();
      const parent = db.getFBAccount(resolveInternalId(accountId));
      if (!parent) return { success: false, error: 'Tài khoản không tồn tại' };
      if (parent.parent_facebook_id) return { success: false, error: 'Tài khoản này là Page' };
      const cookie = resolveFBCookie(parent);
      if (!cookie) return { success: false, error: 'Không tìm thấy cookie. Vui lòng cập nhật cookie.' };
      const remote = await fetchManagedPages(cookie, proxyAgentFor(resolveFBProxyId(parent)));
      return { success: true, pages: mergePageList(remote, db.getFBPageChildren(parent.facebook_id)) };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:listPages error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  /**
   * Bật / tắt một Page thành tài khoản con. Tắt: ngắt kết nối, giữ dữ liệu.
   */
  ipcMain.handle('fb:setPageEnabled', async (_event, { accountId, profileId, enabled }: { accountId: string; profileId: string; enabled: boolean }) => {
    try {
      const db = DatabaseService.getInstance();
      const parent = db.getFBAccount(resolveInternalId(accountId));
      if (!parent) return { success: false, error: 'Tài khoản không tồn tại' };
      if (parent.parent_facebook_id) return { success: false, error: 'Tài khoản này là Page' };
      if (!/^\d+$/.test(String(profileId || ''))) return { success: false, error: 'Id Page không hợp lệ' };
      const existing = db.getFBPageChildren(parent.facebook_id).find((c: any) => c.facebook_id === profileId);

      if (!enabled) {
        if (existing) {
          await FacebookConnectionManager.disconnect(existing.id).catch(() => {});
          FacebookService.removeInstance(existing.id);
          db.setFBPageEnabled(existing.id, false);
        }
        return { success: true };
      }

      const owner = db.getFBAccountByFacebookId(profileId);
      if (owner && owner.parent_facebook_id !== parent.facebook_id) {
        return { success: false, error: 'Page này đã được thêm dưới một tài khoản khác' };
      }

      const cookie = resolveFBCookie(parent);
      if (!cookie) return { success: false, error: 'Không tìm thấy cookie. Vui lòng cập nhật cookie.' };
      const proxyId = resolveFBProxyId(parent);
      const page = (await fetchManagedPages(cookie, proxyAgentFor(proxyId))).find((p) => p.profileId === profileId);
      if (!page) return { success: false, error: 'Tài khoản không quản trị Page này' };

      const id = existing?.id || uuid();
      db.saveFBPageAccount({
        id, facebook_id: page.profileId, name: page.name, avatar_url: page.avatarUrl || '',
        parent_facebook_id: parent.facebook_id, delegate_page_id: page.delegatePageId, proxy_id: proxyId,
      });
      try {
        // connect → initSession với cookie i_user, kiểm FacebookID === id Page (FacebookService._doConnect)
        await FacebookConnectionManager.getOrCreate(id, buildPageCookie(cookie, page.profileId), proxyId);
      } catch (err: any) {
        await FacebookConnectionManager.disconnect(id).catch(() => {});
        FacebookService.removeInstance(id);
        db.setFBPageEnabled(id, false);
        return { success: false, error: err.message };
      }
      Logger.log(`[facebookIpc] fb:setPageEnabled: Page ${page.profileId} (${page.name}) enabled under ${parent.facebook_id}`);
      return { success: true };
    } catch (err: any) {
      Logger.error(`[facebookIpc] fb:setPageEnabled error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });
```

- [ ] **Step 6: `loginIpc.ts`**

`login:getAccounts`: trong vòng `for (const fb of fbAccounts)`, thêm map cha. Đổi khối thành:

```ts
            let fbIdToUuid: Record<string, string> = {};
            let fbParentOf: Record<string, string | null> = {};
            try {
                const fbAccounts = DatabaseService.getInstance().getFBAccounts();
                for (const fb of fbAccounts) {
                    if (fb.facebook_id && fb.id) fbIdToUuid[fb.facebook_id] = fb.id;
                    if (fb.facebook_id) fbParentOf[fb.facebook_id] = fb.parent_facebook_id || null;
                }
            } catch {}
```

và thay `...(isFB ? { facebook_id: acc.zalo_id } : {}),` bằng

```ts
                    ...(isFB ? { facebook_id: acc.zalo_id, parent_zalo_id: fbParentOf[acc.zalo_id] ?? null } : {}),
```

`login:removeAccount`: trong nhánh `if (fbAcc?.id) {`, ngay sau dòng `secureDelete(...)`:

```ts
                    // Page con đi cùng tài khoản cha, cùng lựa chọn xóa dữ liệu
                    if (!fbAcc.parent_facebook_id) {
                        const { removePageChildren } = require('./facebookIpc');
                        await removePageChildren(zaloId, deleteData ? 'deleteWithData' : 'deactivate');
                    }
```

- [ ] **Step 7: Preload và kiểu renderer**

`electron/preload.ts`, trong khối `fb: {`, ngay sau dòng `refreshProfile:`:

```ts
    listPages:           (params: { accountId: string }) => ipcRenderer.invoke('fb:listPages', params),
    setPageEnabled:      (params: { accountId: string; profileId: string; enabled: boolean }) => ipcRenderer.invoke('fb:setPageEnabled', params),
```

`src/ui/lib/ipc.ts`, trong khối kiểu `fb: {`, ngay sau dòng `refreshProfile:`:

```ts
        listPages:            (params: { accountId: string }) => Promise<{ success: boolean; pages?: Array<{ profileId: string; name: string; delegatePageId: string | null; avatarUrl: string | null; enabled: boolean }>; error?: string }>;
        setPageEnabled:       (params: { accountId: string; profileId: string; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
```

Kiểm chế độ employee/relay: grep `fb:` trong `src/ui/lib/ipc.ts` / file relay để xem kênh `fb:*` có cần đăng ký thêm vào danh sách cho phép nào không (ví dụ allowlist). Nếu có allowlist cho `fb:addAccount`/`fb:refreshProfile`, thêm hai kênh mới cùng chỗ; nếu không có, không làm gì. Ghi kết quả vào report.

- [ ] **Step 8: Kiểm chứng**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx tsc -p tsconfig.electron.json --noEmit`
Expected: exit 0.

Run: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19 env NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

Run: `grep -n "fb:listPages\|fb:setPageEnabled" electron/ipc/facebookIpc.ts electron/preload.ts`
Expected: mỗi kênh có một handler và một dòng preload.

- [ ] **Step 9: Commit**

```bash
git add electron/ipc/facebookIpc.ts electron/ipc/loginIpc.ts electron/preload.ts src/ui/lib/ipc.ts
git commit -m "feat(facebook): add Page list/toggle IPC and tie Page lifecycle to the parent account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sidebar hiện Page dưới tài khoản cha

**Files:**
- Create: `src/ui/lib/accountTree.ts`
- Test: `src/__tests__/ui/accountTree.test.ts`
- Modify: `src/ui/store/accountStore.ts` (`AccountInfo` ~dòng 5-25, so sánh trong `setAccounts` ~dòng 56-66)
- Modify: `src/ui/components/layout/SidebarAccounts.tsx`
- Modify: `src/ui/index.css` (cạnh `.app-account.is-drag-over` ~dòng 249)

**Interfaces:**
- Consumes: `parent_zalo_id` từ `login:getAccounts` (Task 4).
- Produces:
  - `interface TreeAccount { zalo_id: string; parent_zalo_id?: string | null }`
  - `orderAccountsWithChildren<T extends TreeAccount>(accounts: T[]): T[]`
  - `AccountInfo.parent_zalo_id?: string | null`

- [ ] **Step 1: Write the failing test**

Tạo `src/__tests__/ui/accountTree.test.ts`:

```ts
import { orderAccountsWithChildren } from '../../ui/lib/accountTree';

const a = (zalo_id: string, parent_zalo_id: string | null = null) => ({ zalo_id, parent_zalo_id });
const ids = (list: Array<{ zalo_id: string }>) => list.map((x) => x.zalo_id);

describe('orderAccountsWithChildren', () => {
  it('đưa Page con ngay sau tài khoản cha, giữ thứ tự xuất hiện', () => {
    const list = [a('p1'), a('zalo'), a('page2', 'p1'), a('p2'), a('page1', 'p1'), a('page3', 'p2')];
    expect(ids(orderAccountsWithChildren(list))).toEqual(['p1', 'page2', 'page1', 'zalo', 'p2', 'page3']);
  });
  it('Page mồ côi (cha không có trong danh sách) giữ vị trí của nó', () => {
    expect(ids(orderAccountsWithChildren([a('x'), a('orphan', 'missing'), a('y')]))).toEqual(['x', 'orphan', 'y']);
  });
  it('không đổi danh sách không có Page', () => {
    const list = [a('z1'), a('z2'), a('z3')];
    expect(ids(orderAccountsWithChildren(list))).toEqual(['z1', 'z2', 'z3']);
  });
  it('quan hệ vòng hoặc lồng nhiều tầng không làm mất dòng nào', () => {
    const cyc = [a('m', 'n'), a('n', 'm'), a('k')];
    expect(ids(orderAccountsWithChildren(cyc)).sort()).toEqual(['k', 'm', 'n']);
    const deep = [a('root'), a('mid', 'root'), a('leaf', 'mid')];
    expect(ids(orderAccountsWithChildren(deep))).toEqual(['root', 'mid', 'leaf']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/ui/accountTree.test.ts`
Expected: FAIL, "Cannot find module '../../ui/lib/accountTree'".

- [ ] **Step 3: Write minimal implementation**

Tạo `src/ui/lib/accountTree.ts` (không import `@/…` để jest chạy được):

```ts
/** Tài khoản tối thiểu để sắp cây: id + id tài khoản cha (Page Facebook). */
export interface TreeAccount {
  zalo_id: string;
  parent_zalo_id?: string | null;
}

/**
 * Thứ tự hiển thị: mỗi Page con đứng ngay sau tài khoản cha, theo thứ tự xuất hiện.
 * Page có cha không nằm trong danh sách giữ vị trí của nó. Không bao giờ làm mất dòng.
 */
export function orderAccountsWithChildren<T extends TreeAccount>(accounts: T[]): T[] {
  const ids = new Set(accounts.map((acc) => acc.zalo_id));
  const hasParent = (acc: T) => !!acc.parent_zalo_id && ids.has(acc.parent_zalo_id);
  const childrenOf = new Map<string, T[]>();
  for (const acc of accounts) {
    if (!hasParent(acc)) continue;
    const list = childrenOf.get(acc.parent_zalo_id!) || [];
    list.push(acc);
    childrenOf.set(acc.parent_zalo_id!, list);
  }

  const out: T[] = [];
  const placed = new Set<T>();
  const place = (acc: T) => {
    if (placed.has(acc)) return;
    placed.add(acc);
    out.push(acc);
    (childrenOf.get(acc.zalo_id) || []).forEach(place);
  };
  accounts.filter((acc) => !hasParent(acc)).forEach(place);
  accounts.forEach(place); // dòng còn sót (quan hệ vòng) đi theo thứ tự gốc
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/ui/accountTree.test.ts`
Expected: PASS.

- [ ] **Step 5: Store**

`src/ui/store/accountStore.ts`: trong `AccountInfo`, sau `facebook_id?: string;`:

```ts
  /** Page Facebook: facebook_id của tài khoản cá nhân cha; null/undefined với tài khoản thường */
  parent_zalo_id?: string | null;
```

Trong `setAccounts`, thêm vào chuỗi so sánh sau `&& a.channel === b?.channel`:

```ts
          && a.parent_zalo_id === b?.parent_zalo_id
```

- [ ] **Step 6: Sidebar**

`src/ui/components/layout/SidebarAccounts.tsx`:

1. Import: `import { orderAccountsWithChildren } from '@/lib/accountTree';`
2. Trong `AccountAvatar`, ngay trước `</span>` đóng ngoài cùng (sau khối `ChannelBadge`):

```tsx
      {account.parent_zalo_id && (
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-blue-600 text-white flex items-center justify-center pointer-events-none" title="Page Facebook">
          <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3v18h2v-7h6l1 2h6V5h-6l-1-2H5z"/></svg>
        </span>
      )}
```

3. `accountTooltip`: thêm phần tử `account.parent_zalo_id ? 'Page Facebook' : null,` ngay sau dòng `account.is_business ? ...`.
4. Thay

```ts
  const shown = query
    ? accounts.filter((a) => (a.full_name || '').toLowerCase().includes(query) || (a.phone || '').includes(query))
    : accounts;
```

bằng

```ts
  // Page con đứng ngay sau tài khoản cha; thứ tự dựng lại mỗi lần render nên kéo cha thì con đi theo
  const ordered = orderAccountsWithChildren(accounts);
  const shown = query
    ? ordered.filter((a) => (a.full_name || '').toLowerCase().includes(query) || (a.phone || '').includes(query))
    : ordered;
```

5. Trong `renderBadges`, đổi vị trí chấm "Chưa kết nối": thay `${collapsed ? 'bottom-1.5 right-3' : 'left-6 top-5'}` bằng `${collapsed ? 'bottom-1.5 right-3' : account.parent_zalo_id ? 'left-10 top-5' : 'left-6 top-5'}`.
6. Trong `shown.map((account) => {`, thêm `const isChild = !!account.parent_zalo_id;`; đổi `draggable={canDrag}` thành `draggable={canDrag && !isChild}`; thêm `${isChild ? 'is-child' : ''}` vào `className` của `button.app-account`; đổi `style={{ cursor: canDrag ? 'grab' : 'pointer' }}` thành `style={{ cursor: canDrag && !isChild ? 'grab' : 'pointer' }}`.

Không sửa danh sách "Hộp thư gộp" (khối `mergedInboxMode`).

- [ ] **Step 7: CSS**

`src/ui/index.css`, ngay sau dòng `.app-account.is-drag-over { opacity: 0.6; }`:

```css
  .app-account.is-child { padding-left: 25px; }
```

(Quy tắc `.app-sidebar.is-collapsed .app-account { ... padding: 0; }` có độ ưu tiên cao hơn nên thu gọn không thụt lề.)

- [ ] **Step 8: Kiểm chứng**

Run: `systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 nice -n 19 npx jest src/__tests__/ui src/__tests__/facebook`
Expected: PASS.

Run: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19 env NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/ui/lib/accountTree.ts src/__tests__/ui/accountTree.test.ts src/ui/store/accountStore.ts src/ui/components/layout/SidebarAccounts.tsx src/ui/index.css
git commit -m "feat(ui): show Facebook Pages nested under their personal account in the sidebar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Bảng bật/tắt Page, menu Dashboard, bước Chọn Page

**Files:**
- Create: `src/ui/components/facebook/FacebookPagesPanel.tsx`
- Modify: `src/ui/components/dashboard/AccountCard.tsx`
- Modify: `src/ui/components/auth/AddAccountModal.tsx`

**Interfaces:**
- Consumes: `ipc.fb.listPages`, `ipc.fb.setPageEnabled` (Task 4); `AccountInfo.parent_zalo_id` (Task 5).
- Produces: `export type FacebookPageItem = { profileId: string; name: string; delegatePageId: string | null; avatarUrl: string | null; enabled: boolean }`; `export default function FacebookPagesPanel({ accountId, initialPages }: { accountId: string; initialPages?: FacebookPageItem[] })`.

- [ ] **Step 1: `FacebookPagesPanel`**

Tạo `src/ui/components/facebook/FacebookPagesPanel.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { toLocalMediaUrl } from '@/lib/localMedia';

export type FacebookPageItem = {
  profileId: string;
  name: string;
  delegatePageId: string | null;
  avatarUrl: string | null;
  enabled: boolean;
};

/** Danh sách Page mà tài khoản Facebook cá nhân quản trị; bật Page để thành tài khoản con. */
export default function FacebookPagesPanel({ accountId, initialPages }: { accountId: string; initialPages?: FacebookPageItem[] }) {
  const [pages, setPages] = useState<FacebookPageItem[] | null>(initialPages ?? null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const setAccounts = useAccountStore((s) => s.setAccounts);

  const load = useCallback(async () => {
    setPages(null);
    setLoadError('');
    try {
      const res = await ipc.fb?.listPages({ accountId });
      if (res?.success) setPages(res.pages || []);
      else setLoadError(res?.error || 'Không tải được danh sách Page');
    } catch (err: any) {
      setLoadError(err?.message || 'Không tải được danh sách Page');
    }
  }, [accountId]);

  useEffect(() => {
    if (!initialPages) load();
  }, [load, initialPages]);

  const toggle = async (page: FacebookPageItem) => {
    const next = !page.enabled;
    setBusyId(page.profileId);
    setRowError((e) => ({ ...e, [page.profileId]: '' }));
    try {
      const res = await ipc.fb?.setPageEnabled({ accountId, profileId: page.profileId, enabled: next });
      if (res?.success) {
        setPages((list) => list && list.map((p) => (p.profileId === page.profileId ? { ...p, enabled: next } : p)));
        const acc = await ipc.login?.getAccounts();
        if (acc?.accounts) setAccounts(acc.accounts);
      } else {
        setRowError((e) => ({ ...e, [page.profileId]: res?.error || 'Thao tác thất bại' }));
      }
    } catch (err: any) {
      setRowError((e) => ({ ...e, [page.profileId]: err?.message || 'Thao tác thất bại' }));
    } finally {
      setBusyId(null);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-400">{loadError}</p>
        <button type="button" onClick={load} className="text-sm text-blue-400 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35 rounded">
          Thử lại
        </button>
      </div>
    );
  }

  if (!pages) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Đang tải danh sách Page">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <span className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <span className="h-3 flex-1 rounded bg-gray-700" />
          </div>
        ))}
      </div>
    );
  }

  if (pages.length === 0) {
    return <p className="text-sm text-gray-400">Tài khoản này chưa quản trị Page nào</p>;
  }

  return (
    <ul className="space-y-1">
      {pages.map((page) => (
        <li key={page.profileId} className="py-1.5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-8 h-8 rounded-full overflow-hidden bg-gray-700 flex-shrink-0">
              {page.avatarUrl && <img src={toLocalMediaUrl(page.avatarUrl)} alt="" className="w-full h-full object-cover" />}
            </span>
            <span className="flex-1 min-w-0 truncate text-sm text-gray-200" title={page.name}>{page.name}</span>
            <button
              type="button"
              role="switch"
              aria-checked={page.enabled}
              aria-label={`${page.enabled ? 'Tắt' : 'Bật'} Page ${page.name}`}
              disabled={busyId !== null}
              onClick={() => toggle(page)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35 ${
                page.enabled ? 'bg-blue-600' : 'bg-gray-600'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                page.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`} />
            </button>
          </div>
          {rowError[page.profileId] && <p className="text-xs text-red-400 mt-1 ml-11">{rowError[page.profileId]}</p>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: `AccountCard`**

`src/ui/components/dashboard/AccountCard.tsx`:

1. Import: `import FacebookPagesPanel from '../facebook/FacebookPagesPanel';`
2. Sau `const [fbCookieModalOpen, setFbCookieModalOpen] = useState(false);`:

```tsx
  const [pagesModalOpen, setPagesModalOpen] = useState(false);
```

   Sau `const isZaloAcc = isZalo(accountChannel);`:

```tsx
  const isPageAcc = isFacebookAcc && !!acc.parent_zalo_id;
  const parentName = useAccountStore((s) => s.accounts.find((a) => a.zalo_id === acc.parent_zalo_id)?.full_name);
```

3. Dưới dòng `<p className="text-xs text-gray-400 truncate">{isFacebookAcc ? ... : acc.zalo_id}</p>`:

```tsx
          {isPageAcc && (
            <p className="text-xs text-gray-400 truncate">Page của {parentName || acc.parent_zalo_id}</p>
          )}
```

4. Trong menu, nhánh `isFacebookAcc ? (<> ... </>)`: bọc nút "Cập nhật Cookie FB" bằng `{!isPageAcc && ( ... )}` và ngay sau nó thêm:

```tsx
                {!isPageAcc && (
                  <button
                    onClick={() => { setMenuOpen(false); setPagesModalOpen(true); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M4 21V4h9l1 2h6v9h-7l-1-2H6v8"/>
                    </svg>
                    Quản lý Page
                  </button>
                )}
```

5. Hàng 2 khi listener chết: bọc nút thứ hai (nút có chữ `{isFacebookAcc ? 'Cập nhật Cookie' : ...}`) bằng `{!isPageAcc && ( ... )}`.
6. Ngay sau khối `{fbCookieModalOpen && (...)}` ở cuối:

```tsx
    {pagesModalOpen && (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[200] p-4" onClick={() => setPagesModalOpen(false)}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quản lý Page"
          className="bg-gray-800 rounded-xl w-full max-w-sm p-5 border border-gray-700 shadow-2xl max-h-[80vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold">Quản lý Page</h3>
            <button
              type="button"
              onClick={() => setPagesModalOpen(false)}
              aria-label="Đóng"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <p className="text-xs text-gray-400 mb-3">Bật Page để nhận và trả lời tin nhắn của Page trong MaiHub.</p>
          <div className="overflow-y-auto min-h-0">
            <FacebookPagesPanel accountId={acc.zalo_id} />
          </div>
        </div>
      </div>
    )}
```

- [ ] **Step 3: `AddAccountModal` — bước Chọn Page**

`src/ui/components/auth/AddAccountModal.tsx`:

1. Import: `import FacebookPagesPanel, { FacebookPageItem } from '../facebook/FacebookPagesPanel';`
2. `type Step = 'channel' | 'proxy' | 'detail' | 'telegram' | 'telegram_user' | 'pages';`
3. Sau `const [proxyLoading, setProxyLoading] = useState(false);`:

```tsx
  const [pagesParent, setPagesParent] = useState<{ accountId: string; pages: FacebookPageItem[] } | null>(null);

  // Sau khi thêm Facebook: có Page quản trị thì cho chọn Page, không có (hoặc lỗi) thì đóng như cũ
  const handleFacebookAdded = async (facebookId?: string) => {
    if (facebookId) {
      try {
        const res = await ipc.fb?.listPages({ accountId: facebookId });
        if (res?.success && res.pages && res.pages.length > 0) {
          setPagesParent({ accountId: facebookId, pages: res.pages });
          setStep('pages');
          return;
        }
      } catch {}
    }
    onClose();
  };
```

4. `headerTitle`: thêm nhánh đầu `step === 'pages' ? 'Chọn Page'` trước `step === 'channel' ? ...`.
5. Nút quay lại: đổi `{step !== 'channel' && (` thành `{step !== 'channel' && step !== 'pages' && (`.
6. Trong khối `step === 'detail' && isFacebook(channel)`: đổi `<FacebookAccountLoginTab onSuccess={onClose} ...` và `<FacebookCookieLoginTab onSuccess={onClose} ...` thành `onSuccess={handleFacebookAdded}`.
7. Ngay sau khối `{step === 'detail' && isFacebook(channel) && (...)}`:

```tsx
        {step === 'pages' && pagesParent && (
          <div className="p-6 space-y-4">
            <p className="text-gray-400 text-sm">
              Bật Page để nhận và trả lời tin nhắn của Page ngay trong MaiHub. Có thể đổi sau ở menu "Quản lý Page" của tài khoản.
            </p>
            <div className="max-h-[50vh] overflow-y-auto">
              <FacebookPagesPanel accountId={pagesParent.accountId} initialPages={pagesParent.pages} />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm py-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35"
            >
              Xong
            </button>
          </div>
        )}
```

8. `FacebookAccountLoginTab` và `FacebookCookieLoginTab`: đổi kiểu prop `onSuccess: () => void` thành `onSuccess: (facebookId?: string) => void`, và lời gọi `onSuccess();` trong nhánh thành công thành `onSuccess(result.facebookId);`. Không đổi gì khác trong hai tab.

- [ ] **Step 4: Kiểm chứng**

Run: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19 env NODE_OPTIONS=--max-old-space-size=4096 npx tsc -p tsconfig.json --noEmit`
Expected: exit 0.

Run: `grep -n "#[0-9a-fA-F]\{3,6\}" src/ui/components/facebook/FacebookPagesPanel.tsx`
Expected: không có kết quả (không mã hex).

Run: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 nice -n 19 npx vite build`
Expected: build xong không lỗi (cảnh báo kích thước chunk có sẵn thì bỏ qua).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/facebook/FacebookPagesPanel.tsx src/ui/components/dashboard/AccountCard.tsx src/ui/components/auth/AddAccountModal.tsx
git commit -m "feat(ui): manage Facebook Pages from the dashboard and after adding an account

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Sau các task (controller, không giao implementer)

1. Cập nhật trạng thái spec: `Chờ duyệt` → `Đã duyệt, đang chờ kiểm tay` trong `docs/specs/2026-10-03-facebook-page-inbox.md`.
2. Toàn bộ: `npx jest` (chỉ được còn 2 suite lỗi mốc), hai `tsc`, `vite build`.
3. Chạy app ở môi trường cách ly (`XDG_CONFIG_HOME` trong scratchpad, Xvfb), chụp Sidebar / Quản lý Page / Chọn Page ở light + dark, desktop + mobile. Hai vòng.
4. Kiểm tay với tin nhắn thật (spec §14.2) là của anh, trước khi gộp nhánh.
