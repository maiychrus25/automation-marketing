// Máy nhân viên: lọc hội thoại đã tải trong bộ nhớ, cùng nghĩa với DatabaseService.getContactsFiltered của boss
// (search: LIKE %q% trên display_name, alias, contact_id, phone; unread: unread_count > 0; channel: bằng đúng giá trị).
// shortcut: không bỏ dấu tiếng Việt (truy vấn của boss cũng không bỏ), chỉ hạ chữ thường cho cả hai phía.
export interface ConversationFilter {
  search?: string;
  unreadOnly?: boolean;
  channel?: string;
}

export function filterConversationsInMemory<T extends { contact_id?: string; display_name?: string | null; alias?: string | null; phone?: string | null; unread_count?: number | null; channel?: string | null }>(
  contacts: readonly T[],
  { search, unreadOnly, channel }: ConversationFilter,
): T[] {
  const q = (search || '').toLowerCase();
  const byChannel = !!channel && channel !== 'all';
  if (!q && !unreadOnly && !byChannel) return contacts as T[];
  return contacts.filter((c) => {
    if (byChannel && (c.channel || 'zalo') !== channel) return false;
    if (unreadOnly && !((c.unread_count ?? 0) > 0)) return false;
    if (q && ![c.display_name, c.alias, c.contact_id, c.phone].some((v) => (v ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
}
