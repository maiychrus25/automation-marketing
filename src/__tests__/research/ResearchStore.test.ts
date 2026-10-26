import { memoryDb } from '../facebookPoster/helpers';
import { ResearchStore } from '../../services/research/ResearchStore';
import type { ResearchItemInput } from '../../models/research';

function setup() {
    const db = memoryDb();
    const store = new ResearchStore(db);
    store.ensureSchema();
    return { db, store };
}
const scan = (id: string, source: any = 'posts', startedAt = 1000) =>
    ({ id, source, query: 'q', params: { year: 2025 }, profileIds: ['p1'], origin: 'manual' as const, startedAt });
const post = (fbId: string, extra: Partial<ResearchItemInput> = {}): ResearchItemInput =>
    ({ kind: 'post', fbId, url: `https://fb.test/${fbId}`, title: `t${fbId}`, ...extra });

describe('ResearchStore', () => {
    it('creates schema idempotently with indexes', () => {
        const { db, store } = setup();
        store.ensureSchema();
        const names = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
        expect(names).toEqual(expect.arrayContaining(['idx_research_items_scan', 'idx_research_items_kind_fb', 'idx_research_items_profile']));
    });

    it('creates, finishes and reads scans with json defaults', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        expect(store.getScan('s1')).toMatchObject({ status: 'running', details: {}, profileIds: ['p1'], params: { year: 2025 }, itemCount: 0, finishedAt: null });
        store.addItems('s1', [post('a')], 'p1', 2000);
        store.finishScan('s1', 'failed', 'checkpoint', 'Lỗi', { profiles: { p1: { items: 1, error: 'checkpoint' } } }, 3000);
        expect(store.getScan('s1')).toMatchObject({ status: 'failed', errorCode: 'checkpoint', error: 'Lỗi', itemCount: 1, finishedAt: 3000, details: { profiles: { p1: { items: 1, error: 'checkpoint' } } } });
        store.updateScanProfiles('s1', ['p1', 'p2']);
        expect(store.getScan('s1')!.profileIds).toEqual(['p1', 'p2']);
        expect(store.getScan('nope')).toBeUndefined();
    });

    it('listScans filters by source, newest first, paginates', () => {
        const { store } = setup();
        store.createScan(scan('a', 'posts', 1));
        store.createScan(scan('b', 'groups', 2));
        store.createScan(scan('c', 'posts', 3));
        expect(store.listScans().map((s) => s.id)).toEqual(['c', 'b', 'a']);
        expect(store.listScans({ source: 'posts' }).map((s) => s.id)).toEqual(['c', 'a']);
        expect(store.listScans({ limit: 1, offset: 1 }).map((s) => s.id)).toEqual(['b']);
    });

    it('addItems dedups by (scan, kind, fb_id) and returns inserted count', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.createScan(scan('s2'));
        expect(store.addItems('s1', [post('a'), post('b'), post('a')], 'p1', 10)).toBe(2);
        expect(store.addItems('s1', [post('b'), post('c')], 'p1', 11)).toBe(1);
        expect(store.addItems('s2', [post('a')], 'p1', 12)).toBe(1);
        expect(store.addItems('s1', [{ kind: 'group', fbId: 'a', url: '', title: 'g' }], 'p1', 13)).toBe(1);
        expect(store.listItems('s1').total).toBe(4);
    });

    it('truncates title to 5000 chars', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.addItems('s1', [post('a', { title: 'x'.repeat(6000) })], 'p1', 1);
        expect(store.listItems('s1').items[0].title).toHaveLength(5000);
    });

    it('engagement sums non-null values, null when all null; sorts nulls last', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.addItems('s1', [
            post('none'),
            post('low', { reactions: 1, comments: null, shares: null }),
            post('high', { reactions: 10, comments: 5, shares: 2 }),
            post('zero', { reactions: 0 }),
        ], 'p1', 1);
        const { items } = store.listItems('s1', { sort: 'engagement' });
        expect(items.map((i) => i.fbId)).toEqual(['high', 'low', 'zero', 'none']);
        expect(items.map((i) => i.engagement)).toEqual([17, 1, 0, null]);
        expect(items[0].reactions).toBe(10);
        expect(items[3].comments).toBeNull();
    });

    it('sorts recent by posted_at (captured_at fallback) and members desc nulls last', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.addItems('s1', [post('old', { postedAt: 100 }), post('new', { postedAt: 900 }), post('mid', { postedAt: 500 })], 'p1', 1);
        expect(store.listItems('s1', { sort: 'recent' }).items.map((i) => i.fbId)).toEqual(['new', 'mid', 'old']);

        store.createScan(scan('g1', 'groups'));
        store.addItems('g1', [
            { kind: 'group', fbId: 'a', url: '', title: 'A', memberCount: 10 },
            { kind: 'group', fbId: 'b', url: '', title: 'B', memberCount: null },
            { kind: 'group', fbId: 'c', url: '', title: 'C', memberCount: 500 },
        ], 'p1', 50);
        expect(store.listItems('g1', { sort: 'members' }).items.map((i) => i.fbId)).toEqual(['c', 'a', 'b']);
        expect(store.listItems('g1', { sort: 'recent' }).items).toHaveLength(3);
    });

    it('engagementRate uses member_count from the most recent groups scan, rounded to 4 decimals', () => {
        const { store } = setup();
        store.createScan(scan('g-old', 'groups', 10));
        store.addItems('g-old', [{ kind: 'group', fbId: 'G1', url: '', title: 'G', memberCount: 1000 }], 'p1', 100);
        store.createScan(scan('g-new', 'groups', 20));
        store.addItems('g-new', [{ kind: 'group', fbId: 'G1', url: '', title: 'G', memberCount: 3000 }], 'p1', 200);
        store.createScan(scan('pg', 'pages', 25));
        store.addItems('pg', [{ kind: 'group', fbId: 'G1', url: '', title: 'ignored', memberCount: 1 }], 'p1', 300); // không phải lượt quét groups
        store.createScan(scan('s1'));
        store.addItems('s1', [
            post('p1', { placeId: 'G1', placeKind: 'group', reactions: 10 }),
            post('p2', { placeId: 'UNKNOWN', placeKind: 'group', reactions: 10 }),
            post('p3', { placeId: 'G1', placeKind: 'group' }),
        ], 'p1', 400);
        const byId = Object.fromEntries(store.listItems('s1').items.map((i) => [i.fbId, i]));
        expect(byId.p1.engagementRate).toBe(0.0033);
        expect(byId.p2.engagementRate).toBeNull();
        expect(byId.p3.engagementRate).toBeNull();
    });

    it('listItems clamps limit (default 200, max 500) and paginates', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.addItems('s1', Array.from({ length: 600 }, (_, i) => post(`i${i}`, { reactions: i })), 'p1', 1);
        expect(store.listItems('s1').items).toHaveLength(200);
        expect(store.listItems('s1', { limit: 9999 }).items).toHaveLength(500);
        const page = store.listItems('s1', { limit: 2, offset: 1 });
        expect(page.total).toBe(600);
        expect(page.items.map((i) => i.fbId)).toEqual(['i598', 'i597']);
    });

    it('itemsCapturedSince counts per profile from the threshold', () => {
        const { store } = setup();
        store.createScan(scan('s1'));
        store.addItems('s1', [post('a'), post('b')], 'p1', 100);
        store.addItems('s1', [post('c')], 'p1', 500);
        store.addItems('s1', [post('d')], 'p2', 500);
        expect(store.itemsCapturedSince('p1', 200)).toBe(1);
        expect(store.itemsCapturedSince('p1', 0)).toBe(3);
        expect(store.itemsCapturedSince('none', 0)).toBe(0);
    });

    it('saves and overwrites queries', () => {
        const { store } = setup();
        expect(store.getQuery('X')).toBeUndefined();
        store.saveQuery('X', 'doc1', '{"a":1}', 1);
        store.saveQuery('X', 'doc2', '{"a":2}', 2);
        expect(store.getQuery('X')).toEqual({ friendlyName: 'X', docId: 'doc2', variablesTemplate: '{"a":2}', capturedAt: 2 });
    });

    it('pruneOlderThan deletes old scans together with their items', () => {
        const { db, store } = setup();
        store.createScan(scan('old', 'posts', 100));
        store.createScan(scan('new', 'posts', 900));
        store.addItems('old', [post('a'), post('b')], 'p1', 100);
        store.addItems('new', [post('a')], 'p1', 900);
        expect(store.pruneOlderThan(500)).toBe(1);
        expect(store.getScan('old')).toBeUndefined();
        expect(db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM research_items WHERE scan_id='old'")!.n).toBe(0);
        expect(store.listItems('new').total).toBe(1);
    });

    it('failInterruptedScans turns running scans into failed only', () => {
        const { store } = setup();
        store.createScan(scan('r'));
        store.createScan(scan('d'));
        store.addItems('r', [post('a')], 'p1', 1);
        store.finishScan('d', 'done', '', '', {}, 5);
        expect(store.failInterruptedScans(9000)).toBe(1);
        expect(store.getScan('r')).toMatchObject({ status: 'failed', finishedAt: 9000, itemCount: 1 });
        expect(store.getScan('r')!.error).not.toBe('');
        expect(store.getScan('d')).toMatchObject({ status: 'done', finishedAt: 5 });
        expect(store.failInterruptedScans(9100)).toBe(0);
    });

    it('countScans counts all or by source', () => {
        const { store } = setup();
        store.createScan(scan('a', 'posts'));
        store.createScan(scan('b', 'groups'));
        expect(store.countScans()).toBe(2);
        expect(store.countScans('groups')).toBe(1);
    });

    describe('trendingRows', () => {
        it('matches trimmed queries case-insensitively and returns only posts from posts scans', () => {
            const { store } = setup();
            for (const [id, source, query] of [['match', 'posts', 'serum '], ['other', 'posts', 'cream'], ['groups', 'groups', 'serum']]) {
                store.createScan({ ...scan(id, source, 1000), query });
                store.addItems(id, [post(id, { placeName: 'Group', placeId: 'g1', reactions: 10, comments: 2, shares: 1, postedAt: 500 }),
                    { kind: 'group', fbId: `${id}-group`, title: 'Group', url: '' }], 'p1', 1200);
                store.finishScan(id, 'done', '', '', {}, 1500);
            }
            expect(store.trendingRows({ queries: [' Serum '], groupIds: [], since: 1000 })).toEqual([{
                fbId: 'match', url: 'https://fb.test/match', title: 'tmatch', placeName: 'Group', placeId: 'g1',
                reactions: 10, comments: 2, shares: 1, postedAt: 500, capturedAt: 1200,
            }]);
        });

        it.each([
            ['CHĂM SÓC Da ', 'chăm sóc da'],
            ['chăm', 'chăm'.normalize('NFD')],
            ['chăm'.normalize('NFD'), 'CHĂM'],
        ])('matches Vietnamese queries after NFC normalization and case folding: %s / %s', (storedQuery, query) => {
            const { store } = setup();
            store.createScan({ ...scan('match'), query: storedQuery });
            store.addItems('match', [post('matching-post')], 'p1', 1200);
            store.finishScan('match', 'done', '', '', {}, 1500);
            expect(store.trendingRows({ queries: [query], groupIds: [], since: 1000 }).map((item) => item.fbId))
                .toEqual(['matching-post']);
        });

        it('does not match a different Vietnamese word or remove accents', () => {
            const { store } = setup();
            store.createScan({ ...scan('other'), query: 'CHĂM SÓC Da ' });
            store.addItems('other', [post('unrelated-post')], 'p1', 1200);
            store.finishScan('other', 'done', '', '', {}, 1500);
            expect(store.trendingRows({ queries: ['trang điểm'], groupIds: [], since: 1000 })).toEqual([]);
            expect(store.trendingRows({ queries: ['cham soc da'], groupIds: [], since: 1000 })).toEqual([]);
        });

        it('matches group_feed posts by place_id independently of the query', () => {
            const { store } = setup();
            store.createScan(scan('feed', 'group_feed'));
            store.addItems('feed', [post('yes', { placeId: 'g1' }), post('no', { placeId: 'g2' })], 'p1', 1200);
            store.finishScan('feed', 'done', '', '', {}, 1500);
            store.createScan(scan('posts'));
            store.addItems('posts', [post('wrong-source', { placeId: 'g1' })], 'p1', 1200);
            store.finishScan('posts', 'done', '', '', {}, 1500);
            expect(store.trendingRows({ queries: [], groupIds: ['g1'], since: 1000 })).toEqual([{
                fbId: 'yes', url: 'https://fb.test/yes', title: 'tyes', placeName: '', placeId: 'g1',
                reactions: null, comments: null, shares: null, postedAt: null, capturedAt: 1200,
            }]);
            expect(store.trendingRows({ queries: ['q'], groupIds: ['g1'], since: 1000 }).map((i) => i.fbId).sort())
                .toEqual(['wrong-source', 'yes']);
        });

        it('excludes failed, running, cancelled and old scans even if captured or finished recently', () => {
            const { store } = setup();
            for (const status of ['done', 'failed', 'running', 'cancelled'] as const) {
                store.createScan(scan(status, 'posts', 1000));
                store.addItems(status, [post(status)], 'p1', 1200);
                if (status !== 'running') store.finishScan(status, status, '', '', {}, 1500);
            }
            store.createScan(scan('old', 'posts', 999));
            store.addItems('old', [post('old')], 'p1', 1200);
            store.finishScan('old', 'done', '', '', {}, 1500);
            expect(store.trendingRows({ queries: ['q'], groupIds: [], since: 1000 }).map((i) => i.fbId)).toEqual(['done']);
        });

        it('returns an empty list for a keyword without any completed scan', () => {
            const { store } = setup();
            store.createScan(scan('running'));
            store.addItems('running', [post('a')], 'p1', 1200);
            expect(store.trendingRows({ queries: ['q'], groupIds: [], since: 0 })).toEqual([]);
            expect(store.trendingRows({ queries: ['unknown'], groupIds: [], since: 0 })).toEqual([]);
        });

        it('uses bound query and group ID values and returns no rows for empty filters', () => {
            const { store } = setup();
            store.createScan(scan('done'));
            store.addItems('done', [post('a')], 'p1', 1200);
            store.finishScan('done', 'done', '', '', {}, 1500);
            expect(store.trendingRows({ queries: ["q') OR 1=1 --"], groupIds: ["g') OR 1=1 --"], since: 0 })).toEqual([]);
            expect(store.trendingRows({ queries: [], groupIds: [], since: 0 })).toEqual([]);
        });
    });
});
