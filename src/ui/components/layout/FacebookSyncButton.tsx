import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { DataAccessor } from '@/lib/data/DataAccessor';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { getMessageCacheKey, useChatStore } from '@/store/chatStore';
import { isFacebook } from '@/lib/channelHelper';
import DateInputVN from '@/components/common/DateInputVN';
import { DownloadIcon } from '@/components/common/icons';
import type { FbHistorySyncStatus } from '../../../services/facebook/facebookHistory';
import {
  mergeThreadMessages, nextFocusIndex, refreshPlan, resolveSyncRange, tabStopIndexes, type SyncPreset,
} from '../../lib/chat/mobileSyncView';
import {
  FB_SYNC_ALL_WARNING, FB_SYNC_TITLE, FB_SYNC_WAITING,
  fbSyncNotes, fbSyncProgress, isFbSyncRunning, isFbSyncTerminal, isFbSyncWaiting, reduceFbSyncStatus,
} from '../../lib/chat/fbHistorySyncView';

const PRESETS: { value: SyncPreset; label: string }[] = [
  { value: 'week', label: '1 tuần gần nhất' },
  { value: 'custom', label: 'Chọn ngày' },
  { value: 'all', label: 'Toàn bộ' },
];

// Làm mới danh sách hội thoại; hội thoại đang mở chỉ được gộp thêm tin (không thay thế). Cùng cách với MobileSyncButton.
async function refreshChats(accountId: string) {
  const chat = useChatStore.getState();
  const plan = refreshPlan(accountId, useAccountStore.getState().activeAccountId, chat.activeThreadId);
  if (plan.list) {
    try {
      const res = await ipc.db?.getContacts(accountId);
      const contacts = res?.contacts ?? res ?? [];
      if (contacts.length > 0) useChatStore.getState().setContacts(accountId, contacts);
    } catch {}
  }
  if (!plan.thread) return;
  try {
    const { activeThreadId, activeTopicId } = chat;
    if (!activeThreadId) return;
    const key = getMessageCacheKey(accountId, activeThreadId, activeTopicId);
    const loaded = useChatStore.getState().messages[key] || [];
    const limit = Math.min(5000, Math.max(50, loaded.length + 50));
    const dbRes = await DataAccessor.getMessages({ zaloId: accountId, threadId: activeThreadId, limit, offset: 0, topicId: activeTopicId });
    const fetched = dbRes?.messages || dbRes?.items || [];
    const current = useChatStore.getState().messages[key] || [];
    const merged = mergeThreadMessages(current, [...fetched].reverse());
    if (merged !== current) useChatStore.getState().setMessages(accountId, activeThreadId, merged, activeTopicId);
  } catch {}
}

export default function FacebookSyncButton() {
  const showNotification = useAppStore(s => s.showNotification);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const account = useAccountStore(s => s.accounts.find(a => a.zalo_id === activeAccountId));
  const visible = !!activeAccountId && isFacebook(account?.channel);

  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, FbHistorySyncStatus>>({});
  const [preset, setPreset] = useState<SyncPreset>('week');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [formError, setFormError] = useState('');
  const [retry, setRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState('');

  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const activeRef = useRef<string | null>(null);
  const handledRef = useRef<Record<string, string | null>>({});
  openRef.current = open;
  activeRef.current = activeAccountId;

  const status = activeAccountId ? statuses[activeAccountId] : undefined;
  const running = isFbSyncRunning(status);

  // Hết thời gian chờ mà không có sự kiện mới: render lại để dòng "Đang chờ…" tắt đúng hạn.
  const [, setTick] = useState(0);
  const pausedUntil = status?.pausedUntil;
  useEffect(() => {
    if (!running || !pausedUntil || pausedUntil <= Date.now()) return;
    const t = setTimeout(() => setTick(n => n + 1), pausedUntil - Date.now());
    return () => clearTimeout(t);
  }, [running, pausedUntil]);

  // fromEvent=false (getStatus/start) chỉ đánh dấu đã xử lý, không thông báo lại.
  const applyStatus = useCallback((next: FbHistorySyncStatus, fromEvent: boolean) => {
    setStatuses(prev => {
      const merged = reduceFbSyncStatus(prev[next.accountId] ?? null, next, next.accountId);
      return merged && merged !== prev[next.accountId] ? { ...prev, [next.accountId]: merged } : prev;
    });
    if (!isFbSyncTerminal(next)) return;
    const key = `${next.accountId}:${next.startedAt}:${next.stage}`;
    if (handledRef.current[next.accountId] === key) return;
    handledRef.current[next.accountId] = key;
    const showing = openRef.current && activeRef.current === next.accountId;
    if (fromEvent && !showing && next.stage !== 'cancelled') {
      if (next.stage === 'completed') showNotification(next.message || 'Đồng bộ tin nhắn Facebook hoàn tất', 'success');
      else showNotification(next.error || next.message || 'Đồng bộ tin nhắn Facebook thất bại', 'error');
    }
    if (next.stage !== 'failed' || next.messagesSaved > 0) void refreshChats(next.accountId);
  }, [showNotification]);

  useEffect(() => {
    const unsub = ipc.on?.('event:fbHistorySync', (data: FbHistorySyncStatus) => {
      if (data?.accountId) applyStatus(data, true);
    });
    return () => { unsub?.(); };
  }, [applyStatus]);

  useEffect(() => {
    setBusy(false); setCancelling(false); setFormError(''); setActionError(''); setRetry(false);
  }, [activeAccountId]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);

  // Mở hộp thoại: lấy trạng thái hiện tại của tài khoản đang chọn.
  useEffect(() => {
    if (!open || !activeAccountId) return;
    let alive = true;
    ipc.fbHistorySync?.getStatus(activeAccountId).then(res => {
      if (alive && res?.success && res.status) applyStatus(res.status, false);
    }).catch(() => {});
    return () => { alive = false; };
  }, [open, activeAccountId, applyStatus]);

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const view: 'form' | 'running' | 'done' =
    running ? 'running' : isFbSyncTerminal(status) && !retry ? 'done' : 'form';
  const shown = open && visible;

  useEffect(() => { if (shown) panelRef.current?.focus(); }, [shown, view]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const all = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled])'));
      const items = tabStopIndexes(all.map(el => {
        const radio = el instanceof HTMLInputElement && el.type === 'radio';
        return { isRadio: radio, checked: radio && (el as HTMLInputElement).checked, disabled: false, group: radio ? (el as HTMLInputElement).name : undefined };
      })).map(i => all[i]);
      const idx = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (idx === null) return;
      e.preventDefault();
      (idx >= 0 ? items[idx] : panelRef.current).focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, close]);

  const handleStart = async () => {
    if (!activeAccountId || busy) return;
    const range = resolveSyncRange(preset, fromDate, toDate, Date.now());
    if ('error' in range) { setFormError(range.error); return; }
    setFormError('');
    setBusy(true);
    try {
      const res = await ipc.fbHistorySync?.start(activeAccountId, range);
      if (res?.success) {
        setRetry(false);
        if (res.status) applyStatus(res.status, false);
      } else {
        setFormError(res?.error || 'Không thể bắt đầu đồng bộ');
      }
    } catch (e: any) {
      setFormError(e?.message || 'Không thể bắt đầu đồng bộ');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!activeAccountId || cancelling) return;
    setCancelling(true);
    setActionError('');
    try {
      const res = await ipc.fbHistorySync?.cancel(activeAccountId);
      if (!res?.success) setActionError(res?.error || 'Không thể dừng đồng bộ');
    } catch (e: any) {
      setActionError(e?.message || 'Không thể dừng đồng bộ');
    } finally { setCancelling(false); }
  };

  if (!visible) return null;

  const toneClass =
    status?.stage === 'completed' ? 'bg-green-500/10 text-green-400'
      : status?.stage === 'failed' ? 'bg-red-500/10 text-red-400'
        : 'bg-gray-700 text-gray-200';
  const progress = status ? fbSyncProgress(status) : 0;
  const title = running ? `${FB_SYNC_TITLE} — đang chạy nền` : FB_SYNC_TITLE;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { setRetry(false); setOpen(true); }}
        className={`app-toolbar-btn ${running ? 'text-blue-400' : ''}`}
        title={title}
        aria-label={title}
      >
        <DownloadIcon className="w-3.5 h-3.5" />
      </button>

      {shown && (
        <div
          className="fixed inset-0 mac-overlay flex items-center justify-center z-[10001]"
          onClick={e => { if (e.target === e.currentTarget) close(); }}
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-sync-title"
            className="mac-alert w-full max-w-[440px] mx-4 max-h-[90vh] overflow-y-auto overflow-x-hidden focus:outline-none app-no-drag"
          >
            <div className="px-5 pt-5 pb-3">
              <h3 id="fb-sync-title" className="text-gray-100 font-bold text-sm leading-snug">{FB_SYNC_TITLE}</h3>
            </div>

            <div className="px-5 pb-4 space-y-3 text-sm break-words" aria-live="polite">
              {view === 'form' && (
                <>
                  <p className="text-gray-400 leading-relaxed">
                    MaiHub tải lịch sử tin nhắn Messenger từ Facebook về máy và ghép vào các hội thoại hiện có. Tin đã có sẽ không bị trùng.
                  </p>
                  <div role="radiogroup" aria-label="Khoảng thời gian" className="space-y-2">
                    {PRESETS.map(p => (
                      <label key={p.value} className="flex items-center gap-2 text-gray-100 cursor-pointer">
                        <input
                          type="radio"
                          name="fb-sync-range"
                          value={p.value}
                          checked={preset === p.value}
                          onChange={() => { setPreset(p.value); setFormError(''); }}
                          className="focus-visible:ring-[3px] focus-visible:ring-blue-500/35 focus:outline-none"
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                  {preset === 'custom' && (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <label className="flex-1 min-w-0 text-gray-400 text-xs">
                        Từ ngày
                        <DateInputVN value={fromDate} onChange={e => setFromDate(e.target.value)} className="input-field mt-1" />
                      </label>
                      <label className="flex-1 min-w-0 text-gray-400 text-xs">
                        Đến ngày
                        <DateInputVN value={toDate} onChange={e => setToDate(e.target.value)} className="input-field mt-1" />
                      </label>
                    </div>
                  )}
                  {preset === 'all' && <p className="text-orange-400 text-xs">{FB_SYNC_ALL_WARNING}</p>}
                  {formError && <p role="alert" className="text-red-400 text-xs">{formError}</p>}
                </>
              )}

              {view === 'running' && status && (
                <>
                  <div className={`rounded-lg px-3 py-2 ${toneClass}`}>{status.message}</div>
                  {status.currentThreadName && <p className="text-gray-400 text-xs truncate">{status.currentThreadName}</p>}
                  {isFbSyncWaiting(status, Date.now()) && <p className="text-orange-400 text-xs">{FB_SYNC_WAITING}</p>}
                  <div
                    role="progressbar"
                    aria-label="Tiến độ đồng bộ"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    className="h-2 rounded-full bg-gray-700 overflow-hidden"
                  >
                    <div className="h-full bg-blue-600 transition-[width] duration-150" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-gray-400 text-xs">{status.messagesSaved} tin mới</p>
                  {actionError && <p role="alert" className="text-red-400 text-xs">{actionError}</p>}
                </>
              )}

              {view === 'done' && status && (
                <>
                  <div className={`rounded-lg px-3 py-2 ${toneClass}`}>
                    {status.stage === 'failed' ? (status.error || status.message) : status.message}
                  </div>
                  {fbSyncNotes(status).length > 0 && (
                    <ul className="list-disc pl-5 text-gray-400 text-xs space-y-0.5">
                      {fbSyncNotes(status).map(n => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5">
              {view === 'running' ? (
                <>
                  <button type="button" onClick={close} className="btn-secondary">Ẩn</button>
                  <button type="button" onClick={handleCancel} disabled={cancelling} className="btn-secondary disabled:opacity-50">Dừng đồng bộ</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={close} className="btn-secondary">Đóng</button>
                  {view === 'done' ? (
                    <button type="button" onClick={() => { setRetry(true); setFormError(''); }} className="btn-primary">Đồng bộ lại</button>
                  ) : (
                    <button type="button" onClick={handleStart} disabled={busy} className="btn-primary">Bắt đầu đồng bộ</button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
