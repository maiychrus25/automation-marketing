import { BUSY_ERROR } from './FacebookPosterService';

export const LOGIN_CHECK_SETTING_KEY = 'fb_poster_login_check';
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
export const BUSY_RETRY_MS = 5 * 60 * 1000;
export const BUSY_GIVE_UP_MS = 2 * 60 * 60 * 1000;

export interface LoginCheckConfig { enabled: boolean; time: string; }

export const DEFAULT_LOGIN_CHECK_CONFIG: LoginCheckConfig = { enabled: true, time: '07:00' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateLoginCheckConfig(input: any): LoginCheckConfig {
    if (!input || typeof input.enabled !== 'boolean' || typeof input.time !== 'string' || !TIME_RE.test(input.time)) {
        throw new Error('Cấu hình kiểm tra đăng nhập không hợp lệ');
    }
    return { enabled: input.enabled, time: input.time };
}

/** Đọc cấu hình đã lưu; thiếu hoặc hỏng thì dùng mặc định. */
export function parseLoginCheckConfig(raw: string | null): LoginCheckConfig {
    if (!raw) return { ...DEFAULT_LOGIN_CHECK_CONFIG };
    try {
        return validateLoginCheckConfig(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_LOGIN_CHECK_CONFIG };
    }
}

/** Mốc `time` (giờ máy) kế tiếp, luôn lớn hơn `now`. */
export function nextDailyAt(time: string, now: number): number {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) { d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); }
    return d.getTime();
}

export interface LoginCheckDeps {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    readConfig: () => LoginCheckConfig;
    isBusy: () => boolean;
    /** Đồng bộ; ném `BUSY_ERROR` khi đang có việc chạy. */
    runCheck: () => void;
    log: (msg: string) => void;
}

/** Chạy kiểm tra đăng nhập Facebook mỗi ngày một lần; bận thì thử lại mỗi 5 phút, quá 2 giờ thì bỏ lượt. */
export class LoginCheckScheduler {
    private timer: unknown = null;
    private stopped = false;
    private scheduledAt = 0;

    constructor(private readonly deps: LoginCheckDeps) {}

    start(): void {
        this.stopped = false;
        this.armNextDay();
    }

    stop(): void {
        this.stopped = true;
        this.clear();
    }

    reschedule(): void {
        if (!this.stopped) this.armNextDay();
    }

    private armNextDay(): void {
        const { now, readConfig } = this.deps;
        this.scheduledAt = nextDailyAt(readConfig().time, now());
        this.armAt(this.scheduledAt);
    }

    private armAt(target: number): void {
        this.clear();
        const delay = Math.min(Math.max(0, target - this.deps.now()), MAX_TIMER_MS);
        this.timer = this.deps.setTimer(() => this.fire(), delay);
    }

    private fire(): void {
        if (this.stopped) return;
        this.timer = null;
        const { now, readConfig, isBusy, runCheck, log } = this.deps;
        if (now() < this.scheduledAt) { this.armAt(this.scheduledAt); return; }
        if (!readConfig().enabled) { this.armNextDay(); return; }
        let busy = isBusy();
        if (!busy) {
            try {
                runCheck();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message === BUSY_ERROR) busy = true;
                else log(`[LoginCheckScheduler] kiểm tra đăng nhập lỗi: ${message}`);
            }
        }
        if (busy) {
            if (now() - this.scheduledAt >= BUSY_GIVE_UP_MS) {
                log('[LoginCheckScheduler] bỏ lượt kiểm tra đăng nhập: đang có việc khác chạy quá 2 giờ');
            } else {
                this.armAt(now() + BUSY_RETRY_MS);
                return;
            }
        }
        this.armNextDay();
    }

    private clear(): void {
        if (this.timer !== null) this.deps.clearTimer(this.timer);
        this.timer = null;
    }
}
