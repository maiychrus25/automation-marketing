/**
 * GroupSyncPanel.tsx
 *
 * Bảng nổi đồng bộ nhóm: không chặn màn hình, thu nhỏ được, chạy tiếp khi
 * người dùng chuyển tab/màn hình. Trạng thái nằm ở groupSyncSession.
 * Dùng cùng khung và lớp màu với AccountInitPanel. Khi AccountInitPanel đang hiện:
 * màn rộng (>=700px) thì đặt bên trái nó, màn hẹp (<700px) thì xếp phía trên (bottom-[5.5rem]).
 */
import { useSyncExternalStore } from 'react';
import { groupSyncSession, groupSyncSummary } from '@/lib/groupSyncSession';

// Gắn một lần ở mức module: tạo hàm mới mỗi lần render sẽ khiến useSyncExternalStore đăng ký lại liên tục
const subscribeGroupSync = groupSyncSession.subscribe.bind(groupSyncSession);

export default function GroupSyncPanel({ besideInitPanel = false }: { besideInitPanel?: boolean }) {
  const s = useSyncExternalStore(
    subscribeGroupSync,
    () => groupSyncSession.getState(),
  );
  if (s.status === 'idle') return null;
  const pos = besideInitPanel ? 'bottom-[5.5rem] right-4 min-[700px]:bottom-4 min-[700px]:right-[22.5rem]' : 'bottom-4 right-4';

  const active = s.status === 'running' || s.status === 'stopping';
  const summary = groupSyncSummary(s);
  const pct = s.status === 'done' ? 100 : s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : 0;

  if (s.minimized) {
    return (
      <button
        onClick={() => groupSyncSession.setMinimized(false)}
        aria-label={`Mở lại bảng đồng bộ nhóm: ${summary}`}
        title="Mở lại bảng đồng bộ nhóm"
        className={`fixed ${pos} z-[150] max-w-[calc(100vw-2rem)] flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-full px-4 py-2 shadow-2xl hover:bg-gray-750 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
      >
        {active
          ? <svg className="animate-spin w-4 h-4 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5" /></svg>
          : <span className="w-2 h-2 rounded-full bg-gray-400 flex-shrink-0" />}
        <span className="text-xs text-white font-medium truncate">{summary}</span>
        <span className="text-gray-400 text-[10px] flex-shrink-0">▲</span>
      </button>
    );
  }

  return (
    <div className={`fixed ${pos} z-[150] w-[330px] max-w-[calc(100vw-2rem)] bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden select-none`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700 bg-gray-800/95">
        <span className="text-sm font-semibold text-white truncate flex-1 min-w-0">Đồng bộ nhóm Zalo</span>
        <button onClick={() => groupSyncSession.setMinimized(true)} title="Thu nhỏ" aria-label="Thu nhỏ bảng đồng bộ nhóm"
          className="p-1 rounded text-gray-400 hover:text-gray-300 hover:bg-gray-700 transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {!active && (
          <button onClick={() => groupSyncSession.dismiss()} title="Đóng" aria-label="Đóng bảng đồng bộ nhóm"
            className="p-1 rounded text-gray-400 hover:text-gray-300 hover:bg-gray-700 transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      <div className="px-4 pt-3 pb-1">
        <div className="flex items-center justify-between mb-1.5 gap-2">
          <span role="status" aria-live="polite" title={summary} className={`text-[11px] text-gray-400 min-w-0 ${s.status === 'failed' ? 'break-words' : 'truncate'}`}>{summary}</span>
          <span className="text-[11px] text-blue-400 font-semibold flex-shrink-0">{pct}%</span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden" role="progressbar" aria-label="Tiến độ đồng bộ nhóm" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        {active && s.currentName && (
          <p className="text-[11px] text-gray-400 truncate leading-tight mt-1.5">{s.currentName}</p>
        )}
      </div>
      {active && <div className="px-4 pb-3 pt-2 flex items-center justify-between gap-2">
        <p className="text-[10px] text-gray-400 leading-relaxed min-w-0">Bạn có thể tiếp tục dùng ứng dụng. Đừng đóng MaiHub cho tới khi đồng bộ xong.</p>
        {s.status === 'running' && s.step === 2 && (
          <button onClick={() => groupSyncSession.stop()} className="flex-shrink-0 px-3 py-1 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            Dừng
          </button>
        )}
      </div>}
      {!active && <div className="pb-3" />}
    </div>
  );
}
