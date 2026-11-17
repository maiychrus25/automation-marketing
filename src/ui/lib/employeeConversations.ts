import DataAccessor from '@/lib/data/DataAccessor';
import { useChatStore } from '@/store/chatStore';

/** Máy nhân viên: nạp lại hội thoại của một tài khoản từ boss qua REST (db:getContacts cục bộ trống trên máy nhân viên). */
export async function reloadEmployeeConversations(accountId: string, limit = 200): Promise<void> {
  const res: any = await DataAccessor.getConversations(accountId, limit, 0);
  if (!Array.isArray(res?.items) || res.items.length === 0) return;
  // Giữ hội thoại cục bộ chưa có trên boss, giống loadEmployeeConversationsForAccounts
  const seen = new Set(res.items.map((c: any) => c.contact_id));
  const current = useChatStore.getState().contacts[accountId] || [];
  useChatStore.getState().setContacts(accountId, [...res.items, ...current.filter((c: any) => !seen.has(c.contact_id))]);
}
