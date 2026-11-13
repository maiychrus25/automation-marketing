import { EventEmitter } from 'events';
import { wireZaloListenerLifecycle, isCurrentZaloListener, ZCA_RETRY_WATCHDOG_MS } from '../../utils/zaloListenerRetry';

function makeListener() {
  const l: any = new EventEmitter();
  l.canRetry = jest.fn(() => 500);
  l.start = jest.fn();
  l.stop = jest.fn();
  l.retryCount = { '1000': { count: 3, max: 5, times: [1] } };
  return l;
}

function setup(current = true) {
  const listener = makeListener();
  const origCanRetry = listener.canRetry;
  const origStart = listener.start;
  const state = { current };
  const hooks = { isCurrent: () => state.current, onConnected: jest.fn(), onGiveUp: jest.fn() };
  wireZaloListenerLifecycle(listener, hooks);
  return { listener, origCanRetry, origStart, state, hooks };
}

describe('wireZaloListenerLifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('blocksCanRetryWhenNotCurrent', () => {
    const { listener, origCanRetry, state } = setup(false);
    expect(listener.canRetry(1000)).toBe(false);
    expect(origCanRetry).not.toHaveBeenCalled();
    state.current = true;
    expect(listener.canRetry(1000)).toBe(500);
  });

  it('passesThroughWhenCurrent', () => {
    const { listener, origCanRetry } = setup(true);
    expect(listener.canRetry(1006)).toBe(500);
    expect(origCanRetry).toHaveBeenCalledWith(1006);
  });

  it('blocksScheduledStartOfStaleListener', () => {
    const { listener, origStart, hooks } = setup(false);
    listener.start({ retryOnClose: true });
    expect(origStart).toHaveBeenCalledTimes(1);
    listener.start({ retryOnClose: true });
    expect(origStart).toHaveBeenCalledTimes(1);
    // blocked start ends the listener's life: it never starts again, even if it looks current
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('resetsRetryBudgetOnConnected', () => {
    const { listener, hooks } = setup();
    listener.emit('connected');
    expect(listener.retryCount['1000'].count).toBe(0);
    expect(hooks.onConnected).toHaveBeenCalledTimes(1);
  });

  it('staysQuietWhileRetrying', () => {
    const { listener, hooks } = setup();
    listener.emit('disconnected', 1006, 'x');
    jest.advanceTimersByTime(ZCA_RETRY_WATCHDOG_MS - 1);
    expect(hooks.onGiveUp).not.toHaveBeenCalled();
    listener.emit('connected');
    jest.advanceTimersByTime(200_000);
    expect(hooks.onGiveUp).not.toHaveBeenCalled();
  });

  it('givesUpAfterWatchdog', () => {
    const { listener, hooks } = setup();
    listener.emit('disconnected', 1006, 'x');
    jest.advanceTimersByTime(ZCA_RETRY_WATCHDOG_MS);
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
    expect(hooks.onGiveUp).toHaveBeenCalledWith('retry_timeout', 1006, 'x');
    expect(listener.stop).toHaveBeenCalled();
  });

  it('closedGivesUpOnce', () => {
    const { listener, hooks } = setup();
    listener.emit('disconnected', 1006, 'x');
    listener.emit('closed', 1006, 'x');
    jest.advanceTimersByTime(ZCA_RETRY_WATCHDOG_MS * 2);
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
    expect(hooks.onGiveUp).toHaveBeenCalledWith('closed', 1006, 'x');
  });

  it('staleListenerThatReconnectsIsStopped', () => {
    const { listener, hooks } = setup(false);
    listener.emit('connected');
    expect(listener.stop).toHaveBeenCalled();
    expect(hooks.onConnected).not.toHaveBeenCalled();
  });

  it('manualDisconnectDoesNotReconnect', () => {
    const { listener, origCanRetry, origStart, hooks } = setup(false);
    listener.emit('disconnected', 1000, 'm');
    expect(listener.canRetry(1000)).toBe(false);
    listener.emit('closed', 1000, 'm');
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
    expect(hooks.onGiveUp).toHaveBeenCalledWith('closed', 1000, 'm');
    expect(origCanRetry).not.toHaveBeenCalled();
    listener.start();
    listener.start();
    expect(origStart).toHaveBeenCalledTimes(1);
  });

  it('doesNotRestartAfterGivingUp', () => {
    const { listener, origStart } = setup();
    listener.start();
    listener.emit('disconnected', 1006, 'x');
    jest.advanceTimersByTime(ZCA_RETRY_WATCHDOG_MS);
    listener.start({ retryOnClose: true });
    expect(origStart).toHaveBeenCalledTimes(1);
  });

  it('givesUpImmediatelyWhenQueuedStartIsBlocked', () => {
    const { listener, origStart, state, hooks } = setup(true);
    listener.start({ retryOnClose: true });
    listener.emit('disconnected', 1006, 'x');
    state.current = false;
    listener.start({ retryOnClose: true });
    expect(origStart).toHaveBeenCalledTimes(1);
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
    expect(hooks.onGiveUp).toHaveBeenCalledWith('closed', 1006, 'x');
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(200_000);
    expect(hooks.onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('newListenerConnectsAfterManualDisconnectButOldOneStaysBlocked', () => {
    // Real composition: the manual-disconnect flag is NOT part of isCurrent.
    const oldConn = { id: 'old' };
    const newConn = { id: 'new' };
    let registered: any = newConn; // disconnectUser removed old, fresh login registered new
    const make = (conn: any) => {
      const listener = makeListener();
      const hooks = {
        isCurrent: () => isCurrentZaloListener({ removed: false, currentConnection: registered, connection: conn }),
        onConnected: jest.fn(),
        onGiveUp: jest.fn(),
      };
      wireZaloListenerLifecycle(listener, hooks);
      return { listener, hooks };
    };
    const fresh = make(newConn);
    fresh.listener.emit('connected');
    expect(fresh.hooks.onConnected).toHaveBeenCalledTimes(1);
    expect(fresh.listener.stop).not.toHaveBeenCalled();

    const old = make(oldConn);
    expect(old.listener.canRetry(1000)).toBe(false);
    old.listener.emit('connected');
    expect(old.listener.stop).toHaveBeenCalled();
    expect(old.hooks.onConnected).not.toHaveBeenCalled();

    expect(isCurrentZaloListener({ removed: true, currentConnection: newConn, connection: newConn })).toBe(false);
    registered = undefined;
    expect(isCurrentZaloListener({ removed: false, currentConnection: registered, connection: newConn })).toBe(false);
  });
});
