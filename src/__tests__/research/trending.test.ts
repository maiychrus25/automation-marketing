import { parseTrendingParams, rankTrending, type TrendingRow } from '../../services/research/trending';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 26, 7);
const row = (extra: Partial<TrendingRow> = {}): TrendingRow => ({
    fbId: 'a', url: 'https://www.facebook.com/posts/a', title: 'Post', placeName: 'Group', placeId: 'g1',
    reactions: 50, comments: null, shares: null, postedAt: NOW - 5 * HOUR, capturedAt: NOW, ...extra,
});

describe('rankTrending', () => {
    it('ranks growth from 100 to 400 over three hours at 100 per hour', () => {
        expect(rankTrending([
            row({ reactions: 100, capturedAt: NOW - 3 * HOUR }),
            row({ reactions: 400 }),
        ], NOW, 20)).toEqual([{
            fbId: 'a', url: 'https://www.facebook.com/posts/a', text: 'Post', placeName: 'Group', placeId: 'g1',
            engagement: 400, score: 100, basis: 'growth', seen: 2, postedAt: NOW - 5 * HOUR,
        }]);
    });

    it('ranks a single observation by age at capture time, not current time', () => {
        expect(rankTrending([row()], NOW + HOUR, 20)[0]).toMatchObject({ score: 10, basis: 'age', seen: 1 });
    });

    it('uses the latest observation when the interval is less than an hour', () => {
        const items = rankTrending([
            row({ reactions: 5, capturedAt: NOW - HOUR + 1 }), row(),
        ], NOW, 20);
        expect(items[0]).toMatchObject({ engagement: 50, score: 10, basis: 'age' });
    });

    it('uses growth at exactly one hour and preserves negative growth', () => {
        expect(rankTrending([row({ reactions: 100, capturedAt: NOW - HOUR }), row()], NOW, 20)[0])
            .toMatchObject({ engagement: 50, score: -50, basis: 'growth', seen: 2 });
    });

    it('uses the earliest and latest captures regardless of input order', () => {
        const rows = [
            row({ reactions: 400, title: 'Latest', placeName: 'New group', url: 'https://www.facebook.com/latest' }),
            row({ reactions: 900, capturedAt: NOW - HOUR }),
            row({ reactions: 100, capturedAt: NOW - 3 * HOUR }),
        ];
        expect(rankTrending(rows, NOW, 20)[0]).toMatchObject({
            text: 'Latest', placeName: 'New group', url: 'https://www.facebook.com/latest',
            engagement: 400, score: 100, basis: 'growth', seen: 3,
        });
        expect(rows[0].title).toBe('Latest');
        expect(rows[2].reactions).toBe(100);
    });

    it('excludes posts without postedAt, including repeated observations', () => {
        expect(rankTrending([row({ postedAt: null })], NOW, 20)).toEqual([]);
        expect(rankTrending([
            row({ capturedAt: NOW - 3 * HOUR }), row({ postedAt: null }),
        ], NOW, 20)).toEqual([]);
    });

    it('excludes posts older than seven days but includes the exact boundary', () => {
        expect(rankTrending([row({ postedAt: NOW - 604800001 })], NOW, 20)).toEqual([]);
        expect(rankTrending([row({ postedAt: NOW - 604800000 })], NOW, 20)).toHaveLength(1);
    });

    it('counts null engagement components as zero and sums all components', () => {
        expect(rankTrending([row({ reactions: null })], NOW, 20)[0]).toMatchObject({ engagement: 0, score: 0 });
        expect(rankTrending([row({ reactions: null, comments: 30, shares: 20 })], NOW, 20)[0])
            .toMatchObject({ engagement: 50, score: 10 });
    });

    it('floors the age denominator at one hour', () => {
        expect(rankTrending([row({ postedAt: NOW - HOUR / 2 })], NOW, 20)[0].score).toBe(50);
    });

    it('sorts by descending score and applies the limit after ranking', () => {
        const rows = [row({ fbId: 'low', reactions: 5 }), row({ fbId: 'high', reactions: 500 }), row({ fbId: 'mid' })];
        expect(rankTrending(rows, NOW, 2).map((i) => [i.fbId, i.score])).toEqual([['high', 100], ['mid', 10]]);
    });

    it('truncates the latest title to 500 characters', () => {
        expect(rankTrending([row({ title: 'x'.repeat(501) })], NOW, 20)[0].text).toBe('x'.repeat(500));
    });

    it('returns an empty list when no observations match', () => {
        expect(rankTrending([], NOW, 20)).toEqual([]);
    });

    it('ranks a large history without losing observations or limiting before grouping', () => {
        const rows = Array.from({ length: 10000 }, (_, i) => [
            row({ fbId: `post-${i}`, reactions: i + 100, capturedAt: NOW }),
            row({ fbId: `post-${i}`, reactions: 100, capturedAt: NOW - HOUR }),
        ]).flat();
        const items = rankTrending(rows, NOW, 100);
        expect(items).toHaveLength(100);
        expect(items[0]).toMatchObject({ fbId: 'post-9999', score: 9999, seen: 2 });
        expect(items[99]).toMatchObject({ fbId: 'post-9900', score: 9900 });
    });
});

describe('parseTrendingParams', () => {
    it.each([undefined, {}, { queries: [], groupIds: [] }])('requires at least one query or group ID: %p', (params) => {
        expect(() => parseTrendingParams(params)).toThrow('Cần ít nhất một từ khoá hoặc mã nhóm');
    });

    it('defaults to 72 hours and 20 items, trimming queries without changing case', () => {
        expect(parseTrendingParams({ queries: [' Serum ', 'KEM'] })).toEqual({
            queries: ['Serum', 'KEM'], groupIds: [], sinceHours: 72, limit: 20,
        });
    });

    it('accepts group IDs without queries and explicit integer boundaries', () => {
        expect(parseTrendingParams({ groupIds: ['g1'], sinceHours: 168, limit: 100 })).toEqual({
            queries: [], groupIds: ['g1'], sinceHours: 168, limit: 100,
        });
        expect(parseTrendingParams({ queries: ['x'], sinceHours: 1, limit: 1 })).toMatchObject({ sinceHours: 1, limit: 1 });
    });

    it.each([169, 0, 1.5, '72', null, NaN, Infinity])('rejects invalid sinceHours: %p', (sinceHours) => {
        expect(() => parseTrendingParams({ queries: ['x'], sinceHours })).toThrow('sinceHours phải là số nguyên từ 1 đến 168');
    });

    it.each([101, 0, 1.5, '20', null, NaN, Infinity])('rejects invalid limit: %p', (limit) => {
        expect(() => parseTrendingParams({ queries: ['x'], limit })).toThrow('limit phải là số nguyên từ 1 đến 100');
    });

    it('enforces the query count and length limits', () => {
        expect(() => parseTrendingParams({ queries: Array(11).fill('x') })).toThrow('queries tối đa 10 mục');
        expect(() => parseTrendingParams({ queries: ['x'.repeat(81)] })).toThrow('queries chứa từ khoá không hợp lệ');
        expect(parseTrendingParams({ queries: Array(10).fill('x'.repeat(80)) }).queries).toHaveLength(10);
    });

    it('enforces the group ID count limit', () => {
        expect(() => parseTrendingParams({ groupIds: Array(21).fill('g') })).toThrow('groupIds tối đa 20 mục');
        expect(parseTrendingParams({ groupIds: Array(20).fill('g') }).groupIds).toHaveLength(20);
    });

    it.each([null, 'x', [1], [''], ['   ']])('rejects invalid query lists: %p', (queries) => {
        expect(() => parseTrendingParams({ queries, groupIds: ['g1'] })).toThrow(/queries/);
    });

    it.each([null, 'g', [1], [''], ['   ']])('rejects invalid group ID lists: %p', (groupIds) => {
        expect(() => parseTrendingParams({ queries: ['x'], groupIds })).toThrow(/groupIds/);
    });
});
