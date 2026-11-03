import type { Page } from 'playwright-core';
import type { ProfileTaskContext } from '../browser/ProfileJobQueue';
import type { EngagementStatus, FbPosterEngagementItem } from '../../models/facebookPoster';
import type { AutonomyLimiter } from '../autonomy/AutonomyLimiter';
import type { CommentOutcome } from './firstComment';
import type { ReplyOutcome, ReplyTarget } from './commentReply';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { ENGAGEMENT_TTL_MS } from './engagementRules';
import { STOPPED_BY_OPERATOR } from './engagementOperations';

// Đăng đúng câu anh đã duyệt: bình luận mới dưới bài (`comment`) hoặc trả lời một bình luận (`reply`) (spec 2026-11-02 §3 bước 5–6, §8).
// Không thử lại sau khi đã bấm gửi.

export const EXPIRED_AFTER_APPROVAL = 'expired_after_approval';
export const NOT_SENT = 'not_sent';

export interface EngagementPosterDeps {
    store: Pick<FacebookPosterStore, 'listApprovedEngagement' | 'getEngagementItem' | 'startEngagementPosting' | 'settleEngagement' | 'markPostingEngagementUncertain'>;
    limiter: Pick<AutonomyLimiter, 'assertEffect' | 'commit' | 'release'>;
    openSession(profileId: string, context: ProfileTaskContext): Promise<{ page: Page; close(): Promise<void> }>;
    postComment(page: Page, input: { postUrl: string; comment: string; text: string }, deps: { getIsStopping(): boolean }): Promise<CommentOutcome>;
    postReply(page: Page, input: { postUrl: string; target: ReplyTarget; text: string }, deps: { getIsStopping(): boolean }): Promise<ReplyOutcome>;
    emit(type: 'engagement.finished', payload: { id: number; status: string; reason: string }): void;
    assertCurrent?: () => void;
    /** Mốc dừng khẩn gần nhất (epoch ms, 0 nếu chưa dừng): dòng duyệt trước/đúng mốc thì không đăng. */
    stopEpoch?(): number;
    observeLogin?(profileId: string, state: 'logged_out' | 'checkpoint'): void;
    now?: () => number;
    /** Chẩn đoán (không kèm nội dung bình luận). */
    log?: (message: string) => void;
    /** Hẹn giờ một lần, trả hàm huỷ. Mặc định setTimeout không giữ tiến trình. */
    schedule?: (fn: () => void, ms: number) => () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
}

export class EngagementPoster {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private cancelled = false;
    private abort = new AbortController();
    private readonly now: () => number;
    /** id -> thời điểm được thử lại (giờ im lặng); dòng vẫn `approved`. */
    private readonly deferred = new Map<number, number>();
    private timer: { at: number; cancel: () => void } | null = null;

    constructor(private readonly deps: EngagementPosterDeps) {
        this.now = deps.now ?? Date.now;
    }

    enqueue(_id: number): void { this.kick(); }

    /** Lúc dựng: dòng `posting` dở thành `uncertain` (giữ chỗ), dòng `approved` được xếp lại. */
    recover(): void {
        if (!this.active) this.deps.store.markPostingEngagementUncertain(); // an in-flight row of this instance is not a crash leftover
        this.kick();
    }

    cancel(): void {
        this.cancelled = true;
        this.abort.abort();
        this.clearTimer();
        this.deferred.clear(); // the next kick re-evaluates via assertEffect and re-defers
    }

    /** Gợi ý đã bị huỷ ở nơi khác: bỏ hẹn giờ của nó. */
    forget(id: number): void {
        if (!this.deferred.delete(id)) return;
        if (!this.active) this.rearm(); // a running drain re-arms when it ends
    }

    isRunning(): boolean { return this.active; }
    whenIdle(): Promise<void> { return this.running; }

    private clearTimer(): void { this.timer?.cancel(); this.timer = null; }

    private kick(): void {
        if (this.active) return;
        // A cancel (e.g. an aborted workspace switch) must not park the instance for good: a new drain starts fresh.
        if (this.cancelled) { this.cancelled = false; this.abort = new AbortController(); }
        this.active = true;
        this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.active = false; });
    }

    private defer(id: number, retryAt: number): void { this.deferred.set(id, retryAt); }

    /** One timer for the earliest remaining deferral; called when a drain ends. */
    private rearm(): void {
        this.clearTimer();
        if (this.cancelled || this.deferred.size === 0) return;
        const at = Math.min(...this.deferred.values());
        const cancel = (this.deps.schedule ?? defaultSchedule)(() => { this.timer = null; this.kick(); }, Math.max(0, at - this.now()));
        this.timer = { at, cancel };
    }

    private async drain(): Promise<void> {
        try { await this.drainLoop(); } finally { this.rearm(); }
    }

    private async drainLoop(): Promise<void> {
        while (!this.cancelled) {
            const next = this.deps.store.listApprovedEngagement().find((item) => (this.deferred.get(item.id) ?? 0) <= this.now());
            if (!next) return;
            this.deferred.delete(next.id);
            try {
                await this.process(next);
            } catch (err) {
                // process() settles its own row; anything escaping leaves it 'posting' => 'uncertain' on restart. Stop rather than spin.
                this.deps.log?.(`engagement ${next.id} stopped the queue: ${err instanceof Error ? err.message : 'unknown error'}`);
                return;
            }
        }
    }

    private settle(item: FbPosterEngagementItem, status: EngagementStatus, reason: string, code: string, postedAt: number | null = null): void {
        this.deps.store.settleEngagement(item.id, status, reason, postedAt);
        try { this.deps.emit('engagement.finished', { id: item.id, status, reason: code }); } catch { /* listener must not break the queue */ }
    }

    private async process(first: FbPosterEngagementItem): Promise<void> {
        const { limiter, store } = this.deps;
        const item = store.getEngagementItem(first.id);
        if (!item || item.status !== 'approved') return;
        const reservation = item.reservationId;
        const release = () => { if (reservation !== null) limiter.release(reservation); };
        const deadline = (item.decidedAt ?? item.suggestedAt) + ENGAGEMENT_TTL_MS;
        const expire = () => { release(); this.settle(item, 'skipped', EXPIRED_AFTER_APPROVAL, EXPIRED_AFTER_APPROVAL); };
        /** Hết hạn hoặc bị gate chặn: đã hoãn / hết hạn / bỏ qua, trả true. `posting` là dòng đã chuyển sang posting. */
        const refused = (posting: boolean): boolean => {
            // Same-ms tie counts as approved before the stop (fail-safe).
            if (item.decidedAt !== null && item.decidedAt <= (this.deps.stopEpoch?.() ?? 0)) { release(); this.settle(item, 'skipped', STOPPED_BY_OPERATOR, STOPPED_BY_OPERATOR); return true; }
            if (this.now() >= deadline) { expire(); return true; }
            try {
                if (reservation !== null) limiter.assertEffect(reservation);
                return false;
            } catch (err) {
                const details = (err as { details?: { reason?: string; retryAt?: number | null } })?.details;
                // Quiet hours or the posting-day comment cap: wait while still inside the 24h window.
                if (details?.reason === 'quiet_hours' || details?.reason === 'quota') {
                    if (typeof details.retryAt === 'number' && details.retryAt < deadline) {
                        if (posting) store.settleEngagement(item.id, 'approved', '', null);
                        this.defer(item.id, details.retryAt);
                    } else expire();
                    return true;
                }
                release();
                const code = details?.reason ?? 'blocked';
                this.settle(item, 'skipped', code, code);
                return true;
            }
        };
        if (this.now() >= deadline) return expire();
        if (refused(false)) return;
        if (!store.startEngagementPosting(item.id)) return;
        let opened: Awaited<ReturnType<EngagementPosterDeps['openSession']>>;
        try {
            this.deps.assertCurrent?.();
            opened = await this.deps.openSession(item.profileId, { jobId: `engagement-${item.id}`, signal: this.abort.signal, priority: 'background', assertCurrent: () => this.deps.assertCurrent?.() });
        } catch (err) {
            // Nothing was sent: a cancelled drain goes back to the queue, otherwise the slot is returned.
            const code = (err as { code?: unknown })?.code;
            if (code === 'logged_out' || code === 'checkpoint') { try { this.deps.observeLogin?.(item.profileId, code); } catch { /* observing must not break the queue */ } }
            if (this.cancelled) { store.settleEngagement(item.id, 'approved', '', null); return; }
            release();
            return this.settle(item, 'skipped', err instanceof Error ? err.message : 'Không mở được profile', 'session_unavailable');
        }
        // The profile slot can be freed hours later: re-check the 24h window, quiet hours and pause before posting.
        let blocked = true;
        try { blocked = refused(true); } finally { if (blocked) await opened.close().catch(() => undefined); }
        if (blocked) return;
        let outcome: CommentOutcome | ReplyOutcome | null = null;
        const stopping = { getIsStopping: () => this.cancelled };
        try {
            outcome = item.kind === 'reply'
                ? await this.deps.postReply(opened.page, { postUrl: item.postUrl, target: { commentId: item.targetCommentId || undefined, author: item.targetAuthor || undefined, excerpt: item.targetExcerpt || undefined }, text: item.approvedText }, stopping)
                : await this.deps.postComment(opened.page, { postUrl: item.postUrl, comment: item.approvedText, text: item.postExcerpt }, stopping);
        } catch {
            outcome = null;
        } finally {
            await opened.close().catch(() => undefined);
        }
        if (!outcome) return this.settle(item, 'uncertain', 'Không rõ đã gửi hay chưa', 'uncertain'); // keeps the slot
        if (outcome.status === 'posted') {
            if (reservation !== null) limiter.commit(reservation);
            return this.settle(item, 'posted', '', '', this.now());
        }
        // Cancelled (app quit / workspace switch) before the send click: still owed, retried by recover()/the next kick.
        if (!outcome.sent && this.cancelled) { store.settleEngagement(item.id, 'approved', '', null); return; }
        if (outcome.status === 'failed' && !outcome.sent) { release(); return this.settle(item, 'skipped', outcome.reason, NOT_SENT); } // nothing reached Facebook
        if (outcome.status === 'failed') {
            if (reservation !== null) limiter.commit(reservation);
            return this.settle(item, 'failed', outcome.reason, 'failed');
        }
        release();
        this.settle(item, 'skipped', outcome.reason, outcome.status);
    }
}
