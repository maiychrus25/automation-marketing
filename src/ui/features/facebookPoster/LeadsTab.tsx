import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import LeadConfigPopover from './LeadConfigPopover';
import { LEAD_STATUS_OPTIONS, formatLeadMatch, formatLeadTime, leadStatusChip } from './leadFormat';
import type { FbPosterLead, LeadStatus } from '../../../models/facebookPoster';

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;
const NOTE_MAX = 1000;
const RANGES = [{ days: 7, label: '7 ngày' }, { days: 30, label: '30 ngày' }, { days: 90, label: '90 ngày' }];
const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';
const BTN = `px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50 whitespace-nowrap ${FOCUS}`;
const TH = 'px-2 py-1.5 text-left font-medium whitespace-nowrap';
const TD = 'px-2 py-1.5 align-top';

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

export default function LeadsTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [leads, setLeads] = useState<FbPosterLead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [campaignId, setCampaignId] = useState('');
  const [days, setDays] = useState(30);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({});
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const loadSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Link lấy từ dữ liệu Facebook (không tin cậy): tiến trình chính kiểm tra (chỉ https tới facebook.com) rồi mới mở.
  const openLink = (url: string) => {
    ipc.research?.openLink(url).then((res) => {
      if (!res?.success) showNotification(res?.error || 'Không mở được link', 'error');
    }).catch(() => showNotification('Không mở được link', 'error'));
  };

  const campaignNames = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns]);

  // Lọc chữ sau khi ngừng gõ để không gọi DB mỗi phím.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchText.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [searchText]);

  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.campaignList().then((res) => {
      if (!cancelled && res?.success) setCampaigns((res.campaigns ?? []).map((c) => ({ id: c.id, name: c.name })));
    }).catch(() => { /* bộ lọc chiến dịch vẫn dùng được với "Tất cả" */ });
    return () => { cancelled = true; };
  }, []);

  const filter = useCallback(() => ({
    status: status || undefined,
    campaignId: campaignId || undefined,
    from: Date.now() - days * DAY_MS,
    search: search || undefined,
  }), [status, campaignId, days, search]);

  // Chỉ phản hồi của lần gọi mới nhất được ghi vào state; không ghi sau khi tab đã gỡ.
  useEffect(() => {
    const seq = ++loadSeq.current;
    ipc.facebookPoster?.leadList({ ...filter(), limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((res) => {
      if (seq !== loadSeq.current || !alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không tải được khách tiềm năng');
      setLeads(res.leads ?? []);
      setTotal(res.total ?? 0);
      setLoadError('');
    }).catch((err) => {
      if (seq !== loadSeq.current || !alive.current) return;
      setLoadError(errorText(err, 'Không tải được khách tiềm năng'));
    }).finally(() => { if (seq === loadSeq.current && alive.current) setLoading(false); });
  }, [filter, page, reloadTick]);

  useEffect(() => {
    const reload = () => setReloadTick((n) => n + 1);
    const offFound = ipc.on?.('facebookPoster:leadsFound', reload);
    const offProgress = ipc.on?.('facebookPoster:commentCollectProgress', (data: { done: number; total: number }) => {
      setRunning(true);
      setProgress({ done: data.done, total: data.total });
    });
    const offFinished = ipc.on?.('facebookPoster:commentCollectFinished', (data: { auto?: boolean; posts?: number; leads?: number }) => {
      setRunning(false);
      setProgress(null);
      reload();
      if (data && !data.auto) showNotification(`Đã thu ${data.posts ?? 0} bài, có ${data.leads ?? 0} khách mới`, 'info');
    });
    let cancelled = false;
    ipc.facebookPoster?.commentCollectStatus().then((res) => {
      if (cancelled || !res?.success) return;
      setRunning(!!res.running);
      if (res.running && res.progress) setProgress(res.progress);
    }).catch(() => { /* sự kiện tiến độ sẽ cập nhật */ });
    return () => { cancelled = true; offFound?.(); offProgress?.(); offFinished?.(); };
  }, [showNotification]);

  const collectNow = async () => {
    setStarting(true);
    try {
      const res = await ipc.facebookPoster.commentCollect({});
      if (!res?.success) { showNotification(res?.error || 'Không bắt đầu được việc thu bình luận', 'error'); return; }
      if (!res.posts) { showNotification('Chưa có bài nào đến hạn thu bình luận', 'info'); return; }
      setRunning(true);
      setProgress({ done: 0, total: res.posts });
      // Việc có thể đã xong (và đã báo xong) trước khi lời gọi trả về: đọc lại trạng thái để không treo.
      const st = await ipc.facebookPoster.commentCollectStatus();
      if (alive.current && st?.success && !st.running) { setRunning(false); setProgress(null); setReloadTick((n) => n + 1); }
    } catch (err) {
      showNotification(errorText(err, 'Không bắt đầu được việc thu bình luận'), 'error');
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const cancelCollect = async () => {
    try {
      const res = await ipc.facebookPoster.commentCollectCancel();
      if (!res?.success) showNotification(res?.error || 'Không huỷ được', 'error');
    } catch (err) { showNotification(errorText(err, 'Không huỷ được'), 'error'); }
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const res = await ipc.facebookPoster.leadExport(filter());
      if (!res?.success) showNotification(res?.error || 'Không xuất được Excel', 'error');
      else if (res.saved && res.path) showNotification(`Đã xuất Excel: ${res.path}`, 'success');
    } catch (err) { showNotification(errorText(err, 'Không xuất được Excel'), 'error'); }
    finally { if (alive.current) setExporting(false); }
  };

  const patchLocal = (id: number, patch: Partial<FbPosterLead>) => setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  // Đổi trạng thái ngay (lạc quan); lỗi thì trả về trạng thái cũ và báo.
  const changeStatus = async (lead: FbPosterLead, next: LeadStatus) => {
    const previous = lead.status;
    if (next === previous) return;
    patchLocal(lead.id, { status: next });
    try {
      const res = await ipc.facebookPoster.leadUpdate({ id: lead.id, status: next });
      if (!res?.success) throw new Error(res?.error || 'Không cập nhật được trạng thái');
      if (alive.current && res.lead) patchLocal(lead.id, { status: res.lead.status, updatedAt: res.lead.updatedAt });
    } catch (err) {
      if (alive.current) patchLocal(lead.id, { status: previous });
      showNotification(errorText(err, 'Không cập nhật được trạng thái'), 'error');
    }
  };

  const saveNote = async (lead: FbPosterLead) => {
    const draft = noteDrafts[lead.id];
    if (draft === undefined || draft === lead.note) return;
    try {
      const res = await ipc.facebookPoster.leadUpdate({ id: lead.id, note: draft });
      if (!res?.success) throw new Error(res?.error || 'Không lưu được ghi chú');
      if (alive.current) patchLocal(lead.id, { note: draft });
    } catch (err) {
      showNotification(errorText(err, 'Không lưu được ghi chú'), 'error');
    } finally {
      if (alive.current) setNoteDrafts((prev) => { const { [lead.id]: _drop, ...rest } = prev; return rest; });
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const select = `input-field text-xs py-1 ${FOCUS}`;

  return (
    <section aria-label="Khách tiềm năng" className="space-y-3 min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">Trạng thái
          <select className={select} value={status} onChange={(e) => { setStatus(e.target.value as LeadStatus | ''); setPage(0); }}>
            <option value="">Tất cả</option>
            {LEAD_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-400 min-w-0">Chiến dịch
          <select className={`${select} max-w-[10rem]`} value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setPage(0); }}>
            <option value="">Tất cả</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">Khoảng
          <select className={select} value={days} onChange={(e) => { setDays(Number(e.target.value)); setPage(0); }}>
            {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
        </label>
        <input className={`input-field text-xs py-1 flex-1 min-w-[140px] ${FOCUS}`} aria-label="Tìm khách" placeholder="Tìm tên hoặc nội dung" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <>
            <span role="status" className="text-xs text-blue-400 whitespace-nowrap">Đang thu bình luận… ({progress?.done ?? 0}/{progress?.total ?? 0})</span>
            <button type="button" onClick={cancelCollect} className={BTN}>Huỷ</button>
          </>
        ) : (
          <button type="button" onClick={collectNow} disabled={starting} className={BTN}>{starting ? 'Đang bắt đầu…' : 'Thu ngay'}</button>
        )}
        <button type="button" onClick={exportXlsx} disabled={exporting || total === 0} className={BTN}>{exporting ? 'Đang xuất…' : 'Xuất Excel'}</button>
        <div className="ml-auto"><LeadConfigPopover /></div>
      </div>
      {loading ? <div className="flex justify-center py-10" role="status" aria-label="Đang tải khách"><Spinner size={5} /></div>
        : loadError ? (
          <div role="alert" className="poster-empty"><p>{loadError}</p><button type="button" className={`${BTN} mt-3`} onClick={() => setReloadTick((n) => n + 1)}>Thử lại</button></div>
        ) : leads.length === 0 ? <p className="poster-empty">Chưa có khách tiềm năng trong khoảng này. Bình luận có từ khoá hoặc số điện thoại sẽ được lọc vào đây sau khi thu.</p>
          : (
            <div className="overflow-x-auto max-w-full rounded-lg border border-gray-700" tabIndex={0} role="region" aria-label="Bảng khách tiềm năng">
              <table className="w-full text-xs text-gray-300">
                <thead className="text-gray-400 border-b border-gray-700">
                  <tr>
                    <th className={TH}>Người bình luận</th><th className={TH}>Nội dung</th><th className={TH}>Nhóm</th>
                    <th className={TH}>Chiến dịch · biến thể</th><th className={TH}>Khớp / AI</th><th className={TH}>Thời gian</th>
                    <th className={TH}>Trạng thái</th><th className={TH}>Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {leads.map((l) => {
                    const chip = leadStatusChip(l.status);
                    const campaignLabel = l.campaignId ? (campaignNames.get(l.campaignId) ?? 'Chiến dịch đã xoá') : '';
                    return (
                      <tr key={l.id}>
                        <td className={`${TD} max-w-[10rem] break-words`}>
                          {l.authorUrl ? <button type="button" onClick={() => openLink(l.authorUrl)} className={`text-blue-400 hover:underline text-left ${FOCUS}`}>{l.authorName || l.authorUrl}</button> : <span>{l.authorName || '—'}</span>}
                          <button type="button" onClick={() => openLink(l.postUrl)} className={`block text-blue-400 hover:underline mt-0.5 ${FOCUS}`}>Mở bài</button>
                        </td>
                        <td className={`${TD} min-w-[12rem] max-w-[18rem]`}><p className="line-clamp-3 break-words" title={l.text}>{l.text}</p></td>
                        <td className={`${TD} max-w-[10rem]`}><span className="block truncate" title={l.groupUrl}>{l.groupUrl || '—'}</span></td>
                        <td className={`${TD} max-w-[10rem] break-words`}>{l.campaignId || l.variant ? [campaignLabel, l.variant].filter(Boolean).join(' · ') : '—'}</td>
                        <td className={`${TD} max-w-[10rem] break-words`} title={l.aiReason ?? undefined}>{formatLeadMatch(l)}</td>
                        <td className={`${TD} whitespace-nowrap`}>{formatLeadTime(l.commentedAtMs)}</td>
                        <td className={`${TD} whitespace-nowrap`}>
                          <select aria-label={`Trạng thái của ${l.authorName || 'khách'}`} value={l.status} onChange={(e) => changeStatus(l, e.target.value as LeadStatus)}
                            className={`rounded border bg-transparent px-1 py-0.5 text-xs ${chip.cls} ${FOCUS}`}>
                            {LEAD_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value} className="text-gray-900">{o.label}</option>)}
                          </select>
                        </td>
                        <td className={`${TD} min-w-[10rem]`}>
                          <input type="text" maxLength={NOTE_MAX} aria-label={`Ghi chú cho ${l.authorName || 'khách'}`} className={`input-field text-xs py-1 w-full ${FOCUS}`}
                            value={noteDrafts[l.id] ?? l.note}
                            onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            onBlur={() => saveNote(l)}
                            onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 text-xs text-gray-400">
          <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className={BTN}>Trước</button>
          <span>Trang {page + 1}/{pageCount} · {total} khách</span>
          <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount} className={BTN}>Sau</button>
        </div>
      )}
    </section>
  );
}
