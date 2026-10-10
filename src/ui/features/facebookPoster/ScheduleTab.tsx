import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { describeRecurrence } from '../../../services/facebookPoster/scheduleTime';
import ScheduleDialog, { formatShort } from './ScheduleDialog';
import PostPreview from './PostPreview';
import { STATUS_LABEL } from './HistoryTab';
import { buildMovePatch, canDragSchedule, getCalendarDays, getScheduleOccurrences, getUnscheduledDrafts, matchesChannels, type CalendarView, type ScheduleOccurrence } from './calendarModel';
import type { FbPosterScheduleView } from '../../../models/facebookPoster';

interface Props {
  selectedChannels: string[] | null;
  profileNames: Map<string, string>;
  onCompose: (at?: number) => void;
  onOpenHistory: () => void;
  onEditDraft: (id: string) => void;
}
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const dateLabel = (date: Date) => date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
const clock = (at: number) => new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
const LABELS: Record<string, string> = { draft: 'Nháp', scheduled: 'Đã hẹn', paused: 'Tạm dừng', queued: 'Đang chờ', ...Object.fromEntries(Object.entries(STATUS_LABEL).map(([key, value]) => [key, value.label])) };

export default function ScheduleTab({ selectedChannels, profileNames, onCompose, onOpenHistory, onEditDraft }: Props) {
  const showNotification = useAppStore(s => s.showNotification);
  const [schedules, setSchedules] = useState<FbPosterScheduleView[]>([]);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<FbPosterScheduleView | null>(null);
  const [approving, setApproving] = useState<FbPosterScheduleView | null>(null);
  const [detail, setDetail] = useState<ScheduleOccurrence | null>(null);
  const [view, setView] = useState<CalendarView>('week');
  const [anchor, setAnchor] = useState(new Date());
  const [listView, setListView] = useState(false);
  const [stateFilter, setStateFilter] = useState('all');
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const [operationError, setOperationError] = useState('');
  const dragging = useRef<ScheduleOccurrence | null>(null);
  const detailRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await ipc.facebookPoster?.scheduleList();
      if (!res?.success) throw new Error(res?.error || 'Không tải được danh sách lịch');
      setSchedules(res.schedules || []);
      setDetail(previous => {
        if (!previous) return null;
        const schedule = res.schedules?.find(item => item.id === previous.schedule.id);
        if (!schedule) return null;
        return getScheduleOccurrences([schedule], getCalendarDays(new Date(previous.at), 'day'), null, Date.now(), new Set(res.queuedIds || []))
          .find(entry => entry.at === previous.at) || null;
      });
      setQueued(new Set(res.queuedIds || []));
      setError('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Không tải được danh sách lịch'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const offChanged = ipc.on?.('facebookPoster:schedulesChanged', () => { load(); });
    const offFinished = ipc.on?.('facebookPoster:runFinished', () => { load(); });
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { offChanged?.(); offFinished?.(); window.clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    const dialog = detailRef.current;
    if (detail && dialog && !dialog.open) dialog.showModal();
  }, [detail]);
  useEffect(() => {
    if (!loading && !listView && view !== 'month' && scrollRef.current) scrollRef.current.scrollTop = 8 * 84;
  }, [loading, listView, view]);

  const days = useMemo(() => getCalendarDays(anchor, view), [anchor, view]);
  const entries = useMemo(() => getScheduleOccurrences(schedules, days, selectedChannels, now, queued), [schedules, days, selectedChannels, now, queued]);
  const status = (entry: ScheduleOccurrence) => entry.schedule.draft ? 'draft' : entry.historical ? entry.schedule.lastRun?.status || 'done'
    : !entry.schedule.enabled ? 'paused' : entry.queued ? 'queued' : 'scheduled';
  const shownEntries = entries.filter(entry => stateFilter === 'all' || status(entry) === stateFilter);
  const entriesBySlot = new Map<string, ScheduleOccurrence[]>();
  for (const entry of shownEntries) {
    const date = new Date(entry.at);
    const key = `${dayKey(date)}:${view === 'month' ? '' : date.getHours()}`;
    entriesBySlot.set(key, [...(entriesBySlot.get(key) || []), entry]);
  }

  const toggle = async (schedule: FbPosterScheduleView) => {
    setSaving(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.scheduleUpdate({ id: schedule.id, enabled: !schedule.enabled });
      if (!res?.success) throw new Error(res?.error || 'Không cập nhật được lịch');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không cập nhật được lịch';
      setOperationError(message);
      showNotification(message, 'error');
    }
    finally { setSaving(false); load(); }
  };
  const remove = async (schedule: FbPosterScheduleView) => {
    const ok = await showConfirm({ title: 'Xoá lịch đăng?', message: `Lịch "${schedule.name}" sẽ bị xoá cùng nội dung đã lưu.`, confirmText: 'Xoá', variant: 'danger' });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await ipc.facebookPoster?.scheduleDelete(schedule.id);
      if (!res?.success) throw new Error(res?.error || 'Không xoá được lịch');
      setDetail(null);
    } catch (error) { showNotification(error instanceof Error ? error.message : 'Không xoá được lịch', 'error'); }
    finally { setSaving(false); load(); }
  };
  const approveNow = async (schedule: FbPosterScheduleView) => {
    const ok = await showConfirm({ title: 'Đăng ngay bản nháp?', message: `Bài "${schedule.name}" sẽ được đăng ngay khi không còn việc nào đang chạy.`, confirmText: 'Đăng ngay' });
    if (!ok) return;
    setSaving(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.draftApprove({ id: schedule.id, when: 'now' });
      if (!res?.success) throw new Error(res?.error || 'Không duyệt được nháp');
      showNotification('Đã duyệt — bài sẽ được đăng ngay', 'success');
      closeDetail();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Không duyệt được nháp');
    } finally {
      setSaving(false);
      load();
    }
  };
  const closeDetail = () => { detailRef.current?.close(); setDetail(null); };
  const move = async (date: Date, hour?: number) => {
    const entry = dragging.current;
    dragging.current = null;
    if (!entry || saving || entry.historical || entry.queued || !canDragSchedule(entry.schedule)) return;
    const target = new Date(date);
    const original = new Date(entry.at);
    target.setHours(hour ?? original.getHours(), original.getMinutes(), 0, 0);
    if (target.getTime() < Date.now() + 60_000) { showNotification('Giờ đăng phải sau thời điểm hiện tại ít nhất 1 phút', 'error'); return; }
    if (target.getTime() === entry.at) return;
    setSaving(true);
    try {
      const res = await ipc.facebookPoster?.scheduleUpdate(buildMovePatch(entry.schedule, target.getTime()));
      if (!res?.success) throw new Error(res?.error || 'Không dời được lịch');
      showNotification('Đã dời lịch đăng', 'success');
    } catch (error) { showNotification(error instanceof Error ? error.message : 'Không dời được lịch', 'error'); }
    finally { setSaving(false); load(); }
  };
  const navigate = (step: number) => {
    const date = new Date(anchor);
    if (view === 'month') { date.setDate(1); date.setMonth(date.getMonth() + step); }
    else date.setDate(date.getDate() + step * (view === 'week' ? 7 : 1));
    setAnchor(date);
  };
  const slot = (date: Date, hour?: number) => {
    const key = `${dayKey(date)}:${hour ?? ''}`;
    const currentHour = hour !== undefined && dayKey(date) === dayKey(new Date(now)) && hour === new Date(now).getHours();
    const draftAt = new Date(date);
    draftAt.setHours(hour ?? 9, 0, 0, 0);
    const future = draftAt.getTime() >= now + 60_000;
    return <div key={key} className={`poster-calendar-slot ${hour === undefined ? 'is-month' : ''} ${date.getMonth() !== anchor.getMonth() && view === 'month' ? 'is-outside' : ''}`} data-hour={hour}
      onDragOver={event => { if (dragging.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={event => { event.preventDefault(); void move(date, hour); }}>
      {hour === undefined && <span className={`poster-month-date ${dayKey(date) === dayKey(new Date(now)) ? 'is-today' : ''}`}>{date.getDate()}</span>}
      <button type="button" className="poster-slot-add" aria-label={`Soạn bài lúc ${hour ?? 9}:00 ${dateLabel(date)}`} disabled={!future || saving} onClick={() => onCompose(draftAt.getTime())}><span aria-hidden="true">＋</span></button>
      <div className="poster-slot-posts">
        {(entriesBySlot.get(key) || []).map(entry => {
          const profiles = (entry.schedule.params.profiles || []) as { profileId: string; targets: string[] }[];
          const state = status(entry);
          const draggable = !saving && !entry.historical && canDragSchedule(entry.schedule) && (entry.schedule.enabled || entry.schedule.draft) && entry.at >= now + 60_000 && !entry.queued;
          return <button key={`${entry.schedule.id}:${entry.at}`} type="button" className={`poster-calendar-post is-${state}`} draggable={draggable}
            onDragStart={event => { dragging.current = entry; event.dataTransfer.setData('text/plain', entry.schedule.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { dragging.current = null; }}
            onClick={() => { setOperationError(''); setDetail(entry); }} aria-label={`${entry.schedule.name}, ${formatShort(entry.at)}, ${LABELS[state]}`}>
            <span className="poster-post-time">{clock(entry.at)} · {entry.schedule.draft && entry.at < now ? 'Quá giờ dự kiến' : LABELS[state]}</span>
            <span className="poster-post-title">{entry.schedule.name}</span>
            <span className="poster-post-channel"><span className="poster-mini-avatar" aria-hidden="true">{(profileNames.get(profiles[0]?.profileId) || '?').slice(0, 1)}</span>
              <span className="truncate">{profileNames.get(profiles[0]?.profileId) || 'Profile đã xoá'}{profiles.length > 1 ? ` +${profiles.length - 1}` : ''}</span>
              {entry.schedule.kind === 'recurring' && <span title="Lịch lặp lại">↻</span>}
            </span>
          </button>;
        })}
      </div>
      {currentHour && <div className="poster-now-line" aria-label={`Giờ hiện tại ${clock(now)}`} style={{ top: `${new Date(now).getMinutes() / 60 * 100}%` }}><span>{clock(now)}</span></div>}
    </div>;
  };

  const visibleSchedules = schedules.filter(schedule => {
    const channelMatches = matchesChannels(schedule, selectedChannels);
    const state = status({ schedule, at: schedule.runAt ?? now, historical: schedule.kind === 'once' && !!schedule.lastRun && schedule.nextRunAt === null && !queued.has(schedule.id), queued: queued.has(schedule.id) });
    return channelMatches && (stateFilter === 'all' || stateFilter === state);
  });
  const unscheduledDrafts = getUnscheduledDrafts(schedules, selectedChannels).filter(() => stateFilter === 'all' || stateFilter === 'draft');
  return (
    <section className="poster-calendar" aria-label="Lịch đăng bài">
      <div className="poster-calendar-filters">
        <div className="poster-date-navigation"><button className="poster-icon-button" aria-label="Khoảng trước" onClick={() => navigate(-1)}>‹</button>
          <span>{view === 'month' ? anchor.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' }) : view === 'day' ? `${dateLabel(days[0])}/${days[0].getFullYear()}` : `${dateLabel(days[0])} – ${dateLabel(days[6])}/${days[6].getFullYear()}`}</span>
          <button className="poster-icon-button" aria-label="Khoảng tiếp theo" onClick={() => navigate(1)}>›</button></div>
        <button className="poster-button" onClick={() => setAnchor(new Date())}>Hôm nay</button>
        <select className="poster-input poster-state-filter" aria-label="Lọc trạng thái lịch" value={stateFilter} onChange={event => setStateFilter(event.target.value)}>
          <option value="all">Tất cả trạng thái</option>{['draft', 'scheduled', 'queued', 'paused', 'done', 'failed', 'missed', 'cancelled', 'running'].map(state => <option key={state} value={state}>{LABELS[state]}</option>)}
        </select>
        <div className="poster-view-switch" aria-label="Chế độ lịch">{(['day', 'week', 'month'] as const).map(value => <button key={value} aria-pressed={!listView && view === value} onClick={() => { setView(value); setListView(false); }}>{value === 'day' ? 'Ngày' : value === 'week' ? 'Tuần' : 'Tháng'}</button>)}</div>
        <button className="poster-button" aria-pressed={listView} onClick={() => setListView(value => !value)}>Danh sách</button>
      </div>
      {loading ? <div className="flex justify-center py-10" role="status" aria-label="Đang tải lịch"><Spinner size={5} /></div>
        : error ? <div role="alert" className="poster-empty"><p>{error}</p><button className="poster-button mt-3" onClick={() => { setLoading(true); load(); }}>Thử lại</button></div>
        : listView ? <div className="poster-schedule-list">
          {visibleSchedules.length === 0 && <p className="poster-empty">Chưa có lịch đăng phù hợp. Bấm Soạn bài để hẹn giờ.</p>}
          {visibleSchedules.map(schedule => <article key={schedule.id} className="poster-schedule-row">
            <div className="min-w-0 flex-1"><h3 className="font-semibold truncate" title={schedule.name}>{schedule.name}</h3><p className="poster-muted text-xs mt-1">{schedule.draft ? `Nháp · ${schedule.runAt ? 'Dự kiến ' + formatShort(schedule.runAt) : 'Chưa xếp lịch'}` : <>{schedule.kind === 'once' ? 'Một lần' : describeRecurrence(schedule.days, schedule.time)} · {schedule.nextRunAt ? formatShort(schedule.nextRunAt) : 'Không có lần chạy tới'}{queued.has(schedule.id) ? ' · Đang chờ' : ''}</>}</p>
              {schedule.lastRun && <button onClick={onOpenHistory} className="poster-link text-xs mt-1">Lần gần nhất: {STATUS_LABEL[schedule.lastRun.status]?.label} · {formatShort(schedule.lastRun.startedAt)}</button>}</div>
            {schedule.draft ? <div className="flex flex-wrap gap-2 items-center">
              <button className="poster-button" onClick={() => onEditDraft(schedule.id)}>Sửa</button>
              <button className="poster-primary" disabled={saving} onClick={() => setApproving(schedule)}>Duyệt & hẹn giờ</button>
              <button className="poster-button text-red-400" disabled={saving} onClick={() => remove(schedule)}>Xoá</button>
            </div> : <div className="flex flex-wrap gap-2 items-center"><button className="poster-button" aria-label={`${schedule.enabled ? 'Tạm dừng' : 'Bật lại'} lịch ${schedule.name}`} disabled={saving} onClick={() => toggle(schedule)}>{schedule.enabled ? 'Tạm dừng' : 'Bật lại'}</button>
              <button className="poster-button" onClick={() => setEditing(schedule)}>Sửa giờ</button><button className="poster-button text-red-400" disabled={saving} onClick={() => remove(schedule)}>Xoá</button></div>}
          </article>)}
        </div> : <>
          {unscheduledDrafts.length > 0 && <div className="poster-draft-strip" aria-label="Nháp chưa xếp lịch">
            <span className="poster-muted text-xs">Nháp chưa xếp lịch</span>
            {unscheduledDrafts.map(s => <button key={s.id} type="button" className="poster-calendar-post is-draft"
              onClick={() => { setOperationError(''); setDetail({ schedule: s, at: now, historical: false }); }} aria-label={`${s.name}, nháp chưa xếp lịch`}>
              <span className="poster-post-time">Nháp</span><span className="poster-post-title">{s.name}</span>
            </button>)}
          </div>}
          <div ref={scrollRef} className="poster-calendar-scroll" tabIndex={0} aria-label="Lưới lịch có thể cuộn">
            <div className={`poster-calendar-grid is-${view}`}>
              {view !== 'month' && <div className="poster-day-header poster-muted">Giờ</div>}
              {(view === 'month' ? days.slice(0, 7) : days).map(date => <div key={dayKey(date)} className={`poster-day-header ${dayKey(date) === dayKey(new Date(now)) ? 'is-today' : ''}`}>
                <span className="poster-muted">{date.toLocaleDateString('vi-VN', { weekday: 'short' })}</span>{view !== 'month' && <strong>{dateLabel(date)}</strong>}
              </div>)}
              {view === 'month' ? days.map(date => slot(date)) : Array.from({ length: 24 }, (_, hour) => <React.Fragment key={hour}><div className="poster-hour-label">{String(hour).padStart(2, '0')}:00</div>{days.map(date => slot(date, hour))}</React.Fragment>)}
            </div>
          </div>
          <div className="poster-calendar-footer"><span>{shownEntries.length ? `${shownEntries.length} bài trong khoảng đang xem` : 'Chưa có bài trong khoảng đang xem. Bấm ＋ để soạn bài.'}</span><span>Giờ địa phương · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
        </>}
      {saving && <p className="poster-muted text-xs px-5 py-2" role="status">Đang cập nhật lịch…</p>}
      {editing && <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} onSaved={load} />}
      {approving && <ScheduleDialog approveDraftId={approving.id} defaultName={approving.name} initialRunAt={approving.runAt ?? undefined} onClose={() => setApproving(null)} onSaved={load} />}
      {detail && <dialog ref={detailRef} className="poster-dialog poster-detail-dialog" aria-labelledby="poster-detail-title" onCancel={event => { event.preventDefault(); closeDetail(); }}>
        <header className="poster-dialog-header"><h2 id="poster-detail-title" className="break-words min-w-0">{detail.schedule.name}</h2><button className="poster-icon-button shrink-0" aria-label="Đóng chi tiết bài" onClick={closeDetail}>✕</button></header>
        <div className="p-5 space-y-4"><p className="poster-muted">{detail.schedule.draft && detail.schedule.runAt === null ? 'Chưa xếp lịch' : formatShort(detail.at)} · {LABELS[status(detail)]}</p>
          {(operationError || error) && <p role="alert" className="text-red-400 text-sm break-words">{operationError || error}</p>}
          <PostPreview text={String(detail.schedule.params.text || '')} comment={String(detail.schedule.params.comment || '')} mediaPaths={[]} mode={detail.schedule.params.mode === 'page' ? 'page' : 'group'} names={((detail.schedule.params.profiles || []) as { profileId: string }[]).map(profile => profileNames.get(profile.profileId) || profile.profileId)} />
          {Array.isArray(detail.schedule.params.mediaPaths) && detail.schedule.params.mediaPaths.length > 0 && <p className="poster-muted text-xs break-words">Tệp đính kèm đã lưu: {detail.schedule.params.mediaPaths.join(', ')}</p>}
          {detail.schedule.draft ? <div className="flex flex-wrap gap-2">
            <button className="poster-button" onClick={() => { const id = detail.schedule.id; closeDetail(); onEditDraft(id); }}>Sửa</button>
            <button className="poster-primary" disabled={saving} onClick={() => { setApproving(detail.schedule); closeDetail(); }}>Duyệt & hẹn giờ</button>
            <button className="poster-button" disabled={saving} onClick={() => void approveNow(detail.schedule)}>Đăng ngay</button>
            <button className="poster-button text-red-400" disabled={saving} onClick={() => { const schedule = detail.schedule; closeDetail(); void remove(schedule); }}>Xoá</button>
          </div> : <div className="flex flex-wrap gap-2"><button className="poster-button" disabled={saving} onClick={() => toggle(detail.schedule)}>{detail.schedule.enabled ? 'Tạm dừng lịch' : 'Bật lịch'}</button>
            <button className="poster-primary" onClick={() => { setEditing(detail.schedule); closeDetail(); }}>Sửa giờ</button><button className="poster-button" onClick={() => { closeDetail(); onOpenHistory(); }}>Lịch sử</button>
            <button className="poster-button text-red-400" disabled={saving} onClick={() => { const schedule = detail.schedule; closeDetail(); void remove(schedule); }}>Xoá lịch</button></div>}
        </div>
      </dialog>}
    </section>
  );
}
