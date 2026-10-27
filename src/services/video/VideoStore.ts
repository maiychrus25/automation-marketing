import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import type { VideoJob, VideoStatus } from '../../models/video';

// Nguồn: docs/specs/2026-10-20-video-studio.md mục 6.2. Chạy lại nhiều lần được (IF NOT EXISTS).
export const VIDEO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS video_jobs (
    id            TEXT PRIMARY KEY,
    remote_id     TEXT,
    name          TEXT NOT NULL,
    source        TEXT NOT NULL,
    template_id   TEXT,
    aspect        TEXT NOT NULL DEFAULT '',
    spec_json     TEXT NOT NULL,
    status        TEXT NOT NULL,
    progress      REAL NOT NULL DEFAULT 0,
    error         TEXT NOT NULL DEFAULT '',
    file_path     TEXT,
    thumb_path    TEXT,
    size_bytes    INTEGER,
    duration_sec  REAL,
    created_at    INTEGER NOT NULL,
    finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status);
`;

// Chạy sau VIDEO_SCHEMA_SQL, từng câu trong try/catch (cột đã có thì ALTER ném lỗi, bỏ qua) — như FB_POSTER_MIGRATIONS.
// 26.31: engine thứ hai (ad_video của AHV AI); DB cũ đọc ra engine 'hyperframes' nên đi đúng nhánh cũ.
export const VIDEO_MIGRATIONS: string[] = [
    "ALTER TABLE video_jobs ADD COLUMN engine TEXT NOT NULL DEFAULT 'hyperframes'",
    "ALTER TABLE video_jobs ADD COLUMN step_text TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE video_jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT ''",
];

const ACTIVE: VideoStatus[] = ['uploading', 'queued', 'rendering'];

const COLUMNS: Record<keyof Omit<VideoJob, 'id'>, string> = {
    remoteId: 'remote_id', name: 'name', source: 'source', engine: 'engine', templateId: 'template_id', aspect: 'aspect',
    specJson: 'spec_json', status: 'status', progress: 'progress', error: 'error', stepText: 'step_text',
    resultJson: 'result_json', filePath: 'file_path',
    thumbPath: 'thumb_path', sizeBytes: 'size_bytes', durationSec: 'duration_sec', createdAt: 'created_at', finishedAt: 'finished_at',
};

function mapJob(row: any): VideoJob {
    return {
        id: row.id, remoteId: row.remote_id ?? null, name: row.name, source: row.source,
        engine: row.engine ?? 'hyperframes', templateId: row.template_id ?? null,
        aspect: row.aspect, specJson: row.spec_json, status: row.status, progress: row.progress, error: row.error,
        stepText: row.step_text ?? '', resultJson: row.result_json ?? '',
        filePath: row.file_path ?? null, thumbPath: row.thumb_path ?? null, sizeBytes: row.size_bytes ?? null,
        durationSec: row.duration_sec ?? null, createdAt: row.created_at, finishedAt: row.finished_at ?? null,
    };
}

export class VideoStore {
    constructor(private readonly db: SqlDatabase) {}

    ensureSchema(): void {
        this.db.exec(VIDEO_SCHEMA_SQL);
        for (const sql of VIDEO_MIGRATIONS) {
            try { this.db.exec(sql); } catch { /* cột đã có */ }
        }
    }

    create(job: VideoJob): void {
        const keys = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];
        this.db.run(
            `INSERT INTO video_jobs (id, ${keys.map((k) => COLUMNS[k]).join(', ')}) VALUES (?${', ?'.repeat(keys.length)})`,
            [job.id, ...keys.map((k) => job[k])],
        );
    }

    get(id: string): VideoJob | null {
        const row = this.db.queryOne<any>('SELECT * FROM video_jobs WHERE id = ?', [id]);
        return row ? mapJob(row) : null;
    }

    update(id: string, patch: Partial<Omit<VideoJob, 'id'>>): void {
        const keys = (Object.keys(patch) as (keyof typeof COLUMNS)[]).filter((k) => k in COLUMNS);
        if (keys.length === 0) return;
        this.db.run(`UPDATE video_jobs SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => patch[k]), id]);
    }

    delete(id: string): void {
        this.db.run('DELETE FROM video_jobs WHERE id = ?', [id]);
    }

    list(opts: { status?: VideoStatus; limit?: number; offset?: number } = {}): { videos: VideoJob[]; total: number } {
        const where = opts.status ? 'WHERE status = ?' : '';
        const args = opts.status ? [opts.status] : [];
        const total = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM video_jobs ${where}`, args)?.n ?? 0;
        const rows = this.db.query<any>(
            `SELECT * FROM video_jobs ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
            [...args, opts.limit ?? 50, opts.offset ?? 0],
        );
        return { videos: rows.map(mapJob), total };
    }

    listActive(): VideoJob[] {
        return this.db
            .query<any>(`SELECT * FROM video_jobs WHERE status IN (${ACTIVE.map(() => '?').join(', ')}) ORDER BY created_at`, ACTIVE)
            .map(mapJob);
    }
}
