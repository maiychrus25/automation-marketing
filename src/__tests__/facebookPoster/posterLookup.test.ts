import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { createPosterLookup, BOSS_ONLY_PROFILE, MAX_TRACKED_URLS } from '../../services/facebookPoster/posterLookup';
import { memoryDb } from './helpers';

const db = memoryDb();
new FacebookPosterStore(db).ensureSchema();
const lookup = createPosterLookup(db);
const params = (profiles: string[]) => JSON.stringify({ mode: 'group', text: 't', profiles: profiles.map((profileId) => ({ profileId, targets: [] })) });
const schedule = (id: string, paramsJson: string, campaignId: string | null = null, draft = 0) =>
    db.run('INSERT INTO fb_poster_schedules (id, name, kind, params_json, draft, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)', [id, id, 'once', paramsJson, draft, campaignId]);
const run = (id: string, paramsJson: string, campaignId: string | null = null) =>
    db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, campaign_id) VALUES (?, 'post', 'group', ?, 'done', 1, ?)", [id, paramsJson, campaignId]);
const result = (runId: string, profileId: string) =>
    db.run("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES (?, ?, 'n', 'u', 'posted', 1)", [runId, profileId]);
const tracking = (resultId: number, profileId: string, postUrl: string | null, postedAt: number, campaignId: string | null = null) =>
    db.run("INSERT INTO fb_poster_post_tracking (result_id, run_id, profile_id, group_url, post_url, posted_at, link_status, campaign_id) VALUES (?, 'r', ?, 'g', ?, ?, 'known', ?)", [resultId, profileId, postUrl, postedAt, campaignId]);
const lead = (key: string, profileId: string, campaignId: string | null = null) =>
    db.run("INSERT INTO fb_poster_leads (comment_key, post_url, profile_id, campaign_id, detected_at, updated_at) VALUES (?, 'u', ?, ?, 1, 1)", [key, profileId, campaignId]);
const campaign = (id: string) => db.run("INSERT INTO fb_poster_campaigns (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)", [id, id]);

describe('createPosterLookup', () => {
    test('scheduleProfilesReadsTheStoredParamsAndDraftsShareTheTable', () => {
        schedule('s-two', params(['p1', 'p2']));
        schedule('d-one', params(['p3']), null, 1);
        expect(lookup.scheduleProfiles('s-two').sort()).toEqual(['p1', 'p2']);
        expect(lookup.scheduleProfiles('d-one')).toEqual(['p3']);
    });

    test('scheduleProfilesIsNullOnlyForAMissingRow', () => {
        expect(lookup.scheduleProfiles('nope')).toBeNull();
        schedule('s-bad', '{not json');
        schedule('s-none', JSON.stringify({ mode: 'group', profiles: [] }));
        expect(lookup.scheduleProfiles('s-bad')).toEqual([]);
        expect(lookup.scheduleProfiles('s-none')).toEqual([]);
    });

    test('runProfilesIsTheUnionOfTheStoredParamsAndTheResultProfiles', () => {
        run('r1', params(['p1']));
        result('r1', 'p9');
        result('r1', 'p9');
        expect(lookup.runProfiles('r1').sort()).toEqual(['p1', 'p9']);
        expect(lookup.runProfiles('missing')).toBeNull();
        run('r-bad', 'oops');
        expect(lookup.runProfiles('r-bad')).toEqual([]);
    });

    test('leadProfilesIsTheProfileOfTheRow', () => {
        lead('k1', 'p1');
        const id = (db.queryOne<{ id: number }>("SELECT id FROM fb_poster_leads WHERE comment_key = 'k1'"))!.id;
        expect(lookup.leadProfiles(String(id))).toEqual(['p1']);
        expect(lookup.leadProfiles('99999')).toBeNull();
        lead('k2', '');
        const emptyId = (db.queryOne<{ id: number }>("SELECT id FROM fb_poster_leads WHERE comment_key = 'k2'"))!.id;
        expect(lookup.leadProfiles(String(emptyId))).toEqual([]);
        expect(lookup.leadProfiles('not-a-number')).toBeNull();
    });

    test('campaignProfilesUnionsSchedulesRunsTrackingAndLeads', () => {
        campaign('c-all'); campaign('c-empty');
        schedule('cs', params(['p1']), 'c-all');
        run('cr', params(['p2']), 'c-all');
        result('cr', 'p2b');
        tracking(501, 'p3', 'https://x/1', 10, 'c-all');
        lead('ck', 'p4', 'c-all');
        expect(lookup.campaignProfiles('c-all').sort()).toEqual(['p1', 'p2', 'p2b', 'p3', 'p4']);
        expect(lookup.campaignProfiles('c-empty')).toEqual([]);
        expect(lookup.campaignProfiles('c-missing-never-created')).toBeNull();
    });

    test('aCampaignManagedByPageAutonomyCarriesTheBossOnlyMarker', () => {
        campaign('c-page'); campaign('c-deleted');
        schedule('ps', params(['p1']), 'c-page');
        expect(lookup.campaignProfiles('c-page')).toEqual(['p1']); // no links table yet: nothing marks it
        db.exec('CREATE TABLE page_campaign_links (campaign_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, page_id TEXT, profile_id TEXT, revision INTEGER, managed INTEGER, proposal_id TEXT, created_at INTEGER, deleted_at INTEGER)');
        db.run("INSERT INTO page_campaign_links VALUES ('c-page', 'w', 'pg', 'p1', 1, 1, 'pr', 1, NULL)");
        db.run("INSERT INTO page_campaign_links VALUES ('c-deleted', 'w', 'pg', 'p1', 2, 1, 'pr', 1, 5)");
        expect(lookup.campaignProfiles('c-page')).toEqual(expect.arrayContaining(['p1', BOSS_ONLY_PROFILE]));
        expect(lookup.campaignProfiles('c-deleted')).toContain(BOSS_ONLY_PROFILE); // a deleted link still marks it
        expect(BOSS_ONLY_PROFILE).toBe('__boss__');
    });

    test('trackedPostUrlsAreTheOnesOfTheGivenProfilesNewestFirst', () => {
        tracking(601, 'q1', 'https://x/old', 100);
        tracking(602, 'q1', 'https://x/new', 300);
        tracking(603, 'q2', 'https://x/other', 200);
        tracking(604, 'q1', null, 400);
        tracking(605, 'q1', '', 500);
        expect(lookup.trackedPostUrls(['q1'])).toEqual(['https://x/new', 'https://x/old']);
        expect(lookup.trackedPostUrls(['q1', 'q2'])).toEqual(['https://x/new', 'https://x/other', 'https://x/old']);
        expect(lookup.trackedPostUrls([])).toEqual([]);
    });

    test('anIdIsAlwaysABoundParameter', () => {
        expect(lookup.scheduleProfiles("x' OR '1'='1")).toBeNull();
        expect(lookup.campaignProfiles("x' OR '1'='1")).toBeNull();
    });
});

describe('Page-managed work carries the boss-only marker (one predicate)', () => {
    beforeAll(() => {
        db.exec('CREATE TABLE IF NOT EXISTS page_work_resources (resource_kind TEXT, resource_id TEXT)');
        db.exec('CREATE TABLE IF NOT EXISTS page_campaign_executions (schedule_id TEXT PRIMARY KEY, x TEXT)');
        campaign('c-linked');
        schedule('pm-linked', params(['p1']), 'c-linked');
        db.run("INSERT OR IGNORE INTO page_campaign_links VALUES ('c-linked', 'w', 'pg', 'p1', 1, 1, 'pr', 1, NULL)");
        schedule('pm-auth', params(['p1']));
        db.run("UPDATE fb_poster_schedules SET authority_kind = 'autonomy' WHERE id = 'pm-auth'");
        schedule('pm-work', params(['p1']), null, 1);
        db.run("INSERT INTO page_work_resources VALUES ('draft', 'pm-work')");
        schedule('pm-exec', params(['p1']));
        db.run("INSERT INTO page_campaign_executions VALUES ('pm-exec', 'x')");
        schedule('plain', params(['p1']));
    });

    test.each(['pm-linked', 'pm-auth', 'pm-work', 'pm-exec'])('schedule %s is boss only', (id) => {
        expect(lookup.scheduleProfiles(id)).toContain(BOSS_ONLY_PROFILE);
    });
    test('anOrdinaryScheduleIsNot', () => expect(lookup.scheduleProfiles('plain')).toEqual(['p1']));

    test('aRunOfAManagedScheduleOrCampaignIsBossOnly', () => {
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id) VALUES ('run-ms', 'post', 'group', ?, 'done', 1, 'pm-auth')", [params(['p1'])]);
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, campaign_id) VALUES ('run-mc', 'post', 'group', ?, 'done', 1, 'c-linked')", [params(['p1'])]);
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id) VALUES ('run-ok', 'post', 'group', ?, 'done', 1, 'plain')", [params(['p1'])]);
        expect(lookup.runProfiles('run-ms')).toContain(BOSS_ONLY_PROFILE);
        expect(lookup.runProfiles('run-mc')).toContain(BOSS_ONLY_PROFILE);
        expect(lookup.runProfiles('run-ok')).toEqual(['p1']);
    });
});

describe('the lookup throws instead of answering "no such record"', () => {
    test('aFailingQueryPropagates', () => {
        const broken = createPosterLookup({ query: () => { throw new Error('boom'); }, queryOne: () => { throw new Error('boom'); } });
        for (const call of [() => broken.scheduleProfiles('x'), () => broken.runProfiles('x'), () => broken.leadProfiles('1'), () => broken.campaignProfiles('x'), () => broken.trackedPostUrls(['p1'])]) {
            expect(call).toThrow('boom');
        }
    });
    test('aMissingPosterTableIsAnErrorToo', () => {
        const bare = memoryDb();
        expect(() => createPosterLookup(bare).scheduleProfiles('x')).toThrow();
    });
});

describe('cost of the lookup', () => {
    test('campaignProfilesRunsAFixedNumberOfQueriesWhateverTheRunCount', () => {
        campaign('c-many');
        for (let i = 0; i < 20; i++) run(`many-${i}`, params(['p1']), 'c-many');
        let calls = 0;
        const counting = createPosterLookup({ query: (s, p) => { calls++; return db.query(s, p); }, queryOne: (s, p) => { calls++; return db.queryOne(s, p); } });
        counting.campaignProfiles('c-many');
        expect(calls).toBeLessThanOrEqual(10);
    });
    test('trackedPostUrlsAreDistinctAndCapped', () => {
        tracking(701, 'dup', 'https://x/same', 1);
        tracking(702, 'dup', 'https://x/same', 2);
        expect(lookup.trackedPostUrls(['dup'])).toEqual(['https://x/same']);
        expect(MAX_TRACKED_URLS).toBe(500);
    });
});
