import assert from 'node:assert';
import { CommentCollectScheduler, COMMENT_TICK_MINUTES } from '../../services/facebookPoster/CommentCollectScheduler';
import { MAX_COMMENT_POSTS } from '../../services/facebookPoster/CommentCollector';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';

const row = (i: number) => ({ resultId: i, profileId: `p${i}`, postUrl: `u${i}` }) as any;

function setup() {
  const env = {
    t: 1000, blockedUntil: 0, busy: false, autoCollect: true, readThrows: false, due: [] as any[],
    runErr: null as Error | null, runs: [] as any[][], logs: [] as string[],
    dueArgs: [] as { now: number; limit: number }[],
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
  };
  const sched = new CommentCollectScheduler({
    now: () => env.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; env.timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    readConfig: () => { if (env.readThrows) throw new Error('boom'); return { autoCollect: env.autoCollect } as any; },
    isBusy: () => env.busy,
    blockedUntil: () => env.blockedUntil,
    duePosts: (now, limit) => { env.dueArgs.push({ now, limit }); return env.due.slice(0, limit); },
    runCollect: (rows) => { if (env.runErr) throw env.runErr; env.runs.push(rows); },
    log: (m) => env.logs.push(m),
  });
  const live = () => env.timers.filter((x) => !x.cleared);
  return { env, sched, live };
}

describe('CommentCollectScheduler', () => {
  test('start arms a 15 minute timer and re-arms after firing', () => {
    const { env, sched, live } = setup();
    sched.start();
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].ms, COMMENT_TICK_MINUTES * 60_000);
    live()[0].fn();
    assert.strictEqual(live().length, 2);
    assert.strictEqual(env.runs.length, 0);
  });

  test('stop clears the timer and a late fire does nothing', () => {
    const { env, sched, live } = setup();
    env.due = [row(1)];
    sched.start();
    const t = live()[0];
    sched.stop();
    assert.strictEqual(live().length, 0);
    t.fn();
    assert.strictEqual(env.runs.length, 0);
  });

  test('autoCollect off → skips without querying', () => {
    const { env, sched } = setup();
    env.autoCollect = false; env.due = [row(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(env.dueArgs.length, 0);
  });

  test('busy → skips the tick', () => {
    const { env, sched } = setup();
    env.busy = true; env.due = [row(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(env.dueArgs.length, 0);
  });

  test('nothing due → no run', () => {
    const { env, sched } = setup();
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
  });

  test('due posts run, capped at 10', () => {
    const { env, sched } = setup();
    env.due = Array.from({ length: 14 }, (_, i) => row(i + 1));
    sched.tickNow();
    assert.strictEqual(env.dueArgs[0].limit, MAX_COMMENT_POSTS);
    assert.strictEqual(env.runs.length, 1);
    assert.strictEqual(env.runs[0].length, 10);
  });

  test('BUSY from runCollect is not logged; other errors are', () => {
    const { env, sched } = setup();
    env.due = [row(1)];
    env.runErr = new Error(BUSY_ERROR);
    sched.tickNow();
    assert.strictEqual(env.logs.length, 0);
    env.runErr = new Error('khác');
    sched.tickNow();
    assert.strictEqual(env.logs.length, 1);
  });

  test('config read failure falls back to the default (autoCollect on) and logs', () => {
    const { env, sched } = setup();
    env.readThrows = true; env.due = [row(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 1);
    assert.strictEqual(env.logs.length, 1);
  });

  test('skips ticks while blockedUntil is in the future and resumes after', () => {
    const { env, sched } = setup();
    env.due = [row(1)];
    env.blockedUntil = 5000;
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(env.dueArgs.length, 0);
    env.t = 5000;
    sched.tickNow();
    assert.strictEqual(env.runs.length, 1);
  });
});
