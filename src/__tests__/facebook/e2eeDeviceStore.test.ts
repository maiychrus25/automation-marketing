jest.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, app: { getPath: () => '/tmp' } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import Logger from '../../utils/Logger';
import { FacebookE2EEDeviceStore, DEVICE_SAVE_DEBOUNCE_MS, fbE2EEDeviceKey } from '../../services/facebook/FacebookE2EEDeviceStore';

const DEVICE = '{"k":"synthetic"}';

describe('FacebookE2EEDeviceStore', () => {
  let db: any, get: jest.Mock, set: jest.Mock, remove: jest.Mock, runOnBossDb: jest.Mock, store: FacebookE2EEDeviceStore;
  beforeEach(() => {
    jest.useFakeTimers();
    db = {};
    get = jest.fn(); set = jest.fn(); remove = jest.fn();
    runOnBossDb = jest.fn((fn: any) => fn(db));
    store = new FacebookE2EEDeviceStore('acc1', { runOnBossDb, get, set, remove, canEncrypt: () => true });
  });
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  test('nothingIsWrittenWhenOsEncryptionIsUnavailable', () => {
    // Mặc định hỏi safeStorage (mock ở trên trả false): secureSet sẽ ghi chữ thường vào bảng được đồng bộ cho nhân viên.
    const plain = new FacebookE2EEDeviceStore('acc1', { runOnBossDb, get, set, remove });
    plain.save(DEVICE); plain.flush();
    plain.save(DEVICE); jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS);
    expect(set).not.toHaveBeenCalled();
    expect((Logger.warn as jest.Mock).mock.calls.length).toBe(1); // cảnh báo một lần, không kèm nội dung
    expect(JSON.stringify((Logger.warn as jest.Mock).mock.calls)).not.toContain('synthetic');
  });

  test('loadReturnsStoredValueAndNullOnError', () => {
    get.mockReturnValue(DEVICE);
    expect(store.load()).toBe(DEVICE);
    expect(get).toHaveBeenCalledWith('fb_e2ee_device_acc1', db);
    get.mockImplementation(() => { throw new Error('decrypt'); });
    expect(store.load()).toBeNull();
  });

  test('firstSnapshotIsWrittenAtOnceThenLaterOnesDebounceToLatest', () => {
    // Bản đầu mang hạt giống khoá: phải nằm trong DB trước khi bridge tải khoá lên Facebook.
    store.save('a');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(fbE2EEDeviceKey('acc1'), 'a', db);
    expect(runOnBossDb).toHaveBeenCalled();
    store.save('b'); store.save('c');
    expect(set).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(fbE2EEDeviceKey('acc1'), 'c', db);
  });

  test('snapshotAfterAQuietPeriodIsWrittenAtOnce', () => {
    store.save('a');
    jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS);
    store.save('b');
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(fbE2EEDeviceKey('acc1'), 'b', db);
  });

  test('flushWritesPendingNowAndTimerDoesNotWriteAgain', () => {
    store.save('a'); store.save('b'); store.flush();
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(fbE2EEDeviceKey('acc1'), 'b', db);
    jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS * 5);
    expect(set).toHaveBeenCalledTimes(2);
    store.flush();
    expect(set).toHaveBeenCalledTimes(2);
  });

  test('clearDropsPendingAndRemovesStored', () => {
    store.save('a'); store.save('b'); store.clear();
    expect(remove).toHaveBeenCalledWith('fb_e2ee_device_acc1', db);
    jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS * 5);
    expect(set).toHaveBeenCalledTimes(1); // chỉ bản 'a' ghi ngay lúc đầu; 'b' đang chờ bị bỏ
  });

  test('setFailureDoesNotThrowAndNeverLogsDeviceData', () => {
    set.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => store.save(DEVICE)).not.toThrow();
    expect(() => jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS)).not.toThrow();
    expect(Logger.warn).toHaveBeenCalled();
    const logged = JSON.stringify([(Logger.warn as jest.Mock).mock.calls, (Logger.error as jest.Mock).mock.calls, (Logger.log as jest.Mock).mock.calls]);
    expect(logged).not.toContain('synthetic');
  });

  test('emptyAndNonStringValuesAreIgnored', () => {
    store.save(''); store.save(undefined as any); store.save(123 as any); store.save(null as any);
    jest.advanceTimersByTime(DEVICE_SAVE_DEBOUNCE_MS * 5);
    expect(set).not.toHaveBeenCalled();
  });
});
