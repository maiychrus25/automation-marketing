process.env.TZ = 'Asia/Ho_Chi_Minh';
import assert from 'node:assert';
import { TIME_RE, computeNextRun, describeRecurrence } from '../../services/facebookPoster/scheduleTime';

const ALL = [0, 1, 2, 3, 4, 5, 6];
const rec = (days: number[], time: string) => ({ kind: 'recurring' as const, runAt: null, days, time });
const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

describe('scheduleTime', () => {
  it('TIME_RE accepts HH:mm only', () => {
    assert.ok(TIME_RE.test('08:00') && TIME_RE.test('23:59'));
    assert.ok(!TIME_RE.test('25:00') && !TIME_RE.test('8:00') && !TIME_RE.test('08:60'));
  });

  it('once: future runAt returned, past/equal/null gives null', () => {
    const once = (runAt: number | null) => ({ kind: 'once' as const, runAt, days: [], time: '' });
    assert.strictEqual(computeNextRun(once(2000), 1000), 2000);
    assert.strictEqual(computeNextRun(once(1000), 1000), null);
    assert.strictEqual(computeNextRun(once(500), 1000), null);
    assert.strictEqual(computeNextRun(once(null), 1000), null);
  });

  it('recurring daily: before time gives today, after gives tomorrow, equal gives tomorrow', () => {
    assert.strictEqual(computeNextRun(rec(ALL, '08:00'), at(2026, 10, 7, 7, 0)), at(2026, 10, 7, 8, 0));
    assert.strictEqual(computeNextRun(rec(ALL, '08:00'), at(2026, 10, 7, 9, 0)), at(2026, 10, 8, 8, 0));
    assert.strictEqual(computeNextRun(rec(ALL, '08:00'), at(2026, 10, 7, 8, 0)), at(2026, 10, 8, 8, 0));
  });

  it('only Monday from a Saturday gives next Monday', () => {
    // 2026-10-10 is a Saturday
    assert.strictEqual(new Date(at(2026, 10, 10)).getDay(), 6);
    assert.strictEqual(computeNextRun(rec([1], '08:00'), at(2026, 10, 10, 12, 0)), at(2026, 10, 12, 8, 0));
  });

  it('same weekday after its time wraps a full week', () => {
    assert.strictEqual(computeNextRun(rec([6], '08:00'), at(2026, 10, 10, 12, 0)), at(2026, 10, 17, 8, 0));
  });

  it('crosses month end', () => {
    assert.strictEqual(computeNextRun(rec(ALL, '08:00'), at(2026, 1, 31, 9, 0)), at(2026, 2, 1, 8, 0));
  });

  it('empty days, bad time, out-of-range days give null / no crash', () => {
    assert.strictEqual(computeNextRun(rec([], '08:00'), 1000), null);
    assert.strictEqual(computeNextRun(rec(ALL, '25:00'), 1000), null);
    assert.strictEqual(computeNextRun(rec([9, -1], '08:00'), 1000), null);
    assert.strictEqual(computeNextRun(rec([1, 1, 9], '08:00'), at(2026, 10, 10, 12, 0)), at(2026, 10, 12, 8, 0));
  });

  it('describeRecurrence', () => {
    assert.strictEqual(describeRecurrence([1, 3, 5], '08:00'), 'T2, T4, T6 lúc 08:00');
    assert.strictEqual(describeRecurrence([0, 6], '09:30'), 'T7, CN lúc 09:30');
    assert.strictEqual(describeRecurrence([6, 0, 1, 1, 9], '09:30'), 'T2, T7, CN lúc 09:30');
    assert.strictEqual(describeRecurrence(ALL, '07:05'), 'Hằng ngày lúc 07:05');
  });
});
