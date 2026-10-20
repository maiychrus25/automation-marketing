import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { useAppStore } from '@/store/appStore';
import MediaPicker from './MediaPicker';
import type { MediaItem } from '../../../services/facebookPoster/mediaRules';
import { defaultVariables, validateVideoForm, VIDEO_MUSIC_EXTENSIONS, type VideoTemplate } from './videoFormat';

export interface MusicTrack { id: string; name: string; durationSec: number; license: string; source: string }
export interface VideoRenderRequest { name: string; templateId: string; aspect: string; variables: Record<string, unknown>; imagePaths: string[]; musicId: string | null; musicPath?: string }

interface Props {
  template: VideoTemplate;
  music: MusicTrack[];
  submitting: boolean;
  error: string;
  onSubmit: (request: VideoRenderRequest) => void;
  onCancel: () => void;
}

type MusicMode = 'none' | 'builtin' | 'upload';
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const FIELD = 'input-field text-sm w-full mt-1';

export default function VideoTemplateForm({ template, music, submitting, error, onSubmit, onCancel }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [name, setName] = useState(template.name);
  const [aspect, setAspect] = useState(template.aspects[0] ?? '');
  const [variables, setVariables] = useState<Record<string, unknown>>(() => defaultVariables(template));
  const [images, setImages] = useState<MediaItem[]>([]);
  const [musicMode, setMusicMode] = useState<MusicMode>('none');
  const [musicId, setMusicId] = useState(music[0]?.id ?? '');
  const [musicPath, setMusicPath] = useState('');
  const [touched, setTouched] = useState(false);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement>(null);
  // Mỗi lần bấm/đổi bài tăng số này; phản hồi tải nhạc cũ hơn bị bỏ.
  const previewSeq = useRef(0);

  const stopPreview = () => {
    previewSeq.current += 1;
    audioRef.current?.pause();
    setPreviewState('idle');
  };
  useEffect(() => () => { previewSeq.current += 1; audioRef.current?.pause(); }, []);
  useEffect(() => { stopPreview(); }, [musicId, musicMode]);

  const togglePreview = async () => {
    if (previewState !== 'idle') { stopPreview(); return; }
    const seq = ++previewSeq.current;
    setPreviewState('loading');
    try {
      const res = await ipc.video?.musicPreview(musicId);
      if (seq !== previewSeq.current) return;
      if (!res?.success || !res.path) throw new Error(res?.error || 'Không tải được nhạc nghe thử');
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = toLocalMediaUrl(res.path);
      await audio.play();
      if (seq === previewSeq.current) setPreviewState('playing');
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setPreviewState('idle');
      showNotification(err instanceof Error && err.message ? err.message : 'Không phát được nhạc nghe thử', 'error');
    }
  };

  const errors = validateVideoForm(template, {
    name, aspect, variables, imagePaths: images.map((i) => i.path),
    musicPath: musicMode === 'upload' ? musicPath : undefined,
  });
  if (musicMode === 'upload' && !musicPath) errors.music = 'Chọn tệp nhạc hoặc đổi sang không nhạc.';
  if (musicMode === 'builtin' && !musicId) errors.music = 'Chọn một bản nhạc có sẵn.';
  const invalid = Object.keys(errors).length > 0;
  const show = (key: string) => (touched && errors[key] ? <p role="alert" className="text-xs text-red-400 mt-1">{errors[key]}</p> : null);

  const pickMusic = async () => {
    try {
      const res = await ipc.file?.openDialog({
        title: 'Chọn tệp nhạc',
        filters: [{ name: 'Nhạc', extensions: VIDEO_MUSIC_EXTENSIONS }],
        properties: ['openFile'],
      });
      if (res?.filePaths?.[0]) setMusicPath(res.filePaths[0]);
    } catch (err) { showNotification(err instanceof Error && err.message ? err.message : 'Không mở được hộp chọn tệp', 'error'); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || submitting) return;
    onSubmit({
      name: name.trim(), templateId: template.id, aspect, variables,
      imagePaths: images.map((i) => i.path),
      musicId: musicMode === 'builtin' ? musicId : null,
      ...(musicMode === 'upload' ? { musicPath } : {}),
    });
  };

  const setVariable = (key: string, value: unknown) => setVariables((prev) => ({ ...prev, [key]: value }));
  const selected = music.find((m) => m.id === musicId);

  return (
    <form onSubmit={submit} noValidate className="space-y-4 min-w-0" aria-label={`Tạo video từ mẫu ${template.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="poster-button" onClick={onCancel} disabled={submitting}>← Chọn mẫu khác</button>
        <h3 className="text-base font-semibold break-words min-w-0">{template.name}</h3>
      </div>
      {template.description && <p className="poster-muted text-xs break-words">{template.description}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
        <label className="block text-xs text-gray-400 min-w-0">Tên video
          <input className={FIELD} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={touched && !!errors.name} />
          {show('name')}
        </label>
        <label className="block text-xs text-gray-400 min-w-0">Khổ video
          <select className={FIELD} value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {template.aspects.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {show('aspect')}
        </label>
        {Object.entries(template.variables).map(([key, def]) => (
          <label key={key} className="block text-xs text-gray-400 min-w-0">{def.label}
            {def.type === 'color' ? (
              <span className="flex items-center gap-2 mt-1">
                <input type="color" aria-label={`Chọn màu: ${def.label}`} className="h-9 w-12 shrink-0 rounded border border-gray-600 bg-transparent p-0.5"
                  value={/^#[0-9a-fA-F]{6}$/.test(String(variables[key])) ? String(variables[key]) : '#000000'} onChange={(e) => setVariable(key, e.target.value)} />
                <input className="input-field text-sm w-full min-w-0" value={String(variables[key] ?? '')} onChange={(e) => setVariable(key, e.target.value)} placeholder="#rrggbb" aria-invalid={touched && !!errors[`var:${key}`]} />
              </span>
            ) : def.type === 'number' ? (
              <input className={FIELD} type="number" value={typeof variables[key] === 'number' && Number.isFinite(variables[key]) ? (variables[key] as number) : ''}
                onChange={(e) => setVariable(key, e.target.value === '' ? '' : Number(e.target.value))} aria-invalid={touched && !!errors[`var:${key}`]} />
            ) : (
              <input className={FIELD} maxLength={def.maxLength} value={String(variables[key] ?? '')} onChange={(e) => setVariable(key, e.target.value)} aria-invalid={touched && !!errors[`var:${key}`]} />
            )}
            {show(`var:${key}`)}
          </label>
        ))}
      </div>

      <div className="space-y-1 min-w-0">
        <p className="text-xs text-gray-400">Ảnh ({template.imageSlots.min === template.imageSlots.max ? template.imageSlots.min : `${template.imageSlots.min}–${template.imageSlots.max}`} ảnh JPEG/PNG/WebP, thứ tự là thứ tự trong video)</p>
        <MediaPicker items={images} onChange={setImages} disabled={submitting} />
        {show('images')}
      </div>

      <fieldset className="space-y-2 min-w-0">
        <legend className="text-xs text-gray-400">Nhạc nền</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {([['none', 'Không nhạc'], ['builtin', 'Nhạc có sẵn'], ['upload', 'Tải tệp lên']] as [MusicMode, string][]).map(([mode, label]) => (
            <label key={mode} className="inline-flex items-center gap-1.5">
              <input type="radio" name="video-music-mode" checked={musicMode === mode} onChange={() => setMusicMode(mode)} />{label}
            </label>
          ))}
        </div>
        {musicMode === 'builtin' && (music.length === 0
          ? <p className="poster-muted text-xs">Máy chủ chưa có nhạc có sẵn.</p>
          : <div className="space-y-1">
            <select className={FIELD} aria-label="Chọn nhạc có sẵn" value={musicId} onChange={(e) => setMusicId(e.target.value)}>
              {music.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.durationSec}s)</option>)}
            </select>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="poster-button" onClick={togglePreview} aria-pressed={previewState === 'playing'}>
                {previewState === 'loading' ? 'Đang tải…' : previewState === 'playing' ? 'Dừng nghe thử' : 'Nghe thử'}
              </button>
              <audio ref={audioRef} onEnded={() => setPreviewState('idle')} onError={() => setPreviewState('idle')} />
            </div>
            {selected && <p className="poster-muted text-xs break-words">Giấy phép: {selected.license} · Nguồn: {selected.source}</p>}
          </div>)}
        {musicMode === 'upload' && (
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <button type="button" className="poster-button" onClick={pickMusic} disabled={submitting}>Chọn tệp nhạc</button>
              {musicPath && <span className="text-xs break-all min-w-0" title={musicPath}>{fileName(musicPath)}</span>}
            </div>
            <p className="text-xs text-orange-400">Nhạc tự tải lên: anh chịu trách nhiệm về bản quyền.</p>
          </div>
        )}
        {show('music')}
      </fieldset>

      {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="poster-primary" disabled={submitting} aria-disabled={submitting}>{submitting ? 'Đang gửi…' : 'Tạo video'}</button>
        {touched && invalid && <span className="text-xs text-red-400">Kiểm tra lại các ô báo lỗi.</span>}
      </div>
    </form>
  );
}
