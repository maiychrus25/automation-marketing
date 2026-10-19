import * as fs from 'fs';
import * as path from 'path';
import {
    parseGraphqlChunks, parseCompactNumber, parseSearchPosts, parseSearchGroups,
    parseSearchPages, parseGroupFeed, describeShape,
} from '../../services/research/parsers';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('parseCompactNumber', () => {
    it.each([
        ['1,2K', 1200], ['1.2K', 1200], ['12 N', 12000], ['12 nghìn', 12000], ['1,5M', 1500000],
        ['1,5 Tr', 1500000], ['1,5 triệu', 1500000], ['1.234', 1234], ['1,234', 1234],
        ['1.234.567', 1234567], ['987', 987], ['12K thành viên', 12000], ['1,2 Tr người theo dõi', 1200000],
        ['12 người theo dõi', 12], ['1,1K', 1100],
    ])('%s -> %d', (text, expected) => {
        expect(parseCompactNumber(text)).toBe(expected);
    });
    it.each(['', '   ', 'abc', 'Công khai', '--'])('"%s" -> null', (text) => {
        expect(parseCompactNumber(text)).toBeNull();
    });
});

describe('parseGraphqlChunks', () => {
    it('strips for(;;); and reads multi-line JSON', () => {
        const chunks = parseGraphqlChunks('for (;;);{"a":1}\n{"b":2}\n\n');
        expect(chunks).toEqual([{ a: 1 }, { b: 2 }]);
    });
    it('skips broken lines and never throws', () => {
        expect(parseGraphqlChunks('{"a":1}\n{oops\n{"c":3}')).toEqual([{ a: 1 }, { c: 3 }]);
        expect(parseGraphqlChunks('')).toEqual([]);
        expect(parseGraphqlChunks(fx('garbage.txt'))).toEqual([]);
    });
    it('reads a single pretty-printed JSON document', () => {
        expect(parseGraphqlChunks('for (;;);{\n  "a": 1\n}')).toEqual([{ a: 1 }]);
    });
});

describe('parseSearchPosts', () => {
    const r = parseSearchPosts(fx('search-posts.txt'));
    it('reads all fields, drops the item without id, takes cursor from the second line', () => {
        expect(r.errorCode).toBeNull();
        expect(r.endCursor).toBe('CURSOR_POSTS_NEXT');
        expect(r.items).toHaveLength(2);
        expect(r.items[0]).toEqual({
            kind: 'post', fbId: '222222222222221',
            url: 'https://www.facebook.com/groups/111111111111111/posts/222222222222221/',
            title: 'Bài mẫu giả số một',
            placeKind: 'group', placeId: '111111111111111', placeName: 'Nhóm Giả Một',
            authorKind: 'person', authorId: '100000000000001', authorName: 'Người Dùng A',
            authorUrl: 'https://www.facebook.com/profile.php?id=100000000000001',
            privacy: '', memberCount: null, followerCount: null,
            reactions: 120, comments: 15, shares: 4, postedAt: 1760000000 * 1000,
        });
    });
    it('reads page author, page place and string counts (relay_rendering_strategy)', () => {
        const p = r.items[1];
        expect(p.authorKind).toBe('page');
        expect(p.authorName).toBe('Trang Giả B');
        expect(p.authorUrl).toBe('https://www.facebook.com/page.fake.100000000000002');
        expect(p.placeKind).toBe('page');
        expect([p.reactions, p.comments, p.shares]).toEqual([1200, 12000, 3]);
    });
});

describe('missing fields', () => {
    it('gives null (never 0) and fallbacks', () => {
        const r = parseSearchPosts(fx('missing-fields.txt'));
        expect(r.errorCode).toBeNull();
        expect(r.items).toHaveLength(1);
        const p = r.items[0];
        expect(p.title).toBe('');
        expect([p.reactions, p.comments, p.shares, p.postedAt]).toEqual([null, null, null, null]);
        expect(p.authorKind).toBe('unknown');
        expect(p.authorId).toBe('');
        expect(p.placeKind).toBe('group');
        expect(p.placeId).toBe('111111111111111');
    });
    it('groups and pages without snippet', () => {
        const text = JSON.stringify({ data: { serpResponse: { results: { edges: [
            { rendering_strategy: { view_model: { profile: { id: '111111111111119', name: 'Nhóm Giả Chín', url: 'https://www.facebook.com/groups/111111111111119/' } } } },
        ] } } } });
        const g = parseSearchGroups(text).items[0];
        expect(g.privacy).toBe('');
        expect(g.memberCount).toBeNull();
        const pg = parseSearchPages(text).items[0];
        expect(pg.followerCount).toBeNull();
    });
});

describe('parseSearchGroups', () => {
    it('reads profile, privacy and member counts', () => {
        const r = parseSearchGroups(fx('search-groups.txt'));
        expect(r.errorCode).toBeNull();
        expect(r.endCursor).toBe('CURSOR_GROUPS_NEXT');
        expect(r.items.map(i => [i.fbId, i.title, i.privacy, i.memberCount])).toEqual([
            ['111111111111111', 'Nhóm Giả Một', 'public', 12000],
            ['111111111111112', 'Nhóm Giả Hai', 'private', 1500000],
            ['111111111111113', 'Nhóm Giả Ba', 'public', 1234],
        ]);
        expect(r.items[0].kind).toBe('group');
        expect(r.items[0].url).toBe('https://www.facebook.com/groups/111111111111111/');
        expect(r.items[0].reactions).toBeNull();
    });
});

describe('parseSearchPages', () => {
    it('reads profile and follower counts, cursor from a later line', () => {
        const r = parseSearchPages(fx('search-pages.txt'));
        expect(r.errorCode).toBeNull();
        expect(r.endCursor).toBe('CURSOR_PAGES_NEXT');
        expect(r.items.map(i => [i.kind, i.fbId, i.title, i.followerCount])).toEqual([
            ['page', '300000000000001', 'Trang Giả Một', 1200000],
            ['page', '300000000000002', 'Trang Giả Hai', 12000],
        ]);
    });
});

describe('parseGroupFeed', () => {
    const ctx = { groupId: '111111111111111', groupName: 'Nhóm Ngữ Cảnh' };
    const r = parseGroupFeed(fx('group-feed.txt'), ctx);
    it('reads stories and the cursor', () => {
        expect(r.errorCode).toBeNull();
        expect(r.endCursor).toBe('CURSOR_FEED_NEXT');
        expect(r.items.map(i => i.fbId)).toEqual(['222222222222231', '222222222222232', '222222222222233']);
    });
    it('uses the context group when story.to is missing', () => {
        expect(r.items[1].placeKind).toBe('group');
        expect(r.items[1].placeId).toBe('111111111111111');
        expect(r.items[1].placeName).toBe('Nhóm Ngữ Cảnh');
        expect(r.items[1].authorName).toBe('Người Dùng E');
    });
    it('finds counts at a non-standard path by key name', () => {
        expect(r.items[2]).toMatchObject({ reactions: 2500, comments: 33, shares: 9, authorKind: 'page' });
    });
});

describe('errors', () => {
    it.each([
        ['error-logged-out.json', 'logged_out'],
        ['error-rate-limited.json', 'rate_limited'],
        ['error-persisted-query.json', 'query_changed'],
        ['garbage.txt', 'parse_failed'],
    ])('%s -> %s', (name, code) => {
        for (const fn of [parseSearchPosts, parseSearchGroups, parseSearchPages]) {
            const r = fn(fx(name));
            expect(r.items).toEqual([]);
            expect(r.errorCode).toBe(code);
        }
        expect(parseGroupFeed(fx(name)).errorCode).toBe(code);
    });
    it('detects checkpoint by message and empty input as parse_failed', () => {
        const t = JSON.stringify({ errors: [{ message: 'Account hit a checkpoint' }] });
        expect(parseSearchPosts(t).errorCode).toBe('checkpoint');
        expect(parseSearchPosts('').errorCode).toBe('parse_failed');
        expect(parseSearchPosts('{"x":1}').errorCode).toBe('parse_failed');
    });
    it('empty but valid data is not an error', () => {
        const r = parseSearchPosts('{"data":{"serpResponse":{"results":{"edges":[]}}}}');
        expect(r).toEqual({ items: [], endCursor: null, errorCode: null });
    });
    it('does not throw on odd shapes', () => {
        for (const t of ['[]', 'null', '{"data":null}', '{"data":{"serpResponse":{"results":{"edges":[null,1,"x",{}]}}}}']) {
            expect(() => parseSearchPosts(t)).not.toThrow();
            expect(() => parseGroupFeed(t)).not.toThrow();
        }
    });
});

describe('describeShape', () => {
    it('lists key paths with types and no values', () => {
        const shape = describeShape(parseGraphqlChunks(fx('search-posts.txt')), 14);
        expect(shape).toContain('[].data.serpResponse.results.edges:array[3]');
        expect(shape.some(s => s.endsWith('edges[].rendering_strategy.view_model.click_model.story.post_id:string'))).toBe(true);
        expect(shape.join('\n')).not.toContain('Người Dùng');
        expect(shape.join('\n')).not.toContain('222222222222221');
    });
    it('caps keys, depth and size', () => {
        const wide: Record<string, number> = {};
        for (let i = 0; i < 1000; i++) wide[`k${i}`] = i;
        expect(describeShape(wide).length).toBeLessThanOrEqual(400);
        expect(describeShape({ a: { b: { c: 1 } } }, 2)).not.toContain('a.b.c:number');
        const long: Record<string, number> = {};
        for (let i = 0; i < 400; i++) long['x'.repeat(100) + i] = i;
        expect(describeShape(long).join('\n').length).toBeLessThanOrEqual(20 * 1024);
    });
    it('handles primitives and null', () => {
        expect(() => describeShape(null)).not.toThrow();
        expect(describeShape({ a: null, b: true })).toEqual(expect.arrayContaining(['a:null', 'b:bool']));
    });
});
