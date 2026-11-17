import type { PosterLookup } from '../http/posterAccess';
import { profileIdsOfStoredParams } from './profileScope';
import { BOSS_ONLY_PROFILE, isPageManagedRun, pageManagedCampaignIds, pageManagedScheduleIds } from './pageManaged';

export { BOSS_ONLY_PROFILE };

/** Newest tracked post URLs the lookup returns (commentCollect keeps at most 50 of them). */
export const MAX_TRACKED_URLS = 500;

/** Throwing reader: a SQL error must surface as an exception, never as "no rows" (that would read as "no such record" and be allowed). */
export interface LookupReader {
    query<T>(sql: string, params?: any[]): T[];
    queryOne<T>(sql: string, params?: any[]): T | undefined;
}

/** Which browser profiles each record of the poster belongs to, read from the boss database (every id is a bound parameter). Throws when the database cannot be read. */
export function createPosterLookup(db: LookupReader): PosterLookup {
    const column = (sql: string, params: unknown[]): string[] =>
        db.query<{ profile_id: string | null }>(sql, params as any[]).map((r) => r.profile_id ?? '').filter((id) => id !== '');
    const unique = (ids: string[]): string[] => [...new Set(ids)];

    return {
        scheduleProfiles: (id) => {
            const row = db.queryOne<{ params_json: string }>('SELECT params_json FROM fb_poster_schedules WHERE id = ?', [id]);
            if (!row) return null;
            const profiles = profileIdsOfStoredParams(row.params_json);
            return pageManagedScheduleIds(db).has(id) ? [...profiles, BOSS_ONLY_PROFILE] : profiles;
        },
        runProfiles: (id) => {
            const row = db.queryOne<{ params_json: string; schedule_id: string | null; campaign_id: string | null }>('SELECT params_json, schedule_id, campaign_id FROM fb_poster_runs WHERE id = ?', [id]);
            if (!row) return null;
            const profiles = [...profileIdsOfStoredParams(row.params_json), ...column('SELECT DISTINCT profile_id FROM fb_poster_results WHERE run_id = ?', [id])];
            return unique(isPageManagedRun(row, pageManagedScheduleIds(db), pageManagedCampaignIds(db)) ? [...profiles, BOSS_ONLY_PROFILE] : profiles);
        },
        leadProfiles: (id) => {
            if (!/^\d+$/.test(id)) return null;
            const row = db.queryOne<{ profile_id: string | null }>('SELECT profile_id FROM fb_poster_leads WHERE id = ?', [Number(id)]);
            return row ? (row.profile_id ? [row.profile_id] : []) : null;
        },
        campaignProfiles: (id) => {
            if (!db.queryOne('SELECT 1 AS n FROM fb_poster_campaigns WHERE id = ?', [id])) return null;
            const storedProfiles = (sql: string) => db.query<{ params_json: string }>(sql, [id]).flatMap((r) => profileIdsOfStoredParams(r.params_json));
            return unique([
                ...storedProfiles('SELECT params_json FROM fb_poster_schedules WHERE campaign_id = ?'),
                ...storedProfiles('SELECT params_json FROM fb_poster_runs WHERE campaign_id = ?'),
                ...column('SELECT DISTINCT profile_id FROM fb_poster_results WHERE run_id IN (SELECT id FROM fb_poster_runs WHERE campaign_id = ?)', [id]),
                ...column('SELECT DISTINCT profile_id FROM fb_poster_post_tracking WHERE campaign_id = ?', [id]),
                ...column('SELECT DISTINCT profile_id FROM fb_poster_leads WHERE campaign_id = ?', [id]),
                ...(pageManagedCampaignIds(db).has(id) ? [BOSS_ONLY_PROFILE] : []),
            ]);
        },
        trackedPostUrls: (profileIds) => {
            if (profileIds.length === 0) return [];
            return db.query<{ post_url: string }>(
                `SELECT post_url FROM fb_poster_post_tracking WHERE profile_id IN (${profileIds.map(() => '?').join(',')}) AND post_url IS NOT NULL AND post_url <> ''
                 GROUP BY post_url ORDER BY MAX(posted_at) DESC, MAX(result_id) DESC LIMIT ${MAX_TRACKED_URLS}`, [...profileIds],
            ).map((r) => r.post_url);
        },
    };
}

/** The lookup over a database object: strict variants when it has them (DatabaseService), else its own query (which throws, like the test adapters). */
export function strictReader(db: { query: LookupReader['query']; queryOne: LookupReader['queryOne']; queryStrict?: LookupReader['query']; queryOneStrict?: LookupReader['queryOne'] }): LookupReader {
    return {
        query: (sql, params) => (db.queryStrict ?? db.query).call(db, sql, params),
        queryOne: (sql, params) => (db.queryOneStrict ?? db.queryOne).call(db, sql, params),
    };
}
