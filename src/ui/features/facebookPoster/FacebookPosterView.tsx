import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore, type FacebookPosterSection } from '@/store/appStore';
import PostTab from './PostTab';
import JoinTab from './JoinTab';
import CommentsTab from './CommentsTab';
import ScheduleTab from './ScheduleTab';
import HistoryTab from './HistoryTab';
import RunPanel, { PosterLog, PosterProgress } from './RunPanel';
import ChannelsPanel, { type PosterChannel } from './ChannelsPanel';
import type { FbPosterRun } from '../../../models/facebookPoster';

const MAX_LOGS = 500;
const SECTIONS: Record<FacebookPosterSection, { label: string; description?: string }> = {
  schedule: { label: 'Lịch đăng' },
  join: { label: 'Tham gia nhóm', description: 'Tìm nhóm theo từ khóa và tham gia bằng profile đã chọn.' },
  comments: { label: 'Thu bình luận', description: 'Thu bình luận từ các bài đã đăng và tìm kiếm kết quả.' },
  history: { label: 'Lịch sử', description: 'Theo dõi kết quả từng lượt chạy và xuất dữ liệu CSV.' },
};
const FACEBOOK_PROVIDER = { id: 'facebook', name: 'Facebook', badge: 'f' };

export default function FacebookPosterView() {
  const section = useAppStore(s => s.facebookPosterSection);
  const openFacebookPoster = useAppStore(s => s.openFacebookPoster);
  const [run, setRun] = useState<FbPosterRun | null>(null);
  const [progress, setProgress] = useState<PosterProgress | null>(null);
  const [logs, setLogs] = useState<PosterLog[]>([]);
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const [channels, setChannels] = useState<PosterChannel[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<string[] | null>(null);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [channelsError, setChannelsError] = useState('');
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerMounted, setComposerMounted] = useState(false);
  const [composeAt, setComposeAt] = useState<number | undefined>();
  const [showProgress, setShowProgress] = useState(false);
  const setView = useAppStore(s => s.setView);
  const runIdRef = useRef<string | null>(null);

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

  const compose = (at?: number) => {
    setChannelsOpen(false);
    setComposeAt(at);
    setComposerMounted(true);
    setComposerOpen(true);
  };

  // Reads the run record for a runId the panel has not seen; a run that already finished is no longer "current".
  const syncRun = (runId: string) => {
    setShowProgress(true);
    ipc.facebookPoster?.current().then((res) => {
      if (res?.success && res.run?.id === runId) { setRun(res.run); return; }
      return ipc.facebookPoster?.getRun(runId).then((r) => { if (r?.success && runIdRef.current === runId) setRun(r.run); });
    }).catch(() => {});
  };

  // Tabs call this right after start() resolves, so Start stays disabled until the first event arrives.
  const onStarted = () => {
    setShowProgress(true);
    ipc.facebookPoster?.current().then((res) => { if (res?.success && res.run) setRun(res.run); }).catch(() => {});
  };

  useEffect(() => {
    loadChannels();
    ipc.facebookPoster?.current().then((res) => {
      if (!res?.success) return;
      runIdRef.current = res.run?.id ?? null;
      setRun(res.run ?? null);
      setProgress(res.progress ?? null);
      if (res.run) setShowProgress(true);
    }).catch(() => {});
    const offLog = ipc.on?.('facebookPoster:log', (data: PosterLog) => {
      // A new runId means a new run started: reset the panel, then fetch its record.
      if (data.runId !== runIdRef.current) {
        runIdRef.current = data.runId;
        setLogs([]);
        syncRun(data.runId);
      }
      setLogs((prev) => [...prev, data].slice(-MAX_LOGS));
    });
    const offProgress = ipc.on?.('facebookPoster:progress', (data: PosterProgress) => {
      if (data.runId !== runIdRef.current) {
        runIdRef.current = data.runId;
        setLogs([]);
        syncRun(data.runId);
      }
      setProgress(data);
    });
    const offFinished = ipc.on?.('facebookPoster:runFinished', (data: { runId: string; status: FbPosterRun['status'] }) => {
      setRun((prev) => (prev && prev.id === data.runId ? { ...prev, status: data.status } : prev));
    });
    return () => { offLog?.(); offProgress?.(); offFinished?.(); };
  }, []);

  const busy = run?.status === 'running';

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
            {section === 'schedule' && <ScheduleTab selectedChannels={selectedChannels} profileNames={profileNames} onCompose={compose} onOpenHistory={() => openFacebookPoster('history')} />}
            {section !== 'schedule' && <div className="poster-task-page">
              <p className="poster-muted mb-6">{SECTIONS[section].description}</p>
              {section === 'join' && <JoinTab busy={busy} onStarted={onStarted} />}
              {section === 'comments' && <CommentsTab busy={busy} onStarted={onStarted} />}
              {section === 'history' && <HistoryTab />}
            </div>}
          </main>
        </div>
        {showProgress && <aside aria-label="Tiến độ" className="poster-run-panel"><RunPanel run={run} progress={progress} logs={logs} profileNames={profileNames} /></aside>}
      </div>
      {composerMounted && <PostTab open={composerOpen} onClose={() => setComposerOpen(false)} initialProfileIds={selectedChannels ?? []} initialRunAt={composeAt}
        busy={busy} profileNames={profileNames} onStarted={onStarted} />}
    </div>
  );
}
