import assert from 'node:assert';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import {
  FacebookPosterScheduler, GRACE_MS, QUEUE_MAX_WAIT_MS, MAX_TIMER_MS,
  MISSED_APP_CLOSED, MISSED_QUEUE_TIMEOUT, MISSED_APP_QUIT, ERROR_RETRY_MS, type MissedNotice,
} from '../../services/facebookPoster/FacebookPosterScheduler';
import type { StartParams } from '../../services/facebookPoster/FacebookPosterService';
import type { FbPosterSchedule } from '../../models/facebookPoster';
import { memoryDb } from './helpers';

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 7, 12, 0, 0).getTime(); // Wed 2026-10-07 12:00 local

function setup(over: { resolveParams?: (s: FbPosterSchedule) => StartParams; startRun?: (p: StartParams, id: string) => { runId: string } } = {}) {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const env = {
    t: T0, busy: false, seq: 0,
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
    started: [] as string[], missed: [] as MissedNotice[], changed: 0,
  };
  const sched = new FacebookPosterScheduler({
    store,
    now: () => env.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; env.timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    isBusy: () => env.busy,
    resolveParams: over.resolveParams ?? (() => ({ kind: 'post' }) as unknown as StartParams),
    startRun: over.startRun ?? ((_p, id) => { env.started.push(id); return { runId: `run-${id}` }; }),
    newId: () => `gen-${++env.seq}`,
    onMissed: (n) => env.missed.push(n),
    onChanged: () => { env.changed++; },
  });
  const add = (id: string, over: Record<string, unknown> = {}) => store.createSchedule({
    id, name: `Lịch ${id}`, kind: 'once', params: { kind: 'post', mode: 'group' }, runAt: T0, days: [], time: '',
    enabled: true, nextRunAt: T0, createdAt: 1, ...over,
  } as Parameters<FacebookPosterStore['createSchedule']>[0]);
  const live = () => env.timers.filter((x) => !x.cleared);
  return { store, env, sched, add, live };
}

describe('FacebookPosterScheduler', () => {
  test('1. start() records a missed run for a schedule long overdue', () => {
    const { store, env, sched, add } = setup();
    add('a', { runAt: T0 - 5 * MIN, nextRunAt: T0 - 5 * MIN });
    sched.start();
    const s = store.getSchedule('a')!;
    assert.strictEqual(s.nextRunAt, null);
    const run = store.getRun(s.lastRunId!)!.run;
    assert.strictEqual(run.status, 'missed');
    assert.strictEqual(run.error, MISSED_APP_CLOSED);
    assert.strictEqual(run.startedAt, T0 - 5 * MIN);
    assert.deepStrictEqual(env.missed, [{ scheduleId: 'a', name: 'Lịch a', reason: MISSED_APP_CLOSED, at: T0 - 5 * MIN }]);
    assert.deepStrictEqual(env.started, []);
  });

  test('2. start() runs a schedule due within the grace window', () => {
    const { env, sched, add } = setup();
    add('a', { runAt: T0 - 30000, nextRunAt: T0 - 30000 });
    sched.start();
    assert.deepStrictEqual(env.started, ['a']);
    assert.ok(env.changed >= 1);
  });

  test('3. arm() uses the delay to the next schedule, capped at MAX_TIMER_MS', () => {
    const a = setup();
    a.add('a', { runAt: T0 + 10 * MIN, nextRunAt: T0 + 10 * MIN });
    a.sched.start();
    assert.deepStrictEqual(a.live().map((x) => x.ms), [600000]);
    const b = setup();
    b.add('a', { runAt: T0 + 3 * 24 * 60 * MIN, nextRunAt: T0 + 3 * 24 * 60 * MIN });
    b.sched.start();
    assert.deepStrictEqual(b.live().map((x) => x.ms), [MAX_TIMER_MS]);
  });

  test('4. timer fires while idle: starts the run and moves a recurring schedule to the next weekday', () => {
    const { store, env, sched, add, live } = setup();
    const due = new Date(2026, 9, 7, 13, 0, 0).getTime(); // Wed 13:00
    add('r', { kind: 'recurring', runAt: null, days: [1, 3, 5], time: '13:00', nextRunAt: due });
    sched.start();
    assert.strictEqual(live()[0].ms, 60 * MIN);
    env.t = due;
    live()[0].fn();
    assert.deepStrictEqual(env.started, ['r']);
    assert.strictEqual(store.getSchedule('r')!.nextRunAt, new Date(2026, 9, 9, 13, 0, 0).getTime()); // Fri
    assert.strictEqual(store.getSchedule('r')!.lastRunId, 'run-r');
  });

  test('5. busy at fire time queues; onRunFinished starts it once idle', () => {
    const { env, sched, add } = setup();
    add('a');
    env.busy = true;
    sched.start();
    assert.deepStrictEqual(env.started, []);
    assert.deepStrictEqual(sched.queuedIds(), ['a']);
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, ['a']);
    assert.deepStrictEqual(sched.queuedIds(), []);
  });

  test('6. busy for more than 2 h records missed via the queue-timeout timer', () => {
    const { store, env, sched, add, live } = setup();
    add('a');
    env.busy = true;
    sched.start();
    assert.strictEqual(live()[0].ms, QUEUE_MAX_WAIT_MS);
    env.t = T0 + QUEUE_MAX_WAIT_MS + 1;
    live()[0].fn();
    assert.deepStrictEqual(sched.queuedIds(), []);
    const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
    assert.strictEqual(run.status, 'missed');
    assert.strictEqual(run.error, MISSED_QUEUE_TIMEOUT);
    assert.strictEqual(env.missed[0].reason, MISSED_QUEUE_TIMEOUT);
    assert.deepStrictEqual(env.started, []);
  });

  test('7. deleted while queued: skipped silently', () => {
    const { store, env, sched, add } = setup();
    add('a');
    env.busy = true;
    sched.start();
    store.deleteSchedule('a');
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, []);
    assert.deepStrictEqual(env.missed, []);
    assert.strictEqual(store.listRuns({ limit: 10, offset: 0 }).total, 0);
    assert.deepStrictEqual(sched.queuedIds(), []);
  });

  test('8. disabled while queued: skipped', () => {
    const { store, env, sched, add } = setup();
    add('a');
    env.busy = true;
    sched.start();
    store.updateSchedule('a', { enabled: false }, env.t);
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, []);
    assert.deepStrictEqual(env.missed, []);
    assert.deepStrictEqual(sched.queuedIds(), []);
  });

  test('9. two schedules due together start one after another in order', () => {
    let env!: ReturnType<typeof setup>['env'];
    const ctx = setup({ startRun: (_p, id) => { env.started.push(id); env.busy = true; return { runId: `run-${id}` }; } });
    env = ctx.env;
    const { sched, add } = ctx;
    add('b', { createdAt: 2 });
    add('a', { createdAt: 1 });
    sched.start();
    assert.deepStrictEqual(env.started, ['a']);
    assert.deepStrictEqual(sched.queuedIds(), ['b']);
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, ['a', 'b']);
  });

  test('10. resolveParams throws: failed run with that error, queue continues', () => {
    const { store, env, sched, add } = setup({
      resolveParams: (s) => { if (s.id === 'a') throw new Error('Không tìm thấy tệp ảnh/video'); return { kind: 'post' } as unknown as StartParams; },
    });
    add('a', { createdAt: 1 });
    add('b', { createdAt: 2 });
    sched.start();
    const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.error, 'Không tìm thấy tệp ảnh/video');
    assert.deepStrictEqual(env.started, ['b']);
  });

  test('11. startRun throws busy (race): item stays first in the queue', () => {
    const { store, sched, add } = setup({ startRun: () => { throw new Error('Đang có việc chạy'); } });
    add('a');
    add('b', { createdAt: 2 });
    sched.start();
    assert.deepStrictEqual(sched.queuedIds(), ['a', 'b']);
    assert.strictEqual(store.getSchedule('a')!.lastRunId, null);
  });

  test('12. fires late after sleep: missed instead of started', () => {
    const { store, env, sched, add, live } = setup();
    const due = T0 + 60 * MIN;
    add('a', { runAt: due, nextRunAt: due });
    sched.start();
    env.t = due + 10 * MIN;
    live()[0].fn();
    const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
    assert.strictEqual(run.status, 'missed');
    assert.strictEqual(run.error, MISSED_APP_CLOSED);
    assert.deepStrictEqual(env.started, []);
  });

  test('13. stop records queued items as missed and clears timers', () => {
    const { store, env, sched, add, live } = setup();
    add('a');
    env.busy = true;
    sched.start();
    const stale = live()[0];
    sched.stop();
    const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
    assert.strictEqual(run.status, 'missed');
    assert.strictEqual(run.error, MISSED_APP_QUIT);
    assert.strictEqual(env.missed[0].reason, MISSED_APP_QUIT);
    assert.deepStrictEqual(sched.queuedIds(), []);
    assert.strictEqual(live().length, 0);
    env.busy = false;
    stale.fn();
    assert.deepStrictEqual(env.started, []);
    assert.strictEqual(live().length, 0);
  });

  test('14. a store exception in fire() still leaves a timer armed', () => {
    const { store, sched, add, live } = setup();
    add('a', { runAt: T0 + 10 * MIN, nextRunAt: T0 + 10 * MIN });
    const real = store.listDueSchedules.bind(store);
    let thrown = false;
    store.listDueSchedules = (at: number) => { if (!thrown) { thrown = true; throw new Error('db down'); } return real(at); };
    sched.start();
    assert.ok(thrown);
    assert.deepStrictEqual(live().map((x) => x.ms), [600000]);
  });

  test('15. a failing lastRunId write does not record a failed run', () => {
    const { store, env, sched, add } = setup();
    add('a');
    const real = store.updateSchedule.bind(store);
    store.updateSchedule = (id, fields, at) => {
      if ('lastRunId' in fields) throw new Error('write failed');
      return real(id, fields, at);
    };
    sched.start();
    assert.deepStrictEqual(env.started, ['a']);
    assert.strictEqual(store.listRuns({ limit: 10, offset: 0 }).total, 0);
  });

  test('16. a persistent store fault re-arms at ERROR_RETRY_MS, then recovers', () => {
    const { store, env, sched, add, live } = setup();
    add('a');
    add('b', { runAt: T0 + 10 * MIN, nextRunAt: T0 + 10 * MIN, createdAt: 2 });
    const real = store.listDueSchedules.bind(store);
    store.listDueSchedules = () => { throw new Error('db down'); };
    sched.start();
    assert.deepStrictEqual(live().map((x) => x.ms), [ERROR_RETRY_MS]);
    env.t += ERROR_RETRY_MS;
    live()[0].fn();
    assert.deepStrictEqual(live().map((x) => x.ms), [ERROR_RETRY_MS]);
    store.listDueSchedules = real;
    env.t += ERROR_RETRY_MS;
    live()[0].fn();
    assert.deepStrictEqual(env.started, ['a']);
    assert.deepStrictEqual(live().map((x) => x.ms), [T0 + 10 * MIN - env.t]);
  });

  test('17. nextScheduledAt throwing in arm() still arms a retry timer', () => {
    const { store, sched, add, live } = setup();
    add('a', { runAt: T0 + 10 * MIN, nextRunAt: T0 + 10 * MIN });
    store.nextScheduledAt = () => { throw new Error('db down'); };
    sched.start();
    assert.deepStrictEqual(live().map((x) => x.ms), [ERROR_RETRY_MS]);
  });

  test('draft schedules never start, even with inconsistent enabled/nextRunAt', () => {
    const { env, sched, add } = setup();
    add('d', { draft: true }); // add() mặc định enabled: true, nextRunAt: T0 — dữ liệu lệch có chủ đích
    sched.start();
    assert.deepStrictEqual(env.started, []);
  });

  test('a schedule due now (draft approved "now") waits while busy and starts after the run finishes', () => {
    const { env, sched, add } = setup();
    env.busy = true;
    add('n', { runAt: T0, nextRunAt: T0 });
    sched.start();
    assert.deepStrictEqual(env.started, []);
    assert.deepStrictEqual(sched.queuedIds(), ['n']);
    env.busy = false;
    sched.onRunFinished();
    assert.deepStrictEqual(env.started, ['n']);
  });
});
