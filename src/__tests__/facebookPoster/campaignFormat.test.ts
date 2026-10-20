import { campaignStatusChip, formatCampaignRange, dateInputToStartAt, dateInputToEndAt, toDateInput } from '../../ui/features/facebookPoster/campaignFormat';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('campaignFormat', () => {
  const now = at(2026, 10, 20);
  test('status chip follows status first, then the date window', () => {
    expect(campaignStatusChip({ status: 'archived', startAt: null, endAt: null }, now).label).toBe('Lưu trữ');
    expect(campaignStatusChip({ status: 'paused', startAt: null, endAt: at(2026, 1, 1) }, now).label).toBe('Tạm dừng');
    expect(campaignStatusChip({ status: 'active', startAt: at(2026, 11, 1), endAt: null }, now).label).toBe('Chưa bắt đầu');
    expect(campaignStatusChip({ status: 'active', startAt: null, endAt: at(2026, 10, 1) }, now).label).toBe('Đã kết thúc');
    expect(campaignStatusChip({ status: 'active', startAt: at(2026, 10, 1), endAt: at(2026, 10, 30) }, now)).toEqual({ label: 'Đang chạy', tone: 'success' });
    expect(campaignStatusChip({ status: 'active', startAt: null, endAt: null }, now).label).toBe('Đang chạy');
  });
  test('range text', () => {
    expect(formatCampaignRange(null, null)).toBe('Không giới hạn ngày');
    expect(formatCampaignRange(at(2026, 10, 1), at(2026, 10, 30))).toBe('01/10/2026 – 30/10/2026');
    expect(formatCampaignRange(at(2026, 10, 1), null)).toBe('Từ 01/10/2026');
    expect(formatCampaignRange(null, at(2026, 10, 30))).toBe('Đến 30/10/2026');
  });
  test('date input converts to local start and end of day and back', () => {
    const s = dateInputToStartAt('2026-10-20') as number;
    const e = dateInputToEndAt('2026-10-20') as number;
    expect(new Date(s).getHours()).toBe(0);
    expect(new Date(e).getHours()).toBe(23);
    expect(new Date(e).getMilliseconds()).toBe(999);
    expect(toDateInput(s)).toBe('2026-10-20');
    expect(toDateInput(e)).toBe('2026-10-20');
    expect(dateInputToStartAt('')).toBeNull();
    expect(dateInputToEndAt('abc')).toBeNull();
    expect(toDateInput(null)).toBe('');
  });
});
