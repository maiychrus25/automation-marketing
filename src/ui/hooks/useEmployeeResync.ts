import { useEffect } from 'react';
import { create } from 'zustand';
import DataAccessor from '@/lib/data/DataAccessor';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAccountStore } from '@/store/accountStore';
import { useChatStore } from '@/store/chatStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { currentEmployeeSession, onEmployeeSessionEnd, reloadEmployeeConversations } from '@/lib/employeeConversations';
import { RESYNC_MESSAGES_LIMIT, ResyncScheduler, runResync, shouldIgnoreResyncSignal } from '@/lib/employeeResync';
import { mapReplyQuotes } from '@/lib/chat/mapReplyQuotes';

/** Trạng thái hiển thị ở TopBar (chỉ boolean, không chứa dữ liệu). */
export const useResyncStatus = create<{ running: boolean; failed: boolean }>(() => ({ running: false, failed: false }));

/** Máy nhân viên: nghe employee:resync và tải lại hội thoại + tin của hội thoại đang mở; chỉ nối dây, logic ở employeeResync.ts. */
export function useEmployeeResync(): void {
  useEffect(() => {
    const run = () => runResync({
      accountIds: () => useAccountStore.getState().accounts.map((a) => a.zalo_id),
      activeAccountId: () => useAccountStore.getState().activeAccountId,
      activeThreadId: () => useChatStore.getState().activeThreadId,
      activeTopicId: () => useChatStore.getState().activeTopicId,
      captureSession: currentEmployeeSession,
      isWindowFocused: () => document.hasFocus(),
      // Cùng hai lệnh như khi nhấp vào hội thoại (ConversationList.selectConversation)
      markOpenThreadRead: (zaloId, threadId) => {
        DataAccessor.markAsRead({ zaloId, contactId: threadId }).catch(() => {});
        useChatStore.getState().clearUnread(zaloId, threadId);
      },
      // Trộn theo contact_id: giữ hội thoại đã cuộn thêm; boss thắng ở unread_count
      loadConversations: (accountId, shouldWrite) => reloadEmployeeConversations(accountId, 200, shouldWrite, true),
      loadMessages: async (zaloId, threadId, topicId) => {
        const res: any = await DataAccessor.getMessages({ zaloId, threadId, limit: RESYNC_MESSAGES_LIMIT, topicId: topicId || undefined }, { throwOnError: true });
        return mapReplyQuotes(Array.isArray(res?.items) ? res.items : []).mapped;
      },
      mergeMessages: (zaloId, threadId, fetched, topicId) => useChatStore.getState().mergeFetchedMessages(zaloId, threadId, fetched, topicId),
      setStatus: (s) => {
        useResyncStatus.setState(s);
        // Một lượt tải lại không lỗi đã nạp lại mọi tài khoản → xoá dòng "chưa tải được" của lượt nạp nền (không đụng tiến độ lượt đang chạy)
        if (!s.running && !s.failed && useEmployeeStore.getState().employeeInitialLoadDone) useEmployeeStore.getState().setBootstrapProgress(0, 0, 0);
      },
    });
    const scheduler = new ResyncScheduler({
      run,
      isReady: () => useEmployeeStore.getState().employeeInitialLoadDone,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    });
    const unsubReady = useEmployeeStore.subscribe((s, prev) => {
      if (s.employeeInitialLoadDone && !prev.employeeInitialLoadDone && s.mode === 'employee') scheduler.notifyReady();
    });
    const unsub = window.electronAPI?.on('employee:resync', (payload: any) => {
      if (useEmployeeStore.getState().mode !== 'employee') return;
      // Tín hiệu của workspace khác (chỉ bỏ khi cả hai id đều biết và khác nhau)
      if (shouldIgnoreResyncSignal(payload?.workspaceId, useWorkspaceStore.getState().activeWorkspaceId)) return;
      scheduler.request(String(payload?.reason ?? 'unknown'));
    });
    // Đăng xuất / đổi workspace: không để dòng "chưa cập nhật được" của phiên cũ lại
    const offSession = onEmployeeSessionEnd(() => useResyncStatus.setState({ running: false, failed: false }));
    return () => { unsub?.(); unsubReady(); offSession(); scheduler.dispose(); };
  }, []);
}
