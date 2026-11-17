jest.mock('@/lib/ipc', () => ({ __esModule: true, default: {} }));
import { RESYNC_DEBOUNCE_MS, RESYNC_MESSAGES_LIMIT, ResyncScheduler, resyncSteps, resyncStatusText, mergeFetchedWindow as mergeWindow, runResync, shouldIgnoreResyncSignal } from '../../ui/lib/employeeResync';
import { extractDedupText } from '../../ui/store/chatStore';

const mergeFetchedWindow = (existing: any[], fetched: any[], limit = RESYNC_MESSAGES_LIMIT) => mergeWindow(existing, fetched, limit, extractDedupText);

function makeHarness(run: (reasons: string[]) => Promise<void>, isReady?: () => boolean) {
  let pending: (() => void) | null = null;
  const h = { armed: 0 };
  const sched = new ResyncScheduler({
    run,
    isReady,
    setTimer: (fn) => { pending = fn; h.armed++; return 1; },
    clearTimer: () => { pending = null; },
  });
  return { sched, h, fire: () => { const f = pending; pending = null; f?.(); }, hasTimer: () => pending !== null };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('ResyncScheduler', () => {
  test('debounceIsFiveHundredMs', () => expect(RESYNC_DEBOUNCE_MS).toBe(500));

  test('threeRequestsWithinWindowRunOnceWithAllReasons', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const h = makeHarness(run);
    h.sched.request('gap'); h.sched.request('fresh'); h.sched.request('system-resume');
    expect(run).not.toHaveBeenCalled();
    h.fire(); await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['gap', 'fresh', 'system-resume']);
  });

  test('requestWhileRunningTriggersExactlyOneMoreRun', async () => {
    let release!: () => void;
    const run = jest.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r; })).mockResolvedValue(undefined);
    const h = makeHarness(run);
    h.sched.request('gap'); h.fire();
    expect(h.sched.running).toBe(true);
    const armedBefore = h.h.armed;
    h.sched.request('fresh'); h.sched.request('gap');
    expect(h.h.armed).toBe(armedBefore);
    expect(h.hasTimer()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    release(); await flush(); await flush();
    h.fire(); await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(['fresh', 'gap']);
    expect(h.sched.running).toBe(false);
  });

  test('runThatThrowsDoesNotBlockNextRequest', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const h = makeHarness(run);
    h.sched.request('gap'); h.fire(); await flush();
    expect(h.sched.running).toBe(false);
    h.sched.request('gap'); h.fire(); await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('resyncSteps', () => {
  test('activeAccountFirstThenOpenThreadMessages', () => {
    expect(resyncSteps({ accountIds: ['a', 'b', 'c'], activeAccountId: 'b', activeThreadId: 't1' })).toEqual([
      { kind: 'conversations', accountId: 'b' },
      { kind: 'conversations', accountId: 'a' },
      { kind: 'conversations', accountId: 'c' },
      { kind: 'messages', accountId: 'b', threadId: 't1' },
    ]);
  });
  test('noOpenThreadMeansNoMessageStep', () => {
    expect(resyncSteps({ accountIds: ['a'], activeAccountId: 'a', activeThreadId: null })).toEqual([
      { kind: 'conversations', accountId: 'a' },
    ]);
  });
});

describe('resyncStatusText', () => {
  test('threeCases', () => {
    expect(resyncStatusText(true, false)).toBe('Đang cập nhật dữ liệu từ máy Boss…');
    expect(resyncStatusText(false, true)).toBe('Chưa cập nhật được dữ liệu từ máy Boss');
    expect(resyncStatusText(false, false)).toBeNull();
  });
});

describe('ResyncScheduler gate and dispose', () => {
  test('signalBeforeReadyIsKeptAndRunsOnceWhenReady', async () => {
    let ready = false;
    const run = jest.fn().mockResolvedValue(undefined);
    const h = makeHarness(run, () => ready);
    h.sched.request('fresh'); h.sched.request('gap'); h.fire(); await flush();
    expect(run).not.toHaveBeenCalled();
    ready = true; h.sched.notifyReady();
    h.fire(); await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['fresh', 'gap']);
  });
  test('notifyReadyWithNothingPendingArmsNothing', () => {
    const h = makeHarness(jest.fn(), () => true);
    h.sched.notifyReady();
    expect(h.hasTimer()).toBe(false);
  });
  test('disposeClearsTimerAndInFlightRunArmsNothing', async () => {
    let release!: () => void;
    const run = jest.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r; })).mockResolvedValue(undefined);
    const h = makeHarness(run);
    h.sched.request('gap'); h.sched.dispose();
    expect(h.hasTimer()).toBe(false);
    h.sched.request('gap'); expect(h.hasTimer()).toBe(false);
    const h2 = makeHarness(run);
    h2.sched.request('gap'); h2.fire();
    h2.sched.request('fresh'); h2.sched.dispose();
    release(); await flush(); await flush();
    expect(h2.hasTimer()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

const row = (id: string, ts: number, extra: any = {}) => ({ msg_id: id, timestamp: ts, content: id, ...extra });

describe('mergeFetchedWindow', () => {
  test('overlapUpdatesRowsKeepsOthersAndLocalOnlyFields', () => {
    const existing = [row('a', 1), row('b', 2, { local_paths: 'L', content: 'old' }), row('temp_1', 5, { send_status: 'sending' })];
    const fetched = [row('b', 2, { content: 'edited', is_edited: 1, local_paths: null }), row('c', 3, { is_recalled: 1, msg_type: 'recalled' })];
    const out = mergeFetchedWindow(existing, fetched);
    expect(out.map((m: any) => m.msg_id)).toEqual(['a', 'b', 'c', 'temp_1']);
    expect(out[1]).toMatchObject({ content: 'edited', is_edited: 1, local_paths: 'L' });
    expect(out[2]).toMatchObject({ is_recalled: 1 });
  });
  test('overlapRecalledRowBecomesRecalled', () => {
    const out = mergeFetchedWindow([row('a', 1), row('b', 2)], [row('b', 2, { is_recalled: 1 })]);
    expect((out.find((m: any) => m.msg_id === 'b') as any).is_recalled).toBe(1);
  });
  test('overlapDropsTempWhoseRealIdWasFetched', () => {
    const out = mergeFetchedWindow([row('a', 1), row('temp_1', 5, { real_msg_id: 'n' })], [row('a', 1), row('n', 6)]);
    expect(out.map((m: any) => m.msg_id)).toEqual(['a', 'n']);
  });
  test('noOverlapNewerReplacesWindowKeepsPendingTemp', () => {
    const existing = [row('a', 1), row('b', 2), row('temp_1', 3, { send_status: 'pending' })];
    const fetched = [row('x', 10), row('y', 11)];
    const out = mergeFetchedWindow(existing, fetched, 2); // trang đầy và không nối được → thay cửa sổ
    expect(out.map((m: any) => m.msg_id)).toEqual(['temp_1', 'x', 'y']);
    expect(new Set(out.map((m: any) => m.msg_id)).size).toBe(out.length);
  });
  test('wholeHistoryReturnedMergesEvenWithoutOverlap', () => {
    const out = mergeFetchedWindow([row('a', 5), row('b', 6)], [row('x', 1), row('y', 7)]);
    expect(out.map((m: any) => m.msg_id)).toEqual(['x', 'a', 'b', 'y']);
  });
  test('emptyFetchedChangesNothing', () => {
    const existing = [row('a', 5)];
    expect(mergeFetchedWindow(existing, [])).toBe(existing);
  });
});

describe('mergeFetchedWindow local fields and settled pending', () => {
  test.each([[null], [''], ['{}'], ['[]'], [{}], [[]]])('emptyFetchedLocalPathsKeepsLoaded %p', (empty) => {
    const out = mergeFetchedWindow([row('a', 1, { local_paths: '{"x":"/p"}' })], [row('a', 1, { local_paths: empty })]);
    expect((out[0] as any).local_paths).toBe('{"x":"/p"}');
  });
  test('nonEmptyFetchedLocalPathsWins', () => {
    const out = mergeFetchedWindow([row('a', 1, { local_paths: '{"x":"/p"}' })], [row('a', 1, { local_paths: '{"x":"/q"}' })]);
    expect((out[0] as any).local_paths).toBe('{"x":"/q"}');
  });
  test('emptyFetchedQuoteDataKeepsLoadedButOrdinaryFieldsMayBecomeEmpty', () => {
    const out: any = mergeFetchedWindow([row('a', 1, { quote_data: '{"q":1}', content: 'x' })], [row('a', 1, { quote_data: null, content: '' })]);
    expect(out[0].quote_data).toBe('{"q":1}');
    expect(out[0].content).toBe('');
  });
  test('replaceBranchDropsTempWhoseRealIdWasFetchedAndKeepsOthers', () => {
    const existing = [row('a', 1), row('temp_1', 3, { real_msg_id: 'n', send_status: 'sent' }), row('temp_2', 4, { send_status: 'pending' })];
    const out = mergeFetchedWindow(existing, [row('n', 10), row('y', 11)], 2);
    expect(out.map((m: any) => m.msg_id)).toEqual(['temp_2', 'n', 'y']);
  });
});

describe('runResync', () => {
  function deps(over: any = {}) {
    const status: any[] = [];
    const d: any = {
      accountIds: () => ['a', 'b', 'c'],
      activeAccountId: () => 'a',
      activeThreadId: () => 't1',
      activeTopicId: () => null,
      captureSession: () => () => true,
      isWindowFocused: () => false,
      markOpenThreadRead: jest.fn(),
      loadConversations: jest.fn().mockResolvedValue(undefined),
      loadMessages: jest.fn().mockResolvedValue([row('m', 1)]),
      mergeMessages: jest.fn(),
      setStatus: (s: any) => status.push(s),
      ...over,
    };
    return { d, status };
  }
  test('oneFailingAccountDoesNotStopOthersAndRunEndsFailed', async () => {
    const loadConversations = jest.fn(async (id: string) => { if (id === 'b') throw new Error('x'); });
    const { d, status } = deps({ loadConversations });
    await runResync(d);
    expect(loadConversations.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(d.mergeMessages).toHaveBeenCalledTimes(1);
    expect(status[status.length - 1]).toEqual({ running: false, failed: true });
  });
  test('successfulRunClearsFailed', async () => {
    const { d, status } = deps();
    await runResync(d);
    expect(status[0]).toEqual({ running: true });
    expect(status[status.length - 1]).toEqual({ running: false, failed: false });
  });
  test('threadSwitchDuringRunSkipsMerge', async () => {
    let thread = 't1';
    const { d } = deps({ activeThreadId: () => thread, loadMessages: jest.fn(async () => { thread = 't2'; return [row('m', 1)]; }) });
    await runResync(d);
    expect(d.mergeMessages).not.toHaveBeenCalled();
  });
  test('topicSwitchDuringRunSkipsMerge', async () => {
    let topic: string | null = null;
    const { d } = deps({ activeTopicId: () => topic, loadMessages: jest.fn(async () => { topic = 'tp'; return [row('m', 1)]; }) });
    await runResync(d);
    expect(d.mergeMessages).not.toHaveBeenCalled();
  });
  test('removedAccountIsSkipped', async () => {
    let ids = ['a', 'b', 'c'];
    const loadConversations = jest.fn(async (id: string) => { if (id === 'a') ids = ['a', 'c']; });
    const { d } = deps({ accountIds: () => ids, loadConversations });
    await runResync(d);
    expect(loadConversations.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
  });
  test('removedActiveAccountSkipsMessagesStep', async () => {
    let ids = ['a', 'b'];
    const loadConversations = jest.fn(async () => { ids = ['b']; });
    const { d } = deps({ accountIds: () => ids, loadConversations });
    await runResync(d);
    expect(d.loadMessages).not.toHaveBeenCalled();
  });
});

const seq = (from: number, to: number, extra: any = {}) => Array.from({ length: to - from + 1 }, (_, i) => row(String(from + i), from + i, extra));
const ids = (rows: any[]) => rows.map((m) => m.msg_id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

describe('mergeFetchedWindow continuity (U1)', () => {
  test('limitIsTheConstantTheHookRequests', () => expect(RESYNC_MESSAGES_LIMIT).toBe(50));
  test('sharedLiveRowDoesNotProveContinuity', () => {
    const out = mergeFetchedWindow([...seq(1, 20), row('90', 90)], seq(41, 90), 50);
    expect(ids(out)).toEqual(range(41, 90));
  });
  test('liveRowNewerThanTheFetchedPageIsKept', () => {
    const out = mergeFetchedWindow([...seq(1, 20), row('90', 90)], seq(41, 89), 49);
    expect(ids(out)).toEqual(range(41, 90));
  });
  test('oldestFetchedRowAlreadyLoadedMeansContinuous', () => {
    expect(ids(mergeFetchedWindow(seq(1, 60), seq(41, 90), 50))).toEqual(range(1, 90));
  });
  test('shortPageMeansWholeHistoryNothingDropped', () => {
    const out = mergeFetchedWindow([...seq(1, 20), row('90', 90)], seq(41, 60), 50);
    expect(ids(out)).toEqual([...range(1, 20), ...range(41, 60), '90']);
  });
  test('discontinuousDropsLoadedRowsInsideTheRangeTheBossDidNotReturn', () => {
    const out = mergeFetchedWindow([...seq(1, 3), row('45', 45), row('90', 90)], seq(41, 90).filter((m) => m.msg_id !== '45'), 49);
    expect(ids(out)).not.toContain('45');
    expect(ids(out)).not.toContain('2');
  });
  test('pendingRowsSurviveInEveryBranch', () => {
    const t = row('temp_1', 95, { send_status: 'sending' });
    expect(ids(mergeFetchedWindow([...seq(1, 20), t], seq(41, 90), 50))).toContain('temp_1');
    expect(ids(mergeFetchedWindow([...seq(1, 60), t], seq(41, 90), 50))).toContain('temp_1');
    expect(ids(mergeFetchedWindow([...seq(1, 20), t], seq(41, 60), 50))).toContain('temp_1');
  });
  test('emptyFetchChangesNothing', () => {
    const existing = seq(1, 3);
    expect(mergeFetchedWindow(existing, [], 50)).toBe(existing);
  });
  test('discontinuousRowKnownLocallyKeepsLocalOnlyFields', () => {
    const out: any = mergeFetchedWindow([row('50', 50, { local_paths: '{"x":"/p"}' }), row('1', 1)], [...seq(41, 49), row('50', 50, { local_paths: null })], 10);
    expect(out.find((m: any) => m.msg_id === '50').local_paths).toBe('{"x":"/p"}');
    expect(ids(out)).not.toContain('1');
  });
});

describe('mergeFetchedWindow quote_data (U10)', () => {
  test('nonEmptyLoadedQuoteWinsOverFetchedOne', () => {
    const out: any = mergeFetchedWindow([row('a', 1, { quote_data: '{"resolved":1}' })], [row('a', 1, { quote_data: '{"generated":1}' })]);
    expect(out[0].quote_data).toBe('{"resolved":1}');
  });
  test('emptyLoadedQuoteTakesFetchedOne', () => {
    const out: any = mergeFetchedWindow([row('a', 1, { quote_data: '' })], [row('a', 1, { quote_data: '{"q":1}' })]);
    expect(out[0].quote_data).toBe('{"q":1}');
  });
});

describe('mergeFetchedWindow settled timeout rows (U2)', () => {
  const timeoutRow = (id: string, text: string, status = 'timeout') => row(id, 100, { content: text, is_sent: 1, send_status: status });
  const sent = (id: string, ts: number, text: string, extra: any = {}) => row(id, ts, { content: text, is_sent: 1, ...extra });
  test('timeoutRowWithMatchingNewFetchedOutgoingRowIsDropped', () => {
    const out = mergeFetchedWindow([row('a', 1), timeoutRow('temp_1', 'hi')], [row('a', 1), sent('n', 101, 'hi')]);
    expect(ids(out)).toEqual(['a', 'n']);
  });
  test('failedRowWithSameTextIsKept', () => {
    const out = mergeFetchedWindow([row('a', 1), timeoutRow('temp_1', 'hi', 'failed')], [row('a', 1), sent('n', 101, 'hi')]);
    expect(ids(out)).toContain('temp_1');
  });
  test('twoTimeoutRowsOneFetchedRowKeepsOneBubble', () => {
    const out = mergeFetchedWindow([row('a', 1), timeoutRow('temp_1', 'hi'), timeoutRow('temp_2', 'hi')], [row('a', 1), sent('n', 101, 'hi')]);
    expect(ids(out).filter((i: string) => i.startsWith('temp_'))).toHaveLength(1);
  });
  test('alreadyLoadedFetchedRowIsNotUsedForTheMatch', () => {
    const loaded = sent('n', 101, 'hi');
    const out = mergeFetchedWindow([row('a', 1), loaded, timeoutRow('temp_1', 'hi')], [row('a', 1), loaded]);
    expect(ids(out)).toContain('temp_1');
  });
  test('incomingRowWithSameTextDoesNotMatch', () => {
    const out = mergeFetchedWindow([row('a', 1), timeoutRow('temp_1', 'hi')], [row('a', 1), row('n', 101, { content: 'hi', is_sent: 0 })]);
    expect(ids(out)).toContain('temp_1');
  });
  test('matchUsesTheSameNormalisationAsAddMessage', () => {
    const out = mergeFetchedWindow([row('a', 1), timeoutRow('temp_1', JSON.stringify('hi'))], [row('a', 1), sent('n', 101, 'hi')]);
    expect(ids(out)).not.toContain('temp_1');
  });
  test('discontinuousBranchAlsoDropsTheTimeoutRow', () => {
    const out = mergeFetchedWindow([...seq(1, 5), timeoutRow('temp_1', 'hi')], [...seq(41, 49), sent('n', 101, 'hi')], 10);
    expect(ids(out)).not.toContain('temp_1');
  });
});

describe('shouldIgnoreResyncSignal (U4)', () => {
  test('ignoredOnlyWhenBothKnownAndDifferent', () => {
    expect(shouldIgnoreResyncSignal('w1', 'w2')).toBe(true);
    expect(shouldIgnoreResyncSignal('w1', 'w1')).toBe(false);
    expect(shouldIgnoreResyncSignal(undefined, 'w2')).toBe(false);
    expect(shouldIgnoreResyncSignal('', 'w2')).toBe(false);
    expect(shouldIgnoreResyncSignal('w1', '')).toBe(false);
    expect(shouldIgnoreResyncSignal(42 as any, 'w2')).toBe(false);
  });
});

describe('runResync session and unread (U3, U4)', () => {
  function deps(over: any = {}) {
    const status: any[] = [];
    const d: any = {
      accountIds: () => ['a'],
      activeAccountId: () => 'a',
      activeThreadId: () => 't1',
      activeTopicId: () => null,
      captureSession: () => () => true,
      isWindowFocused: () => true,
      markOpenThreadRead: jest.fn(),
      loadConversations: jest.fn().mockResolvedValue(undefined),
      loadMessages: jest.fn().mockResolvedValue([row('m', 1)]),
      mergeMessages: jest.fn(),
      setStatus: (s: any) => status.push(s),
      ...over,
    };
    return { d, status };
  }
  test('focusedAndStillOpenMarksReadOnce', async () => {
    const { d } = deps();
    await runResync(d);
    expect(d.markOpenThreadRead).toHaveBeenCalledTimes(1);
    expect(d.markOpenThreadRead).toHaveBeenCalledWith('a', 't1');
  });
  test('notFocusedDoesNotMarkRead', async () => {
    const { d } = deps({ isWindowFocused: () => false });
    await runResync(d);
    expect(d.markOpenThreadRead).not.toHaveBeenCalled();
  });
  test('threadSwitchedDuringConversationsStepDoesNotMarkRead', async () => {
    let thread = 't1';
    const { d } = deps({ activeThreadId: () => thread, loadConversations: jest.fn(async () => { thread = 't2'; }) });
    await runResync(d);
    expect(d.markOpenThreadRead).not.toHaveBeenCalled();
  });
  test('noOpenThreadDoesNotMarkRead', async () => {
    const { d } = deps({ activeThreadId: () => null });
    await runResync(d);
    expect(d.markOpenThreadRead).not.toHaveBeenCalled();
  });
  test('sessionChangedMidRunSkipsMergeAndEndsIdle', async () => {
    let ok = true;
    const { d, status } = deps({
      captureSession: () => () => ok,
      loadMessages: jest.fn(async () => { ok = false; return [row('m', 1)]; }),
    });
    await runResync(d);
    expect(d.mergeMessages).not.toHaveBeenCalled();
    expect(status[status.length - 1]).toEqual({ running: false, failed: false });
  });
  test('sessionChangedDuringConversationsStepEndsIdleEvenIfThatStepFailed', async () => {
    let ok = true;
    const { d, status } = deps({
      captureSession: () => () => ok,
      loadConversations: jest.fn(async () => { ok = false; throw new Error('x'); }),
    });
    await runResync(d);
    expect(d.loadMessages).not.toHaveBeenCalled();
    expect(status[status.length - 1]).toEqual({ running: false, failed: false });
  });
  test('conversationsLoadIsGivenTheSessionGuard', async () => {
    const guard = () => true;
    const { d } = deps({ captureSession: () => guard });
    await runResync(d);
    expect(d.loadConversations).toHaveBeenCalledWith('a', guard);
  });
});
