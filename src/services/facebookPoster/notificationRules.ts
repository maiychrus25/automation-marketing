// Quy tắc thuần của thông báo qua bot: cấu hình, kỳ báo cáo 📊 theo múi giờ và nhãn giờ của tin gom 🎯.
// Spec: docs/specs/2026-10-31-page-publish-proof-metrics.md mục 4.2, 5, 6. Mọi phép tính giờ nhận `timeZone`
// tường minh (không dùng Date#getHours) nên múi giờ của máy không đổi khóa kỳ.

export const NOTIFICATION_SETTING_KEY = 'fb_poster_notification_config';
export const REPORT_PERIOD_SETTING_KEY = 'fb_poster_report_last_period';
export const LEAD_DIGEST_CURSOR_SETTING_KEY = 'fb_poster_lead_digest_cursor';
export const NOTIFICATION_TICK_MS = 60_000;
export const LEAD_DIGEST_MINUTES = [0, 15, 30, 60, 120, 240] as const;
/** Chứa `BUSY_ERROR` ('Đang có việc chạy') để Control API trả BUSY. */
export const LEAD_DIGEST_BUSY_ERROR = 'Đang có việc chạy: lượt thu bình luận chưa xong, đổi "Gom tin khách tiềm năng" sau khi lượt thu kết thúc';

export type ReportCadence = 'off' | 'daily' | 'weekly';

export interface NotificationConfig {
    reportCadence: ReportCadence;
    /** Giờ gửi 0–23 theo giờ địa phương. */
    reportHour: number;
    /** 1 = thứ Hai … 7 = Chủ nhật; chỉ dùng với `weekly`. */
    reportWeekday: number;
    /** 0 = gửi ngay từng lượt như trước. */
    leadDigestMinutes: (typeof LEAD_DIGEST_MINUTES)[number];
}

export const DEFAULT_NOTIFICATION_CONFIG: Readonly<NotificationConfig> = Object.freeze({
    reportCadence: 'weekly', reportHour: 8, reportWeekday: 1, leadDigestMinutes: 60,
});

/** Con trỏ lead đã xử lý: lead sau con trỏ là lead có `id` lớn hơn (`at` chỉ dùng cho khung giờ/nhãn). */
export type LeadCursor = { at: number; id: number };

export interface ReportPeriod {
    /** `${cadence}:YYYY-MM-DD` của ngày gửi; mỗi khóa chỉ phát một lần. */
    key: string;
    from: number;
    /** Lúc gửi của kỳ (không gồm `to`). */
    to: number;
    /**
     * Nhãn kỳ theo múi giờ, sẵn để bridge hiển thị: `dd/MM HH:mm → dd/MM HH:mm` khi giờ gửi > 0; giờ gửi 0 thì là
     * các ngày trọn vẹn kết thúc hôm trước (`dd/MM–dd/MM` với tuần, `dd/MM` với ngày).
     */
    label: string;
}

const KEYS = ['reportCadence', 'reportHour', 'reportWeekday', 'leadDigestMinutes'] as const;
const CADENCES: readonly string[] = ['off', 'daily', 'weekly'];

function checkKeys(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cấu hình thông báo không hợp lệ');
    const extra = Object.keys(input).filter((k) => !(KEYS as readonly string[]).includes(k));
    if (extra.length) throw new Error(`Trường không hỗ trợ trong cấu hình thông báo: ${extra.join(', ')}`);
    return input as Record<string, unknown>;
}

const isIntIn = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function validateNotificationConfig(input: unknown): NotificationConfig {
    const o = checkKeys(input);
    if (typeof o.reportCadence !== 'string' || !CADENCES.includes(o.reportCadence)) throw new Error('reportCadence phải là off, daily hoặc weekly');
    if (!isIntIn(o.reportHour, 0, 23)) throw new Error('reportHour phải là số nguyên từ 0 đến 23');
    if (!isIntIn(o.reportWeekday, 1, 7)) throw new Error('reportWeekday phải là số nguyên từ 1 (thứ Hai) đến 7 (Chủ nhật)');
    if (!(LEAD_DIGEST_MINUTES as readonly unknown[]).includes(o.leadDigestMinutes)) throw new Error(`leadDigestMinutes phải là một trong ${LEAD_DIGEST_MINUTES.join(', ')}`);
    return {
        reportCadence: o.reportCadence as ReportCadence, reportHour: o.reportHour as number, reportWeekday: o.reportWeekday as number,
        leadDigestMinutes: o.leadDigestMinutes as NotificationConfig['leadDigestMinutes'],
    };
}

/** Áp một phần cấu hình (chỉ các khóa đã biết) lên cấu hình hiện tại rồi kiểm lại toàn bộ. */
export function mergeNotificationConfig(current: NotificationConfig, patch: unknown): NotificationConfig {
    return validateNotificationConfig({ ...current, ...checkKeys(patch) });
}

/** Đọc cấu hình đã lưu; thiếu hoặc hỏng thì dùng mặc định. */
export function parseNotificationConfig(raw: string | null): NotificationConfig {
    if (raw) {
        try { return validateNotificationConfig(JSON.parse(raw)); } catch { /* dùng mặc định */ }
    }
    return { ...DEFAULT_NOTIFICATION_CONFIG };
}

// ─── Giờ theo múi ────────────────────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(ms: number, timeZone: string) {
    let f = formatters.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
        });
        formatters.set(timeZone, f);
    }
    const p: Record<string, string> = {};
    for (const part of f.formatToParts(ms)) p[part.type] = part.value;
    return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, isoWeekday: WEEKDAYS.indexOf(p.weekday) + 1 };
}

/** Chênh lệch (ms) giữa giờ địa phương và UTC tại thời điểm `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
    const p = zonedParts(ms, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Thời điểm UTC của giờ địa phương `y-m-d hour:00` (tháng/ngày được tràn như Date.UTC). */
function zonedTime(y: number, m: number, d: number, hour: number, timeZone: string): number {
    const guess = Date.UTC(y, m - 1, d, hour);
    const first = guess - zoneOffset(guess, timeZone);
    return guess - zoneOffset(first, timeZone);
}

const pad = (n: number) => String(n).padStart(2, '0');

function dayMonth(ms: number, timeZone: string): string {
    const p = zonedParts(ms, timeZone);
    return `${pad(p.d)}/${pad(p.m)}`;
}

function hourMinute(ms: number, timeZone: string): string {
    const p = zonedParts(ms, timeZone);
    return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** `HH:mm–HH:mm` theo múi giờ. */
export function clockLabel(from: number, to: number, timeZone: string): string {
    return `${hourMinute(from, timeZone)}–${hourMinute(to, timeZone)}`;
}

function periodLabel(from: number, to: number, reportHour: number, timeZone: string): string {
    if (reportHour > 0) return `${dayMonth(from, timeZone)} ${hourMinute(from, timeZone)} → ${dayMonth(to, timeZone)} ${hourMinute(to, timeZone)}`;
    const [first, last] = [dayMonth(from, timeZone), dayMonth(to - 1, timeZone)];
    return first === last ? first : `${first}–${last}`;
}

/** Kỳ báo cáo gần nhất đã đến giờ gửi tại `now`; `off` thì null. */
export function latestReportPeriod(config: NotificationConfig, now: number, timeZone: string): ReportPeriod | null {
    if (config.reportCadence === 'off') return null;
    const daily = config.reportCadence === 'daily';
    const p = zonedParts(now, timeZone);
    const due = p.hour * 60 + p.minute >= config.reportHour * 60;
    const d = (p.isoWeekday - config.reportWeekday + 7) % 7;
    const back = daily ? (due ? 0 : 1) : (d === 0 && !due ? 7 : d);
    const sendDay = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
    const [y, m, day] = [sendDay.getUTCFullYear(), sendDay.getUTCMonth() + 1, sendDay.getUTCDate()];
    const to = zonedTime(y, m, day, config.reportHour, timeZone);
    const from = zonedTime(y, m, day - (daily ? 1 : 7), config.reportHour, timeZone);
    return { key: `${config.reportCadence}:${y}-${pad(m)}-${pad(day)}`, from, to, label: periodLabel(from, to, config.reportHour, timeZone) };
}
