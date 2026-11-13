import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-zalo-dup-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';

const OWNER = 'owner1';

const msg = (over: { msgId?: string; cliMsgId?: string; uidFrom?: string; threadId?: string; content?: string; isSelf?: boolean } = {}) => ({
  type: 0,
  threadId: over.threadId ?? 'thread1',
  isSelf: over.isSelf ?? false,
  data: {
    msgId: 'msgId' in over ? over.msgId : 'm1',
    cliMsgId: 'cliMsgId' in over ? over.cliMsgId : 'c1',
    uidFrom: over.uidFrom ?? 'u1',
    ts: String(Date.now()),
    msgType: 'webchat',
    content: over.content ?? 'hello',
  },
});

describe('Zalo message delivered twice under two ids', () => {
  const service = DatabaseService.getInstance();
  const count = (): number =>
    service.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE owner_zalo_id=?', [OWNER])!.n;

  beforeAll(async () => { await service.initialize(); });
  afterAll(() => {
    service.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sameCliSameContentDifferentIdIsDuplicate', async () => {
    await service.saveMessage(OWNER, msg({ msgId: 'a1', cliMsgId: 'ca1' }));
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'a2', cliMsgId: 'ca1' }))).toBe(true);
  });

  test.each([
    ['differentContentIsNotDuplicate', { content: 'other' }, OWNER],
    ['differentSenderIsNotDuplicate', { uidFrom: 'u2' }, OWNER],
    ['differentThreadIsNotDuplicate', { threadId: 'thread2' }, OWNER],
    ['differentAccountIsNotDuplicate', {}, 'owner2'],
  ])('%s', async (_name, over, owner) => {
    await service.saveMessage(OWNER, msg({ msgId: 'b1', cliMsgId: 'cb1' }));
    expect(service.isDuplicateZaloDelivery(owner, msg({ msgId: 'b2', cliMsgId: 'cb1', ...over }))).toBe(false);
  });

  test('sameMsgIdIsNotDuplicate', async () => {
    await service.saveMessage(OWNER, msg({ msgId: 'c1x', cliMsgId: 'cc1' }));
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'c1x', cliMsgId: 'cc1' }))).toBe(false);
  });

  test('missingCliOrMissingMsgIdIsNotDuplicate', async () => {
    await service.saveMessage(OWNER, msg({ msgId: 'd1', cliMsgId: 'cd1' }));
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'd2', cliMsgId: undefined }))).toBe(false);
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: undefined, cliMsgId: 'cd1' }))).toBe(false);
  });

  test('syntheticIdIsNotDuplicate', async () => {
    await service.saveMessage(OWNER, msg({ msgId: 'mb_e1', cliMsgId: 'ce1' }));
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'e2', cliMsgId: 'ce1' }))).toBe(false);
    await service.saveMessage(OWNER, msg({ msgId: 'f1', cliMsgId: 'cf1' }));
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'cli_f2', cliMsgId: 'cf1' }))).toBe(false);
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'mb_f3', cliMsgId: 'cf1' }))).toBe(false);
  });

  test('nonZaloRowWithSameKeysIsNotDuplicate', () => {
    service.run(
      `INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel, cli_msg_id)
       VALUES ('fb-h1', ?, 'thread1', 0, 'u1', 'hello', 'text', 1, 0, 'facebook', 'ch1')`, [OWNER]);
    expect(service.isDuplicateZaloDelivery(OWNER, msg({ msgId: 'h2', cliMsgId: 'ch1' }))).toBe(false);
  });

  test('ownSentEchoIsKeptOnce', async () => {
    // The app saves its own sent message only through the listener (selfListen) echo.
    const before = count();
    const own = msg({ msgId: 'g1', cliMsgId: 'cg1', uidFrom: '0', isSelf: true });
    await service.saveMessage(OWNER, own);
    expect(service.isDuplicateZaloDelivery(OWNER, own)).toBe(false);
    await service.saveMessage(OWNER, own); // echo with the same ids
    expect(count()).toBe(before + 1);
  });

  test('indexExistsAndLookupUsesIt', () => {
    const plan = service.query<any>(
      'EXPLAIN QUERY PLAN SELECT msg_id FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND cli_msg_id IS NOT NULL', [OWNER, 'x']
    ).map(r => r.detail).join('\n');
    expect(plan).toContain('idx_messages_cli');
  });

  test('migration adds the index to an old DB', () => {
    service.run('DROP INDEX IF EXISTS idx_messages_cli');
    (service as any).migrate();
    const row = service.queryOne<any>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_cli'");
    expect(row?.name).toBe('idx_messages_cli');
  });
});
