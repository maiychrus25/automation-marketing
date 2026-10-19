import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { SCAN_STATUS, SOURCE_LABEL, errorLabel, formatCount, formatRate, formatTime } from './researchFormat';
import type { ResearchItem, ResearchScan, ResearchSort } from '../../../models/research';

const PAGE_SIZE = 50;
const openLink = (url: string) => { if (ipc.shell?.openExternal) ipc.shell.openExternal(url); else window.open(url, '_blank'); };

const LinkBtn = ({ url, children, label }: { url: string; children: React.ReactNode; label?: string }) => (
  <button type="button" onClick={() => openLink(url)} title={url} aria-label={label} className="text-blue-400 hover:underline text-left">{children}</button>
);

interface Props { scanId: string; reloadKey: number }

export default function ResearchResultsTable({ scanId, reloadKey }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [scan, setScan] = useState<ResearchScan | null>(null);
  const [items, setItems] = useState<ResearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<ResearchSort>('engagement');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { setPage(0); setSort('engagement'); }, [scanId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    ipc.research?.get({ scanId, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((res) => {
      if (!alive) return;
      if (res?.success) { setScan(res.scan ?? null); setItems(res.items || []); setTotal(res.total ?? 0); }
      else showNotification(res?.error || 'Không tải được kết quả', 'error');
    }).catch(() => { if (alive) showNotification('Không tải được kết quả', 'error'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanId, sort, page, reloadKey]);

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const res = await ipc.research?.exportXlsx(scanId);
      if (!res?.success) showNotification(res?.error || 'Không xuất được Excel', 'error');
      else if (res.saved && res.path) showNotification(`Đã xuất Excel: ${res.path}`, 'success');
    } catch (err: any) { showNotification(err?.message || 'Không xuất được Excel', 'error'); } finally { setExporting(false); }
  };

  const shape = Array.isArray((scan?.details as any)?.shape) ? ((scan!.details as any).shape as string[]) : [];
  const copyShape = () => {
    navigator.clipboard?.writeText(shape.join('\n')).then(
      () => showNotification('Đã sao chép chẩn đoán', 'success'),
      () => showNotification('Không sao chép được', 'error'));
  };

  const kind = scan?.source === 'groups' ? 'group' : scan?.source === 'pages' ? 'page' : 'post';
  const sortOptions: { value: ResearchSort; label: string }[] = kind === 'post'
    ? [{ value: 'engagement', label: 'Tương tác cao nhất' }, { value: 'recent', label: 'Mới nhất' }]
    : [{ value: 'members', label: kind === 'group' ? 'Nhiều thành viên nhất' : 'Nhiều người theo dõi nhất' }, { value: 'recent', label: 'Mới nhất' }];
  const effectiveSort = sortOptions.some((o) => o.value === sort) ? sort : sortOptions[0].value;
  useEffect(() => { if (scan && effectiveSort !== sort) setSort(effectiveSort); }, [scan, effectiveSort, sort]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const th = 'px-2 py-1.5 text-left text-xs font-medium text-gray-400 whitespace-nowrap';
  const td = 'px-2 py-1.5 text-xs text-gray-200 align-top';

  return (
    <section aria-label="Kết quả" className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium text-white">Kết quả{scan ? ` · ${SOURCE_LABEL[scan.source]}${scan.query ? ` · ${scan.query}` : ''}` : ''}</h3>
        <label htmlFor="research-sort" className="text-xs text-gray-400">Sắp xếp{' '}
          <select id="research-sort" className="input-field text-xs" value={effectiveSort} onChange={(e) => { setSort(e.target.value as ResearchSort); setPage(0); }}>
            {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={exportXlsx} disabled={exporting || total === 0} className="px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">Xuất Excel</button>
      </div>
      {scan && scan.error && <p className="text-xs text-red-400 break-words">{scan.errorCode ? `${errorLabel(scan.errorCode)}: ` : ''}{scan.error}</p>}
      {scan && <p className="text-xs text-gray-400"><span className={SCAN_STATUS[scan.status].cls}>{SCAN_STATUS[scan.status].label}</span> · {formatCount(total)} mục</p>}
      {loading && items.length === 0 ? <div className="flex justify-center py-6"><Spinner size={5} /></div>
        : items.length === 0 ? <p className="text-sm text-gray-400 text-center py-6">Chưa có kết quả.</p> : (
          <div className="overflow-x-auto rounded-lg border border-gray-700 max-w-full">
            <table className="min-w-full text-left">
              <thead className="border-b border-gray-700">
                {kind === 'post' ? (
                  <tr><th className={th}>Nội dung</th><th className={th}>Nơi đăng</th><th className={th}>Người đăng</th><th className={th}>Cảm xúc</th><th className={th}>Bình luận</th><th className={th}>Chia sẻ</th><th className={th}>Tương tác</th><th className={th}>Tỉ lệ</th><th className={th}>Thời gian</th><th className={th}>Bài</th></tr>
                ) : kind === 'group' ? (
                  <tr><th className={th}>Tên nhóm</th><th className={th}>Quyền riêng tư</th><th className={th}>Thành viên</th><th className={th}>Link</th></tr>
                ) : (
                  <tr><th className={th}>Tên trang</th><th className={th}>Người theo dõi</th><th className={th}>Link</th></tr>
                )}
              </thead>
              <tbody className="divide-y divide-gray-800">
                {items.map((it) => kind === 'post' ? (
                  <tr key={it.id}>
                    <td className={`${td} max-w-[18rem]`}><span className="block truncate" title={it.title}>{it.title || '—'}</span></td>
                    <td className={`${td} max-w-[10rem]`}><span className="block truncate" title={it.placeName}>{it.placeName || '—'}</span></td>
                    <td className={`${td} max-w-[10rem]`}>{it.authorName ? (it.authorUrl ? <LinkBtn url={it.authorUrl}><span className="block truncate max-w-[10rem]">{it.authorName}</span></LinkBtn> : <span className="block truncate" title={it.authorName}>{it.authorName}</span>) : '—'}</td>
                    <td className={td}>{formatCount(it.reactions)}</td>
                    <td className={td}>{formatCount(it.comments)}</td>
                    <td className={td}>{formatCount(it.shares)}</td>
                    <td className={td}>{formatCount(it.engagement)}</td>
                    <td className={td}>{formatRate(it.engagementRate)}</td>
                    <td className={`${td} whitespace-nowrap`}>{formatTime(it.postedAt)}</td>
                    <td className={td}>{it.url ? <LinkBtn url={it.url} label="Mở bài">Mở bài</LinkBtn> : '—'}</td>
                  </tr>
                ) : kind === 'group' ? (
                  <tr key={it.id}>
                    <td className={`${td} max-w-[18rem]`}><span className="block truncate" title={it.title}>{it.title || '—'}</span></td>
                    <td className={td}>{it.privacy === 'public' ? 'Công khai' : it.privacy === 'private' ? 'Riêng tư' : '—'}</td>
                    <td className={td}>{formatCount(it.memberCount)}</td>
                    <td className={td}>{it.url ? <LinkBtn url={it.url} label="Mở nhóm">Mở nhóm</LinkBtn> : '—'}</td>
                  </tr>
                ) : (
                  <tr key={it.id}>
                    <td className={`${td} max-w-[18rem]`}><span className="block truncate" title={it.title}>{it.title || '—'}</span></td>
                    <td className={td}>{formatCount(it.followerCount)}</td>
                    <td className={td}>{it.url ? <LinkBtn url={it.url} label="Mở trang">Mở trang</LinkBtn> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-xs text-gray-400">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Trước</button>
          <span>Trang {page + 1}/{pageCount}</span>
          <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Sau</button>
        </div>
      )}
      {shape.length > 0 && (
        <details className="rounded-lg border border-gray-700 px-3 py-2">
          <summary className="text-xs text-gray-300 cursor-pointer">Chẩn đoán (gửi cho kỹ thuật)</summary>
          <pre className="mt-2 text-xs text-gray-400 whitespace-pre-wrap break-all max-h-60 overflow-auto">{shape.join('\n')}</pre>
          <button type="button" onClick={copyShape} className="mt-2 px-3 py-1 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400">Sao chép</button>
        </details>
      )}
    </section>
  );
}
