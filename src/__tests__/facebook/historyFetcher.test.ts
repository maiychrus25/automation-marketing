import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-history-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import Logger from '../../utils/Logger';
import DatabaseService from '../../services/database/DatabaseService';
import { FacebookHistoryFetcher, HISTORY_RISK_TEXT, HISTORY_LIVE_WINDOW_MS } from '../../services/facebook/FacebookHistoryFetcher';
import { FacebookHistoryLimiter } from '../../services/facebook/FacebookHistoryLimiter';
import { BridgeNotReadyError } from '../../services/facebook/FacebookE2EEBridge';

const ACC = 'acc-history';
const OWNER = '100500';
const T0 = 1_700_000_000_000;
const NO_ANCHOR = { timestampMs: 0, messageId: '' };

describe('FacebookHistoryFetcher', () => {
  const db = DatabaseService.getInstance();
  let seq = 0;

  const newThread = (e2ee = false): string => {
    const id = String(200000 + ++seq);
    db.saveFBThread({ id, account_id: ACC, name: 'Khach', type: 'user', participant_count: 2, unread_count: 3, is_muted: 0, is_e2ee: e2ee ? 1 : 0 } as any);
    return id;
  };
  const seedLocal = (threadId: string, id: string, ts: number) =>
    db.saveFBMessage({ id, account_id: ACC, thread_id: threadId, sender_id: '777', body: 'cu', timestamp: ts, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
  const rows = (threadId: string) =>
    db.query<any>("SELECT msg_id, is_sent, msg_type, timestamp FROM messages WHERE owner_zalo_id=? AND thread_id=? AND channel='facebook' ORDER BY timestamp", [OWNER, threadId]);
  const thread = (id: string) => db.queryOne<any>('SELECT unread_count, last_message_preview, last_message_at FROM fb_threads WHERE id=? AND account_id=?', [id, ACC]);

  const bridgeMsg = (threadId: string, id: string, ts: number, extra: any = {}) =>
    ({ id, threadId: Number(threadId), senderId: 777, text: 'noi dung ' + id, timestampMs: ts, ...extra });
  const bridgePage = (threadId: string, msgs: any[], more = true) => {
    const min = msgs.reduce((a, m) => (m.timestampMs < a.timestampMs ? m : a), msgs[0]);
    return { threadId, messages: msgs, hasMoreBefore: more, minTimestampMs: min.timestampMs, minMessageId: min.id };
  };
  const gqlMsg = (id: string, ts: number, extra: any = {}) =>
    ({ id, body: 'gql ' + id, isAdmin: false, timestampMs: ts, senderId: '777', senderName: 'A', attachments: [], reactions: [], isUnsent: false, replyToMessageId: '', ...extra });

  const make = (over: any = {}) => {
    const clock = { t: T0 + 10_000_000 };
    const limiter = new FacebookHistoryLimiter(() => clock.t);
    const sleep = jest.fn(async (ms: number) => { clock.t += ms; });
    const bridge = { isAlive: jest.fn(() => true), fetchMessages: jest.fn() };
    const gql = jest.fn();
    const runOnBossDb = jest.fn((fn: (d: DatabaseService) => void) => fn(db));
    const fetcher = new FacebookHistoryFetcher({
      accountId: ACC, facebookId: () => OWNER, bridge: () => bridge, fetchGraphQLPage: gql, limiter, sleep,
      now: () => clock.t, runOnBossDb, ...over,
    });
    return { fetcher, limiter, sleep, bridge, gql, clock, runOnBossDb };
  };

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('guards', () => {
    test('cooldownBlocksWithoutNetwork', async () => {
      const { fetcher, limiter, bridge, gql } = make();
      limiter.recordResult(false, 'checkpoint');
      const res: any = await fetcher.fetchPage(newThread(), NO_ANCHOR);
      expect(res).toMatchObject({ success: false, code: 'COOLDOWN' });
      expect(res.error).toBe('Đang tạm dừng tải lịch sử Facebook để bảo vệ tài khoản (còn 30 phút)');
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
      expect(gql).not.toHaveBeenCalled();
    });

    test('badThreadIdIsFetchError', async () => {
      const { fetcher, gql } = make();
      expect(await fetcher.fetchPage('abc', NO_ANCHOR)).toMatchObject({ success: false, code: 'FETCH', error: 'Mã hội thoại không hợp lệ' });
      expect(gql).not.toHaveBeenCalled();
    });

    test('e2eeThreadIsRefused', async () => {
      const { fetcher, gql, bridge } = make();
      const id = newThread(true);
      expect(fetcher.isE2EEThread(id)).toBe(true);
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: false, code: 'E2EE', error: 'Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ' });
      expect(gql).not.toHaveBeenCalled();
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
    });

    test('threadWithOnlyBridgeMessageIdsIsTreatedAsE2EE', async () => {
      // Chat 1:1 mã hoá thường không có hàng fb_threads nên không có cờ is_e2ee: nhận ra từ tin đã có trong máy.
      const { fetcher, gql, bridge } = make();
      const id = String(200000 + ++seq);
      expect(fetcher.isE2EEThread(id)).toBe(false); // chưa có tin nào: chưa kết luận được
      seedLocal(id, '7526000000000000001', T0);
      expect(fetcher.isE2EEThread(id)).toBe(true);
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: false, code: 'E2EE' });
      expect(gql).not.toHaveBeenCalled();
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
      // Hội thoại có cả tin Messenger thường (đã chuyển sang mã hoá) vẫn tải được phần cũ.
      seedLocal(id, 'mid.$cAAA1', T0 - 1_000);
      expect(fetcher.isE2EEThread(id)).toBe(false);
    });

    // Hội thoại của Page không bao giờ mã hoá đầu cuối: một hội thoại chỉ có tin mang mã tạm `page:<ms>` (Page gửi qua
    // trình duyệt) không được báo nhầm là "mã hoá, không tải được tin cũ".
    test('anAccountWithoutEncryptedChatsNeverTreatsAThreadAsE2EE', async () => {
      const { fetcher } = make({ hasEncryptedChats: () => false, latestPageUnavailable: () => 'chưa có tin làm mốc' });
      const id = String(200000 + ++seq);
      seedLocal(id, 'page:1700000000000', T0);
      expect(fetcher.isE2EEThread(id)).toBe(false);
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: false, code: 'FETCH', error: 'chưa có tin làm mốc' });
    });

    // Page không có trang "tin mới nhất": hội thoại chưa có tin làm mốc thì báo lỗi ngay, không gọi mạng, không tính vào
    // hạn mức tải lịch sử (nhiều hội thoại như vậy không được làm cạn hạn mức của cả tài khoản).
    test('anAccountWithoutALatestPageFailsFastWithoutChargingTheLimiter', async () => {
      const { fetcher, gql, bridge, limiter, sleep } = make({ latestPageUnavailable: () => 'chưa có tin làm mốc' });
      const charged = jest.spyOn(limiter, 'recordRequest');
      const id = String(200000 + ++seq);
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toEqual({ success: false, code: 'FETCH', error: 'chưa có tin làm mốc' });
      expect(await fetcher.syncThread(id, { fromTs: null, toTs: null })).toMatchObject({ complete: false, error: 'chưa có tin làm mốc', pages: 0 });
      expect(gql).not.toHaveBeenCalled();
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
      expect(charged).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      // Có tin làm mốc thì vẫn tải qua kết nối như thường.
      seedLocal(id, 'mid.$cAAA9', T0);
      bridge.fetchMessages.mockResolvedValue({ threadId: id, messages: [], hasMoreBefore: false, minTimestampMs: 0 });
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: true, source: 'lightspeed' });
    });
  });

  describe('save order', () => {
    test('replyInTheSamePageGetsItsQuoteEvenWhenThePageIsNewestFirst', async () => {
      const { fetcher, gql } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [
        gqlMsg('mid.$reply', T0 + 2000, { replyToMessageId: 'mid.$orig' }),
        gqlMsg('mid.$orig', T0 + 1000),
      ], cursor: { hasMore: false } });
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: true, saved: 2 });
      const reply = db.queryOne<any>("SELECT quote_data FROM messages WHERE owner_zalo_id=? AND msg_id='mid.$reply'", [OWNER]);
      expect(JSON.parse(reply.quote_data)).toMatchObject({ msgId: 'mid.$orig', msg: 'gql mid.$orig' });
    });
  });

  describe('anchor choice', () => {
    test('noLightSpeedMessageLocallyUsesGraphQl', async () => {
      const { fetcher, gql, bridge } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$g1', T0 + 1000), gqlMsg('mid.$g2', T0 + 2000)], cursor: { hasMore: true } });
      const res: any = await fetcher.fetchPage(id, NO_ANCHOR);
      expect(gql).toHaveBeenCalledWith(id, 20);
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
      expect(res).toMatchObject({ success: true, source: 'graphql', count: 2, saved: 2, stored: 2, received: 2, hasMoreBefore: true, minTimestampMs: T0 + 1000, minMessageId: 'mid.$g1' });
    });

    test('graphQlWithoutLightSpeedMessagesHasNoMore', async () => {
      const { fetcher, gql } = make();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('4000000000000000001', T0)], cursor: { hasMore: true } });
      const res: any = await fetcher.fetchPage(newThread(), NO_ANCHOR);
      expect(res.hasMoreBefore).toBe(false);
    });

    test('callerAnchorGoesToBridge', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$p1', T0 - 5000)]));
      await fetcher.fetchPage(id, { timestampMs: T0, messageId: 'mid.$x' });
      expect(bridge.fetchMessages).toHaveBeenCalledWith({ threadId: id, beforeTimestampMs: T0, beforeMessageId: 'mid.$x' });
      expect(gql).not.toHaveBeenCalled();
    });

    test('numericAnchorFallsBackToOlderLightSpeedMessage', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$y', T0 - 5000);
      seedLocal(id, 'mid.$z', T0 + 5000);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$p1', T0 - 9000)]));
      await fetcher.fetchPage(id, { timestampMs: T0, messageId: '4000000000000000009' });
      expect(bridge.fetchMessages).toHaveBeenCalledWith({ threadId: id, beforeTimestampMs: T0 - 5000, beforeMessageId: 'mid.$y' });
    });

    test('temporaryMessageIdAlsoFallsBack', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$y', T0 - 5000);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$p1', T0 - 9000)]));
      await fetcher.fetchPage(id, { timestampMs: T0, messageId: 'tmp_12345' });
      expect(bridge.fetchMessages).toHaveBeenCalledWith(expect.objectContaining({ beforeMessageId: 'mid.$y' }));
    });

    test('noAnchorUsesNewestLocalLightSpeedMessage', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$old', T0 - 9000);
      seedLocal(id, 'mid.$new', T0 - 1000);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$p1', T0 - 9500)]));
      await fetcher.fetchPage(id, NO_ANCHOR);
      expect(bridge.fetchMessages).toHaveBeenCalledWith(expect.objectContaining({ beforeMessageId: 'mid.$new', beforeTimestampMs: T0 - 1000 }));
    });

    test('latestKnownMuchNewerThanLocalUsesGraphQl', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      seedLocal(id, 'mid.$old', T0);
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$g1', T0 + 100_000)] });
      await fetcher.fetchPage(id, NO_ANCHOR, undefined, { latestKnownMs: T0 + 60_001 });
      expect(gql).toHaveBeenCalledTimes(1);
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
    });

    test('latestKnownWithinGapStillUsesBridge', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      seedLocal(id, 'mid.$old', T0);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$p1', T0 - 1000)]));
      await fetcher.fetchPage(id, NO_ANCHOR, undefined, { latestKnownMs: T0 + 60_000 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
      expect(gql).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    const withAnchor = { timestampMs: T0, messageId: 'mid.$x' };

    test('bridgeNullIsBridgeDown', async () => {
      const { fetcher } = make({ bridge: () => null });
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'BRIDGE_DOWN', error: 'Bridge Facebook chưa chạy (đang kết nối lại) — thử lại sau ít phút' });
    });

    test('bridgeNotAliveIsBridgeDown', async () => {
      const { fetcher, bridge } = make();
      bridge.isAlive.mockReturnValue(false);
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'BRIDGE_DOWN' });
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
    });

    test.each([
      ['unknown method: fetchMessages', 'BRIDGE_OLD'],
      ['bridge disconnected', 'BRIDGE_DOWN'],
      ['client not initialised', 'BRIDGE_DOWN'],
      ['Messenger client is not initialised', 'BRIDGE_DOWN'],
      ['timed out waiting for Messenger history', 'FETCH'],
      ['history request already running for thread 5', 'FETCH'],
      ['fetch messages task: boom', 'FETCH'],
    ])('bridgeError "%s" maps to %s', async (message, code) => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new Error(message));
      const res: any = await fetcher.fetchPage(newThread(), withAnchor);
      expect(res).toMatchObject({ success: false, code });
      if (code === 'FETCH') expect(res.error).toBe(message);
      if (code === 'BRIDGE_OLD') expect(res.error).toBe('Bridge Facebook bản cũ chưa hỗ trợ tải lịch sử — khởi động lại MaiHub sau khi cập nhật');
    });

    test('bridgeNotReadyErrorIsBridgeDown', async () => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new BridgeNotReadyError());
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'BRIDGE_DOWN' });
    });

    test('riskErrorStartsCooldown', async () => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new Error('checkpoint required'));
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'RISK', error: HISTORY_RISK_TEXT });
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'COOLDOWN' });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('graphQlFailureIsFetchWithOriginalMessage', async () => {
      const { fetcher, gql } = make();
      gql.mockResolvedValue({ success: false, error: 'loi mang' });
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR)).toMatchObject({ success: false, code: 'FETCH', error: 'loi mang', source: 'graphql' });
    });

    test('graphQlRiskStartsCooldown', async () => {
      const { fetcher, gql } = make();
      gql.mockResolvedValue({ success: false, error: 'login_required' });
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR)).toMatchObject({ success: false, code: 'RISK' });
    });
  });

  describe('rate limiting', () => {
    test('interactiveTooLongIsBusy', async () => {
      const { fetcher, limiter, gql, sleep } = make();
      for (let i = 0; i < 120; i++) limiter.recordRequest();
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR)).toMatchObject({ success: false, code: 'BUSY', error: 'Đang tải nhiều tin cũ — thử lại sau ít phút' });
      expect(gql).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    test('interactiveShortWaitSleepsThenFetches', async () => {
      const { fetcher, limiter, gql, sleep } = make();
      limiter.recordRequest();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$g1', T0)] });
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR)).toMatchObject({ success: true });
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    test('backgroundWaitsInSlicesThenFetches', async () => {
      const { fetcher, limiter, gql, sleep } = make();
      limiter.recordRequest();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$g1', T0)] });
      const onWait = jest.fn();
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR, undefined, { mode: 'background', onWait })).toMatchObject({ success: true });
      expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 1000]);
      expect(onWait).not.toHaveBeenCalled();
    });

    test('backgroundReportsLongWaitOnce', async () => {
      const { fetcher, limiter, gql } = make();
      for (let i = 0; i < 120; i++) limiter.recordRequest();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$g1', T0)] });
      const onWait = jest.fn();
      let stops = 0;
      const res: any = await fetcher.fetchPage(newThread(), NO_ANCHOR, undefined, { mode: 'background', onWait, shouldStop: () => ++stops > 3 });
      expect(res).toMatchObject({ success: false, code: 'CANCELLED', error: 'Đã huỷ' });
      expect(onWait).toHaveBeenCalledTimes(1);
      expect(onWait.mock.calls[0][0]).toBeGreaterThanOrEqual(4000);
      expect(gql).not.toHaveBeenCalled();
    });

    test('backgroundCancelledWhileWaiting', async () => {
      const { fetcher, limiter, gql } = make();
      limiter.recordRequest();
      const res: any = await fetcher.fetchPage(newThread(), NO_ANCHOR, undefined, { mode: 'background', shouldStop: () => true });
      expect(res).toMatchObject({ success: false, code: 'CANCELLED' });
      expect(gql).not.toHaveBeenCalled();
    });
  });

  describe('storing', () => {
    test('historyPageIsStoredWithoutTouchingUnreadOrPreview', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      const before = thread(id);
      const msgs = [
        bridgeMsg(id, 'mid.$s1', T0 + 1000),
        bridgeMsg(id, 'mid.$s2', T0 + 2000, { senderId: Number(OWNER) }),
        bridgeMsg(id, 'mid.$s3', T0 + 3000, { text: '', attachments: [{ type: 'image', url: 'https://x.invalid/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 10 }] }),
      ];
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, msgs));
      const res: any = await fetcher.fetchPage(id, { timestampMs: T0 + 9000, messageId: 'mid.$top' });
      expect(res).toMatchObject({ success: true, source: 'lightspeed', saved: 3, stored: 3, received: 3, count: 3, hasMoreBefore: true, minTimestampMs: T0 + 1000, minMessageId: 'mid.$s1' });
      const stored = rows(id);
      expect(stored.map(r => r.msg_id)).toEqual(['mid.$s1', 'mid.$s2', 'mid.$s3']);
      expect(stored.map(r => r.is_sent)).toEqual([0, 1, 0]);
      expect(stored.map(r => r.msg_type)).toEqual(['text', 'text', 'image']);
      expect(thread(id)).toEqual(before);

      const again: any = await fetcher.fetchPage(id, { timestampMs: T0 + 9000, messageId: 'mid.$top' });
      expect(again).toMatchObject({ success: true, saved: 0, stored: 0, received: 3, count: 3 });
      expect(rows(id)).toHaveLength(3);
    });

    test('bridgeAdminMessageIsSystemAndMissingMinIsDerived', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      bridge.fetchMessages.mockResolvedValue({ threadId: id, messages: [bridgeMsg(id, 'mid.$a1', T0 + 5000, { isAdminMsg: true }), bridgeMsg(id, 'mid.$a2', T0 + 4000)], hasMoreBefore: true });
      const res: any = await fetcher.fetchPage(id, { timestampMs: T0 + 9000, messageId: 'mid.$top' });
      expect(res.minTimestampMs).toBe(T0 + 4000);
      expect(rows(id).map(r => r.msg_type)).toEqual(['text', 'system']);
    });

    test('graphQlPageDoesNotTouchUnreadOrPreview', async () => {
      const { fetcher, gql } = make();
      const id = newThread();
      const before = thread(id);
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$q1', T0 + 1000, { senderId: OWNER }), gqlMsg('mid.$q2', T0 + 2000, { isAdmin: true })] });
      await fetcher.fetchPage(id, NO_ANCHOR);
      expect(rows(id).map(r => [r.is_sent, r.msg_type])).toEqual([[1, 'text'], [0, 'system']]);
      expect(thread(id)).toEqual(before);
    });

    test('rangeOnlyStoresMessagesInside', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      const msgs = [0, 1000, 2000, 3000].map(d => bridgeMsg(id, 'mid.$r' + d, T0 + d));
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, msgs));
      const res: any = await fetcher.fetchPage(id, { timestampMs: T0 + 9000, messageId: 'mid.$top' }, { fromTs: T0 + 1000, toTs: T0 + 2000 });
      expect(res).toMatchObject({ success: true, saved: 2, stored: 2, received: 2, count: 4 });
      expect(rows(id).map(r => r.msg_id)).toEqual(['mid.$r1000', 'mid.$r2000']);
    });

    test('persistGraphQlMessagesReportsFreshAndStored', () => {
      const { fetcher } = make();
      const id = newThread();
      const msgs = [gqlMsg('mid.$k1', T0 + 1000), gqlMsg('mid.$k2', T0 + 2000)];
      expect(fetcher.persistGraphQLMessages(id + '@facebook.com', msgs)).toEqual({ stored: 2, fresh: 2, received: 2 });
      expect(fetcher.persistGraphQLMessages(id, msgs)).toEqual({ stored: 0, fresh: 0, received: 2 });
    });
  });

  describe('fix round 1', () => {
    const withAnchor = { timestampMs: T0, messageId: 'mid.$x' };

    test('bridgeReplacedDuringWaitIsReReadAfterTheWait', async () => {
      const oldBridge = { isAlive: jest.fn(() => true), fetchMessages: jest.fn() };
      const newBridge = { isAlive: jest.fn(() => true), fetchMessages: jest.fn() };
      let current: any = oldBridge;
      const { fetcher, limiter, sleep, clock } = make({ bridge: () => current });
      limiter.recordRequest();
      sleep.mockImplementation(async (ms: number) => { clock.t += ms; current = newBridge; });
      const id = newThread();
      newBridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$w1', T0 - 1000)]));
      expect(await fetcher.fetchPage(id, withAnchor, undefined, { mode: 'background' })).toMatchObject({ success: true });
      expect(newBridge.fetchMessages).toHaveBeenCalledTimes(1);
      expect(oldBridge.fetchMessages).not.toHaveBeenCalled();
    });

    test('bridgeGoneDuringWaitIsBridgeDownWithoutSpendingARequest', async () => {
      const live = { isAlive: jest.fn(() => true), fetchMessages: jest.fn() };
      let current: any = live;
      const { fetcher, limiter, sleep, clock } = make({ bridge: () => current });
      limiter.recordRequest();
      sleep.mockImplementation(async (ms: number) => { clock.t += ms; current = null; });
      const recorded = jest.spyOn(limiter, 'recordRequest');
      expect(await fetcher.fetchPage(newThread(), withAnchor, undefined, { mode: 'background' })).toMatchObject({ success: false, code: 'BRIDGE_DOWN' });
      expect(recorded).not.toHaveBeenCalled();
      expect(live.fetchMessages).not.toHaveBeenCalled();
    });

    test('cooldownStartingDuringWaitIsCooldown', async () => {
      const { fetcher, limiter, sleep, clock, gql } = make();
      limiter.recordRequest();
      sleep.mockImplementation(async (ms: number) => { clock.t += ms; limiter.recordResult(false, 'checkpoint'); });
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR, undefined, { mode: 'background' })).toMatchObject({ success: false, code: 'COOLDOWN' });
      expect(gql).not.toHaveBeenCalled();
    });

    test('successfulRequestsAreReportedToTheLimiter', async () => {
      const { fetcher, limiter, bridge, gql } = make();
      const reported = jest.spyOn(limiter, 'recordResult');
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$ok1', T0)] });
      await fetcher.fetchPage(id, NO_ANCHOR);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$ok2', T0 - 1000)]));
      await fetcher.fetchPage(id, withAnchor);
      expect(reported.mock.calls).toEqual([[true], [true]]);
    });

    test('graphQlPageIgnoresNodesWithoutTimestampWhenFindingTheOldest', async () => {
      const { fetcher, gql } = make();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$z0', 0), gqlMsg('mid.$z1', T0 + 1000), gqlMsg('mid.$z2', T0 + 2000)], cursor: { hasMore: true } });
      expect(await fetcher.fetchPage(newThread(), NO_ANCHOR)).toMatchObject({ success: true, minTimestampMs: T0 + 1000, minMessageId: 'mid.$z1', hasMoreBefore: true });
    });

    test('bridgeFallbackMinIgnoresMessagesWithoutTimestamp', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      bridge.fetchMessages.mockResolvedValue({ threadId: id, messages: [bridgeMsg(id, 'mid.$y0', 0), bridgeMsg(id, 'mid.$y1', T0 + 4000)], hasMoreBefore: true });
      expect(await fetcher.fetchPage(id, withAnchor)).toMatchObject({ success: true, minTimestampMs: T0 + 4000 });
    });

    test('unknownErrorShapesGetAGenericText', async () => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue({ code: 5 });
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'FETCH', error: 'Facebook không trả lời' });
    });

    test('seventeenDigitThreadIdIsStoredExactly', async () => {
      const { fetcher, bridge } = make();
      const id = '24512345678901234';
      expect(String(Number(id))).not.toBe(id);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$big1', T0 - 1000)]));
      await fetcher.fetchPage(id, withAnchor);
      expect(rows(id).map(r => r.msg_id)).toEqual(['mid.$big1']);
    });

    test('anchorIgnoresOtherThreadsAndOtherChannels', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      const other = newThread();
      seedLocal(other, 'mid.$other', T0 - 1000);
      db.run(`INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel)
              VALUES ('mid.$zalo', ?, ?, 0, '1', 'x', 'text', ?, 0, '[]', 'received', 'zalo')`, [OWNER, id, T0 - 2000]);
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$n1', T0)] });
      await fetcher.fetchPage(id, NO_ANCHOR);
      expect(gql).toHaveBeenCalledTimes(1);
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
    });

    test('failedGraphQlCallCountsOneRequest', async () => {
      const { fetcher, limiter, gql } = make();
      const recorded = jest.spyOn(limiter, 'recordRequest');
      gql.mockResolvedValue({ success: false, error: 'loi mang' });
      await fetcher.fetchPage(newThread(), NO_ANCHOR);
      expect(recorded).toHaveBeenCalledTimes(1);
    });

    test('checkOrderCooldownThenIdThenE2ee', async () => {
      const first = make();
      first.limiter.recordResult(false, 'checkpoint');
      expect(await first.fetcher.fetchPage('abc', NO_ANCHOR)).toMatchObject({ code: 'COOLDOWN' });
      const second = make({ bridge: () => null });
      expect(await second.fetcher.fetchPage(newThread(true), withAnchor)).toMatchObject({ code: 'E2EE' });
    });

    test('savingHistoryDoesNotLogMessageContent', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [
        bridgeMsg(id, 'mid.$l1', T0 + 1000, { text: 'bi mat rieng tu' }),
        bridgeMsg(id, 'mid.$l2', T0 + 2000, { text: '', attachments: [{ type: 'sticker', url: 'https://secret.invalid/s.png' }] }),
      ]));
      (Logger.log as jest.Mock).mockClear();
      await fetcher.fetchPage(id, { timestampMs: T0 + 9000, messageId: 'mid.$top' });
      const logged = JSON.stringify((Logger.log as jest.Mock).mock.calls);
      expect(logged).not.toContain('bi mat rieng tu');
      expect(logged).not.toContain('secret.invalid');
      expect(rows(id)).toHaveLength(2);
    });

    test('savingLiveMessagesStillLogs', () => {
      const id = newThread();
      (Logger.log as jest.Mock).mockClear();
      db.saveFBMessage({ id: 'mid.$live1', account_id: ACC, thread_id: id, sender_id: '777', body: 'tin song', timestamp: T0, type: 'text', is_self: 0, is_unsent: 0 });
      expect(JSON.stringify((Logger.log as jest.Mock).mock.calls)).toContain('tin song');
    });
  });

  describe('final fix round', () => {
    const withAnchor = { timestampMs: T0, messageId: 'mid.$x' };

    test('everyDbTouchRunsOnTheBossDb', async () => {
      const { fetcher, bridge, gql, runOnBossDb } = make();
      const id = newThread();
      fetcher.isE2EEThread(id);
      expect(runOnBossDb).toHaveBeenCalledTimes(1);

      runOnBossDb.mockClear();
      seedLocal(id, 'mid.$b0', T0 - 1000);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$b1', T0 - 2000)]));
      expect(await fetcher.fetchPage(id, NO_ANCHOR)).toMatchObject({ success: true, saved: 1 });
      // e2ee check + anchor lookup + one save for the whole page
      expect(runOnBossDb).toHaveBeenCalledTimes(3);

      runOnBossDb.mockClear();
      const other = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$b2', T0), gqlMsg('mid.$b3', T0 + 1)] });
      expect(await fetcher.fetchPage(other, NO_ANCHOR)).toMatchObject({ success: true, saved: 2 });
      expect(runOnBossDb).toHaveBeenCalledTimes(3);
    });

    test('messagesInsideTheLiveWindowAreLeftToTheLivePath', async () => {
      const { fetcher, clock, bridge } = make();
      const id = newThread();
      const fresh = clock.t - 10_000;
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [
        bridgeMsg(id, 'mid.$live', fresh), bridgeMsg(id, 'mid.$o1', T0 + 2000), bridgeMsg(id, 'mid.$o2', T0 + 1000),
      ]));
      const res: any = await fetcher.fetchPage(id, withAnchor);
      expect(res).toMatchObject({ success: true, saved: 2, stored: 2, received: 2, count: 3, minTimestampMs: T0 + 1000, minMessageId: 'mid.$o2' });
      expect(rows(id).map(r => r.msg_id)).toEqual(['mid.$o2', 'mid.$o1']);

      // the live event arrives later: it must still count as a new message
      const before = thread(id).unread_count;
      const outcome = db.saveFBMessage({ id: 'mid.$live', account_id: ACC, thread_id: id, sender_id: '777', body: 'moi', timestamp: fresh, type: 'text', is_self: 0, is_unsent: 0 });
      expect(outcome).toBe('new');
      expect(thread(id).unread_count).toBe(before + 1);
    });

    test('theWindowIsFiveMinutes', () => {
      expect(HISTORY_LIVE_WINDOW_MS).toBe(5 * 60_000);
    });

    test('liveWindowAlsoAppliesToGraphQlPages', () => {
      const { fetcher, clock } = make();
      const id = newThread();
      expect(fetcher.persistGraphQLMessages(id, [gqlMsg('mid.$gl1', clock.t - 1000), gqlMsg('mid.$gl2', T0)])).toEqual({ stored: 1, fresh: 1, received: 1 });
    });

    const COLLISION = 'history request already running for thread 5';

    test('backgroundRetriesACollidingThreadRequest', async () => {
      const { fetcher, bridge, sleep, limiter } = make();
      const id = newThread();
      const recorded = jest.spyOn(limiter, 'recordResult');
      bridge.fetchMessages
        .mockRejectedValueOnce(new Error(COLLISION))
        .mockRejectedValueOnce(new Error(COLLISION))
        .mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$c1', T0 - 1000)]));
      const res = await fetcher.fetchPage(id, withAnchor, undefined, { mode: 'background' });
      expect(res).toMatchObject({ success: true, saved: 1 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.filter(c => c[0] === 1000)).toHaveLength(10);
      expect(sleep.mock.calls.every(c => c[0] <= 1000)).toBe(true);
      expect(recorded.mock.calls.filter(c => c[0] === false)).toHaveLength(0);
    });

    test('backgroundGivesUpAfterSixRetries', async () => {
      const { fetcher, bridge, limiter } = make();
      bridge.fetchMessages.mockRejectedValue(new Error(COLLISION));
      const res: any = await fetcher.fetchPage(newThread(), withAnchor, undefined, { mode: 'background' });
      expect(res).toMatchObject({ success: false, code: 'FETCH', error: COLLISION });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(7);
      expect(limiter.cooldownRemaining()).toBe(0);
    });

    test('collisionRetryHonoursShouldStop', async () => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new Error(COLLISION));
      let stop = false;
      bridge.fetchMessages.mockImplementation(async () => { stop = true; throw new Error(COLLISION); });
      const res: any = await fetcher.fetchPage(newThread(), withAnchor, undefined, { mode: 'background', shouldStop: () => stop });
      expect(res).toMatchObject({ success: false, code: 'CANCELLED' });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('interactiveReturnsACollisionAtOnce', async () => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new Error(COLLISION));
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'FETCH', error: COLLISION });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('collisionRetriesDoNotUseUpTheSyncFetchRetry', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$s0', T0);
      bridge.fetchMessages
        .mockRejectedValueOnce(new Error(COLLISION))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$s1', T0 - 1000)], false));
      expect(await fetcher.syncThread(id, { fromTs: null, toTs: null })).toMatchObject({ complete: true, pages: 1 });
    });

    test.each(['Bridge exited (code=1)', 'Bridge closed'])('"%s" is bridge down', async message => {
      const { fetcher, bridge } = make();
      bridge.fetchMessages.mockRejectedValue(new Error(message));
      expect(await fetcher.fetchPage(newThread(), withAnchor)).toMatchObject({ success: false, code: 'BRIDGE_DOWN' });
    });
  });

  describe('syncThread', () => {
    const all = { fromTs: null, toTs: null };

    test('threePagesThenEnd', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$a3', T0 + 3000), gqlMsg('mid.$a4', T0 + 4000)], cursor: { hasMore: true } });
      bridge.fetchMessages
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$a2', T0 + 2000)]))
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$a1', T0 + 1000)], false));
      const onPage = jest.fn();
      const res = await fetcher.syncThread(id, all, { onPage });
      expect(res).toEqual({ saved: 4, received: 4, pages: 3, complete: true });
      expect(onPage).toHaveBeenCalledTimes(3);
      expect(bridge.fetchMessages).toHaveBeenNthCalledWith(1, { threadId: id, beforeTimestampMs: T0 + 3000, beforeMessageId: 'mid.$a3' });
    });

    test('stopsWhenOldestIsBeforeRangeStart', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$b1', T0 - 5000), gqlMsg('mid.$b2', T0 + 1000)], cursor: { hasMore: true } });
      const res = await fetcher.syncThread(id, { fromTs: T0, toTs: null });
      expect(res).toMatchObject({ pages: 1, complete: true, saved: 1, received: 1 });
      expect(bridge.fetchMessages).not.toHaveBeenCalled();
    });

    test('stopsWhenBridgeRepeatsTheSamePage', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$c9', T0 + 9000);
      bridge.fetchMessages.mockImplementation(async () => bridgePage(id, [bridgeMsg(id, 'mid.$c9', T0 + 9000)]));
      const res = await fetcher.syncThread(id, all);
      // trang 1 lùi từ tin trong máy; trang 2 trả lại đúng trang đó → mốc không lùi → dừng
      expect(res).toMatchObject({ complete: true, pages: 2 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(2);
    });

    test('stopsWhenALaterPageIsNewerThanItsAnchor', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$n3', T0 + 3000)], cursor: { hasMore: true } });
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$n4', T0 + 4000)]));
      const res = await fetcher.syncThread(id, all);
      expect(res).toMatchObject({ complete: true, pages: 2 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('oneFetchErrorIsRetried', async () => {
      const { fetcher, gql } = make();
      const id = newThread();
      gql
        .mockResolvedValueOnce({ success: false, error: 'boom' })
        .mockResolvedValueOnce({ success: true, messages: [gqlMsg('mid.$d1', T0 + 1000)] });
      const res = await fetcher.syncThread(id, all);
      expect(res).toMatchObject({ complete: true, pages: 1, saved: 1 });
      expect(gql).toHaveBeenCalledTimes(2);
    });

    test('twoFetchErrorsInARowFail', async () => {
      const { fetcher, gql } = make();
      gql.mockResolvedValue({ success: false, error: 'boom' });
      const res = await fetcher.syncThread(newThread(), all);
      expect(res).toMatchObject({ complete: false, code: 'FETCH', error: 'boom', pages: 0 });
      expect(gql).toHaveBeenCalledTimes(2);
    });

    test('otherErrorsEndImmediately', async () => {
      const { fetcher, bridge } = make();
      const id = newThread();
      seedLocal(id, 'mid.$e1', T0);
      bridge.fetchMessages.mockRejectedValue(new Error('bridge disconnected'));
      const res = await fetcher.syncThread(id, all);
      expect(res).toMatchObject({ complete: false, code: 'BRIDGE_DOWN', pages: 0 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('cancelledIsIncompleteWithoutError', async () => {
      const { fetcher, gql } = make();
      const res: any = await fetcher.syncThread(newThread(), all, { shouldStop: () => true });
      expect(res.complete).toBe(false);
      expect(res.error).toBeUndefined();
      expect(res.code).toBeUndefined();
      expect(gql).not.toHaveBeenCalled();
    });

    test('rangeEndingInThePastWalksNewerPagesWithoutStoringThem', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      const toTs = T0 + 5000;
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$f9', T0 + 9000), gqlMsg('mid.$f6', T0 + 6000)], cursor: { hasMore: true } });
      bridge.fetchMessages
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$f5', T0 + 5000), bridgeMsg(id, 'mid.$f4', T0 + 4000)]))
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$f2', T0 + 2000)], false));
      const res = await fetcher.syncThread(id, { fromTs: null, toTs });
      expect(res).toEqual({ saved: 3, received: 3, pages: 3, complete: true });
      expect(rows(id).map(r => r.msg_id)).toEqual(['mid.$f2', 'mid.$f4', 'mid.$f5']);
    });

    test('latestKnownIsOnlyUsedOnFirstPage', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      seedLocal(id, 'mid.$g0', T0);
      // trang 1 (bridge) lưu mid.$g1 (cũ hơn latestKnown - 60 s) và trả mốc kế tiếp không có mã tin → trang 2 tra trong DB,
      // nơi mid.$g1 sẽ bị coi là không có mốc nếu latestKnownMs còn được truyền
      bridge.fetchMessages
        .mockResolvedValueOnce({ threadId: id, messages: [bridgeMsg(id, 'mid.$g1', T0 - 20_000)], hasMoreBefore: true, minTimestampMs: T0 - 20_000 })
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$g2', T0 - 21_000)], false));
      const res = await fetcher.syncThread(id, all, { latestKnownMs: T0 + 50_000 });
      expect(res).toMatchObject({ pages: 2, complete: true });
      expect(gql).not.toHaveBeenCalled();
      expect(bridge.fetchMessages).toHaveBeenNthCalledWith(2, { threadId: id, beforeTimestampMs: T0 - 20_000, beforeMessageId: 'mid.$g1' });
    });

    test('latestKnownIsIgnoredWhenRangeHasUpperBound', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      seedLocal(id, 'mid.$gold', T0 - 20_000);
      bridge.fetchMessages.mockResolvedValue(bridgePage(id, [bridgeMsg(id, 'mid.$h1', T0 - 21_000)], false));
      const res = await fetcher.syncThread(id, { fromTs: null, toTs: T0 + 5000 }, { latestKnownMs: T0 + 50_000 });
      expect(res).toMatchObject({ pages: 1, complete: true });
      expect(gql).not.toHaveBeenCalled();
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(1);
    });

    test('stopsWhenAnAnchorIsUsedAgain', async () => {
      const { fetcher, bridge, gql } = make();
      const id = newThread();
      gql.mockResolvedValue({ success: true, messages: [gqlMsg('mid.$A', T0 + 1000)], cursor: { hasMore: true } });
      bridge.fetchMessages
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$B', T0 + 1000)]))
        .mockResolvedValueOnce(bridgePage(id, [bridgeMsg(id, 'mid.$A', T0 + 1000)]))
        .mockRejectedValue(new Error('bridge disconnected'));
      const res = await fetcher.syncThread(id, all);
      expect(res).toMatchObject({ complete: true, pages: 3 });
      expect(bridge.fetchMessages).toHaveBeenCalledTimes(2);
    });
  });
});
