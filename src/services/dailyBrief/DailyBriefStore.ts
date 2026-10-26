import type { DailyBrief, DailyBriefPatch, PageIdentity } from '../../models/dailyBrief';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';

export const BRIEF_MAX_ATTEMPTS_PER_DAY = 3;
export const BRIEF_STALE_MS = 3600000;
export const BRIEF_MAX_ROWS = 10;
export const BRIEF_NOT_RUNNING_ERROR = 'Kế hoạch Page không ở trạng thái đang chạy';

export interface LocalClock {
    date(ms: number): string; // YYYY-MM-DD
    minutes(ms: number): number; // 0–1439
}

export const systemClock: LocalClock = {
    date(ms) {
        const date = new Date(ms);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    },
    minutes(ms) {
        const date = new Date(ms);
        return date.getHours() * 60 + date.getMinutes();
    },
};

function mapIdentity(row: any): PageIdentity {
    return {
        profileId: row.profile_id, kind: row.kind, pageId: row.page_id, pageName: row.page_name,
        category: row.category, about: row.about, recentPosts: JSON.parse(row.recent_posts_json),
        learnedAt: row.learned_at, errorCode: row.error_code, error: row.error,
    };
}

function mapBrief(row: any): DailyBrief {
    return {
        profileId: row.profile_id, niche: row.niche, keywords: JSON.parse(row.keywords_json),
        groupIds: JSON.parse(row.group_ids_json), tone: row.tone, notes: row.notes, time: row.time,
        draftsPerDay: row.drafts_per_day, enabled: row.enabled === 1, lastRunDate: row.last_run_date,
        status: row.status, attemptDate: row.attempt_date, attempts: row.attempts,
        claimedAt: row.claimed_at, claimedDate: row.claimed_date, updatedAt: row.updated_at,
    };
}

export class DailyBriefStore {
    constructor(private readonly db: SqlDatabase, private readonly clock: LocalClock = systemClock) {}

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS fb_page_identities (
                profile_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                page_id TEXT NOT NULL DEFAULT '',
                page_name TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                about TEXT NOT NULL DEFAULT '',
                recent_posts_json TEXT NOT NULL DEFAULT '[]',
                learned_at INTEGER NOT NULL,
                error_code TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS daily_briefs (
                profile_id TEXT PRIMARY KEY,
                niche TEXT NOT NULL DEFAULT '',
                keywords_json TEXT NOT NULL DEFAULT '[]',
                group_ids_json TEXT NOT NULL DEFAULT '[]',
                tone TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                time TEXT NOT NULL DEFAULT '07:00',
                drafts_per_day INTEGER NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                last_run_date TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                attempt_date TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                claimed_at INTEGER,
                claimed_date TEXT,
                updated_at INTEGER NOT NULL
            );
        `);
    }

    upsertIdentity(i: PageIdentity): void {
        this.db.run(
            `INSERT INTO fb_page_identities
                (profile_id, kind, page_id, page_name, category, about, recent_posts_json, learned_at, error_code, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET
                kind = excluded.kind, page_id = excluded.page_id, page_name = excluded.page_name,
                category = excluded.category, about = excluded.about, recent_posts_json = excluded.recent_posts_json,
                learned_at = excluded.learned_at, error_code = excluded.error_code, error = excluded.error`,
            [i.profileId, i.kind, i.pageId, i.pageName, i.category, i.about, JSON.stringify(i.recentPosts), i.learnedAt, i.errorCode, i.error],
        );
    }

    getIdentity(profileId: string): PageIdentity | undefined {
        const row = this.db.queryOne<any>('SELECT * FROM fb_page_identities WHERE profile_id = ?', [profileId]);
        return row ? mapIdentity(row) : undefined;
    }

    listIdentities(): PageIdentity[] {
        return this.db.query<any>('SELECT * FROM fb_page_identities ORDER BY profile_id').map(mapIdentity);
    }

    getBrief(profileId: string): DailyBrief | undefined {
        const row = this.db.queryOne<any>('SELECT * FROM daily_briefs WHERE profile_id = ?', [profileId]);
        return row ? mapBrief(row) : undefined;
    }

    listBriefs(): DailyBrief[] {
        return this.db.query<any>('SELECT * FROM daily_briefs ORDER BY profile_id').map(mapBrief);
    }

    countBriefs(): number {
        return this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM daily_briefs')?.n ?? 0;
    }

    saveBrief(profileId: string, patch: DailyBriefPatch, now: number): DailyBrief {
        const current = this.getBrief(profileId);
        this.db.run(
            `INSERT INTO daily_briefs
                (profile_id, niche, keywords_json, group_ids_json, tone, notes, time, drafts_per_day, enabled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET
                niche = excluded.niche, keywords_json = excluded.keywords_json, group_ids_json = excluded.group_ids_json,
                tone = excluded.tone, notes = excluded.notes, time = excluded.time,
                drafts_per_day = excluded.drafts_per_day, enabled = excluded.enabled, updated_at = excluded.updated_at`,
            [profileId, patch.niche ?? current?.niche ?? '', JSON.stringify(patch.keywords ?? current?.keywords ?? []),
                JSON.stringify(patch.groupIds ?? current?.groupIds ?? []), patch.tone ?? current?.tone ?? '',
                patch.notes ?? current?.notes ?? '', patch.time ?? current?.time ?? '07:00',
                patch.draftsPerDay ?? current?.draftsPerDay ?? 1, (patch.enabled ?? current?.enabled ?? true) ? 1 : 0, now],
        );
        return this.getBrief(profileId)!;
    }

    deleteBrief(profileId: string): boolean {
        this.db.run('DELETE FROM daily_briefs WHERE profile_id = ?', [profileId]);
        return (this.db.queryOne<{ n: number }>('SELECT changes() AS n')?.n ?? 0) > 0;
    }

    claimDue(now: number, isEligible: (profileId: string) => boolean): DailyBrief[] {
        return this.db.transaction(() => {
            const today = this.clock.date(now);
            const minutes = this.clock.minutes(now);
            const claimed: DailyBrief[] = [];
            const briefs = this.db.query<any>('SELECT * FROM daily_briefs WHERE enabled = 1 ORDER BY profile_id').map(mapBrief);
            for (const brief of briefs) {
                let attempts = brief.attemptDate === today ? brief.attempts : 0;
                if (brief.status === 'running') {
                    if (now - brief.claimedAt! < BRIEF_STALE_MS) continue;
                    attempts += 1;
                    if (this.clock.date(brief.claimedAt!) !== today) attempts = 0;
                }
                const [hours, minute] = brief.time.split(':').map(Number);
                if (brief.lastRunDate === today || minutes < hours * 60 + minute
                    || attempts >= BRIEF_MAX_ATTEMPTS_PER_DAY || !isEligible(brief.profileId)) continue;
                this.db.run(
                    `UPDATE daily_briefs SET status = 'running', claimed_at = ?, claimed_date = ?,
                        attempt_date = ?, attempts = ?, updated_at = ? WHERE profile_id = ?`,
                    [now, today, today, attempts, now, brief.profileId],
                );
                claimed.push({
                    ...brief, status: 'running', claimedAt: now, claimedDate: today,
                    attemptDate: today, attempts, updatedAt: now,
                });
            }
            return claimed;
        });
    }

    finishBrief(profileId: string, ok: boolean, now: number, claimedAt: number): DailyBrief {
        const brief = this.getBrief(profileId);
        if (!brief || brief.status !== 'running' || brief.claimedAt !== claimedAt) throw new Error(BRIEF_NOT_RUNNING_ERROR);
        this.db.run(
            `UPDATE daily_briefs SET status = 'idle', last_run_date = ?, attempt_date = ?, attempts = ?, updated_at = ?
             WHERE profile_id = ?`,
            [ok ? brief.claimedDate : brief.lastRunDate, ok ? brief.attemptDate : brief.claimedDate,
                ok ? brief.attempts : brief.attempts + 1, now, profileId],
        );
        return this.getBrief(profileId)!;
    }
}
