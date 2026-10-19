import { linkChip, formatStatsLine, parseMinutesList, formatMinutesList, minutesLabel } from '../../ui/features/facebookPoster/trackingFormat';

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
});
