import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { formatMinutesList, minutesLabel, parseMinutesList } from './trackingFormat';
import type { PostTrackingConfig } from '../../../services/facebookPoster/postTracking';

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';

export default function TrackConfigPopover() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<PostTrackingConfig | null>(null);
  const [linkText, setLinkText] = useState('');
  const [statsText, setStatsText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const apply = (c: PostTrackingConfig) => {
    setConfig(c);
    setLinkText(formatMinutesList(c.linkRetryMinutes));
    setStatsText(formatMinutesList(c.statsAtMinutes));
  };

  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.getTrackConfig().then((res) => {
      if (cancelled) return;
      if (res?.success && res.config) apply(res.config); else setLoadFailed(true);
    }).catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); gearRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    popoverRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  const save = async (next: PostTrackingConfig) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await ipc.facebookPoster.setTrackConfig(next);
      if (!res?.success || !res.config) throw new Error(res?.error || 'Không lưu được cài đặt');
      apply(res.config);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Không lưu được cài đặt');
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    const linkRetryMinutes = parseMinutesList(linkText);
    const statsAtMinutes = parseMinutesList(statsText);
    if (!linkRetryMinutes || !statsAtMinutes) { setError('Mốc thời gian phải là các số phút nguyên, cách nhau bằng dấu phẩy'); return; }
    save({ ...config, linkRetryMinutes, statsAtMinutes });
  };

  return (
    <div ref={wrapRef} className="relative">
      <button ref={gearRef} type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" aria-label="Cài đặt tự lấy link và đo tương tác" title="Tự lấy link và đo"
        className={`px-2 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>⚙</button>
      {open && (
        <div ref={popoverRef} tabIndex={-1} role="dialog" aria-label="Tự lấy link và đo" className="absolute right-0 top-full mt-1 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700 bg-gray-900 p-3 focus:outline-none space-y-2 shadow-lg">
          <p className="text-sm text-gray-200">Tự lấy link và đo</p>
          {config ? (
            <form onSubmit={submit} className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.autoEnabled} disabled={saving} onChange={(e) => save({ ...config, autoEnabled: e.target.checked })} className={FOCUS} />
                Bật tự động
              </label>
              <label className="block text-xs text-gray-400">
                Mốc thử lấy link (phút)
                <input type="text" inputMode="numeric" value={linkText} onChange={(e) => setLinkText(e.target.value)} disabled={saving} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
                <span className="block mt-0.5">Hiện tại: {config.linkRetryMinutes.map(minutesLabel).join(', ')}</span>
              </label>
              <label className="block text-xs text-gray-400">
                Mốc đo tương tác (phút)
                <input type="text" inputMode="numeric" value={statsText} onChange={(e) => setStatsText(e.target.value)} disabled={saving} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
                <span className="block mt-0.5">Hiện tại: {config.statsAtMinutes.map(minutesLabel).join(', ')}</span>
              </label>
              <p className="text-xs text-gray-500">Mỗi danh sách 1–10 mốc, tăng dần, từ 5 đến 20160 phút.</p>
              {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}
              <button type="submit" disabled={saving} className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-50 ${FOCUS}`}>{saving ? 'Đang lưu…' : 'Lưu mốc thời gian'}</button>
            </form>
          ) : <p className="text-xs text-gray-400">{loadFailed ? 'Không tải được cài đặt' : 'Đang tải…'}</p>}
        </div>
      )}
    </div>
  );
}
