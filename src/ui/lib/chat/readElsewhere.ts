/** Số chưa đọc cần áp khi hội thoại được đọc ở máy khác; null = không đổi (không bao giờ tăng). */
export function unreadAfterReadElsewhere(current: unknown, incoming: unknown): number | null {
  const from = Number(current);
  const to = Number(incoming);
  if (!Number.isInteger(to) || to < 0) return null;
  if (!Number.isFinite(from) || from <= 0 || to >= from) return null;
  return to;
}
