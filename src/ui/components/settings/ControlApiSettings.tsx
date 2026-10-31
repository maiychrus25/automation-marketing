import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ScopedKeyPolicy } from '../../../services/control/controlAuthorization';
import type { PageIdentity } from '../../../models/dailyBrief';
import ControlKeyScope, { scopeValidationError } from './ControlKeyScope';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { showConfirm } from '../common/ConfirmDialog';
import { Spinner } from '../common/PageLoading';
import { findBroadCidrs } from './controlAllowList';
import { Card, CodeBox } from './controlApiParts';
import PairingPanel from './PairingPanel';
import { BotIcon, KeyIcon, RefreshIcon, TrashIcon } from '../common/icons';

type ControlView = { workspaceId: string; workspaceGeneration: number; protectedWritesEnabled?: boolean; enabled: boolean; port: number; allowList: string[]; fingerprint: string | null; running: boolean; error?: string; warning?: string; publicHost?: string | null; detectedPublicHost?: string | null };
type KeyRow = { policy?: ScopedKeyPolicy; id: string; name: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null };
type AuditRow = { at: number; keyName: string | null; ip: string | null; method: string | null; ok: boolean; errorCode: string | null; durationMs: number | null };

const formatTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString('vi-VN') : '—');

export default function ControlApiSettings() {
  const { showNotification } = useAppStore();
  const [view, setView] = useState<ControlView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [protectedWritesEnabled, setProtectedWritesEnabled] = useState(false);
  const [scopeOptions, setScopeOptions] = useState<{ workspaceId: string; identities: PageIdentity[] }>({ workspaceId: '', identities: [] });
  const [policy, setPolicy] = useState<ScopedKeyPolicy | null>(null);
  const [scopeLoadError, setScopeLoadError] = useState('');
  const [scopeLoading, setScopeLoading] = useState(false);
  const scopeError = scopeValidationError(policy, scopeOptions.identities, scopeOptions.workspaceId);
  const [port, setPort] = useState('47321');
  const [allowText, setAllowText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [rawKey, setRawKey] = useState<{ key: string; policy: ScopedKeyPolicy | null } | null>(null);
  const [keysError, setKeysError] = useState('');
  const [auditError, setAuditError] = useState('');
  const [firewall, setFirewall] = useState('');
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [scopeNotice, setScopeNotice] = useState('');
  const workspaceEpoch = useRef(0);
  const scopeRequest = useRef(0);
  const currentView = useRef<ControlView | null>(null);
  const isCurrent = useCallback((epoch: number) => epoch === workspaceEpoch.current && !useWorkspaceStore.getState().isSwitching, []);
  const isViewCurrent = (v: ControlView | null) => !!v && v === currentView.current
    && v.workspaceId === useWorkspaceStore.getState().activeWorkspaceId && !useWorkspaceStore.getState().isSwitching;

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showNotification('Đã sao chép', 'success');
    } catch {
      showNotification('Không sao chép được, hãy bôi đen và sao chép thủ công', 'error');
    }
  }, [showNotification]);

  const applyView = useCallback((v: ControlView) => {
    currentView.current = v;
    setView(v);
    setEnabled(!!v.enabled);
    setProtectedWritesEnabled(v.protectedWritesEnabled === true);
    setPort(String(v.port));
    setAllowText((v.allowList || []).join('\n'));
  }, []);

  const loadFirewall = useCallback(async () => {
    const epoch = workspaceEpoch.current;
    const res = await ipc.controlApi?.firewallCommand();
    if (isCurrent(epoch)) setFirewall(res?.success && res.command ? res.command : '');
  }, [isCurrent]);

  const loadKeys = useCallback(async () => {
    const epoch = workspaceEpoch.current;
    try {
      const res = await ipc.controlApi?.listKeys();
      if (!isCurrent(epoch)) return;
      if (res?.success) { setKeys(res.keys || []); setKeysError(''); }
      else setKeysError(res?.error || 'Không tải được danh sách khoá');
    } catch (e: any) { if (isCurrent(epoch)) setKeysError(e?.message || 'Không tải được danh sách khoá'); }
  }, [isCurrent]);

  const loadScopeOptions = useCallback(async () => {
    const epoch = workspaceEpoch.current;
    const request = ++scopeRequest.current;
    if (!isCurrent(epoch)) return;
    setScopeLoading(true);
    const [configResult, scopeResult] = await Promise.allSettled([
      ipc.controlApi?.getConfig(), ipc.controlApi?.getScopeOptions(),
    ]);
    if (!isCurrent(epoch) || request !== scopeRequest.current) return;
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const config = configResult.status === 'fulfilled' ? configResult.value : undefined;
    const res = scopeResult.status === 'fulfilled' ? scopeResult.value : undefined;
    if (config?.success && config.workspaceId === workspaceId && Number.isSafeInteger(config.workspaceGeneration)) {
      applyView(config as ControlView);
      setLoadError('');
      setFormError('');
    } else {
      currentView.current = null;
      const error = config?.error || 'Không tải được cấu hình workspace hiện tại, hãy tải lại.';
      setLoadError(error);
      setFormError(error);
    }
    if (res?.success && res.workspaceId === workspaceId && Array.isArray(res.identities)) {
      const identities = res.identities;
      setScopeOptions({ workspaceId, identities });
      setPolicy(current => {
        if (!current) return current;
        if (current.workspaceId !== workspaceId) {
          return current.kind === 'page_receiver'
            ? { kind: 'page_receiver', workspaceId, assignments: [], ownerChatId: '', ownerSenderId: '' }
            : { kind: 'page_runner', workspaceId, assignments: [] };
        }
        const assignments = current.assignments.map(a => ({ ...a,
          profileIds: a.profileIds.filter(id => identities.some(i => i.kind === 'page' && i.pageId === a.pageId && i.profileId === id)),
        })).filter(a => a.profileIds.length);
        return { ...current, assignments };
      });
      setScopeLoadError('');
      setScopeNotice('Đã tải lại phạm vi: chỉ giữ lựa chọn Page/profile còn hợp lệ; các ID chủ Page giữ nguyên trong cùng workspace.');
    } else {
      setScopeOptions({ workspaceId: '', identities: [] });
      setScopeLoadError(res?.error || 'Không tải được phạm vi khoá');
      setScopeNotice('');
    }
    setScopeLoading(false);
  }, [applyView, isCurrent]);

  const loadAudit = useCallback(async () => {
    const epoch = workspaceEpoch.current;
    setAuditLoading(true);
    try {
      const res = await ipc.controlApi?.listAudit(100);
      if (!isCurrent(epoch)) return;
      if (res?.success) { setAudit(res.audit || []); setAuditError(''); }
      else setAuditError(res?.error || 'Không tải được danh sách lệnh');
    } catch (e: any) {
      if (isCurrent(epoch)) setAuditError(e?.message || 'Không tải được danh sách lệnh');
    } finally {
      if (isCurrent(epoch)) setAuditLoading(false);
    }
  }, [isCurrent]);

  const reloadAfterPairing = useCallback(async () => {
    await Promise.all([loadKeys(), loadAudit(), loadScopeOptions(), loadFirewall().catch(() => {})]);
  }, [loadKeys, loadAudit, loadScopeOptions, loadFirewall]);

  useEffect(() => {
    // Subscribe synchronously: React can batch an A→B→A switch into a single render.
    const unsubscribe = useWorkspaceStore.subscribe((state, previous) => {
      if (state.activeWorkspaceId === previous.activeWorkspaceId && state.isSwitching === previous.isSwitching) return;
      workspaceEpoch.current++;
      currentView.current = null;
      setView(null);
      setLoadError('');
      setProtectedWritesEnabled(false);
      setSaving(false);
      setInvalid([]);
      setFormError('');
      setKeys([]);
      setRawKey(null);
      setAudit([]);
      setFirewall('');
      setScopeOptions({ workspaceId: '', identities: [] });
      setScopeNotice('');
      setPolicy(current => !current ? null : current.kind === 'page_receiver'
        ? { kind: 'page_receiver', workspaceId: state.activeWorkspaceId, assignments: [], ownerChatId: '', ownerSenderId: '' }
        : { kind: 'page_runner', workspaceId: state.activeWorkspaceId, assignments: [] });
      if (!state.isSwitching) void reloadAfterPairing();
    });
    if (!useWorkspaceStore.getState().isSwitching) void reloadAfterPairing();
    return () => { unsubscribe(); workspaceEpoch.current++; currentView.current = null; };
  }, [reloadAfterPairing]);

  const save = async () => {
    if (saving || regenerating || !isViewCurrent(view)) return;
    const { workspaceId, workspaceGeneration } = view!;
    const epoch = workspaceEpoch.current;
    setSaving(true);
    setInvalid([]);
    setFormError('');
    try {
      const res = await ipc.controlApi?.setConfig({ enabled, port: Number(port), allowList: allowText, protectedWritesEnabled, workspaceId, workspaceGeneration });
      if (!isViewCurrent(view)) return;
      if (res?.success && res.workspaceId === workspaceId && res.workspaceGeneration === workspaceGeneration) {
        applyView(res as ControlView);
        showNotification('Đã lưu cấu hình', 'success');
        loadFirewall().catch(() => {});
      } else {
        setFormError(res?.error || 'Không lưu được cấu hình');
        setInvalid(res?.invalid || []);
      }
    } catch (e: any) {
      if (isViewCurrent(view)) setFormError(e?.message || 'Không lưu được cấu hình');
    } finally {
      if (isCurrent(epoch)) setSaving(false);
    }
  };

  const toggleProtectedWrites = async (checked: boolean) => {
    if (!isViewCurrent(view)) return;
    if (!checked) { setProtectedWritesEnabled(false); return; }
    const ok = await showConfirm({
      title: 'Xác nhận đã kiểm tra cách ly receiver?',
      message: 'Chỉ bật sau khi đã kiểm chứng receiver chạy cách ly bằng tài khoản hệ điều hành riêng, runner không đọc được khoá, cấu hình hay .env của receiver. Lệnh staging và hai khoá riêng chưa đủ. Đây chỉ là khai báo vận hành của bạn, không phải bằng chứng kỹ thuật tự động. Nếu chưa kiểm xong, chọn Hủy và giữ tắt.',
      confirmText: 'Tôi đã kiểm tra cách ly',
      variant: 'warning',
    });
    if (ok && isViewCurrent(view)) setProtectedWritesEnabled(true);
  };

  const regenerate = async () => {
    if (saving || regenerating || !isViewCurrent(view)) return;
    setRegenerating(true);
    try {
      const ok = await showConfirm({
        title: 'Tạo lại chứng chỉ?',
        message: 'Dấu vân tay sẽ đổi. Bạn phải cập nhật MAIHUB_CERT_SHA256 trong cấu hình bot, nếu không bot sẽ không kết nối được.',
        confirmText: 'Tạo lại',
        variant: 'warning',
      });
      if (!ok || !isViewCurrent(view)) return;
      const res = await ipc.controlApi?.regenerateCertificate();
      if (!isViewCurrent(view)) return;
      if (res?.success) {
        const next = { ...view!, fingerprint: res.fingerprint ?? null, running: !!res.running };
        currentView.current = next;
        setView(next);
        showNotification('Đã tạo lại chứng chỉ', 'success');
      } else showNotification(res?.error || 'Không tạo lại được chứng chỉ', 'error');
    } catch (e: any) {
      showNotification(e?.message || 'Không tạo lại được chứng chỉ', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const createKey = async () => {
    if (scopeError) { showNotification(scopeError, 'error'); return; }
    setCreating(true);
    try {
      if (policy?.kind === 'page_receiver') {
        const ok = await showConfirm({
          title: 'Xác nhận chủ Page cho receiver?',
          message: `Tôi đã xác nhận Chat ID ${policy.ownerChatId} và Sender ID ${policy.ownerSenderId} của chủ Page. Khoá receiver phải giữ riêng, không đưa vào .env, cấu hình hay MCP của runner. Cấp khoá chưa chứng minh cách ly cài đặt.`,
          confirmText: 'Xác nhận và tạo khoá', variant: 'warning',
        });
        if (!ok) return;
      }
      const res = await ipc.controlApi?.createKey(newKeyName.trim(), policy ?? undefined);
      if (res?.success && res.key) {
        setRawKey({ key: res.key, policy });
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

      <Card title="Phạm vi khoá mới">
        <p className="text-xs text-gray-400">Áp dụng cho cả ghép nối và tạo khoá bên dưới. Không thay đổi quyền của khoá đã cấp.</p>
        <ControlKeyScope value={policy} onChange={setPolicy} identities={scopeOptions.identities} workspaceId={scopeOptions.workspaceId} />
        {scopeLoadError && <p className="text-xs text-red-400 break-words" role="alert">{scopeLoadError}</p>}
        {scopeNotice && <p className="text-xs text-gray-400 break-words" role="status">{scopeNotice}</p>}
        <button type="button" className="btn-secondary flex items-center gap-2" onClick={loadScopeOptions} disabled={scopeLoading}>
          {scopeLoading ? <Spinner size={4} /> : <RefreshIcon className="w-4 h-4" />} Tải lại phạm vi
        </button>
      </Card>

      <PairingPanel
        policy={policy}
        scopeError={scopeError}
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
        <label className="flex items-start gap-2 text-sm text-gray-200 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 shrink-0 accent-blue-600" checked={protectedWritesEnabled} disabled={scopeLoading || !isViewCurrent(view)} onChange={e => { void toggleProtectedWrites(e.target.checked); }} />
          Cho phép ghi được bảo vệ (đã kiểm tra cách ly receiver)
        </label>
        <p className="text-xs text-amber-500 leading-relaxed">Mặc định tắt. Chỉ lưu bật sau khi kiểm chứng cách ly receiver khỏi runner. Xác nhận này là khai báo vận hành, không tự kiểm chứng kỹ thuật; provisioning/staging chưa phải cài đặt sẵn sàng.</p>
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
        <button type="button" className="btn-primary flex items-center gap-2" onClick={save} disabled={saving || regenerating || scopeLoading || !isViewCurrent(view)}>
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
        <button type="button" className="btn-secondary flex items-center gap-2" onClick={regenerate} disabled={regenerating || saving || scopeLoading || !isViewCurrent(view)}>
          {regenerating ? <Spinner size={4} /> : <RefreshIcon className="w-4 h-4" />} Tạo lại chứng chỉ
        </button>
      </Card>

      <Card title="Khoá truy cập">
        <div className="flex flex-wrap gap-2">
          <input aria-label="Tên khoá" className="input-field flex-1 min-w-0 basis-[8rem]" maxLength={60} placeholder="Tên khoá (vd. bot-telegram)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newKeyName.trim() && !creating && !scopeError) createKey(); }} />
          <button type="button" className="btn-primary flex items-center gap-2" onClick={createKey} disabled={creating || !newKeyName.trim() || !!scopeError}>
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
                  <p className="text-xs text-gray-400 break-words">{!k.policy ? 'Legacy toàn quyền' : `${k.policy.kind === 'page_runner' ? 'Runner chuẩn bị nháp' : 'Receiver xác nhận'} · Workspace ${k.policy.workspaceId}`}</p>
                  {k.policy?.assignments.map(a => <p key={a.pageId} className="text-xs text-gray-400 break-all">Page {a.pageId} · profile {a.profileIds.join(', ')}</p>)}
                  {k.policy?.kind === 'page_receiver' && <p className="text-xs text-gray-400 break-all">Owner chat {k.policy.ownerChatId} · sender {k.policy.ownerSenderId}</p>}
                  <p className="text-xs text-gray-500 break-words">Tạo: {formatTime(k.createdAt)} · Dùng gần nhất: {formatTime(k.lastUsedAt)}</p>
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

      <Card title="Cấu hình cho bot legacy">
        <p className="text-xs text-amber-500">Mẫu cũ chỉ dành cho legacy. Không gộp receiver vào cấu hình, .env hay MCP của runner; mỗi role giữ khoá và cấu hình riêng.</p>
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
            <p className="text-xs text-amber-500 leading-relaxed">Khoá chỉ hiện một lần — sao chép và lưu đúng cấu hình riêng của role.</p>
            {rawKey.policy && <p className="text-xs text-gray-400 break-words">{rawKey.policy.kind === 'page_receiver' ? 'Receiver xác nhận: lưu riêng, không đưa vào cấu hình/.env/MCP của runner. Cần kiểm chứng cách ly trước khi bật ghi.' : 'Runner chuẩn bị nháp: chỉ lưu vào cấu hình runner, không kèm khoá receiver.'}</p>}
            <CodeBox text={rawKey.key} onCopy={copy} label="Sao chép khoá" />
            <div className="flex justify-end">
              <button type="button" className="btn-primary" autoFocus onClick={closeKeyModal}>Đã lưu, đóng</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
