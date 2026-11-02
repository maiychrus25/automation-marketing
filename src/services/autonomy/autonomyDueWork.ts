import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { FacebookPosterStore } from '../facebookPoster/FacebookPosterStore';
import { DailyBriefStore, type LocalClock } from '../dailyBrief/DailyBriefStore';
import { OWNER_CONFIRMATION_PREFIX } from '../control/ownerPageRunner';
import type { AutonomyLimiter } from './AutonomyLimiter';

export interface AutonomyDueWork {
    briefs: number;
    campaignSchedules: number;
    commentPosts: number;
    unrepliedLeads: number;
    videosPending: number;
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

/** Read-only: what the bot could pick up next, for `autonomy.status`. */
export function computeDueWork(db: SqlDatabase, now: number, clock: LocalClock, gate: DueWorkGate): AutonomyDueWork {
    return {
        briefs: hasTable(db, 'daily_briefs') ? new DailyBriefStore(db, clock).countDue(now) : 0,
        campaignSchedules: dueOwnerCampaigns(db, now),
        commentPosts: hasTable(db, 'fb_poster_post_tracking') ? new FacebookPosterStore(db).listDueCommentPosts(now, COMMENT_POST_SCAN_LIMIT).length : 0,
        unrepliedLeads: dueLeads(db, gate),
        videosPending: hasTable(db, 'video_jobs') ? count(db, "SELECT COUNT(*) AS n FROM video_jobs WHERE status IN ('uploading','queued','rendering')") : 0,
    };
}
