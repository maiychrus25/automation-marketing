const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp', quit: jest.fn() }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
}));
// uuid và otplib (qua FacebookLoginHelper) là gói ESM, Jest không nạp được.
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../services/facebook/FacebookLoginHelper', () => ({ loginWithCredentials: jest.fn() }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockDb = { getFBAccount: jest.fn(), getFBAccountByFacebookId: jest.fn(), run: jest.fn(), updateFBAccountSession: jest.fn(), updateFBAccountProfile: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
jest.mock('../../services/facebook/FacebookAccountCookie', () => ({ resolveFBCookie: () => '', resolveFBProxyId: () => null }));
const mockInitSession = jest.fn();
const mockFetchHome = jest.fn();
jest.mock('../../services/facebook/FacebookSession', () => ({
  ...jest.requireActual('../../services/facebook/FacebookSession'),
  initSession: (...a: any[]) => mockInitSession(...a),
  fetchFBHomepage: (...a: any[]) => mockFetchHome(...a),
  fetchBasicProfileFromHome: async () => ({ name: 'Ten Moi', avatarUrl: 'http://a/b.png' }),
}));
const mockSecureSet = jest.fn();
jest.mock('../../services/secure/SecureSettingsService', () => ({ secureGet: jest.fn(), secureSet: (...a: any[]) => mockSecureSet(...a), secureDelete: jest.fn() }));
const mockRecordEvent = jest.fn();
const mockRecordCheck = jest.fn();
jest.mock('../../services/facebook/fbSessionEvents', () => ({
  ...jest.requireActual('../../services/facebook/fbSessionEvents'),
  recordFbSessionEvent: (...a: any[]) => mockRecordEvent(...a),
  recordCookieCheck: (...a: any[]) => mockRecordCheck(...a),
}));
jest.mock('../../services/facebook/facebookProxyChange', () => ({ forgetProxyChangeFailure: jest.fn(), reconnectPageChildren: jest.fn(async () => {}) }));

import * as ipc from '../../../electron/ipc/facebookIpc';

const ACC = 'acc-update-cookie';
const COOKIE = 'c_user=100000000001; xs=token';
const call = (payload: any) => handlers.get('fb:updateCookie')!({}, payload);

describe('Facebook cookie update', () => {
  beforeAll(() => { ipc.registerFacebookIpc(); });
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getFBAccount.mockReturnValue({ id: ACC, facebook_id: '100000000001', name: 'Ten Cu', avatar_url: '', parent_facebook_id: null });
    mockInitSession.mockResolvedValue({ FacebookID: '100000000001' });
    mockFetchHome.mockResolvedValue('<html/>');
  });

  test('aPageAccountIsRefused', async () => {
    mockDb.getFBAccount.mockReturnValue({ id: ACC, facebook_id: '1', parent_facebook_id: '2' });
    const res = await call({ accountId: ACC, cookie: COOKIE });
    expect(res.success).toBe(false);
    expect(res.error).toContain('tài khoản cá nhân');
    expect(mockSecureSet).not.toHaveBeenCalled();
  });

  test('anExpiredCookieReturnsTheProblemAndStoresNothing', async () => {
    mockInitSession.mockRejectedValue(Object.assign(new Error('checkpoint'), { fbSessionProblem: 'checkpoint' }));
    await expect(call({ accountId: ACC, cookie: COOKIE })).resolves.toMatchObject({ success: false, problem: 'checkpoint' });
    expect(mockSecureSet).not.toHaveBeenCalled();
  });

  test('aLiveCookieIsStoredAndRecordedAsByUser', async () => {
    await expect(call({ accountId: ACC, cookie: COOKIE })).resolves.toEqual({ success: true });
    expect(mockSecureSet).toHaveBeenCalledWith(`fb_cookie_${ACC}`, COOKIE);
    expect(mockRecordEvent).toHaveBeenCalledWith({ accountId: ACC, kind: 'cookie_updated', detail: 'by=user' });
  });

  test('theSharedStepRecordsByBrowser', async () => {
    await expect(ipc.applyFbAccountCookie(ACC, COOKIE, 'browser')).resolves.toEqual({ success: true });
    expect(mockSecureSet).toHaveBeenCalledWith(`fb_cookie_${ACC}`, COOKIE);
    expect(mockRecordEvent).toHaveBeenCalledWith({ accountId: ACC, kind: 'cookie_updated', detail: 'by=browser' });
  });

  test('applyFbAccountCookieNoLongerWritesThePlainCopy', async () => {
    await expect(call({ accountId: ACC, cookie: COOKIE })).resolves.toEqual({ success: true });
    const sqls = mockDb.run.mock.calls.map(c => String(c[0]));
    expect(sqls.some(q => q.includes('cookie_encrypted'))).toBe(false);
    expect(JSON.stringify(mockDb.run.mock.calls)).not.toContain(COOKIE);
  });
});
