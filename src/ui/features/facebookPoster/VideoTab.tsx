import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import AdVideoForm from './AdVideoForm';
import VideoLibrary from './VideoLibrary';
import VideoTemplateForm, { type MusicTrack, type VideoRenderRequest } from './VideoTemplateForm';
import type { VideoTemplate } from './videoFormat';
import type { AdVideoRequest, AdVoiceOption, VideoJob } from '../../../models/video';

const LIST_LIMIT = 100;

/** Hai máy dựng video: mẫu HyperFrames (máy chủ render riêng) và video quảng cáo AI (AHV AI). */
type Mode = 'hyperframes' | 'ahv_ad';

export default function VideoTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const setPosterComposeMediaPaths = useAppStore((s) => s.setPosterComposeMediaPaths);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<VideoTemplate[]>([]);
  const [music, setMusic] = useState<MusicTrack[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState('');
  const [selected, setSelected] = useState<VideoTemplate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [videos, setVideos] = useState<VideoJob[]>([]);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [playing, setPlaying] = useState<VideoJob | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [mode, setMode] = useState<Mode>('hyperframes');
  const [adConfigured, setAdConfigured] = useState<boolean | null>(null);
  const [adOpen, setAdOpen] = useState(false);
  const [adError, setAdError] = useState('');
  const [voices, setVoices] = useState<AdVoiceOption[]>([]);
  // Chỉ phản hồi của lần gọi mới nhất được ghi vào state; mọi lần gọi bị bỏ khi tab đã gỡ.
  const listSeq = useRef(0);
  const templatesSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const res = await ipc.video?.list({ limit: LIST_LIMIT });
      if (seq !== listSeq.current || !alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không tải được thư viện video');
      setVideos(res.videos ?? []);
      setTotal(res.total ?? res.videos?.length ?? 0);
      setListError('');
      // Video đang xem bị xoá ở nơi khác thì đóng trình phát.
      setPlaying((p) => (p && !(res.videos ?? []).some((v) => v.id === p.id) ? null : p));
    } catch (err) { if (seq === listSeq.current && alive.current) setListError(err instanceof Error ? err.message : 'Không tải được thư viện video'); }
    finally { if (seq === listSeq.current && alive.current) setListLoading(false); }
  }, []);

  const loadTemplates = useCallback(async () => {
    const seq = ++templatesSeq.current;
    setTemplatesLoading(true);
    setTemplatesError('');
    try {
      const res = await ipc.video?.templates();
      if (seq !== templatesSeq.current || !alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không tải được danh sách mẫu');
      setTemplates(res.templates ?? []);
      setMusic(res.music ?? []);
    } catch (err) { if (seq === templatesSeq.current && alive.current) setTemplatesError(err instanceof Error ? err.message : 'Không tải được danh sách mẫu'); }
    finally { if (seq === templatesSeq.current && alive.current) setTemplatesLoading(false); }
  }, []);

  /** Cấu hình AHV AI đọc riêng: chưa cấu hình thì chế độ quảng cáo AI chỉ hiện hướng dẫn. */
  const loadAdSettings = useCallback(async () => {
    try {
      const res = await ipc.video?.ahvSettingsGet();
      if (!alive.current) return;
      setAdConfigured(!!res?.success && !!res.configured);
    } catch { if (alive.current) setAdConfigured(false); }
  }, []);

  const loadVoices = useCallback(async () => {
    try {
      const res = await ipc.video?.voices();
      if (!alive.current || !res?.success) return;
      setVoices(res.voices ?? []);
    } catch { /* không có danh sách giọng thì vẫn dùng được giọng mặc định */ }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await ipc.video?.settingsGet();
      if (!alive.current) return;
      if (!res?.success) throw new Error(res?.error || 'Không đọc được cài đặt máy chủ render');
      setSettingsError('');
      setConfigured(!!res.configured);
      if (res.configured) loadTemplates();
    } catch (err) { if (alive.current) { setSettingsError(err instanceof Error ? err.message : 'Không đọc được cài đặt máy chủ render'); setConfigured(false); } }
  }, [loadTemplates]);

  useEffect(() => { loadSettings(); loadAdSettings(); loadList(); }, [loadSettings, loadAdSettings, loadList]);
  useEffect(() => { if (mode === 'ahv_ad' && adConfigured && voices.length === 0) loadVoices(); }, [mode, adConfigured, voices.length, loadVoices]);
  useEffect(() => {
    const off = ipc.on?.('video:changed', () => { loadList(); });
    return () => { off?.(); };
  }, [loadList]);

  const createAd = async (request: AdVideoRequest) => {
    setSubmitting(true);
    setAdError('');
    try {
      const res = await ipc.video?.adCreate(request);
      if (!alive.current) return;
      if (!res?.success) { setAdError(res?.error || 'Không tạo được video quảng cáo'); return; }
      showNotification('Đã gửi kịch bản sang AHV AI, theo dõi tiến độ trong thư viện', 'success');
      setAdOpen(false);
      loadList();
    } catch (err) { if (alive.current) setAdError(err instanceof Error && err.message ? err.message : 'Không tạo được video quảng cáo'); }
    finally { if (alive.current) setSubmitting(false); }
  };

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('nav:view', { detail: { view: 'settings' } }));
    setTimeout(() => window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'renderServer' } })), 80);
  };

  const create = async (request: VideoRenderRequest) => {
    setSubmitting(true);
    setFormError('');
    try {
      const res = await ipc.video?.render(request);
      if (!alive.current) return;
      if (!res?.success) { setFormError(res?.error || 'Không tạo được video'); return; }
      showNotification('Đã gửi yêu cầu tạo video, theo dõi tiến độ trong thư viện', 'success');
      setSelected(null);
      loadList();
    } catch (err) { if (alive.current) setFormError(err instanceof Error && err.message ? err.message : 'Không tạo được video'); }
    finally { if (alive.current) setSubmitting(false); }
  };

  const run = async (video: VideoJob, action: () => Promise<{ success: boolean; error?: string } | undefined>, fallback: string, after?: (res: any) => void) => {
    setBusyId(video.id);
    try {
      const res = await action();
      if (!res?.success) throw new Error(res?.error || fallback);
      after?.(res);
    } catch (err) { showNotification(err instanceof Error && err.message ? err.message : fallback, 'error'); }
    finally { if (alive.current) setBusyId(null); loadList(); }
  };

  const cancel = async (video: VideoJob) => {
    // Video quảng cáo AI: AHV không có đường huỷ, job bên đó vẫn chạy và vẫn tốn tiền máy.
    if (video.engine === 'ahv_ad') {
      const ok = await showConfirm({
        title: 'Bỏ theo dõi video quảng cáo?',
        message: `MaiHub sẽ ngừng theo dõi "${video.name}", nhưng AHV AI vẫn dựng tiếp video này và vẫn tính tiền máy. Không lấy lại được kết quả sau khi bỏ theo dõi.`,
        confirmText: 'Bỏ theo dõi', variant: 'danger',
      });
      if (!ok) return;
    }
    await run(video, () => ipc.video!.cancel(video.id), 'Không huỷ được video');
  };
  const exportFile = (video: VideoJob) => run(video, () => ipc.video!.exportFile(video.id), 'Không tải được video',
    (res) => { if (res.saved) showNotification('Đã lưu video', 'success'); });
  const remove = async (video: VideoJob) => {
    const ok = await showConfirm({ title: 'Xoá video?', message: `Video "${video.name}" và tệp trên máy sẽ bị xoá, không khôi phục được.`, confirmText: 'Xoá', variant: 'danger' });
    if (ok) await run(video, () => ipc.video!.delete(video.id), 'Không xoá được video');
  };
  const useInComposer = (video: VideoJob) => {
    if (!video.filePath) return;
    setPosterComposeMediaPaths([video.filePath]);
  };

  return (
    <div className="space-y-8 min-w-0">
      <section aria-label="Tạo video" className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Tạo video</h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Chọn cách tạo video">
            <button type="button" className={mode === 'hyperframes' ? 'poster-primary' : 'poster-button'}
              aria-pressed={mode === 'hyperframes'} onClick={() => { setMode('hyperframes'); setAdOpen(false); }}>Mẫu HyperFrames</button>
            <button type="button" className={mode === 'ahv_ad' ? 'poster-primary' : 'poster-button'}
              aria-pressed={mode === 'ahv_ad'} onClick={() => { setMode('ahv_ad'); setSelected(null); }}>Video quảng cáo AI</button>
          </div>
        </div>
        {mode === 'ahv_ad' ? (
          adConfigured === null ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải"><Spinner size={5} /></div>
          : !adConfigured ? (
            <div className="rounded-lg border border-gray-700 p-4 space-y-2" role="region" aria-label="Chưa cấu hình AHV AI">
              <p className="text-sm font-medium">Chưa cấu hình AHV AI</p>
              <p className="poster-muted text-xs">Video quảng cáo nhiều cảnh được dựng trên AHV AI. Vào Cài đặt → Máy chủ render video, nhập địa chỉ và khoá API của AHV AI rồi bấm Kiểm tra kết nối.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="poster-primary" onClick={openSettings}>Mở cài đặt</button>
                <button type="button" className="poster-button" onClick={loadAdSettings}>Kiểm tra lại</button>
              </div>
            </div>)
          : adOpen ? <AdVideoForm voices={voices} submitting={submitting} error={adError} onSubmit={createAd} onCancel={() => { setAdOpen(false); setAdError(''); }} />
          : (
            <div className="rounded-lg border border-gray-700 p-4 space-y-2" role="region" aria-label="Video quảng cáo AI">
              <p className="text-sm font-medium">Video quảng cáo AI nhiều cảnh</p>
              <p className="poster-muted text-xs break-words">Kịch bản 2–10 cảnh, có người dẫn nói tiếng Việt, giọng đọc, nhạc nền và khung cuối. Video dọc 1080×1920, mất khoảng 20–60 phút.</p>
              <button type="button" className="poster-primary" onClick={() => { setAdError(''); setAdOpen(true); }}>Viết kịch bản mới</button>
            </div>)
        ) : configured === null ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải"><Spinner size={5} /></div>
          : !configured ? (
            <div className="rounded-lg border border-gray-700 p-4 space-y-2" role="region" aria-label="Chưa cấu hình máy chủ render">
              <p className="text-sm font-medium">Chưa cấu hình máy chủ render video</p>
              <p className="poster-muted text-xs">Video được dựng trên máy chủ riêng. Vào Cài đặt, nhập địa chỉ và khoá API rồi bấm Thử kết nối. Các mục khác vẫn dùng bình thường.</p>
              {settingsError && <p role="alert" className="text-xs text-red-400 break-words">{settingsError}</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" className="poster-primary" onClick={openSettings}>Mở cài đặt máy chủ render</button>
                <button type="button" className="poster-button" onClick={loadSettings}>Kiểm tra lại</button>
              </div>
            </div>)
          : selected ? <VideoTemplateForm key={selected.id} template={selected} music={music} submitting={submitting} error={formError}
            onSubmit={create} onCancel={() => { setSelected(null); setFormError(''); }} />
          : templatesLoading ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải mẫu"><Spinner size={5} /></div>
          : templatesError ? (
            <div className="space-y-2"><p role="alert" className="text-sm text-red-400 break-words">{templatesError}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="poster-button" onClick={loadTemplates}>Thử lại</button>
                <button type="button" className="poster-button" onClick={openSettings}>Mở cài đặt</button>
              </div></div>)
          : templates.length === 0 ? <p className="poster-muted text-sm">Máy chủ chưa có mẫu nào.</p>
          : <ul className="grid gap-3 min-w-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))' }}>
            {templates.map((t) => (
              <li key={t.id} className="min-w-0">
                <button type="button" className="w-full h-full text-left rounded-lg border border-gray-700 p-3 space-y-1 hover:bg-gray-700/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                  onClick={() => { setFormError(''); setSelected(t); }}>
                  <span className="block text-sm font-medium break-words">{t.name}</span>
                  <span className="block poster-muted text-xs break-words">{t.description}</span>
                  <span className="block poster-muted text-xs">Khổ: {t.aspects.join(', ')} · {t.imageSlots.min === t.imageSlots.max ? t.imageSlots.min : `${t.imageSlots.min}–${t.imageSlots.max}`} ảnh</span>
                </button>
              </li>))}
          </ul>}
      </section>

      <section aria-label="Thư viện video" className="space-y-3 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Thư viện{total > 0 ? ` (${total})` : ''}</h2>
          <button type="button" className="poster-button" onClick={loadList}>Làm mới</button>
        </div>
        {listError && <p role="alert" className="text-sm text-red-400 break-words">{listError}</p>}
        {listLoading ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải"><Spinner size={5} /></div>
          : <VideoLibrary videos={videos} busyId={busyId} playing={playing} onPlay={setPlaying} onUse={useInComposer} onExport={exportFile} onCancel={cancel} onDelete={remove} />}
      </section>
    </div>
  );
}
