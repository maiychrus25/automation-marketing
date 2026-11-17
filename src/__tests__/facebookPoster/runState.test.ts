import { RUN_NOT_FOUND_ERROR } from '../../models/facebookPoster';
import { initialRunState, reduceRunState, runsToSettle, shouldSettleRun, MAX_LIVE_RUNS, type PosterLog, type PosterRunAction, type PosterRunState } from '../../ui/features/facebookPoster/runState';
import type { RunSnapshot } from '../../services/facebookPoster/FacebookPosterService';
import type { FbPosterRun } from '../../models/facebookPoster';

const run = (id: string, patch: Partial<FbPosterRun> = {}): FbPosterRun => ({
  id, kind: 'post', mode: 'group', params: {}, status: 'running', error: '', startedAt: 1, finishedAt: null,
  scheduleId: null, scheduleName: null, campaignId: null, ...patch,
});
const snapshot = (id: string, patch: Partial<FbPosterRun> = {}, done = 0): RunSnapshot => ({
  run: run(id, patch), progress: { runId: id, done, total: 4, profiles: [{ profileId: 'p1', state: 'waiting', done: 0, total: 4, waitingReason: `Chờ profile ${id}` }] },
});
const log = (runId: string, message: string): PosterLog => ({ runId, profileId: 'p1', level: 'info', message, at: 1 });
const reduceAll = (actions: PosterRunAction[], state: PosterRunState = initialRunState) => actions.reduce(reduceRunState, state);

describe('poster run state', () => {
  it('keeps at most 500 logs per run and never mixes interleaved runs', () => {
    const actions: PosterRunAction[] = [{ type: 'reconcile', runs: [snapshot('run-a'), snapshot('run-b')] }];
    for (let i = 0; i < 600; i++) {
      actions.push({ type: 'log', entry: log('run-a', `a${i}`) });
      if (i % 3 === 0) actions.push({ type: 'log', entry: log('run-b', `b${i}`) });
    }
    const state = reduceAll(actions);
    expect(state.logs['run-a']).toHaveLength(500);
    expect(state.logs['run-a'][0].message).toBe('a100');
    expect(state.logs['run-a'][499].message).toBe('a599');
    expect(state.logs['run-b'][0].runId).toBe('run-b');
    expect(state.logs['run-b'].every(entry => entry.runId === 'run-b')).toBe(true);
  });

  it('caches only live runs plus the selected one, however long the history', () => {
    let state = reduceAll([{ type: 'reconcile', runs: [snapshot('run-0')] }, { type: 'select', runId: 'run-0' }]);
    for (let i = 1; i <= 20; i++) {
      state = reduceAll([
        { type: 'reconcile', runs: [snapshot(`run-${i}`)] },
        { type: 'log', entry: log(`run-${i}`, 'start') },
        { type: 'progress', progress: { runId: `run-${i}`, done: 1, total: 4, profiles: [] } },
        { type: 'finished', runId: `run-${i}`, status: 'done' },
      ], state);
    }
    // Unknown-metadata runs (logs only) are bounded too.
    for (let i = 0; i < 10; i++) state = reduceRunState(state, { type: 'log', entry: log(`ghost-${i}`, 'x') });
    expect(Object.keys(state.logs).length).toBeLessThanOrEqual(3);
    expect(Object.keys(state.runs).length).toBeLessThanOrEqual(3);
    expect(state.selectedRunId).toBe('run-0');
    expect(state.runs['run-0']).toBeDefined();
  });

  it('does not change the selection on events of other runs', () => {
    let state = reduceAll([{ type: 'reconcile', runs: [snapshot('run-a'), snapshot('run-b')] }, { type: 'select', runId: 'run-a' }]);
    const selectedBefore = state.selectedRunId;
    state = reduceAll([
      { type: 'reconcile', runs: [snapshot('run-c', { startedAt: 5 })] },
      { type: 'log', entry: log('run-b', 'other') },
      { type: 'progress', progress: { runId: 'run-b', done: 2, total: 4, profiles: [] } },
      { type: 'finished', runId: 'run-b', status: 'done' },
    ], state);
    const selectedAfterUnrelatedEvent = state.selectedRunId;
    expect(selectedAfterUnrelatedEvent).toBe(selectedBefore);
    expect(selectedBefore).toBe('run-a');
  });

  it('selects the first reconciled run only when nothing is selected', () => {
    const state = reduceAll([{ type: 'reconcile', runs: [snapshot('run-a'), snapshot('run-b')] }]);
    expect(state.selectedRunId).toBe('run-a');
    expect(reduceRunState(state, { type: 'select', runId: 'run-b' }).selectedRunId).toBe('run-b');
  });

  it('replays bootstrap events after the snapshot and never revives a finished run', () => {
    const buffered: PosterRunAction[] = [
      { type: 'log', entry: log('run-a', 'buffered') },
      { type: 'finished', runId: 'run-a', status: 'done' },
    ];
    let state = reduceAll([{ type: 'select', runId: 'run-a' }, { type: 'reconcile', runs: [snapshot('run-a', {}, 3)] }, ...buffered]);
    const runFinishedDuringBootstrap = state.runs['run-a'].run;
    expect(runFinishedDuringBootstrap.status).toBe('done');
    expect(state.logs['run-a'].map(entry => entry.message)).toEqual(['buffered']);
    // A late snapshot (e.g. a slow getRun) must not bring the run back to running or lose its last progress.
    state = reduceRunState(state, { type: 'reconcile', runs: [snapshot('run-a')] });
    expect(state.runs['run-a'].run.status).toBe('done');
    expect(state.runs['run-a'].progress.done).toBe(3);
  });

  it('reconciles by ID without duplicates and keeps each run its own waiting reason', () => {
    const state = reduceAll([
      { type: 'reconcile', runs: [snapshot('run-a'), snapshot('run-b')] },
      { type: 'reconcile', runs: [snapshot('run-a', {}, 2), snapshot('run-b')] },
      { type: 'progress', progress: { runId: 'run-b', done: 1, total: 4, profiles: [{ profileId: 'p1', state: 'waiting', done: 1, total: 4, waitingReason: 'Chờ profile B' }] } },
    ]);
    expect(Object.keys(state.runs)).toEqual(['run-a', 'run-b']);
    expect(state.runs['run-a'].progress.done).toBe(2);
    expect(state.runs['run-a'].progress.profiles[0].waitingReason).toBe('Chờ profile run-a');
    expect(state.runs['run-b'].progress.profiles[0].waitingReason).toBe('Chờ profile B');
  });

  it('ignores progress and finished events of unknown runs and is pure', () => {
    const before = reduceAll([{ type: 'reconcile', runs: [snapshot('run-a')] }]);
    const frozen = JSON.stringify(before);
    const after = reduceAll([
      { type: 'progress', progress: { runId: 'run-x', done: 1, total: 1, profiles: [] } },
      { type: 'finished', runId: 'run-x', status: 'failed' },
    ], before);
    expect(after.runs['run-x']).toBeUndefined();
    expect(JSON.stringify(before)).toBe(frozen);
  });

  describe('settling runs the boss no longer reports (employee reconnect)', () => {
    const live = () => reduceAll([{ type: 'reconcile', runs: [snapshot('run-a'), snapshot('run-b'), snapshot('run-c', { status: 'done' })] }]);

    it('lists a live run that is missing from active(), not a present or terminal one', () => {
      const state = live();
      expect(runsToSettle(state.runs, ['run-b'])).toEqual(['run-a']);
      expect(runsToSettle(state.runs, ['run-a', 'run-b'])).toEqual([]);
      expect(runsToSettle(state.runs, [])).toEqual(['run-a', 'run-b']);
    });

    it('settle ends the run as failed with the note and frees a live slot', () => {
      const before = live();
      const liveCount = (s: PosterRunState) => Object.values(s.runs).filter((r) => r.run.status === 'running').length;
      expect(liveCount(before)).toBe(MAX_LIVE_RUNS);
      const after = reduceAll([{ type: 'settle', runId: 'run-a', error: 'Không rõ kết quả, xem Lịch sử', at: 42 }], before);
      expect(after.runs['run-a'].run.status).toBe('failed');
      expect(after.runs['run-a'].run.error).toBe('Không rõ kết quả, xem Lịch sử');
      // The live panel shows log lines, not run.error: the note must be the last log line of that run.
      expect(after.logs['run-a'].at(-1)).toEqual({ runId: 'run-a', profileId: '', level: 'error', message: 'Không rõ kết quả, xem Lịch sử', at: 42 });
      expect(liveCount(after)).toBe(MAX_LIVE_RUNS - 1);
    });

    it('settle never revives or overwrites a run that is already terminal or unknown', () => {
      const done = reduceAll([{ type: 'reconcile', runs: [snapshot('run-c', { status: 'done' })] }]);
      expect(reduceAll([{ type: 'settle', runId: 'run-c', error: 'x', at: 1 }], done)).toBe(done);
      expect(reduceAll([{ type: 'settle', runId: 'nope', error: 'x', at: 1 }], done)).toBe(done);
    });

    it('a lost run is settled only on a definite refusal, never on a transient or unexplained failure', () => {
      for (const code of ['RECORD_FORBIDDEN', 'PROFILE_FORBIDDEN', 'MODULE_FORBIDDEN']) expect(shouldSettleRun({ success: false, code })).toBe(true);
      // The handler's own "run not found" has no code: it is recognised by its exact text.
      expect(shouldSettleRun({ success: false, error: RUN_NOT_FOUND_ERROR })).toBe(true);
      for (const code of ['TIMEOUT', 'NOT_CONNECTED', 'BAD_RESPONSE', 'WORKSPACE_MISMATCH', 'BODY_TOO_LARGE']) expect(shouldSettleRun({ success: false, code })).toBe(false);
      // A failure without a code (401 Unauthorized, 500, a tunnel interstitial) says nothing about the run.
      expect(shouldSettleRun({ success: false, error: 'Unauthorized' })).toBe(false);
      expect(shouldSettleRun({ success: false })).toBe(false);
      expect(shouldSettleRun(undefined)).toBe(false);
      expect(shouldSettleRun(null)).toBe(false);
      expect(shouldSettleRun({ success: true })).toBe(false);
    });

    it('without a settle action the reducer keeps a missing live run live (boss path unchanged)', () => {
      const after = reduceAll([{ type: 'reconcile', runs: [snapshot('run-b')] }], live());
      expect(after.runs['run-a'].run.status).toBe('running');
    });
  });
});
