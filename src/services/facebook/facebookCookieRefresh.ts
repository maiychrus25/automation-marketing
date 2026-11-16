/**
 * Cookie phiên mà Facebook làm mới trong lúc dùng (qua Set-Cookie, hoặc bridge Go nhận hộ). App giữ nguyên chuỗi cookie
 * người dùng dán lúc thêm tài khoản thì sớm muộn sẽ gửi bản cũ; hai hàm thuần ở đây gộp bản mới vào chuỗi đang lưu.
 * Không ghi log, không chạm mạng hay kho lưu trữ.
 */

/** Chỉ các cookie của phiên đăng nhập mới được nhận; cookie giao diện, quảng cáo hay chuyển Page (i_user) thì không. */
const SESSION_COOKIES = ['xs', 'fr', 'datr', 'sb'];

function parseCookieHeader(cookie: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) pairs.push([name, part.slice(eq + 1).trim()]);
  }
  return pairs;
}

/** Tên và giá trị các cookie còn hiệu lực trong các dòng Set-Cookie. Cookie bị xoá (giá trị trống / "deleted", đã hết hạn) bị bỏ. */
export function refreshedCookiesFrom(setCookie: unknown, now: number = Date.now()): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(setCookie)) return out;
  for (const raw of setCookie) {
    const [first, ...attributes] = String(raw).split(';');
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || !value || value === 'deleted') continue;
    const attr = (key: string) => attributes.map(a => a.trim()).find(a => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
    const maxAge = attr('max-age');
    if (maxAge !== undefined && Number(maxAge) <= 0) continue;
    const expires = attr('expires');
    if (expires !== undefined && Date.parse(expires) <= now) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Gộp cookie phiên mới vào chuỗi cookie đang dùng: thay giá trị đã có, thêm cookie còn thiếu, giữ nguyên thứ tự và mọi
 * cookie khác. `changed` là tên các cookie đã đổi (rỗng thì `cookie` chính là chuỗi đầu vào).
 * Cookie của một tài khoản khác (c_user khác) bị từ chối toàn bộ.
 */
export function mergeRefreshedCookies(cookie: string, incoming: Record<string, string>): { cookie: string; changed: string[] } {
  const pairs = parseCookieHeader(cookie);
  const current = new Map(pairs);
  const userId = current.get('c_user');
  if (!userId || !current.get('xs')) return { cookie, changed: [] };
  if (incoming.c_user && incoming.c_user !== userId) return { cookie, changed: [] };
  const changed: string[] = [];
  for (const name of SESSION_COOKIES) {
    const value = incoming[name];
    if (!value || value === 'deleted' || current.get(name) === value) continue;
    if (current.has(name)) pairs[pairs.findIndex(([n]) => n === name)][1] = value;
    else pairs.push([name, value]);
    current.set(name, value);
    changed.push(name);
  }
  return changed.length ? { cookie: pairs.map(([n, v]) => `${n}=${v}`).join('; '), changed } : { cookie, changed };
}
