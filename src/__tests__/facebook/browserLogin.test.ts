import { ensureLoginProfile, loginProfileKey } from '../../services/facebook/browserLogin/loginProfile';
import { readLoginCookie, BrowserCookie } from '../../services/facebook/browserLogin/browserLoginCookie';
import {
  runBrowserLogin,
  BrowserLoginStatus,
  BROWSER_LOGIN_POLL_MS,
  BROWSER_LOGIN_TIMEOUT_MS,
} from '../../services/facebook/browserLogin/runBrowserLogin';

const c = (name: string, value: string, domain = '.facebook.com'): BrowserCookie => ({ name, value, domain });
const login = (xs = 'a'): BrowserCookie[] => [c('c_user', '1'), c('xs', xs), c('datr', 'd')];

describe('readLoginCookie', () => {
  it('ignoresCookiesOfOtherSites', () => {
    const cookies = [c('c_user', '1', '.evil.com'), c('xs', 'a', 'notfacebook.com')];
    expect(readLoginCookie(cookies, '1')).toEqual({ state: 'waiting' });
  });
  it('waitsWhileXsIsMissing', () => {
    expect(readLoginCookie([c('c_user', '1'), c('xs', '')], '1')).toEqual({ state: 'waiting' });
    expect(readLoginCookie([c('c_user', '1')], '1')).toEqual({ state: 'waiting' });
  });
  it('refusesAnotherAccount', () => {
    expect(readLoginCookie(login(), '2')).toEqual({ state: 'wrong_account' });
  });
  it('buildsTheCookieStringOncePerName', () => {
    const cookies = [c('c_user', '1'), c('xs', 'a'), c('datr', 'd'), c('xs', 'b', 'facebook.com')];
    expect(readLoginCookie(cookies, '1')).toEqual({ state: 'ready', cookie: 'c_user=1; xs=a; datr=d' });
  });
});

function setup(opts: { reads: BrowserCookie[][]; applyResults?: Array<{ success: boolean; error?: string }>; closedAfterReads?: number }) {
  let clock = 1000;
  let reads = 0;
  let closed = false;
  const ac = new AbortController();
  const statuses: Array<[BrowserLoginStatus, string | undefined]> = [];
  const win = {
    readCookies: jest.fn(async () => opts.reads[Math.min(reads++, opts.reads.length - 1)]),
    isClosed: jest.fn(() => closed || (opts.closedAfterReads !== undefined && reads >= opts.closedAfterReads)),
    close: jest.fn(async () => { closed = true; }),
  };
  let applyCalls = 0;
  const applyCookie = jest.fn(async (_cookie: string) => {
    const list = opts.applyResults ?? [{ success: true }];
    return list[Math.min(applyCalls++, list.length - 1)];
  });
  const sleep = jest.fn(async (ms: number) => { clock += ms; });
  const deps = {
    open: jest.fn(async () => win),
    expectedFacebookId: '1',
    applyCookie,
    onStatus: (s: BrowserLoginStatus, d?: string) => { statuses.push([s, d]); },
    signal: ac.signal,
    sleep,
    now: () => clock,
  };
  return { deps, win, applyCookie, statuses, ac, sleep, setClosed: () => { closed = true; } };
}

describe('runBrowserLogin', () => {
  it('aMatchingLoginIsSavedAndTheWindowClosed', async () => {
    const t = setup({ reads: [[], login()] });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({ success: true });
    expect(t.applyCookie).toHaveBeenCalledTimes(1);
    expect(t.applyCookie).toHaveBeenCalledWith('c_user=1; xs=a; datr=d');
    expect(t.win.close).toHaveBeenCalled();
    expect(t.statuses.map(s => s[0])).toEqual(['opening', 'waiting', 'saving']);
  });

  it('aWrongAccountIsNeverSaved', async () => {
    const t = setup({ reads: [[c('c_user', '2'), c('xs', 'a')]], closedAfterReads: 3 });
    const r = await runBrowserLogin(t.deps);
    expect(t.applyCookie).not.toHaveBeenCalled();
    expect(t.statuses.map(s => s[0])).toContain('wrong_account');
    expect(r).toMatchObject({ success: false, code: 'CLOSED' });
  });

  it('aFailedCheckIsNotRetriedUntilTheCookieChanges', async () => {
    const t = setup({
      reads: [login('a'), login('a'), login('a'), login('a'), login('b')],
      applyResults: [{ success: false, error: 'bad cookie' }, { success: true }],
    });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({ success: true });
    expect(t.applyCookie).toHaveBeenCalledTimes(2);
    expect(t.applyCookie).toHaveBeenNthCalledWith(2, 'c_user=1; xs=b; datr=d');
    expect(t.statuses).toContainEqual(['check_failed', 'bad cookie']);
    expect(t.statuses.filter(s => s[0] === 'check_failed')).toHaveLength(1);
  });

  it('closingTheWindowEndsWithClosed', async () => {
    const t = setup({ reads: [[]], closedAfterReads: 2 });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({
      success: false, code: 'CLOSED', error: 'Đã đóng trình duyệt, chưa lấy được cookie',
    });
  });

  it('cancellingEndsWithCancelledAndClosesTheWindow', async () => {
    const t = setup({ reads: [[]] });
    t.sleep.mockImplementation(async () => { t.ac.abort(); });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({
      success: false, code: 'CANCELLED', error: 'Đã huỷ đăng nhập bằng trình duyệt',
    });
    expect(t.win.close).toHaveBeenCalled();
  });

  it('afterTenMinutesItTimesOut', async () => {
    const t = setup({ reads: [[]] });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({
      success: false, code: 'TIMEOUT', error: 'Quá 10 phút chưa đăng nhập xong, đã đóng trình duyệt',
    });
    expect(t.win.close).toHaveBeenCalled();
    expect(t.sleep).toHaveBeenCalledTimes(BROWSER_LOGIN_TIMEOUT_MS / BROWSER_LOGIN_POLL_MS);
  });

  it('closingTheWindowWhileSavingKeepsTheSaveResult', async () => {
    const t = setup({ reads: [login()] });
    t.applyCookie.mockImplementation(async () => { t.setClosed(); return { success: true }; });
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({ success: true });
  });

  it('aWindowThatCannotOpenIsReported', async () => {
    const t = setup({ reads: [[]] });
    t.deps.open.mockRejectedValue(new Error('no chrome'));
    await expect(runBrowserLogin(t.deps)).resolves.toEqual({ success: false, code: 'OPEN_FAILED', error: 'no chrome' });
    expect(t.statuses[0][0]).toBe('opening');
  });
});

describe('ensureLoginProfile', () => {
  const makeDb = (settings: Record<string, string> = {}, profiles: Record<string, { id: string; proxy_id: number | null }> = {}) => ({
    getSetting: jest.fn((k: string) => settings[k] ?? null),
    setSetting: jest.fn((k: string, v: string) => { settings[k] = v; }),
    getBrowserProfileById: jest.fn((id: string) => profiles[id] ?? null),
    createBrowserProfile: jest.fn((p: { id: string; proxy_id: number | null }) => { profiles[p.id] = { id: p.id, proxy_id: p.proxy_id }; return { id: p.id }; }),
    updateBrowserProfile: jest.fn(),
  });
  const run = (db: ReturnType<typeof makeDb>, proxyId: number | null = null, newId = () => 'p-new') =>
    ensureLoginProfile({ db, internalId: 'acc1', accountName: 'An', proxyId, newId });

  it('createsAProfileOnFirstUseAndRemembersIt', () => {
    const db = makeDb();
    expect(run(db, 7)).toBe('p-new');
    expect(db.createBrowserProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p-new', name: 'Đăng nhập Facebook – An', group_id: null, proxy_id: 7, note: 'Hồ sơ MaiHub dùng để lấy cookie Facebook',
      fingerprint: expect.any(Object),
    }));
    expect(db.setSetting).toHaveBeenCalledWith(loginProfileKey('acc1'), 'p-new');
  });
  it('reusesTheRememberedProfileAndFollowsTheAccountProxy', () => {
    const db = makeDb({ [loginProfileKey('acc1')]: 'p-old' }, { 'p-old': { id: 'p-old', proxy_id: 1 } });
    expect(run(db, 2)).toBe('p-old');
    expect(db.updateBrowserProfile).toHaveBeenCalledWith('p-old', { proxy_id: 2 });
    expect(db.createBrowserProfile).not.toHaveBeenCalled();
    const same = makeDb({ [loginProfileKey('acc1')]: 'p-old' }, { 'p-old': { id: 'p-old', proxy_id: 2 } });
    run(same, 2);
    expect(same.updateBrowserProfile).not.toHaveBeenCalled();
  });
  it('recreatesAProfileThatWasDeleted', () => {
    const db = makeDb({ [loginProfileKey('acc1')]: 'p-gone' });
    expect(run(db)).toBe('p-new');
    expect(db.setSetting).toHaveBeenCalledWith(loginProfileKey('acc1'), 'p-new');
  });
});
