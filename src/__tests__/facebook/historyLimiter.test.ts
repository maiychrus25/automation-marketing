import {
  FacebookHistoryLimiter, isFacebookRiskError, HISTORY_MIN_GAP_MS, HISTORY_MAX_PAGES_PER_HOUR,
  HISTORY_COOLDOWN_MS, HISTORY_INTERACTIVE_MAX_WAIT_MS,
} from '../../services/facebook/FacebookHistoryLimiter';

describe('FacebookHistoryLimiter', () => {
  let t = 0;
  const make = () => { t = 1_000_000; return new FacebookHistoryLimiter(() => t); };

  it('exposes fixed constants', () => {
    expect([HISTORY_MIN_GAP_MS, HISTORY_MAX_PAGES_PER_HOUR, HISTORY_COOLDOWN_MS, HISTORY_INTERACTIVE_MAX_WAIT_MS])
      .toEqual([2000, 120, 1_800_000, 5000]);
  });

  it('enforces the minimum gap', () => {
    const l = make();
    expect(l.waitMs()).toBe(0);
    l.recordRequest();
    expect(l.waitMs()).toBe(2000);
    t += 500;
    expect(l.waitMs()).toBe(1500);
    t += 1500;
    expect(l.waitMs()).toBe(0);
  });

  it('enforces the hourly budget with a sliding window', () => {
    const l = make();
    const first = t;
    for (let i = 0; i < HISTORY_MAX_PAGES_PER_HOUR; i++) { l.recordRequest(); t += 2000; }
    expect(l.waitMs()).toBe(first + 3_600_000 - t);
    t = first + 3_600_000;
    expect(l.waitMs()).toBe(0);
  });

  it('starts a 30 minute cooldown only on risk errors', () => {
    const l = make();
    expect(l.recordResult(false, 'socket hang up')).toBe('ok');
    expect(l.cooldownRemaining()).toBe(0);
    expect(l.recordResult(true)).toBe('ok');
    expect(l.recordResult(false, 'checkpoint required')).toBe('risk');
    expect(l.cooldownRemaining()).toBe(1_800_000);
    t += 1_800_000;
    expect(l.cooldownRemaining()).toBe(0);
  });

  it('isFacebookRiskError matches each pattern and Error objects', () => {
    for (const m of ['checkpoint', 'login_required', 'Not logged in', 'code 1357001', '1357004', '1390008']) {
      expect(isFacebookRiskError(m)).toBe(true);
    }
    expect(isFacebookRiskError(new Error('Checkpoint needed'))).toBe(true);
    expect(isFacebookRiskError('timeout')).toBe(false);
    expect(isFacebookRiskError(undefined)).toBe(false);
  });

  it('reads message from plain objects and tolerates odd inputs', () => {
    expect(isFacebookRiskError({ message: 'checkpoint required' })).toBe(true);
    expect(isFacebookRiskError({ message: 'timeout' })).toBe(false);
    expect(isFacebookRiskError({ code: 1 })).toBe(false);
    expect(isFacebookRiskError(null)).toBe(false);
  });

  it('survives a backward clock jump', () => {
    const l = make();
    for (let i = 0; i < HISTORY_MAX_PAGES_PER_HOUR; i++) l.recordRequest();
    l.recordResult(false, 'checkpoint');
    t -= 3_600_000;
    expect(l.waitMs()).toBeLessThanOrEqual(3_600_000);
    expect(l.cooldownRemaining()).toBeLessThanOrEqual(HISTORY_COOLDOWN_MS);
    const g = make();
    g.recordRequest();
    t -= 3_600_000;
    expect(g.waitMs()).toBeLessThanOrEqual(HISTORY_MIN_GAP_MS);
  });

  it('recordRequest prunes old entries by itself', () => {
    const l = make();
    for (let i = 0; i < 5; i++) { l.recordRequest(); t += 2000; }
    t += 3_600_000;
    l.recordRequest();
    expect((l as any).requests).toHaveLength(1);
  });

  it('budget boundary: 119th and 120th have no budget wait, 121st does', () => {
    const l = make();
    const first = t;
    for (let i = 0; i < 119; i++) { l.recordRequest(); t += 2000; }
    expect(l.waitMs()).toBe(0);
    l.recordRequest(); t += 2000; // 120th
    expect(l.waitMs()).toBe(first + 3_600_000 - t);
    expect(l.waitMs()).toBeGreaterThan(0);
  });

  it('waitMs excludes cooldown and a second risk restarts it', () => {
    const l = make();
    l.recordResult(false, 'checkpoint');
    expect(l.waitMs()).toBe(0);
    t += 600_000;
    expect(l.recordResult(false, '1357001')).toBe('risk');
    expect(l.cooldownRemaining()).toBe(1_800_000);
  });
});
