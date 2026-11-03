import { ControlError } from '../control/ControlMethods';
import type { LocalClock } from '../dailyBrief/DailyBriefStore';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import {
    AUTONOMY_POLICY_SETTING_KEY, inQuietHours, mergeAutonomyPolicy, minutesOf, parseAutonomyPolicy, type AutonomyPolicy,
} from './autonomyPolicy';

export type AutonomyAction = 'page_post' | 'group_post' | 'lead_reply' | 'video' | 'agent_run' | 'engagement_suggest' | 'engagement_comment';
export type AutonomyOrigin = 'api' | 'app';
export type LimitReason = 'quota' | 'quiet_hours' | 'profile_paused' | 'stopped' | 'master_off';

export interface LimitRequest {
    action: AutonomyAction;
    origin: AutonomyOrigin;
    profileId?: string;
    targetKey?: string;
    ref?: string;
}

export interface PolicyChange { at: number; actor: string; field: keyof AutonomyPolicy; before: unknown; after: unknown }
export interface ProfilePause { profileId: string; reason: string; pausedAt: number }
export interface AutonomyUsage {
    date: string;
    workspace: { videos: number; agentRuns: number };
    profiles: Record<string, { pagePosts: number; groupPosts: number; leadReplies: number; facebookActions: number; engagementSuggestions: number; engagementComments: number }>;
}
export interface AutonomySummary { pagePosts: number; groupPosts: number; leadReplies: number; videos: number; engagementSuggested: number; engagementPosted: number; blocked: number; pauses: number }

export interface AutonomyLimiterDeps {
    now(): number;
    clock: LocalClock;
    protectedWritesEnabled(): boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const POLICY_CHANGE_RETENTION_DAYS = 30;
const FACEBOOK_ACTIONS: readonly AutonomyAction[] = ['page_post', 'group_post', 'lead_reply', 'engagement_comment'];
const FACEBOOK_LIST = FACEBOOK_ACTIONS.map((a) => `'${a}'`).join(',');

const MESSAGES: Record<LimitReason, string> = {
    quota: 'Đã hết lượt trong ngày cho thao tác này',
    quiet_hours: 'Đang trong giờ im lặng, không thao tác Facebook tự động',
    profile_paused: 'Profile đang bị dừng tự động, cần bật lại',
    stopped: 'Tự vận hành đang tắt',
    master_off: 'Công tắc ghi Facebook đang tắt',
};

interface Denial { reason: LimitReason; retryAt: number | null }
interface ActionRow { id: number; action: AutonomyAction; profile_id: string; origin: AutonomyOrigin; status: string; ref: string }

const emptyProfileUsage = () => ({ pagePosts: 0, groupPosts: 0, leadReplies: 0, facebookActions: 0, engagementSuggestions: 0, engagementComments: 0 });
const isFacebook = (action: AutonomyAction) => FACEBOOK_ACTIONS.includes(action);
/** R3: approved-engagement actions are always counted (any origin) and never gated by the master/stop switches. */
const isEngagement = (action: AutonomyAction) => action === 'engagement_suggest' || action === 'engagement_comment';

export class AutonomyLimiter {
    constructor(private readonly db: SqlDatabase, private readonly deps: AutonomyLimiterDeps) {}

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS autonomy_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                profile_id TEXT NOT NULL DEFAULT '',
                target_key TEXT NOT NULL DEFAULT '',
                origin TEXT NOT NULL,
                local_date TEXT NOT NULL,
                status TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                ref TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                settled_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_autonomy_actions_day ON autonomy_actions(local_date, action, profile_id);
            CREATE TABLE IF NOT EXISTS autonomy_profile_pauses (
                profile_id TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                paused_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS autonomy_policy_changes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at INTEGER NOT NULL,
                actor TEXT NOT NULL,
                field TEXT NOT NULL,
                before_json TEXT NOT NULL,
                after_json TEXT NOT NULL
            );
        `);
    }

    policy(): AutonomyPolicy {
        const row = this.db.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [AUTONOMY_POLICY_SETTING_KEY]);
        return parseAutonomyPolicy(row?.value ?? null);
    }

    setPolicy(patch: unknown, actor: string): { policy: AutonomyPolicy; changes: PolicyChange[] } {
        return this.db.transaction(() => {
            const before = this.policy();
            const policy = mergeAutonomyPolicy(before, patch);
            const at = this.deps.now();
            const changes = (Object.keys(policy) as (keyof AutonomyPolicy)[])
                .filter((field) => policy[field] !== before[field])
                .map((field): PolicyChange => ({ at, actor, field, before: before[field], after: policy[field] }));
            this.db.run(
                `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                [AUTONOMY_POLICY_SETTING_KEY, JSON.stringify(policy)],
            );
            this.db.run('DELETE FROM autonomy_policy_changes WHERE at < ?', [at - POLICY_CHANGE_RETENTION_DAYS * DAY_MS]);
            for (const c of changes) {
                this.db.run('INSERT INTO autonomy_policy_changes (at, actor, field, before_json, after_json) VALUES (?, ?, ?, ?, ?)',
                    [c.at, c.actor, c.field, JSON.stringify(c.before), JSON.stringify(c.after)]);
            }
            return { policy, changes };
        });
    }

    /** `switches` only looks at the master switch and the stop switch (a schedule may be created at night or while quota is spent). */
    check(req: LimitRequest, scope: 'full' | 'switches' = 'full'): void {
        const denial = this.evaluate(req, scope === 'full', scope === 'switches');
        if (denial) this.deny(req, denial);
    }

    /** Quiet hours + paused profile only, no counting and no blocked row: for read-only Facebook jobs (`engagement.readComments`). */
    checkGates(profileId: string): void {
        const req: LimitRequest = { action: 'engagement_comment', origin: 'app', profileId };
        const denial = this.evaluate(req, false);
        if (denial) this.deny(req, denial);
    }

    /** `capsOnly`: only the caps apply (no quiet-hours / pause / switch gates); the gates are re-checked by `assertEffect` at effect time. */
    reserve(req: LimitRequest, opts: { capsOnly?: boolean } = {}): number | null {
        if (req.origin === 'app' && req.action !== 'video' && !isEngagement(req.action)) return null;
        let denial: Denial | null = null;
        const id = this.db.transaction(() => {
            denial = this.evaluate(req, true, false, opts.capsOnly === true);
            if (denial) return null;
            return this.db.runInsert(
                `INSERT INTO autonomy_actions (action, profile_id, target_key, origin, local_date, status, ref, created_at)
                 VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
                [req.action, req.profileId ?? '', req.targetKey ?? '', req.origin, this.today(), req.ref ?? '', this.deps.now()],
            );
        });
        // The blocked row is written after the transaction so a refusal never rolls itself back.
        if (denial) this.deny(req, denial);
        return id;
    }

    commit(id: number): boolean {
        return this.db.transaction(() => {
            const row = this.db.queryOne<{ status: string }>('SELECT status FROM autonomy_actions WHERE id = ?', [id]);
            if (row?.status !== 'reserved') return false;
            this.db.run("UPDATE autonomy_actions SET status = 'used', settled_at = ? WHERE id = ?", [this.deps.now(), id]);
            return true;
        });
    }

    release(id: number): boolean {
        return this.db.transaction(() => {
            const row = this.db.queryOne<{ status: string }>('SELECT status FROM autonomy_actions WHERE id = ?', [id]);
            if (row?.status !== 'reserved') return false;
            this.db.run("UPDATE autonomy_actions SET status = 'released', settled_at = ? WHERE id = ?", [this.deps.now(), id]);
            return true;
        });
    }

    /** Re-checks the gates (not the caps) right before the real effect; an approved comment also re-checks the posting-day cap. */
    assertEffect(id: number): void {
        const row = this.db.queryOne<ActionRow>('SELECT id, action, profile_id, origin, status, ref FROM autonomy_actions WHERE id = ?', [id]);
        if (!row || (row.origin !== 'api' && !isEngagement(row.action))) return;
        const req: LimitRequest = { action: row.action, origin: row.origin, profileId: row.profile_id || undefined, ref: row.ref || undefined };
        const denial = this.evaluate(req, false) ?? (row.action === 'engagement_comment' ? this.postingDayDenial(row.profile_id) : null);
        if (denial) this.deny(req, denial);
    }

    /** Approval books the slot on the approval day; comments the profile sent today (by send time) must stay under the cap. */
    private postingDayDenial(profileId: string): Denial | null {
        const effective = this.effectiveNow();
        const today = this.deps.clock.date(effective);
        const sent = this.db.query<{ settled_at: number }>(
            "SELECT settled_at FROM autonomy_actions WHERE action = 'engagement_comment' AND status = 'used' AND profile_id = ? AND settled_at > ?",
            [profileId, effective - 2 * DAY_MS]).filter((r) => this.deps.clock.date(r.settled_at) === today).length;
        return sent >= this.policy().engagementCommentsPerDay ? { reason: 'quota', retryAt: this.midnightAfter(effective) } : null;
    }

    pauseProfile(profileId: string, reason: 'checkpoint' | 'logged_out'): boolean {
        return this.db.transaction(() => {
            if (this.db.queryOne('SELECT 1 FROM autonomy_profile_pauses WHERE profile_id = ?', [profileId])) return false;
            const now = this.deps.now();
            this.db.run('INSERT INTO autonomy_profile_pauses (profile_id, reason, paused_at) VALUES (?, ?, ?)', [profileId, reason, now]);
            this.db.run(
                `INSERT INTO autonomy_actions (action, profile_id, origin, local_date, status, reason, created_at)
                 VALUES ('profile_pause', ?, 'app', ?, 'event', ?, ?)`,
                [profileId, this.deps.clock.date(now), reason, now],
            );
            return true;
        });
    }

    resumeProfile(profileId: string): boolean {
        return this.db.transaction(() => {
            if (!this.db.queryOne('SELECT 1 FROM autonomy_profile_pauses WHERE profile_id = ?', [profileId])) return false;
            this.db.run('DELETE FROM autonomy_profile_pauses WHERE profile_id = ?', [profileId]);
            return true;
        });
    }

    pausedProfiles(): ProfilePause[] {
        return this.db.query<{ profile_id: string; reason: string; paused_at: number }>(
            'SELECT profile_id, reason, paused_at FROM autonomy_profile_pauses ORDER BY paused_at, profile_id',
        ).map((r) => ({ profileId: r.profile_id, reason: r.reason, pausedAt: r.paused_at }));
    }

    usage(): AutonomyUsage {
        const date = this.today();
        const rows = this.db.query<{ action: string; profile_id: string; n: number }>(
            `SELECT action, profile_id, COUNT(*) AS n FROM autonomy_actions
             WHERE local_date = ? AND status IN ('reserved','used') GROUP BY action, profile_id`, [date]);
        const usage: AutonomyUsage = { date, workspace: { videos: 0, agentRuns: 0 }, profiles: {} };
        for (const r of rows) {
            if (r.action === 'video') usage.workspace.videos += r.n;
            else if (r.action === 'agent_run') usage.workspace.agentRuns += r.n;
            else if (isFacebook(r.action as AutonomyAction)) {
                const p = (usage.profiles[r.profile_id] ??= emptyProfileUsage());
                if (r.action === 'page_post') p.pagePosts += r.n;
                else if (r.action === 'group_post') p.groupPosts += r.n;
                else if (r.action === 'engagement_comment') p.engagementComments += r.n;
                else p.leadReplies += r.n;
                p.facebookActions += r.n;
            } else if (r.action === 'engagement_suggest') {
                (usage.profiles[r.profile_id] ??= emptyProfileUsage()).engagementSuggestions += r.n;
            }
        }
        return usage;
    }

    changes(sinceMs: number): PolicyChange[] {
        const floor = Math.max(sinceMs, this.deps.now() - POLICY_CHANGE_RETENTION_DAYS * DAY_MS);
        return this.db.query<{ at: number; actor: string; field: string; before_json: string; after_json: string }>(
            'SELECT at, actor, field, before_json, after_json FROM autonomy_policy_changes WHERE at >= ? ORDER BY id', [floor],
        ).map((r) => ({ at: r.at, actor: r.actor, field: r.field as keyof AutonomyPolicy, before: JSON.parse(r.before_json), after: JSON.parse(r.after_json) }));
    }

    summary(from: number, to: number): AutonomySummary {
        const rows = this.db.query<{ action: string; status: string; origin: string; n: number }>(
            'SELECT action, status, origin, COUNT(*) AS n FROM autonomy_actions WHERE created_at >= ? AND created_at <= ? GROUP BY action, status, origin', [from, to]);
        const out: AutonomySummary = { pagePosts: 0, groupPosts: 0, leadReplies: 0, videos: 0, engagementSuggested: 0, engagementPosted: 0, blocked: 0, pauses: 0 };
        for (const r of rows) {
            if (r.status === 'blocked') out.blocked += r.n;
            else if (r.action === 'profile_pause') out.pauses += r.n;
            else if (r.status === 'reserved' || r.status === 'used') {
                if (r.action === 'page_post') out.pagePosts += r.n;
                else if (r.action === 'group_post') out.groupPosts += r.n;
                else if (r.action === 'lead_reply') out.leadReplies += r.n;
                else if (r.action === 'engagement_suggest') out.engagementSuggested += r.n;
                else if (r.action === 'engagement_comment') out.engagementPosted += r.n;
                // "Bot đã tự làm": the operator's own videos share the cap but are not the bot's work.
                else if (r.action === 'video' && r.origin === 'api') out.videos += r.n;
            }
        }
        return out;
    }

    /** A rolled-back clock must not reopen today's quota, so the date comes from the latest recorded time. */
    private effectiveNow(): number {
        const latest = this.db.queryOne<{ t: number | null }>('SELECT MAX(created_at) AS t FROM autonomy_actions')?.t ?? 0;
        return Math.max(this.deps.now(), latest);
    }

    private today(): string {
        return this.deps.clock.date(this.effectiveNow());
    }

    /** Next local midnight (R7). */
    private midnightAfter(now: number): number {
        return now + (1440 - this.deps.clock.minutes(now)) * MINUTE_MS;
    }

    private evaluate(req: LimitRequest, withCaps: boolean, switchesOnly = false, capsOnly = false): Denial | null {
        const policy = this.policy();
        const now = this.deps.now();
        const facebook = isFacebook(req.action);
        const engagement = isEngagement(req.action);
        if (!capsOnly && req.origin === 'api' && !engagement) {
            if (facebook && !this.deps.protectedWritesEnabled()) return { reason: 'master_off', retryAt: null };
            if (!policy.enabled) return { reason: 'stopped', retryAt: null };
        }
        if (switchesOnly) return null;
        if (!capsOnly && facebook && (req.origin === 'api' || engagement)) {
            const minute = this.deps.clock.minutes(now);
            if (inQuietHours(policy, minute)) {
                const wait = (minutesOf(policy.quietEnd) - minute + 1440) % 1440;
                return { reason: 'quiet_hours', retryAt: now + wait * MINUTE_MS };
            }
            const profileId = req.profileId ?? '';
            if (this.db.queryOne('SELECT 1 FROM autonomy_profile_pauses WHERE profile_id = ?', [profileId])) return { reason: 'profile_paused', retryAt: null };
        }
        if (!withCaps) return null;
        const effective = this.effectiveNow();
        const quota: Denial = { reason: 'quota', retryAt: this.midnightAfter(effective) };
        const date = this.deps.clock.date(effective);
        const profileId = req.profileId ?? '';
        const countWhere = (where: string, params: unknown[]) => this.db.queryOne<{ n: number }>(
            `SELECT COUNT(*) AS n FROM autonomy_actions WHERE status IN ('reserved','used') AND ${where}`, params)!.n;
        const dayCount = (action: AutonomyAction, perProfile: boolean) => countWhere(
            perProfile ? 'local_date = ? AND action = ? AND profile_id = ?' : 'local_date = ? AND action = ?',
            perProfile ? [date, action, profileId] : [date, action]);

        if (facebook) {
            const cap = { page_post: policy.pagePostsPerDay, group_post: policy.groupPostsPerDay, lead_reply: policy.leadRepliesPerDay, engagement_comment: policy.engagementCommentsPerDay }[req.action as 'page_post' | 'group_post' | 'lead_reply' | 'engagement_comment'];
            if (dayCount(req.action, true) >= cap) return quota;
            if (countWhere(`local_date = ? AND profile_id = ? AND action IN (${FACEBOOK_LIST})`, [date, profileId]) >= policy.facebookActionsPerDay) return quota;
            if (req.action === 'group_post') {
                const oldest = this.db.queryOne<{ t: number | null }>(
                    `SELECT MIN(created_at) AS t FROM autonomy_actions WHERE status IN ('reserved','used')
                     AND action = 'group_post' AND profile_id = ? AND target_key = ? AND created_at > ?`,
                    [profileId, req.targetKey ?? '', effective - policy.groupRepeatDays * DAY_MS])?.t;
                if (oldest != null) return { reason: 'quota', retryAt: oldest + policy.groupRepeatDays * DAY_MS };
            }
        } else if (req.action === 'engagement_suggest') {
            if (dayCount('engagement_suggest', true) >= policy.engagementSuggestionsPerDay) return quota;
        } else if (req.action === 'video') {
            const used = dayCount('video', false);
            const keepLast = req.origin === 'api' && policy.videoReserveLast ? 1 : 0;
            if (used + keepLast >= policy.videosPerDay) return quota;
        } else if (dayCount('agent_run', false) >= policy.agentRunsPerDay) return quota;
        return null;
    }

    private deny(req: LimitRequest, denial: Denial): never {
        if (req.origin === 'api') {
            const now = this.deps.now();
            this.db.run(
                `INSERT INTO autonomy_actions (action, profile_id, target_key, origin, local_date, status, reason, ref, created_at)
                 VALUES (?, ?, ?, ?, ?, 'blocked', ?, ?, ?)`,
                [req.action, req.profileId ?? '', req.targetKey ?? '', req.origin, this.deps.clock.date(this.effectiveNow()), denial.reason, req.ref ?? '', now],
            );
        }
        throw new ControlError('LIMIT_REACHED', MESSAGES[denial.reason], { reason: denial.reason, retryAt: denial.retryAt });
    }
}
