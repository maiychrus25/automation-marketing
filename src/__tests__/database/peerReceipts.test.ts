import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-receipts-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import {
  recordPeerReceipt, messageTimestampById, handleZaloReceiptEvents, recordFacebookReceipt,
} from '../../services/receipts/peerReceipts';

const OWNER = 'owner-1';
const FB_OWNER = 'fb-owner-1';
let seq = 0;

describe('peer receipts', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  let broadcastSeen: jest.SpyInstance;

  const contact = (owner: string, id: string, channel = 'zalo') => {
    db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, channel) VALUES (?, ?, 'x', ?)`, [owner, id, channel]);
    return id;
  };
  const newContact = (channel = 'zalo') => contact(channel === 'zalo' ? OWNER : FB_OWNER, `t-${++seq}`, channel);
  const marks = (owner: string, id: string) =>
    db.queryOne<any>('SELECT peer_delivered_ts AS d, peer_read_ts AS r FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [owner, id])!;
  const msg = (owner: string, thread: string, over: Record<string, any>) => db.run(
    `INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel, cli_msg_id)
     VALUES (?, ?, ?, 0, 's', 'c', 'text', ?, 1, ?, ?)`,
    [over.msgId, owner, thread, over.ts, over.channel ?? 'zalo', over.cli ?? null],
  );
  const receiptEvents = () => emit.mock.calls.filter(c => c[0] === 'event:receipt');

  beforeAll(async () => { await db.initialize(); });
  beforeEach(() => {
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation(() => {});
    broadcastSeen = jest.spyOn(EventBroadcaster, 'broadcastSeen').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('advancesAndEmitsOnce', () => {
    const t = newContact();
    expect(recordPeerReceipt(OWNER, t, { deliveredTs: 100 })).toEqual({ deliveredTs: 100, readTs: 0 });
    expect(receiptEvents()).toEqual([['event:receipt', { zaloId: OWNER, threadId: t, deliveredTs: 100, readTs: 0 }]]);
    expect(marks(OWNER, t)).toEqual({ d: 100, r: 0 });
  });

  test('readImpliesDelivered', () => {
    const t = newContact();
    expect(recordPeerReceipt(OWNER, t, { readTs: 500 })).toEqual({ deliveredTs: 500, readTs: 500 });
    expect(marks(OWNER, t)).toEqual({ d: 500, r: 500 });
  });

  test('lowerOrEqualIsNoop', () => {
    const t = newContact();
    recordPeerReceipt(OWNER, t, { readTs: 500 });
    emit.mockClear();
    expect(recordPeerReceipt(OWNER, t, { readTs: 500 })).toBeNull();
    expect(recordPeerReceipt(OWNER, t, { deliveredTs: 300, readTs: 400 })).toBeNull();
    expect(receiptEvents()).toHaveLength(0);
    expect(marks(OWNER, t)).toEqual({ d: 500, r: 500 });
  });

  test('missingContactIsNotCreated', () => {
    expect(recordPeerReceipt(OWNER, 'ghost', { readTs: 5 })).toBeNull();
    expect(db.queryOne("SELECT 1 FROM contacts WHERE contact_id='ghost'")).toBeUndefined();
    expect(receiptEvents()).toHaveLength(0);
  });

  test.each([[0], [-5], [NaN], ['junk' as any], [undefined as any]])('badValueIgnored %p', (bad) => {
    const t = newContact();
    expect(recordPeerReceipt(OWNER, t, { deliveredTs: bad, readTs: bad })).toBeNull();
    expect(marks(OWNER, t)).toEqual({ d: 0, r: 0 });
    expect(receiptEvents()).toHaveLength(0);
  });

  test('migrationAddsColumnsToOldDb', () => {
    db.exec('ALTER TABLE contacts DROP COLUMN peer_delivered_ts');
    db.exec('ALTER TABLE contacts DROP COLUMN peer_read_ts');
    (db as any).migrate();
    const t = newContact();
    expect(marks(OWNER, t)).toEqual({ d: 0, r: 0 });
  });

  describe('messageTimestampById', () => {
    test('byMsgIdThenCliMsgId', () => {
      const t = newContact();
      msg(OWNER, t, { msgId: 'm1', ts: 1000 });
      msg(OWNER, t, { msgId: 'm2', ts: 2000, cli: 'cli-2' });
      expect(messageTimestampById(OWNER, t, ['m1'], 'zalo')).toBe(1000);
      expect(messageTimestampById(OWNER, t, ['nope', 'cli-2'], 'zalo')).toBe(2000);
      expect(messageTimestampById(OWNER, t, ['nope'], 'zalo')).toBe(0);
      expect(messageTimestampById(OWNER, t, [null, undefined, '0'], 'zalo')).toBe(0);
    });
  });

  describe('handleZaloReceiptEvents', () => {
    const userSeen = (t: string, msgId: string, extra: any = {}) => ({ type: 0, threadId: t, isSelf: false, data: { msgId, realMsgId: msgId, ...extra } });

    test('badItemsDoNotStopGoodOne', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'm1', ts: 1000 });
      const thrower = { get threadId(): string { throw new Error('boom'); }, data: {} };
      expect(() => handleZaloReceiptEvents(OWNER, [null, thrower, userSeen(t, 'm1')], 'read')).not.toThrow();
      expect(marks(OWNER, t)).toEqual({ d: 1000, r: 1000 });
      expect(broadcastSeen).toHaveBeenCalledTimes(1);
    });

    test('nonArrayDoesNotThrow', () => {
      for (const bad of [null, undefined, {}, 'x', 5]) expect(() => handleZaloReceiptEvents(OWNER, bad, 'read')).not.toThrow();
      expect(broadcastSeen).not.toHaveBeenCalled();
    });

    test('cliMsgIdFallbackForUserSeen', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'm9', ts: 3000, cli: 'cli-9' });
      handleZaloReceiptEvents(OWNER, [userSeen(t, 'cli-9')], 'read');
      expect(marks(OWNER, t).r).toBe(3000);
    });

    test('groupSeenCountsAsRead', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'g1', ts: 4000 });
      handleZaloReceiptEvents(OWNER, [{ type: 1, threadId: t, isSelf: false, data: { msgId: 'g1', groupId: t, seenUids: ['u2'] } }], 'read');
      expect(marks(OWNER, t).r).toBe(4000);
    });

    test('deliveredIsDeliveredOnlyAndDoesNotBroadcastSeen', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'm1', ts: 1000 });
      handleZaloReceiptEvents(OWNER, [{ type: 0, threadId: t, isSelf: false, data: { msgId: 'm1', seen: 0, deliveredUids: [t] } }], 'delivered');
      expect(marks(OWNER, t)).toEqual({ d: 1000, r: 0 });
      expect(broadcastSeen).not.toHaveBeenCalled();
    });

    test('deliveredWithSeenFlagCountsAsRead', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'm1', ts: 1000 });
      handleZaloReceiptEvents(OWNER, [{ type: 0, threadId: t, isSelf: false, data: { msgId: 'm1', seen: 1 } }], 'delivered');
      expect(marks(OWNER, t).r).toBe(1000);
    });

    test('deliveredUnknownMessageUsesMSTsOnlyInMs', () => {
      const t = newContact();
      const ev = (mSTs: number) => [{ type: 0, threadId: t, isSelf: false, data: { msgId: 'unknown', seen: 0, mSTs } }];
      handleZaloReceiptEvents(OWNER, ev(1_700_000_000), 'delivered'); // seconds -> ignored
      expect(marks(OWNER, t).d).toBe(0);
      handleZaloReceiptEvents(OWNER, ev(1_700_000_000_000), 'delivered');
      expect(marks(OWNER, t).d).toBe(1_700_000_000_000);
    });

    test('unknownIdWithoutMStsIgnored', () => {
      const t = newContact();
      handleZaloReceiptEvents(OWNER, [userSeen(t, 'unknown')], 'read');
      expect(marks(OWNER, t)).toEqual({ d: 0, r: 0 });
    });

    test('isSelfSkipsMarkAndBroadcast', () => {
      const t = newContact(); msg(OWNER, t, { msgId: 'm1', ts: 1000 });
      handleZaloReceiptEvents(OWNER, [{ ...userSeen(t, 'm1'), isSelf: true }], 'read');
      expect(marks(OWNER, t)).toEqual({ d: 0, r: 0 });
      expect(broadcastSeen).not.toHaveBeenCalled();
    });
  });

  describe('facebook', () => {
    test('msTimestampsMarkAtLeastSendTime', () => {
      const t = newContact('facebook');
      const T = 1_760_000_000_000;
      msg(FB_OWNER, t, { msgId: 'mid.1', ts: T, channel: 'facebook' });
      recordFacebookReceipt(FB_OWNER, 'self-fb', { threadId: t, actorFbId: 'peer', timestampMs: String(T + 1) }, 'delivered');
      expect(marks(FB_OWNER, t).d).toBeGreaterThanOrEqual(T);
    });

    test('deliveredWithoutTimestampLooksUpMessage', () => {
      const t = newContact('facebook');
      msg(FB_OWNER, t, { msgId: 'mid.2', ts: 7777, channel: 'facebook' });
      recordFacebookReceipt(FB_OWNER, 'self-fb', { threadId: t, actorFbId: 'peer', messageId: 'mid.2' }, 'delivered');
      expect(marks(FB_OWNER, t).d).toBe(7777);
    });

    test('receiptWithoutWatermarkMarksOnlyThatMessage', () => {
      const t = newContact('facebook');
      const T = 1_760_000_000_000;
      msg(FB_OWNER, t, { msgId: 'mid.X', ts: T, channel: 'facebook' });
      msg(FB_OWNER, t, { msgId: 'mid.Y', ts: T + 5000, channel: 'facebook' });
      // object exactly as the listener emits when the delta has no watermark
      recordFacebookReceipt(FB_OWNER, 'self-fb', { messageId: 'mid.X', threadId: t, actorFbId: 'peer', timestampMs: 0 }, 'delivered');
      expect(marks(FB_OWNER, t).d).toBe(T);
    });

    test('receiptWithoutWatermarkForUnknownMessageIsIgnored', () => {
      const t = newContact('facebook');
      emit.mockClear();
      recordFacebookReceipt(FB_OWNER, 'self-fb', { messageId: 'mid.none', threadId: t, actorFbId: 'peer', timestampMs: 0 }, 'delivered');
      expect(marks(FB_OWNER, t)).toEqual({ d: 0, r: 0 });
      expect(receiptEvents()).toHaveLength(0);
    });

    test('readWatermarkRecorded', () => {
      const t = newContact('facebook');
      recordFacebookReceipt(FB_OWNER, 'self-fb', { threadId: t, actorFbId: 'peer', watermarkTimestampMs: 9000 }, 'read');
      expect(marks(FB_OWNER, t)).toEqual({ d: 9000, r: 9000 });
    });

    test('ownDeviceIgnored', () => {
      const t = newContact('facebook');
      recordFacebookReceipt(FB_OWNER, 'self-fb', { threadId: t, actorFbId: 'self-fb', watermarkTimestampMs: 9000 }, 'read');
      expect(marks(FB_OWNER, t)).toEqual({ d: 0, r: 0 });
    });
  });
});
