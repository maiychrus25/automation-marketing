import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import VideoLibrary from './VideoLibrary';
import VideoTemplateForm, { type MusicTrack, type VideoRenderRequest } from './VideoTemplateForm';
import type { VideoTemplate } from './videoFormat';
import type { VideoJob } from '../../../models/video';

const LIST_LIMIT = 100;

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

  useEffect(() => { loadSettings(); loadList(); }, [loadSettings, loadList]);
  useEffect(() => {
    const off = ipc.on?.('video:changed', () => { loadList(); });
    return () => { off?.(); };
  }, [loadList]);

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

  const cancel = (video: VideoJob) => run(video, () => ipc.video!.cancel(video.id), 'Không huỷ được video');
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
        <h2 className="text-base font-semibold">Tạo video</h2>
        {configured === null ? <div className="flex justify-center py-6" role="status" aria-label="Đang tải"><Spinner size={5} /></div>
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
