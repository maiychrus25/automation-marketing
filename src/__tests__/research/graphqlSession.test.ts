import {
    GraphqlSession, ResearchError, buildSearchVariables, buildGroupFeedVariables, readTokensInPage,
} from '../../services/research/graphqlSession';

const SEARCH = 'SearchCometResultsPaginatedResultsQuery';
const sleepMock = () => jest.fn(async () => undefined);

function makePage(opts: {
    url?: string; tokens?: any; emitAt?: { scroll: number; req: any }[]; fetchResult?: any; cookies?: any[];
} = {}) {
    const listeners: Record<string, Function[]> = {};
    let scrolls = 0;
    const page: any = {
        goto: jest.fn(async () => undefined),
        url: jest.fn(() => opts.url ?? 'https://www.facebook.com/'),
        evaluate: jest.fn(async (fn: Function, arg?: any) => {
            if (fn.name === 'readTokensInPage') {
                return opts.tokens ?? { dtsg: 'DTSG', lsd: 'LSD', userId: '100', loginForm: false };
            }
            (globalThis as any).fetch = jest.fn(async () => ({
                status: opts.fetchResult?.status ?? 200, text: async () => opts.fetchResult?.text ?? 'body',
            }));
            (globalThis as any).__lastFetch = (globalThis as any).fetch;
            return fn(arg);
        }),
        on: jest.fn((ev: string, cb: Function) => { (listeners[ev] ||= []).push(cb); }),
        off: jest.fn((ev: string, cb: Function) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); }),
        mouse: {
            wheel: jest.fn(async () => {
                scrolls++;
                for (const e of opts.emitAt || []) {
                    if (e.scroll === scrolls) (listeners.request || []).forEach((cb) => cb(e.req));
                }
            }),
        },
        context: () => ({ cookies: async () => opts.cookies ?? [] }),
    };
    return { page, listeners };
}

const req = (name: string, extra: Record<string, string> = {}, method = 'POST', url = 'https://www.facebook.com/api/graphql/') => ({
    url: () => url, method: () => method,
    postData: () => new URLSearchParams({
        fb_api_req_friendly_name: name, doc_id: '999', variables: JSON.stringify({ count: 5, cursor: null, args: { text: 'x' } }), ...extra,
    }).toString(),
});

function makeStore() {
    const m = new Map<string, any>();
    return {
        m,
        getQuery: jest.fn((n: string) => m.get(n)),
        saveQuery: jest.fn((n: string, docId: string, tpl: string, at: number) => {
            m.set(n, { friendlyName: n, docId, variablesTemplate: tpl, capturedAt: at });
        }),
    };
}
const mk = (page: any, store = makeStore()) =>
    ({ store, s: new GraphqlSession(page, store as any, { now: () => 1000, sleep: sleepMock(), random: () => 0.5 }) });

describe('open', () => {
    it('reads tokens and succeeds', async () => {
        const { page } = makePage();
        const { s } = mk(page);
        await s.open();
        expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/', expect.objectContaining({ waitUntil: 'domcontentloaded', timeout: 45000 }));
    });
    it('/login -> logged_out', async () => {
        const { page } = makePage({ url: 'https://www.facebook.com/login/?next=x' });
        await expect(mk(page).s.open()).rejects.toMatchObject({ code: 'logged_out' });
    });
    it('/checkpoint -> checkpoint', async () => {
        const { page } = makePage({ url: 'https://www.facebook.com/checkpoint/1' });
        await expect(mk(page).s.open()).rejects.toMatchObject({ code: 'checkpoint' });
    });
    it('missing fb_dtsg -> logged_out', async () => {
        const { page } = makePage({ tokens: { dtsg: '', lsd: 'L', userId: '1', loginForm: false } });
        const err = await mk(page).s.open().catch((e) => e);
        expect(err).toBeInstanceOf(ResearchError);
        expect(err.code).toBe('logged_out');
    });
    it('login form -> logged_out', async () => {
        const { page } = makePage({ tokens: { dtsg: '', lsd: '', userId: '', loginForm: true } });
        await expect(mk(page).s.open()).rejects.toMatchObject({ code: 'logged_out' });
    });
    it('user id falls back to c_user cookie', async () => {
        const { page } = makePage({
            tokens: { dtsg: 'D', lsd: 'L', userId: '', loginForm: false },
            cookies: [{ name: 'c_user', value: '777' }],
        });
        const { s } = mk(page);
        await s.open();
        await s.call({ friendlyName: SEARCH, docId: '1', variables: {} }, {});
        const body = new URLSearchParams(((globalThis as any).fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.get('av')).toBe('777');
    });
});

describe('readTokensInPage (in-page)', () => {
    afterEach(() => { delete (globalThis as any).require; delete (globalThis as any).document; });
    it('uses require modules when available', () => {
        (globalThis as any).require = (n: string) => ({ DTSGInitialData: { token: 'a' }, LSD: { token: 'b' }, CurrentUserInitialData: { USER_ID: '9' } } as any)[n];
        (globalThis as any).document = { documentElement: { outerHTML: '' }, querySelector: () => null };
        expect(readTokensInPage()).toEqual({ dtsg: 'a', lsd: 'b', userId: '9', loginForm: false });
    });
    it('falls back to HTML regex', () => {
        (globalThis as any).require = () => { throw new Error('nope'); };
        (globalThis as any).document = {
            documentElement: { outerHTML: '..."DTSGInitialData",[],{"token":"HD"}..."LSD",[],{"token":"HL"}..."USER_ID":"55"' },
            querySelector: () => null,
        };
        const r = readTokensInPage();
        expect(r.dtsg).toBe('HD');
        expect(r.lsd).toBe('HL');
    });
});

describe('ensureQuery', () => {
    it('captures after 2nd scroll, saves under name:source, then uses store', async () => {
        const { page, listeners } = makePage({ emitAt: [{ scroll: 2, req: req(SEARCH) }] });
        const { s, store } = mk(page);
        await s.open();
        const q = await s.ensureQuery('posts', SEARCH, 'https://www.facebook.com/search/posts?q=x');
        expect(q).toMatchObject({ friendlyName: SEARCH, docId: '999' });
        expect(q.variables).toEqual({ count: 5, cursor: null, args: { text: 'x' } });
        expect(page.mouse.wheel).toHaveBeenCalledTimes(2);
        expect(store.saveQuery).toHaveBeenCalledWith(`${SEARCH}:posts`, '999', expect.any(String), 1000);
        expect(listeners.request).toHaveLength(0);
        page.goto.mockClear();
        const again = await s.ensureQuery('posts', SEARCH, 'https://x');
        expect(again).toEqual(q);
        expect(page.goto).not.toHaveBeenCalled();
    });
    it('ignores non-graphql and wrong-name requests, accepts fallback name', async () => {
        const { page } = makePage({ emitAt: [
            { scroll: 1, req: req('Other') },
            { scroll: 1, req: req(SEARCH, {}, 'GET') },
            { scroll: 2, req: req('SearchCometResultsInitialQueryResultsFoo') },
        ] });
        const { s } = mk(page);
        const q = await s.ensureQuery('posts', SEARCH, 'https://x');
        expect(q.friendlyName).toBe('SearchCometResultsInitialQueryResultsFoo');
    });
    it('group_feed fallback matches GroupsCometFeed', async () => {
        const { page } = makePage({ emitAt: [{ scroll: 1, req: req('GroupsCometFeedXyz') }] });
        const q = await mk(page).s.ensureQuery('group_feed', 'GroupsCometFeedRegularStoriesPaginationQuery', 'https://x');
        expect(q.friendlyName).toBe('GroupsCometFeedXyz');
    });
    it('nothing captured after 6 scrolls -> query_changed naming the URL; listener removed', async () => {
        const { page, listeners } = makePage();
        const { s } = mk(page);
        const err = await s.ensureQuery('posts', SEARCH, 'https://www.facebook.com/search/posts?q=zz').catch((e) => e);
        expect(err).toMatchObject({ code: 'query_changed' });
        expect(err.message).toContain('https://www.facebook.com/search/posts?q=zz');
        expect(page.mouse.wheel).toHaveBeenCalledTimes(6);
        expect(listeners.request).toHaveLength(0);
    });
});

describe('call', () => {
    const query = { friendlyName: SEARCH, docId: '999', variables: {} };
    async function opened(opts: any = {}) {
        const { page } = makePage(opts);
        const { s } = mk(page);
        await s.open();
        return { page, s };
    }
    it('sends the exact body and returns text', async () => {
        const { s } = await opened({ fetchResult: { text: 'RAW' } });
        const out = await s.call(query, { count: 5, cursor: 'c' });
        expect(out).toBe('RAW');
        const [url, init] = ((globalThis as any).fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('/api/graphql/');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('include');
        expect(init.headers).toEqual({
            'Content-Type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': SEARCH, 'x-fb-lsd': 'LSD',
        });
        const b = new URLSearchParams(init.body);
        expect(Object.fromEntries(b)).toEqual({
            av: '100', __user: '100', __a: '1', fb_dtsg: 'DTSG', lsd: 'LSD', fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: SEARCH, variables: JSON.stringify({ count: 5, cursor: 'c' }),
            server_timestamps: 'true', doc_id: '999',
        });
    });
    it.each([[401, 'logged_out'], [403, 'logged_out'], [429, 'rate_limited'], [500, 'parse_failed']])('status %d -> %s', async (status, code) => {
        const { s } = await opened({ fetchResult: { status } });
        const err = await s.call(query, {}).catch((e) => e);
        expect(err.code).toBe(code);
        expect(err.message).toContain(String(status));
    });
    it('throws if not opened', async () => {
        const { page } = makePage();
        await expect(mk(page).s.call(query, {})).rejects.toBeInstanceOf(ResearchError);
    });
});

describe('variable builders', () => {
    const tpl = { count: 5, cursor: null, extra: { keep: 1 }, args: { text: 'old', experience: { type: 'POSTS_TAB' }, filters: [], other: 'k' }, __relay_internal__x: true };
    it('sets text/cursor/count, keeps unknown keys, does not mutate', () => {
        const snapshot = JSON.stringify(tpl);
        const v: any = buildSearchVariables(tpl, { query: 'kw', source: 'posts', cursor: 'abc', count: 10 });
        expect(v.args.text).toBe('kw');
        expect(v.cursor).toBe('abc');
        expect(v.count).toBe(10);
        expect(v.args.other).toBe('k');
        expect(v.args.experience).toEqual({ type: 'POSTS_TAB' });
        expect(v.extra).toEqual({ keep: 1 });
        expect(v.__relay_internal__x).toBe(true);
        expect(v.args.filters).toEqual([]);
        expect(JSON.stringify(tpl)).toBe(snapshot);
    });
    it('recent and year filters', () => {
        const v: any = buildSearchVariables(tpl, { query: 'kw', source: 'posts', recent: true, year: 2025, cursor: null, count: 5 });
        expect(v.args.filters).toEqual([
            '{"name":"recent_posts","args":""}',
            JSON.stringify({ name: 'creation_time', args: JSON.stringify({ start_year: '2025', start_month: '2025-1', end_year: '2025', end_month: '2025-12' }) }),
        ]);
    });
    it('template without args still gets cursor/count', () => {
        const v: any = buildSearchVariables({ foo: 1 }, { query: 'kw', source: 'groups', cursor: 'c', count: 3 });
        expect(v).toMatchObject({ foo: 1, cursor: 'c', count: 3 });
    });
    it('group feed builder', () => {
        const t = { count: 3, cursor: null, id: 'G', scale: 2 };
        const v = buildGroupFeedVariables(t, { cursor: 'z', count: 30 });
        expect(v).toEqual({ count: 30, cursor: 'z', id: 'G', scale: 2 });
        expect(t.cursor).toBeNull();
    });
});

describe('recapture', () => {
    it('works once, second time throws query_changed', async () => {
        const { page } = makePage({ emitAt: [{ scroll: 1, req: req(SEARCH, { doc_id: '1' }) }] });
        const { s, store } = mk(page);
        await s.ensureQuery('posts', SEARCH, 'https://x');
        // new doc id on recapture
        const p2 = makePage({ emitAt: [{ scroll: 1, req: req(SEARCH, { doc_id: '2' }) }] });
        const sess = new GraphqlSession(p2.page, store as any, { now: () => 2, sleep: sleepMock(), random: () => 0 });
        const q = await sess.recapture('posts', SEARCH, 'https://x');
        expect(q.docId).toBe('2');
        expect(p2.page.goto).toHaveBeenCalled();
        expect(store.m.get(`${SEARCH}:posts`).docId).toBe('2');
        await expect(sess.recapture('posts', SEARCH, 'https://x')).rejects.toMatchObject({ code: 'query_changed' });
    });
});

describe('fix round 1', () => {
    it('keeps scrolling past a fallback and stores the exact match', async () => {
        const { page } = makePage({ emitAt: [
            { scroll: 1, req: req('SearchCometResultsInitialFoo', { doc_id: '111' }) },
            { scroll: 3, req: req(SEARCH, { doc_id: '222' }) },
        ] });
        const { s, store } = mk(page);
        const q = await s.ensureQuery('posts', SEARCH, 'https://x');
        expect(q).toMatchObject({ friendlyName: SEARCH, docId: '222' });
        expect(page.mouse.wheel).toHaveBeenCalledTimes(3);
        expect(store.m.get(`${SEARCH}:posts`).docId).toBe('222');
    });
    it('only fallback seen -> uses it after all 6 scrolls with its real name', async () => {
        const { page } = makePage({ emitAt: [{ scroll: 1, req: req('SearchCometResultsInitialFoo', { doc_id: '111' }) }] });
        const { s, store } = mk(page);
        const q = await s.ensureQuery('posts', SEARCH, 'https://x');
        expect(q).toMatchObject({ friendlyName: 'SearchCometResultsInitialFoo', docId: '111' });
        expect(page.mouse.wheel).toHaveBeenCalledTimes(6);
        expect(store.m.has(`${SEARCH}:posts`)).toBe(true);
    });
    it('call: closed target -> Mất kết nối; network error -> Lỗi mạng', async () => {
        const { page } = makePage();
        const { s } = mk(page);
        await s.open();
        const q = { friendlyName: SEARCH, docId: '1', variables: {} };
        const real = page.evaluate.getMockImplementation();
        page.evaluate.mockImplementation(async () => { throw new Error('Target page, context or browser has been closed'); });
        const e1 = await s.call(q, {}).catch((e: any) => e);
        expect(e1).toBeInstanceOf(ResearchError);
        expect(e1.code).toBe('parse_failed');
        expect(e1.message).toContain('Mất kết nối với trang');
        page.evaluate.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
        const e2 = await s.call(q, {}).catch((e: any) => e);
        expect(e2.code).toBe('parse_failed');
        expect(e2.message).toContain('Lỗi mạng khi gọi Facebook');
        page.evaluate.mockImplementation(async () => { throw new Error('Execution context was destroyed ' + 'x'.repeat(500)); });
        const e3 = await s.call(q, {}).catch((e: any) => e);
        expect(e3.message).toContain('Mất kết nối với trang');
        expect(e3.message.length).toBeLessThanOrEqual(200);
        page.evaluate.mockImplementation(real);
    });
    it('goto failure in open and ensureQuery -> parse_failed, listener removed', async () => {
        const a = makePage();
        a.page.goto.mockRejectedValue(new Error('Timeout 45000ms exceeded'));
        const e1 = await mk(a.page).s.open().catch((e: any) => e);
        expect(e1).toMatchObject({ code: 'parse_failed' });
        expect(e1.message).toContain('Không tải được trang');
        const b = makePage();
        b.page.goto.mockRejectedValue(new Error('net::ERR_FAILED'));
        const e2 = await mk(b.page).s.ensureQuery('posts', SEARCH, 'https://x').catch((e: any) => e);
        expect(e2).toMatchObject({ code: 'parse_failed' });
        expect(b.listeners.request).toHaveLength(0);
    });
    it('empty user id after cookie fallback -> logged_out', async () => {
        const { page } = makePage({ tokens: { dtsg: 'D', lsd: 'L', userId: '', loginForm: false }, cookies: [] });
        await expect(mk(page).s.open()).rejects.toMatchObject({ code: 'logged_out' });
    });
    it('corrupt stored template -> recaptures', async () => {
        const { page } = makePage({ emitAt: [{ scroll: 1, req: req(SEARCH, { doc_id: '5' }) }] });
        const store = makeStore();
        store.m.set(`${SEARCH}:posts`, { friendlyName: 'k', docId: '1', variablesTemplate: '{bad', capturedAt: 1 });
        const q = await mk(page, store).s.ensureQuery('posts', SEARCH, 'https://x');
        expect(q.docId).toBe('5');
    });
});
