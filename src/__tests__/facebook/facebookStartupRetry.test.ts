import { createStartupRetry } from '../../services/facebook/facebookStartupRetry';

describe('createStartupRetry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('retries at 15s, 60s and 180s after each failure, then stops', async () => {
    const connect = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(14_999);
    expect(connect).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(connect).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops after a success on the second attempt', async () => {
    const connect = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(15_000);
    await jest.advanceTimersByTimeAsync(60_000);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not double up when scheduled twice', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    r.schedule('a');
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('clear and clearAll cancel pending retries', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a'); r.schedule('b'); r.schedule('c');
    r.clear('a');
    r.clearAll();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(connect).not.toHaveBeenCalled();
  });

  it('skips connect when shouldRetry says no (disabled, removed, disconnected, connected)', async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const r = createStartupRetry({ connect, shouldRetry: () => false });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(connect).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  const deferred = () => {
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((_, rej) => { reject = rej; });
    return { promise, reject };
  };

  it('clearDuringInFlightConnectStopsRetries', async () => {
    const d = deferred();
    const connect = jest.fn().mockReturnValue(d.promise);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(connect).toHaveBeenCalledTimes(1);
    r.clear('a');
    d.reject(new Error('ENOTFOUND'));
    await jest.advanceTimersByTimeAsync(300_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clearAll also invalidates an in-flight connect', async () => {
    const d = deferred();
    const connect = jest.fn().mockReturnValue(d.promise);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(15_000);
    r.clearAll();
    d.reject(new Error('x'));
    await jest.advanceTimersByTimeAsync(300_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('scheduleAfterClearStartsFresh', async () => {
    const d = deferred();
    const connect = jest.fn().mockReturnValueOnce(d.promise).mockResolvedValue(undefined);
    const r = createStartupRetry({ connect, shouldRetry: () => true });
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(15_000);
    r.clear('a');
    d.reject(new Error('x'));
    await jest.advanceTimersByTimeAsync(0);
    r.schedule('a');
    await jest.advanceTimersByTimeAsync(14_999);
    expect(connect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('logs once when retries are exhausted', async () => {
    const log = jest.fn();
    const r = createStartupRetry({ connect: jest.fn().mockRejectedValue(new Error('ENOTFOUND')), shouldRetry: () => true, log });
    r.schedule('acc-1');
    await jest.advanceTimersByTimeAsync(300_000);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((m) => /exhausted/i.test(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('acc-1');
  });

  it('unrefs its timers', () => {
    const unref = jest.fn();
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((() => ({ unref })) as any);
    createStartupRetry({ connect: async () => {}, shouldRetry: () => true }).schedule('a');
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
