import { memoryDb } from '../facebookPoster/helpers';
import { ResearchStore } from '../../services/research/ResearchStore';
import { ResearchError } from '../../services/research/graphqlSession';
import {
    ResearchService, PER_PROFILE_CHUNK, PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS, GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS,
} from '../../services/research/ResearchService';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';

const NOW = 1760500000000;
const SEARCH_Q = { friendlyName: 'SearchCometResultsPaginatedResultsQuery', docId: 'd1', variables: { count: 5, cursor: null, args: { text: 'x', filters: [] } } };
const FEED_Q = { friendlyName: 'GroupsCometFeedRegularStoriesPaginationQuery', docId: 'd2', variables: { count: 3, cursor: null, id: '999' } };

function story(postId: string, createdSec: number) {
    return {
        __typename: 'Story', post_id: postId, url: `https://www.facebook.com/groups/1/posts/${postId}/`,
        comet_sections: {
            context_layout: { story: { comet_sections: { actor_photo: { story: { actors: [{ __typename: 'User', id: `u${postId}`, name: 'Người Giả', url: `https://www.facebook.com/u${postId}` }] } } } } },
            content: { story: { message: { text: `Bài ${postId}` } } },
            timestamp: { story: { creation_time: createdSec } },
        },
        to: { __typename: 'Group', id: '1', name: 'Nhóm Giả', url: 'https://www.facebook.com/groups/1/' },
    };
}
/** Trang kết quả tìm kiếm giả: `n` bài có ID bắt đầu từ `from`. */
function postsPage(from: number, n: number, next: string | null): string {
    const edges = Array.from({ length: n }, (_, i) => ({ node: { __typename: 'SearchRenderable' }, rendering_strategy: { view_model: { click_model: { story: story(String(from + i), 1760000000) } } } }));
    return `for (;;);${JSON.stringify({ data: { serpResponse: { results: { edges, page_info: { end_cursor: next, has_next_page: next !== null } } } } })}`;
}
function feedPage(ids: [string, number][], next: string | null): string {
    const edges = ids.map(([id, sec]) => ({ node: story(id, sec), cursor: 'x' }));
    return `for (;;);${JSON.stringify({ data: { node: { __typename: 'Group', group_feed: { edges, page_info: { end_cursor: next, has_next_page: next !== null } } } } })}`;
}

type Call = { profileId: string; vars: any };

function setup(opts: {
    profiles?: string[]; script?: (c: Call, n: number) => string | Error; cap?: number; busy?: string[];
    loginStates?: any[]; membership?: Record<string, string[]>; scannedAt?: Record<string, number>; openFail?: string[];
    ensureThrows?: Record<string, Error>; onSleep?: (ms: number, svc: ResearchService) => void; excluded?: string[];
    ensureHook?: (profileId: string, svc: ResearchService) => void; recaptureThrows?: boolean; docIds?: string[];
} = {}) {
    const store = new ResearchStore(memoryDb());
    store.ensureSchema();
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const opened: string[] = [];
    const closed: string[] = [];
    const emitted: { channel: string; data: any }[] = [];
    const observed: [string, string][] = [];
    const ensured: string[] = [];
    let recaptures = 0;
    const profiles = (opts.profiles ?? ['p1', 'p2', 'p3', 'p4']).map((id) => ({ id, name: id }));
    const makeSession = (profileId: string): any => {
            return {
                open: async () => undefined,
                ensureQuery: async (source: string) => {
                    ensured.push(profileId);
                    if (opts.ensureThrows?.[profileId]) throw opts.ensureThrows[profileId];
                    opts.ensureHook?.(profileId, svc);
                    return source === 'group_feed' ? FEED_Q : SEARCH_Q;
                },
                recapture: async () => {
                    recaptures++;
                    if (opts.recaptureThrows) throw new ResearchError('query_changed', 'vẫn hỏng');
                    return { ...SEARCH_Q, docId: 'fresh' };
                },
                call: async (_q: any, vars: any) => {
                    const c = { profileId, vars };
                    calls.push(c);
                    const out = opts.script ? opts.script(c, calls.length - 1) : postsPage(1, 1, null);
                    if (out instanceof Error) throw out;
                    return out;
                },
            } as any;
    };
    let svc!: ResearchService;
    let n = 0;
    svc = new ResearchService({
        store,
        openSession: async (id) => {
            if (opts.openFail?.includes(id)) throw new Error('Profile đang mở');
            opened.push(id);
            return { session: makeSession(id), close: async () => { closed.push(id); } };
        },
        listProfiles: () => profiles,
        isProfileBusy: (id) => !!opts.busy?.includes(id),
        loginStates: () => opts.loginStates ?? [],
        groupMembership: () => Object.fromEntries(Object.entries(opts.membership ?? {}).map(([id, urls]) =>
            [id, urls.map((url) => ({ url, scannedAt: opts.scannedAt?.[url] ?? null }))])),
        observeLogin: (id, state) => { observed.push([id, state]); },
        readConfig: () => ({ excludedProfileIds: opts.excluded ?? [], perProfileDailyCap: opts.cap ?? 500 }),
        emit: (channel, data) => { emitted.push({ channel, data }); },
        now: () => NOW,
        sleep: async (ms) => { sleeps.push(ms); opts.onSleep?.(ms, svc); },
        random: () => 0,
        newId: () => `scan${++n}`,
    });
    return { svc, store, calls, sleeps, opened, closed, emitted, observed, ensured, recaptures: () => recaptures };
}

/** Phân trang giả: con trỏ `c<k>` là trang thứ k (10 bài mỗi trang, ID liên tục), vô hạn. */
const endless = (c: Call) => {
    const k = c.vars.cursor ? Number(String(c.vars.cursor).slice(1)) : 0;
    return postsPage(k * 10 + 1, 10, `c${k + 1}`);
};
const finishedEvents = (h: ReturnType<typeof setup>) => h.emitted.filter((e) => e.channel === 'research:finished');
const run = async (h: ReturnType<typeof setup>, p: Partial<Parameters<ResearchService['search']>[0]> = {}) => {
    const { scanId } = h.svc.search({ source: 'posts', query: 'sữa bột', origin: 'api', ...p });
    await h.svc.whenIdle();
    return h.store.getScan(scanId)!;
};

describe('ResearchService keyword scan', () => {
    it('chia 200 mục cho 4 profile, 50 mỗi profile, con trỏ nối tiếp', async () => {
        const h = setup({ script: endless });
        const scan = await run(h, { limit: 200 });
        expect(scan.status).toBe('done');
        expect(scan.errorCode).toBe('');
        expect(scan.itemCount).toBe(200);
        expect(PER_PROFILE_CHUNK).toBe(50);
        for (const id of ['p1', 'p2', 'p3', 'p4']) {
            expect((scan.details as any).profiles[id].items).toBe(50);
        }
        expect(scan.profileIds).toEqual(['p1', 'p2', 'p3', 'p4']);
        // profile 2 bắt đầu từ con trỏ c5 (profile 1 đã lấy 5 trang)
        expect(h.calls.filter((c) => c.profileId === 'p2')[0].vars.cursor).toBe('c5');
        expect(h.closed.sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(finishedEvents(h)).toHaveLength(1);
        expect(finishedEvents(h)[0].data).toEqual({ scanId: scan.id, source: 'posts', query: 'sữa bột', status: 'done', errorCode: '', itemCount: 200 });
    });

    it('phát research:progress sau mỗi trang', async () => {
        const h = setup({ script: endless });
        await run(h, { limit: 20 });
        const prog = h.emitted.filter((e) => e.channel === 'research:progress').map((e) => e.data);
        expect(prog).toEqual([
            { scanId: 'scan1', source: 'posts', items: 10, profileId: 'p1' },
            { scanId: 'scan1', source: 'posts', items: 20, profileId: 'p1' },
        ]);
    });

    it('checkpoint ở profile 2: bỏ profile, báo observeLogin, ghi details_json', async () => {
        const cp = `for (;;);${JSON.stringify({ errors: [{ message: 'checkpoint' }] })}`;
        const h = setup({ script: (c) => (c.profileId === 'p2' ? cp : endless(c)), profiles: ['p1', 'p2', 'p3', 'p4'] });
        const scan = await run(h, { limit: 150 });
        expect(h.observed).toEqual([['p2', 'checkpoint']]);
        expect((scan.details as any).profiles.p2).toEqual({ items: 0, error: 'checkpoint' });
        expect(scan.itemCount).toBe(150);
        expect(scan.status).toBe('done');
        expect(scan.profileIds).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(h.closed).toContain('p2');
    });

    it('rate_limited và lỗi mở profile: ghi details, không observeLogin', async () => {
        const rl = `for (;;);${JSON.stringify({ errors: [{ message: 'rate limit', code: 1390008 }] })}`;
        const h = setup({ script: (c) => (c.profileId === 'p1' ? rl : endless(c)), openFail: ['p2'], profiles: ['p1', 'p2', 'p3', 'p4'] });
        const scan = await run(h, { limit: 100 });
        const d = (scan.details as any).profiles;
        expect(d.p1.error).toBe('rate_limited');
        expect(d.p2.error).toMatch(/^open_failed/);
        expect(h.observed).toEqual([]);
        expect(scan.itemCount).toBe(100);
    });

    it('hết profile trước khi đủ limit: done + no_profile_available', async () => {
        const h = setup({ script: endless, profiles: ['p1', 'p2'] });
        const scan = await run(h, { limit: 300 });
        expect(scan.status).toBe('done');
        expect(scan.errorCode).toBe('no_profile_available');
        expect(scan.itemCount).toBe(100);
    });

    it('không có profile nào lúc bắt đầu: failed + no_profile_available', async () => {
        const h = setup({ profiles: ['p1'], busy: ['p1'] });
        const scan = await run(h);
        expect(scan.status).toBe('failed');
        expect(scan.errorCode).toBe('no_profile_available');
        expect(h.opened).toEqual([]);
        expect(finishedEvents(h)).toHaveLength(1);
    });

    it('bỏ profile đã loại trừ, đang bận, logged_out và ngoài profileIds', async () => {
        const h = setup({
            script: endless, profiles: ['p1', 'p2', 'p3', 'p4', 'p5'], excluded: ['p1'], busy: ['p2'],
            loginStates: [{ profileId: 'p3', state: 'logged_out', checkedAt: 1, source: 'check', lastError: null, lastErrorAt: null }],
        });
        const scan = await run(h, { limit: 10, profileIds: ['p1', 'p2', 'p3', 'p4'] });
        expect(scan.profileIds).toEqual(['p4']);
    });

    it('trần ngày: profile chạm trần bị bỏ, profile còn chỗ chỉ lấy phần còn lại', async () => {
        const h = setup({ script: endless, profiles: ['p1', 'p2'], cap: 500 });
        // p1 đã thu 480 mục trong 24 giờ qua
        const old = h.store;
        old.createScan({ id: 'old', source: 'posts', query: 'a', params: {}, profileIds: [], origin: 'api', startedAt: NOW - 1000 });
        old.addItems('old', Array.from({ length: 480 }, (_, i) => ({ kind: 'post' as const, fbId: `o${i}`, url: '', title: '' })), 'p1', NOW - 1000);
        old.addItems('old', Array.from({ length: 500 }, (_, i) => ({ kind: 'post' as const, fbId: `q${i}`, url: '', title: '' })), 'p2', NOW - 1000);
        const scan = await run(h, { limit: 100 });
        // p2 chạm trần: chỉ p1 dùng được, mỗi lần tối đa 20 mục còn lại
        expect(scan.profileIds).toEqual(['p1']);
        expect(scan.itemCount).toBe(20);
        expect(scan.errorCode).toBe('no_profile_available');
        expect(scan.status).toBe('done');
    });

    it('nghỉ 2–5 giây giữa trang và phát hành sleep giả', async () => {
        const h = setup({ script: endless });
        await run(h, { limit: 30 });
        expect(h.sleeps).toHaveLength(2);
        for (const ms of h.sleeps) { expect(ms).toBeGreaterThanOrEqual(PAGE_DELAY_MIN_MS); expect(ms).toBeLessThanOrEqual(PAGE_DELAY_MAX_MS); }
    });

    it('huỷ trong lúc nghỉ: cancelled, đóng trình duyệt, không gọi thêm trang', async () => {
        const h = setup({ script: endless, onSleep: (_ms, svc) => { svc.cancel(); } });
        const scan = await run(h, { limit: 100 });
        expect(scan.status).toBe('cancelled');
        expect(h.calls).toHaveLength(1);
        expect(h.closed).toEqual(['p1']);
        expect(scan.itemCount).toBe(10);
        expect(finishedEvents(h)[0].data.status).toBe('cancelled');
    });

    it('huỷ ngay sau ensureQuery: không gọi trang nào, vẫn đóng phiên', async () => {
        const h = setup({ script: endless, ensureHook: (_id, svc) => { svc.cancel(); } });
        const scan = await run(h);
        expect(scan.status).toBe('cancelled');
        expect(h.calls).toHaveLength(0);
        expect(h.closed).toEqual(['p1']);
    });

    it('cancel() trả false khi rảnh', () => {
        expect(setup().svc.cancel()).toBe(false);
    });

    it('đang chạy thì ném BUSY_ERROR; hết thì chạy lại được', async () => {
        const h = setup({ script: endless });
        h.svc.search({ source: 'posts', query: 'a', limit: 10, origin: 'api' });
        expect(h.svc.isRunning()).toBe(true);
        expect(() => h.svc.search({ source: 'posts', query: 'b', origin: 'api' })).toThrow(BUSY_ERROR);
        expect(() => h.svc.scanGroupFeeds({ origin: 'api' })).toThrow(BUSY_ERROR);
        await h.svc.whenIdle();
        expect(h.svc.isRunning()).toBe(false);
        expect(() => h.svc.search({ source: 'posts', query: 'b', limit: 10, origin: 'api' })).not.toThrow();
        await h.svc.whenIdle();
    });

    it('query_changed sau một lần bắt lại: failed', async () => {
        const changed = `for (;;);${JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] })}`;
        const h = setup({ script: () => changed });
        const scan = await run(h);
        expect(h.recaptures()).toBe(1);
        expect(scan.status).toBe('failed');
        expect(scan.errorCode).toBe('query_changed');
        expect(h.closed).toEqual(['p1']);
    });

    it('doc_id hỏng một lần: bắt lại rồi gọi lại thành công', async () => {
        const changed = `for (;;);${JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] })}`;
        let first = true;
        const h = setup({ script: () => { if (first) { first = false; return changed; } return postsPage(1, 3, null); } });
        const scan = await run(h);
        expect(h.recaptures()).toBe(1);
        expect(scan.status).toBe('done');
        expect(scan.itemCount).toBe(3);
    });

    it('recapture ném query_changed: failed', async () => {
        const changed = `for (;;);${JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] })}`;
        const h = setup({ script: () => changed, recaptureThrows: true });
        const scan = await run(h);
        expect(scan.errorCode).toBe('query_changed');
        expect(scan.status).toBe('failed');
    });

    it('parse_failed ở trang đầu: failed; lưu hình dạng', async () => {
        const h = setup({ script: () => 'khong phai json' });
        const scan = await run(h);
        expect(scan.status).toBe('failed');
        expect(scan.errorCode).toBe('parse_failed');
        expect(h.opened).toEqual(['p1']);
    });

    it('parse_failed ở trang sau: done + errorCode, giữ mục đã thu', async () => {
        const h = setup({ script: (_c, n) => (n === 0 ? postsPage(1, 10, 'c1') : 'rác') });
        const scan = await run(h, { limit: 100 });
        expect(scan.status).toBe('done');
        expect(scan.errorCode).toBe('parse_failed');
        expect(scan.itemCount).toBe(10);
    });

    it('trang đầu 0 mục: lưu details.shape (đường dẫn, không giá trị)', async () => {
        const empty = `for (;;);${JSON.stringify({ data: { serpResponse: { results: { edges: [], page_info: { end_cursor: null } } } } })}`;
        const h = setup({ script: () => empty });
        const scan = await run(h);
        expect(scan.status).toBe('done');
        expect(scan.itemCount).toBe(0);
        const shape = (scan.details as any).shape as string[];
        expect(shape.some((l) => l.includes('data.serpResponse.results.edges'))).toBe(true);
    });

    it('con trỏ mang sang không dùng được (0 mục): bắt đầu lại từ null, bỏ mục trùng', async () => {
        let carriedTried = false;
        const h = setup({
            profiles: ['p1', 'p2'],
            script: (c) => {
                if (c.profileId === 'p2' && c.vars.cursor === 'c5' && !carriedTried) { carriedTried = true; return postsPage(0, 0, null); }
                return endless(c);
            },
        });
        const scan = await run(h, { limit: 80 });
        const p2 = h.calls.filter((c) => c.profileId === 'p2');
        expect(p2[0].vars.cursor).toBe('c5');
        expect(p2[1].vars.cursor).toBeNull();
        // p2 lặp lại các trang c0..c4 (mục trùng bị bỏ) rồi thêm 30 mục mới
        expect(scan.itemCount).toBe(80);
        expect(new Set(h.store.listItems(scan.id, { limit: 500 }).items.map((i) => i.fbId)).size).toBe(80);
    });

    it('lỗi bất ngờ từ dep: failed parse_failed, một sự kiện finished, không unhandled rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        const h = setup({ script: () => { throw new TypeError('boom'); } });
        const scan = await run(h);
        await new Promise((r) => setImmediate(r));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(scan.status).toBe('failed');
        expect(scan.errorCode).toBe('parse_failed');
        expect(finishedEvents(h)).toHaveLength(1);
        expect(h.closed).toEqual(['p1']);

        const store = new ResearchStore(memoryDb());
        store.ensureSchema();
        const svc = new ResearchService({
            store, openSession: async () => { throw new Error('x'); }, listProfiles: () => { throw new Error('listProfiles hỏng'); },
            isProfileBusy: () => false, loginStates: () => [], groupMembership: () => ({}),
            observeLogin: () => undefined, readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 500 }), emit: () => undefined,
            newId: () => 's',
        });
        svc.search({ source: 'posts', query: 'a', origin: 'api' });
        await svc.whenIdle();
        expect(store.getScan('s')!.status).toBe('failed');
    });

    it('kiểm tra tham số đồng bộ bằng Error tiếng Việt', () => {
        const { svc } = setup();
        const bad = [
            { query: '' }, { query: 'x'.repeat(101) }, { query: 'a', limit: 0 }, { query: 'a', limit: 501 },
            { query: 'a', year: 2009 }, { query: 'a', year: 2999 }, { query: 'a', recent: true, source: 'groups' as const },
            { query: 'a', year: 2024, source: 'pages' as const }, { query: 'a', profileIds: [] },
            { query: 'a', profileIds: Array.from({ length: 51 }, (_, i) => `p${i}`) },
        ];
        for (const b of bad) expect(() => svc.search({ source: 'posts', origin: 'api', ...b })).toThrow(Error);
        expect(svc.isRunning()).toBe(false);
        expect(() => svc.scanGroupFeeds({ origin: 'api', sinceDays: 31 })).toThrow(Error);
        expect(() => svc.scanGroupFeeds({ origin: 'api', limitPerGroup: 101 })).toThrow(Error);
        expect(() => svc.scanGroupFeeds({ origin: 'api', groupUrls: Array.from({ length: 21 }, (_, i) => `https://www.facebook.com/groups/${i}`) })).toThrow(Error);
        expect(svc.isRunning()).toBe(false);
    });

    it('dùng URL kích hoạt theo nguồn và mã hoá từ khoá; lọc recent/year truyền vào biến', async () => {
        const h = setup({ script: () => postsPage(1, 1, null) });
        await run(h, { recent: true, year: 2024, query: 'sữa & bột' });
        expect(h.calls[0].vars.args.text).toBe('sữa & bột');
        expect(h.calls[0].vars.args.filters).toHaveLength(2);
        expect(h.calls[0].vars.count).toBe(10);
    });
});

describe('ResearchService group_feed', () => {
    const G1 = 'https://www.facebook.com/groups/111';
    const G2 = 'https://www.facebook.com/groups/222';
    const day = 86400;
    const nowSec = NOW / 1000;

    it('dùng profile đã tham gia, nghỉ 5–10 giây giữa nhóm, tái dùng phiên khi liên tiếp', async () => {
        const h = setup({
            profiles: ['p1', 'p2'], membership: { p2: [G1 + '/', G2] },
            script: () => feedPage([['a1', nowSec - day]], null),
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1, G2], origin: 'api' });
        await h.svc.whenIdle();
        const scan = h.store.getScan(scanId)!;
        expect(scan.status).toBe('done');
        expect(h.opened).toEqual(['p2']);
        expect(h.closed).toEqual(['p2']);
        expect(h.sleeps).toHaveLength(1);
        expect(h.sleeps[0]).toBeGreaterThanOrEqual(GROUP_DELAY_MIN_MS);
        expect(h.sleeps[0]).toBeLessThanOrEqual(GROUP_DELAY_MAX_MS);
        expect(h.calls[0].vars.id).toBe('111');
        expect(h.calls[1].vars.id).toBe('222');
        expect(finishedEvents(h)).toHaveLength(1);
    });

    it('nhóm không đọc được: not_member, sang nhóm khác', async () => {
        const h = setup({
            profiles: ['p1'],
            script: (c) => (c.vars.id === '111' ? 'rác' : feedPage([['b1', nowSec - day]], null)),
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1, G2], origin: 'api' });
        await h.svc.whenIdle();
        const scan = h.store.getScan(scanId)!;
        expect(scan.status).toBe('done');
        expect((scan.details as any).groups[G1]).toBe('not_member');
        expect(scan.itemCount).toBe(1);
        expect((scan.details as any).shape).toBeTruthy();
    });

    it('dừng nhóm khi gặp bài cũ hơn sinceDays, giữ bài mới', async () => {
        const h = setup({
            profiles: ['p1'],
            script: () => feedPage([['n1', nowSec - day], ['n2', nowSec - 2 * day], ['old', nowSec - 10 * day], ['after', nowSec - 11 * day]], 'NEXT'),
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1], sinceDays: 7, origin: 'api' });
        await h.svc.whenIdle();
        const scan = h.store.getScan(scanId)!;
        expect(scan.itemCount).toBe(2);
        expect(h.calls).toHaveLength(1);
    });

    it('dừng nhóm khi đủ limitPerGroup', async () => {
        let k = 0;
        const h = setup({
            profiles: ['p1'],
            script: () => { const base = k++ * 10; return feedPage(Array.from({ length: 10 }, (_, i) => [`g${base + i}`, nowSec - day] as [string, number]), 'NEXT'); },
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1], limitPerGroup: 25, origin: 'api' });
        await h.svc.whenIdle();
        expect(h.store.getScan(scanId)!.itemCount).toBe(25);
        expect(h.calls).toHaveLength(3);
    });

    it('không truyền groupUrls: lấy nhóm quét gần nhất của profile đủ điều kiện', async () => {
        const G3 = 'https://www.facebook.com/groups/3';
        const h = setup({
            profiles: ['p1', 'p2'], membership: { p1: [G1, G2], p2: [G3, G1] }, scannedAt: { [G1]: 10, [G2]: 50, [G3]: 30 },
            script: () => feedPage([['a1', nowSec - day]], null),
        });
        h.svc.scanGroupFeeds({ origin: 'manual', limitPerGroup: 1 });
        await h.svc.whenIdle();
        expect(h.calls.map((c) => c.vars.id)).toEqual(['222', '3', '111']);
    });

    it('không truyền groupUrls và không profile nào: failed', async () => {
        const h = setup({ profiles: ['p1'], busy: ['p1'], membership: { p1: [G1] } });
        const { scanId } = h.svc.scanGroupFeeds({ origin: 'manual' });
        await h.svc.whenIdle();
        const scan = h.store.getScan(scanId)!;
        expect(scan.status).toBe('failed');
        expect(scan.errorCode).toBe('no_profile_available');
    });

    it('huỷ trong lúc nghỉ giữa nhóm: cancelled và đóng phiên', async () => {
        const h = setup({
            profiles: ['p1'], script: () => feedPage([['a1', nowSec - day]], null),
            onSleep: (_ms, svc) => { svc.cancel(); },
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1, G2], origin: 'api' });
        await h.svc.whenIdle();
        expect(h.store.getScan(scanId)!.status).toBe('cancelled');
        expect(h.closed).toEqual(['p1']);
        expect(h.calls).toHaveLength(1);
    });

    it('profile checkpoint giữa chừng: đổi sang profile khác cho cùng nhóm', async () => {
        const cp = `for (;;);${JSON.stringify({ errors: [{ message: 'checkpoint' }] })}`;
        const h = setup({
            profiles: ['p1', 'p2'],
            script: (c) => (c.profileId === 'p1' ? cp : feedPage([['z1', nowSec - day]], null)),
        });
        const { scanId } = h.svc.scanGroupFeeds({ groupUrls: [G1], origin: 'api' });
        await h.svc.whenIdle();
        const scan = h.store.getScan(scanId)!;
        expect(h.observed).toEqual([['p1', 'checkpoint']]);
        expect(scan.itemCount).toBe(1);
        expect(scan.profileIds).toEqual(['p1', 'p2']);
    });
});

describe('ResearchService stop', () => {
    it('stop() huỷ lượt đang chạy', async () => {
        const h = setup({ script: endless, onSleep: (_ms, svc) => svc.stop() });
        const scan = await run(h, { limit: 100 });
        expect(scan.status).toBe('cancelled');
    });
});
