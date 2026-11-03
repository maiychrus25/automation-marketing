import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createEngagementOperations } from '../../services/facebookPoster/engagementOperations';
import { EngagementPoster, type EngagementPosterDeps } from '../../services/facebookPoster/EngagementPoster';
import { ENGAGEMENT_TTL_MS } from '../../services/facebookPoster/engagementRules';
import type { CommentOutcome } from '../../services/facebookPoster/firstComment';
import type { ReplyOutcome } from '../../services/facebookPoster/commentReply';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';

const HCM = 'Asia/Ho_Chi_Minh';
const clock: LocalClock = {
    date: (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: HCM, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)),
    minutes: (ms) => {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: HCM, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
        return Number(p.hour) * 60 + Number(p.minute);
    },
};
const T0 = Date.UTC(2026, 10, 3, 3, 0); // 10:00 Ho Chi Minh
const HOUR = 3_600_000;

function setup(opts: { outcome?: CommentOutcome | (() => Promise<CommentOutcome>); replyOutcome?: ReplyOutcome | (() => Promise<ReplyOutcome>); enqueueThrows?: boolean; onOpen?: () => void } = {}) {
    const h = { now: T0 };
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock, protectedWritesEnabled: () => false });
    limiter.ensureSchema(); // policy untouched: enabled=false proves the posting is not switch-gated
    const events: any[] = [];
    const posted: any[] = [];
    const replied: any[] = [];
    const replyOutcome = opts.replyOutcome ?? { status: 'posted', reason: '', sent: true };
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const outcome = opts.outcome ?? { status: 'posted', reason: '' };
    const opsEvents: any[] = [];
    const sessions = { opened: 0, closed: 0 };
    const stop = { epoch: 0 };
    const deps: EngagementPosterDeps = {
        store, limiter, now: () => h.now, stopEpoch: () => stop.epoch,
        openSession: async () => { sessions.opened += 1; opts.onOpen?.(); return { page: {} as any, close: async () => { sessions.closed += 1; } }; },
        postComment: async (_page, input) => { posted.push(input); return typeof outcome === 'function' ? outcome() : outcome; },
        postReply: async (_page, input) => { replied.push(input); return typeof replyOutcome === 'function' ? replyOutcome() : replyOutcome; },
        emit: (type, payload) => events.push({ type, payload }),
        schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    };
    const poster = new EngagementPoster(deps);
    const ops = createEngagementOperations({
        store, limiter: () => limiter, now: () => h.now, emit: (type, payload) => opsEvents.push({ type, payload }), profileExists: () => true, replySupported: true,
        enqueuePost: (id) => { if (opts.enqueueThrows) throw new Error('boom'); poster.enqueue(id); },
        onCancelled: (id) => poster.forget(id),
        markStopped: (at) => { stop.epoch = at; },
    });
    let seq = 0;
    const approved = (text?: string) => {
        seq += 1;
        const { id } = ops.suggest({ profileId: 'p1', kind: 'comment', postUrl: `https://www.facebook.com/groups/g1/posts/${seq}/`, postExcerpt: 'Bai ve giay', text: 'Bài này hữu ích quá', reason: 'dung chu de' });
        return id;
    };
    const approvedReply = (target: Record<string, string>) => {
        seq += 1;
        return ops.suggest({ profileId: 'p1', kind: 'reply', postUrl: `https://www.facebook.com/trang/posts/${seq}/`, postExcerpt: 'Bai ve giay', text: 'Dạ còn size 42 ạ', reason: 'khach hoi', ...target }).id;
    };
    const row = (id: number) => db.queryOne<any>('SELECT * FROM fb_poster_engagement_items WHERE id = ?', [id]);
    const action = (id: number) => db.queryOne<any>("SELECT * FROM autonomy_actions WHERE action = 'engagement_comment' AND ref = ?", [`engagement:${id}`]);
    /** An `engagement_comment` slot already sent (`used`) by p1, booked on `localDate` and sent at `settledAt`. */
    const sentEarlier = (localDate: string, createdAt: number, settledAt: number) => db.run(
        "INSERT INTO autonomy_actions (action, profile_id, origin, local_date, status, ref, created_at, settled_at) VALUES ('engagement_comment', 'p1', 'app', ?, 'used', 'engagement:0', ?, ?)",
        [localDate, createdAt, settledAt]);
    return { h, db, store, limiter, ops, poster, events, opsEvents, sessions, posted, replied, timers, stop, approved, approvedReply, row, action, sentEarlier };
}

describe('EngagementPoster', () => {
    it('approvedItemPostsExactApprovedText', async () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id, '  Mình đã sửa câu này  ');
        await s.poster.whenIdle();
        expect(s.posted).toEqual([{ postUrl: 'https://www.facebook.com/groups/g1/posts/1/', comment: 'Mình đã sửa câu này', text: 'Bai ve giay' }]);
        expect(s.row(id)).toMatchObject({ status: 'posted', result_reason: '', posted_at: T0 });
        expect(s.action(id).status).toBe('used');
        expect(s.events).toEqual([{ type: 'engagement.finished', payload: { id, status: 'posted', reason: '' } }]);
    });

    it.each(['post_not_found', 'pending_approval', 'no_post_url'] as const)('unavailablePostSkipsAndReleases %s', async (status) => {
        const s = setup({ outcome: { status, reason: 'khong thay bai' } });
        const id = s.approved();
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'khong thay bai' });
        expect(s.action(id).status).toBe('released');
        expect(s.events[0].payload).toEqual({ id, status: 'skipped', reason: status });
    });

    it('sentFailureKeepsSlot', async () => {
        const s = setup({ outcome: { status: 'failed', reason: 'khong gui duoc', sent: true } });
        const id = s.approved();
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('failed');
        expect(s.action(id).status).toBe('used');
        s.poster.recover();
        await s.poster.whenIdle();
        expect(s.posted).toHaveLength(1);
    });

    it('thrownPostBecomesUncertainAndKeepsReservation', async () => {
        const s = setup({ outcome: async () => { throw new Error('crash'); } });
        const id = s.approved();
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('uncertain');
        expect(s.action(id).status).toBe('reserved');
        expect(s.events[0].payload).toMatchObject({ id, status: 'uncertain' });
    });

    it('quietHoursDefersThenExpires', async () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id);
        s.h.now = T0 + 13 * HOUR; // 23:00, quiet hours; the drain runs after this point
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('approved');
        expect(s.posted).toHaveLength(0);
        expect(s.events).toHaveLength(0);
        const live = s.timers.filter((t) => !t.cancelled);
        expect(live).toHaveLength(1);
        expect(live[0].ms).toBe(8 * HOUR); // 07:00 next day
        s.h.now = T0 + 21 * HOUR;
        live[0].fn();
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('posted');

        // A second item is only picked up after its 24h window has passed: expired, slot returned.
        const late = s.approved();
        s.ops.approve(late);
        s.h.now += ENGAGEMENT_TTL_MS + HOUR;
        await s.poster.whenIdle();
        expect(s.row(late)).toMatchObject({ status: 'skipped', result_reason: 'expired_after_approval' });
        expect(s.action(late).status).toBe('released');
        expect(s.events.at(-1).payload).toEqual({ id: late, status: 'skipped', reason: 'expired_after_approval' });
    });

    it('pausedProfileSkipsAndReleases', async () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id);
        s.limiter.pauseProfile('p1', 'checkpoint');
        await s.poster.whenIdle();
        expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'profile_paused' });
        expect(s.action(id).status).toBe('released');
        expect(s.posted).toHaveLength(0);
    });

    it('postingBecomesUncertainAfterRestart', () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id);
        s.db.run("UPDATE fb_poster_engagement_items SET status = 'posting' WHERE id = ?", [id]);
        const fresh = new EngagementPoster({ ...(s.poster as any).deps });
        fresh.recover();
        expect(s.row(id)).toMatchObject({ status: 'uncertain', result_reason: 'interrupted' });
        expect(s.action(id).status).toBe('reserved');
    });

    it('cancelledDrainResetsAndKeepsApproved', async () => {
        const s = setup();
        const id = s.approved();
        s.poster.cancel();
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('posted'); // a stale cancel flag must not park the poster
    });

    it('deferredItemRearmsAfterCancelAndRecover', async () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id);
        s.h.now = T0 + 13 * HOUR; // 23:00, quiet hours
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('approved');
        s.poster.cancel();
        expect(s.timers.filter((t) => !t.cancelled)).toHaveLength(0);
        s.poster.recover();
        await s.poster.whenIdle();
        const live = s.timers.filter((t) => !t.cancelled);
        expect(live).toHaveLength(1);
        s.h.now = T0 + 21 * HOUR;
        live[0].fn();
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe('posted');
    });

    it('laterDeferralIsRearmedAfterEarlierTimerFires', async () => {
        const s = setup();
        const a = s.approved();
        s.ops.approve(a);
        s.h.now = T0 + 13 * HOUR; // 23:00 day 1: a deferred to 07:00, timer armed
        await s.poster.whenIdle();
        const first = s.timers.filter((t) => !t.cancelled);
        expect(first).toHaveLength(1);
        s.h.now = T0 + 34 * HOUR; // 20:00 day 2... a is past its window; b arrives in the evening quiet hours
        s.h.now += 2 * HOUR; // 22:00 day 2
        const b = s.approved();
        s.ops.approve(b);
        await s.poster.whenIdle();
        expect(s.row(a).status).toBe('skipped');
        expect(s.row(b).status).toBe('approved');
        first[0].fn(); // the earlier timer fires; b is not due yet
        await s.poster.whenIdle();
        const live = s.timers.filter((t) => !t.cancelled && t !== first[0] && t.ms > 0).slice(-1);
        expect(live).toHaveLength(1);
        s.h.now += 9 * HOUR; // 07:00 day 3
        live[0].fn();
        await s.poster.whenIdle();
        expect(s.row(b).status).toBe('posted');
    });

    it('notSentFailureReleasesAndSkips', async () => {
        const s = setup({ outcome: { status: 'failed', reason: 'Không thấy nút gửi bình luận cạnh ô nhập.' } });
        const id = s.approved();
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'Không thấy nút gửi bình luận cạnh ô nhập.' });
        expect(s.action(id).status).toBe('released');
        expect(s.events).toEqual([{ type: 'engagement.finished', payload: { id, status: 'skipped', reason: 'not_sent' } }]);
        expect(s.store.hasLiveEngagementPost('p1', s.row(id).post_key)).toBe(false); // the bot may suggest this post again
    });

    it('replyItemPostsApprovedTextUnderTarget', async () => {
        const s = setup();
        const id = s.approvedReply({ targetAuthor: 'Khach Hai', targetExcerpt: 'Con size 42 khong' });
        s.ops.approve(id, '  Dạ còn size 42 ạ, anh ghé shop nhé ');
        await s.poster.whenIdle();
        expect(s.posted).toHaveLength(0);
        expect(s.replied).toEqual([{ postUrl: 'https://www.facebook.com/trang/posts/1/', target: { commentId: undefined, author: 'Khach Hai', excerpt: 'Con size 42 khong' }, text: 'Dạ còn size 42 ạ, anh ghé shop nhé' }]);
        expect(s.row(id)).toMatchObject({ status: 'posted', posted_at: T0 });
        expect(s.action(id).status).toBe('used');
        const byId = s.approvedReply({ targetCommentId: '9102' });
        s.ops.approve(byId);
        await s.poster.whenIdle();
        expect(s.replied[1].target).toEqual({ commentId: '9102', author: undefined, excerpt: undefined });
    });

    it.each([
        ['target_not_found', { status: 'target_not_found', reason: 'khong thay binh luan' }, 'skipped', 'released', 'target_not_found'],
        ['post_not_found', { status: 'post_not_found', reason: 'khong thay bai' }, 'skipped', 'released', 'post_not_found'],
        ['failed before send', { status: 'failed', reason: 'khong thay o tra loi' }, 'skipped', 'released', 'not_sent'],
        ['failed after send', { status: 'failed', reason: 'khong doc lai duoc', sent: true }, 'failed', 'used', 'failed'],
        ['thrown', async () => { throw new Error('crash'); }, 'uncertain', 'reserved', 'uncertain'],
    ] as [string, ReplyOutcome | (() => Promise<ReplyOutcome>), string, string, string][])('replyResultMapsToItemStatus: %s', async (_label, replyOutcome, status, slot, code) => {
        const s = setup({ replyOutcome });
        const id = s.approvedReply({ targetCommentId: '9102' });
        s.ops.approve(id);
        await s.poster.whenIdle();
        expect(s.row(id).status).toBe(status);
        expect(s.action(id).status).toBe(slot);
        expect(s.events.at(-1).payload).toMatchObject({ id, status, reason: code });
        expect(s.posted).toHaveLength(0);
    });

    describe('regatesAfterProfileSlotWait', () => {
        it('pausedWhileWaitingSkipsAndReleases', async () => {
            let pause = () => {};
            const s = setup({ onOpen: () => pause() });
            pause = () => s.limiter.pauseProfile('p1', 'checkpoint');
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.sessions).toEqual({ opened: 1, closed: 1 });
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'profile_paused' });
            expect(s.action(id).status).toBe('released');
        });

        it('quietHoursWhileWaitingGoesBackToApprovedAndDefers', async () => {
            let night = () => {};
            const s = setup({ onOpen: () => night() });
            night = () => { s.h.now = T0 + 13 * HOUR; night = () => {}; }; // the profile slot frees up at 23:00
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.sessions.closed).toBe(1);
            expect(s.row(id).status).toBe('approved');
            expect(s.action(id).status).toBe('reserved');
            const live = s.timers.filter((t) => !t.cancelled);
            expect(live).toHaveLength(1);
            s.h.now = T0 + 21 * HOUR;
            live[0].fn();
            await s.poster.whenIdle();
            expect(s.row(id).status).toBe('posted');
        });

        it('expiredWhileWaitingSkipsAsExpired', async () => {
            let late = () => {};
            const s = setup({ onOpen: () => late() });
            late = () => { s.h.now = T0 + ENGAGEMENT_TTL_MS + HOUR; };
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.sessions.closed).toBe(1);
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'expired_after_approval' });
            expect(s.action(id).status).toBe('released');
        });
    });

    it('cancelApprovedReleasesAndSkips', async () => {
        const s = setup();
        const id = s.approved();
        s.ops.approve(id);
        s.h.now = T0 + 13 * HOUR; // 23:00: deferred, a wake-up timer is armed
        await s.poster.whenIdle();
        expect(s.timers.filter((t) => !t.cancelled)).toHaveLength(1);
        s.opsEvents.length = 0;
        expect(s.ops.cancel(id)).toEqual({ id, status: 'skipped' });
        expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'cancelled_by_operator' });
        expect(s.action(id).status).toBe('released');
        expect(s.opsEvents).toEqual([{ type: 'engagement.finished', payload: { id, status: 'skipped', reason: 'cancelled_by_operator' } }]);
        expect(s.timers.filter((t) => !t.cancelled)).toHaveLength(0); // the deferral is cleared
        s.h.now = T0 + 21 * HOUR;
        s.poster.recover();
        await s.poster.whenIdle();
        expect(s.posted).toHaveLength(0);
    });

    it('cancelRefusesPostingOrPending', () => {
        const s = setup();
        const pending = s.approved();
        expect(() => s.ops.cancel(pending)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(s.row(pending).status).toBe('pending');
        const posting = s.approved();
        s.ops.approve(posting);
        s.db.run("UPDATE fb_poster_engagement_items SET status = 'posting' WHERE id = ?", [posting]);
        expect(() => s.ops.cancel(posting)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(s.row(posting).status).toBe('posting');
        expect(s.action(posting).status).toBe('reserved');
        expect(() => s.ops.cancel(9999)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(s.opsEvents.filter((e) => e.type === 'engagement.finished')).toHaveLength(0);
    });

    it('cancelAllApprovedForEmergencyStop', async () => {
        const s = setup();
        const a = s.approved();
        const b = s.approved();
        const posting = s.approved();
        s.ops.approve(a); s.ops.approve(b); s.ops.approve(posting);
        s.h.now = T0 + 13 * HOUR; // quiet hours: all deferred
        await s.poster.whenIdle();
        s.db.run("UPDATE fb_poster_engagement_items SET status = 'posting' WHERE id = ?", [posting]);
        s.opsEvents.length = 0;
        expect(s.ops.cancelAllApproved('stopped_by_operator')).toBe(2);
        for (const id of [a, b]) {
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'stopped_by_operator' });
            expect(s.action(id).status).toBe('released');
        }
        expect(s.row(posting).status).toBe('posting'); // already clicking: left alone
        expect(s.opsEvents.map((e) => e.payload)).toEqual([
            { id: a, status: 'skipped', reason: 'stopped_by_operator' }, { id: b, status: 'skipped', reason: 'stopped_by_operator' }]);
    });

    describe('emergencyStopReachesQueuedPosting', () => {
        it('queuedPostingRowIsStoppedAfterEmergencyStop', async () => {
            let stopNow = () => {};
            const s = setup({ onOpen: () => stopNow() });
            // The operator presses stop while the row is already `posting`, waiting for the profile slot.
            stopNow = () => { s.h.now += 60_000; s.ops.cancelAllApproved('stopped_by_operator'); };
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.sessions).toEqual({ opened: 1, closed: 1 });
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'stopped_by_operator' });
            expect(s.action(id).status).toBe('released');
            expect(s.events).toEqual([{ type: 'engagement.finished', payload: { id, status: 'skipped', reason: 'stopped_by_operator' } }]);
        });

        it('rowApprovedAfterStopStillPosts', async () => {
            const s = setup();
            s.ops.cancelAllApproved('stopped_by_operator'); // nothing queued, but the stop time is recorded
            expect(s.stop.epoch).toBe(T0);
            s.h.now += 60_000;
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.row(id).status).toBe('posted');
            expect(s.action(id).status).toBe('used');
        });
    });

    describe('cancelAfterSessionOpen', () => {
        it('cancelledBeforeSendReturnsToApproved', async () => {
            let s: ReturnType<typeof setup>;
            let calls = 0;
            // App quit / workspace switch while typing: the poster stops before the send click.
            s = setup({ outcome: async () => { calls += 1; if (calls > 1) return { status: 'posted', reason: '' }; s.poster.cancel(); return { status: 'failed', reason: 'Đã huỷ giữa chừng.' }; } });
            const id = s.approved();
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.sessions).toEqual({ opened: 1, closed: 1 });
            expect(s.row(id)).toMatchObject({ status: 'approved', result_reason: '' });
            expect(s.action(id).status).toBe('reserved'); // still owed
            expect(s.events).toHaveLength(0);
            s.poster.recover(); // next start / kick retries it within its 24h window
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(2);
            expect(s.row(id).status).toBe('posted');
            expect(s.action(id).status).toBe('used');
        });

        it('nonCancelledNotSentStillSkips', async () => {
            const s = setup({ outcome: { status: 'failed', reason: 'Không thấy nút gửi bình luận cạnh ô nhập.' } });
            const id = s.approved();
            s.poster.cancel(); // a stale cancel flag is reset by the next drain: this failure is not caused by cancelling
            s.ops.approve(id);
            await s.poster.whenIdle();
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'Không thấy nút gửi bình luận cạnh ô nhập.' });
            expect(s.action(id).status).toBe('released');
            expect(s.events).toEqual([{ type: 'engagement.finished', payload: { id, status: 'skipped', reason: 'not_sent' } }]);
        });
    });

    describe('postingDayCap', () => {
        it('postingDayCapDefersToNextDay', async () => {
            let sendOther = () => {};
            const s = setup({ onOpen: () => sendOther() });
            s.limiter.setPolicy({ engagementCommentsPerDay: 1 }, 'test');
            // While this row waited for the profile, a comment approved yesterday was sent today: today's posting cap is used up.
            sendOther = () => s.sentEarlier('2026-11-02', T0 - 20 * HOUR, T0);
            const id = s.approved();
            s.ops.approve(id); // booked on today's ledger: only yesterday's row is there, so the approval still reserves
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.sessions.closed).toBe(1);
            expect(s.row(id).status).toBe('approved');
            expect(s.action(id).status).toBe('reserved');
            expect(s.events).toHaveLength(0);
            const live = s.timers.filter((t) => !t.cancelled);
            expect(live).toHaveLength(1);
            expect(live[0].ms).toBe(14 * HOUR); // next local midnight
            s.h.now = T0 + 21 * HOUR; // 07:00 next day, after quiet hours
            live[0].fn();
            await s.poster.whenIdle();
            expect(s.row(id).status).toBe('posted');
            expect(s.action(id).status).toBe('used');
        });

        it('postingDayCapExpiresWhenPastWindow', async () => {
            const s = setup();
            s.limiter.setPolicy({ engagementCommentsPerDay: 1 }, 'test');
            const id = s.approved();
            s.ops.approve(id);
            s.sentEarlier('2026-11-03', T0 - HOUR, T0 + 21 * HOUR + 30 * 60_000); // sent 07:30 next day
            s.h.now = T0 + 22 * HOUR; // 08:00 next day: cap used, the next midnight is past the 24h window
            await s.poster.whenIdle();
            expect(s.posted).toHaveLength(0);
            expect(s.row(id)).toMatchObject({ status: 'skipped', result_reason: 'expired_after_approval' });
            expect(s.action(id).status).toBe('released');
            expect(s.events).toEqual([{ type: 'engagement.finished', payload: { id, status: 'skipped', reason: 'expired_after_approval' } }]);
        });
    });

    it('approveRollsBackWhenEnqueueFails', () => {
        const s = setup({ enqueueThrows: true });
        const id = s.approved();
        expect(() => s.ops.approve(id)).toThrow('boom');
        expect(s.row(id)).toMatchObject({ status: 'pending', approved_text: '', reservation_id: null, decided_at: null });
        expect(s.action(id).status).toBe('released');
    });
});
