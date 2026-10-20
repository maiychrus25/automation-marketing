import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** sha256 hex của khoá gốc. */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Đọc `RENDER_API_KEYS` (`{"<tên>":"<sha256 hex>"}`); sai định dạng thì ném lỗi. */
export function parseKeys(envJson: string): Map<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(envJson);
  } catch {
    throw new Error('RENDER_API_KEYS không phải JSON hợp lệ');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('RENDER_API_KEYS phải là đối tượng {"<tên>":"<sha256>"}');
  }
  const keys = new Map<string, string>();
  for (const [name, hash] of Object.entries(data)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`RENDER_API_KEYS: hash của "${name}" phải là sha256 hex (64 ký tự)`);
    }
    keys.set(name, hash.toLowerCase());
  }
  if (keys.size === 0) throw new Error('RENDER_API_KEYS chưa có khoá nào');
  return keys;
}

/** Trả tên MaiHub nếu khoá đúng, ngược lại null. So sánh thời gian hằng, duyệt hết mọi khoá. */
export function verifyKey(raw: string, keys: Map<string, string>): string | null {
  const given = Buffer.from(hashKey(raw), 'hex');
  let found: string | null = null;
  for (const [name, hash] of keys) {
    if (timingSafeEqual(given, Buffer.from(hash, 'hex')) && found === null) found = name;
  }
  return found;
}

/** Khoá gốc 32 byte ngẫu nhiên (base64url) kèm hash để đưa vào `.env`. */
export function generateKey(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashKey(raw) };
}
