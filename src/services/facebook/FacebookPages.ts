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
export async function fetchManagedPages(cookie: string, httpsAgent?: any, timeoutMs = 60000): Promise<ManagedPage[]> {
  try {
    const res = await axios.get(BOOKMARKS_PAGES_URL, {
      headers: fbHeaders(stripPageCookie(cookie)),
      timeout: timeoutMs,
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

/**
 * Tên người gửi từ tiêu đề thông báo Page.
 * Facebook gửi title dạng "<tên người gửi> đến <tên Page>" (deltaBiiMPageMessageNotification).
 * Bỏ phần " đến <pageName>" ở cuối để lấy tên người gửi; không khớp thì trả nguyên title.
 */
export function parsePageSenderName(title: string | undefined | null, pageName: string | undefined | null): string {
  const raw = (title || '').trim();
  if (!raw) return '';
  if (pageName && raw.endsWith(pageName)) {
    const head = raw.slice(0, raw.length - pageName.length).replace(/\s*đến\s*$/u, '').trim();
    if (head) return head;
  }
  return raw;
}
