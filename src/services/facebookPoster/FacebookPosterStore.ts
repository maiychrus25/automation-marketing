import { FB_POSTER_SCHEMA_SQL } from './schema';
import { keyOf, type CollectedComment } from './collectComments';
import type {
    FbPosterComment, FbPosterGroup, FbPosterKind, FbPosterMode, FbPosterResult, FbPosterRun, FbPosterRunStatus,
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

const INTERRUPTED_RUN_ERROR = 'App đóng khi việc đang chạy';

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
        postUrl: row.post_url ?? null,
        commentStatus: row.comment_status,
        identity: row.identity,
        createdAt: row.created_at,
    };
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
    }

    // ─── Runs ────────────────────────────────────────────────────────────────

    createRun(run: { id: string; kind: FbPosterKind; mode: FbPosterMode | ''; params: Record<string, unknown>; startedAt: number }): void {
        this.db.run(
            `INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
            [run.id, run.kind, run.mode, JSON.stringify(run.params), run.startedAt],
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
                (run_id, profile_id, profile_name, target_url, target_name, outcome, error, post_url, comment_status, identity, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.runId, r.profileId, r.profileName, r.targetUrl, r.targetName, r.outcome, r.error, r.postUrl, r.commentStatus, r.identity, r.createdAt],
        );
    }

    listRuns(opts: { limit: number; offset: number; kind?: FbPosterKind }): { runs: FbPosterRun[]; total: number } {
        const where = opts.kind ? 'WHERE kind = ?' : '';
        const filter = opts.kind ? [opts.kind] : [];
        const rows = this.db.query<any>(
            `SELECT * FROM fb_poster_runs ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`,
            [...filter, opts.limit, opts.offset],
        );
        return { runs: rows.map(mapRun), total: this.count(`SELECT COUNT(*) AS n FROM fb_poster_runs ${where}`, filter) };
    }

    getRun(id: string): { run: FbPosterRun; results: FbPosterResult[] } | null {
        const row = this.db.queryOne<any>('SELECT * FROM fb_poster_runs WHERE id = ?', [id]);
        if (!row) return null;
        const results = this.db.query<any>('SELECT * FROM fb_poster_results WHERE run_id = ? ORDER BY id', [id]);
        return { run: mapRun(row), results: results.map(mapResult) };
    }

    /** Dòng mới nhất của mỗi post_url (bare column đi theo MAX() trong SQLite), mới nhất trước. */
    listPostedUrls(limit: number): { postUrl: string; profileId: string; profileName: string; targetUrl: string; createdAt: number }[] {
        return this.db.query<any>(
            `SELECT post_url, profile_id, profile_name, target_url, MAX(created_at) AS created_at
             FROM fb_poster_results WHERE post_url IS NOT NULL
             GROUP BY post_url ORDER BY created_at DESC LIMIT ?`,
            [limit],
        ).map((row) => ({
            postUrl: row.post_url,
            profileId: row.profile_id,
            profileName: row.profile_name,
            targetUrl: row.target_url,
            createdAt: row.created_at,
        }));
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

    private count(sql: string, params: any[] = []): number {
        return this.db.queryOne<{ n: number }>(sql, params)?.n ?? 0;
    }
}
