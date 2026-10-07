import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { describeRecurrence } from '../../../services/facebookPoster/scheduleTime';
import ScheduleDialog, { formatShort } from './ScheduleDialog';
import { STATUS_LABEL } from './HistoryTab';
import type { FbPosterScheduleView } from '../../../models/facebookPoster';

export default function ScheduleTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [schedules, setSchedules] = useState<FbPosterScheduleView[]>([]);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<FbPosterScheduleView | null>(null);

  const load = useCallback(() => {
    return ipc.facebookPoster?.scheduleList().then((res) => {
      if (res?.success) { setSchedules(res.schedules || []); setQueued(new Set(res.queuedIds || [])); setError(''); }
      else setError(res?.error || 'Không tải được danh sách lịch');
    }).catch(() => setError('Không tải được danh sách lịch')).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const offChanged = ipc.on?.('facebookPoster:schedulesChanged', () => { load(); });
    const offFinished = ipc.on?.('facebookPoster:runFinished', () => { load(); });
    return () => { offChanged?.(); offFinished?.(); };
  }, [load]);

  const toggle = async (s: FbPosterScheduleView) => {
    const res = await ipc.facebookPoster?.scheduleUpdate({ id: s.id, enabled: !s.enabled });
    if (!res?.success) showNotification(res?.error || 'Không cập nhật được lịch', 'error');
    load();
  };

  const remove = async (s: FbPosterScheduleView) => {
    const ok = await showConfirm({ title: 'Xoá lịch đăng?', message: `Lịch "${s.name}" sẽ bị xoá cùng nội dung đã lưu.`, confirmText: 'Xoá', variant: 'danger' });
    if (!ok) return;
    const res = await ipc.facebookPoster?.scheduleDelete(s.id);
    if (!res?.success) showNotification(res?.error || 'Không xoá được lịch', 'error');
    load();
  };

  if (loading) return <div className="flex justify-center py-10"><Spinner size={5} /></div>;
  if (error) return <p role="alert" className="text-sm text-red-400 text-center py-10">{error}</p>;
  if (schedules.length === 0) return <p className="text-sm text-gray-400 text-center py-10">Chưa có lịch đăng nào. Soạn bài ở tab Đăng bài rồi bấm Lên lịch.</p>;

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400">
            <tr>
              <th className="py-2 pr-3 font-medium">Tên</th>
              <th className="py-2 pr-3 font-medium">Kiểu</th>
              <th className="py-2 pr-3 font-medium">Lần chạy tới</th>
              <th className="py-2 pr-3 font-medium">Lần gần nhất</th>
              <th className="py-2 pr-3 font-medium">Trạng thái</th>
              <th className="py-2 font-medium"><span className="sr-only">Thao tác</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {schedules.map((s) => {
              const chip = s.lastRun ? (STATUS_LABEL[s.lastRun.status] || { label: s.lastRun.status, cls: 'text-gray-400' }) : null;
              return (
                <tr key={s.id} className="align-top">
                  <td className="py-2 pr-3 text-gray-200 max-w-[14rem] truncate" title={s.name}>{s.name}</td>
                  <td className="py-2 pr-3 text-gray-300 whitespace-nowrap">{s.kind === 'once' ? 'Một lần' : describeRecurrence(s.days, s.time)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-gray-300">
                    {s.nextRunAt ? formatShort(s.nextRunAt) : '—'}
                    {queued.has(s.id) && <span className="ml-2 px-1.5 py-0.5 rounded text-xs bg-blue-600/20 text-blue-400">Đang chờ</span>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {s.lastRun && chip ? <><span className={`text-xs ${chip.cls}`}>{chip.label}</span> <span className="text-xs text-gray-400">{formatShort(s.lastRun.startedAt)}</span></> : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <button type="button" role="switch" aria-checked={s.enabled} aria-label={`${s.enabled ? 'Tạm dừng' : 'Bật'} lịch ${s.name}`} onClick={() => toggle(s)}
                      className="inline-flex items-center gap-2 text-xs text-gray-300 focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                      <span className={`relative inline-block w-9 h-5 rounded-full ${s.enabled ? 'bg-blue-600' : 'bg-gray-600'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-4' : ''}`} />
                      </span>
                      {s.enabled ? 'Bật' : 'Tạm dừng'}
                    </button>
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setEditing(s)} className="px-2.5 py-1 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 focus-visible:ring-2 focus-visible:ring-blue-500">Sửa giờ</button>
                      <button type="button" onClick={() => remove(s)} className="px-2.5 py-1 rounded-lg text-xs border border-gray-600 text-red-400 hover:border-red-400 focus-visible:ring-2 focus-visible:ring-blue-500">Xoá</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <ScheduleDialog schedule={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
