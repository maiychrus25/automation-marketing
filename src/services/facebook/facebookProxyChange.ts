/**
 * Nối lại tài khoản Facebook và các Page con của nó khi cookie hoặc proxy của tài khoản cha đổi.
 * Page không có proxy riêng: nó đi cùng proxy với tài khoản cha (resolveFBProxyId).
 */
import DatabaseService from '../database/DatabaseService';
import FacebookConnectionManager from '../../utils/FacebookConnectionManager';
import Logger from '../../utils/Logger';
import { resolveFBCookie, resolveFBProxyId } from './FacebookAccountCookie';
import { FacebookService } from './FacebookService';

/** Kết nối lại các Page con đang bật sau khi cookie hoặc proxy của tài khoản cha đổi. */
export async function reconnectPageChildren(parentFacebookId: string): Promise<void> {
  for (const child of DatabaseService.getInstance().getFBPageChildren(parentFacebookId)) {
    if (child.enabled !== 1) continue;
    try {
      await FacebookConnectionManager.disconnect(child.id).catch(() => {});
      FacebookService.removeInstance(child.id);
      const cookie = resolveFBCookie(child);
      if (!cookie) continue;
      await FacebookConnectionManager.getOrCreate(child.id, cookie, resolveFBProxyId(child));
    } catch (err: any) {
      Logger.warn(`[facebookProxyChange] reconnect Page ${child.facebook_id} failed: ${err.message}`);
    }
  }
}

/**
 * Proxy của một tài khoản Facebook cá nhân vừa đổi trong cơ sở dữ liệu: nối lại nó và các Page con đang bật để đi qua
 * proxy mới. Chạy nền, không ném lỗi. Trả false khi tài khoản chưa kết nối (proxy mới áp ở lần kết nối tới).
 */
export function applyFacebookProxyChange(facebookId: string): boolean {
  const account = DatabaseService.getInstance().getFBAccountByFacebookId(facebookId);
  if (!account?.id || !FacebookConnectionManager.get(account.id)) return false;
  void (async () => {
    try {
      // Ngắt hẳn trước: getOrCreate trả lại kết nối đang có (với proxy cũ) nếu nó còn trong danh sách.
      await FacebookConnectionManager.disconnect(account.id);
      const cookie = resolveFBCookie(account);
      if (cookie) await FacebookConnectionManager.getOrCreate(account.id, cookie, resolveFBProxyId(account));
    } catch (err: any) {
      Logger.warn(`[facebookProxyChange] reconnect account after proxy change failed: ${err.message}`);
    }
    await reconnectPageChildren(facebookId).catch(() => {});
  })();
  return true;
}
