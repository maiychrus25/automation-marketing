import { ControlError } from '../control/ControlMethods';
import type { AutonomyLimiter } from '../autonomy/AutonomyLimiter';
import { ENGAGEMENT_STATUSES, type EngagementKind, type EngagementStatus } from '../../models/facebookPoster';
import { commentPostIdentity } from './collectComments';
import { ENGAGEMENT_RESEARCH_SETTING_KEY, ENGAGEMENT_TTL_MS, parseResearchLast, validateEngagementText } from './engagementRules';
import type { FacebookPosterStore } from './FacebookPosterStore';

// Hàng chờ bình luận góp ý: bot chỉ gợi ý/rút/đọc; duyệt và bỏ chỉ có ở đây cho IPC của app (không có trong Control API).

export const REPLY_UNSUPPORTED_ERROR = 'Trả lời bình luận chưa hỗ trợ';
const NOT_FOUND_ERROR = 'Không tìm thấy gợi ý';
const NOT_PENDING_ERROR = 'Gợi ý không còn chờ duyệt';
const EXPIRED_ERROR = 'Gợi ý đã hết hạn';
const DUPLICATE_ERROR = 'Bài này đã có gợi ý còn hiệu lực cho profile';
export const WITHDRAWN_REASON = 'withdrawn_by_bot';
export const CANCELLED_BY_OPERATOR = 'cancelled_by_operator';
export const STOPPED_BY_OPERATOR = 'stopped_by_operator';
const NOT_CANCELLABLE_ERROR = 'Gợi ý không còn chờ đăng (đang đăng hoặc đã xong)';
export const FACEBOOK_URL = /^https:\/\/(?:www\.|m\.|mbasic\.)?facebook\.com\/\S+$/i;
const MAX_URL = 2000;
const MAX_EXCERPT = 500;
const MAX_REASON = 500;
const MAX_REF = 200;
const MAX_REJECT_REASON = 300;
const MAX_LIST = 200;
const MAX_MARK_PROFILES = 100;

export interface EngagementOperationsDeps {
    store: Pick<FacebookPosterStore, 'hasLiveEngagementPost' | 'insertEngagementItem' | 'getEngagementItem' | 'listEngagementItems' | 'expireDueEngagement' | 'approveEngagementItem' | 'rejectEngagementItem' | 'revertEngagementToPending' | 'listApprovedEngagement' | 'cancelApprovedEngagement'>;
    limiter(): { reserve: AutonomyLimiter['reserve']; commit: AutonomyLimiter['commit']; release: AutonomyLimiter['release'] };
    now(): number;
    emit(type: 'engagement.suggested' | 'engagement.decided' | 'engagement.finished', payload: Record<string, unknown>): void;
    profileExists(id: string): boolean;
    /** Xếp job đăng cho gợi ý vừa duyệt (EngagementPoster.enqueue); ném thì duyệt được hoàn lại. */
    enqueuePost(id: number): void;
    /** Sổ lần thử nghiên cứu theo profile (`engagement_research_last` trong app_settings); thiếu thì không ghi. */
    researchLog?: { read(): string | null; write(value: string): void };
    /** Gợi ý đã duyệt vừa bị huỷ: bỏ hẹn giờ đăng của nó (EngagementPoster.forget). */
    onCancelled?(id: number): void;
    /** Chẩn đoán (không kèm nội dung bình luận). */
    log?(message: string): void;
    /** R1: bật khi đã có mẫu DOM trả lời bình luận (Task 5). */
    replySupported?: boolean;
}

const bad = (message: string, field?: string) => new ControlError('INVALID_PARAMS', message, field ? { field } : undefined);

function text(value: unknown, field: string, max: number, required: boolean): string {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || (required && !value.trim())) throw bad(`Thiếu hoặc sai tham số ${field}`, field);
    const trimmed = value.trim();
    if (trimmed.length > max) throw bad(`${field} tối đa ${max} ký tự`, field);
    return trimmed;
}

export function createEngagementOperations(deps: EngagementOperationsDeps) {
    const { store } = deps;
    const markResearchedAt = (profileIds: string[], at: number) => {
        const log = deps.researchLog;
        if (!log) return;
        const last = parseResearchLast(log.read());
        for (const id of profileIds) last[id] = at;
        log.write(JSON.stringify(last));
    };
    const expireDue = () => store.expireDueEngagement(deps.now());
    const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

    /** Sau khi dòng đã sang `skipped`: trả chỗ, bỏ hẹn giờ, báo bot. Lỗi phụ không làm hỏng việc huỷ đã ghi. */
    const afterCancel = (item: { id: number; reservationId: number | null }, reason: string) => {
        try { if (item.reservationId !== null) deps.limiter().release(item.reservationId); } catch (err) { deps.log?.(`engagement ${item.id} release failed: ${errText(err)}`); }
        try { deps.onCancelled?.(item.id); } catch { /* a stale timer only causes a harmless wake-up */ }
        try { deps.emit('engagement.finished', { id: item.id, status: 'skipped', reason }); } catch { /* listener must not undo the cancel */ }
    };

    /** Gợi ý còn `pending` và chưa hết hạn, nếu không thì ném lỗi có mã. */
    function pendingItem(id: number) {
        expireDue();
        const item = Number.isInteger(id) ? store.getEngagementItem(id) : null;
        if (!item) throw new ControlError('NOT_FOUND', NOT_FOUND_ERROR);
        if (item.status === 'expired') throw new ControlError('CONFLICT', EXPIRED_ERROR);
        if (item.status !== 'pending') throw new ControlError('CONFLICT', NOT_PENDING_ERROR);
        return item;
    }

    return {
        expireDue,

        suggest(p: Record<string, any>) {
            const profileId = text(p.profileId, 'profileId', 200, true);
            if (!deps.profileExists(profileId)) throw new ControlError('NOT_FOUND', 'Không tìm thấy profile');
            if (p.kind !== 'comment' && p.kind !== 'reply') throw bad('kind phải là comment hoặc reply', 'kind');
            const kind: EngagementKind = p.kind;
            if (kind === 'reply' && deps.replySupported !== true) throw bad(REPLY_UNSUPPORTED_ERROR, 'kind');
            const postUrl = text(p.postUrl, 'postUrl', MAX_URL, true);
            if (!FACEBOOK_URL.test(postUrl)) throw bad('postUrl phải là link bài trên Facebook', 'postUrl');
            const target = {
                targetCommentId: text(p.targetCommentId, 'targetCommentId', 200, false),
                targetAuthor: text(p.targetAuthor, 'targetAuthor', 200, false),
                targetExcerpt: text(p.targetExcerpt, 'targetExcerpt', MAX_EXCERPT, false),
            };
            if (kind === 'reply' && !target.targetCommentId && !(target.targetAuthor && target.targetExcerpt)) throw bad('Trả lời cần targetCommentId hoặc targetAuthor cùng targetExcerpt', 'targetCommentId');
            const row = {
                profileId, kind, postUrl, postKey: commentPostIdentity(postUrl), ...target,
                postExcerpt: text(p.postExcerpt, 'postExcerpt', MAX_EXCERPT, true),
                suggestedText: validateEngagementText(p.text),
                reason: text(p.reason, 'reason', MAX_REASON, true),
                sourceRef: text(p.sourceRef, 'sourceRef', MAX_REF, false),
            };
            expireDue();
            if (store.hasLiveEngagementPost(profileId, row.postKey)) throw new ControlError('CONFLICT', DUPLICATE_ERROR);
            const limiter = deps.limiter();
            // Gợi ý không có "trước/sau bấm": giữ chỗ rồi commit ngay khi dòng đã vào hàng chờ.
            const reservationId = limiter.reserve({ action: 'engagement_suggest', origin: 'api', profileId });
            const now = deps.now();
            let id: number;
            try {
                id = store.insertEngagementItem(row, now, now + ENGAGEMENT_TTL_MS);
            } catch (err) {
                if (reservationId !== null) limiter.release(reservationId);
                throw err;
            }
            if (reservationId !== null) limiter.commit(reservationId);
            // Sổ nghiên cứu chỉ để giãn nhịp chạy agent: lỗi ghi không được làm hỏng gợi ý đã vào hàng chờ.
            try { markResearchedAt([profileId], now); } catch (err) { deps.log?.(`engagement research log write failed: ${errText(err)}`); }
            deps.emit('engagement.suggested', { id, profileId, kind });
            return { id, status: 'pending' as const, expiresAt: now + ENGAGEMENT_TTL_MS };
        },

        /** Bot báo đã nghiên cứu xong cho các profile (kể cả vòng không gợi ý được gì) để bắt đầu thời gian chờ; profile lạ bị bỏ qua. */
        markResearched(p: Record<string, any>) {
            const ids = p.profileIds;
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_MARK_PROFILES || ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200))
                throw bad(`profileIds phải là danh sách 1–${MAX_MARK_PROFILES} mã profile`, 'profileIds');
            const known = [...new Set<string>(ids)].filter((id) => deps.profileExists(id));
            markResearchedAt(known, deps.now());
            return { marked: known.length };
        },

        list(p: Record<string, any> = {}) {
            if (p.status !== undefined && !ENGAGEMENT_STATUSES.includes(p.status)) throw bad('status không hợp lệ', 'status');
            if (p.profileId !== undefined && typeof p.profileId !== 'string') throw bad('profileId không hợp lệ', 'profileId');
            expireDue();
            const limit = Number.isInteger(p.limit) && p.limit >= 1 ? Math.min(p.limit, MAX_LIST) : 50;
            const offset = Number.isInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
            return store.listEngagementItems({ status: p.status as EngagementStatus | undefined, profileId: p.profileId || undefined, limit, offset });
        },

        /** Bot rút gợi ý còn `pending` của chính nó. */
        withdraw(p: { id: number }) {
            const item = pendingItem(p.id);
            store.rejectEngagementItem(item.id, WITHDRAWN_REASON, deps.now());
            deps.emit('engagement.decided', { id: item.id, decision: 'withdrawn' });
            return { id: item.id, status: 'rejected' as const };
        },

        /** Chỉ app (IPC) gọi; Control API không có đường tới đây. */
        approve(id: number, editedText?: string) {
            const item = pendingItem(id);
            const approvedText = validateEngagementText(editedText ?? item.suggestedText);
            const limiter = deps.limiter();
            const reservationId = limiter.reserve({ action: 'engagement_comment', origin: 'app', profileId: item.profileId, ref: `engagement:${item.id}` }, { capsOnly: true }); // quiet hours / pause are enforced at post time (assertEffect)
            try {
                store.approveEngagementItem(item.id, approvedText, reservationId, deps.now());
            } catch (err) {
                if (reservationId !== null) limiter.release(reservationId);
                throw err;
            }
            try {
                deps.enqueuePost(item.id);
            } catch (err) {
                // Nothing will post it: give the slot back and let the operator approve again.
                store.revertEngagementToPending(item.id);
                if (reservationId !== null) limiter.release(reservationId);
                throw err;
            }
            deps.emit('engagement.decided', { id: item.id, decision: 'approved' });
            return { id: item.id, status: 'approved' as const };
        },

        /** Chỉ app (IPC) gọi: huỷ một gợi ý đã duyệt chưa đăng (`approved`, không phải `posting`). */
        cancel(id: number) {
            const item = Number.isInteger(id) ? store.getEngagementItem(id) : null;
            if (!item) throw new ControlError('NOT_FOUND', NOT_FOUND_ERROR);
            if (!store.cancelApprovedEngagement(item.id, CANCELLED_BY_OPERATOR)) throw new ControlError('CONFLICT', NOT_CANCELLABLE_ERROR);
            afterCancel(item, CANCELLED_BY_OPERATOR);
            return { id: item.id, status: 'skipped' as const };
        },

        /** Dừng khẩn: huỷ mọi gợi ý `approved` chưa đăng; từng dòng lỗi được ghi log rồi bỏ qua. Trả số dòng đã huỷ. */
        cancelAllApproved(reason: string): number {
            let cancelled = 0;
            for (const item of store.listApprovedEngagement()) {
                try {
                    if (!store.cancelApprovedEngagement(item.id, reason)) continue;
                } catch (err) { deps.log?.(`engagement ${item.id} cancel failed: ${errText(err)}`); continue; }
                cancelled += 1;
                afterCancel(item, reason);
            }
            return cancelled;
        },

        /** Chỉ app (IPC) gọi. */
        reject(id: number, reason?: string) {
            const item = pendingItem(id);
            store.rejectEngagementItem(item.id, typeof reason === 'string' ? reason.trim().slice(0, MAX_REJECT_REASON) : '', deps.now());
            deps.emit('engagement.decided', { id: item.id, decision: 'rejected' });
            return { id: item.id, status: 'rejected' as const };
        },
    };
}

export type EngagementOperations = ReturnType<typeof createEngagementOperations>;
