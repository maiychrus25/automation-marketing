import { planJwtSecretInit, tokenIssuedAtMs, evaluateEmployeeToken, nextRevocationMark, LoginThrottle, JWT_SECRET_VERSION } from '../../services/employee/employeeTokenPolicy';

describe('planJwtSecretInit', () => {
  it.each([
    [null, null, 'create'],
    ['', 2, 'create'],
    ['old', null, 'rotate'],
    ['old', 1, 'rotate'],
    ['key', 2, 'keep'],
    ['key', 3, 'keep'],
  ])('(%p, %p) -> %s', (existing, version, expected) => {
    expect(planJwtSecretInit(existing as any, version as any)).toBe(expected);
  });
  it('current version is 2', () => expect(JWT_SECRET_VERSION).toBe(2));
});

describe('tokenIssuedAtMs', () => {
  it('prefers ts in ms', () => expect(tokenIssuedAtMs({ ts: 5, iat: 9 })).toBe(5));
  it('falls back to iat seconds', () => expect(tokenIssuedAtMs({ iat: 2 })).toBe(2000));
  it('ignores non finite ts', () => expect(tokenIssuedAtMs({ ts: 'x', iat: 2 })).toBe(2000));
  it('returns 0 when neither exists', () => expect(tokenIssuedAtMs({})).toBe(0));
});

describe('evaluateEmployeeToken', () => {
  const active = { is_active: 1 };
  it('unavailable when employee is missing', () => expect(evaluateEmployeeToken({ issuedAtMs: 10, employee: null, validAfterMs: 0 })).toBe('unavailable'));
  it('inactive when disabled', () => expect(evaluateEmployeeToken({ issuedAtMs: 10, employee: { is_active: 0 }, validAfterMs: 0 })).toBe('inactive'));
  it('revoked when issued in the same ms as the mark', () => expect(evaluateEmployeeToken({ issuedAtMs: 100, employee: active, validAfterMs: 100 })).toBe('revoked'));
  it('ok 1 ms after the mark', () => expect(evaluateEmployeeToken({ issuedAtMs: 101, employee: active, validAfterMs: 100 })).toBe('ok'));
});

describe('nextRevocationMark', () => {
  it('moves past the mark and the last issued token', () => {
    expect(nextRevocationMark(100, 100, 100)).toBe(101);
    expect(nextRevocationMark(100, 0, 150)).toBe(150);
    expect(nextRevocationMark(100, 0, 0)).toBe(100);
  });
});

describe('LoginThrottle', () => {
  const MIN = 60_000;
  it('locks after 5 failures and opens after 15 minutes', () => {
    let t = 0;
    const th = new LoginThrottle(() => t);
    for (let i = 0; i < 4; i++) th.recordFailure('a');
    expect(th.isLocked('a')).toBe(false);
    th.recordFailure('a');
    expect(th.isLocked('a')).toBe(true);
    t = 15 * MIN - 1;
    expect(th.isLocked('a')).toBe(true);
    t = 15 * MIN;
    expect(th.isLocked('a')).toBe(false);
  });
  it('success clears the counter', () => {
    const th = new LoginThrottle(() => 0);
    for (let i = 0; i < 4; i++) th.recordFailure('a');
    th.recordSuccess('a');
    th.recordFailure('a');
    expect(th.isLocked('a')).toBe(false);
  });
  it('shares a counter across letter case and does not lock others', () => {
    const th = new LoginThrottle(() => 0);
    'Admin admin ADMIN aDmin Admin'.split(' ').forEach((u) => th.recordFailure(u));
    expect(th.isLocked('admin')).toBe(true);
    expect(th.isLocked('other')).toBe(false);
  });
  it('failures older than 15 minutes do not count', () => {
    let t = 0;
    const th = new LoginThrottle(() => t);
    for (let i = 0; i < 4; i++) th.recordFailure('a');
    t = 16 * MIN;
    th.recordFailure('a');
    expect(th.isLocked('a')).toBe(false);
  });
});
