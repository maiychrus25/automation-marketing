import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export const KEY_PREFIX = 'mh_';

/** SHA-256 hex của khoá thô; chỉ giá trị này được lưu. */
export function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

/** `mh_` + base64url(32 byte ngẫu nhiên). */
export function generateKey(): string {
    return KEY_PREFIX + randomBytes(32).toString('base64url');
}

/** So khớp hằng thời gian: băm khoá nhận được rồi so với hash đã lưu (cả hai là hex 64 ký tự). */
export function keyMatches(rawKey: string, storedHash: string): boolean {
    const a = Buffer.from(hashKey(rawKey), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Danh sách IP được phép (chỉ IPv4 / CIDR IPv4; CIDR IPv6 chưa hỗ trợ) ──────────

function ipv4ToInt(ip: string): number | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
        const o = Number(m[i]);
        if (o > 255) return null;
        n = n * 256 + o;
    }
    return n;
}

function normalizeIp(ip: string): string {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
    return m ? m[1] : ip.trim();
}

type AllowEntry = { kind: 'v4'; base: number; mask: number } | { kind: 'v6loopback' };

function parseEntry(raw: string): AllowEntry | null {
    const text = raw.trim();
    if (text === '::1') return { kind: 'v6loopback' };
    const [addr, bits, extra] = text.split('/');
    if (extra !== undefined) return null;
    const base = ipv4ToInt(addr);
    if (base === null) return null;
    let prefix = 32;
    if (bits !== undefined) {
        if (!/^\d{1,2}$/.test(bits) || Number(bits) > 32) return null;
        prefix = Number(bits);
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { kind: 'v4', base: (base & mask) >>> 0, mask };
}

/** `::1` chỉ khớp mục `::1` tường minh; mục không hợp lệ bị bỏ qua; danh sách rỗng từ chối tất cả. */
export function ipAllowed(ip: string, list: string[]): boolean {
    const normalized = normalizeIp(ip);
    const asInt = ipv4ToInt(normalized);
    for (const raw of list) {
        const entry = parseEntry(raw);
        if (!entry) continue;
        if (entry.kind === 'v6loopback') { if (normalized === '::1') return true; continue; }
        if (asInt !== null && ((asInt & entry.mask) >>> 0) === entry.base) return true;
    }
    return false;
}

/** Tách văn bản (phân cách bằng dấu phẩy/khoảng trắng/xuống dòng) cho UI cài đặt. */
export function parseAllowList(text: string): { entries: string[]; invalid: string[] } {
    const entries: string[] = [];
    const invalid: string[] = [];
    for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
        (parseEntry(token) ? entries : invalid).push(token);
    }
    return { entries, invalid };
}

// ─── Giới hạn tốc độ và khoá IP ───────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;

/** Cửa sổ trượt 60 giây theo từng khoá. */
export class RateLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly limitPerMinute: number = 60, private readonly now: () => number = Date.now) {}

    take(keyId: string): boolean {
        const t = this.now();
        const recent = (this.hits.get(keyId) ?? []).filter((h) => t - h < RATE_WINDOW_MS);
        if (recent.length >= this.limitPerMinute) {
            this.hits.set(keyId, recent);
            return false;
        }
        recent.push(t);
        this.hits.set(keyId, recent);
        return true;
    }
}

const LOCKOUT_MAX_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 600_000;
const LOCKOUT_BLOCK_MS = 900_000;

/** 10 lần sai trong 600 s từ một IP thì chặn 900 s; đăng nhập đúng xoá bộ đếm. */
export class AuthLockout {
    private readonly failures = new Map<string, number[]>();
    private readonly blockedUntil = new Map<string, number>();

    constructor(private readonly now: () => number = Date.now) {}

    isBlocked(ip: string, now: number = this.now()): boolean {
        const until = this.blockedUntil.get(ip);
        if (until === undefined) return false;
        if (now >= until) { this.blockedUntil.delete(ip); return false; }
        return true;
    }

    recordFailure(ip: string, now: number = this.now()): void {
        const recent = (this.failures.get(ip) ?? []).filter((f) => now - f < LOCKOUT_WINDOW_MS);
        recent.push(now);
        if (recent.length >= LOCKOUT_MAX_FAILURES) {
            this.blockedUntil.set(ip, now + LOCKOUT_BLOCK_MS);
            this.failures.delete(ip);
        } else {
            this.failures.set(ip, recent);
        }
    }

    recordSuccess(ip: string): void {
        this.failures.delete(ip);
    }
}
