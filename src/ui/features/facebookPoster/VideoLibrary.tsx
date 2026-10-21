import React, { useEffect, useRef, useState } from 'react';
import { toLocalMediaUrl } from '@/lib/localMedia';
import type { VideoJob } from '../../../models/video';
import { formatBytes, formatDuration, isActiveStatus, videoStatusChip, VIDEO_TONE_CLASS } from './videoFormat';

interface Props {
  videos: VideoJob[];
  busyId: string | null;
  playing: VideoJob | null;
  onPlay: (video: VideoJob | null) => void;
  onUse: (video: VideoJob) => void;
  onExport: (video: VideoJob) => void;
  onCancel: (video: VideoJob) => void;
  onDelete: (video: VideoJob) => void;
}

const BTN = 'poster-button';

function PlayerDialog({ video, onClose }: { video: VideoJob; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  useEffect(() => {
    // <video> đọc thẳng local-media:// theo từng đoạn: Chromium huỷ yêu cầu khi tạm dừng tải rồi báo
    // PIPELINE_ERROR_READ "data source error" thay vì đọc tiếp. Tải cả tệp thành Blob thì phát và tua ổn định.
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    fetch(toLocalMediaUrl(video.filePath ?? ''))
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [video.filePath]);
  return (
    <dialog ref={ref} aria-labelledby="video-player-title" className="poster-dialog space-y-3 p-4 max-w-2xl"
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}>
      <h2 id="video-player-title" className="text-base font-semibold break-words">{video.name}</h2>
      {failed ? (
        <p role="alert" className="text-sm text-red-400 break-words">Không mở được tệp video. Thử "Tải về" để xem bằng trình phát khác.</p>
      ) : src ? (
        <video controls preload="metadata" className="w-full max-h-[70dvh] rounded-lg bg-black" src={src}>
          Không phát được video này.
        </video>
      ) : (
        <div role="status" className="grid min-h-40 place-items-center rounded-lg bg-black text-sm text-white">Đang tải video…</div>
      )}
      <div className="flex justify-end"><button type="button" className={BTN} onClick={onClose} autoFocus>Đóng</button></div>
    </dialog>
  );
}

export default function VideoLibrary({ videos, busyId, playing, onPlay, onUse, onExport, onCancel, onDelete }: Props) {
  if (videos.length === 0) return <p className="poster-muted text-sm">Chưa có video nào. Chọn một mẫu để tạo video đầu tiên.</p>;
  return (
    <>
      <ul className="grid gap-3 min-w-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))' }}>
        {videos.map((v) => {
          const chip = videoStatusChip(v.status);
          const busy = busyId === v.id;
          const percent = Math.round(Math.min(1, Math.max(0, v.progress || 0)) * 100);
          const playable = v.status === 'done' && !!v.filePath;
          return (
            <li key={v.id} className="rounded-lg border border-gray-700 overflow-hidden min-w-0 flex flex-col">
              <div className="aspect-video bg-gray-800 flex items-center justify-center overflow-hidden">
                {v.thumbPath ? <img src={toLocalMediaUrl(v.thumbPath)} alt={`Ảnh bìa: ${v.name}`} className="w-full h-full object-cover" />
                  : <span className="poster-muted text-xs">Chưa có ảnh bìa</span>}
              </div>
              <div className="p-3 space-y-2 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <h3 className="text-sm font-medium break-words min-w-0 flex-1" title={v.name}>{v.name}</h3>
                  <span className={`shrink-0 whitespace-nowrap rounded border px-1.5 text-xs ${VIDEO_TONE_CLASS[chip.tone]}`}>{chip.label}</span>
                </div>
                {isActiveStatus(v.status) && (
                  <div className="space-y-1">
                    <div role="progressbar" aria-label={`Tiến độ ${v.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 rounded bg-gray-700 overflow-hidden">
                      <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="poster-muted text-xs">{percent}%</p>
                  </div>
                )}
                {v.status === 'done' && <p className="poster-muted text-xs">{formatDuration(v.durationSec)} · {formatBytes(v.sizeBytes)} · {v.aspect}</p>}
                {v.status === 'failed' && v.error && <p className="text-xs text-red-400 break-words line-clamp-3" title={v.error}>{v.error}</p>}
                <div className="flex flex-wrap gap-2">
                  {playable && <>
                    <button type="button" className={BTN} disabled={busy} onClick={() => onPlay(v)}>Xem</button>
                    <button type="button" className={BTN} disabled={busy} onClick={() => onUse(v)}>Dùng trong Soạn bài</button>
                    <button type="button" className={BTN} disabled={busy} onClick={() => onExport(v)}>Tải về</button>
                  </>}
                  {isActiveStatus(v.status) && <button type="button" className={BTN} disabled={busy} onClick={() => onCancel(v)}>Huỷ</button>}
                  <button type="button" className={`${BTN} text-red-400`} disabled={busy} onClick={() => onDelete(v)}>Xoá</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {playing?.filePath && <PlayerDialog video={playing} onClose={() => onPlay(null)} />}
    </>
  );
}
