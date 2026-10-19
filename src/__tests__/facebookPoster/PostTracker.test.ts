import { ResearchError } from '../../services/research/graphqlSession';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PostTracker, MAX_TRACK_GROUPS } from '../../services/facebookPoster/PostTracker';
import { DEFAULT_POST_TRACKING_CONFIG, normalizeHead } from '../../services/facebookPoster/postTracking';
import { memoryDb } from './helpers';

// Bảng tin giả: khoá "<groupId>|<cursor>" -> kết quả đọc (hoặc Error để call() ném).
const feeds: Record<string, any> = {};
jest.mock('../../services/research/parsers', () => ({
    ...jest.requireActual('../../services/research/parsers'),
    parseGroupFeed: (text: string) => feeds[text] ?? { items: [], endCursor: null, errorCode: null },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const G1 = 'https://www.facebook.com/groups/111/';
const G2 = 'https://www.facebook.com/groups/222/';
const UID = 'u1';
const TEXT = 'Bán hàng giá rẻ hôm nay';

function item(fbId: string, postedAt: number, over: Record<string, unknown> = {}) {
    return {
        kind: 'post', fbId, url: `https://www.facebook.com/groups/111/posts/${fbId}/`, title: TEXT, authorId: UID, postedAt,
        reactions: 5, comments: 2, shares: 1, ...over,
    };
}
const page = (items: any[], endCursor: string | null = null) => ({ items, endCursor, errorCode: null });

function setup(opts: { sessionFor?: (profileId: string) => any; busyOnAcquire?: boolean; random?: () => number } = {}) {
    const store = new FacebookPosterStore(memoryDb());
    store.ensureSchema();
    const events: { type: string; payload: any }[] = [];
    const sleeps: number[] = [];
    const closes: string[] = [];
    const opened: string[] = [];
    const calls: string[] = [];
    const slot = { acquire: jest.fn(() => { if (opts.busyOnAcquire) throw new Error(BUSY_ERROR); }), release: jest.fn() };
    const observeLogin = jest.fn();
    const sleep = jest.fn(async (ms: number) => { sleeps.push(ms); });
    const tracker = new PostTracker({
        store,
        openSession: async (profileId: string) => {
            opened.push(profileId);
            const custom = opts.sessionFor?.(profileId);
            const session = custom ?? {
                open: async () => undefined,
                userId: () => UID,
                ensureQuery: jest.fn(async (_s: string, _n: string, url: string) => ({
                    friendlyName: 'Q', docId: 'd', variables: /groups\/111/.test(url) ? { id: '111', cursor: null, count: 10 } : { id: '222', cursor: null, count: 10 },
                })),
                recapture: async () => ({ friendlyName: 'Q', docId: 'd2', variables: { id: '111', cursor: null, count: 10 } }),
                call: jest.fn(async (_q: any, vars: any) => {
                    const key = `${vars.id ?? vars.groupID}|${vars.cursor}`;
                    calls.push(key);
                    const f = feeds[key];
                    if (f instanceof Error) throw f;
                    return key;
                }),
            };
            return { session, close: async () => { closes.push(profileId); } };
        },
        slot,
        observeLogin,
        emit: (type, payload) => { events.push({ type, payload }); },
        now: () => NOW,
        sleep,
        random: opts.random ?? (() => 0),
        newId: () => 'job1',
    });
    return { store, tracker, events, sleeps, closes, opened, calls, slot, observeLogin, sleep };
}

let seq = 0;
function addRow(store: FacebookPosterStore, over: Record<string, unknown> = {}) {
    const id = ++seq;
    store.createTracking({
        resultId: id, runId: 'r', scheduleId: null, profileId: 'p1', groupUrl: G1, groupId: '', postId: '', postUrl: null,
        postedAt: NOW - 3 * HOUR, textHead: normalizeHead(TEXT), linkStatus: 'missing', removedSuspected: false, lastSeenAt: null,
        lastCheckedAt: null, checkCount: 0, nextCheckAt: NOW - 1, statsDone: [], ...over,
    } as any);
    return id;
}
const rowOf = (store: FacebookPosterStore, id: number) => store.listTracking({}).find((r) => r.resultId === id)!;
const finished = (events: any[]) => events.filter((e) => e.type === 'posts.trackFinished');

async function run(h: ReturnType<typeof setup>, params: any = {}) {
    const res = h.tracker.track(params);
    await h.tracker.whenIdle();
    return res;
}

beforeEach(() => { for (const k of Object.keys(feeds)) delete feeds[k]; });

describe('matching and linking', () => {
    test('links a pending-approval post by author, time and first 60 chars', async () => {
        const h = setup();
        const id = addRow(h.store, { linkStatus: 'pending_approval' });
        feeds['111|null'] = page([item('f9', NOW - 3 * HOUR + 5 * MIN), item('other', NOW - 3 * HOUR, { authorId: 'u2' })]);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({
            postId: 'f9', linkStatus: 'known', postUrl: 'https://www.facebook.com/groups/111/posts/f9/', checkCount: 0,
            lastSeenAt: NOW, lastCheckedAt: NOW, groupId: '111',
        });
        expect(h.store.latestStats([id])[0]).toMatchObject({ reactions: 5, comments: 2, shares: 1, capturedAt: NOW });
        expect(finished(h.events)[0].payload).toMatchObject({ checked: 1, found: 1, linked: 1, removedSuspected: 0, notFound: 0, errors: 0 });
    });

    test('does not link another author, a 3 h time gap, or a different text', async () => {
        const h = setup();
        const id = addRow(h.store);
        feeds['111|null'] = page([
            item('a', NOW - 3 * HOUR, { authorId: 'u2' }), item('b', NOW), item('c', NOW - 3 * HOUR, { title: 'Nội dung khác hẳn' }),
            item('old', NOW - 10 * HOUR),
        ]);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({ postId: '', linkStatus: 'missing' });
        expect(h.store.latestStats([id])).toEqual([]);
    });

    test('two rows with the same text do not claim the same feed item', async () => {
        const h = setup();
        const a = addRow(h.store, { postedAt: NOW - 3 * HOUR });
        const b = addRow(h.store, { postedAt: NOW - 3 * HOUR - 30 * MIN });
        feeds['111|null'] = page([item('only', NOW - 3 * HOUR - 10 * MIN)]);
        await run(h);
        expect([rowOf(h.store, a).postId, rowOf(h.store, b).postId].filter(Boolean)).toEqual(['only']);
    });

    test('known post is measured by post_id, no text matching needed', async () => {
        const h = setup();
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', postUrl: 'https://x/p1', textHead: 'khác', lastSeenAt: 1, postedAt: NOW - 90 * MIN });
        feeds['111|null'] = page([item('P1', NOW - 90 * MIN, { title: 'đã sửa nội dung', reactions: 9, comments: null, shares: null })]);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({ postUrl: 'https://x/p1', lastSeenAt: NOW });
        expect(h.store.latestStats([id])[0]).toMatchObject({ reactions: 9, comments: null });
        expect(finished(h.events)[0].payload).toMatchObject({ found: 1, linked: 0 });
    });

    test('one measurement marks ALL due milestones and recomputes next_check_at', async () => {
        const h = setup();
        const postedAt = NOW - 2 * DAY; // mốc 60m và 1440m đã đến hạn, 4320m chưa
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', postedAt, lastSeenAt: 1, statsDone: [] });
        feeds['111|null'] = page([item('P1', postedAt), item('older', postedAt - 2 * HOUR)]);
        await run(h);
        const r = rowOf(h.store, id);
        expect(r.statsDone.sort()).toEqual(['1440m', '60m']);
        expect(r.nextCheckAt).toBe(postedAt + 4320 * MIN);
    });

    test('a not-yet-due row that is seen anyway is still linked and measured', async () => {
        const h = setup();
        const id = addRow(h.store, { nextCheckAt: NOW + DAY });
        feeds['111|null'] = page([item('f1', NOW - 3 * HOUR)]);
        await run(h, { sinceDays: 3 });
        expect(rowOf(h.store, id).linkStatus).toBe('known');
    });
});

describe('conclusions (spec 4.3 steps 4-5)', () => {
    test('removed_suspected only when the feed was read past the post time', async () => {
        const h = setup();
        const id = addRow(h.store, { linkStatus: 'known', postId: 'GONE', lastSeenAt: 1, postedAt: NOW - 5 * HOUR });
        feeds['111|null'] = page([item('x', NOW - 6 * HOUR)]);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({ removedSuspected: true, nextCheckAt: null });
        expect(finished(h.events)[0].payload.removedSuspected).toBe(1);
    });

    test('early stop (page limit) concludes nothing and only updates last_checked_at', async () => {
        const h = setup();
        const known = addRow(h.store, { linkStatus: 'known', postId: 'GONE', lastSeenAt: 1, postedAt: NOW - 20 * HOUR });
        const missing = addRow(h.store, { postedAt: NOW - 20 * HOUR });
        for (let i = 0; i < 12; i++) feeds[`111|${i === 0 ? 'null' : 'c' + i}`] = page([item('n' + i, NOW - HOUR)], 'c' + (i + 1));
        await run(h);
        expect(h.calls).toHaveLength(10);
        expect(rowOf(h.store, known)).toMatchObject({ removedSuspected: false, lastCheckedAt: NOW });
        expect(rowOf(h.store, missing)).toMatchObject({ linkStatus: 'missing', checkCount: 0, lastCheckedAt: NOW });
        expect(finished(h.events)[0].payload).toMatchObject({ removedSuspected: 0, notFound: 0 });
    });

    test('missing row read past: check_count grows and next retry milestone is scheduled', async () => {
        const h = setup();
        const postedAt = NOW - 3 * HOUR;
        const id = addRow(h.store, { postedAt });
        feeds['111|null'] = page([item('x', postedAt - 2 * HOUR, { title: 'bài khác' })]);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', checkCount: 1, nextCheckAt: postedAt + 360 * MIN });
    });

    test('not_found past the last retry milestone when read past; next_check_at null', async () => {
        const h = setup();
        const postedAt = NOW - 8 * DAY;
        const id = addRow(h.store, { postedAt, linkStatus: 'pending_approval' });
        feeds['111|null'] = page([item('x', postedAt - 2 * HOUR, { title: 'bài khác' })]);
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }] });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'not_found', nextCheckAt: null, checkCount: 1 });
        expect(finished(h.events)[0].payload.notFound).toBe(1);
    });

    test('past the last milestone but not read past: stays missing, no endless due loop', async () => {
        const h = setup();
        const postedAt = NOW - 8 * DAY;
        const id = addRow(h.store, { postedAt });
        feeds['111|null'] = page([item('x', NOW - HOUR)]);
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }] });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', checkCount: 0, nextCheckAt: null });
    });

    test('seen again after being suspected removed -> recovered', async () => {
        const h = setup();
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', lastSeenAt: 1, removedSuspected: true, postedAt: NOW - HOUR });
        feeds['111|null'] = page([item('P1', NOW - HOUR)]);
        await run(h);
        expect(rowOf(h.store, id).removedSuspected).toBe(false);
    });
});

describe('reading bounds and pauses', () => {
    test('stops at an item older than min(posted_at) - 1 h', async () => {
        const h = setup();
        addRow(h.store, { postedAt: NOW - 5 * HOUR });
        feeds['111|null'] = page([item('a', NOW - HOUR)], 'c1');
        feeds['111|c1'] = page([item('b', NOW - 7 * HOUR)], 'c2');
        feeds['111|c2'] = page([item('c', NOW - 9 * HOUR)], 'c3');
        await run(h);
        expect(h.calls).toEqual(['111|null', '111|c1']);
    });

    test('stops on repeated cursor, on no cursor, and after 2 consecutive empty pages', async () => {
        const h = setup();
        addRow(h.store);
        feeds['111|null'] = page([item('a', NOW - HOUR)], 'c1');
        feeds['111|c1'] = page([item('b', NOW - HOUR)], 'c1');
        await run(h);
        expect(h.calls).toEqual(['111|null', '111|c1']);

        const h2 = setup();
        addRow(h2.store);
        feeds['111|null'] = page([], 'c1');
        feeds['111|c1'] = page([], 'c2');
        feeds['111|c2'] = page([item('z', NOW - HOUR)], null);
        await run(h2);
        expect(h2.calls).toEqual(['111|null', '111|c1']);
    });

    test('sleeps 3-6 s between pages and 8-15 s between pairs, never after the last', async () => {
        const lo = setup({ random: () => 0 });
        addRow(lo.store); addRow(lo.store, { groupUrl: G2 });
        feeds['111|null'] = page([item('a', NOW - HOUR)], 'c1');
        feeds['111|c1'] = page([item('b', NOW - 9 * HOUR)], 'c2');
        feeds['222|null'] = page([], null);
        await run(lo);
        expect(lo.sleeps).toEqual([3000, 8000]);

        const hi = setup({ random: () => 1 });
        addRow(hi.store); addRow(hi.store, { groupUrl: G2 });
        await run(hi);
        expect(hi.sleeps).toEqual([6000, 15000]);
    });

    test('slug group goes through prepareGroupFeed (fresh capture, captured id)', async () => {
        const SLUG = 'https://www.facebook.com/groups/my.slug/';
        const ensureQuery = jest.fn(async () => ({ friendlyName: 'Q', docId: 'd', variables: { groupID: '777', cursor: null, count: 10 } }));
        const h = setup({
            sessionFor: () => ({
                open: async () => undefined, userId: () => UID, ensureQuery,
                recapture: async () => { throw new Error('no'); },
                call: async (_q: any, vars: any) => `${vars.groupID}|${vars.cursor}`,
            }),
        });
        const id = addRow(h.store, { groupUrl: SLUG });
        feeds['777|null'] = page([item('s1', NOW - 3 * HOUR)]);
        await run(h);
        expect(ensureQuery).toHaveBeenCalledWith('group_feed', expect.any(String), expect.stringContaining('/groups/my.slug/'), true);
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'known', postId: 's1', groupId: '777' });
    });
});

describe('errors', () => {
    const twoProfiles = (h: ReturnType<typeof setup>) => {
        addRow(h.store, { profileId: 'p1' });
        addRow(h.store, { profileId: 'p1', groupUrl: G2 });
        addRow(h.store, { profileId: 'p2' });
    };
    const failingSession = (code: any) => ({
        open: async () => { throw new ResearchError(code, code); },
        userId: () => UID, ensureQuery: jest.fn(), recapture: jest.fn(), call: jest.fn(),
    });

    test('logged_out/checkpoint: observeLogin once and skip the profile\'s remaining pairs only', async () => {
        for (const code of ['logged_out', 'checkpoint']) {
            const h = setup({ sessionFor: (p) => (p === 'p1' ? failingSession(code) : undefined) });
            twoProfiles(h);
            feeds['111|null'] = page([item('ok', NOW - 3 * HOUR)]);
            await run(h);
            expect(h.observeLogin).toHaveBeenCalledTimes(1);
            expect(h.observeLogin).toHaveBeenCalledWith('p1', code);
            expect(h.opened.filter((p) => p === 'p1')).toHaveLength(1);
            expect(h.opened).toContain('p2');
            expect(finished(h.events)[0].payload.errors).toBe(1);
        }
    });

    test('rate_limited skips the profile\'s remaining pairs without observeLogin', async () => {
        const h = setup({ sessionFor: (p) => (p === 'p1' ? failingSession('rate_limited') : undefined) });
        twoProfiles(h);
        await run(h);
        expect(h.observeLogin).not.toHaveBeenCalled();
        expect(h.opened.filter((p) => p === 'p1')).toHaveLength(1);
        expect(h.opened).toContain('p2');
    });

    test('unresolved/query_changed/unexpected errors are recorded per pair and the job continues', async () => {
        const h = setup({
            sessionFor: (p) => (p === 'p2' ? {
                open: async () => undefined, userId: () => UID,
                ensureQuery: async () => { throw new ResearchError('query_changed', 'x'); }, recapture: jest.fn(), call: jest.fn(),
            } : undefined),
        });
        addRow(h.store, { profileId: 'p2' });
        addRow(h.store, { profileId: 'p3' });
        const ok = addRow(h.store, { profileId: 'p1' });
        feeds['111|null'] = page([item('good', NOW - 3 * HOUR)]);
        const origOpen = (h.tracker as any).deps.openSession;
        (h.tracker as any).deps.openSession = async (p: string) => { if (p === 'p3') throw new Error('Profile đang mở'); return origOpen(p); };
        await run(h);
        const last = h.tracker.status().last!;
        expect(last.errors.map((e) => e.profileId).sort()).toEqual(['p2', 'p3']);
        expect(last.errors.find((e) => e.profileId === 'p2')!.error).toBe('unresolved');
        expect(rowOf(h.store, ok).linkStatus).toBe('known');
        expect(h.observeLogin).not.toHaveBeenCalled();
        expect(h.closes).toContain('p2');
    });

    test('session is closed in finally when reading throws', async () => {
        const h = setup({ sessionFor: () => ({ ...failingSession('parse_failed'), open: async () => undefined, ensureQuery: async () => { throw new Error('boom'); } }) });
        addRow(h.store);
        await run(h);
        expect(h.closes).toEqual(['p1']);
        expect(h.tracker.status().last!.errors[0].error).toBe('boom');
    });

    test('first page parse error is a pair error with shape diagnostics and no conclusions', async () => {
        const h = setup();
        const id = addRow(h.store);
        feeds['111|null'] = { items: [], endCursor: null, errorCode: 'parse_failed' };
        await run(h);
        expect(h.tracker.status().last!.errors).toHaveLength(1);
        expect(h.tracker.status().last!.shape).toBeDefined();
        expect(rowOf(h.store, id)).toMatchObject({ checkCount: 0, lastCheckedAt: null });
    });
});

describe('slot, status, events and cancel', () => {
    test('holds the slot for the whole job; second track and poster-busy both throw BUSY', async () => {
        const h = setup();
        addRow(h.store);
        feeds['111|null'] = page([item('a', NOW - 3 * HOUR)]);
        h.tracker.track();
        expect(h.slot.acquire).toHaveBeenCalledTimes(1);
        expect(h.slot.release).not.toHaveBeenCalled();
        expect(h.tracker.isRunning()).toBe(true);
        expect(() => h.tracker.track()).toThrow(BUSY_ERROR);
        await h.tracker.whenIdle();
        expect(h.slot.release).toHaveBeenCalledTimes(1);
        expect(h.tracker.isRunning()).toBe(false);

        const busy = setup({ busyOnAcquire: true });
        expect(() => busy.tracker.track()).toThrow(BUSY_ERROR);
        expect(busy.tracker.isRunning()).toBe(false);
        expect(busy.slot.release).not.toHaveBeenCalled();
    });

    test('status and events: progress, finished exactly once with auto flag', async () => {
        const h = setup();
        addRow(h.store); addRow(h.store, { groupUrl: G2 });
        const { jobId, pairs } = h.tracker.track({ auto: true });
        expect(jobId).toBe('job1');
        expect(pairs).toHaveLength(2);
        expect(h.tracker.status()).toMatchObject({ running: true, jobId: 'job1', progress: { done: 0, total: 2 } });
        await h.tracker.whenIdle();
        expect(h.events.filter((e) => e.type === 'posts.trackProgress').map((e) => e.payload)).toEqual([
            { jobId: 'job1', done: 1, total: 2 }, { jobId: 'job1', done: 2, total: 2 },
        ]);
        expect(finished(h.events)).toHaveLength(1);
        expect(finished(h.events)[0].payload).toMatchObject({ jobId: 'job1', auto: true, groups: 2, errors: 0, cancelled: false });
        const st = h.tracker.status();
        expect(st).toMatchObject({ running: false, jobId: null, progress: { done: 2, total: 2 } });
        expect(st.last).toMatchObject({ jobId: 'job1', auto: true, finishedAt: NOW, groups: 2, errors: [] });
    });

    test('a throwing emit does not break the job', async () => {
        const h = setup();
        (h.tracker as any).deps.emit = () => { throw new Error('listener'); };
        addRow(h.store);
        await run(h);
        expect(h.tracker.status().last).not.toBeNull();
        expect(h.slot.release).toHaveBeenCalledTimes(1);
    });

    test('cancel stops after the current page, closes the session, finishes once with cancelled', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const h = setup();
        (h.tracker as any).sleepFn = () => gate;
        addRow(h.store, { postedAt: NOW - 20 * HOUR });
        addRow(h.store, { groupUrl: G2 });
        feeds['111|null'] = page([item('a', NOW - HOUR)], 'c1');
        feeds['111|c1'] = page([item('b', NOW - HOUR)], 'c2');
        h.tracker.track();
        await new Promise((r) => setImmediate(r));
        expect(h.calls).toEqual(['111|null']);
        expect(h.tracker.cancel()).toBe(true);
        await h.tracker.whenIdle();
        release();
        expect(h.calls).toEqual(['111|null']);
        expect(h.opened).toEqual(['p1']);
        expect(h.closes).toEqual(['p1']);
        expect(finished(h.events)).toHaveLength(1);
        expect(finished(h.events)[0].payload.cancelled).toBe(true);
        expect(h.tracker.cancel()).toBe(false);
    });
});

describe('selection', () => {
    test('caps at 30 pairs, pending first then least recently checked; filters apply', async () => {
        const h = setup();
        for (let i = 0; i < 32; i++) addRow(h.store, { groupUrl: `https://www.facebook.com/groups/${1000 + i}/`, lastCheckedAt: 1000 + i, linkStatus: 'known', postId: `k${i}` });
        addRow(h.store, { groupUrl: 'https://www.facebook.com/groups/9999/', lastCheckedAt: NOW, linkStatus: 'pending_approval' });
        const { pairs } = h.tracker.track();
        await h.tracker.whenIdle();
        expect(pairs).toHaveLength(MAX_TRACK_GROUPS);
        expect(pairs[0].groupUrl).toContain('/9999/');
        expect(pairs[1].groupUrl).toContain('/1000/');
        expect(pairs.some((p) => p.groupUrl.includes('/1031/'))).toBe(false);

        const f = setup();
        addRow(f.store); addRow(f.store, { groupUrl: G2 }); addRow(f.store, { profileId: 'p9', groupUrl: G2 });
        addRow(f.store, { groupUrl: 'https://www.facebook.com/groups/333/', linkStatus: 'not_found' });
        expect(f.tracker.track({ groupUrls: ['https://www.facebook.com/groups/222'], profileIds: ['p1'] }).pairs)
            .toEqual([{ profileId: 'p1', groupUrl: G2 }]);
        await f.tracker.whenIdle();
        const g = setup();
        addRow(g.store); addRow(g.store, { groupUrl: 'https://www.facebook.com/groups/333/', linkStatus: 'not_found' });
        expect(g.tracker.track().pairs).toHaveLength(1);
        await g.tracker.whenIdle();
    });

    test('validates sinceDays and groupUrls and releases the slot when rejecting', () => {
        const h = setup();
        expect(() => h.tracker.track({ sinceDays: 0 })).toThrow();
        expect(() => h.tracker.track({ sinceDays: 15 })).toThrow();
        expect(() => h.tracker.track({ groupUrls: Array.from({ length: 31 }, (_, i) => `https://www.facebook.com/groups/${i}`) })).toThrow();
        expect(h.slot.acquire).not.toHaveBeenCalled();
    });

    test('sinceDays limits rows by posted_at; explicit pairs reach rows up to 14 days', async () => {
        const h = setup();
        const old = addRow(h.store, { postedAt: NOW - 5 * DAY });
        expect(h.tracker.track({ sinceDays: 3 }).pairs).toEqual([]);
        await h.tracker.whenIdle();
        feeds['111|null'] = page([item('x', NOW - 5 * DAY - 2 * HOUR, { title: 'bài khác' })]);
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }] });
        expect(rowOf(h.store, old).checkCount).toBe(1);
    });

    test('uses custom config milestones', async () => {
        const h = setup();
        (h.tracker as any).deps.getConfig = () => ({ ...DEFAULT_POST_TRACKING_CONFIG, statsAtMinutes: [30, 6000] });
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', postedAt: NOW - HOUR, lastSeenAt: 1 });
        feeds['111|null'] = page([item('P1', NOW - HOUR)]);
        await run(h);
        expect(rowOf(h.store, id).statsDone).toEqual(['30m']);
    });
});
