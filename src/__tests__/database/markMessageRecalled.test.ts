import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-recall-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';

const OWNER = 'zalo-owner-recall';

describe('markMessageRecalled on a real database', () => {
  const db = DatabaseService.getInstance();
  const insert = (msgId: string, cliMsgId: string | null, content: string) => db.run(
    `INSERT INTO messages (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel)
     VALUES (?, ?, ?, 'thread-1', 0, 'peer-1', ?, 'text', 1000, 0, 'zalo')`, [msgId, cliMsgId, OWNER, content]);
  const row = (msgId: string) => db.queryOne<any>('SELECT is_recalled, msg_type, content, recalled_content FROM messages WHERE owner_zalo_id=? AND msg_id=?', [OWNER, msgId])!;

  beforeAll(async () => { await db.initialize(); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('marksAMessageRecalledByItsMessageId', () => {
    insert('g-100', 'c-100', 'hello-recall-1');
    db.markMessageRecalled(OWNER, 'g-100');
    expect(row('g-100')).toEqual({ is_recalled: 1, msg_type: 'recalled', content: JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' }), recalled_content: 'hello-recall-1' });
  });

  test('recallingTheSameMessageTwiceKeepsTheOriginalContent', () => {
    insert('g-300', 'c-300', 'hello-recall-3');
    db.markMessageRecalled(OWNER, 'g-300');
    db.markMessageRecalled(OWNER, 'g-300');
    db.markMessageRecalled(OWNER, 'c-300');
    expect(row('g-300')).toMatchObject({ is_recalled: 1, recalled_content: 'hello-recall-3' });
  });

  test('marksAMessageRecalledByItsClientMessageId', () => {
    insert('g-200', 'c-200', 'hello-recall-2');
    db.markMessageRecalled(OWNER, 'c-200');
    expect(row('g-200')).toMatchObject({ is_recalled: 1, msg_type: 'recalled', recalled_content: 'hello-recall-2' });
  });
});
