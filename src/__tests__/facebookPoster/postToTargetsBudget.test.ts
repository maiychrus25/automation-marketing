import { postToTargets, type PostTargetResult } from '../../services/facebookPoster/postToTargets';
import type { TaskDeps } from '../../services/facebookPoster/types';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createAutonomyBudget } from '../../services/autonomy/autonomyBudget';
import type { LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import { memoryDb, runWithFakeTimers, fakeLocators } from './helpers';

const NOW = Date.UTC(2026, 10, 3, 10, 0);
const utcClock: LocalClock = {
  date: (ms) => new Date(ms).toISOString().slice(0, 10),
  minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
};
const group = (n: number) => `https://www.facebook.com/groups/${n}000000001/`;

function setup(enabled = true) {
  const db = memoryDb();
  const limiter = new AutonomyLimiter(db, { now: () => NOW, clock: utcClock, protectedWritesEnabled: () => true });
  limiter.ensureSchema();
  if (enabled) limiter.setPolicy({ enabled: true }, 'test');
  const status = (s: string) => db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM autonomy_actions WHERE status = ?', [s])!.n;
  return { db, limiter, status, budget: () => createAutonomyBudget(limiter, { profileId: 'p1', mode: 'group', runId: 'run-1' }) };
}

/** Fake page: `dialogCloses=false` leaves the composer open after the click; the Post button is missing for the first `noPublishAttempts` attempts. */
function fakePage(clicked: string[], opts: { dialogCloses?: boolean; noPublishAttempts?: number } = {}) {
  const { dialogCloses = true, noPublishAttempts = 0 } = opts;
  const noPublish = () => attempt <= noPublishAttempts;
  let attempt = 0;
  return {
    goto: async (u: string) => { if (u.includes('/groups/')) attempt++; },
    $: async () => null,
    on: () => {}, off: () => {},
    keyboard: { type: async () => {}, press: async () => {} },
    locator: fakeLocators(clicked),
    waitForFunction: async () => { throw new Error('timeout (fake)'); },
    waitForSelector: async (_s: string, o?: { state?: string }) => {
      if (o?.state === 'hidden') { if (!dialogCloses) throw new Error('dialog still open (fake)'); return true; }
      return noPublish() ? null : true;
    },
    evaluate: async (fn: { name: string }) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'readEditorTextInPage') return '';
      if (fn.name === 'markPublishButtonInPage') return !noPublish();
      return false;
    },
  };
}

function run(page: unknown, targets: string[], deps: Partial<TaskDeps> = {}) {
  const results: PostTargetResult[] = [];
  return runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets, minDelay: 0, maxDelay: 0 },
    {
      launch: async () => ({ ctx: { cookies: async () => [{ name: 'c_user', value: '1' }], close: async () => {} }, page }) as never,
      getIsStopping: () => false, sendLog: () => {}, updateProgress: () => {},
      onResult: (r: PostTargetResult) => results.push(r), pickRetryDelaySec: () => 1, ...deps,
    } as never,
  ));
}

describe('postToTargets autonomyBudget', () => {
  it('apiRunStopsAtGroupCapWithLimitReached', async () => {
    const { budget, status } = setup();
    const clicked: string[] = [];
    const out = await run(fakePage(clicked), [group(1), group(2), group(3), group(4)], { autonomyBudget: budget() });
    expect(clicked).toEqual(['publish', 'publish', 'publish']);
    expect(out.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(out.results[3]).toMatchObject({ errorCode: 'limit_reached', attempts: 1, error: 'Đã hết lượt trong ngày cho thao tác này' });
    expect(status('used')).toBe(3);
    expect(status('blocked')).toBe(1);
  });

  it('refusedTargetDoesNoPageWork', async () => {
    const { budget, limiter } = setup();
    limiter.setPolicy({ groupPostsPerDay: 0 }, 'test');
    const clicked: string[] = [];
    const calls: string[] = [];
    const page = fakePage(clicked);
    const spied = { ...page, goto: async (u: string) => { calls.push(u); }, evaluate: async () => { calls.push('evaluate'); return false; } };
    const out = await run(spied, [group(1)], { autonomyBudget: budget() });
    expect(out.results[0]).toMatchObject({ ok: false, errorCode: 'limit_reached', attempts: 1 });
    // Only the one home-page check before the loop; the target itself was never opened or typed into.
    expect(calls).toEqual(['https://www.facebook.com/']);
    expect(clicked).toEqual([]);
  });

  it('sameGroupWithinRepeatWindowIsSkipped', async () => {
    const { budget, status } = setup();
    const clicked: string[] = [];
    // First call posts to group 1; the second call (a new run) repeats group 1 and adds group 2.
    await run(fakePage(clicked), [group(1)], { autonomyBudget: budget() });
    const out = await run(fakePage(clicked), [group(1), group(2)], { autonomyBudget: budget() });
    expect(out.results.map((r) => r.errorCode)).toEqual(['limit_reached', '']);
    expect(out.results[1].ok).toBe(true);
    expect(clicked).toHaveLength(2);
    expect(status('used')).toBe(2);
  });

  it('failureBeforeClickReleasesReservation', async () => {
    const { budget, status } = setup();
    const clicked: string[] = [];
    const out = await run(fakePage(clicked, { noPublishAttempts: 9 }), [group(1)], { autonomyBudget: budget() });
    expect(out.results[0]).toMatchObject({ ok: false, errorCode: 'submit_not_found', attempts: 3 });
    expect(clicked).toEqual([]);
    // Every attempt released its own reservation; nothing stays counted.
    expect(status('released')).toBe(3);
    expect(status('reserved') + status('used')).toBe(0);
  });

  it('retriedTargetReleasesThenReservesAgainAndCountsOnce', async () => {
    const { budget, status, limiter } = setup();
    const clicked: string[] = [];
    const out = await run(fakePage(clicked, { noPublishAttempts: 1 }), [group(1)], { autonomyBudget: budget() });
    expect(out.results[0]).toMatchObject({ ok: true, attempts: 2 });
    expect(clicked).toEqual(['publish']);
    expect(status('released')).toBe(1);
    expect(status('used')).toBe(1);
    expect(limiter.usage().profiles.p1.groupPosts).toBe(1);
  });

  it('failureAfterClickKeepsReservation', async () => {
    const { budget, status } = setup();
    const clicked: string[] = [];
    const out = await run(fakePage(clicked, { dialogCloses: false }), [group(1)], { autonomyBudget: budget() });
    expect(out.results[0]).toMatchObject({ ok: false, errorCode: 'uncertain_after_submit', attempts: 1 });
    expect(clicked).toEqual(['publish']);
    expect(status('used')).toBe(1);
    expect(status('released')).toBe(0);
  });

  it('appOriginRunsAreNeverCounted', async () => {
    const { status, limiter } = setup(false);
    const clicked: string[] = [];
    const targets = [1, 2, 3, 4, 5].map(group);
    // No budget is attached for app runs: policy disabled and 5 groups still post.
    const out = await run(fakePage(clicked), targets);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(clicked).toHaveLength(5);
    expect(status('used') + status('reserved') + status('blocked')).toBe(0);
    expect(limiter.reserve({ action: 'group_post', origin: 'app', profileId: 'p1' })).toBeNull();
  });
});
