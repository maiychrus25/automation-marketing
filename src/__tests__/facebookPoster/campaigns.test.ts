import { isCampaignRunnable, campaignBlockReason, validateCampaignInput } from '../../services/facebookPoster/campaigns';
import type { FbPosterCampaign } from '../../models/facebookPoster';

const camp = (over: Partial<FbPosterCampaign> = {}): FbPosterCampaign => ({
  id: 'c1', name: 'Tết', goal: '', status: 'active', startAt: null, endAt: null, createdAt: 0, updatedAt: 0, ...over,
});

describe('campaign runnable rules', () => {
  test('active without window is runnable', () => {
    expect(isCampaignRunnable(camp(), 100)).toBe(true);
    expect(campaignBlockReason(camp(), 100)).toBeNull();
  });
  test('paused and archived', () => {
    expect(isCampaignRunnable(camp({ status: 'paused' }), 100)).toBe(false);
    expect(campaignBlockReason(camp({ status: 'paused' }), 100)).toBe('Chiến dịch đang tạm dừng');
    expect(isCampaignRunnable(camp({ status: 'archived' }), 100)).toBe(false);
    expect(campaignBlockReason(camp({ status: 'archived' }), 100)).toBe('Chiến dịch đã lưu trữ');
  });
  test('window bounds are inclusive', () => {
    const c = camp({ startAt: 10, endAt: 20 });
    expect(isCampaignRunnable(c, 9)).toBe(false);
    expect(isCampaignRunnable(c, 10)).toBe(true);
    expect(isCampaignRunnable(c, 20)).toBe(true);
    expect(isCampaignRunnable(c, 21)).toBe(false);
    expect(campaignBlockReason(c, 21)).toBe('Ngoài thời gian chiến dịch');
    expect(isCampaignRunnable(camp({ startAt: 10, endAt: 10 }), 10)).toBe(true);
  });
  test('open-ended bounds', () => {
    expect(isCampaignRunnable(camp({ startAt: 10 }), 1e12)).toBe(true);
    expect(isCampaignRunnable(camp({ endAt: 10 }), 0)).toBe(true);
  });
});

describe('validateCampaignInput', () => {
  const none = () => null;
  const fails = (input: Record<string, unknown>, msg: string, opts: Parameters<typeof validateCampaignInput>[1] = { findByName: none }) =>
    expect(() => validateCampaignInput(input, opts)).toThrow(new Error(msg));

  test('defaults', () => {
    expect(validateCampaignInput({ name: '  Tết  ' }, { findByName: none }))
      .toEqual({ name: 'Tết', goal: '', startAt: null, endAt: null, status: 'active' });
  });
  test('name rules', () => {
    fails({ name: '  ' }, 'Tên chiến dịch không được để trống');
    fails({ name: 'x'.repeat(101) }, 'Tên chiến dịch tối đa 100 ký tự');
    expect(validateCampaignInput({ name: 'x'.repeat(100) }, { findByName: none }).name).toHaveLength(100);
  });
  test('duplicate name is rejected except itself', () => {
    const other = camp({ id: 'c2', name: 'tết' });
    fails({ name: 'TẾT' }, 'Tên chiến dịch đã tồn tại', { findByName: () => other });
    const existing = camp({ id: 'c2' });
    expect(validateCampaignInput({ name: 'Tết' }, { existing, findByName: () => existing }).name).toBe('Tết');
  });
  test('edit keeps old values when fields absent', () => {
    const existing = camp({ name: 'Cũ', goal: 'g', status: 'paused', startAt: 1, endAt: 5 });
    expect(validateCampaignInput({}, { existing, findByName: none }))
      .toEqual({ name: 'Cũ', goal: 'g', startAt: 1, endAt: 5, status: 'paused' });
  });
  test('window and goal', () => {
    fails({ name: 'a', startAt: 5, endAt: 4 }, 'Ngày bắt đầu phải trước ngày kết thúc');
    expect(validateCampaignInput({ name: 'a', startAt: 5, endAt: 5 }, { findByName: none }).endAt).toBe(5);
    fails({ name: 'a', goal: 'x'.repeat(1001) }, 'Mục tiêu tối đa 1000 ký tự');
    fails({ name: 'a', status: 'zzz' }, 'Trạng thái chiến dịch không hợp lệ');
    fails({ name: 'a', startAt: 'x' }, 'Ngày bắt đầu không hợp lệ');
  });
});
