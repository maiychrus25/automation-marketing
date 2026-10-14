import { randomUUID } from 'crypto';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { generateKey, hashKey } from './controlSecurity';

/** Bảng của Control API; DatabaseService chạy chuỗi này, test chạy trên memoryDb(). */
export const CONTROL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS control_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS control_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  key_name TEXT,
  ip TEXT,
  method TEXT,
  params_summary TEXT,
  ok INTEGER NOT NULL,
  error_code TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_control_audit_at ON control_audit(at);
CREATE TABLE IF NOT EXISTS control_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_idempotency (
  key_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);
`;

/** Cột thêm sau khi bảng đã có (DB cũ); lỗi "cột đã tồn tại" được bỏ qua. Dòng cũ có method '' và không bị coi là xung đột. */
export const CONTROL_MIGRATIONS = [
  `ALTER TABLE control_idempotency ADD COLUMN method TEXT NOT NULL DEFAULT ''`,
];

export const AUDIT_RETENTION_MS = 30 * 86_400_000;
export const EVENT_RETENTION_MS = 7 * 86_400_000;
export const EVENT_MAX_ROWS = 5000;
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export interface ControlKeyInfo {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
}

export interface ControlAuditRow {
    at: number;
    keyName: string | null;
    ip: string | null;
    method: string | null;
    paramsSummary: string | null;
    ok: boolean;
    errorCode: string | null;
    durationMs: number | null;
}

export interface ControlEvent {
    seq: number;
    type: string;
    payload: unknown;
    createdAt: number;
}

export class ControlStore {
    constructor(private readonly db: SqlDatabase) {}

    /** Nơi duy nhất trả khoá thô; DB chỉ giữ SHA-256. */
    createKey(name: string): { id: string; name: string; key: string } {
        const id = randomUUID();
        const key = generateKey();
        this.db.run(
            'INSERT INTO control_keys (id, name, key_hash, created_at) VALUES (?,?,?,?)',
            [id, name, hashKey(key), Date.now()],
        );
        return { id, name, key };
    }

    listKeys(): ControlKeyInfo[] {
        return this.db.query<any>('SELECT id, name, created_at, last_used_at, revoked_at FROM control_keys ORDER BY created_at DESC')
            .map((r) => ({
                id: r.id, name: r.name, createdAt: r.created_at,
                lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null,
            }));
    }

    /** true nếu khoá đang hoạt động đã bị thu hồi bây giờ. */
    revokeKey(id: string): boolean {
        const active = this.db.queryOne<any>('SELECT id FROM control_keys WHERE id = ? AND revoked_at IS NULL', [id]);
        if (!active) return false;
        this.db.run('UPDATE control_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), id]);
        return true;
    }

    findActiveKeyByHash(hash: string): { id: string; name: string } | null {
        const row = this.db.queryOne<any>('SELECT id, name FROM control_keys WHERE key_hash = ? AND revoked_at IS NULL', [hash]);
        return row ? { id: row.id, name: row.name } : null;
    }

    touchKey(id: string, at: number): void {
        this.db.run('UPDATE control_keys SET last_used_at = ? WHERE id = ?', [at, id]);
    }

    addAudit(row: ControlAuditRow): void {
        this.db.run(
            'INSERT INTO control_audit (at, key_name, ip, method, params_summary, ok, error_code, duration_ms) VALUES (?,?,?,?,?,?,?,?)',
            [row.at, row.keyName, row.ip, row.method, row.paramsSummary, row.ok ? 1 : 0, row.errorCode, row.durationMs],
        );
    }

    listAudit(limit: number): ControlAuditRow[] {
        return this.db.query<any>('SELECT * FROM control_audit ORDER BY id DESC LIMIT ?', [limit]).map((r) => ({
            at: r.at, keyName: r.key_name ?? null, ip: r.ip ?? null, method: r.method ?? null,
            paramsSummary: r.params_summary ?? null, ok: r.ok === 1, errorCode: r.error_code ?? null,
            durationMs: r.duration_ms ?? null,
        }));
    }

    addEvent(type: string, payload: unknown): number {
        return this.db.runInsert(
            'INSERT INTO control_events (type, payload, created_at) VALUES (?,?,?)',
            [type, JSON.stringify(payload ?? null), Date.now()],
        );
    }

    listEventsAfter(seq: number, limit: number): ControlEvent[] {
        return this.db.query<any>('SELECT seq, type, payload, created_at FROM control_events WHERE seq > ? ORDER BY seq ASC LIMIT ?', [seq, limit])
            .map((r) => ({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload), createdAt: r.created_at }));
    }

    getIdempotent(keyId: string, idem: string): { result: string; createdAt: number; method: string } | null {
        const row = this.db.queryOne<any>('SELECT result, created_at, method FROM control_idempotency WHERE key_id = ? AND idem_key = ?', [keyId, idem]);
        return row ? { result: row.result, createdAt: row.created_at, method: row.method ?? '' } : null;
    }

    putIdempotent(keyId: string, idem: string, method: string, resultJson: string, now: number): void {
        this.db.run('INSERT OR REPLACE INTO control_idempotency (key_id, idem_key, method, result, created_at) VALUES (?,?,?,?,?)', [keyId, idem, method, resultJson, now]);
    }

    /** Audit > 30 ngày; sự kiện > 7 ngày hoặc ngoài 5000 dòng mới nhất; idempotency > 24 giờ. */
    pruneOld(now: number): void {
        this.db.transaction(() => {
            this.db.run('DELETE FROM control_audit WHERE at < ?', [now - AUDIT_RETENTION_MS]);
            this.db.run('DELETE FROM control_events WHERE created_at < ?', [now - EVENT_RETENTION_MS]);
            this.db.run(
                'DELETE FROM control_events WHERE seq <= (SELECT seq FROM control_events ORDER BY seq DESC LIMIT 1 OFFSET ?)',
                [EVENT_MAX_ROWS],
            );
            this.db.run('DELETE FROM control_idempotency WHERE created_at < ?', [now - IDEMPOTENCY_TTL_MS]);
        });
    }
}
