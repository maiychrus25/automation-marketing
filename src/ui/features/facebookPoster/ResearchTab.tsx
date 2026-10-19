import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import ResearchProfilesPanel, { type ResearchProfileUsage } from './ResearchProfilesPanel';
import ResearchScanForm from './ResearchScanForm';
import ResearchResultsTable from './ResearchResultsTable';
import { SCAN_STATUS, SOURCE_LABEL, errorLabel, formatCount, formatTime } from './researchFormat';
import type { ResearchScan } from '../../../models/research';

const PAGE_SIZE = 20;

export default function ResearchTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [profiles, setProfiles] = useState<ResearchProfileUsage[]>([]);
  const [scans, setScans] = useState<ResearchScan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [resultsTick, setResultsTick] = useState(0);
  const [progress, setProgress] = useState<{ items: number; profileId: string } | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const pageRef = useRef(page);
  pageRef.current = page;

  const loadProfiles = useCallback(() => {
    ipc.research?.profileUsage().then((res) => {
      if (res?.success) setProfiles(res.profiles || []);
      else showNotification(res?.error || 'Không tải được danh sách profile', 'error');
    }).catch(() => showNotification('Không tải được danh sách profile', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  useEffect(() => {
    let alive = true;
    ipc.research?.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((res) => {
      if (!alive) return;
      if (res?.success) { setScans(res.scans || []); setTotal(res.total ?? 0); }
      else showNotification(res?.error || 'Không tải được danh sách lượt quét', 'error');
    }).catch(() => { if (alive) showNotification('Không tải được danh sách lượt quét', 'error'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, loadTick]);

  useEffect(() => {
    const offProgress = ipc.on?.('research:progress', (data: { items: number; profileId: string }) => setProgress({ items: data.items, profileId: data.profileId }));
    const offFinished = ipc.on?.('research:finished', () => {
      setProgress(null);
      setLoadTick((n) => n + 1);
      setResultsTick((n) => n + 1);
      loadProfiles();
    });
    return () => { offProgress?.(); offFinished?.(); };
  }, [loadProfiles]);

  const running = scans.some((s) => s.status === 'running');
  const profileName = progress ? profiles.find((p) => p.id === progress.profileId)?.name : undefined;
  const progressText = progress ? `Đã thu ${formatCount(progress.items)} mục${profileName ? ` · profile ${profileName}` : ''}` : '';
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4 min-w-0">
      <ResearchProfilesPanel profiles={profiles} onChanged={loadProfiles} />
      <ResearchScanForm running={running} progressText={progressText}
        onStarted={(id) => { setPage(0); setSelected(id); setLoadTick((n) => n + 1); setResultsTick((n) => n + 1); loadProfiles(); }} />
      <section aria-label="Lượt quét" className="space-y-2 min-w-0">
        <h3 className="text-sm font-medium text-white">Lượt quét</h3>
        {scans.length === 0 ? <p className="text-sm text-gray-400 py-4">Chưa có lượt quét nào.</p> : (
          <ul className="space-y-1.5">
            {scans.map((s) => {
              const st = SCAN_STATUS[s.status];
              const active = selected === s.id;
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => setSelected(active ? null : s.id)} aria-pressed={active}
                    className={`w-full text-left rounded-lg border px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs min-w-0 ${active ? 'border-blue-400' : 'border-gray-700 hover:border-gray-500'}`}>
                    <span className="text-sm text-gray-200">{SOURCE_LABEL[s.source]}</span>
                    {s.query && <span className="text-gray-300 truncate max-w-[14rem]" title={s.query}>{s.query}</span>}
                    <span className="text-gray-400 whitespace-nowrap">{formatTime(s.startedAt)}</span>
                    <span className="text-gray-400 whitespace-nowrap">{formatCount(s.itemCount)} mục</span>
                    <span className={`whitespace-nowrap ${st.cls}`}>{st.label}</span>
                    {s.errorCode && <span className="text-red-400 whitespace-nowrap">{errorLabel(s.errorCode)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 text-xs text-gray-400">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Trước</button>
            <span>Trang {page + 1}/{pageCount}</span>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Sau</button>
          </div>
        )}
      </section>
      {selected && <ResearchResultsTable scanId={selected} reloadKey={resultsTick} />}
    </div>
  );
}
