import { FB_POSTER_SCHEMA_SQL, FB_POSTER_MIGRATIONS } from './schema';
import { keyOf, type CollectedComment } from './collectComments';
import type {
    FbPosterComment, FbPosterGroup, FbPosterKind, FbPosterMode, FbPosterResult, FbPosterRun, FbPosterRunStatus,
    FbPosterSchedule, FbPosterScheduleView, LoginState, ProfileLoginState,
    LinkStatus, PostStatsGroupBy, PostStatsReportRow, PostStatsSnapshot, PostTrackingRow,
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

const INTERRUPTED_RUN_ERROR = 'App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook.';

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
    };
}

function mapSchedule(row: any): FbPosterSchedule {
    return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        params: JSON.parse(row.params_json),
        runAt: row.run_at ?? null,
        days: row.days === '' ? [] : String(row.days).split(',').map(Number),
        time: row.time,
        enabled: row.enabled === 1,
        draft: row.draft === 1,
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
        profileId: row.profile_id,
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

const engagementOf = (s: PostStatsSnapshot) => (s.reactions ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);

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
        collectedAt: row.collected_at,
    };
}

export class FacebookPosterStore {
    constructor(private readonly db: SqlDatabase) {}

    ensureSchema(): void {
        this.db.exec(FB_POSTER_SCHEMA_SQL);
        for (const sql of FB_POSTER_MIGRATIONS) {
            try { this.db.exec(sql); } catch { /* cột đã có */ }
        }
    }

    // ─── Runs ────────────────────────────────────────────────────────────────

    createRun(run: { id: string; kind: FbPosterKind; mode: FbPosterMode | ''; params: Record<string, unknown>; startedAt: number; scheduleId?: string | null }): void {
        this.db.run(
            `INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
            [run.id, run.kind, run.mode, JSON.stringify(run.params), run.startedAt, run.scheduleId ?? null],
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

    addResult(r: Omit<FbPosterResult, 'id'>): number {
        return this.db.runInsert(
            `INSERT INTO fb_poster_results
                (run_id, profile_id, profile_name, target_url, target_name, outcome, error, error_code, attempts, post_url, comment_status, identity, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.runId, r.profileId, r.profileName, r.targetUrl, r.targetName, r.outcome, r.error, r.errorCode, r.attempts, r.postUrl, r.commentStatus, r.identity, r.createdAt],
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

    createSchedule(s: Omit<FbPosterSchedule, 'lastRunId' | 'updatedAt' | 'draft'> & { draft?: boolean }): void {
        this.db.run(
            `INSERT INTO fb_poster_schedules
                (id, name, kind, params_json, run_at, days, time, enabled, draft, next_run_at, last_run_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [s.id, s.name, s.kind, JSON.stringify(s.params), s.runAt, s.days.join(','), s.time, s.enabled ? 1 : 0, s.draft ? 1 : 0, s.nextRunAt, s.createdAt, s.createdAt],
        );
    }

    getSchedule(id: string): FbPosterSchedule | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_schedules WHERE id = ?', [id]);
        return row ? mapSchedule(row) : null;
    }

    listSchedules(): FbPosterScheduleView[] {
        const rows = this.db.query<any>(
            `SELECT s.*, r.status AS lr_status, r.started_at AS lr_started_at, r.error AS lr_error
             FROM fb_poster_schedules s LEFT JOIN fb_poster_runs r ON r.id = s.last_run_id
             ORDER BY s.enabled DESC, s.next_run_at IS NULL, s.next_run_at, s.created_at`,
        );
        return rows.map((row) => ({
            ...mapSchedule(row),
            lastRun: row.lr_status == null ? null : { status: row.lr_status, startedAt: row.lr_started_at, error: row.lr_error },
        }));
    }

    updateSchedule(
        id: string,
        fields: Partial<Pick<FbPosterSchedule, 'name' | 'enabled' | 'runAt' | 'days' | 'time' | 'nextRunAt' | 'lastRunId' | 'kind' | 'draft' | 'params'>>,
        updatedAt: number,
    ): void {
        const sets: string[] = [];
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
        set('updated_at', updatedAt);
        this.db.run(`UPDATE fb_poster_schedules SET ${sets.join(', ')} WHERE id = ?`, [...values, id]);
    }

    deleteSchedule(id: string): void {
        this.db.run('DELETE FROM fb_poster_schedules WHERE id = ?', [id]);
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
        return new Set(this.db.query<{ key: string }>('SELECT key FROM fb_poster_comments').map((row) => row.key));
    }

    /** Trả số dòng thật sự thêm mới (dòng trùng khoá bị bỏ qua). */
    saveComments(profileId: string, rows: CollectedComment[], collectedAt: number): number {
        return this.db.transaction(() => {
            const before = this.count('SELECT COUNT(*) AS n FROM fb_poster_comments');
            for (const c of rows) {
                this.db.run(
                    `INSERT OR IGNORE INTO fb_poster_comments
                        (key, profile_id, post_url, author_id, author_name, author_url, text, commented_at, collected_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [keyOf(c), profileId, c.postUrl, c.authorId, c.authorName, c.authorUrl, c.text, c.commentedAt, collectedAt],
                );
            }
            return this.count('SELECT COUNT(*) AS n FROM fb_poster_comments') - before;
        });
    }

    listComments(opts: { postUrl?: string; limit: number; offset: number }): { comments: FbPosterComment[]; total: number } {
        const where = opts.postUrl !== undefined ? 'WHERE post_url = ?' : '';
        const filter = opts.postUrl !== undefined ? [opts.postUrl] : [];
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

    createTracking(row: PostTrackingRow): void {
        this.db.run(
            `INSERT OR IGNORE INTO fb_poster_post_tracking
               (result_id, run_id, schedule_id, profile_id, group_url, group_id, post_id, post_url, posted_at, text_head,
                link_status, removed_suspected, last_seen_at, last_checked_at, check_count, next_check_at, stats_done)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.resultId, row.runId, row.scheduleId, row.profileId, row.groupUrl, row.groupId, row.postId, row.postUrl, row.postedAt,
             row.textHead, row.linkStatus, row.removedSuspected ? 1 : 0, row.lastSeenAt, row.lastCheckedAt, row.checkCount,
             row.nextCheckAt, row.statsDone.join(',')],
        );
    }

    listTracking(filter: { linkStatus?: LinkStatus; profileId?: string; groupUrl?: string; sinceMs?: number; limit?: number }): PostTrackingRow[] {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.linkStatus !== undefined) { where.push('link_status = ?'); params.push(filter.linkStatus); }
        if (filter.profileId !== undefined) { where.push('profile_id = ?'); params.push(filter.profileId); }
        if (filter.groupUrl !== undefined) { where.push('group_url = ?'); params.push(filter.groupUrl); }
        if (filter.sinceMs !== undefined) { where.push('posted_at >= ?'); params.push(filter.sinceMs); }
        params.push(filter.limit ?? 1000);
        return this.db.query<any>(
            `SELECT * FROM fb_poster_post_tracking ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY posted_at DESC, result_id DESC LIMIT ?`,
            params,
        ).map(mapTracking);
    }

    /** Các cặp (profile, nhóm) có dòng đến hạn, bài chờ duyệt rồi bài chưa có link đứng trước, rồi theo mốc sớm nhất. */
    listDuePairs(now: number, limit: number): { profileId: string; groupUrl: string }[] {
        return this.db.query<any>(
            `SELECT profile_id, group_url,
                    MIN(CASE link_status WHEN 'pending_approval' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END) AS priority,
                    MIN(next_check_at) AS earliest
             FROM fb_poster_post_tracking
             WHERE next_check_at IS NOT NULL AND next_check_at <= ?
             GROUP BY profile_id, group_url
             ORDER BY priority ASC, earliest ASC, profile_id ASC, group_url ASC LIMIT ?`,
            [now, limit],
        ).map((r) => ({ profileId: r.profile_id, groupUrl: r.group_url }));
    }

    listTrackingForPair(profileId: string, groupUrl: string, sinceMs: number): PostTrackingRow[] {
        return this.db.query<any>(
            'SELECT * FROM fb_poster_post_tracking WHERE profile_id = ? AND group_url = ? AND posted_at >= ? ORDER BY posted_at DESC, result_id DESC',
            [profileId, groupUrl, sinceMs],
        ).map(mapTracking);
    }

    updateTracking(resultId: number, patch: Partial<Omit<PostTrackingRow, 'resultId' | 'runId' | 'scheduleId' | 'profileId' | 'groupUrl' | 'postedAt' | 'textHead'>>): void {
        const sets: string[] = [];
        const params: any[] = [];
        for (const [key, column] of Object.entries(TRACKING_PATCH_COLUMNS)) {
            if (!(key in patch)) continue;
            const value = (patch as Record<string, unknown>)[key];
            sets.push(`${column} = ?`);
            params.push(key === 'removedSuspected' ? (value ? 1 : 0) : key === 'statsDone' ? (value as string[]).join(',') : value);
        }
        if (sets.length === 0) return;
        this.db.run(`UPDATE fb_poster_post_tracking SET ${sets.join(', ')} WHERE result_id = ?`, [...params, resultId]);
    }

    addPostStats(resultId: number, snap: { capturedAt: number; reactions: number | null; comments: number | null; shares: number | null }): void {
        this.db.run(
            'INSERT INTO fb_poster_post_stats (result_id, captured_at, reactions, comments, shares) VALUES (?, ?, ?, ?, ?)',
            [resultId, snap.capturedAt, snap.reactions, snap.comments, snap.shares],
        );
    }

    /** Lần đo mới nhất của mỗi bài trong `resultIds` (bài chưa đo không có mặt). */
    latestStats(resultIds: number[]): PostStatsSnapshot[] {
        if (resultIds.length === 0) return [];
        const marks = resultIds.map(() => '?').join(',');
        return this.db.query<any>(
            `SELECT s.* FROM fb_poster_post_stats s
             WHERE s.result_id IN (${marks})
               AND s.id = (SELECT x.id FROM fb_poster_post_stats x WHERE x.result_id = s.result_id ORDER BY x.captured_at DESC, x.id DESC LIMIT 1)
             ORDER BY s.result_id`,
            resultIds,
        ).map(mapPostStats);
    }

    /** Báo cáo hiệu quả bài đã đăng (spec mục 5). Bài tính theo `posted_at` trong [from, to]. */
    statsReport(opts: { from: number; to: number; groupBy: PostStatsGroupBy; limit: number }): PostStatsReportRow[] {
        const rows = this.db.query<any>(
            `SELECT t.*, sc.name AS schedule_name,
                    (SELECT r.profile_name FROM fb_poster_results r WHERE r.profile_id = t.profile_id ORDER BY r.id DESC LIMIT 1) AS profile_name,
                    (SELECT g.name FROM fb_poster_groups g WHERE g.profile_id = t.profile_id AND g.url = t.group_url) AS group_name
             FROM fb_poster_post_tracking t LEFT JOIN fb_poster_schedules sc ON sc.id = t.schedule_id
             WHERE t.posted_at >= ? AND t.posted_at <= ? ORDER BY t.posted_at, t.result_id`,
            [opts.from, opts.to],
        );
        const latest = new Map(this.latestStats(rows.map((r) => r.result_id)).map((x) => [x.resultId, x]));
        const memberCache = new Map<string, number | null>();
        const memberCountOf = (r: any): number | null => {
            const cacheKey = `${r.group_id}\u0000${r.group_url}`;
            if (!memberCache.has(cacheKey)) memberCache.set(cacheKey, this.groupMemberCount(r.group_id, r.group_url));
            return memberCache.get(cacheKey) ?? null;
        };

        const buckets = new Map<string, { row: PostStatsReportRow; rates: number[]; engagement: number }>();
        for (const r of rows) {
            const [key, label] = ((): [string, string] => {
                switch (opts.groupBy) {
                    case 'group': return [r.group_url, r.group_name || r.group_url];
                    case 'profile': return [r.profile_id, r.profile_name ?? ''];
                    case 'schedule': return [r.schedule_id ?? '', r.schedule_name ?? ''];
                    case 'day': return [localDay(r.posted_at), localDay(r.posted_at)];
                    default: return [String(r.result_id), r.group_name || r.group_url];
                }
            })();
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = {
                    row: { key, label, posts: 0, withLink: 0, pending: 0, notFound: 0, removedSuspected: 0, reactions: 0, comments: 0, shares: 0, measured: 0, avgEngagement: null, engagementRate: null },
                    rates: [], engagement: 0,
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
                    postedAt: r.posted_at, linkStatus: r.link_status,
                    snapshots: this.db.query<any>('SELECT * FROM fb_poster_post_stats WHERE result_id = ? ORDER BY captured_at, id', [r.result_id]).map(mapPostStats),
                };
            }
        }
        return [...buckets.values()].slice(0, opts.limit).map(({ row, rates, engagement }) => {
            row.avgEngagement = row.measured > 0 ? engagement / row.measured : null;
            // groupBy 'group': trung bình tương tác / số thành viên của chính nhóm đó; khác: trung bình tỉ lệ theo bài.
            row.engagementRate = rates.length > 0 ? rates.reduce((a, c) => a + c, 0) / rates.length : null;
            return row;
        });
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
