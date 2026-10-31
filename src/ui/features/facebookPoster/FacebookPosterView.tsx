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
import RunPanel from './RunPanel';
import ChannelsPanel, { type PosterChannel } from './ChannelsPanel';
import { initialRunState, reduceRunState, MAX_LIVE_RUNS, type PosterLog, type PosterRunAction, type ProgressSnapshot, type RunSnapshot } from './runState';
import type { FbPosterRun, FbPosterSchedule } from '../../../models/facebookPoster';

const SECTIONS: Record<FacebookPosterSection, { label: string; description?: string }> = {
  schedule: { label: 'Lịch đăng' },
  campaigns: { label: 'Chiến dịch', description: 'Gom lịch đăng theo chiến dịch, đặt khoảng ngày và so sánh hiệu quả.' },
  video: { label: 'Video', description: 'Tạo video quảng cáo từ ảnh và mẫu có sẵn, render trên máy chủ riêng.' },
  join: { label: 'Tham gia nhóm', description: 'Tìm nhóm theo từ khóa và tham gia bằng profile đã chọn.' },
  comments: { label: 'Thu bình luận', description: 'Thu bình luận từ các bài đã đăng và tìm kiếm kết quả.' },
  leads: { label: 'Khách tiềm năng', description: 'Bình luận có ý định mua được lọc tự động từ các bài đã đăng.' },
  research: { label: 'Nghiên cứu', description: 'Quét bài, nhóm, fanpage theo chủ đề để lên chiến dịch.' },
  history: { label: 'Lịch sử', description: 'Theo dõi kết quả từng lượt chạy và xuất dữ liệu CSV.' },
};
const FACEBOOK_PROVIDER = { id: 'facebook', name: 'Facebook', badge: 'f' };

export default function FacebookPosterView() {
  const section = useAppStore(s => s.facebookPosterSection);
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
  }, []);

  const compose = (at?: number, mediaPaths: string[] = []) => {
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
    Promise.resolve(ipc.facebookPoster?.active()).then((res) => {
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
      });
    return () => { alive = false; offLog?.(); offProgress?.(); offFinished?.(); };
  }, [bootstrapSeq, dispatch]);

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
          <h1>{SECTIONS[section].label}</h1>
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" className="poster-button poster-mobile-channels" aria-expanded={channelsOpen} onClick={() => setChannelsOpen(value => !value)}>Kênh</button>
            <button type="button" className="poster-button" aria-expanded={showProgress} onClick={() => setShowProgress(value => !value)}><span className={`poster-status-dot ${busy ? 'is-running' : ''}`} />Tiến độ</button>
            <button type="button" className="poster-primary poster-top-compose" onClick={() => compose()}>＋ Soạn bài</button>
          </div>
        </header>
        <div className={`poster-body ${channelsOpen ? 'channels-open' : ''}`}>
          <ChannelsPanel channels={channels} selected={selectedChannels} onChange={setSelectedChannels} onCompose={() => compose()}
            onAdd={() => setView('browser')} loading={channelsLoading} error={channelsError} onRetry={loadChannels} />
          <main className="poster-content" aria-label={SECTIONS[section].label}>
            {section === 'schedule' && <ScheduleTab selectedChannels={selectedChannels} profileNames={profileNames} onCompose={compose} onEditDraft={editDraft} onOpenHistory={() => openFacebookPoster('history')} />}
            {section !== 'schedule' && <div className="poster-task-page">
              <p className="poster-muted mb-6">{SECTIONS[section].description}</p>
              {section === 'campaigns' && <CampaignsTab />}
              {section === 'video' && <VideoTab />}
              {section === 'join' && <JoinTab atCapacity={atCapacity} onStarted={onStarted} />}
              {section === 'comments' && <CommentsTab atCapacity={atCapacity} onStarted={onStarted} />}
              {section === 'leads' && <LeadsTab />}
              {section === 'research' && <ResearchTab />}
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
