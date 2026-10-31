import React, { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { KIND_LABEL, STATUS_LABEL } from './HistoryTab';
import type { PosterLog, ProgressSnapshot, RunSnapshot } from './runState';
import type { FbPosterRun } from '../../../models/facebookPoster';

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-gray-400',
  success: 'text-green-400',
  warning: 'text-orange-400',
  error: 'text-red-400',
};
const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  waiting: { label: 'Chờ', cls: 'text-gray-400' },
  running: { label: 'Đang chạy', cls: 'text-blue-400' },
  done: { label: 'Xong', cls: 'text-green-400' },
  failed: { label: 'Lỗi', cls: 'text-red-400' },
  cancelled: { label: 'Đã hủy', cls: 'text-orange-400' },
};

const formatClock = (at: number) => new Date(at).toLocaleTimeString('vi-VN', { hour12: false });

interface Props {
  /** Every cached run (live ones plus the selected one), for the run picker. */
  runs: RunSnapshot[];
  run: FbPosterRun | null;
  progress: ProgressSnapshot | null;
  logs: PosterLog[];
  profileNames: Map<string, string>;
  onSelect: (runId: string) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export default function RunPanel({ runs, run, progress, logs, profileNames, onSelect, loading, error, onRetry }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const namesOf = (p: ProgressSnapshot) => p.profiles.map((x) => profileNames.get(x.profileId) || x.profileId).join(', ');

  // Each item cancels its own run: the ID and label are fixed before the confirm opens, whatever is selected meanwhile.
  const handleCancel = async (item: RunSnapshot) => {
    const runId = item.run.id;
    const label = [KIND_LABEL[item.run.kind] || item.run.kind, namesOf(item.progress)].filter(Boolean).join(' · ');
    const confirmed = await showConfirm({
      title: 'Hủy việc đang chạy?',
      message: `Lượt: ${label}. Các đích chưa làm sẽ bị bỏ qua. Đích đang làm dở có thể đã đăng.`,
      confirmText: 'Hủy việc',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.facebookPoster?.cancel(runId);
    if (!res?.success) showNotification(res?.error || 'Không hủy được việc', 'error');
    else if (res.cancelled === false) showNotification('Lượt này đã kết thúc, không còn gì để hủy.', 'info');
  };

  const status = (
    <>
      {loading && <p className="text-xs text-gray-400">Đang tải lượt đang chạy...</p>}
      {error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-400 break-words">
          {error}
          {onRetry && <button type="button" onClick={onRetry} className="px-2 py-0.5 rounded-lg border border-gray-600 text-gray-300 hover:border-gray-400">Thử lại</button>}
        </p>
      )}
    </>
  );

  if (!run && logs.length === 0 && runs.length === 0) {
    return (loading || error)
      ? <div className="flex flex-col gap-2 py-10 items-center text-center">{status}</div>
      : <p className="text-sm text-gray-400 text-center py-10">Chưa có việc nào đang chạy.</p>;
  }

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const sorted = [...runs].sort((a, b) => a.run.startedAt - b.run.startedAt || a.run.id.localeCompare(b.run.id));

  return (
    <div className="flex flex-col gap-3 min-w-0 h-full min-h-0">
      <h2 className="text-sm font-semibold text-white">Tiến độ</h2>
      {status}
      {sorted.length > 0 && (
        <ul aria-label="Lượt đang theo dõi" className="space-y-1 shrink-0">
          {sorted.map((snapshot) => {
            const { run: item, progress: p } = snapshot;
            const selected = item.id === run?.id;
            // A live run whose every profile is still waiting has not started work yet.
            const waiting = item.status === 'running' && p.profiles.length > 0 && p.profiles.every((x) => x.state === 'waiting');
            const reason = waiting ? p.profiles.find((x) => x.waitingReason)?.waitingReason : undefined;
            const chip = waiting ? { label: 'Đang chờ', cls: 'text-gray-400' } : STATUS_LABEL[item.status] || { label: item.status, cls: 'text-gray-400' };
            const names = namesOf(p);
            return (
              <li key={item.id} className="flex items-center gap-2 min-w-0">
                <button type="button" aria-pressed={selected} onClick={() => onSelect(item.id)}
                  className={`flex-1 flex items-center gap-2 text-left text-xs rounded-lg border px-2 py-1.5 min-w-0 ${selected ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-500'}`}>
                  <span className="font-medium text-gray-200 whitespace-nowrap">{KIND_LABEL[item.kind] || item.kind}</span>
                  <span className="truncate flex-1 min-w-0 text-gray-400" title={names}>{names}</span>
                  <span className={`whitespace-nowrap ${chip.cls}`} title={reason}>{chip.label}{reason && <span className="sr-only">: {reason}</span>}</span>
                  <span className="text-gray-400 whitespace-nowrap">{p.done}/{p.total}</span>
                </button>
                <button type="button" onClick={() => handleCancel(snapshot)} disabled={item.status !== 'running'}
                  aria-label={`Hủy lượt ${KIND_LABEL[item.kind] || item.kind}${names ? ` · ${names}` : ''}`}
                  className="shrink-0 px-3 py-1 rounded-lg text-xs border border-red-500/50 text-red-400 hover:bg-red-900/20 disabled:opacity-40">Hủy</button>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <div className="flex justify-between text-xs text-gray-400 mb-1"><span>{done}/{total}</span><span>{percent}%</span></div>
        <div className="h-2 rounded-full bg-gray-700 overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {progress && progress.profiles.length > 0 && (
        <ul className="space-y-1 max-h-40 overflow-y-auto shrink-0">
          {progress.profiles.map((p) => {
            const chip = STATE_CHIP[p.state] || STATE_CHIP.waiting;
            return (
              <li key={p.profileId} className="text-xs min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate flex-1 min-w-0 text-gray-200" title={profileNames.get(p.profileId) || p.profileId}>{profileNames.get(p.profileId) || p.profileId}</span>
                  <span className={`whitespace-nowrap ${chip.cls}`}>{chip.label}</span>
                  <span className="text-gray-400 whitespace-nowrap">{p.done}/{p.total}</span>
                </div>
                {p.waitingReason && <p className="text-gray-400 break-words mt-0.5">{p.waitingReason}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <div ref={listRef} onScroll={handleScroll} role="log" aria-label="Nhật ký"
        className="flex-1 min-h-[160px] max-h-72 lg:max-h-none overflow-y-auto rounded-lg bg-gray-800 border border-gray-700 p-2 space-y-0.5">
        {logs.length === 0 ? <p className="text-xs text-gray-400">Chưa có nhật ký.</p> : logs.map((l, i) => (
          <p key={i} className={`text-xs break-words ${LEVEL_COLOR[l.level] || LEVEL_COLOR.info}`}>
            <span className="text-gray-500 mr-1.5">{formatClock(l.at)}</span>
            {profileNames.get(l.profileId) ? `[${profileNames.get(l.profileId)}] ` : ''}{l.message}
          </p>
        ))}
      </div>
    </div>
  );
}
