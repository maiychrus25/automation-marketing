import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-histsync-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookHistorySyncService, { FbHistorySyncTarget, MAX_THREAD_PAGES } from '../../services/facebook/FacebookHistorySyncService';
import { FacebookHistoryLimiter } from '../../services/facebook/FacebookHistoryLimiter';
import { FB_HISTORY_SYNC_EVENT, FbHistorySyncStatus } from '../../services/facebook/facebookHistory';

const INTERNAL = 'acc-internal';
const OWNER = 'fb-owner-hist';
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

type ThreadResult = Awaited<ReturnType<FbHistorySyncTarget['syncThreadHistory']>>;
interface FakeOpts {
  pages?: Array<{ threads: any[]; nextBefore: number | null; error?: string }>;
  thread?: (id: string, opts: any) => Promise<ThreadResult> | ThreadResult;
  status?: () => string;
  connected?: () => boolean;
  ready?: () => boolean;
  page?: boolean;
  e2ee?: string[];
}

function makeTarget(o: FakeOpts = {}) {
  const limiter = new FacebookHistoryLimiter(() => 0);
  const calls = { list: [] as Array<number | null>, sync: [] as string[], latest: [] as Array<number | undefined> };
  let pageIdx = 0;
  const target: FbHistorySyncTarget = {
    isConnected: () => (o.connected ? o.connected() : true),
    getStatus: () => (o.status ? o.status() : 'connected'),
    getAccountId: () => INTERNAL,
    isPage: () => !!o.page,
    ...(o.ready ? { isHistoryReady: o.ready } : {}),
    isE2EEThread: id => (o.e2ee || []).includes(id),
    historyLimiterFor: () => limiter,
    getThreadListPage: async before => {
      calls.list.push(before);
      return (o.pages || [{ threads: [], nextBefore: null }])[pageIdx++] || { threads: [], nextBefore: null };
    },
    syncThreadHistory: async (id, _range, opts) => {
      calls.sync.push(id);
      calls.latest.push(opts.latestKnownMs);
      if (o.thread) return o.thread(id, opts);
      opts.onPage({ saved: 2, received: 3 });
      return { saved: 2, received: 3, pages: 1, complete: true };
    },
  };
  return { target, limiter, calls };
}

describe('FacebookHistorySyncService', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  let clock = T0;
  let acct = 0;
  let id: string;
  const sleep = jest.fn(async (ms: number) => { clock += ms; });
  const bossCalls = jest.fn((fn: (d: DatabaseService) => void) => fn(db));
  const svc = () => new (FacebookHistorySyncService as any)({ now: () => clock, sleep, runOnBossDb: bossCalls }) as FacebookHistorySyncService & { whenIdle(a: string): Promise<void> };
  const events = (): FbHistorySyncStatus[] => emit.mock.calls.filter(c => c[0] === FB_HISTORY_SYNC_EVENT).map(c => c[1]);
  const run = async (s: ReturnType<typeof svc>, t: FbHistorySyncTarget | null, range = { fromTs: null as number | null, toTs: null as number | null }) => {
    const r = s.start(id, range, async () => t);
    await s.whenIdle(id);
    return r;
  };
  const th = (tid: string, ms: number, extra: any = {}) => ({ id: tid, name: `n-${tid}`, lastActivityMs: ms, ...extra });

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: INTERNAL, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  beforeEach(() => {
    id = `${OWNER}-${acct++}`;
    clock = T0;
    sleep.mockClear();
    bossCalls.mockClear();
    db.run('DELETE FROM fb_threads WHERE account_id = ?', [INTERNAL]);
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
  });
  afterEach(() => emit.mockRestore());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('failsWhenServiceMissingOrNotConnected', async () => {
    const s = svc();
    await run(s, null);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Tài khoản Facebook chưa kết nối — kết nối lại rồi đồng bộ' });
    id += 'x';
    await run(s, makeTarget({ connected: () => false }).target);
    expect(s.getStatus(id)?.stage).toBe('failed');
  });

  // Từ 26.44.0 tài khoản Page đồng bộ như tài khoản cá nhân (danh sách hội thoại và tin cũ lấy qua hộp thư Page).
  test('aPageAccountIsSyncedLikeAPersonalOne', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ page: true, pages: [{ threads: [{ id: '777001', name: 'Khach', lastActivityMs: T0 - DAY }], nextBefore: null }] });
    await run(s, target);
    expect(calls.sync).toEqual(['777001']);
    expect(s.getStatus(id)).toMatchObject({ stage: 'completed', threadsDone: 1, messagesSaved: 2 });
  });

  // Page: tài khoản vẫn "đã kết nối" trong lúc hộp thư Page đang nối lại. Lượt đồng bộ chờ hộp thư như chờ một kết nối rớt.
  test('aPageWhoseInboxIsReconnectingIsWaitedFor', async () => {
    const s = svc();
    let checks = 0;
    const { target, calls } = makeTarget({ page: true, ready: () => ++checks > 2, pages: [{ threads: [{ id: '777002', name: 'Khach', lastActivityMs: T0 - DAY }], nextBefore: null }] });
    await run(s, target);
    expect(calls.sync).toEqual(['777002']);
    expect(s.getStatus(id)?.stage).toBe('completed');
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  test('aPageWhoseInboxNeverComesBackStopsTheRun', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ page: true, ready: () => false });
    await run(s, target);
    expect(calls.list).toEqual([]);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Tài khoản Facebook mất kết nối — đã dừng đồng bộ' });
  });

  test('secondStartWhileRunningIsRejected', async () => {
    const s = svc();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { target } = makeTarget({ pages: [{ threads: [th('101', T0)], nextBefore: null }], thread: async () => { await gate; return { saved: 0, received: 0, pages: 1, complete: true }; } });
    const first = s.start(id, { fromTs: null, toTs: null }, async () => target);
    expect(first.success).toBe(true);
    const second = s.start(id, { fromTs: null, toTs: null }, async () => target);
    expect(second).toMatchObject({ success: false, error: 'Đang đồng bộ tài khoản này' });
    release();
    await s.whenIdle(id);
    expect(s.getStatus(id)?.stage).toBe('completed');
  });

  test('listsPagesUntilNextBeforeNull', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ pages: [
      { threads: [th('102', T0)], nextBefore: 111 },
      { threads: [th('103', T0 - 1000)], nextBefore: null },
    ] });
    await run(s, target);
    expect(calls.list).toEqual([null, 111]);
    expect(calls.sync.sort()).toEqual(['102', '103']);
    expect(db.queryOne<any>('SELECT id FROM fb_threads WHERE id=? AND account_id=?', ['103', INTERNAL])).toBeTruthy();
  });

  test('stopsListingWhenOldestThreadBeforeFrom', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ pages: [
      { threads: [th('104', T0), th('105', T0 - 10 * DAY)], nextBefore: 5 },
      { threads: [th('106', T0 - 20 * DAY)], nextBefore: null },
    ] });
    await run(s, target, { fromTs: T0 - DAY, toTs: null });
    expect(calls.list).toEqual([null]);
    expect(calls.sync).toEqual(['104']);
  });

  test('mergesLocalThreadsWithoutDuplicates', async () => {
    const s = svc();
    db.saveFBThread({ id: '115', account_id: INTERNAL, name: 'L', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0, last_message_at: T0 - 1000 } as any);
    db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, last_message_time, channel) VALUES (?, '117', 'C', ?, 'facebook')`, [id, T0 - 2000]);
    const { target, calls } = makeTarget({ pages: [{ threads: [th('115', T0), th('116', T0 - 3000)], nextBefore: null }] });
    await run(s, target);
    expect([...calls.sync].sort()).toEqual(['115', '116', '117']);
  });

  test('filtersByRangeNewestFirst', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ pages: [{ threads: [th('107', T0 - 2 * DAY), th('108', T0), th('109', T0 - 30 * DAY), th('110', 0)], nextBefore: null }] });
    await run(s, target, { fromTs: T0 - 5 * DAY, toTs: null });
    expect(calls.sync).toEqual(['108', '107', '110']);
    expect(s.getStatus(id)?.threadsTotal).toBe(3);
  });

  test('e2eeThreadCountedAndSkipped', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ e2ee: ['111'], pages: [{ threads: [th('111', T0), th('112', T0 - 1)], nextBefore: null }] });
    await run(s, target);
    expect(calls.sync).toEqual(['112']);
    expect(s.getStatus(id)).toMatchObject({ skippedE2EE: 1, threadsDone: 2, stage: 'completed' });
  });

  test('fetchFailureCountsFailedThreadAndRunCompletes', async () => {
    const s = svc();
    const { target } = makeTarget({
      pages: [{ threads: [th('113', T0), th('114', T0 - 1)], nextBefore: null }],
      thread: (tid, opts) => {
        if (tid === '113') return { saved: 0, received: 0, pages: 1, complete: false, error: 'x', code: 'FETCH' };
        opts.onPage({ saved: 1, received: 1 });
        return { saved: 1, received: 1, pages: 1, complete: true };
      },
    });
    await run(s, target);
    expect(s.getStatus(id)).toMatchObject({ stage: 'completed', failedThreads: 1, threadsDone: 2, messagesSaved: 1, message: 'Đã đồng bộ 2 hội thoại, 1 tin mới' });
  });

  test('riskCodeFailsRunAndSkipsRest', async () => {
    const s = svc();
    const { target, calls } = makeTarget({
      pages: [{ threads: [th('102', T0), th('103', T0 - 1)], nextBefore: null }],
      thread: () => ({ saved: 0, received: 0, pages: 1, complete: false, error: 'Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản', code: 'RISK' }),
    });
    await run(s, target);
    expect(calls.sync).toEqual(['102']);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản' });
  });

  test('cookieExpiredMidRunFails', async () => {
    const s = svc();
    let status = 'connected';
    const { target, calls } = makeTarget({
      status: () => status,
      pages: [{ threads: [th('102', T0), th('103', T0 - 1)], nextBefore: null }],
      thread: () => { status = 'cookie_expired'; return { saved: 0, received: 0, pages: 1, complete: true }; },
    });
    await run(s, target);
    expect(calls.sync).toEqual(['102']);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản' });
  });

  test('disconnectMidRunFails', async () => {
    const s = svc();
    let up = true;
    const { target } = makeTarget({ connected: () => up, pages: [{ threads: [th('102', T0), th('103', T0 - 1)], nextBefore: null }], thread: () => { up = false; return { saved: 0, received: 0, pages: 1, complete: true }; } });
    await run(s, target);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Tài khoản Facebook mất kết nối — đã dừng đồng bộ' });
  });

  test('cancelMidThreadEndsCancelled', async () => {
    const s = svc();
    const { target, calls } = makeTarget({
      pages: [{ threads: [th('102', T0), th('103', T0 - 1)], nextBefore: null }],
      thread: (_tid, opts) => {
        opts.onPage({ saved: 4, received: 4 });
        s.cancel(id);
        expect(opts.shouldStop()).toBe(true);
        return { saved: 4, received: 4, pages: 1, complete: false, code: 'CANCELLED' };
      },
    });
    await run(s, target);
    expect(calls.sync).toEqual(['102']);
    expect(s.getStatus(id)).toMatchObject({ stage: 'cancelled', message: 'Đã dừng — đã lưu 4 tin mới', threadsDone: 0 });
    expect(events().some(e => e.message === 'Đang dừng…')).toBe(true);
  });

  test('riskErrorWhileListingFails', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ pages: [{ threads: [], nextBefore: 9, error: 'checkpoint required' }] });
    await run(s, target);
    expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản' });
    expect(calls.sync).toEqual([]);
  });

  test('plainListingErrorKeepsWhatWasListed', async () => {
    const s = svc();
    const { target, calls } = makeTarget({ pages: [
      { threads: [th('102', T0)], nextBefore: 7 },
      { threads: [], nextBefore: 8, error: 'timeout' },
    ] });
    await run(s, target);
    expect(calls.sync).toEqual(['102']);
    expect(s.getStatus(id)?.stage).toBe('completed');
  });

  test('emptyRangeCompletesWithMessage', async () => {
    const s = svc();
    await run(s, makeTarget().target);
    expect(s.getStatus(id)).toMatchObject({ stage: 'completed', message: 'Không có hội thoại nào trong khoảng thời gian này' });
  });

  test('waitsForLimiterBeforeListPageInSlices', async () => {
    const s = svc();
    const { target, limiter } = makeTarget({ pages: [{ threads: [th('102', T0)], nextBefore: 1 }, { threads: [], nextBefore: null }] });
    limiter.waitMs = jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(2500).mockReturnValue(0);
    await run(s, target);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 1000, 500]);
  });

  test('onWaitSetsPausedUntilAndOnPageClearsIt', async () => {
    const s = svc();
    const seen: Array<number | undefined> = [];
    const { target } = makeTarget({
      pages: [{ threads: [th('102', T0)], nextBefore: null }],
      thread: (_t, opts) => {
        opts.onWait(5000);
        seen.push(s.getStatus(id)?.pausedUntil);
        opts.onPage({ saved: 1, received: 1 });
        seen.push(s.getStatus(id)?.pausedUntil);
        return { saved: 1, received: 1, pages: 1, complete: true };
      },
    });
    await run(s, target);
    expect(seen).toEqual([T0 + 5000, undefined]);
  });

  test('terminalStatusAlwaysEmittedAndProgressThrottled', async () => {
    const s = svc();
    const { target } = makeTarget({
      pages: [{ threads: [th('102', T0)], nextBefore: null }],
      thread: (_t, opts) => { for (let i = 0; i < 20; i++) opts.onPage({ saved: 1, received: 1 }); return { saved: 20, received: 20, pages: 20, complete: true }; },
    });
    await run(s, target);
    const ev = events();
    expect(ev[ev.length - 1]).toMatchObject({ stage: 'completed', messagesSaved: 20 });
    expect(ev.length).toBeLessThan(12);
  });

  test('getStatusReturnsFinalAndRerunAfterFinishWorks', async () => {
    const s = svc();
    expect(s.getStatus(id)).toBeNull();
    await run(s, makeTarget().target);
    expect(s.getStatus(id)?.stage).toBe('completed');
    const again = s.start(id, { fromTs: null, toTs: null }, async () => makeTarget().target);
    expect(again.success).toBe(true);
    await s.whenIdle(id);
    expect(s.getStatus(id)?.stage).toBe('completed');
  });

  test('getServiceRejectionEndsRunFailed', async () => {
    const s = svc();
    s.start(id, { fromTs: null, toTs: null }, async () => { throw new Error('boom'); });
    await s.whenIdle(id);
    expect(s.getStatus(id)?.stage).toBe('failed');
  });
  describe('fix round 1', () => {
    const okPage = (ids: string[], next: number | null) => ({ threads: ids.map((x, i) => th(x, T0 - i)), nextBefore: next });

    test('idsNormalisedAcrossSources', async () => {
      const s = svc();
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, last_message_time, channel) VALUES (?, '123@msgr', 'C', ?, 'facebook')`, [id, T0]);
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, last_message_time, channel) VALUES (?, 'abc', 'C', ?, 'facebook')`, [id, T0]);
      const { target, calls } = makeTarget({ pages: [okPage(['123'], null)] });
      await run(s, target);
      expect(calls.sync).toEqual(['123']);
      expect(s.getStatus(id)?.failedThreads).toBe(0);
    });

    test('longListingWaitIsVisibleAndShortIsSilent', async () => {
      const s = svc();
      const { target, limiter } = makeTarget({ pages: [okPage(['1'], 5), okPage(['2'], null)] });
      limiter.waitMs = jest.fn().mockReturnValueOnce(4000).mockReturnValueOnce(3999).mockReturnValue(0);
      await run(s, target);
      const paused = events().filter(e => e.pausedUntil);
      expect(paused.length).toBe(1);
      expect(paused[0].pausedUntil).toBe(T0 + 4000);
      expect(events().some(e => e.stage === 'listing' && !e.pausedUntil && e.message.includes('(1)'))).toBe(true);
      expect(s.getStatus(id)?.pausedUntil).toBeUndefined();
    });

    test('repeatedCursorStopsListingAndRunContinues', async () => {
      const s = svc();
      const { target, calls } = makeTarget({ pages: [okPage(['1'], 10), okPage(['2'], 20), okPage(['3'], 10), okPage(['9'], null)] });
      await run(s, target);
      expect(calls.list).toEqual([null, 10, 20]);
      expect(calls.sync.sort()).toEqual(['1', '2', '3']);
      expect(s.getStatus(id)?.stage).toBe('completed');
    });

    test('maxThreadPagesStopsListing', async () => {
      const s = svc();
      const pages = Array.from({ length: MAX_THREAD_PAGES + 5 }, (_, i) => okPage([String(i + 1)], i + 1000));
      const { target, calls } = makeTarget({ pages, thread: () => ({ saved: 0, received: 0, pages: 1, complete: true }) });
      await run(s, target);
      expect(calls.list.length).toBe(MAX_THREAD_PAGES);
      expect(s.getStatus(id)?.stage).toBe('completed');
    });

    test('codeWithoutErrorCountsAsFailedThread', async () => {
      const s = svc();
      const { target } = makeTarget({ pages: [okPage(['1'], null)], thread: () => ({ saved: 0, received: 0, pages: 1, complete: false, code: 'FETCH' }) });
      await run(s, target);
      expect(s.getStatus(id)).toMatchObject({ failedThreads: 1, stage: 'completed' });
    });

    test('cancelDuringListing', async () => {
      const s = svc();
      const { target, calls } = makeTarget({ pages: [okPage(['1'], 5), okPage(['2'], null)] });
      const orig = target.getThreadListPage;
      target.getThreadListPage = async b => { const r = await orig(b); s.cancel(id); return r; };
      await run(s, target);
      expect(s.getStatus(id)?.stage).toBe('cancelled');
      expect(calls.sync).toEqual([]);
    });

    test('cancelDuringLimiterWaitInListing', async () => {
      const s = svc();
      const { target, limiter, calls } = makeTarget({ pages: [okPage(['1'], null)] });
      limiter.waitMs = jest.fn().mockReturnValue(10_000);
      sleep.mockImplementationOnce(async ms => { clock += ms; s.cancel(id); });
      await run(s, target);
      expect(s.getStatus(id)?.stage).toBe('cancelled');
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(calls.list).toEqual([]);
    });

    test('cancelBetweenThreads', async () => {
      const s = svc();
      const { target, calls } = makeTarget({
        pages: [okPage(['1', '2'], null)],
        thread: () => { s.cancel(id); return { saved: 0, received: 0, pages: 1, complete: true }; },
      });
      await run(s, target);
      expect(calls.sync).toEqual(['1']);
      expect(s.getStatus(id)?.stage).toBe('cancelled');
    });

    test('threadListRejectionFailsRunWithTerminalStatus', async () => {
      const s = svc();
      const { target } = makeTarget();
      target.getThreadListPage = async () => { throw new Error('net down'); };
      await run(s, target);
      expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'net down' });
    });

    test('syncThreadRejectionCountsFailedThread', async () => {
      const s = svc();
      const { target } = makeTarget({ pages: [okPage(['1', '2'], null)] });
      target.syncThreadHistory = async () => { throw new Error('boom'); };
      await run(s, target);
      expect(s.getStatus(id)).toMatchObject({ stage: 'completed', failedThreads: 2, threadsDone: 2 });
    });

    test.each(['BRIDGE_DOWN', 'BRIDGE_OLD', 'COOLDOWN'] as const)('%sStopsRunWithTargetError', async code => {
      const s = svc();
      const { target, calls } = makeTarget({ pages: [okPage(['1', '2'], null)], thread: () => ({ saved: 0, received: 0, pages: 0, complete: false, code, error: `err-${code}` }) });
      await run(s, target);
      expect(calls.sync).toEqual(['1']);
      expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: `err-${code}` });
    });

    test('cooldownBeforeListingFails', async () => {
      const s = svc();
      const { target, limiter, calls } = makeTarget({ pages: [okPage(['1'], null)] });
      limiter.recordResult(false, 'checkpoint');
      await run(s, target);
      expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Facebook có dấu hiệu hạn chế — đã dừng đồng bộ để bảo vệ tài khoản' });
      expect(calls.list).toEqual([]);
    });

    test('progressStringsAreEmitted', async () => {
      const s = svc();
      await run(s, makeTarget({ pages: [okPage(['1', '2'], null)] }).target);
      const msgs = events().map(e => e.message);
      expect(msgs).toContain('Đang lấy danh sách hội thoại…');
      expect(msgs.some(m => /^Đang lấy danh sách hội thoại… \(\d+\)$/.test(m))).toBe(true);
      expect(msgs).toContain('Đang tải tin nhắn 2 hội thoại…');
    });
  });

  describe('final fix round', () => {
    const okPage = (ids: string[]) => ({ threads: ids.map((x, i) => th(x, T0 - i)), nextBefore: null });

    test('listingSavesAndReadsThreadsOnTheBossDb', async () => {
      const s = svc();
      db.saveFBThread({ id: '9001', account_id: INTERNAL, name: 'Local', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0 } as any);
      const { target, calls } = makeTarget({ pages: [okPage(['9002'])] });
      await run(s, target);
      expect(calls.sync.sort()).toEqual(['9001', '9002']);
      // saveFBThreads + local thread/contact listing
      expect(bossCalls).toHaveBeenCalledTimes(2);
    });

    test('shortReconnectDuringTheRunIsWaitedOut', async () => {
      const s = svc();
      let checks = 0;
      let down = false;
      const { target, calls } = makeTarget({
        connected: () => !down || ++checks > 3,
        pages: [okPage(['201', '202'])],
        thread: () => { down = true; return { saved: 0, received: 0, pages: 1, complete: true }; },
      });
      await run(s, target);
      expect(calls.sync).toEqual(['201', '202']);
      expect(s.getStatus(id)).toMatchObject({ stage: 'completed' });
      expect(sleep.mock.calls.some(c => c[0] === 5000)).toBe(true);
    });

    test('lostConnectionFailsAfterTwoMinutes', async () => {
      const s = svc();
      let down = false;
      const { target, calls } = makeTarget({ connected: () => !down, pages: [okPage(['201', '202'])], thread: () => { down = true; return { saved: 0, received: 0, pages: 1, complete: true }; } });
      await run(s, target);
      expect(calls.sync).toEqual(['201']);
      expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Tài khoản Facebook mất kết nối — đã dừng đồng bộ' });
      expect(sleep.mock.calls.filter(c => c[0] === 5000)).toHaveLength(24);
    });

    test('cookieExpiryWhileWaitingFailsAtOnce', async () => {
      const s = svc();
      let down = false;
      let waited = 0;
      sleep.mockImplementation(async (ms: number) => { clock += ms; if (down) waited++; });
      const { target } = makeTarget({
        connected: () => !down, status: () => (waited >= 1 ? 'cookie_expired' : 'connected'),
        pages: [okPage(['201', '202'])], thread: () => { down = true; return { saved: 0, received: 0, pages: 1, complete: true }; },
      });
      await run(s, target);
      expect(s.getStatus(id)).toMatchObject({ stage: 'failed', error: 'Phiên Facebook hết hạn hoặc cần xác minh — đã dừng đồng bộ để bảo vệ tài khoản' });
      expect(waited).toBe(1);
      sleep.mockImplementation(async (ms: number) => { clock += ms; });
    });

    test('cancelWhileWaitingForTheConnectionEndsCancelled', async () => {
      const s = svc();
      let down = false;
      sleep.mockImplementation(async (ms: number) => { clock += ms; if (down) s.cancel(id); });
      const { target } = makeTarget({ connected: () => !down, pages: [okPage(['201', '202'])], thread: () => { down = true; return { saved: 0, received: 0, pages: 1, complete: true }; } });
      await run(s, target);
      expect(s.getStatus(id)?.stage).toBe('cancelled');
      sleep.mockImplementation(async (ms: number) => { clock += ms; });
    });
  });
});
