import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createEngagementOperations, type EngagementOperationsDeps } from '../../services/facebookPoster/engagementOperations';
import { ENGAGEMENT_TTL_MS, containsLink, validateEngagementText } from '../../services/facebookPoster/engagementRules';
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

function setup(over: Partial<EngagementOperationsDeps> = {}) {
    const h = { now: T0 };
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock, protectedWritesEnabled: () => false });
    limiter.ensureSchema(); // policy untouched: enabled=false proves the engagement actions are not switch-gated
    const events: any[] = [];
    const enqueued: number[] = [];
    const ops = createEngagementOperations({
        store, limiter: () => limiter, now: () => h.now,
        emit: (type, payload) => events.push({ type, payload }),
        profileExists: (id) => id === 'p1' || id === 'p2',
        enqueuePost: (id) => enqueued.push(id),
        ...over,
    });
    let seq = 0;
    const input = (o: Record<string, unknown> = {}) => {
        seq += 1;
        return { profileId: 'p1', kind: 'comment', postUrl: `https://www.facebook.com/groups/g1/posts/${seq}/`, postExcerpt: 'Bai ve giay chay bo', text: 'Bài này hữu ích quá, cảm ơn bạn đã chia sẻ', reason: 'Dung chu de', ...o };
    };
    const rows = () => db.query<any>('SELECT * FROM fb_poster_engagement_items ORDER BY id');
    const used = (action: string, status = 'used') => db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM autonomy_actions WHERE action = ? AND status = ?', [action, status])!.n;
    return { h, db, store, limiter, ops, events, enqueued, input, rows, used };
}

describe('engagement research cooldown log', () => {
    function withLog() {
        const saved = new Map<string, string>();
        const t = setup({ researchLog: { read: () => saved.get('engagement_research_last') ?? null, write: (v) => { saved.set('engagement_research_last', v); } } });
        return { ...t, last: () => JSON.parse(saved.get('engagement_research_last') ?? '{}') };
    }

    it('suggestRecordsResearchAttempt', () => {
        const t = withLog();
        t.ops.suggest(t.input());
        expect(t.last()).toEqual({ p1: T0 });
    });

    it('suggestSurvivesResearchLogWriteFailure', () => {
        const logs: string[] = [];
        const t = setup({ researchLog: { read: () => null, write: () => { throw new Error('disk full'); } }, log: (m) => logs.push(m) });
        const out = t.ops.suggest(t.input());
        expect(out.status).toBe('pending');
        expect(t.rows()).toHaveLength(1);
        expect(t.used('engagement_suggest')).toBe(1);
        expect(t.events.map((e) => e.type)).toEqual(['engagement.suggested']);
        expect(logs).toEqual([expect.stringContaining('disk full')]);
    });

    it('markResearchedIsOwnerOnlyAndValidates', () => {
        const t = withLog();
        t.h.now = T0 + 5;
        expect(t.ops.markResearched({ profileIds: ['p1', 'p2', 'ghost', 'p1'] })).toEqual({ marked: 2 });
        expect(t.last()).toEqual({ p1: T0 + 5, p2: T0 + 5 });
        for (const bad of [undefined, 'p1', [], [1], [''], Array.from({ length: 101 }, () => 'p1')])
            expect(() => t.ops.markResearched({ profileIds: bad as any })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    });
});

describe('engagementRules', () => {
    it('suggestValidatesTextLinksAndLength', () => {
        expect(validateEngagementText('  Xin chào  ')).toBe('Xin chào');
        for (const bad of ['', '   ', 5, null, 'x'.repeat(601), 'xem https://a.vn', 'vào www.abc.vn', 'ghé shop.com.vn nhé', 'HTTP://X.IO',
            'abc.com', 'shopee.vn/abc', 'fb.me/x', 'https://x.y', 'www.abc', 'ftp://a.b', 'Vào ABC.COM nhé'])
            expect(() => validateEngagementText(bad)).toThrow(Error);
        expect(validateEngagementText('x'.repeat(600))).toHaveLength(600);
        expect(containsLink('Giá 1.5 triệu, ok')).toBe(false);
        for (const ok of ['Ship tận nơi TP.HCM', 'Q.1, TP.HCM', 'ok.Hay', 'hay.Thật sự', 'Dr.Martens']) expect(containsLink(ok)).toBe(false);
        expect(containsLink('xem abc.com')).toBe(true);
    });
});

describe('engagementOperations', () => {
    it('suggestStoresPendingAndEmits', () => {
        const s = setup();
        const r = s.ops.suggest(s.input());
        expect(r).toEqual({ id: 1, status: 'pending', expiresAt: T0 + ENGAGEMENT_TTL_MS });
        expect(s.rows()[0]).toMatchObject({ profile_id: 'p1', kind: 'comment', status: 'pending', approved_text: '', post_key: 'https://www.facebook.com/groups/g1/posts/1/' });
        expect(s.events).toEqual([{ type: 'engagement.suggested', payload: { id: 1, profileId: 'p1', kind: 'comment' } }]);
        expect(s.used('engagement_suggest')).toBe(1);
    });

    it('approveWorksInQuietHours', () => {
        const s = setup();
        const { id } = s.ops.suggest(s.input());
        s.h.now = T0 + 13 * 3_600_000; // 23:00 Ho Chi Minh, inside the default quiet hours
        expect(s.ops.approve(id)).toEqual({ id, status: 'approved' });
        expect(s.used('engagement_comment', 'reserved')).toBe(1);
    });

    it('approveWorksForPausedProfile', () => {
        const s = setup();
        const { id } = s.ops.suggest(s.input());
        s.limiter.pauseProfile('p1', 'checkpoint');
        expect(s.ops.approve(id)).toEqual({ id, status: 'approved' });
        expect(s.enqueued).toEqual([id]);
    });

    it('overlongFieldsAreRefusedNotTruncated', () => {
        const s = setup();
        for (const [field, max] of [['postExcerpt', 500], ['reason', 500], ['sourceRef', 200]] as const) {
            expect(() => s.ops.suggest(s.input({ [field]: 'x'.repeat(max + 1) }))).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS', details: { field } }));
            expect(s.ops.suggest(s.input({ [field]: 'x'.repeat(max) })).status).toBe('pending');
        }
    });

    it('suggestRejectsUnknownProfileBadUrlAndKind', () => {
        const s = setup();
        expect(() => s.ops.suggest(s.input({ profileId: 'zz' }))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(() => s.ops.suggest(s.input({ postUrl: 'http://evil.example/x' }))).toThrow(Error);
        expect(() => s.ops.suggest(s.input({ kind: 'dm' }))).toThrow(Error);
        expect(() => s.ops.suggest(s.input({ text: 'xem https://a.vn' }))).toThrow(Error);
        expect(s.rows()).toHaveLength(0);
        expect(s.used('engagement_suggest')).toBe(0);
    });

    it('suggestRejectsDuplicatePostForProfile', () => {
        const s = setup();
        const first = s.input();
        s.ops.suggest(first);
        // Same post under a tracking-param spelling is still the same post (R2).
        expect(() => s.ops.suggest({ ...first, postUrl: `${first.postUrl}?fbclid=abc` })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(s.ops.suggest({ ...first, profileId: 'p2' }).id).toBe(2); // another profile may comment on the same post
        s.ops.reject(1, 'khong hop');
        expect(s.ops.suggest(first).id).toBe(3); // rejected rows free the post
    });

    it('suggestStopsAtTwenty', () => {
        const s = setup();
        for (let i = 0; i < 20; i++) s.ops.suggest(s.input());
        expect(() => s.ops.suggest(s.input())).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED' }));
        expect(s.rows()).toHaveLength(20);
        expect(s.ops.suggest(s.input({ profileId: 'p2' })).id).toBe(21);
    });

    it('replyRejectedUntilSupported', () => {
        const s = setup();
        const reply = s.input({ kind: 'reply', targetCommentId: 'c1' });
        expect(() => s.ops.suggest(reply)).toThrow('Trả lời bình luận chưa hỗ trợ');
        expect(s.rows()).toHaveLength(0);
        const t = setup({ replySupported: true });
        expect(() => t.ops.suggest(t.input({ kind: 'reply' }))).toThrow(Error); // needs a target
        expect(t.ops.suggest(t.input({ kind: 'reply', targetAuthor: 'An', targetExcerpt: 'gia sao' })).status).toBe('pending');
    });

    it('pendingExpiresAfter24h', () => {
        const s = setup();
        s.ops.suggest(s.input());
        s.h.now = T0 + ENGAGEMENT_TTL_MS - 1;
        expect(s.ops.expireDue()).toBe(0);
        s.h.now = T0 + ENGAGEMENT_TTL_MS;
        expect(s.ops.list({}).items[0].status).toBe('expired');
        expect(s.ops.expireDue()).toBe(0);
        expect(() => s.ops.approve(1)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    });

    it('approveUsesEditedTextAndReserves', () => {
        const s = setup();
        const { id } = s.ops.suggest(s.input());
        s.events.length = 0;
        expect(s.ops.approve(id, '  Câu đã sửa  ')).toEqual({ id, status: 'approved' });
        expect(s.rows()[0]).toMatchObject({ status: 'approved', approved_text: 'Câu đã sửa', decided_at: T0 });
        expect(s.rows()[0].reservation_id).toBeGreaterThan(0);
        expect(s.used('engagement_comment', 'reserved')).toBe(1);
        expect(s.enqueued).toEqual([id]);
        expect(s.events).toEqual([{ type: 'engagement.decided', payload: { id, decision: 'approved' } }]);
        const t = setup();
        const b = t.ops.suggest(t.input({ text: 'Giữ nguyên câu bot' }));
        t.ops.approve(b.id);
        expect(t.rows()[0].approved_text).toBe('Giữ nguyên câu bot');
    });

    it('editedTextIsValidatedLikeSuggestion', () => {
        const s = setup();
        const { id } = s.ops.suggest(s.input());
        for (const bad of ['', 'x'.repeat(601), 'vào shop.vn']) expect(() => s.ops.approve(id, bad)).toThrow(Error);
        expect(s.rows()[0].status).toBe('pending');
        expect(s.used('engagement_comment', 'reserved')).toBe(0);
        expect(s.enqueued).toEqual([]);
    });

    it('approveRejectsExpiredDecidedOrWithdrawn', () => {
        const s = setup();
        const a = s.ops.suggest(s.input()).id;
        const b = s.ops.suggest(s.input()).id;
        const c = s.ops.suggest(s.input()).id;
        s.ops.approve(a);
        s.ops.reject(b);
        s.ops.withdraw({ id: c });
        for (const id of [a, b, c]) expect(() => s.ops.approve(id)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(() => s.ops.approve(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(() => s.ops.reject(a)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(s.rows().find((r) => r.id === c)).toMatchObject({ status: 'rejected', reject_reason: 'withdrawn_by_bot' });
        expect(s.enqueued).toEqual([a]);
    });

    it('approveStopsAtTenPerProfile', () => {
        const s = setup();
        const ids = Array.from({ length: 11 }, () => s.ops.suggest(s.input()).id);
        ids.slice(0, 10).forEach((id) => s.ops.approve(id));
        expect(() => s.ops.approve(ids[10])).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED' }));
        expect(s.rows()[10]).toMatchObject({ status: 'pending', reservation_id: null });
        expect(s.enqueued).toHaveLength(10);
    });

    it('rejectRecordsReasonAndWithdrawOnlyPending', () => {
        const s = setup();
        const { id } = s.ops.suggest(s.input());
        s.events.length = 0;
        expect(s.ops.reject(id, '  Không hợp  ')).toEqual({ id, status: 'rejected' });
        expect(s.rows()[0]).toMatchObject({ status: 'rejected', reject_reason: 'Không hợp', decided_at: T0 });
        expect(s.events).toEqual([{ type: 'engagement.decided', payload: { id, decision: 'rejected' } }]);
        expect(() => s.ops.withdraw({ id })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(() => s.ops.withdraw({ id: 99 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });

    it('listFiltersAndExposesRejectReason', () => {
        const s = setup();
        const a = s.ops.suggest(s.input()).id;
        s.ops.suggest(s.input({ profileId: 'p2' }));
        s.ops.reject(a, 'lạc đề');
        const all = s.ops.list({});
        expect(all.total).toBe(2);
        expect(all.items.map((i: any) => i.id)).toEqual([2, 1]);
        expect(s.ops.list({ status: 'rejected' }).items[0]).toMatchObject({ id: a, rejectReason: 'lạc đề', suggestedText: expect.any(String) });
        expect(s.ops.list({ profileId: 'p2' }).total).toBe(1);
        expect(s.ops.list({ limit: 1, offset: 1 }).items.map((i: any) => i.id)).toEqual([1]);
        expect(() => s.ops.list({ status: 'bogus' })).toThrow(Error);
    });
});
