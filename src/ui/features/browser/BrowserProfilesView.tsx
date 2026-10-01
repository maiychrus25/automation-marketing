import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/PageLoading';
import { CloseIcon, DownloadIcon, EditIcon, FolderIcon, GlobeIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/common/icons';
import BrowserProfileForm, { ProxyOption } from './BrowserProfileForm';
import type { BrowserProfile, BrowserProfileGroup } from '../../../models/browserProfile';

const PAGE_SIZE = 50;
const MAX_RUNNING_PROFILES = 30;

type GroupFilter = 'all' | 'none' | number;

interface EngineState {
  supported: boolean;
  installed: boolean;
  version: string;
}

function formatTime(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString('vi-VN') : 'Chưa mở';
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// ─── Group manager ───────────────────────────────────────────────────────────
function GroupManager({ groups, onClose, onChanged }: { groups: BrowserProfileGroup[]; onClose: () => void; onChanged: () => void }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const res = await ipc.browserProfile?.saveGroup({ name: name.trim() });
    setSaving(false);
    if (res?.success) {
      setName('');
      onChanged();
    } else {
      showNotification(res?.error || 'Tạo nhóm thất bại', 'error');
    }
  };

  const handleDelete = async (group: BrowserProfileGroup) => {
    const confirmed = await showConfirm({
      title: `Xóa nhóm "${group.name}"?`,
      message: 'Các profile trong nhóm sẽ không bị xóa, chỉ trở về "Không nhóm".',
      confirmText: 'Xóa nhóm',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.browserProfile?.deleteGroup(group.id);
    if (res?.success) onChanged();
    else showNotification(res?.error || 'Xóa nhóm thất bại', 'error');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Quản lý nhóm"
        className="w-full max-w-sm max-h-full overflow-y-auto bg-gray-800 border border-gray-700 rounded-xl shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-semibold text-white">Quản lý nhóm</h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700">
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <form onSubmit={handleAdd} className="flex gap-2">
            <input className="input-field text-sm flex-1 min-w-0" placeholder="Tên nhóm mới" maxLength={100} aria-label="Tên nhóm mới"
              value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
            <button type="submit" disabled={saving || !name.trim()} className="btn-primary text-sm px-3 py-1.5 text-white disabled:opacity-60">Thêm</button>
          </form>
          {groups.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">Chưa có nhóm nào</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((group) => (
                <li key={group.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-900">
                  <span className="text-sm text-gray-200 truncate">{group.name}</span>
                  <button type="button" onClick={() => handleDelete(group)} aria-label={`Xóa nhóm ${group.name}`}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-900/20">
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main view ───────────────────────────────────────────────────────────────
export default function BrowserProfilesView() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [groups, setGroups] = useState<BrowserProfileGroup[]>([]);
  const [proxies, setProxies] = useState<ProxyOption[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [formTarget, setFormTarget] = useState<BrowserProfile | 'new' | null>(null);
  const [showGroups, setShowGroups] = useState(false);

  const load = useCallback(async () => {
    const [listRes, proxyRes, engineRes] = await Promise.all([
      ipc.browserProfile?.list(),
      ipc.proxy?.list(),
      ipc.browserProfile?.engineStatus(),
    ]);
    if (!listRes?.success) {
      setLoadError(listRes?.error || 'Không tải được danh sách profile');
      setLoading(false);
      return;
    }
    setLoadError('');
    setProfiles(listRes.profiles || []);
    setGroups(listRes.groups || []);
    setRunningIds(new Set(listRes.runningIds || []));
    setProxies(proxyRes?.success ? proxyRes.proxies : []);
    if (engineRes?.success) {
      setEngine({ supported: !!engineRes.supported, installed: !!engineRes.installed, version: engineRes.version || '' });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const offStatus = ipc.on?.('browserProfile:statusChanged', (data: { runningIds: string[] }) => {
      setRunningIds(new Set(data?.runningIds || []));
    });
    const offProgress = ipc.on?.('browserProfile:engineProgress', (data: { received: number; total: number }) => {
      setProgress(data);
    });
    return () => {
      offStatus?.();
      offProgress?.();
    };
  }, [load]);

  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const proxyNames = useMemo(() => new Map(proxies.map((p) => [p.id, p.name || `${p.host}:${p.port}`])), [proxies]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (groupFilter === 'none' && p.group_id !== null) return false;
      if (typeof groupFilter === 'number' && p.group_id !== groupFilter) return false;
      if (!keyword) return true;
      return p.name.toLowerCase().includes(keyword) || p.note.toLowerCase().includes(keyword);
    });
  }, [profiles, search, groupFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const allOnPageSelected = pageItems.length > 0 && pageItems.every((p) => selected.has(p.id));
  const selectedIds = profiles.filter((p) => selected.has(p.id)).map((p) => p.id);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of pageItems) {
        if (allOnPageSelected) next.delete(p.id); else next.add(p.id);
      }
      return next;
    });
  };

  const openProfile = async (id: string): Promise<boolean> => {
    setBusy(id, true);
    const res = await ipc.browserProfile?.open(id);
    setBusy(id, false);
    if (!res?.success) showNotification(res?.error || 'Không mở được profile', 'error');
    return !!res?.success;
  };

  const closeProfile = async (id: string) => {
    setBusy(id, true);
    const res = await ipc.browserProfile?.close(id);
    setBusy(id, false);
    if (!res?.success) showNotification(res?.error || 'Không đóng được profile', 'error');
  };

  const handleBulkOpen = async () => {
    setBulkBusy(true);
    for (const id of selectedIds) {
      if (runningIds.has(id)) continue;
      // Stop at the first failure (limit reached, missing engine, dead proxy) instead of repeating the same error.
      if (!(await openProfile(id))) break;
    }
    setBulkBusy(false);
  };

  const handleBulkClose = async () => {
    setBulkBusy(true);
    for (const id of selectedIds) {
      if (runningIds.has(id)) await closeProfile(id);
    }
    setBulkBusy(false);
  };

  const deleteProfiles = async (ids: string[], label: string) => {
    const confirmed = await showConfirm({
      title: `Xóa ${label}?`,
      message: 'Toàn bộ dữ liệu trình duyệt của profile (cookie, phiên đăng nhập, lịch sử) sẽ bị xóa vĩnh viễn và không khôi phục được.',
      confirmText: 'Xóa',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.browserProfile?.delete(ids);
    if (!res?.success) {
      showNotification(res?.error || 'Xóa profile thất bại', 'error');
      return;
    }
    const skipped = res.skippedRunning?.length || 0;
    showNotification(
      skipped > 0 ? `Đã xóa ${res.deleted} profile. ${skipped} profile đang mở nên chưa xóa.` : `Đã xóa ${res.deleted} profile`,
      skipped > 0 ? 'warning' : 'success',
    );
    setSelected(new Set());
    load();
  };

  const handleBulkProxy = async (value: string) => {
    if (value === '') return;
    const res = await ipc.browserProfile?.setProxy(selectedIds, value === 'none' ? null : Number(value));
    if (res?.success) {
      showNotification(`Đã cập nhật proxy cho ${res.updated} profile`, 'success');
      load();
    } else {
      showNotification(res?.error || 'Gán proxy thất bại', 'error');
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    setProgress(null);
    const res = await ipc.browserProfile?.installEngine();
    setInstalling(false);
    if (res?.success) {
      setEngine({ supported: !!res.supported, installed: !!res.installed, version: res.version || '' });
      showNotification('Đã cài trình duyệt', 'success');
    } else {
      showNotification(res?.error || 'Tải trình duyệt thất bại', 'error');
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900">
        <Spinner size={6} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-gray-900 p-4 text-center">
        <p role="alert" className="text-sm text-red-400">{loadError}</p>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="btn-primary text-sm px-4 py-1.5 text-white">Thử lại</button>
      </div>
    );
  }

  const canOpen = !!engine?.installed;

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-200 min-w-0">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-700">
        <div className="min-w-0">
          <h1 className="text-base font-semibold text-white flex items-center gap-2">
            <GlobeIcon className="w-4 h-4" /> Trình duyệt
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {profiles.length} profile · {runningIds.size}/{MAX_RUNNING_PROFILES} đang mở
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowGroups(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400">
            <FolderIcon className="w-4 h-4" /> Nhóm
          </button>
          <button type="button" onClick={() => setFormTarget('new')} className="btn-primary text-sm flex items-center gap-1.5 px-3 py-1.5 text-white">
            <PlusIcon className="w-4 h-4" /> Tạo profile
          </button>
        </div>
      </div>

      {/* Engine state */}
      {engine && !engine.supported && (
        <div role="alert" className="mx-4 mt-3 px-3 py-2 rounded-lg border border-yellow-500/40 bg-yellow-900/20 text-xs text-yellow-300">
          Hệ điều hành này chưa được hỗ trợ. Tính năng Trình duyệt hiện chỉ chạy trên Windows và Linux.
        </div>
      )}
      {engine && engine.supported && !engine.installed && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg border border-blue-500/40 bg-blue-900/20 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-200">
            Cần tải nhân trình duyệt (phiên bản {engine.version}, khoảng 190 MB) trước khi mở profile.
          </p>
          <button type="button" onClick={handleInstall} disabled={installing}
            className="btn-primary text-xs flex items-center gap-1.5 px-3 py-1.5 text-white disabled:opacity-60">
            {installing ? <Spinner size={3} /> : <DownloadIcon className="w-3.5 h-3.5" />}
            {installing
              ? progress && progress.total > 0
                ? `Đang tải ${formatMb(progress.received)} / ${formatMb(progress.total)}`
                : 'Đang tải...'
              : 'Tải trình duyệt'}
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="relative flex-1 min-w-[180px]">
          <SearchIcon className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input className="input-field text-sm w-full pl-8" placeholder="Tìm theo tên hoặc ghi chú" aria-label="Tìm profile"
            value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        </div>
        <select className="input-field text-sm w-auto max-w-full" aria-label="Lọc theo nhóm"
          value={String(groupFilter)}
          onChange={(e) => {
            const value = e.target.value;
            setGroupFilter(value === 'all' || value === 'none' ? value : Number(value));
            setPage(0);
          }}>
          <option value="all">Tất cả nhóm</option>
          <option value="none">Không nhóm</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {/* Bulk actions */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mx-4 mb-3 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700">
          <span className="text-xs text-gray-200">Đã chọn {selectedIds.length}</span>
          <button type="button" onClick={handleBulkOpen} disabled={bulkBusy || !canOpen}
            className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-blue-500 disabled:opacity-50">Mở</button>
          <button type="button" onClick={handleBulkClose} disabled={bulkBusy}
            className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-blue-500 disabled:opacity-50">Đóng</button>
          <select className="input-field text-xs w-auto max-w-full" aria-label="Gán proxy cho các profile đã chọn" value="" disabled={bulkBusy}
            onChange={(e) => handleBulkProxy(e.target.value)}>
            <option value="">Gán proxy...</option>
            <option value="none">Không proxy</option>
            {proxies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" onClick={() => deleteProfiles(selectedIds, `${selectedIds.length} profile`)} disabled={bulkBusy}
            className="px-3 py-1 rounded-lg text-xs border border-red-500/50 text-red-400 hover:bg-red-900/20 disabled:opacity-50">Xóa</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-400 hover:text-white">Bỏ chọn</button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-auto px-4">
        {profiles.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <GlobeIcon className="w-8 h-8 mx-auto mb-3" />
            <p className="text-sm font-medium">Chưa có profile nào</p>
            <p className="text-xs mt-1">Mỗi profile là một trình duyệt riêng với fingerprint, cookie và proxy riêng.</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center py-16 text-sm text-gray-400">Không có profile nào khớp bộ lọc</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900 text-xs text-gray-400">
              <tr className="border-b border-gray-700">
                <th className="w-8 py-2 text-left">
                  <input type="checkbox" aria-label="Chọn tất cả trên trang" checked={allOnPageSelected} onChange={togglePage} />
                </th>
                <th className="py-2 text-left font-medium">Tên</th>
                <th className="py-2 text-left font-medium hidden md:table-cell">Nhóm</th>
                <th className="py-2 text-left font-medium hidden md:table-cell">Proxy</th>
                <th className="py-2 text-left font-medium hidden lg:table-cell">Mở gần nhất</th>
                <th className="py-2 text-left font-medium">Trạng thái</th>
                <th className="py-2 text-right font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((profile) => {
                const running = runningIds.has(profile.id);
                const busy = busyIds.has(profile.id);
                return (
                  <tr key={profile.id} className="border-b border-gray-800 hover:bg-gray-800/60">
                    <td className="py-2">
                      <input type="checkbox" aria-label={`Chọn ${profile.name}`} checked={selected.has(profile.id)} onChange={() => toggleOne(profile.id)} />
                    </td>
                    <td className="py-2 pr-2 max-w-[100px] sm:max-w-[220px]">
                      <p className="text-gray-200 truncate" title={profile.name}>{profile.name}</p>
                      {profile.note && <p className="text-[11px] text-gray-400 truncate" title={profile.note}>{profile.note}</p>}
                    </td>
                    <td className="py-2 pr-2 hidden md:table-cell text-gray-400 truncate max-w-[140px]">
                      {profile.group_id !== null ? groupNames.get(profile.group_id) || '—' : '—'}
                    </td>
                    <td className="py-2 pr-2 hidden md:table-cell truncate max-w-[160px]">
                      {profile.proxy_id !== null
                        ? <span className="text-gray-200">{proxyNames.get(profile.proxy_id) || 'Proxy đã xóa'}</span>
                        : <span className="text-yellow-400">Không proxy</span>}
                    </td>
                    <td className="py-2 pr-2 hidden lg:table-cell text-gray-400 whitespace-nowrap">{formatTime(profile.last_opened_at)}</td>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1.5 text-xs ${running ? 'text-green-400' : 'text-gray-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-green-400' : 'bg-gray-500'}`} />
                        {running ? 'Đang mở' : 'Đã dừng'}
                      </span>
                    </td>
                    <td className="py-2 whitespace-nowrap text-right">
                      {running ? (
                        <button type="button" onClick={() => closeProfile(profile.id)} disabled={busy}
                          className="px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-200 hover:border-red-500 hover:text-red-400 disabled:opacity-50">
                          Đóng
                        </button>
                      ) : (
                        <button type="button" onClick={() => openProfile(profile.id)} disabled={busy || !canOpen}
                          title={canOpen ? 'Mở trình duyệt' : 'Cần tải trình duyệt trước'}
                          className="btn-primary px-3 py-1 text-xs text-white disabled:opacity-50">
                          {busy ? 'Đang mở...' : 'Mở'}
                        </button>
                      )}
                      <button type="button" onClick={() => setFormTarget(profile)} aria-label={`Sửa ${profile.name}`}
                        className="ml-1 p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-900/20 align-middle">
                        <EditIcon className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => deleteProfiles([profile.id], `profile "${profile.name}"`)} disabled={running}
                        aria-label={`Xóa ${profile.name}`} title={running ? 'Đóng profile trước khi xóa' : 'Xóa'}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-900/20 disabled:opacity-40 align-middle">
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-gray-700 text-xs text-gray-400">
          <span>{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} / {filtered.length}</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}
              className="px-3 py-1 rounded-lg border border-gray-600 text-gray-200 disabled:opacity-40">Trước</button>
            <span>Trang {currentPage + 1}/{pageCount}</span>
            <button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount - 1}
              className="px-3 py-1 rounded-lg border border-gray-600 text-gray-200 disabled:opacity-40">Sau</button>
          </div>
        </div>
      )}

      {formTarget && (
        <BrowserProfileForm
          profile={formTarget === 'new' ? undefined : formTarget}
          groups={groups}
          proxies={proxies}
          running={formTarget !== 'new' && runningIds.has(formTarget.id)}
          onClose={() => setFormTarget(null)}
          onSaved={() => { setFormTarget(null); load(); }}
        />
      )}
      {showGroups && <GroupManager groups={groups} onClose={() => setShowGroups(false)} onChanged={load} />}
    </div>
  );
}
