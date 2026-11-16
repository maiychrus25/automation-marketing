const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
jest.mock('../../utils/ProxyHelper', () => ({ createProxyAgent: jest.fn() }));
const applyFacebookProxyChange = jest.fn();
jest.mock('../../services/facebook/facebookProxyChange', () => ({ applyFacebookProxyChange: (id: string) => applyFacebookProxyChange(id) }));
const db = { queryOne: jest.fn(), getProxyById: jest.fn(), setAccountProxy: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => db } }));

import { registerProxyIpc } from '../../../electron/ipc/proxyIpc';

const FB = '100000000008724';
const PAGE = '100000000004280';
const ZALO = '5550001112223334445';
const setAccount = (payload: any) => handlers.get('proxy:setAccount')!({}, payload);

describe('proxy:setAccount', () => {
  beforeAll(() => registerProxyIpc());
  beforeEach(() => {
    jest.clearAllMocks();
    db.getProxyById.mockImplementation((id: number) => (id === 7 ? { id: 7, name: 'P7' } : null));
    db.queryOne.mockImplementation((sql: string, [id]: string[]) => {
      if (sql.includes('FROM accounts')) return ({ [FB]: { channel: 'facebook' }, [PAGE]: { channel: 'facebook' }, [ZALO]: { channel: 'zalo' }, tg1: { channel: 'telegram' } } as any)[id] ?? null;
      if (sql.includes('FROM fb_accounts')) return id === PAGE ? { parent_facebook_id: FB } : { parent_facebook_id: null };
      return null;
    });
    applyFacebookProxyChange.mockReturnValue(true);
  });

  test('aConnectedFacebookAccountIsSavedAndReconnected', async () => {
    expect(await setAccount({ zaloId: FB, proxyId: 7 })).toEqual({ success: true, applied: 'reconnecting' });
    expect(db.setAccountProxy).toHaveBeenCalledWith(FB, 7);
    expect(applyFacebookProxyChange).toHaveBeenCalledWith(FB);
    // Lưu trước rồi mới nối lại: kết nối mới đọc proxy từ cơ sở dữ liệu.
    expect(db.setAccountProxy.mock.invocationCallOrder[0]).toBeLessThan(applyFacebookProxyChange.mock.invocationCallOrder[0]);
  });

  test('aFacebookAccountThatIsNotConnectedTakesTheProxyAtItsNextConnect', async () => {
    applyFacebookProxyChange.mockReturnValue(false);
    expect(await setAccount({ zaloId: FB, proxyId: null })).toEqual({ success: true, applied: 'next_connect' });
    expect(db.setAccountProxy).toHaveBeenCalledWith(FB, null);
  });

  test('aZaloAccountIsSavedAndAppliesAfterRestart', async () => {
    expect(await setAccount({ zaloId: ZALO, proxyId: 7 })).toEqual({ success: true, applied: 'next_start' });
    expect(db.setAccountProxy).toHaveBeenCalledWith(ZALO, 7);
    expect(applyFacebookProxyChange).not.toHaveBeenCalled();
  });

  test.each([
    [{ zaloId: '', proxyId: 7 }, 'Thiếu zaloId'],
    [{ zaloId: 123, proxyId: 7 }, 'Thiếu zaloId'],
    [{ zaloId: 'nobody', proxyId: 7 }, 'Không tìm thấy tài khoản'],
    [{ zaloId: FB, proxyId: 99 }, 'Proxy không tồn tại'],
    [{ zaloId: FB, proxyId: '7' }, 'Proxy không tồn tại'],
    [{ zaloId: FB, proxyId: 1.5 }, 'Proxy không tồn tại'],
    [{ zaloId: PAGE, proxyId: 7 }, 'Page dùng proxy của tài khoản Facebook chính'],
    [{ zaloId: 'tg1', proxyId: 7 }, 'Kênh này chưa hỗ trợ proxy'],
  ])('rejects_%j', async (payload, error) => {
    expect(await setAccount(payload)).toEqual({ success: false, error });
    expect(db.setAccountProxy).not.toHaveBeenCalled();
    expect(applyFacebookProxyChange).not.toHaveBeenCalled();
  });

  test('aDatabaseErrorIsReported', async () => {
    db.setAccountProxy.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(await setAccount({ zaloId: FB, proxyId: 7 })).toEqual({ success: false, error: 'disk full' });
    expect(applyFacebookProxyChange).not.toHaveBeenCalled();
  });
});
