import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { LeadReplier, type LeadReplierDeps } from '../../services/facebookPoster/LeadReplier';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createControlMethods, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { visibleMethods } from '../../services/control/controlAuthorization';
import type { ControlPrincipal } from '../../models/pageOperations';
import type { CommentOutcome } from '../../services/facebookPoster/firstComment';
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

function setup(opts: { outcome?: CommentOutcome | (() => Promise<CommentOutcome>) } = {}) {
    const h = { now: T0 };
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock, protectedWritesEnabled: () => true });
    limiter.ensureSchema();
    limiter.setPolicy({ enabled: true }, 'test');
    const events: any[] = [];
    const closed: number[] = [];
    const posted: any[] = [];
    const outcome = opts.outcome ?? { status: 'posted', reason: '' };
    const deps: LeadReplierDeps = {
        store, limiter,
        now: () => h.now,
        openSession: async () => ({ page: {} as any, close: async () => { closed.push(1); } }),
        postComment: async (_page, input) => {
            posted.push(input);
            return typeof outcome === 'function' ? outcome() : outcome;
        },
        emit: (type, payload) => events.push({ type, payload }),
    };
    const replier = new LeadReplier(deps);
    let leadSeq = 0;
    /** Seed a posted run + result + lead; `app` false makes a lead whose post the app did not publish. */
    const seedLead = (over: { authorId?: string; app?: boolean; variant?: string; postUrl?: string; profileId?: string } = {}) => {
        leadSeq += 1;
        const runId = `run${leadSeq}`;
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?, ?, 'group', ?, 'done', 1)",
            [runId, 'post', JSON.stringify({ kind: 'post', text: 'Bai goc', variants: ['Bai B'] })]);
        const resultId = db.runInsert(
            "INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, post_url, created_at) VALUES (?, ?, 'P', 'https://www.facebook.com/groups/g1/', 'posted', 'https://www.facebook.com/groups/g1/posts/1', 1)",
            [runId, over.profileId ?? 'p1']);
        return db.runInsert(
            `INSERT INTO fb_poster_leads (comment_key, post_url, result_id, variant, profile_id, author_id, author_name, text, detected_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'Khach', 'gia bao nhieu', 1, 1)`,
            [`k${leadSeq}`, over.postUrl ?? 'https://www.facebook.com/groups/g1/posts/1', over.app === false ? null : resultId,
                over.variant ?? '', over.profileId ?? 'p1', over.authorId ?? `a${leadSeq}`]);
    };
    const rows = () => db.query<any>('SELECT * FROM fb_poster_lead_replies ORDER BY id');
    const action = (status: string) => db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM autonomy_actions WHERE action = ? AND status = ?', ['lead_reply', status])!.n;
    return { h, db, store, limiter, replier, events, closed, posted, seedLead, rows, action };
}

describe('LeadReplier', () => {
    it('replyQueuesAndPostsOnce', async () => {
        const s = setup();
        const leadId = s.seedLead({ variant: 'B' });
        expect(s.replier.enqueue({ leadId, text: '  Chào anh, em gửi báo giá  ' })).toEqual({ replyId: 1, status: 'queued' });
        await s.replier.whenIdle();
        expect(s.posted).toEqual([{ postUrl: 'https://www.facebook.com/groups/g1/posts/1', comment: 'Chào anh, em gửi báo giá', text: 'Bai B' }]);
        expect(s.rows()).toMatchObject([{ status: 'posted', lead_id: leadId, profile_id: 'p1', finished_at: T0 }]);
        expect(s.action('used')).toBe(1);
        expect(s.closed).toHaveLength(1);
        expect(s.events).toEqual([{ type: 'comments.replied', payload: { replyId: 1, leadId, status: 'posted', reason: '' } }]);
        expect(s.replier.isRunning()).toBe(false);
    });

    it('rejectsLeadNotFromAppPost', () => {
        const s = setup();
        expect(() => s.replier.enqueue({ leadId: s.seedLead({ app: false }), text: 'x' })).toThrow('Khách không thuộc bài do app đăng');
        expect(() => s.replier.enqueue({ leadId: 999, text: 'x' })).toThrow('Không tìm thấy khách');
        expect(() => s.replier.enqueue({ leadId: s.seedLead(), text: '   ' })).toThrow();
        expect(() => s.replier.enqueue({ leadId: s.seedLead(), text: 'a'.repeat(1001) })).toThrow();
        expect(s.rows()).toEqual([]);
        expect(s.action('reserved')).toBe(0);
    });

    it('secondReplyToSameAuthorOnPostIsRejected', async () => {
        const s = setup();
        const first = s.seedLead({ authorId: 'same' });
        const sameAuthor = s.seedLead({ authorId: 'same' });
        s.replier.enqueue({ leadId: first, text: 'a' });
        expect(() => s.replier.enqueue({ leadId: first, text: 'b' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(() => s.replier.enqueue({ leadId: sameAuthor, text: 'b' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        await s.replier.whenIdle();
        expect(() => s.replier.enqueue({ leadId: sameAuthor, text: 'b' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(s.rows()).toHaveLength(1);
        expect(s.posted).toHaveLength(1);
    });

    it('blockedAtEffectTimeReleasesAndSkips', async () => {
        const s = setup();
        const leadId = s.seedLead();
        s.replier.enqueue({ leadId, text: 'a' });
        // Quiet hours begin (23:00 local) between reserve and the effect.
        s.h.now = Date.UTC(2026, 10, 3, 16, 0);
        await s.replier.whenIdle();
        expect(s.posted).toEqual([]);
        expect(s.rows()).toMatchObject([{ status: 'skipped' }]);
        expect(s.rows()[0].reason).not.toBe('');
        expect(s.action('released')).toBe(1);
        expect(s.events[0].payload).toMatchObject({ status: 'skipped' });
    });

    it('postNotFoundReleasesReservation', async () => {
        const s = setup({ outcome: { status: 'post_not_found', reason: 'Không thấy bài' } });
        s.replier.enqueue({ leadId: s.seedLead(), text: 'a' });
        await s.replier.whenIdle();
        expect(s.rows()).toMatchObject([{ status: 'skipped', reason: 'Không thấy bài' }]);
        expect(s.action('released')).toBe(1);
        expect(s.action('used')).toBe(0);
    });

    it('failedAfterClickKeepsReservationAndDoesNotRetry', async () => {
        const s = setup({ outcome: { status: 'failed', reason: 'Gửi lỗi' } });
        const leadId = s.seedLead();
        s.replier.enqueue({ leadId, text: 'a' });
        await s.replier.whenIdle();
        expect(s.rows()).toMatchObject([{ status: 'failed', reason: 'Gửi lỗi' }]);
        expect(s.action('used')).toBe(1);
        expect(() => s.replier.enqueue({ leadId, text: 'again' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        await s.replier.whenIdle();
        expect(s.posted).toHaveLength(1);
    });

    it('runningReplyBecomesUncertainAfterRestart', async () => {
        const s = setup();
        const leadId = s.seedLead();
        const queuedLead = s.seedLead();
        const reservation = s.limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1', ref: `lead:${leadId}` })!;
        s.db.run("INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, author_id, text, status, reservation_id, created_at) VALUES (?, 'p1', 'u', 'x', 't', 'running', ?, 1)", [leadId, reservation]);
        s.db.run("INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, author_id, text, status, reservation_id, created_at) VALUES (?, 'p1', 'https://www.facebook.com/groups/g1/posts/1', 'y', 'q', 'queued', ?, 1)",
            [queuedLead, s.limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1', ref: `lead:${queuedLead}` })]);
        s.replier.recover();
        await s.replier.whenIdle();
        const rows = s.rows();
        expect(rows[0]).toMatchObject({ status: 'uncertain', finished_at: T0 });
        expect(rows[1]).toMatchObject({ status: 'posted' });
        expect(s.action('reserved')).toBe(1); // the uncertain one keeps its slot
        expect(s.posted).toHaveLength(1);
    });

    it('dailyCapOfTenPerProfile', async () => {
        const s = setup();
        for (let i = 0; i < 10; i += 1) s.replier.enqueue({ leadId: s.seedLead(), text: `r${i}` });
        const eleventh = s.seedLead();
        expect(() => s.replier.enqueue({ leadId: eleventh, text: 'late' })).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: expect.objectContaining({ reason: 'quota' }) }));
        await s.replier.whenIdle();
        expect(s.rows()).toHaveLength(10);
        expect(s.posted).toHaveLength(10);
        // Another profile still has its own cap.
        expect(s.replier.enqueue({ leadId: s.seedLead({ profileId: 'p2' }), text: 'ok' }).status).toBe('queued');
    });
});

describe('LeadReplier lifecycle', () => {
    it('replierDrainsAgainAfterCancelWhenWorkspaceUnchanged', async () => {
        const s = setup();
        s.replier.cancel();
        s.replier.enqueue({ leadId: s.seedLead(), text: 'after cancel' });
        await s.replier.whenIdle();
        expect(s.rows()).toMatchObject([{ status: 'posted' }]);
        expect(s.posted).toHaveLength(1);
    });

    it('recoverDoesNotFlipInFlightRow', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const s = setup({ outcome: async () => { await gate; return { status: 'posted', reason: '' }; } });
        s.replier.enqueue({ leadId: s.seedLead(), text: 'x' });
        for (let i = 0; i < 20 && s.rows()[0]?.status !== 'running'; i += 1) await Promise.resolve();
        expect(s.rows()[0].status).toBe('running');
        s.replier.recover();
        expect(s.rows()[0].status).toBe('running');
        release();
        await s.replier.whenIdle();
        expect(s.rows()[0].status).toBe('posted');
    });
});

describe('comments.reply control method', () => {
    it('commentsReplyIsOwnerOnly', async () => {
        const reply = jest.fn(() => ({ replyId: 3, status: 'queued' }));
        const methods = createControlMethods({ leads: { reply } } as unknown as ControlMethodDeps);
        const method = methods.find((m) => m.name === 'comments.reply')!;
        expect(method).toMatchObject({ destructive: false });
        expect(method.description).toMatch(/Chỉ owner/);
        expect(await method.run({ leadId: 4, text: 'xin chào', junk: 1 }, {})).toEqual({ replyId: 3, status: 'queued' });
        expect(reply).toHaveBeenCalledWith({ leadId: 4, text: 'xin chào' });
        const runner: ControlPrincipal = { kind: 'page_runner', keyId: 'k', workspaceId: 'ws', assignments: [{ pageId: 'pg', profileIds: ['p1'] }] };
        const receiver = { ...runner, kind: 'page_receiver', ownerChatId: '1', ownerSenderId: '2' } as ControlPrincipal;
        expect(visibleMethods(runner, methods).map((m) => m.name)).not.toContain('comments.reply');
        expect(visibleMethods(receiver, methods).map((m) => m.name)).not.toContain('comments.reply');
        expect(visibleMethods({ kind: 'legacy' } as ControlPrincipal, methods).map((m) => m.name)).toContain('comments.reply');
    });

    it('mapsReplyErrorsToProtocolCodes', async () => {
        const reply = jest.fn(() => { throw new Error('Khách không thuộc bài do app đăng'); });
        const methods = createControlMethods({ leads: { reply } } as unknown as ControlMethodDeps);
        await expect(methods.find((m) => m.name === 'comments.reply')!.run({ leadId: 4, text: 'x' }, {})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });
});
