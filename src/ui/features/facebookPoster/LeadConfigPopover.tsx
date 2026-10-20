import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { formatMinutesList, minutesLabel, parseMinutesList } from './trackingFormat';
import { parseKeywordText } from './leadFormat';
import type { LeadConfig } from '../../../services/facebookPoster/leadRules';

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';

export default function LeadConfigPopover() {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<LeadConfig | null>(null);
  const [keywordText, setKeywordText] = useState('');
  const [minutesText, setMinutesText] = useState('');
  const [scoreText, setScoreText] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const apply = (c: LeadConfig) => {
    setConfig(c);
    setKeywordText(c.keywords.join(', '));
    setMinutesText(formatMinutesList(c.collectAtMinutes));
    setScoreText(String(c.aiMinScore));
  };

  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.leadConfigGet().then((res) => {
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

  const save = async (next: LeadConfig) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await ipc.facebookPoster.leadConfigSet(next);
      if (!res?.success || !res.config) throw new Error(res?.error || 'Không lưu được cài đặt');
      if (alive.current) apply(res.config);
    } catch (err) {
      if (alive.current) setError(err instanceof Error && err.message ? fieldLabels(err.message) : 'Không lưu được cài đặt');
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    const collectAtMinutes = parseMinutesList(minutesText);
    if (!collectAtMinutes) { setError('Mốc thu phải là các số phút nguyên, cách nhau bằng dấu phẩy'); return; }
    if (!/^\d+$/.test(scoreText.trim())) { setError('Ngưỡng điểm AI phải là số nguyên từ 0 đến 100'); return; }
    save({ ...config, keywords: parseKeywordText(keywordText), collectAtMinutes, aiMinScore: Number(scoreText) });
  };

  return (
    <div ref={wrapRef} className="relative">
      <button ref={gearRef} type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" aria-label="Cài đặt lọc khách tiềm năng" title="Cài đặt lọc khách"
        className={`px-2 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>⚙</button>
      {open && (
        <div ref={popoverRef} tabIndex={-1} role="dialog" aria-label="Cài đặt lọc khách" className="absolute right-0 top-full mt-1 z-20 w-[min(22rem,calc(100vw-3rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-3 focus:outline-none space-y-2 shadow-lg">
          <p className="text-sm text-gray-200">Lọc khách tiềm năng</p>
          {config ? (
            <form onSubmit={submit} className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.autoCollect} disabled={saving} onChange={(e) => save({ ...config, autoCollect: e.target.checked })} className={FOCUS} />
                Tự thu bình luận theo mốc
              </label>
              <label className="block text-xs text-gray-400">
                Mốc thu (phút kể từ lúc đăng)
                <input type="text" inputMode="numeric" value={minutesText} onChange={(e) => setMinutesText(e.target.value)} disabled={saving} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
                <span className="block mt-0.5">Hiện tại: {config.collectAtMinutes.map(minutesLabel).join(', ')}</span>
              </label>
              <label className="block text-xs text-gray-400">
                Từ khoá (cách nhau bằng dấu phẩy)
                <textarea rows={4} value={keywordText} onChange={(e) => setKeywordText(e.target.value)} disabled={saving} className={`input-field text-sm w-full mt-1 ${FOCUS}`} />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.detectPhone} disabled={saving} onChange={(e) => save({ ...config, detectPhone: e.target.checked })} className={FOCUS} />
                Nhận cả bình luận có số điện thoại
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={config.aiEnabled} disabled={saving} onChange={(e) => save({ ...config, aiEnabled: e.target.checked })} className={FOCUS} />
                Dùng AI chấm ý định mua
              </label>
              <label className="block text-xs text-gray-400">
                Ngưỡng điểm AI (0–100)
                <input type="text" inputMode="numeric" value={scoreText} onChange={(e) => setScoreText(e.target.value)} disabled={saving} className={`input-field text-sm w-24 mt-1 block ${FOCUS}`} />
              </label>
              <p className="text-xs text-gray-500">Mốc thu 1–10 mốc, tăng dần, từ 30 đến 20160 phút. Từ khoá 1–100 mục, mỗi mục tối đa 40 ký tự. AI lỗi thì mọi bình luận khớp từ khoá vẫn thành khách.</p>
              {error && <p role="alert" className="text-xs text-red-400 break-words">{error}</p>}
              <button type="submit" disabled={saving} className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-50 ${FOCUS}`}>{saving ? 'Đang lưu…' : 'Lưu cài đặt'}</button>
            </form>
          ) : <p className="text-xs text-gray-400">{loadFailed ? 'Không tải được cài đặt' : 'Đang tải…'}</p>}
        </div>
      )}
    </div>
  );
}

// Lỗi kiểm tra cấu hình dùng chung với Control API nên mang tên trường; đổi sang nhãn hiển thị.
function fieldLabels(message: string): string {
  return message
    .replace(/\bcollectAtMinutes\b/g, 'Mốc thu')
    .replace(/\baiMinScore\b/g, 'Ngưỡng điểm AI')
    .replace(/\bautoCollect\b/g, 'Tự thu bình luận');
}
