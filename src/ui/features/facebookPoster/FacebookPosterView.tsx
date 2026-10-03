import React, { useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import PostTab from './PostTab';
import RunPanel, { PosterLog, PosterProgress } from './RunPanel';
import type { FbPosterRun } from '../../../models/facebookPoster';

const MAX_LOGS = 500;
const TABS = ['Đăng bài', 'Tham gia nhóm', 'Bình luận', 'Lịch sử'] as const;

// Task 12 thay ba panel này bằng nội dung thật.
const JoinTab = () => <p className="text-sm text-gray-400">Đang hoàn thiện</p>;
const CommentsTab = () => <p className="text-sm text-gray-400">Đang hoàn thiện</p>;
const HistoryTab = () => <p className="text-sm text-gray-400">Đang hoàn thiện</p>;

export default function FacebookPosterView() {
  const [tab, setTab] = useState(0);
  const [run, setRun] = useState<FbPosterRun | null>(null);
  const [progress, setProgress] = useState<PosterProgress | null>(null);
  const [logs, setLogs] = useState<PosterLog[]>([]);
  const [profileNames, setProfileNames] = useState<Map<string, string>>(new Map());
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    ipc.browserProfile?.list().then((res) => {
      if (res?.success) setProfileNames(new Map((res.profiles || []).map((p: any) => [p.id, p.name])));
    });
    ipc.facebookPoster?.current().then((res) => {
      if (!res?.success) return;
      runIdRef.current = res.run?.id ?? null;
      setRun(res.run ?? null);
      setProgress(res.progress ?? null);
    });
    const offLog = ipc.on?.('facebookPoster:log', (data: PosterLog) => {
      // A new runId means a new run started: reset the panel, then fetch its record.
      if (data.runId !== runIdRef.current) {
        runIdRef.current = data.runId;
        setLogs([]);
        ipc.facebookPoster?.current().then((res) => { if (res?.success && res.run?.id === data.runId) setRun(res.run); });
      }
      setLogs((prev) => [...prev, data].slice(-MAX_LOGS));
    });
    const offProgress = ipc.on?.('facebookPoster:progress', (data: PosterProgress) => {
      if (data.runId !== runIdRef.current) {
        runIdRef.current = data.runId;
        setLogs([]);
        ipc.facebookPoster?.current().then((res) => { if (res?.success && res.run?.id === data.runId) setRun(res.run); });
      }
      setProgress(data);
    });
    const offFinished = ipc.on?.('facebookPoster:runFinished', (data: { runId: string; status: FbPosterRun['status'] }) => {
      setRun((prev) => (prev && prev.id === data.runId ? { ...prev, status: data.status } : prev));
    });
    return () => { offLog?.(); offProgress?.(); offFinished?.(); };
  }, []);

  const busy = run?.status === 'running';

  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + TABS.length) % TABS.length;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 text-gray-200 min-w-0">
      <div className="px-4 pt-3 border-b border-gray-700">
        <h1 className="text-base font-semibold text-white">Đăng Facebook</h1>
        <div role="tablist" aria-label="Đăng Facebook" className="flex gap-1 mt-2 overflow-x-auto">
          {TABS.map((label, i) => (
            <button key={label} ref={(el) => { tabRefs.current[i] = el; }} type="button" role="tab" id={`fb-tab-${i}`} aria-selected={tab === i} aria-controls="fb-tabpanel"
              tabIndex={tab === i ? 0 : -1} onClick={() => setTab(i)} onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 ${tab === i ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        <div id="fb-tabpanel" role="tabpanel" aria-labelledby={`fb-tab-${tab}`} className="min-w-0 p-4 lg:flex-1 lg:overflow-y-auto">
          {tab === 0 && <PostTab busy={busy} profileNames={profileNames} />}
          {tab === 1 && <JoinTab />}
          {tab === 2 && <CommentsTab />}
          {tab === 3 && <HistoryTab />}
        </div>
        <aside aria-label="Tiến độ" className="p-4 border-t lg:border-t-0 lg:border-l border-gray-700 lg:w-96 lg:shrink-0 min-w-0">
          <RunPanel run={run} progress={progress} logs={logs} profileNames={profileNames} />
        </aside>
      </div>
    </div>
  );
}
