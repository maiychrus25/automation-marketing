import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '../common/PageLoading';
import { Card } from './controlApiParts';

// Cài đặt máy chủ render video (spec Video Studio 6.1). Khoá API chỉ hiện 4 ký tự cuối; để trống = giữ khoá cũ.
export default function RenderServerSettings() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hint, setHint] = useState('');
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const apply = (res: { url?: string; apiKeyHint?: string; configured?: boolean }) => {
    setUrl(res.url ?? '');
    setHint(res.apiKeyHint ?? '');
    setConfigured(!!res.configured);
  };

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await ipc.video?.settingsGet();
      if (!alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không tải được cài đặt máy chủ render');
      apply(res);
    } catch (err) { if (alive.current) setLoadError(err instanceof Error ? err.message : 'Không tải được cài đặt máy chủ render'); }
    finally { if (alive.current) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const urlInvalid = !!url.trim() && !/^https:\/\/\S+$/i.test(url.trim());
  const keyMissing = !configured && !apiKey.trim();

  const save = async () => {
    setSaving(true);
    setError('');
    setTestResult(null);
    try {
      const res = await ipc.video?.settingsSet({ url: url.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!alive.current) return;
      if (!res?.success) { setError(res?.error || 'Không lưu được cài đặt'); return; }
      apply(res);
      setApiKey('');
      showNotification('Đã lưu cài đặt máy chủ render', 'success');
    } catch (err) { if (alive.current) setError(err instanceof Error && err.message ? err.message : 'Không lưu được cài đặt'); }
    finally { if (alive.current) setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await ipc.video?.testConnection();
      if (!alive.current) return;
      setTestResult(res?.success
        ? { ok: true, text: `Kết nối được (phiên bản ${res.version ?? '?'}, ${res.templateCount ?? 0} mẫu).` }
        : { ok: false, text: res?.error || 'Không kết nối được máy chủ render' });
    } catch (err) { if (alive.current) setTestResult({ ok: false, text: err instanceof Error && err.message ? err.message : 'Không kết nối được máy chủ render' }); }
    finally { if (alive.current) setTesting(false); }
  };

  return (
    <div className="space-y-4 p-2 max-w-2xl min-w-0">
      <h2 className="text-base font-semibold text-white">Máy chủ render video</h2>
      <Card>
        <p className="text-xs text-gray-400">Video được dựng trên máy chủ riêng của anh. Nhập địa chỉ (bắt đầu bằng https://) và khoá API do quản trị máy chủ cấp. Khoá được mã hoá trên máy này.</p>
        {loading ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải"><Spinner size={5} /></div>
          : loadError ? <div className="space-y-2"><p role="alert" className="text-sm text-red-400 break-words">{loadError}</p><button type="button" className="btn-secondary" onClick={load}>Thử lại</button></div>
          : <>
            <label className="block text-xs text-gray-400">Địa chỉ máy chủ
              <input className="input-field text-sm w-full mt-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://render.example.com" inputMode="url" autoComplete="off" aria-invalid={urlInvalid} />
            </label>
            {urlInvalid && <p role="alert" className="text-xs text-red-400">Địa chỉ phải bắt đầu bằng https://</p>}
            <label className="block text-xs text-gray-400">Khoá API
              <input className="input-field text-sm w-full mt-1" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
                placeholder={configured && hint ? `Đang dùng khoá …${hint} (để trống để giữ nguyên)` : 'Dán khoá API'} />
            </label>
            {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary" onClick={save} disabled={saving || !url.trim() || urlInvalid || keyMissing}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
              <button type="button" className="btn-secondary" onClick={test} disabled={testing || saving || !configured}>{testing ? 'Đang thử…' : 'Thử kết nối'}</button>
              {!configured && <span className="text-xs text-gray-500">Lưu cài đặt trước khi thử kết nối.</span>}
            </div>
            {testResult && <p role={testResult.ok ? 'status' : 'alert'} className={`text-sm break-words ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>{testResult.text}</p>}
          </>}
      </Card>
    </div>
  );
}
