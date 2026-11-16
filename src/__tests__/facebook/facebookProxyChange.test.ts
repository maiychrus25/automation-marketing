jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const manager = { get: jest.fn(), disconnect: jest.fn(), getOrCreate: jest.fn() };
jest.mock('../../utils/FacebookConnectionManager', () => ({ __esModule: true, default: manager }));
const removeInstance = jest.fn();
jest.mock('../../services/facebook/FacebookService', () => ({ __esModule: true, FacebookService: { removeInstance: (id: string) => removeInstance(id) } }));
const cookies: Record<string, string | null> = {};
const proxies: Record<string, number | null> = {};
jest.mock('../../services/facebook/FacebookAccountCookie', () => ({
  resolveFBCookie: (acc: any) => cookies[acc.id] ?? null,
  resolveFBProxyId: (acc: any) => proxies[acc.id] ?? null,
}));
const db = { getFBAccountByFacebookId: jest.fn(), getFBPageChildren: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => db } }));

import { applyFacebookProxyChange, forgetProxyChangeFailure, reconnectPageChildren } from '../../services/facebook/facebookProxyChange';

const PARENT = { id: 'acc-parent', facebook_id: '100000000008724' };
const PAGE_ON = { id: 'acc-page-on', facebook_id: '100000000004280', parent_facebook_id: PARENT.facebook_id, enabled: 1 };
const PAGE_OFF = { id: 'acc-page-off', facebook_id: '100000000007362', parent_facebook_id: PARENT.facebook_id, enabled: 0 };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

describe('applyFacebookProxyChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(cookies, { [PARENT.id]: 'c-parent', [PAGE_ON.id]: 'c-page', [PAGE_OFF.id]: 'c-off' });
    Object.assign(proxies, { [PARENT.id]: 7, [PAGE_ON.id]: 7, [PAGE_OFF.id]: 7 });
    db.getFBAccountByFacebookId.mockReturnValue(PARENT);
    db.getFBPageChildren.mockReturnValue([PAGE_ON, PAGE_OFF]);
    manager.get.mockReturnValue({});
    manager.disconnect.mockResolvedValue(undefined);
    manager.getOrCreate.mockResolvedValue({});
  });

  test('reconnectsTheAccountThenItsEnabledPagesThroughTheNewProxy', async () => {
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(true);
    await settle();
    expect(manager.disconnect.mock.calls.map(c => c[0])).toEqual([PARENT.id, PAGE_ON.id]);
    expect(manager.getOrCreate.mock.calls).toEqual([[PARENT.id, 'c-parent', 7], [PAGE_ON.id, 'c-page', 7]]);
    // Tài khoản cha phải ngắt xong rồi mới nối lại: nối trước khi ngắt sẽ trả về kết nối cũ (proxy cũ).
    expect(manager.disconnect.mock.invocationCallOrder[0]).toBeLessThan(manager.getOrCreate.mock.invocationCallOrder[0]);
  });

  test('removingTheProxyReconnectsDirectly', async () => {
    Object.assign(proxies, { [PARENT.id]: null, [PAGE_ON.id]: null });
    applyFacebookProxyChange(PARENT.facebook_id);
    await settle();
    expect(manager.getOrCreate.mock.calls).toEqual([[PARENT.id, 'c-parent', null], [PAGE_ON.id, 'c-page', null]]);
  });

  test('anAccountThatIsNotConnectedIsLeftAlone', async () => {
    manager.get.mockReturnValue(null);
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(false);
    db.getFBAccountByFacebookId.mockReturnValue(null);
    expect(applyFacebookProxyChange('999')).toBe(false);
    await settle();
    expect(manager.disconnect).not.toHaveBeenCalled();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  test('aFailedReconnectOfTheAccountStillReconnectsThePagesAndNeverThrows', async () => {
    manager.getOrCreate.mockRejectedValueOnce(new Error('proxy refused'));
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(true);
    await settle();
    expect(manager.getOrCreate.mock.calls.map(c => c[0])).toEqual([PARENT.id, PAGE_ON.id]);
  });

  // Lỗi thật 16/11/2026: nối lại qua proxy hỏng thất bại, tài khoản rời danh sách kết nối. Khi người dùng đổi proxy lần nữa
  // (ví dụ về "Không proxy"), tài khoản phải được nối lại chứ không bị coi là "chưa từng kết nối".
  test('anAccountWhoseReconnectFailedIsReconnectedOnTheNextProxyChange', async () => {
    manager.disconnect.mockImplementation(async () => { manager.get.mockReturnValue(null); }); // ngắt xong thì rời danh sách kết nối
    manager.getOrCreate.mockRejectedValueOnce(new Error('HTTP 403'));
    applyFacebookProxyChange(PARENT.facebook_id);
    await settle();
    expect(removeInstance).toHaveBeenCalledWith(PARENT.id); // không để lại service hỏng giữ proxy cũ
    jest.clearAllMocks();
    manager.get.mockReturnValue(null); // đã rời danh sách kết nối
    manager.disconnect.mockResolvedValue(undefined);
    manager.getOrCreate.mockResolvedValue({});
    Object.assign(proxies, { [PARENT.id]: null, [PAGE_ON.id]: null });
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(true);
    await settle();
    expect(manager.getOrCreate.mock.calls).toEqual([[PARENT.id, 'c-parent', null], [PAGE_ON.id, 'c-page', null]]);

    jest.clearAllMocks();
    manager.get.mockReturnValue(null); // lần này đã nối được: tài khoản không còn trong danh sách "hỏng"
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(false);
  });

  // Sau lần nối lại hỏng, người dùng chủ động ngắt hoặc xoá tài khoản: đổi proxy về sau không được tự nối lại nó.
  test('anAccountTheUserDisconnectedAfterAFailureIsNotReconnected', async () => {
    manager.disconnect.mockImplementation(async () => { manager.get.mockReturnValue(null); });
    manager.getOrCreate.mockRejectedValueOnce(new Error('HTTP 403'));
    applyFacebookProxyChange(PARENT.facebook_id);
    await settle();
    forgetProxyChangeFailure(PARENT.id); // fb:disconnect / fb:removeAccount gọi hàm này
    jest.clearAllMocks();
    manager.get.mockReturnValue(null);
    expect(applyFacebookProxyChange(PARENT.facebook_id)).toBe(false);
    await settle();
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  // Trong lúc lần nối lại của hàm này hỏng, một lần kết nối khác (người dùng bấm kết nối) đã thành công: không được gỡ nó.
  test('aConnectionMadeMeanwhileIsNotRemovedWhenThisReconnectFails', async () => {
    manager.getOrCreate.mockImplementationOnce(async () => { manager.get.mockReturnValue({ fresh: true }); throw new Error('HTTP 403'); });
    applyFacebookProxyChange(PARENT.facebook_id);
    await settle();
    expect(removeInstance).not.toHaveBeenCalledWith(PARENT.id);
    forgetProxyChangeFailure(PARENT.id);
  });

  test('reconnectPageChildrenSkipsDisabledPagesAndPagesWithoutACookie', async () => {
    cookies[PAGE_ON.id] = null;
    await reconnectPageChildren(PARENT.facebook_id);
    expect(manager.disconnect.mock.calls.map(c => c[0])).toEqual([PAGE_ON.id]);
    expect(removeInstance).toHaveBeenCalledWith(PAGE_ON.id);
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });
});
