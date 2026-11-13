import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-seen-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookService from '../../services/facebook/FacebookService';

// Real production path: FacebookService.handleBridgeEvent('seen') on a temp DB.
const ACC = 'acc-seen';
const OWNER = 'fb-owner-seen';
const PEER = '100200555';
const T = 1_700_000_000_000;

describe('E2EE bridge seen event records a read mark', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  const mark = () => db.queryOne<any>("SELECT peer_read_ts AS r FROM contacts WHERE owner_zalo_id=? AND contact_id=?", [OWNER, PEER])!.r;
  const calls = (name: string) => emit.mock.calls.filter(c => c[0] === name);

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, channel) VALUES (?, ?, 'x', 'facebook')`, [OWNER, PEER]);
    db.run(
      `INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel)
       VALUES ('own1', ?, ?, 0, ?, 'hi', 'text', ?, 1, 'facebook')`, [OWNER, PEER, OWNER, T]);
  });
  beforeEach(() => { emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any); });
  afterEach(() => emit.mockRestore());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('peerSeenRecordsMarkEmitsReceiptAndKeepsOnSeen', () => {
    const svc: any = new (FacebookService as any)(ACC, 'c_user=1');
    svc.handleBridgeEvent({ type: 'seen', data: { threadId: `${PEER}@msgr`, userId: `${PEER}@msgr`, timestampMs: T + 1 } });
    expect(mark()).toBe(T + 1);
    expect(calls('event:receipt')).toHaveLength(1);
    expect(calls('fb:onSeen')).toHaveLength(1);
  });

  test('ownSeenRecordsNoMark', () => {
    const svc: any = new (FacebookService as any)(ACC, 'c_user=1');
    svc.handleBridgeEvent({ type: 'seen', data: { threadId: PEER, userId: OWNER, timestampMs: T + 5000 } });
    expect(mark()).toBe(T + 1);
    expect(calls('event:receipt')).toHaveLength(0);
    expect(calls('fb:onSeen')).toHaveLength(1);
  });
});
