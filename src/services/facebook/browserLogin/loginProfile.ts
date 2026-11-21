import type { BrowserFingerprint } from '../../../models/browserProfile';
import { generateFingerprint } from '../../browser/fingerprint';

export const loginProfileKey = (internalId: string) => `fb_login_profile_${internalId}`;

interface LoginProfileDb {
  getSetting(k: string): string | null;
  setSetting(k: string, v: string): void;
  getBrowserProfileById(id: string): { id: string; proxy_id: number | null } | null;
  createBrowserProfile(p: { id: string; name: string; group_id: null; proxy_id: number | null; fingerprint: BrowserFingerprint; note: string }): { id: string };
  updateBrowserProfile(id: string, f: { proxy_id: number | null }): void;
}

/** Hồ sơ trình duyệt riêng của tài khoản để đăng nhập lấy cookie; tạo lần đầu, các lần sau dùng lại và theo proxy của tài khoản. */
export function ensureLoginProfile(deps: { db: LoginProfileDb; internalId: string; accountName: string; proxyId: number | null; newId(): string }): string {
  const { db, internalId, proxyId } = deps;
  const key = loginProfileKey(internalId);
  const remembered = db.getSetting(key);
  const existing = remembered ? db.getBrowserProfileById(remembered) : null;
  if (existing) {
    if (existing.proxy_id !== proxyId) db.updateBrowserProfile(existing.id, { proxy_id: proxyId });
    return existing.id;
  }
  const created = db.createBrowserProfile({
    id: deps.newId(),
    name: `Đăng nhập Facebook – ${deps.accountName}`,
    group_id: null,
    proxy_id: proxyId,
    fingerprint: generateFingerprint(),
    note: 'Hồ sơ MaiHub dùng để lấy cookie Facebook',
  });
  db.setSetting(key, created.id);
  return created.id;
}
