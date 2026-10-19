import { eligibleProfiles, pickGroupProfile, remainingToday } from '../../services/research/profileRotation';
import type { ProfileLoginState } from '../../models/facebookPoster';

const profiles = ['a', 'b', 'c', 'd'].map(id => ({ id, name: `P ${id}` }));
const login = (profileId: string, state: ProfileLoginState['state']): ProfileLoginState =>
    ({ profileId, state, checkedAt: null, source: null, lastError: null, lastErrorAt: null });
const base = {
    profiles, excluded: [], busyIds: [], loginStates: [], usedLast24h: {}, lastUsedAt: {},
    cap: 100, failedInScan: [],
};

describe('eligibleProfiles', () => {
    it('keeps all profiles in input order when nothing differs', () => {
        expect(eligibleProfiles(base)).toEqual(['a', 'b', 'c', 'd']);
    });
    it('drops excluded, busy, logged_out, checkpoint, capped and failed profiles', () => {
        const out = eligibleProfiles({
            ...base, profiles: [...profiles, { id: 'e', name: 'E' }, { id: 'f', name: 'F' }],
            excluded: ['a'], busyIds: ['b'],
            loginStates: [login('c', 'logged_out'), login('d', 'checkpoint')],
            usedLast24h: { e: 100 }, failedInScan: ['f'],
        });
        expect(out).toEqual([]);
    });
    it('treats unknown and missing login state as eligible', () => {
        expect(eligibleProfiles({ ...base, loginStates: [login('a', 'unknown'), login('b', 'ok')] }))
            .toEqual(['a', 'b', 'c', 'd']);
    });
    it('orders by fewest items in 24h, then least recently used, then input order', () => {
        const out = eligibleProfiles({
            ...base,
            usedLast24h: { a: 10, b: 0, c: 0, d: 0 },
            lastUsedAt: { b: 500, c: 100 },
        });
        // d never used -> first; c older than b; a has most items
        expect(out).toEqual(['d', 'c', 'b', 'a']);
    });
    it('restrictTo keeps only listed ids, still subject to other rules', () => {
        const out = eligibleProfiles({ ...base, restrictTo: ['b', 'c'], excluded: ['c'] });
        expect(out).toEqual(['b']);
    });
});

describe('pickGroupProfile', () => {
    const url = 'https://www.facebook.com/groups/123/';
    it('prefers the first eligible profile that joined the group (URLs normalized)', () => {
        const membership = { c: ['https://WWW.facebook.com/groups/123?ref=x#y'], d: [url], z: [url] };
        expect(pickGroupProfile(url, membership, ['a', 'c', 'd'])).toBe('c');
    });
    it('falls back to the first eligible profile when nobody joined', () => {
        expect(pickGroupProfile(url, { a: ['https://www.facebook.com/groups/999/'] }, ['b', 'a'])).toBe('b');
    });
    it('returns null with no eligible profiles', () => {
        expect(pickGroupProfile(url, { a: [url] }, [])).toBeNull();
    });
});

describe('remainingToday', () => {
    it('returns cap minus used, floored at 0', () => {
        expect(remainingToday('a', { a: 30 }, 100)).toBe(70);
        expect(remainingToday('a', {}, 100)).toBe(100);
        expect(remainingToday('a', { a: 150 }, 100)).toBe(0);
    });
});
