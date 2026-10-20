import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import TrackConfigPopover from './TrackConfigPopover';
import { formatCount, formatRate } from './researchFormat';
import { GROUP_BY_OPTIONS, RANGE_OPTIONS, gradeChip, formatBestTimes } from './trackingFormat';
import type { GroupScore } from '../../../services/facebookPoster/groupScores';
import type { PostStatsGroupBy, PostStatsReportRow } from '../../../models/facebookPoster';

// Giới hạn của thao tác theo dõi (trackingOperations.track): đọc tối đa 14 ngày bài gần nhất.
const MAX_TRACK_SINCE_DAYS = 14;

const DAY_MS = 86_400_000;
const FOCUS = 'focus-visible:ring-2 focus-visible:ring-blue-500';
const TH = 'px-2 py-1.5 text-left font-medium whitespace-nowrap';
const TD = 'px-2 py-1.5 whitespace-nowrap';

interface Props {
  /** Lọc theo chiến dịch / lịch; khi đã lọc theo chiến dịch thì ẩn lựa chọn gom theo Chiến dịch. */
  campaignId?: string;
  scheduleId?: string;
}

export default function PerformancePanel({ campaignId, scheduleId }: Props = {}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<PostStatsGroupBy>('group');
  const [rows, setRows] = useState<PostStatsReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [scores, setScores] = useState<Record<string, GroupScore>>({});
  const [openReasons, setOpenReasons] = useState<string | null>(null);
  const [bestLine, setBestLine] = useState('');
  const aliveRef = useRef(true);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    ipc.facebookPoster?.postStats({ from: Date.now() - days * DAY_MS, groupBy, campaignId, scheduleId, limit: 200 }).then((res) => {
      if (cancelled) return;
      if (res?.success) setRows(res.rows || []); else { setRows([]); setLoadError(res?.error || 'Không tải được báo cáo'); }
    }).catch(() => { if (!cancelled) { setRows([]); setLoadError('Không tải được báo cáo'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days, groupBy, campaignId, scheduleId, reloadTick]);

  // Điểm nhóm: cùng khoảng ngày và chiến dịch với bảng; lỗi thì ẩn cột giá trị (ô hiện —).
  useEffect(() => {
    if (groupBy !== 'group') return;
    let cancelled = false;
    setScores({});
    setOpenReasons(null);
    ipc.facebookPoster?.groupScores({ from: Date.now() - days * DAY_MS, campaignId }).then((res) => {
      if (cancelled || !res?.success) return;
      setScores(Object.fromEntries((res.groups || []).map((s) => [s.groupUrl, s])));
    }).catch(() => { /* ô điểm hiện — */ });
    return () => { cancelled = true; };
  }, [groupBy, days, campaignId, reloadTick]);

  // Gợi ý giờ đăng: khoảng mặc định 60 ngày của dịch vụ, chỉ lọc theo chiến dịch.
  useEffect(() => {
    let cancelled = false;
    setBestLine('');
    ipc.facebookPoster?.bestTimes({ campaignId }).then((res) => {
      if (cancelled || !res?.success) return;
      setBestLine(formatBestTimes({ hours: res.hours || [], weekdays: res.weekdays || [], insufficient: res.insufficient ?? true }));
    }).catch(() => { /* không hiện dòng gợi ý */ });
    return () => { cancelled = true; };
  }, [campaignId, reloadTick]);

  useEffect(() => {
    let cancelled = false;
    ipc.facebookPoster?.trackStatus().then((res) => {
      if (cancelled || !res?.success) return;
      setRunning(!!res.running);
      if (res.running && res.progress) setProgress(res.progress);
    }).catch(() => { /* sự kiện tiến độ sẽ cập nhật */ });
    const offProgress = ipc.on?.('facebookPoster:trackProgress', (data: { done: number; total: number }) => {
      setRunning(true);
      setProgress({ done: data.done, total: data.total });
    });
    const offFinished = ipc.on?.('facebookPoster:trackFinished', () => {
      setRunning(false);
      setProgress(null);
      setReloadTick((n) => n + 1);
    });
    return () => { cancelled = true; offProgress?.(); offFinished?.(); };
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const res = await ipc.facebookPoster.trackPosts({ sinceDays: Math.min(days, MAX_TRACK_SINCE_DAYS) });
      if (!res?.success) showNotification(res?.error || 'Không bắt đầu được việc theo dõi', 'error');
      else if (!res.pairs?.length) showNotification('Không có bài nào cần theo dõi', 'info'); // việc đã kết thúc ngay, không treo "Đang theo dõi"
      else {
        setRunning(true);
        setProgress({ done: 0, total: res.pairs.length });
        // Việc có thể đã xong (và đã báo trackFinished) trước khi lời gọi trả về: đọc lại trạng thái để không treo.
        const st = await ipc.facebookPoster.trackStatus();
        if (aliveRef.current && st?.success && !st.running) { setRunning(false); setProgress(null); setReloadTick((n) => n + 1); }
      }
    } catch (err) {
      showNotification(err instanceof Error && err.message ? err.message : 'Không bắt đầu được việc theo dõi', 'error');
    } finally {
      if (aliveRef.current) setStarting(false);
    }
  }, [days, showNotification]);

  const cancel = async () => {
    try {
      const res = await ipc.facebookPoster.trackCancel();
      if (!res?.success) showNotification(res?.error || 'Không huỷ được', 'error');
    } catch (err) {
      showNotification(err instanceof Error && err.message ? err.message : 'Không huỷ được', 'error');
    }
  };

  const select = 'input-field text-xs py-1';
  const groupOptions = campaignId ? GROUP_BY_OPTIONS.filter((o) => o.value !== 'campaign') : GROUP_BY_OPTIONS;
  const labelHead = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label || 'Nhóm';

  return (
    <section aria-label="Hiệu quả bài đăng" className="rounded-lg border border-gray-700 p-3 space-y-2 min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-sm font-medium text-white">Hiệu quả</h3>
        <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">Khoảng
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${select} ${FOCUS}`}>
            {RANGE_OPTIONS.map((o) => <option key={o.days} value={o.days}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">Gom theo
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as PostStatsGroupBy)} className={`${select} ${FOCUS}`}>
            {groupOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {running ? (
            <>
              <span role="status" className="text-xs text-blue-400 whitespace-nowrap">Đang theo dõi… ({progress?.done ?? 0}/{progress?.total ?? 0})</span>
              <button type="button" onClick={cancel} className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>Huỷ</button>
            </>
          ) : (
            <button type="button" onClick={start} disabled={starting} className={`px-3 py-1.5 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50 whitespace-nowrap ${FOCUS}`}>
              {starting ? 'Đang bắt đầu…' : 'Cập nhật số liệu'}
            </button>
          )}
          <TrackConfigPopover />
        </div>
      </div>
      {loading ? <div className="flex justify-center py-4"><Spinner size={5} /></div>
        : loadError ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span role="alert" className="text-red-400 break-words">{loadError}</span>
            <button type="button" onClick={() => setReloadTick((n) => n + 1)} className={`px-2.5 py-1 rounded-lg border border-gray-600 text-gray-300 hover:border-gray-400 ${FOCUS}`}>Thử lại</button>
          </div>
        ) : rows.length === 0 ? <p className="text-xs text-gray-400 py-2">Chưa có bài nào được theo dõi trong khoảng này.</p>
          : (
            <div className="overflow-x-auto max-w-full" tabIndex={0} role="region" aria-label="Bảng hiệu quả bài đăng">
              <table className="w-full text-xs text-gray-300">
                <thead className="text-gray-400 border-b border-gray-700">
                  <tr>
                    <th className={TH}>{labelHead}</th>
                    {groupBy === 'group' && <th className={TH}>Điểm</th>}
                    <th className={`${TH} text-right`}>Bài</th><th className={`${TH} text-right`}>Có link</th>
                    <th className={`${TH} text-right`}>Chờ duyệt</th><th className={`${TH} text-right`}>Không thấy</th>
                    <th className={`${TH} text-right`}>Nghi xoá</th>
                    <th className={`${TH} text-right`}>👍</th><th className={`${TH} text-right`}>💬</th><th className={`${TH} text-right`}>↗</th>
                    <th className={`${TH} text-right`}>TB/bài</th><th className={`${TH} text-right`}>Tỉ lệ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className={`${TD} max-w-[16rem] truncate`} title={r.label}>{r.label}</td>
                      {groupBy === 'group' && (
                        <td className={TD}>
                          {(() => {
                            const sc = scores[r.key];
                            if (!sc) return '—';
                            const chip = gradeChip(sc.grade, sc.score);
                            const text = sc.reasons.join('\n');
                            return (
                              <button type="button" aria-label={chip.aria} title={text} aria-expanded={openReasons === r.key}
                                onClick={() => setOpenReasons(openReasons === r.key ? null : r.key)}
                                className={`px-1.5 rounded border text-[11px] ${chip.cls} ${FOCUS}`}>{chip.label}</button>
                            );
                          })()}
                        </td>
                      )}
                      <td className={`${TD} text-right`}>{formatCount(r.posts)}</td><td className={`${TD} text-right`}>{formatCount(r.withLink)}</td>
                      <td className={`${TD} text-right`}>{formatCount(r.pending)}</td><td className={`${TD} text-right`}>{formatCount(r.notFound)}</td>
                      <td className={`${TD} text-right ${r.removedSuspected ? 'text-red-400' : ''}`}>{formatCount(r.removedSuspected)}</td>
                      <td className={`${TD} text-right`}>{formatCount(r.reactions)}</td><td className={`${TD} text-right`}>{formatCount(r.comments)}</td><td className={`${TD} text-right`}>{formatCount(r.shares)}</td>
                      <td className={`${TD} text-right`}>{r.insufficient ? <span className="text-gray-400">chưa đủ dữ liệu</span> : r.avgEngagement === null ? '—' : r.avgEngagement.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}</td>
                      <td className={`${TD} text-right`}>{formatRate(r.engagementRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {groupBy === 'group' && openReasons && scores[openReasons] && (
        <div role="status" className="text-xs text-gray-400">
          <p className="truncate">Điểm {scores[openReasons].score ?? '—'} · {scores[openReasons].label}</p>
          <ul className="list-disc pl-4">
            {scores[openReasons].reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      )}
      {bestLine && <p className="text-xs text-gray-400">{bestLine}</p>}
    </section>
  );
}
