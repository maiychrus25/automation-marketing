import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import LoginStateBadge from './LoginStateBadge';
import { formatCount, parseBoundedInt } from './researchFormat';
import type { ResearchConfig } from '../../../services/research/researchConfig';
import type { ProfileLoginState } from '../../../models/facebookPoster';

export interface ResearchProfileUsage { id: string; name: string; itemsLast24h: number; cap: number; loginState: string; excluded: boolean; busy: boolean }

interface Props { profiles: ResearchProfileUsage[]; onChanged: () => void }

export default function ResearchProfilesPanel({ profiles, onChanged }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [config, setConfig] = useState<ResearchConfig | null>(null);
  const [capDraft, setCapDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.research?.getConfig().then((res) => {
      if (!alive) return;
      if (res?.success && res.config) { setConfig(res.config); setCapDraft(String(res.config.perProfileDailyCap)); }
      else showNotification(res?.error || 'Không tải được cấu hình quét', 'error');
    }).catch(() => { if (alive) showNotification('Không tải được cấu hình quét', 'error'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lưu cấu hình; thất bại thì giữ nguyên cấu hình cũ (người dùng thấy ô quay về giá trị cũ).
  const save = async (next: ResearchConfig): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await ipc.research?.setConfig(next);
      if (!res?.success || !res.config) { showNotification(res?.error || 'Không lưu được cấu hình', 'error'); return false; }
      setConfig(res.config);
      setCapDraft(String(res.config.perProfileDailyCap));
      onChanged();
      return true;
    } catch (err: any) {
      showNotification(err?.message || 'Không lưu được cấu hình', 'error');
      return false;
    } finally { setSaving(false); }
  };

  const toggleExcluded = (id: string, excluded: boolean) => {
    if (!config) return;
    const ids = excluded ? [...new Set([...config.excludedProfileIds, id])] : config.excludedProfileIds.filter((x) => x !== id);
    void save({ ...config, excludedProfileIds: ids });
  };

  const saveCap = async () => {
    if (!config) return;
    const cap = parseBoundedInt(capDraft, 50, 5000);
    if (cap === null) { showNotification('Trần mỗi profile/ngày phải từ 50 đến 5000', 'error'); setCapDraft(String(config.perProfileDailyCap)); return; }
    if (cap !== config.perProfileDailyCap) await save({ ...config, perProfileDailyCap: cap });
  };

  return (
    <section aria-label="Profile dùng để quét" className="rounded-lg border border-gray-700 p-3 space-y-3 min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-sm font-medium text-white">Profile dùng để quét</h3>
        <div className="flex items-end gap-2">
          <label htmlFor="research-cap" className="block text-xs text-gray-400">Trần mỗi profile/ngày
            <input id="research-cap" type="number" min={50} max={5000} className="input-field text-sm w-28 mt-1 block" value={capDraft}
              disabled={!config || saving} onChange={(e) => setCapDraft(e.target.value)} />
          </label>
          <button type="button" onClick={saveCap} disabled={!config || saving} className="px-3 py-2 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">Lưu</button>
        </div>
      </div>
      {profiles.length === 0 ? <p className="text-xs text-gray-400">Chưa có profile nào.</p> : (
        <ul className="divide-y divide-gray-800">
          {profiles.map((p) => {
            const state = { profileId: p.id, state: p.loginState, checkedAt: null, source: null, lastError: null, lastErrorAt: null } as ProfileLoginState;
            const checked = config ? config.excludedProfileIds.includes(p.id) : p.excluded;
            return (
              <li key={p.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs min-w-0">
                <span className="text-sm text-gray-200 truncate max-w-[14rem]" title={p.name}>{p.name}</span>
                <LoginStateBadge state={state} />
                <span className="text-gray-400 whitespace-nowrap">Đã quét 24h: {formatCount(p.itemsLast24h)} / {formatCount(p.cap)}</span>
                {p.busy && <span className="text-yellow-400 whitespace-nowrap">Đang bận</span>}
                <label htmlFor={`research-excl-${p.id}`} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
                  <input id={`research-excl-${p.id}`} type="checkbox" checked={checked} disabled={!config || saving} onChange={(e) => toggleExcluded(p.id, e.target.checked)} />
                  Không dùng để quét
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
