import { RESEARCH_SCHEMA_SQL } from './schema';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import type {
    ResearchErrorCode, ResearchItem, ResearchItemInput, ResearchOrigin, ResearchQuery,
    ResearchScan, ResearchScanStatus, ResearchSort, ResearchSource,
} from '../../models/research';

const TITLE_MAX = 5000;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
const INTERRUPTED_ERROR = 'App đóng khi lượt quét đang chạy.';

function mapScan(row: any): ResearchScan {
    return {
        id: row.id,
        source: row.source,
        query: row.query,
        params: JSON.parse(row.params_json),
        profileIds: JSON.parse(row.profile_ids),
        details: JSON.parse(row.details_json),
        origin: row.origin,
        status: row.status,
        errorCode: row.error_code,
        error: row.error,
        itemCount: row.item_count,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? null,
    };
}

function mapItem(row: any): ResearchItem {
    const parts = [row.reactions, row.comments, row.shares].filter((v) => v !== null && v !== undefined) as number[];
    const engagement = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
    const members = row.place_members;
    const engagementRate = engagement !== null && typeof members === 'number' && members > 0
        ? Math.round((engagement / members) * 10000) / 10000
        : null;
    return {
        id: row.id,
        scanId: row.scan_id,
        kind: row.kind,
        fbId: row.fb_id,
        url: row.url,
        title: row.title,
        placeKind: row.place_kind,
        placeId: row.place_id,
        placeName: row.place_name,
        authorKind: row.author_kind,
        authorId: row.author_id,
        authorName: row.author_name,
        authorUrl: row.author_url,
        privacy: row.privacy,
        memberCount: row.member_count ?? null,
        followerCount: row.follower_count ?? null,
        reactions: row.reactions ?? null,
        comments: row.comments ?? null,
        shares: row.shares ?? null,
        postedAt: row.posted_at ?? null,
        capturedAt: row.captured_at,
        profileId: row.profile_id,
        engagement,
        engagementRate,
    };
}

function clampLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit) || (limit as number) < 1) return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit as number), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
    return Number.isFinite(offset) && (offset as number) > 0 ? Math.floor(offset as number) : 0;
}

export class ResearchStore {
    constructor(private readonly db: SqlDatabase) {}

    ensureSchema(): void {
        this.db.exec(RESEARCH_SCHEMA_SQL);
    }

    createScan(scan: {
        id: string; source: ResearchSource; query: string; params: Record<string, unknown>;
        profileIds: string[]; origin: ResearchOrigin; startedAt: number;
    }): void {
        this.db.run(
            `INSERT INTO research_scans (id, source, query, params_json, profile_ids, origin, status, started_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
            [scan.id, scan.source, scan.query, JSON.stringify(scan.params), JSON.stringify(scan.profileIds), scan.origin, scan.startedAt],
        );
    }

    updateScanProfiles(id: string, profileIds: string[]): void {
        this.db.run('UPDATE research_scans SET profile_ids = ? WHERE id = ?', [JSON.stringify(profileIds), id]);
    }

    finishScan(
        id: string, status: Exclude<ResearchScanStatus, 'running'>, errorCode: ResearchErrorCode | '',
        error: string, details: Record<string, unknown>, at: number,
    ): void {
        this.db.run(
            `UPDATE research_scans SET status = ?, error_code = ?, error = ?, details_json = ?, finished_at = ?,
                    item_count = (SELECT COUNT(*) FROM research_items WHERE scan_id = ?)
             WHERE id = ?`,
            [status, errorCode, error, JSON.stringify(details ?? {}), at, id, id],
        );
    }

    /** Lưu mục, bỏ trùng theo UNIQUE(scan_id, kind, fb_id). Trả số mục thực sự được thêm. */
    addItems(scanId: string, items: ResearchItemInput[], profileId: string, at: number): number {
        return this.db.transaction(() => {
            let added = 0;
            for (const it of items) {
                const before = this.db.queryOne<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0;
                this.db.run(
                    `INSERT OR IGNORE INTO research_items
                     (scan_id, kind, fb_id, url, title, place_kind, place_id, place_name, author_kind, author_id,
                      author_name, author_url, privacy, member_count, follower_count, reactions, comments, shares,
                      posted_at, captured_at, profile_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        scanId, it.kind, it.fbId, it.url ?? '', (it.title ?? '').slice(0, TITLE_MAX),
                        it.placeKind ?? 'unknown', it.placeId ?? '', it.placeName ?? '',
                        it.authorKind ?? 'unknown', it.authorId ?? '', it.authorName ?? '', it.authorUrl ?? '',
                        it.privacy ?? '', it.memberCount ?? null, it.followerCount ?? null,
                        it.reactions ?? null, it.comments ?? null, it.shares ?? null, it.postedAt ?? null,
                        at, profileId,
                    ],
                );
                const after = this.db.queryOne<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0;
                if (after > before) added++;
            }
            return added;
        });
    }

    listScans(opts: { limit?: number; offset?: number; source?: ResearchSource } = {}): ResearchScan[] {
        const where = opts.source ? 'WHERE source = ?' : '';
        const params: any[] = opts.source ? [opts.source] : [];
        return this.db
            .query<any>(`SELECT * FROM research_scans ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
                [...params, clampLimit(opts.limit), clampOffset(opts.offset)])
            .map(mapScan);
    }

    getScan(id: string): ResearchScan | undefined {
        const row = this.db.queryOne<any>('SELECT * FROM research_scans WHERE id = ?', [id]);
        return row ? mapScan(row) : undefined;
    }

    listItems(scanId: string, opts: { sort?: ResearchSort; limit?: number; offset?: number } = {}): { total: number; items: ResearchItem[] } {
        const sort = opts.sort ?? 'engagement';
        // Tổng engagement (NULL nếu cả ba cột NULL) dùng cho cả ORDER BY lẫn engagementRate.
        const engagementSql = `CASE WHEN i.reactions IS NULL AND i.comments IS NULL AND i.shares IS NULL THEN NULL
                               ELSE COALESCE(i.reactions,0) + COALESCE(i.comments,0) + COALESCE(i.shares,0) END`;
        const order = sort === 'recent'
            ? 'COALESCE(i.posted_at, i.captured_at) DESC, i.id ASC'
            : sort === 'members'
                ? '(i.member_count IS NULL) ASC, i.member_count DESC, i.id ASC'
                : `(${engagementSql} IS NULL) ASC, ${engagementSql} DESC, i.id ASC`;
        const total = this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM research_items WHERE scan_id = ?', [scanId])?.n ?? 0;
        // Số thành viên của nhóm nơi đăng: mục 'group' mới nhất trong các lượt quét 'groups' (idx kind+fb_id).
        const rows = this.db.query<any>(
            `SELECT i.*, (
                 SELECT g.member_count FROM research_items g
                 JOIN research_scans s ON s.id = g.scan_id
                 WHERE g.kind = 'group' AND g.fb_id = i.place_id AND s.source = 'groups'
                 ORDER BY g.captured_at DESC, g.id DESC LIMIT 1
             ) AS place_members
             FROM research_items i WHERE i.scan_id = ?
             ORDER BY ${order} LIMIT ? OFFSET ?`,
            [scanId, clampLimit(opts.limit), clampOffset(opts.offset)],
        );
        return { total, items: rows.map(mapItem) };
    }

    /** Số mục profile đã thu từ mốc `sinceMs` (ms epoch) đến nay. */
    itemsCapturedSince(profileId: string, sinceMs: number): number {
        return this.db.queryOne<{ n: number }>(
            'SELECT COUNT(*) AS n FROM research_items WHERE profile_id = ? AND captured_at >= ?',
            [profileId, sinceMs],
        )?.n ?? 0;
    }

    getQuery(name: string): ResearchQuery | undefined {
        const row = this.db.queryOne<any>('SELECT * FROM research_queries WHERE friendly_name = ?', [name]);
        return row ? { friendlyName: row.friendly_name, docId: row.doc_id, variablesTemplate: row.variables_template, capturedAt: row.captured_at } : undefined;
    }

    saveQuery(name: string, docId: string, template: string, at: number): void {
        this.db.run(
            `INSERT INTO research_queries (friendly_name, doc_id, variables_template, captured_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(friendly_name) DO UPDATE SET doc_id = excluded.doc_id,
                variables_template = excluded.variables_template, captured_at = excluded.captured_at`,
            [name, docId, template, at],
        );
    }

    /** Xoá lượt quét bắt đầu trước `cutoffMs` cùng các mục của nó. Trả số lượt quét bị xoá. */
    pruneOlderThan(cutoffMs: number): number {
        return this.db.transaction(() => {
            const ids = this.db.query<{ id: string }>('SELECT id FROM research_scans WHERE started_at < ?', [cutoffMs]);
            for (const { id } of ids) {
                this.db.run('DELETE FROM research_items WHERE scan_id = ?', [id]);
                this.db.run('DELETE FROM research_scans WHERE id = ?', [id]);
            }
            return ids.length;
        });
    }

    /** Lượt 'running' còn sót khi app tắt đột ngột thì chuyển thành 'failed'. */
    failInterruptedScans(at: number): number {
        const n = this.db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM research_scans WHERE status = 'running'")?.n ?? 0;
        if (n > 0) {
            this.db.run(
                `UPDATE research_scans SET status = 'failed', error = ?, finished_at = ?,
                    item_count = (SELECT COUNT(*) FROM research_items WHERE scan_id = research_scans.id)
                 WHERE status = 'running'`,
                [INTERRUPTED_ERROR, at],
            );
        }
        return n;
    }
}
