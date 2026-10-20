import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { LeadDetector, buildLeadsFoundPayload } from '../../services/facebookPoster/LeadDetector';
import { DEFAULT_LEAD_CONFIG, type LeadConfig } from '../../services/facebookPoster/leadRules';
import type { FbPosterComment } from '../../models/facebookPoster';
import { memoryDb } from './helpers';

const POST = 'https://www.facebook.com/groups/1/posts/1/';

function comment(n: number, text: string, over: Partial<FbPosterComment> = {}): FbPosterComment {
  return { key: `k${n}`, profileId: 'p1', postUrl: POST, authorId: `a${n}`, authorName: `Khách ${n}`, authorUrl: `u${n}`, text, commentedAt: '', commentedAtMs: null, collectedAt: 1, ...over };
}

function setup(config: Partial<LeadConfig> = {}, classify?: any) {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const emitted: { type: string; payload: any }[] = [];
  const logs: string[] = [];
  const detector = new LeadDetector({
    store, readConfig: () => ({ ...DEFAULT_LEAD_CONFIG, ...config }), classify,
    emit: (type, payload) => { emitted.push({ type, payload }); }, now: () => 5000, log: (m) => logs.push(m),
  });
  return { store, detector, emitted, logs };
}

describe('LeadDetector', () => {
  test('chỉ bình luận khớp (và có chữ) thành khách, ai_* NULL khi AI tắt', async () => {
    const { detector, store } = setup();
    const leads = await detector.process([comment(1, 'giá bao nhiêu vậy'), comment(2, 'đẹp quá'), comment(3, '   '), comment(4, 'gọi 0901234567')], { auto: false });
    expect(leads.map((l) => l.commentKey)).toEqual(['k1', 'k4']);
    expect(leads[0]).toMatchObject({ status: 'new', aiIntent: null, aiScore: null, aiReason: null, detectedAt: 5000, matched: ['giá', 'bao nhiêu'] });
    expect(leads[1].matched).toEqual(['phone']);
    expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(2);
  });

  test('AI bật: dưới ngưỡng bị loại, trên ngưỡng giữ kèm ai_*', async () => {
    const classify = jest.fn(async (items: any[]) => items.map((_, i) => (i === 0
      ? { intent: 'buy', score: 90, reason: 'muốn mua' } : { intent: 'other', score: 20, reason: 'chỉ hỏi chơi' })));
    const { detector } = setup({ aiEnabled: true, aiMinScore: 60 }, classify);
    const leads = await detector.process([comment(1, 'ib giá'), comment(2, 'giá sao')], { auto: true });
    expect(leads.map((l) => l.commentKey)).toEqual(['k1']);
    expect(leads[0]).toMatchObject({ aiIntent: 'buy', aiScore: 90, aiReason: 'muốn mua' });
  });

  test.each([
    ['ném lỗi', async () => { throw new Error('hết hạn mức'); }],
    ['trả null', async () => null],
  ])('AI %s: rơi về từ khoá, một cảnh báo', async (_n, classify) => {
    const { detector, logs } = setup({ aiEnabled: true }, classify);
    const leads = await detector.process([comment(1, 'ib giá'), comment(2, 'giá sao')], { auto: false });
    expect(leads.map((l) => [l.commentKey, l.aiScore])).toEqual([['k1', null], ['k2', null]]);
    expect(logs).toHaveLength(1);
  });

  test('aiEnabled nhưng chưa có classify: giữ từ khoá, một cảnh báo', async () => {
    const { detector, logs } = setup({ aiEnabled: true });
    expect(await detector.process([comment(1, 'ib')], { auto: false })).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  test('chia lô 20 và chỉ cảnh báo một lần khi lỗi', async () => {
    const classify = jest.fn(async (items: any[]) => items.map(() => ({ intent: 'buy', score: 99, reason: '' })));
    const { detector } = setup({ aiEnabled: true }, classify);
    const comments = Array.from({ length: 45 }, (_, i) => comment(i, 'ib'));
    expect(await detector.process(comments, { auto: false })).toHaveLength(45);
    expect(classify.mock.calls.map((c) => c[0].length)).toEqual([20, 20, 5]);

    const failing = jest.fn(async () => { throw new Error('x'); });
    const s2 = setup({ aiEnabled: true }, failing);
    expect(await s2.detector.process(comments, { auto: false })).toHaveLength(45);
    expect(s2.logs).toHaveLength(1);
  });

  test('ngữ cảnh chiến dịch / biến thể / nhóm lấy từ dòng theo dõi cùng post_url', async () => {
    const { detector, store } = setup();
    store.createTracking({
      resultId: 7, runId: 'r1', scheduleId: null, campaignId: 'c1', variant: 'B', profileId: 'p1', groupUrl: 'https://www.facebook.com/groups/1/',
      groupId: '1', postId: '1', postUrl: POST, postedAt: 1000, textHead: 'x', linkStatus: 'known', removedSuspected: false,
      lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [],
    } as any);
    const leads = await detector.process([comment(1, 'ib'), comment(2, 'ib', { postUrl: 'https://www.facebook.com/other' })], { auto: false });
    expect(leads[0]).toMatchObject({ resultId: 7, campaignId: 'c1', variant: 'B', groupUrl: 'https://www.facebook.com/groups/1/', profileId: 'p1' });
    expect(leads[1]).toMatchObject({ resultId: null, campaignId: null, variant: '', groupUrl: '' });
  });

  test('chạy hai lần không tạo khách trùng và không phát lại sự kiện', async () => {
    const { detector, emitted, store } = setup();
    const rows = [comment(1, 'ib')];
    expect(await detector.process(rows, { auto: false })).toHaveLength(1);
    expect(await detector.process(rows, { auto: false })).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(1);
  });

  test('leads.found có tối đa 3 mẫu mới nhất, không phát khi 0', async () => {
    const { detector, emitted } = setup();
    await detector.process([comment(1, 'đẹp')], { auto: true });
    expect(emitted).toHaveLength(0);
    await detector.process([1, 2, 3, 4, 5].map((n) => comment(n, `ib ${n}`)), { auto: true });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'leads.found', payload: { count: 5, auto: true } });
    expect(emitted[0].payload.samples).toEqual([
      { authorName: 'Khách 5', text: 'ib 5', postUrl: POST },
      { authorName: 'Khách 4', text: 'ib 4', postUrl: POST },
      { authorName: 'Khách 3', text: 'ib 3', postUrl: POST },
    ]);
  });

  test('không ném lỗi khi ghi hỏng hoặc emit hỏng', async () => {
    const { detector, store, logs } = setup();
    jest.spyOn(store, 'createLeads').mockImplementation(() => { throw new Error('locked'); });
    expect(await detector.process([comment(1, 'ib')], { auto: false })).toEqual([]);
    expect(logs.some((l) => l.includes('locked'))).toBe(true);
  });

  test('emit:false returns the leads without an event; buildLeadsFoundPayload aggregates', async () => {
    const { detector, emitted } = setup();
    const a = await detector.process([comment(1, 'ib giá'), comment(2, 'ib nhé')], { auto: true, emit: false });
    const b = await detector.process([comment(3, 'ib ship'), comment(4, 'ib size')], { auto: true, emit: false });
    expect(emitted).toHaveLength(0);
    const payload = buildLeadsFoundPayload([...a, ...b], true);
    expect(payload.count).toBe(4);
    expect(payload.auto).toBe(true);
    expect(payload.samples.map((x) => x.authorName)).toEqual(['Khách 4', 'Khách 3', 'Khách 2']);
  });

  test('a shared aiState skips the AI after the first failure across calls, with one warning', async () => {
    const classify = jest.fn(async () => { throw new Error('timeout'); });
    const { detector, logs } = setup({ aiEnabled: true }, classify);
    const aiState = { failed: false };
    const first = await detector.process([comment(1, 'ib giá')], { auto: true, emit: false, aiState });
    const second = await detector.process([comment(2, 'ib giá')], { auto: true, emit: false, aiState });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(logs.filter((m) => m.includes('AI không dùng được'))).toHaveLength(1);
  });
});
