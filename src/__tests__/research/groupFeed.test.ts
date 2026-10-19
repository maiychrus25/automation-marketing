import { ResearchError } from '../../services/research/graphqlSession';
import { GROUP_FEED_QUERY_NAME, groupFeedTriggerUrl, groupKey, isUnresolved, prepareGroupFeed } from '../../services/research/groupFeed';

const TEMPLATE = { id: '111', cursor: null, count: 3, scale: 1 };
const query = (vars: Record<string, any> = TEMPLATE) => ({ friendlyName: GROUP_FEED_QUERY_NAME, docId: 'd', variables: vars });

function fakeGql(opts: { query?: any; error?: Error } = {}) {
    return {
        ensureQuery: jest.fn(async () => { if (opts.error) throw opts.error; return opts.query ?? query(); }),
        recapture: jest.fn(async () => query()),
    };
}

describe('groupKey / trigger url', () => {
    it('extracts numeric ids and slugs', () => {
        expect(groupKey('https://www.facebook.com/groups/123/')).toBe('123');
        expect(groupKey('https://www.facebook.com/groups/my.slug?x=1')).toBe('my.slug');
        expect(groupKey('https://www.facebook.com/pages/x')).toBe('');
    });
    it('uses chronological sorting', () => {
        expect(groupFeedTriggerUrl('123')).toBe('https://www.facebook.com/groups/123/?sorting_setting=CHRONOLOGICAL');
    });
});

describe('prepareGroupFeed', () => {
    it('numeric: stored template allowed, id substituted', async () => {
        const gql = fakeGql();
        const p = await prepareGroupFeed(gql as any, 'https://www.facebook.com/groups/999', 10);
        expect(p.unresolved).toBe(false);
        if (isUnresolved(p)) return;
        expect(gql.ensureQuery).toHaveBeenCalledWith('group_feed', GROUP_FEED_QUERY_NAME, groupFeedTriggerUrl('999'), false);
        expect(p.groupId).toBe('999');
        expect(p.buildVars(p.query, 'CUR')).toMatchObject({ id: '999', cursor: 'CUR', count: 10, scale: 1 });
        await p.recapture();
        expect(gql.recapture).toHaveBeenCalledWith('group_feed', GROUP_FEED_QUERY_NAME, groupFeedTriggerUrl('999'));
    });
    it('slug: fresh capture, id taken from the captured query and not substituted', async () => {
        const gql = fakeGql({ query: query({ groupID: '777', cursor: null, count: 3 }) });
        const p = await prepareGroupFeed(gql as any, 'https://www.facebook.com/groups/my.slug', 10);
        if (isUnresolved(p)) throw new Error('should resolve');
        expect(gql.ensureQuery).toHaveBeenCalledWith('group_feed', GROUP_FEED_QUERY_NAME, groupFeedTriggerUrl('my.slug'), true);
        expect(p.groupId).toBe('777');
        expect(p.buildVars(p.query, null).groupID).toBe('777');
    });
    it('slug without numeric id in the query -> no_id', async () => {
        const gql = fakeGql({ query: query({ cursor: null }) });
        expect(await prepareGroupFeed(gql as any, 'https://www.facebook.com/groups/slug', 10)).toEqual({ unresolved: true, reason: 'no_id' });
    });
    it('query_changed -> no_query; other errors propagate', async () => {
        const changed = fakeGql({ error: new ResearchError('query_changed', 'x') });
        expect(await prepareGroupFeed(changed as any, 'https://www.facebook.com/groups/1', 10)).toEqual({ unresolved: true, reason: 'no_query' });
        const out = fakeGql({ error: new ResearchError('logged_out', 'x') });
        await expect(prepareGroupFeed(out as any, 'https://www.facebook.com/groups/1', 10)).rejects.toMatchObject({ code: 'logged_out' });
    });
});
