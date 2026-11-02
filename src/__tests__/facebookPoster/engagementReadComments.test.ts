import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { readEngagementComments, type EngagementReaderDeps } from '../../services/facebookPoster/EngagementReader';
import type { CollectedComment } from '../../services/facebookPoster/collectComments';
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
const URL_OK = 'https://www.facebook.com/groups/g1/posts/1/';

const row = (i: number, text = `cau hoi ${i}`): CollectedComment => ({
    authorId: `id${i}`, authorName: `Nguoi ${i}`, authorUrl: `https://www.facebook.com/id${i}`, text, commentedAt: '2 giờ', postUrl: URL_OK,
});

function setup(opts: { afterLaunch?: () => void; rows?: CollectedComment[]; loginProblem?: 'checkpoint' | 'logged_out'; launchError?: Error; collectError?: Error } = {}) {
    const h = { now: T0 };
    const db = memoryDb();
    const store = new FacebookPosterStore(db);
    store.ensureSchema();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock, protectedWritesEnabled: () => false });
    limiter.ensureSchema();
    const calls = { launch: [] as any[], closed: 0, observed: [] as any[], collectInput: null as any };
    const deps: EngagementReaderDeps = {
        profileExists: (id) => id === 'p1',
        gate: (id) => limiter.checkGates(id),
        launchFor: async (profileId, ctx) => {
            calls.launch.push({ profileId, ctx });
            if (opts.launchError) throw opts.launchError;
            opts.afterLaunch?.();
            return { ctx: {} as any, page: {} as any, close: async () => { calls.closed += 1; } };
        },
        collect: (async (input: any, d: any) => {
            calls.collectInput = input;
            if (opts.collectError) throw opts.collectError;
            await d.launch();
            const keys = await d.loadKeys();
            expect(keys.size).toBe(0);
            if (opts.rows?.length) await d.saveComments(opts.rows);
            return { scanned: 1, failed: 0, added: 0, results: [], ...(opts.loginProblem ? { loginProblem: opts.loginProblem } : {}) };
        }) as any,
        observeLogin: (id, state) => calls.observed.push([id, state]),
        now: () => h.now,
    };
    const count = (t: string) => db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    return { h, db, limiter, deps, calls, count };
}

describe('readEngagementComments', () => {
    it('readCommentsReturnsTrimmedListWithoutSaving', async () => {
        const rows = Array.from({ length: 60 }, (_, i) => row(i, i === 0 ? 'x'.repeat(700) : undefined));
        const s = setup({ rows });
        const out = await readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK });
        expect(out.comments).toHaveLength(50);
        expect(out.comments[0].text).toHaveLength(500);
        expect(Object.keys(out.comments[0]).sort()).toEqual(['authorName', 'commentedAt', 'text']);
        expect(JSON.stringify(out)).not.toMatch(/id0|authorId|authorUrl|facebook\.com\/id/);
        expect(s.calls.collectInput).toMatchObject({ posts: [{ postUrl: URL_OK }], maxPerPost: 50, stopOnLoginProblem: true });
        expect(s.calls.launch[0].ctx.priority).toBe('background');
        expect(s.calls.closed).toBe(1);
        expect(s.count('fb_poster_comments')).toBe(0);
        expect(s.count('fb_poster_leads')).toBe(0);
        expect(s.count('autonomy_actions')).toBe(0); // no cap counted
    });

    it('readCommentsRefusedInQuietHoursOrPaused', async () => {
        const s = setup({ rows: [row(1)] });
        s.h.now = T0 + 13 * 3_600_000; // 23:00 HCM, default quiet hours
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'quiet_hours' } });
        s.h.now = T0;
        s.limiter.pauseProfile('p1', 'checkpoint');
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'profile_paused' } });
        expect(s.calls.launch).toHaveLength(0);
        expect(s.db.queryOne<any>("SELECT COUNT(*) AS n FROM autonomy_actions WHERE status = 'blocked'")!.n).toBe(0);
    });

    it('readCommentsLoginProblemPausesProfile', async () => {
        const a = setup({ loginProblem: 'checkpoint' });
        await expect(readEngagementComments(a.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'checkpoint' } });
        expect(a.calls.observed).toEqual([['p1', 'checkpoint']]);
        const b = setup({ collectError: Object.assign(new Error('x'), { code: 'logged_out' }) });
        await expect(readEngagementComments(b.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'logged_out' } });
        expect(b.calls.observed).toEqual([['p1', 'logged_out']]);
    });

    it('validatesInputAndMapsBusyProfile', async () => {
        const s = setup();
        await expect(readEngagementComments(s.deps, { profileId: 'nope', postUrl: URL_OK })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: 'http://facebook.com/x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: 'https://evil.com/facebook.com/x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        const busy = setup({ collectError: Object.assign(new Error('Hết thời gian chờ profile'), { code: 'profile_wait_timeout' }) });
        await expect(readEngagementComments(busy.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'BUSY' });
        expect(busy.calls.observed).toEqual([]);
    });

    it('readCommentsContextCarriesShortDeadline', async () => {
        const s = setup({ rows: [row(1)] });
        await readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK });
        expect(s.calls.launch[0].ctx.deadlineAt).toBe(T0 + 60_000);
    });

    it('readCommentsRegatesAfterLaunch', async () => {
        let s: ReturnType<typeof setup>;
        s = setup({ rows: [row(1)], afterLaunch: () => s.limiter.pauseProfile('p1', 'checkpoint') });
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'profile_paused' } });
        expect(s.calls.closed).toBe(1);
    });

    it('readCommentsFailsIfWorkspaceChangedMidRead', async () => {
        const s = setup({ rows: [row(1)] });
        let stale = false;
        s.deps.assertCurrent = () => { if (stale) throw new Error('switching'); };
        s.deps.launchFor = async () => { stale = true; return { ctx: {} as any, page: {} as any, close: async () => undefined }; };
        await expect(readEngagementComments(s.deps, { profileId: 'p1', postUrl: URL_OK })).rejects.toMatchObject({ code: 'BUSY' });
    });
});
