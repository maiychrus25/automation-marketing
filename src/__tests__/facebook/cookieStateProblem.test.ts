jest.mock('axios');
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
import axios from 'axios';
import { checkCookieState, checkCookieStateDetailed, forgetRecentSessions } from '../../services/facebook/FacebookSession';

const fail = (message: string, extra: object = {}) => async () => { throw Object.assign(new Error(message), extra); };
const ok = (async () => ({})) as any;

describe('checkCookieStateDetailed', () => {
  it('carries the problem when expired', async () => {
    const init = fail('[FacebookSession] Missing required session fields: fb_dtsg', { fbSessionProblem: 'logged_out' }) as any;
    await expect(checkCookieStateDetailed('c', undefined, init)).resolves.toEqual({ state: 'expired', problem: 'logged_out' });
  });
  it('has no problem when expired for another reason', async () => {
    await expect(checkCookieStateDetailed('c', undefined, fail('boom') as any)).resolves.toEqual({ state: 'expired' });
  });
  it('is unknown, without problem, on a transient network error', async () => {
    const init = fail('connect ETIMEDOUT', { fbSessionProblem: 'logged_out' }) as any;
    await expect(checkCookieStateDetailed('c', undefined, init)).resolves.toEqual({ state: 'unknown' });
  });
  it('is alive on success', async () => {
    await expect(checkCookieStateDetailed('c', undefined, ok)).resolves.toEqual({ state: 'alive' });
  });
});

describe('checkCookieState keeps its three states', () => {
  it.each([
    ['alive', ok],
    ['expired', fail('[FacebookSession] Missing required session fields: fb_dtsg') as any],
    ['expired', fail('[FacebookSession] Missing required session fields: fb_dtsg', { fbSessionProblem: 'checkpoint' }) as any],
    ['expired', fail('[FacebookSession] FacebookID is not numeric: x') as any],
    ['unknown', fail('[FacebookSession] Cannot fetch Facebook homepage (HTTP 503): bad') as any],
    ['unknown', fail('[FacebookSession] Cannot fetch Facebook homepage (HTTP 407 qua proxy): bad') as any],
    ['unknown', fail('socket hang up') as any],
  ])('%s', async (state, init) => {
    await expect(checkCookieState('c', undefined, init)).resolves.toBe(state);
  });
});

describe('initSession attaches the diagnosis from the page it already loaded', () => {
  beforeEach(() => forgetRecentSessions());
  it('logged-out page: same message, plus fbSessionProblem, one request', async () => {
    const get = axios.get as jest.Mock;
    get.mockReset().mockResolvedValue({ data: '<html>checkpoint {"actorID":"0"}</html>', headers: {}, request: { res: { responseUrl: 'https://www.facebook.com/' } } });
    await expect(checkCookieStateDetailed('c_user=1; xs=a')).resolves.toEqual({ state: 'expired', problem: 'logged_out' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('final URL under /checkpoint', async () => {
    const get = axios.get as jest.Mock;
    get.mockReset().mockResolvedValue({ data: '<html></html>', headers: {}, request: { res: { responseUrl: 'https://www.facebook.com/checkpoint/1/?next=x' } } });
    await expect(checkCookieStateDetailed('c_user=2; xs=a')).resolves.toEqual({ state: 'expired', problem: 'checkpoint' });
  });
});
