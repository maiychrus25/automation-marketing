import { stripAccents } from './leadRules';

// Đổi nhãn thời gian tương đối của bình luận Facebook ("2 giờ", "Hôm qua", "12 tháng 10") ra mốc thời gian (ms, giờ máy).
// Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.1.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTH_NAMES: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
    july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12,
};

const UNIT_MS: Array<[RegExp, number]> = [
    [/^(?:phut|m|min|mins|minute|minutes)$/, MINUTE_MS],
    [/^(?:gio|h|hr|hrs|hour|hours)$/, HOUR_MS],
    [/^(?:ngay|d|day|days)$/, DAY_MS],
    [/^(?:tuan|w|wk|wks|week|weeks)$/, 7 * DAY_MS],
];

/** Ngày dương lịch (00:00 giờ máy); không có năm thì năm hiện tại, rơi vào tương lai thì lùi một năm. */
function dateOrNull(day: number, month: number, year: number | null, now: number): number | null {
    const current = new Date(now).getFullYear();
    const y = year ?? current;
    const d = new Date(y, month - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    if (year === null && d.getTime() > now) {
        const prev = new Date(y - 1, month - 1, day);
        return prev.getMonth() === month - 1 && prev.getDate() === day ? prev.getTime() : null;
    }
    return d.getTime();
}

export function parseCommentTime(label: string, collectedAt: number): number | null {
    const text = stripAccents(String(label ?? '').normalize('NFC'))
        .replace(/\s+(?:luc|at)\s.*$/, '') // "Hôm qua lúc 10:30"
        .replace(/\s+/g, ' ').trim();
    if (text === '') return null;

    if (text === 'vua xong' || text === 'just now') return collectedAt;
    if (text === 'hom qua' || text === 'yesterday') return collectedAt - DAY_MS;

    const rel = /^(\d+)\s*([a-z]+)$/.exec(text);
    if (rel) {
        const unit = UNIT_MS.find(([re]) => re.test(rel[2]));
        if (unit) return collectedAt - Number(rel[1]) * unit[1];
    }

    const viDate = /^(\d{1,2}) thang (\d{1,2})(?:,? (\d{4}))?$/.exec(text);
    if (viDate) return dateOrNull(Number(viDate[1]), Number(viDate[2]), viDate[3] ? Number(viDate[3]) : null, collectedAt);

    const enDate = /^([a-z]+) (\d{1,2})(?:,? (\d{4}))?$/.exec(text);
    if (enDate && MONTH_NAMES[enDate[1]]) {
        return dateOrNull(Number(enDate[2]), MONTH_NAMES[enDate[1]], enDate[3] ? Number(enDate[3]) : null, collectedAt);
    }
    return null;
}
