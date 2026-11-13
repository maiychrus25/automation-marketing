import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-bossdb-'));
const activePath = path.join(tmpDir, 'active.db');
const bossPath = path.join(tmpDir, 'boss.db');
const ws = { activeId: 'default' };

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../utils/WorkspaceManager', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getActiveDbPath: () => activePath,
      getActiveWorkspaceId: () => ws.activeId,
      getWorkspaceById: () => ({ dbPath: 'boss.db' }),
      resolveDbPath: (p: string) => path.join(tmpDir, p),
    }),
  },
}));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import { handleZaloReceiptEvents } from '../../services/receipts/peerReceipts';
import { applyZaloReadElsewhere } from '../../services/zalo/zaloReadElsewhere';

// Non-default workspace on screen: Zalo writers must read/write the BOSS (default workspace) DB, where the message is saved.
const OWNER = 'owner-boss';
const T = 1_700_000_000_000;
const msg = (msgId: string, o: { thread?: string; ts?: number; uid?: string; isSelf?: boolean } = {}) => ({
  type: 1, threadId: o.thread ?? 'grpB', isSelf: o.isSelf ?? false,
  data: { msgId, cliMsgId: 'cli-same', uidFrom: o.uid ?? 'u1', ts: String(o.ts ?? T), msgType: 'webchat', content: 'xin chao' },
});

describe('Zalo writers use the boss DB while a non-default workspace is active', () => {
  const db = DatabaseService.getInstance();
  const count = (sql: string, params: any[]) => db.queryOne<any>(sql, params)!.n as number;
  const inBoss = <T>(fn: () => T): T => db.withDbPath(bossPath, fn);
  const msgRows = (thread: string) => count('SELECT COUNT(*) AS n FROM messages WHERE owner_zalo_id=? AND thread_id=?', [OWNER, thread]);
  const contact = (thread: string) => db.queryOne<any>('SELECT * FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [OWNER, thread])!;
  let emit: jest.SpyInstance; let emitAware: jest.SpyInstance; let heard: any[]; let unhook: () => void;

  beforeAll(async () => {
    await db.initialize();
    db.forceFlush();
    fs.copyFileSync(activePath, bossPath); // same schema, separate file
  });
  beforeEach(() => {
    ws.activeId = 'employee';
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
    emitAware = jest.spyOn(EventBroadcaster as any, 'emitAware').mockImplementation(() => {});
    heard = [];
    unhook = EventBroadcaster.onBeforeSend('event:message', (d) => heard.push(d));
  });
  afterEach(() => { unhook(); jest.restoreAllMocks(); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('duplicateDeliveryIsDetectedOnTheBossDb', async () => {
    await EventBroadcaster.broadcastMessage(OWNER, msg('g-a'));
    await EventBroadcaster.broadcastMessage(OWNER, msg('g-b')); // same cliMsgId + content, other msgId
    expect(inBoss(() => msgRows('grpB'))).toBe(1);
    expect(msgRows('grpB')).toBe(0); // nothing leaks into the active DB
  });

  test('silentHistoryReplayOfAKnownMessageIsSkippedOnTheBossDb', async () => {
    await EventBroadcaster.broadcastMessage(OWNER, msg('h-1', { thread: 'grpH', ts: T + 5 }));
    const before = heard.length;
    await EventBroadcaster.broadcastMessage(OWNER, msg('h-1', { thread: 'grpH', ts: T + 5 }), { silent: true });
    expect(inBoss(() => msgRows('grpH'))).toBe(1);
    expect(heard.length).toBe(before);
  });

  test('readElsewhereLowersUnreadInTheBossContact', () => {
    const thread = 'u-unread';
    inBoss(() => {
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, unread_count) VALUES (?, ?, 2)`, [OWNER, thread]);
      for (const [id, ts] of [['i1', T], ['i2', T + 1000]] as const) {
        db.run(`INSERT INTO messages (owner_zalo_id, thread_id, msg_id, channel, sender_id, is_sent, timestamp, status, msg_type) VALUES (?, ?, ?, 'zalo', 'x', 0, ?, 'received', 'text')`, [OWNER, thread, id, ts]);
      }
    });
    applyZaloReadElsewhere(OWNER, [{ threadId: thread, isGroup: false, lastMsgId: 'i2' }]);
    expect(inBoss(() => contact(thread).unread_count)).toBe(0);
    expect(emitAware).toHaveBeenCalledWith('db:unreadChanged', expect.objectContaining({ zaloId: OWNER, contactId: thread, unread: 0 }));
    expect(emit).not.toHaveBeenCalledWith('db:unreadChanged', expect.anything());
  });

  test('seenReceiptAdvancesPeerReadTsInTheBossContact', () => {
    const thread = 'u-recv';
    inBoss(() => {
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id) VALUES (?, ?)`, [OWNER, thread]);
      db.run(`INSERT INTO messages (owner_zalo_id, thread_id, msg_id, channel, sender_id, is_sent, timestamp, status, msg_type) VALUES (?, ?, 'o1', 'zalo', 'me', 1, ?, 'sent', 'text')`, [OWNER, thread, T]);
    });
    handleZaloReceiptEvents(OWNER, [{ type: 0, threadId: thread, isSelf: false, data: { msgId: 'o1', realMsgId: 'o1', seenUids: [thread] } }], 'read');
    expect(inBoss(() => contact(thread).peer_read_ts)).toBe(T);
    expect(emitAware).toHaveBeenCalledWith('event:receipt', expect.objectContaining({ zaloId: OWNER, threadId: thread }));
  });

  test('defaultWorkspaceKeepsEverythingOnTheSingleDbAndEmitsToTheRenderer', async () => {
    ws.activeId = 'default';
    await EventBroadcaster.broadcastMessage(OWNER, msg('d-a', { thread: 'grpD', ts: T + 9 }));
    await EventBroadcaster.broadcastMessage(OWNER, msg('d-b', { thread: 'grpD', ts: T + 9 }));
    expect(msgRows('grpD')).toBe(1);
    expect(inBoss(() => msgRows('grpD'))).toBe(0);
    expect(heard).toHaveLength(1);
  });
});
