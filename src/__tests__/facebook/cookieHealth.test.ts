import Logger from '../../utils/Logger';
import { checkCookieState, isTransientFacebookError } from '../../services/facebook/FacebookSession';

describe('isTransientFacebookError', () => {
  it.each([
    'getaddrinfo ENOTFOUND www.facebook.com',
    'getaddrinfo EAI_AGAIN www.facebook.com',
    'read ECONNRESET',
    'ERR_SOCKET_CLOSED',
    'tunneling socket could not be established, statusCode=502',
    'Proxy connection ended before receiving CONNECT response',
    'Request failed with status code 407',
    'Client network socket disconnected before secure TLS connection was established',
    'write EPROTO 00000000:error:0A000438:SSL routines',
    'write EPIPE',
    'connect ECONNABORTED',
    '[FacebookSession] Cannot fetch Facebook homepage (HTTP 503): Request failed with status code 503',
    'socket hang up',
    'timeout of 15000ms exceeded',
    'Request failed with status code 429',
    'Request failed with status code 503',
    '[FacebookSession] Cannot fetch Facebook homepage (HTTP ?): getaddrinfo ENOTFOUND www.facebook.com',
    '[FacebookSession] Cannot fetch Facebook homepage (HTTP 502): Request failed with status code 502',
  ])('treats "%s" as transient', (msg) => {
    expect(isTransientFacebookError(new Error(msg))).toBe(true);
  });

  it.each([
    'Cookie không hợp lệ',
    'checkpoint',
    'Request failed with status code 400',
    'Request failed with status code 401',
    'Request failed with status code 403',
    '[FacebookSession] Cannot fetch Facebook homepage (HTTP 403): Request failed with status code 403',
    '[FacebookSession] Missing required session fields: fb_dtsg',
    '[FacebookSession] Cannot fetch Facebook homepage (HTTP 400): Request failed with status code 400',
    '',
  ])('treats "%s" as a rejection', (msg) => {
    expect(isTransientFacebookError(new Error(msg))).toBe(false);
  });

  it('handles undefined and plain strings', () => {
    expect(isTransientFacebookError(undefined)).toBe(false);
    expect(isTransientFacebookError('ETIMEDOUT')).toBe(true);
  });
});

describe('checkCookieState', () => {
  beforeEach(() => { jest.spyOn(Logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());
  it('alive when the session initializer resolves', async () => {
    expect(await checkCookieState('c', undefined, async () => ({} as any))).toBe('alive');
  });
  it('unknown on a network failure', async () => {
    const init = async () => { throw new Error('getaddrinfo ENOTFOUND www.facebook.com'); };
    expect(await checkCookieState('c', undefined, init)).toBe('unknown');
  });
  it('expired on any other failure', async () => {
    const init = async () => { throw new Error('[FacebookSession] Missing required session fields: fb_dtsg'); };
    expect(await checkCookieState('c', undefined, init)).toBe('expired');
  });
});
