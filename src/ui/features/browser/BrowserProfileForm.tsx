import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { CloseIcon, RefreshIcon } from '@/components/common/icons';
import type { BrowserProfile, BrowserProfileGroup } from '../../../models/browserProfile';

export interface ProxyOption {
  id: number;
  name: string;
  type: string;
  host: string;
  port: number;
}

const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'vi-VN', label: 'Tiếng Việt (vi-VN)' },
  { value: 'en-US', label: 'English - US (en-US)' },
  { value: 'en-GB', label: 'English - UK (en-GB)' },
  { value: 'th-TH', label: 'ไทย (th-TH)' },
  { value: 'id-ID', label: 'Indonesia (id-ID)' },
  { value: 'zh-CN', label: '中文 (zh-CN)' },
  { value: 'ja-JP', label: '日本語 (ja-JP)' },
  { value: 'ko-KR', label: '한국어 (ko-KR)' },
];

const DEFAULT_LANGUAGE = 'vi-VN';
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';

interface Props {
  /** Profile being edited; undefined when creating. */
  profile?: BrowserProfile;
  groups: BrowserProfileGroup[];
  proxies: ProxyOption[];
  /** Fingerprint fields are locked while the browser is open. */
  running: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function BrowserProfileForm({ profile, groups, proxies, running, onClose, onSaved }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [name, setName] = useState(profile?.name || '');
  const [groupId, setGroupId] = useState<string>(profile?.group_id != null ? String(profile.group_id) : '');
  const [proxyId, setProxyId] = useState<string>(profile?.proxy_id != null ? String(profile.proxy_id) : '');
  const [language, setLanguage] = useState(profile?.fingerprint.language || DEFAULT_LANGUAGE);
  const [timezone, setTimezone] = useState(profile?.fingerprint.timezone || DEFAULT_TIMEZONE);
  const [note, setNote] = useState(profile?.note || '');
  const [regenerate, setRegenerate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const timezones = useMemo<string[]>(() => {
    try {
      return (Intl as any).supportedValuesOf('timeZone');
    } catch {
      return [DEFAULT_TIMEZONE];
    }
  }, []);
  const languageOptions = LANGUAGES.some((l) => l.value === language) ? LANGUAGES : [...LANGUAGES, { value: language, label: language }];

  // Escape dismisses the confirm dialog first, not this modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirming) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, confirming]);

  const handleRegenerate = async () => {
    setConfirming(true);
    const confirmed = await showConfirm({
      title: 'Tạo lại fingerprint?',
      message: 'Các website sẽ thấy profile này như một thiết bị mới. Tài khoản đang đăng nhập có thể bị yêu cầu xác minh lại.',
      confirmText: 'Tạo lại',
      variant: 'warning',
    });
    setConfirming(false);
    if (confirmed) setRegenerate(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Tên profile không được để trống');
      return;
    }
    setSaving(true);
    setError('');
    const common = {
      name: name.trim(),
      groupId: groupId ? Number(groupId) : null,
      proxyId: proxyId ? Number(proxyId) : null,
      note,
    };
    let res;
    if (!profile) {
      res = await ipc.browserProfile?.create({ ...common, language, timezone });
    } else {
      const fingerprintChanged = language !== profile.fingerprint.language || timezone !== profile.fingerprint.timezone;
      res = await ipc.browserProfile?.update(profile.id, {
        ...common,
        ...(fingerprintChanged ? { language, timezone } : {}),
        ...(regenerate ? { regenerateFingerprint: true } : {}),
      });
    }
    setSaving(false);
    if (res?.success) {
      showNotification(profile ? 'Đã cập nhật profile' : 'Đã tạo profile', 'success');
      onSaved();
    } else {
      setError(res?.error || 'Lưu profile thất bại');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={profile ? 'Sửa profile' : 'Tạo profile'}
        className="w-full max-w-md max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-xl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">{profile ? `Sửa "${profile.name}"` : 'Tạo profile mới'}</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label htmlFor="bp-name" className="text-xs text-gray-400 mb-1 block">Tên profile</label>
            <input id="bp-name" className="input-field text-sm w-full" placeholder="VD: FB Sale 01" maxLength={100} autoFocus
              value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bp-group" className="text-xs text-gray-400 mb-1 block">Nhóm</label>
              <select id="bp-group" className="input-field text-sm w-full" value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={saving}>
                <option value="">Không nhóm</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bp-proxy" className="text-xs text-gray-400 mb-1 block">Proxy</label>
              <select id="bp-proxy" className="input-field text-sm w-full" value={proxyId} onChange={(e) => setProxyId(e.target.value)} disabled={saving || running}>
                <option value="">Không proxy (dùng mạng của máy)</option>
                {proxies.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.type.toUpperCase()} {p.host}:{p.port}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="bp-language" className="text-xs text-gray-400 mb-1 block">Ngôn ngữ</label>
              <select id="bp-language" className="input-field text-sm w-full" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={saving || running}>
                {languageOptions.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="bp-timezone" className="text-xs text-gray-400 mb-1 block">Múi giờ</label>
              <input id="bp-timezone" list="bp-timezones" className="input-field text-sm w-full" value={timezone}
                onChange={(e) => setTimezone(e.target.value)} disabled={saving || running} />
              <datalist id="bp-timezones">
                {timezones.map((tz) => <option key={tz} value={tz} />)}
              </datalist>
            </div>
          </div>
          <p className="text-[11px] text-gray-400">Nên chọn ngôn ngữ và múi giờ khớp với vị trí của proxy.</p>

          <div>
            <label htmlFor="bp-note" className="text-xs text-gray-400 mb-1 block">Ghi chú</label>
            <textarea id="bp-note" className="input-field text-sm w-full" rows={2} maxLength={1000}
              value={note} onChange={(e) => setNote(e.target.value)} disabled={saving} />
          </div>

          {profile && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-700 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs text-gray-200">Fingerprint</p>
                <p className="text-[11px] text-gray-400 truncate">
                  {regenerate ? 'Sẽ tạo fingerprint mới khi lưu' : `Seed ${profile.fingerprint.seed} · ${profile.fingerprint.hardwareConcurrency} nhân CPU`}
                </p>
              </div>
              <button type="button" onClick={handleRegenerate} disabled={saving || running || regenerate}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-600 text-gray-300 hover:border-blue-500 hover:text-blue-400 disabled:opacity-50">
                <RefreshIcon className="w-3.5 h-3.5" /> Tạo lại
              </button>
            </div>
          )}
          {profile && running && (
            <p className="text-[11px] text-yellow-400">Profile đang mở: đóng trình duyệt để đổi proxy, ngôn ngữ, múi giờ hoặc fingerprint.</p>
          )}

          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:bg-gray-700">Hủy</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-1.5 text-white disabled:opacity-60">
              {saving ? 'Đang lưu...' : profile ? 'Lưu' : 'Tạo profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
