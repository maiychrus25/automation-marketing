import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import {
  AD_SCENE_LABEL, adVideoRequest, emptyAdForm, emptyScene, validateAdVideoForm,
  type AdSceneForm, type AdSceneType, type AdVideoFormValues,
} from './adVideoFormat';
import { VIDEO_IMAGE_EXTENSIONS, VIDEO_MUSIC_EXTENSIONS } from './videoFormat';
import type { AdVideoRequest, AdVoiceOption } from '../../../models/video';

interface Props {
  voices: AdVoiceOption[];
  submitting: boolean;
  error: string;
  onSubmit: (request: AdVideoRequest) => void;
  onCancel: () => void;
}

const FIELD = 'input-field text-sm w-full mt-1';
const SCENE_TYPES: AdSceneType[] = ['ai', 'image', 'presenter'];
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export default function AdVideoForm({ voices, submitting, error, onSubmit, onCancel }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [form, setForm] = useState<AdVideoFormValues>(emptyAdForm);
  const [touched, setTouched] = useState(false);

  const errors = validateAdVideoForm(form);
  const invalid = Object.keys(errors).length > 0;
  const show = (key: string) => (touched && errors[key] ? <p role="alert" className="text-xs text-red-400 mt-1 break-words">{errors[key]}</p> : null);
  const set = <K extends keyof AdVideoFormValues>(key: K, value: AdVideoFormValues[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const setScene = (index: number, patch: Partial<AdSceneForm>) =>
    setForm((prev) => ({ ...prev, scenes: prev.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s)) }));

  const pick = async (title: string, extensions: string[]): Promise<string | null> => {
    try {
      const res = await ipc.file?.openDialog({ title, filters: [{ name: title, extensions }], properties: ['openFile'] });
      return res?.filePaths?.[0] ?? null;
    } catch (err) {
      showNotification(err instanceof Error && err.message ? err.message : 'Không mở được hộp chọn tệp', 'error');
      return null;
    }
  };
  const pickImage = async (apply: (path: string) => void) => {
    const path = await pick('Ảnh', VIDEO_IMAGE_EXTENSIONS);
    if (path) apply(path);
  };

  const addScene = () => setForm((prev) => ({ ...prev, scenes: [...prev.scenes, emptyScene('ai')] }));
  const removeScene = (index: number) => setForm((prev) => ({ ...prev, scenes: prev.scenes.filter((_, i) => i !== index) }));
  const moveScene = (index: number, delta: number) => setForm((prev) => {
    const next = [...prev.scenes];
    const target = index + delta;
    if (target < 0 || target >= next.length) return prev;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...prev, scenes: next };
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid || submitting) return;
    onSubmit(adVideoRequest(form));
  };

  /** Ô chọn tệp dùng chung: hiện tên tệp đã chọn và nút bỏ chọn. */
  const filePick = (label: string, path: string, onPick: () => void, onClear: () => void) => (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <button type="button" className="poster-button" onClick={onPick} disabled={submitting}>{path ? 'Đổi tệp' : label}</button>
      {path && <>
        <span className="poster-muted text-xs break-all min-w-0" title={path}>{fileName(path)}</span>
        <button type="button" className="poster-button" onClick={onClear} disabled={submitting}>Bỏ</button>
      </>}
    </div>
  );

  const hasPresenterScene = form.scenes.some((s) => s.type === 'presenter');

  return (
    <form onSubmit={submit} noValidate className="space-y-5 min-w-0" aria-label="Tạo video quảng cáo AI">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="poster-button" onClick={onCancel} disabled={submitting}>← Quay lại</button>
        <h3 className="text-base font-semibold break-words min-w-0">Video quảng cáo AI (dọc 1080×1920)</h3>
      </div>
      <p className="poster-muted text-xs break-words">
        AHV AI vẽ ảnh, đọc lời tiếng Việt, cho ảnh chuyển động, khớp môi người dẫn rồi dựng video. Mỗi video mất khoảng
        20–60 phút; theo tiến độ trong thư viện bên dưới.
      </p>

      <label className="block text-xs text-gray-400">Tên video
        <input className={FIELD} value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoComplete="off" aria-invalid={!!(touched && errors.name)} />
      </label>
      {show('name')}

      <label className="block text-xs text-gray-400 max-w-xs">Ngôn ngữ lời đọc
        <select className={FIELD} value={form.language} onChange={(e) => set('language', e.target.value as 'vi' | 'en')}>
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </label>

      <section aria-label="Kịch bản" className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold">Kịch bản ({form.scenes.length} cảnh)</h4>
          <button type="button" className="poster-button" onClick={addScene} disabled={submitting || form.scenes.length >= 10}>+ Thêm cảnh</button>
        </div>
        {show('scenes')}
        <ol className="space-y-3 min-w-0">
          {form.scenes.map((scene, i) => (
            <li key={i} className="rounded-lg border border-gray-700 p-3 space-y-2 min-w-0">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-sm font-medium">Cảnh {i + 1}</span>
                <select className="input-field text-sm" aria-label={`Loại cảnh ${i + 1}`} value={scene.type}
                  onChange={(e) => setScene(i, { type: e.target.value as AdSceneType })} disabled={submitting}>
                  {SCENE_TYPES.map((t) => <option key={t} value={t}>{AD_SCENE_LABEL[t]}</option>)}
                </select>
                <span className="flex-1" />
                <button type="button" className="poster-button" onClick={() => moveScene(i, -1)} disabled={submitting || i === 0} aria-label={`Đưa cảnh ${i + 1} lên`}>↑</button>
                <button type="button" className="poster-button" onClick={() => moveScene(i, 1)} disabled={submitting || i === form.scenes.length - 1} aria-label={`Đưa cảnh ${i + 1} xuống`}>↓</button>
                <button type="button" className="poster-button text-red-400" onClick={() => removeScene(i)} disabled={submitting || form.scenes.length <= 2} aria-label={`Xoá cảnh ${i + 1}`}>Xoá</button>
              </div>

              {scene.type === 'ai' && <>
                <label className="block text-xs text-gray-400">Mô tả hình (tiếng Anh cho ảnh sát ý hơn)
                  <textarea className={FIELD} rows={2} value={scene.prompt} onChange={(e) => setScene(i, { prompt: e.target.value })} />
                </label>
                {show(`scene:${i}:prompt`)}
              </>}

              {scene.type === 'image' && <>
                <span className="block text-xs text-gray-400">Ảnh của cảnh</span>
                {filePick('Chọn ảnh', scene.imagePath, () => pickImage((path) => setScene(i, { imagePath: path })), () => setScene(i, { imagePath: '' }))}
                {show(`scene:${i}:image`)}
              </>}

              {scene.type === 'presenter' ? <>
                <label className="block text-xs text-gray-400">Lời thoại người dẫn nói (đọc không quá 15 giây)
                  <textarea className={FIELD} rows={2} value={scene.line} onChange={(e) => setScene(i, { line: e.target.value })} />
                </label>
                {show(`scene:${i}:line`)}
                <label className="block text-xs text-gray-400">Bối cảnh (tuỳ chọn, ví dụ "đứng trước dãy máy chủ")
                  <input className={FIELD} value={scene.setting} onChange={(e) => setScene(i, { setting: e.target.value })} />
                </label>
                {show(`scene:${i}:setting`)}
              </> : <>
                <div className="grid gap-2 sm:grid-cols-2 min-w-0">
                  <label className="block text-xs text-gray-400 min-w-0">Chuyển động (tuỳ chọn)
                    <input className={FIELD} value={scene.motion} onChange={(e) => setScene(i, { motion: e.target.value })} placeholder="camera chậm tiến vào" />
                  </label>
                  <label className="block text-xs text-gray-400 min-w-0">Độ dài (giây, 2–4,3; để trống cho hệ tự tính)
                    <input className={FIELD} value={scene.duration} onChange={(e) => setScene(i, { duration: e.target.value })} inputMode="decimal" placeholder="2.2" />
                  </label>
                </div>
                {show(`scene:${i}:motion`)}
                {show(`scene:${i}:duration`)}
                <label className="block text-xs text-gray-400">Lời đọc nền (tuỳ chọn; có thể phủ sang cảnh sau)
                  <textarea className={FIELD} rows={2} value={scene.voiceover} onChange={(e) => setScene(i, { voiceover: e.target.value })} />
                </label>
                {show(`scene:${i}:voiceover`)}
              </>}
            </li>
          ))}
        </ol>
      </section>

      {hasPresenterScene && (
        <section aria-label="Người dẫn" className="space-y-2 min-w-0">
          <h4 className="text-sm font-semibold">Người dẫn</h4>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={form.presenterMode === 'image' ? 'poster-primary' : 'poster-button'} onClick={() => set('presenterMode', 'image')} disabled={submitting}>Ảnh của tôi</button>
            <button type="button" className={form.presenterMode === 'prompt' ? 'poster-primary' : 'poster-button'} onClick={() => set('presenterMode', 'prompt')} disabled={submitting}>Để AI vẽ</button>
          </div>
          {form.presenterMode === 'image'
            ? filePick('Chọn ảnh người dẫn', form.presenterImagePath, () => pickImage((path) => set('presenterImagePath', path)), () => set('presenterImagePath', ''))
            : <label className="block text-xs text-gray-400">Mô tả người dẫn
              <textarea className={FIELD} rows={2} value={form.presenterPrompt} onChange={(e) => set('presenterPrompt', e.target.value)} placeholder="nam Việt 30 tuổi, áo vest navy, nền studio" />
            </label>}
          {show('presenter')}
        </section>
      )}

      <section aria-label="Giọng đọc" className="space-y-2 min-w-0">
        <h4 className="text-sm font-semibold">Giọng đọc</h4>
        <div className="grid gap-2 sm:grid-cols-2 min-w-0">
          <label className="block text-xs text-gray-400 min-w-0">Giọng
            <select className={FIELD} value={form.voiceName} onChange={(e) => set('voiceName', e.target.value)} disabled={submitting}>
              <option value="">Giọng mặc định</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.region ? ` · ${v.region}` : ''}</option>)}
            </select>
          </label>
          <label className="block text-xs text-gray-400 min-w-0">Tốc độ (0,7–1,3)
            <input className={FIELD} value={form.voiceSpeed} onChange={(e) => set('voiceSpeed', e.target.value)} inputMode="decimal" />
          </label>
        </div>
        {show('voice')}
      </section>

      <section aria-label="Nhạc nền" className="space-y-2 min-w-0">
        <h4 className="text-sm font-semibold">Nhạc nền</h4>
        <div className="flex flex-wrap gap-2">
          {([['none', 'Không nhạc'], ['file', 'Tệp nhạc của tôi'], ['prompt', 'Để AI tạo nhạc']] as const).map(([mode, label]) => (
            <button key={mode} type="button" className={form.musicMode === mode ? 'poster-primary' : 'poster-button'} onClick={() => set('musicMode', mode)} disabled={submitting}>{label}</button>
          ))}
        </div>
        {form.musicMode === 'file' && filePick('Chọn tệp nhạc', form.musicPath,
          async () => { const p = await pick('Nhạc', VIDEO_MUSIC_EXTENSIONS); if (p) set('musicPath', p); },
          () => set('musicPath', ''))}
        {form.musicMode === 'prompt' && (
          <label className="block text-xs text-gray-400">Mô tả nhạc
            <input className={FIELD} value={form.musicPrompt} onChange={(e) => set('musicPrompt', e.target.value)} placeholder="nhạc quảng cáo nhẹ nhàng, tươi vui, không lời" />
          </label>
        )}
        {show('music')}
      </section>

      <section aria-label="Thương hiệu" className="space-y-2 min-w-0">
        <h4 className="text-sm font-semibold">Thương hiệu (tuỳ chọn, thêm khung cuối ~2,6 giây)</h4>
        {filePick('Chọn logo', form.brandLogoPath, () => pickImage((path) => set('brandLogoPath', path)), () => set('brandLogoPath', ''))}
        <div className="grid gap-2 sm:grid-cols-2 min-w-0">
          <label className="block text-xs text-gray-400 min-w-0">Website
            <input className={FIELD} value={form.brandWebsite} onChange={(e) => set('brandWebsite', e.target.value)} placeholder="example.com" autoComplete="off" />
          </label>
          <label className="block text-xs text-gray-400 min-w-0">Câu kết (được đọc lên)
            <input className={FIELD} value={form.brandEndLine} onChange={(e) => set('brandEndLine', e.target.value)} placeholder="Ghé cửa hàng ngay hôm nay." />
          </label>
        </div>
        {show('brand')}
      </section>

      {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="poster-primary" disabled={submitting}>{submitting ? 'Đang gửi…' : 'Tạo video quảng cáo'}</button>
        <button type="button" className="poster-button" onClick={onCancel} disabled={submitting}>Huỷ</button>
        {touched && invalid && <span className="text-xs text-red-400">Còn ô chưa hợp lệ.</span>}
      </div>
    </form>
  );
}
