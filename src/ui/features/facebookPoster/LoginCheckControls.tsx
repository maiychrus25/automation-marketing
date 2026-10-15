import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';
type Config = { enabled: boolean; time: string };

export default function LoginCheckControls({ selected }: { selected: string[] }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [runActive, setRunActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.current().then((res) => {
      if (!cancelled && res?.success) setRunActive(res.run?.status === 'running');
    }).catch(() => {});
    ipc.facebookPoster?.getLoginCheckConfig().then((res) => {
      if (!cancelled && res?.success && res.config) setConfig(res.config);
    }).catch(() => {});
    const offProgress = ipc.on?.('facebookPoster:progress', () => setRunActive(true));
    const offFinished = ipc.on?.('facebookPoster:runFinished', () => setRunActive(false));
    const offCheck = ipc.on?.('facebookPoster:loginCheckProgress', (data: { done: number; total: number } | null) => setProgress(data ?? null));
    return () => { cancelled = true; offProgress?.(); offFinished?.(); offCheck?.(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
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
    const prev = config;
    setConfig(next);
    try {
      const res = await ipc.facebookPoster.setLoginCheckConfig(next);
      if (!res?.success) throw new Error(res?.error || 'Không lưu được cài đặt');
      if (res.config) setConfig(res.config);
    } catch (err) {
      setConfig(prev);
      showNotification(err instanceof Error && err.message ? err.message : 'Không lưu được cài đặt', 'error');
    }
  };

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1">
      <button type="button" onClick={start} disabled={checking || runActive}
        title={runActive ? 'Đang có lượt đăng chạy' : selected.length ? 'Kiểm tra các profile đã chọn' : 'Kiểm tra tất cả profile'}
        className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50 whitespace-nowrap ${FOCUS}`}>
        {checking ? `Đang kiểm tra… (${progress?.done ?? 0}/${progress?.total ?? 0})` : 'Kiểm tra đăng nhập'}
      </button>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" aria-label="Cài đặt tự kiểm tra đăng nhập" title="Tự kiểm tra mỗi ngày"
        className={`px-2 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>⚙</button>
      {open && (
        <div role="dialog" aria-label="Tự kiểm tra mỗi ngày" className="absolute right-0 top-full mt-1 z-20 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-700 bg-gray-900 p-3 space-y-2 shadow-lg">
          <p className="text-sm text-gray-200">Tự kiểm tra mỗi ngày</p>
          {config ? (
            <>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.enabled} onChange={(e) => save({ ...config, enabled: e.target.checked })} className={FOCUS} />
                Bật tự kiểm tra
              </label>
              <label className="block text-xs text-gray-400">
                Giờ kiểm tra
                <input type="time" value={config.time} disabled={!config.enabled} onChange={(e) => e.target.value && save({ ...config, time: e.target.value })} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
              </label>
            </>
          ) : <p className="text-xs text-gray-400">Đang tải…</p>}
        </div>
      )}
    </div>
  );
}
