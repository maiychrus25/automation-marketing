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
