import assert from 'node:assert';
import { PostTrackScheduler, TRACK_TICK_MINUTES } from '../../services/facebookPoster/PostTrackScheduler';
import { AUTO_TRACK_GROUPS } from '../../services/facebookPoster/PostTracker';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';

const pair = (i: number) => ({ profileId: `p${i}`, groupUrl: `g${i}` });

function setup() {
  const env = {
    t: 1000, busy: false, autoEnabled: true, readThrows: false, due: [] as { profileId: string; groupUrl: string }[],
    runErr: null as Error | null, runs: [] as { pairs: unknown[]; auto: boolean }[], logs: [] as string[],
    dueArgs: [] as { now: number; limit: number }[],
    timers: [] as { fn: () => void; ms: number; cleared: boolean }[],
  };
  const sched = new PostTrackScheduler({
    now: () => env.t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; env.timers.push(h); return h; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    readConfig: () => { if (env.readThrows) throw new Error('boom'); return { autoEnabled: env.autoEnabled } as any; },
    isBusy: () => env.busy,
    duePairs: (now, limit) => { env.dueArgs.push({ now, limit }); return env.due.slice(0, limit); },
    runTrack: (pairs, auto) => { if (env.runErr) throw env.runErr; env.runs.push({ pairs, auto }); },
    log: (m) => env.logs.push(m),
  });
  const live = () => env.timers.filter((x) => !x.cleared);
  return { env, sched, live };
}

describe('Page/group timer fairness',()=>{
  test('trackingUsesOneFairTimer',()=>{
    const startedKinds:string[]=[];let busy=false,autoEnabled=true;const timers:unknown[]=[];
    const scheduler=new PostTrackScheduler({now:()=>0,setTimer:(fn)=>{timers.push(fn);return fn;},clearTimer:()=>{},
      readConfig:()=>({autoEnabled} as any),isBusy:()=>busy,duePairs:()=>[pair(1)],runTrack:()=>{startedKinds.push('group');},
      runDueCampaignTracking:()=>{startedKinds.push('page');return true;},log:()=>{}});
    scheduler.start();for(let i=0;i<4;i++)scheduler.tickNow();
    expect(startedKinds).toEqual(['group','page','group','page']);expect(timers).toHaveLength(1);
    busy=true;scheduler.tickNow();expect(startedKinds).toHaveLength(4);
    busy=false;autoEnabled=false;scheduler.tickNow();expect(startedKinds).toEqual(['group','page','group','page','page']);
  });
});

describe('PostTrackScheduler', () => {
  test('start arms a timer every tick and re-arms after firing', () => {
    const { env, sched, live } = setup();
    sched.start();
    assert.strictEqual(live().length, 1);
    assert.strictEqual(live()[0].ms, TRACK_TICK_MINUTES * 60_000);
    live()[0].fn();
    assert.strictEqual(live().length, 2);
    assert.strictEqual(env.runs.length, 0);
  });

  test('autoEnabled off → does nothing', () => {
    const { env, sched } = setup();
    env.autoEnabled = false; env.due = [pair(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(env.dueArgs.length, 0);
  });

  test('busy → skip tick', () => {
    const { env, sched } = setup();
    env.busy = true; env.due = [pair(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(env.dueArgs.length, 0);
  });

  test('nothing due → no run', () => {
    const { env, sched } = setup();
    sched.tickNow();
    assert.strictEqual(env.runs.length, 0);
  });

  test('due pairs → runTrack with at most AUTO_TRACK_GROUPS pairs and auto=true', () => {
    const { env, sched } = setup();
    env.due = Array.from({ length: 15 }, (_, i) => pair(i));
    sched.tickNow();
    assert.strictEqual(env.dueArgs[0].limit, AUTO_TRACK_GROUPS);
    assert.strictEqual(env.dueArgs[0].now, 1000);
    assert.strictEqual(env.runs.length, 1);
    assert.strictEqual(env.runs[0].pairs.length, 10);
    assert.strictEqual(env.runs[0].auto, true);
  });

  test('runTrack throwing BUSY → treated as busy, not logged', () => {
    const { env, sched, live } = setup();
    env.due = [pair(1)]; env.runErr = new Error(BUSY_ERROR);
    sched.start();
    live()[0].fn();
    assert.deepStrictEqual(env.logs, []);
    assert.strictEqual(live().length, 2);
  });

  test('runTrack non-BUSY error is logged and scheduler keeps going', () => {
    const { env, sched, live } = setup();
    env.due = [pair(1)]; env.runErr = new Error('khác');
    sched.start();
    live()[0].fn();
    assert.strictEqual(env.logs.length, 1);
    assert.ok(env.logs[0].includes('khác'));
    assert.strictEqual(live().length, 2);
  });

  test('readConfig failure falls back to defaults (auto on) without throwing', () => {
    const { env, sched } = setup();
    env.readThrows = true; env.due = [pair(1)];
    sched.tickNow();
    assert.strictEqual(env.runs.length, 1);
    assert.strictEqual(env.logs.length, 1);
  });

  test('stop clears the timer and later fires do nothing', () => {
    const { env, sched, live } = setup();
    env.due = [pair(1)];
    sched.start();
    const h = live()[0];
    sched.stop();
    assert.strictEqual(live().length, 0);
    h.fn();
    assert.strictEqual(env.runs.length, 0);
    assert.strictEqual(live().length, 0);
  });
});
