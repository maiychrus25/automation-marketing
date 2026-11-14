import {
  isFbSyncRunning, isFbSyncTerminal, fbSyncProgress, fbSyncNotes, isFbSyncWaiting, reduceFbSyncStatus,
} from '../../ui/lib/chat/fbHistorySyncView';
import { emptyFbHistorySyncStatus, type FbHistorySyncStage, type FbHistorySyncStatus } from '../../services/facebook/facebookHistory';

const make = (over: Partial<FbHistorySyncStatus> = {}): FbHistorySyncStatus =>
  ({ ...emptyFbHistorySyncStatus('fb1'), startedAt: 100, ...over });

describe('stage helpers', () => {
  const stages: FbHistorySyncStage[] = ['idle', 'listing', 'syncing', 'completed', 'failed', 'cancelled'];
  it('running only while listing/syncing', () => {
    expect(stages.filter(s => isFbSyncRunning(make({ stage: s })))).toEqual(['listing', 'syncing']);
    expect(isFbSyncRunning(null)).toBe(false);
    expect(isFbSyncRunning(undefined)).toBe(false);
  });
  it('terminal only for completed/failed/cancelled', () => {
    expect(stages.filter(s => isFbSyncTerminal(make({ stage: s })))).toEqual(['completed', 'failed', 'cancelled']);
    expect(isFbSyncTerminal(null)).toBe(false);
  });
});

describe('fbSyncProgress', () => {
  it('0 when total is 0 or while listing', () => {
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 0 }))).toBe(0);
    expect(fbSyncProgress(make({ stage: 'listing', threadsTotal: 10, threadsDone: 5 }))).toBe(0);
  });
  it('50 for 5 of 10', () => {
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 10, threadsDone: 5 }))).toBe(50);
  });
  it('100 when completed, clamped', () => {
    expect(fbSyncProgress(make({ stage: 'completed', threadsTotal: 0 }))).toBe(100);
    expect(fbSyncProgress(make({ stage: 'syncing', threadsTotal: 2, threadsDone: 9 }))).toBe(100);
  });
});

describe('fbSyncNotes', () => {
  it('empty when both counters are 0', () => {
    expect(fbSyncNotes(make())).toEqual([]);
  });
  it('lists non-zero counters', () => {
    expect(fbSyncNotes(make({ skippedE2EE: 3, failedThreads: 2 }))).toEqual([
      '3 hội thoại mã hoá đầu cuối được bỏ qua', '2 hội thoại không tải được',
    ]);
    expect(fbSyncNotes(make({ failedThreads: 1 }))).toEqual(['1 hội thoại không tải được']);
  });
});

describe('isFbSyncWaiting', () => {
  it('waiting only when running and pausedUntil is in the future', () => {
    expect(isFbSyncWaiting(make({ stage: 'syncing', pausedUntil: 2000 }), 1000)).toBe(true);
    expect(isFbSyncWaiting(make({ stage: 'syncing', pausedUntil: 1000 }), 1000)).toBe(false);
    expect(isFbSyncWaiting(make({ stage: 'syncing' }), 1000)).toBe(false);
    expect(isFbSyncWaiting(make({ stage: 'completed', pausedUntil: 2000 }), 1000)).toBe(false);
  });
});

describe('reduceFbSyncStatus', () => {
  it('takes the first event for the account', () => {
    const next = make({ stage: 'listing' });
    expect(reduceFbSyncStatus(null, next, 'fb1')).toBe(next);
  });
  it('ignores other accounts', () => {
    const prev = make({ stage: 'syncing' });
    expect(reduceFbSyncStatus(prev, make({ accountId: 'fb2', startedAt: 999 }), 'fb1')).toBe(prev);
    expect(reduceFbSyncStatus(null, make({ accountId: 'fb2' }), 'fb1')).toBeNull();
  });
  it('ignores stale runs (older startedAt)', () => {
    const prev = make({ stage: 'syncing', startedAt: 200 });
    expect(reduceFbSyncStatus(prev, make({ stage: 'completed', startedAt: 100 }), 'fb1')).toBe(prev);
  });
  it('accepts same or newer startedAt', () => {
    const prev = make({ stage: 'syncing', startedAt: 200 });
    const same = make({ stage: 'completed', startedAt: 200 });
    const newer = make({ stage: 'listing', startedAt: 300 });
    expect(reduceFbSyncStatus(prev, same, 'fb1')).toBe(same);
    expect(reduceFbSyncStatus(prev, newer, 'fb1')).toBe(newer);
  });
  it('keeps a terminal status when a non-terminal one with the same startedAt arrives late', () => {
    for (const stage of ['completed', 'failed', 'cancelled'] as const) {
      const prev = make({ stage, startedAt: 200 });
      expect(reduceFbSyncStatus(prev, make({ stage: 'syncing', startedAt: 200 }), 'fb1')).toBe(prev);
    }
  });
  it('a newer run replaces a terminal status', () => {
    const prev = make({ stage: 'completed', startedAt: 200 });
    const next = make({ stage: 'listing', startedAt: 300 });
    expect(reduceFbSyncStatus(prev, next, 'fb1')).toBe(next);
  });
});
