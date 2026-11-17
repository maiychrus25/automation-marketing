import { FacebookPosterStore, RUN_SCOPE_WINDOW } from '../../services/facebookPoster/FacebookPosterStore';
import { memoryDb } from './helpers';

// Two profiles with data in every table the employee-facing reads touch. `profileIds` narrows; undefined = today's behaviour; [] = nothing.
const db = memoryDb();
const store = new FacebookPosterStore(db);
store.ensureSchema();

const params = (...ids: string[]) => JSON.stringify({ mode: 'group', text: 't', profiles: ids.map((profileId) => ({ profileId, targets: [] })) });
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

beforeAll(() => {
    for (const [i, p] of [['s1', 'p1'], ['s2', 'p2'], ['s12', 'p1,p2']] as const) {
        db.run('INSERT INTO fb_poster_schedules (id, name, kind, params_json, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [i, i, 'once', params(...p.split(',')), i === 's2' ? 'c2' : 'c1', 1, 1]);
    }
    db.run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('s-none', 'n', 'once', '{}', 1, 1)");
    for (const [i, p] of [['r1', 'p1'], ['r2', 'p2'], ['r12', 'p1,p2']] as const) {
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?, 'post', 'group', ?, 'done', ?)", [i, params(...p.split(',')), NOW + (i === 'r12' ? 3 : i === 'r2' ? 2 : 1)]);
    }
    db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES ('rs1', 'scan_groups', '', ?, 'done', ?)", [JSON.stringify({ kind: 'scan_groups', profileIds: ['p1'] }), NOW]);
    // results: r-extra has no profile in its params, only in its result rows
    db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES ('r-extra', 'post', 'group', '{}', 'done', ?)", [NOW + 9]);
    db.run("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, post_url, created_at) VALUES ('r-extra', 'p2', 'n', 'https://g/9', 'posted', 'https://x/p2-extra', ?)", [NOW]);
    const result = (runId: string, profile: string, target: string, outcome: string, postUrl: string | null, at = NOW) =>
        db.run("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, target_name, outcome, post_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [runId, profile, `name-${profile}`, target, `T-${target}`, outcome, postUrl, at]);
    result('r1', 'p1', 'https://g/1', 'posted', 'https://x/p1-a');
    result('r1', 'p1', 'https://g/2', 'failed', null);
    result('r2', 'p2', 'https://g/1', 'posted', 'https://x/p2-a', NOW + 5);
    result('r2', 'p2', 'https://g/3', 'posted', 'https://x/p2-b');
    result('r12', 'p1', 'https://g/1', 'posted', 'https://x/p1-b', NOW + 6);
    db.run("INSERT INTO fb_poster_campaigns (id, name, created_at, updated_at) VALUES ('c1', 'c1', 1, 1), ('c2', 'c2', 1, 1)");
    const tracked = (resultId: number, profile: string, groupUrl: string, postUrl: string, campaign: string, kind = 'group', pageId = '') =>
        db.run("INSERT INTO fb_poster_post_tracking (result_id, run_id, profile_id, group_url, post_url, posted_at, link_status, campaign_id, target_kind, page_id) VALUES (?, 'r', ?, ?, ?, ?, 'known', ?, ?, ?)",
            [resultId, profile, groupUrl, postUrl, NOW - resultId, campaign, kind, pageId]);
    tracked(1, 'p1', 'https://g/1', 'https://x/t1', 'c1');
    tracked(2, 'p1', 'https://g/2', 'https://x/t2', 'c1');
    tracked(3, 'p2', 'https://g/1', 'https://x/t3', 'c2');
    tracked(4, 'p2', 'https://g/3', 'https://x/t4', 'c2');
    tracked(5, 'p2', 'https://g/3', 'https://x/t5', 'c2');
    tracked(6, 'p1', 'https://www.facebook.com/', 'https://x/pg1', 'c1', 'page', 'page-1');
    tracked(7, 'p2', 'https://www.facebook.com/', 'https://x/pg2', 'c2', 'page', 'page-2');
    db.run('INSERT INTO fb_poster_post_stats (result_id, captured_at, reactions, comments, shares) VALUES (1, 1, 10, 0, 0), (3, 1, 100, 0, 0)');
    db.run("INSERT INTO fb_poster_page_followers (page_id, profile_id, captured_on, captured_at, followers) VALUES ('page-1', 'p1', '2026-06-14', 1, 11), ('page-2', 'p2', '2026-06-14', 1, 22)");
    db.run("INSERT INTO fb_poster_comments (key, profile_id, post_url, collected_at) VALUES ('k1', 'p1', 'https://x/t1', 1), ('k2', 'p2', 'https://x/t3', 2), ('k3', 'p1', 'https://x/t3', 3)");
    db.run("INSERT INTO fb_poster_leads (comment_key, post_url, profile_id, campaign_id, detected_at, updated_at, text) VALUES ('k1', 'u', 'p1', 'c1', 1, 1, 'alpha'), ('k2', 'u', 'p2', 'c2', 2, 2, 'alpha'), ('k3', 'u', 'p1', NULL, 3, 3, 'beta')");
    db.run("INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, text, status, created_at) VALUES (1, 'p1', 'u', 'a', 'posted', 1), (2, 'p2', 'u', 'b', 'posted', 2), (3, 'p1', 'u', 'c', 'queued', 3)");
    db.run("INSERT INTO fb_poster_login_state (profile_id, state, checked_at, source) VALUES ('p1', 'ok', 1, 'check'), ('p2', 'logged_out', 2, 'check')");
});

const ids = (rows: Array<{ profileId?: string }>) => [...new Set(rows.map((r) => r.profileId))].sort();

describe('store reads narrowed by profileIds', () => {
    test('listPostedUrls', () => {
        expect(store.listPostedUrls(100).length).toBeGreaterThan(store.listPostedUrls(100, ['p1']).length);
        expect(ids(store.listPostedUrls(100, ['p1']))).toEqual(['p1']);
        expect(store.listPostedUrls(100, ['p1']).map((r) => r.postUrl).sort()).toEqual(['https://x/p1-a', 'https://x/p1-b']);
        expect(store.listPostedUrls(100, [])).toEqual([]);
        expect(ids(store.listPostedUrls(100))).toEqual(['p1', 'p2']);
    });

    test('listComments totalsAndRowsAreTheScopedOnes', () => {
        const all = store.listComments({ limit: 100, offset: 0 });
        const scoped = store.listComments({ limit: 100, offset: 0, profileIds: ['p1'] });
        expect(all.total).toBe(3);
        expect(scoped.total).toBe(2);
        expect(scoped.comments.every((c) => c.profileId === 'p1')).toBe(true);
        expect(store.listComments({ limit: 1, offset: 1, profileIds: ['p1'] }).total).toBe(2); // paging keeps the scoped total
        expect(store.listComments({ limit: 100, offset: 0, profileIds: [] })).toEqual({ comments: [], total: 0 });
    });

    test('listLoginStates', () => {
        expect(store.listLoginStates().map((s) => s.profileId)).toEqual(['p1', 'p2']);
        expect(store.listLoginStates(['p2']).map((s) => s.profileId)).toEqual(['p2']);
        expect(store.listLoginStates([])).toEqual([]);
    });

    test('listTracking isInAdditionToTheSingleProfileFilter', () => {
        const base = { sinceMs: 0, untilMs: NOW + DAY };
        expect(ids(store.listTracking({ ...base, profileIds: ['p1'] }))).toEqual(['p1']);
        expect(store.listTracking({ ...base, profileIds: ['p1'], profileId: 'p2' })).toEqual([]);
        expect(store.listTracking({ ...base, profileIds: [] })).toEqual([]);
        expect(ids(store.listTracking(base))).toEqual(['p1', 'p2']);
        expect(store.listTracking({ ...base, targetKind: 'page', pageId: 'page-2', profileIds: ['p1'] })).toEqual([]);
    });

    test('listPageFollowers', () => {
        expect(store.listPageFollowers({ sinceDay: '2026-01-01' }).map((f) => f.pageId)).toEqual(['page-1', 'page-2']);
        expect(store.listPageFollowers({ sinceDay: '2026-01-01', profileIds: ['p1'] }).map((f) => f.pageId)).toEqual(['page-1']);
        expect(store.listPageFollowers({ sinceDay: '2026-01-01', pageId: 'page-2', profileIds: ['p1'] })).toEqual([]);
        expect(store.listPageFollowers({ sinceDay: '2026-01-01', profileIds: [] })).toEqual([]);
    });

    test('listLeads totalsAndSearchAreScoped', () => {
        expect(store.listLeads({ limit: 10, offset: 0 }).total).toBe(3);
        const scoped = store.listLeads({ limit: 10, offset: 0, profileIds: ['p1'] });
        expect(scoped.total).toBe(2);
        expect(scoped.leads.every((l) => l.profileId === 'p1')).toBe(true);
        expect(store.listLeads({ limit: 10, offset: 0, profileIds: ['p1'], search: 'alpha' }).total).toBe(1); // the in-memory search path is scoped too
        expect(store.listLeads({ limit: 10, offset: 0, profileIds: [] })).toEqual({ leads: [], total: 0 });
    });

    test('listLeadReplies', () => {
        expect(store.listLeadReplies(10, 0).length).toBe(3);
        expect(store.listLeadReplies(10, 0, ['p1']).map((r) => r.profileId)).toEqual(['p1', 'p1']);
        expect(store.listLeadReplies(10, 0, [])).toEqual([]);
    });

    test('statsReport countsOnlyTheScopedProfiles', () => {
        const base = { from: 0, to: NOW + DAY, limit: 100 };
        const posts = (rows: Array<{ posts: number }>) => rows.reduce((n, r) => n + r.posts, 0);
        expect(posts(store.statsReport({ ...base, groupBy: 'campaign' }))).toBe(7);
        const scoped = store.statsReport({ ...base, groupBy: 'campaign', profileIds: ['p1'] });
        expect(scoped.map((r) => r.key)).toEqual(['c1']);
        expect(posts(scoped)).toBe(3);
        expect(store.statsReport({ ...base, groupBy: 'profile', profileIds: ['p2'] }).map((r) => r.key)).toEqual(['p2']);
        expect(store.statsReport({ ...base, groupBy: 'hour', profileIds: ['p1'] }).reduce((n, r) => n + r.reactions, 0)).toBe(10); // only p1's measured reactions
        expect(store.statsReport({ ...base, groupBy: 'page', profileIds: ['p1'] }).map((r) => r.key)).toEqual(['page-1']);
        expect(store.statsReport({ ...base, groupBy: 'day', profileIds: [] })).toEqual([]);
    });

    test('groupScoreInputs', () => {
        const base = { from: 0, to: NOW + DAY };
        expect(store.groupScoreInputs(base).map((g) => g.groupUrl).sort()).toEqual(['https://g/1', 'https://g/2', 'https://g/3', 'https://g/9']);
        const scoped = store.groupScoreInputs({ ...base, profileIds: ['p1'] });
        expect(scoped.map((g) => g.groupUrl).sort()).toEqual(['https://g/1', 'https://g/2']);
        const g1 = scoped.find((g) => g.groupUrl === 'https://g/1')!;
        expect(g1.attempted).toBe(2); // r1 + r12, never p2's attempt
        expect(g1.measured).toBe(1); // p1's tracked post only
        expect(store.groupScoreInputs({ ...base, profileIds: [] })).toEqual([]);
    });

    test('listSchedules keepsOnlyTheSchedulesWhoseEveryProfileIsInScope', () => {
        expect(store.listSchedules().map((s) => s.id).sort()).toEqual(['s-none', 's1', 's12', 's2']);
        expect(store.listSchedules({ profileIds: ['p1'] }).map((s) => s.id)).toEqual(['s1']);
        expect(store.listSchedules({ profileIds: ['p1', 'p2'] }).map((s) => s.id).sort()).toEqual(['s1', 's12', 's2']);
        expect(store.listSchedules({ profileIds: [] })).toEqual([]);
        expect(store.listSchedules({ campaignId: 'c1', profileIds: ['p1'] }).map((s) => s.id)).toEqual(['s1']);
    });

    test('listRuns filtersByTheRunProfilesBeforePagingAndTotalIsTheFilteredCount', () => {
        expect(store.listRuns({ limit: 50, offset: 0 }).total).toBe(5);
        const scoped = store.listRuns({ limit: 50, offset: 0, kind: 'post', profileIds: ['p1'] });
        expect(scoped.runs.map((r) => r.id)).toEqual(['r1']);
        expect(scoped.total).toBe(1);
        const both = store.listRuns({ limit: 50, offset: 0, kind: 'post', profileIds: ['p1', 'p2'] });
        expect(both.runs.map((r) => r.id)).toEqual(['r-extra', 'r12', 'r2', 'r1']); // r-extra is known by its result row only
        const paged = store.listRuns({ limit: 2, offset: 1, kind: 'post', profileIds: ['p1', 'p2'] });
        expect(paged.runs.map((r) => r.id)).toEqual(['r12', 'r2']);
        expect(paged.total).toBe(4);
        expect(store.listRuns({ limit: 50, offset: 0, profileIds: ['p1'] }).runs.map((r) => r.id).sort()).toEqual(['r1', 'rs1']);
        expect(store.listRuns({ limit: 50, offset: 0, profileIds: [] })).toEqual({ runs: [], total: 0 });
        expect(RUN_SCOPE_WINDOW).toBe(1000);
    });

    test('anIdIsNeverInterpolated', () => {
        expect(store.listComments({ limit: 10, offset: 0, profileIds: ["p1' OR '1'='1"] }).total).toBe(0);
        expect(store.listLeads({ limit: 10, offset: 0, profileIds: ["x') OR 1=1 --"] }).total).toBe(0);
    });
});

describe('Page-managed work is not listed to an employee scope', () => {
    // The database is shared by the whole file: remove the rows this test adds so the others pass in any order.
    afterEach(() => {
        db.run("DELETE FROM fb_poster_schedules WHERE id = 's-auto'");
        db.run("DELETE FROM fb_poster_runs WHERE id = 'r-auto'");
    });

    test('listSchedulesAndListRunsLeaveItOut', () => {
        db.run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, authority_kind, created_at, updated_at) VALUES ('s-auto', 'a', 'once', ?, 'autonomy', 1, 1)", [params('p1')]);
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id) VALUES ('r-auto', 'post', 'group', ?, 'done', ?, 's-auto')", [params('p1'), NOW + 50]);
        expect(store.listSchedules({ profileIds: ['p1'] }).map((s) => s.id)).toEqual(['s1']);
        expect(store.listSchedules().map((s) => s.id)).toContain('s-auto');
        expect(store.listRuns({ limit: 50, offset: 0, kind: 'post', profileIds: ['p1'] }).runs.map((r) => r.id)).toEqual(['r1']);
        expect(store.listRuns({ limit: 50, offset: 0, kind: 'post' }).runs.map((r) => r.id)).toContain('r-auto');
    });
});

describe('listRuns under a scope reads result profiles strictly', () => {
    test('aFailingResultReadFailsTheListing', () => {
        const failing: any = { ...db, queryStrict: (q: string, p?: any[]) => { if (q.includes('fb_poster_results')) throw new Error('boom'); return db.query(q, p); } };
        expect(() => new FacebookPosterStore(failing).listRuns({ limit: 10, offset: 0, profileIds: ['p1'] })).toThrow('boom');
    });
});
