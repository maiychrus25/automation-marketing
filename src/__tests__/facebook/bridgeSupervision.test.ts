import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-bridge-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../../services/facebook/FacebookUtils', () => ({
  ...jest.requireActual('../../services/facebook/FacebookUtils'),
  resolveE2EEBinaryPath: () => '/fake/bridge',
  parseE2EECookies: () => ({ c_user: '1', xs: 'x' }),
}));

import FacebookService from '../../services/facebook/FacebookService';
import { FacebookE2EEBridge } from '../../services/facebook/FacebookE2EEBridge';
import EventBroadcaster from '../../services/event/EventBroadcaster';

/** Fake Go bridge: records whether the 'event' listener existed when connect() ran; replays an event inside connect(). */
class FakeBridge extends EventEmitter {
  alive = true;
  listenerCountAtConnect = -1;
  spawn = jest.fn();
  newClient = jest.fn().mockResolvedValue({});
  /** When set, connect() waits for it (then may reject) before returning. */
  connectGate: Promise<void> | null = null;
  /** When true, close() emits 'closed' on a later tick (after close() has returned), like a real process exit. */
  lateClosed = false;
  connect = jest.fn(async () => {
    this.listenerCountAtConnect = this.listenerCount('event');
    if (this.connectGate) await this.connectGate;
    this.emit('event', { type: 'e2eeMessage', data: { messageId: 'replayed' } });
    return {};
  });
  connectE2EE = jest.fn().mockResolvedValue({});
  call = jest.fn();
  close = jest.fn(async () => {
    this.alive = false;
    if (this.lateClosed) setTimeout(() => this.emit('closed', 0), 1);
    else this.emit('closed', 0);
  });
  isAlive() { return this.alive; }
}

let nextConfig: ((b: FakeBridge) => void) | null = null;

describe('FacebookService E2EE bridge supervision', () => {
  let svc: any;
  let bridges: FakeBridge[];
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
    bridges = [];
    nextConfig = null;
    jest.spyOn(FacebookE2EEBridge, 'create').mockImplementation((() => { const b = new FakeBridge(); nextConfig?.(b); bridges.push(b); return b; }) as any);
    svc = new (FacebookService as any)('acc-sup', 'c_user=1; xs=x');
    svc.status = 'connected';
    svc.handleBridgeEvent = jest.fn();
  });
  afterEach(async () => {
    await svc.stopE2EEBridge();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('listenerIsAttachedBeforeConnectSoReplayedEventIsHandled', async () => {
    await svc.startE2EEBridge('fb1');
    expect(bridges[0].listenerCountAtConnect).toBe(1);
    await Promise.resolve(); await Promise.resolve();
    expect(svc.handleBridgeEvent).toHaveBeenCalledTimes(1);
  });

  test('backoffDoublesWithOneTimerAndResetsAfterConnected', async () => {
    const start = jest.spyOn(svc, 'startE2EEBridge').mockResolvedValue(undefined);
    svc._scheduleE2EEReconnect('fb1', 'test');
    svc._scheduleE2EEReconnect('fb1', 'test again'); // second call must not add a timer
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(9_999); expect(start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); expect(start).toHaveBeenCalledTimes(1);

    svc._scheduleE2EEReconnect('fb1', 'test');
    jest.advanceTimersByTime(19_999); expect(start).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1); expect(start).toHaveBeenCalledTimes(2);

    svc._scheduleE2EEReconnect('fb1', 'test');
    jest.advanceTimersByTime(40_000); expect(start).toHaveBeenCalledTimes(3);

    svc.setE2EEStatus('connected');
    svc._scheduleE2EEReconnect('fb1', 'test');
    jest.advanceTimersByTime(10_000); expect(start).toHaveBeenCalledTimes(4);
  });

  test('pendingReconnectIsCancelledByStopAndSkippedWhenConditionsChange', async () => {
    const start = jest.spyOn(svc, 'startE2EEBridge').mockResolvedValue(undefined);
    svc._scheduleE2EEReconnect('fb1', 'test');
    await svc.stopE2EEBridge(); // disable / disconnect / manual retry all go through here
    expect(jest.getTimerCount()).toBe(0);

    svc._scheduleE2EEReconnect('fb1', 'test');
    svc.e2eeEnabled = false;
    jest.advanceTimersByTime(300_000);
    expect(start).not.toHaveBeenCalled();

    svc.e2eeEnabled = true;
    svc._scheduleE2EEReconnect('fb1', 'test');
    svc.e2eeBridgeGen++; // a newer bridge generation is already up
    jest.advanceTimersByTime(300_000);
    expect(start).not.toHaveBeenCalled();

    svc._scheduleE2EEReconnect('fb1', 'test');
    svc.status = 'disconnected';
    jest.advanceTimersByTime(300_000);
    expect(start).not.toHaveBeenCalled();
  });

  test('unexpectedBridgeCloseSchedulesReconnectButDeliberateStopDoesNot', async () => {
    await svc.startE2EEBridge('fb1');
    bridges[0].alive = false; bridges[0].emit('closed', 1);
    expect(svc.e2eeBridge).toBeNull();
    expect(jest.getTimerCount()).toBe(1);

    await svc.stopE2EEBridge();
    expect(jest.getTimerCount()).toBe(0);
    await svc.startE2EEBridge('fb1');
    await svc.stopE2EEBridge(); // close() emits 'closed' on the fake; it must not re-arm the timer
    expect(jest.getTimerCount()).toBe(0);
  });

  test('rejectedCriticalEventClosesBridgeButDuplicateDoesNot', async () => {
    await svc.startE2EEBridge('fb1');
    const b = bridges[0];
    b.close.mockClear();
    b.emit('event', { type: 'e2eeMessage', data: { messageId: 'dup1' } });
    b.emit('event', { type: 'e2eeMessage', data: { messageId: 'dup1' } });
    expect(b.close).not.toHaveBeenCalled();
    // fill the pipeline with a stuck handler so the hard cap is reachable
    svc.handleBridgeEvent = () => new Promise(() => {});
    for (let i = 0; i < 2002; i++) b.emit('event', { type: 'e2eeMessage', data: { messageId: `m${i}` } });
    expect(b.close).toHaveBeenCalled();
  });

  test('staleStartFailingAfterStopAndFreshStartLeavesNewBridgeAlone', async () => {
    let rejectA!: (e: Error) => void;
    nextConfig = b => { if (bridges.length === 0) b.connectGate = new Promise<void>((_, rej) => { rejectA = rej; }); };
    const startA = svc.startE2EEBridge('fb1');
    await Promise.resolve(); await Promise.resolve();
    await svc.stopE2EEBridge();
    nextConfig = null;
    await svc.startE2EEBridge('fb1'); // B connects
    const [a, b] = bridges;
    expect(svc.e2eeBridge).toBe(b);
    rejectA(new Error('A connect failed'));
    await startA;
    expect(svc.e2eeBridge).toBe(b);
    expect(svc.e2eeStatus).toBe('connected');
    expect(svc._e2eeReconnectTimer).toBeNull(); // (B's heartbeat interval is the only timer)
    expect(a.close).toHaveBeenCalled(); // A only cleans up its own instance
    expect(b.close).not.toHaveBeenCalled();
    svc.handleBridgeEvent.mockClear();
    b.emit('event', { type: 'e2eeMessage', data: { messageId: 'after-stale' } });
    await Promise.resolve(); await Promise.resolve();
    expect(svc.handleBridgeEvent).toHaveBeenCalledTimes(1);
  });

  test('errorEmittedOnBridgeWhileConnectIsPendingDoesNotThrow', async () => {
    let release!: () => void;
    nextConfig = b => { b.connectGate = new Promise<void>(res => { release = res; }); };
    const start = svc.startE2EEBridge('fb1');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(bridges[0].connect).toHaveBeenCalled(); // connect still pending
    expect(() => bridges[0].emit('error', new Error('early failure'))).not.toThrow();
    release();
    await start;
    expect(svc.e2eeBridge).toBe(bridges[0]);
    expect(() => bridges[0].emit('error', new Error('late failure'))).not.toThrow();
  });

  test('realHandleBridgeEventDispatchesFollowUpsAndDedupesReplays', async () => {
    delete svc.handleBridgeEvent; // use the real prototype method
    const group = jest.spyOn(svc, 'handleBridgeGroupMessage').mockImplementation(() => {});
    jest.spyOn(svc, 'persistReactionToDB').mockImplementation(() => {});
    const emit = EventBroadcaster.emit as unknown as jest.Mock;
    await svc.startE2EEBridge('fb1');
    const b = bridges[0];
    emit.mockClear();
    b.emit('event', { type: 'message', data: { messageId: 'X', threadId: 't' } });
    b.emit('event', { type: 'reaction', data: { messageId: 'X', userId: 'u', emoji: 'x', timestampMs: 1 } });
    b.emit('event', { type: 'messageUnsend', data: { messageId: 'X', threadId: 't' } });
    b.emit('event', { type: 'messageUnsend', data: { messageId: 'X', threadId: 't' } }); // replay inside 5 s
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const names = emit.mock.calls.map(c => c[0]);
    expect(group).toHaveBeenCalledTimes(1);
    expect(names.filter(n => n === 'fb:onReaction')).toHaveLength(1);
    expect(names.filter(n => n === 'fb:onUnsend')).toHaveLength(1);
  });

  test('overflowRejectionClosesBridgeOnceAndArmsOneReconnectAtCurrentBackoff', async () => {
    await svc.startE2EEBridge('fb1');
    const b = bridges[0];
    b.close.mockImplementation(async () => { b.alive = false; }); // real close() emits no 'closed'
    svc.handleBridgeEvent = () => new Promise(() => {});
    for (let i = 0; i < 2002; i++) b.emit('event', { type: 'e2eeMessage', data: { messageId: `m${i}` } });
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(svc.e2eeBridge).toBeNull();
    expect(svc.e2eeStatus).toBe('disconnected');
    expect(jest.getTimerCount()).toBe(1);
    const start = jest.spyOn(svc, 'startE2EEBridge').mockResolvedValue(undefined);
    jest.advanceTimersByTime(9_999); expect(start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); expect(start).toHaveBeenCalledTimes(1);
  });

  test('manualRetryStartsFromCleanBackoffSoFailureWaitsTenSeconds', async () => {
    svc._e2eeReconnectAttempts = 2; // two failed automatic attempts: next would be 40 s
    nextConfig = b => { b.newClient.mockRejectedValue(new Error('down')); };
    await expect(svc.retryE2EE()).rejects.toThrow();
    expect(svc._e2eeReconnectAttempts).toBe(1); // reset to 0, then one scheduled attempt
    const start = jest.spyOn(svc, 'startE2EEBridge').mockResolvedValue(undefined);
    jest.advanceTimersByTime(9_999); expect(start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); expect(start).toHaveBeenCalledTimes(1);
  });

  test('lateClosedFromOldGenerationDoesNotTouchNewBridgeOrScheduleReconnect', async () => {
    nextConfig = b => { b.lateClosed = true; };
    await svc.startE2EEBridge('fb1');
    await svc.stopE2EEBridge(); // old bridge's 'closed' will arrive later
    await svc.startE2EEBridge('fb1');
    const fresh = bridges[1];
    jest.advanceTimersByTime(5);
    expect(svc.e2eeBridge).toBe(fresh);
    expect(jest.getTimerCount()).toBe(1); // only the new heartbeat interval; no reconnect timeout
    expect(svc._e2eeReconnectTimer).toBeNull();
    expect(svc.e2eeStatus).toBe('connected');
  });

  test('heartbeatKillGoesThroughSchedulerAfterTwoFailures', async () => {
    await svc.startE2EEBridge('fb1');
    const b = bridges[0];
    b.call.mockRejectedValue(new Error('hung'));
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(b.close).toHaveBeenCalled();
    expect(svc._e2eeReconnectTimer).not.toBeNull();
  });
});
