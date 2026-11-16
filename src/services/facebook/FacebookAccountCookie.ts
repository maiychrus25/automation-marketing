/**
 * FacebookAccountCookie.ts
 * Chỗ đọc cookie + proxy của một dòng fb_accounts, và ghi lại cookie được làm mới.
 * Page con không có cookie riêng: dựng từ cookie tài khoản cha + i_user lúc chạy.
 */

import DatabaseService from '../database/DatabaseService';
import { secureGet, secureSet } from '../secure/SecureSettingsService';
import { pickFBCookie, FBAccountCookieRow } from './FacebookPages';

function readStoredCookie(account: FBAccountCookieRow): string | null {
  return secureGet(`fb_cookie_${account.id}`) || account.cookie_encrypted || null;
}

/**
 * Ghi bản làm mới của cookie một tài khoản cá nhân (Facebook vừa làm mới cookie phiên). Page không có cookie riêng.
 * Chỉ ghi khi kho vẫn đang giữ đúng bản `previous` mà bản mới phát sinh từ đó: nếu người dùng vừa dán cookie khác
 * (fb:updateCookie ghi thẳng vào kho trong lúc service cũ còn chạy) thì không được ghi đè. Trả true nếu đã ghi.
 */
export function storeRefreshedFBCookie(accountId: string, previous: string, refreshed: string): boolean {
  const key = `fb_cookie_${accountId}`;
  if (secureGet(key) !== previous) return false;
  secureSet(key, refreshed);
  return true;
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
