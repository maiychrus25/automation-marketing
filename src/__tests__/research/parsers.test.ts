import * as fs from 'fs';
import * as path from 'path';
import {
    parseGraphqlChunks, parseCompactNumber, parseSearchPosts, parseSearchGroups,
    parseSearchPages, parseGroupFeed, describeShape,
} from '../../services/research/parsers';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

describe('Story provenance boundaries', () => {
    const outer = '12345';
    const foreign = { __typename: 'Story', post_id: '99999', url: 'https://www.facebook.com/67890/posts/99999',
        actors: [{ __typename: 'Page', id: '67890' }], creation_time: 100,
        feedback: { reaction_count: { count: 10 }, comment_count: { total_count: 2 }, share_count: { count: 3 } } };
    const read = (story: object, group: boolean) => group
        ? parseGroupFeed(JSON.stringify({ data: { node: { group_feed: { edges: [{ node: story }] } } } })).items
        : parseSearchPosts(JSON.stringify({ data: { serpResponse: { results: { edges: [
            { rendering_strategy: { view_model: { click_model: { story } } } },
        ] } } } })).items;
    it.each([false, true])('does not borrow identity, counts or time from embedded posts (group=%s)', group => {
        const [item] = read({ post_id: outer, url: 'https://www.facebook.com/67890/posts/12345', attachments: [{ target: foreign }] }, group);
        expect(item).toMatchObject({ fbId: outer, authorKind: 'unknown', authorId: '', reactions: null, comments: null, shares: null, postedAt: null });
        const [owned] = read({ post_id: outer, actors: [{ __typename: 'Page', id: '67890' }], attachments: [{ target: foreign }] }, group);
        expect(owned).toMatchObject({ fbId: outer, url: '', authorId: '67890', reactions: null, comments: null, shares: null });
    });
    it('does not borrow comment feedback but preserves same-story comet fragments', () => {
        const [item] = read({ post_id: outer, comet_sections: {
            context_layout: { story: { post_id: outer, actors: [{ __typename: 'Page', id: '67890' }] } },
            feedback: { story: { post_id: outer, feedback: { comment_rendering_instance: { comments: {
                total_count: 0, edges: [{ node: { __typename: 'Comment', feedback: foreign.feedback } }],
            } } } } },
            timestamp: { story: { post_id: outer, creation_time: 123 } },
        } }, false);
        expect(item).toMatchObject({ authorKind: 'page', authorId: '67890', reactions: null, comments: 0, shares: null, postedAt: 123000 });
    });
    it('keeps an exact Page-prefixed ID and its same-story URL/fragments',()=>{
        const [item]=read({post_id:'67890_12345',url:'https://www.facebook.com/67890/posts/12345',actors:[{__typename:'Page',id:'67890'}],
            comet_sections:{feedback:{story:{post_id:'12345',feedback:{reaction_count:{count:0}}}}}},false);
        expect(item).toMatchObject({fbId:'67890_12345',authorId:'67890',reactions:0});
    });
    it('comment feedback without a typed node cannot fill missing post metrics', () => {
        const [item]=read({post_id:outer,feedback:{comments:{total_count:2,feedback:foreign.feedback,actors:foreign.actors,creation_time:100}}},false);
        expect(item).toMatchObject({authorKind:'unknown',authorId:'',reactions:null,shares:null,postedAt:null});
    });
    const references = [
        ['posts', (id: string) => `https://www.facebook.com/67890/posts/${id}`],
        ['permalink', (id: string) => `https://www.facebook.com/67890/permalink/${id}/`],
        ['story_query', (id: string) => `https://www.facebook.com/story.php?id=67890&story_fbid=${id}`],
        ['permalink_query', (id: string) => `https://www.facebook.com/permalink.php?story_fbid=${id}&id=67890`],
    ] as const;
    const referenceCases = [false, true].flatMap(group => ['url', 'permalink_url', 'wwwURL'].flatMap(key =>
        references.map(([form, makeUrl]) => ({ group, key, form, makeUrl }))));
    const evidence = { __typename: 'Story', actors: [{ __typename: 'Page', id: '67890' }], creation_time: 123,
        feedback: { reaction_count: { count: 10 }, comment_count: { total_count: 2 }, share_count: { count: 3 } } };
    it.each(referenceCases)('rejects foreign pfbid without post_id: $form/$key group=$group', ({group,key,makeUrl}) => {
        const [item] = read({ post_id: outer, url: 'https://www.facebook.com/67890/posts/12345',
            comet_sections: { feedback: { story: { ...evidence, [key]: makeUrl('pfbidForeignPost') } } } }, group);
        expect(item).toMatchObject({fbId:outer,url:'https://www.facebook.com/67890/posts/12345',authorKind:'unknown',authorId:'',
            reactions:null,comments:null,shares:null,postedAt:null});
    });
    it.each(referenceCases)('preserves same-target pfbid URL and comet evidence: $form/$key group=$group', ({group,key,makeUrl}) => {
        const [item] = read({ [key]: makeUrl('pfbidExpectedPost'),
            comet_sections: { feedback: { story: { ...evidence, [key]: makeUrl('pfbidExpectedPost') } } } }, group);
        expect(item).toMatchObject({fbId:'pfbidExpectedPost',url:makeUrl('pfbidExpectedPost'),authorKind:'page',authorId:'67890',
            reactions:10,comments:2,shares:3,postedAt:123000});
    });
    const conflictingReferences = [
        {url:'https://www.facebook.com/67890/posts/12345foreign'},
        {url:'https://www.facebook.com/story.php?id=67890&story_fbid=12345foreign'},
        {url:'https://www.facebook.com/67890/posts/12345',permalink_url:'https://www.facebook.com/67890/posts/pfbidForeignPost'},
        {url:'https://www.facebook.com/67890/posts/12345',wwwURL:'https://www.facebook.com/67890/permalink/pfbidForeignPost'},
        {url:'https://www.facebook.com/profile.php?id=67890',permalink_url:'https://www.facebook.com/story.php?id=67890&story_fbid=pfbidForeignPost'},
        {url:'https://www.facebook.com/67890/posts/12345?story_fbid=pfbidForeignPost'},
        {url:'https://www.facebook.com/story.php?id=67890&story_fbid=12345&story_fbid=pfbidForeignPost'},
        {url:'https://www.facebook.com/67890/posts/12345/foreign'},
    ];
    it.each([false,true].flatMap(group=>conflictingReferences.map(refs=>({group,refs}))))('checks complete IDs and every reference group=$group refs=$refs',({group,refs})=>{
        const [item]=read({post_id:outer,url:'https://www.facebook.com/67890/posts/12345',
            comet_sections:{feedback:{story:{...evidence,...refs}}}},group);
        expect(item).toMatchObject({fbId:outer,authorKind:'unknown',authorId:'',reactions:null,comments:null,shares:null,postedAt:null});
    });
    it.each([false,true])('does not treat an opaque ID prefix as the same post group=%s',group=>{
        const [item]=read({post_id:'pfbidExpected',url:'https://www.facebook.com/67890/posts/pfbidExpected',
            comet_sections:{feedback:{story:{...evidence,url:'https://www.facebook.com/67890/posts/pfbidExpectedExtra'}}}},group);
        expect(item).toMatchObject({fbId:'pfbidExpected',authorKind:'unknown',reactions:null,postedAt:null});
    });
    it('does not manufacture an outer post ID from an attached Story', () => {
        expect(read({ attachments: [{ target: foreign }] }, false)).toEqual([]);
    });
});

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

describe('cursor rules', () => {
    const edge = (id: string, extra: Record<string, unknown> = {}) => ({
        rendering_strategy: { view_model: { click_model: { story: { post_id: id, ...extra } } } },
    });
    const wrap = (results: Record<string, unknown>) => JSON.stringify({ data: { serpResponse: { results } } });
    it('last page with null cursor stops, even if a comment cursor exists nearby', () => {
        const t = wrap({
            edges: [edge('222222222222251', { comments: { edges: [], page_info: { end_cursor: 'CURSOR_COMMENT', has_next_page: true } } })],
            page_info: { end_cursor: null, has_next_page: false },
        });
        const r = parseSearchPosts(t);
        expect(r.items).toHaveLength(1);
        expect(r.endCursor).toBeNull();
    });
    it('has_next_page false wins over a cursor', () => {
        expect(parseSearchPosts(wrap({ edges: [edge('222222222222252')], page_info: { end_cursor: 'C', has_next_page: false } })).endCursor).toBeNull();
    });
    it('ignores page_info nested inside a story when the documented one is absent', () => {
        const t = wrap({ edges: [edge('222222222222253', { comments: { edges: [], page_info: { end_cursor: 'CURSOR_COMMENT', has_next_page: true } } })] });
        expect(parseSearchPosts(t).endCursor).toBeNull();
    });
    it('uses a page_info sibling of edges when the documented path is absent', () => {
        const t = JSON.stringify({ data: { other: { edges: [edge('222222222222254')], page_info: { end_cursor: 'CURSOR_SIBLING', has_next_page: true } } } });
        expect(parseSearchPosts(t).endCursor).toBe('CURSOR_SIBLING');
    });
    it('uses a defer chunk page_info for the same connection', () => {
        expect(parseSearchPosts(fx('search-posts.txt')).endCursor).toBe('CURSOR_POSTS_NEXT');
    });
});

describe('error classification: not found', () => {
    it('only persisted-query related messages are query_changed', () => {
        const mk = (message: string) => JSON.stringify({ data: null, errors: [{ message }] });
        expect(parseSearchPosts(mk('Group not found')).errorCode).toBe('parse_failed');
        expect(parseSearchPosts(mk('Page not found')).errorCode).toBe('parse_failed');
        expect(parseSearchPosts(mk('Query not found')).errorCode).toBe('query_changed');
        expect(parseSearchPosts(mk('Document not found for doc_id 1')).errorCode).toBe('query_changed');
        expect(parseSearchPosts(mk('PersistedQueryNotFound')).errorCode).toBe('query_changed');
    });
});

describe('describeShape key privacy', () => {
    it('replaces id-like and name-like keys with <key>', () => {
        const shape = describeShape({
            byId: { '100000000000001': { n: 1 }, '100000000000002': { n: 2 } },
            byName: { 'Người Dùng A': { n: 1 }, 'Người Dùng B': { n: 2 } },
            long: { ['x'.repeat(41)]: 1 },
        }, 8, 400);
        const text = shape.join('\n');
        expect(text).not.toContain('100000000000001');
        expect(text).not.toContain('Người');
        expect(text).not.toContain('xxxxxxxx');
        expect(shape).toContain('byId.<key>.n:number');
        expect(shape.filter((s) => s.startsWith('byId.<key>.n'))).toHaveLength(1);
        expect(shape).toContain('byName.<key>:object');
    });
});
