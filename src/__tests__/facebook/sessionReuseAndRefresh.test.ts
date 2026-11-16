jest.mock('axios');
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import axios from 'axios';
import {
  SESSION_REUSE_MS, checkCookieState, fetchFBHomepage, forgetRecentSessions, initSession, isTransientFacebookError,
} from '../../services/facebook/FacebookSession';

const get = axios.get as jest.Mock;
const COOKIE = 'c_user=100000000008724; xs=old-xs; datr=d1; fr=old-fr';
const HOME = 'DTSGInitialData",[],{"token":"TOKEN"} async_get_token":"AG" jazoest=22" hash":"H" sessionId":"S1" "actorID":"100000000008724" client_revision":123,';
const page = (setCookie?: string[]) => ({ data: HOME, headers: setCookie ? { 'set-cookie': setCookie } : {} });

describe('initSession', () => {
  beforeEach(() => { jest.clearAllMocks(); forgetRecentSessions(); jest.useFakeTimers().setSystemTime(1_800_000_000_000); });
  afterEach(() => jest.useRealTimers());

  test('cookiesFacebookRefreshesAreMergedIntoTheSessionCookie', async () => {
    get.mockResolvedValue(page(['xs=new-xs; Max-Age=31536000; path=/; secure', 'fr=new-fr; path=/', 'presence=p; path=/']));
    const session = await initSession(COOKIE);
    expect(session.cookieFacebook).toBe('c_user=100000000008724; xs=new-xs; datr=d1; fr=new-fr');
    expect(session.refreshedCookieNames).toEqual(['xs', 'fr']);
    expect(session.fb_dtsg).toBe('TOKEN');
  });

  test('withoutRefreshedCookiesTheSessionKeepsTheGivenCookie', async () => {
    get.mockResolvedValue(page());
    const session = await initSession(COOKIE);
    expect(session.cookieFacebook).toBe(COOKIE);
    expect(session.refreshedCookieNames).toBeUndefined();
  });

  // Lúc mở app, mỗi tài khoản từng tải trang chủ Facebook ba lần liên tiếp (kiểm tra cookie, kết nối, giao diện kiểm tra lại).
  test('aSecondCallWithinTheReuseWindowDoesNotLoadTheHomepageAgain', async () => {
    get.mockResolvedValue(page(['xs=new-xs; path=/']));
    const first = await initSession(COOKIE);
    expect(await checkCookieState(COOKIE)).toBe('alive');
    const again = await initSession(COOKIE);
    expect(get).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
    expect(again).not.toBe(first); // bản sao: bên gọi sửa session của mình không làm đổi bản đang nhớ
    again.fb_dtsg = 'changed';
    expect((await initSession(COOKIE)).fb_dtsg).toBe('TOKEN');

    jest.setSystemTime(Date.now() + SESSION_REUSE_MS + 1);
    await initSession(COOKIE);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('theRefreshedCookieAlsoFindsTheRememberedSession', async () => {
    get.mockResolvedValue(page(['xs=new-xs; path=/']));
    const first = await initSession(COOKIE);
    await initSession(first.cookieFacebook); // bên gọi đã chuyển sang cookie mới
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('differentCookiesAndFailuresAreNeverReused', async () => {
    get.mockResolvedValue(page());
    await initSession(COOKIE);
    await initSession(`${COOKIE}; i_user=100000000004280`); // Page: phiên riêng
    expect(get).toHaveBeenCalledTimes(2);

    forgetRecentSessions();
    get.mockReset();
    get.mockResolvedValueOnce({ data: '<html>login</html>', headers: {} }).mockResolvedValueOnce(page());
    await expect(initSession(COOKIE)).rejects.toThrow('Missing required session fields');
    await expect(initSession(COOKIE)).resolves.toMatchObject({ fb_dtsg: 'TOKEN' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  // Đổi proxy rồi nối lại trong vòng 60 giây: lần kiểm tra phải thật sự đi qua proxy mới, không lấy kết quả đã nhớ của đường cũ.
  test('aRememberedSessionIsNotReusedForADifferentProxy', async () => {
    get.mockResolvedValue(page());
    await initSession(COOKIE, 'AGENT-A');
    await initSession(COOKIE, 'AGENT-A');
    expect(get).toHaveBeenCalledTimes(1);
    await initSession(COOKIE, 'AGENT-B');
    await initSession(COOKIE);
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[1][1]).toMatchObject({ httpsAgent: 'AGENT-B' });
  });

  test('aCallerThatNeedsFreshTokensBypassesTheRememberedSession', async () => {
    get.mockResolvedValue(page());
    await initSession(COOKIE);
    await initSession(COOKIE, undefined, { fresh: true });
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('theHomepageRequestGoesThroughTheGivenProxyAgent', async () => {
    get.mockResolvedValue(page());
    await initSession(COOKIE, 'AGENT');
    expect(get.mock.calls[0][1]).toMatchObject({ httpsAgent: 'AGENT' });
    expect(await fetchFBHomepage(COOKIE, 'AGENT')).toBe(HOME);
  });
});

describe('a refusal that comes through a proxy', () => {
  beforeEach(() => { jest.clearAllMocks(); forgetRecentSessions(); });

  // Lỗi thật 16/11/2026: máy chủ proxy trả 403 cho mọi kết nối. Coi đó là "cookie hết hạn" sẽ bắt người dùng đăng nhập lại
  // Facebook trong khi cookie vẫn tốt, và app thôi không thử nối lại.
  test.each([403, 407])('http_%i_throughAProxyIsATemporaryProblemNotAnExpiredCookie', async (status) => {
    get.mockRejectedValue(Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } }));
    await expect(initSession(COOKIE, 'AGENT')).rejects.toThrow(`HTTP ${status} qua proxy`);
    expect(await checkCookieState(COOKIE, 'AGENT')).toBe('unknown');
    expect(isTransientFacebookError(new Error(`[FacebookSession] Cannot fetch Facebook homepage (HTTP ${status} qua proxy): x`))).toBe(true);
  });

  test('http_403_withoutAProxyStillMeansTheCookieWasRejected', async () => {
    get.mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403 } }));
    expect(await checkCookieState(COOKIE)).toBe('expired');
  });
});
