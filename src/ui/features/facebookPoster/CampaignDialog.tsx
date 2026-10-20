import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { dateInputToEndAt, dateInputToStartAt, toDateInput } from './campaignFormat';
import type { CampaignView } from '../../../services/facebookPoster/campaignOperations';

interface Props {
  /** Có thì sửa chiến dịch này, không có thì tạo mới. */
  campaign?: CampaignView;
  onClose: () => void;
  onSaved: () => void;
}

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';

export default function CampaignDialog({ campaign, onClose, onSaved }: Props) {
  const [name, setName] = useState(campaign?.name ?? '');
  const [goal, setGoal] = useState(campaign?.goal ?? '');
  const [start, setStart] = useState(toDateInput(campaign?.startAt ?? null));
  const [end, setEnd] = useState(toDateInput(campaign?.endAt ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    nameRef.current?.focus();
    return () => dialog?.close();
  }, []);

  const startAt = dateInputToStartAt(start);
  const endAt = dateInputToEndAt(end);
  const badRange = startAt !== null && endAt !== null && startAt > endAt;
  const invalid = !name.trim() || badRange;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = campaign
        ? await ipc.facebookPoster?.campaignUpdate({ id: campaign.id, name: name.trim(), goal: goal.trim(), startAt, endAt })
        : await ipc.facebookPoster?.campaignCreate({ name: name.trim(), goal: goal.trim(), startAt, endAt });
      if (!res?.success) { setError(res?.error || 'Không lưu được chiến dịch'); return; }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Không lưu được chiến dịch');
    } finally {
      setSaving(false);
    }
  };

  const input = `input-field text-sm w-full mt-1 ${FOCUS}`;
  return (
    <dialog ref={dialogRef} aria-labelledby="campaign-dialog-title" className="poster-dialog poster-schedule-dialog space-y-3"
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}>
      <h2 id="campaign-dialog-title" className="text-base font-semibold text-white">{campaign ? 'Sửa chiến dịch' : 'Tạo chiến dịch'}</h2>
      <label className="block text-xs text-gray-400">Tên chiến dịch
        <input ref={nameRef} className={input} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="block text-xs text-gray-400">Mục tiêu (tuỳ chọn)
        <textarea className={`${input} resize-y`} rows={3} maxLength={1000} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-xs text-gray-400">Từ ngày
          <input type="date" className={input} value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="block text-xs text-gray-400">Đến ngày
          <input type="date" className={input} value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-gray-400">Lịch của chiến dịch chỉ tự chạy trong khoảng ngày này (giờ máy). Để trống nếu không giới hạn.</p>
      {badRange && <p role="alert" className="text-xs text-red-400">Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.</p>}
      {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className={`px-3 py-1.5 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>Huỷ</button>
        <button type="button" onClick={save} disabled={saving || invalid} className={`btn-primary text-sm px-4 py-1.5 text-white disabled:opacity-60 ${FOCUS}`}>
          {saving ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>
    </dialog>
  );
}
