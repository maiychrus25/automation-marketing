import { initialRunState, reduceRunState, type PosterLog, type PosterRunAction, type PosterRunState } from '../../ui/features/facebookPoster/runState';
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
});
