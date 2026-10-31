import { randomUUID } from 'crypto';
import { DailyBriefStore } from './DailyBriefStore';
import type { PageBusiness, PageConfirmation, PageFact, PageFactInput } from '../../models/pageOperations';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';

export const PAGE_BUSINESS_MAX_ROWS = 10;
export const PAGE_BUSINESS_MAX_FACTS = 100;
export const PAGE_FACT_MAX_VALUE = 2000;
export const PAGE_FACT_MAX_REASON = 1000;
export const PAGE_FACT_MAX_SOURCE_REF = 500;

export class PageBusinessError extends Error {
    constructor(public readonly code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'INTERNAL', message: string) {
        super(message);
        this.name = 'PageBusinessError';
    }
}

function requireText(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) throw new PageBusinessError('INVALID_PARAMS', 'Thông tin Page không hợp lệ');
}

function requireInteger(value: unknown): void {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PageBusinessError('INVALID_PARAMS', 'Mốc thời gian hoặc phiên bản không hợp lệ');
}

function checkLength(value: string, max: number): void {
    if (value.length > max) throw new PageBusinessError('LIMIT_EXCEEDED', `Thông tin Page vượt giới hạn ${max} ký tự`);
}

function validateConfirmation(confirmation: PageConfirmation): void {
    if (!confirmation) throw new PageBusinessError('INVALID_PARAMS', 'Thiếu thông tin xác nhận của chủ Page');
    requireInteger(confirmation.confirmedAt);
    requireText(confirmation.confirmationRef);
}

function validateFact(input: PageFactInput): void {
    const fields = ['id', 'topic', 'value', 'status', 'sourceType', 'sourceRef', 'reason', 'observedAt'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !fields.includes(key))
        || !['observed', 'hypothesis'].includes(input.status) || !['page', 'research'].includes(input.sourceType)
        || typeof input.reason !== 'string') throw new PageBusinessError('INVALID_PARAMS', 'Đề xuất thông tin Page không hợp lệ');
    if ('id' in input) requireText(input.id);
    requireText(input.topic);
    requireText(input.value);
    requireText(input.sourceRef);
    requireInteger(input.observedAt);
    if (input.status === 'hypothesis') requireText(input.reason);
    checkLength(input.value, PAGE_FACT_MAX_VALUE);
    checkLength(input.reason, PAGE_FACT_MAX_REASON);
    checkLength(input.sourceRef, PAGE_FACT_MAX_SOURCE_REF);
}

function mapFact(row: any): PageFact {
    return {
        id: row.id, topic: row.topic, value: row.value, status: row.status, sourceType: row.source_type,
        sourceRef: row.source_ref, reason: row.reason, observedAt: row.observed_at, updatedAt: row.updated_at,
        confirmedAt: row.confirmed_at, confirmationRef: row.confirmation_ref,
    };
}

/** Workspace-local storage; callers enforce live Page identity, source eligibility and receiver authority. */
export class PageBusinessStore {
    constructor(private readonly db: SqlDatabase) {}

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS page_business_profiles (
                page_id TEXT PRIMARY KEY NOT NULL,
                primary_profile_id TEXT,
                revision INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                protected_since INTEGER
            );
            CREATE TABLE IF NOT EXISTS page_business_facts (
                id TEXT PRIMARY KEY NOT NULL,
                page_id TEXT NOT NULL REFERENCES page_business_profiles(page_id),
                topic TEXT NOT NULL,
                value TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('observed', 'hypothesis', 'confirmed')),
                source_type TEXT NOT NULL CHECK (source_type IN ('page', 'research', 'owner')),
                source_ref TEXT NOT NULL,
                reason TEXT NOT NULL,
                observed_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                confirmed_at INTEGER,
                confirmation_ref TEXT
            );
            CREATE INDEX IF NOT EXISTS page_business_facts_page ON page_business_facts(page_id);
        `);
    }

    get(pageId: string): PageBusiness | null {
        const row = this.db.queryOne<any>(`SELECT p.*,
            (SELECT COUNT(*) FROM page_business_facts f WHERE f.page_id = p.page_id) AS fact_count
            FROM page_business_profiles p WHERE page_id = ?`, [pageId]);
        if (!row) return null;
        const facts = this.db.query<any>('SELECT * FROM page_business_facts WHERE page_id = ? ORDER BY rowid', [pageId]).map(mapFact);
        if (facts.length !== row.fact_count) throw new PageBusinessError('INTERNAL', 'Không đọc đủ thông tin Page');
        return {
            pageId: row.page_id, primaryProfileId: row.primary_profile_id, revision: row.revision,
            updatedAt: row.updated_at, enabled: row.enabled === 1, protectedSince: row.protected_since, facts,
        };
    }

    list(): PageBusiness[] {
        const count = this.countProfiles();
        const rows = this.db.query<{ page_id: string }>('SELECT page_id FROM page_business_profiles ORDER BY page_id');
        if (rows.length !== count) throw new PageBusinessError('INTERNAL', 'Không đọc đủ hồ sơ Page');
        return rows.map((row) => this.requireBusiness(row.page_id));
    }

    ensure(pageId: string, primaryProfileId: string | null, now: number): PageBusiness {
        requireText(pageId);
        if (primaryProfileId !== null) requireText(primaryProfileId);
        requireInteger(now);
        return this.db.transaction(() => {
            const current = this.get(pageId);
            if (current) return current;
            if (this.countProfiles() >= PAGE_BUSINESS_MAX_ROWS) throw new PageBusinessError('LIMIT_EXCEEDED', 'Tối đa 10 hồ sơ kinh doanh Page');
            this.db.run('INSERT INTO page_business_profiles (page_id, primary_profile_id, updated_at) VALUES (?, ?, ?)',
                [pageId, primaryProfileId, now]);
            this.requireChange();
            return this.requireBusiness(pageId);
        });
    }

    propose(pageId: string, input: PageFactInput, expectedRevision: number, now: number): PageBusiness {
        validateFact(input);
        return this.mutate(pageId, expectedRevision, now, (business) => {
            if (input.id !== undefined) {
                const fact = this.requireFact(business, input.id);
                this.requireUnconfirmed(fact);
                this.db.run(`UPDATE page_business_facts SET topic = ?, value = ?, status = ?, source_type = ?,
                    source_ref = ?, reason = ?, observed_at = ?, updated_at = ? WHERE id = ? AND page_id = ? AND status != 'confirmed'`,
                [input.topic, input.value, input.status, input.sourceType, input.sourceRef, input.reason,
                    input.observedAt, now, input.id, pageId]);
            } else {
                if (business.facts.length >= PAGE_BUSINESS_MAX_FACTS) throw new PageBusinessError('LIMIT_EXCEEDED', 'Tối đa 100 thông tin mỗi hồ sơ Page');
                this.db.run(`INSERT INTO page_business_facts
                    (id, page_id, topic, value, status, source_type, source_ref, reason, observed_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [randomUUID(), pageId, input.topic, input.value, input.status, input.sourceType, input.sourceRef,
                    input.reason, input.observedAt, now]);
            }
            this.requireChange();
        });
    }

    // These operations are for the trusted receiver path, never runner methods.
    createOwnerFact(pageId: string, input: { topic: string; value: string; reason: string }, expectedRevision: number, confirmation: PageConfirmation): PageBusiness {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['topic', 'value', 'reason'].includes(key)) || typeof input.reason !== 'string')
            throw new PageBusinessError('INVALID_PARAMS', 'Thông tin chủ Page không hợp lệ');
        requireText(input.topic);
        requireText(input.value);
        validateConfirmation(confirmation);
        checkLength(input.value, PAGE_FACT_MAX_VALUE);
        checkLength(input.reason, PAGE_FACT_MAX_REASON);
        checkLength(confirmation.confirmationRef, PAGE_FACT_MAX_SOURCE_REF);
        return this.mutate(pageId, expectedRevision, confirmation.confirmedAt, business => {
            if (business.facts.length >= PAGE_BUSINESS_MAX_FACTS) throw new PageBusinessError('LIMIT_EXCEEDED', 'Tối đa 100 thông tin mỗi hồ sơ Page');
            this.db.run(`INSERT INTO page_business_facts
                (id, page_id, topic, value, status, source_type, source_ref, reason, observed_at, updated_at, confirmed_at, confirmation_ref)
                VALUES (?, ?, ?, ?, 'confirmed', 'owner', ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), pageId, input.topic, input.value, confirmation.confirmationRef, input.reason,
                confirmation.confirmedAt, confirmation.confirmedAt, confirmation.confirmedAt, confirmation.confirmationRef]);
            this.requireChange();
        });
    }

    confirmFact(pageId: string, factId: string, expectedRevision: number, confirmation: PageConfirmation): PageBusiness {
        requireText(factId);
        validateConfirmation(confirmation);
        return this.mutate(pageId, expectedRevision, confirmation.confirmedAt, (business) => {
            this.requireUnconfirmed(this.requireFact(business, factId));
            this.db.run(`UPDATE page_business_facts SET status = 'confirmed', confirmed_at = ?, confirmation_ref = ?, updated_at = ?
                WHERE id = ? AND page_id = ? AND status != 'confirmed'`,
            [confirmation.confirmedAt, confirmation.confirmationRef, confirmation.confirmedAt, factId, pageId]);
            this.requireChange();
        });
    }

    setPrimaryProfile(pageId: string, profileId: string, expectedRevision: number, confirmation: PageConfirmation): PageBusiness {
        requireText(profileId);
        validateConfirmation(confirmation);
        return this.mutate(pageId, expectedRevision, confirmation.confirmedAt, (business) => {
            if (business.protectedSince !== null) this.protectBriefs(pageId, profileId);
            business.primaryProfileId = profileId;
        });
    }

    setEnabled(pageId: string, enabled: boolean, expectedRevision: number, confirmation: PageConfirmation): PageBusiness {
        if (typeof enabled !== 'boolean') throw new PageBusinessError('INVALID_PARAMS', 'Trạng thái bật Page không hợp lệ');
        validateConfirmation(confirmation);
        return this.mutate(pageId, expectedRevision, confirmation.confirmedAt, (business) => {
            business.enabled = enabled;
            if (enabled && business.protectedSince === null) {
                if (!business.primaryProfileId) throw new PageBusinessError('CONFLICT', 'Cần chọn hồ sơ chính trước khi bật Page');
                this.protectBriefs(pageId, business.primaryProfileId);
                business.protectedSince = confirmation.confirmedAt;
            }
        });
    }

    private protectBriefs(pageId: string, profileId: string): void {
        // Same DB transaction as the metadata CAS: legacy claims cannot race a protected handoff.
        new DailyBriefStore(this.db).ensureSchema();
        const associated = `SELECT profile_id FROM fb_page_identities WHERE page_id = ? AND kind = 'page'
            UNION SELECT ? AS profile_id`;
        const params = [pageId, profileId];
        const busy = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM daily_briefs
            WHERE status != 'idle' AND profile_id IN (${associated})`, params);
        if (!busy || !Number.isSafeInteger(busy.n)) throw new PageBusinessError('INTERNAL', 'Không kiểm tra được lượt chạy cũ');
        if (busy.n !== 0) throw new PageBusinessError('CONFLICT', 'Cần chờ kế hoạch Page cũ kết thúc trước khi bật');
        const conflicting = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM page_brief_handoffs
            WHERE page_id != ? AND profile_id IN (${associated})`, [pageId, ...params]);
        if (!conflicting) throw new PageBusinessError('INTERNAL', 'Không kiểm tra được chuyển giao Page');
        if (conflicting.n !== 0) throw new PageBusinessError('CONFLICT', 'Hồ sơ đã chuyển giao cho Page khác');
        this.db.run(`INSERT INTO page_brief_handoffs (profile_id, page_id)
            SELECT profile_id, ? FROM (${associated}) WHERE 1 ON CONFLICT(profile_id) DO NOTHING`, [pageId, ...params]);
        const missing = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM (${associated}) a
            WHERE NOT EXISTS (SELECT 1 FROM page_brief_handoffs h WHERE h.profile_id = a.profile_id AND h.page_id = ?)`, [...params, pageId]);
        if (!missing || missing.n !== 0) throw new PageBusinessError('INTERNAL', 'Không ghi đủ chuyển giao Page');
    }

    private mutate(pageId: string, expectedRevision: number, now: number, write: (business: PageBusiness) => void): PageBusiness {
        requireText(pageId);
        requireInteger(expectedRevision);
        requireInteger(now);
        return this.db.transaction(() => {
            const business = this.requireBusiness(pageId);
            if (business.revision !== expectedRevision) throw new PageBusinessError('CONFLICT', 'Hồ sơ Page đã thay đổi, cần đọc lại');
            write(business);
            this.db.run(`UPDATE page_business_profiles SET primary_profile_id = ?, enabled = ?, protected_since = ?,
                revision = revision + 1, updated_at = ? WHERE page_id = ? AND revision = ?`,
            [business.primaryProfileId, business.enabled ? 1 : 0, business.protectedSince, now, pageId, expectedRevision]);
            this.requireChange();
            const saved = this.requireBusiness(pageId);
            if (saved.revision !== expectedRevision + 1) throw new PageBusinessError('INTERNAL', 'Không ghi được hồ sơ Page');
            return saved;
        });
    }

    private countProfiles(): number {
        const row = this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM page_business_profiles');
        if (!row || !Number.isSafeInteger(row.n) || row.n < 0) throw new PageBusinessError('INTERNAL', 'Không đếm được hồ sơ Page');
        return row.n;
    }

    private requireBusiness(pageId: string): PageBusiness {
        const business = this.get(pageId);
        if (!business) throw new PageBusinessError('NOT_FOUND', 'Không tìm thấy hồ sơ Page');
        return business;
    }

    private requireFact(business: PageBusiness, factId: string): PageFact {
        const fact = business.facts.find((item) => item.id === factId);
        if (!fact) throw new PageBusinessError('NOT_FOUND', 'Không tìm thấy thông tin Page');
        return fact;
    }

    private requireUnconfirmed(fact: PageFact): void {
        if (fact.status === 'confirmed') throw new PageBusinessError('CONFLICT', 'Thông tin đã xác nhận không được ghi đè, hãy tạo đề xuất mới');
    }

    private requireChange(): void {
        // DatabaseService swallows read errors; missing changes() must roll back, never imply success.
        const row = this.db.queryOne<{ n: number }>('SELECT changes() AS n');
        if (!row || row.n !== 1) throw new PageBusinessError('INTERNAL', 'Không ghi được thông tin Page');
    }
}
