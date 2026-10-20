import { pickBestTimes } from '../../services/facebookPoster/bestTimes';
import type { PostStatsReportRow } from '../../models/facebookPoster';

function row(key: string, label: string, avg: number | null, measured: number): PostStatsReportRow {
    return {
        key, label, posts: measured, withLink: measured, pending: 0, notFound: 0, removedSuspected: 0, reactions: 0, comments: 0, shares: 0,
        measured, insufficient: measured < 5, avgEngagement: avg, engagementRate: null,
    };
}

test('lọc measured < 5, tối đa 3 giờ và 2 thứ, xếp theo avgEngagement giảm dần', () => {
    const hours = [row('08', '08h', 5, 5), row('09', '09h', 50, 4), row('10', '10h', 30, 9), row('11', '11h', 20, 5), row('12', '12h', 40, 6)];
    const days = [row('1', 'Thứ 2', 3, 5), row('2', 'Thứ 3', 9, 5), row('7', 'Chủ nhật', 7, 8), row('3', 'Thứ 4', 99, 1)];
    const out = pickBestTimes(hours, days);
    expect(out.insufficient).toBe(false);
    expect(out.hours).toEqual([
        { key: '12', label: '12h', avgEngagement: 40, measured: 6 },
        { key: '10', label: '10h', avgEngagement: 30, measured: 9 },
        { key: '11', label: '11h', avgEngagement: 20, measured: 5 },
    ]);
    expect(out.weekdays.map(w => w.key)).toEqual(['2', '7']);
});

test('không giờ nào đủ → insufficient', () => {
    const out = pickBestTimes([row('09', '09h', 50, 4)], [row('1', 'Thứ 2', 5, 9)]);
    expect(out.insufficient).toBe(true);
    expect(out.hours).toEqual([]);
    expect(out.weekdays.map(w => w.key)).toEqual(['1']);
});

test('avgEngagement null bị bỏ qua', () => {
    const out = pickBestTimes([row('09', '09h', null, 9), row('10', '10h', 1, 5)], []);
    expect(out.hours.map(h => h.key)).toEqual(['10']);
});
