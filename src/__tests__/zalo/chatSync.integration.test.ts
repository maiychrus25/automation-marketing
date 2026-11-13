import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-chatsync-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import { handleZaloReceiptEvents } from '../../services/receipts/peerReceipts';
import { applyZaloClearUnread } from '../../services/zalo/zaloReadElsewhere';
import { lastOutgoingReceipt } from '../../ui/lib/chat/messageReceipt';

// End to end on a temp DB, no network: production EventBroadcaster.broadcastMessage (normalize -> duplicate check -> saveMessage),
// the Zalo receipt handler, the read-elsewhere handler and the renderer's pure label helper, with synthetic zca-js shapes.
const OWNER = 'owner-int';
const T = 1_700_000_000_000;

const zaloMessage = (o: { threadId: string; type?: number; msgId: string; cliMsgId: string; uidFrom: string; ts: number; content: any; msgType?: string; isSelf?: boolean }) => ({
  type: o.type ?? 0,
  threadId: o.threadId,
  isSelf: o.isSelf ?? false,
  data: { msgId: o.msgId, cliMsgId: o.cliMsgId, uidFrom: o.uidFrom, ts: String(o.ts), msgType: o.msgType ?? 'webchat', content: o.content },
});

describe('chat sync end to end (Zalo)', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  const rows = (thread: string) => db.query<any>('SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY timestamp', [OWNER, thread]);
  const contact = (thread: string) => db.queryOne<any>('SELECT * FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [OWNER, thread])!;

  beforeAll(async () => { await db.initialize(); });
  let heard: any[];
  let unhook: () => void;
  beforeEach(() => {
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
    heard = [];
    unhook = EventBroadcaster.onBeforeSend('event:message', (data) => heard.push(data)); // the hook runs where the renderer send happens
  });
  afterEach(() => { unhook(); emit.mockRestore(); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('groupMessageDeliveredTwiceUnderDifferentIdsIsStoredOnce', async () => {
    const first = zaloMessage({ threadId: 'grp1', type: 1, msgId: 'g-a', cliMsgId: 'cli-g', uidFrom: 'u1', ts: T, content: 'xin chao' });
    const second = zaloMessage({ threadId: 'grp1', type: 1, msgId: 'g-b', cliMsgId: 'cli-g', uidFrom: 'u1', ts: T, content: 'xin chao' });
    await EventBroadcaster.broadcastMessage(OWNER, first);
    expect(heard).toHaveLength(1);
    expect(db.isDuplicateZaloDelivery(OWNER, second)).toBe(true);
    await EventBroadcaster.broadcastMessage(OWNER, second);
    expect(rows('grp1')).toHaveLength(1);
    expect(heard).toHaveLength(1); // the UI hears about it once
  });

  test('jxlPhotoIsStoredWithJpgUrl', async () => {
    const jxl = 'https://f21-zpc.zdn.vn/jxl/abc123/photo.jxl?jxlstatus=1';
    const msg = zaloMessage({
      threadId: 'u-photo', msgId: 'p1', cliMsgId: 'cli-p1', uidFrom: 'u-photo', ts: T, msgType: 'chat.photo',
      content: { href: jxl, thumb: jxl, title: '' },
    });
    await EventBroadcaster.broadcastMessage(OWNER, msg);
    const stored = JSON.parse(rows('u-photo')[0].content);
    expect(stored.href).toBe('https://f21-zpc.zdn.vn/jpg/abc123/photo.jpg');
    expect(stored.thumb).toBe('https://f21-zpc.zdn.vn/jpg/abc123/photo.jpg');
    expect(rows('u-photo')[0].content).not.toMatch(/jxl/i);
  });

  test('ownMessageThenDeliveredThenSeenShowsDeliveredThenRead', async () => {
    const thread = 'u-recv';
    await EventBroadcaster.broadcastMessage(OWNER, zaloMessage({ threadId: thread, msgId: 'o1', cliMsgId: 'cli-o1', uidFrom: '0', ts: T, content: 'hi', isSelf: true }));
    const marks = () => ({ deliveredTs: contact(thread).peer_delivered_ts, readTs: contact(thread).peer_read_ts });
    expect(lastOutgoingReceipt(rows(thread), marks(), 'zalo')).toBeNull();

    handleZaloReceiptEvents(OWNER, [{ type: 0, threadId: thread, isSelf: false, data: { msgId: 'o1', realMsgId: 'o1', seen: 0, deliveredUids: [thread] } }], 'delivered');
    expect(lastOutgoingReceipt(rows(thread), marks(), 'zalo')).toBe('delivered');

    handleZaloReceiptEvents(OWNER, [{ type: 0, threadId: thread, isSelf: false, data: { msgId: 'o1', realMsgId: 'o1', seenUids: [thread] } }], 'read');
    expect(lastOutgoingReceipt(rows(thread), marks(), 'zalo')).toBe('read');
  });

  test('readElsewhereClearsUnreadAndReturnsTheBroadcastValue', async () => {
    const thread = 'u-unread';
    await EventBroadcaster.broadcastMessage(OWNER, zaloMessage({ threadId: thread, msgId: 'i1', cliMsgId: 'cli-i1', uidFrom: thread, ts: T, content: 'one' }));
    await EventBroadcaster.broadcastMessage(OWNER, zaloMessage({ threadId: thread, msgId: 'i2', cliMsgId: 'cli-i2', uidFrom: thread, ts: T + 1000, content: 'two' }));
    expect(contact(thread).unread_count).toBe(2);

    const result = applyZaloClearUnread(db, OWNER, { threadId: thread, isGroup: false, lastMsgId: 'i2' });
    expect(result.unread).toBe(0); // what ZaloLoginHelper broadcasts as db:unreadChanged
    expect(contact(thread).unread_count).toBe(0);
  });
});
