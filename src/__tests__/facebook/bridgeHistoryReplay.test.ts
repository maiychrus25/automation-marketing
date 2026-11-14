import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-replay-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import FacebookService from '../../services/facebook/FacebookService';

const NOW = 1_800_000_000_000;
const THREAD = '100000000000000001';
const MIN = 60_000;

describe('bridge replayed history is stored silently', () => {
  let svc: any;
  let persist: jest.Mock;
  let incoming: jest.SpyInstance;
  let admin: jest.SpyInstance;
  let e2ee: jest.SpyInstance;
  const msg = (extra: any) => ({ id: 'mid.$replay1', threadId: `${THREAD}@msgr`, senderId: '200', text: 'x', ...extra });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    svc = new (FacebookService as any)('acc-replay', 'c_user=1');
    persist = jest.fn().mockReturnValue({ stored: 1, fresh: 0, received: 1 });
    svc.historyFetcher = { persistBridgeMessages: persist };
    incoming = jest.spyOn(svc, 'handleIncomingMessage').mockResolvedValue(undefined);
    admin = jest.spyOn(svc, 'handleAdminGroupMessage').mockImplementation(() => {});
    e2ee = jest.spyOn(svc, 'handleE2EEMessage').mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('oldHistoryMessageIsPersistedSilently', () => {
    const data = msg({ isHistory: true, timestampMs: NOW - 6 * MIN });
    svc.handleBridgeEvent({ type: 'message', data });
    expect(persist).toHaveBeenCalledWith([data], undefined, THREAD);
    expect(incoming).not.toHaveBeenCalled();
  });

  test('recentHistoryMessageStaysOnLivePath', () => {
    svc.handleBridgeEvent({ type: 'message', data: msg({ isHistory: true, timestampMs: NOW - MIN }) });
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  test('oldMessageWithoutHistoryFlagStaysOnLivePath', () => {
    svc.handleBridgeEvent({ type: 'message', data: msg({ timestampMs: NOW - 60 * MIN }) });
    expect(incoming).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  test('adminMessageKeepsSystemBranch', () => {
    svc.handleBridgeEvent({ type: 'message', data: msg({ isAdminMsg: true, isHistory: true, timestampMs: NOW - 60 * MIN }) });
    expect(admin).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(incoming).not.toHaveBeenCalled();
  });

  test('persistErrorIsSwallowedAndDoesNotFallThrough', () => {
    persist.mockImplementation(() => { throw new Error('db down'); });
    expect(() => svc.handleBridgeEvent({ type: 'message', data: msg({ isHistory: true, timestampMs: NOW - 6 * MIN }) })).not.toThrow();
    expect(incoming).not.toHaveBeenCalled();
  });

  test('oldHistoryMessageWithoutThreadIsDroppedNotStoredUnderZero', () => {
    svc.handleBridgeEvent({ type: 'message', data: msg({ threadId: undefined, isHistory: true, timestampMs: NOW - 6 * MIN }) });
    expect(persist).not.toHaveBeenCalled();
    expect(incoming).not.toHaveBeenCalled();
  });

  test('oldE2eeMessageStillGoesToE2eeHandler', () => {
    svc.handleBridgeEvent({ type: 'e2eeMessage', data: { id: 'mid.$e1', threadId: THREAD, timestampMs: NOW - 60 * MIN } });
    expect(e2ee).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });
});
