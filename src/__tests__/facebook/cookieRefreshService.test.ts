import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-cookie-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import Logger from '../../utils/Logger';
import DatabaseService from '../../services/database/DatabaseService';
import FacebookService, { BRIDGE_COOKIE_POLL_EVERY } from '../../services/facebook/FacebookService';
import { FacebookE2EEBridge } from '../../services/facebook/FacebookE2EEBridge';
import { secureGet } from '../../services/secure/SecureSettingsService';
import { resolveFBCookie } from '../../services/facebook/FacebookAccountCookie';

const ACC = 'acc-cookie-personal';
const FB = '100000000008724';
const PAGE_ACC = 'acc-cookie-page';
const PAGE_FB = '100000000004280';
const COOKIE = `c_user=${FB}; xs=old-xs; datr=d1; fr=old-fr`;
const logged = () => [...(Logger.log as jest.Mock).mock.calls, ...(Logger.warn as jest.Mock).mock.calls].map(c => String(c[0])).join('\n');

describe('FacebookService keeps the cookies Facebook refreshes', () => {
  const db = DatabaseService.getInstance();
  const personal = (): any => new (FacebookService as any)(ACC, COOKIE);

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: FB, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBPageAccount({ id: PAGE_ACC, facebook_id: PAGE_FB, name: 'Page', avatar_url: '', parent_facebook_id: FB, delegate_page_id: '1000000000003955', proxy_id: null });
  });
  beforeEach(() => { jest.clearAllMocks(); db.setSetting(`fb_cookie_${ACC}`, COOKIE); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('cookiesRefreshedOnTheHomepageAreUsedAndStored', () => {
    const svc = personal();
    svc.dataFB = { cookieFacebook: COOKIE };
    svc.adoptSessionCookie({ cookieFacebook: COOKIE.replace('old-xs', 'new-xs'), refreshedCookieNames: ['xs'] });
    expect(svc.cookie).toBe(COOKIE.replace('old-xs', 'new-xs'));
    expect(svc.dataFB.cookieFacebook).toBe(svc.cookie);
    expect(secureGet(`fb_cookie_${ACC}`)).toBe(svc.cookie);
    // Page con dựng cookie từ bản đã lưu của tài khoản cha: lần kết nối tới của Page dùng xs mới.
    expect(resolveFBCookie(db.getFBAccount(PAGE_ACC) as any)).toContain('xs=new-xs');
    expect(logged()).toContain('xs');
    expect(logged()).not.toMatch(/new-xs|old-xs/); // chỉ ghi tên cookie, không ghi giá trị
  });

  // Người dùng vừa dán cookie mới ở Dashboard (fb:updateCookie ghi thẳng vào kho) trong khi service đang chạy vẫn giữ cookie cũ.
  // Bản làm mới của cookie cũ không được ghi đè lên cookie người dùng vừa dán.
  test('aCookieTheUserReplacedMeanwhileIsNeverOverwritten', () => {
    const svc = personal();
    const pasted = `c_user=${FB}; xs=pasted-by-user; datr=d9; fr=f9`;
    db.setSetting(`fb_cookie_${ACC}`, pasted);
    svc.adoptSessionCookie({ cookieFacebook: COOKIE.replace('old-xs', 'new-xs'), refreshedCookieNames: ['xs'] });
    expect(secureGet(`fb_cookie_${ACC}`)).toBe(pasted);
    expect(svc.cookie).toContain('xs=new-xs'); // phiên đang chạy vẫn dùng bản mới của chính nó
  });

  test('aSessionWithoutRefreshedCookiesWritesNothing', () => {
    const svc = personal();
    const setSetting = jest.spyOn(db, 'setSetting');
    svc.adoptSessionCookie({ cookieFacebook: COOKIE });
    expect(svc.cookie).toBe(COOKIE);
    expect(setSetting).not.toHaveBeenCalled();
    setSetting.mockRestore();
  });

  test('cookiesTheBridgeHoldsAreMergedTheSameWay', () => {
    const svc = personal();
    svc.dataFB = { cookieFacebook: COOKIE };
    // Từ bridge chỉ nhận xs: fr / datr / sb của bridge có thể khác bản của app, nhận cả hai phía sẽ ghi qua ghi lại mãi.
    svc.adoptBridgeCookies({ c_user: FB, xs: 'bridge-xs', fr: 'bridge-fr', datr: 'bridge-datr', sb: 'bridge-sb', wd: '1x1', presence: 'p' });
    expect(svc.cookie).toBe(COOKIE.replace('old-xs', 'bridge-xs'));
    expect(secureGet(`fb_cookie_${ACC}`)).toBe(svc.cookie);

    const setSetting = jest.spyOn(db, 'setSetting');
    svc.adoptBridgeCookies({ c_user: FB, xs: 'bridge-xs' }); // không có gì mới
    svc.adoptBridgeCookies({ c_user: '100000000009999', xs: 'someone-else' }); // tài khoản khác
    svc.adoptBridgeCookies(null);
    expect(setSetting).not.toHaveBeenCalled();
    expect(svc.cookie).toContain('xs=bridge-xs');
    setSetting.mockRestore();
  });

  // Cookie của Page = cookie tài khoản cha + i_user, dựng lại mỗi lần kết nối: không lưu riêng.
  test('aPageUsesTheRefreshedCookieInMemoryButNeverStoresIt', () => {
    const pageCookie = `${COOKIE}; i_user=${PAGE_FB}`;
    const svc: any = new (FacebookService as any)(PAGE_ACC, pageCookie);
    const setSetting = jest.spyOn(db, 'setSetting');
    svc.adoptSessionCookie({ cookieFacebook: pageCookie.replace('old-xs', 'new-xs'), refreshedCookieNames: ['xs'] });
    expect(svc.cookie).toContain('xs=new-xs');
    expect(setSetting).not.toHaveBeenCalled();
    setSetting.mockRestore();
  });

  test('theBridgeIsAskedForItsCookiesEveryFewHeartbeats', async () => {
    const svc = personal();
    const bridge = { getCookies: jest.fn().mockResolvedValue({ c_user: FB, xs: 'bridge-xs' }) };
    svc.e2eeBridge = bridge;
    for (let beat = 1; beat < BRIDGE_COOKIE_POLL_EVERY; beat++) await svc.pollBridgeCookies(bridge, beat);
    expect(bridge.getCookies).not.toHaveBeenCalled();
    await svc.pollBridgeCookies(bridge, BRIDGE_COOKIE_POLL_EVERY);
    expect(bridge.getCookies).toHaveBeenCalledTimes(1);
    expect(svc.cookie).toContain('xs=bridge-xs');

    bridge.getCookies.mockRejectedValue(new Error('unknown method: getCookies')); // bridge cũ: bỏ qua, không ném lỗi
    await expect(svc.pollBridgeCookies(bridge, BRIDGE_COOKIE_POLL_EVERY * 2)).resolves.toBeUndefined();
  });

  // Bridge bị thay (cập nhật cookie, ngắt, khởi động lại) trong lúc đang chờ trả lời: cookie của bridge cũ không được dùng.
  test('theAnswerOfABridgeThatWasReplacedMeanwhileIsIgnored', async () => {
    const svc = personal();
    let answer: (v: any) => void = () => {};
    const oldBridge = { getCookies: jest.fn(() => new Promise(r => { answer = r; })) };
    svc.e2eeBridge = oldBridge;
    const polling = svc.pollBridgeCookies(oldBridge, BRIDGE_COOKIE_POLL_EVERY);
    svc.e2eeBridge = { getCookies: jest.fn() };
    answer({ c_user: FB, xs: 'stale-bridge-xs' });
    await polling;
    expect(svc.cookie).toBe(COOKIE);
  });

  test('theBridgeCommandIsACallThatNeverLogsItsResult', async () => {
    const bridge: any = Object.create(FacebookE2EEBridge.prototype);
    bridge.call = jest.fn().mockResolvedValue({ cookies: { c_user: FB, xs: 'bridge-xs' } });
    await expect(bridge.getCookies()).resolves.toEqual({ c_user: FB, xs: 'bridge-xs' });
    expect(bridge.call).toHaveBeenCalledWith('getCookies', {}, 5000);
    bridge.call.mockResolvedValue(null);
    await expect(bridge.getCookies()).resolves.toBeNull();
    expect(logged()).not.toContain('bridge-xs');
  });
});
