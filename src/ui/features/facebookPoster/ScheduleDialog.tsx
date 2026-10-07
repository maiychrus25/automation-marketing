import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { computeNextRun } from '../../../services/facebookPoster/scheduleTime';
import type { FbPosterScheduleView } from '../../../models/facebookPoster';

// Thứ tự hiển thị T2..T7, CN; giá trị theo getDay().
const DAYS: { value: number; label: string }[] = [
  { value: 1, label: 'T2' }, { value: 2, label: 'T3' }, { value: 3, label: 'T4' }, { value: 4, label: 'T5' },
  { value: 5, label: 'T6' }, { value: 6, label: 'T7' }, { value: 0, label: 'CN' },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** datetime-local value (local time) from epoch ms. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const formatShort = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
};
const formatFull = (ms: number) => `${formatShort(ms)}/${new Date(ms).getFullYear()}`;

interface Props {
  onClose: () => void;
  /** Create mode: builds the post params and the default name placeholder. */
  buildParams?: () => Record<string, unknown>;
  defaultName?: string;
  /** Edit mode ("Sửa giờ"): only name and timing of this schedule's own kind are editable. */
  schedule?: FbPosterScheduleView;
  onSaved?: () => void;
}

export default function ScheduleDialog({ onClose, buildParams, defaultName = '', schedule, onSaved }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const edit = !!schedule;
  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<'once' | 'recurring'>(schedule?.kind ?? 'once');
  const [runAtInput, setRunAtInput] = useState(schedule?.runAt ? toLocalInput(schedule.runAt) : '');
  const [days, setDays] = useState<number[]>(schedule?.days ?? [1, 2, 3, 4, 5]);
  const [time, setTime] = useState(schedule?.time || '08:00');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runAt = runAtInput ? new Date(runAtInput).getTime() : null;
  const next = computeNextRun({ kind, runAt, days, time }, Date.now());
  const missing = kind === 'once' ? runAt === null || Number.isNaN(runAt) : days.length === 0 || !time;
  const toggleDay = (d: number) => setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      let res;
      if (schedule) {
        // Send only what changed, so a rename never recomputes the next run.
        const patch: { id: string; name?: string; runAt?: number; days?: number[]; time?: string } = { id: schedule.id };
        if (name.trim() !== schedule.name) patch.name = name.trim();
        if (kind === 'once') { if (runAt !== schedule.runAt && runAt !== null) patch.runAt = runAt; }
        else {
          if ([...days].sort().join() !== [...schedule.days].sort().join()) patch.days = days;
          if (time !== schedule.time) patch.time = time;
        }
        if (Object.keys(patch).length === 1) { onClose(); return; }
        res = await ipc.facebookPoster?.scheduleUpdate(patch);
      } else {
        res = await ipc.facebookPoster?.scheduleCreate({
          name: name.trim() || undefined, kind,
          ...(kind === 'once' ? { runAt: runAt as number } : { days, time }),
          params: buildParams ? buildParams() : {},
        });
      }
      if (!res?.success) { setError(res?.error || 'Không lưu được lịch'); return; }
      if (!edit) showNotification(`Đã lên lịch — chạy lúc ${next ? formatShort(next) : '—'}`, 'success');
      onSaved?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Không lưu được lịch');
    } finally {
      setSaving(false);
    }
  };

  const radio = (value: 'once' | 'recurring', label: string) => (
    <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
      <input type="radio" name="schedule-kind" checked={kind === value} onChange={() => setKind(value)} disabled={edit} className="focus-visible:ring-2 focus-visible:ring-blue-500" />
      {label}
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title"
        className="w-full max-w-md max-h-full overflow-y-auto rounded-xl border border-gray-700 bg-gray-800 p-4 space-y-3 min-w-0">
        <h2 id="schedule-dialog-title" className="text-base font-semibold text-white">{edit ? 'Sửa giờ' : 'Lên lịch đăng'}</h2>

        <label className="block text-xs text-gray-400">
          Tên lịch
          <input ref={nameRef} className="input-field text-sm w-full mt-1 focus-visible:ring-2 focus-visible:ring-blue-500" maxLength={100} value={name}
            placeholder={defaultName.slice(0, 40)} onChange={(e) => setName(e.target.value)} />
        </label>

        {!edit && (
          <div role="radiogroup" aria-label="Kiểu lịch" className="flex gap-4">
            {radio('once', 'Một lần')}
            {radio('recurring', 'Lặp lại')}
          </div>
        )}

        {kind === 'once' ? (
          <label className="block text-xs text-gray-400">
            Thời điểm đăng
            <input type="datetime-local" className="input-field text-sm w-full mt-1 focus-visible:ring-2 focus-visible:ring-blue-500"
              min={toLocalInput(Date.now() + 60_000)} value={runAtInput} onChange={(e) => setRunAtInput(e.target.value)} />
          </label>
        ) : (
          <div className="space-y-2">
            <div role="group" aria-label="Ngày trong tuần" className="flex flex-wrap gap-x-3 gap-y-1">
              {DAYS.map((d) => (
                <label key={d.value} className="flex items-center gap-1 text-sm text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={days.includes(d.value)} onChange={() => toggleDay(d.value)} className="focus-visible:ring-2 focus-visible:ring-blue-500" />
                  {d.label}
                </label>
              ))}
            </div>
            <label className="block text-xs text-gray-400">
              Giờ đăng
              <input type="time" className="input-field text-sm w-full mt-1 focus-visible:ring-2 focus-visible:ring-blue-500" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
        )}

        {edit
          ? <p className="text-xs text-gray-400">Muốn đổi nội dung thì xoá và lên lịch lại.</p>
          : <p className="text-xs text-orange-400">Đăng cùng một nội dung lặp lại bằng nhiều tài khoản dễ bị Facebook hạn chế.</p>}
        {!edit && <p className="text-xs text-gray-400">Chạy lần đầu: {next ? formatFull(next) : '—'}</p>}
        {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400 focus-visible:ring-2 focus-visible:ring-blue-500">Huỷ</button>
          <button type="button" onClick={save} disabled={saving || missing} className="btn-primary text-sm px-4 py-1.5 text-white disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-blue-500">
            {saving ? 'Đang lưu...' : edit ? 'Lưu' : 'Lưu lịch'}
          </button>
        </div>
      </div>
    </div>
  );
}
