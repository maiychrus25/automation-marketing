import { linkChip, formatStatsLine, parseMinutesList, formatMinutesList, minutesLabel, gradeChip, formatBestTimes } from '../../ui/features/facebookPoster/trackingFormat';

describe('trackingFormat', () => {
  test('linkChip maps statuses and prefers removed_suspected', () => {
    expect(linkChip('known', false)).toBeNull();
    expect(linkChip('pending_approval', false)?.label).toBe('Chờ duyệt');
    expect(linkChip('missing', false)?.label).toBe('Chưa có link');
    expect(linkChip('not_found', false)?.label).toBe('Không tìm thấy');
    expect(linkChip('known', true)?.label).toBe('Có thể đã bị xoá');
    expect(linkChip('known', true)?.cls).toContain('red');
  });

  test('formatStatsLine handles nulls', () => {
    expect(formatStatsLine({ reactions: 3, comments: null, shares: 1 })).toBe('👍 3 · 💬 — · ↗ 1');
  });

  test('parseMinutesList', () => {
    expect(parseMinutesList('30, 120 360')).toEqual([30, 120, 360]);
    expect(parseMinutesList('')).toBeNull();
    expect(parseMinutesList('30, x')).toBeNull();
    expect(parseMinutesList('-5')).toBeNull();
    expect(formatMinutesList([30, 60])).toBe('30, 60');
  });

  test('minutesLabel', () => {
    expect(minutesLabel(30)).toBe('30 phút');
    expect(minutesLabel(120)).toBe('2 giờ');
    expect(minutesLabel(4320)).toBe('3 ngày');
  });

  test('gradeChip maps grade and score to label, tone and aria label', () => {
    expect(gradeChip('good', 82)).toMatchObject({ label: '82', tone: 'good', aria: 'Điểm 82, Tốt' });
    expect(gradeChip('fair', 55)).toMatchObject({ tone: 'fair', aria: 'Điểm 55, Trung bình' });
    expect(gradeChip('poor', 12)).toMatchObject({ tone: 'poor', aria: 'Điểm 12, Kém' });
    expect(gradeChip('insufficient', null)).toMatchObject({ label: 'chưa đủ dữ liệu', tone: 'insufficient', aria: 'Chưa đủ dữ liệu' });
  });

  test('formatBestTimes lists hours and weekdays or reports insufficient data', () => {
    const slot = (key: string, label: string) => ({ key, label, avgEngagement: 1, measured: 5 });
    expect(formatBestTimes({ hours: [slot('09', '09h'), slot('20', '20h')], weekdays: [slot('6', 'Thứ 7'), slot('7', 'Chủ nhật')], insufficient: false }))
      .toBe('Giờ nên đăng: 9h, 20h · Thứ nên đăng: Thứ 7, Chủ nhật (60 ngày gần nhất, theo giờ máy)');
    expect(formatBestTimes({ hours: [slot('21', '21h')], weekdays: [], insufficient: false })).toBe('Giờ nên đăng: 21h (60 ngày gần nhất, theo giờ máy)');
    expect(formatBestTimes({ hours: [], weekdays: [], insufficient: true })).toBe('Chưa đủ dữ liệu để gợi ý giờ đăng');
  });
});
