/** Gợi ý giờ / thứ đăng tốt nhất từ báo cáo gom theo giờ và thứ (spec 26.23 §3.2). */
import type { PostStatsReportRow } from '../../models/facebookPoster';
import { MIN_MEASURED_FOR_COMPARISON } from './postTracking';

export interface BestTimeSlot {
    key: string;
    label: string;
    avgEngagement: number;
    measured: number;
}

const MAX_HOURS = 3;
const MAX_WEEKDAYS = 2;

function top(rows: PostStatsReportRow[], limit: number): BestTimeSlot[] {
    return rows
        .filter(r => r.measured >= MIN_MEASURED_FOR_COMPARISON && r.avgEngagement !== null)
        .map(r => ({ key: r.key, label: r.label, avgEngagement: r.avgEngagement as number, measured: r.measured }))
        .sort((a, b) => b.avgEngagement - a.avgEngagement)
        .slice(0, limit);
}

export interface BestTimes { hours: BestTimeSlot[]; weekdays: BestTimeSlot[]; insufficient: boolean }

export function pickBestTimes(hourRows: PostStatsReportRow[], weekdayRows: PostStatsReportRow[]): BestTimes {
    const hours = top(hourRows, MAX_HOURS);
    return { hours, weekdays: top(weekdayRows, MAX_WEEKDAYS), insufficient: hours.length === 0 };
}
