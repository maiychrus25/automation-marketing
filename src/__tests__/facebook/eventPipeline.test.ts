jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { FacebookEventPipeline, EventPriority, bridgeEventKey } from '../../services/facebook/FacebookEventPipeline';

const { LOW, NORMAL, HIGH } = EventPriority;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const noop = async () => {};
/** A process() that stays pending until release() is called. */
const gate = () => {
  let release!: () => void;
  const started = jest.fn();
  const process = () => { started(); return new Promise<void>(r => { release = r; }); };
  return { process, started, release: () => release() };
};

describe('FacebookEventPipeline', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_000_000); });
  afterEach(() => { jest.useRealTimers(); });

  test('processesOneAtATimeInArrivalOrder', async () => {
    const p = new FacebookEventPipeline('a');
    const order: string[] = [];
    const first = gate();
    p.enqueue('1', HIGH, 0, async () => { order.push('1-start'); await first.process(); order.push('1-end'); });
    p.enqueue('2', HIGH, 0, async () => { order.push('2'); });
    await flush();
    expect(order).toEqual(['1-start']);
    first.release();
    await flush();
    expect(order).toEqual(['1-start', '1-end', '2']);
    await p.stop(true);
  });

  test('duplicateWithinWindowIsDroppedThenAcceptedAgain', async () => {
    const p = new FacebookEventPipeline('a');
    const run = jest.fn(noop);
    expect(p.enqueue('x', HIGH, 0, run)).toBe(true);
    await flush();
    expect(p.isDuplicate('x')).toBe(true);
    expect(p.enqueue('x', HIGH, 0, run)).toBe(false);
    jest.setSystemTime(1_000_000 + 4999);
    expect(p.isDuplicate('x')).toBe(true);
    jest.setSystemTime(1_000_000 + 5000);
    expect(p.isDuplicate('x')).toBe(false);
    expect(p.enqueue('x', HIGH, 0, run)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    await p.stop(true);
  });

  test('idStillQueuedOrRunningIsDuplicate', async () => {
    const p = new FacebookEventPipeline('a');
    const g = gate();
    p.enqueue('x', HIGH, 0, g.process);
    expect(p.isDuplicate('x')).toBe(true);
    expect(p.enqueue('x', HIGH, 0, noop)).toBe(false);
    g.release();
    await p.stop(true);
  });

  test('reactionEditAndUnsendRightAfterTheirMessageAreProcessed', async () => {
    const p = new FacebookEventPipeline('a');
    const seen: string[] = [];
    const evts = [
      { type: 'e2eeMessage', data: { messageId: 'M1' } },
      { type: 'e2eeReaction', data: { messageId: 'M1', senderJid: 'u1', emoji: 'x', timestampMs: 5 } },
      { type: 'e2eeReaction', data: { messageId: 'M1', senderJid: 'u2', emoji: 'x', timestampMs: 5 } },
      { type: 'messageEdit', data: { messageId: 'M1', editCount: 1, newText: 'a' } },
      { type: 'messageEdit', data: { messageId: 'M1', editCount: 2, newText: 'b' } },
      { type: 'messageUnsend', data: { messageId: 'M1' } },
    ];
    for (const e of evts) {
      expect(p.enqueue(bridgeEventKey(e), HIGH, 0, async () => { seen.push(bridgeEventKey(e)); })).toBe(true);
    }
    await flush();
    expect(seen).toHaveLength(evts.length);
    // the very same reaction replayed is still a duplicate
    expect(p.enqueue(bridgeEventKey(evts[1]), HIGH, 0, noop)).toBe(false);
    await p.stop(true);
  });

  test('reactionAddRemoveAddWithinWindowAreAllDispatched', async () => {
    // Bridge payloads carry no add/remove flag: removal is an empty reaction, E2EE reactions have no timestamp at all.
    const p = new FacebookEventPipeline('a');
    const ran: string[] = [];
    const send = (e: any, tag: string) => p.enqueue(bridgeEventKey(e), NORMAL, 0, async () => { ran.push(tag); });
    const add = { type: 'e2eeReaction', data: { messageId: 'M', senderId: 7, reaction: '👍' } };
    const remove = { type: 'e2eeReaction', data: { messageId: 'M', senderId: 7, reaction: '' } };
    expect([send(add, 'add1'), send(remove, 'rm1'), send(add, 'add2'), send(remove, 'rm2')]).toEqual([true, true, true, true]);
    await flush();
    expect(ran).toEqual(['add1', 'rm1', 'add2', 'rm2']);
    // with a timestamp an exact replay is still one event; another actor's removal is a different event
    const ts = { type: 'reaction', data: { messageId: 'M', actorId: 1, reaction: '👍', timestampMs: 5 } };
    expect(send(ts, 'ts')).toBe(true);
    expect(send({ ...ts, data: { ...ts.data } }, 'replay')).toBe(false);
    expect(bridgeEventKey({ type: 'reaction', data: { messageId: 'M', actorId: 1, reaction: '', timestampMs: 0 } }))
      .not.toBe(bridgeEventKey({ type: 'reaction', data: { messageId: 'M', actorId: 2, reaction: '', timestampMs: 0 } }));
    await p.stop(true);
  });

  test('bridgeEventKeyShapes', () => {
    expect(bridgeEventKey({ type: 'message', data: { id: 'A' } })).toBe('message:A');
    expect(bridgeEventKey({ type: 'reaction', data: { messageId: 'A', userId: 'u', reaction: 'y', timestampMs: 9 } })).toBe('reaction:A:u:y:9');
    expect(bridgeEventKey({ type: 'messageEdit', data: { messageId: 'A', editCount: 2, newText: 't' } })).toBe('messageEdit:A:2:t');
    const a = bridgeEventKey({ type: 'typing', data: {} });
    const b = bridgeEventKey({ type: 'typing', data: {} });
    expect(a).not.toBe(b);
  });

  test('fullQueueDropsOneLowToAdmitHigh', async () => {
    const p = new FacebookEventPipeline('a');
    const g = gate();
    p.enqueue('busy', HIGH, 0, g.process); // occupies the worker, leaves the queue itself empty
    await flush();
    for (let i = 0; i < 500; i++) p.enqueue(`n${i}`, i === 250 ? LOW : NORMAL, 0, noop);
    expect(p.getDepth()).toBe(500);
    expect(p.enqueue('h', HIGH, 0, noop)).toBe(true);
    expect(p.getDepth()).toBe(500);
    expect(p.isDuplicate('n250')).toBe(false); // dropped LOW id is released
    g.release();
    await p.stop(true);
  });

  test('fullQueueWithoutLowRejectsLowAndAdmitsImportantUpToHardCap', async () => {
    const p = new FacebookEventPipeline('a');
    const g = gate();
    p.enqueue('busy', HIGH, 0, g.process);
    await flush();
    for (let i = 0; i < 500; i++) p.enqueue(`n${i}`, NORMAL, 0, noop);
    expect(p.enqueue('low', LOW, 0, noop)).toBe(false);
    for (let i = 500; i < 2000; i++) expect(p.enqueue(`n${i}`, i % 2 ? HIGH : NORMAL, 0, noop)).toBe(true);
    expect(p.getDepth()).toBe(2000);
    expect(p.enqueue('over', HIGH, 0, noop)).toBe(false);
    expect(p.isDuplicate('over')).toBe(false);
    g.release();
    await p.stop(true);
  });

  test('olderGenerationIsDiscardedAndRejected', async () => {
    const p = new FacebookEventPipeline('a');
    const g = gate();
    p.enqueue('busy', HIGH, 1, g.process);
    await flush();
    const old = jest.fn(noop);
    p.enqueue('old', HIGH, 1, old);
    p.setGeneration(2);
    expect(p.getDepth()).toBe(0);
    expect(p.enqueue('late', HIGH, 1, old)).toBe(false);
    expect(p.enqueue('new', HIGH, 2, noop)).toBe(true);
    g.release();
    await flush();
    expect(old).not.toHaveBeenCalled();
    await p.stop(true);
  });

  test('failingProcessDoesNotStopQueueAndReleasesId', async () => {
    const p = new FacebookEventPipeline('a');
    const ran = jest.fn(noop);
    p.enqueue('bad', HIGH, 0, async () => { throw new Error('boom'); });
    p.enqueue('sync-bad', HIGH, 0, (() => { throw new Error('sync'); }) as any);
    p.enqueue('ok', HIGH, 0, ran);
    await flush();
    expect(ran).toHaveBeenCalledTimes(1);
    expect(p.isDuplicate('bad')).toBe(false);
    expect(p.isDuplicate('sync-bad')).toBe(false);
    await p.stop(true);
  });

  test('stopCancelClearsQueueAndLeavesNoTimers', async () => {
    const p = new FacebookEventPipeline('a');
    const g = gate();
    const never = jest.fn(noop);
    p.enqueue('busy', HIGH, 0, g.process);
    p.enqueue('q', HIGH, 0, never);
    await p.stop(true);
    expect(p.getDepth()).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(p.enqueue('after', HIGH, 0, never)).toBe(false);
    g.release();
    await flush();
    expect(never).not.toHaveBeenCalled();
  });
});
