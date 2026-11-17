import {
  runWithConcurrency,
  EMPLOYEE_BOOTSTRAP_CONCURRENCY,
  bootstrapProgressText,
  shouldRunZaloInit,
  bootstrapKey,
  decideBootstrapRequest,
  orderActiveFirst,
} from '../../ui/lib/backgroundLoad';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('runWithConcurrency', () => {
  it('never runs more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const res = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++; peak = Math.max(peak, active);
      await tick();
      active--;
    }, () => {});
    expect(peak).toBe(3);
    expect(res).toEqual({ done: 8, failed: 0 });
  });

  it('one failing item does not stop the others', async () => {
    const seen: number[] = [];
    const res = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
    }, () => {});
    expect(seen.sort()).toEqual([1, 3, 4]);
    expect(res).toEqual({ done: 4, failed: 1 });
  });

  it('reports progress after every item, failures included', async () => {
    const calls: Array<[number, number, number]> = [];
    await runWithConcurrency(['a', 'b', 'c'], 1, async (x) => { if (x === 'b') throw new Error('x'); },
      (d, t, f) => calls.push([d, t, f]));
    expect(calls).toEqual([[1, 3, 0], [2, 3, 1], [3, 3, 1]]);
  });

  it('a throwing progress listener does not reject the run', async () => {
    const res = await runWithConcurrency([1, 2], 1, async () => {}, () => { throw new Error('ui'); });
    expect(res).toEqual({ done: 2, failed: 0 });
  });

  it('handles an empty list', async () => {
    expect(await runWithConcurrency([], 3, async () => {}, () => {})).toEqual({ done: 0, failed: 0 });
  });

  it('uses 3 as the bootstrap concurrency', () => {
    expect(EMPLOYEE_BOOTSTRAP_CONCURRENCY).toBe(3);
  });
});

describe('bootstrapProgressText', () => {
  it('shows progress while running', () => expect(bootstrapProgressText(1, 4, 0)).toBe('Đang tải hội thoại 1/4'));
  it('shows failures once finished', () => expect(bootstrapProgressText(4, 4, 2)).toBe('Chưa tải được hội thoại của 2 tài khoản'));
  it('is null when finished without failures or when empty', () => {
    expect(bootstrapProgressText(4, 4, 0)).toBeNull();
    expect(bootstrapProgressText(0, 0, 0)).toBeNull();
  });
});

describe('shouldRunZaloInit', () => {
  it('is off for employees only', () => {
    expect(shouldRunZaloInit(true)).toBe(false);
    expect(shouldRunZaloInit(false)).toBe(true);
  });
});

describe('single-run decision', () => {
  it('key ignores order and duplicates', () => expect(bootstrapKey(['b', 'a', 'b'])).toBe(bootstrapKey(['a', 'b'])));
  it('starts when idle', () => expect(decideBootstrapRequest(null, 'a')).toBe('start'));
  it('joins a run for the same set', () => expect(decideBootstrapRequest('a|b', 'a|b')).toBe('join'));
  it('supersedes a run for a different set', () => expect(decideBootstrapRequest('a|b', 'a')).toBe('start'));
  it('puts the active account first', () => {
    expect(orderActiveFirst(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(orderActiveFirst(['a', 'b'], 'zzz')).toEqual(['a', 'b']);
    expect(orderActiveFirst(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});
