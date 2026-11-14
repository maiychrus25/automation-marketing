import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { DataAccessor } from '@/lib/data/DataAccessor';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import { getMessageCacheKey, useChatStore } from '@/store/chatStore';
import { isZalo } from '@/lib/channelHelper';
import DateInputVN from '@/components/common/DateInputVN';
import { SmartphoneIcon } from '@/components/common/icons';
import type { MobileSyncStatus } from '../../../services/zalo/mobileSync/types';
import {
  isMobileSyncRunning, isMobileSyncTerminal, mobileSyncNotes, mobileSyncStep,
  mergeThreadMessages, nextFocusIndex, reduceMobileSyncStatus, refreshPlan, resolveSyncRange, tabStopIndexes, terminalEffects, type SyncPreset,
} from '../../lib/chat/mobileSyncView';

const TITLE = 'Đồng bộ tin nhắn từ điện thoại';
const STEPS = [
  'Xác nhận trên điện thoại',
  'Điện thoại chuẩn bị dữ liệu',
  'Tải dữ liệu về máy',
  'Giải mã',
  'Ghép tin nhắn vào hội thoại',
];
const PRESETS: { value: SyncPreset; label: string }[] = [
  { value: 'week', label: '1 tuần gần nhất' },
  { value: 'custom', label: 'Chọn ngày' },
  { value: 'all', label: 'Toàn bộ' },
];

// Làm mới danh sách hội thoại của tài khoản vừa xong; hội thoại đang mở chỉ được gộp thêm tin mới (không thay thế).
// Giới hạn: tin nhập cũ hơn cửa sổ đã tải chỉ hiện khi cuộn lên hoặc mở lại hội thoại.
async function refreshChats(zaloId: string) {
  const chat = useChatStore.getState();
  const plan = refreshPlan(zaloId, useAccountStore.getState().activeAccountId, chat.activeThreadId);
  if (plan.list) {
    try {
      const res = await ipc.db?.getContacts(zaloId);
      const contacts = res?.contacts ?? res ?? [];
      if (contacts.length > 0) useChatStore.getState().setContacts(zaloId, contacts);
    } catch {}
  }
  if (!plan.thread) return;
  try {
    const { activeThreadId, activeTopicId } = chat;
    if (!activeThreadId) return;
    const key = getMessageCacheKey(zaloId, activeThreadId, activeTopicId);
    const loaded = useChatStore.getState().messages[key] || [];
    const limit = Math.min(5000, Math.max(50, loaded.length + 50));
    const dbRes = await DataAccessor.getMessages({ zaloId, threadId: activeThreadId, limit, offset: 0, topicId: activeTopicId });
    const fetched = dbRes?.messages || dbRes?.items || [];
    // Đọc lại store sau khi chờ DB để không ghi đè tin vừa đến.
    const current = useChatStore.getState().messages[key] || [];
    const merged = mergeThreadMessages(current, [...fetched].reverse());
    if (merged !== current) useChatStore.getState().setMessages(zaloId, activeThreadId, merged, activeTopicId);
  } catch {}
}

export default function MobileSyncButton() {
  const showNotification = useAppStore(s => s.showNotification);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const channel = useAccountStore(s => s.accounts.find(a => a.zalo_id === activeAccountId)?.channel);

  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, MobileSyncStatus>>({});
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
  const handledRef = useRef<Record<string, string | null>>({});
  const activeRef = useRef<string | null>(null);
  openRef.current = open;
  activeRef.current = activeAccountId;

  const status = activeAccountId ? statuses[activeAccountId] : undefined;
  const running = isMobileSyncRunning(status?.stage);

  // Một nơi xử lý mọi trạng thái đến; fromEvent=false (getStatus) chỉ đánh dấu đã xử lý, không thông báo lại.
  const applyStatus = useCallback((next: MobileSyncStatus, fromEvent: boolean) => {
    setStatuses(prev => reduceMobileSyncStatus(prev, next));
    const fx = terminalEffects(next, { open: openRef.current, activeAccountId: activeRef.current }, handledRef.current[next.zaloId] ?? null);
    if (fx.key) handledRef.current[next.zaloId] = fx.key;
    if (fx.notify && fromEvent) {
      if (next.stage === 'completed') showNotification(next.message || 'Đồng bộ từ điện thoại hoàn tất', 'success');
      else showNotification(next.error || next.message || 'Đồng bộ từ điện thoại thất bại', 'error');
    }
    if (fx.refresh) void refreshChats(next.zaloId);
  }, [showNotification]);

  useEffect(() => {
    const unsub = ipc.on?.('event:mobileSync', (data: MobileSyncStatus) => {
      if (data?.zaloId) applyStatus(data, true);
    });
    return () => { unsub?.(); };
  }, [applyStatus]);

  const visible = !!activeAccountId && isZalo(channel);
  useEffect(() => {
    setBusy(false); setCancelling(false); setFormError(''); setActionError(''); setRetry(false);
  }, [activeAccountId]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);

  // Mở hộp thoại: lấy trạng thái hiện tại của tài khoản đang chọn.
  useEffect(() => {
    if (!open || !activeAccountId) return;
    let alive = true;
    ipc.mobileSync?.getStatus(activeAccountId).then(res => {
      if (alive && res?.success && res.status) applyStatus(res.status, false);
    }).catch(() => {});
    return () => { alive = false; };
  }, [open, activeAccountId, applyStatus]);

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  const view: 'form' | 'running' | 'done' =
    running ? 'running' : status && isMobileSyncTerminal(status.stage) && !retry ? 'done' : 'form';
  const shown = open && visible;

  // Đổi màn hình (nút đang focus bị gỡ) thì đưa focus về hộp thoại.
  useEffect(() => { if (shown) panelRef.current?.focus(); }, [shown, view]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const all = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled])'));
      // Trình duyệt chỉ dừng Tab ở radio đang chọn của mỗi nhóm.
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
      const res = await ipc.mobileSync?.start(activeAccountId, range);
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
      const res = await ipc.mobileSync?.cancel(activeAccountId);
      if (!res?.success) setActionError(res?.error || 'Không thể huỷ đồng bộ');
    } catch (e: any) {
      setActionError(e?.message || 'Không thể huỷ đồng bộ');
    } finally { setCancelling(false); }
  };

  const step = mobileSyncStep(status?.stage);
  const notes = useMemo(() => mobileSyncNotes({ ...status?.stats }), [status?.stats]);

  if (!visible) return null;

  const progress = Math.max(0, Math.min(100, Math.round(status?.progress ?? 0)));
  const toneClass =
    status?.stage === 'completed' ? 'bg-green-500/10 text-green-400'
      : status?.stage === 'failed' ? 'bg-red-500/10 text-red-400'
        : status?.stage === 'mobile_idle' ? 'bg-orange-500/10 text-orange-400'
          : 'bg-gray-700 text-gray-200';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => { setRetry(false); setOpen(true); }}
        className={`app-toolbar-btn ${running ? 'text-blue-400' : ''}`}
        title={running ? `${TITLE} — đang chạy nền` : TITLE}
        aria-label={running ? `${TITLE} — đang chạy nền` : TITLE}
      >
        <SmartphoneIcon className="w-3.5 h-3.5" />
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
            aria-labelledby="mobile-sync-title"
            className="mac-alert w-full max-w-[440px] mx-4 max-h-[90vh] overflow-y-auto overflow-x-hidden focus:outline-none app-no-drag"
          >
            <div className="px-5 pt-5 pb-3">
              <h3 id="mobile-sync-title" className="text-gray-100 font-bold text-sm leading-snug">{TITLE}</h3>
            </div>

            <div className="px-5 pb-4 space-y-3 text-sm break-words" aria-live="polite">
              {view === 'form' && (
                <>
                  <p className="text-gray-400 leading-relaxed">
                    MaiHub lấy lịch sử tin nhắn Zalo từ điện thoại của bạn (giống Zalo trên máy tính) rồi ghép vào các hội thoại hiện có. Tin đã có sẽ không bị trùng.
                  </p>
                  <div role="radiogroup" aria-label="Khoảng thời gian" className="space-y-2">
                    {PRESETS.map(p => (
                      <label key={p.value} className="flex items-center gap-2 text-gray-100 cursor-pointer">
                        <input
                          type="radio"
                          name="mobile-sync-range"
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
                  {preset === 'all' && (
                    <p className="text-orange-400 text-xs">Đồng bộ toàn bộ có thể mất nhiều thời gian.</p>
                  )}
                  {formError && <p role="alert" className="text-red-400 text-xs">{formError}</p>}
                </>
              )}

              {view === 'running' && status && (
                <>
                  <ol className="space-y-1.5">
                    {STEPS.map((label, i) => (
                      <li
                        key={label}
                        aria-current={i === step ? 'step' : undefined}
                        className={`flex items-center gap-2 ${i === step ? 'text-gray-100 font-semibold' : i < step ? 'text-green-400' : 'text-gray-500'}`}
                      >
                        <span className="w-4 text-center flex-shrink-0">{i < step ? '✓' : i === step ? '●' : '○'}</span>
                        <span className="min-w-0">{label}</span>
                      </li>
                    ))}
                  </ol>
                  <div className={`rounded-lg px-3 py-2 ${toneClass}`}>{status.message}</div>
                  {actionError && <p role="alert" className="text-red-400 text-xs">{actionError}</p>}
                  {step >= 2 && (
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
                  )}
                </>
              )}

              {view === 'done' && status && (
                <>
                  <div className={`rounded-lg px-3 py-2 ${toneClass}`}>
                    {status.stage === 'failed' ? (status.error || status.message) : status.message}
                  </div>
                  {status.stage === 'completed' && status.stats && (
                    <dl className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-gray-700 px-3 py-2">
                        <dt className="text-gray-400 text-xs">Tin nhắn mới</dt>
                        <dd className="text-gray-100 font-semibold">{status.stats.messagesImported}</dd>
                      </div>
                      <div className="rounded-lg bg-gray-700 px-3 py-2">
                        <dt className="text-gray-400 text-xs">Hội thoại</dt>
                        <dd className="text-gray-100 font-semibold">{status.stats.conversationsResolved} / {status.stats.conversations}</dd>
                      </div>
                    </dl>
                  )}
                  {status.stage === 'completed' && notes.length > 0 && (
                    <ul className="list-disc pl-5 text-gray-400 text-xs space-y-0.5">
                      {notes.map(n => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5">
              {view === 'running' ? (
                <>
                  <button type="button" onClick={close} className="btn-secondary">Ẩn</button>
                  <button type="button" onClick={handleCancel} disabled={cancelling} className="btn-secondary disabled:opacity-50">Huỷ đồng bộ</button>
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
