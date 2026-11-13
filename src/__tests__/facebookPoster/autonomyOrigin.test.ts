import fs from 'fs';
import os from 'os';
import path from 'path';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { FacebookPosterScheduler } from '../../services/facebookPoster/FacebookPosterScheduler';
import { FacebookPosterService, type StartParams } from '../../services/facebookPoster/FacebookPosterService';
import { approveDraft, saveDraft, type DraftDeps } from '../../services/facebookPoster/drafts';
import { apiScheduleOrigin, planScheduleUpdate } from '../../services/facebookPoster/scheduleUpdate';
import { FB_POSTER_MIGRATIONS, FB_POSTER_SCHEMA_SQL } from '../../services/facebookPoster/schema';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { cancelApiWork } from '../../services/autonomy/cancelApiWork';
import { createAutonomyBudget } from '../../services/autonomy/autonomyBudget';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import { memoryDb } from './helpers';

// 10:00 UTC on 2026-11-03: outside quiet hours.
const NOW = Date.UTC(2026, 10, 3, 10, 0);
const utcClock: LocalClock = {
  date: (ms) => new Date(ms).toISOString().slice(0, 10),
  minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
};
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup(clockNow = NOW) {
  const db = memoryDb();
  const store = new FacebookPosterStore(db);
  store.ensureSchema();
  const limiter = new AutonomyLimiter(db, { now: () => clockNow, clock: utcClock, protectedWritesEnabled: () => true });
  limiter.ensureSchema();
  limiter.setPolicy({ enabled: true }, 'test');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-origin-'));
  dirs.push(baseDir);
  let seq = 0;
  const deps: DraftDeps = {
    store, baseDir, maxSchedules: 200, now: () => clockNow, newId: () => `d${++seq}`, autonomy: limiter,
    env: { profileExists: (id) => id === 'p1', fileExists: (p) => fs.existsSync(p), fileSize: (p) => fs.statSync(p).size },
  };
  return { db, store, limiter, deps };
}
const draftParams = () => ({ mode: 'group', text: 'Tuyển Sale', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] });

describe('migration', () => {
  it('migrationDefaultsOldRowsToApp', () => {
    const db = memoryDb();
    db.exec(FB_POSTER_SCHEMA_SQL);
    const old = FB_POSTER_MIGRATIONS.filter((sql) => !/ADD COLUMN origin\b/.test(sql));
    for (const sql of old) { try { db.exec(sql); } catch { /* existing column */ } }
    expect(db.query<{ name: string }>('PRAGMA table_info(fb_poster_runs)').some((c) => c.name === 'origin')).toBe(false);
    db.run(`INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES ('old', 'post', 'group', '{}', 'done', 1)`);
    db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, days, time, enabled, next_run_at, created_at, updated_at)
            VALUES ('s-old', 'Old', 'once', '{}', '', '', 1, 5, 1, 1)`);
    for (const sql of FB_POSTER_MIGRATIONS) { try { db.exec(sql); } catch { /* existing column */ } }
    const store = new FacebookPosterStore(db);
    expect(store.getRun('old')!.run.origin).toBe('app');
    expect(store.getSchedule('s-old')!.origin).toBe('app');
  });
});

describe('origin plumbing', () => {
  it('apiApprovalCreatesApiOriginScheduleAndRun', async () => {
    const { store, deps } = setup();
    const a = saveDraft(deps, { params: draftParams() });
    const b = saveDraft(deps, { params: draftParams() });
    expect(approveDraft(deps, { id: a.id, when: 'now' }, 'api')).toMatchObject({ origin: 'api', enabled: true });
    expect(approveDraft(deps, { id: b.id, when: 'now' })).toMatchObject({ origin: 'app' });
    // scheduleUpdate path never changes origin.
    store.updateSchedule(a.id, { name: 'Renamed' }, NOW);
    expect(store.getSchedule(a.id)!.origin).toBe('api');

    // The scheduler hands an api schedule's origin to startRun; an app schedule leaves the default.
    const options: unknown[] = [];
    const sched = new FacebookPosterScheduler({
      store, now: () => NOW, setTimer: () => ({}), clearTimer: () => {}, isBusy: () => false, canStart: () => true,
      resolveParams: () => ({ kind: 'post' }) as unknown as StartParams,
      startRun: (_p, id, o) => { options.push([id, o.origin]); return { runId: `run-${id}` }; },
      newId: () => 'gen', onMissed: () => {}, onChanged: () => {}, campaignBlock: () => null,
    });
    sched.start();
    expect(options).toEqual(expect.arrayContaining([[a.id, 'api'], [b.id, undefined]]));

    // The service stores the origin on the run and only attaches a budget for api post runs without a guard.
    const seen: { origin: string | undefined; budget: boolean }[] = [];
    const service = new FacebookPosterService({
      store, getProfile: (id) => ({ id, name: id }), emit: () => {}, newId: () => `r${seen.length + 1}`,
      acquireProfile: async (profileId) => ({ profileId, open: async () => { throw new Error('unused'); }, release: () => {} }),
      createAutonomyBudget: () => ({ check: () => {}, reserve: () => 1, commit: () => {}, release: () => {} }),
      tasks: { postToTargets: (async (_input: unknown, d: { autonomyBudget?: unknown }) => { seen.push({ origin: undefined, budget: !!d.autonomyBudget }); return { posted: 0, failed: 0, results: [] }; }) as never },
    });
    const post = { kind: 'post', mode: 'group', text: 't', mediaPaths: [], comment: null, profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/'] }], minDelaySec: 0, maxDelaySec: 0, concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } as StartParams;
    const apiRun = service.start(post, undefined, { origin: 'api' }).runId; await service.whenIdle();
    const appRun = service.start(post).runId; await service.whenIdle();
    expect(store.getRun(apiRun)!.run.origin).toBe('api');
    expect(store.getRun(appRun)!.run.origin).toBe('app');
    expect(seen.map((s) => s.budget)).toEqual([true, false]);
  });

  it('apiScheduleUpdateRunGetsAutonomyBudget', async () => {
    const { store, deps, limiter } = setup();
    const draft = saveDraft(deps, { params: draftParams() });
    approveDraft(deps, { id: draft.id, when: 'schedule', kind: 'once', runAt: NOW + 3_600_000 });
    store.updateSchedule(draft.id, { enabled: false, nextRunAt: null }, NOW);
    expect(store.getSchedule(draft.id)!.origin).toBe('app');
    // The bot turns the operator's schedule back on through schedules.update (the IPC path in posterOperations.scheduleUpdate).
    const current = store.getSchedule(draft.id)!;
    const fields = planScheduleUpdate(current, { enabled: true, runAt: NOW + 2 * 60_000 }, NOW);
    store.updateSchedule(draft.id, { ...fields, ...apiScheduleOrigin(current, fields, limiter) }, NOW);
    expect(store.getSchedule(draft.id)!.origin).toBe('api');

    // When it fires, the scheduler starts an api run and the service attaches the autonomy budget to it.
    const budgets: boolean[] = [];
    const service = new FacebookPosterService({
      store, getProfile: (id) => ({ id, name: id }), emit: () => {}, newId: () => 'run-from-schedule',
      // Cùng đồng hồ giả với scheduler: hạn chờ của lượt hẹn tính từ NOW, đồng hồ thật sẽ luôn quá hạn.
      now: () => NOW + 3 * 60_000,
      acquireProfile: async (profileId) => ({ profileId, open: async () => { throw new Error('unused'); }, release: () => {} }),
      createAutonomyBudget: () => ({ check: () => {}, reserve: () => 1, commit: () => {}, release: () => {} }),
      tasks: { postToTargets: (async (_input: unknown, d: { autonomyBudget?: unknown }) => { budgets.push(!!d.autonomyBudget); return { posted: 0, failed: 0, results: [] }; }) as never },
    });
    const post = { kind: 'post', mode: 'group', text: 't', mediaPaths: [], comment: null, profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/'] }], minDelaySec: 0, maxDelaySec: 0, concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 } as StartParams;
    const sched = new FacebookPosterScheduler({
      store, now: () => NOW + 3 * 60_000, setTimer: () => ({}), clearTimer: () => {}, isBusy: () => false, canStart: () => true,
      resolveParams: () => post, startRun: (p, id, o) => service.start(p, id, o),
      newId: () => 'gen', onMissed: () => {}, onChanged: () => {}, campaignBlock: () => null,
    });
    sched.start();
    await service.whenIdle();
    expect(store.getRun('run-from-schedule')!.run.origin).toBe('api');
    expect(budgets).toEqual([true]);
  });

  it('approveNowRejectedDuringQuietHours', () => {
    const { deps, store } = setup(Date.UTC(2026, 10, 3, 23, 0));
    const draft = saveDraft(deps, { params: draftParams() });
    let error: any;
    try { approveDraft(deps, { id: draft.id, when: 'now' }, 'api'); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'quiet_hours' } });
    expect(store.getSchedule(draft.id)).toMatchObject({ draft: true, enabled: false });
    // The operator's own approval is never limited.
    expect(approveDraft(deps, { id: draft.id, when: 'now' })).toMatchObject({ enabled: true, origin: 'app' });
  });

  it('approveScheduleOnlyChecksStoppedAndMasterOff', () => {
    const { deps, limiter } = setup(Date.UTC(2026, 10, 3, 23, 0));
    const draft = saveDraft(deps, { params: draftParams() });
    const when = { id: draft.id, when: 'schedule' as const, kind: 'once', runAt: Date.UTC(2026, 10, 4, 10, 0) };
    limiter.setPolicy({ enabled: false }, 'test');
    expect(() => approveDraft(deps, when, 'api')).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'stopped' }) }));
    limiter.setPolicy({ enabled: true }, 'test');
    // Quiet hours do not stop a schedule being created.
    expect(approveDraft(deps, when, 'api')).toMatchObject({ origin: 'api', enabled: true });
  });
});

describe('cancelApiWork', () => {
  it('stopCancelsApiRunsAndDisablesApiSchedulesOnly', () => {
    const { store } = setup();
    const add = (id: string, origin: 'api' | 'app') => {
      store.createSchedule({ id, name: id, kind: 'once', params: {}, runAt: NOW, days: [], time: '', enabled: true, nextRunAt: NOW, createdAt: 1 });
      store.updateSchedule(id, { origin }, 1);
    };
    add('api-1', 'api'); add('api-2', 'api'); add('app-1', 'app');
    const cancelled: string[] = [];
    const runs = [
      { id: 'run-api', origin: 'api' }, { id: 'run-app', origin: 'app' }, { id: 'run-api-gone', origin: 'api' },
    ] as never[];
    const result = cancelApiWork({ store, now: () => NOW, activeRuns: () => runs, cancelRun: (id) => { cancelled.push(id); return id !== 'run-api-gone'; } });
    expect(result).toEqual({ cancelledRuns: 1, disabledSchedules: 2 });
    expect(cancelled).toEqual(['run-api', 'run-api-gone']);
    expect(store.getSchedule('api-1')).toMatchObject({ enabled: false, nextRunAt: null, origin: 'api' });
    expect(store.getSchedule('api-2')).toMatchObject({ enabled: false, nextRunAt: null });
    expect(store.getSchedule('app-1')).toMatchObject({ enabled: true, nextRunAt: NOW });
  });

  it('cancelContinuesWhenOneRunCancelThrows', () => {
    const { store } = setup();
    store.createSchedule({ id: 'api-1', name: 'a', kind: 'once', params: {}, runAt: NOW, days: [], time: '', enabled: true, nextRunAt: NOW, createdAt: 1 });
    store.updateSchedule('api-1', { origin: 'api' }, 1);
    const tried: string[] = [];
    const runs = [{ id: 'r1', origin: 'api' }, { id: 'r2', origin: 'api' }, { id: 'r3', origin: 'api' }] as never[];
    const result = cancelApiWork({ store, now: () => NOW, activeRuns: () => runs, cancelRun: (id) => { tried.push(id); if (id === 'r2') throw new Error('boom'); return true; } });
    expect(tried).toEqual(['r1', 'r2', 'r3']);
    expect(result).toEqual({ cancelledRuns: 2, disabledSchedules: 1 });
    expect(store.getSchedule('api-1')!.enabled).toBe(false);
  });

  it('leavesCampaignAuthoritySchedulesAlone', () => {
    const { store } = setup();
    store.createSchedule({ id: 'camp', name: 'camp', kind: 'once', params: {}, runAt: NOW, days: [], time: '', enabled: true, nextRunAt: NOW, createdAt: 1 });
    store.updateAutonomySchedule('camp', { origin: 'api' }, 1, 1);
    expect(cancelApiWork({ store, now: () => NOW, activeRuns: () => [], cancelRun: () => true })).toEqual({ cancelledRuns: 0, disabledSchedules: 0 });
    expect(store.getSchedule('camp')!.enabled).toBe(true);
  });
});

describe('cancelApiWork wake', () => {
  it('wakesEventWaitersOnlyAfterOwnerCampaignSchedulesWereCancelled', () => {
    const { store } = setup();
    const wake = jest.fn();
    const base = { store, now: () => NOW, activeRuns: () => [], cancelRun: () => true, wakeEventWaiters: wake };
    cancelApiWork({ ...base, cancelOwnerCampaignSchedules: () => 0 });
    expect(wake).not.toHaveBeenCalled();
    expect(cancelApiWork({ ...base, cancelOwnerCampaignSchedules: () => 2 })).toEqual({ cancelledRuns: 0, disabledSchedules: 2 });
    expect(wake).toHaveBeenCalledTimes(1);
    // Best-effort: a failing wake never breaks the stop.
    expect(cancelApiWork({ ...base, cancelOwnerCampaignSchedules: () => 1, wakeEventWaiters: () => { throw new Error('boom'); } })).toEqual({ cancelledRuns: 0, disabledSchedules: 1 });
  });
});

describe('createAutonomyBudget', () => {
  it('usesGroupActionAndNormalizedTargetKey', () => {
    const { limiter, db } = setup();
    const budget = createAutonomyBudget(limiter, { profileId: 'p1', mode: 'group', runId: 'run-1' });
    const id = budget.reserve('https://www.facebook.com/groups/123456789?ref=x');
    budget.commit(id);
    const row = db.queryOne<{ action: string; target_key: string; origin: string; status: string; ref: string }>('SELECT * FROM autonomy_actions WHERE id = ?', [id])!;
    expect(row).toMatchObject({ action: 'group_post', origin: 'api', status: 'used', ref: 'run-1' });
    expect(row.target_key).toContain('123456789');
    const pageBudget = createAutonomyBudget(limiter, { profileId: 'p1', mode: 'page', runId: 'run-2' });
    expect(db.queryOne<{ action: string }>('SELECT action FROM autonomy_actions WHERE id = ?', [pageBudget.reserve('https://www.facebook.com/')])!.action).toBe('page_post');
  });
});
