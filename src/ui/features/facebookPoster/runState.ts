import type { RunSnapshot, ProgressSnapshot } from '../../../services/facebookPoster/FacebookPosterService';
import { RUN_NOT_FOUND_ERROR, type FbPosterRun } from '../../../models/facebookPoster';

export type { RunSnapshot, ProgressSnapshot };
export interface PosterLog { runId: string; profileId: string; level: string; message: string; at: number }
export type PosterRunState = { runs: Record<string, RunSnapshot>; logs: Record<string, PosterLog[]>; selectedRunId: string | null };
export type PosterRunAction =
  | { type: 'reconcile'; runs: RunSnapshot[] }
  | { type: 'select'; runId: string }
  | { type: 'log'; entry: PosterLog }
  | { type: 'progress'; progress: ProgressSnapshot }
  | { type: 'finished'; runId: string; status: FbPosterRun['status'] }
  /** Employee only: a run the boss no longer reports and whose record the boss refuses to give (runFinished was lost, the profile was unassigned). */
  | { type: 'settle'; runId: string; error: string; at: number };

export const MAX_LOGS_PER_RUN = 500;
/** Mirrors MAX_ACTIVE_POSTER_RUNS (the coordinator imports node crypto, so the renderer cannot import it). */
export const MAX_LIVE_RUNS = 2;
/** Live runs plus the one being viewed. */
export const MAX_CACHED_RUNS = MAX_LIVE_RUNS + 1;
/** UI hint only; the coordinator still decides admission. */
export const CAPACITY_REASON = 'Đã đạt giới hạn lượt chạy (tối đa 2). Đợi một lượt xong hoặc hủy bớt.';

export const initialRunState: PosterRunState = { runs: {}, logs: {}, selectedRunId: null };

/** A run without metadata yet (logs only) is treated as live until reconciled. */
const isLive = (state: PosterRunState, runId: string) => (state.runs[runId]?.run.status ?? 'running') === 'running';

function prune(state: PosterRunState): PosterRunState {
  const selected = state.selectedRunId;
  const ids = [...new Set([...Object.keys(state.runs), ...Object.keys(state.logs)])];
  const others = ids.filter(id => id !== selected && isLive(state, id));
  const keep = new Set([...(selected ? [selected] : []), ...others.slice(-(MAX_CACHED_RUNS - (selected ? 1 : 0)))]);
  if (ids.every(id => keep.has(id))) return state;
  const pick = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => keep.has(id)));
  return { ...state, runs: pick(state.runs), logs: pick(state.logs) };
}

function reconcile(state: PosterRunState, snapshots: RunSnapshot[]): PosterRunState {
  const runs = { ...state.runs };
  for (const snapshot of snapshots) {
    const known = runs[snapshot.run.id];
    // Terminal is sticky: a late snapshot must not revive a finished run (tombstone).
    if (known && known.run.status !== 'running') continue;
    // A terminal record (getRun) carries no progress; keep the last live one.
    runs[snapshot.run.id] = known && snapshot.run.status !== 'running' ? { run: snapshot.run, progress: known.progress } : snapshot;
  }
  return { ...state, runs, selectedRunId: state.selectedRunId ?? snapshots[0]?.run.id ?? null };
}

/** Employee reconnect: ids of runs held as running that the fresh active() answer does not contain. */
export function runsToSettle(runs: Record<string, RunSnapshot>, activeIds: readonly string[]): string[] {
  return Object.values(runs).filter((s) => s.run.status === 'running' && !activeIds.includes(s.run.id)).map((s) => s.run.id);
}

/** Answers that mean "this run is no longer yours or no longer exists". Anything else (no answer, a timeout, 401/500 without a code) says nothing about the run. */
const SETTLE_CODES: ReadonlySet<string> = new Set(['RECORD_FORBIDDEN', 'PROFILE_FORBIDDEN', 'MODULE_FORBIDDEN']);

/** Employee reconnect: a missing run is ended locally only when the boss definitely refuses its record or says it does not exist; otherwise it stays live and the next resync asks again. */
export function shouldSettleRun(res: { success?: boolean; code?: string; error?: string } | null | undefined): boolean {
  return !!res && res.success === false && (SETTLE_CODES.has(res.code ?? '') || res.error === RUN_NOT_FOUND_ERROR);
}

export function reduceRunState(state: PosterRunState, action: PosterRunAction): PosterRunState {
  switch (action.type) {
    case 'reconcile': return prune(reconcile(state, action.runs));
    case 'select': return prune({ ...state, selectedRunId: action.runId });
    case 'log': {
      const { runId } = action.entry;
      const logs = [...(state.logs[runId] ?? []), action.entry].slice(-MAX_LOGS_PER_RUN);
      return prune({ ...state, logs: { ...state.logs, [runId]: logs } });
    }
    case 'progress': {
      const known = state.runs[action.progress.runId];
      if (!known || known.run.status !== 'running') return state;
      return { ...state, runs: { ...state.runs, [known.run.id]: { ...known, progress: action.progress } } };
    }
    case 'finished': {
      const known = state.runs[action.runId];
      if (!known) return state;
      return prune({ ...state, runs: { ...state.runs, [action.runId]: { ...known, run: { ...known.run, status: action.status } } } });
    }
    case 'settle': {
      const known = state.runs[action.runId];
      if (!known || known.run.status !== 'running') return state;
      // The live panel shows log lines, not run.error: the note goes into the run's log too.
      const logs = [...(state.logs[action.runId] ?? []), { runId: action.runId, profileId: '', level: 'error', message: action.error, at: action.at }].slice(-MAX_LOGS_PER_RUN);
      return prune({ ...state, logs: { ...state.logs, [action.runId]: logs }, runs: { ...state.runs, [action.runId]: { ...known, run: { ...known.run, status: 'failed', error: action.error } } } });
    }
  }
}
