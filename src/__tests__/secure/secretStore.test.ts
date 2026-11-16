jest.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({ queryOne: () => null }) } }));

import Logger from '../../utils/Logger';
import { SECRET_STORE_LOCKED_MESSAGE, isStoredSecretUnreadable, whenSecretStoreReady } from '../../services/secure/secretStore';

describe('whenSecretStoreReady', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
  afterEach(() => jest.useRealTimers());

  test('runsAtOnceWhenTheStoreIsAvailable', () => {
    const run = jest.fn();
    whenSecretStoreReady(run, { isAvailable: () => true, isNeeded: () => true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Máy không có kho mật khẩu (Linux không keyring) và chưa từng lưu gì ở dạng mã hoá: không có gì để chờ.
  test('runsAtOnceWhenNothingWasEverEncryptedOnThisMachine', () => {
    const run = jest.fn();
    whenSecretStoreReady(run, { isAvailable: () => false, isNeeded: () => false });
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(600_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Lỗi thật 16/11/2026: app được mở lúc máy Mac đang khóa, Chuỗi khóa chưa đọc được. App vẫn kết nối các tài khoản bằng
  // dữ liệu chưa giải mã: Zalo báo "cookie không hợp lệ, hãy đăng nhập lại" và bị đánh dấu là đã ngắt.
  test('waitsWhileTheStoreIsLockedAndRunsOnceItOpens', () => {
    const run = jest.fn();
    let available = false;
    whenSecretStoreReady(run, { isAvailable: () => available, isNeeded: () => true });
    jest.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    expect((Logger.warn as jest.Mock).mock.calls.filter(c => String(c[0]).includes('kho mật khẩu'))).toHaveLength(1); // báo một lần, không lặp mỗi nhịp
    available = true;
    jest.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(600_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('theReturnedFunctionCancelsTheWait', () => {
    const run = jest.fn();
    let available = false;
    const cancel = whenSecretStoreReady(run, { isAvailable: () => available, isNeeded: () => true });
    cancel();
    available = true;
    jest.advanceTimersByTime(600_000);
    expect(run).not.toHaveBeenCalled();
  });

  test('aCheckThatThrowsIsTreatedAsNotNeededSoStartupIsNeverBlocked', () => {
    const run = jest.fn();
    whenSecretStoreReady(run, { isAvailable: () => false, isNeeded: () => { throw new Error('db closed'); } });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('isStoredSecretUnreadable', () => {
  const locked = () => false;
  const open = () => true;

  test('anEncryptedValueCannotBeReadWhileTheStoreIsLocked', () => {
    expect(isStoredSecretUnreadable('djEwAbCdEf0123456789', locked)).toBe(true);
    expect(isStoredSecretUnreadable('djEwAbCdEf0123456789', open)).toBe(false);
  });

  test('plainValuesAreAlwaysReadable', () => {
    for (const plain of ['', '[{"key":"zpsid"}]', '  {"a":1}', '123456:ABC-DEF_ghi']) expect(isStoredSecretUnreadable(plain, locked)).toBe(false);
  });

  test('theMessageTellsTheUserNotToLogInAgain', () => {
    expect(SECRET_STORE_LOCKED_MESSAGE).toContain('không cần đăng nhập lại');
  });
});

// Ba chỗ dùng không chạy được trong Jest (tiến trình chính của Electron): khóa cách nối bằng chính mã nguồn.
describe('where the secret store check is wired in', () => {
  const read = (rel: string) => require('fs').readFileSync(require('path').resolve(__dirname, '../../..', rel), 'utf8') as string;

  test('startupAutoConnectRunsInsideWhenSecretStoreReady', () => {
    const main = read('electron/main.ts');
    const block = main.slice(main.indexOf('whenSecretStoreReady(() => {'), main.indexOf('onRendererReportedReady = startConnectorServices'));
    for (const call of ['reconnectAllFBAccounts()', 'reconnectAllTelegramAccounts()', 'startupAllWorkspaces()']) expect(block).toContain(call);
    // Không còn lời gọi nào nằm ngoài khối chờ.
    expect(main.split('reconnectAllFBAccounts()').length - 1).toBe(1);
    expect(main.split('startupAllWorkspaces().catch').length - 1).toBe(1);
  });

  test('zaloReconnectStopsBeforeConnectingAndBeforeMarkingTheAccountDisconnected', () => {
    const ipc = read('electron/ipc/loginIpc.ts');
    const handler = ipc.slice(ipc.indexOf("ipcMain.handle('login:connect'"));
    const check = handler.indexOf('isStoredSecretUnreadable(');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(handler.indexOf('loginService.connectUser(auth)'));
    expect(check).toBeLessThan(handler.indexOf('setListenerActive(zaloId, false)'));
  });

  test('zaloNoLongerAsksForANewLoginWhenTheStoreIsLocked', () => {
    const helper = read('src/utils/ZaloLoginHelper.ts');
    const locked = helper.indexOf('if (!isSecretStoreAvailable()) throw new Error(SECRET_STORE_LOCKED_MESSAGE);');
    expect(locked).toBeGreaterThan(0);
    expect(locked).toBeLessThan(helper.indexOf("'Cookies tài khoản không hợp lệ"));
  });
});
