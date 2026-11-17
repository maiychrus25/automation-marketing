import {
  FB_SESSION_EVENTS_KEY, FB_SESSION_EVENTS_MAX, appendFbSessionEvent, formatCookieRefreshDetail, readFbSessionEvents,
  recordCookieCheck, recordFbSessionEvent, type FbSessionEvent,
} from '../../services/facebook/fbSessionEvents';

const ev = (n: number): FbSessionEvent => ({ at: n, accountId: 'acc-a', kind: 'status', detail: `d${n}` });
const memDb = (initial?: string) => {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(FB_SESSION_EVENTS_KEY, initial);
  return { store, getSetting: (k: string) => store.get(k) ?? null, setSetting: (k: string, v: string) => { store.set(k, v); } };
};

describe('appendFbSessionEvent', () => {
  it('keeps newest last and drops the oldest beyond max', () => {
    let list: FbSessionEvent[] = [];
    for (let i = 1; i <= 5; i++) list = appendFbSessionEvent(list, ev(i), 3);
    expect(list.map((e) => e.at)).toEqual([3, 4, 5]);
  });
  it('defaults to 200', () => {
    expect(FB_SESSION_EVENTS_MAX).toBe(200);
    let list: FbSessionEvent[] = [];
    for (let i = 1; i <= 205; i++) list = appendFbSessionEvent(list, ev(i));
    expect(list).toHaveLength(200);
    expect(list[0].at).toBe(6);
  });
});

describe('formatCookieRefreshDetail', () => {
  it('formats names and stored', () => {
    expect(formatCookieRefreshDetail('homepage', ['xs', 'fr'], true)).toBe('source=homepage names=xs,fr stored=true');
  });
  it('drops names that contain = or are too long', () => {
    expect(formatCookieRefreshDetail('bridge', ['xs=secretvalue', 'a'.repeat(60), 'fr'], false)).toBe('source=bridge names=fr stored=false');
  });
});

describe('recordFbSessionEvent', () => {
  const now = () => 1000;
  it('starts a new list when the stored value is not JSON', () => {
    const db = memDb('not json');
    expect(() => recordFbSessionEvent({ accountId: 'acc-a', kind: 'status', detail: 'connected' }, { db, now })).not.toThrow();
    expect(readFbSessionEvents(db)).toEqual([{ at: 1000, accountId: 'acc-a', kind: 'status', detail: 'connected' }]);
  });
  it('works with no stored value and appends after', () => {
    const db = memDb();
    recordFbSessionEvent({ accountId: 'acc-a', kind: 'status', detail: 'a' }, { db, now });
    recordFbSessionEvent({ accountId: 'acc-a', kind: 'status', detail: 'b' }, { db, now });
    expect(readFbSessionEvents(db).map((e) => e.detail)).toEqual(['a', 'b']);
  });
  it('never throws when setSetting throws, and the stored list stays valid', () => {
    const db = memDb(JSON.stringify([ev(1)]));
    const bad = { getSetting: db.getSetting, setSetting: () => { throw new Error('disk'); } };
    expect(() => recordFbSessionEvent({ accountId: 'acc-a', kind: 'status', detail: 'x' }, { db: bad, now })).not.toThrow();
    expect(readFbSessionEvents(db)).toEqual([ev(1)]);
  });
  it('never throws when getSetting throws', () => {
    const bad = { getSetting: () => { throw new Error('x'); }, setSetting: () => {} };
    expect(() => recordFbSessionEvent({ accountId: 'a', kind: 'status', detail: 'x' }, { db: bad })).not.toThrow();
    expect(readFbSessionEvents(bad)).toEqual([]);
  });
  it('a cookie value passed as a name never reaches the record', () => {
    const db = memDb();
    const secret = 'xs=SECRETVALUE123';
    recordFbSessionEvent({ accountId: 'acc-a', kind: 'cookie_refreshed', detail: formatCookieRefreshDetail('homepage', [secret, 'SECRETVALUE123x'.repeat(4)], true) }, { db, now });
    expect(db.store.get(FB_SESSION_EVENTS_KEY)).not.toContain('SECRETVALUE123');
  });
});

describe('recordCookieCheck', () => {
  it('records the same detail for an account at most once per 60 s', () => {
    const db = memDb();
    let t = 0;
    const deps = { db, now: () => t };
    recordCookieCheck('acc-d', 'alive', deps);
    t = 30_000; recordCookieCheck('acc-d', 'alive', deps);
    t = 30_001; recordCookieCheck('acc-d', 'expired problem=logged_out', deps);
    t = 61_000; recordCookieCheck('acc-d', 'alive', deps);
    expect(readFbSessionEvents(db).map((e) => [e.kind, e.detail])).toEqual([
      ['cookie_check', 'alive'], ['cookie_check', 'expired problem=logged_out'], ['cookie_check', 'alive'],
    ]);
  });
});
