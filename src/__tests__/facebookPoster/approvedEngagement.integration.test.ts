import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createEngagementOperations } from '../../services/facebookPoster/engagementOperations';
import { EngagementPoster } from '../../services/facebookPoster/EngagementPoster';
import { ENGAGEMENT_TTL_MS } from '../../services/facebookPoster/engagementRules';
import { buildMetricsReport } from '../../services/facebookPoster/NotificationScheduler';
import { createControlMethods, describe as describeMethods, type ControlMethodDeps } from '../../services/control/ControlMethods';
import type { CommentOutcome } from '../../services/facebookPoster/firstComment';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';

// One in-memory DB; store, operations, limiter, poster and Control methods are real. Only the Facebook page/comment poster is a fake.
// Electron IPC wiring (engagement:approve calls ops.approve) is covered by the unit tests; here the IPC path is `ops.approve`.
const ZONE = 'Asia/Ho_Chi_Minh';
const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const clock: LocalClock = { date: (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; }, minutes: (ms) => { const p = parts(ms); return Number(p.hour) * 60 + Number(p.minute); } };
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 3, 0); // 10:00 local, outside quiet hours

function world(outcome: CommentOutcome = { status: 'posted', reason: '' }) {
    const h = { now: T0, master: false };
    const db = memoryDb();
    const store = new FacebookPosterStore(db); store.ensureSchema();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock, protectedWritesEnabled: () => h.master });
    limiter.ensureSchema(); // policy untouched: enabled=false, protectedWritesEnabled=false
    const posted: { postUrl: string; comment: string; text: string }[] = [];
    const events: { type: string; payload: any }[] = [];
    const poster = new EngagementPoster({
        store, limiter, now: () => h.now,
        openSession: async () => ({ page: {} as any, close: async () => undefined }),
        postComment: async (_page, input) => { posted.push(input); return outcome; },
        emit: (type, payload) => events.push({ type, payload }),
        schedule: () => () => undefined,
    });
    const ops = createEngagementOperations({
        store, limiter: () => limiter, now: () => h.now, emit: (type, payload) => events.push({ type, payload }),
        profileExists: (id) => id === 'p1', enqueuePost: (id) => poster.enqueue(id),
    });
    const readCalls: unknown[] = [];
    const engagement = { suggest: (p: any) => ops.suggest(p), list: (p?: any) => ops.list(p), withdraw: (p: any) => ops.withdraw(p), markResearched: (p: any) => ops.markResearched(p),
        readComments: (p: any) => { readCalls.push(p); return { comments: [] }; } };
    const stub = new Proxy({}, { get: () => () => undefined });
    const methods = createControlMethods({ poster: stub, research: stub, tracking: stub, campaigns: stub, leads: stub, videos: stub, engagement } as unknown as ControlMethodDeps);
    const call = (name: string, p: any = {}): Promise<any> => methods.find((m) => m.name === name)!.run(p, { principal: { kind: 'legacy', keyId: 'owner' }, assertCurrent() {} } as any);
    let seq = 0;
    const suggestion = (over: Record<string, unknown> = {}) => { seq += 1; return { profileId: 'p1', kind: 'comment', postUrl: `https://www.facebook.com/groups/g1/posts/${seq}/`, postExcerpt: 'Bai ve giay chay bo', text: 'Bài này hữu ích quá, cảm ơn bạn', reason: 'Dung chu de', ...over }; };
    const rows = () => db.query<any>('SELECT * FROM fb_poster_engagement_items ORDER BY id');
    const used = (action: string) => db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM autonomy_actions WHERE action = ? AND status = 'used'", [action])!.n;
    return { h, db, store, limiter, ops, poster, methods, call, posted, events, readCalls, suggestion, rows, used };
}

test('suggestApprovePostEndToEnd', async () => {
    const w = world();
    const { id, status } = await w.call('engagement.suggest', w.suggestion());
    expect(status).toBe('pending');
    expect(w.posted).toEqual([]); // nothing is posted without approval
    expect(w.used('engagement_suggest')).toBe(1);

    w.ops.approve(id, '  Mình đã sửa lại câu này  '); // the IPC engagement:approve path
    await w.poster.whenIdle();
    expect(w.posted).toEqual([{ postUrl: 'https://www.facebook.com/groups/g1/posts/1/', comment: 'Mình đã sửa lại câu này', text: 'Bai ve giay chay bo' }]);
    expect(w.rows()[0]).toMatchObject({ status: 'posted', approved_text: 'Mình đã sửa lại câu này', posted_at: T0 });
    expect(w.used('engagement_comment')).toBe(1);
    expect(w.events.map((e) => e.type)).toEqual(['engagement.suggested', 'engagement.decided', 'engagement.finished']);

    const report = buildMetricsReport(w.store, { key: '2026-11-03', label: '03/11', from: T0 - HOUR, to: T0 + 24 * HOUR }, 'daily', () => 'Page', (a, b) => w.limiter.summary(a, b));
    expect((report as any).commentSuggestions).toEqual({ suggested: 1, approved: 1, posted: 1, rejected: 0, expired: 0 });
    expect(w.limiter.usage().profiles.p1).toMatchObject({ engagementSuggestions: 1, engagementComments: 1, facebookActions: 1 });
});

test('botPathNeverReachesApproved', async () => {
    const w = world();
    const names = w.methods.map((m) => m.name).filter((n) => n.startsWith('engagement.'));
    expect(names.sort()).toEqual(['engagement.list', 'engagement.markResearched', 'engagement.readComments', 'engagement.suggest', 'engagement.withdraw']);
    expect((describeMethods(w.methods).methods as any[]).filter((m) => m.name.startsWith('engagement.')).length).toBe(names.length);
    const { id } = await w.call('engagement.suggest', w.suggestion());
    const extras: Record<string, unknown>[] = [{}, { status: 'approved' }, { approvedText: 'x' }, { status: 'approved', approvedText: 'x', decidedAt: 1 }];
    const valid: Record<string, Record<string, unknown>> = {
        'engagement.suggest': w.suggestion(), 'engagement.list': { status: 'pending' }, 'engagement.withdraw': { id },
        'engagement.readComments': { profileId: 'p1', postUrl: 'https://www.facebook.com/groups/g1/posts/1/' }, 'engagement.markResearched': { profileIds: ['p1'] },
    };
    for (const name of names) for (const extra of extras) { try { await w.call(name, { ...valid[name], ...extra }); } catch { /* refusing is fine; reaching approved is not */ } }
    await w.poster.whenIdle();
    for (const row of w.rows()) {
        expect(['pending', 'rejected', 'expired']).toContain(row.status);
        expect(row.approved_text).toBe('');
    }
    expect(w.rows().some((r) => ['approved', 'posting', 'posted'].includes(r.status))).toBe(false);
    expect(w.posted).toEqual([]);
    expect(w.used('engagement_comment')).toBe(0);
    // reply is refused until the reply routine exists
    await expect(w.call('engagement.suggest', w.suggestion({ kind: 'reply' }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

test('expiryAndCapsShareLedger', async () => {
    const w = world();
    // 24h expiry: an unapproved suggestion cannot be approved afterwards.
    const { id: stale } = await w.call('engagement.suggest', w.suggestion());
    w.h.now = T0 + ENGAGEMENT_TTL_MS + 1;
    expect(() => w.ops.approve(stale)).toThrow();
    expect(w.rows()[0].status).toBe('expired');
    w.h.now = T0;

    // 20 suggestions per day per profile (the expired one counted), the 21st is refused.
    for (let i = 0; i < 19; i += 1) await w.call('engagement.suggest', w.suggestion());
    await expect(w.call('engagement.suggest', w.suggestion())).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(w.used('engagement_suggest')).toBe(20);

    // facebookActionsPerDay (12) is shared: 4 lead replies + 8 approvals fill it, the 9th approval is refused although the engagement cap is 10.
    w.h.master = true; w.limiter.setPolicy({ enabled: true }, 'test'); // bot lead replies need the switches; engagement never did
    for (let i = 0; i < 4; i += 1) { const r = w.limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1' }); w.limiter.commit(r!); }
    const pending = w.rows().filter((r) => r.status === 'pending');
    expect(pending.length).toBeGreaterThanOrEqual(10);
    for (const row of pending.slice(0, 8)) w.ops.approve(row.id);
    await w.poster.whenIdle();
    expect(w.used('engagement_comment')).toBe(8);
    expect(() => w.ops.approve(pending[8].id)).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED' }));
    expect(w.rows().find((r) => r.id === pending[8].id)!.status).toBe('pending');

    // Raising the shared cap exposes the engagement cap of 10: 2 more approvals, then the 11th is refused.
    w.limiter.setPolicy({ facebookActionsPerDay: 50 }, 'test');
    for (const row of pending.slice(8, 10)) w.ops.approve(row.id);
    await w.poster.whenIdle();
    expect(w.used('engagement_comment')).toBe(10);
    expect(() => w.ops.approve(pending[10].id)).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED' }));
});
