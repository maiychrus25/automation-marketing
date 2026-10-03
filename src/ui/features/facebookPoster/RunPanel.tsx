import React, { useEffect, useRef } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import type { FbPosterRun } from '../../../models/facebookPoster';

export interface PosterLog { runId: string; profileId: string; level: 'info' | 'success' | 'warning' | 'error'; message: string; at: number }
export interface PosterProgress { runId: string; done: number; total: number; profiles: { profileId: string; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; done: number; total: number }[] }

const LEVEL_COLOR: Record<PosterLog['level'], string> = {
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
  run: FbPosterRun | null;
  progress: PosterProgress | null;
  logs: PosterLog[];
  profileNames: Map<string, string>;
}

export default function RunPanel({ run, progress, logs, profileNames }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const busy = run?.status === 'running';
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

  const handleCancel = async () => {
    const confirmed = await showConfirm({
      title: 'Hủy việc đang chạy?',
      message: 'Các đích chưa làm sẽ bị bỏ qua. Đích đang làm dở có thể đã đăng.',
      confirmText: 'Hủy việc',
      variant: 'danger',
    });
    if (!confirmed) return;
    const res = await ipc.facebookPoster?.cancel();
    if (!res?.success) showNotification(res?.error || 'Không hủy được việc', 'error');
  };

  if (!run && logs.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-10">Chưa có việc nào đang chạy.</p>;
  }

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="flex flex-col gap-3 min-w-0 h-full min-h-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Tiến độ</h2>
        <button type="button" onClick={handleCancel} disabled={!busy}
          className="px-3 py-1 rounded-lg text-xs border border-red-500/50 text-red-400 hover:bg-red-900/20 disabled:opacity-40">Hủy</button>
      </div>
      <div>
        <div className="flex justify-between text-xs text-gray-400 mb-1"><span>{done}/{total}</span><span>{percent}%</span></div>
        <div className="h-2 rounded-full bg-gray-700 overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {progress && progress.profiles.length > 0 && (
        <ul className="space-y-1 max-h-40 overflow-y-auto">
          {progress.profiles.map((p) => {
            const chip = STATE_CHIP[p.state] || STATE_CHIP.waiting;
            return (
              <li key={p.profileId} className="flex items-center gap-2 text-xs min-w-0">
                <span className="truncate flex-1 min-w-0 text-gray-200" title={profileNames.get(p.profileId) || p.profileId}>{profileNames.get(p.profileId) || p.profileId}</span>
                <span className={`whitespace-nowrap ${chip.cls}`}>{chip.label}</span>
                <span className="text-gray-400 whitespace-nowrap">{p.done}/{p.total}</span>
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
