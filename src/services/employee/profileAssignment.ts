/** Kiểm tra danh sách hồ sơ do giao diện gửi: không phải mảng thì null; bỏ phần tử không phải chuỗi và id không phải hồ sơ đang có. */
export function sanitizeProfileIds(input: unknown, existingIds: Iterable<string>): string[] | null {
  if (!Array.isArray(input)) return null;
  const existing = new Set(existingIds);
  return input.filter((id): id is string => typeof id === 'string' && existing.has(id));
}
