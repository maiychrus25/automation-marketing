import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import CampaignDialog from './CampaignDialog';
import PerformancePanel from './PerformancePanel';
import { formatShort } from './ScheduleDialog';
import { formatCount } from './researchFormat';
import { CAMPAIGN_TONE_CLASS, campaignStatusChip, formatCampaignRange } from './campaignFormat';
import type { CampaignStatus } from '../../../models/facebookPoster';
import type { CampaignView } from '../../../services/facebookPoster/campaignOperations';

type CampaignDetail = NonNullable<Awaited<ReturnType<NonNullable<typeof ipc.facebookPoster>['campaignGet']>>['campaign']>;

const BTN = 'poster-button';

function StatusChip({ campaign, now }: { campaign: CampaignView; now: number }) {
  const chip = campaignStatusChip(campaign, now);
  return <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 text-xs ${CAMPAIGN_TONE_CLASS[chip.tone]}`}>{chip.label}</span>;
}

export default function CampaignsTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [campaigns, setCampaigns] = useState<CampaignView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<{ campaign?: CampaignView } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [now, setNow] = useState(Date.now());
  const openFacebookPoster = useAppStore((s) => s.openFacebookPoster);
  const setPosterFocusScheduleId = useAppStore((s) => s.setPosterFocusScheduleId);
  // Chỉ phản hồi của lần gọi mới nhất được ghi vào state; mọi lần gọi bị bỏ khi tab đã gỡ.
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const openSchedule = (id: string) => { setPosterFocusScheduleId(id); openFacebookPoster('schedule'); };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      // Mặc định API ẩn lưu trữ; khi bật công tắc thì gọi thêm danh sách lưu trữ.
      const [res, archived] = await Promise.all([
        ipc.facebookPoster?.campaignList(),
        showArchived ? ipc.facebookPoster?.campaignList({ status: 'archived' }) : Promise.resolve(undefined),
      ]);
      if (seq !== loadSeq.current || !alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không tải được danh sách chiến dịch');
      if (archived && !archived.success) throw new Error(archived.error || 'Không tải được danh sách chiến dịch');
      setCampaigns([...(res.campaigns || []), ...(archived?.campaigns || [])]);
      setError('');
      setNow(Date.now());
    } catch (err) { if (seq === loadSeq.current && alive.current) setError(err instanceof Error ? err.message : 'Không tải được danh sách chiến dịch'); }
    finally { if (seq === loadSeq.current && alive.current) setLoading(false); }
  }, [showArchived]);

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current;
    try {
      const res = await ipc.facebookPoster?.campaignGet(id);
      if (seq !== detailSeq.current || !alive.current) return;
      if (!res?.success || !res.campaign) throw new Error(res?.error || 'Không tải được chiến dịch');
      setDetail(res.campaign);
      setDetailError('');
    } catch (err) { if (seq !== detailSeq.current || !alive.current) return; setDetail(null); setDetailError(err instanceof Error ? err.message : 'Không tải được chiến dịch'); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const reload = () => { load(); if (detailId) loadDetail(detailId); };
    // Số bài và TB/bài đổi khi lượt đăng hoặc lượt theo dõi kết thúc, không chỉ khi lịch đổi.
    const offs = ['facebookPoster:schedulesChanged', 'facebookPoster:runFinished', 'facebookPoster:trackFinished'].map((channel) => ipc.on?.(channel, reload));
    return () => { offs.forEach((off) => off?.()); };
  }, [load, loadDetail, detailId]);
  useEffect(() => { if (detailId) { setDetail(null); loadDetail(detailId); } }, [detailId, loadDetail]);

  const refresh = () => { load(); if (detailId) loadDetail(detailId); };

  const setStatus = async (c: CampaignView, status: CampaignStatus) => {
    setBusyId(c.id);
    try {
      const res = await ipc.facebookPoster?.campaignUpdate({ id: c.id, status });
      if (!res?.success) throw new Error(res?.error || 'Không cập nhật được chiến dịch');
    } catch (err) { showNotification(err instanceof Error ? err.message : 'Không cập nhật được chiến dịch', 'error'); }
    finally { setBusyId(null); refresh(); }
  };
  const archive = async (c: CampaignView) => {
    const ok = await showConfirm({ title: 'Lưu trữ chiến dịch?', message: `Lịch của "${c.name}" sẽ không tự chạy nữa. Có thể khôi phục sau.`, confirmText: 'Lưu trữ' });
    if (ok) await setStatus(c, 'archived');
  };
  const remove = async (c: CampaignView) => {
    const ok = await showConfirm({ title: 'Xoá chiến dịch?', message: `Chiến dịch "${c.name}" sẽ bị xoá. Báo cáo cũ vẫn xem được với nhãn "(chiến dịch đã xoá)".`, confirmText: 'Xoá', variant: 'danger' });
    if (!ok) return;
    setBusyId(c.id);
    try {
      const res = await ipc.facebookPoster?.campaignDelete(c.id);
      if (!res?.success) throw new Error(res?.error || 'Không xoá được chiến dịch');
      if (detailId === c.id) { setDetailId(null); setDetail(null); }
    } catch (err) { showNotification(err instanceof Error ? err.message : 'Không xoá được chiến dịch', 'error'); }
    finally { setBusyId(null); load(); }
  };

  const actions = (c: CampaignView) => {
    const busy = busyId === c.id;
    const empty = c.scheduleCount + c.draftCount === 0;
    return (
      <div className="flex flex-wrap gap-2">
        {c.status === 'archived'
          ? <button type="button" className={BTN} disabled={busy} onClick={() => setStatus(c, 'active')}>Khôi phục</button>
          : <>
            <button type="button" className={BTN} disabled={busy} onClick={() => setStatus(c, c.status === 'paused' ? 'active' : 'paused')}>{c.status === 'paused' ? 'Tiếp tục' : 'Tạm dừng'}</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => setDialog({ campaign: c })}>Sửa</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => archive(c)}>Lưu trữ</button>
          </>}
        <button type="button" className={`${BTN} text-red-400`} disabled={busy || !empty} onClick={() => remove(c)}
          title={empty ? undefined : 'Chuyển hoặc xoá lịch / bài nháp của chiến dịch trước'}>Xoá</button>
      </div>
    );
  };

  const dialogEl = dialog && <CampaignDialog campaign={dialog.campaign} onClose={() => setDialog(null)} onSaved={refresh} />;

  if (detailId) {
    const c = detail ?? campaigns.find((x) => x.id === detailId) ?? null;
    return (
      <section aria-label="Chi tiết chiến dịch" className="space-y-4 min-w-0">
        <button type="button" className={BTN} onClick={() => { setDetailId(null); setDetail(null); }}>← Danh sách chiến dịch</button>
        {detailError && <div role="alert" className="text-sm text-red-400 break-words">{detailError}</div>}
        {!c && !detailError && <div className="flex justify-center py-10" role="status" aria-label="Đang tải"><Spinner size={5} /></div>}
        {c && <>
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold break-words min-w-0">{c.name}</h2>
              <StatusChip campaign={c} now={now} />
            </div>
            <p className="poster-muted text-xs">{formatCampaignRange(c.startAt, c.endAt)}</p>
            <p className="text-sm break-words whitespace-pre-wrap">{c.goal || <span className="poster-muted">Chưa có mục tiêu.</span>}</p>
            {actions(c)}
          </div>
          <div className="space-y-2 min-w-0">
            <h3 className="text-sm font-medium">Lịch và bài nháp</h3>
            {!detail ? <div className="flex justify-center py-4"><Spinner size={5} /></div>
              : detail.schedules.length === 0 ? <p className="poster-muted text-xs">Chưa có lịch hay bài nháp nào. Soạn bài rồi chọn chiến dịch này.</p>
                : <ul className="space-y-2">
                  {detail.schedules.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="poster-schedule-row w-full text-left focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => openSchedule(s.id)} aria-label={`Mở ${s.draft ? 'bài nháp' : 'lịch'} ${s.name} trong Lịch đăng`}>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold truncate" title={s.name}>{s.name}</p>
                        <p className="poster-muted text-xs mt-1">
                          {s.draft ? 'Bài nháp' : s.kind === 'once' ? 'Một lần' : 'Lặp lại'}
                          {!s.draft && ` · ${s.enabled ? 'Đang bật' : 'Đã tắt'}`}
                          {` · ${s.nextRunAt ? formatShort(s.nextRunAt) : 'Không có lần chạy tới'}`}
                        </p>
                      </div>
                      </button>
                    </li>
                  ))}
                </ul>}
          </div>
          <PerformancePanel campaignId={c.id} />
        </>}
        {dialogEl}
      </section>
    );
  }

  const visible = campaigns.filter((c) => showArchived || c.status !== 'archived');
  return (
    <section aria-label="Danh sách chiến dịch" className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="poster-primary" onClick={() => setDialog({})}>＋ Tạo chiến dịch</button>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="focus-visible:ring-2 focus-visible:ring-blue-500" />
          Hiện đã lưu trữ
        </label>
      </div>
      {loading ? <div className="flex justify-center py-10" role="status" aria-label="Đang tải chiến dịch"><Spinner size={5} /></div>
        : error ? <div role="alert" className="poster-empty"><p>{error}</p><button type="button" className={`${BTN} mt-3`} onClick={() => { setLoading(true); load(); }}>Thử lại</button></div>
          : visible.length === 0 ? <p className="poster-empty">Chưa có chiến dịch. Bấm Tạo chiến dịch để gom các lịch đăng và so sánh hiệu quả.</p>
            : <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {visible.map((c) => (
                <li key={c.id} className="rounded-lg border border-gray-700 p-3 space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <button type="button" className="poster-link font-semibold text-left break-words min-w-0" onClick={() => setDetailId(c.id)}>{c.name}</button>
                    <StatusChip campaign={c} now={now} />
                  </div>
                  <p className="poster-muted text-xs">{formatCampaignRange(c.startAt, c.endAt)}</p>
                  <p className="text-xs">
                    {formatCount(c.scheduleCount)} lịch · {formatCount(c.draftCount)} nháp
                    {c.summary
                      ? ` · ${formatCount(c.summary.posts)} bài · ${formatCount(c.summary.withLink)} có link · TB/bài `
                      : ' · Chưa có bài'}
                    {c.summary && (c.summary.insufficient ? <span className="text-gray-400">chưa đủ dữ liệu</span>
                      : c.summary.avgEngagement === null ? '—' : c.summary.avgEngagement.toLocaleString('vi-VN', { maximumFractionDigits: 1 }))}
                  </p>
                  {actions(c)}
                </li>
              ))}
            </ul>}
      {dialogEl}
    </section>
  );
}
