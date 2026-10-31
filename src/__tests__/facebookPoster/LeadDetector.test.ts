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

describe('URL alias ingestion with real SQLite', () => {
  const alias = 'https://m.facebook.com/groups/1/posts/1/?fbclid=x&utm_source=campaign';
  test('one batch and stale rescans create one lead and retain attribution', async () => {
    const { store, detector, emitted } = setup();
    store.createTracking({ resultId: 7, runId: 'r1', scheduleId: null, campaignId: 'c1', variant: 'B', profileId: 'p1', groupUrl: 'g1', groupId: '1', postId: '1', postUrl: alias, postedAt: 1, textHead: '', linkStatus: 'known', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [] } as any);
    const snapshots = [store.loadCommentKeys(), store.loadCommentKeys()];
    expect(snapshots.map((keys) => keys.size)).toEqual([0, 0]);
    const row = comment(1, 'ib giá', { postUrl: alias });
    const created = store.insertCommentsReturningNew('p1', [row, { ...row, postUrl: POST }, { ...row, postUrl: `${POST}?fbclid=y` }], 1);
    expect(created).toHaveLength(1);
    expect(await detector.process(created, { auto: false })).toMatchObject([{ postUrl: alias, campaignId: 'c1', resultId: 7 }]);
    for (const postUrl of [POST, alias]) {
      expect(await detector.process(store.insertCommentsReturningNew('p2', [{ ...row, postUrl, commentedAt: '3 giờ' }], 2), { auto: true })).toEqual([]);
    }
    expect(store.listComments({ limit: 10, offset: 0 }).total).toBe(1);
    expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.samples[0].postUrl).toBe(alias);
  });

  test.each([POST, alias])('legacy raw key remains untouched and rescans stay silent: %s', async (postUrl) => {
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const row = comment(1, 'ib giá', { postUrl });
    const oldKey = `a1\u0000${postUrl}\u0000ib giá`;
    db.run('INSERT INTO fb_poster_comments (key, profile_id, post_url, author_id, text, collected_at) VALUES (?, ?, ?, ?, ?, ?)', [oldKey, 'original', postUrl, 'a1', row.text, 1]);
    const events: unknown[] = [];
    const detector = new LeadDetector({ store, readConfig: () => DEFAULT_LEAD_CONFIG, emit: (_type, payload) => events.push(payload), now: () => 5, log: () => {} });
    await detector.process([{ ...row, key: oldKey }], { auto: false });
    events.length = 0;
    const snapshots = [store.loadCommentKeys(), store.loadCommentKeys()];
    for (const keys of snapshots) expect(keys.has(`a1\u0000${POST}\u0000ib giá`)).toBe(true);
    for (const url of [POST, alias]) {
      const created = store.insertCommentsReturningNew('p2', [{ ...row, postUrl: url }], 2);
      expect(created).toEqual([]);
      expect(await detector.process(created, { auto: true })).toEqual([]);
    }
    expect(events).toEqual([]);
    expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(1);
    expect(store.listComments({ limit: 10, offset: 0 }).comments).toMatchObject([{ key: oldKey, postUrl, profileId: 'original', collectedAt: 1 }]);
  });

  test.each([
    ['https://www.facebook.com/groups/1/posts/AbC/?unknown=a%20b', 'https://m.facebook.com/groups/1/posts/AbC/?unknown=a%20b&fbclid=x'],
    ['https://www.facebook.com/groups/1/posts/AbC/?unknown=a%20b&unknown=a%2Bb&id=AbC#section', 'https://m.facebook.com/groups/1/posts/AbC/?unknown=a%20b&unknown=a%2Bb&id=AbC&fbclid=x#section'],
    ['https://www.facebook.com/groups/1/posts/AbC/', 'https://www.facebook.com/groups/1/posts/AbC/?__cft__=synthetic'],
  ])('legacy query aliases stay silent in both directions: %s', async (plain, tracked) => {
    for (const [persistedUrl, scannedUrl] of [[plain, tracked], [tracked, plain]]) {
      const db = memoryDb();
      const store = new FacebookPosterStore(db);
      store.ensureSchema();
      const oldKey = `a1\u0000${persistedUrl}\u0000ib giá`;
      db.run('INSERT INTO fb_poster_comments (key, profile_id, post_url, author_id, text, collected_at) VALUES (?, ?, ?, ?, ?, ?)', [oldKey, 'original', persistedUrl, 'a1', 'ib giá', 1]);
      const events: unknown[] = [];
      const detector = new LeadDetector({ store, readConfig: () => DEFAULT_LEAD_CONFIG, emit: (_type, payload) => events.push(payload), now: () => 5, log: () => {} });
      await detector.process([comment(1, 'ib giá', { key: oldKey, postUrl: persistedUrl })], { auto: false });
      events.length = 0;
      const created = store.insertCommentsReturningNew('rescan', [comment(1, 'ib giá', { postUrl: scannedUrl })], 2);
      expect(created).toEqual([]);
      expect(await detector.process(created, { auto: true })).toEqual([]);
      expect(events).toEqual([]);
      expect(store.listComments({ limit: 10, offset: 0 })).toMatchObject({ total: 1, comments: [{ key: oldKey, postUrl: persistedUrl, profileId: 'original', collectedAt: 1 }] });
      expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(1);
      if (plain.includes('unknown=a%20b')) {
        const distinct = store.insertCommentsReturningNew('rescan', [comment(1, 'ib giá', { postUrl: plain.replace('unknown=a%20b', 'unknown=a%2Bb') })], 3);
        expect(distinct).toHaveLength(1);
        expect(await detector.process(distinct, { auto: true })).toHaveLength(1);
      }
    }
  });

  test.each([1, 2])('deterministic alias stress round %i', async (round) => {
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const events: any[] = [];
    const detector = new LeadDetector({ store, readConfig: () => DEFAULT_LEAD_CONFIG, emit: (_type, payload) => events.push(payload), now: () => 5, log: () => {} });
    const rows = Array.from({ length: 120 }, (_, i) => comment(i, `ib ${i % 3}`, { authorId: `a${i % 10}`, postUrl: `https://www.facebook.com/groups/${round}/posts/${i}/` }));
    for (const row of rows.slice(0, 40)) {
      const url = row.postUrl.replace('www.', 'm.') + '?fbclid=legacy';
      db.run('INSERT INTO fb_poster_comments (key, profile_id, post_url, author_id, text, collected_at) VALUES (?, ?, ?, ?, ?, ?)', [`${row.authorId}\u0000${url}\u0000${row.text}`, 'legacy', url, row.authorId, row.text, 1]);
    }
    const stale = [store.loadCommentKeys(), store.loadCommentKeys()];
    expect(stale.map((keys) => keys.size)).toEqual([80, 80]);
    let inserted = 0;
    let leads = 0;
    for (let batch = 0; batch < 8; batch++) {
      const aliases = rows.flatMap((row) => ['www', 'm', 'mbasic'].map((host) => ({ ...row, postUrl: row.postUrl.replace('www.', `${host}.`) + `?fbclid=${batch}&utm_source=${round}` })));
      const created = store.insertCommentsReturningNew('new', aliases, 2);
      inserted += created.length;
      leads += (await detector.process(created, { auto: true })).length;
    }
    expect(inserted).toBe(80);
    expect(leads).toBe(80);
    expect(store.listComments({ limit: 200, offset: 0 }).total).toBe(120);
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(80);
  });
});

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

  test('buildLeadsFoundPayload gives leadIds newest first (max 20) and distinct non-null campaignIds', () => {
    const campaigns = ['c1', null, 'c2', 'c1'];
    const leads = Array.from({ length: 25 }, (_v, i) => ({ id: i + 1, campaignId: campaigns[i % 4], authorName: `A${i}`, text: 't', postUrl: 'u' })) as any[];
    const payload = buildLeadsFoundPayload(leads, false);
    expect(payload.leadIds).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
    expect(payload.campaignIds).toEqual(['c1', 'c2']);
    expect(payload.count).toBe(25);
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
