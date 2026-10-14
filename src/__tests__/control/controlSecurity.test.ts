import { hashKey, generateKey, keyMatches, ipAllowed, parseAllowList, RateLimiter, AuthLockout } from '../../services/control/controlSecurity';

describe('keys', () => {
  it('generates mh_ + base64url(32 bytes) and hashes to sha256 hex', () => {
    const k = generateKey();
    expect(k).toMatch(/^mh_[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(k);
    expect(hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(k)).toBe(hashKey(k));
  });
  it('keyMatches compares hashes', () => {
    const h = hashKey('mh_abc');
    expect(keyMatches('mh_abc', h)).toBe(true);
    expect(keyMatches('mh_abd', h)).toBe(false);
    expect(keyMatches('x', 'short')).toBe(false);
  });
});

describe('ipAllowed', () => {
  it('matches exact IPv4, /32 and /24', () => {
    expect(ipAllowed('10.0.0.5', ['10.0.0.5'])).toBe(true);
    expect(ipAllowed('10.0.0.5', ['10.0.0.5/32'])).toBe(true);
    expect(ipAllowed('10.0.0.6', ['10.0.0.5/32'])).toBe(false);
    expect(ipAllowed('192.168.1.77', ['192.168.1.0/24'])).toBe(true);
    expect(ipAllowed('192.168.2.77', ['192.168.1.0/24'])).toBe(false);
    expect(ipAllowed('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });
  it('normalizes ::ffff: mapped addresses', () => {
    expect(ipAllowed('::ffff:192.168.1.9', ['192.168.1.0/24'])).toBe(true);
    expect(ipAllowed('::ffff:192.168.2.9', ['192.168.1.0/24'])).toBe(false);
  });
  it('::1 only matches explicit ::1', () => {
    expect(ipAllowed('::1', ['127.0.0.1'])).toBe(false);
    expect(ipAllowed('::1', ['0.0.0.0/0'])).toBe(false);
    expect(ipAllowed('::1', ['::1'])).toBe(true);
  });
  it('ignores invalid entries and empty list denies', () => {
    expect(ipAllowed('10.0.0.5', ['garbage', '10.0.0.0/33', '10.0.0.5/'])).toBe(false);
    expect(ipAllowed('10.0.0.5', [])).toBe(false);
    expect(ipAllowed('not-an-ip', ['10.0.0.5'])).toBe(false);
  });
  it('parseAllowList validates input', () => {
    expect(parseAllowList('10.0.0.1, 192.168.0.0/16\n::1 bad 1.2.3.4/40 fe80::/10')).toEqual({
      entries: ['10.0.0.1', '192.168.0.0/16', '::1'],
      invalid: ['bad', '1.2.3.4/40', 'fe80::/10'],
    });
  });
});

describe('ipAllowed edge cases', () => {
  it('handles uppercase mapped prefix, whitespace, high-bit CIDR', () => {
    expect(ipAllowed('::FFFF:1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipAllowed(' 1.2.3.4 ', ['  1.2.3.4  '])).toBe(true);
    expect(ipAllowed('200.1.2.3', ['200.0.0.0/8'])).toBe(true);
    expect(ipAllowed('200.1.2.3', ['128.0.0.0/1'])).toBe(true);
    expect(ipAllowed('100.1.2.3', ['128.0.0.0/1'])).toBe(false);
  });
  it('rejects out-of-range and leading-zero octets', () => {
    expect(ipAllowed('256.0.0.1', ['256.0.0.1'])).toBe(false);
    expect(ipAllowed('10.0.0.1', ['010.0.0.1'])).toBe(false);
    expect(parseAllowList('010.0.0.1 256.0.0.1 10.0.0.0/8')).toEqual({ entries: ['10.0.0.0/8'], invalid: ['010.0.0.1', '256.0.0.1'] });
  });
  it('fails closed on other IPv6 forms', () => {
    expect(ipAllowed('::ffff:c0a8:0109', ['192.168.1.9', '0.0.0.0/0'])).toBe(false);
    expect(ipAllowed('0:0:0:0:0:ffff:1.2.3.4', ['1.2.3.4', '0.0.0.0/0'])).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows 60 per minute per key then recovers', () => {
    let t = 1000;
    const rl = new RateLimiter(60, () => t);
    for (let i = 0; i < 60; i++) expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
    t += 60_001;
    expect(rl.take('a')).toBe(true);
  });
});

describe('AuthLockout', () => {
  it('blocks 900s after 10 failures in 600s; success resets', () => {
    let t = 0;
    const lo = new AuthLockout(() => t);
    for (let i = 0; i < 9; i++) lo.recordFailure('1.1.1.1');
    expect(lo.isBlocked('1.1.1.1')).toBe(false);
    lo.recordSuccess('1.1.1.1');
    for (let i = 0; i < 9; i++) lo.recordFailure('1.1.1.1');
    expect(lo.isBlocked('1.1.1.1')).toBe(false);
    lo.recordFailure('1.1.1.1');
    expect(lo.isBlocked('1.1.1.1')).toBe(true);
    expect(lo.isBlocked('2.2.2.2')).toBe(false);
    t += 899_000;
    expect(lo.isBlocked('1.1.1.1')).toBe(true);
    t += 2_000;
    expect(lo.isBlocked('1.1.1.1')).toBe(false);
  });
  it('evicts stale state after the window', () => {
    let t = 0;
    const lo = new AuthLockout(() => t);
    lo.recordFailure('a'); for (let i = 0; i < 10; i++) lo.recordFailure('b');
    t += 1_000_000;
    lo.recordFailure('c');
    expect((lo as any).failures.has('a')).toBe(false);
    expect((lo as any).blockedUntil.has('b')).toBe(false);
    expect((lo as any).failures.has('c')).toBe(true);
  });
  it('failures older than 600s do not count', () => {
    let t = 0;
    const lo = new AuthLockout(() => t);
    for (let i = 0; i < 9; i++) lo.recordFailure('x');
    t += 601_000;
    lo.recordFailure('x');
    expect(lo.isBlocked('x')).toBe(false);
  });
});
