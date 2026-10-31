import { readFileSync } from 'fs';
import { join } from 'path';
import type { Page } from 'playwright-core';
import { PageLoginProblem, parseIdentityHtml, parsePagePosts, readPageIdentity } from '../../services/dailyBrief/pageIdentity';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const pageHtml = fixture('page-identity.html');
const personHtml = fixture('person-identity.html');
const finalUrl = 'https://www.facebook.com/example-driving-school/';
const activeId = '100000000000101';
const pageId = '200000000000201';
const expectedPost = {
    text: 'Check mirrors and signal before changing lanes.', reactions: 12, comments: 3, shares: 2,
    postedAt: 1793000000000, url: 'https://www.facebook.com/reel/300000000000301',
};
const emptyIdentity = { kind: 'unknown', pageId: '', pageName: '', category: '', about: '', recentPosts: [] };
const fixtureRoot = (html = pageHtml) => JSON.parse(/<script type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);
const envelope = (html = pageHtml) => {
    const root = fixtureRoot(html);
    return root.require?.[0]?.[0] === 'ScheduledServerJS' ? root.require[0][3][0].__bbox : root;
};
const feed = () => JSON.parse(fixture('page-posts.json'));
const payload = (root: any, index: number) => root.require[index][3][1].__bbox.result.data;
const htmlOf = (root: unknown) => `<script type="application/json">${JSON.stringify(root)}</script>`;
const storyOf = (data: any) => data.user.timeline_list_feed_units.edges[0].node;
const renderersOf = (story: any) => story.comet_sections.feedback.story.story_ufi_container.story.feedback_context
    .feedback_target_with_context.comet_ufi_summary_and_actions_renderer.feedback.adaptive_ufi_action_renderers;

describe('parseIdentityHtml', () => {
    it('review F1: reads the observed transport wrapper and the minimized root identically', () => {
        expect(fixtureRoot().require[0].slice(0, 3)).toEqual(['ScheduledServerJS', 'handle', null]);
        const expected = { kind: 'page', pageId, pageName: 'Example Driving School', category: 'Driving school',
            about: 'Driving lessons for beginners. Practical instruction and road safety.', recentPosts: [expectedPost] };
        expect(parseIdentityHtml(pageHtml, finalUrl)).toEqual(expected);
        expect(parseIdentityHtml(htmlOf(envelope()), finalUrl)).toEqual(expected);
    });

    it('review F1: only unwraps recognized transport entries within finite bounds', () => {
        const wrap = (root: unknown, name = 'ScheduledServerJS', method = 'handle') => ({
            require: [[name, method, null, [{ __bbox: root }]]],
        });
        let root = envelope();
        for (let depth = 0; depth < 3; depth++) root = wrap(root);
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', recentPosts: [expectedPost] });
        for (const noise of [wrap(envelope(), 'OtherModule'), wrap(envelope(), 'ScheduledServerJS', 'other'),
            { arbitrary: { __bbox: envelope() } }, { viewer: { actor: envelope() } }]) {
            expect(parseIdentityHtml(htmlOf(noise), finalUrl)).toEqual(emptyIdentity);
        }
        for (let depth = 0; depth < 30; depth++) root = wrap(root);
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
        const wide = { require: Array.from({ length: 1025 }, () => wrap(envelope()).require[0]) };
        expect(parseIdentityHtml(htmlOf(wide), finalUrl)).toEqual(emptyIdentity);
    });

    it.each([176, 241])('transport budget: reads a Page among %i initial JSON scripts with unrelated wrappers', (scriptCount) => {
        const scripts = Array.from({ length: scriptCount }, (_, index) => htmlOf({
            require: [['ScheduledServerJS', 'handle', null, [{ __bbox: {
                define: [['SyntheticFeatureData', [], { index, enabled: true }, 0]],
                require: [['RelayPrefetchedStreamCache', 'next', [], [`synthetic-noise-${index}`, { __bbox: { result: { data: {
                    user: { id: 'foreign-user', delegate_page: { id: 'foreign-page', name: 'Synthetic Foreign Page' } },
                    viewer: { actor: { id: 'foreign-user', is_profile_plus: false } },
                    switcher: { actor: { id: activeId, is_profile_plus: false } },
                } } } }]]],
            } }]]],
        }));
        scripts[Math.floor(scriptCount / 2)] = htmlOf(fixtureRoot());
        expect(parseIdentityHtml(scripts.join('\n'), finalUrl)).toEqual({
            kind: 'page', pageId, pageName: 'Example Driving School', category: 'Driving school',
            about: 'Driving lessons for beginners. Practical instruction and road safety.', recentPosts: [expectedPost],
        });
    });

    it('transport budget: accepts exactly 1024 total envelopes including the recognized child', () => {
        const scripts = Array(1023).fill(htmlOf({ configuration: { enabled: true } }));
        scripts[1022] = htmlOf(fixtureRoot());
        expect(parseIdentityHtml(scripts.join('\n'), finalUrl)).toMatchObject({ kind: 'page', pageId, recentPosts: [expectedPost] });
    });

    it.each([1024, 1025])('transport budget: rejects %i initial scripts plus a recognized child without partial results', (scriptCount) => {
        const scripts = Array(scriptCount).fill(htmlOf({ configuration: { enabled: true } }));
        scripts[0] = htmlOf(fixtureRoot());
        expect(parseIdentityHtml(scripts.join('\n'), finalUrl)).toEqual(emptyIdentity);
    });

    it('transport budget: still accepts four transport levels and rejects the fifth', () => {
        let root = envelope();
        for (let depth = 0; depth < 4; depth++) root = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: root }]]] };
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', pageId, recentPosts: [expectedPost] });
        root = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: root }]]] };
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it('review F1: retains contradictions across recognized root and wrapped modules', () => {
        const root = fixtureRoot();
        root.define = [['CurrentUserInitialData', [], { USER_ID: 'foreign' }]];
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it('joins the exact Page fixture through the active User and delegated Page', () => {
        expect(parseIdentityHtml(pageHtml, finalUrl)).toEqual({
            kind: 'page', pageId, pageName: 'Example Driving School', category: 'Driving school',
            about: 'Driving lessons for beginners. Practical instruction and road safety.', recentPosts: [expectedPost],
        });
    });

    it('recognizes the explicitly false matching actor in the synthetic person fixture', () => {
        expect(parseIdentityHtml(personHtml, 'https://www.facebook.com/me')).toEqual({ ...emptyIdentity, kind: 'person' });
    });

    it.each(['', '<h1>Example Driving School</h1>', '<script type="application/json">{bad</script>',
        htmlOf({ __typename: 'Page', id: pageId, name: 'Noise' })])('keeps unsupported HTML unknown: %s', (html) => {
        expect(parseIdentityHtml(html, finalUrl)).toEqual(emptyIdentity);
    });

    it.each(['https://facebook.com.evil.test/me', 'https://evil.test/me', 'http://www.facebook.com/me',
        'https://www.facebook.com@evil.test/me', 'https://user:pass@www.facebook.com/me', 'not a URL'])
    ('rejects an unsupported final origin: %s', (url) => {
        expect(parseIdentityHtml(pageHtml, url)).toEqual(emptyIdentity);
    });

    it('does not classify from a header, name, delegated Page or User typename alone', () => {
        const root = envelope();
        delete payload(root, 0).user.comet_profile_entity_menu.user.delegate_page.viewer.actor.is_profile_plus;
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it.each(['missing-current', 'conflicting-current', 'wrong-menu-user', 'wrong-actor', 'conflicting-page',
        'same-profile-and-page', 'true-and-false', 'false-with-page'])('rejects absent or contradictory evidence: %s', (variant) => {
        const root = envelope();
        const menu = payload(root, 0).user.comet_profile_entity_menu.user;
        if (variant === 'missing-current') root.define = [];
        if (variant === 'conflicting-current') root.define.push(['CurrentUserInitialData', [], { USER_ID: 'other' }]);
        if (variant === 'wrong-menu-user') menu.id = 'other';
        if (variant === 'wrong-actor') menu.delegate_page.viewer.actor.id = 'other';
        if (variant === 'conflicting-page') payload(root, 1).user.profile_header_renderer.user.delegate_page.id = 'other-page';
        if (variant === 'same-profile-and-page') {
            menu.delegate_page.id = activeId;
            payload(root, 1).user.profile_header_renderer.user.delegate_page.id = activeId;
            payload(root, 2).user.delegate_page.id = activeId;
        }
        if (variant === 'true-and-false') payload(root, 2).viewer = { actor: { id: activeId, is_profile_plus: false } };
        if (variant === 'false-with-page') menu.delegate_page.viewer.actor.is_profile_plus = false;
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it.each(['missing-flag', 'foreign-false', 'page-evidence', 'actor-page-id'])('does not guess person: %s', (variant) => {
        const root = envelope(personHtml);
        const data = payload(root, 0);
        if (variant === 'missing-flag') delete data.viewer.actor.is_profile_plus;
        if (variant === 'foreign-false') data.viewer.actor.id = 'foreign';
        if (variant === 'page-evidence') data.user.delegate_page = { id: pageId };
        if (variant === 'actor-page-id') data.viewer.actor.delegate_page_id = pageId;
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it('disregards foreign Page actors, switcher entries, shared actors and unrelated payloads', () => {
        const root = envelope();
        root.require.unshift(['OtherModule', 'next', [], ['noise', { __bbox: { result: { data: {
            viewer: { actor: { id: activeId, is_profile_plus: false } },
        } } } }]]);
        const data = payload(root, 1);
        data.viewer = { actor: { id: 'foreign', is_profile_plus: false, delegate_page_id: 'foreign-page' } };
        data.switcher = { user: { id: activeId, delegate_page: { id: 'foreign-page' }, is_profile_plus: false } };
        root.require.push(['RelayPrefetchedStreamCache', 'next', [], ['noise', { __bbox: { result: { data: {
            user: { id: 'foreign', delegate_page: { id: 'foreign-page', name: 'Wrong' } },
        } } } }]]);
        storyOf(payload(root, 3)).shared_story = { actors: [{ id: activeId, is_profile_plus: false }], delegate_page: { id: 'other' } };
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', pageId, recentPosts: [expectedPost] });
    });

    it('does not join a foreign menu User to a matching actor hidden inside it', () => {
        const root = envelope();
        payload(root, 0).user.id = 'foreign';
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it('reads multiple inert JSON scripts, skips malformed JSON and never executes scripts', () => {
        const root = envelope();
        const html = `<script>throw new Error('must not execute')</script>
            <script type="application/json">{bad</script>
            ${htmlOf({ define: root.define })}${htmlOf({ require: root.require })}`;
        expect(parseIdentityHtml(html, finalUrl)).toMatchObject({ kind: 'page', recentPosts: [expectedPost] });
        expect(parseIdentityHtml(`<!-- ${htmlOf(root)} -->`, finalUrl)).toEqual(emptyIdentity);
        expect(parseIdentityHtml(pageHtml.replace('type="application/json"', 'data-type="application/json"'), finalUrl)).toEqual(emptyIdentity);
    });

    it.each(['Before <!--literal--> after', 'Before <!-- after', 'Before --> after'])
    ('review F2: preserves literal comment text inside JSON: %s', (text) => {
        const root = envelope();
        const data = payload(root, 2);
        data.user.delegate_page.best_description.text = text;
        storyOf(data).comet_sections.content.story.message.text = text;
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({
            kind: 'page', about: text, recentPosts: [{ ...expectedPost, text }],
        });
    });

    it('review F2: excludes real HTML comments without excluding the next script', () => {
        const conflicting = envelope();
        conflicting.define[0][2].USER_ID = 'foreign';
        expect(parseIdentityHtml(`<!-- ${htmlOf(conflicting)} -->${pageHtml}<!-- trailing -->`, finalUrl))
            .toMatchObject({ kind: 'page', recentPosts: [expectedPost] });
        expect(parseIdentityHtml(`<!-- ${htmlOf(envelope())} -->`, finalUrl)).toEqual(emptyIdentity);
    });

    it('caps about, deduplicates across feed payloads and caps the combined post count', () => {
        const root = envelope();
        const data = payload(root, 2);
        data.user.delegate_page.best_description.text = 'a'.repeat(1001);
        const first = storyOf(data);
        data.user.timeline_list_feed_units.edges = Array.from({ length: 12 }, (_, index) => ({ node: {
            ...first, post_id: String(index), permalink_url: `https://www.facebook.com/reel/${index}`,
        } }));
        root.require.push(structuredClone(root.require[2]));
        const result = parseIdentityHtml(htmlOf(root), finalUrl);
        expect(result.about).toBe('a'.repeat(1000));
        expect(result.recentPosts).toHaveLength(10);
        expect(new Set(result.recentPosts.map((post) => post.url)).size).toBe(10);
    });

    it('ignores a foreign timeline and a homepage news feed', () => {
        const root = envelope();
        const data = payload(root, 2);
        data.user.id = 'foreign';
        payload(root, 1).viewer = { news_feed: feed().user.timeline_list_feed_units };
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', recentPosts: [] });
    });

    it('only uses the documented Page name sources, ignoring a root User name', () => {
        const root = envelope();
        const data = payload(root, 2);
        delete data.user.delegate_page.name;
        data.user.name = 'Unrelated root name';
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', pageName: 'Example Driving School' });
    });

    it.each([['Header name', 'Delegate name'], ['Delegate name', 'Header name']])
    ('review F6: compares valid header %s and delegate %s independently', (headerName, delegateName) => {
        const root = envelope();
        payload(root, 0).user.comet_profile_entity_menu.user.delegate_page.name = delegateName;
        payload(root, 2).user.delegate_page.name = delegateName;
        const header = payload(root, 1).user.profile_header_renderer.user;
        header.name = headerName;
        header.delegate_page.name = delegateName;
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it.each(['Example Driving School', '', null, 123])('review F6: retains consistent or unavailable header name %p', (name) => {
        const root = envelope();
        const header = payload(root, 1).user.profile_header_renderer.user;
        header.name = name;
        header.delegate_page.name = 'Example Driving School';
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toMatchObject({ kind: 'page', pageName: 'Example Driving School' });
    });

    it.each(['numeric-current', 'numeric-delegate', 'conflicting-name', 'conflicting-actor-page'])
    ('rejects malformed or conflicting identity values: %s', (variant) => {
        const root = envelope();
        if (variant === 'numeric-current') root.define[0][2].USER_ID = 123;
        if (variant === 'numeric-delegate') payload(root, 2).user.delegate_page.id = 123;
        if (variant === 'conflicting-name') payload(root, 2).user.delegate_page.name = 'Conflicting name';
        if (variant === 'conflicting-actor-page') payload(root, 2).viewer = { actor: { id: activeId, delegate_page_id: 'other' } };
        expect(parseIdentityHtml(htmlOf(root), finalUrl)).toEqual(emptyIdentity);
    });

    it('ignores executable, external and misleading script types but accepts ordinary attribute quoting', () => {
        expect(parseIdentityHtml(pageHtml.replace('type="application/json"', "nonce='fixture' type='application/json'"), finalUrl))
            .toMatchObject({ kind: 'page', pageId });
        for (const attributes of ['src="https://example.invalid/a" type="application/json"',
            'type="text/javascript"', 'type="application/json" type="text/javascript"']) {
            expect(parseIdentityHtml(pageHtml.replace('type="application/json"', attributes), finalUrl)).toEqual(emptyIdentity);
        }
    });

    it('deduplicates across separate feed payloads while preserving available sample order', () => {
        const root = envelope();
        root.require.push(structuredClone(root.require[2]));
        const extra = structuredClone(root.require[2]);
        const story = storyOf(extra[3][1].__bbox.result.data);
        story.post_id = 'second';
        story.permalink_url = 'https://www.facebook.com/reel/second';
        root.require.push(extra);
        expect(parseIdentityHtml(htmlOf(root), finalUrl).recentPosts.map((post) => post.url))
            .toEqual([expectedPost.url, 'https://www.facebook.com/reel/second']);
    });
});

describe('parsePagePosts', () => {
    it('reads the exact standalone fixture with milliseconds and unflattened metrics', () => {
        expect(parsePagePosts(feed())).toEqual([expectedPost]);
    });

    it('selects feedback renderers by field rather than position', () => {
        const data = feed();
        renderersOf(storyOf(data)).reverse();
        expect(parsePagePosts(data)).toEqual([expectedPost]);
    });

    it.each([null, [], {}, { user: { id: activeId, delegate_page: { id: pageId }, timeline_list_feed_units: { edges: {} } } }])
    ('handles malformed data without throwing: %p', (data) => {
        expect(parsePagePosts(data)).toEqual([]);
    });

    it.each(['foreign', 'nested-only', 'mixed', 'wrong-type', 'missing-id', 'invalid-actors', 'missing-delegate'])
    ('rejects unsupported ownership or story identity: %s', (variant) => {
        const data = feed();
        const story = storyOf(data);
        if (variant === 'foreign') story.actors = [{ id: 'foreign' }];
        if (variant === 'nested-only') {
            story.actors = [];
            story.shared_story = { actors: [{ id: activeId }] };
        }
        if (variant === 'mixed') story.actors.push({ id: 'foreign' });
        if (variant === 'wrong-type') story.__typename = 'Other';
        if (variant === 'missing-id') delete story.post_id;
        if (variant === 'invalid-actors') story.actors = {};
        if (variant === 'missing-delegate') delete data.user.delegate_page;
        expect(parsePagePosts(data)).toEqual([]);
    });

    it('does not borrow shared story text, time or metrics and does not collect nested posts', () => {
        const data = feed();
        const story = storyOf(data);
        const shared = structuredClone(story);
        shared.post_id = 'shared';
        delete story.creation_time;
        story.comet_sections = { content: { story: { shared_story: shared } } };
        story.shared_story = shared;
        expect(parsePagePosts(data)).toEqual([{ text: '', reactions: null, comments: null, shares: null,
            postedAt: null, url: expectedPost.url }]);
    });

    it.each([undefined, null, '12', -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    ('keeps invalid or unavailable numeric values null: %p', (value) => {
        const data = feed();
        const story = storyOf(data);
        const renderers = renderersOf(story);
        renderers[0].feedback.reaction_count.count = value;
        renderers[1].feedback.comment_rendering_instance.comments.total_count = value;
        renderers[2].feedback.share_count.count = value;
        story.creation_time = value;
        expect(parsePagePosts(data)).toEqual([{ ...expectedPost, reactions: null, comments: null, shares: null, postedAt: null }]);
    });

    it('preserves explicit zero counts and epoch zero', () => {
        const data = feed();
        const story = storyOf(data);
        const renderers = renderersOf(story);
        renderers[0].feedback.reaction_count.count = 0;
        renderers[1].feedback.comment_rendering_instance.comments.total_count = 0;
        renderers[2].feedback.share_count.count = 0;
        story.creation_time = 0;
        expect(parsePagePosts(data)).toEqual([{ ...expectedPost, reactions: 0, comments: 0, shares: 0, postedAt: 0 }]);
    });

    it('keeps absent and contradictory feedback null without borrowing nested metrics', () => {
        const data = feed();
        const renderers = renderersOf(storyOf(data));
        renderers.splice(1, 2);
        renderers.push({ feedback: { reaction_count: { count: 99 }, shared_story: { share_count: { count: 5 } } } });
        expect(parsePagePosts(data)).toEqual([{ ...expectedPost, reactions: null, comments: null, shares: null }]);
    });

    it.each(['javascript:alert(1)', 'https://www.facebook.com.evil.test/reel/1', 'https://evil.test/reel/1',
        'http://www.facebook.com/reel/1', '/reel/1', 'https://user:pass@www.facebook.com/reel/1', 123, null])
    ('rejects unsafe or unsupported permalinks: %p', (url) => {
        const data = feed();
        storyOf(data).permalink_url = url;
        expect(parsePagePosts(data)).toEqual([]);
    });

    it('deduplicates post IDs and URLs before limiting to ten posts with 500-character text', () => {
        const data = feed();
        const first = storyOf(data);
        first.comet_sections.content.story.message.text = 't'.repeat(501);
        const edges = data.user.timeline_list_feed_units.edges;
        edges.push(structuredClone(edges[0]), { node: { ...first, post_id: 'different-id' } });
        for (let index = 0; index < 12; index++) edges.push({ node: { ...first, post_id: String(index),
            permalink_url: `https://www.facebook.com/reel/${index}` } });
        const result = parsePagePosts(data);
        expect(result).toHaveLength(10);
        expect(result[0]).toEqual({ ...expectedPost, text: 't'.repeat(500) });
        expect(result[1].url).toBe('https://www.facebook.com/reel/0');
        expect(result.every((post) => post.text.length === 500)).toBe(true);
    });

    it('does not return query tokens or fragments from permalinks', () => {
        const data = feed();
        storyOf(data).permalink_url += '?access_token=synthetic-secret#tracking';
        expect(parsePagePosts(data)).toEqual([expectedPost]);
    });

    it.each(['/story.php?story_fbid=301&id=201', '/story.php?story_fbid=302&id=201',
        '/watch?v=301', '/photo.php?fbid=301', '/profile.php?id=201', '/', '/example-driving-school/', '/login/'])
    ('review F3: rejects query-dependent and arbitrary paths: %s', (path) => {
        const data = feed();
        storyOf(data).permalink_url = `https://www.facebook.com${path}`;
        expect(parsePagePosts(data)).toEqual([]);
    });

    it.each(['/reel/300000000000301', '/posts/300000000000301',
        '/example-driving-school/posts/pfbidExample', '/200000000000201/posts/300000000000301/'])
    ('review F3: retains self-contained post paths while dropping token queries: %s', (path) => {
        const data = feed();
        storyOf(data).permalink_url = `https://www.facebook.com${path}?access_token=synthetic-secret&tracking=synthetic#fragment`;
        expect(parsePagePosts(data)).toEqual([{ ...expectedPost, url: `https://www.facebook.com${path}` }]);
    });

    it('review F3: never turns two unsupported query URLs into one broken sample', () => {
        const data = feed();
        const first = storyOf(data);
        data.user.timeline_list_feed_units.edges = ['301', '302'].map((postId) => ({ node: {
            ...first, post_id: postId, permalink_url: `https://www.facebook.com/story.php?story_fbid=${postId}&id=201`,
        } }));
        expect(parsePagePosts(data)).toEqual([]);
    });

    it.each([8640000000001, 9007199254741])('keeps out-of-range millisecond timestamps null: %p', (seconds) => {
        const data = feed();
        storyOf(data).creation_time = seconds;
        expect(parsePagePosts(data)[0].postedAt).toBeNull();
    });

    it('stress: handles malformed edges around large duplicate samples without modifying input', () => {
        const data = feed();
        const story = storyOf(data);
        story.comet_sections.content.story.message.text = 't'.repeat(100000);
        data.user.timeline_list_feed_units.edges = [null, 1, 'invalid', { node: null },
            ...Array.from({ length: 2000 }, () => ({ node: story }))];
        expect(parsePagePosts(data)).toEqual([{ ...expectedPost, text: 't'.repeat(500) }]);
        expect(story.comet_sections.content.story.message.text).toHaveLength(100000);
        expect(data.user.timeline_list_feed_units.edges).toHaveLength(2004);
    });

    it('stress: malformed envelope field types stay unknown and malformed feed fields stay empty', () => {
        const values = [undefined, null, true, 1, 'bad', [], {}, { id: [] }];
        for (const value of values) {
            expect(parseIdentityHtml(htmlOf({ define: value, require: value }), finalUrl)).toEqual(emptyIdentity);
            expect(parsePagePosts({ user: value })).toEqual([]);
            const data = feed();
            data.user.timeline_list_feed_units.edges = [{ node: value }];
            expect(parsePagePosts(data)).toEqual([]);
        }
    });
});

function fakePage(url = finalUrl, error?: Error, status: number | null = 200) {
    const calls: unknown[] = [];
    const fake = {
        goto: async (...args: unknown[]) => {
            calls.push(['goto', ...args]);
            if (error) throw error;
            return status === null ? null : { status: () => status };
        },
        url: () => url,
        content: async () => { calls.push(['content']); return pageHtml; },
    };
    return { page: fake as unknown as Page, calls };
}

describe('readPageIdentity ownership guards', () => {
    it('denies before navigating', async () => {
        const { page, calls } = fakePage(); const error = new Error('revoked');
        await expect(readPageIdentity(page, { assertCurrent: () => { throw error; } })).rejects.toBe(error);
        expect(calls).toEqual([]);
    });
    it.each([false, true])('guards navigation resolve/reject=%s before content or redirect fallback', async (rejects) => {
        const { page } = fakePage(); let current = true; const error = new Error('revoked');
        page.goto = async () => { current = false; if (rejects) throw new Error('navigation'); return null; };
        page.url = () => 'https://www.facebook.com/checkpoint/';
        const content = jest.fn(async () => pageHtml); page.content = content;
        await expect(readPageIdentity(page, { assertCurrent: () => { if (!current) throw error; } })).rejects.toBe(error);
        expect(content).not.toHaveBeenCalled();
    });
    it.each([false, true])('guards content resolve/reject=%s before identity exposure or login fallback', async (rejects) => {
        const { page } = fakePage(); let current = true; const error = new Error('revoked');
        page.content = async () => { current = false; if (rejects) throw new Error('content'); return pageHtml; };
        page.url = () => current ? finalUrl : 'https://www.facebook.com/login/';
        await expect(readPageIdentity(page, { assertCurrent: () => { if (!current) throw error; } })).rejects.toBe(error);
    });
    it.each(['goto', 'content'] as const)('preserves legacy redirect classification when %s throws synchronously', async (method) => {
        const { page } = fakePage(); let redirected = false;
        page[method] = () => { redirected = true; throw new Error('closed'); };
        page.url = () => redirected ? 'https://www.facebook.com/checkpoint/' : finalUrl;
        await expect(readPageIdentity(page)).rejects.toBeInstanceOf(PageLoginProblem);
    });
    it('never masks a guard failure with redirect classification even if guard throws only once', async () => {
        const { page } = fakePage(); const error = new Error('revoked'); let checks = 0;
        page.url = () => 'https://www.facebook.com/checkpoint/';
        await expect(readPageIdentity(page, { assertCurrent: () => { if (++checks === 2) throw error; } })).rejects.toBe(error);
    });
});

describe('readPageIdentity', () => {
    it.each([
        ['/checkpoint/required', 'checkpoint', false], ['/checkpoint/required', 'checkpoint', true],
        ['/login/', 'logged_out', false], ['/login/', 'logged_out', true],
    ] as const)('review F5: final URL %s has state %s when content rejects=%s', async (path, state, rejects) => {
        const { page } = fakePage();
        let currentUrl = finalUrl;
        page.url = () => currentUrl;
        page.content = async () => {
            currentUrl = `https://www.facebook.com${path}`;
            if (rejects) throw new Error('Đọc trang thất bại khi chuyển hướng');
            return pageHtml;
        };
        const promise = readPageIdentity(page);
        await expect(promise).rejects.toBeInstanceOf(PageLoginProblem);
        await expect(promise).rejects.toMatchObject({ state });
    });

    it('review F5: preserves a content error without a login redirect', async () => {
        const { page } = fakePage();
        const error = new Error('Không đọc được nội dung trang');
        page.content = async () => { throw error; };
        await expect(readPageIdentity(page)).rejects.toBe(error);
    });

    it('review F5: checks the final origin after content instead of reusing the initial URL', async () => {
        const { page } = fakePage();
        let currentUrl = finalUrl;
        page.url = () => currentUrl;
        page.content = async () => { currentUrl = 'https://example.invalid/me'; return pageHtml; };
        expect(await readPageIdentity(page)).toEqual(emptyIdentity);
    });

    it.each([400, 404, 429, 500, 503])('review F4: HTTP %i stays an error and does not read content', async (status) => {
        const { page, calls } = fakePage(finalUrl, undefined, status);
        await expect(readPageIdentity(page)).rejects.toThrow(`HTTP ${status}`);
        expect(calls).toHaveLength(1);
    });

    it.each([['/checkpoint/required', 'checkpoint'], ['/login/', 'logged_out']] as const)
    ('review F4: login classification at %s takes priority over HTTP failure', async (path, state) => {
        const { page, calls } = fakePage(`https://www.facebook.com${path}`, undefined, 500);
        const promise = readPageIdentity(page);
        await expect(promise).rejects.toBeInstanceOf(PageLoginProblem);
        await expect(promise).rejects.toMatchObject({ state });
        expect(calls).toHaveLength(1);
    });

    it.each([200, 204, null])('review F4: retains successful or absent navigation response %p', async (status) => {
        const { page } = fakePage(finalUrl, undefined, status);
        expect(await readPageIdentity(page)).toMatchObject({ kind: 'page', pageId });
    });

    it('only navigates and reads, with a bounded Playwright load and the supplied timeout', async () => {
        const { page, calls } = fakePage();
        expect(await readPageIdentity(page, { gotoTimeoutMs: 1234 })).toMatchObject({ kind: 'page', pageId });
        expect(calls).toEqual([
            ['goto', 'https://www.facebook.com/me', { waitUntil: 'load', timeout: 1234 }], ['content'],
        ]);
    });

    it.each([undefined, 0, -1, NaN, Infinity])('uses a finite positive default for timeout %p', async (timeout) => {
        const { page, calls } = fakePage();
        await readPageIdentity(page, { gotoTimeoutMs: timeout });
        expect(calls[0]).toEqual(['goto', 'https://www.facebook.com/me', { waitUntil: 'load', timeout: 45000 }]);
    });

    it.each([
        ['/checkpoint/required', 'checkpoint'], ['/two_step_verification', 'checkpoint'],
        ['/auth_platform', 'checkpoint'], ['/login/?next=me', 'logged_out'],
    ] as const)('throws the shared login classification for redirect %s, even on navigation failure', async (path, state) => {
        for (const error of [undefined, new Error('Điều hướng thất bại sau chuyển hướng')]) {
            const { page, calls } = fakePage(`https://www.facebook.com${path}`, error);
            const promise = readPageIdentity(page);
            await expect(promise).rejects.toBeInstanceOf(PageLoginProblem);
            await expect(promise).rejects.toMatchObject({ state });
            expect(calls).toHaveLength(1);
        }
    });

    it('preserves navigation failures instead of turning them into unknown', async () => {
        const error = new Error('Điều hướng quá giờ');
        const { page, calls } = fakePage(finalUrl, error);
        await expect(readPageIdentity(page)).rejects.toBe(error);
        expect(calls).toHaveLength(1);
    });
});
