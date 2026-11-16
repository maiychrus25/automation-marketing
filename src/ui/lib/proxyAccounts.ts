import { CHANNEL } from './channelHelper';

/**
 * Tài khoản gán được proxy riêng: Zalo và Facebook cá nhân. Page Facebook đi cùng proxy với tài khoản chính của nó,
 * còn Telegram chưa đi qua proxy.
 */
export function proxyAssignableAccounts<T extends { channel?: string; parent_zalo_id?: string | null }>(accounts: T[]): T[] {
  return accounts.filter((a) => {
    const channel = a.channel || CHANNEL.ZALO;
    return channel === CHANNEL.ZALO || (channel === CHANNEL.FACEBOOK && !a.parent_zalo_id);
  });
}

/** Thông báo sau khi gán proxy, theo cách máy chủ đã áp proxy mới (`applied` của `proxy:setAccount`). */
export function proxyAppliedMessage(applied?: string): string {
  if (applied === 'reconnecting') return 'Đã lưu. Đang kết nối lại tài khoản qua proxy mới…';
  if (applied === 'next_connect') return 'Đã lưu. Proxy có hiệu lực khi tài khoản kết nối lại';
  if (applied === 'next_start') return 'Đã lưu. Proxy có hiệu lực sau khi bạn mở lại MaiHub';
  return 'Đã lưu';
}
