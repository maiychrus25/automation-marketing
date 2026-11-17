import { normalizeEmployeeAccount } from '../../ui/lib/employeeAccounts';

describe('normalizeEmployeeAccount', () => {
  it('keeps channel, parent and facebook_id for a Page row', () => {
    const out = normalizeEmployeeAccount({ zalo_id: 'page-1', full_name: 'Page One', avatar_url: 'a.png', phone: '1', is_business: 1, is_active: 1, listener_active: 1, channel: 'facebook', parent_zalo_id: 'fb-personal' });
    expect(out).toMatchObject({ zalo_id: 'page-1', channel: 'facebook', parent_zalo_id: 'fb-personal', facebook_id: 'page-1' });
  });
  it('turns a legacy row without the two fields into a Zalo account', () => {
    const out = normalizeEmployeeAccount({ zalo_id: 'acc-a', full_name: 'A' });
    expect(out.channel).toBe('zalo');
    expect(out.parent_zalo_id).toBeNull();
    expect(out.facebook_id).toBeUndefined();
  });
  it('keeps every existing field value', () => {
    const out = normalizeEmployeeAccount({ zalo_id: 'acc-a', display_name: 'Disp', avatar_url: 'x', phone: '09', is_business: 1, is_active: 0, listener_active: 1 });
    expect(out).toMatchObject({ zalo_id: 'acc-a', display_name: 'Disp', full_name: 'Disp', avatar_url: 'x', phone: '09', is_business: 1, is_active: 0, listenerActive: true, isConnected: true, isOnline: true, imei: '', cookies: '' });
  });
});

import { fbConnectedReloadSource, fbCookieExpiredMessage } from '../../ui/lib/employeeAccounts';

describe('Facebook connection status decisions', () => {
  it('employee reloads over REST, boss reads the local DB', () => {
    expect(fbConnectedReloadSource(true)).toBe('rest');
    expect(fbConnectedReloadSource(false)).toBe('local');
  });
  it('employee gets the tell-the-Boss text, boss keeps the original text', () => {
    expect(fbCookieExpiredMessage(true, 'X')).toBe('Page này đang mất kết nối trên máy Boss. Hãy báo cho Boss kiểm tra.');
    expect(fbCookieExpiredMessage(false, 'X')).toBe('⚠️ Tài khoản Facebook "X" bị ngắt kết nối (FB phát hiện bot hoặc cookie hết hạn). Vui lòng đăng nhập lại FB để lấy cookie mới.');
  });
});

import { withoutBossOnlyFbCaps } from '../../ui/lib/employeeAccounts';

describe('withoutBossOnlyFbCaps', () => {
  const cap = { supportsUnsend: true, supportsForward: true, supportsEdit: true, supportsPoll: true, supportsBlock: true, supportsGroupRename: true, supportsReaction: true };
  it('turns the boss-only controls off for an employee on Facebook and keeps the rest', () => {
    expect(withoutBossOnlyFbCaps(cap, true, 'facebook')).toEqual({ ...cap, supportsDeleteForMe: false, supportsUnsend: false, supportsForward: false, supportsEdit: false, supportsPoll: false, supportsBlock: false, supportsGroupRename: false });
  });
  it('switches delete-for-me off (it unsends over fb:unsendMessage on a Page)', () => {
    expect((withoutBossOnlyFbCaps(cap, true, 'facebook') as any).supportsDeleteForMe).toBe(false);
    expect((withoutBossOnlyFbCaps(cap, false, 'facebook') as any).supportsDeleteForMe).toBeUndefined();
  });
  it('returns the same object for a boss or another channel', () => {
    expect(withoutBossOnlyFbCaps(cap, false, 'facebook')).toBe(cap);
    expect(withoutBossOnlyFbCaps(cap, true, 'zalo')).toBe(cap);
    expect(withoutBossOnlyFbCaps(cap, true, undefined)).toBe(cap);
  });
});

describe('shouldCheckFbInit', () => {
  test('anEmployeeSkipsTheFacebookInitPanelAndABossStillChecks', async () => {
    const { shouldCheckFbInit } = await import('../../ui/lib/employeeAccounts');
    expect(shouldCheckFbInit(true)).toBe(false);
    expect(shouldCheckFbInit(false)).toBe(true);
  });
});

describe('fbCookieExpiredMessage with a problem', () => {
  const employeeText = 'Page này đang mất kết nối trên máy Boss. Hãy báo cho Boss kiểm tra.';
  it.each(['logged_out', 'checkpoint', 'unrecognised_page'] as const)('employee text is unchanged for %s', (problem) => {
    expect(fbCookieExpiredMessage(true, 'X', problem)).toBe(employeeText);
  });
  it('boss logged_out', () => {
    expect(fbCookieExpiredMessage(false, 'X', 'logged_out')).toBe('Facebook đã đăng xuất tài khoản "X". Hãy cập nhật cookie mới để kết nối lại.');
  });
  it('boss checkpoint', () => {
    expect(fbCookieExpiredMessage(false, 'X', 'checkpoint')).toBe('Facebook đang yêu cầu xác minh tài khoản "X". Hãy mở Facebook trên trình duyệt để xác minh, rồi cập nhật cookie mới.');
  });
  it('boss unrecognised_page', () => {
    expect(fbCookieExpiredMessage(false, 'X', 'unrecognised_page')).toBe('MaiHub không đọc được trang Facebook của tài khoản "X" (có thể Facebook vừa đổi trang). Hãy thử kết nối lại; nếu vẫn lỗi thì cập nhật cookie mới.');
  });
  it('boss without a problem keeps the old text byte for byte', () => {
    expect(fbCookieExpiredMessage(false, 'X')).toBe('⚠️ Tài khoản Facebook "X" bị ngắt kết nối (FB phát hiện bot hoặc cookie hết hạn). Vui lòng đăng nhập lại FB để lấy cookie mới.');
  });
});

describe('Telegram decisions for an employee machine', () => {
  it('recognises both Telegram channels and nothing else', async () => {
    const { isTelegramChannel } = await import('../../ui/lib/employeeAccounts');
    expect(isTelegramChannel('telegram_user')).toBe(true);
    expect(isTelegramChannel('telegram_bot')).toBe(true);
    for (const other of ['zalo', 'facebook', '', undefined, null]) expect(isTelegramChannel(other as any)).toBe(false);
  });

  it('telegramHealthForEmployee answers from listener_active or listenerActive and never needs IPC', async () => {
    const { telegramHealthForEmployee } = await import('../../ui/lib/employeeAccounts');
    expect(telegramHealthForEmployee({ listener_active: 1 })).toEqual({ connected: true });
    expect(telegramHealthForEmployee({ listener_active: 0 })).toEqual({ connected: false });
    expect(telegramHealthForEmployee({ listener_active: true })).toEqual({ connected: true });
    expect(telegramHealthForEmployee({ listenerActive: true })).toEqual({ connected: true });
    expect(telegramHealthForEmployee({ listenerActive: false })).toEqual({ connected: false });
    expect(telegramHealthForEmployee({})).toEqual({ connected: false });
    expect(telegramHealthForEmployee(undefined)).toEqual({ connected: false });
  });

  it('employeeSendFailure reports a failed send to an employee only', async () => {
    const { employeeSendFailure } = await import('../../ui/lib/employeeAccounts');
    const timeout = { success: false, error: 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện.', code: 'TIMEOUT' };
    expect(employeeSendFailure(true, timeout)).toEqual({ error: timeout.error, code: 'TIMEOUT' });
    expect(employeeSendFailure(true, { success: false })).toEqual({ error: 'Gửi không thành công', code: undefined });
    expect(employeeSendFailure(true, { success: false, error: '', code: 'BOSS_ONLY' })).toEqual({ error: 'Gửi không thành công', code: 'BOSS_ONLY' });
    expect(employeeSendFailure(true, { success: true })).toBeNull();
    expect(employeeSendFailure(true, undefined)).toBeNull();
    expect(employeeSendFailure(true, null)).toBeNull();
    expect(employeeSendFailure(false, timeout)).toBeNull();
  });

  it('unreadReloadDelayMs keeps 300 ms for a boss and waits 2000 ms for an employee', async () => {
    const { unreadReloadDelayMs } = await import('../../ui/lib/employeeAccounts');
    expect(unreadReloadDelayMs(false)).toBe(300);
    expect(unreadReloadDelayMs(true)).toBe(2000);
  });
});

// main.ts khong chay duoc trong Jest: khoa cach noi bang chinh ma nguon.
describe('Telegram start-up in electron/main.ts on a remote workspace', () => {
  const main = require('fs').readFileSync(require('path').resolve(__dirname, '../../../electron/main.ts'), 'utf8') as string;
  const body = (name: string) => main.slice(main.indexOf(name), main.indexOf('\n}\n', main.indexOf(name)));
  it('reconnectAllTelegramAccounts returns before reading accounts when the active workspace is remote', () => {
    const fn = body('async function reconnectAllTelegramAccounts');
    expect(fn.indexOf('isRemoteWorkspaceActive()')).toBeGreaterThan(0);
    expect(fn.indexOf('isRemoteWorkspaceActive()')).toBeLessThan(fn.indexOf('getAccounts()'));
  });
  it('the bot health check skips its tick (not its registration) while the workspace is remote', () => {
    const fn = body('function startTelegramBotHealthCheck');
    expect(fn.indexOf('setInterval')).toBeLessThan(fn.indexOf('isRemoteWorkspaceActive()'));
    expect(fn.indexOf('isRemoteWorkspaceActive()')).toBeLessThan(fn.indexOf('getActiveBots()'));
  });
});

import { shouldQueryDbFilter, pinsFromResponse, shouldResetPagingOnFilterChange } from '../../ui/lib/employeeAccounts';

describe('shouldQueryDbFilter', () => {
  it('queries the database only for a boss with an active filter', () => {
    expect(shouldQueryDbFilter(false, true)).toBe(true);
    expect(shouldQueryDbFilter(false, false)).toBe(false);
  });
  it('never queries on an employee machine, filter or not', () => {
    expect(shouldQueryDbFilter(true, true)).toBe(false);
    expect(shouldQueryDbFilter(true, false)).toBe(false);
  });
});

describe('pinsFromResponse', () => {
  it('returns the pins array, including an empty one (a real "no pins")', () => {
    expect(pinsFromResponse({ pins: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(pinsFromResponse({ pins: [] })).toEqual([]);
  });
  it('returns null when the response carries no pins array (employee local handler answers only success)', () => {
    expect(pinsFromResponse({ success: true } as any)).toBeNull();
    expect(pinsFromResponse(null)).toBeNull();
    expect(pinsFromResponse(undefined)).toBeNull();
    expect(pinsFromResponse({ pins: 'x' })).toBeNull();
  });
});

describe('shouldResetPagingOnFilterChange', () => {
  it('resets paging on a filter change for a boss only', () => {
    expect(shouldResetPagingOnFilterChange(false)).toBe(true);
    expect(shouldResetPagingOnFilterChange(true)).toBe(false);
  });
});
