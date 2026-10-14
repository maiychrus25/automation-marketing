import { EventNotifier } from '../../services/control/EventNotifier';

describe('EventNotifier', () => {
  it('does not lose an event added between check and wait (registers before re-check)', async () => {
    const calls: number[] = [];
    let has = false;
    const notifier = new EventNotifier({ listEventsAfter: () => { calls.push(1); return has ? [{} as any] : []; } });
    has = true;
    await expect(notifier.waitForEvent(0, 5000)).resolves.toBeUndefined();
    expect(notifier.pending).toBe(0);
  });

  it('abort signal resolves and removes waiter and timer', async () => {
    const notifier = new EventNotifier({ listEventsAfter: () => [] });
    const ac = new AbortController();
    const p = notifier.waitForEvent(0, 60_000, ac.signal);
    expect(notifier.pending).toBe(1);
    ac.abort();
    await p;
    expect(notifier.pending).toBe(0);
    await notifier.waitForEvent(0, 60_000, ac.signal); // already aborted
    expect(notifier.pending).toBe(0);
  });
});
