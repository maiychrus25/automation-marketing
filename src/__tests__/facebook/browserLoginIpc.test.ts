const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp', quit: jest.fn() }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
}));
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../services/facebook/FacebookLoginHelper', () => ({ loginWithCredentials: jest.fn() }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const settings: Record<string, string> = {};
const mockDb = {
  getFBAccount: jest.fn(), getFBAccountByFacebookId: jest.fn(), run: jest.fn(), updateFBAccountSession: jest.fn(), updateFBAccountProfile: jest.fn(),
  getSetting: jest.fn((k: string) => settings[k] ?? null), setSetting: jest.fn((k: string, v: string) => { settings[k] = v; }),
  getBrowserProfileById: jest.fn(() => ({ id: 'prof-1', proxy_id: null })), createBrowserProfile: jest.fn(() => ({ id: 'prof-1' })), updateBrowserProfile: jest.fn(),
};
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
jest.mock('../../services/facebook/FacebookAccountCookie', () => ({ resolveFBCookie: () => '', resolveFBProxyId: () => null }));
const mockInitSession = jest.fn();
jest.mock('../../services/facebook/FacebookSession', () => ({
  ...jest.requireActual('../../services/facebook/FacebookSession'),
  initSession: (...a: any[]) => mockInitSession(...a),
  fetchFBHomepage: async () => '<html/>',
  fetchBasicProfileFromHome: async () => ({ name: 'Ten', avatarUrl: '' }),
}));
const mockSecureSet = jest.fn();
jest.mock('../../services/secure/SecureSettingsService', () => ({ secureGet: jest.fn(), secureSet: (...a: any[]) => mockSecureSet(...a), secureDelete: jest.fn() }));
const mockRecordEvent = jest.fn();
jest.mock('../../services/facebook/fbSessionEvents', () => ({
  ...jest.requireActual('../../services/facebook/fbSessionEvents'),
  recordFbSessionEvent: (...a: any[]) => mockRecordEvent(...a),
  recordCookieCheck: jest.fn(),
}));
jest.mock('../../services/facebook/facebookProxyChange', () => ({ forgetProxyChangeFailure: jest.fn(), reconnectPageChildren: jest.fn(async () => {}) }));
const mockEmit = jest.fn();
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: (...a: any[]) => mockEmit(...a) } }));

const fakeService = { isRunning: jest.fn(), openForAutomation: jest.fn() };
let engineInstalled = true;
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({
  getBrowserProfileService: () => fakeService,
  isBrowserEngineInstalled: () => engineInstalled,
}));

import * as ipc from '../../../electron/ipc/facebookIpc';

const ACC = 'acc-browser-login';
const FB_ID = '100000000001';
const loginCookies = [
  { name: 'c_user', value: FB_ID, domain: '.facebook.com' },
  { name: 'xs', value: 'token', domain: '.facebook.com' },
];
const fakeContext = (cookies: any[]) => {
  const closeListeners: Array<() => void> = [];
  const page = { goto: jest.fn(async () => undefined) };
  const session = {
    context: {
      pages: () => [page], newPage: async () => page,
      cookies: jest.fn(async () => cookies),
      on: (ev: string, fn: () => void) => { if (ev === 'close') closeListeners.push(fn); },
    },
    close: jest.fn(async () => { closeListeners.forEach((fn) => fn()); }),
  };
  return session;
};
const call = (payload: any) => handlers.get('fb:loginWithBrowser')!({}, payload);

describe('Facebook browser login IPC', () => {
  beforeAll(() => { ipc.registerFacebookIpc(); });
  beforeEach(() => {
    jest.clearAllMocks();
    engineInstalled = true;
    fakeService.isRunning.mockReturnValue(false);
    mockDb.getFBAccount.mockReturnValue({ id: ACC, facebook_id: FB_ID, name: 'Ten', avatar_url: '', parent_facebook_id: null });
    mockInitSession.mockResolvedValue({ FacebookID: FB_ID });
  });

  test('employeesAreRefused', async () => {
    const res = await call({ accountId: ACC, _fromRelay: true });
    expect(res).toMatchObject({ success: false, code: 'BOSS_ONLY' });
    expect(fakeService.openForAutomation).not.toHaveBeenCalled();
  });

  test('pagesAreRefused', async () => {
    mockDb.getFBAccount.mockReturnValue({ id: ACC, facebook_id: '1', parent_facebook_id: '2' });
    const res = await call({ accountId: ACC });
    expect(res).toMatchObject({ success: false, code: 'PAGE_ACCOUNT' });
    expect(fakeService.openForAutomation).not.toHaveBeenCalled();
  });

  test('missingEngineIsExplained', async () => {
    engineInstalled = false;
    const res = await call({ accountId: ACC });
    expect(res).toMatchObject({ success: false, code: 'ENGINE_MISSING', error: 'Chưa cài trình duyệt của MaiHub. Vào mục Hồ sơ trình duyệt để cài.' });
  });

  test('aRunningLoginProfileIsReported', async () => {
    fakeService.isRunning.mockReturnValue(true);
    const res = await call({ accountId: ACC });
    expect(res).toMatchObject({ success: false, code: 'PROFILE_BUSY', error: 'Hồ sơ đăng nhập đang mở. Đóng cửa sổ đó rồi thử lại.' });
    expect(fakeService.openForAutomation).not.toHaveBeenCalled();
  });

  test('aSecondLoginForTheSameAccountIsRefusedWhileTheFirstRuns', async () => {
    const session = fakeContext([]);
    fakeService.openForAutomation.mockResolvedValue(session);
    const first = call({ accountId: ACC });
    await new Promise((r) => setImmediate(r));
    await expect(call({ accountId: ACC })).resolves.toMatchObject({ success: false, code: 'IN_PROGRESS' });
    await handlers.get('fb:cancelBrowserLogin')!({}, { accountId: ACC });
    await expect(first).resolves.toMatchObject({ code: 'CANCELLED' });
  });

  test('aMatchingLoginStoresTheCookieByBrowser', async () => {
    fakeService.openForAutomation.mockResolvedValue(fakeContext(loginCookies));
    await expect(call({ accountId: ACC })).resolves.toEqual({ success: true });
    expect(mockSecureSet).toHaveBeenCalledWith(`fb_cookie_${ACC}`, `c_user=${FB_ID}; xs=token`);
    expect(mockRecordEvent).toHaveBeenCalledWith({ accountId: ACC, kind: 'cookie_updated', detail: 'by=browser' });
    expect(mockEmit).toHaveBeenCalledWith('fb:browserLoginStatus', { accountId: ACC, status: 'saving' });
  });

  test('cancelStopsTheRunningLogin', async () => {
    fakeService.openForAutomation.mockResolvedValue(fakeContext([]));
    const started = Date.now();
    const running = call({ accountId: ACC });
    await new Promise((r) => setImmediate(r));
    await expect(handlers.get('fb:cancelBrowserLogin')!({}, { accountId: ACC })).resolves.toEqual({ success: true });
    await expect(running).resolves.toMatchObject({ success: false, code: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('aFailureRightAfterTheBrowserOpensClosesIt', async () => {
    const session = fakeContext([]);
    session.context.pages = () => [];
    session.context.newPage = async () => { throw new Error('boom'); };
    fakeService.openForAutomation.mockResolvedValue(session);
    await expect(call({ accountId: ACC })).resolves.toMatchObject({ success: false, code: 'OPEN_FAILED' });
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
