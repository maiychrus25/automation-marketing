import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { toLocalMediaUrl } from '@/lib/localMedia';

export type FacebookPageItem = {
  profileId: string;
  name: string;
  delegatePageId: string | null;
  avatarUrl: string | null;
  enabled: boolean;
};

/** Danh sách Page mà tài khoản Facebook cá nhân quản trị; bật Page để thành tài khoản con. */
export default function FacebookPagesPanel({ accountId, initialPages }: { accountId: string; initialPages?: FacebookPageItem[] }) {
  const [pages, setPages] = useState<FacebookPageItem[] | null>(initialPages ?? null);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const setAccounts = useAccountStore((s) => s.setAccounts);

  const load = useCallback(async () => {
    setPages(null);
    setLoadError('');
    try {
      const res = await ipc.fb?.listPages({ accountId });
      if (res?.success) setPages(res.pages || []);
      else setLoadError(res?.error || 'Không tải được danh sách Page');
    } catch (err: any) {
      setLoadError(err?.message || 'Không tải được danh sách Page');
    }
  }, [accountId]);

  useEffect(() => {
    if (!initialPages) load();
  }, [load, initialPages]);

  const toggle = async (page: FacebookPageItem) => {
    const next = !page.enabled;
    setBusyId(page.profileId);
    setRowError((e) => ({ ...e, [page.profileId]: '' }));
    try {
      const res = await ipc.fb?.setPageEnabled({ accountId, profileId: page.profileId, enabled: next });
      if (res?.success) {
        setPages((list) => list && list.map((p) => (p.profileId === page.profileId ? { ...p, enabled: next } : p)));
        const acc = await ipc.login?.getAccounts();
        if (acc?.accounts) setAccounts(acc.accounts);
      } else {
        setRowError((e) => ({ ...e, [page.profileId]: res?.error || 'Thao tác thất bại' }));
      }
    } catch (err: any) {
      setRowError((e) => ({ ...e, [page.profileId]: err?.message || 'Thao tác thất bại' }));
    } finally {
      setBusyId(null);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-400">{loadError}</p>
        <button type="button" onClick={load} className="text-sm text-blue-400 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35 rounded">
          Thử lại
        </button>
      </div>
    );
  }

  if (!pages) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Đang tải danh sách Page">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <span className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
            <span className="h-3 flex-1 rounded bg-gray-700" />
          </div>
        ))}
      </div>
    );
  }

  if (pages.length === 0) {
    return <p className="text-sm text-gray-400">Tài khoản này chưa quản trị Page nào</p>;
  }

  return (
    <ul className="space-y-1">
      {pages.map((page) => (
        <li key={page.profileId} className="py-1.5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-8 h-8 rounded-full overflow-hidden bg-gray-700 flex-shrink-0">
              {page.avatarUrl && <img src={toLocalMediaUrl(page.avatarUrl)} alt="" className="w-full h-full object-cover" />}
            </span>
            <span className="flex-1 min-w-0 truncate text-sm text-gray-200" title={page.name}>{page.name}</span>
            <button
              type="button"
              role="switch"
              aria-checked={page.enabled}
              aria-label={`${page.enabled ? 'Tắt' : 'Bật'} Page ${page.name}`}
              disabled={busyId !== null}
              onClick={() => toggle(page)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/35 ${
                page.enabled ? 'bg-blue-600' : 'bg-gray-600'
              }`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                page.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`} />
            </button>
          </div>
          {rowError[page.profileId] && <p className="text-xs text-red-400 mt-1 ml-11">{rowError[page.profileId]}</p>}
        </li>
      ))}
    </ul>
  );
}
