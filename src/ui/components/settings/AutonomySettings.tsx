import React, { useCallback, useEffect, useState } from 'react';
import type { AutonomyPolicy } from '../../../services/autonomy/autonomyPolicy';
import type { PolicyChange } from '../../../services/autonomy/AutonomyLimiter';
import type { AutonomyStatus } from '../../../services/autonomy/autonomyOperations';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';
import { Spinner } from '../common/PageLoading';
import { BotIcon, RefreshIcon } from '../common/icons';
import { Card } from './controlApiParts';
import { policyFieldLabel, buildPolicyRows, buildProfileRows, buildWorkspaceRows, confirmThenCall, fieldFromError, type PolicyFieldKey } from './autonomyView';

const DAY_MS = 86_400_000;
const formatTime = (ms: number) => new Date(ms).toLocaleString('vi-VN');
const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';

const showValue = (v: unknown) => (typeof v === 'boolean' ? (v ? 'bật' : 'tắt') : String(v));

export default function AutonomySettings() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [status, setStatus] = useState<AutonomyStatus | null>(null);
  const [changes, setChanges] = useState<PolicyChange[]>([]);
  const [protectedWrites, setProtectedWrites] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [fieldError, setFieldError] = useState<{ field: PolicyFieldKey; message: string } | null>(null);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [s, c, cfg, profs] = await Promise.all([
        ipc.autonomy?.status(),
        ipc.autonomy?.changes(Date.now() - 30 * DAY_MS),
        ipc.controlApi?.getConfig().catch(() => undefined),
        ipc.browserProfile?.list().catch(() => undefined),
      ]);
      if (!s?.success || !s.status) { setLoadError(s?.error || 'Không tải được trạng thái tự vận hành'); return; }
      setStatus(s.status);
      setChanges(c?.success ? c.changes || [] : []);
      setProtectedWrites(cfg?.success ? cfg.protectedWritesEnabled === true : null);
      setNames(Object.fromEntries((profs?.success ? profs.profiles || [] : []).map((p) => [p.id, p.name])));
      setDraft({});
    } catch (e: any) {
      setLoadError(e?.message || 'Không tải được trạng thái tự vận hành');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const apply = async (patch: Partial<AutonomyPolicy>, okText: string) => {
    setBusy(true);
    setFieldError(null);
    setFormError('');
    try {
      const res = await ipc.autonomy?.setConfig(patch);
      if (res?.success) { showNotification(okText, 'success'); await load(); return true; }
      const found = fieldFromError(res?.error);
      if (found) setFieldError(found); else setFormError(res?.error || 'Không lưu được');
    } catch (e: any) {
      setFormError(e?.message || 'Không lưu được');
    } finally {
      setBusy(false);
    }
    return false;
  };

  const stop = async () => {
    setBusy(true);
    try {
      const out = await confirmThenCall(
        () => showConfirm({ title: 'Dừng khẩn tự vận hành?', message: 'Tắt công tắc, huỷ các lượt đang chạy, tắt các lịch do bot tạo và huỷ các bình luận đã duyệt chưa đăng (bình luận đang gửi dở không dừng được). Lịch của anh giữ nguyên.', confirmText: 'Dừng khẩn', variant: 'danger' }),
        () => ipc.autonomy!.stop(),
      );
      if (!out.ran) return;
      if (out.value?.success) { showNotification(`Đã dừng: huỷ ${out.value.cancelledRuns ?? 0} lượt, tắt ${out.value.disabledSchedules ?? 0} lịch${out.value.cancelledEngagement ? `, huỷ ${out.value.cancelledEngagement} bình luận đã duyệt` : ''}`, 'success'); await load(); }
      else showNotification(out.value?.error || 'Không dừng được', 'error');
    } finally { setBusy(false); }
  };

  const resumeProfile = async (profileId: string) => {
    setBusy(true);
    try {
      const res = await ipc.autonomy?.resumeProfile(profileId);
      if (res?.success) { showNotification('Đã bật lại profile', 'success'); await load(); }
      else showNotification(res?.error || 'Không bật lại được', 'error');
    } finally { setBusy(false); }
  };

  if (loading && !status) return <div className="flex justify-center py-10" role="status" aria-label="Đang tải"><Spinner size={6} /></div>;
  if (!status) {
    return (
      <div className="space-y-3 max-w-3xl">
        <p className="text-sm text-red-400 break-words" role="alert">{loadError || 'Không tải được trạng thái tự vận hành'}</p>
        <button type="button" className="btn-secondary" onClick={load}>Thử lại</button>
      </div>
    );
  }

  const rows = buildPolicyRows(status.policy);
  const valueOf = (key: PolicyFieldKey, current: number | string | boolean) => (key in draft ? draft[key] : current);
  const dirty = rows.filter((r) => isDirty(r.key, r.value, draft));
  const save = () => {
    const patch: Record<string, unknown> = {};
    for (const r of dirty) patch[r.key] = r.kind === 'count' ? Number(draft[r.key]) : draft[r.key];
    void apply(patch as Partial<AutonomyPolicy>, 'Đã lưu trần');
  };
  const profiles = buildProfileRows(status, names);
  const badge = !status.enabled ? { text: 'Đã tắt', cls: 'bg-gray-500/20 text-gray-400' }
    : status.quietNow ? { text: 'Bật, đang trong giờ im lặng', cls: 'bg-amber-500/15 text-amber-500' }
    : { text: 'Đang bật', cls: 'bg-green-500/15 text-green-500' };

  return (
    <div className="space-y-4 max-w-3xl min-w-0">
      <div>
        <h2 className="text-base font-semibold text-white flex items-center gap-2"><BotIcon className="w-4 h-4" /> Tự vận hành</h2>
        <p className="text-xs text-gray-400 mt-1 leading-relaxed">Cho bot tự đăng và trả lời trong các trần dưới đây. Thao tác của anh trong app không bị đếm, trừ video. Ngày tính theo múi giờ {status.timeZone}.</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input type="checkbox" role="switch" className="w-4 h-4 accent-blue-600" checked={status.enabled} disabled={busy}
              onChange={(e) => { void apply({ enabled: e.target.checked }, e.target.checked ? 'Đã bật tự vận hành' : 'Đã tắt tự vận hành'); }} />
            Bật tự vận hành
          </label>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.cls}`}>{badge.text}</span>
          <button type="button" onClick={stop} disabled={busy}
            className={`ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 ${FOCUS}`}>Dừng khẩn</button>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          Ghi được bảo vệ (bot đăng và trả lời trên Facebook): <strong className={protectedWrites ? 'text-green-500' : 'text-amber-500'}>{protectedWrites === null ? 'không đọc được' : protectedWrites ? 'đang bật' : 'đang tắt'}</strong>.
          Chỉnh ở tab "Điều khiển từ bot". {protectedWrites === false && 'Khi tắt, bot không đăng hay trả lời dù tự vận hành đang bật.'}
        </p>
        {!status.masterOn && <p className="text-xs text-amber-500">Công tắc tổng của app đang tắt nên bot không chạy việc nào.</p>}
      </Card>

      <Card title="Trần mỗi ngày">
        <div className="space-y-2">
          {rows.map((r) => {
            const id = `autonomy-${r.key}`;
            const err = fieldError?.field === r.key ? fieldError.message : '';
            const v = valueOf(r.key, r.value);
            const atDefault = String(v) === String(r.defaultValue);
            return (
              <div key={r.key} className="grid gap-x-3 gap-y-1 sm:grid-cols-[1fr_7rem_auto] items-center min-w-0">
                <label htmlFor={id} className="text-sm text-gray-200 min-w-0 break-words">
                  {r.label}{r.hint && <span className="block text-xs text-gray-400">{r.hint}</span>}
                </label>
                {r.kind === 'flag'
                  ? <input id={id} type="checkbox" className="w-4 h-4 accent-blue-600" checked={v === true} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.checked })} />
                  : <input id={id} className="input-field w-full" type={r.kind === 'time' ? 'time' : 'number'} min={r.min} max={r.max} value={String(v)} aria-invalid={!!err} aria-describedby={err ? `${id}-err` : undefined}
                      onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} />}
                <button type="button" className={`text-xs text-blue-400 hover:underline disabled:opacity-40 disabled:no-underline whitespace-nowrap justify-self-start ${FOCUS}`} disabled={atDefault}
                  onClick={() => setDraft({ ...draft, [r.key]: r.kind === 'count' ? String(r.defaultValue) : r.defaultValue as string | boolean })}
                  aria-label={`${r.label}: về mặc định (${String(r.defaultValue)})`}>Về mặc định ({typeof r.defaultValue === 'boolean' ? (r.defaultValue ? 'bật' : 'tắt') : String(r.defaultValue)})</button>
                {err && <p id={`${id}-err`} role="alert" className="text-xs text-red-400 break-words sm:col-span-3">{err}</p>}
              </div>
            );
          })}
        </div>
        {formError && <p className="text-xs text-red-400 break-words" role="alert">{formError}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={save} disabled={busy || dirty.length === 0}>{busy ? 'Đang lưu…' : 'Lưu trần'}</button>
          <button type="button" className="btn-secondary" onClick={() => { setDraft({}); setFieldError(null); setFormError(''); }} disabled={busy || dirty.length === 0}>Bỏ thay đổi</button>
        </div>
      </Card>

      <Card title="Hôm nay">
        <div className="flex flex-wrap gap-2">
          {buildWorkspaceRows(status).map((w) => (
            <span key={w.key} className="px-2.5 py-1 rounded-lg bg-gray-900/60 text-xs text-gray-200">{w.label}: {w.used}/{w.cap} <span className="text-gray-400">(còn {w.remaining})</span></span>
          ))}
          <button type="button" className={`text-xs text-blue-400 hover:underline flex items-center gap-1 ${FOCUS}`} onClick={load} disabled={loading}><RefreshIcon className="w-3.5 h-3.5" /> Tải lại</button>
        </div>
        {profiles.length === 0 ? <p className="text-xs text-gray-400">Hôm nay chưa có profile nào dùng đến trần.</p> : (
          <ul className="space-y-2">
            {profiles.map((p) => (
              <li key={p.profileId} className="rounded-lg border border-gray-700 p-3 space-y-2 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-gray-200 truncate max-w-full" title={p.profileId}>{p.name}</span>
                  {p.paused && <span className="px-2 py-0.5 rounded-full text-xs bg-red-500/15 text-red-400">Đang dừng</span>}
                </div>
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  {p.cells.map((c) => (
                    <div key={c.key} className="min-w-0"><dt className="text-gray-400">{c.label}</dt><dd className={c.remaining === 0 ? 'text-amber-500' : 'text-gray-200'}>{c.used}/{c.cap}</dd></div>
                  ))}
                </dl>
                {p.paused && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-red-400 break-words min-w-0 flex-1 basis-[12rem]">{p.paused.reasonLabel} · từ {formatTime(p.paused.pausedAt)}. Xử lý trên Facebook rồi bật lại.</p>
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void resumeProfile(p.profileId); }}>Bật lại</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Lịch sử đổi chính sách (30 ngày)">
        {changes.length === 0 ? <p className="text-xs text-gray-400">Chưa có thay đổi nào trong 30 ngày qua.</p> : (
          <ul className="space-y-1 text-xs text-gray-300">
            {[...changes].sort((a, b) => b.at - a.at).map((c, i) => (
              <li key={`${c.at}-${c.field}-${i}`} className="break-words">
                <span className="text-gray-400">{formatTime(c.at)}</span> · {c.actor === 'app' ? 'Anh (trong app)' : `Bot (${c.actor})`} · {policyFieldLabel(c.field)}: {showValue(c.before)} → {showValue(c.after)}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function isDirty(key: string, current: unknown, draft: Record<string, string | boolean>): boolean {
  return key in draft && String(draft[key]) !== String(current);
}
