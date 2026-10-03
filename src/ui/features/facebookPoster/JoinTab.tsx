import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import ProfilePicker from './ProfilePicker';

interface Props { busy: boolean; onStarted: () => void }

const splitLines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

export default function JoinTab({ busy, onStarted }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [keywords, setKeywords] = useState('');
  const [limit, setLimit] = useState(10);
  const [minDelaySec, setMinDelaySec] = useState(60);
  const [maxDelaySec, setMaxDelaySec] = useState(180);
  const [starting, setStarting] = useState(false);

  const disabledReason = busy ? 'Đang có việc chạy. Đợi xong hoặc hủy việc đó.'
    : profileIds.length === 0 ? 'Chọn một profile.'
    : splitLines(keywords).length === 0 ? 'Nhập ít nhất một từ khóa.'
    : !Number.isInteger(limit) || limit < 1 || limit > 200 ? 'Giới hạn nhóm phải từ 1 đến 200.'
    : minDelaySec < 0 || maxDelaySec < minDelaySec || maxDelaySec > 86400 ? 'Thời gian nghỉ không hợp lệ.'
    : '';

  const handleStart = async () => {
    setStarting(true);
    try {
      const res = await ipc.facebookPoster?.start('join', { profileId: profileIds[0], keywords: splitLines(keywords), limit, minDelaySec, maxDelaySec });
      if (!res?.success) showNotification(res?.error || 'Không bắt đầu được', 'error');
      else onStarted();
    } catch (err: any) {
      showNotification(err?.message || 'Không bắt đầu được', 'error');
    } finally {
      setStarting(false);
    }
  };

  const numberInput = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <label className="block text-xs text-gray-400">
      {label}
      <input type="number" className="input-field text-sm w-full mt-1" min={min} max={max} value={value} disabled={busy}
        onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <div className="space-y-4 min-w-0">
      <section>
        <h3 className="text-sm font-medium text-white mb-2">Profile</h3>
        <ProfilePicker mode="single" selected={profileIds} onChange={setProfileIds} disabled={busy} />
      </section>
      <label className="block text-xs text-gray-400">
        Từ khóa (mỗi dòng một từ)
        <textarea className="input-field text-sm w-full mt-1 min-h-[90px]" value={keywords} disabled={busy} onChange={(e) => setKeywords(e.target.value)} />
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {numberInput('Giới hạn nhóm', limit, setLimit, 1, 200)}
        {numberInput('Nghỉ tối thiểu (giây)', minDelaySec, setMinDelaySec, 0, 86400)}
        {numberInput('Nghỉ tối đa (giây)', maxDelaySec, setMaxDelaySec, 0, 86400)}
      </div>
      <p className="text-xs text-orange-400 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2">
        Xin vào nhiều nhóm liên tục dễ bị Facebook hạn chế tài khoản.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleStart} disabled={!!disabledReason || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">
          {starting ? 'Đang bắt đầu...' : 'Bắt đầu'}
        </button>
        {disabledReason && <span className="text-xs text-gray-400">{disabledReason}</span>}
      </div>
    </div>
  );
}
