// Quy tắc thuần cho token đăng nhập của nhân viên: khoá ký, thu hồi, chống dò mật khẩu.

export const JWT_SECRET_VERSION = 2;

/** Không có khoá → tạo; khoá cũ (version < 2 hoặc không có) coi là đã lộ → đổi; còn lại giữ. */
export function planJwtSecretInit(existing: string | null, version: number | null): 'create' | 'rotate' | 'keep' {
    if (!existing) return 'create';
    if (version === null || version < JWT_SECRET_VERSION) return 'rotate';
    return 'keep';
}

export function tokenIssuedAtMs(claims: { ts?: unknown; iat?: unknown }): number {
    if (typeof claims.ts === 'number' && Number.isFinite(claims.ts)) return claims.ts;
    if (typeof claims.iat === 'number' && Number.isFinite(claims.iat)) return claims.iat * 1000;
    return 0;
}

export function evaluateEmployeeToken(input: {
    issuedAtMs: number;
    employee: { is_active: number } | null;
    validAfterMs: number;
}): 'ok' | 'unavailable' | 'inactive' | 'revoked' {
    if (!input.employee) return 'unavailable';
    if (!input.employee.is_active) return 'inactive';
    if (input.issuedAtMs <= input.validAfterMs) return 'revoked';
    return 'ok';
}

/** Mốc thu hồi mới luôn lớn hơn mốc cũ và mọi token đã phát hành, kể cả cùng mili giây. */
export function nextRevocationMark(nowMs: number, currentMark: number, lastIssuedMs: number): number {
    return Math.max(nowMs, currentMark + 1, lastIssuedMs);
}

const THROTTLE_MAX_FAILURES = 5;
const THROTTLE_WINDOW_MS = 15 * 60_000;
const THROTTLE_SWEEP_SIZE = 1000;

export class LoginThrottle {
    private entries = new Map<string, { failures: number[]; lockedUntil: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    private key(username: string): string {
        return String(username).toLowerCase().trim();
    }

    isLocked(username: string): boolean {
        const entry = this.entries.get(this.key(username));
        return !!entry && entry.lockedUntil > this.now();
    }

    recordFailure(username: string): void {
        const now = this.now();
        if (this.entries.size >= THROTTLE_SWEEP_SIZE) this.sweep(now);
        const k = this.key(username);
        const entry = this.entries.get(k) ?? { failures: [], lockedUntil: 0 };
        entry.failures = entry.failures.filter((t) => now - t < THROTTLE_WINDOW_MS);
        entry.failures.push(now);
        if (entry.failures.length >= THROTTLE_MAX_FAILURES) {
            entry.lockedUntil = now + THROTTLE_WINDOW_MS;
            entry.failures = [];
        }
        this.entries.set(k, entry);
    }

    recordSuccess(username: string): void {
        this.entries.delete(this.key(username));
    }

    private sweep(now: number): void {
        for (const [k, e] of this.entries) {
            if (e.lockedUntil <= now && !e.failures.some((t) => now - t < THROTTLE_WINDOW_MS)) this.entries.delete(k);
        }
    }
}
