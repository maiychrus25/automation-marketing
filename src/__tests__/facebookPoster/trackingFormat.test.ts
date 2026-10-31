import { linkChip, formatStatsLine, parseMinutesList, formatMinutesList, minutesLabel, gradeChip, formatBestTimes, missingStatsReason, followerSummary, GROUP_BY_OPTIONS, REPORT_CADENCE_OPTIONS, WEEKDAY_OPTIONS, LEAD_DIGEST_OPTIONS } from '../../ui/features/facebookPoster/trackingFormat';

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
  test('pageChipsUseSpecLabels', () => {
    expect(linkChip('missing', false, 'page')!.label).toBe('Đang tìm link');
    expect(linkChip('not_found', false, 'page')!.label).toBe('Không tìm thấy');
    expect(linkChip('missing', false)!.label).toBe('Chưa có link');
    expect(linkChip('known', false, 'page')).toBeNull();
  });

  test('group not_found title is unchanged and page title is separate', () => {
    expect(linkChip('not_found', false)!.title).toBe('Đã thử hết các mốc nhưng không thấy bài trong nhóm');
    expect(linkChip('not_found', false, 'page')!.title).toContain('Page');
  });

  test('missingStatsReason', () => {
    const row = { linkStatus: 'known' as const, targetKind: 'page' as const, statsDone: ['60m'] };
    const snap = { id: 1, resultId: 1, capturedAt: 1, reactions: 1, comments: 0, shares: 0 };
    expect(missingStatsReason(row, null)).toBe('Không có trong 10 bài gần nhất của Page');
    expect(missingStatsReason(row, snap)).toBeNull();
    expect(missingStatsReason({ ...row, statsDone: [] }, null)).toBeNull();
    expect(missingStatsReason({ ...row, linkStatus: 'missing' }, null)).toBeNull();
    expect(missingStatsReason({ ...row, targetKind: 'group' }, null)).toBeNull();
  });

  test('followerSummary', () => {
    const r = (capturedOn: string, followers: number) => ({ pageId: 'p', profileId: 'u', capturedOn, capturedAt: 0, followers });
    expect(followerSummary([])).toEqual({ current: null, change7: null, change30: null });
    expect(followerSummary([r('2026-10-01', 1000), r('2026-10-24', 1100), r('2026-10-31', 1150)])).toEqual({ current: 1150, change7: 50, change30: 150 });
    expect(followerSummary([r('2026-10-28', 1100), r('2026-10-31', 1150)])).toEqual({ current: 1150, change7: null, change30: null });
  });

  test('followerSummary uses the latest capture on or before the baseline day', () => {
    const r = (capturedOn: string, followers: number) => ({ pageId: 'p', profileId: 'u', capturedOn, capturedAt: 0, followers });
    expect(followerSummary([r('2026-10-01', 1000), r('2026-10-23', 1080), r('2026-10-31', 1150)])).toEqual({ current: 1150, change7: 70, change30: 150 });
    expect(followerSummary([r('2026-10-30', 1100), r('2026-10-31', 1150)])).toEqual({ current: 1150, change7: null, change30: null });
  });

  test('optionLists', () => {
    expect(LEAD_DIGEST_OPTIONS.map((o) => o.value)).toEqual([0, 15, 30, 60, 120, 240]);
    expect(LEAD_DIGEST_OPTIONS[0].label).toBe('Gửi ngay');
    expect(WEEKDAY_OPTIONS).toHaveLength(7);
    expect(WEEKDAY_OPTIONS[0]).toEqual({ value: 1, label: 'Thứ 2' });
    expect(WEEKDAY_OPTIONS[6].label).toBe('Chủ nhật');
    expect(REPORT_CADENCE_OPTIONS.map((o) => o.value)).toEqual(['off', 'daily', 'weekly']);
    expect(GROUP_BY_OPTIONS).toContainEqual({ value: 'page', label: 'Page' });
  });
});
