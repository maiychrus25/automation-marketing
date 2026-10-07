import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import type { FbPosterRun, FbPosterResult } from '../../../models/facebookPoster';

const PAGE_SIZE = 50;

const KIND_LABEL: Record<string, string> = { post: 'Đăng bài', join: 'Tham gia nhóm', scan_groups: 'Quét nhóm', collect_comments: 'Thu bình luận' };
const MODE_LABEL: Record<string, string> = { group: 'Nhóm', page: 'Page' };
export const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  running: { label: 'Đang chạy', cls: 'text-blue-400' },
  done: { label: 'Xong', cls: 'text-green-400' },
  cancelled: { label: 'Đã hủy', cls: 'text-orange-400' },
  failed: { label: 'Lỗi', cls: 'text-red-400' },
  missed: { label: 'Đã lỡ', cls: 'text-orange-400' },
};
const OUTCOME_LABEL: Record<string, { label: string; cls: string }> = {
  posted: { label: 'Đã đăng', cls: 'text-green-400' },
  failed: { label: 'Lỗi', cls: 'text-red-400' },
  skipped: { label: 'Bỏ qua', cls: 'text-orange-400' },
  joined: { label: 'Đã vào', cls: 'text-green-400' },
  pending: { label: 'Chờ duyệt', cls: 'text-yellow-400' },
  unknown: { label: 'Không rõ', cls: 'text-gray-400' },
  done: { label: 'Xong', cls: 'text-green-400' },
};
const COMMENT_STATUS_LABEL: Record<string, string> = {
  not_requested: '—',
  posted: 'Đã bình luận',
  no_post_url: 'Không có link bài',
  pending_approval: 'Bài chờ duyệt',
  post_not_found: 'Không thấy bài',
  failed: 'Lỗi bình luận',
};

const openLink = (url: string) => { if (ipc.shell?.openExternal) ipc.shell.openExternal(url); else window.open(url, '_blank'); };
const formatTime = (at: number) => new Date(at).toLocaleString('vi-VN', { hour12: false });

const Chip = ({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) => {
  const chip = map[value] || { label: value, cls: 'text-gray-400' };
  return <span className={`text-xs whitespace-nowrap ${chip.cls}`}>{chip.label}</span>;
};

const countOutcomes = (results: FbPosterResult[]): string => {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) || 0) + 1);
  return [...counts].map(([outcome, n]) => `${OUTCOME_LABEL[outcome]?.label || outcome}: ${n}`).join(' · ') || 'Chưa có kết quả';
};

export default function HistoryTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [runs, setRuns] = useState<FbPosterRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, FbPosterResult[]>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    const off = ipc.on?.('facebookPoster:runFinished', () => {
      setDetails({}); // counts of a finished run must be refetched
      setReloadTick((n) => n + 1);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    ipc.facebookPoster?.listRuns({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((res) => {
      if (cancelled) return;
      if (res?.success) { setRuns(res.runs || []); setTotal(res.total ?? 0); }
      else showNotification(res?.error || 'Không tải được lịch sử', 'error');
    }).catch(() => { if (!cancelled) showNotification('Không tải được lịch sử', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; setLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, reloadTick]);

  // Results are fetched lazily, only when a run is expanded.
  useEffect(() => {
    if (!expanded || details[expanded]) return;
    let cancelled = false;
    setDetailLoading(true);
    ipc.facebookPoster?.getRun(expanded).then((res) => {
      if (cancelled) return;
      if (res?.success) setDetails((prev) => ({ ...prev, [expanded]: res.results || [] }));
      else showNotification(res?.error || 'Không tải được chi tiết', 'error');
    }).catch(() => { if (!cancelled) showNotification('Không tải được chi tiết', 'error'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; setDetailLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, details]);

  const exportCsv = async (runId: string) => {
    try {
      const res = await ipc.facebookPoster?.exportRunCsv(runId);
      if (!res?.success) showNotification(res?.error || 'Không xuất được CSV', 'error');
      else if (res.path) showNotification(`Đã xuất CSV: ${res.path}`, 'success');
    } catch (err: any) {
      showNotification(err?.message || 'Không xuất được CSV', 'error');
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading && runs.length === 0) return <div className="flex justify-center py-10"><Spinner size={5} /></div>;
  if (runs.length === 0) return <p className="text-sm text-gray-400 text-center py-10">Chưa có lịch sử.</p>;

  return (
    <div className="space-y-3 min-w-0">
      <ul className="space-y-2" aria-label="Lịch sử chạy">
        {runs.map((run) => {
          const open = expanded === run.id;
          const results = details[run.id];
          const byProfile = new Map<string, FbPosterResult[]>();
          for (const r of results || []) byProfile.set(r.profileName || r.profileId, [...(byProfile.get(r.profileName || r.profileId) || []), r]);
          return (
            <li key={run.id} className="rounded-lg border border-gray-700 min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <button type="button" onClick={() => setExpanded(open ? null : run.id)} aria-expanded={open}
                  className="flex-1 min-w-[12rem] text-left text-sm text-gray-200">
                  {open ? '▾' : '▸'} {formatTime(run.startedAt)} · {KIND_LABEL[run.kind] || run.kind}{run.mode ? ` · ${MODE_LABEL[run.mode] || run.mode}` : ''}
                </button>
                {run.scheduleId && (
                  <span className="text-xs text-gray-400 max-w-[14rem] truncate" title={run.scheduleName ? `Theo lịch: ${run.scheduleName}` : undefined}>
                    {run.scheduleName ? `Theo lịch: ${run.scheduleName}` : 'Theo lịch'}
                  </span>
                )}
                <Chip map={STATUS_LABEL} value={run.status} />
                <button type="button" onClick={() => exportCsv(run.id)} className="px-2.5 py-1 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400">Xuất CSV</button>
              </div>
              {open && (
                <div className="px-3 pb-3 pt-2 border-t border-gray-700 space-y-3 min-w-0">
                  {run.error && <p className="text-xs text-red-400 break-words">{run.error}</p>}
                  {!results ? (detailLoading ? <div className="flex justify-center py-3"><Spinner size={5} /></div> : null) : (
                    <>
                      <p className="text-xs text-gray-400">{countOutcomes(results)}</p>
                      {[...byProfile].map(([name, rows]) => (
                        <div key={name} className="min-w-0">
                          <h4 className="text-sm font-medium text-white truncate" title={name}>{name}</h4>
                          <ul className="divide-y divide-gray-800">
                            {rows.map((r) => (
                              <li key={r.id} className="py-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs min-w-0">
                                <button type="button" onClick={() => openLink(r.targetUrl)} title={r.targetUrl} className="text-blue-400 hover:underline truncate max-w-full text-left">{r.targetName || r.targetUrl}</button>
                                <Chip map={OUTCOME_LABEL} value={r.outcome} />
                                {r.error && <span className="text-red-400 break-words min-w-0">{r.error}</span>}
                                {r.postUrl && <button type="button" onClick={() => openLink(r.postUrl!)} className="text-blue-400 hover:underline whitespace-nowrap">Mở bài</button>}
                                <span className="text-gray-400">{COMMENT_STATUS_LABEL[r.commentStatus] || r.commentStatus}</span>
                                {r.identity && <span className="text-gray-400 break-words min-w-0">{r.identity}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-xs text-gray-400">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Trước</button>
          <span>Trang {page + 1}/{pageCount}</span>
          <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Sau</button>
        </div>
      )}
    </div>
  );
}
