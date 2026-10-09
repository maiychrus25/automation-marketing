import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { buildWriteMessages, buildPolishMessages } from '../../../services/ai/fbContentPrompt';
import type { MediaItem } from '../../../services/facebookPoster/mediaRules';

/** Khối Trợ Lý AI trong PostTab: viết/trau chuốt content + gen ảnh (template thiệp / minh hoạ). */
export default function AIAssistPanel({ text, setText, setMedia, disabled }: {
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setMedia: React.Dispatch<React.SetStateAction<MediaItem[]>>;
  disabled?: boolean;
}) {
  const [assistants, setAssistants] = useState<any[]>([]);
  const [assistantId, setAssistantId] = useState('');
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [brief, setBrief] = useState('');
  const [imgPrompt, setImgPrompt] = useState('');
  const [tplId, setTplId] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    ipc.ai?.listAssistants().then((r: any) => {
      const list = (r?.assistants || r || []) as any[];
      setAssistants(list);
      if (list[0]) setAssistantId(list[0].id);
    }).catch(() => {});
    ipc.ai?.listPosterTemplates().then((r: any) => setTemplates(r?.templates || [])).catch(() => {});
  }, []);

  const run = async (mode: 'write' | 'polish') => {
    setErr('');
    try {
      const messages = mode === 'write' ? buildWriteMessages(brief) : buildPolishMessages(text);
      setBusy(mode);
      const r = await ipc.ai?.chat(assistantId, messages);
      if (r?.success && r.result) setText(r.result);
      else setErr(r?.error || 'Trợ lý AI lỗi');
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const genImage = async () => {
    setErr(''); setBusy('img');
    try {
      const base = tplId ? templates.find(t => t.id === tplId) : null;
      const r = await ipc.ai?.generateImage({
        assistantId,
        prompt: imgPrompt.trim() || text.slice(0, 500),
        baseImages: base ? [base.path] : undefined,
        size: base ? '1024x1536' : '1024x1024',
      });
      if (r?.success && r.localPath) setMedia(prev => [...prev, { path: r.localPath!, size: r.size || 0 }]);
      else setErr(r?.error || 'Gen ảnh lỗi');
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const d = disabled || !assistantId || !!busy;
  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
        <span>✨ Trợ Lý AI</span>
        <select value={assistantId} onChange={e => setAssistantId(e.target.value)} className="ml-auto max-w-[55%] rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700">
          {assistants.length === 0 && <option value="">(chưa có trợ lý — cấu hình ở mục AI)</option>}
          {assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={2}
        placeholder="Brief ngắn (vd: tuyển Junior UA, 12-18M, HN)..."
        className="mb-2 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
      <div className="mb-2 flex flex-wrap gap-2">
        <button type="button" disabled={d || !brief.trim()} onClick={() => run('write')} className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy === 'write' ? 'Đang viết…' : 'Viết bài'}</button>
        <button type="button" disabled={d || !text.trim()} onClick={() => run('polish')} className="rounded bg-indigo-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy === 'polish' ? 'Đang sửa…' : 'Trau chuốt'}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={tplId} onChange={e => setTplId(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700">
          <option value="">Ảnh minh hoạ (gen tự do)</option>
          {templates.map(t => <option key={t.id} value={t.id}>Thiệp: {t.name}</option>)}
        </select>
        <input value={imgPrompt} onChange={e => setImgPrompt(e.target.value)} placeholder="Mô tả ảnh (bỏ trống = theo nội dung bài)"
          className="min-w-[150px] flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
        <button type="button" disabled={d} onClick={genImage} className="rounded bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy === 'img' ? 'Đang tạo ảnh…' : 'Tạo ảnh AI'}</button>
      </div>
      {err && <div className="mt-2 text-xs text-red-500">{err}</div>}
    </div>
  );
}
