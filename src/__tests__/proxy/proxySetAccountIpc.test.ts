const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
const headThroughProxy = jest.fn();
// checkProxyWorks thật, chạy trên headThroughProxy giả: kiểm cả thứ tự và số trang thử.
jest.mock('../../utils/ProxyHelper', () => ({
  createProxyAgent: jest.fn(() => 'AGENT'),
  checkProxyWorks: async (agent: any) => {
    let last = { ok: false, status: 0, ms: 0 };
    for (const url of ['https://www.google.com', 'https://httpbin.org/get']) { last = await headThroughProxy(agent, url); if (last.ok) return last; }
    return last;
  },
}));
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
    headThroughProxy.mockResolvedValue({ ok: true, status: 200, ms: 5 });
  });

  test('aConnectedFacebookAccountIsSavedAndReconnected', async () => {
    expect(await setAccount({ zaloId: FB, proxyId: 7 })).toEqual({ success: true, applied: 'reconnecting' });
    expect(db.setAccountProxy).toHaveBeenCalledWith(FB, 7);
    expect(applyFacebookProxyChange).toHaveBeenCalledWith(FB);
    // Lưu trước rồi mới nối lại: kết nối mới đọc proxy từ cơ sở dữ liệu.
    expect(db.setAccountProxy.mock.invocationCallOrder[0]).toBeLessThan(applyFacebookProxyChange.mock.invocationCallOrder[0]);
  });

  // Lỗi thật 16/11/2026: gán một proxy bị nhà cung cấp từ chối (403) làm tài khoản Facebook và các Page mất kết nối.
  test('aProxyThatFailsTheSameCheckAsTheTestButtonIsRefusedAndNothingChanges', async () => {
    headThroughProxy.mockResolvedValue({ ok: false, status: 403, ms: 100 });
    const res = await setAccount({ zaloId: FB, proxyId: 7 });
    expect(res).toEqual({ success: false, error: 'Proxy này không kết nối được (HTTP 403). Hãy kiểm tra lại proxy bằng nút Test; tài khoản vẫn giữ thiết lập cũ.' });
    expect(headThroughProxy.mock.calls.map(c => c[1])).toEqual(['https://www.google.com', 'https://httpbin.org/get']);
    expect(db.setAccountProxy).not.toHaveBeenCalled();
    expect(applyFacebookProxyChange).not.toHaveBeenCalled();
  });

  // Một trang thử không vào được (bị chặn ở mạng đó, chậm) thì thử trang kia: proxy tốt không bị từ chối oan.
  test('oneReachableCheckUrlIsEnough', async () => {
    headThroughProxy.mockResolvedValueOnce({ ok: false, status: 0, ms: 10000 }).mockResolvedValueOnce({ ok: true, status: 200, ms: 300 });
    expect(await setAccount({ zaloId: ZALO, proxyId: 7 })).toEqual({ success: true, applied: 'next_start' });
    expect(db.setAccountProxy).toHaveBeenCalledWith(ZALO, 7);
  });

  test('theTestButtonUsesTheSameCheck', async () => {
    headThroughProxy.mockResolvedValue({ ok: false, status: 407, ms: 100 });
    const test = (proxy: any) => handlers.get('proxy:test')!({}, { proxy });
    expect(await test({ host: 'p.test', port: 1 })).toEqual({ success: false, error: 'Proxy không phản hồi (HTTP 407). Kiểm tra lại host/port/credentials.' });
    headThroughProxy.mockResolvedValue({ ok: true, status: 200, ms: 42 });
    expect(await test({ host: 'p.test', port: 1 })).toEqual({ success: true, ms: 42, status: 200 });
  });

  test('removingAProxyNeedsNoCheck', async () => {
    headThroughProxy.mockResolvedValue({ ok: false, status: 0, ms: 100 });
    expect(await setAccount({ zaloId: FB, proxyId: null })).toEqual({ success: true, applied: 'reconnecting' });
    expect(headThroughProxy).not.toHaveBeenCalled();
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
