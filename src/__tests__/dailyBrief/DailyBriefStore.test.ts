import { memoryDb } from '../facebookPoster/helpers';
import {
    BRIEF_MAX_ATTEMPTS_PER_DAY, BRIEF_MAX_ROWS, BRIEF_NOT_RUNNING_ERROR, BRIEF_STALE_MS,
    DailyBriefStore, systemClock,
} from '../../services/dailyBrief/DailyBriefStore';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import type { PageIdentity } from '../../models/dailyBrief';

const clock: LocalClock = {
    date: (ms) => new Date(ms).toISOString().slice(0, 10),
    minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
};
const at = (time: string) => Date.parse(`2026-10-${time}Z`);
const eligible = () => true;

function setup() {
    const db = memoryDb();
    const store = new DailyBriefStore(db, clock);
    store.ensureSchema();
    return { db, store };
}

const identity = (profileId = 'p1'): PageIdentity => ({
    profileId, kind: 'page', pageId: '123', pageName: 'Driving school', category: 'Education',
    about: 'Driving lessons', learnedAt: at('26T06:00:00'), errorCode: '', error: '',
    recentPosts: [
        { text: 'First lesson', reactions: 12, comments: 0, shares: null, postedAt: at('25T07:00:00'), url: 'https://fb.test/123/posts/1' },
        { text: 'Next lesson', reactions: null, comments: null, shares: 0, postedAt: null, url: 'https://fb.test/123/posts/2' },
    ],
});

describe('DailyBriefStore', () => {
    it('exports the exact limits and user-facing error', () => {
        expect(BRIEF_MAX_ATTEMPTS_PER_DAY).toBe(3);
        expect(BRIEF_STALE_MS).toBe(3600000);
        expect(BRIEF_MAX_ROWS).toBe(10);
        expect(BRIEF_NOT_RUNNING_ERROR).toBe('Kế hoạch Page không ở trạng thái đang chạy');
    });

    it('uses machine-local date and minutes in systemClock', () => {
        const now = new Date(2026, 0, 2, 3, 4).getTime();
        expect(systemClock.date(now)).toBe('2026-01-02');
        expect(systemClock.minutes(now)).toBe(184);
        expect(systemClock.minutes(new Date(2026, 0, 2, 23, 59).getTime())).toBe(1439);
    });

    it('creates both tables idempotently with claimed_date', () => {
        const { db, store } = setup();
        expect(() => store.ensureSchema()).not.toThrow();
        const names = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
        expect(names).toEqual(expect.arrayContaining(['fb_page_identities', 'daily_briefs']));
        expect(db.query<{ name: string; type: string }>('PRAGMA table_info(daily_briefs)'))
            .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'claimed_date', type: 'TEXT' })]));
    });

    it('round-trips identity JSON and replaces the row for the same profile', () => {
        const { store } = setup();
        expect(store.getIdentity('p1')).toBeUndefined();
        const first = identity();
        store.upsertIdentity(first);
        expect(store.getIdentity('p1')).toEqual(first);
        const replacement: PageIdentity = {
            ...first, kind: 'unknown', pageId: '', pageName: '', category: '', about: '', recentPosts: [],
            learnedAt: at('26T08:00:00'), errorCode: 'checkpoint', error: 'Cần kiểm tra đăng nhập',
        };
        store.upsertIdentity(replacement);
        expect(store.getIdentity('p1')).toEqual(replacement);
        expect(store.listIdentities()).toEqual([replacement]);
    });

    it('lists all learned identities independently of briefs', () => {
        const { store } = setup();
        expect(store.listIdentities()).toEqual([]);
        const person: PageIdentity = { ...identity('p2'), kind: 'person', pageId: '', pageName: '', recentPosts: [] };
        store.upsertIdentity(person);
        store.upsertIdentity(identity());
        expect(store.listIdentities()).toHaveLength(2);
        expect(store.listIdentities()).toEqual(expect.arrayContaining([identity(), person]));
        expect(store.countBriefs()).toBe(0);
    });

    it('creates briefs with defaults without performing Control API validation', () => {
        const { store } = setup();
        const now = at('26T06:00:00');
        expect(store.getBrief('p1')).toBeUndefined();
        const saved = store.saveBrief('p1', {}, now);
        expect(saved).toEqual({
            profileId: 'p1', niche: '', keywords: [], groupIds: [], tone: '', notes: '',
            time: '07:00', draftsPerDay: 1, enabled: true, lastRunDate: null, status: 'idle',
            attemptDate: null, attempts: 0, claimedAt: null, claimedDate: null, updatedAt: now,
        });
        expect(store.getBrief('p1')).toEqual(saved);
    });

    it('only patches supplied configuration and preserves running state', () => {
        const { store } = setup();
        expect(store.saveBrief('p1', {
            niche: 'Driving', keywords: ['lessons', 'road safety'], groupIds: ['g1', 'g2'],
            tone: 'Friendly', notes: 'Beginner tips', time: '06:30', draftsPerDay: 2,
        }, at('26T06:00:00'))).toMatchObject({
            niche: 'Driving', keywords: ['lessons', 'road safety'], groupIds: ['g1', 'g2'],
            tone: 'Friendly', notes: 'Beginner tips', time: '06:30', draftsPerDay: 2,
        });
        const [claimed] = store.claimDue(at('26T07:00:00'), eligible);
        const updated = store.saveBrief('p1', { notes: '', keywords: [], groupIds: [], enabled: false }, at('26T07:01:00'));
        expect(updated).toEqual({ ...claimed, notes: '', keywords: [], groupIds: [], enabled: false, updatedAt: at('26T07:01:00') });
        expect(store.saveBrief('p1', { niche: 'Safety', tone: 'Calm', time: '08:00', draftsPerDay: 5, enabled: true }, at('26T07:02:00')))
            .toEqual({ ...updated, niche: 'Safety', tone: 'Calm', time: '08:00', draftsPerDay: 5, enabled: true, updatedAt: at('26T07:02:00') });
        expect(store.getBrief('p1')).toEqual(store.saveBrief('p1', {}, at('26T07:02:00')));
    });

    it('lists, counts and deletes briefs without removing identities', () => {
        const { store } = setup();
        expect(store.listBriefs()).toEqual([]);
        expect(store.countBriefs()).toBe(0);
        store.upsertIdentity(identity());
        const first = store.saveBrief('p1', { keywords: ['a'] }, 1);
        const second = store.saveBrief('p2', { keywords: ['b'], enabled: false }, 2);
        expect(store.listBriefs()).toEqual(expect.arrayContaining([first, second]));
        expect(store.countBriefs()).toBe(2);
        expect(store.deleteBrief('p1')).toBe(true);
        expect(store.deleteBrief('p1')).toBe(false);
        expect(store.deleteBrief('missing')).toBe(false);
        expect(store.getBrief('p1')).toBeUndefined();
        expect(store.getIdentity('p1')).toEqual(identity());
        expect(store.listBriefs()).toEqual([second]);
        expect(store.countBriefs()).toBe(1);
    });

    it('claims at the scheduled minute and does not claim twice across store instances', () => {
        const { db, store } = setup();
        store.saveBrief('p1', { time: '07:00' }, at('26T06:00:00'));
        expect(store.claimDue(at('26T06:59:00'), eligible)).toEqual([]);
        const [claimed] = store.claimDue(at('26T07:00:00'), eligible);
        expect(claimed).toEqual(store.getBrief('p1'));
        expect(claimed).toMatchObject({
            profileId: 'p1', status: 'running', claimedAt: at('26T07:00:00'), claimedDate: '2026-10-26',
            attemptDate: '2026-10-26', attempts: 0, updatedAt: at('26T07:00:00'),
        });
        expect(store.claimDue(at('26T07:00:00'), eligible)).toEqual([]);
        expect(new DailyBriefStore(db, clock).claimDue(at('26T07:00:00'), eligible)).toEqual([]);
    });

    it('stops after three failures and resets attempts on the next day', () => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        for (let failures = 0; failures < 3; failures++) {
            const claims = store.claimDue(now, eligible);
            expect(claims).toEqual([expect.objectContaining({ attempts: failures })]);
            expect(store.finishBrief('p1', false, now + 1, claims[0].claimedAt!)).toMatchObject({
                status: 'idle', attempts: failures + 1, attemptDate: '2026-10-26', lastRunDate: null, updatedAt: now + 1,
            });
        }
        expect(store.claimDue(now + 2, eligible)).toEqual([]);
        expect(store.claimDue(at('27T07:00:00'), eligible)).toEqual([
            expect.objectContaining({ attempts: 0, attemptDate: '2026-10-27', claimedDate: '2026-10-27' }),
        ]);
    });

    it.each([3599999, 3600000, 3600001])('reclaims stale work at the one-hour boundary (%i ms)', (elapsed) => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        store.claimDue(now, eligible);
        const claims = store.claimDue(now + elapsed, eligible);
        if (elapsed < 3600000) {
            expect(claims).toEqual([]);
            expect(store.getBrief('p1')).toMatchObject({ attempts: 0, claimedAt: now });
        } else {
            expect(claims).toEqual([expect.objectContaining({ attempts: 1, claimedAt: now + elapsed, claimedDate: '2026-10-26' })]);
        }
    });

    it('counts stale claims toward the same daily failure limit', () => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        store.claimDue(now, eligible);
        expect(store.claimDue(now + 3600001, eligible)[0].attempts).toBe(1);
        expect(store.claimDue(now + 7200002, eligible)[0].attempts).toBe(2);
        expect(store.claimDue(now + 10800003, eligible)).toEqual([]);
        expect(store.claimDue(at('27T07:00:00'), eligible)[0].attempts).toBe(0);
    });

    it('does not charge a previous-day stale claim against the new day', () => {
        const { store } = setup();
        const now = at('26T23:50:00');
        store.saveBrief('p1', {}, now);
        for (let failures = 0; failures < 2; failures++) {
            const [claimed] = store.claimDue(now, eligible);
            store.finishBrief('p1', false, now, claimed.claimedAt!);
        }
        store.claimDue(now, eligible);
        expect(store.claimDue(at('27T07:00:00'), eligible)).toEqual([
            expect.objectContaining({ attempts: 0, attemptDate: '2026-10-27', claimedDate: '2026-10-27' }),
        ]);
    });

    it('does not reclaim a recent running claim just because the day changed', () => {
        const { store } = setup();
        store.saveBrief('p1', { time: '00:00' }, at('26T23:50:00'));
        store.claimDue(at('26T23:50:00'), eligible);
        expect(store.claimDue(at('27T00:10:00'), eligible)).toEqual([]);
    });

    it('does not claim again after a successful finish on the same day', () => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        const [claimed] = store.claimDue(now, eligible);
        expect(store.finishBrief('p1', true, now + 1, claimed.claimedAt!)).toMatchObject({ status: 'idle', lastRunDate: '2026-10-26', attempts: 0, updatedAt: now + 1 });
        expect(store.claimDue(at('26T18:00:00'), eligible)).toEqual([]);
    });

    it('finishes after midnight for the claimed day and still claims the next morning', () => {
        const { store } = setup();
        store.saveBrief('p1', {}, at('26T23:50:00'));
        const [claimed] = store.claimDue(at('26T23:50:00'), eligible);
        expect(store.finishBrief('p1', true, at('27T00:10:00'), claimed.claimedAt!).lastRunDate).toBe('2026-10-26');
        expect(store.claimDue(at('27T07:00:00'), eligible)).toEqual([
            expect.objectContaining({ profileId: 'p1', claimedDate: '2026-10-27', attempts: 0 }),
        ]);
    });

    it('attributes a failed finish after midnight to the claimed day', () => {
        const { store } = setup();
        store.saveBrief('p1', {}, at('26T23:50:00'));
        const [claimed] = store.claimDue(at('26T23:50:00'), eligible);
        expect(store.finishBrief('p1', false, at('27T00:10:00'), claimed.claimedAt!)).toMatchObject({ attempts: 1, attemptDate: '2026-10-26', status: 'idle' });
        expect(store.claimDue(at('27T07:00:00'), eligible)[0].attempts).toBe(0);
    });

    it('rejects completion of claim A after stale reclaim B without closing B', () => {
        const { store } = setup();
        store.saveBrief('p1', {}, at('26T23:50:00'));
        const [claimA] = store.claimDue(at('26T23:50:00'), eligible);
        const [claimB] = store.claimDue(at('27T07:00:00'), eligible);
        expect(claimA).toMatchObject({ claimedAt: at('26T23:50:00'), claimedDate: '2026-10-26' });
        expect(claimB).toMatchObject({ status: 'running', claimedAt: at('27T07:00:00'), claimedDate: '2026-10-27' });
        expect(() => store.finishBrief('p1', true, at('27T07:01:00'), claimA.claimedAt!))
            .toThrow(new Error(BRIEF_NOT_RUNNING_ERROR));
        expect(store.getBrief('p1')).toEqual(claimB);
        expect(() => store.finishBrief('p1', false, at('27T07:02:00'), claimA.claimedAt!))
            .toThrow(new Error(BRIEF_NOT_RUNNING_ERROR));
        expect(store.getBrief('p1')).toEqual(claimB);
        const finished = store.finishBrief('p1', true, at('27T07:03:00'), claimB.claimedAt!);
        expect(finished).toMatchObject({ status: 'idle', lastRunDate: '2026-10-27', claimedAt: claimB.claimedAt });
        expect(store.getBrief('p1')).toEqual(finished);
    });

    it('leaves ineligible profiles idle', () => {
        const { store } = setup();
        const saved = store.saveBrief('p1', {}, at('26T06:00:00'));
        expect(store.claimDue(at('26T07:00:00'), () => false)).toEqual([]);
        expect(store.getBrief('p1')).toEqual(saved);
        expect(store.claimDue(at('26T07:00:00'), eligible)).toHaveLength(1);
    });

    it('never claims disabled briefs', () => {
        const { store } = setup();
        const saved = store.saveBrief('p1', { enabled: false }, at('26T06:00:00'));
        expect(store.claimDue(at('26T07:00:00'), eligible)).toEqual([]);
        expect(store.claimDue(at('27T07:00:00'), eligible)).toEqual([]);
        expect(store.getBrief('p1')).toEqual(saved);
    });

    it.each([true, false])('rejects finishing idle or missing briefs (ok=%s)', (ok) => {
        const { store } = setup();
        const saved = store.saveBrief('p1', {}, 1);
        expect(() => store.finishBrief('p1', ok, 2, 0)).toThrow(new Error(BRIEF_NOT_RUNNING_ERROR));
        expect(() => store.finishBrief('missing', ok, 2, 0)).toThrow(new Error(BRIEF_NOT_RUNNING_ERROR));
        expect(store.getBrief('p1')).toEqual(saved);
    });

    it('claims enabled rows in profile order and rolls back the transaction on failure', () => {
        const { store } = setup();
        store.saveBrief('p2', {}, at('26T06:00:00'));
        store.saveBrief('p1', {}, at('26T06:00:00'));
        const visited: string[] = [];
        expect(() => store.claimDue(at('26T07:00:00'), (profileId) => {
            visited.push(profileId);
            if (profileId === 'p2') throw new Error('Eligibility unavailable');
            return true;
        })).toThrow('Eligibility unavailable');
        expect(visited).toEqual(['p1', 'p2']);
        expect(store.listBriefs()).toEqual([
            expect.objectContaining({ profileId: 'p1', status: 'idle', claimedAt: null }),
            expect.objectContaining({ profileId: 'p2', status: 'idle', claimedAt: null }),
        ]);
        expect(store.claimDue(at('26T07:00:00'), eligible).map((brief) => brief.profileId)).toEqual(['p1', 'p2']);
    });
});


describe('expired settlement regression', () => {
    it.each([0, 2])('persists the third failure with %i explicit failures, once', (explicit) => {
        const { store } = setup();
        let now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        for (let i = 0; i < explicit; i++) {
            const [claim] = store.claimDue(now, eligible);
            store.finishBrief('p1', false, now++, claim.claimedAt!);
        }
        const expired = jest.fn();
        store.claimDue(now, eligible);
        for (let i = explicit; i < 3; i++) {
            now += 3600000;
            store.claimDue(now, eligible, undefined, expired);
        }
        expect(store.getBrief('p1')).toMatchObject({ status: 'idle', attempts: 3, attemptDate: '2026-10-26' });
        const before = store.getBrief('p1');
        store.claimDue(now + 1, eligible, undefined, expired);
        expect(store.getBrief('p1')).toEqual(before);
        expect(expired.mock.calls.map(([b]) => b.attempts)).toEqual(explicit ? [3] : [1, 2, 3]);
        expect(() => store.finishBrief('p1', true, now, before!.claimedAt!)).toThrow(BRIEF_NOT_RUNNING_ERROR);
    });

    it.each(['ineligible', 'disabled', 'future-time'] as const)('settles %s work before testing reclaim eligibility', (mode) => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now);
        store.claimDue(now, eligible);
        if (mode === 'disabled') store.saveBrief('p1', { enabled: false }, now);
        if (mode === 'future-time') store.saveBrief('p1', { time: '23:59' }, now);
        const expired = jest.fn();
        expect(store.claimDue(now + 3600000, () => mode !== 'ineligible', undefined, expired)).toEqual([]);
        expect(store.getBrief('p1')).toMatchObject({ status: 'idle', attempts: 1, attemptDate: '2026-10-26' });
        store.claimDue(now + 7200000, () => false, undefined, expired);
        expect(expired).toHaveBeenCalledTimes(1);
    });

    it('snapshots the expired claimed day before resetting the next claim', () => {
        const { store } = setup();
        const now = at('26T23:50:00');
        store.saveBrief('p1', {}, now);
        for (let i = 0; i < 2; i++) {
            const [b] = store.claimDue(now, eligible);
            store.finishBrief('p1', false, now, b.claimedAt!);
        }
        store.claimDue(now, eligible);
        const expired = jest.fn();
        expect(store.claimDue(at('27T07:00:00'), eligible, undefined, expired)[0]).toMatchObject({ attempts: 0, attemptDate: '2026-10-27' });
        expect(expired).toHaveBeenCalledWith(expect.objectContaining({ status: 'idle', attempts: 3, attemptDate: '2026-10-26' }));
    });

    it('does not publish expired outcomes when a later eligibility check rolls back', () => {
        const { store } = setup();
        const now = at('26T07:00:00');
        store.saveBrief('p1', {}, now); store.saveBrief('p2', {}, now);
        store.claimDue(now, eligible);
        const before = store.listBriefs();
        const expired = jest.fn();
        expect(() => store.claimDue(now + 3600000, (id) => {
            if (id === 'p2') throw new Error('rollback');
            return true;
        }, undefined, expired)).toThrow('rollback');
        expect(store.listBriefs()).toEqual(before);
        expect(expired).not.toHaveBeenCalled();
    });
});
