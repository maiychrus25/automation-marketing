import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';
import { Spinner } from '../common/PageLoading';
import { findBroadCidrs } from './controlAllowList';
import { Card, CodeBox } from './controlApiParts';
import PairingPanel from './PairingPanel';
import { BotIcon, KeyIcon, RefreshIcon, TrashIcon } from '../common/icons';

type ControlView = { enabled: boolean; port: number; allowList: string[]; fingerprint: string | null; running: boolean; error?: string; warning?: string; publicHost?: string | null; detectedPublicHost?: string | null };
type KeyRow = { id: string; name: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null };
type AuditRow = { at: number; keyName: string | null; ip: string | null; method: string | null; ok: boolean; errorCode: string | null; durationMs: number | null };

const formatTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString('vi-VN') : '—');

export default function ControlApiSettings() {
  const { showNotification } = useAppStore();
  const [view, setView] = useState<ControlView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState('47321');
  const [allowText, setAllowText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [keysError, setKeysError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [firewall, setFirewall] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showNotification('Đã sao chép', 'success');
    } catch {
      showNotification('Không sao chép được, hãy bôi đen và sao chép thủ công', 'error');
    }
  }, [showNotification]);

  const applyView = (v: ControlView) => {
    setView(v);
    setEnabled(!!v.enabled);
    setPort(String(v.port));
    setAllowText((v.allowList || []).join('\n'));
  };

  const loadFirewall = useCallback(async () => {
    const res = await ipc.controlApi?.firewallCommand();
    setFirewall(res?.success && res.command ? res.command : '');
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      const res = await ipc.controlApi?.listKeys();
      if (res?.success) { setKeys(res.keys || []); setKeysError(''); }
      else setKeysError(res?.error || 'Không tải được danh sách khoá');
    } catch (e: any) { setKeysError(e?.message || 'Không tải được danh sách khoá'); }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await ipc.controlApi?.listAudit(100);
      if (res?.success) { setAudit(res.audit || []); setAuditError(''); }
      else setAuditError(res?.error || 'Không tải được danh sách lệnh');
    } catch (e: any) {
      setAuditError(e?.message || 'Không tải được danh sách lệnh');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const reloadAfterPairing = useCallback(async () => {
    try {
      const res = await ipc.controlApi?.getConfig();
      if (res?.success) applyView(res as ControlView);
    } catch { /* giữ nguyên giao diện hiện tại */ }
    await Promise.all([loadKeys(), loadAudit(), loadFirewall().catch(() => {})]);
  }, [loadKeys, loadAudit, loadFirewall]);

  useEffect(() => {
    (async () => {
      try {
        const res = await ipc.controlApi?.getConfig();
        if (res?.success) applyView(res as ControlView);
        else setLoadError(res?.error || 'Không tải được cấu hình');
      } catch (e: any) {
        setLoadError(e?.message || 'Không tải được cấu hình');
      }
      await Promise.all([loadKeys(), loadAudit(), loadFirewall().catch(() => {})]);
    })();
  }, [loadKeys, loadAudit, loadFirewall]);

  const save = async () => {
    setSaving(true);
    setInvalid([]);
    setFormError('');
    try {
      const res = await ipc.controlApi?.setConfig({ enabled, port: Number(port), allowList: allowText });
      if (res?.success) {
        applyView(res as ControlView);
        showNotification('Đã lưu cấu hình', 'success');
        loadFirewall().catch(() => {});
      } else {
        setFormError(res?.error || 'Không lưu được cấu hình');
        setInvalid(res?.invalid || []);
      }
    } catch (e: any) {
      setFormError(e?.message || 'Không lưu được cấu hình');
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    const ok = await showConfirm({
      title: 'Tạo lại chứng chỉ?',
      message: 'Dấu vân tay sẽ đổi. Bạn phải cập nhật MAIHUB_CERT_SHA256 trong cấu hình bot, nếu không bot sẽ không kết nối được.',
      confirmText: 'Tạo lại',
      variant: 'warning',
    });
    if (!ok) return;
    setRegenerating(true);
    try {
      const res = await ipc.controlApi?.regenerateCertificate();
      if (res?.success) {
        setView(v => (v ? { ...v, fingerprint: res.fingerprint ?? null, running: !!res.running } : v));
        showNotification('Đã tạo lại chứng chỉ', 'success');
      } else showNotification(res?.error || 'Không tạo lại được chứng chỉ', 'error');
    } catch (e: any) {
      showNotification(e?.message || 'Không tạo lại được chứng chỉ', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const createKey = async () => {
    setCreating(true);
    try {
      const res = await ipc.controlApi?.createKey(newKeyName.trim());
      if (res?.success && res.key) {
        setRawKey(res.key);
        setNewKeyName('');
        loadKeys();
      } else showNotification(res?.error || 'Không tạo được khoá', 'error');
    } catch (e: any) {
      showNotification(e?.message || 'Không tạo được khoá', 'error');
    } finally {
      setCreating(false);
    }
  };

  const closeKeyModal = () => setRawKey(null);

  const revoke = async (k: KeyRow) => {
    const ok = await showConfirm({
      title: `Thu hồi khoá "${k.name}"?`,
      message: 'Bot đang dùng khoá này sẽ không gọi được nữa. Không thể hoàn tác.',
      confirmText: 'Thu hồi',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      const res = await ipc.controlApi?.revokeKey(k.id);
      if (res?.success) { showNotification('Đã thu hồi khoá', 'success'); loadKeys(); }
      else showNotification(res?.error || 'Không thu hồi được khoá', 'error');
    } catch (e: any) {
      showNotification(e?.message || 'Không thu hồi được khoá', 'error');
    }
  };

  if (!view && !loadError) {
    return <div className="flex items-center gap-2 p-4 text-sm text-gray-400"><Spinner size={5} /> Đang tải...</div>;
  }
  if (!view) {
    return <div className="p-4 text-sm text-red-400" role="alert">{loadError}</div>;
  }

  const status = view.error ? { text: 'Lỗi', cls: 'bg-red-500/15 text-red-400' }
    : view.running ? { text: 'Đang chạy', cls: 'bg-green-500/15 text-green-500' }
    : { text: 'Đã tắt', cls: 'bg-gray-500/20 text-gray-400' };
  const urlText = `https://<IP-VPS>:${view.port}`;
  const envText = `MAIHUB_URL=${urlText}\nMAIHUB_CERT_SHA256=${view.fingerprint || ''}\nMAIHUB_API_KEY=${'<khoá vừa tạo>'}`;
  const mcpText = 'claude mcp add maihub -- python3 /đường/dẫn/maihub_bridge.py mcp --env-file /đường/dẫn/.env';

  return (
    <div className="space-y-4 max-w-3xl min-w-0">
      <div>
        <h2 className="text-base font-semibold text-white flex items-center gap-2"><BotIcon className="w-4 h-4" /> Điều khiển từ bot</h2>
        <p className="text-xs text-gray-400 mt-1 leading-relaxed">Bot AI (ví dụ bot Telegram trên VPS) điều khiển Đăng Facebook qua kết nối HTTPS có khoá.</p>
      </div>

      <PairingPanel
        publicHost={view.publicHost ?? view.detectedPublicHost ?? ''}
        onCopy={copy}
        onCreated={reloadAfterPairing}
        onPaired={reloadAfterPairing}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input type="checkbox" role="switch" className="w-4 h-4 accent-blue-600" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            Bật điều khiển từ bot
          </label>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${status.cls}`}>{status.text}</span>
        </div>
        {view.error && <p className="text-xs text-red-400 break-words" role="alert">{view.error}</p>}
        {view.warning && <p className="text-xs text-amber-500 break-words">{view.warning}</p>}
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <div>
            <label htmlFor="control-port" className="text-xs text-gray-400 block mb-1">Cổng (1024–65535)</label>
            <input id="control-port" className="input-field" type="number" min={1024} max={65535} value={port} onChange={e => setPort(e.target.value)} />
          </div>
          <div className="min-w-0">
            <label htmlFor="control-allow" className="text-xs text-gray-400 block mb-1">IP được phép (mỗi dòng một IP hoặc CIDR, bắt buộc có ít nhất một)</label>
            <textarea id="control-allow" className="input-field font-mono min-h-[5rem]" rows={4} value={allowText} placeholder={'203.0.113.5\n10.0.0.0/24'} onChange={e => setAllowText(e.target.value)} />
          </div>
        </div>
        {findBroadCidrs(allowText).length > 0 && (
          <p className="text-xs text-amber-500 break-words" role="status">Cảnh báo: {findBroadCidrs(allowText).join(', ')} là dải IP rất rộng (rộng hơn /16), nhiều máy lạ có thể kết nối tới cổng này. Chỉ nên cho phép đúng IP của bot.</p>
        )}
        {formError && <p className="text-xs text-red-400 break-words" role="alert">{formError}</p>}
        {invalid.length > 0 && (
          <ul className="text-xs text-red-400 font-mono list-disc pl-5 break-all">
            {invalid.map(i => <li key={i}>{i}</li>)}
          </ul>
        )}
        <button type="button" className="btn-primary flex items-center gap-2" onClick={save} disabled={saving}>
          {saving && <Spinner size={4} className="text-white" />} Lưu
        </button>
      </Card>

      <Card title="Thông tin kết nối">
        <div>
          <p className="text-xs text-gray-400 mb-1">Địa chỉ (thay &lt;IP-VPS&gt; bằng IP công khai của máy này mà bot truy cập được)</p>
          <CodeBox text={urlText} onCopy={copy} label="Sao chép địa chỉ" />
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1">Dấu vân tay chứng chỉ (SHA-256)</p>
          {view.fingerprint
            ? <CodeBox text={view.fingerprint} onCopy={copy} label="Sao chép dấu vân tay" />
            : <p className="text-xs text-gray-500">Chưa có chứng chỉ, sẽ được tạo khi bật lần đầu.</p>}
        </div>
        <button type="button" className="btn-secondary flex items-center gap-2" onClick={regenerate} disabled={regenerating}>
          {regenerating ? <Spinner size={4} /> : <RefreshIcon className="w-4 h-4" />} Tạo lại chứng chỉ
        </button>
      </Card>

      <Card title="Khoá truy cập">
        <div className="flex flex-wrap gap-2">
          <input aria-label="Tên khoá" className="input-field flex-1 min-w-0 basis-[8rem]" maxLength={60} placeholder="Tên khoá (vd. bot-telegram)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newKeyName.trim() && !creating) createKey(); }} />
          <button type="button" className="btn-primary flex items-center gap-2" onClick={createKey} disabled={creating || !newKeyName.trim()}>
            {creating ? <Spinner size={4} className="text-white" /> : <KeyIcon className="w-4 h-4" />} Tạo khoá
          </button>
        </div>
        {keysError && <p className="text-xs text-red-400 break-words" role="alert">{keysError}</p>}
        {keys.length === 0 ? <p className="text-xs text-gray-500">Chưa có khoá nào.</p> : (
          <ul className="divide-y divide-gray-700">
            {keys.map(k => (
              <li key={k.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 break-words">{k.name} {k.revokedAt && <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-red-500/15 text-red-400">Đã thu hồi</span>}</p>
                  <p className="text-xs text-gray-500">Tạo: {formatTime(k.createdAt)} · Dùng gần nhất: {formatTime(k.lastUsedAt)}</p>
                </div>
                {!k.revokedAt && (
                  <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => revoke(k)}>
                    <TrashIcon className="w-4 h-4" /> Thu hồi
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Tường lửa Windows">
        {firewall ? <CodeBox text={firewall} onCopy={copy} label="Sao chép lệnh tường lửa" /> : <p className="text-xs text-gray-500">Lưu danh sách IP để hiện lệnh.</p>}
        <p className="text-xs text-gray-400">Chạy một lần trong PowerShell/CMD quyền Administrator trên máy Windows. Lần đầu dòng xoá luật có thể báo "No rules match the specified criteria.": bình thường, cứ chạy tiếp dòng thêm luật.</p>
      </Card>

      <Card title="Cấu hình cho bot">
        <CodeBox text={envText} onCopy={copy} label="Sao chép cấu hình .env" />
        <p className="text-xs text-gray-400">Cài MCP cho Claude Code:</p>
        <CodeBox text={mcpText} onCopy={copy} label="Sao chép lệnh cài MCP" />
      </Card>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Lệnh gần đây</h3>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={loadAudit} disabled={auditLoading}>
            {auditLoading ? <Spinner size={4} /> : <RefreshIcon className="w-4 h-4" />} Làm mới
          </button>
        </div>
        {auditError && <p className="text-xs text-red-400 break-words" role="alert">{auditError}</p>}
        {audit.length === 0 ? <p className="text-xs text-gray-500">Chưa có lệnh nào.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-gray-300 whitespace-nowrap">
              <thead className="text-gray-500">
                <tr><th scope="col" className="pr-3 py-1">Thời gian</th><th scope="col" className="pr-3">Khoá</th><th scope="col" className="pr-3">IP</th><th scope="col" className="pr-3">Phương thức</th><th scope="col" className="pr-3">Kết quả</th><th scope="col">Thời lượng</th></tr>
              </thead>
              <tbody>
                {audit.map((a, i) => (
                  <tr key={`${a.at}-${i}`} className="border-t border-gray-700">
                    <td className="pr-3 py-1">{formatTime(a.at)}</td>
                    <td className="pr-3">{a.keyName || '—'}</td>
                    <td className="pr-3 font-mono">{a.ip || '—'}</td>
                    <td className="pr-3 font-mono">{a.method || '—'}</td>
                    <td className={`pr-3 ${a.ok ? 'text-green-500' : 'text-red-400'}`}>{a.ok ? 'OK' : a.errorCode || 'Lỗi'}</td>
                    <td>{a.durationMs != null ? `${a.durationMs} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {rawKey && (
        <div className="fixed inset-0 z-50 mac-overlay flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="control-key-title" onKeyDown={e => { if (e.key === 'Escape') closeKeyModal(); }}>
          <div className="mac-alert w-full max-w-md p-5 space-y-3 max-h-full overflow-y-auto">
            <h3 id="control-key-title" className="text-sm font-semibold text-white">Khoá mới</h3>
            <p className="text-xs text-amber-500 leading-relaxed">Khoá chỉ hiện một lần — sao chép và lưu vào cấu hình bot ngay.</p>
            <CodeBox text={rawKey} onCopy={copy} label="Sao chép khoá" />
            <div className="flex justify-end">
              <button type="button" className="btn-primary" autoFocus onClick={closeKeyModal}>Đã lưu, đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
