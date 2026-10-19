import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { SOURCE_LABEL, parseBoundedInt, parseUrlList } from './researchFormat';
import type { ResearchSource } from '../../../models/research';

interface Props {
  running: boolean;
  progressText: string;
  onStarted: (scanId: string) => void;
}

const SOURCES: ResearchSource[] = ['posts', 'groups', 'pages', 'group_feed'];
const YEARS = (() => { const now = new Date().getFullYear(); return Array.from({ length: now - 2009 }, (_, i) => now - i); })();

export default function ResearchScanForm({ running, progressText, onStarted }: Props) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [source, setSource] = useState<ResearchSource>('posts');
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(false);
  const [year, setYear] = useState('');
  const [limit, setLimit] = useState('200');
  const [groupUrls, setGroupUrls] = useState('');
  const [sinceDays, setSinceDays] = useState('7');
  const [limitPerGroup, setLimitPerGroup] = useState('30');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const isFeed = source === 'group_feed';

  const fail = (message: string) => showNotification(message, 'error');

  const start = async () => {
    try {
      let res;
      if (isFeed) {
        const urls = parseUrlList(groupUrls);
        const days = parseBoundedInt(sinceDays, 1, 30);
        const perGroup = parseBoundedInt(limitPerGroup, 1, 100);
        if (urls.length > 20) return fail('Tối đa 20 nhóm mỗi lượt quét');
        if (days === null) return fail('Số ngày gần đây phải từ 1 đến 30');
        if (perGroup === null) return fail('Số bài mỗi nhóm phải từ 1 đến 100');
        setStarting(true);
        res = await ipc.research?.scanGroupFeeds({ ...(urls.length ? { groupUrls: urls } : {}), sinceDays: days, limitPerGroup: perGroup });
      } else {
        const text = query.trim();
        const max = parseBoundedInt(limit, 1, 500);
        if (text.length < 1 || text.length > 100) return fail('Từ khoá phải từ 1 đến 100 ký tự');
        if (max === null) return fail('Số lượng phải từ 1 đến 500');
        setStarting(true);
        res = await ipc.research?.search({
          source: source as 'posts' | 'groups' | 'pages', query: text, limit: max,
          ...(source === 'posts' && recent ? { recent: true } : {}), ...(source === 'posts' && year ? { year: Number(year) } : {}),
        });
      }
      if (!res?.success || !res.scanId) return fail(res?.error || 'Không bắt đầu được lượt quét');
      onStarted(res.scanId);
    } catch (err: any) {
      fail(err?.message || 'Không bắt đầu được lượt quét');
    } finally { setStarting(false); }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      const res = await ipc.research?.cancel();
      if (!res?.success) fail(res?.error || 'Không huỷ được lượt quét');
    } catch (err: any) { fail(err?.message || 'Không huỷ được lượt quét'); } finally { setCancelling(false); }
  };

  const field = 'block text-xs text-gray-400';
  const inputCls = 'input-field text-sm w-full mt-1';
  return (
    <section aria-label="Quét mới" className="rounded-lg border border-gray-700 p-3 space-y-3 min-w-0">
      <h3 className="text-sm font-medium text-white">Quét mới</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label htmlFor="research-source" className={field}>Nguồn
          <select id="research-source" className={inputCls} value={source} disabled={running} onChange={(e) => setSource(e.target.value as ResearchSource)}>
            {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
          </select>
        </label>
        {!isFeed && (
          <label htmlFor="research-query" className={field}>Từ khoá
            <input id="research-query" type="text" maxLength={100} className={inputCls} value={query} disabled={running} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {!isFeed && (
          <label htmlFor="research-limit" className={field}>Số lượng (1–500)
            <input id="research-limit" type="number" min={1} max={500} className={inputCls} value={limit} disabled={running} onChange={(e) => setLimit(e.target.value)} />
          </label>
        )}
        {source === 'posts' && (
          <>
            <label htmlFor="research-year" className={field}>Năm
              <select id="research-year" className={inputCls} value={year} disabled={running} onChange={(e) => setYear(e.target.value)}>
                <option value="">Tất cả</option>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label htmlFor="research-recent" className="flex items-center gap-2 text-xs text-gray-300 sm:mt-6 cursor-pointer">
              <input id="research-recent" type="checkbox" checked={recent} disabled={running} onChange={(e) => setRecent(e.target.checked)} />
              Gần đây
            </label>
          </>
        )}
        {isFeed && (
          <>
            <label htmlFor="research-groups" className={`${field} sm:col-span-2`}>URL nhóm (mỗi dòng một nhóm, tối đa 20; để trống = tự chọn từ các nhóm đã tham gia)
              <textarea id="research-groups" className={`${inputCls} min-h-[80px]`} value={groupUrls} disabled={running} onChange={(e) => setGroupUrls(e.target.value)} />
            </label>
            <label htmlFor="research-since" className={field}>Số ngày gần đây (1–30)
              <input id="research-since" type="number" min={1} max={30} className={inputCls} value={sinceDays} disabled={running} onChange={(e) => setSinceDays(e.target.value)} />
            </label>
            <label htmlFor="research-pergroup" className={field}>Số bài mỗi nhóm (1–100)
              <input id="research-pergroup" type="number" min={1} max={100} className={inputCls} value={limitPerGroup} disabled={running} onChange={(e) => setLimitPerGroup(e.target.value)} />
            </label>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={start} disabled={running || starting} className="btn-primary text-sm px-4 py-2 text-white disabled:opacity-60">{starting ? 'Đang bắt đầu…' : 'Quét'}</button>
        <button type="button" onClick={cancel} disabled={!running || cancelling} className="px-4 py-2 rounded-lg text-sm border border-gray-600 text-gray-300 hover:border-gray-400 disabled:opacity-50">Huỷ</button>
        {running && <span role="status" className="text-xs text-gray-400 min-w-0 break-words">{progressText || 'Đang quét…'}</span>}
      </div>
    </section>
  );
}
