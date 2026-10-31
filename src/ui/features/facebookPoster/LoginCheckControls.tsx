import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';
type Config = { enabled: boolean; time: string };

export default function LoginCheckControls({ selected }: { selected: string[] }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Poster runs do not gate the check: the backend only enforces lifecycle admission and its own one-job limit.
  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.getLoginCheckConfig().then((res) => {
      if (!cancelled && res?.success && res.config) setConfig(res.config);
    }).catch(() => {});
    const offCheck = ipc.on?.('facebookPoster:loginCheckProgress', (data: { done: number; total: number } | null) => setProgress(data ?? null));
    return () => { cancelled = true; offCheck?.(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); gearRef.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  useEffect(() => {
    if (open) popoverRef.current?.focus();
  }, [open]);

  const checking = starting || progress !== null;

  const start = async () => {
    setStarting(true);
    try {
      const res = await ipc.facebookPoster.checkLogins(selected.length ? selected : undefined);
      if (!res?.success) showNotification(res?.error || 'Không bắt đầu được kiểm tra đăng nhập', 'error');
    } catch (err) {
      showNotification(err instanceof Error && err.message ? err.message : 'Không bắt đầu được kiểm tra đăng nhập', 'error');
    } finally {
      setStarting(false);
    }
  };

  const save = async (next: Config) => {
    if (saving) return;
    const prev = config;
    setSaving(true);
    setConfig(next);
    try {
      const res = await ipc.facebookPoster.setLoginCheckConfig(next);
      if (!res?.success) throw new Error(res?.error || 'Không lưu được cài đặt');
      if (res.config) setConfig(res.config);
    } catch (err) {
      setConfig(prev);
      showNotification(err instanceof Error && err.message ? err.message : 'Không lưu được cài đặt', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1">
      <button type="button" onClick={start} disabled={checking}
        title={selected.length ? 'Kiểm tra các profile đã chọn' : 'Kiểm tra tất cả profile'}
        className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50 whitespace-nowrap ${FOCUS}`}>
        {checking ? `Đang kiểm tra… (${progress?.done ?? 0}/${progress?.total ?? 0})` : 'Kiểm tra đăng nhập'}
      </button>
      <button ref={gearRef} type="button" onClick={() => { if (open) gearRef.current?.focus(); setOpen((v) => !v); }} aria-expanded={open} aria-haspopup="dialog" aria-label="Cài đặt tự kiểm tra đăng nhập" title="Tự kiểm tra mỗi ngày"
        className={`px-2 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>⚙</button>
      {open && (
        <div ref={popoverRef} tabIndex={-1} role="dialog" aria-label="Tự kiểm tra mỗi ngày" className="absolute left-0 sm:left-auto sm:right-0 top-full mt-1 z-20 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700 bg-gray-900 p-3 focus:outline-none space-y-2 shadow-lg">
          <p className="text-sm text-gray-200">Tự kiểm tra mỗi ngày</p>
          {config ? (
            <>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.enabled} disabled={saving} onChange={(e) => save({ ...config, enabled: e.target.checked })} className={FOCUS} />
                Bật tự kiểm tra
              </label>
              <label className="block text-xs text-gray-400">
                Giờ kiểm tra
                <input type="time" value={config.time} disabled={!config.enabled || saving} onChange={(e) => e.target.value && save({ ...config, time: e.target.value })} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
              </label>
            </>
          ) : <p className="text-xs text-gray-400">Đang tải…</p>}
        </div>
      )}
    </div>
  );
}
