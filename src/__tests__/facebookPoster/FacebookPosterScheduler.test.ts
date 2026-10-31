import assert from 'node:assert';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import {
  FacebookPosterScheduler, GRACE_MS, QUEUE_MAX_WAIT_MS, MAX_TIMER_MS,
  MISSED_APP_CLOSED, MISSED_QUEUE_TIMEOUT, MISSED_APP_QUIT, ERROR_RETRY_MS, type MissedNotice,
} from '../../services/facebookPoster/FacebookPosterScheduler';
import type { RunStartOptions, StartParams } from '../../services/facebookPoster/FacebookPosterService';
import type { FbPosterSchedule } from '../../models/facebookPoster';
import { memoryDb } from './helpers';

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 7, 12, 0, 0).getTime(); // Wed 2026-10-07 12:00 local

function setup(over: { canStart?: (p: StartParams) => boolean; assertAutonomyCurrent?: (s:FbPosterSchedule)=>void; resolveParams?: (s: FbPosterSchedule) => StartParams; startRun?: (p: StartParams, id: string, options: RunStartOptions) => { runId: string }; isScheduleRunning?: (id: string) => boolean } = {}) {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const env = {
    t: T0, busy: false, seq: 0,
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
    started: [] as string[], missed: [] as MissedNotice[], changed: 0,
    block: (() => null) as (s: FbPosterSchedule, t: number) => string | null,
  };
  const sched = new FacebookPosterScheduler({
    store,
    now: () => env.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; env.timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    isBusy: () => env.busy,
    canStart: over.canStart ?? (() => true),
    resolveParams: over.resolveParams ?? (() => ({ kind: 'post' }) as unknown as StartParams),
    startRun: over.startRun ?? ((_p, id) => { env.started.push(id); return { runId: `run-${id}` }; }),
    newId: () => `gen-${++env.seq}`,
    onMissed: (n) => env.missed.push(n),
    onChanged: () => { env.changed++; },
    campaignBlock: (s, t) => env.block(s, t),
    assertAutonomyCurrent: over.assertAutonomyCurrent,
    isScheduleRunning: over.isScheduleRunning,
  });
  const add = (id: string, over: Record<string, unknown> = {}) => store.createSchedule({
    id, name: `Lịch ${id}`, kind: 'once', params: { kind: 'post', mode: 'group' }, runAt: T0, days: [], time: '',
    enabled: true, nextRunAt: T0, createdAt: 1, ...over,
  } as Parameters<FacebookPosterStore['createSchedule']>[0]);
  const live = () => env.timers.filter((x) => !x.cleared);
  return { store, env, sched, add, live };
}

test('autonomyCannotUseManualCampaignBypassOrMissingAuthorityCallback',()=>{
  const s=setup(); s.add('auto');
  s.store.updateAutonomySchedule('auto',{},T0,1);
  s.sched.bypassCampaignGateOnce('auto'); s.sched.start();
  expect(s.env.started).toEqual([]);
});

test.each(['paused','archived','missing','throw'])('autonomyCannotUseCampaignFailOpen(%s)',state=>{
  const s=setup({assertAutonomyCurrent:()=>{if(state==='throw') throw new Error('revoked');}});
  s.add('auto',{campaignId:'campaign'}); s.store.updateAutonomySchedule('auto',{},T0,1);
  jest.spyOn(s.store,'getCampaign').mockReturnValue(state==='missing'?null:{status:state==='throw'?'active':state} as any);
  s.sched.bypassCampaignGateOnce('auto'); s.sched.start(); expect(s.env.started).toEqual([]);
});
test('queuedAutonomyRechecksAuthorityAfterBusyAwait',()=>{
  let revoked=false; const s=setup({assertAutonomyCurrent:()=>{if(revoked) throw new Error('revoked');}});
  s.add('auto',{campaignId:'campaign'}); s.store.updateAutonomySchedule('auto',{},T0,1);
  jest.spyOn(s.store,'getCampaign').mockReturnValue({status:'active'} as any);
  s.env.busy=true; s.sched.start(); expect(s.sched.queuedIds()).toEqual(['auto']);
  revoked=true; s.env.busy=false; s.sched.onRunFinished(); expect(s.env.started).toEqual([]);
});

test('queuedAutonomyPreflightRunsOnlyWhenTheItemCanStart',()=>{
  const authority=jest.fn(); const s=setup({assertAutonomyCurrent:authority});
  s.add('auto',{campaignId:'campaign'}); s.store.updateAutonomySchedule('auto',{},T0,1);
  jest.spyOn(s.store,'getCampaign').mockReturnValue({status:'active'} as any);
  s.env.busy=true; s.sched.start(); expect(s.sched.queuedIds()).toEqual(['auto']);
  const atEnqueue=authority.mock.calls.length;
  for(let i=0;i<20;i++) s.sched.onResourcesChanged();
  expect(authority.mock.calls.length).toBe(atEnqueue);
  s.env.busy=false; s.sched.onResourcesChanged();
  expect(authority.mock.calls.length).toBe(atEnqueue+1); expect(s.env.started).toEqual(['auto']);
});

test.each([['refused switch', false], ['real revocation', true]] as const)('autonomyOccurrenceDueWhileBusyIsQueuedWithoutPreflight (%s)', (_label, revoked) => {
  let switching = true;
  const s = setup({ assertAutonomyCurrent: () => { if (switching || revoked) throw new Error('not current'); } });
  s.add('auto', { campaignId: 'campaign' }); s.store.updateAutonomySchedule('auto', {}, T0, 1);
  jest.spyOn(s.store, 'getCampaign').mockReturnValue({ status: 'active' } as any);
  s.env.busy = true; s.sched.start();
  expect(s.sched.queuedIds()).toEqual(['auto']); expect(s.env.missed).toEqual([]);
  switching = false; s.env.busy = false; s.sched.onResourcesChanged();
  if (revoked) { expect(s.env.started).toEqual([]); expect(s.env.missed.map(m => m.reason)).toEqual(['Không kiểm được quyền lịch tự động']); }
  else { expect(s.env.started).toEqual(['auto']); expect(s.env.missed).toEqual([]); }
});

describe('one live run per schedule', () => {
  function recurring(live: Set<string>) {
    const started: { id: string; options: RunStartOptions }[] = [];
    const ctx = setup({ isScheduleRunning: id => live.has(id),
      startRun: (_p, id, options) => { started.push({ id, options }); live.add(id); return { runId: `run-${id}-${started.length}` }; } });
    ctx.add('daily', { kind: 'recurring', days: [0, 1, 2, 3, 4, 5, 6], time: '12:00', runAt: null });
    return { ...ctx, started };
  }

  test('a due occurrence stays queued while the same schedule still runs, then starts with its original deadline', () => {
    const live = new Set<string>();
    const ctx = recurring(live);
    ctx.sched.start();
    expect(ctx.started.map(s => s.id)).toEqual(['daily']);
    ctx.env.t = T0 + 24 * 60 * MIN;
    ctx.store.updateSchedule('daily', { nextRunAt: ctx.env.t }, ctx.env.t);
    ctx.live().slice(-1)[0].fn();
    expect(ctx.sched.queuedIds()).toEqual(['daily']);
    expect(ctx.started).toHaveLength(1);
    const enqueuedAt = ctx.env.t;
    const runs = ctx.store.listRuns({ limit: 50, offset: 0 }).runs.length;
    ctx.env.t += 30 * MIN; ctx.sched.onResourcesChanged();
    expect(ctx.started).toHaveLength(1);
    expect(ctx.store.listRuns({ limit: 50, offset: 0 }).runs).toHaveLength(runs);
    live.clear(); ctx.sched.onRunFinished();
    expect(ctx.started.map(s => s.options)).toEqual([
      { priority: 'scheduled', deadlineAt: T0 + QUEUE_MAX_WAIT_MS },
      { priority: 'scheduled', deadlineAt: enqueuedAt + QUEUE_MAX_WAIT_MS },
    ]);
  });

  test('an occurrence blocked by its own live run is missed at its original deadline', () => {
    const live = new Set<string>();
    const ctx = recurring(live);
    ctx.sched.start();
    ctx.env.t = T0 + 24 * 60 * MIN;
    ctx.store.updateSchedule('daily', { nextRunAt: ctx.env.t }, ctx.env.t);
    ctx.live().slice(-1)[0].fn();
    expect(ctx.sched.queuedIds()).toEqual(['daily']);
    ctx.env.t += QUEUE_MAX_WAIT_MS;
    ctx.live().slice(-1)[0].fn();
    expect(ctx.sched.queuedIds()).toEqual([]);
    expect(ctx.started).toHaveLength(1);
    expect(ctx.env.missed.map(m => m.reason)).toEqual([MISSED_QUEUE_TIMEOUT]);
  });
});

describe('resource-aware scheduling', () => {
  test('busy profile does not consume capacity or hide an independent schedule', () => {
    let available = false;
    const started: { id: string; options: RunStartOptions }[] = [];
    const ctx = setup({
      resolveParams: s => ({ kind: 'scan_groups', profileIds: [s.id], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 }),
      canStart: p => p.kind === 'scan_groups' && (p.profileIds[0] === 'schedule-y' || available),
      startRun: (_p, id, options) => { started.push({ id, options }); return { runId: `run-${id}` }; },
    });
    ctx.add('schedule-x', { createdAt: 1 }); ctx.add('schedule-y', { createdAt: 2 });
    ctx.sched.start();
    expect(started.map(s => s.id)).toEqual(['schedule-y']);
    expect(ctx.sched.queuedIds()).toEqual(['schedule-x']);
    expect(ctx.store.getSchedule('schedule-x')!.lastRunId).toBeNull();
    ctx.env.t += 60_000; available = true;
    ctx.sched.onResourcesChanged();
    expect(started.map(s => s.id)).toEqual(['schedule-y', 'schedule-x']);
    expect(started.map(s => s.options)).toEqual([
      { priority: 'scheduled', deadlineAt: T0 + 7_200_000 },
      { priority: 'scheduled', deadlineAt: T0 + 7_200_000 },
    ]);
  });

  test('queued profile update is resolved again without resetting the occurrence deadline', () => {
    const options: RunStartOptions[] = [];
    const ctx = setup({
      resolveParams: s => s.params as StartParams,
      canStart: p => p.kind === 'scan_groups' && p.profileIds[0] === 'available',
      startRun: (_params, id, value) => { options.push(value); return { runId: `run-${id}` }; },
    });
    const params = { kind: 'scan_groups', profileIds: ['busy'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 };
    ctx.add('edited', { params }); ctx.sched.start(); expect(options).toEqual([]);
    ctx.env.t += 30_000;
    ctx.store.updateSchedule('edited', { params: { ...params, profileIds: ['available'] } }, ctx.env.t);
    ctx.sched.onResourcesChanged();
    expect(options).toEqual([{ priority: 'scheduled', deadlineAt: T0 + 7_200_000 }]);
    expect(ctx.sched.queuedIds()).toEqual([]);
  });

  test('stress: 200 queued schedules drain independent profiles drain without duplicate runs or reset deadlines', () => {
    const available = new Set<string>();
    const started: string[] = [];
    const deadlines: number[] = [];
    let ctx: ReturnType<typeof setup>;
    ctx = setup({
      resolveParams: s => ({ kind: 'scan_groups', profileIds: [s.id], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 }),
      canStart: p => p.kind === 'scan_groups' && available.has(p.profileIds[0]),
      startRun: (_p, id, options) => {
        started.push(id); deadlines.push(options.deadlineAt!); ctx.env.busy = true;
        ctx.sched.onResourcesChanged(); // reservation notifications may be synchronous
        return { runId: `run-${id}` };
      },
    });
    for (let i = 0; i < 200; i++) ctx.add(`schedule-${i}`, { createdAt: i });
    ctx.env.busy = true; ctx.sched.start();
    expect(ctx.sched.queuedIds()).toHaveLength(200);
    expect(ctx.store.listRuns({ limit: 10, offset: 0 }).total).toBe(0);
    for (let i = 199; i >= 0; i--) {
      available.add(`schedule-${i}`); ctx.env.busy = false; ctx.env.t += 1000;
      ctx.sched.onResourcesChanged();
      expect(started[started.length - 1]).toBe(`schedule-${i}`);
    }
    expect(new Set(started).size).toBe(200);
    expect(new Set(deadlines)).toEqual(new Set([T0 + 7_200_000]));
    expect(ctx.sched.queuedIds()).toEqual([]);
    expect(ctx.env.timers.every(timer => timer.ms > 0)).toBe(true);
  });

  test('expires at exact deadline without rearming a zero-delay timer', () => {
    const ctx = setup({ canStart: () => false }); ctx.add('blocked'); ctx.sched.start();
    ctx.env.t = T0 + 7_200_000; ctx.live()[0].fn();
    expect(ctx.env.started).toEqual([]);
    expect(ctx.sched.queuedIds()).toEqual([]);
    expect(ctx.env.missed[0].reason).toBe(MISSED_QUEUE_TIMEOUT);
    expect(ctx.env.timers.every(timer => timer.ms > 0)).toBe(true);
  });

  test.each(['delete', 'draft', 'disable'])('removes %s while capacity remains exhausted', mutation => {
    const ctx = setup(); ctx.add('queued'); ctx.env.busy = true; ctx.sched.start();
    if (mutation === 'delete') ctx.store.deleteSchedule('queued');
    else ctx.store.updateSchedule('queued', mutation === 'draft' ? { draft: true } : { enabled: false }, ctx.env.t);
    ctx.sched.onResourcesChanged();
    expect(ctx.sched.queuedIds()).toEqual([]);
    expect(ctx.env.started).toEqual([]);
    expect(ctx.store.listRuns({ limit: 10, offset: 0 }).total).toBe(0);
  });
});

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
  describe('campaign gate', () => {
    const PAUSED = 'Chiến dịch đang tạm dừng';
    test('recurring schedule of a blocked campaign: not run, not recorded, nextRunAt advances', () => {
      const { store, env, sched, add, live } = setup();
      const due = new Date(2026, 9, 7, 13, 0, 0).getTime();
      add('r', { kind: 'recurring', runAt: null, days: [1, 3, 5], time: '13:00', nextRunAt: due });
      env.block = () => PAUSED;
      sched.start();
      env.t = due;
      live()[0].fn();
      assert.deepStrictEqual(env.started, []);
      assert.deepStrictEqual(env.missed, []);
      assert.strictEqual(store.getSchedule('r')!.lastRunId, null);
      assert.strictEqual(store.getSchedule('r')!.nextRunAt, new Date(2026, 9, 9, 13, 0, 0).getTime());
    });

    test('resume: the next due time runs again', () => {
      const { env, sched, add, live } = setup();
      const due = new Date(2026, 9, 7, 13, 0, 0).getTime();
      const next = new Date(2026, 9, 9, 13, 0, 0).getTime();
      add('r', { kind: 'recurring', runAt: null, days: [1, 3, 5], time: '13:00', nextRunAt: due });
      env.block = () => PAUSED;
      sched.start();
      env.t = due;
      live()[0].fn();
      env.block = () => null;
      env.t = next;
      live()[0].fn();
      assert.deepStrictEqual(env.started, ['r']);
    });

    test.each(['Chiến dịch đang tạm dừng', 'Chiến dịch đã lưu trữ', 'Ngoài thời gian chiến dịch'])('once schedule records missed with reason %s', (reason) => {
      const { store, env, sched, add } = setup();
      add('a');
      env.block = () => reason;
      sched.start();
      const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
      assert.strictEqual(run.status, 'missed');
      assert.strictEqual(run.error, reason);
      assert.deepStrictEqual(env.missed, [{ scheduleId: 'a', name: 'Lịch a', reason, at: T0 }]);
      assert.deepStrictEqual(env.started, []);
      assert.deepStrictEqual(sched.queuedIds(), []);
    });

    test('"Đăng ngay" (bypassCampaignGateOnce) runs despite a paused campaign, only once', () => {
      const { env, sched, add, live } = setup();
      add('a');
      env.block = () => PAUSED;
      sched.bypassCampaignGateOnce('a');
      sched.start();
      assert.deepStrictEqual(env.started, ['a']);
      assert.deepStrictEqual(env.missed, []);
      // bypass chỉ áp dụng cho 'a'; lịch khác của chiến dịch vẫn bị chặn
      add('b');
      sched.reschedule();
      live()[0].fn();
      assert.deepStrictEqual(env.started, ['a']);
      assert.deepStrictEqual(env.missed.map((m: any) => [m.scheduleId, m.reason]), [['b', PAUSED]]);
    });

    test('an overdue schedule stays app-closed even when the campaign is blocked', () => {
      const { env, sched, add } = setup();
      add('a', { runAt: T0 - 5 * MIN, nextRunAt: T0 - 5 * MIN });
      env.block = () => PAUSED;
      sched.start();
      assert.deepStrictEqual(env.missed.map((m) => m.reason), [MISSED_APP_CLOSED]);
    });

    test('overdue branch clears the "Đăng ngay" bypass, so a later automatic run is gated again', () => {
      const { store, env, sched, add } = setup();
      add('a', { runAt: T0 - 5 * MIN, nextRunAt: T0 - 5 * MIN });
      env.block = () => PAUSED;
      sched.bypassCampaignGateOnce('a');
      sched.start();
      assert.deepStrictEqual(env.missed.map((m) => m.reason), [MISSED_APP_CLOSED]);
      store.updateSchedule('a', { nextRunAt: T0 }, T0);
      sched.reschedule();
      env.timers.filter((x) => !x.cleared)[0].fn();
      assert.deepStrictEqual(env.started, []);
      assert.deepStrictEqual(env.missed.map((m) => m.reason), [MISSED_APP_CLOSED, PAUSED]);
    });

    test('clearCampaignGateBypass drops the bypass for that schedule', () => {
      const { env, sched, add } = setup();
      add('a');
      env.block = () => PAUSED;
      sched.bypassCampaignGateOnce('a');
      sched.clearCampaignGateBypass('a');
      sched.start();
      assert.deepStrictEqual(env.started, []);
      assert.deepStrictEqual(env.missed.map((m) => m.reason), [PAUSED]);
    });

    test('paused while waiting in the queue: recorded missed, never started', () => {
      const { store, env, sched, add } = setup();
      add('a');
      env.busy = true;
      sched.start();
      assert.deepStrictEqual(sched.queuedIds(), ['a']);
      env.block = () => PAUSED;
      env.busy = false;
      sched.onRunFinished();
      assert.deepStrictEqual(env.started, []);
      assert.deepStrictEqual(sched.queuedIds(), []);
      const run = store.getRun(store.getSchedule('a')!.lastRunId!)!.run;
      assert.strictEqual(run.status, 'missed');
      assert.strictEqual(run.error, PAUSED);
      assert.strictEqual(env.missed[0].reason, PAUSED);
    });

    test('campaignBlock throwing does not block the schedule', () => {
      const { env, sched, add } = setup();
      add('a');
      env.block = () => { throw new Error('db down'); };
      sched.start();
      assert.deepStrictEqual(env.started, ['a']);
      assert.deepStrictEqual(env.missed, []);
    });
  });
});
