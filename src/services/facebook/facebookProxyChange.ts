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

/** Tài khoản mà lần nối lại sau khi đổi proxy đã thất bại: nó rời danh sách kết nối nhưng vẫn là tài khoản người dùng muốn chạy. */
const failedAfterProxyChange = new Set<string>();

/** Người dùng chủ động ngắt hoặc xoá tài khoản: quên dấu "nối lại hỏng" để lần đổi proxy sau không tự nối lại nó. */
export function forgetProxyChangeFailure(accountId: string): void {
  failedAfterProxyChange.delete(accountId);
}

/**
 * Proxy của một tài khoản Facebook cá nhân vừa đổi trong cơ sở dữ liệu: nối lại nó và các Page con đang bật để đi qua
 * proxy mới. Chạy nền, không ném lỗi. Trả false khi tài khoản chưa kết nối (proxy mới áp ở lần kết nối tới).
 */
export function applyFacebookProxyChange(facebookId: string): boolean {
  const account = DatabaseService.getInstance().getFBAccountByFacebookId(facebookId);
  if (!account?.id) return false;
  const accountId: string = account.id;
  if (!FacebookConnectionManager.get(accountId) && !failedAfterProxyChange.has(accountId)) return false;
  void (async () => {
    try {
      // Ngắt hẳn trước: getOrCreate trả lại kết nối đang có (với proxy cũ) nếu nó còn trong danh sách.
      await FacebookConnectionManager.disconnect(accountId);
      const cookie = resolveFBCookie(account);
      if (cookie) await FacebookConnectionManager.getOrCreate(accountId, cookie, resolveFBProxyId(account));
      failedAfterProxyChange.delete(accountId);
    } catch (err: any) {
      Logger.warn(`[facebookProxyChange] reconnect account after proxy change failed: ${err.message}`);
      // Trong lúc đó đã có kết nối khác thành công (người dùng bấm kết nối): để yên.
      if (!FacebookConnectionManager.get(accountId)) {
        // Kết nối hỏng không được nằm lại (nó giữ proxy cũ); nhớ để lần đổi proxy sau nối lại tài khoản này.
        FacebookService.removeInstance(accountId);
        failedAfterProxyChange.add(accountId);
      }
    }
    await reconnectPageChildren(facebookId).catch(() => {});
  })();
  return true;
}
