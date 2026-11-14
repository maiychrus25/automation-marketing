import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-histint-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookHistorySyncService, { FbHistorySyncTarget } from '../../services/facebook/FacebookHistorySyncService';
import { FacebookHistoryFetcher } from '../../services/facebook/FacebookHistoryFetcher';
import { FacebookHistoryLimiter } from '../../services/facebook/FacebookHistoryLimiter';

// Whole path with no network: real temp DB, real fetcher, real sync service; fake bridge, fake GraphQL page.
const ACC = 'acc-hist-int';
const OWNER = '100900';
const T0 = 1_700_000_000_000;
const PAGE = 20;
const NORMAL = '300001';
const E2EE = '300002';
const EMPTY = '300003';
const TOTAL = 45;

describe('Facebook history sync end to end', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  const clock = { t: T0 + 10_000_000 };
  const sleep = jest.fn(async (ms: number) => { clock.t += ms; });

  // Oldest first: message i has timestamp T0 + i * 1000.
  const all = Array.from({ length: TOTAL }, (_, i) => ({ id: `mid.$m${i}`, timestampMs: T0 + i * 1000 }));
  const bridgeCalls: Array<{ threadId: string; beforeTimestampMs: number; beforeMessageId: string }> = [];

  const bridge = {
    isAlive: () => true,
    fetchMessages: async (p: { threadId: string; beforeTimestampMs: number; beforeMessageId: string }) => {
      bridgeCalls.push(p);
      const older = all.filter(m => m.timestampMs < p.beforeTimestampMs).sort((a, b) => b.timestampMs - a.timestampMs);
      const page = older.slice(0, PAGE);
      return {
        threadId: p.threadId,
        messages: page.map(m => ({ id: m.id, threadId: p.threadId, senderId: 777, text: `noi dung ${m.id}`, timestampMs: m.timestampMs })),
        hasMoreBefore: older.length > PAGE,
        minTimestampMs: page.length ? page[page.length - 1].timestampMs : 0,
        minMessageId: page.length ? page[page.length - 1].id : '',
      };
    },
  };
  const graphQlCalls: string[] = [];
  const fetchGraphQLPage = async (threadId: string) => {
    graphQlCalls.push(threadId);
    if (threadId !== NORMAL) return { success: true, messages: [], cursor: { hasMore: false } };
    const newest = all.slice(-PAGE).reverse();
    return {
      success: true, cursor: { hasMore: true },
      messages: newest.map(m => ({ id: m.id, body: `noi dung ${m.id}`, isAdmin: false, timestampMs: m.timestampMs, senderId: '777', senderName: 'A', attachments: [], reactions: [], isUnsent: false, replyToMessageId: '' })),
    };
  };

  const limiter = new FacebookHistoryLimiter(() => clock.t);
  const runOnBossDb = jest.fn((fn: (d: DatabaseService) => void) => fn(db));
  const fetcher = new FacebookHistoryFetcher({ accountId: ACC, facebookId: () => OWNER, bridge: () => bridge, fetchGraphQLPage, limiter, sleep, now: () => clock.t, runOnBossDb });
  const listed = [NORMAL, EMPTY].map((id, i) => ({
    id, name: `Khach ${i}`, type: 'user', participant_count: 2, unread_count: 3, lastActivityMs: T0 + TOTAL * 1000,
  }));
  const target: FbHistorySyncTarget = {
    isConnected: () => true,
    getStatus: () => 'connected',
    getAccountId: () => ACC,
    isPage: () => false,
    isE2EEThread: id => fetcher.isE2EEThread(id),
    historyLimiterFor: () => limiter,
    getThreadListPage: async () => ({ threads: listed, nextBefore: null }),
    syncThreadHistory: (id, range, opts) => fetcher.syncThread(id, range, opts),
  };

  const svc = new (FacebookHistorySyncService as any)({ now: () => clock.t, sleep, runOnBossDb }) as FacebookHistorySyncService & { whenIdle(a: string): Promise<void> };
  const runAll = async () => {
    const res = svc.start(OWNER, { fromTs: null, toTs: null }, async () => target);
    expect(res.success).toBe(true);
    await svc.whenIdle(OWNER);
    return svc.getStatus(OWNER)!;
  };
  const messageRows = () => db.query<any>("SELECT msg_id FROM messages WHERE owner_zalo_id=? AND channel='facebook'", [OWNER]);
  const unreadSnapshot = () => ({
    threads: db.query<any>('SELECT id, unread_count FROM fb_threads WHERE account_id=? ORDER BY id', [ACC]),
    contacts: db.query<any>("SELECT contact_id, unread_count FROM contacts WHERE owner_zalo_id=? AND channel='facebook' ORDER BY contact_id", [OWNER]),
  });

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBThread({ id: E2EE, account_id: ACC, name: 'Ma hoa', type: 'user', participant_count: 2, unread_count: 3, is_muted: 0, is_e2ee: 1 } as any);
    db.saveFBThreads(ACC, listed.map(({ lastActivityMs: _drop, ...t }) => t));
    for (const id of [E2EE]) {
      db.run(`INSERT OR IGNORE INTO contacts (owner_zalo_id, contact_id, display_name, channel, unread_count) VALUES (?, ?, 'Ma hoa', 'facebook', 3)`, [OWNER, id]);
    }
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
  });
  afterAll(() => {
    emit.mockRestore();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('fullRangeSavesEveryMessageOnceWithoutTouchingUnread', async () => {
    const before = unreadSnapshot();
    expect(before.threads.map((t: any) => t.unread_count)).toEqual([3, 3, 3]);

    const first = await runAll();
    expect(first).toMatchObject({ stage: 'completed', threadsTotal: 3, threadsDone: 3, skippedE2EE: 1, failedThreads: 0, messagesSaved: TOTAL });
    expect(messageRows()).toHaveLength(TOTAL);
    // Newest page from GraphQL, the two older pages from the bridge (anchored, nothing numeric or empty).
    expect(graphQlCalls.filter(id => id === NORMAL)).toHaveLength(1);
    expect(bridgeCalls).toHaveLength(2);
    expect(bridgeCalls[0]).toMatchObject({ threadId: NORMAL, beforeMessageId: 'mid.$m25', beforeTimestampMs: T0 + 25_000 });
    expect(unreadSnapshot()).toEqual(before);
    // every DB touch of the run went through the boss-DB runner
    expect(runOnBossDb.mock.calls.length).toBeGreaterThan(0);

    const second = await runAll();
    expect(second).toMatchObject({ stage: 'completed', threadsDone: 3, skippedE2EE: 1, messagesSaved: 0 });
    expect(messageRows()).toHaveLength(TOTAL);
    expect(unreadSnapshot()).toEqual(before);
  });

  test('liveMessageAfterwardsStillCountsAsUnread', () => {
    const before = unreadSnapshot();
    db.saveFBMessage({ id: 'mid.$live1', account_id: ACC, thread_id: NORMAL, sender_id: '777', body: 'tin moi', timestamp: T0 + 99_000, type: 'text', is_self: 0, is_unsent: 0 });
    const after = unreadSnapshot();
    const unreadOf = (s: typeof before, id: string) => ({
      thread: s.threads.find((t: any) => t.id === id).unread_count,
      contact: s.contacts.find((c: any) => c.contact_id === id).unread_count,
    });
    expect(unreadOf(after, NORMAL)).toEqual({ thread: unreadOf(before, NORMAL).thread + 1, contact: unreadOf(before, NORMAL).contact + 1 });
    expect(unreadOf(after, EMPTY)).toEqual(unreadOf(before, EMPTY));
    expect(messageRows()).toHaveLength(TOTAL + 1);
  });
});
