import React, { useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import ProfilePicker from './ProfilePicker';
import ScheduleDialog from './ScheduleDialog';
import MediaPicker from './MediaPicker';
import PostPreview from './PostPreview';
import { matchesKeywords } from './matchKeywords';
import { validateMediaSelection, type MediaItem } from '../../../services/facebookPoster/mediaRules';
import type { FbPosterGroup, FbPosterMode } from '../../../models/facebookPoster';

const MAX_TEXT = 63206;
const MAX_COMMENT = 8000;

interface Props {
  busy: boolean;
  profileNames: Map<string, string>;
  onStarted: () => void;
  open: boolean;
  onClose: () => void;
  initialProfileIds: string[];
  initialRunAt?: number;
}

const splitLines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

export default function PostTab({ busy, profileNames, onStarted, open, onClose, initialProfileIds, initialRunAt }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [mode, setMode] = useState<FbPosterMode>('group');
  const [text, setText] = useState('');
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [comment, setComment] = useState('');
  const [profileIds, setProfileIds] = useState<string[]>(initialProfileIds);
  const [keyword, setKeyword] = useState('');
  const [groupsByProfile, setGroupsByProfile] = useState<Record<string, FbPosterGroup[]>>({});
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [extraLinks, setExtraLinks] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [minDelaySec, setMinDelaySec] = useState(300);
  const [maxDelaySec, setMaxDelaySec] = useState(900);
  const [concurrency, setConcurrency] = useState(3);
  const [staggerMinSec, setStaggerMinSec] = useState(30);
  const [staggerMaxSec, setStaggerMaxSec] = useState(90);
  const [starting, setStarting] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [operationError, setOperationError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  const reportError = (message: string) => { setOperationError(message); showNotification(message, 'error'); };

  // Reload scanned groups when the selection changes and when a run ends (a scan may have just finished).
  const idsKey = profileIds.join(',');
  useEffect(() => {
    if (mode !== 'group' || profileIds.length === 0 || busy) return;
    let cancelled = false;
    setGroupsLoading(true);
    setOperationError('');
    ipc.facebookPoster?.listGroups(profileIds).then((res) => {
      if (cancelled) return;
      if (res?.success) setGroupsByProfile(res.groups || {});
      else reportError(res?.error || 'Không tải được danh sách nhóm');
    }).catch(() => { if (!cancelled) reportError('Không tải được danh sách nhóm'); })
      .finally(() => { if (!cancelled) setGroupsLoading(false); });
    return () => { cancelled = true; setGroupsLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, mode, busy]);

  const key = (profileId: string, url: string) => `${profileId}|${url}`;
  const filteredGroups = (id: string) => (groupsByProfile[id] || []).filter((g) => matchesKeywords(g.name, keyword));
  const isChecked = (id: string, g: FbPosterGroup) => !unchecked.has(key(id, g.url));

  const targetsFor = (id: string): string[] => {
    const scanned = filteredGroups(id).filter((g) => isChecked(id, g)).map((g) => g.url);
    return [...new Set([...scanned, ...splitLines(extraLinks[id] || '')])];
  };

  const targetCounts = useMemo(
    () => profileIds.map((id) => targetsFor(id).length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileIds, groupsByProfile, keyword, unchecked, extraLinks],
  );

  const setChecked = (id: string, urls: string[], checked: boolean) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      for (const url of urls) { if (checked) next.delete(key(id, url)); else next.add(key(id, url)); }
      return next;
    });
  };
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const rescan = async (id: string) => {
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.start('scan_groups', { profileIds: [id], concurrency: 1 });
      if (!res?.success) reportError(res?.error || 'Không quét được nhóm');
      else { onStarted(); onClose(); }
    } catch (error) { reportError(error instanceof Error ? error.message : 'Không quét được nhóm'); }
  };

  // Scheduling is allowed while a run is active, so the busy clause is only part of the Start reason.
  const scheduleDisabledReason = profileIds.length === 0 ? 'Chọn ít nhất một profile.'
    : !text.trim() ? 'Nhập nội dung bài.'
    : mode === 'group' && targetCounts.some((n) => n === 0) ? 'Mỗi profile cần ít nhất một nhóm.'
    : validateMediaSelection(media) ?? '';
  const disabledReason = busy ? 'Đang có việc chạy. Đợi xong hoặc hủy việc đó.' : scheduleDisabledReason;

  const postParams = () => ({
    mode, text,
    mediaPaths: media.map((m) => m.path),
    comment,
    profiles: profileIds.map((profileId) => ({ profileId, targets: mode === 'group' ? targetsFor(profileId) : [] })),
    minDelaySec, maxDelaySec, concurrency, staggerMinSec, staggerMaxSec,
  });

  const handleStart = async () => {
    setStarting(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.start('post', postParams());
      if (!res?.success) reportError(res?.error || 'Không bắt đầu được');
      else { onStarted(); onClose(); }
    } catch (err: any) {
      reportError(err?.message || 'Không bắt đầu được');
    } finally {
      setStarting(false);
    }
  };

  const numberInput = (label: string, value: number, set: (n: number) => void, min: number, max?: number) => (
    <label className="block text-xs text-gray-400">
      {label}
      <input type="number" className="input-field text-sm w-full mt-1" min={min} max={max} value={value} disabled={busy}
        onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <dialog ref={dialogRef} className="poster-dialog poster-composer" aria-labelledby="poster-composer-title" onCancel={e => { e.preventDefault(); onClose(); }}>
      <header className="poster-dialog-header"><div><h2 id="poster-composer-title">Soạn bài</h2><p className="poster-muted text-sm mt-1">Chọn kênh, viết nội dung và xem trước bài đăng.</p></div>
        <button type="button" className="poster-icon-button" aria-label="Đóng trình soạn bài" onClick={onClose}>✕</button>
      </header>
      <div className="poster-composer-grid">
      <div className="poster-editor space-y-4 min-w-0">
      <div role="group" aria-label="Chế độ đăng" className="inline-flex rounded-lg border border-gray-600 overflow-hidden">
        {(['group', 'page'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} disabled={busy}
            className={`px-4 py-1.5 text-sm ${mode === m ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
            {m === 'group' ? 'Nhóm' : 'Trang'}
          </button>
        ))}
      </div>

      <label className="block text-xs text-gray-400">
        Nội dung bài
        <textarea className="input-field text-sm w-full mt-1 min-h-[220px] max-h-[60vh] resize-y leading-relaxed" maxLength={MAX_TEXT} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
        <span className="block text-right mt-0.5">{text.length}/{MAX_TEXT}</span>
      </label>

      <MediaPicker items={media} onChange={setMedia} disabled={busy} />

      <label className="block text-xs text-gray-400">
        Bình luận đầu tiên (tuỳ chọn)
        <textarea className="input-field text-sm w-full mt-1 min-h-[60px]" maxLength={MAX_COMMENT} value={comment} disabled={busy} onChange={(e) => setComment(e.target.value)} />
      </label>

      <section>
        <h3 className="text-sm font-medium text-white mb-2">Profile</h3>
        <ProfilePicker mode="multi" selected={profileIds} onChange={setProfileIds} disabled={busy} />
      </section>

      {mode === 'page' ? (
        <p className="text-xs text-gray-400 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2">
          Mỗi profile đăng lên Page mà nó đang đứng danh tính. Kiểm tra tên danh tính trong nhật ký.
        </p>
      ) : profileIds.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-white">Nhóm sẽ đăng</h3>
          <input className="input-field text-sm w-full" aria-label="Lọc nhóm theo từ khoá" placeholder="Lọc nhóm theo từ khoá, cách nhau dấu phẩy (không phân biệt dấu)"
            value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          {groupsLoading && <p className="text-xs text-gray-400">Đang tải danh sách nhóm...</p>}
          {profileIds.map((id) => {
            const all = groupsByProfile[id] || [];
            const shown = filteredGroups(id);
            const checkedCount = shown.filter((g) => isChecked(id, g)).length;
            const open = expanded.has(id);
            return (
              <div key={id} className="rounded-lg border border-gray-700 min-w-0">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => toggleExpanded(id)} aria-expanded={open}
                    className="flex-1 min-w-0 text-left text-sm text-gray-200 truncate" title={profileNames.get(id) || id}>
                    {open ? '▾' : '▸'} {profileNames.get(id) || id}
                  </button>
                  <span className="text-xs text-gray-400 whitespace-nowrap">{checkedCount}/{shown.length} nhóm</span>
                  <button type="button" onClick={() => rescan(id)} disabled={busy} className="px-2.5 py-1 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">Quét lại nhóm</button>
                </div>
                {open && (
                  <div className="px-3 pb-3 space-y-2 border-t border-gray-700 pt-2">
                    {all.length === 0 ? (
                      <p className="text-xs text-gray-400">Chưa quét nhóm. Bấm "Quét lại nhóm" hoặc dán link nhóm bên dưới.</p>
                    ) : shown.length === 0 ? (
                      <p className="text-xs text-gray-400">Không có nhóm nào khớp từ khoá.</p>
                    ) : (
                      <>
                        <div className="flex gap-3 text-xs">
                          <button type="button" onClick={() => setChecked(id, shown.map((g) => g.url), true)} className="text-blue-400 hover:underline">Chọn tất cả</button>
                          <button type="button" onClick={() => setChecked(id, shown.map((g) => g.url), false)} className="text-blue-400 hover:underline">Bỏ chọn tất cả</button>
                        </div>
                        <ul className="max-h-48 overflow-y-auto divide-y divide-gray-800">
                          {shown.map((g) => (
                            <li key={g.url}>
                              <label className="flex items-center gap-2 py-1.5 cursor-pointer min-w-0">
                                <input type="checkbox" checked={isChecked(id, g)} disabled={busy} onChange={(e) => setChecked(id, [g.url], e.target.checked)} />
                                <span className="text-sm text-gray-200 truncate" title={g.name}>{g.name}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <label className="block text-xs text-gray-400">
                      Thêm link nhóm (mỗi dòng một link)
                      <textarea className="input-field text-sm w-full mt-1 min-h-[56px]" value={extraLinks[id] || ''} disabled={busy}
                        onChange={(e) => setExtraLinks((prev) => ({ ...prev, [id]: e.target.value }))} />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      <details className="poster-advanced">
      <summary className="cursor-pointer poster-muted text-sm">Tuỳ chọn vận hành</summary>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        {numberInput('Nghỉ tối thiểu (giây)', minDelaySec, setMinDelaySec, 0, 86400)}
        {numberInput('Nghỉ tối đa (giây)', maxDelaySec, setMaxDelaySec, 0, 86400)}
        {numberInput('Số profile song song (1–10)', concurrency, setConcurrency, 1, 10)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {numberInput('Giãn cách khởi động tối thiểu (giây)', staggerMinSec, setStaggerMinSec, 0, 3600)}
        {numberInput('Giãn cách khởi động tối đa (giây)', staggerMaxSec, setStaggerMaxSec, 0, 3600)}
        <p className="text-[11px] text-gray-400 self-end pb-2">
          Profile sau bắt đầu cách profile trước một khoảng ngẫu nhiên trong giới hạn này. Đặt 0–0 để bật đồng loạt; giãn cách giúp các tài khoản không khởi động cùng một lúc.
        </p>
      </div>
      </details>

      <div className="poster-composer-footer flex flex-wrap items-center gap-3">
        {operationError && <p role="alert" className="w-full text-sm text-red-400 break-words">{operationError}</p>}
        <button type="button" onClick={handleStart} disabled={!!disabledReason || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">
          {starting ? 'Đang bắt đầu...' : 'Đăng ngay'}
        </button>
        <button type="button" onClick={() => setScheduling(true)} disabled={!!scheduleDisabledReason} className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-60">
          Hẹn giờ
        </button>
        {disabledReason && <span className="text-xs text-gray-400">{disabledReason}</span>}
      </div>
      </div>
      <aside className="poster-composer-preview"><div className="flex items-center justify-between mb-5"><h3 className="font-semibold">Xem trước</h3><span className="poster-muted text-xs">Facebook</span></div>
        <PostPreview text={text} comment={comment} mediaPaths={media.map(item => item.path)} mode={mode} names={profileIds.map(id => profileNames.get(id) || id)}
          targetName={filteredGroups(profileIds[0]).find(group => isChecked(profileIds[0], group))?.name} />
      </aside>
      </div>
      {scheduling && <ScheduleDialog onClose={() => setScheduling(false)} buildParams={postParams} defaultName={text.trim()} initialRunAt={initialRunAt} onSaved={onClose} />}
    </dialog>
  );
}
