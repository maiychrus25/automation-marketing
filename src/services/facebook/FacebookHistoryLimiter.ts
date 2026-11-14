/** Giới hạn tốc độ tải lịch sử Facebook theo từng tài khoản: hằng số cố định, không ngẫu nhiên. */

export const HISTORY_MIN_GAP_MS = 2_000;
export const HISTORY_MAX_PAGES_PER_HOUR = 120;
export const HISTORY_COOLDOWN_MS = 30 * 60_000;
export const HISTORY_INTERACTIVE_MAX_WAIT_MS = 5_000;

const HOUR_MS = 3_600_000;
const RISK_PATTERN = /checkpoint|login_required|not logged in|1357001|1357004|1390008/i;

export function isFacebookRiskError(error: unknown): boolean {
  const text = typeof error === 'object' && error !== null
    ? String((error as { message?: unknown }).message ?? '')
    : String(error ?? '');
  return RISK_PATTERN.test(text);
}

export class FacebookHistoryLimiter {
  private requests: number[] = [];
  private cooldownUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  cooldownRemaining(): number {
    return Math.min(HISTORY_COOLDOWN_MS, Math.max(0, this.cooldownUntil - this.now()));
  }

  /** ms tới khi yêu cầu kế tiếp được đi (khoảng cách tối thiểu + ngân sách theo giờ); không gồm cooldown. */
  waitMs(): number {
    const now = this.now();
    this.requests = this.requests.filter(t => now - t < HOUR_MS);
    const last = this.requests[this.requests.length - 1];
    // Kẹp để đồng hồ hệ thống lùi không làm chờ quá lâu.
    const gapWait = last === undefined ? 0 : Math.min(HISTORY_MIN_GAP_MS, Math.max(0, last + HISTORY_MIN_GAP_MS - now));
    const budgetWait = this.requests.length >= HISTORY_MAX_PAGES_PER_HOUR
      ? Math.min(HOUR_MS, Math.max(0, this.requests[this.requests.length - HISTORY_MAX_PAGES_PER_HOUR] + HOUR_MS - now))
      : 0;
    return Math.max(gapWait, budgetWait);
  }

  recordRequest(): void {
    const now = this.now();
    this.requests = this.requests.filter(t => now - t < HOUR_MS);
    this.requests.push(now);
  }

  recordResult(ok: boolean, error?: unknown): 'ok' | 'risk' {
    if (ok || !isFacebookRiskError(error)) return 'ok';
    this.cooldownUntil = this.now() + HISTORY_COOLDOWN_MS;
    return 'risk';
  }
}
