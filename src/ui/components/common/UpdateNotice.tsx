import React, { useEffect } from 'react';
import ipc from '@/lib/ipc';
import { useUpdateStore } from '@/store/updateStore';
import type { UpdateState } from '../../../services/update/UpdateService';

/**
 * Update card (top right, under the toolbar so it never covers the global toast at the bottom).
 * Fed by the main process `update:state` event; see docs/specs/2026-10-03-auto-update.md.
 */
export default function UpdateNotice() {
  const {
    status, updateInfo, progress, error, showPopup, canInstall, actionError,
    applyState, startDownload, installUpdate, dismiss,
  } = useUpdateStore();

  useEffect(() => {
    let cancelled = false;
    ipc.update?.getState?.().then((state: UpdateState) => { if (!cancelled && state) applyState(state); }).catch(() => undefined);
    const off = ipc.on?.('update:state', (state: UpdateState) => applyState(state));
    return () => { cancelled = true; off?.(); };
  }, [applyState]);

  if (!showPopup || status === 'idle' || !updateInfo && status !== 'error') return null;

  const version = updateInfo?.version;
  const notes = typeof updateInfo?.releaseNotes === 'string' ? updateInfo.releaseNotes : '';
  const percent = Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0)));

  return (
    <div
      role="status"
      aria-live="polite"
      className="mac-toast fixed top-16 right-4 z-50 w-[calc(100vw-2rem)] max-w-[360px] p-4 flex flex-col gap-3"
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold break-words">
          {status === 'available' && `Có bản MaiHub ${version} mới`}
          {status === 'downloading' && `Đang tải bản ${version}… ${percent}%`}
          {status === 'downloaded' && `Đã tải xong bản ${version}`}
          {status === 'error' && 'Cập nhật gặp lỗi'}
        </p>
        {status === 'available' && notes && (
          <p className="mt-1 text-xs text-gray-400 whitespace-pre-line break-words line-clamp-3">{notes}</p>
        )}
        {status === 'available' && !canInstall && (
          <p className="mt-1 text-xs text-gray-400">Bản này cần tải bộ cài và cài tay.</p>
        )}
        {status === 'downloaded' && (
          <p className="mt-1 text-xs text-gray-400">Khởi động lại để cài. Các trình duyệt đang mở sẽ được đóng.</p>
        )}
        {status === 'error' && error && (
          <p className="mt-1 text-xs text-red-500 break-words">{error.message}</p>
        )}
        {actionError && (
          <p className="mt-1 text-xs text-red-500 break-words" role="alert">{actionError}</p>
        )}
      </div>

      {status === 'downloading' && (
        <div className="h-1.5 w-full rounded-full bg-gray-700 overflow-hidden" role="progressbar"
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Tiến độ tải bản cập nhật">
          <div className="h-full bg-blue-600 transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </div>
      )}

      {status !== 'downloading' && (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={dismiss}>
            {status === 'error' ? 'Đóng' : 'Để sau'}
          </button>
          {status === 'available' && (
            <button type="button" className="btn-primary" onClick={() => { void startDownload(); }}>
              {canInstall ? 'Cập nhật' : 'Tải bản mới'}
            </button>
          )}
          {status === 'downloaded' && (
            <button type="button" className="btn-primary" onClick={() => { void installUpdate(); }}>
              Khởi động lại để cập nhật
            </button>
          )}
          {status === 'error' && version && (
            <button type="button" className="btn-primary" onClick={() => { void startDownload(); }}>
              Thử lại
            </button>
          )}
        </div>
      )}
    </div>
  );
}
