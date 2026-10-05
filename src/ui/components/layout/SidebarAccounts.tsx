import React, { useRef, useState } from 'react';
import { useAccountStore, AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useVisibleAccounts } from '@/hooks/useVisibleAccounts';
import ChannelBadge, { ZaloIcon, FacebookIcon, TelegramIcon } from '../common/ChannelBadge';
import { isFacebook, isTelegram, CHANNEL } from '@/lib/channelHelper';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { formatPhone } from '@/utils/phoneUtils';
import { orderAccountsWithChildren } from '@/lib/accountTree';
import { FolderIcon } from '@/components/common/icons';

/** Hiện ô lọc khi có từ chừng này tài khoản trở lên (spec mục 7.2). */
const FILTER_THRESHOLD = 8;

interface SidebarAccountsProps {
  collapsed: boolean;
  onAddAccount: () => void;
}

/** Số hội thoại có tin chưa đọc của một tài khoản, bỏ qua hội thoại "khác". */
function useUnreadConversationCount(): (zaloId: string) => number {
  const contacts = useChatStore((s) => s.contacts);
  const others = useAppStore((s) => s.othersConversations);
  return (zaloId) => {
    const acctOthers = others[zaloId] || new Set<string>();
    return (contacts[zaloId] || []).reduce(
      (sum, c) => (acctOthers.has(c.contact_id) || !(c.unread_count > 0) ? sum : sum + 1),
      0,
    );
  };
}

function AccountAvatar({ account, size }: { account: AccountInfo; size: number }) {
  const fallbackClass = isFacebook(account.channel) ? 'bg-blue-800' : isTelegram(account.channel) ? 'bg-blue-500' : 'bg-blue-600';
  const iconSize = Math.round(size * 0.4);
  return (
    <span className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <span className="block w-full h-full rounded-full overflow-hidden">
        {account.avatar_url ? (
          <img
            src={toLocalMediaUrl(account.avatar_url)}
            alt={account.full_name}
            className="w-full h-full object-cover"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.style.display = 'none';
              import('@/lib/avatarRetry').then(({ handleAvatarError }) =>
                handleAvatarError({ ownerId: account.zalo_id, contactId: account.zalo_id, channel: account.channel || CHANNEL.ZALO })
              ).then((newUrl) => {
                if (newUrl) {
                  useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: newUrl });
                  img.src = newUrl;
                  img.style.display = '';
                } else {
                  useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: '' });
                }
              }).catch(() => {
                useAccountStore.getState().updateAccount(account.zalo_id, { avatar_url: '' });
              });
            }}
          />
        ) : (
          <span className={`w-full h-full flex items-center justify-center text-white ${fallbackClass}`}>
            {isFacebook(account.channel) ? <FacebookIcon size={iconSize} /> : isTelegram(account.channel) ? <TelegramIcon size={iconSize} /> : <ZaloIcon size={iconSize} />}
          </span>
        )}
      </span>
      <span className="absolute -top-1.5 -left-1 pointer-events-none">
        <ChannelBadge channel={(account.channel as any) || CHANNEL.ZALO} size="xs" />
      </span>
      {account.parent_zalo_id && (
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-blue-600 text-white flex items-center justify-center pointer-events-none" title="Page Facebook">
          <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3v18h2v-7h6l1 2h6V5h-6l-1-2H5z"/></svg>
        </span>
      )}
    </span>
  );
}

function accountTooltip(account: AccountInfo, listenerDead: boolean): string {
  return [
    account.full_name || account.zalo_id,
    account.phone ? formatPhone(account.phone) : account.username ? `@${account.username}` : null,
    account.is_business ? 'Tài khoản Zalo Business' : null,
    account.parent_zalo_id ? 'Page Facebook' : null,
    listenerDead ? 'Listener chết' : !account.isConnected ? 'Chưa kết nối' : null,
  ].filter(Boolean).join('\n');
}

export default function SidebarAccounts({ collapsed, onAddAccount }: SidebarAccountsProps) {
  const { activeAccountId, setActiveAccount, reorderAccounts } = useAccountStore();
  const accounts = useVisibleAccounts();
  const previewEmployeeId = useEmployeeStore((s) => s.previewEmployeeId);
  const empMode = useEmployeeStore((s) => s.mode);
  const isSimulating = empMode !== 'employee' && !!previewEmployeeId;
  const canAdd = empMode !== 'employee' && !isSimulating;
  const { setView, mergedInboxMode, mergedInboxAccounts, mergedInboxFilterAccount, setMergedInboxFilter, exitMergedInbox } = useAppStore();
  const { activeThreadId, activeThreadType, saveAccountThread } = useChatStore();
  const unreadOf = useUnreadConversationCount();

  const [filter, setFilter] = useState('');
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Ô lọc ẩn khi thu gọn, nên bỏ lọc để danh sách không bị lọc ngầm.
  const filterVisible = !collapsed && accounts.length >= FILTER_THRESHOLD;
  const query = filterVisible ? filter.trim().toLowerCase() : '';
  // Page con đứng ngay sau tài khoản cha; thứ tự dựng lại mỗi lần render nên kéo cha thì con đi theo
  const ordered = orderAccountsWithChildren(accounts);
  const shown = query
    ? ordered.filter((a) => (a.full_name || '').toLowerCase().includes(query) || (a.phone || '').includes(query))
    : ordered;
  // Kéo thả dùng chỉ số trong danh sách đầy đủ; tắt khi đang lọc để không đổi nhầm vị trí.
  const canDrag = !query;

  const openAccount = (account: AccountInfo) => {
    if (activeAccountId && activeThreadId) saveAccountThread(activeAccountId, activeThreadId, activeThreadType);
    setActiveAccount(account.zalo_id);
    setView('chat');
  };

  const renderBadges = (account: AccountInfo, unread: number, listenerDead: boolean) => (
    <>
      {collapsed && (listenerDead ? (
        <span className="absolute top-1 right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center pointer-events-none">!</span>
      ) : unread > 0 ? (
        <span className="app-count absolute top-0.5 right-1 pointer-events-none">{unread > 99 ? '99+' : unread}</span>
      ) : null)}
      {collapsed && account.is_business ? (
        <span className="absolute bottom-1 left-1.5 w-3.5 h-3.5 rounded-full bg-amber-500 text-white flex items-center justify-center pointer-events-none" title="Zalo Business">
          <FolderIcon className="w-2.5 h-2.5" />
        </span>
      ) : null}
      {!account.isConnected && !listenerDead && (
        <span className={`absolute w-3 h-3 rounded-full bg-gray-800 border border-gray-600 flex items-center justify-center pointer-events-none ${collapsed ? 'bottom-1.5 right-3' : account.parent_zalo_id ? 'left-10 top-5' : 'left-6 top-5'}`} title="Chưa kết nối">
          <svg width="6" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="text-red-500"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </span>
      )}
    </>
  );

  // ── Hộp thư gộp ───────────────────────────────────────────────────────────
  if (mergedInboxMode) {
    return (
      <>
        <div className="app-group-title">
          {!collapsed && <span>Hộp thư gộp</span>}
          <button type="button" className="app-group-action" onClick={exitMergedInbox} title="Thoát chế độ Gộp tài khoản" aria-label="Thoát chế độ Gộp tài khoản">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="app-accounts">
          <button
            type="button"
            className={`app-account ${mergedInboxFilterAccount === null ? 'is-active' : ''}`}
            onClick={() => setMergedInboxFilter(null)}
            aria-label="Tất cả tài khoản"
            title="Chọn tất cả tài khoản"
          >
            <span className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </span>
            {!collapsed && <span className="app-account-name">Tất cả tài khoản</span>}
          </button>
          {mergedInboxAccounts.map((zaloId) => {
            const account = accounts.find((a) => a.zalo_id === zaloId);
            if (!account) return null;
            const unread = unreadOf(zaloId);
            const isSelected = mergedInboxFilterAccount === zaloId;
            return (
              <button
                key={zaloId}
                type="button"
                className={`app-account ${isSelected ? 'is-active' : ''}`}
                onClick={() => setMergedInboxFilter(isSelected ? null : zaloId)}
                aria-label={account.full_name || zaloId}
                title={`${account.full_name || zaloId}${isSelected ? ' - đang lọc' : ' - nhấn để lọc'}`}
              >
                <AccountAvatar account={account} size={collapsed ? 32 : 24} />
                {!collapsed && <span className="app-account-name">{account.full_name || zaloId}</span>}
                {!collapsed && unread > 0 && <span className="app-count">{unread > 99 ? '99+' : unread}</span>}
                {renderBadges(account, unread, false)}
              </button>
            );
          })}
        </div>
      </>
    );
  }

  // ── Danh sách thường ──────────────────────────────────────────────────────
  return (
    <>
      <div className="app-group-title">
        {!collapsed && <span>Tài khoản</span>}
        {!collapsed && canAdd && (
          <button type="button" className="app-group-action" onClick={onAddAccount} title="Thêm tài khoản" aria-label="Thêm tài khoản">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        )}
      </div>
      {filterVisible && (
        <div className="px-1 pb-1.5 flex-shrink-0">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Lọc tài khoản…"
            aria-label="Lọc tài khoản"
            className="input-field h-7 text-xs"
          />
        </div>
      )}
      <div className="app-accounts">
        {shown.map((account) => {
          const index = accounts.indexOf(account);
          const unread = unreadOf(account.zalo_id);
          const listenerDead = account.isConnected && account.listenerActive === false;
          const isActive = activeAccountId === account.zalo_id;
          const isChild = !!account.parent_zalo_id;
          return (
            <div
              key={account.zalo_id}
              draggable={canDrag && !isChild}
              onDragStart={(e) => { dragIndexRef.current = index; e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIndex(index); }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIndexRef.current;
                if (from !== null && from !== index) reorderAccounts(from, index);
                dragIndexRef.current = null;
                setDragOverIndex(null);
              }}
              onDragEnd={() => { dragIndexRef.current = null; setDragOverIndex(null); }}
            >
              <button
                type="button"
                className={`app-account ${isActive ? 'is-active' : ''} ${dragOverIndex === index ? 'is-drag-over' : ''} ${isChild ? 'is-child' : ''} ${listenerDead ? 'ring-1 ring-inset ring-red-500/60' : ''}`}
                onClick={() => openAccount(account)}
                aria-label={account.full_name || account.zalo_id}
                aria-current={isActive ? 'true' : undefined}
                title={accountTooltip(account, listenerDead)}
                style={{ cursor: canDrag && !isChild ? 'grab' : 'pointer' }}
              >
                <AccountAvatar account={account} size={collapsed ? 32 : 24} />
                {!collapsed && (
                  <span className={`app-account-name ${account.isConnected ? '' : 'is-dim'}`}>{account.full_name || account.zalo_id}</span>
                )}
                {!collapsed && account.is_business ? <FolderIcon className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" /> : null}
                {!collapsed && listenerDead && <span className="text-[10px] font-bold text-red-500" title="Listener chết">!</span>}
                {!collapsed && !listenerDead && unread > 0 && <span className="app-count">{unread > 99 ? '99+' : unread}</span>}
                {renderBadges(account, unread, listenerDead)}
              </button>
            </div>
          );
        })}
        {collapsed && canAdd && (
          <button type="button" className="app-account" onClick={onAddAccount} title="Thêm tài khoản" aria-label="Thêm tài khoản">
            <span className="w-8 h-8 rounded-full border-2 border-dashed border-gray-600 flex items-center justify-center text-gray-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
            </span>
          </button>
        )}
      </div>
    </>
  );
}
