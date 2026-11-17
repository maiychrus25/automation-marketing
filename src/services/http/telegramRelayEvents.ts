import { relayEventAccountIds } from '../socket/relayAudience';

/**
 * telegramRelayEvents - Nhận diện sự kiện relay của tài khoản Telegram ở máy nhân viên. Thuần, không I/O.
 * Dữ liệu Telegram nhân viên đọc từ boss qua REST nên sự kiện loại này không bao giờ được ghi vào cơ sở dữ liệu tại máy.
 */

export function isTelegramChannelName(channel: unknown): boolean {
  return channel === 'telegram_user' || channel === 'telegram_bot';
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Đúng khi payload mang kênh Telegram (ngoài cùng, message, message.data) hoặc mã tài khoản (mọi khoá relayAudience nhận diện) thuộc tài khoản Telegram đã biết. */
export function isTelegramRelayPayload(data: unknown, telegramAccountIds: ReadonlySet<string>): boolean {
  if (!isObject(data)) return false;
  if (isTelegramChannelName(data.channel)) return true;
  const message = data.message;
  if (isObject(message) && (isTelegramChannelName(message.channel) || (isObject(message.data) && isTelegramChannelName(message.data.channel)))) return true;
  // Cùng tập khoá với classifyRelayEvent; payload nêu nhiều tài khoản là Telegram khi BẤT KỲ tài khoản nào thuộc tập.
  return relayEventAccountIds(data).some((id) => telegramAccountIds.has(id));
}

/** Mã các tài khoản Telegram trong danh sách tài khoản của snapshot (`accountsData`). */
export function telegramAccountIdsFrom(accounts: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(accounts)) return ids;
  for (const row of accounts) {
    if (isObject(row) && isTelegramChannelName(row.channel) && typeof row.zalo_id === 'string') ids.add(row.zalo_id);
  }
  return ids;
}
