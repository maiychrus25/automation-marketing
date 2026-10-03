import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { SearchIcon } from '@/components/common/icons';
import type { BrowserProfile, BrowserProfileGroup } from '../../../models/browserProfile';

interface Props {
  mode: 'multi' | 'single';
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export default function ProfilePicker({ mode, selected, onChange, disabled }: Props) {
  const setView = useAppStore((s) => s.setView);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [groups, setGroups] = useState<BrowserProfileGroup[]>([]);
  const [proxyNames, setProxyNames] = useState<Map<number, string>>(new Map());
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const [res, proxyRes] = await Promise.all([ipc.browserProfile?.list(), ipc.proxy?.list()]);
      if (!res?.success) {
        setLoadError(res?.error || 'Không tải được danh sách profile');
        return;
      }
      setLoadError('');
      setProfiles(res.profiles || []);
      setGroups(res.groups || []);
      setRunningIds(new Set(res.runningIds || []));
      setProxyNames(new Map((proxyRes?.success ? proxyRes.proxies : []).map((p: any) => [p.id, p.name || `${p.host}:${p.port}`])));
    } catch (err) {
      setLoadError(err instanceof Error && err.message ? err.message : 'Không tải được danh sách profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const off = ipc.on?.('browserProfile:statusChanged', (data: { runningIds: string[] }) => setRunningIds(new Set(data?.runningIds || [])));
    return () => off?.();
  }, [load]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (groupFilter === 'none' && p.group_id !== null) return false;
      if (groupFilter !== 'all' && groupFilter !== 'none' && p.group_id !== Number(groupFilter)) return false;
      return !keyword || p.name.toLowerCase().includes(keyword);
    });
  }, [profiles, search, groupFilter]);

  const toggle = (id: string) => {
    if (mode === 'single') return onChange([id]);
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.includes(p.id));
  const toggleAll = () => {
    const ids = filtered.map((p) => p.id);
    onChange(allFilteredSelected ? selected.filter((s) => !ids.includes(s)) : [...new Set([...selected, ...ids])]);
  };

  if (loading) return <div className="flex justify-center py-6"><Spinner size={5} /></div>;
  if (loadError) {
    return (
      <div className="text-center py-4 space-y-2">
        <p role="alert" className="text-sm text-red-400">{loadError}</p>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="btn-primary text-sm px-4 py-1.5 text-white">Thử lại</button>
      </div>
    );
  }
  if (profiles.length === 0) {
    return (
      <div className="text-center py-4 space-y-2">
        <p className="text-sm text-gray-400">Chưa có profile. Tạo profile ở màn hình Trình duyệt.</p>
        <button type="button" onClick={() => setView('browser')} className="btn-primary text-sm px-4 py-1.5 text-white">Mở màn hình Trình duyệt</button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[140px]">
          <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input className="input-field text-sm w-full pl-8" placeholder="Tìm profile" aria-label="Tìm profile" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input-field text-sm w-auto max-w-full" aria-label="Lọc theo nhóm profile" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="all">Tất cả nhóm</option>
          <option value="none">Không nhóm</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {mode === 'multi' && (
          <button type="button" onClick={toggleAll} disabled={disabled || filtered.length === 0} className="px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">
            {allFilteredSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
          </button>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="text-center py-4 text-sm text-gray-400">Không có profile nào khớp bộ lọc</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-800" role={mode === 'single' ? 'radiogroup' : undefined} aria-label="Danh sách profile">
          {filtered.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-800/60 min-w-0">
                <input type={mode === 'single' ? 'radio' : 'checkbox'} name="fb-poster-profile" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} disabled={disabled} />
                <span className="text-sm text-gray-200 truncate flex-1 min-w-0" title={p.name}>{p.name}</span>
                <span className="text-xs text-gray-400 truncate max-w-[40%] hidden sm:inline">
                  {p.proxy_id !== null ? proxyNames.get(p.proxy_id) || 'Proxy đã xóa' : 'Không proxy'}
                </span>
                {runningIds.has(p.id) && <span className="text-xs text-yellow-400 whitespace-nowrap">Đang mở</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-400">Đã chọn {selected.length} profile</p>
    </div>
  );
}
