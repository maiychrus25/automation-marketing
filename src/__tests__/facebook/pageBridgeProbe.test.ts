jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import Logger from '../../utils/Logger';
import { describeInboxPage, describeProbeEvent, isPageBridgeProbeEnabled, pageBridgeCookies, runPageBridgeProbe } from '../../services/facebook/pageBridgeProbe';

const PAGE = '100000000004280';
const COOKIE = `c_user=100000000008724; xs=tok; datr=d; fr=f; sb=s; wd=1x1; i_user=${PAGE}`;
const noPages = jest.fn().mockResolvedValue({ status: 200, finalUrl: 'https://www.facebook.com/messages/', html: '' });
const logged = () => (Logger.log as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');

const fakeBridge = (userId: string) => {
  const handlers: Record<string, (arg: any) => void> = {};
  return {
    handlers,
    on: jest.fn((name: string, cb: (arg: any) => void) => { handlers[name] = cb; }),
    spawn: jest.fn(),
    newClient: jest.fn().mockResolvedValue(undefined),
    connect: jest.fn().mockResolvedValue({ user: { id: userId } }),
    connectE2EE: jest.fn(),
    fetchMessages: jest.fn().mockResolvedValue({ messages: [{}, {}, {}], hasMoreBefore: true }),
    close: jest.fn().mockResolvedValue(undefined),
  };
};

describe('pageBridgeProbe', () => {
  beforeEach(() => (Logger.log as jest.Mock).mockClear());
  afterEach(() => { delete process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE; });

  test('onlyRunsWhenTheLaunchFlagIsSet', () => {
    expect(isPageBridgeProbeEnabled()).toBe(false);
    process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE = '1';
    expect(isPageBridgeProbeEnabled()).toBe(true);
  });

  test('cookiesKeepThePageSwitchAndDropUnrelatedOnes', () => {
    expect(pageBridgeCookies(COOKIE)).toEqual({ c_user: '100000000008724', xs: 'tok', datr: 'd', fr: 'f', sb: 's', i_user: PAGE });
    expect(pageBridgeCookies('c_user=1; xs=tok')).toBeNull(); // không phải cookie Page
    expect(pageBridgeCookies(`xs=tok; i_user=${PAGE}`)).toBeNull(); // thiếu c_user
  });

  test('eventSummariesNeverCarryMessageContent', () => {
    const s = describeProbeEvent({ type: 'message', data: { id: 'mid.$abcdef123456', threadId: 100000000005141, senderId: 100000000005141, text: 'SECRET TEXT', attachments: [{}], isHistory: true } });
    expect(s).toBe('message id=…123456 thread=…5141 sender=…5141 hasText=true attachments=1 isHistory=true');
    expect(describeProbeEvent({ type: 'raw', data: { from: 'lightspeed', type: 'LSTable', data: { LSInsertMessage: [{ Text: 'SECRET TEXT' }], LSUpsertMessage: [] } } }))
      .toBe('raw lightspeed/LSTable tables=LSInsertMessage,LSUpsertMessage');
    expect(describeProbeEvent({ type: 'ready', data: null })).toBe('ready');
  });

  test('connectsAsThePageWithoutE2EEAndFetchesHistoryOnceOnTheFirstLiveMessage', async () => {
    const bridge = fakeBridge(PAGE);
    const probe = await runPageBridgeProbe('acc-page-1', COOKIE, { createBridge: () => bridge as any, fetchPage: noPages });
    expect(bridge.newClient).toHaveBeenCalledWith(expect.objectContaining({ cookies: expect.objectContaining({ i_user: PAGE }), e2eeMemoryOnly: true }));
    expect(bridge.connect).toHaveBeenCalled();
    expect(bridge.connectE2EE).not.toHaveBeenCalled();
    expect(logged()).toContain('connected user=…4280 asPage=true');

    const live = { type: 'message', data: { id: 'mid.$1', threadId: '100000000005141', senderId: '100000000005141', text: 'SECRET TEXT' } };
    bridge.handlers.event(live);
    bridge.handlers.event(live);
    await new Promise(r => setImmediate(r));
    expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    expect(bridge.fetchMessages).toHaveBeenCalledWith(expect.objectContaining({ threadId: '100000000005141' }));
    expect(logged()).toContain('history thread=…5141 messages=3 hasMoreBefore=true');
    expect(logged()).not.toContain('SECRET');

    await probe!.close();
    expect(bridge.close).toHaveBeenCalled();
  });

  test('reportsWhenFacebookConnectsAsThePersonalAccountInstead', async () => {
    const bridge = fakeBridge('100000000008724');
    await runPageBridgeProbe('acc-page-1', COOKIE, { createBridge: () => bridge as any, fetchPage: noPages });
    expect(logged()).toContain('connected user=…8724 asPage=false');
  });

  test('aFailedConnectClosesTheBridgeAndReturnsNull', async () => {
    const bridge = fakeBridge(PAGE);
    bridge.connect.mockRejectedValue(new Error('boom'));
    await expect(runPageBridgeProbe('acc-page-1', COOKIE, { createBridge: () => bridge as any, fetchPage: noPages })).resolves.toBeNull();
    expect(bridge.close).toHaveBeenCalled();
  });

  test('aCookieWithoutThePageSwitchDoesNothing', async () => {
    const create = jest.fn();
    await expect(runPageBridgeProbe('acc-page-1', 'c_user=1; xs=tok', { createBridge: create, fetchPage: noPages })).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  // Trang Facebook trả về khi dùng cookie của Page: chỉ ghi dấu hiệu, không ghi nội dung.
  test('inboxPageSummaryListsIdentityMarkersWithoutContent', () => {
    const html = '<title>SECRET NAME</title>{"USER_ID":"100000000004280","ACCOUNT_ID":"100000000008724"} {"USER_ID":"0"} "CurrentUserInitialData" x "MessengerWebInitData" y';
    const s = describeInboxPage(html, 'https://business.facebook.com/latest/inbox/all?asset_id=123&x=SECRET', 200);
    expect(s).toBe(`page status=200 url=business.facebook.com/latest/inbox/all len=${html.length} userIds=…4280,0 accountIds=…8724 markers=CurrentUserInitialData,MessengerWebInitData`);
    expect(describeInboxPage('', 'not a url', 302)).toBe('page status=302 url=? len=0 userIds=- accountIds=- markers=-');
  });

  test('inspectsTheInboxPagesWithTheSameCookiesAsTheBridge', async () => {
    const bridge = fakeBridge(PAGE);
    const fetchPage = jest.fn().mockResolvedValue({ status: 200, finalUrl: 'https://www.facebook.com/messages/', html: '{"USER_ID":"0"}' });
    await runPageBridgeProbe('acc-page-1', COOKIE, { createBridge: () => bridge as any, fetchPage });
    expect(fetchPage).toHaveBeenCalledTimes(4);
    const control = fetchPage.mock.calls[3];
    expect(control[0]).toBe('https://www.facebook.com/messages/');
    expect(control[1]).not.toContain('i_user');
    expect(control[1]).toContain('c_user=100000000008724');
    const [url, cookieHeader] = fetchPage.mock.calls[0];
    expect(url).toBe('https://www.facebook.com/messages/');
    expect(cookieHeader).toContain(`i_user=${PAGE}`);
    expect(cookieHeader).not.toContain('wd=');
    expect(logged()).toContain('www.facebook.com/messages/ -> page status=200 url=www.facebook.com/messages/ len=15 userIds=0 accountIds=- markers=-');
  });

  test('aPageFetchErrorIsLoggedAndDoesNotStopTheProbe', async () => {
    const bridge = fakeBridge(PAGE);
    const fetchPage = jest.fn().mockRejectedValue(new Error('timeout'));
    await expect(runPageBridgeProbe('acc-page-1', COOKIE, { createBridge: () => bridge as any, fetchPage })).resolves.not.toBeNull();
    expect(logged()).toContain('fetch failed: timeout');
  });
});
