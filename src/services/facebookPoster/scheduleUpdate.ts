import type { FbPosterSchedule } from '../../models/facebookPoster';
import { TIME_RE, computeNextRun } from './scheduleTime';

const MAX_NAME = 100;
const MIN_LEAD_MS = 60 * 1000;
export const LEAD_ERROR = 'Giờ đăng phải sau thời điểm hiện tại ít nhất 1 phút';
export const DRAFT_ENABLE_ERROR = 'Bản nháp phải được duyệt trước khi bật';

export type ScheduleUpdateFields = Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt'>>;

/** Validates the timing fields of a schedule; returns the normalized values. */
export function readTiming(kind: string, input: { runAt?: unknown; days?: unknown; time?: unknown }, now: number): Pick<FbPosterSchedule, 'runAt' | 'days' | 'time'> {
    if (kind === 'once') {
        const runAt = input.runAt;
        if (typeof runAt !== 'number' || !Number.isInteger(runAt) || runAt < now + MIN_LEAD_MS) throw new Error(LEAD_ERROR);
        return { runAt, days: [], time: '' };
    }
    const days = Array.isArray(input.days) ? [...new Set(input.days)] : [];
    if (days.length === 0 || !days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
        throw new Error('Chọn ít nhất một ngày trong tuần');
    }
    if (typeof input.time !== 'string' || !TIME_RE.test(input.time)) throw new Error('Giờ không hợp lệ');
    return { runAt: null, days: (days as number[]).sort((a, b) => a - b), time: input.time };
}

export function readName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (name.length > MAX_NAME) throw new Error('Tên lịch tối đa 100 ký tự');
    return name;
}

/**
 * Fields to write for an update request. `nextRunAt` is recomputed only when the request touches
 * enabled/runAt/days/time, so renaming never moves or clears a pending run.
 */
export function planScheduleUpdate(
    existing: FbPosterSchedule,
    request: { name?: unknown; enabled?: unknown; runAt?: unknown; days?: unknown; time?: unknown },
    now: number,
): ScheduleUpdateFields {
    if (existing.draft && request.enabled !== undefined) throw new Error(DRAFT_ENABLE_ERROR);
    const fields: ScheduleUpdateFields = {};
    if (request.name !== undefined) {
        const name = readName(request.name);
        if (!name) throw new Error('Tên lịch không được để trống');
        fields.name = name;
    }
    const touchesTiming = request.enabled !== undefined || request.runAt !== undefined || request.days !== undefined || request.time !== undefined;
    if (!touchesTiming) return fields;

    if (request.enabled !== undefined) fields.enabled = !!request.enabled;
    if (existing.kind === 'once') {
        if (request.runAt !== undefined) fields.runAt = readTiming('once', request, now).runAt;
    } else if (request.days !== undefined || request.time !== undefined) {
        const timing = readTiming('recurring', { days: request.days ?? existing.days, time: request.time ?? existing.time }, now);
        fields.days = timing.days;
        fields.time = timing.time;
    }
    const merged = { ...existing, ...fields };
    fields.nextRunAt = merged.enabled ? computeNextRun(merged, now) : null;
    if (merged.enabled && fields.nextRunAt === null) throw new Error(LEAD_ERROR);
    return fields;
}
