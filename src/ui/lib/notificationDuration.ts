// Thông báo dài cần hiện lâu hơn mới đọc kịp: 4 giây như cũ cho câu ngắn, thêm theo độ dài, tối đa 12 giây.
const BASE_MS = 4000;
const MAX_MS = 12000;
const MS_PER_CHARACTER = 60;

export function notificationDurationMs(message: string): number {
  return Math.min(MAX_MS, Math.max(BASE_MS, message.length * MS_PER_CHARACTER));
}
