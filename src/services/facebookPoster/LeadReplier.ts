import type { Page } from 'playwright-core';
import type { ProfileTaskContext } from '../browser/ProfileJobQueue';
import type { FbPosterLeadReply } from '../../models/facebookPoster';
import type { AutonomyLimiter } from '../autonomy/AutonomyLimiter';
import { ControlError } from '../control/ControlMethods';
import type { CommentOutcome } from './firstComment';
import type { FacebookPosterStore } from './FacebookPosterStore';

// Trả lời khách đã thu được dưới bài do chính app đăng. Mỗi khách (và mỗi người trên mỗi bài) tối đa một lần, luôn qua bộ giới hạn.
// shortcut: bình luận mới dưới bài, chưa trả lời theo luồng dưới bình luận của khách; nâng cấp khi có mẫu DOM trả lời.

export const MAX_REPLY_LENGTH = 1000;
export const NOT_APP_POST_ERROR = 'Khách không thuộc bài do app đăng';
export const LEAD_NOT_FOUND_ERROR = 'Không tìm thấy khách';
const REPLY_CONFLICT = 'Khách này đã có lượt trả lời';

export interface LeadReplierDeps {
    store: Pick<FacebookPosterStore,
        'leadReplySource' | 'hasLeadReply' | 'insertLeadReply' | 'getLeadReply' | 'setLeadReplyStatus' | 'nextQueuedLeadReply' | 'markRunningLeadRepliesUncertain'>;
    limiter: Pick<AutonomyLimiter, 'reserve' | 'assertEffect' | 'commit' | 'release'>;
    openSession(profileId: string, context: ProfileTaskContext): Promise<{ page: Page; close(): Promise<void> }>;
    postComment(page: Page, input: { postUrl: string; comment: string; text: string }, deps: { getIsStopping(): boolean }): Promise<CommentOutcome>;
    emit(type: 'comments.replied', payload: { replyId: number; leadId: number; status: FbPosterLeadReply['status']; reason: string }): void;
    assertCurrent?: () => void;
    observeLogin?(profileId: string, state: 'logged_out' | 'checkpoint'): void;
    now?: () => number;
}

export class LeadReplier {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private cancelled = false;
    private abort = new AbortController();
    private readonly now: () => number;

    constructor(private readonly deps: LeadReplierDeps) {
        this.now = deps.now ?? Date.now;
    }

    enqueue(input: { leadId: number; text: string }): { replyId: number; status: 'queued' } {
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (text.length < 1 || text.length > MAX_REPLY_LENGTH) throw new Error(`Nội dung trả lời phải dài 1–${MAX_REPLY_LENGTH} ký tự`);
        const source = this.deps.store.leadReplySource(input.leadId);
        if (!source) throw new Error(LEAD_NOT_FOUND_ERROR);
        if (!source.fromAppPost || !source.postUrl || !source.profileId) throw new Error(NOT_APP_POST_ERROR);
        if (this.deps.store.hasLeadReply(source.leadId, source.postUrl, source.authorId)) throw new ControlError('CONFLICT', REPLY_CONFLICT);
        const reservationId = this.deps.limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: source.profileId, ref: `lead:${source.leadId}` });
        let replyId: number;
        try {
            replyId = this.deps.store.insertLeadReply({ leadId: source.leadId, profileId: source.profileId, postUrl: source.postUrl, authorId: source.authorId, text, reservationId }, this.now());
        } catch (err) {
            if (reservationId !== null) this.deps.limiter.release(reservationId);
            throw err;
        }
        this.kick();
        return { replyId, status: 'queued' };
    }

    /** Lúc dựng: lượt đang chạy dở thành "chưa rõ" (giữ chỗ), lượt đang chờ xếp lại. */
    recover(): void {
        if (!this.active) this.deps.store.markRunningLeadRepliesUncertain(this.now()); // an in-flight row of this instance is not a crash leftover
        this.kick();
    }

    cancel(): void {
        this.cancelled = true;
        this.abort.abort();
    }

    isRunning(): boolean { return this.active; }
    whenIdle(): Promise<void> { return this.running; }

    private kick(): void {
        if (this.active) return;
        // A cancel (e.g. a workspace switch that was then aborted) must not park the instance for good: a new drain starts fresh.
        if (this.cancelled) { this.cancelled = false; this.abort = new AbortController(); }
        this.active = true;
        // Deferred so enqueue returns first and the effect-time check really happens later than the reservation.
        this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.active = false; });
    }

    private async drain(): Promise<void> {
        while (!this.cancelled) {
            const next = this.deps.store.nextQueuedLeadReply();
            if (!next) return;
            try {
                await this.process(next);
            } catch {
                // process() settles its own row; anything escaping leaves the row 'running' => 'uncertain' on restart. Stop rather than spin.
                return;
            }
        }
    }

    private settle(reply: FbPosterLeadReply, status: FbPosterLeadReply['status'], reason: string): void {
        this.deps.store.setLeadReplyStatus(reply.id, status, reason, this.now());
        try { this.deps.emit('comments.replied', { replyId: reply.id, leadId: reply.leadId, status, reason }); } catch { /* listener must not break the queue */ }
    }

    private async process(reply: FbPosterLeadReply): Promise<void> {
        const { limiter, store } = this.deps;
        const reservation = reply.reservationId;
        const release = () => { if (reservation !== null) limiter.release(reservation); };
        store.setLeadReplyStatus(reply.id, 'running', '', null);
        try {
            if (reservation !== null) limiter.assertEffect(reservation);
        } catch (err) {
            release();
            return this.settle(reply, 'skipped', err instanceof Error ? err.message : 'Bị bộ giới hạn chặn');
        }
        let opened: Awaited<ReturnType<LeadReplierDeps['openSession']>>;
        try {
            this.deps.assertCurrent?.();
            opened = await this.deps.openSession(reply.profileId, { jobId: `lead-reply-${reply.id}`, signal: this.abort.signal, priority: 'background', assertCurrent: () => this.deps.assertCurrent?.() });
        } catch (err) {
            // Nothing was sent: give the slot back. A cancelled drain goes back to the queue for the next start.
            const code = (err as { code?: unknown })?.code;
            if (code === 'logged_out' || code === 'checkpoint') { try { this.deps.observeLogin?.(reply.profileId, code); } catch { /* quan sát không được làm hỏng hàng đợi */ } }
            if (this.cancelled) { store.setLeadReplyStatus(reply.id, 'queued', '', null); return; }
            release();
            return this.settle(reply, 'skipped', err instanceof Error ? err.message : 'Không mở được profile');
        }
        let outcome: CommentOutcome | null = null;
        try {
            const source = store.leadReplySource(reply.leadId);
            outcome = await this.deps.postComment(opened.page, { postUrl: reply.postUrl, comment: reply.text, text: source?.postText ?? '' }, { getIsStopping: () => this.cancelled });
        } catch {
            outcome = null;
        } finally {
            await opened.close().catch(() => undefined);
        }
        if (!outcome) return this.settle(reply, 'uncertain', 'Không rõ đã gửi hay chưa'); // keeps the slot
        if (outcome.status === 'posted') {
            if (reservation !== null) limiter.commit(reservation);
            return this.settle(reply, 'posted', '');
        }
        if (outcome.status === 'failed') {
            if (reservation !== null) limiter.commit(reservation);
            return this.settle(reply, 'failed', outcome.reason);
        }
        release();
        this.settle(reply, 'skipped', outcome.reason);
    }
}
