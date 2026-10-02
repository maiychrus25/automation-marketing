import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '@/lib/ipc';
import { DataAccessor } from '@/lib/data/DataAccessor';

import { useAppStore, FONT_SCALE_MIN, FONT_SCALE_MAX, FONT_SCALE_STEP } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { useUpdateStore } from '@/store/updateStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useCRMStore } from '@/store/crmStore';
import { useChatStore } from '@/store/chatStore';
import AppearanceMenu from './AppearanceMenu';
import WorkspaceSwitcher from '@/components/common/WorkspaceSwitcher';
import { useErpNotificationStore } from '@/store/erp/erpNotificationStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { useCurrentEmployeeId, useErpPermissions } from '@/hooks/erp/useErpContext';
import NotificationCenter from '@/features/erp/notifications/NotificationCenter';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, KeyIcon, MonitorIcon, PluginIcon, RefreshIcon, StarIcon } from '@/components/common/icons';
import { isFacebook, isTelegram } from '@/lib/channelHelper';


const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

/** Map scale factor to px value for display */
const scaleToPx = (s: number) => Math.round(16 * s);

/** Tiêu đề toolbar theo màn hiện tại. */
const VIEW_TITLES: Record<string, string> = {
  dashboard: 'Tổng quan',
  chat: 'Chat',
  friends: 'Bạn bè',
  crm: 'CRM',
  workflow: 'Workflow',
  integration: 'Tích hợp',
  analytics: 'Báo cáo',
  erp: 'Quản lý công việc',
  browser: 'Trình duyệt',
  settings: 'Cài đặt',
};

export default function TopBar({ variant = 'full' }: { variant?: 'full' | 'startup' }) {
  const [isMaximized, setIsMaximized] = useState(false);
  const { showNotification, fontSizeScale, setFontSizeScale, view, toggleSidebarCollapsed, sidebarCollapsed, windowAppearance } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const [loadingOldMsgs, setLoadingOldMsgs] = useState(false);
  const [lockScreenEnabled, setLockScreenEnabled] = useState(false);

  // More dropdown (guide + bug report + font size)
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Font size slider: local temp value, only applies on release
  const [fontTemp, setFontTemp] = useState(fontSizeScale);

  // Update state
  const { status: updateStatus, updateInfo, platform, setShowPopup, openUpdatePopup } = useUpdateStore();
  const isMac = platform === 'darwin';

  // Employee store
  const { mode: empMode, currentEmployee, bossConnected, bossUrl, latency, previewEmployeeId, employees, setBossConnected, setToken } = useEmployeeStore();
  const previewEmployee = previewEmployeeId ? employees.find((e: any) => e.employee_id === previewEmployeeId) : null;

  // Reconnect popup state
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState('');
  const [savedPassword, setSavedPassword] = useState('');
  const bossUrlRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Load saved password từ localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('deplao_employee_password');
      if (raw) setSavedPassword(atob(raw));
    } catch { /* ignore */ }
  }, []);

  // Save password khi kết nối thành công
  const savePassword = useCallback((password: string) => {
    try {
      localStorage.setItem('deplao_employee_password', btoa(password));
      setSavedPassword(password);
    } catch { /* ignore */ }
  }, []);

  // ── Ngắt kết nối khỏi BOSS ──────────────────────────────────────────────
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      // Reset REST client — stop health check, clear token
      const RestQueryService = (await import('../../../services/http/RestQueryService')).default;
      RestQueryService.getInstance().reset();

      // Chỉ set disconnected, KHÔNG reset currentEmployee/mode
      // => giữ nguyên badge + nút kết nối lại trên UI
      setBossConnected(false);
      setToken('');

      showNotification('Đã ngắt kết nối khỏi BOSS', 'success');
    } catch (err: any) {
      showNotification(err.message || 'Lỗi ngắt kết nối', 'error');
    } finally {
      setDisconnecting(false);
    }
  }, [disconnecting, showNotification, setBossConnected, setToken]);

  const handleReconnect = useCallback(async () => {
    setReconnectError('');
    const bossAddr = bossUrlRef.current?.value.trim();
    const username = usernameRef.current?.value.trim();
    const password = passwordRef.current?.value || savedPassword;

    if (!bossAddr) { setReconnectError('Vui lòng nhập địa chỉ BOSS'); return; }
    if (!username) { setReconnectError('Vui lòng nhập tên đăng nhập'); return; }
    if (!password) { setReconnectError('Vui lòng nhập mật khẩu'); return; }

    setReconnecting(true);
    try {
      const RestQueryService = (await import('../../../services/http/RestQueryService')).default;

      const loginRes = await RestQueryService.login(bossAddr, username, password);
      if (!loginRes.success) {
        setReconnectError(loginRes.error || 'Đăng nhập thất bại');
        setReconnecting(false);
        return;
      }

      // Boss trả về {success, token, employee, snapshot} — KHÔNG có data wrapper
      const token = (loginRes as any).token || loginRes.data?.token;
      const employee = (loginRes as any).employee || loginRes.data?.employee;
      if (!token || !employee) {
        setReconnectError('Phản hồi từ BOSS không hợp lệ');
        setReconnecting(false);
        return;
      }

      RestQueryService.getInstance().init(bossAddr, token);
      // Theo dõi trạng thái kết nối RestQueryService → cập nhật header real-time
      RestQueryService.getInstance().setOnStatusChange((connected, latency) => {
        useEmployeeStore.getState().setBossConnected(connected);
        if (latency > 0) useEmployeeStore.getState().setLatency(latency);
      });
      await ipc.employee?.setMode('employee');
      await ipc.employee?.connectToBoss(bossAddr, token);

      const permsMap: Record<string, boolean> = {};
      if (employee.permissions) {
        for (const p of employee.permissions) permsMap[p.module] = p.can_access;
      }

      useEmployeeStore.getState().setCurrentEmployee(employee);
      useEmployeeStore.getState().setPermissions(permsMap);
      useEmployeeStore.getState().setAssignedAccounts(employee.assigned_accounts || []);
      useEmployeeStore.getState().setBossUrl(bossAddr);
      // Persist bossUrl to workspace cache — không bị cached URL cũ ghi đè
      ipc.workspace?.update?.(useWorkspaceStore.getState().activeWorkspaceId, { bossUrl: bossAddr } as any).catch(() => {});
      useEmployeeStore.getState().setBossConnected(true);
      useEmployeeStore.getState().setToken(token);
      useEmployeeStore.getState().setMode('employee');

      showNotification(`Đã kết nối lại! Xin chào ${employee.display_name}`, 'success');
      savePassword(password);
      setReconnectOpen(false);
      setReconnecting(false);
    } catch (err: any) {
      setReconnectError(err.message || 'Lỗi kết nối');
      setReconnecting(false);
    }
  }, [showNotification]);

  // ERP notifications + attendance
  const erpPerms = useErpPermissions();
  const erpEid = useCurrentEmployeeId();
  const { unreadCount, loadUnreadCount } = useErpNotificationStore();
  const { loadTodayAttendance } = useErpEmployeeStore();
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!erpPerms.can('erp.access')) return;
    loadUnreadCount(erpEid);
    loadTodayAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erpEid]);

  useEffect(() => {
    if (!ipc.on) return;
    const unsub = ipc.on('erp:event:notification', () => loadUnreadCount(erpEid));
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erpEid]);

  useEffect(() => {
    if (!bellOpen) return;
    const handler = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bellOpen]);

  // Đóng more dropdown khi click ra ngoài
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [moreOpen]);

  // Sync fontTemp when fontSizeScale changes externally
  useEffect(() => {
    setFontTemp(fontSizeScale);
  }, [fontSizeScale]);

  // Update: now using badge next to version + popup (see below)

  useEffect(() => {
    ipc.window?.isMaximized().then(setIsMaximized);
  }, []);

  // Check lock screen status
  useEffect(() => {
    ipc.lockScreen?.status().then(res => {
      if (res?.success && res.enabled) setLockScreenEnabled(true);
    });
    // Listen for lock screen enable/disable from Settings
    const handleChanged = (e: Event) => {
      const enabled = (e as CustomEvent).detail?.enabled ?? false;
      setLockScreenEnabled(enabled);
    };
    window.addEventListener('lockScreen:changed', handleChanged);
    return () => window.removeEventListener('lockScreen:changed', handleChanged);
  }, []);

  // Đóng reconnect popup khi click ra ngoài
  useEffect(() => {
    if (!reconnectOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.reconnect-popup') && !target.closest('.employee-badge')) {
        setReconnectOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [reconnectOpen]);

  // Telegram topbar sync is intentionally background work. Refresh the
  // currently visible DB state once the main process signals completion, while
  // never blocking the topbar button for a long channel/history pass.
  useEffect(() => {
    if (!ipc.on) return;
    return ipc.on('event:telegramSync', (data: any) => {
      if (!data?.zaloId || data.zaloId !== activeAccountId) return;
      if (data.status === 'failed') {
        showNotification(data.error || 'Không thể đồng bộ tin nhắn Telegram', 'error');
        return;
      }
      if (data.status !== 'completed') return;

      void (async () => {
        const conversationsRes = await DataAccessor.getConversations(data.zaloId, 500, 0);
        const contacts = conversationsRes?.items ?? [];
        useChatStore.getState().setContacts(data.zaloId, contacts);

        const chatState = useChatStore.getState();
        const threadId = chatState.activeThreadId;
        const topicId = chatState.activeTopicId;
        if (threadId) {
          const messagesRes = await DataAccessor.getMessages({
            zaloId: data.zaloId,
            threadId,
            topicId: topicId || undefined,
            limit: topicId ? 50 : 20,
            offset: 0,
          });
          const dbMessages = messagesRes?.messages ?? messagesRes?.items ?? [];
          const latestState = useChatStore.getState();
          if (
            useAccountStore.getState().activeAccountId === data.zaloId &&
            latestState.activeThreadId === threadId &&
            latestState.activeTopicId === topicId
          ) {
            latestState.setMessages(data.zaloId, threadId, [...dbMessages].reverse(), topicId);
          }
        }

        const insertedText = data.inserted ? `, thêm ${data.inserted} tin nhắn` : '';
        const pendingText = data.pending ? '. Phần còn lại đang tiếp tục tải nền' : '';
        showNotification(`Đã đồng bộ ${contacts.length} hội thoại${insertedText}${pendingText}`, 'success');
      })().catch(() => {
        showNotification('Đã tải dữ liệu Telegram, nhưng không thể làm mới giao diện.', 'warning');
      });
    });
  }, [activeAccountId, showNotification]);

  // ── Tải tin nhắn cũ / đồng bộ lại hội thoại ────────────────────────────────
  const handleRequestOldMessages = useCallback(async () => {
    if (!activeAccountId || loadingOldMsgs) return;

    // Detect channel of active account
    const activeAccount = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);

    setLoadingOldMsgs(true);
    try {
      if (isFacebook(activeAccount?.channel)) {
        // Facebook: force-refresh threads + reload contacts into store
        showNotification('Đang đồng bộ hội thoại Facebook...', 'success');
        const res = await ipc.fb?.getThreads({ accountId: activeAccountId, forceRefresh: true });
        if (res?.success) {
          const count = res.threads?.length ?? 0;
          // Reload contacts from DB into chat store
          try {
            const contactsRes = await ipc.db?.getContacts(activeAccountId);
            const contacts = contactsRes?.contacts ?? contactsRes ?? [];
            if (contacts.length > 0) {
              useChatStore.getState().setContacts(activeAccountId, contacts);
            }
          } catch {}
          // Refresh avatar cho active thread nếu là 1-1 Facebook
          const chatState = useChatStore.getState();
          const activeThreadId = chatState.activeThreadId;
          const activeThreadType = chatState.activeThreadType;
          if (activeThreadId && activeThreadType !== 1 && /^\d+$/.test(activeThreadId)) {
            ipc.fb.refreshContactAvatar({ accountId: activeAccountId, userId: activeThreadId })
              .then(refreshRes => {
                if (refreshRes.success && refreshRes.avatarUrl) {
                  useChatStore.getState().updateContact(activeAccountId, {
                    contact_id: activeThreadId,
                    avatar_url: refreshRes.avatarUrl,
                  });
                }
              }).catch(() => {});
          }
          showNotification(`Đã đồng bộ ${count} hội thoại Facebook`, 'success');
        } else {
          showNotification(res?.error || 'Không thể đồng bộ hội thoại Facebook', 'error');
        }
      } else if (isTelegram(activeAccount?.channel)) {
        // Acknowledge immediately. Full account history runs in the main
        // process and completion refreshes the visible state via telegramSync.
        const syncRes = await ipc.telegramUser?.refreshMessages({ accountId: activeAccountId });
        if (!syncRes?.success) {
          showNotification(syncRes?.error || 'Không thể đồng bộ tin nhắn Telegram', 'error');
          return;
        }
        showNotification(
          'Đang tải tin nhắn Telegram ở nền. Hội thoại sẽ tự cập nhật.',
          'info',
        );
      } else {
        // Zalo: request old messages as before
        const res = await ipc.login?.requestOldMessages(activeAccountId);
        if (res?.success) {
          showNotification('Đang tải tin nhắn cũ… Tin nhắn sẽ xuất hiện dần.', 'success');
        } else {
          showNotification(res?.error || 'Không thể tải tin nhắn cũ', 'error');
        }
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + (e.message || 'Không thể tải'), 'error');
    } finally {
      setLoadingOldMsgs(false);
    }
  }, [activeAccountId, loadingOldMsgs, showNotification]);

  const nativeControls = windowAppearance.nativeControls;
  const toolbarClass = `app-toolbar app-drag ${nativeControls ? 'has-native-controls' : ''}`;

  // Nút cửa sổ tự vẽ: chỉ khi không phải macOS và không có overlay gốc.
  const maximizeLabel = isMaximized ? 'Phục hồi' : 'Phóng to';
  const trafficGlyph = { width: 8, height: 8, viewBox: '0 0 8 8', fill: 'none', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 1.2, strokeLinecap: 'round' as const };
  const windowButtons = !isMac && !nativeControls ? (
    windowAppearance.platform === 'linux' ? (
    <div className="app-traffic app-no-drag" role="group" aria-label="Điều khiển cửa sổ">
      <button type="button" className="app-traffic-btn is-minimize" onClick={() => ipc.window?.minimize()} title="Thu nhỏ" aria-label="Thu nhỏ">
        <svg {...trafficGlyph}><path d="M1 4h6" /></svg>
      </button>
      <button type="button" className="app-traffic-btn is-maximize" onClick={() => { ipc.window?.maximize(); setIsMaximized(!isMaximized); }} title={maximizeLabel} aria-label={maximizeLabel}>
        <svg {...trafficGlyph}><path d="M1 4h6M4 1v6" /></svg>
      </button>
      <button type="button" className="app-traffic-btn is-close" onClick={() => ipc.window?.close()} title="Đóng" aria-label="Đóng">
        <svg {...trafficGlyph}><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" /></svg>
      </button>
    </div>
    ) : (
    <div className="flex items-stretch -mr-[15px] ml-2">
      <button type="button" onClick={() => ipc.window?.minimize()} className="app-window-btn" title="Thu nhỏ" aria-label="Thu nhỏ">
        <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><rect width="10" height="1" /></svg>
      </button>
      <button type="button" onClick={() => { ipc.window?.maximize(); setIsMaximized(!isMaximized); }} className="app-window-btn" title={isMaximized ? 'Phục hồi' : 'Phóng to'} aria-label={isMaximized ? 'Phục hồi' : 'Phóng to'}>
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="2" y="0" width="8" height="8" /><rect x="0" y="2" width="8" height="8" fill="none" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0" y="0" width="10" height="10" /></svg>
        )}
      </button>
      <button type="button" onClick={() => ipc.window?.close()} className="app-window-btn is-close" title="Đóng" aria-label="Đóng">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="0" y1="0" x2="10" y2="10" /><line x1="10" y1="0" x2="0" y2="10" /></svg>
      </button>
    </div>
    )
  ) : null;

  if (variant === 'startup') {
    return <header className={toolbarClass}><div className="flex-1" />{windowButtons}</header>;
  }

  return (
    <>
      <style>{`
        @keyframes reconnectShake {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          10%      { transform: translate(-1.5px, 0.8px) rotate(-0.8deg); }
          20%      { transform: translate(1.2px, -0.5px) rotate(0.6deg); }
          30%      { transform: translate(-0.8px, -1px) rotate(-0.4deg); }
          40%      { transform: translate(1.5px, 0.5px) rotate(0.7deg); }
          50%      { transform: translate(-1px, 1.2px) rotate(-0.5deg); }
          60%      { transform: translate(0.5px, -0.8px) rotate(0.3deg); }
          70%      { transform: translate(-1.2px, -0.3px) rotate(-0.6deg); }
          80%      { transform: translate(0.8px, 1px) rotate(0.4deg); }
          90%      { transform: translate(-0.5px, -1.2px) rotate(-0.3deg); }
        }
      `}</style>
    <header className={toolbarClass}>
      <div className="app-toolbar-left">
        <button type="button" className="app-toolbar-btn" onClick={toggleSidebarCollapsed}
          title={sidebarCollapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'} aria-label={sidebarCollapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
        </button>
        <span className="app-toolbar-title">{VIEW_TITLES[view] || 'MaiHub'}</span>
        <span className="app-toolbar-sep" />

        {/* Workspace switcher - only shows when multiple workspaces exist */}
        <WorkspaceSwitcher />

        {/* Employee mode indicator + reconnect popup */}
        {empMode === 'employee' && currentEmployee && (
          <div className="relative flex items-center gap-2">
            {/* Status badge (không click được) */}
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-gray-800 border border-gray-600 select-none">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${bossConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
              <span className="text-[11px] text-gray-300">{bossConnected ? (latency > 0 ? `Online - ${latency}ms` : 'Online') : 'Offline'}</span>
              <span className="text-[11px] text-gray-300">- {currentEmployee.display_name}</span>
            </div>

            {/* Nút Ngắt kết nối — chỉ hiện khi đang connected */}
            {bossConnected && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-700/80 text-gray-400 text-[11px] font-medium transition-all duration-200 hover:bg-red-600/30 hover:text-red-300 hover:border-red-500/30 border border-gray-600/50 disabled:opacity-50"
                title="Ngắt kết nối khỏi BOSS"
              >
                {disconnecting ? (
                  <span className="w-3 h-3 border-2 border-gray-500 border-t-gray-300 rounded-full animate-spin" />
                ) : (
                  <>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <line x1="12" y1="20" x2="12.01" y2="20" />
                    </svg>
                    <span>Ngắt kết nối</span>
                  </>
                )}
              </button>
            )}

            {/* Nút Kết nối lại riêng biệt — chỉ hiện khi disconnected */}
            {!bossConnected && (
              <button
                onClick={() => setReconnectOpen(v => !v)}
                className="employee-badge reconnect-btn relative flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-700/90 text-white text-[11px] font-semibold transition-all duration-300 hover:bg-green-700 hover:shadow-green-400/50 overflow-hidden border border-green-500/40"
                style={{ animation: 'reconnectShake 0.6s ease-in-out infinite' }}
              >
                <span className="relative z-10 flex items-center gap-1.5 text-white-important">
                  <span className="drop-shadow-[0_0_4px_rgba(34,197,94,0.6)]"><PluginIcon className="w-4 h-4" /></span>
                  <span className="drop-shadow-[0_0_6px_rgba(34,197,94,0.4)]">Kết nối lại</span>
                </span>
              </button>
            )}

            {/* Reconnect popup */}
            {reconnectOpen && (
              <div className="reconnect-popup mac-popover absolute left-0 top-full mt-2 w-72 z-[9999] p-4">
                <p className="text-xs text-gray-400 font-medium mb-2"><PluginIcon className="w-4 h-4 inline" /> Kết nối lại với BOSS</p>
                <div className="space-y-2">
                  <input
                    ref={bossUrlRef}
                    defaultValue={bossUrl}
                    placeholder="Địa chỉ BOSS (IP:Port hoặc Tunnel URL)"
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  <input
                    ref={usernameRef}
                    defaultValue={currentEmployee?.username || ''}
                    placeholder="Tên đăng nhập"
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  <input
                    ref={passwordRef}
                    type="password"
                    placeholder={savedPassword ? '••••••••' : 'Mật khẩu'}
                    defaultValue={savedPassword || ''}
                    onKeyDown={e => e.key === 'Enter' && handleReconnect()}
                    className="w-full px-2.5 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-gray-200 placeholder-gray-500"
                  />
                  {savedPassword && (
                    <p className="text-[10px] text-gray-400 text-right"><KeyIcon className="w-4 h-4 inline" /> Đã lưu mật khẩu</p>
                  )}
                  {reconnectError && (
                    <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1">
                      <AlertIcon className="w-3 h-3 inline text-red-400" /> {reconnectError}
                    </p>
                  )}
                  <button
                    onClick={handleReconnect}
                    disabled={reconnecting}
                    className="w-full py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {reconnecting ? (
                      <>
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Đang kết nối...
                      </>
                    ) : '🔌 Kết nối lại'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Boss preview mode indicator */}
        {empMode !== 'employee' && previewEmployee && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-amber-900/40 border border-amber-600/40">
            <span className="text-[11px] text-amber-300">👁 Đang xem: {previewEmployee.display_name}</span>
          </div>
        )}
      </div>

      {/* Toolbar actions */}
      <div className="app-toolbar-right">
        {/* Tải tin nhắn cũ (toàn phiên đăng nhập) - ẩn với nhân viên */}
        {activeAccountId && empMode !== 'employee' && (
          <button
            onClick={handleRequestOldMessages}
            disabled={loadingOldMsgs}
            className={`app-toolbar-btn ${loadingOldMsgs ? 'text-blue-400' : ''}`}
            title={(() => {
              const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
              return isFacebook(acc?.channel)
                ? 'Đồng bộ lại hội thoại Facebook'
                : isTelegram(acc?.channel)
                  ? 'Đồng bộ hội thoại và tin nhắn Telegram'
                  : 'Tải tin nhắn cũ';
            })()}
          >
            {loadingOldMsgs ? (
              <Spinner size={3} />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
            )}
          </button>
        )}

        {/* Update: now handled by badge next to version + UpdateNotification popup */}

        {/*/!* ── ERP Attendance quick check-in ── *!/*/}
        {/*{erpPerms.can('attendance.checkin') && (*/}
        {/*  <button*/}
        {/*    onClick={async () => {*/}
        {/*      if (!todayAttendance?.check_in_at) await checkIn();*/}
        {/*      else if (!todayAttendance?.check_out_at) await checkOut();*/}
        {/*      else showNotification('Đã chấm công đầy đủ hôm nay', 'success');*/}
        {/*    }}*/}
        {/*    className={`w-9 h-9 flex items-center justify-center transition-colors ${*/}
        {/*      todayAttendance?.check_out_at ? 'text-green-500' :*/}
        {/*      todayAttendance?.check_in_at ? 'text-blue-400 hover:bg-gray-700' :*/}
        {/*      'text-gray-400 hover:bg-gray-700 hover:text-white'*/}
        {/*    }`}*/}
        {/*    title={*/}
        {/*      todayAttendance?.check_out_at ? 'Đã check-out hôm nay' :*/}
        {/*      todayAttendance?.check_in_at ? 'Check-out' : 'Check-in'*/}
        {/*    }*/}
        {/*  >*/}
        {/*    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">*/}
        {/*      <circle cx="12" cy="12" r="9" />*/}
        {/*      <polyline points="12 7 12 12 15 14" />*/}
        {/*    </svg>*/}
        {/*  </button>*/}
        {/*)}*/}

        {/* ── ERP Notifications bell ── */}
        {erpPerms.can('erp.access') && (
          <div className="relative" ref={bellRef}>
            <button
              onClick={() => setBellOpen(v => !v)}
              className="app-toolbar-btn"
              aria-expanded={bellOpen}
              title="Thông báo ERP"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadCount > 0 && (
                <span className="app-toolbar-badge">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute right-0 top-full mt-1 z-[9999] app-no-drag">
                <NotificationCenter onClose={() => setBellOpen(false)} />
              </div>
            )}
          </div>
        )}

        {/* MaiHub: đã gỡ nút dẫn sang kho GitHub của tác giả
            thượng nguồn — bản nội bộ không quảng bá dự án bên ngoài. */}



        {/* Lock screen button - only visible when lock screen is enabled */}
        {lockScreenEnabled && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('lockScreen:lock'))}
            className="app-toolbar-btn"
            title="Khoá ứng dụng (Ctrl+Shift+L)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </button>
        )}

        <AppearanceMenu />

        {/* ── More dropdown (guide + bug report + font size) ── */}
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen(v => !v)}
            className="app-toolbar-btn"
            aria-expanded={moreOpen}
            title="Thêm (cỡ chữ, hướng dẫn, báo lỗi)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1.5"/>
              <circle cx="5" cy="12" r="1.5"/>
              <circle cx="19" cy="12" r="1.5"/>
            </svg>
          </button>

          {moreOpen && (
            <div className="mac-popover absolute right-0 top-full mt-1.5 w-64 z-[9999] overflow-hidden">
              {/* Font size slider */}
              <div className="px-4 py-3 border-b border-gray-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400 font-medium">Cỡ chữ</span>
                  <span className="text-xs text-gray-200 font-semibold min-w-[2.5rem] text-right">
                    {scaleToPx(fontTemp)}px
                  </span>
                </div>
                <input
                  type="range"
                  min={FONT_SCALE_MIN}
                  max={FONT_SCALE_MAX}
                  step={FONT_SCALE_STEP}
                  value={fontTemp}
                  onChange={(e) => setFontTemp(Number(e.target.value))}
                  onMouseUp={() => setFontSizeScale(fontTemp)}
                  onTouchEnd={() => setFontSizeScale(fontTemp)}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer
                    bg-gray-600 accent-blue-500
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500
                    [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-gray-800
                    [&::-webkit-slider-thumb]:shadow-md"
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-gray-400">12px</span>
                  <span className="text-[10px] text-gray-400">24px</span>
                </div>
              </div>

              {/* Hướng dẫn sử dụng */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'overview' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-blue-400 transition-colors text-left"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">Hướng dẫn sử dụng</p>
                  <p className="text-[10px] text-gray-400">Tính năng & thao tác cơ bản</p>
                </div>
              </button>

              {/* Báo lỗi */}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
                  setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'bugreport' } })), 80);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-red-400 transition-colors text-left border-t border-gray-700/50"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                  <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>
                  <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/>
                  <path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17H2M18 13h4M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 17h4"/>
                </svg>
                <div>
                  <p className="text-xs font-medium">Báo lỗi</p>
                  <p className="text-[10px] text-gray-400">Gửi phản hồi & báo cáo lỗi</p>
                </div>
              </button>



            </div>
          )}
        </div>
      </div>

      {windowButtons}
    </header>
    </>
  );
}
