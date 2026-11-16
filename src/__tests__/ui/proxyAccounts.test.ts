import { proxyAppliedMessage, proxyAssignableAccounts } from '../../ui/lib/proxyAccounts';

describe('proxyAssignableAccounts', () => {
  // Page đi cùng proxy với tài khoản cha; Telegram chưa đi qua proxy: không cho gán để khỏi tạo cảm giác đã có tác dụng.
  test('keepsZaloAndPersonalFacebookAccountsOnly', () => {
    const accounts: Array<{ zalo_id: string; channel?: string; parent_zalo_id?: string | null }> = [
      { zalo_id: 'z1' }, // tài khoản Zalo cũ không ghi kênh
      { zalo_id: 'z2', channel: 'zalo' },
      { zalo_id: 'f1', channel: 'facebook', parent_zalo_id: null },
      { zalo_id: 'p1', channel: 'facebook', parent_zalo_id: 'f1' },
      { zalo_id: 't1', channel: 'telegram' },
      { zalo_id: 't2', channel: 'telegram_user' },
    ];
    expect(proxyAssignableAccounts(accounts).map(a => a.zalo_id)).toEqual(['z1', 'z2', 'f1']);
  });
});

describe('proxyAppliedMessage', () => {
  test('saysWhenTheNewProxyTakesEffect', () => {
    expect(proxyAppliedMessage('reconnecting')).toBe('Đã lưu. Đang kết nối lại tài khoản qua proxy mới…');
    expect(proxyAppliedMessage('next_connect')).toBe('Đã lưu. Proxy có hiệu lực khi tài khoản kết nối lại');
    expect(proxyAppliedMessage('next_start')).toBe('Đã lưu. Proxy có hiệu lực sau khi bạn mở lại MaiHub');
    expect(proxyAppliedMessage(undefined)).toBe('Đã lưu');
  });
});
