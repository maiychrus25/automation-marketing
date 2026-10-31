import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { formatMinutesList, minutesLabel, parseMinutesList, REPORT_CADENCE_OPTIONS, WEEKDAY_OPTIONS, LEAD_DIGEST_OPTIONS } from './trackingFormat';
import type { PostTrackingConfig } from '../../../services/facebookPoster/postTracking';
import type { NotificationConfig } from '../../../services/facebookPoster/notificationRules';

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, '0')}:00` }));

export default function TrackConfigPopover() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<PostTrackingConfig | null>(null);
  const [linkText, setLinkText] = useState('');
  const [statsText, setStatsText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notif, setNotif] = useState<NotificationConfig | null>(null);
  const [notifLoadFailed, setNotifLoadFailed] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);
  const [reportError, setReportError] = useState('');
  const [digestError, setDigestError] = useState('');
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

  // Cài đặt thông báo là phần phụ: tải lỗi thì thay hai khối bằng một dòng báo lỗi, không chặn mốc theo dõi.
  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.getNotificationConfig().then((res) => {
      if (cancelled) return;
      if (res?.success && res.config) setNotif(res.config); else setNotifLoadFailed(true);
    }).catch(() => { if (!cancelled) setNotifLoadFailed(true); });
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
      setError(err instanceof Error && err.message ? fieldLabels(err.message) : 'Không lưu được cài đặt');
    } finally {
      setSaving(false);
    }
  };

  // Lưu ngay khi đổi. Select là controlled theo bản đã lưu nên lỗi tự trả về giá trị cũ; lỗi gom tin hiện cạnh ô gom tin.
  const saveNotif = async (patch: Partial<NotificationConfig>) => {
    if (notifSaving) return;
    const isDigest = 'leadDigestMinutes' in patch;
    const setErr = isDigest ? setDigestError : setReportError;
    setNotifSaving(true);
    setReportError('');
    setDigestError('');
    try {
      const res = await ipc.facebookPoster.setNotificationConfig(patch);
      if (!res?.success || !res.config) throw new Error(res?.error || 'Không lưu được cài đặt');
      setNotif(res.config);
    } catch (err) {
      setErr(err instanceof Error && err.message ? fieldLabels(err.message) : 'Không lưu được cài đặt');
    } finally {
      setNotifSaving(false);
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
        <div ref={popoverRef} tabIndex={-1} role="dialog" aria-label="Tự lấy link và đo" className="absolute right-0 top-full mt-1 z-20 w-[min(20rem,calc(100vw-8rem))] rounded-lg border border-gray-700 bg-gray-900 p-3 focus:outline-none space-y-2 shadow-lg max-h-[75vh] overflow-y-auto">
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
          {!notif && notifLoadFailed && <p className="text-xs text-gray-400 border-t border-gray-700 pt-2">Không tải được cài đặt báo cáo</p>}
          {notif && (
            <div className="space-y-2 border-t border-gray-700 pt-2">
              <div className="space-y-1">
                <label className="block text-xs text-gray-400">
                  Báo cáo qua bot
                  <select value={notif.reportCadence} disabled={notifSaving} onChange={(e) => saveNotif({ reportCadence: e.target.value as NotificationConfig['reportCadence'] })} className={`input-field text-xs py-1 w-full mt-1 ${FOCUS}`}>
                    {REPORT_CADENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <label className="block text-xs text-gray-400 min-w-0">
                    Giờ gửi báo cáo
                    <select value={notif.reportHour} disabled={notifSaving || notif.reportCadence === 'off'} onChange={(e) => saveNotif({ reportHour: Number(e.target.value) })} className={`input-field text-xs py-1 w-full mt-1 ${FOCUS}`}>
                      {HOUR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                  {notif.reportCadence === 'weekly' && (
                    <label className="block text-xs text-gray-400 min-w-0">
                      Thứ gửi báo cáo
                      <select value={notif.reportWeekday} disabled={notifSaving} onChange={(e) => saveNotif({ reportWeekday: Number(e.target.value) })} className={`input-field text-xs py-1 w-full mt-1 ${FOCUS}`}>
                        {WEEKDAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                {reportError && <p role="alert" className="text-xs text-red-400 break-words">{reportError}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-gray-400">
                  Gom tin khách tiềm năng
                  <select value={notif.leadDigestMinutes} disabled={notifSaving} onChange={(e) => saveNotif({ leadDigestMinutes: Number(e.target.value) as NotificationConfig['leadDigestMinutes'] })} className={`input-field text-xs py-1 w-full mt-1 ${FOCUS}`}>
                    {LEAD_DIGEST_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                {digestError && <p role="alert" className="text-xs text-red-400 break-words">{digestError}</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Lỗi kiểm tra cấu hình dùng chung với Control API nên mang tên trường; đổi sang nhãn hiển thị.
function fieldLabels(message: string): string {
  return message
    .replace(/\blinkRetryMinutes\b/g, 'Mốc thử lấy link')
    .replace(/\bstatsAtMinutes\b/g, 'Mốc đo tương tác')
    .replace(/\bautoEnabled\b/g, 'Bật tự động')
    .replace(/\breportCadence\b/g, 'Báo cáo qua bot')
    .replace(/\breportHour\b/g, 'Giờ gửi báo cáo')
    .replace(/\breportWeekday\b/g, 'Thứ gửi báo cáo')
    .replace(/\bleadDigestMinutes\b/g, 'Gom tin khách tiềm năng');
}
