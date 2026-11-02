import { memoryDb } from '../facebookPoster/helpers';
import { AutonomyLimiter, type LimitRequest } from '../../services/autonomy/AutonomyLimiter';
import { ControlError } from '../../services/control/ControlMethods';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';

function zoneClock(zone: string): LocalClock {
    const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    return {
        date: (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; },
        minutes: (ms) => { const p = parts(ms); return Number(p.hour) * 60 + Number(p.minute); },
    };
}

// 10:00 local in each zone on 2026-11-03 (NY is EST, UTC-5).
const START: Record<string, number> = { [HCM]: Date.UTC(2026, 10, 3, 3, 0), [NY]: Date.UTC(2026, 10, 3, 15, 0) };

function setup(zone = HCM, enabled = true, writes = true) {
    const h = { now: START[zone], writes };
    const db = memoryDb();
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock: zoneClock(zone), protectedWritesEnabled: () => h.writes });
    limiter.ensureSchema();
    if (enabled) limiter.setPolicy({ enabled: true }, 'test');
    return { h, db, limiter };
}

const page = (over: Partial<LimitRequest> = {}): LimitRequest => ({ action: 'page_post', origin: 'api', profileId: 'p1', ...over });
function thrown(fn: () => unknown): ControlError {
    try { fn(); } catch (e) { return e as ControlError; }
    throw new Error('expected LIMIT_REACHED');
}
const count = (db: ReturnType<typeof memoryDb>, status: string) =>
    db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM autonomy_actions WHERE status = ?', [status])!.n;

describe.each([HCM, NY])('AutonomyLimiter (%s)', (zone) => {
    it('appOriginIsNotCountedExceptVideo', () => {
        const { limiter, db } = setup(zone, false, false);
        expect(limiter.reserve({ action: 'page_post', origin: 'app', profileId: 'p1' })).toBeNull();
        expect(() => limiter.check({ action: 'lead_reply', origin: 'app', profileId: 'p1' })).not.toThrow();
        const id = limiter.reserve({ action: 'video', origin: 'app' });
        expect(id).toEqual(expect.any(Number));
        expect(count(db, 'reserved')).toBe(1);
    });

    it('masterOffBlocksFacebookActionsOnly', () => {
        const { limiter, h } = setup(zone);
        h.writes = false;
        for (const action of ['page_post', 'group_post', 'lead_reply'] as const) {
            expect(thrown(() => limiter.check({ action, origin: 'api', profileId: 'p1', targetKey: 'g' })).details).toMatchObject({ reason: 'master_off', retryAt: null });
        }
        expect(() => limiter.check({ action: 'video', origin: 'api' })).not.toThrow();
        expect(() => limiter.check({ action: 'agent_run', origin: 'api' })).not.toThrow();
    });

    it('disabledBlocksAllApiActions', () => {
        const { limiter } = setup(zone, false);
        for (const action of ['page_post', 'group_post', 'lead_reply', 'video', 'agent_run'] as const) {
            expect(thrown(() => limiter.check({ action, origin: 'api', profileId: 'p1' })).details).toMatchObject({ reason: 'stopped' });
        }
    });

    it('quietHoursBlockFacebookActions', () => {
        const { limiter, h } = setup(zone);
        h.now += 13 * HOUR + 30 * MIN; // 23:30 local
        const err = thrown(() => limiter.check(page()));
        expect(err.details).toMatchObject({ reason: 'quiet_hours', retryAt: h.now + 7.5 * HOUR });
        expect(() => limiter.check({ action: 'agent_run', origin: 'api' })).not.toThrow();
    });

    it('pausedProfileBlockedUntilResume', () => {
        const { limiter } = setup(zone);
        expect(limiter.pauseProfile('p1', 'checkpoint')).toBe(true);
        expect(limiter.pauseProfile('p1', 'logged_out')).toBe(false);
        expect(limiter.pausedProfiles()).toMatchObject([{ profileId: 'p1', reason: 'checkpoint' }]);
        expect(thrown(() => limiter.check(page())).details).toMatchObject({ reason: 'profile_paused' });
        expect(() => limiter.check(page({ profileId: 'p2' }))).not.toThrow();
        expect(limiter.resumeProfile('p1')).toBe(true);
        expect(limiter.resumeProfile('p1')).toBe(false);
        expect(() => limiter.check(page())).not.toThrow();
    });

    it('perProfileDailyCaps', () => {
        const { limiter } = setup(zone);
        for (let i = 0; i < 3; i++) limiter.commit(limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: `g${i}` })!);
        expect(thrown(() => limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g9' })).details).toMatchObject({ reason: 'quota' });
        for (let i = 0; i < 9; i++) limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1' });
        // 3 group + 9 replies = 12 actions: next reply is under the reply cap (10) but over the total (12).
        expect(thrown(() => limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1' })).details).toMatchObject({ reason: 'quota' });
        expect(limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p2' })).toEqual(expect.any(Number));
        expect(limiter.usage().profiles.p1).toEqual({ pagePosts: 0, groupPosts: 3, leadReplies: 9, facebookActions: 12 });
    });

    it('groupRepeatWithinThreeDaysBlocked', () => {
        const { limiter, h } = setup(zone);
        limiter.commit(limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g1' })!);
        h.now += DAY;
        expect(thrown(() => limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g1' })).details).toMatchObject({ reason: 'quota' });
        expect(limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g2' })).not.toBeNull();
        h.now += 2 * DAY;
        expect(limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g1' })).not.toBeNull();
    });

    it('videoCapCountsBothOriginsAndBotKeepsLastSlot', () => {
        const { limiter } = setup(zone);
        limiter.commit(limiter.reserve({ action: 'video', origin: 'app' })!);
        expect(thrown(() => limiter.reserve({ action: 'video', origin: 'api' })).details).toMatchObject({ reason: 'quota' });
        limiter.setPolicy({ videoReserveLast: false }, 'test');
        expect(limiter.reserve({ action: 'video', origin: 'api' })).not.toBeNull();
        expect(thrown(() => limiter.reserve({ action: 'video', origin: 'app' })).details).toMatchObject({ reason: 'quota' });
        expect(limiter.usage().workspace.videos).toBe(2);
    });

    it('summaryCountsOnlyBotVideosWhileCapCountsBoth', () => {
        const { limiter } = setup(zone);
        limiter.setPolicy({ videoReserveLast: false, videosPerDay: 3 }, 'test');
        limiter.commit(limiter.reserve({ action: 'video', origin: 'app' })!);
        limiter.commit(limiter.reserve({ action: 'video', origin: 'api' })!);
        expect(limiter.usage().workspace.videos).toBe(2);
        expect(limiter.summary(0, Number.MAX_SAFE_INTEGER).videos).toBe(1);
    });

    it('botVideoDisabledWhenCapIsOneAndReserveLast', () => {
        const { limiter } = setup(zone);
        limiter.setPolicy({ videosPerDay: 1 }, 'test');
        expect(thrown(() => limiter.reserve({ action: 'video', origin: 'api' })).details).toMatchObject({ reason: 'quota' });
        expect(limiter.reserve({ action: 'video', origin: 'app' })).not.toBeNull();
        expect(thrown(() => limiter.reserve({ action: 'video', origin: 'app' })).details).toMatchObject({ reason: 'quota' });
    });

    it('groupRepeatRetryAtIsWhenWindowExpires', () => {
        const { limiter, h } = setup(zone);
        const first = h.now;
        limiter.commit(limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g1' })!);
        h.now += DAY;
        expect(thrown(() => limiter.reserve({ action: 'group_post', origin: 'api', profileId: 'p1', targetKey: 'g1' })).details)
            .toMatchObject({ reason: 'quota', retryAt: first + 3 * DAY });
    });

    it('commitReturnsFalseForReleasedOrUnknown', () => {
        const { limiter } = setup(zone);
        const id = limiter.reserve(page())!;
        expect(limiter.release(id)).toBe(true);
        expect(limiter.commit(id)).toBe(false);
        expect(limiter.commit(9999)).toBe(false);
        const live = limiter.reserve(page({ profileId: 'p2' }))!;
        expect(limiter.commit(live)).toBe(true);
        expect(limiter.commit(live)).toBe(false);
    });

    it('agentRunsCapWorkspaceWide', () => {
        const { limiter } = setup(zone);
        limiter.setPolicy({ agentRunsPerDay: 1 }, 'test');
        limiter.commit(limiter.reserve({ action: 'agent_run', origin: 'api' })!);
        expect(thrown(() => limiter.reserve({ action: 'agent_run', origin: 'api' })).details).toMatchObject({ reason: 'quota' });
    });

    it('quotaResetsAtLocalMidnight', () => {
        const { limiter, h } = setup(zone);
        limiter.commit(limiter.reserve(page())!);
        const err = thrown(() => limiter.reserve(page()));
        expect(err.details).toMatchObject({ reason: 'quota', retryAt: h.now + 14 * HOUR });
        h.now += 15 * HOUR; // 01:00 next day: new day but quiet hours
        expect(thrown(() => limiter.reserve(page())).details).toMatchObject({ reason: 'quiet_hours' });
        h.now += 7 * HOUR; // 08:00
        expect(limiter.reserve(page())).not.toBeNull();
    });

    it('clockRollbackDoesNotRefillQuota', () => {
        const { limiter, h } = setup(zone);
        limiter.commit(limiter.reserve(page())!);
        h.now -= 2 * DAY;
        expect(thrown(() => limiter.reserve(page())).details).toMatchObject({ reason: 'quota' });
    });

    it('releaseIsIdempotentAndCommittedRowsStayCounted', () => {
        const { limiter } = setup(zone);
        const id = limiter.reserve(page())!;
        expect(limiter.release(id)).toBe(true);
        expect(limiter.release(id)).toBe(false);
        const again = limiter.reserve(page())!;
        limiter.commit(again);
        expect(limiter.release(again)).toBe(false);
        expect(thrown(() => limiter.reserve(page())).details).toMatchObject({ reason: 'quota' });
    });

    it('blockedRowsAreRecordedButNotCounted', () => {
        const { limiter, db } = setup(zone);
        limiter.commit(limiter.reserve(page())!);
        thrown(() => limiter.reserve(page()));
        thrown(() => limiter.reserve(page()));
        expect(count(db, 'blocked')).toBe(2);
        expect(limiter.usage().profiles.p1.pagePosts).toBe(1);
        limiter.pauseProfile('p9', 'logged_out');
        expect(limiter.summary(0, Number.MAX_SAFE_INTEGER)).toEqual({ pagePosts: 1, groupPosts: 0, leadReplies: 0, videos: 0, blocked: 2, pauses: 1 });
    });

    it('assertEffectRechecksGatesWithoutCountingAgain', () => {
        const { limiter, h } = setup(zone);
        const id = limiter.reserve(page())!;
        expect(() => limiter.assertEffect(id)).not.toThrow();
        limiter.pauseProfile('p1', 'logged_out');
        expect(thrown(() => limiter.assertEffect(id)).details).toMatchObject({ reason: 'profile_paused' });
        limiter.resumeProfile('p1');
        h.writes = false;
        expect(thrown(() => limiter.assertEffect(id)).details).toMatchObject({ reason: 'master_off' });
    });

    it('policyChangesLoggedPerField', () => {
        const { limiter, h } = setup(zone, false);
        const { policy, changes } = limiter.setPolicy({ enabled: true, videosPerDay: 5, agentRunsPerDay: 12 }, 'owner');
        expect(policy.enabled).toBe(true);
        expect(changes).toEqual([
            { at: h.now, actor: 'owner', field: 'enabled', before: false, after: true },
            { at: h.now, actor: 'owner', field: 'videosPerDay', before: 2, after: 5 },
        ]);
        expect(limiter.policy().videosPerDay).toBe(5);
        expect(limiter.changes(0)).toHaveLength(2);
        h.now += 31 * DAY;
        limiter.setPolicy({ videosPerDay: 6 }, 'owner');
        expect(limiter.changes(0)).toHaveLength(1);
        expect(() => limiter.setPolicy({ bogus: 1 }, 'owner')).toThrow();
    });

    it('limitErrorCarriesReasonAndRetryAt', () => {
        const { limiter } = setup(zone, false);
        const err = thrown(() => limiter.check(page()));
        expect(err).toBeInstanceOf(ControlError);
        expect(err.code).toBe('LIMIT_REACHED');
        expect(err.details).toEqual({ reason: 'stopped', retryAt: null });
        expect(err.message).toMatch(/[ăâêôơưđ]/i);
    });
});
