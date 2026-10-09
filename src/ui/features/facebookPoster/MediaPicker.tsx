import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useAppStore } from '@/store/appStore';
import { MAX_IMAGES, isVideo, validateMediaSelection, acceptDroppedMedia, type MediaItem } from '../../../services/facebookPoster/mediaRules';

interface Props {
  items: MediaItem[];
  onChange: (items: MediaItem[]) => void;
  disabled?: boolean;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const tileButton = 'px-1.5 py-0.5 rounded text-[11px] border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-40';

function summary(items: MediaItem[]): string {
  if (items.length === 0) return '';
  if (items.length === 1 && isVideo(items[0].path)) return '1 video';
  const mb = items.reduce((sum, i) => sum + i.size, 0) / (1024 * 1024);
  return `${items.length}/${MAX_IMAGES} ảnh · ${mb.toFixed(1)} MB`;
}

export default function MediaPicker({ items, onChange, disabled }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [dragOver, setDragOver] = useState(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const dropped: MediaItem[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const path = ipc.file?.getDroppedPath(f) || (f as any).path || '';
        if (path) dropped.push({ path, size: f.size });
      } catch { /* bỏ file không lấy được path */ }
    }
    const added = acceptDroppedMedia(dropped, items);
    if (added.length) onChange([...items, ...added]);
    else if (dropped.length) showNotification('Chỉ hỗ trợ ảnh/video, hoặc tệp đã có', 'warning');
  };

  const pick = async () => {
    let res;
    try {
      res = await ipc.facebookPoster?.pickMedia();
    } catch (err: any) {
      showNotification(err?.message || 'Không mở được hộp chọn tệp', 'error');
      return;
    }
    if (!res?.success) { showNotification(res?.error || 'Không chọn được tệp', 'error'); return; }
    const known = new Set(items.map((i) => i.path));
    const added: MediaItem[] = [];
    for (const item of res.items ?? []) {
      if (!known.has(item.path)) { known.add(item.path); added.push(item); }
    }
    if (added.length) onChange([...items, ...added]);
  };

  const move = (from: number, to: number) => {
    const next = [...items];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };

  const error = validateMediaSelection(items);

  return (
    <div
      className={`space-y-2 min-w-0 rounded-lg border border-dashed p-2 transition-colors ${dragOver ? 'border-blue-500 bg-blue-500/10' : 'border-transparent'}`}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <button type="button" onClick={pick} disabled={disabled} className="px-3 py-1.5 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">Chọn ảnh/video</button>
        <span className="text-xs text-gray-500">hoặc kéo-thả vào đây</span>
        {items.length > 0 && <span className="text-xs text-gray-400">{summary(items)}</span>}
      </div>
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-2 min-w-0">
          {items.map((item, i) => {
            const k = i + 1;
            return (
              <li key={item.path} className="w-[88px] min-w-0 space-y-1">
                <div className="relative w-[72px] h-[72px] rounded-lg border border-gray-700 overflow-hidden bg-gray-800 flex items-center justify-center">
                  {isVideo(item.path)
                    ? <span className="text-[11px] text-gray-300 px-1 break-all line-clamp-4" title={item.path}>{fileName(item.path)}</span>
                    : <img src={toLocalMediaUrl(item.path)} alt={fileName(item.path)} title={item.path} className="w-full h-full object-cover" />}
                  <span className="absolute top-0 left-0 px-1 text-[11px] bg-black/70 text-white rounded-br">{k}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <button type="button" className={tileButton} aria-label={`Đưa ảnh ${k} lên`} disabled={disabled || i === 0} onClick={() => move(i, i - 1)}>Lên</button>
                  <button type="button" className={tileButton} aria-label={`Đưa ảnh ${k} xuống`} disabled={disabled || i === items.length - 1} onClick={() => move(i, i + 1)}>Xuống</button>
                  <button type="button" className={tileButton} aria-label={`Bỏ ảnh ${k}`} disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))}>Bỏ</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
