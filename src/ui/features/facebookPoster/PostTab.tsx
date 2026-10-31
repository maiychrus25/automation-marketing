import React, { useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import ProfilePicker from './ProfilePicker';
import ScheduleDialog from './ScheduleDialog';
import MediaPicker from './MediaPicker';
import PostPreview from './PostPreview';
import { matchesKeywords } from './matchKeywords';
import CampaignSelect from './CampaignSelect';
import { gradeChip } from './trackingFormat';
import { CAPACITY_REASON } from './runState';
import { hydrateTargets, targetsToSave, hydrateVariants, validateVariantTabs, buildVariantParams } from './draftForm';
import { VARIANT_LABELS, MAX_VARIANTS } from '../../../services/facebookPoster/variants';
import { validateMediaSelection, type MediaItem } from '../../../services/facebookPoster/mediaRules';
import type { GroupScore } from '../../../services/facebookPoster/groupScores';
import type { FbPosterGroup, FbPosterMode, FbPosterSchedule } from '../../../models/facebookPoster';

const MAX_TEXT = 63206;
const MAX_COMMENT = 8000;

interface Props {
  /** Two runs are live: Start/rescan wait (UI hint; the coordinator decides). Editing stays open. */
  atCapacity: boolean;
  profileNames: Map<string, string>;
  onStarted: (runId: string) => void;
  open: boolean;
  onClose: () => void;
  initialProfileIds: string[];
  initialRunAt?: number;
  /** Gắn sẵn các tệp (video từ mục Video) khi mở bài mới; bỏ qua khi sửa nháp. */
  initialMediaPaths?: string[];
  /** Mở lại một bản nháp để sửa: nội dung, ảnh (đường dẫn tuyệt đối), profile, nhóm. */
  draft?: { schedule: FbPosterSchedule; media: { path: string; size: number }[] };
}

const splitLines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

export default function PostTab({ atCapacity, profileNames, onStarted, open, onClose, initialProfileIds, initialRunAt, initialMediaPaths, draft }: Props) {
  const dp = draft?.schedule.params as Record<string, any> | undefined;
  const showNotification = useAppStore((s) => s.showNotification);
  const [mode, setMode] = useState<FbPosterMode>(dp?.mode === 'page' ? 'page' : 'group');
  const [text, setText] = useState<string>(typeof dp?.text === 'string' ? dp.text : '');
  const [variantTabs, setVariantTabs] = useState<string[]>(hydrateVariants(dp));
  const [activeTab, setActiveTab] = useState(0);
  const [campaignId, setCampaignId] = useState<string | null>(draft?.schedule.campaignId ?? null);
  const [media, setMedia] = useState<MediaItem[]>(draft?.media ?? (initialMediaPaths ?? []).map((path) => ({ path, size: 0 })));
  const [comment, setComment] = useState<string>(typeof dp?.comment === 'string' ? dp.comment : '');
  const [commentDelayMin, setCommentDelayMin] = useState<number>(Number.isInteger(dp?.commentDelayMin) ? dp!.commentDelayMin : 0);
  const [profileIds, setProfileIds] = useState<string[]>(
    dp ? ((dp.profiles ?? []) as { profileId: string }[]).map((p) => p.profileId) : initialProfileIds);
  const [keyword, setKeyword] = useState('');
  const [groupsByProfile, setGroupsByProfile] = useState<Record<string, FbPosterGroup[]>>({});
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [extraLinks, setExtraLinks] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [minDelaySec, setMinDelaySec] = useState<number>(dp?.minDelaySec ?? 300);
  const [maxDelaySec, setMaxDelaySec] = useState<number>(dp?.maxDelaySec ?? 900);
  const [concurrency, setConcurrency] = useState<number>(dp?.concurrency ?? 3);
  const [staggerMinSec, setStaggerMinSec] = useState<number>(dp?.staggerMinSec ?? 30);
  const [staggerMaxSec, setStaggerMaxSec] = useState<number>(dp?.staggerMaxSec ?? 90);
  const [savingDraft, setSavingDraft] = useState(false);
  const hydrated = useRef(!dp);
  const [starting, setStarting] = useState(false);
  // Refs block a second click in the same tick, before the disabled state renders.
  const startingRef = useRef(false);
  const savingRef = useRef(false);
  // profileId -> scan runId ('' while the start request is in flight); cleared when that run finishes.
  const scans = useRef(new Map<string, string>());
  const [, setScansVersion] = useState(0);
  const setScan = (profileId: string, runId: string | null) => {
    if (runId === null) scans.current.delete(profileId); else scans.current.set(profileId, runId);
    setScansVersion((n) => n + 1);
  };
  // runFinished seen while a scan start is still in flight (a fast scan can finish before start() resolves).
  const finishedEarly = useRef(new Set<string>());
  const [groupsTick, setGroupsTick] = useState(0);
  const [scheduling, setScheduling] = useState(false);
  const [operationError, setOperationError] = useState('');
  const [scoreByGroup, setScoreByGroup] = useState<Record<string, GroupScore>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  // Điểm nhóm (30 ngày): tải một lần mỗi lần mở; lỗi thì im lặng bỏ qua chip.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    ipc.facebookPoster?.groupScores({}).then((res) => {
      if (cancelled || !res?.success) return;
      setScoreByGroup(Object.fromEntries((res.groups || []).map((s) => [s.groupUrl, s])));
    }).catch(() => { /* bỏ qua */ });
    return () => { cancelled = true; };
  }, [open]);
  const reportError = (message: string) => { setOperationError(message); showNotification(message, 'error'); };

  // Reload scanned groups when the selection changes and when a run ends (a scan may have just finished).
  // Only the group list reloads; text, checks and links being edited stay as they are.
  useEffect(() => ipc.on?.('facebookPoster:runFinished', (data: { runId: string }) => {
    for (const [profileId, runId] of scans.current) if (runId === data.runId) setScan(profileId, null);
    if ([...scans.current.values()].includes('')) finishedEarly.current.add(data.runId);
    setGroupsTick((n) => n + 1);
  }), []);
  const idsKey = profileIds.join(',');
  useEffect(() => {
    if (mode !== 'group' || profileIds.length === 0) return;
    let cancelled = false;
    setGroupsLoading(true);
    setOperationError('');
    ipc.facebookPoster?.listGroups(profileIds).then((res) => {
      if (cancelled) return;
      if (res?.success) {
        const groups: Record<string, FbPosterGroup[]> = res.groups || {};
        setGroupsByProfile(groups);
        // Áp đích của nháp một lần, ngay khi danh sách nhóm tải xong (lần render đầu chưa có nhóm).
        if (!hydrated.current) {
          hydrated.current = true;
          const nextUnchecked = new Set<string>();
          const links: Record<string, string> = {};
          for (const entry of (dp?.profiles ?? []) as { profileId: string; targets: string[] }[]) {
            const h = hydrateTargets(entry.targets ?? [], (groups[entry.profileId] || []).map((g) => g.url));
            for (const url of h.uncheckedUrls) nextUnchecked.add(`${entry.profileId}|${url}`);
            if (h.extraLinks) links[entry.profileId] = h.extraLinks;
          }
          setUnchecked(nextUnchecked);
          setExtraLinks(links);
        }
      }
      else reportError(res?.error || 'Không tải được danh sách nhóm');
    }).catch(() => { if (!cancelled) reportError('Không tải được danh sách nhóm'); })
      .finally(() => { if (!cancelled) setGroupsLoading(false); });
    return () => { cancelled = true; setGroupsLoading(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, mode, groupsTick]);

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

  // The composer stays open: the list reloads when this scan finishes.
  const rescan = async (id: string) => {
    if (scans.current.has(id)) return;
    setScan(id, '');
    setOperationError('');
    let runId: string | null = null;
    try {
      const res = await ipc.facebookPoster?.start('scan_groups', { profileIds: [id], concurrency: 1 });
      if (!res?.success) reportError(res?.error || 'Không quét được nhóm');
      else if (res.runId) { runId = res.runId; onStarted(res.runId); }
    } catch (error) { reportError(error instanceof Error ? error.message : 'Không quét được nhóm'); }
    finally {
      const done = runId !== null && finishedEarly.current.has(runId);
      setScan(id, done ? null : runId);
      if (![...scans.current.values()].includes('')) finishedEarly.current.clear();
    }
  };

  // Scheduling is allowed at capacity, so the capacity clause is only part of the Start reason.
  const activeText = activeTab === 0 ? text : variantTabs[activeTab - 1] ?? '';
  const variantError = validateVariantTabs(text, variantTabs);
  const scheduleDisabledReason = profileIds.length === 0 ? 'Chọn ít nhất một profile.'
    : !text.trim() ? 'Nhập nội dung bài.'
    : variantError ? variantError
    : mode === 'group' && targetCounts.some((n) => n === 0) ? 'Mỗi profile cần ít nhất một nhóm.'
    : validateMediaSelection(media) ?? '';
  const disabledReason = atCapacity ? CAPACITY_REASON : scheduleDisabledReason;

  const postParams = () => ({
    mode, text, ...buildVariantParams(variantTabs),
    mediaPaths: media.map((m) => m.path),
    comment,
    commentDelayMin,
    profiles: profileIds.map((profileId) => ({ profileId, targets: mode === 'group'
      ? targetsToSave(profileId, targetsFor(profileId), hydrated.current ? null : dp?.profiles ?? null) : [] })),
    minDelaySec, maxDelaySec, concurrency, staggerMinSec, staggerMaxSec,
  });

  const handleStart = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.start('post', { ...postParams(), ...(campaignId ? { campaignId } : {}) });
      if (!res?.success) reportError(res?.error || 'Không bắt đầu được');
      else { if (res.runId) onStarted(res.runId); onClose(); }
    } catch (err: any) {
      reportError(err?.message || 'Không bắt đầu được');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const draftDisabledReason = !text.trim() ? 'Nhập nội dung bài.' : variantError ?? validateMediaSelection(media) ?? '';
  const handleSaveDraft = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingDraft(true);
    setOperationError('');
    try {
      const res = await ipc.facebookPoster?.draftSave({
        id: draft?.schedule.id,
        plannedAt: draft ? draft.schedule.runAt : initialRunAt ?? null,
        campaignId,
        params: postParams(),
      });
      if (!res?.success) reportError(res?.error || 'Không lưu được nháp');
      else { showNotification('Đã lưu nháp', 'success'); onClose(); }
    } catch (err: any) {
      reportError(err?.message || 'Không lưu được nháp');
    } finally {
      savingRef.current = false;
      setSavingDraft(false);
    }
  };

  const numberInput = (label: string, value: number, set: (n: number) => void, min: number, max?: number) => (
    <label className="block text-xs text-gray-400">
      {label}
      <input type="number" className="input-field text-sm w-full mt-1" min={min} max={max} value={value}
        onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <dialog ref={dialogRef} className="poster-dialog poster-composer" aria-labelledby="poster-composer-title" onCancel={e => { e.preventDefault(); onClose(); }}>
      <header className="poster-dialog-header"><div><h2 id="poster-composer-title">{draft ? 'Sửa bản nháp' : 'Soạn bài'}</h2><p className="poster-muted text-sm mt-1">Chọn kênh, viết nội dung và xem trước bài đăng.</p></div>
        <button type="button" className="poster-icon-button" aria-label="Đóng trình soạn bài" onClick={onClose}>✕</button>
      </header>
      <div className="poster-composer-grid">
      <div className="poster-editor space-y-4 min-w-0">
      <div role="group" aria-label="Chế độ đăng" className="inline-flex rounded-lg border border-gray-600 overflow-hidden">
        {(['group', 'page'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
            className={`px-4 py-1.5 text-sm ${mode === m ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>
            {m === 'group' ? 'Nhóm' : 'Trang'}
          </button>
        ))}
      </div>

      <CampaignSelect value={campaignId} onChange={setCampaignId} />

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Biến thể nội dung">
        {[text, ...variantTabs].map((_, i) => (
          <span key={i} className="inline-flex items-center rounded-lg border border-gray-600 overflow-hidden">
            <button type="button" role="tab" aria-selected={activeTab === i} onClick={() => setActiveTab(i)}
              className={`px-3 py-1 text-sm ${activeTab === i ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800'}`}>{VARIANT_LABELS[i]}</button>
            {i > 0 && <button type="button" aria-label={`Xoá biến thể ${VARIANT_LABELS[i]}`} className="px-1.5 py-1 text-xs text-gray-400 hover:text-red-400 disabled:opacity-50"
              onClick={() => { setVariantTabs((prev) => prev.filter((_, j) => j !== i - 1)); setActiveTab((cur) => (cur >= i ? cur - 1 : cur)); }}>✕</button>}
          </span>
        ))}
        {variantTabs.length + 1 < MAX_VARIANTS && <button type="button" className="px-3 py-1 rounded-lg text-sm border border-dashed border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50"
          onClick={() => { setVariantTabs((prev) => [...prev, '']); setActiveTab(variantTabs.length + 1); }}>+ Biến thể</button>}
      </div>
      {variantTabs.length > 0 && <p className="text-xs text-gray-400 -mt-2">Các nhóm sẽ lần lượt nhận {VARIANT_LABELS.slice(0, variantTabs.length + 1).join(', ')}.</p>}

      <label className="block text-xs text-gray-400">
        {activeTab === 0 ? 'Nội dung bài' : `Nội dung biến thể ${VARIANT_LABELS[activeTab]}`}
        <textarea className="input-field text-sm w-full mt-1 min-h-[220px] max-h-[60vh] resize-y leading-relaxed" maxLength={MAX_TEXT} value={activeText}
          onChange={(e) => (activeTab === 0 ? setText(e.target.value) : setVariantTabs((prev) => prev.map((v, j) => (j === activeTab - 1 ? e.target.value : v))))} />
        <span className="block text-right mt-0.5">{activeText.length}/{MAX_TEXT}</span>
      </label>

      <MediaPicker items={media} onChange={setMedia} />

      <label className="block text-xs text-gray-400">
        Bình luận đầu tiên (tuỳ chọn)
        <textarea className="input-field text-sm w-full mt-1 min-h-[60px]" maxLength={MAX_COMMENT} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label className="flex flex-wrap items-center gap-2 text-xs text-gray-400 -mt-2">
        Bình luận sau
        <input type="number" className="input-field text-sm w-20" min={0} max={60} step={1} value={commentDelayMin}
          disabled={!comment.trim()} onChange={(e) => setCommentDelayMin(Math.min(60, Math.max(0, Math.trunc(Number(e.target.value)) || 0)))} />
        phút kể từ lúc bài lên (0 = ngay).
      </label>

      <section>
        <h3 className="text-sm font-medium text-white mb-2">Profile</h3>
        <ProfilePicker mode="multi" selected={profileIds} onChange={setProfileIds} />
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
                  <button type="button" onClick={() => rescan(id)} disabled={scans.current.has(id) || atCapacity}
                    className="px-2.5 py-1 rounded-lg text-xs border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">{scans.current.has(id) ? 'Đang quét...' : 'Quét lại nhóm'}</button>
                  {atCapacity && !scans.current.has(id) && <span className="w-full text-xs text-gray-400 break-words">{CAPACITY_REASON}</span>}
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
                                <input type="checkbox" checked={isChecked(id, g)} onChange={(e) => setChecked(id, [g.url], e.target.checked)} />
                                <span className="text-sm text-gray-200 truncate" title={g.name}>{g.name}</span>
                                {scoreByGroup[g.url]?.score != null && (() => {
                                  const sc = scoreByGroup[g.url];
                                  const chip = gradeChip(sc.grade, sc.score);
                                  return <span aria-label={chip.aria} title={sc.reasons.join('\n')} className={`shrink-0 px-1.5 rounded border text-[11px] ${chip.cls}`}>{chip.label}</span>;
                                })()}
                              </label>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <label className="block text-xs text-gray-400">
                      Thêm link nhóm (mỗi dòng một link)
                      <textarea className="input-field text-sm w-full mt-1 min-h-[56px]" value={extraLinks[id] || ''}
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
        {/* Sửa nháp chỉ lưu: đăng/hẹn giờ từ đây tạo bản sao trong khi nháp vẫn nằm trên lịch → dễ đăng trùng. Duyệt ở lịch. */}
        {!draft && <>
        <button type="button" onClick={handleStart} disabled={!!disabledReason || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">
          {starting ? 'Đang bắt đầu...' : 'Đăng ngay'}
        </button>
        <button type="button" onClick={() => setScheduling(true)} disabled={!!scheduleDisabledReason} className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-60">
          Hẹn giờ
        </button>
        </>}
        <button type="button" onClick={handleSaveDraft} disabled={!!draftDisabledReason || savingDraft}
          className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-200 hover:border-gray-400 disabled:opacity-60">
          {savingDraft ? 'Đang lưu...' : 'Lưu nháp'}
        </button>
        {(draft ? draftDisabledReason : disabledReason) && <span className="text-xs text-gray-400">{draft ? draftDisabledReason : disabledReason}</span>}
      </div>
      </div>
      <aside className="poster-composer-preview"><div className="flex items-center justify-between mb-5"><h3 className="font-semibold">Xem trước</h3><span className="poster-muted text-xs">Facebook</span></div>
        <PostPreview text={activeText} comment={comment} mediaPaths={media.map(item => item.path)} mode={mode} names={profileIds.map(id => profileNames.get(id) || id)}
          targetName={filteredGroups(profileIds[0]).find(group => isChecked(profileIds[0], group))?.name} />
      </aside>
      </div>
      {scheduling && <ScheduleDialog onClose={() => setScheduling(false)} buildParams={postParams} defaultName={text.trim()} initialCampaignId={campaignId} initialRunAt={initialRunAt} onSaved={onClose} />}
    </dialog>
  );
}
