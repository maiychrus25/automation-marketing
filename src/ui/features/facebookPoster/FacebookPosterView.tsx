import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore, type FacebookPosterSection } from '@/store/appStore';
import PostTab from './PostTab';
import JoinTab from './JoinTab';
import CommentsTab from './CommentsTab';
import ScheduleTab from './ScheduleTab';
import HistoryTab from './HistoryTab';
import CampaignsTab from './CampaignsTab';
import VideoTab from './VideoTab';
import LeadsTab from './LeadsTab';
import ResearchTab from './ResearchTab';
import EngagementTab from './EngagementTab';
import RunPanel from './RunPanel';
import { useEmployeePoster } from './useEmployeePoster';
import { shouldIgnoreResyncSignal } from '@/lib/employeeResync';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { keepSelectedChannels, posterSectionFor, POSTER_EMPLOYEE_NOTICE, POSTER_NO_PROFILE_NOTICE } from '../../lib/employeePoster';
import ChannelsPanel, { type PosterChannel } from './ChannelsPanel';
import { initialRunState, reduceRunState, runsToSettle, shouldSettleRun, MAX_LIVE_RUNS, type PosterLog, type PosterRunAction, type ProgressSnapshot, type RunSnapshot } from './runState';
import type { FbPosterRun, FbPosterSchedule } from '../../../models/facebookPoster';

const SECTIONS: Record<FacebookPosterSection, { label: string; description?: string }> = {
  schedule: { label: 'Lịch đăng' },
  campaigns: { label: 'Chiến dịch', description: 'Gom lịch đăng theo chiến dịch, đặt khoảng ngày và so sánh hiệu quả.' },
  video: { label: 'Video', description: 'Tạo video quảng cáo từ ảnh và mẫu có sẵn, render trên máy chủ riêng.' },
  join: { label: 'Tham gia nhóm', description: 'Tìm nhóm theo từ khóa và tham gia bằng profile đã chọn.' },
  comments: { label: 'Thu bình luận', description: 'Thu bình luận từ các bài đã đăng và tìm kiếm kết quả.' },
  leads: { label: 'Khách tiềm năng', description: 'Bình luận có ý định mua được lọc tự động từ các bài đã đăng.' },
  research: { label: 'Nghiên cứu', description: 'Quét bài, nhóm, fanpage theo chủ đề để lên chiến dịch.' },
  engagement: { label: 'Chờ duyệt', description: 'Bình luận bot gợi ý vào bài của người khác. Bot không tự đăng: chỉ câu anh duyệt mới được đăng.' },
  history: { label: 'Lịch sử', description: 'Theo dõi kết quả từng lượt chạy và xuất dữ liệu CSV.' },
};
const FACEBOOK_PROVIDER = { id: 'facebook', name: 'Facebook', badge: 'f' };

export default function FacebookPosterView() {
  const { isEmployee, noProfiles, assignedKey, assigned } = useEmployeePoster();
  // Mục đã lưu bị ẩn với nhân viên (video, nghiên cứu, chờ duyệt) rơi về Lịch đăng; mục ẩn không mount nên không tải dữ liệu.
  const section = useAppStore(s => posterSectionFor(s.facebookPosterSection, isEmployee)) as FacebookPosterSection;
  const openFacebookPoster = useAppStore(s => s.openFacebookPoster);
  // Per-run cache (bounded in runState); unmounting the view frees it.
  const [runState, setRunState] = useState(initialRunState);
  const stateRef = useRef(runState);
  stateRef.current = runState;
  const dispatch = useCallback((action: PosterRunAction) => setRunState((s) => reduceRunState(s, action)), []);
  const [runsLoad, setRunsLoad] = useState({ loading: true, error: '' });
  // Bumped by retry and workspace switch; each value is one bootstrap generation.
  const [bootstrapSeq, setBootstrapSeq] = useState(0);
  const resolveRunRef = useRef<(runId: string) => void>(() => {});
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  // Boss only: who created a schedule (never requested on an employee machine, which has no employee list).
  const [employeeNames, setEmployeeNames] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (isEmployee) { setEmployeeNames(null); return; }
    let alive = true;
    Promise.resolve(ipc.employee?.list()).then((res) => {
      if (alive && res?.success) setEmployeeNames(new Map(res.employees.map((e: any) => [e.employee_id, e.display_name])));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [isEmployee]);
  const [channels, setChannels] = useState<PosterChannel[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<string[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState('');
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerMounted, setComposerMounted] = useState(false);
  const [composeAt, setComposeAt] = useState<number | undefined>();
  const [composeMedia, setComposeMedia] = useState<string[]>([]);
  const composeMediaPaths = useAppStore(s => s.posterComposeMediaPaths);
  const setComposeMediaPaths = useAppStore(s => s.setPosterComposeMediaPaths);
  const [composeSeq, setComposeSeq] = useState(0);
  const [editingDraft, setEditingDraft] = useState<{ schedule: FbPosterSchedule; media: { path: string; size: number }[] } | null>(null);
  // Mỗi lần mở nháp là một composer mới (nạp lại từ DB), kể cả mở lại cùng nháp.
  const [draftOpenSeq, setDraftOpenSeq] = useState(0);
  const showNotification = useAppStore(s => s.showNotification);
  const [showProgress, setShowProgress] = useState(false);
  const setView = useAppStore(s => s.setView);

  const loadChannels = useCallback(async () => {
    // Chưa được gán hồ sơ: không gửi yêu cầu nào tới máy Boss, màn hình chỉ hiện lời nhắc.
    if (noProfiles) { setChannels([]); setProfileNames(new Map()); setChannelsError(''); setChannelsLoading(false); return; }
    setChannelsLoading(true);
    try {
      const res = await ipc.browserProfile?.list();
      if (!res?.success) throw new Error(res?.error || 'Không tải được kênh');
      const groups = new Map((res.groups || []).map(g => [g.id, g.name]));
      setChannels((res.profiles || []).map(p => ({ id: p.id, name: p.name, group: groups.get(p.group_id!) || 'Không nhóm', provider: FACEBOOK_PROVIDER })));
      setProfileNames(new Map((res.profiles || []).map(p => [p.id, p.name])));
      setChannelsError('');
    } catch (error) {
      setChannelsError(error instanceof Error ? error.message : 'Không tải được kênh');
    } finally { setChannelsLoading(false); }
    // assignedKey: boss gán/bỏ hồ sơ giữa phiên thì tải lại danh sách kênh (so theo nội dung).
  }, [noProfiles, assignedKey]);

  const compose = (at?: number, mediaPaths: string[] = []) => {
    if (noProfiles) return;
    setEditingDraft(null);
    // Chỉ khi có tệp gắn sẵn mới dựng lại composer; mở thường vẫn giữ nội dung đang soạn dở.
    // Gán luôn (rỗng khi mở thường) để tệp gắn sẵn cũ không bao giờ bám sang bài mới khác.
    setComposeMedia(mediaPaths);
    if (mediaPaths.length) setComposeSeq((n) => n + 1);
    setChannelsOpen(false);
    setComposeAt(at);
    setComposerMounted(true);
    setComposerOpen(true);
  };
  const editDraft = async (id: string) => {
    if (noProfiles) return;
    const res = await ipc.facebookPoster?.draftGet(id);
    if (!res?.success || !res.draft) { showNotification(res?.error || 'Không mở được bản nháp', 'error'); return; }
    setChannelsOpen(false);
    setComposeMedia([]);
    setEditingDraft({ schedule: res.draft, media: res.media ?? [] });
    setDraftOpenSeq((n) => n + 1);
    setComposeAt(undefined);
    setComposerMounted(true);
    setComposerOpen(true);
  };

  // Mục Video yêu cầu mở Soạn bài với video đã gắn: mở rồi xoá yêu cầu để không mở lại.
  useEffect(() => {
    if (!composeMediaPaths) return;
    compose(undefined, composeMediaPaths);
    setComposeMediaPaths(null);
  }, [composeMediaPaths]);

  // Tabs pass the runId returned by start(); current() is only the oldest live run, not necessarily this one.
  const onStarted = (runId: string) => {
    setShowProgress(true);
    dispatch({ type: 'select', runId });
  };

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // Employee: a run absent from the fresh active() answer is ended from its stored record (getRun). Only a definite refusal of the boss ends it as
  // "failed" with a neutral note; no answer or a transient failure leaves it live for the next resync. `isAlive` drops answers of an older bootstrap.
  const settleMissingRuns = useCallback((activeIds: string[], isAlive: () => boolean) => {
    for (const runId of runsToSettle(stateRef.current.runs, activeIds)) {
      Promise.resolve(ipc.facebookPoster?.getRun(runId)).then((res) => {
        if (!isAlive()) return;
        // The record still says running (a run started while active() was in flight): leave it alone.
        if (res?.success && res.run) { if (res.run.status !== 'running') dispatch({ type: 'reconcile', runs: [{ run: res.run, progress: { runId, done: 0, total: 0, profiles: [] } }] }); }
        else if (shouldSettleRun(res)) dispatch({ type: 'settle', runId, error: 'Không rõ kết quả, xem Lịch sử', at: Date.now() });
      }).catch(() => undefined);
    }
  }, [dispatch]);

  // Employee: after a reconnect or boss restart (employee:resync) read the live runs again, like on mount.
  useEffect(() => {
    if (!isEmployee) return;
    return ipc.on?.('employee:resync', (payload: { workspaceId?: string } | null) => {
      if (shouldIgnoreResyncSignal(payload?.workspaceId, useWorkspaceStore.getState().activeWorkspaceId)) return;
      setBootstrapSeq((n) => n + 1);
    });
  }, [isEmployee]);

  // Boss unassigned profiles mid-session: the channel filter drops them (an emptied selection goes back to "all").
  useEffect(() => {
    if (isEmployee) setSelectedChannels((prev) => keepSelectedChannels(prev, assigned));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEmployee, assignedKey]);

  // Subscribe before reading active(): events that land during the request are buffered, then replayed after the snapshot.
  useEffect(() => {
    let alive = true;
    let buffer: PosterRunAction[] | null = [];
    const requested = new Set<string>();
    // Metadata for a run first seen through an event: the live snapshot (with progress) first, else the stored record.
    const resolveRun = (runId: string) => {
      if (!alive || buffer || requested.has(runId) || stateRef.current.runs[runId]) return;
      requested.add(runId);
      setShowProgress(true);
      (async () => {
        const live = await ipc.facebookPoster?.active();
        if (!alive) return;
        const runs = live?.success ? live.runs ?? [] : [];
        if (runs.length) dispatch({ type: 'reconcile', runs });
        if (runs.some((s) => s.run.id === runId)) { requested.delete(runId); return; }
        const stored = await ipc.facebookPoster?.getRun(runId);
        if (!alive || !stored?.success || !stored.run) return;
        dispatch({ type: 'reconcile', runs: [{ run: stored.run, progress: { runId, done: 0, total: 0, profiles: [] } }] });
        requested.delete(runId);
      })().catch(() => { /* Kept in `requested`: an unknown ID is not refetched on every event. */ });
    };
    resolveRunRef.current = resolveRun;
    const push = (action: PosterRunAction) => {
      if (!alive) return;
      if (buffer) buffer.push(action); else dispatch(action);
    };
    const offLog = ipc.on?.('facebookPoster:log', (entry: PosterLog) => push({ type: 'log', entry }));
    const offProgress = ipc.on?.('facebookPoster:progress', (progress: ProgressSnapshot) => {
      push({ type: 'progress', progress });
      resolveRun(progress.runId);
    });
    const offFinished = ipc.on?.('facebookPoster:runFinished', (data: { runId: string; status: FbPosterRun['status'] }) => push({ type: 'finished', runId: data.runId, status: data.status }));
    setRunsLoad({ loading: true, error: '' });
    // Không có hồ sơ được gán: boss từ chối mọi lệnh, không hỏi lượt đang chạy.
    Promise.resolve(noProfiles ? { success: true, runs: [] as RunSnapshot[], error: undefined as string | undefined } : ipc.facebookPoster?.active()).then((res) => {
      if (!res?.success) throw new Error(res?.error || 'Không tải được lượt đang chạy');
      return { runs: res.runs ?? [], error: '' };
    }).catch((error: unknown) => ({ runs: [] as RunSnapshot[], error: error instanceof Error && error.message ? error.message : 'Không tải được lượt đang chạy' }))
      .then(({ runs, error }) => {
        if (!alive) return;
        const replay = buffer ?? [];
        buffer = null;
        setRunState((s) => [{ type: 'reconcile', runs } as PosterRunAction, ...replay].reduce(reduceRunState, s));
        setRunsLoad({ loading: false, error });
        if (runs.length) setShowProgress(true);
        // Employee: runFinished can be lost while the network was down. A run held as live that the boss no longer lists is settled from its stored record.
        if (isEmployee && !error) settleMissingRuns(runs.map((r) => r.run.id), () => alive);
      });
    return () => { alive = false; offLog?.(); offProgress?.(); offFinished?.(); };
  }, [bootstrapSeq, dispatch, noProfiles, isEmployee]);

  // A run known only by its logs or selection (started elsewhere, or just started here) gets its metadata by ID.
  useEffect(() => {
    if (runsLoad.loading) return;
    const { runs, logs, selectedRunId } = runState;
    for (const id of [...Object.keys(logs), ...(selectedRunId ? [selectedRunId] : [])]) if (!runs[id]) resolveRunRef.current(id);
  }, [runState, runsLoad.loading]);

  // A new workspace has its own runs: drop the cache and bootstrap again (stale responses are ignored by `alive`).
  useEffect(() => ipc.on?.('workspace:switched', () => {
    setRunState(initialRunState);
    setBootstrapSeq((n) => n + 1);
  }), []);

  const selectedRunId = runState.selectedRunId;
  const selected = selectedRunId ? runState.runs[selectedRunId] : undefined;
  const cachedRuns = Object.values(runState.runs);
  const liveCount = cachedRuns.filter((s) => s.run.status === 'running').length;
  const busy = liveCount > 0;
  const atCapacity = liveCount >= MAX_LIVE_RUNS;

  return (
    <div className="poster-workspace">
      <div className="poster-main">
        <header className="poster-topbar">
          {isEmployee
            ? <div className="min-w-0"><h1>{SECTIONS[section].label}</h1><p className="poster-muted text-xs mt-0.5">{POSTER_EMPLOYEE_NOTICE}</p></div>
            : <h1>{SECTIONS[section].label}</h1>}
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" className="poster-button poster-mobile-channels" aria-expanded={channelsOpen} onClick={() => setChannelsOpen(value => !value)}>Kênh</button>
            <button type="button" className="poster-button" aria-expanded={showProgress} onClick={() => setShowProgress(value => !value)}><span className={`poster-status-dot ${busy ? 'is-running' : ''}`} />Tiến độ</button>
            <button type="button" className="poster-primary poster-top-compose" disabled={noProfiles} onClick={() => compose()}>＋ Soạn bài</button>
          </div>
        </header>
        <div className={`poster-body ${channelsOpen ? 'channels-open' : ''}`}>
          <ChannelsPanel channels={channels} selected={selectedChannels} onChange={setSelectedChannels} onCompose={() => compose()}
            onAdd={isEmployee ? undefined : () => setView('browser')} noProfiles={noProfiles} loading={channelsLoading} error={channelsError} onRetry={loadChannels} />
          <main className="poster-content" aria-label={SECTIONS[section].label}>
            {noProfiles && <p className="poster-muted text-sm text-center p-8">{POSTER_NO_PROFILE_NOTICE}</p>}
            {!noProfiles && section === 'schedule' && <ScheduleTab selectedChannels={selectedChannels} profileNames={profileNames} employeeNames={employeeNames} onCompose={compose} onEditDraft={editDraft} onOpenHistory={() => openFacebookPoster('history')} />}
            {!noProfiles && section !== 'schedule' && <div className="poster-task-page">
              <p className="poster-muted mb-6">{SECTIONS[section].description}</p>
              {section === 'campaigns' && <CampaignsTab />}
              {section === 'video' && <VideoTab />}
              {section === 'join' && <JoinTab atCapacity={atCapacity} onStarted={onStarted} />}
              {section === 'comments' && <CommentsTab atCapacity={atCapacity} onStarted={onStarted} />}
              {section === 'leads' && <LeadsTab />}
              {section === 'research' && <ResearchTab />}
              {section === 'engagement' && <EngagementTab />}
              {section === 'history' && <HistoryTab />}
            </div>}
          </main>
        </div>
        {showProgress && <aside aria-label="Tiến độ" className="poster-run-panel"><RunPanel runs={cachedRuns} run={selected?.run ?? null} progress={selected?.progress ?? null}
          logs={selectedRunId ? runState.logs[selectedRunId] ?? [] : []} profileNames={profileNames} onSelect={(runId) => dispatch({ type: 'select', runId })}
          loading={runsLoad.loading} error={runsLoad.error} onRetry={() => setBootstrapSeq((n) => n + 1)} /></aside>}
      </div>
      {composerMounted && <PostTab key={editingDraft ? `${editingDraft.schedule.id}:${draftOpenSeq}` : composeSeq ? `new:${composeSeq}` : 'new'} draft={editingDraft ?? undefined} initialMediaPaths={composeMedia} open={composerOpen} onClose={() => setComposerOpen(false)} initialProfileIds={selectedChannels ?? []} initialRunAt={composeAt}
        atCapacity={atCapacity} profileNames={profileNames} onStarted={onStarted} />}
    </div>
  );
}
