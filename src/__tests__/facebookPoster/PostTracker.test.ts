import { ResearchError } from '../../services/research/graphqlSession';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PostTracker, MAX_TRACK_GROUPS } from '../../services/facebookPoster/PostTracker';
import { DEFAULT_POST_TRACKING_CONFIG, normalizeHead } from '../../services/facebookPoster/postTracking';
import { memoryDb } from './helpers';
import Logger from '../../utils/Logger';

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

function setup(opts: {
    sessionFor?: (profileId: string) => any; rejectAdmission?: boolean; random?: () => number;
    readPage?: (profileId: string, context: any) => Promise<any>; onPagePostKnown?: (row: any) => void; now?: () => number;
    localDate?: (ms: number) => string;
} = {}) {
    const store = new FacebookPosterStore(memoryDb());
    store.ensureSchema();
    const events: { type: string; payload: any }[] = [];
    const sleeps: number[] = [];
    const closes: string[] = [];
    const opened: string[] = [];
    const calls: string[] = [];
    const assertCurrent = jest.fn(() => { if (opts.rejectAdmission) throw new Error('retired'); });
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
        assertCurrent,
        observeLogin,
        emit: (type, payload) => { events.push({ type, payload }); },
        now: opts.now ?? (() => NOW),
        sleep,
        random: opts.random ?? (() => 0),
        newId: () => 'job1',
        ...(opts.readPage ? { readPage: opts.readPage } : {}),
        onPagePostKnown: opts.onPagePostKnown,
        localDate: opts.localDate ?? ((ms: number) => new Date(ms).toISOString().slice(0, 10)),
    });
    return { store, tracker, events, sleeps, closes, opened, calls, assertCurrent, observeLogin, sleep };
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

test('reserves local tracker admission before row-selection reentry', async () => {
    const h = setup();
    let attempted = false;
    let error: unknown;
    const original = h.store.listTracking.bind(h.store);
    jest.spyOn(h.store, 'listTracking').mockImplementation((opts) => {
        if (!attempted) { attempted = true; try { h.tracker.track(); } catch (caught) { error = caught; } }
        return original(opts);
    });
    h.tracker.track();
    await h.tracker.whenIdle();
    expect(error).toEqual(new Error(BUSY_ERROR));
    expect(finished(h.events)).toHaveLength(1);
});

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

    test('linking a pending post starts the comment schedule; an existing schedule is kept', async () => {
        const h = setup();
        const a = addRow(h.store, { linkStatus: 'pending_approval' });
        feeds['111|null'] = page([item('f9', NOW - 3 * HOUR + 5 * MIN)]);
        await run(h);
        // đăng lúc NOW-3h: mốc 120m đã qua (bỏ), mốc 1440m là mốc kế tiếp
        expect(rowOf(h.store, a)).toMatchObject({ linkStatus: 'known', nextCommentAt: NOW - 3 * HOUR + 1440 * MIN, commentsDone: [] });
        const h2 = setup();
        const b = addRow(h2.store, { linkStatus: 'pending_approval' });
        h2.store.updateCommentSchedule(b, { commentsDone: [], nextCommentAt: 12345 });
        await run(h2);
        expect(rowOf(h2.store, b).nextCommentAt).toBe(12345);
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

    test('past the last milestone and stopped early: still not_found (spec 4.5), no dead missing row', async () => {
        const h = setup();
        const postedAt = NOW - 8 * DAY;
        const id = addRow(h.store, { postedAt });
        feeds['111|null'] = page([item('x', NOW - HOUR)]);
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }] });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'not_found', checkCount: 0, nextCheckAt: null });
        expect(finished(h.events)[0].payload.notFound).toBe(1);
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

    test('no 8-15 s pause after a pair that opened no browser (skipped profile or unknown Page)', async () => {
        const loggedOut = { open: async () => { throw new ResearchError('logged_out', 'logged_out'); }, userId: () => UID, ensureQuery: jest.fn(), recapture: jest.fn(), call: jest.fn() };
        const h = setup({ sessionFor: (p) => (p === 'p1' ? loggedOut : undefined) });
        addRow(h.store, { profileId: 'p1' });
        addRow(h.store, { profileId: 'p1', groupUrl: G2 });
        addRow(h.store, { profileId: 'p2' });
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }, { profileId: 'p1', groupUrl: G2 }, { profileId: 'p2', groupUrl: G1 }] });
        expect(h.opened).toEqual(['p1', 'p2']);
        expect(h.sleeps).toEqual([8000]); // chỉ nghỉ sau lần mở của p1; cặp bị bỏ qua không mở gì nên không nghỉ thêm

        const h2 = setup();
        const PAGE = 'https://www.facebook.com/777';
        addRow(h2.store, { targetKind: 'page', pageId: '', groupUrl: PAGE });
        addRow(h2.store);
        await run(h2, { pairs: [{ profileId: 'p1', groupUrl: PAGE, pageId: '' }, { profileId: 'p1', groupUrl: G1 }] });
        expect(h2.opened).toEqual(['p1']);
        expect(h2.sleeps).toEqual([]);
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

describe('local admission, status, events and cancel', () => {
    test('preserves stop requested while selecting rows', async () => {
        const h = setup(); addRow(h.store);
        const original = h.store.listTracking.bind(h.store);
        jest.spyOn(h.store, 'listTracking').mockImplementation((...args) => { h.tracker.stop(); return original(...args); });
        h.tracker.track(); await h.tracker.whenIdle();
        expect(h.opened).toEqual([]);
        expect(h.tracker.status().last?.cancelled).toBe(true);
    });
    test('holds local admission for the whole job; reentry and retired contexts are rejected', async () => {
        const h = setup();
        addRow(h.store);
        feeds['111|null'] = page([item('a', NOW - 3 * HOUR)]);
        h.tracker.track();
        expect(h.assertCurrent).toHaveBeenCalledTimes(1);
        expect(h.tracker.isRunning()).toBe(true);
        expect(h.tracker.isRunning()).toBe(true);
        expect(() => h.tracker.track()).toThrow(BUSY_ERROR);
        await h.tracker.whenIdle();
        expect(h.tracker.isRunning()).toBe(false);
        expect(h.tracker.isRunning()).toBe(false);

        const busy = setup({ rejectAdmission: true });
        expect(() => busy.tracker.track()).toThrow('retired');
        expect(busy.tracker.isRunning()).toBe(false);
        expect(busy.opened).toEqual([]);
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

    test('an unexpected throw outside the pair loop is recorded, never an unhandled rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        const h = setup();
        addRow(h.store); addRow(h.store, { groupUrl: G2 });
        (h.tracker as any).sleepFn = async () => { throw new Error('sleep broke'); };
        h.tracker.track();
        await h.tracker.whenIdle();
        await new Promise((r) => setImmediate(r));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(h.tracker.isRunning()).toBe(false);
        expect(finished(h.events)).toHaveLength(1);
        expect(h.tracker.status().last!.errors.map((e) => e.error)).toContain('sleep broke');
        expect(h.tracker.isRunning()).toBe(false);
    });

    test('a throwing emit does not break the job', async () => {
        const h = setup();
        (h.tracker as any).deps.emit = () => { throw new Error('listener'); };
        addRow(h.store);
        await run(h);
        expect(h.tracker.status().last).not.toBeNull();
        expect(h.tracker.isRunning()).toBe(false);
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

    test('validates sinceDays and groupUrls before admission', () => {
        const h = setup();
        expect(() => h.tracker.track({ sinceDays: 0 })).toThrow();
        expect(() => h.tracker.track({ sinceDays: 15 })).toThrow();
        expect(() => h.tracker.track({ groupUrls: Array.from({ length: 31 }, (_, i) => `https://www.facebook.com/groups/${i}`) })).toThrow();
        expect(h.assertCurrent).not.toHaveBeenCalled();
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

describe('backing off failed, stale and unseen rows (final review C1/I1/I3)', () => {
    const failing = (code: string) => ({
        open: async () => { throw new ResearchError(code as any, code); },
        userId: () => UID, ensureQuery: jest.fn(), recapture: jest.fn(), call: jest.fn(),
    });
    const due = (h: ReturnType<typeof setup>) => h.store.listDuePairs(NOW, 10);

    test.each(['logged_out', 'checkpoint', 'rate_limited', 'unresolved'])('%s pair is not due again on the next tick', async (code) => {
        const h = setup({ sessionFor: () => failing(code) });
        const id = addRow(h.store, { postedAt: NOW - 3 * HOUR });
        expect(due(h)).toHaveLength(1);
        await run(h, { pairs: due(h) });
        expect(due(h)).toEqual([]);
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', nextCheckAt: NOW - 3 * HOUR + 360 * MIN, checkCount: 0, lastCheckedAt: null });
        const opened = h.opened.length;
        await run(h, { pairs: due(h) });
        expect(h.opened).toHaveLength(opened); // không mở lại trình duyệt ở nhịp sau
    });

    test('a profile launch error also backs the pair off, and a skipped profile\'s other pairs too', async () => {
        const h = setup({ sessionFor: () => failing('rate_limited') });
        addRow(h.store, { profileId: 'p1' });
        addRow(h.store, { profileId: 'p1', groupUrl: G2 });
        await run(h, { pairs: due(h) });
        expect(h.opened).toHaveLength(1);
        expect(due(h)).toEqual([]);
        const h2 = setup();
        addRow(h2.store);
        (h2.tracker as any).deps.openSession = async () => { throw new Error('Profile đang mở'); };
        await run(h2, { pairs: due(h2) });
        expect(due(h2)).toEqual([]);
    });

    test('an errored pair past the last retry milestone becomes not_found with next_check_at NULL', async () => {
        const h = setup({ sessionFor: () => failing('logged_out') });
        const id = addRow(h.store, { postedAt: NOW - 9 * DAY });
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'not_found', nextCheckAt: null });
        expect(finished(h.events)[0].payload.notFound).toBe(1);
    });

    test('an errored known pair marks overdue stats milestones done and moves to the next future one', async () => {
        const h = setup({ sessionFor: () => failing('checkpoint') });
        const postedAt = NOW - 2 * DAY;
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', lastSeenAt: 1, postedAt, nextCheckAt: postedAt + HOUR });
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({ statsDone: ['60m', '1440m'], nextCheckAt: postedAt + 4320 * MIN, linkStatus: 'known' });
    });

    test('rows not due are untouched by a pair error', async () => {
        const h = setup({ sessionFor: () => failing('logged_out') });
        const id = addRow(h.store, { nextCheckAt: NOW + HOUR });
        addRow(h.store, { groupUrl: G1, nextCheckAt: NOW - 1 });
        await run(h, { pairs: [{ profileId: 'p1', groupUrl: G1 }] });
        expect(rowOf(h.store, id).nextCheckAt).toBe(NOW + HOUR);
    });

    test('scheduler pairs settle due rows older than 14 days without reading', async () => {
        const h = setup();
        const missing = addRow(h.store, { postedAt: NOW - 20 * DAY });
        const known = addRow(h.store, { linkStatus: 'known', postId: 'P1', lastSeenAt: 1, postedAt: NOW - 16 * DAY, nextCheckAt: NOW - 5 * DAY });
        expect(due(h)).toHaveLength(1);
        await run(h, { pairs: due(h) });
        expect(h.opened).toEqual([]);
        expect(rowOf(h.store, missing)).toMatchObject({ linkStatus: 'not_found', nextCheckAt: null });
        expect(rowOf(h.store, known)).toMatchObject({ nextCheckAt: null, statsDone: ['60m', '1440m', '4320m'] });
        expect(due(h)).toEqual([]);
    });

    test('a known row checked but not seen moves to the next future milestone, concluding nothing', async () => {
        const h = setup();
        const postedAt = NOW - 2 * HOUR;
        const id = addRow(h.store, { linkStatus: 'known', postId: 'P1', lastSeenAt: null, postedAt, nextCheckAt: postedAt + HOUR });
        feeds['111|null'] = page([item('x', NOW - HOUR)], null);
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({
            removedSuspected: false, statsDone: ['60m'], nextCheckAt: postedAt + 1440 * MIN, lastCheckedAt: NOW,
        });
        expect(due(h)).toEqual([]);
    });

    test('with no pairs, trackFinished is emitted after track() returns', async () => {
        const h = setup();
        const res = h.tracker.track();
        expect(res.pairs).toEqual([]);
        expect(finished(h.events)).toHaveLength(0);
        await h.tracker.whenIdle();
        expect(finished(h.events)).toHaveLength(1);
        expect(h.tracker.isRunning()).toBe(false);
    });
});

describe('Page source (spec page-publish-proof-metrics 4.4, 5)', () => {
    const PAGE = 'https://www.facebook.com/777';
    const pagePair = (over: Record<string, unknown> = {}) => ({ profileId: 'p1', groupUrl: PAGE, pageId: '777', ...over });
    const addPageRow = (store: FacebookPosterStore, over: Record<string, unknown> = {}) =>
        addRow(store, { targetKind: 'page', pageId: '777', groupUrl: PAGE, ...over });
    const post = (postId: string, postedAt: number, over: Record<string, unknown> = {}) => ({
        postId, text: TEXT, reactions: 7, comments: 3, shares: 1, postedAt, url: '', ...over,
    });
    const reading = (recentPosts: any[], over: Record<string, unknown> = {}) => ({
        kind: 'page', pageId: '777', pageName: 'P', category: '', about: '', recentPosts, followers: null, ...over,
    });
    const pageSetup = (read: (profileId: string) => any, extra: Parameters<typeof setup>[0] = {}) => {
        const readPage = jest.fn(async (profileId: string, _context: any) => {
            const value = read(profileId);
            if (value instanceof Error) throw value;
            return value;
        });
        return { ...setup({ readPage, ...extra }), readPage };
    };
    const due = (h: ReturnType<typeof setup>, limit = 10) => h.store.listDuePairs(NOW, limit);

    test('pagePairReadsPageOnceAndWritesStatsAtDueMilestone', async () => {
        const postedAt = NOW - 2 * HOUR;
        const h = pageSetup(() => reading([post('a', postedAt, { reactions: 11 }), post('b', postedAt, { reactions: null, comments: 4, shares: null })]));
        const a = addPageRow(h.store, { linkStatus: 'known', postId: 'a', postUrl: 'https://www.facebook.com/777/posts/a', postedAt, lastSeenAt: 1 });
        const b = addPageRow(h.store, { linkStatus: 'known', postId: 'b', postUrl: 'https://www.facebook.com/777/posts/b', postedAt, lastSeenAt: 1 });
        expect(due(h)).toEqual([pagePair()]);
        await run(h, { pairs: due(h) });
        expect(h.readPage).toHaveBeenCalledTimes(1);
        expect(h.readPage.mock.calls[0][1]).toMatchObject({ jobId: 'job1', priority: 'background', signal: expect.any(Object) });
        expect(h.opened).toEqual([]);
        expect(h.store.latestStats([a])[0]).toMatchObject({ reactions: 11, comments: 3, shares: 1, capturedAt: NOW });
        expect(h.store.latestStats([b])[0]).toMatchObject({ reactions: null, comments: 4, shares: null });
        for (const id of [a, b]) {
            expect(rowOf(h.store, id)).toMatchObject({ statsDone: ['60m'], lastSeenAt: NOW, lastCheckedAt: NOW, nextCheckAt: postedAt + 1440 * MIN });
        }
        expect(finished(h.events)[0].payload).toMatchObject({ checked: 2, found: 2, linked: 0, errors: 0 });
        expect(due(h)).toEqual([]);
    });

    test('pageRowLinkedOnUniqueMatchUsesCanonicalUrl', async () => {
        const known = jest.fn();
        const h = pageSetup(() => reading([post('555', NOW - 3 * HOUR + 5 * MIN)]), { onPagePostKnown: known });
        const id = addPageRow(h.store);
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({
            linkStatus: 'known', postId: '555', postUrl: 'https://www.facebook.com/777/posts/555', checkCount: 0, lastSeenAt: NOW, removedSuspected: false,
        });
        expect(h.store.latestStats([id])[0]).toMatchObject({ reactions: 7, comments: 3, shares: 1 });
        expect(known).toHaveBeenCalledTimes(1);
        expect(known.mock.calls[0][0]).toMatchObject({ resultId: id, postId: '555', linkStatus: 'known', targetKind: 'page', pageId: '777' });
        expect(finished(h.events)[0].payload).toMatchObject({ found: 1, linked: 1 });
    });

    test('pageMissingPastLastRetryBecomesNotFound', async () => {
        const postedAt = NOW - 10080 * MIN - 1;
        const h = pageSetup(() => reading([]));
        const id = addPageRow(h.store, { postedAt });
        await run(h, { pairs: [pagePair()] });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'not_found', nextCheckAt: null, postId: '' });
        expect(finished(h.events)[0].payload.notFound).toBe(1);
        // còn trong lịch: 0 bài khớp chỉ giữ chờ tới mốc kế tiếp
        const h2 = pageSetup(() => reading([post('x', NOW - 3 * HOUR, { text: 'bài khác' })]));
        const id2 = addPageRow(h2.store);
        await run(h2, { pairs: due(h2) });
        expect(rowOf(h2.store, id2)).toMatchObject({ linkStatus: 'missing', checkCount: 0, lastCheckedAt: NOW, nextCheckAt: NOW - 3 * HOUR + 360 * MIN });
    });

    test('knownPostAbsentFromRecentTenMarksMilestoneWithoutStats', async () => {
        const postedAt = NOW - 2 * HOUR;
        const h = pageSetup(() => reading([post('other', NOW - 10 * HOUR)]));
        const id = addPageRow(h.store, { linkStatus: 'known', postId: 'a', postUrl: 'https://www.facebook.com/777/posts/a', postedAt, lastSeenAt: 1 });
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({
            statsDone: ['60m'], removedSuspected: false, linkStatus: 'known', lastCheckedAt: NOW, nextCheckAt: postedAt + 1440 * MIN,
        });
        expect(h.store.latestStats([id])).toEqual([]);
        expect(finished(h.events)[0].payload).toMatchObject({ found: 0, removedSuspected: 0 });
    });

    test.each([
        ['another page', { pageId: '888' }],
        ['not a page', { kind: 'person' }],
    ])('readerPageMismatchConcludesNothing (%s)', async (_label, over) => {
        const h = pageSetup(() => reading([post('555', NOW - 3 * HOUR)], { ...over, followers: 50 }));
        const id = addPageRow(h.store);
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', postId: '', postUrl: null, checkCount: 0, lastCheckedAt: null, nextCheckAt: NOW - 3 * HOUR + 360 * MIN });
        expect(h.store.latestStats([id])).toEqual([]);
        expect(h.store.listPageFollowers({ sinceDay: '1970-01-01' })).toEqual([]);
        expect(h.tracker.status().last!.errors).toEqual([{ profileId: 'p1', groupUrl: PAGE, error: 'page_mismatch' }]);
        expect(due(h)).toEqual([]);
    });

    test('pageLoginProblemObservesLoginAndSkipsProfile', async () => {
        const { PageLoginProblem } = jest.requireActual('../../services/dailyBrief/pageIdentity');
        const h = pageSetup(() => new PageLoginProblem('checkpoint'));
        const pageRow = addPageRow(h.store, { nextCheckAt: NOW - 100 });
        addRow(h.store, { profileId: 'p1', nextCheckAt: NOW - 50 });
        addRow(h.store, { profileId: 'p2', nextCheckAt: NOW - 10 });
        feeds['111|null'] = page([item('ok', NOW - 3 * HOUR)]);
        const pairs = due(h);
        expect(pairs[0]).toEqual(pagePair());
        await run(h, { pairs });
        expect(h.observeLogin).toHaveBeenCalledTimes(1);
        expect(h.observeLogin).toHaveBeenCalledWith('p1', 'checkpoint');
        expect(h.opened).toEqual(['p2']);
        expect(rowOf(h.store, pageRow)).toMatchObject({ linkStatus: 'missing', nextCheckAt: NOW - 3 * HOUR + 360 * MIN });
        expect(h.tracker.status().last!.errors).toEqual([{ profileId: 'p1', groupUrl: PAGE, error: 'checkpoint' }]);
        expect(due(h)).toEqual([]);
    });

    test('followersTextAndApproximateAreRecorded', async () => {
        const h = pageSetup(() => reading([], { followers: 1300, followersText: '1,3K', followersApproximate: true }));
        addPageRow(h.store);
        await run(h, { pairs: [pagePair()] });
        expect(h.store.listPageFollowers({ sinceDay: '1970-01-01' })).toMatchObject([{ followers: 1300, followersText: '1,3K', approximate: true }]);
    });

    test('followersRecordedOncePerLocalDay', async () => {
        let clock = NOW;
        let followers: number | null | undefined = 1234;
        const h = pageSetup(() => reading([], { followers }), { now: () => clock });
        const record = jest.spyOn(h.store, 'recordPageFollowers');
        addPageRow(h.store);
        await run(h, { pairs: [pagePair()] });
        followers = 999;
        clock = NOW + HOUR;
        await run(h, { pairs: [pagePair()] });
        expect(record).toHaveBeenCalledTimes(1);
        expect(h.store.listPageFollowers({ sinceDay: '1970-01-01' })).toEqual([
            { pageId: '777', profileId: 'p1', capturedOn: new Date(NOW).toISOString().slice(0, 10), capturedAt: NOW, followers: 1234, followersText: '', approximate: false },
        ]);
        clock = NOW + DAY;
        await run(h, { pairs: [pagePair()] });
        expect(h.store.listPageFollowers({ sinceDay: '1970-01-01' }).map((r) => r.followers)).toEqual([1234, 999]);

        for (const unverified of [null, undefined]) {
            followers = unverified;
            const h2 = pageSetup(() => reading([], { followers }));
            const record2 = jest.spyOn(h2.store, 'recordPageFollowers');
            addPageRow(h2.store);
            await run(h2, { pairs: [pagePair()] });
            expect(h2.readPage).toHaveBeenCalledTimes(1);
            expect(record2).not.toHaveBeenCalled();
            expect(h2.store.listPageFollowers({ sinceDay: '1970-01-01' })).toEqual([]);
        }
    });

    test('a follower write failure keeps the stats of the same tick and is logged without post text', async () => {
        const postedAt = NOW - 2 * HOUR;
        const h = pageSetup(() => reading([post('a', postedAt, { reactions: 11 })], { followers: 1234 }));
        const id = addPageRow(h.store, { linkStatus: 'known', postId: 'a', postUrl: 'https://www.facebook.com/777/posts/a', postedAt, lastSeenAt: 1 });
        jest.spyOn(h.store, 'recordPageFollowers').mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });
        const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        try {
            await run(h, { pairs: due(h) });
            expect(h.store.latestStats([id])[0]).toMatchObject({ reactions: 11, comments: 3, shares: 1, capturedAt: NOW });
            expect(rowOf(h.store, id)).toMatchObject({ statsDone: ['60m'], lastCheckedAt: NOW, nextCheckAt: postedAt + 1440 * MIN });
            expect(h.tracker.status().last!.errors).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('777');
            expect(warn.mock.calls[0][0]).toContain('SQLITE_BUSY');
            expect(warn.mock.calls[0][0]).not.toContain(TEXT);
        } finally { warn.mockRestore(); }
    });

    test('pageLoggedOutReadObservesLoginOnceAndSkipsTheProfile', async () => {
        const { PageLoginProblem } = jest.requireActual('../../services/dailyBrief/pageIdentity');
        const h = pageSetup((p) => (p === 'p1' ? new PageLoginProblem('logged_out') : reading([])));
        const pageRow = addPageRow(h.store, { nextCheckAt: NOW - 100 });
        addPageRow(h.store, { groupUrl: `${PAGE}?v=2`, nextCheckAt: NOW - 90 });
        addPageRow(h.store, { profileId: 'p2', nextCheckAt: NOW - 80 });
        await run(h, { pairs: due(h) });
        expect(h.observeLogin).toHaveBeenCalledTimes(1);
        expect(h.observeLogin).toHaveBeenCalledWith('p1', 'logged_out');
        expect(h.readPage.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2']); // cặp thứ hai của p1 không đọc lại
        expect(rowOf(h.store, pageRow)).toMatchObject({ linkStatus: 'missing', lastCheckedAt: null, nextCheckAt: NOW - 3 * HOUR + 360 * MIN });
        expect(h.tracker.status().last!.errors).toEqual([{ profileId: 'p1', groupUrl: PAGE, error: 'logged_out' }]);
        expect(due(h)).toEqual([]);
    });

    test('a retired generation after the Page read writes no stats, followers or link', async () => {
        let read = false;
        const h = pageSetup(() => { read = true; return reading([post('555', NOW - 3 * HOUR)], { followers: 50 }); });
        h.assertCurrent.mockImplementation(() => { if (read) throw new Error('retired'); });
        const id = addPageRow(h.store);
        await run(h, { pairs: due(h) });
        // Bộ đọc nhận context của lượt: kiểm thế hệ đi qua deps.assertCurrent.
        expect(() => h.readPage.mock.calls[0][1].assertCurrent()).toThrow('retired');
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', postId: '', postUrl: null, lastSeenAt: null });
        expect(h.store.latestStats([id])).toEqual([]);
        expect(h.store.listPageFollowers({ sinceDay: '1970-01-01' })).toEqual([]);
        expect(h.tracker.status().last!.errors).toEqual([{ profileId: 'p1', groupUrl: PAGE, error: 'retired' }]);
    });

    test.each([
        ['Asia/Ho_Chi_Minh', 2],
        ['America/New_York', 1],
    ])('followers day follows the injected local date (%s)', async (timeZone, rows) => {
        // 16:30Z và 17:30Z cùng một ngày UTC: ở Hồ Chí Minh (UTC+7) là 23:30 và 00:30 hôm sau, ở New York vẫn cùng ngày.
        const first = Date.UTC(2026, 9, 28, 16, 30), second = Date.UTC(2026, 9, 28, 17, 30);
        let clock = first;
        const localDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
        const h = pageSetup(() => reading([], { followers: 100 }), { now: () => clock, localDate });
        addPageRow(h.store, { postedAt: first - 3 * HOUR, nextCheckAt: first - 1 });
        await run(h, { pairs: [pagePair()] });
        clock = second;
        await run(h, { pairs: [pagePair()] });
        const saved = h.store.listPageFollowers({ sinceDay: '1970-01-01' });
        expect(saved).toHaveLength(rows);
        expect(saved[0].capturedOn).toBe(localDate(first));
    });

    test('emptyPageIdPairNeverOpensBrowser', async () => {
        const h = pageSetup(() => reading([post('555', NOW - 3 * HOUR)]));
        const id = addPageRow(h.store, { pageId: '' });
        expect(due(h)).toEqual([pagePair({ pageId: '' })]);
        await run(h, { pairs: due(h) });
        expect(h.readPage).not.toHaveBeenCalled();
        expect(h.opened).toEqual([]);
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'missing', nextCheckAt: NOW - 3 * HOUR + 360 * MIN, lastCheckedAt: null });
        expect(due(h)).toEqual([]);
        // hết lịch 7 ngày thì not_found, không treo mãi
        const h2 = pageSetup(() => reading([]));
        const old = addPageRow(h2.store, { pageId: '', postedAt: NOW - 8 * DAY });
        await run(h2, { pairs: due(h2) });
        expect(rowOf(h2.store, old)).toMatchObject({ linkStatus: 'not_found', nextCheckAt: null });
        expect(h2.readPage).not.toHaveBeenCalled();
    });

    test('pageRowsGetNoCommentSchedule', async () => {
        const h = pageSetup(() => reading([post('555', NOW - 3 * HOUR)]));
        const schedule = jest.spyOn(h.store, 'updateCommentSchedule');
        const id = addPageRow(h.store, { linkStatus: 'pending_approval' });
        await run(h, { pairs: due(h) });
        expect(rowOf(h.store, id)).toMatchObject({ linkStatus: 'known', nextCommentAt: null, commentsDone: [] });
        expect(schedule).not.toHaveBeenCalled();
    });

    test('page pairs never starve group pairs: due page pairs (some without a Page id) advance every tick', async () => {
        const h = pageSetup(() => reading([]));
        const pageRows = Array.from({ length: 12 }, (_, i) => addPageRow(h.store, {
            groupUrl: `${PAGE}?v=${String(i).padStart(2, '0')}`, pageId: i % 3 === 0 ? '' : '777', nextCheckAt: NOW - 1000 + i,
        }));
        const g1 = addRow(h.store, { profileId: 'p2', groupUrl: G1, nextCheckAt: NOW - 1 });
        const g2 = addRow(h.store, { profileId: 'p2', groupUrl: G2, nextCheckAt: NOW - 1 });
        feeds['111|null'] = page([item('ok1', NOW - 3 * HOUR)]);
        feeds['222|null'] = page([item('ok2', NOW - 3 * HOUR)]);
        let ticks = 0;
        while (due(h).length > 0 && ticks < 3) { await run(h, { pairs: due(h) }); ticks++; }
        expect(ticks).toBe(2);
        expect(rowOf(h.store, g1)).toMatchObject({ linkStatus: 'known', lastCheckedAt: NOW });
        expect(rowOf(h.store, g2)).toMatchObject({ linkStatus: 'known', lastCheckedAt: NOW });
        expect(h.opened).toEqual(['p2', 'p2']);
        expect(h.readPage).toHaveBeenCalledTimes(8); // một lần mỗi cặp có Page id, không lần nào cho cặp ''
        for (const id of pageRows) expect(rowOf(h.store, id).nextCheckAt).toBe(NOW - 3 * HOUR + 360 * MIN);
    });

    test('manual selection keys Page rows by (profile, Page) and skips rows whose Page is unknown', async () => {
        const h = pageSetup(() => reading([]));
        addPageRow(h.store); addPageRow(h.store); addPageRow(h.store, { pageId: '' });
        addPageRow(h.store, { pageId: '' }); addRow(h.store);
        const { pairs } = h.tracker.track();
        await h.tracker.whenIdle();
        expect(pairs).toHaveLength(2);
        expect(pairs).toEqual(expect.arrayContaining([pagePair(), { profileId: 'p1', groupUrl: G1 }]));
        expect(h.readPage).toHaveBeenCalledTimes(1);
        // cặp từ bộ hẹn giờ giữ khóa pageId (kể cả '')
        const h2 = pageSetup(() => reading([]));
        expect(h2.tracker.track({ pairs: [pagePair({ pageId: '' }), { profileId: 'p1', groupUrl: G1 }] }).pairs)
            .toEqual([pagePair({ pageId: '' }), { profileId: 'p1', groupUrl: G1 }]);
        await h2.tracker.whenIdle();
    });
});
