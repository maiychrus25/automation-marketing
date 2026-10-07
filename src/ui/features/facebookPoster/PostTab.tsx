import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import ProfilePicker from './ProfilePicker';
import ScheduleDialog from './ScheduleDialog';
import MediaPicker from './MediaPicker';
import { matchesKeywords } from './matchKeywords';
import { validateMediaSelection, type MediaItem } from '../../../services/facebookPoster/mediaRules';
import type { FbPosterGroup, FbPosterMode } from '../../../models/facebookPoster';

const MAX_TEXT = 63206;
const MAX_COMMENT = 8000;

interface Props {
  busy: boolean;
  profileNames: Map<string, string>;
  onStarted: () => void;
}

const splitLines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

export default function PostTab({ busy, profileNames, onStarted }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [mode, setMode] = useState<FbPosterMode>('group');
  const [text, setText] = useState('');
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [comment, setComment] = useState('');
  const [profileIds, setProfileIds] = useState<string[]>([]);
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

  // Reload scanned groups when the selection changes and when a run ends (a scan may have just finished).
  const idsKey = profileIds.join(',');
  useEffect(() => {
    if (mode !== 'group' || profileIds.length === 0 || busy) return;
    let cancelled = false;
    setGroupsLoading(true);
    ipc.facebookPoster?.listGroups(profileIds).then((res) => {
      if (cancelled) return;
      if (res?.success) setGroupsByProfile(res.groups || {});
      else showNotification(res?.error || 'Không tải được danh sách nhóm', 'error');
    }).finally(() => { if (!cancelled) setGroupsLoading(false); });
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
    const res = await ipc.facebookPoster?.start('scan_groups', { profileIds: [id], concurrency: 1 });
    if (!res?.success) showNotification(res?.error || 'Không quét được nhóm', 'error');
    else onStarted();
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
    try {
      const res = await ipc.facebookPoster?.start('post', postParams());
      if (!res?.success) showNotification(res?.error || 'Không bắt đầu được', 'error');
      else onStarted();
    } catch (err: any) {
      showNotification(err?.message || 'Không bắt đầu được', 'error');
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
    <div className="space-y-4 min-w-0">
      <div role="group" aria-label="Chế độ đăng" className="inline-flex rounded-lg border border-gray-600 overflow-hidden">
        {(['group', 'page'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} disabled={busy}
            className={`px-4 py-1.5 text-sm ${mode === m ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
            {m === 'group' ? 'Nhóm' : 'Page'}
          </button>
        ))}
      </div>

      <label className="block text-xs text-gray-400">
        Nội dung bài
        <textarea className="input-field text-sm w-full mt-1 min-h-[110px]" maxLength={MAX_TEXT} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleStart} disabled={!!disabledReason || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">
          {starting ? 'Đang bắt đầu...' : 'Bắt đầu đăng'}
        </button>
        <button type="button" onClick={() => setScheduling(true)} disabled={!!scheduleDisabledReason} className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-60">
          Lên lịch
        </button>
        {disabledReason && <span className="text-xs text-gray-400">{disabledReason}</span>}
      </div>
      {scheduling && <ScheduleDialog onClose={() => setScheduling(false)} buildParams={postParams} defaultName={text.trim()} />}
    </div>
  );
}
