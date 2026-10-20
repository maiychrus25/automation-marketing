import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { CommentCollector, MAX_COMMENT_POSTS } from '../../services/facebookPoster/CommentCollector';
import { collectComments } from '../../services/facebookPoster/collectComments';
import { DEFAULT_LEAD_CONFIG } from '../../services/facebookPoster/leadRules';
import { memoryDb } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 100 * DAY;
const CONFIG = { ...DEFAULT_LEAD_CONFIG, collectAtMinutes: [120, 1440, 4320] };

let seq = 0;
function addPost(store: FacebookPosterStore, over: Record<string, unknown> = {}) {
    const id = ++seq;
    const postedAt = (over.postedAt as number) ?? NOW - 3 * HOUR;
    store.createTracking({
        resultId: id, runId: 'r', scheduleId: null, profileId: 'p1', groupUrl: 'https://www.facebook.com/groups/1/', groupId: '1',
        postId: String(id), postUrl: `https://www.facebook.com/groups/1/posts/${id}/`, postedAt, textHead: 'x', linkStatus: 'known',
        removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [],
        commentsDone: [], nextCommentAt: postedAt + 120 * MIN, ...over,
    } as any);
    return id;
}
const rowOf = (store: FacebookPosterStore, id: number) => store.listTracking({}).find((r) => r.resultId === id)!;
const comment = (postUrl: string, text: string, authorId = 'a1') =>
    ({ authorId, authorName: 'An', authorUrl: 'u', text, commentedAt: '1 giờ', postUrl });

type FakeCollect = (input: any, deps: any) => Promise<any>;

function setup(opts: { collect?: FakeCollect; launchFor?: (id: string) => Promise<any>; busy?: boolean; processThrows?: boolean } = {}) {
    const store = new FacebookPosterStore(memoryDb());
    store.ensureSchema();
    const events: { type: string; payload: any }[] = [];
    const launched: string[] = [];
    const closed: string[] = [];
    const logs: { message: string; level: string }[] = [];
    const processed: { rows: any[]; auto: boolean }[] = [];
    const slot = { acquire: jest.fn(() => { if (opts.busy) throw new Error(BUSY_ERROR); }), release: jest.fn() };
    const observeLogin = jest.fn();
    const sleeps: number[] = [];
    const collect: FakeCollect = opts.collect ?? (async (input, deps) => {
        await deps.launch();
        const results = [];
        for (const p of input.posts) {
            const added = await deps.saveComments([comment(p.postUrl, 'giá bao nhiêu')]);
            results.push({ url: p.postUrl, outcome: 'done', error: null, added });
        }
        return { scanned: results.length, failed: 0, added: results.length, results };
    });
    const collector = new CommentCollector({
        store,
        launchFor: opts.launchFor ?? (async (id: string) => { launched.push(id); return { ctx: {} as any, page: {} as any, close: async () => { closed.push(id); } }; }),
        collect: collect as unknown as typeof collectComments,
        slot,
        observeLogin,
        detector: { process: async (rows, o) => { if (opts.processThrows) throw new Error('ai'); processed.push({ rows, auto: o.auto }); return rows.map((_, i) => ({ id: i }) as any); } },
        readConfig: () => CONFIG,
        emit: (type, payload) => { events.push({ type, payload }); },
        log: (message, level) => { logs.push({ message, level }); },
        now: () => NOW,
        sleep: async (ms) => { sleeps.push(ms); },
        random: () => 0,
        newId: () => 'job1',
    });
    return { store, collector, events, logs, launched, closed, processed, slot, observeLogin, sleeps };
}

async function run(h: ReturnType<typeof setup>, params: any = {}) {
    const res = h.collector.collect(params);
    await h.collector.whenIdle();
    return res;
}
const finished = (events: any[]) => events.filter((e) => e.type === 'comments.collectFinished');

describe('CommentCollector', () => {
    test('collects due posts per profile, saves comments, runs the detector with auto, settles the schedule', async () => {
        const h = setup();
        const a = addPost(h.store);
        const b = addPost(h.store);
        const c = addPost(h.store, { profileId: 'p2' });
        const res = await run(h, { auto: true });
        expect(res).toEqual({ jobId: 'job1', posts: 3 });
        expect(h.launched).toEqual(['p1', 'p2']);
        expect(h.closed).toEqual(['p1', 'p2']);
        expect(h.processed.map((p) => p.auto)).toEqual([true, true, true]);
        const ev = finished(h.events);
        expect(ev).toHaveLength(1);
        expect(ev[0].payload).toEqual({ jobId: 'job1', auto: true, posts: 3, collected: 3, leads: 3, errors: 0 });
        // đăng lúc NOW-3h: mốc 120m đã quá hạn → xong; mốc kế là 1440m
        for (const id of [a, b, c]) {
            expect(rowOf(h.store, id)).toMatchObject({ commentsDone: ['120m'], nextCommentAt: NOW - 3 * HOUR + 1440 * MIN });
        }
        expect(h.sleeps).toEqual([10_000]);
        expect(h.slot.release).toHaveBeenCalledTimes(1);
    });

    test('last milestone sets next_comment_at to NULL and marks every overdue milestone', async () => {
        const h = setup();
        const id = addPost(h.store, { postedAt: NOW - 5 * DAY, nextCommentAt: NOW - 3 * DAY });
        await run(h);
        expect(rowOf(h.store, id)).toMatchObject({ commentsDone: ['120m', '1440m', '4320m'], nextCommentAt: null });
    });

    test('does not create fb_poster_runs or results rows', async () => {
        const h = setup();
        addPost(h.store);
        await run(h);
        const counts = (h.store as any).db.query('SELECT (SELECT COUNT(*) FROM fb_poster_runs) AS runs, (SELECT COUNT(*) FROM fb_poster_results) AS results')[0];
        expect(counts).toEqual({ runs: 0, results: 0 });
    });

    test('explicit postUrls are collected through the tracking rows (max 10)', async () => {
        const h = setup();
        const ids = Array.from({ length: 12 }, () => addPost(h.store, { nextCommentAt: NOW + DAY }));
        const urls = ids.map((id) => rowOf(h.store, id).postUrl as string).concat(['https://unknown/']);
        const res = h.collector.collect({ postUrls: urls });
        expect(res.posts).toBe(MAX_COMMENT_POSTS);
        await h.collector.whenIdle();
    });

    test('BUSY: slot held → throws and no job starts; second collect while running → BUSY', async () => {
        const busy = setup({ busy: true });
        addPost(busy.store);
        expect(() => busy.collector.collect({})).toThrow(BUSY_ERROR);
        expect(busy.collector.isRunning()).toBe(false);
        const h = setup();
        addPost(h.store);
        h.collector.collect({});
        expect(h.collector.isRunning()).toBe(true);
        expect(() => h.collector.collect({})).toThrow(BUSY_ERROR);
        expect(h.slot.acquire).toHaveBeenCalledTimes(1);
        await h.collector.whenIdle();
        expect(h.collector.isRunning()).toBe(false);
        expect(h.slot.release).toHaveBeenCalledTimes(1);
    });

    test('holds the slot until finished, status reports progress and last', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const h = setup({ collect: async (input) => { await gate; return { scanned: 0, failed: 0, added: 0, results: input.posts.map((p: any) => ({ url: p.postUrl, outcome: 'done', error: null, added: 0 })) }; } });
        addPost(h.store);
        h.collector.collect({ auto: true });
        await Promise.resolve();
        expect(h.slot.release).not.toHaveBeenCalled();
        expect(h.collector.status()).toMatchObject({ running: true, jobId: 'job1', progress: { done: 0, total: 1 } });
        release();
        await h.collector.whenIdle();
        expect(h.slot.release).toHaveBeenCalledTimes(1);
        expect(h.collector.status()).toMatchObject({ running: false, jobId: null, last: { jobId: 'job1', auto: true, posts: 1, cancelled: false } });
    });

    test('cancel stops before the next profile and leaves its schedule untouched', async () => {
        let h!: ReturnType<typeof setup>;
        h = setup({ collect: async (input, deps) => {
            await deps.launch();
            h.collector.cancel();
            expect(deps.getIsStopping()).toBe(true);
            return { scanned: 1, failed: 0, added: 0, results: input.posts.map((p: any) => ({ url: p.postUrl, outcome: 'done', error: null, added: 0 })) };
        } });
        const a = addPost(h.store);
        const b = addPost(h.store, { profileId: 'p2' });
        await run(h);
        expect(h.launched).toEqual(['p1']);
        expect(rowOf(h.store, a).commentsDone).toEqual(['120m']);
        expect(rowOf(h.store, b)).toMatchObject({ commentsDone: [], nextCommentAt: NOW - 3 * HOUR + 120 * MIN });
        expect(h.collector.status().last?.cancelled).toBe(true);
        expect(h.slot.release).toHaveBeenCalledTimes(1);
        expect(h.collector.cancel()).toBe(false);
    });

    test('logged-out page: observeLogin, remaining posts of that profile shifted, other profile still runs', async () => {
        let first = '';
        const h = setup({ collect: async (input, deps) => {
            await deps.launch();
            if (input.posts[0].postUrl === first) {
                expect(input.stopOnLoginProblem).toBe(true);
                return {
                    scanned: 0, failed: 1, added: 0, loginProblem: 'logged_out',
                    results: [{ url: input.posts[0].postUrl, outcome: 'failed', error: 'Phiên Facebook đã hết hoặc cần xác minh', added: 0 }],
                };
            }
            return { scanned: 1, failed: 0, added: 0, results: input.posts.map((p: any) => ({ url: p.postUrl, outcome: 'done', error: null, added: 0 })) };
        } });
        const a = addPost(h.store); // id 1 → url /1/
        const b = addPost(h.store); // cùng profile, không có trong results
        const c = addPost(h.store, { profileId: 'p2' });
        void c;
        first = rowOf(h.store, a).postUrl as string;
        await run(h, { auto: true });
        expect(h.observeLogin).toHaveBeenCalledTimes(1);
        expect(h.observeLogin).toHaveBeenCalledWith('p1', 'logged_out');
        for (const id of [a, b]) expect(rowOf(h.store, id)).toMatchObject({ commentsDone: ['120m'], nextCommentAt: NOW - 3 * HOUR + 1440 * MIN });
        expect(h.launched).toEqual(['p1', 'p2']);
        expect(finished(h.events)[0].payload.errors).toBe(2);
    });

    test('launch fails with a checkpoint code: observeLogin(checkpoint), posts shifted, no loop', async () => {
        const err = Object.assign(new Error('checkpoint'), { code: 'checkpoint' });
        const h = setup({
            launchFor: async () => { throw err; },
            collect: async (_input, deps) => { await deps.launch(); return { scanned: 0, failed: 0, added: 0, results: [] }; },
        });
        const a = addPost(h.store);
        const b = addPost(h.store);
        await run(h, { auto: true });
        expect(h.observeLogin).toHaveBeenCalledWith('p1', 'checkpoint');
        for (const id of [a, b]) expect(rowOf(h.store, id)).toMatchObject({ commentsDone: ['120m'], nextCommentAt: NOW - 3 * HOUR + 1440 * MIN });
        expect(h.store.listDueCommentPosts(NOW, 10)).toEqual([]);
    });

    test('a failing post does not block the others and is moved to the next milestone', async () => {
        const h = setup({ collect: async (input, deps) => {
            await deps.launch();
            const results = [];
            for (const [i, p] of input.posts.entries()) {
                if (i === 0) { results.push({ url: p.postUrl, outcome: 'failed', error: 'Không mở được bài', added: 0 }); continue; }
                const added = await deps.saveComments([comment(p.postUrl, 'ib giá')]);
                results.push({ url: p.postUrl, outcome: 'done', error: null, added });
            }
            return { scanned: 1, failed: 1, added: 1, results };
        } });
        const a = addPost(h.store);
        const b = addPost(h.store);
        await run(h);
        expect(rowOf(h.store, a)).toMatchObject({ commentsDone: ['120m'], nextCommentAt: NOW - 3 * HOUR + 1440 * MIN });
        expect(rowOf(h.store, b).commentsDone).toEqual(['120m']);
        expect(h.observeLogin).not.toHaveBeenCalled();
        expect(h.collector.status().last).toMatchObject({ collected: 1, errors: [{ profileId: 'p1', error: 'Không mở được bài' }] });
    });

    test('collect throwing a plain error settles the profile rows and the job still finishes', async () => {
        const h = setup({ collect: async () => { throw new Error('crash'); } });
        const a = addPost(h.store);
        await run(h);
        expect(rowOf(h.store, a).commentsDone).toEqual(['120m']);
        expect(h.collector.isRunning()).toBe(false);
        expect(h.slot.release).toHaveBeenCalledTimes(1);
        expect(finished(h.events)[0].payload.errors).toBe(1);
    });

    test('detector failure does not break the collection', async () => {
        const h = setup({ processThrows: true });
        const a = addPost(h.store);
        await run(h);
        expect(h.collector.status().last).toMatchObject({ collected: 1, leads: 0 });
        expect(rowOf(h.store, a).commentsDone).toEqual(['120m']);
    });

    test('recollecting the same comments adds nothing and sends nothing new', async () => {
        const h = setup();
        const a = addPost(h.store);
        await run(h);
        h.store.updateCommentSchedule(a, { commentsDone: [], nextCommentAt: NOW });
        // loadKeys không được truyền vào fake; dòng trùng khoá bị INSERT OR IGNORE bỏ qua
        await run(h);
        expect(h.processed).toHaveLength(1);
        expect(h.collector.status().last?.collected).toBe(0);
    });

    test('emit throwing does not break the job', async () => {
        const h = setup();
        addPost(h.store);
        (h.collector as any).deps.emit = () => { throw new Error('ui'); };
        await run(h);
        expect(h.collector.isRunning()).toBe(false);
    });

    test('no due posts: finishes with zero posts after collect() returned', async () => {
        const h = setup();
        const res = h.collector.collect({});
        expect(res.posts).toBe(0);
        expect(finished(h.events)).toHaveLength(0);
        await h.collector.whenIdle();
        expect(finished(h.events)).toHaveLength(1);
        expect(h.launched).toEqual([]);
    });

    describe('final-review fixes', () => {
        test('settle failure is logged, aborts the rest of the run and blocks auto runs for 60 minutes', async () => {
            const h = setup();
            const a = addPost(h.store);
            const b = addPost(h.store, { profileId: 'p2' });
            jest.spyOn(h.store, 'updateCommentSchedule').mockImplementation(() => { throw new Error('SQLITE_FULL'); });
            await run(h, { auto: true });
            expect(h.logs.some((l) => l.level === 'error' && l.message.includes('SQLITE_FULL'))).toBe(true);
            expect(h.launched).toEqual(['p1']); // p2 not opened after the abort
            expect(h.collector.blockedUntil).toBe(NOW + 60 * MIN);
            expect(h.collector.status().last!.errors.some((e) => e.error.includes('SQLITE_FULL'))).toBe(true);
            expect(rowOf(h.store, a).nextCommentAt).not.toBeNull();
            expect(rowOf(h.store, b).commentsDone).toEqual([]);
        });

        test('comment insert failure aborts, keeps the milestone and blocks auto runs', async () => {
            const h = setup();
            const a = addPost(h.store);
            jest.spyOn(h.store, 'insertCommentsReturningNew').mockImplementation(() => { throw new Error('readonly'); });
            await run(h, { auto: true });
            expect(h.logs.some((l) => l.level === 'error' && l.message.includes('readonly'))).toBe(true);
            expect(h.collector.blockedUntil).toBe(NOW + 60 * MIN);
            expect(rowOf(h.store, a).nextCommentAt).toBe(NOW - 3 * HOUR + 120 * MIN); // still due, not settled
        });

        test('emits one leads.found per run with the total and at most 3 newest samples', async () => {
            const h = setup();
            for (let i = 0; i < 5; i++) addPost(h.store);
            (h.collector as any).deps.detector = {
                process: async (rows: any[], o: any) => {
                    expect(o.emit).toBe(false);
                    return rows.map((r) => ({ authorName: r.authorName, text: r.text, postUrl: r.postUrl }) as any);
                },
            };
            await run(h, { auto: true });
            const found = h.events.filter((e) => e.type === 'leads.found');
            expect(found).toHaveLength(1);
            expect(found[0].payload.count).toBe(5);
            expect(found[0].payload.samples).toHaveLength(3);
            expect(found[0].payload.auto).toBe(true);
            expect(h.events.map((e) => e.type).indexOf('leads.found')).toBeLessThan(h.events.map((e) => e.type).indexOf('comments.collectFinished'));
        });

        test('no leads.found when no leads were created', async () => {
            const h = setup();
            addPost(h.store);
            (h.collector as any).deps.detector = { process: async () => [] };
            await run(h, { auto: true });
            expect(h.events.some((e) => e.type === 'leads.found')).toBe(false);
        });

        test('shares one AI state across the whole run', async () => {
            const h = setup();
            addPost(h.store); addPost(h.store);
            const states: unknown[] = [];
            (h.collector as any).deps.detector = { process: async (_r: any, o: any) => { states.push(o.aiState); return []; } };
            await run(h, { auto: true });
            expect(states).toHaveLength(2);
            expect(states[0]).toBe(states[1]);
        });

        test('a profile that is already open skips the run without consuming the milestone', async () => {
            const h = setup({ launchFor: async () => { throw new Error('Profile đang mở. Đóng profile trước khi chạy tự động'); } });
            const a = addPost(h.store);
            await run(h, { auto: true });
            expect(rowOf(h.store, a).nextCommentAt).toBe(NOW - 3 * HOUR + 120 * MIN);
            expect(rowOf(h.store, a).commentsDone).toEqual([]);
            expect(h.logs.some((l) => l.level === 'warning' && l.message.includes('Profile đang mở'))).toBe(true);
            expect(h.observeLogin).not.toHaveBeenCalled();
        });

        test.each(['logged_out', 'checkpoint'])('auto run skips a known %s profile without launching and moves to the next milestone', async (state) => {
            const h = setup();
            const a = addPost(h.store);
            h.store.setLoginState('p1', state as any, 'check', NOW);
            await run(h, { auto: true });
            expect(h.launched).toEqual([]);
            expect(rowOf(h.store, a).commentsDone).toEqual(['120m']);
            expect(h.collector.status().last!.errors).toHaveLength(1);
        });

        test('a manual run still tries a profile whose stored state is bad', async () => {
            const h = setup();
            const a = addPost(h.store);
            h.store.setLoginState('p1', 'logged_out' as any, 'check', NOW);
            await run(h, { postUrls: [rowOf(h.store, a).postUrl as string] });
            expect(h.launched).toEqual(['p1']);
        });
    });
});
