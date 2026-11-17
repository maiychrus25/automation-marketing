import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-handled-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';

describe('setMessageHandledByEmployeeFlexible', () => {
  const db = DatabaseService.getInstance();
  beforeAll(async () => { await db.initialize(); });
  const insert = (owner: string, thread: string, msgId: string) => db.run(
    `INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel)
     VALUES (?, ?, ?, 0, 's', 'c', 'text', 1, 1, 'telegram_user')`, [msgId, owner, thread]);
  const handled = (owner: string, thread: string) =>
    db.queryOne<any>('SELECT handled_by_employee AS h FROM messages WHERE owner_zalo_id=? AND thread_id=?', [owner, thread])!.h;

  test('withAThreadOnlyTheRowOfThatThreadIsTagged', () => {
    // Telegram message ids restart in every chat: the same msg_id exists in two chats of one account.
    insert('tg-1', 'chat-A', '5');
    insert('tg-1', 'chat-B', '5');
    db.setMessageHandledByEmployeeFlexible('tg-1', '5', 'emp-1', 'chat-A');
    expect(handled('tg-1', 'chat-A')).toBe('emp-1');
    expect(handled('tg-1', 'chat-B')).toBeNull();
  });

  test('withAThreadAnIncomingRowWithTheSameIdIsNotTagged', () => {
    db.run(`INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel)
      VALUES ('6', 'tg-2', 'chat-Y', 0, 's', 'c', 'text', 1, 0, 'telegram_user')`);
    db.setMessageHandledByEmployeeFlexible('tg-2', '6', 'emp-1', 'chat-Y');
    expect(handled('tg-2', 'chat-Y')).toBeNull();
  });

  test('withoutAThreadTheBehaviourIsUnchanged', () => {
    insert('acc-z', 'u1', '9');
    insert('acc-z', 'u2', '10');
    db.setMessageHandledByEmployeeFlexible('acc-z', '9', 'emp-2');
    expect(handled('acc-z', 'u1')).toBe('emp-2');
    expect(handled('acc-z', 'u2')).toBeNull();
  });
});
