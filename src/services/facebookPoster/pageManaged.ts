/**
 * The one predicate for "this belongs to Page-managed work" (the boss's Page autonomy): used by the record lookup, the scoped
 * schedule/run lists and the media-folder rule, so an employee's profile never reaches it.
 * Reads must throw on failure (strict reader): a missing table is not an error, every other failure is.
 */

/** Profile id no browser profile can have: boss-only records carry it, so no employee scope ever covers them. */
export const BOSS_ONLY_PROFILE = '__boss__';

export interface StrictReader { query<T>(sql: string, params?: any[]): T[] }

const TABLES = ['page_campaign_links', 'page_work_resources', 'page_campaign_executions'];

function existingTables(db: StrictReader): Set<string> {
    return new Set(db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')})`, TABLES).map((r) => r.name));
}

/** Campaigns with any Page-link row (a deleted link still counts). */
export function pageManagedCampaignIds(db: StrictReader): Set<string> {
    if (!existingTables(db).has('page_campaign_links')) return new Set();
    return new Set(db.query<{ campaign_id: string }>('SELECT campaign_id FROM page_campaign_links').map((r) => r.campaign_id));
}

/**
 * Schedules and drafts of Page-managed work: autonomy authority (schedule column `authority_kind`, FacebookPosterStore.writeSchedule),
 * a campaign with a Page link (page_campaign_links, PageCampaignStore), a draft owned by page work (page_work_resources, FacebookPosterStore.isWorkOwnedDraft),
 * or a Page-campaign execution row (page_campaign_executions, schema.ts).
 */
export function pageManagedScheduleIds(db: StrictReader): Set<string> {
    const tables = existingTables(db);
    const ids = new Set<string>();
    const add = (sql: string) => { for (const r of db.query<{ id: string }>(sql)) ids.add(r.id); };
    add("SELECT id FROM fb_poster_schedules WHERE authority_kind = 'autonomy'" + (tables.has('page_campaign_links') ? ' OR campaign_id IN (SELECT campaign_id FROM page_campaign_links)' : ''));
    if (tables.has('page_work_resources')) add("SELECT resource_id AS id FROM page_work_resources WHERE resource_kind = 'draft'");
    if (tables.has('page_campaign_executions')) add('SELECT schedule_id AS id FROM page_campaign_executions');
    return ids;
}

/** A run is Page-managed when it came from a Page-managed schedule or belongs to a Page-managed campaign. */
export function isPageManagedRun(run: { schedule_id: string | null; campaign_id: string | null }, schedules: ReadonlySet<string>, campaigns: ReadonlySet<string>): boolean {
    return (!!run.schedule_id && schedules.has(run.schedule_id)) || (!!run.campaign_id && campaigns.has(run.campaign_id));
}
