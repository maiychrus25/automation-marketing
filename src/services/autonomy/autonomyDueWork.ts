import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { FacebookPosterStore } from '../facebookPoster/FacebookPosterStore';
import { DailyBriefStore, type LocalClock } from '../dailyBrief/DailyBriefStore';
import { OWNER_CONFIRMATION_PREFIX } from '../control/ownerPageRunner';
import { ENGAGEMENT_MAX_PENDING, ENGAGEMENT_RESEARCH_INTERVAL_MS, ENGAGEMENT_RESEARCH_SETTING_KEY, parseResearchLast } from '../facebookPoster/engagementRules';
import type { AutonomyLimiter } from './AutonomyLimiter';

export interface AutonomyDueWork {
    briefs: number;
    campaignSchedules: number;
    commentPosts: number;
    unrepliedLeads: number;
    videosPending: number;
    /** Total room for new comment suggestions over learned, running Page profiles (daily cap and pending limit). */
    engagementSlots: number;
    /** Where those slots are, for the bot's prompt. */
    engagementProfiles: { profileId: string; profileName: string; slots: number }[];
}

const DAY_MS = 86_400_000;
const COMMENT_POST_SCAN_LIMIT = 1000;
const hasTable = (db: SqlDatabase, name: string) =>
    (db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", [name])?.n ?? 0) > 0;
const count = (db: SqlDatabase, sql: string, params: unknown[] = []) => db.queryOne<{ n: number }>(sql, params)?.n ?? 0;

/** Gates that decide whether due work is something the bot can act on now. */
export interface DueWorkGate {
    masterOn: boolean;
    limiter: Pick<AutonomyLimiter, 'policy' | 'usage' | 'pausedProfiles'>;
}

/**
 * Owner-key campaigns (grant `owner:` ref, as `cancelOwnerCampaignSchedules`) still inside their window and quota with no post reserved in
 * the next 24 h: the bot's work is to schedule the next post. Reserved executions are run by the app itself.
 */
function dueOwnerCampaigns(db: SqlDatabase, now: number): number {
    if (!hasTable(db, 'page_campaign_grants') || !hasTable(db, 'page_campaign_executions')) return 0;
    const grants = db.query<{ id: string; campaign_id: string; policy_json: string }>(
        "SELECT id, campaign_id, policy_json FROM page_campaign_grants WHERE status = 'active' AND substr(confirmation_ref, 1, ?) = ?",
        [OWNER_CONFIRMATION_PREFIX.length, OWNER_CONFIRMATION_PREFIX]);
    const due = new Set<string>();
    for (const grant of grants) {
        let policy: { expiresAt?: unknown; maxPostsTotal?: unknown } = {};
        try { policy = JSON.parse(grant.policy_json) ?? {}; } catch { continue; }
        if (typeof policy.expiresAt !== 'number' || now >= policy.expiresAt || typeof policy.maxPostsTotal !== 'number') continue;
        if (count(db, "SELECT COUNT(*) AS n FROM page_campaign_executions WHERE grant_id = ? AND status != 'cancelled'", [grant.id]) >= policy.maxPostsTotal) continue;
        const reserved = count(db, `SELECT COUNT(*) AS n FROM page_campaign_executions e JOIN fb_poster_schedules s ON s.id = e.schedule_id
            WHERE e.grant_id = ? AND e.status = 'reserved' AND s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?`, [grant.id, now + DAY_MS]);
        if (!reserved) due.add(grant.campaign_id);
    }
    return due.size;
}

/**
 * New leads under posts the app published that no reply has handled (any reply row of the lead, or a live reply to the same
 * non-empty `(post_url, author_id)`, as `hasLeadReply`), counted only for profiles that can still reply today.
 */
function dueLeads(db: SqlDatabase, gate: DueWorkGate): number {
    if (!gate.masterOn || !hasTable(db, 'fb_poster_lead_replies')) return 0;
    const rows = db.query<{ profile_id: string; n: number }>(`SELECT res.profile_id AS profile_id, COUNT(*) AS n FROM fb_poster_leads l
        JOIN fb_poster_results res ON res.id = l.result_id AND res.outcome = 'posted'
        JOIN fb_poster_runs run ON run.id = res.run_id AND run.kind = 'post'
        WHERE l.status = 'new' AND l.post_url <> ''
        AND NOT EXISTS (SELECT 1 FROM fb_poster_lead_replies r WHERE r.lead_id = l.id)
        AND NOT (l.author_id <> '' AND EXISTS (SELECT 1 FROM fb_poster_lead_replies r WHERE r.post_url = l.post_url AND r.author_id = l.author_id
            AND r.status IN ('queued','running','posted','failed','uncertain')))
        GROUP BY res.profile_id`);
    const policy = gate.limiter.policy();
    const used = gate.limiter.usage().profiles;
    const paused = new Set(gate.limiter.pausedProfiles().map((p) => p.profileId));
    let total = 0;
    for (const row of rows) {
        const u = used[row.profile_id];
        const canReply = !paused.has(row.profile_id)
            && policy.leadRepliesPerDay > (u?.leadReplies ?? 0) && policy.facebookActionsPerDay > (u?.facebookActions ?? 0);
        if (canReply) total += row.n;
    }
    return total;
}

/**
 * Per learned, running Page profile whose browser profile still exists and whose last research attempt is older than the cooldown:
 * min(daily suggestion cap left, pending limit left), counting only pending rows that have not expired yet.
 */
function engagementSlots(db: SqlDatabase, now: number, gate: DueWorkGate): Pick<AutonomyDueWork, 'engagementSlots' | 'engagementProfiles'> {
    const none = { engagementSlots: 0, engagementProfiles: [] };
    if (!hasTable(db, 'fb_page_identities') || !hasTable(db, 'fb_poster_engagement_items')) return none;
    const checkProfiles = hasTable(db, 'browser_profiles');
    const identities = db.query<{ profile_id: string; page_name: string }>("SELECT profile_id, page_name FROM fb_page_identities WHERE kind = 'page' AND error_code = '' ORDER BY profile_id")
        .filter((i) => !checkProfiles || db.queryOne('SELECT 1 FROM browser_profiles WHERE id = ?', [i.profile_id]));
    const pending = new Map(db.query<{ profile_id: string; n: number }>("SELECT profile_id, COUNT(*) AS n FROM fb_poster_engagement_items WHERE status = 'pending' AND expires_at > ? GROUP BY profile_id", [now]).map((r) => [r.profile_id, r.n]));
    const researched = parseResearchLast(hasTable(db, 'app_settings') ? db.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [ENGAGEMENT_RESEARCH_SETTING_KEY])?.value : undefined);
    const cap = gate.limiter.policy().engagementSuggestionsPerDay;
    const used = gate.limiter.usage().profiles;
    const paused = new Set(gate.limiter.pausedProfiles().map((p) => p.profileId));
    const engagementProfiles: AutonomyDueWork['engagementProfiles'] = [];
    for (const { profile_id: id, page_name: name } of identities) {
        if (paused.has(id) || now - (researched[id] ?? -Infinity) < ENGAGEMENT_RESEARCH_INTERVAL_MS) continue;
        const slots = Math.min(cap - (used[id]?.engagementSuggestions ?? 0), ENGAGEMENT_MAX_PENDING - (pending.get(id) ?? 0));
        if (slots > 0) engagementProfiles.push({ profileId: id, profileName: name || id, slots });
    }
    return { engagementSlots: engagementProfiles.reduce((sum, p) => sum + p.slots, 0), engagementProfiles };
}

/** Read-only: what the bot could pick up next, for `autonomy.status`. */
export function computeDueWork(db: SqlDatabase, now: number, clock: LocalClock, gate: DueWorkGate): AutonomyDueWork {
    return {
        briefs: hasTable(db, 'daily_briefs') ? new DailyBriefStore(db, clock).countDue(now) : 0,
        campaignSchedules: dueOwnerCampaigns(db, now),
        commentPosts: hasTable(db, 'fb_poster_post_tracking') ? new FacebookPosterStore(db).listDueCommentPosts(now, COMMENT_POST_SCAN_LIMIT).length : 0,
        unrepliedLeads: dueLeads(db, gate),
        ...engagementSlots(db, now, gate),
        videosPending: hasTable(db, 'video_jobs') ? count(db, "SELECT COUNT(*) AS n FROM video_jobs WHERE status IN ('uploading','queued','rendering')") : 0,
    };
}
