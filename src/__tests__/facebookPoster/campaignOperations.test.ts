import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { createCampaignOperations } from '../../services/facebookPoster/campaignOperations';
import { memoryDb } from './helpers';

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();

function setup() {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  let seq = 0;
  const reschedule = jest.fn();
  const ops = createCampaignOperations({ store: () => store, now: () => NOW, newId: () => `c${++seq}`, reschedule });
  const schedule = (id: string, campaignId: string | null, draft = false) =>
    store.createSchedule({ id, name: id, kind: 'once', params: {}, runAt: NOW + 1, days: [], time: '', enabled: !draft, nextRunAt: draft ? null : NOW + 1, createdAt: NOW, draft, campaignId });
  return { store, ops, reschedule, schedule };
}

describe('campaignOperations', () => {
  test('create trả hình dạng spec và gọi reschedule', () => {
    const { ops, reschedule } = setup();
    const { campaign } = ops.create({ name: '  Tết  ', goal: 'Bán hàng' });
    expect(campaign).toEqual({
      id: 'c1', name: 'Tết', goal: 'Bán hàng', status: 'active', startAt: null, endAt: null, createdAt: NOW, updatedAt: NOW,
      scheduleCount: 0, draftCount: 0, runnable: true, summary: null,
    });
    expect(reschedule).toHaveBeenCalledTimes(1);
  });

  test('create từ chối tên trùng và khoảng ngày sai, không gọi reschedule', () => {
    const { ops, reschedule } = setup();
    ops.create({ name: 'Tết' });
    reschedule.mockClear();
    expect(() => ops.create({ name: 'tết ' })).toThrow('Tên chiến dịch đã tồn tại');
    expect(() => ops.create({ name: 'B', startAt: 10, endAt: 5 })).toThrow('Ngày bắt đầu phải trước ngày kết thúc');
    expect(reschedule).not.toHaveBeenCalled();
  });

  test('update đổi trạng thái, khoảng ngày (null bỏ giới hạn), runnable theo đó', () => {
    const { ops, reschedule } = setup();
    ops.create({ name: 'A', startAt: NOW + 1000 });
    expect(ops.get({ id: 'c1' }).campaign.runnable).toBe(false);
    reschedule.mockClear();
    const { campaign } = ops.update({ id: 'c1', startAt: null, status: 'paused' });
    expect([campaign.startAt, campaign.status, campaign.runnable]).toEqual([null, 'paused', false]);
    expect(ops.update({ id: 'c1', status: 'active' }).campaign.runnable).toBe(true);
    expect(reschedule).toHaveBeenCalledTimes(2);
    expect(() => ops.update({ id: 'nope', name: 'x' })).toThrow('Không tìm thấy chiến dịch');
    expect(() => ops.update({ id: 'c1', status: 'bad' })).toThrow('Trạng thái chiến dịch không hợp lệ');
  });

  test('list mặc định bỏ archived, lọc theo status, kèm số lịch / nháp', () => {
    const { ops, schedule } = setup();
    ops.create({ name: 'A' }); ops.create({ name: 'B' });
    ops.update({ id: 'c2', status: 'archived' });
    schedule('s1', 'c1'); schedule('d1', 'c1', true);
    const all = ops.list().campaigns;
    expect(all.map((c) => c.id)).toEqual(['c1']);
    expect([all[0].scheduleCount, all[0].draftCount]).toEqual([1, 1]);
    expect(ops.list({ status: 'archived' }).campaigns.map((c) => c.id)).toEqual(['c2']);
    expect(() => ops.list({ status: 'x' })).toThrow('Trạng thái chiến dịch không hợp lệ');
  });

  test('get kèm danh sách lịch của chiến dịch', () => {
    const { ops, schedule } = setup();
    ops.create({ name: 'A' });
    schedule('s1', 'c1'); schedule('d1', 'c1', true); schedule('other', null);
    const { schedules } = ops.get({ id: 'c1' }).campaign;
    expect(schedules.map((s) => s.id).sort()).toEqual(['d1', 's1']);
    expect(schedules.find((s) => s.id === 'd1')).toEqual({ id: 'd1', name: 'd1', kind: 'once', enabled: false, draft: true, nextRunAt: null });
    expect(() => ops.get({ id: '' })).toThrow('Không tìm thấy chiến dịch');
  });

  test('delete bị từ chối khi còn lịch hoặc nháp, được khi trống', () => {
    const { ops, store, schedule, reschedule } = setup();
    ops.create({ name: 'A' });
    schedule('s1', 'c1'); schedule('d1', 'c1', true);
    reschedule.mockClear();
    expect(() => ops.delete({ id: 'c1' })).toThrow('Chiến dịch còn 2 lịch/bài nháp, hãy chuyển hoặc xoá trước');
    expect(reschedule).not.toHaveBeenCalled();
    store.deleteSchedule('s1'); store.deleteSchedule('d1');
    expect(ops.delete({ id: 'c1' })).toEqual({ deleted: true });
    expect(store.getCampaign('c1')).toBeNull();
    expect(reschedule).toHaveBeenCalledTimes(1);
  });

  test('summary lấy từ báo cáo groupBy campaign kể từ lúc tạo chiến dịch', () => {
    const { ops, store } = setup();
    ops.create({ name: 'A' });
    store.createTracking({
      resultId: 1, runId: 'r1', scheduleId: null, campaignId: 'c1', profileId: 'p1', groupUrl: 'g', groupId: '1', postId: 'x',
      postUrl: null, postedAt: NOW, textHead: 't', linkStatus: 'missing', removedSuspected: false, lastSeenAt: null,
      lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [],
    } as any);
    const { summary } = ops.get({ id: 'c1' }).campaign;
    expect(summary).toMatchObject({ key: 'c1', label: 'A', posts: 1, insufficient: true });
  });
});
