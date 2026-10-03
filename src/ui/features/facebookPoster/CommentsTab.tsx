import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import ProfilePicker from './ProfilePicker';
import type { FbPosterComment } from '../../../models/facebookPoster';

const PAGE_SIZE = 100;
type PostedUrl = { postUrl: string; profileId: string; profileName: string; targetUrl: string; createdAt: number };

interface Props { busy: boolean; onStarted: () => void }

const openLink = (url: string) => { if (ipc.shell?.openExternal) ipc.shell.openExternal(url); else window.open(url, '_blank'); };
const formatTime = (at: number) => new Date(at).toLocaleString('vi-VN', { hour12: false });

export default function CommentsTab({ busy, onStarted }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [posts, setPosts] = useState<PostedUrl[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);

  const [comments, setComments] = useState<FbPosterComment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [postFilter, setPostFilter] = useState('');
  const [search, setSearch] = useState('');
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const off = ipc.on?.('facebookPoster:runFinished', () => setReloadTick((n) => n + 1));
    return () => off?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPostsLoading(true);
    ipc.facebookPoster?.listPostedUrls().then((res) => {
      if (cancelled) return;
      if (res?.success) setPosts(res.posts || []);
      else showNotification(res?.error || 'Không tải được danh sách bài', 'error');
    }).catch(() => { if (!cancelled) showNotification('Không tải được danh sách bài', 'error'); })
      .finally(() => { if (!cancelled) setPostsLoading(false); });
    return () => { cancelled = true; setPostsLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  useEffect(() => {
    let cancelled = false;
    setCommentsLoading(true);
    ipc.facebookPoster?.listComments({ postUrl: postFilter || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }).then((res) => {
      if (cancelled) return;
      if (res?.success) { setComments(res.comments || []); setTotal(res.total ?? 0); }
      else showNotification(res?.error || 'Không tải được bình luận', 'error');
    }).catch(() => { if (!cancelled) showNotification('Không tải được bình luận', 'error'); })
      .finally(() => { if (!cancelled) setCommentsLoading(false); });
    return () => { cancelled = true; setCommentsLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postFilter, page, reloadTick]);

  const togglePost = (url: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(url)) next.delete(url); else next.add(url);
    return next;
  });

  const disabledReason = busy ? 'Đang có việc chạy. Đợi xong hoặc hủy việc đó.'
    : profileIds.length === 0 ? 'Chọn một profile.'
    : picked.size === 0 ? 'Chọn ít nhất một bài.'
    : '';

  const handleCollect = async () => {
    setStarting(true);
    try {
      const res = await ipc.facebookPoster?.start('collect_comments', { profileId: profileIds[0], postUrls: [...picked] });
      if (!res?.success) showNotification(res?.error || 'Không bắt đầu được', 'error');
      else onStarted();
    } catch (err: any) {
      showNotification(err?.message || 'Không bắt đầu được', 'error');
    } finally {
      setStarting(false);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? comments.filter((c) => `${c.authorName} ${c.text}`.toLowerCase().includes(q)) : comments;
  }, [comments, search]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6 min-w-0">
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-white">Thu bình luận</h3>
        <ProfilePicker mode="single" selected={profileIds} onChange={setProfileIds} disabled={busy} />
        {postsLoading ? <div className="flex justify-center py-4"><Spinner size={5} /></div>
          : posts.length === 0 ? <p className="text-sm text-gray-400 text-center py-4">Chưa có bài nào có link để thu bình luận.</p>
          : (
            <ul className="max-h-56 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-800" aria-label="Bài đã đăng">
              {posts.map((p) => (
                <li key={p.postUrl} className="flex items-center gap-2 px-3 py-2 min-w-0">
                  <input type="checkbox" aria-label={`Chọn bài ${p.postUrl}`} checked={picked.has(p.postUrl)} onChange={() => togglePost(p.postUrl)} disabled={busy} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 truncate" title={p.profileName}>{p.profileName}</p>
                    <p className="text-xs text-gray-400 truncate" title={p.targetUrl}>{p.targetUrl}</p>
                  </div>
                  <span className="text-xs text-gray-400 whitespace-nowrap hidden sm:inline">{formatTime(p.createdAt)}</span>
                  <button type="button" onClick={() => openLink(p.postUrl)} className="text-xs text-blue-400 hover:underline whitespace-nowrap">Mở bài</button>
                </li>
              ))}
            </ul>
          )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={handleCollect} disabled={!!disabledReason || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">
            {starting ? 'Đang bắt đầu...' : 'Thu bình luận'}
          </button>
          {disabledReason && <span className="text-xs text-gray-400">{disabledReason}</span>}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-white">Bình luận đã thu ({total})</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input-field text-sm flex-1 min-w-[160px]" aria-label="Tìm bình luận" placeholder="Tìm trong trang đang hiển thị" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input-field text-sm w-auto max-w-full" aria-label="Lọc theo bài" value={postFilter} onChange={(e) => { setPostFilter(e.target.value); setPage(0); }}>
            <option value="">Tất cả bài</option>
            {posts.map((p) => <option key={p.postUrl} value={p.postUrl}>{p.profileName} - {p.postUrl}</option>)}
          </select>
        </div>
        {commentsLoading ? <div className="flex justify-center py-6"><Spinner size={5} /></div>
          : shown.length === 0 ? <p className="text-sm text-gray-400 text-center py-6">{comments.length === 0 ? 'Chưa thu bình luận nào.' : 'Không có bình luận khớp.'}</p>
          : (
            <div className="overflow-x-auto rounded-lg border border-gray-700">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-400 text-left">
                  <tr><th className="px-3 py-2">Người bình luận</th><th className="px-3 py-2">Nội dung</th><th className="px-3 py-2">Bài</th><th className="px-3 py-2 whitespace-nowrap">Thu lúc</th></tr>
                </thead>
                <tbody className="divide-y divide-gray-800 align-top">
                  {shown.map((c) => (
                    <tr key={c.key}>
                      <td className="px-3 py-2 max-w-[10rem] break-words">
                        {c.authorUrl ? <button type="button" onClick={() => openLink(c.authorUrl)} className="text-blue-400 hover:underline text-left">{c.authorName || c.authorUrl}</button> : <span className="text-gray-200">{c.authorName}</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-200 whitespace-pre-wrap break-words min-w-[12rem]">{c.text}</td>
                      <td className="px-3 py-2"><button type="button" onClick={() => openLink(c.postUrl)} className="text-blue-400 hover:underline whitespace-nowrap">Mở bài</button></td>
                      <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{formatTime(c.collectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 text-xs text-gray-400">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Trước</button>
            <span>Trang {page + 1}/{pageCount}</span>
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pageCount} className="px-3 py-1 rounded-lg border border-gray-600 disabled:opacity-50">Sau</button>
          </div>
        )}
      </section>
    </div>
  );
}
