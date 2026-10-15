import assert from 'node:assert';
import {
  LoginCheckScheduler, nextDailyAt, parseLoginCheckConfig, validateLoginCheckConfig,
  DEFAULT_LOGIN_CHECK_CONFIG, LOGIN_CHECK_SETTING_KEY, type LoginCheckConfig,
} from '../../services/facebookPoster/LoginCheckScheduler';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const at = (d: number, h: number, mi = 0) => new Date(2026, 9, d, h, mi).getTime();

function setup(start: number, config: LoginCheckConfig = { enabled: true, time: '07:00' }) {
  const env = {
    t: start, busy: false, config, runs: 0, logs: [] as string[], throwErr: null as Error | null,
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
  };
  const sched = new LoginCheckScheduler({
    now: () => env.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; env.timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    readConfig: () => env.config,
    isBusy: () => env.busy,
    runCheck: () => { if (env.throwErr) throw env.throwErr; env.runs++; },
    log: (m) => env.logs.push(m),
  });
  const live = () => env.timers.filter((x) => !x.cleared);
  /** Advance the clock by the live timer's delay and fire it. */
  const tick = () => { const h = live()[live().length - 1]; env.t += h.ms; h.cleared = true; h.fn(); };
  return { env, sched, live, tick };
}

describe('LoginCheckScheduler', () => {
  test('config helpers', () => {
    assert.deepStrictEqual(parseLoginCheckConfig(null), DEFAULT_LOGIN_CHECK_CONFIG);
    assert.deepStrictEqual(parseLoginCheckConfig('garbage'), DEFAULT_LOGIN_CHECK_CONFIG);
    assert.deepStrictEqual(parseLoginCheckConfig('{"enabled":false,"time":"08:30"}'), { enabled: false, time: '08:30' });
    assert.deepStrictEqual(validateLoginCheckConfig({ enabled: true, time: '23:59' }), { enabled: true, time: '23:59' });
    assert.throws(() => validateLoginCheckConfig({ enabled: true, time: '24:00' }));
    assert.throws(() => validateLoginCheckConfig({ enabled: 'yes', time: '07:00' }));
    assert.strictEqual(LOGIN_CHECK_SETTING_KEY, 'fb_poster_login_check');
  });

  test('before 07:00 → today, after → tomorrow', () => {
    assert.strictEqual(nextDailyAt('07:00', at(15, 6)), at(15, 7));
    assert.strictEqual(nextDailyAt('07:00', at(15, 7)), at(16, 7));
    assert.strictEqual(nextDailyAt('07:00', at(15, 8)), at(16, 7));
    const a = setup(at(15, 6));
    a.sched.start();
    assert.strictEqual(a.live()[0].ms, HOUR);
    const b = setup(at(15, 8));
    b.sched.start();
    assert.strictEqual(b.live()[0].ms, 23 * HOUR);
  });

  test('timer is capped at 24 h and re-armed without running early', () => {
    const { env, sched, live, tick } = setup(at(15, 7, 1));
    sched.start();
    assert.strictEqual(live()[0].ms, 24 * HOUR - MIN);
    env.t = at(15, 7, 1);
    live()[0].fn(); // fires early: must not run, must re-arm
    assert.strictEqual(env.runs, 0);
    assert.ok(live().length >= 1);
    tick();
    assert.strictEqual(env.runs, 1);
  });

  test('runs at the scheduled time and arms the next day', () => {
    const { env, sched, live, tick } = setup(at(15, 6));
    sched.start();
    tick();
    assert.strictEqual(env.runs, 1);
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].ms, 24 * HOUR);
  });

  test('busy → retries every 5 min, gives up after 2 h and arms next day', () => {
    const { env, sched, live, tick } = setup(at(15, 6));
    env.busy = true;
    sched.start();
    tick(); // 07:00 busy
    assert.strictEqual(live()[0].ms, 5 * MIN);
    for (let i = 0; i < 23; i++) { tick(); assert.strictEqual(live()[0].ms, 5 * MIN); }
    assert.strictEqual(env.runs, 0);
    tick(); // 09:00 = 2 h after → give up
    assert.strictEqual(env.runs, 0);
    assert.ok(env.logs.length >= 1);
    assert.strictEqual(env.t, at(15, 9));
    assert.strictEqual(live()[0].ms, 22 * HOUR);
  });

  test('retry succeeds once the job finishes', () => {
    const { env, sched, tick } = setup(at(15, 6));
    env.busy = true;
    sched.start();
    tick();
    env.busy = false;
    tick();
    assert.strictEqual(env.runs, 1);
  });

  test('disabled → no run', () => {
    const { env, sched, live, tick } = setup(at(15, 6), { enabled: false, time: '07:00' });
    sched.start();
    tick();
    assert.strictEqual(env.runs, 0);
    assert.strictEqual(live().length, 1);
  });

  test('reschedule after config change', () => {
    const { env, sched, live } = setup(at(15, 6));
    sched.start();
    env.config = { enabled: true, time: '06:30' };
    sched.reschedule();
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].ms, 30 * MIN);
    env.config = { enabled: false, time: '06:30' };
    sched.reschedule();
    live()[0].fn();
    assert.strictEqual(env.runs, 0);
    env.config = { enabled: true, time: '06:30' };
    sched.reschedule();
    assert.strictEqual(live()[0].ms, 30 * MIN);
  });

  test('runCheck throwing BUSY counts as busy', () => {
    const { env, sched, live, tick } = setup(at(15, 6));
    env.throwErr = new Error(BUSY_ERROR);
    sched.start();
    tick();
    assert.strictEqual(live()[0].ms, 5 * MIN);
    env.throwErr = null;
    tick();
    assert.strictEqual(env.runs, 1);
  });

  test('runCheck throwing another error is logged and not retried', () => {
    const { env, sched, live, tick } = setup(at(15, 6));
    env.throwErr = new Error('boom');
    sched.start();
    tick();
    assert.ok(env.logs.some((l) => l.includes('boom')));
    assert.strictEqual(live()[0].ms, 24 * HOUR);
  });

  test('stop clears timer', () => {
    const { env, sched, live } = setup(at(15, 6));
    sched.start();
    const h = live()[0];
    sched.stop();
    assert.strictEqual(live().length, 0);
    h.fn();
    assert.strictEqual(env.runs, 0);
    assert.strictEqual(live().length, 0);
    sched.start();
    assert.strictEqual(live().length, 1);
  });
});
