import { FB_POSTER_SCHEMA_SQL, FB_POSTER_MIGRATIONS } from './schema';
import { MIN_MEASURED_FOR_COMPARISON } from './postTracking';
import { keyOf, type CollectedComment } from './collectComments';
import { parseCommentTime } from './commentTime';
import { stripAccents } from './leadRules';
import type { GroupScoreInput } from './groupScores';
import type { LeadCursor } from './notificationRules';
import { VARIANT_LABELS, variantText } from './variants';
import type {
    FbPosterComment, FbPosterLead, LeadStatus, FbPosterGroup, FbPosterKind, FbPosterMode, FbPosterResult, FbPosterRun, FbPosterRunStatus,
    CampaignStatus, FbPosterCampaign, FbPosterSchedule, FbPosterScheduleView, LoginState, ProfileLoginState,
    LinkStatus, FbPosterEngagementItem, EngagementStatus, LeadReplySource, LeadReplyStatus, FbPosterLeadReply, PostStatsGroupBy, PostStatsReportRow, PostStatsSnapshot, PageFollowerRow, PostTrackingRow, TrackTargetKind,
} from '../../models/facebookPoster';

/**
 * Phần nhỏ nhất của DatabaseService mà store cần. DatabaseService thoả giao diện này
 * bằng các method public sẵn có; test dùng better-sqlite3 :memory: vì DatabaseService
 * import `electron` nên không nạp được trong jest.
 * Lưu ý: DatabaseService.query/queryOne nuốt lỗi và trả []/undefined — đừng dựa vào chúng để bắt lỗi.
 */
export interface SqlDatabase {
    exec(sql: string): void;
    run(sql: string, params?: any[]): void;
    runInsert(sql: string, params?: any[]): number;
    transaction<T>(fn: () => T): T;
    query<T>(sql: string, params?: any[]): T[];
    queryOne<T>(sql: string, params?: any[]): T | undefined;
}

type ScheduleFields = Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt' | 'lastRunId' | 'kind' | 'draft' | 'params' | 'campaignId' | 'origin'>>;

export const INTERRUPTED_REPLY_REASON = 'App đóng khi đang gửi; cần xem lại bài trên Facebook.';
const INTERRUPTED_RUN_ERROR = 'App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook.';

function mapLeadReply(row: any): FbPosterLeadReply {
    return {
        id: row.id, leadId: row.lead_id, profileId: row.profile_id, postUrl: row.post_url, authorId: row.author_id, text: row.text,
        status: row.status, reason: row.reason, reservationId: row.reservation_id, createdAt: row.created_at, finishedAt: row.finished_at,
    };
}

function mapEngagement(row: any): FbPosterEngagementItem {
    return {
        id: row.id, profileId: row.profile_id, kind: row.kind, postUrl: row.post_url, postKey: row.post_key,
        targetCommentId: row.target_comment_id, targetAuthor: row.target_author, targetExcerpt: row.target_excerpt, postExcerpt: row.post_excerpt,
        suggestedText: row.suggested_text, approvedText: row.approved_text, reason: row.reason, sourceRef: row.source_ref,
        status: row.status, rejectReason: row.reject_reason, resultReason: row.result_reason,
        suggestedAt: row.suggested_at, expiresAt: row.expires_at, decidedAt: row.decided_at, postedAt: row.posted_at, reservationId: row.reservation_id,
    };
}

function mapRun(row: any): FbPosterRun {
    return {
        id: row.id,
        kind: row.kind,
        mode: row.mode,
        params: JSON.parse(row.params_json),
        status: row.status,
        error: row.error,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? null,
        scheduleId: row.schedule_id ?? null,
        scheduleName: row.schedule_name ?? null,
        campaignId: row.campaign_id ?? null,
        origin: row.origin === 'api' ? 'api' : 'app',
    };
}

function mapCampaign(row: any): FbPosterCampaign {
    return {
        id: row.id, name: row.name, goal: row.goal, status: row.status,
        startAt: row.start_at ?? null, endAt: row.end_at ?? null,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

function mapSchedule(row: any): FbPosterSchedule {
    return {
        id: row.id,
        revision: row.revision,
        name: row.name,
        kind: row.kind,
        params: JSON.parse(row.params_json),
        runAt: row.run_at ?? null,
        days: row.days === '' ? [] : String(row.days).split(',').map(Number),
        time: row.time,
        enabled: row.enabled === 1,
        draft: row.draft === 1,
        authorityKind: row.authority_kind,
        origin: row.origin === 'api' ? 'api' : 'app',
        campaignId: row.campaign_id ?? null,
        nextRunAt: row.next_run_at ?? null,
        lastRunId: row.last_run_id ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapResult(row: any): FbPosterResult {
    return {
        id: row.id,
        runId: row.run_id,
        profileId: row.profile_id,
        profileName: row.profile_name,
        targetUrl: row.target_url,
        targetName: row.target_name,
        outcome: row.outcome,
        error: row.error,
        errorCode: row.error_code ?? '',
        attempts: row.attempts ?? 1,
        variant: row.variant ?? '',
        postUrl: row.post_url ?? null,
        commentStatus: row.comment_status,
        identity: row.identity,
        createdAt: row.created_at,
    };
}

function mapTracking(row: any): PostTrackingRow {
    return {
        resultId: row.result_id,
        runId: row.run_id,
        scheduleId: row.schedule_id ?? null,
        campaignId: row.campaign_id ?? null,
        variant: row.variant ?? '',
        profileId: row.profile_id,
        targetKind: row.target_kind === 'page' ? 'page' : 'group',
        pageId: row.page_id ?? '',
        groupUrl: row.group_url,
        groupId: row.group_id,
        postId: row.post_id,
        postUrl: row.post_url ?? null,
        postedAt: row.posted_at,
        textHead: row.text_head,
        linkStatus: row.link_status,
        removedSuspected: row.removed_suspected === 1,
        lastSeenAt: row.last_seen_at ?? null,
        lastCheckedAt: row.last_checked_at ?? null,
        checkCount: row.check_count,
        nextCheckAt: row.next_check_at ?? null,
        statsDone: row.stats_done === '' ? [] : String(row.stats_done).split(','),
        commentsDone: !row.comments_done ? [] : String(row.comments_done).split(','),
        nextCommentAt: row.next_comment_at ?? null,
    };
}

function mapLead(row: any): FbPosterLead {
    return {
        id: row.id,
        commentKey: row.comment_key,
        postUrl: row.post_url,
        resultId: row.result_id ?? null,
        groupUrl: row.group_url,
        campaignId: row.campaign_id ?? null,
        variant: row.variant ?? '',
        profileId: row.profile_id,
        authorId: row.author_id,
        authorName: row.author_name,
        authorUrl: row.author_url,
        text: row.text,
        commentedAtMs: row.commented_at_ms ?? null,
        matched: row.matched === '' ? [] : String(row.matched).split(','),
        aiIntent: row.ai_intent ?? null,
        aiScore: row.ai_score ?? null,
        aiReason: row.ai_reason ?? null,
        status: row.status,
        note: row.note,
        detectedAt: row.detected_at,
        updatedAt: row.updated_at,
    };
}

function mapPostStats(row: any): PostStatsSnapshot {
    return {
        id: row.id, resultId: row.result_id, capturedAt: row.captured_at,
        reactions: row.reactions ?? null, comments: row.comments ?? null, shares: row.shares ?? null,
    };
}

/** Cột của fb_poster_post_tracking mà updateTracking được vá, theo tên trường PostTrackingRow. */
const TRACKING_PATCH_COLUMNS: Record<string, string> = {
    postId: 'post_id', postUrl: 'post_url', groupId: 'group_id', linkStatus: 'link_status', removedSuspected: 'removed_suspected',
    lastSeenAt: 'last_seen_at', lastCheckedAt: 'last_checked_at', checkCount: 'check_count', nextCheckAt: 'next_check_at', statsDone: 'stats_done',
};

const IN_CHUNK = 500;
function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

export const engagementOf = (s: Pick<PostStatsSnapshot, 'reactions' | 'comments' | 'shares'>) => (s.reactions ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);

function localDay(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mapComment(row: any): FbPosterComment {
    return {
        key: row.key,
        profileId: row.profile_id,
        postUrl: row.post_url,
        authorId: row.author_id,
        authorName: row.author_name,
        authorUrl: row.author_url,
        text: row.text,
        commentedAt: row.commented_at,
        commentedAtMs: row.commented_at_ms ?? null,
        collectedAt: row.collected_at,
    };
}

export class FacebookPosterStore {
    constructor(private readonly db: SqlDatabase) {}

    /** Trusted same-handle composition only, never a public payload or a second connection. */
    transaction<T>(body:(db:SqlDatabase)=>T):T {return this.db.transaction(() => body(this.db));}

    ensureSchema(): void {
        this.db.exec(FB_POSTER_SCHEMA_SQL);
        for (const sql of FB_POSTER_MIGRATIONS) {
            try { this.db.exec(sql); } catch { /* cột đã có */ }
        }
    }

    /** Ownership survives journal retention; neither origin nor profile proves ownership. */
    isWorkOwnedDraft(id: string): boolean {
        const schema = this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page_work_resources'");
        if (!schema) throw new Error('Không đọc được quyền sở hữu bản nháp');
        if (!schema.n) return false;
        const row = this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM page_work_resources WHERE resource_kind = 'draft' AND resource_id = ?", [id]);
        if (!row) throw new Error('Không đọc được quyền sở hữu bản nháp');
        return row.n > 0;
    }

    // ─── Runs ────────────────────────────────────────────────────────────────

    createRun(run: { id: string; kind: FbPosterKind; mode: FbPosterMode | ''; params: Record<string, unknown>; startedAt: number; scheduleId?: string | null; campaignId?: string | null; origin?: 'api' | 'app' }): void {
        this.db.run(
            `INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id, campaign_id, origin) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
            [run.id, run.kind, run.mode, JSON.stringify(run.params), run.startedAt, run.scheduleId ?? null, run.campaignId ?? null, run.origin ?? 'app'],
        );
    }

    /** Ghi một lượt của lịch không chạy được (lỡ giờ / lỗi trước khi chạy): run kind 'post', không có kết quả đích. */
    recordScheduleRun(r: { id: string; scheduleId: string; params: Record<string, unknown>; at: number; status: 'missed' | 'failed'; reason: string }): void {
        this.db.run(
            `INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, error, started_at, finished_at, schedule_id)
             VALUES (?, 'post', ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, String(r.params.mode ?? ''), JSON.stringify(r.params), r.status, r.reason, r.at, r.at, r.scheduleId],
        );
    }

    finishRun(id: string, status: Exclude<FbPosterRunStatus, 'running'>, error: string, finishedAt: number): void {
        this.db.run('UPDATE fb_poster_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?', [status, error, finishedAt, id]);
    }

    /** App khởi động: việc còn 'running' nghĩa là app đã đóng giữa chừng. Trả số việc đã đổi. */
    failInterruptedRuns(now: number): number {
        return this.db.transaction(() => {
            const pending = this.count(`SELECT COUNT(*) AS n FROM fb_poster_runs WHERE status = 'running'`);
            this.db.run(
                `UPDATE fb_poster_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`,
                [INTERRUPTED_RUN_ERROR, now],
            );
            return pending;
        });
    }

    addResult(r: Omit<FbPosterResult, 'id' | 'variant'> & { variant?: string }): number {
        return this.db.runInsert(
            `INSERT INTO fb_poster_results
                (run_id, profile_id, profile_name, target_url, target_name, outcome, error, error_code, attempts, variant, post_url, comment_status, identity, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.runId, r.profileId, r.profileName, r.targetUrl, r.targetName, r.outcome, r.error, r.errorCode, r.attempts, r.variant ?? '', r.postUrl, r.commentStatus, r.identity, r.createdAt],
        );
    }

    listRuns(opts: { limit: number; offset: number; kind?: FbPosterKind }): { runs: FbPosterRun[]; total: number } {
        const where = opts.kind ? 'WHERE kind = ?' : '';
        const filter = opts.kind ? [opts.kind] : [];
        const rows = this.db.query<any>(
            `SELECT r.*, s.name AS schedule_name FROM fb_poster_runs r LEFT JOIN fb_poster_schedules s ON s.id = r.schedule_id
             ${opts.kind ? 'WHERE r.kind = ?' : ''} ORDER BY r.started_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
            [...filter, opts.limit, opts.offset],
        );
        return { runs: rows.map(mapRun), total: this.count(`SELECT COUNT(*) AS n FROM fb_poster_runs ${where}`, filter) };
    }

    getRun(id: string): { run: FbPosterRun; results: FbPosterResult[] } | null {
        const row = this.db.queryOne<any>('SELECT r.*, s.name AS schedule_name FROM fb_poster_runs r LEFT JOIN fb_poster_schedules s ON s.id = r.schedule_id WHERE r.id = ?', [id]);
        if (!row) return null;
        const results = this.db.query<any>('SELECT * FROM fb_poster_results WHERE run_id = ? ORDER BY id', [id]);
        return { run: mapRun(row), results: results.map(mapResult) };
    }

    /** Dòng mới nhất của mỗi post_url (bare column đi theo MAX() trong SQLite), mới nhất trước. */
    listPostedUrls(limit: number): { postUrl: string; profileId: string; profileName: string; targetUrl: string; createdAt: number }[] {
        return this.db.query<any>(
            `SELECT r.post_url, r.profile_id, r.profile_name, r.target_url, MAX(r.created_at) AS created_at
             FROM fb_poster_results r JOIN fb_poster_runs u ON u.id = r.run_id
             WHERE r.post_url IS NOT NULL
             GROUP BY r.post_url ORDER BY created_at DESC LIMIT ?`,
            [limit],
        ).map((row) => ({
            postUrl: row.post_url,
            profileId: row.profile_id,
            profileName: row.profile_name,
            targetUrl: row.target_url,
            createdAt: row.created_at,
        }));
    }

    // ─── Schedules ───────────────────────────────────────────────────────────

    createSchedule(s: Omit<FbPosterSchedule, 'lastRunId' | 'updatedAt' | 'draft' | 'campaignId' | 'revision'> & { draft?: boolean; campaignId?: string | null }): void {
        this.db.run(
            `INSERT INTO fb_poster_schedules
                (id, name, kind, params_json, run_at, days, time, enabled, draft, campaign_id, next_run_at, last_run_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [s.id, s.name, s.kind, JSON.stringify(s.params), s.runAt, s.days.join(','), s.time, s.enabled ? 1 : 0, s.draft ? 1 : 0, s.campaignId ?? null, s.nextRunAt, s.createdAt, s.createdAt],
        );
    }

    getSchedule(id: string): FbPosterSchedule | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_schedules WHERE id = ?', [id]);
        return row ? mapSchedule(row) : null;
    }

    /** filter.campaignId: id = lịch của chiến dịch đó, '' = lịch không thuộc chiến dịch nào. */
    listSchedules(filter: { campaignId?: string } = {}): FbPosterScheduleView[] {
        const where = filter.campaignId === undefined ? '' : filter.campaignId === '' ? 'WHERE s.campaign_id IS NULL' : 'WHERE s.campaign_id = ?';
        const rows = this.db.query<any>(
            `SELECT s.*, r.status AS lr_status, r.started_at AS lr_started_at, r.error AS lr_error
             FROM fb_poster_schedules s LEFT JOIN fb_poster_runs r ON r.id = s.last_run_id
             ${where}
             ORDER BY s.enabled DESC, s.next_run_at IS NULL, s.next_run_at, s.created_at`,
            filter.campaignId ? [filter.campaignId] : [],
        );
        return rows.map((row) => ({
            ...mapSchedule(row),
            lastRun: row.lr_status == null ? null : { status: row.lr_status, startedAt: row.lr_started_at, error: row.lr_error },
        }));
    }

    updateSchedule(id: string, fields: ScheduleFields, updatedAt: number, expectedRevision?: number): void {
        this.db.transaction(() => this.writeSchedule(id, fields, updatedAt, expectedRevision, false));
    }

    /** Internal promotion/CAS seam; never accept provenance from a public payload. */
    updateAutonomySchedule(id: string, fields: ScheduleFields, updatedAt: number, expectedRevision: number): void {
        this.writeSchedule(id, fields, updatedAt, expectedRevision, true);
    }

    private writeSchedule(id: string, fields: ScheduleFields, updatedAt: number, expectedRevision: number | undefined, autonomy: boolean): void {
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
            throw new Error('Phiên bản bản nháp không hợp lệ');
        const existing = this.getSchedule(id);
        const changesAuthority = Object.keys(fields).some(key => !['name', 'nextRunAt', 'lastRunId'].includes(key));
        if (!autonomy && changesAuthority && existing?.authorityKind === 'autonomy') this.invalidateAutonomySchedule(id);
        const sets: string[] = ['revision = revision + 1'];
        if (autonomy) sets.push("authority_kind = 'autonomy'");
        else if (changesAuthority && existing?.authorityKind === 'autonomy') sets.push("authority_kind = 'owner'");
        const values: any[] = [];
        const set = (column: string, value: any) => { sets.push(`${column} = ?`); values.push(value); };
        if (fields.name !== undefined) set('name', fields.name);
        if (fields.enabled !== undefined) set('enabled', fields.enabled ? 1 : 0);
        if (fields.runAt !== undefined) set('run_at', fields.runAt);
        if (fields.days !== undefined) set('days', fields.days.join(','));
        if (fields.time !== undefined) set('time', fields.time);
        if (fields.nextRunAt !== undefined) set('next_run_at', fields.nextRunAt);
        if (fields.lastRunId !== undefined) set('last_run_id', fields.lastRunId);
        if (fields.kind !== undefined) set('kind', fields.kind);
        if (fields.draft !== undefined) set('draft', fields.draft ? 1 : 0);
        if (fields.params !== undefined) set('params_json', JSON.stringify(fields.params));
        if (fields.campaignId !== undefined) set('campaign_id', fields.campaignId);
        if (fields.origin !== undefined) set('origin', fields.origin);
        set('updated_at', updatedAt);
        this.db.run(`UPDATE fb_poster_schedules SET ${sets.join(', ')} WHERE id = ?${expectedRevision === undefined ? '' : ` AND revision = ?${autonomy ? '' : ' AND draft = 1'}`}`,
            [...values, id, ...(expectedRevision === undefined ? [] : [expectedRevision])]);
        if (expectedRevision !== undefined && this.db.queryOne<{ n: number }>('SELECT changes() AS n')?.n !== 1)
            throw new Error('Bản nháp đã thay đổi, vui lòng tải lại');
    }

    private invalidateAutonomySchedule(id: string): void {
        const execution = this.db.queryOne<{status:string;revision:number}>('SELECT status,revision FROM page_campaign_executions WHERE schedule_id=?',[id]);
        if (!execution || execution.status === 'submitting' || execution.status === 'uncertain')
            throw new Error('Lịch tự động thiếu quyền hoặc chưa rõ kết quả, cần đối soát');
        if (execution.status === 'reserved') {
            this.db.run(`UPDATE page_campaign_executions SET status='cancelled', revision=revision+1,
                execution_json=json_set(execution_json,'$.status','cancelled','$.revision',revision+1) WHERE schedule_id=? AND revision=? AND status='reserved'`,[id,execution.revision]);
            if (this.db.queryOne<{n:number}>('SELECT changes() AS n')?.n !== 1) throw new Error('Lịch tự động đã thay đổi');
        }
    }

    deleteSchedule(id: string): void {
        this.db.transaction(() => {
            if (this.getSchedule(id)?.authorityKind === 'autonomy') this.invalidateAutonomySchedule(id);
            this.db.run('DELETE FROM fb_poster_schedules WHERE id = ?', [id]);
        });
    }

    /** Số lượt đã thực sự bắt đầu của lịch (running / done / cancelled; bỏ missed / failed). */
    countStartedRuns(scheduleId: string): number {
        return this.count(
            `SELECT COUNT(*) AS n FROM fb_poster_runs WHERE schedule_id = ? AND status IN ('running', 'done', 'cancelled')`,
            [scheduleId],
        );
    }

    countSchedules(): number {
        return this.count('SELECT COUNT(*) AS n FROM fb_poster_schedules');
    }

    listDueSchedules(atOrBefore: number): FbPosterSchedule[] {
        return this.db.query<any>(
            'SELECT * FROM fb_poster_schedules WHERE enabled = 1 AND draft = 0 AND next_run_at <= ? ORDER BY next_run_at, created_at',
            [atOrBefore],
        ).map(mapSchedule);
    }

    nextScheduledAt(): number | null {
        return this.db.queryOne<{ t: number | null }>('SELECT MIN(next_run_at) AS t FROM fb_poster_schedules WHERE enabled = 1 AND draft = 0')?.t ?? null;
    }

    // ─── Campaigns ───────────────────────────────────────────────────────────

    createCampaign(c: FbPosterCampaign): void {
        this.db.run(
            `INSERT INTO fb_poster_campaigns (id, name, goal, status, start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [c.id, c.name, c.goal, c.status, c.startAt, c.endAt, c.createdAt, c.updatedAt],
        );
    }

    getCampaign(id: string): FbPosterCampaign | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_campaigns WHERE id = ?', [id]);
        return row ? mapCampaign(row) : null;
    }

    /** Mặc định bỏ 'archived'; opts.status lọc đúng một trạng thái (kể cả 'archived'). */
    listCampaigns(opts: { status?: CampaignStatus; includeArchived?: boolean } = {}): FbPosterCampaign[] {
        const where = opts.status ? 'WHERE status = ?' : opts.includeArchived ? '' : `WHERE status != 'archived'`;
        return this.db.query<any>(
            `SELECT * FROM fb_poster_campaigns ${where} ORDER BY created_at DESC, rowid DESC`,
            opts.status ? [opts.status] : [],
        ).map(mapCampaign);
    }

    updateCampaign(id: string, patch: Partial<Pick<FbPosterCampaign, 'name' | 'goal' | 'status' | 'startAt' | 'endAt'>>, at: number): void {
        const sets: string[] = [];
        const values: any[] = [];
        const set = (column: string, value: any) => { sets.push(`${column} = ?`); values.push(value); };
        if (patch.name !== undefined) set('name', patch.name);
        if (patch.goal !== undefined) set('goal', patch.goal);
        if (patch.status !== undefined) set('status', patch.status);
        if (patch.startAt !== undefined) set('start_at', patch.startAt);
        if (patch.endAt !== undefined) set('end_at', patch.endAt);
        set('updated_at', at);
        this.db.run(`UPDATE fb_poster_campaigns SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    }

    deleteCampaign(id: string): void {
        this.db.run('DELETE FROM fb_poster_campaigns WHERE id = ?', [id]);
    }

    /** Tên đã trim, không phân biệt hoa thường (so sánh trong JS để hoa thường Unicode đúng). */
    findCampaignByName(name: string): FbPosterCampaign | null {
        const wanted = name.trim().toLowerCase();
        return this.listCampaigns({ includeArchived: true }).find((c) => c.name.trim().toLowerCase() === wanted) ?? null;
    }

    countCampaignSchedules(id: string): { schedules: number; drafts: number } {
        return {
            schedules: this.count('SELECT COUNT(*) AS n FROM fb_poster_schedules WHERE campaign_id = ? AND draft = 0', [id]),
            drafts: this.count('SELECT COUNT(*) AS n FROM fb_poster_schedules WHERE campaign_id = ? AND draft = 1', [id]),
        };
    }

    // ─── Groups ──────────────────────────────────────────────────────────────

    /** Thay toàn bộ nhóm của một profile trong một transaction. INSERT thường: URL trùng làm hỏng cả lần thay, dòng cũ giữ nguyên. */
    replaceGroups(profileId: string, groups: { url: string; name: string }[], scannedAt: number): void {
        this.db.transaction(() => {
            this.db.run('DELETE FROM fb_poster_groups WHERE profile_id = ?', [profileId]);
            for (const g of groups) {
                this.db.run(
                    'INSERT INTO fb_poster_groups (profile_id, url, name, scanned_at) VALUES (?, ?, ?, ?)',
                    [profileId, g.url, g.name, scannedAt],
                );
            }
        });
    }

    listGroups(profileIds: string[]): Record<string, FbPosterGroup[]> {
        const byProfile: Record<string, FbPosterGroup[]> = {};
        for (const id of profileIds) byProfile[id] = [];
        if (profileIds.length === 0) return byProfile;
        const rows = this.db.query<any>(
            `SELECT profile_id, url, name, scanned_at FROM fb_poster_groups
             WHERE profile_id IN (${profileIds.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE, url`,
            profileIds,
        );
        for (const row of rows) {
            byProfile[row.profile_id].push({ profileId: row.profile_id, url: row.url, name: row.name, scannedAt: row.scanned_at });
        }
        return byProfile;
    }

    deleteGroupsOfProfile(profileId: string): void {
        this.db.run('DELETE FROM fb_poster_groups WHERE profile_id = ?', [profileId]);
    }

    // ─── Comments ────────────────────────────────────────────────────────────

    loadCommentKeys(): Set<string> {
        const keys = new Set<string>();
        for (const row of this.db.query<{ key: string; authorId: string; postUrl: string; text: string }>(
            'SELECT key, author_id AS authorId, post_url AS postUrl, text FROM fb_poster_comments',
        )) {
            keys.add(row.key);
            keys.add(keyOf(row)); // Recognize legacy raw keys without rewriting persisted rows.
        }
        return keys;
    }

    /** Trả số dòng thật sự thêm mới (dòng trùng khoá bị bỏ qua). */
    saveComments(profileId: string, rows: CollectedComment[], collectedAt: number): number {
        return this.insertCommentsReturningNew(profileId, rows, collectedAt).length;
    }

    /** Ghi bình luận (kèm commented_at_ms ước tính) và trả các dòng thật sự mới, theo thứ tự đầu vào. */
    insertCommentsReturningNew(profileId: string, rows: CollectedComment[], collectedAt: number): FbPosterComment[] {
        if (rows.length === 0) return [];
        return this.db.transaction(() => {
            // Refresh once per batch inside the transaction: caller snapshots can be stale.
            const knownKeys = this.loadCommentKeys();
            const created: FbPosterComment[] = [];
            for (const c of rows) {
                const key = keyOf(c);
                if (knownKeys.has(key)) continue;
                const commentedAtMs = parseCommentTime(c.commentedAt, collectedAt);
                this.db.run(
                    `INSERT OR IGNORE INTO fb_poster_comments
                        (key, profile_id, post_url, author_id, author_name, author_url, text, commented_at, commented_at_ms, collected_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [key, profileId, c.postUrl, c.authorId, c.authorName, c.authorUrl, c.text, c.commentedAt, commentedAtMs, collectedAt],
                );
                if (this.count('SELECT changes() AS n') > 0) { // INSERT OR IGNORE: 0 = trùng khoá, không quét cả bảng
                    knownKeys.add(key);
                    created.push({
                        key, profileId, postUrl: c.postUrl, authorId: c.authorId, authorName: c.authorName, authorUrl: c.authorUrl,
                        text: c.text, commentedAt: c.commentedAt, commentedAtMs, collectedAt,
                    });
                }
            }
            return created;
        });
    }

    /** `since` (ms): chỉ bình luận thu từ mốc đó (collected_at >= since). */
    listComments(opts: { postUrl?: string; since?: number; limit: number; offset: number }): { comments: FbPosterComment[]; total: number } {
        const conditions: string[] = [];
        const filter: any[] = [];
        if (opts.postUrl !== undefined) { conditions.push('post_url = ?'); filter.push(opts.postUrl); }
        if (opts.since !== undefined) { conditions.push('collected_at >= ?'); filter.push(opts.since); }
        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
        const rows = this.db.query<any>(
            `SELECT * FROM fb_poster_comments ${where} ORDER BY collected_at DESC, rowid DESC LIMIT ? OFFSET ?`,
            [...filter, opts.limit, opts.offset],
        );
        return { comments: rows.map(mapComment), total: this.count(`SELECT COUNT(*) AS n FROM fb_poster_comments ${where}`, filter) };
    }

    listLoginStates(): ProfileLoginState[] {
        return this.db.query<any>('SELECT * FROM fb_poster_login_state ORDER BY profile_id').map((row) => ({
            profileId: row.profile_id,
            state: row.state,
            checkedAt: row.checked_at ?? null,
            source: row.source ?? null,
            lastError: row.last_error ?? null,
            lastErrorAt: row.last_error_at ?? null,
        }));
    }

    /** Ghi trạng thái xác định được, xoá lỗi cũ; trả trạng thái trước đó (null nếu chưa có). */
    setLoginState(profileId: string, state: LoginState, source: 'check' | 'run', at: number): LoginState | null {
        const previous = this.db.queryOne<{ state: LoginState }>('SELECT state FROM fb_poster_login_state WHERE profile_id = ?', [profileId])?.state ?? null;
        this.db.run(
            `INSERT INTO fb_poster_login_state (profile_id, state, checked_at, source, last_error, last_error_at) VALUES (?, ?, ?, ?, NULL, NULL)
             ON CONFLICT(profile_id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at, source = excluded.source, last_error = NULL, last_error_at = NULL`,
            [profileId, state, at, source],
        );
        return previous;
    }

    /** Chỉ ghi lỗi khi đã có dòng (cột state NOT NULL): chưa kiểm tra lần nào thì vẫn hiện 'unknown'. */
    setLoginError(profileId: string, error: string, at: number): void {
        this.db.run('UPDATE fb_poster_login_state SET last_error = ?, last_error_at = ? WHERE profile_id = ?', [error, at, profileId]);
    }

    // ─── Theo dõi bài đã đăng ────────────────────────────────────────────────

    createTracking(row: Omit<PostTrackingRow, 'campaignId' | 'variant' | 'commentsDone' | 'nextCommentAt' | 'targetKind' | 'pageId'> & { campaignId?: string | null; variant?: string; commentsDone?: string[]; nextCommentAt?: number | null; targetKind?: TrackTargetKind; pageId?: string }): void {
        this.db.run(
            `INSERT OR IGNORE INTO fb_poster_post_tracking
               (result_id, run_id, schedule_id, campaign_id, variant, profile_id, target_kind, page_id, group_url, group_id, post_id, post_url, posted_at, text_head,
                link_status, removed_suspected, last_seen_at, last_checked_at, check_count, next_check_at, stats_done, comments_done, next_comment_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.resultId, row.runId, row.scheduleId, row.campaignId ?? null, row.variant ?? '', row.profileId, row.targetKind ?? 'group', row.pageId ?? '',
             row.groupUrl, row.groupId, row.postId, row.postUrl, row.postedAt,
             row.textHead, row.linkStatus, row.removedSuspected ? 1 : 0, row.lastSeenAt, row.lastCheckedAt, row.checkCount,
             row.nextCheckAt, row.statsDone.join(','), (row.commentsDone ?? []).join(','), row.nextCommentAt ?? null],
        );
    }

    listTracking(filter: { linkStatus?: LinkStatus; profileId?: string; groupUrl?: string; campaignId?: string; scheduleId?: string; sinceMs?: number; untilMs?: number; limit?: number; targetKind?: TrackTargetKind; pageId?: string }): PostTrackingRow[] {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.targetKind !== undefined) { where.push('target_kind = ?'); params.push(filter.targetKind); }
        if (filter.pageId !== undefined) { where.push('page_id = ?'); params.push(filter.pageId); }
        if (filter.linkStatus !== undefined) { where.push('link_status = ?'); params.push(filter.linkStatus); }
        if (filter.profileId !== undefined) { where.push('profile_id = ?'); params.push(filter.profileId); }
        if (filter.groupUrl !== undefined) { where.push('group_url = ?'); params.push(filter.groupUrl); }
        if (filter.campaignId === '') where.push('campaign_id IS NULL');
        else if (filter.campaignId !== undefined) { where.push('campaign_id = ?'); params.push(filter.campaignId); }
        if (filter.scheduleId !== undefined) { where.push('schedule_id = ?'); params.push(filter.scheduleId); }
        if (filter.sinceMs !== undefined) { where.push('posted_at >= ?'); params.push(filter.sinceMs); }
        if (filter.untilMs !== undefined) { where.push('posted_at <= ?'); params.push(filter.untilMs); }
        params.push(filter.limit ?? 1000);
        return this.db.query<any>(
            `SELECT * FROM fb_poster_post_tracking ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at DESC, result_id DESC LIMIT ?`,
            params,
        ).map(mapTracking);
    }

    /**
     * Các cặp (profile, nhóm) — hoặc (profile, Page) với dòng Page — có dòng đến hạn, bài chờ duyệt rồi bài chưa có link
     * đứng trước, rồi theo mốc sớm nhất. Chỉ cặp Page mới có khóa `pageId`.
     */
    listDuePairs(now: number, limit: number): { profileId: string; groupUrl: string; pageId?: string }[] {
        return this.db.query<any>(
            `SELECT profile_id, group_url, target_kind, page_id,
                    MIN(CASE link_status WHEN 'pending_approval' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END) AS priority,
                    MIN(next_check_at) AS earliest
             FROM fb_poster_post_tracking
             WHERE next_check_at IS NOT NULL AND next_check_at <= ?
             GROUP BY profile_id, group_url, target_kind, page_id
             ORDER BY priority ASC, earliest ASC, profile_id ASC, group_url ASC, page_id ASC LIMIT ?`,
            [now, limit],
        ).map((r) => (r.target_kind === 'page'
            ? { profileId: r.profile_id, groupUrl: r.group_url, pageId: r.page_id }
            : { profileId: r.profile_id, groupUrl: r.group_url }));
    }

    /** Dòng của một cặp: không có `pageId` thì chỉ dòng nhóm; có thì chỉ dòng của đúng Page đó. */
    listTrackingForPair(profileId: string, groupUrl: string, sinceMs: number, pageId?: string): PostTrackingRow[] {
        const kind = pageId === undefined ? "AND target_kind = 'group'" : "AND target_kind = 'page' AND page_id = ?";
        return this.db.query<any>(
            `SELECT * FROM fb_poster_post_tracking WHERE profile_id = ? AND group_url = ? AND posted_at >= ? ${kind} ORDER BY posted_at DESC, result_id DESC`,
            pageId === undefined ? [profileId, groupUrl, sinceMs] : [profileId, groupUrl, sinceMs, pageId],
        ).map(mapTracking);
    }

    updateTracking(resultId: number, patch: Partial<Omit<PostTrackingRow, 'resultId' | 'runId' | 'scheduleId' | 'profileId' | 'groupUrl' | 'postedAt' | 'textHead'>>): void {
        const sets: string[] = [];
        const params: any[] = [];
        for (const [key, column] of Object.entries(TRACKING_PATCH_COLUMNS)) {
            if (!(key in patch)) continue;
            const value = (patch as Record<string, unknown>)[key];
            if (value === undefined) continue;
            sets.push(`${column} = ?`);
            params.push(key === 'removedSuspected' ? (value ? 1 : 0) : key === 'statsDone' ? (value as string[]).join(',') : value);
        }
        if (sets.length === 0) return;
        this.db.run(`UPDATE fb_poster_post_tracking SET ${sets.join(', ')} WHERE result_id = ?`, [...params, resultId]);
    }

    /** Dòng theo dõi theo post_url (chia lô 500); nhiều dòng cùng URL thì lấy dòng result_id nhỏ nhất. */
    trackingByPostUrls(postUrls: string[]): Map<string, PostTrackingRow> {
        const out = new Map<string, PostTrackingRow>();
        for (const urls of chunk([...new Set(postUrls)], IN_CHUNK)) {
            const rows = this.db.query<any>(
                `SELECT * FROM fb_poster_post_tracking WHERE post_url IN (${urls.map(() => '?').join(',')}) ORDER BY result_id DESC`,
                urls,
            );
            for (const row of rows) out.set(row.post_url, mapTracking(row)); // result_id giảm dần nên dòng nhỏ nhất ghi đè sau cùng
        }
        return out;
    }

    recordPageFollowers(row: PageFollowerRow): boolean {
        this.db.run(
            `INSERT OR IGNORE INTO fb_poster_page_followers (page_id, profile_id, captured_on, captured_at, followers, followers_text, approximate) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [row.pageId, row.profileId, row.capturedOn, row.capturedAt, row.followers, row.followersText ?? '', row.approximate ? 1 : 0],
        );
        return this.db.queryOne<{ n: number }>('SELECT changes() AS n')?.n === 1;
    }

    hasPageFollowersOn(pageId: string, capturedOn: string): boolean {
        return this.db.query<any>(`SELECT 1 FROM fb_poster_page_followers WHERE page_id = ? AND captured_on = ?`, [pageId, capturedOn]).length > 0;
    }

    listPageFollowers(filter: { pageId?: string; sinceDay: string }): PageFollowerRow[] {
        const where = filter.pageId === undefined ? ['captured_on >= ?'] : ['captured_on >= ?', 'page_id = ?'];
        const params = filter.pageId === undefined ? [filter.sinceDay] : [filter.sinceDay, filter.pageId];
        return this.db.query<any>(
            `SELECT * FROM fb_poster_page_followers WHERE ${where.join(' AND ')} ORDER BY page_id, captured_on`, params,
        ).map((r) => ({ pageId: r.page_id, profileId: r.profile_id, capturedOn: r.captured_on, capturedAt: r.captured_at, followers: r.followers, followersText: r.followers_text ?? '', approximate: r.approximate === 1 }));
    }

    // ─── Thu bình luận tự động ───────────────────────────────────────────────

    /** Bài nhóm đã có link, đến mốc thu bình luận kế tiếp; sớm nhất trước. Dòng Page không bao giờ vào lịch thu tự động. */
    listDueCommentPosts(now: number, limit: number): PostTrackingRow[] {
        return this.db.query<any>(
            `SELECT * FROM fb_poster_post_tracking
             WHERE target_kind = 'group' AND link_status = 'known' AND post_url IS NOT NULL AND post_url <> '' AND next_comment_at IS NOT NULL AND next_comment_at <= ?
             ORDER BY next_comment_at ASC, result_id ASC LIMIT ?`,
            [now, limit],
        ).map(mapTracking);
    }

    updateCommentSchedule(resultId: number, patch: { commentsDone: string[]; nextCommentAt: number | null }): void {
        this.db.run(
            'UPDATE fb_poster_post_tracking SET comments_done = ?, next_comment_at = ? WHERE result_id = ?',
            [patch.commentsDone.join(','), patch.nextCommentAt, resultId],
        );
    }

    // ─── Khách tiềm năng ─────────────────────────────────────────────────────

    /** INSERT OR IGNORE theo comment_key; trả các dòng thật sự được tạo (có id). */
    createLeads(leads: Omit<FbPosterLead, 'id'>[]): FbPosterLead[] {
        return this.db.transaction(() => {
            const created: FbPosterLead[] = [];
            for (const l of leads) {
                const id = this.db.runInsert(
                    `INSERT OR IGNORE INTO fb_poster_leads
                       (comment_key, post_url, result_id, group_url, campaign_id, variant, profile_id, author_id, author_name, author_url, text,
                        commented_at_ms, matched, ai_intent, ai_score, ai_reason, status, note, detected_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [l.commentKey, l.postUrl, l.resultId, l.groupUrl, l.campaignId, l.variant, l.profileId, l.authorId, l.authorName, l.authorUrl, l.text,
                     l.commentedAtMs, l.matched.join(','), l.aiIntent, l.aiScore, l.aiReason, l.status, l.note, l.detectedAt, l.updatedAt],
                );
                if (this.count('SELECT changes() AS n') > 0) created.push({ ...l, id });
            }
            return created;
        });
    }

    /** Lọc theo trạng thái / chiến dịch / khoảng detected_at ở SQL; tìm chữ không dấu, không phân biệt hoa thường ở JS rồi mới phân trang. */
    listLeads(filter: { status?: LeadStatus; campaignId?: string; from?: number; to?: number; search?: string; limit: number; offset: number }): { leads: FbPosterLead[]; total: number } {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.status !== undefined) { where.push('status = ?'); params.push(filter.status); }
        if (filter.campaignId === '') where.push('campaign_id IS NULL');
        else if (filter.campaignId !== undefined) { where.push('campaign_id = ?'); params.push(filter.campaignId); }
        if (filter.from !== undefined) { where.push('detected_at >= ?'); params.push(filter.from); }
        if (filter.to !== undefined) { where.push('detected_at <= ?'); params.push(filter.to); }
        const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const needle = stripAccents((filter.search ?? '').trim());
        if (needle === '') {
            const rows = this.db.query<any>(
                `SELECT * FROM fb_poster_leads ${clause} ORDER BY detected_at DESC, id DESC LIMIT ? OFFSET ?`,
                [...params, filter.limit, filter.offset],
            );
            return { leads: rows.map(mapLead), total: this.count(`SELECT COUNT(*) AS n FROM fb_poster_leads ${clause}`, params) };
        }
        const matching = this.db.query<any>(`SELECT * FROM fb_poster_leads ${clause} ORDER BY detected_at DESC, id DESC`, params)
            .filter((row) => stripAccents(row.author_name).includes(needle) || stripAccents(row.text).includes(needle));
        return { leads: matching.slice(filter.offset, filter.offset + filter.limit).map(mapLead), total: matching.length };
    }

    /**
     * Hàng chờ tin gom: lead có `id` lớn hơn con trỏ, theo thứ tự ghi (`id` AUTOINCREMENT, không lùi khi đồng hồ máy bị chỉnh).
     * `cursor.at` (giờ phát hiện của lead cuối) chỉ còn để hiển thị; con trỏ cũ `{ at, id }` vẫn dùng được.
     */
    listLeadsAfter(cursor: LeadCursor): FbPosterLead[] {
        return this.db.query<any>('SELECT * FROM fb_poster_leads WHERE id > ? ORDER BY id ASC', [cursor.id]).map(mapLead);
    }

    /** Lead ghi sau cùng (id lớn nhất). */
    latestLeadCursor(): LeadCursor | null {
        const row = this.db.queryOne<{ detected_at: number; id: number }>('SELECT detected_at, id FROM fb_poster_leads ORDER BY id DESC LIMIT 1');
        return row ? { at: row.detected_at, id: row.id } : null;
    }

    updateLead(id: number, patch: { status?: LeadStatus; note?: string }, at: number): FbPosterLead | null {
        const sets: string[] = ['updated_at = ?'];
        const params: any[] = [at];
        if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
        if (patch.note !== undefined) { sets.push('note = ?'); params.push(patch.note); }
        this.db.run(`UPDATE fb_poster_leads SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_leads WHERE id = ?', [id]);
        return row ? mapLead(row) : null;
    }

    /** Xoá khách phát hiện trước `ms`; trả số dòng đã xoá. */
    pruneLeadsOlderThan(ms: number): number {
        return this.db.transaction(() => {
            const before = this.count('SELECT COUNT(*) AS n FROM fb_poster_leads');
            this.db.run('DELETE FROM fb_poster_leads WHERE detected_at < ?', [ms]);
            return before - this.count('SELECT COUNT(*) AS n FROM fb_poster_leads');
        });
    }

    /** Khách + lượt đăng sinh ra bài của khách; `kind`/`outcome` NULL khi khách không gắn với lượt đăng của app. */
    leadReplySource(leadId: number): LeadReplySource | null {
        const row = this.db.queryOne<any>(
            `SELECT l.id, l.post_url, l.author_id, l.variant, r.profile_id AS result_profile_id, r.outcome, u.kind, u.params_json
             FROM fb_poster_leads l
             LEFT JOIN fb_poster_results r ON r.id = l.result_id
             LEFT JOIN fb_poster_runs u ON u.id = r.run_id WHERE l.id = ?`, [leadId]);
        if (!row) return null;
        let params: { text?: unknown; variants?: unknown } = {};
        try { params = JSON.parse(row.params_json ?? '{}') ?? {}; } catch { /* lượt cũ hỏng: không có nội dung bài */ }
        const variants = Array.isArray(params.variants) ? params.variants.filter((v): v is string => typeof v === 'string') : [];
        const text = typeof params.text === 'string' ? params.text : '';
        return {
            leadId: row.id, postUrl: row.post_url, authorId: row.author_id, profileId: row.result_profile_id ?? '',
            fromAppPost: row.kind === 'post' && row.outcome === 'posted',
            postText: variantText({ text, variants }, Math.max(0, VARIANT_LABELS.indexOf(row.variant))),
        };
    }

    /** Có lượt trả lời đang chờ/đang chạy/đã gửi/lỗi/chưa rõ cho khách này hoặc cho cùng người trên cùng bài. */
    hasLeadReply(leadId: number, postUrl: string, authorId: string): boolean {
        const live = "status IN ('queued','running','posted','failed','uncertain')";
        return this.count(`SELECT COUNT(*) AS n FROM fb_poster_lead_replies WHERE ${live} AND (lead_id = ? OR (? <> '' AND post_url = ? AND author_id = ?))`,
            [leadId, authorId, postUrl, authorId]) > 0;
    }

    insertLeadReply(r: { leadId: number; profileId: string; postUrl: string; authorId: string; text: string; reservationId: number | null }, at: number): number {
        return this.db.runInsert(
            `INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, author_id, text, status, reservation_id, created_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`, [r.leadId, r.profileId, r.postUrl, r.authorId, r.text, r.reservationId, at]);
    }

    getLeadReply(id: number): FbPosterLeadReply | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_lead_replies WHERE id = ?', [id]);
        return row ? mapLeadReply(row) : null;
    }

    setLeadReplyStatus(id: number, status: LeadReplyStatus, reason: string, finishedAt: number | null): void {
        this.db.run('UPDATE fb_poster_lead_replies SET status = ?, reason = ?, finished_at = ? WHERE id = ?', [status, reason, finishedAt, id]);
    }

    nextQueuedLeadReply(): FbPosterLeadReply | null {
        const row = this.db.queryOne<any>("SELECT * FROM fb_poster_lead_replies WHERE status = 'queued' ORDER BY id LIMIT 1");
        return row ? mapLeadReply(row) : null;
    }

    /** Khởi động lại: lượt đang chạy dở không biết đã gửi chưa nên giữ chỗ và đánh dấu chưa rõ. */
    markRunningLeadRepliesUncertain(at: number): number {
        return this.db.transaction(() => {
            const n = this.count("SELECT COUNT(*) AS n FROM fb_poster_lead_replies WHERE status = 'running'");
            this.db.run("UPDATE fb_poster_lead_replies SET status = 'uncertain', reason = ?, finished_at = ? WHERE status = 'running'", [INTERRUPTED_REPLY_REASON, at]);
            return n;
        });
    }

    listLeadReplies(limit: number, offset: number): FbPosterLeadReply[] {
        return this.db.query<any>('SELECT * FROM fb_poster_lead_replies ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]).map(mapLeadReply);
    }

    /** Còn hiệu lực = chiếm chỗ của bài (pending/approved/posting/posted/failed/uncertain); rejected/expired/skipped thì nhả bài. */
    hasLiveEngagementPost(profileId: string, postKey: string): boolean {
        return this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE profile_id = ? AND post_key = ? AND status IN ('pending','approved','posting','posted','failed','uncertain')",
            [profileId, postKey]) > 0;
    }

    insertEngagementItem(r: Pick<FbPosterEngagementItem, 'profileId' | 'kind' | 'postUrl' | 'postKey' | 'targetCommentId' | 'targetAuthor' | 'targetExcerpt' | 'postExcerpt' | 'suggestedText' | 'reason' | 'sourceRef'>, at: number, expiresAt: number): number {
        return this.db.runInsert(
            `INSERT INTO fb_poster_engagement_items (profile_id, kind, post_url, post_key, target_comment_id, target_author, target_excerpt, post_excerpt, suggested_text, reason, source_ref, status, suggested_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [r.profileId, r.kind, r.postUrl, r.postKey, r.targetCommentId, r.targetAuthor, r.targetExcerpt, r.postExcerpt, r.suggestedText, r.reason, r.sourceRef, at, expiresAt]);
    }

    getEngagementItem(id: number): FbPosterEngagementItem | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_engagement_items WHERE id = ?', [id]);
        return row ? mapEngagement(row) : null;
    }

    listEngagementItems(f: { status?: EngagementStatus; profileId?: string; limit: number; offset: number }): { total: number; items: FbPosterEngagementItem[] } {
        const where = [f.status ? 'status = ?' : '', f.profileId ? 'profile_id = ?' : ''].filter(Boolean).join(' AND ');
        const params = [f.status, f.profileId].filter((v): v is string => !!v);
        const clause = where ? ` WHERE ${where}` : '';
        return {
            total: this.count(`SELECT COUNT(*) AS n FROM fb_poster_engagement_items${clause}`, params),
            items: this.db.query<any>(`SELECT * FROM fb_poster_engagement_items${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, f.limit, f.offset]).map(mapEngagement),
        };
    }

    /** Gợi ý bình luận trong [from, to): gợi ý theo `suggested_at`, duyệt/bỏ theo `decided_at`, đăng theo `posted_at`, hết hạn theo `expires_at`. */
    engagementCounts(from: number, to: number): { suggested: number; approved: number; posted: number; rejected: number; expired: number } {
        const n = (col: string) => this.count(`SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE ${col} >= ? AND ${col} < ?`, [from, to]);
        return {
            suggested: n('suggested_at'),
            approved: this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE approved_text <> '' AND decided_at >= ? AND decided_at < ?", [from, to]),
            posted: n('posted_at'),
            rejected: this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE status = 'rejected' AND decided_at >= ? AND decided_at < ?", [from, to]),
            expired: this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE status = 'expired' AND expires_at >= ? AND expires_at < ?", [from, to]),
        };
    }

    /** `pending` quá hạn thành `expired`; trả số dòng đổi. */
    expireDueEngagement(now: number): number {
        return this.db.transaction(() => {
            const n = this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE status = 'pending' AND expires_at <= ?", [now]);
            if (n) this.db.run("UPDATE fb_poster_engagement_items SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [now]);
            return n;
        });
    }

    /** Chỉ đổi khi dòng còn `pending`: app duyệt. */
    approveEngagementItem(id: number, approvedText: string, reservationId: number | null, at: number): void {
        this.db.run("UPDATE fb_poster_engagement_items SET status = 'approved', approved_text = ?, reservation_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            [approvedText, reservationId, at, id]);
    }

    /** Chỉ đổi khi dòng còn `pending`: anh bỏ hoặc bot rút. */
    rejectEngagementItem(id: number, reason: string, at: number): void {
        this.db.run("UPDATE fb_poster_engagement_items SET status = 'rejected', reject_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [reason, at, id]);
    }

    /** Gợi ý đã duyệt chờ đăng, theo thứ tự duyệt. */
    listApprovedEngagement(): FbPosterEngagementItem[] {
        return this.db.query<any>("SELECT * FROM fb_poster_engagement_items WHERE status = 'approved' ORDER BY id").map(mapEngagement);
    }

    /** approved -> posting ngay trước khi mở trình duyệt; trả false nếu dòng không còn `approved`. */
    startEngagementPosting(id: number): boolean {
        return this.db.transaction(() => {
            if (!this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE id = ? AND status = 'approved'", [id])) return false;
            this.db.run("UPDATE fb_poster_engagement_items SET status = 'posting' WHERE id = ?", [id]);
            return true;
        });
    }

    /** Anh huỷ (hoặc dừng khẩn) trước khi đăng: chỉ đổi khi dòng còn `approved`; trả false nếu đã sang posting/xong. */
    cancelApprovedEngagement(id: number, reason: string): boolean {
        return this.db.transaction(() => {
            if (!this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE id = ? AND status = 'approved'", [id])) return false;
            this.db.run("UPDATE fb_poster_engagement_items SET status = 'skipped', result_reason = ? WHERE id = ?", [reason, id]);
            return true;
        });
    }

    /** Kết thúc một gợi ý đã duyệt (posted | skipped | failed | uncertain) hoặc trả về `approved` (huỷ trước khi bấm gửi). */
    settleEngagement(id: number, status: EngagementStatus, reason: string, postedAt: number | null): void {
        this.db.run('UPDATE fb_poster_engagement_items SET status = ?, result_reason = ?, posted_at = ? WHERE id = ?', [status, reason, postedAt, id]);
    }

    /** Duyệt xong mà không xếp được job đăng: trả về `pending` như chưa duyệt. */
    revertEngagementToPending(id: number): void {
        this.db.run("UPDATE fb_poster_engagement_items SET status = 'pending', approved_text = '', reservation_id = NULL, decided_at = NULL WHERE id = ? AND status = 'approved'", [id]);
    }

    /** Khởi động lại: dòng `posting` không biết đã gửi chưa nên giữ chỗ và đánh dấu `uncertain`. */
    markPostingEngagementUncertain(): number {
        return this.db.transaction(() => {
            const n = this.count("SELECT COUNT(*) AS n FROM fb_poster_engagement_items WHERE status = 'posting'");
            if (n) this.db.run("UPDATE fb_poster_engagement_items SET status = 'uncertain', result_reason = 'interrupted' WHERE status = 'posting'");
            return n;
        });
    }

    /** Trong các khoá bình luận đã cho, những khoá đã thành khách. */
    leadCommentKeys(keys: string[]): Set<string> {
        const out = new Set<string>();
        for (const part of chunk([...new Set(keys)], IN_CHUNK)) {
            for (const row of this.db.query<{ comment_key: string }>(
                `SELECT comment_key FROM fb_poster_leads WHERE comment_key IN (${part.map(() => '?').join(',')})`, part,
            )) out.add(row.comment_key);
        }
        return out;
    }

    addPostStats(resultId: number, snap: { capturedAt: number; reactions: number | null; comments: number | null; shares: number | null }): void {
        this.db.run(
            'INSERT INTO fb_poster_post_stats (result_id, captured_at, reactions, comments, shares) VALUES (?, ?, ?, ?, ?)',
            [resultId, snap.capturedAt, snap.reactions, snap.comments, snap.shares],
        );
    }

    /**
     * Nội dung gốc đã đăng của từng dòng theo dõi, lấy từ tham số lượt (`fb_poster_runs.params_json`) và nhãn biến thể của dòng.
     * Lượt đã bị xoá hoặc tham số không có `text` thì không có mục (người gọi dùng `textHead`).
     */
    postTexts(rows: Pick<PostTrackingRow, 'resultId' | 'runId' | 'variant'>[]): Map<number, string> {
        const params = new Map<string, any>();
        for (const ids of chunk([...new Set(rows.map((r) => r.runId))], IN_CHUNK)) {
            for (const run of this.db.query<{ id: string; params_json: string }>(`SELECT id, params_json FROM fb_poster_runs WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) {
                try { params.set(run.id, JSON.parse(run.params_json)); } catch { /* tham số hỏng: dùng textHead */ }
            }
        }
        const out = new Map<number, string>();
        for (const row of rows) {
            const p = params.get(row.runId);
            if (!p || typeof p.text !== 'string') continue;
            const text = variantText(p, Math.max(0, VARIANT_LABELS.indexOf(row.variant)));
            if (typeof text === 'string' && text !== '') out.set(row.resultId, text);
        }
        return out;
    }

    /** Lần đo mới nhất của mỗi bài trong `resultIds` (bài chưa đo không có mặt). */
    latestStats(resultIds: number[]): PostStatsSnapshot[] {
        const out: PostStatsSnapshot[] = [];
        for (const ids of chunk(resultIds, IN_CHUNK)) {
            const marks = ids.map(() => '?').join(',');
            out.push(...this.db.query<any>(
                `SELECT s.* FROM fb_poster_post_stats s
                 WHERE s.result_id IN (${marks})
                   AND s.id = (SELECT x.id FROM fb_poster_post_stats x WHERE x.result_id = s.result_id ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)
                 ORDER BY s.result_id`,
                ids,
            ).map(mapPostStats));
        }
        return out.sort((a, b) => a.resultId - b.resultId);
    }

    /** Báo cáo hiệu quả bài đã đăng (spec mục 5). Bài tính theo `posted_at` trong [from, to]. */
    statsReport(opts: { from: number; to: number; groupBy: PostStatsGroupBy; limit: number; campaignId?: string; scheduleId?: string; groupUrl?: string }): PostStatsReportRow[] {
        const where = ['t.posted_at >= ?', 't.posted_at <= ?'];
        const params: any[] = [opts.from, opts.to];
        if (opts.campaignId === '') where.push('t.campaign_id IS NULL');
        else if (opts.campaignId !== undefined) { where.push('t.campaign_id = ?'); params.push(opts.campaignId); }
        if (opts.scheduleId !== undefined) { where.push('t.schedule_id = ?'); params.push(opts.scheduleId); }
        if (opts.groupUrl !== undefined) { where.push('t.group_url = ?'); params.push(opts.groupUrl); }
        // Gom theo nhóm chỉ tính bài nhóm: dòng Page có group_url là trang chủ, không phải một nhóm.
        if (opts.groupBy === 'group') where.push("t.target_kind = 'group'");
        if (opts.groupBy === 'page') where.push("t.target_kind = 'page'");
        const rows = this.db.query<any>(
            `SELECT t.*, sc.name AS schedule_name, cp.name AS campaign_name,
                    (SELECT r.profile_name FROM fb_poster_results r WHERE r.profile_id = t.profile_id ORDER BY r.id DESC LIMIT 1) AS profile_name,
                    COALESCE(
                        (SELECT g.name FROM fb_poster_groups g WHERE g.profile_id = t.profile_id AND g.url = t.group_url),
                        (SELECT g.name FROM fb_poster_groups g WHERE g.url = t.group_url AND g.name <> '' LIMIT 1)
                    ) AS group_name
             FROM fb_poster_post_tracking t LEFT JOIN fb_poster_schedules sc ON sc.id = t.schedule_id
                                         LEFT JOIN fb_poster_campaigns cp ON cp.id = t.campaign_id
             WHERE ${where.join(' AND ')} ORDER BY t.posted_at DESC, t.result_id DESC`,
            params,
        );
        const latest = new Map(this.latestStats(rows.map((r) => r.result_id)).map((x) => [x.resultId, x]));
        const memberCache = new Map<string, number | null>();
        const memberCountOf = (r: any): number | null => {
            const cacheKey = `${r.group_id}\u0000${r.group_url}`;
            if (!memberCache.has(cacheKey)) memberCache.set(cacheKey, this.groupMemberCount(r.group_id, r.group_url));
            return memberCache.get(cacheKey) ?? null;
        };

        const pageNames = opts.groupBy === 'page' ? this.pageNames() : new Map<string, string>();

        const buckets = new Map<string, { row: PostStatsReportRow; rates: number[]; engagement: number; latestAt: number }>();
        for (const r of rows) {
            const [key, label] = ((): [string, string] => {
                switch (opts.groupBy) {
                    case 'group': return [r.group_url, r.group_name || r.group_url];
                    case 'page': return [r.page_id, pageNames.get(r.page_id) || r.page_id || 'Page chưa xác định'];
                    case 'profile': return [r.profile_id, r.profile_name ?? ''];
                    case 'schedule': return [r.schedule_id ?? '', r.schedule_name ?? ''];
                    case 'campaign': return [r.campaign_id ?? '', r.campaign_id === null ? 'Không thuộc chiến dịch' : (r.campaign_name ?? '(chiến dịch đã xoá)')];
                    case 'variant': {
                        const base = r.schedule_id === null ? 'Đăng ngay' : (r.schedule_name ?? '(lịch đã xoá)');
                        return [`${r.schedule_id ?? ''}:${r.variant}`, r.variant === '' ? base : `${base} · ${r.variant}`];
                    }
                    case 'day': return [localDay(r.posted_at), localDay(r.posted_at)];
                    case 'hour': { const hour = String(new Date(r.posted_at).getHours()).padStart(2, '0'); return [hour, `${hour}h`]; }
                    case 'weekday': { const day = new Date(r.posted_at).getDay() || 7; return [String(day), day === 7 ? 'Chủ nhật' : `Thứ ${day + 1}`]; }
                    default: return [String(r.result_id), r.group_name || r.group_url];
                }
            })();
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = {
                    row: { key, label, posts: 0, withLink: 0, pending: 0, notFound: 0, removedSuspected: 0, reactions: 0, comments: 0, shares: 0, measured: 0, insufficient: true, avgEngagement: null, engagementRate: null },
                    rates: [], engagement: 0, latestAt: 0,
                };
                buckets.set(key, bucket);
            }
            const b = bucket.row;
            b.posts++;
            if (r.link_status === 'known') b.withLink++;
            if (r.link_status === 'pending_approval') b.pending++;
            if (r.link_status === 'not_found') b.notFound++;
            if (r.removed_suspected === 1) b.removedSuspected++;
            const snap = latest.get(r.result_id);
            if (snap) {
                b.measured++;
                b.reactions += snap.reactions ?? 0;
                b.comments += snap.comments ?? 0;
                b.shares += snap.shares ?? 0;
                bucket.engagement += engagementOf(snap);
                const members = memberCountOf(r);
                if (members) bucket.rates.push(engagementOf(snap) / members);
            }
            if (opts.groupBy === 'post') {
                b.post = {
                    resultId: r.result_id, postUrl: r.post_url ?? null, groupUrl: r.group_url, text: String(r.text_head).slice(0, 100),
                    postedAt: r.posted_at, linkStatus: r.link_status, snapshots: [],
                };
            }
            if (bucket.latestAt === 0) bucket.latestAt = r.posted_at; // rows đi từ mới đến cũ nên dòng đầu là mới nhất
        }
        // Thứ tự khi cắt `limit` (luôn giữ dữ liệu mới): post/day theo bài mới nhất trước; group/profile/schedule
        // theo số bài giảm dần rồi theo bài mới nhất.
        const ordered = [...buckets.values()];
        if (opts.groupBy === 'group' || opts.groupBy === 'page' || opts.groupBy === 'profile' || opts.groupBy === 'schedule' || opts.groupBy === 'campaign' || opts.groupBy === 'variant') {
            ordered.sort((a, c) => c.row.posts - a.row.posts || c.latestAt - a.latestAt);
        }
        if (opts.groupBy === 'hour' || opts.groupBy === 'weekday') ordered.sort((a, c) => (a.row.key < c.row.key ? -1 : 1));
        const kept = ordered.slice(0, opts.limit);
        if (opts.groupBy === 'post' && kept.length > 0) {
            const history = this.statsHistory(kept.map((k) => k.row.post!.resultId));
            for (const k of kept) k.row.post!.snapshots = history.get(k.row.post!.resultId) ?? [];
        }
        return kept.map(({ row, rates, engagement }) => {
            row.insufficient = row.measured < MIN_MEASURED_FOR_COMPARISON;
            row.avgEngagement = row.measured > 0 ? engagement / row.measured : null;
            // groupBy 'group': trung bình tương tác / số thành viên của chính nhóm đó; khác: trung bình tỉ lệ theo bài.
            row.engagementRate = rates.length > 0 ? rates.reduce((a, c) => a + c, 0) / rates.length : null;
            return row;
        });
    }

    /**
     * Số liệu đầu vào chấm điểm nhóm (spec 26.23 §2.1): lượt đăng từ kết quả chạy (bỏ lỗi do profile) ghép với số liệu theo dõi bài.
     * Nhóm chỉ có ở một phía vẫn có dòng; nhóm chỉ có theo dõi lấy `attempted` = số bài.
     */
    groupScoreInputs(opts: { from: number; to: number; campaignId?: string }): GroupScoreInput[] {
        const where = [
            "r.kind = 'post'", "r.mode = 'group'", 'x.created_at >= ?', 'x.created_at <= ?', "x.outcome IN ('posted', 'failed')",
            "NOT (x.outcome = 'failed' AND x.error_code IN ('not_logged_in', 'launch_failed', 'stopped'))",
        ];
        const params: any[] = [opts.from, opts.to];
        if (opts.campaignId === '') where.push('r.campaign_id IS NULL');
        else if (opts.campaignId !== undefined) { where.push('r.campaign_id = ?'); params.push(opts.campaignId); }
        const attempts = this.db.query<any>(
            `SELECT x.target_url AS url, MAX(x.target_name) AS name, COUNT(*) AS attempted,
                    SUM(CASE WHEN x.outcome = 'posted' THEN 1 ELSE 0 END) AS posted,
                    SUM(CASE WHEN x.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
             FROM fb_poster_results x JOIN fb_poster_runs r ON r.id = x.run_id
             WHERE ${where.join(' AND ')} GROUP BY x.target_url`,
            params,
        );
        const tracked = new Map(this.statsReport({ from: opts.from, to: opts.to, groupBy: 'group', campaignId: opts.campaignId, limit: 100000 }).map((t) => [t.key, t]));
        const out: GroupScoreInput[] = attempts.map((a) => {
            const t = tracked.get(a.url);
            tracked.delete(a.url);
            return {
                groupUrl: a.url, label: t?.label ?? (a.name || a.url), attempted: a.attempted, posted: a.posted, failed: a.failed,
                held: (t?.pending ?? 0) + (t?.notFound ?? 0), removed: t?.removedSuspected ?? 0, withLink: t?.withLink ?? 0,
                measured: t?.measured ?? 0, engagementRate: t?.engagementRate ?? null, avgEngagement: t?.avgEngagement ?? null,
            };
        });
        for (const t of tracked.values()) {
            out.push({
                groupUrl: t.key, label: t.label, attempted: t.posts, posted: t.posts, failed: 0, held: t.pending + t.notFound, removed: t.removedSuspected,
                withLink: t.withLink, measured: t.measured, engagementRate: t.engagementRate, avgEngagement: t.avgEngagement,
            });
        }
        return out;
    }

    /** Mọi lần đo của các bài trong `resultIds`, cũ trước (chia lô 500); bài chưa đo không có mặt. */
    statsHistory(resultIds: number[]): Map<number, PostStatsSnapshot[]> {
        const out = new Map<number, PostStatsSnapshot[]>();
        for (const ids of chunk([...new Set(resultIds)], IN_CHUNK)) {
            const marks = ids.map(() => '?').join(',');
            for (const snap of this.db.query<any>(
                `SELECT * FROM fb_poster_post_stats WHERE result_id IN (${marks}) ORDER BY captured_at, id`, ids,
            )) {
                const list = out.get(snap.result_id) ?? [];
                list.push(mapPostStats(snap));
                out.set(snap.result_id, list);
            }
        }
        return out;
    }

    /** Tên Page đã học theo page_id; bảng danh tính (DailyBriefStore) chưa có thì rỗng. */
    pageNames(): Map<string, string> {
        try {
            return new Map(this.db.query<{ page_id: string; page_name: string }>(
                "SELECT page_id, page_name FROM fb_page_identities WHERE kind = 'page' AND page_id <> '' AND page_name <> ''",
            ).map((r) => [r.page_id, r.page_name]));
        } catch {
            return new Map();
        }
    }

    /** Số thành viên từ mục 'group' mới nhất của Nghiên cứu; bảng không tồn tại hoặc không có mục thì null. */
    private groupMemberCount(groupId: string, groupUrl: string): number | null {
        try {
            const sql = groupId !== ''
                ? "SELECT member_count FROM research_items WHERE kind = 'group' AND fb_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1"
                : "SELECT member_count FROM research_items WHERE kind = 'group' AND url = ? ORDER BY captured_at DESC, id DESC LIMIT 1";
            return this.db.queryOne<{ member_count: number | null }>(sql, [groupId !== '' ? groupId : groupUrl])?.member_count ?? null;
        } catch {
            return null;
        }
    }

    /** Xoá dòng theo dõi có posted_at cũ hơn `ms` cùng các lần đo của chúng. Trả số dòng theo dõi đã xoá. */
    pruneTrackingOlderThan(ms: number): number {
        return this.db.transaction(() => {
            const before = this.count('SELECT COUNT(*) AS n FROM fb_poster_post_tracking');
            this.db.run('DELETE FROM fb_poster_post_stats WHERE result_id IN (SELECT result_id FROM fb_poster_post_tracking WHERE posted_at < ?)', [ms]);
            this.db.run('DELETE FROM fb_poster_post_tracking WHERE posted_at < ?', [ms]);
            return before - this.count('SELECT COUNT(*) AS n FROM fb_poster_post_tracking');
        });
    }

    private count(sql: string, params: any[] = []): number {
        return this.db.queryOne<{ n: number }>(sql, params)?.n ?? 0;
    }
}
