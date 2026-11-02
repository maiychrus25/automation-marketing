import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { Spinner } from '@/components/common/PageLoading';
import { showConfirm } from '@/components/common/ConfirmDialog';
import type { FbPosterEngagementItem } from '../../../models/facebookPoster';
import {
  ENGAGEMENT_FILTERS, approvePayload, canCancel, cardRows, classifyActionError, draftError, mergeItems, statusesFor,
  type ActionError, type EngagementFilterKey,
} from './engagementView';

const PAGE_LIMIT = 50;
const TICK_MS = 30_000;

/** Mục "Chờ duyệt": nơi duy nhất anh duyệt bình luận bot gợi ý vào bài của người khác (spec 2026-11-02 §10). */
export default function EngagementTab() {
  const showNotification = useAppStore((s) => s.showNotification);
  const setPendingCount = useAppStore((s) => s.setEngagementPendingCount);
  const pendingCount = useAppStore((s) => s.engagementPendingCount);
  const [filter, setFilter] = useState<EngagementFilterKey>('pending');
  const [items, setItems] = useState<FbPosterEngagementItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  // Một yêu cầu duyệt/bỏ tại một thời điểm: khoá mọi nút trong lúc chờ để mỗi cú bấm chỉ gửi đúng một id.
  const [busyId, setBusyId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, ActionError>>({});
  const [rejecting, setRejecting] = useState<Record<number, string | undefined>>({});
  const loadSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(t); }, []);

  useEffect(() => {
    Promise.resolve(ipc.browserProfile?.list()).then((res) => {
      if (alive.current && res?.success) setNames(Object.fromEntries((res.profiles || []).map((p) => [p.id, p.name])));
    }).catch(() => { /* Thiếu tên thì hiện mã profile. */ });
  }, []);

  const load = useCallback(async (key: EngagementFilterKey) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const results = await Promise.all(statusesFor(key).map((status) => ipc.facebookPoster.engagementList({ status, limit: PAGE_LIMIT })));
      const failed = results.find((r) => !r?.success);
      if (failed) throw new Error(failed?.error || 'Không tải được danh sách');
      if (seq !== loadSeq.current || !alive.current) return;
      const sum = results.reduce((n, r) => n + (r.total ?? 0), 0);
      setItems(mergeItems(key, results.flatMap((r) => r.items ?? [])));
      setTotal(sum);
      setNow(Date.now());
      setLoadError('');
      if (key === 'pending') setPendingCount(sum);
    } catch (err) {
      if (seq === loadSeq.current && alive.current) setLoadError(err instanceof Error && err.message ? err.message : 'Không tải được danh sách');
    } finally {
      if (seq === loadSeq.current && alive.current) setLoading(false);
    }
  }, [setPendingCount]);

  useEffect(() => { void load(filter); }, [filter, load]);

  const setError = (id: number, error: ActionError | null) => setErrors((prev) => {
    const { [id]: _drop, ...rest } = prev;
    return error ? { ...rest, [id]: error } : rest;
  });

  const openLink = (url: string) => {
    ipc.research?.openLink(url).then((res) => {
      if (!res?.success) showNotification(res?.error || 'Không mở được link', 'error');
    }).catch(() => showNotification('Không mở được link', 'error'));
  };

  const approve = async (item: FbPosterEngagementItem) => {
    if (busyId !== null) return;
    const draft = drafts[item.id] ?? item.suggestedText;
    const invalid = draftError(draft);
    if (invalid) { setError(item.id, { kind: 'field', message: invalid }); return; }
    setBusyId(item.id);
    setError(item.id, null);
    try {
      const res = await ipc.facebookPoster.engagementApprove(approvePayload(item, draft));
      if (!alive.current) return;
      if (!res?.success) {
        const error = classifyActionError(res?.error);
        setError(item.id, error);
        // Gợi ý đã đổi trạng thái hay hết hạn ở nơi khác: tải lại để thẻ phản ánh đúng.
        if (error.kind === 'general') void load(filter);
        return;
      }
      showNotification('Đã duyệt, bot sẽ đăng bình luận', 'success');
      await load(filter);
    } catch (err) {
      if (alive.current) setError(item.id, classifyActionError(err instanceof Error ? err.message : undefined));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const reject = async (item: FbPosterEngagementItem) => {
    if (busyId !== null) return;
    setBusyId(item.id);
    setError(item.id, null);
    try {
      const reason = (rejecting[item.id] ?? '').trim();
      const res = await ipc.facebookPoster.engagementReject({ id: item.id, ...(reason ? { reason } : {}) });
      if (!alive.current) return;
      if (!res?.success) {
        setError(item.id, classifyActionError(res?.error));
        void load(filter);
        return;
      }
      await load(filter);
    } catch (err) {
      if (alive.current) setError(item.id, classifyActionError(err instanceof Error ? err.message : undefined));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const cancel = async (item: FbPosterEngagementItem) => {
    if (busyId !== null) return;
    const ok = await showConfirm({ title: 'Huỷ bình luận đã duyệt?', message: 'Bot sẽ không đăng câu này và trả lại lượt bình luận hôm nay. Không hoàn tác được.', confirmText: 'Huỷ bình luận', cancelText: 'Giữ lại', variant: 'danger' });
    if (!ok || !alive.current) return;
    setBusyId(item.id);
    setError(item.id, null);
    try {
      const res = await ipc.facebookPoster.engagementCancel({ id: item.id });
      if (!alive.current) return;
      if (!res?.success) {
        // Đã sang "đang đăng" hoặc xong ở nơi khác: báo lỗi và tải lại để thẻ đúng trạng thái.
        setError(item.id, classifyActionError(res?.error));
        void load(filter);
        return;
      }
      showNotification('Đã huỷ, bot sẽ không đăng câu này', 'success');
      await load(filter);
    } catch (err) {
      if (alive.current) setError(item.id, classifyActionError(err instanceof Error ? err.message : undefined));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const stopRejecting = (id: number) => setRejecting((prev) => { const { [id]: _drop, ...rest } = prev; return rest; });
  const rowsByItem = useMemo(() => new Map(items.map((i) => [i.id, cardRows(i, names, now)])), [items, names, now]);

  return (
    <section aria-label="Chờ duyệt" className="eng-tab">
      <div className="eng-filters" role="tablist" aria-label="Lọc theo trạng thái">
        {ENGAGEMENT_FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className="eng-filter" onClick={() => setFilter(f.key)}>{f.label}{f.key === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}</button>
        ))}
        <button type="button" className="poster-button eng-refresh" disabled={loading} onClick={() => { void load(filter); }}>Tải lại</button>
      </div>

      {loadError && (
        <div className="eng-notice" role="alert">
          <span className="min-w-0 break-words">{loadError}</span>
          <button type="button" className="poster-button" onClick={() => { void load(filter); }}>Thử lại</button>
        </div>
      )}
      {loading && items.length === 0 && !loadError && <div className="eng-empty"><Spinner /> Đang tải…</div>}
      {!loading && !loadError && items.length === 0 && (
        <p className="eng-empty">{filter === 'pending' ? 'Chưa có gợi ý nào chờ duyệt. Khi bot tìm được bài đáng góp ý, câu gợi ý sẽ hiện ở đây.' : 'Chưa có gợi ý nào ở trạng thái này.'}</p>
      )}

      <ul className="eng-list">
        {items.map((item) => {
          const pending = item.status === 'pending';
          const draft = drafts[item.id] ?? item.suggestedText;
          const error = errors[item.id];
          const fieldError = error?.kind === 'field' ? error.message : '';
          const busy = busyId !== null;
          const confirming = rejecting[item.id] !== undefined;
          const textId = `eng-text-${item.id}`;
          return (
            <li key={item.id} className="eng-card">
              <dl className="eng-rows">
                {(rowsByItem.get(item.id) ?? []).map((r) => (
                  <div key={r.label} className="eng-row"><dt>{r.label}</dt><dd>{r.value}</dd></div>
                ))}
              </dl>
              <button type="button" className="eng-open" onClick={() => openLink(item.postUrl)}>Mở bài trên Facebook ↗</button>

              <label htmlFor={textId} className="eng-label">{pending ? 'Câu bình luận (sửa được)' : 'Câu bình luận'}</label>
              {pending ? (
                <>
                  <textarea id={textId} className="poster-input eng-text" rows={3} value={draft} disabled={busyId === item.id}
                    aria-invalid={!!fieldError} aria-describedby={fieldError ? `${textId}-err` : undefined}
                    onChange={(e) => { setDrafts((prev) => ({ ...prev, [item.id]: e.target.value })); if (fieldError) setError(item.id, null); }} />
                  <div className="eng-meta">
                    {fieldError ? <span id={`${textId}-err`} role="alert" className="eng-error">{fieldError}</span> : <span />}
                    <span className="poster-muted">{draft.trim().length}/600</span>
                  </div>
                </>
              ) : <p className="eng-readonly">{item.approvedText || item.suggestedText}</p>}

              {error && error.kind !== 'field' && <p role="alert" className="eng-error">{error.message}</p>}

              {pending && !confirming && (
                <div className="eng-actions">
                  <button type="button" className="poster-primary" disabled={busy} onClick={() => { void approve(item); }}>{busyId === item.id ? 'Đang duyệt…' : 'Duyệt'}</button>
                  <button type="button" className="poster-button" disabled={busy} onClick={() => setRejecting((prev) => ({ ...prev, [item.id]: '' }))}>Bỏ</button>
                </div>
              )}
              {canCancel(item) && (
                <div className="eng-actions">
                  <button type="button" className="poster-button" disabled={busy} onClick={() => { void cancel(item); }}>{busyId === item.id ? 'Đang huỷ…' : 'Huỷ'}</button>
                </div>
              )}
              {pending && confirming && (
                <div className="eng-reject">
                  <label htmlFor={`eng-reason-${item.id}`} className="eng-label">Lý do bỏ (không bắt buộc)</label>
                  <input id={`eng-reason-${item.id}`} className="poster-input" maxLength={200} value={rejecting[item.id] ?? ''}
                    onChange={(e) => setRejecting((prev) => ({ ...prev, [item.id]: e.target.value }))} />
                  <div className="eng-actions">
                    <button type="button" className="poster-button" disabled={busy} onClick={() => { void reject(item); }}>{busyId === item.id ? 'Đang bỏ…' : 'Xác nhận bỏ'}</button>
                    <button type="button" className="poster-button" disabled={busy} onClick={() => stopRejecting(item.id)}>Huỷ</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {total > items.length && <p className="eng-empty">Hiện {items.length}/{total} gợi ý mới nhất.</p>}
    </section>
  );
}
