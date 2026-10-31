import { randomUUID } from 'crypto';
import type { ApprovalTicket, OwnerUpdate, PageContext, PageResourceOwner, PageResourceRef, PageWork, WorkLease, WorkStep } from '../../models/pageOperations';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { BRIEF_MAX_ATTEMPTS_PER_DAY, BRIEF_STALE_MS, DailyBriefStore, LocalClock, systemClock } from './DailyBriefStore';
import { PageBusinessStore } from './PageBusinessStore';
import { CONTROL_SCHEMA_SQL } from '../control/ControlStore';

export const PAGE_WORK_RETENTION_MS = 30 * 86400000;
const terminal = ['completed', 'failed', 'cancelled'];
const resourceKinds = ['research', 'video', 'draft', 'media', 'campaign'];
type WorkPatch = Partial<Pick<PageWork, 'waitFor' | 'nextCheckAt' | 'reason' | 'evidenceRefs' | 'lastError'>>;

export class PageWorkError extends Error {
    constructor(public readonly code: 'INVALID_PARAMS' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT_EXCEEDED' | 'NEEDS_REVIEW' | 'INTERNAL', message: string) {
        super(message);
        this.name = 'PageWorkError';
    }
}

function requireText(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) throw new PageWorkError('INVALID_PARAMS', 'Thông tin công việc Page không hợp lệ');
}
function requireTime(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PageWorkError('INVALID_PARAMS', 'Mốc thời gian công việc không hợp lệ');
}
function validateResource(resource: PageResourceRef): void {
    if (!resource || !resourceKinds.includes(resource.kind)) throw new PageWorkError('INVALID_PARAMS', 'Loại tài nguyên không hợp lệ');
    requireText(resource.id);
}
function mapWork(row: any): PageWork {
    return {
        id: row.id, workspaceId: row.workspace_id, pageId: row.page_id, profileId: row.profile_id,
        briefDate: row.brief_date, campaignId: row.campaign_id, status: row.status, step: row.step,
        claimedAt: row.claimed_at, attempts: row.attempts, waitFor: row.wait_for, nextCheckAt: row.next_check_at,
        researchId: row.research_id, videoId: row.video_id, draftIds: JSON.parse(row.draft_ids_json),
        reason: row.reason, evidenceRefs: JSON.parse(row.evidence_refs_json), lastError: row.last_error, updatedAt: row.updated_at,
    };
}
function mapStep(row: any): WorkStep {
    return { workId: row.work_id, stepKey: row.step_key, requestHash: row.request_hash, status: row.status,
        resourceKind: row.resource_kind, resourceId: row.resource_id,
        ...(row.result_revision == null ? {} : { resultRevision: row.result_revision }) };
}

/** Workspace-local journal. Live context/receiver authority remain the trusted caller's responsibility. */
export class PageWorkStore {
    constructor(private readonly db: SqlDatabase, private readonly clock: LocalClock = systemClock) {}

    ensureSchema(): void {
        new DailyBriefStore(this.db).ensureSchema();
        new PageBusinessStore(this.db).ensureSchema();
        this.db.exec(CONTROL_SCHEMA_SQL);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS page_work_items (
                id TEXT PRIMARY KEY NOT NULL,
                workspace_id TEXT NOT NULL,
                page_id TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                brief_date TEXT NOT NULL,
                campaign_id TEXT,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'needs_review', 'completed', 'failed', 'cancelled')),
                step TEXT,
                claimed_at INTEGER,
                lease_started_at INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0,
                wait_for TEXT CHECK (wait_for IS NULL OR wait_for = 'video'),
                next_check_at INTEGER,
                research_id TEXT,
                video_id TEXT,
                draft_ids_json TEXT NOT NULL DEFAULT '[]',
                reason TEXT NOT NULL DEFAULT '',
                evidence_refs_json TEXT NOT NULL DEFAULT '[]',
                last_error TEXT,
                updated_at INTEGER NOT NULL,
                UNIQUE(page_id, brief_date),
                CHECK ((status = 'waiting' AND wait_for = 'video' AND video_id IS NOT NULL)
                    OR (status != 'waiting' AND wait_for IS NULL))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS page_work_one_active ON page_work_items(page_id)
                WHERE status IN ('pending', 'running', 'waiting', 'needs_review');
            CREATE TABLE IF NOT EXISTS page_work_steps (
                work_id TEXT NOT NULL,
                step_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('intent', 'succeeded', 'uncertain')),
                resource_kind TEXT,
                resource_id TEXT,
                PRIMARY KEY(work_id, step_key)
            );
            CREATE TABLE IF NOT EXISTS page_work_resources (
                resource_kind TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                page_id TEXT NOT NULL,
                work_id TEXT NOT NULL,
                PRIMARY KEY(resource_kind, resource_id)
            );
            CREATE INDEX IF NOT EXISTS page_work_resources_work ON page_work_resources(work_id);
            CREATE TABLE IF NOT EXISTS page_owner_approvals (
                id TEXT PRIMARY KEY NOT NULL,
                receiver_key_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                page_id TEXT NOT NULL,
                action_json TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                message_id INTEGER,
                expires_at INTEGER NOT NULL,
                consumed_at INTEGER,
                update_id INTEGER,
                update_json TEXT,
                resource_id TEXT,
                UNIQUE(chat_id, sender_id, update_id)
            );
            CREATE TABLE IF NOT EXISTS page_work_daily_usage (
                page_id TEXT NOT NULL,
                usage_date TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                drafts_created INTEGER NOT NULL DEFAULT 0,
                completed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(page_id, usage_date)
            );
        `);
        const columns = this.db.query<{ name: string }>('PRAGMA table_info(page_work_steps)');
        if (!columns.length) throw new PageWorkError('INTERNAL', 'Không đọc được cấu trúc bước công việc');
        if (!columns.some((column) => column.name === 'result_revision'))
            this.db.exec('ALTER TABLE page_work_steps ADD COLUMN result_revision INTEGER');
        // Triggers use this actual connection/transaction, including receiver and recovery writes.
        // Only state transitions and successful draft/business revisions are events, never raw payloads.
        this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS page_work_state_event AFTER UPDATE ON page_work_items
            WHEN NEW.status != OLD.status OR NEW.claimed_at IS NOT OLD.claimed_at
            BEGIN
                INSERT INTO control_events (type, payload, created_at) VALUES ('pageWork.changed',
                    json_object('workId', NEW.id, 'workspaceId', NEW.workspace_id, 'pageId', NEW.page_id, 'status', NEW.status), NEW.updated_at);
            END;
            CREATE TRIGGER IF NOT EXISTS page_work_draft_event AFTER UPDATE ON page_work_steps
            WHEN NEW.status = 'succeeded' AND OLD.status != 'succeeded' AND NEW.resource_kind = 'draft'
            BEGIN
                INSERT INTO control_events (type, payload, created_at)
                    SELECT 'pageWork.draftSaved', json_object('workId', w.id, 'workspaceId', w.workspace_id,
                        'pageId', w.page_id, 'draftId', NEW.resource_id, 'revision', NEW.result_revision), w.updated_at
                    FROM page_work_items w WHERE w.id = NEW.work_id;
            END;
            CREATE TRIGGER IF NOT EXISTS page_work_business_event AFTER UPDATE ON page_business_profiles
            WHEN NEW.revision != OLD.revision
            BEGIN
                INSERT INTO control_events (type, payload, created_at)
                    SELECT 'pageWork.businessChanged', json_object('workId', w.id, 'workspaceId', w.workspace_id,
                        'pageId', w.page_id, 'revision', NEW.revision), NEW.updated_at
                    FROM page_work_items w WHERE w.id = (SELECT id FROM page_work_items WHERE page_id = NEW.page_id ORDER BY rowid DESC LIMIT 1);
            END;
        `);
    }

    /** Only synchronous DB writes belong here; callers must use this same connection. */
    transaction<T>(body: () => T): T { return this.db.transaction(body); }

    /** Private receiver storage, deliberately separate from work/resource views. */
    createApproval(ticket: ApprovalTicket): void {
        this.db.run(`INSERT INTO page_owner_approvals
            (id, receiver_key_id, workspace_id, page_id, action_json, fingerprint, chat_id, sender_id, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ticket.id, ticket.receiverKeyId, ticket.workspaceId, ticket.pageId,
            JSON.stringify(ticket.action), ticket.fingerprint, ticket.chatId, ticket.senderId, ticket.expiresAt]);
        this.changes();
    }

    getApproval(id: string): ApprovalTicket | null {
        const row = this.rows<any>('page_owner_approvals WHERE id = ?', [id])[0];
        return row ? { id: row.id, receiverKeyId: row.receiver_key_id, workspaceId: row.workspace_id, pageId: row.page_id,
            action: JSON.parse(row.action_json), fingerprint: row.fingerprint, chatId: row.chat_id, senderId: row.sender_id,
            messageId: row.message_id, expiresAt: row.expires_at, consumedAt: row.consumed_at,
            update: row.update_json === null ? null : JSON.parse(row.update_json), resourceId: row.resource_id } : null;
    }

    bindApproval(id: string, messageId: number): void {
        this.db.run('UPDATE page_owner_approvals SET message_id = ? WHERE id = ? AND message_id IS NULL AND consumed_at IS NULL', [messageId, id]);
        this.changes();
    }

    approvalForUpdate(update: OwnerUpdate): ApprovalTicket | null {
        const row = this.rows<{ id: string }>('page_owner_approvals WHERE chat_id = ? AND sender_id = ? AND update_id = ?',
            [update.chatId, update.senderId, update.updateId])[0];
        return row ? this.getApproval(row.id) : null;
    }

    consumeApproval(id: string, update: OwnerUpdate, resourceId: string, now: number): void {
        this.db.run(`UPDATE page_owner_approvals SET consumed_at = ?, update_id = ?, update_json = ?, resource_id = ?
            WHERE id = ? AND consumed_at IS NULL`, [now, update.updateId, JSON.stringify(update), resourceId, id]);
        this.changes();
    }

    /** Resume only a quiescent journal with no ambiguous effects; never erase/retry an intent. */
    resumeReviewedWork(workId: string, now: number): PageWork {
        return this.db.transaction(() => {
            const work = this.requireWork(workId);
            if (work.status !== 'needs_review' || this.hasUnresolvedSteps(workId))
                throw new PageWorkError('NEEDS_REVIEW', 'Cần đối soát kết quả trước khi tiếp tục');
            return this.setState(work, 'pending', { lastError: null }, now);
        });
    }

    hasUnresolvedSteps(workId: string): boolean {
        return this.rows<any>("page_work_steps WHERE work_id = ? AND status != 'succeeded'", [workId]).length > 0;
    }

    assertLease(lease: WorkLease, now: number): PageWork {
        requireTime(now);
        return this.requireLease(lease, now);
    }

    getStep(workId: string, stepKey: string): WorkStep | null {
        requireText(workId); requireText(stepKey);
        const row = this.rows<any>('page_work_steps WHERE work_id = ? AND step_key = ?', [workId, stepKey])[0];
        return row ? { ...mapStep(row), resultRevision: row.result_revision ?? null } : null;
    }

    get(id: string): PageWork | null {
        const row = this.rows<any>('page_work_items WHERE id = ?', [id])[0];
        return row ? mapWork(row) : null;
    }

    list(pageIds: string[]): PageWork[] {
        if (!pageIds.length) return [];
        return this.rows<any>(`page_work_items WHERE page_id IN (${pageIds.map(() => '?').join(',')})`, pageIds).map(mapWork);
    }

    reconcileExpiredLease(workId: string, now: number): PageWork {
        requireTime(now);
        return this.db.transaction(() => {
            const work = this.requireWork(workId);
            const row = this.rows<any>('page_work_items WHERE id = ?', [workId])[0];
            if (work.status !== 'running' || now - row.lease_started_at < BRIEF_STALE_MS) return work;
            if (this.hasUnresolvedSteps(workId)) {
                const intents = this.rows<any>("page_work_steps WHERE work_id = ? AND status = 'intent'", [workId]);
                this.db.run("UPDATE page_work_steps SET status = 'uncertain' WHERE work_id = ? AND status = 'intent'", [workId]);
                this.changes(intents.length);
                return this.setState(work, 'needs_review', { lastError: 'Bước trước chưa rõ kết quả, cần đối soát' }, now);
            }
            return this.setState(work, 'pending', {}, now);
        });
    }

    claimDue(context: PageContext, now: number): PageWork | null {
        requireTime(now);
        for (const value of [context.workspaceId, context.pageId, context.profileId]) requireText(value);
        return this.db.transaction(() => {
            const business = this.rows<any>('page_business_profiles WHERE page_id = ?', [context.pageId])[0];
            if (!business || !business.enabled || business.protected_since === null || business.primary_profile_id !== context.profileId) return null;
            const brief = this.rows<any>('daily_briefs WHERE profile_id = ?', [context.profileId])[0];
            if (!brief || !brief.enabled) return null;
            const [hours, minutes] = brief.time.split(':').map(Number);
            if (this.clock.minutes(now) < hours * 60 + minutes) return null;
            const today = this.clock.date(now);
            let row = this.rows<any>("page_work_items WHERE page_id = ? AND status IN ('pending', 'running', 'waiting', 'needs_review')", [context.pageId])[0];
            if (row && (row.workspace_id !== context.workspaceId || row.profile_id !== context.profileId)) return null;
            if (row?.status === 'waiting' || row?.status === 'needs_review' || (row?.next_check_at != null && row.next_check_at > now)) return null;
            if (row?.status === 'running') {
                if (now - row.lease_started_at < BRIEF_STALE_MS) return null;
                if (this.reconcileExpiredLease(row.id, now).status === 'needs_review') return null;
                row = this.rows<any>('page_work_items WHERE id = ?', [row.id])[0];
            }
            const budget = this.dailyUsage(context.pageId, today);
            if (budget.attempts >= BRIEF_MAX_ATTEMPTS_PER_DAY) return null;
            if (!row) {
                if (brief.last_run_date === today || budget.completed > 0 || budget.drafts_created >= brief.drafts_per_day
                    || this.rows<any>('page_work_items WHERE page_id = ? AND brief_date = ?', [context.pageId, today]).length) return null;
                this.db.run(`INSERT INTO page_work_items (id, workspace_id, page_id, profile_id, brief_date, status, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?)`, [randomUUID(), context.workspaceId, context.pageId, context.profileId, today, now]);
                this.changes();
                row = this.rows<any>('page_work_items WHERE page_id = ? AND brief_date = ?', [context.pageId, today])[0];
                if (!row) throw new PageWorkError('INTERNAL', 'Không tạo được công việc Page');
            }
            const token = Math.max(now, (row.claimed_at ?? -1) + 1);
            requireTime(token);
            this.db.run(`UPDATE page_work_items SET status = 'running', claimed_at = ?, lease_started_at = ?,
                attempts = attempts + 1, next_check_at = NULL, updated_at = ? WHERE id = ? AND status = ?`, [token, now, now, row.id, row.status]);
            this.changes();
            this.incrementUsage(context.pageId, today, 'attempts');
            return this.requireWork(row.id);
        });
    }

    beginStep(lease: WorkLease, stepKey: string, requestHash: string, now: number, resource?: PageResourceRef): WorkStep {
        requireText(stepKey); requireText(requestHash); requireTime(now);
        if (resource !== undefined) validateResource(resource);
        return this.db.transaction(() => {
            const work = this.requireLease(lease, now);
            const existing = this.rows<any>('page_work_steps WHERE work_id = ? AND step_key = ?', [work.id, stepKey])[0];
            if (existing) {
                if (existing.request_hash !== requestHash || (resource !== undefined
                    && (existing.resource_kind !== resource.kind || existing.resource_id !== resource.id)))
                    throw new PageWorkError('CONFLICT', 'Nội dung bước công việc đã thay đổi');
                return mapStep(existing);
            }
            if (this.rows<any>("page_work_steps WHERE work_id = ? AND status IN ('intent', 'uncertain')", [work.id]).length)
                throw new PageWorkError('NEEDS_REVIEW', 'Cần đối soát bước trước trước khi tiếp tục');
            this.db.run("INSERT INTO page_work_steps (work_id, step_key, request_hash, status, resource_kind, resource_id) VALUES (?, ?, ?, 'intent', ?, ?)",
                [work.id, stepKey, requestHash, resource?.kind ?? null, resource?.id ?? null]);
            this.changes();
            this.db.run('UPDATE page_work_items SET step = ?, updated_at = ? WHERE id = ?', [stepKey, now, work.id]);
            this.changes();
            const step = this.rows<any>('page_work_steps WHERE work_id = ? AND step_key = ?', [work.id, stepKey])[0];
            if (!step) throw new PageWorkError('INTERNAL', 'Không ghi được ý định công việc');
            return mapStep(step);
        });
    }

    finishStep(lease: WorkLease, stepKey: string, resource: PageResourceRef, now: number, resultRevision?: number): void {
        requireText(stepKey); validateResource(resource); requireTime(now);
        if (resultRevision !== undefined && (resource.kind !== 'draft' || !Number.isSafeInteger(resultRevision) || resultRevision < 1))
            throw new PageWorkError('INVALID_PARAMS', 'Phiên bản kết quả không hợp lệ');
        this.db.transaction(() => {
            const work = this.requireLease(lease, now);
            const step = this.rows<any>('page_work_steps WHERE work_id = ? AND step_key = ?', [work.id, stepKey])[0];
            if (!step || step.status === 'uncertain') throw new PageWorkError('NEEDS_REVIEW', 'Bước công việc cần đối soát');
            if ((step.resource_kind !== null || step.resource_id !== null)
                && (step.resource_kind !== resource.kind || step.resource_id !== resource.id))
                throw new PageWorkError('CONFLICT', 'Bước đã giữ tài nguyên khác');
            if (step.status === 'succeeded') {
                if (resultRevision !== undefined && step.result_revision !== resultRevision)
                    throw new PageWorkError('CONFLICT', 'Bước đã có phiên bản kết quả khác');
                return;
            }
            this.attachResource(work, resource, now);
            this.db.run(`UPDATE page_work_steps SET status = 'succeeded', resource_kind = ?, resource_id = ?, result_revision = ?
                WHERE work_id = ? AND step_key = ? AND status = 'intent'`, [resource.kind, resource.id, resultRevision ?? null, work.id, stepKey]);
            this.changes();
        });
    }

    transition(lease: WorkLease, next: PageWork['status'], patch: WorkPatch, now: number): PageWork {
        requireTime(now);
        return this.db.transaction(() => {
            const work = this.requireLease(lease, now);
            if (!['pending', 'waiting', 'needs_review', ...terminal].includes(next)) throw new PageWorkError('CONFLICT', 'Không thể chuyển trạng thái công việc');
            this.validatePatch(patch);
            const unresolved = this.rows<any>("page_work_steps WHERE work_id = ? AND status IN ('intent', 'uncertain')", [work.id]);
            if (unresolved.length && (next === 'pending' || next === 'waiting' || next === 'completed'))
                throw new PageWorkError('NEEDS_REVIEW', 'Bước chưa rõ kết quả, cần đối soát');
            if (next === 'waiting' && (!work.videoId || patch.waitFor !== 'video')) throw new PageWorkError('CONFLICT', 'Chỉ chờ video đã liên kết');
            if (next === 'completed' && !work.draftIds.length) throw new PageWorkError('CONFLICT', 'Chưa có nháp được lưu và liên kết');
            const saved = this.setState(work, next, patch, now);
            if (next === 'completed') this.incrementUsage(work.pageId, this.clock.date(now), 'completed');
            return saved;
        });
    }

    reconcileVideo(workId: string, videoId: string, status: 'running' | 'completed' | 'failed', now: number): PageWork {
        requireTime(now); requireText(videoId);
        if (!['running', 'completed', 'failed'].includes(status)) throw new PageWorkError('INVALID_PARAMS', 'Trạng thái video không hợp lệ');
        return this.db.transaction(() => {
            const work = this.requireWork(workId);
            if (work.status !== 'waiting' || work.waitFor !== 'video' || work.videoId !== videoId) throw new PageWorkError('CONFLICT', 'Công việc không chờ video này');
            if (status === 'running') return work;
            return this.setState(work, status === 'completed' ? 'pending' : 'needs_review',
                status === 'failed' ? { lastError: 'Video thất bại, cần kiểm tra' } : {}, now);
        });
    }

    /** Trusted context-switch seam; does not cancel an external provider job. */
    invalidateLease(workId: string, now: number): PageWork {
        requireTime(now);
        return this.db.transaction(() => {
            const work = this.requireWork(workId);
            if (work.status !== 'running') return work;
            const intents = this.rows<any>("page_work_steps WHERE work_id = ? AND status = 'intent'", [work.id]);
            this.db.run("UPDATE page_work_steps SET status = 'uncertain' WHERE work_id = ? AND status = 'intent'", [work.id]);
            this.changes(intents.length);
            return this.setState(work, 'needs_review', { lastError: 'Ngữ cảnh Page đã thay đổi, cần kiểm tra' }, now);
        });
    }

    getVideoMediaIds(workId: string, videoId: string): string[] {
        requireText(workId); requireText(videoId);
        return this.rows<{ resource_id: string }>("page_work_steps WHERE work_id = ? AND resource_kind = 'media' AND status = 'succeeded' AND request_hash = ?",
            [workId, videoId]).map(row => row.resource_id);
    }

    /** Video polling is not an agent invocation and may run while the work is waiting. */
    beginMediaAdoption(workId: string, videoId: string, stepKey: string, now: number): void {
        requireText(stepKey); requireTime(now);
        this.db.transaction(() => {
            const work = this.requireWork(workId);
            if (!['running', 'waiting', 'pending'].includes(work.status) || work.videoId !== videoId)
                throw new PageWorkError('CONFLICT', 'Công việc không nhận video này');
            if (this.rows<any>("page_work_steps WHERE work_id = ? AND status != 'succeeded'", [workId]).length)
                throw new PageWorkError('NEEDS_REVIEW', 'Cần đối soát bước trước');
            this.db.run("INSERT INTO page_work_steps (work_id, step_key, request_hash, status, resource_kind) VALUES (?, ?, ?, 'intent', 'media')", [workId, stepKey, videoId]);
            this.changes();
            this.db.run('UPDATE page_work_items SET step = ?, updated_at = ? WHERE id = ?', [stepKey, now, workId]);
            this.changes();
        });
    }

    finishMediaAdoption(workId: string, videoId: string, stepKey: string, mediaId: string, now: number): void {
        requireTime(now);
        this.db.transaction(() => {
            const work = this.requireWork(workId);
            const step = this.getStep(workId, stepKey);
            if (!['running', 'waiting', 'pending'].includes(work.status) || work.videoId !== videoId
                || step?.status !== 'intent' || step.requestHash !== videoId || step.resourceKind !== 'media')
                throw new PageWorkError('CONFLICT', 'Lần nhận video đã hết hiệu lực');
            this.attachResource(work, { kind: 'media', id: mediaId }, now);
            this.db.run('UPDATE page_work_items SET evidence_refs_json = ? WHERE id = ?',
                [JSON.stringify([...new Set([...work.evidenceRefs, `media:${mediaId}`])]), workId]);
            this.changes();
            this.db.run("UPDATE page_work_steps SET status = 'succeeded', resource_id = ? WHERE work_id = ? AND step_key = ? AND status = 'intent'", [mediaId, workId, stepKey]);
            this.changes();
        });
    }

    /** Trusted preparation shutdown only; never changes an approved poster schedule or remote job. */
    stopPreparation(workId: string, status: 'needs_review' | 'cancelled', now: number): PageWork {
        requireTime(now);
        return this.db.transaction(() => {
            const work = this.requireWork(workId);
            if (terminal.includes(work.status)) return work;
            this.db.run("UPDATE page_work_steps SET status = 'uncertain' WHERE work_id = ? AND status = 'intent'", [workId]);
            return this.setState(work, status, { lastError: status === 'needs_review' ? 'Kết quả chưa rõ, cần kiểm tra' : null }, now);
        });
    }

    getResourceOwner(resource: PageResourceRef): PageResourceOwner | null {
        validateResource(resource);
        const row = this.rows<any>('page_work_resources WHERE resource_kind = ? AND resource_id = ?', [resource.kind, resource.id])[0];
        return row ? { workspaceId: row.workspace_id, pageId: row.page_id, workId: row.work_id } : null;
    }

    /** Trusted services only; the actual local save day, not briefDate, is charged for a new draft. */
    linkResource(workId: string, resource: PageResourceRef): void {
        validateResource(resource);
        this.db.transaction(() => this.attachResource(this.requireWork(workId), resource, Date.now()));
    }

    prune(now: number, workspaceId?: string): number {
        requireTime(now);
        if (workspaceId !== undefined) requireText(workspaceId);
        return this.db.transaction(() => {
            const expired = this.rows<any>("page_work_items WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at <= ?"
                + (workspaceId === undefined ? '' : ' AND workspace_id = ?'), [now - PAGE_WORK_RETENTION_MS, ...(workspaceId === undefined ? [] : [workspaceId])]);
            for (const work of expired) {
                const steps = this.rows<any>('page_work_steps WHERE work_id = ?', [work.id]);
                this.db.run('DELETE FROM page_work_steps WHERE work_id = ?', [work.id]);
                this.changes(steps.length);
                this.db.run('DELETE FROM page_work_items WHERE id = ?', [work.id]);
                this.changes();
            }
            // Ownership has no work FK: journal retention must never revoke access to still-live results.
            return expired.length;
        });
    }

    private requireWork(id: string): PageWork {
        const work = this.get(id);
        if (!work) throw new PageWorkError('NOT_FOUND', 'Không tìm thấy công việc Page');
        return work;
    }

    private requireLease(lease: WorkLease, now: number): PageWork {
        requireText(lease.workId); requireTime(lease.claimedAt);
        const row = this.rows<any>('page_work_items WHERE id = ?', [lease.workId])[0];
        if (!row || row.status !== 'running' || row.claimed_at !== lease.claimedAt || now - row.lease_started_at >= BRIEF_STALE_MS)
            throw new PageWorkError('CONFLICT', 'Lượt chạy công việc đã hết hiệu lực');
        const business = this.rows<any>('page_business_profiles WHERE page_id = ?', [row.page_id])[0];
        if (!business || !business.enabled || business.primary_profile_id !== row.profile_id)
            throw new PageWorkError('CONFLICT', 'Ngữ cảnh Page đã thay đổi');
        return mapWork(row);
    }

    private setState(work: PageWork, next: PageWork['status'], patch: WorkPatch, now: number): PageWork {
        this.db.run(`UPDATE page_work_items SET status = ?, wait_for = ?, next_check_at = ?, lease_started_at = NULL,
            reason = ?, evidence_refs_json = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = ? AND claimed_at IS ?`,
        [next, next === 'waiting' ? 'video' : null, ['pending', 'waiting'].includes(next) ? (patch.nextCheckAt ?? null) : null,
            patch.reason ?? work.reason, JSON.stringify([...new Set([...work.evidenceRefs, ...(patch.evidenceRefs ?? [])])]),
            patch.lastError === undefined ? work.lastError : patch.lastError, now, work.id, work.status, work.claimedAt]);
        this.changes();
        return this.requireWork(work.id);
    }

    private attachResource(work: PageWork, resource: PageResourceRef, now: number): void {
        const owner = this.getResourceOwner(resource);
        if (owner) {
            if (owner.workId !== work.id || owner.workspaceId !== work.workspaceId || owner.pageId !== work.pageId)
                throw new PageWorkError('CONFLICT', 'Tài nguyên đã có liên kết khác');
            return;
        }
        if (terminal.includes(work.status)) throw new PageWorkError('CONFLICT', 'Công việc đã kết thúc');
        const singleton = resource.kind === 'research' ? work.researchId : resource.kind === 'video' ? work.videoId
            : resource.kind === 'campaign' ? work.campaignId : null;
        if (singleton && singleton !== resource.id) throw new PageWorkError('CONFLICT', 'Công việc đã có tài nguyên loại này');
        if (resource.kind === 'draft') {
            const brief = this.rows<any>('daily_briefs WHERE profile_id = ?', [work.profileId])[0];
            const budget = this.dailyUsage(work.pageId, this.clock.date(now));
            if (!brief || budget.drafts_created >= brief.drafts_per_day) throw new PageWorkError('LIMIT_EXCEEDED', 'Đã đủ số nháp trong ngày');
        }
        this.db.run(`INSERT INTO page_work_resources (resource_kind, resource_id, workspace_id, page_id, work_id) VALUES (?, ?, ?, ?, ?)`,
            [resource.kind, resource.id, work.workspaceId, work.pageId, work.id]);
        this.changes();
        this.db.run(`UPDATE page_work_items SET campaign_id = ?, research_id = ?, video_id = ?, draft_ids_json = ?, updated_at = ? WHERE id = ?`,
        [resource.kind === 'campaign' ? resource.id : work.campaignId, resource.kind === 'research' ? resource.id : work.researchId,
            resource.kind === 'video' ? resource.id : work.videoId,
            JSON.stringify(resource.kind === 'draft' ? [...work.draftIds, resource.id] : work.draftIds), now, work.id]);
        this.changes();
        if (resource.kind === 'draft') this.incrementUsage(work.pageId, this.clock.date(now), 'drafts_created');
    }

    private validatePatch(patch: WorkPatch): void {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)
            || Object.keys(patch).some((key) => !['waitFor', 'nextCheckAt', 'reason', 'evidenceRefs', 'lastError'].includes(key))
            || (patch.waitFor !== undefined && patch.waitFor !== null && patch.waitFor !== 'video')
            || (patch.reason !== undefined && typeof patch.reason !== 'string')
            || (patch.lastError !== undefined && patch.lastError !== null && typeof patch.lastError !== 'string')
            || (patch.evidenceRefs !== undefined && (!Array.isArray(patch.evidenceRefs) || patch.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim()))))
            throw new PageWorkError('INVALID_PARAMS', 'Thông tin chuyển bước không hợp lệ');
        if (patch.reason !== undefined && patch.reason.length > 1000) throw new PageWorkError('LIMIT_EXCEEDED', 'Lý do vượt giới hạn 1000 ký tự');
        if (patch.nextCheckAt !== undefined && patch.nextCheckAt !== null) requireTime(patch.nextCheckAt);
    }

    private dailyUsage(pageId: string, date: string): { attempts: number; drafts_created: number; completed: number } {
        return this.rows<any>('page_work_daily_usage WHERE page_id = ? AND usage_date = ?', [pageId, date])[0]
            ?? { attempts: 0, drafts_created: 0, completed: 0 };
    }

    private incrementUsage(pageId: string, date: string, column: 'attempts' | 'drafts_created' | 'completed'): void {
        this.db.run(`INSERT INTO page_work_daily_usage (page_id, usage_date, ${column}) VALUES (?, ?, 1)
            ON CONFLICT(page_id, usage_date) DO UPDATE SET ${column} = ${column} + 1`, [pageId, date]);
        this.changes();
    }

    private rows<T>(from: string, params: unknown[] = []): T[] {
        // Production reads may swallow errors; an independent count must agree before accepting an empty result.
        const count = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from}`, params);
        if (!count || !Number.isSafeInteger(count.n) || count.n < 0) throw new PageWorkError('INTERNAL', 'Không đọc được công việc Page');
        const rows = this.db.query<T>(`SELECT * FROM ${from} ORDER BY rowid`, params);
        if (rows.length !== count.n) throw new PageWorkError('INTERNAL', 'Không đọc đủ công việc Page');
        return rows;
    }

    private changes(expected = 1): void {
        const row = this.db.queryOne<{ n: number }>('SELECT changes() AS n');
        if (!row || row.n !== expected) throw new PageWorkError('INTERNAL', 'Không ghi được công việc Page');
    }
}
