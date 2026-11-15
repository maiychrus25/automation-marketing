import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-reactions-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookService from '../../services/facebook/FacebookService';

const ACC = 'acc-reactions';
const OWNER = 'fb-owner-reactions';
const PEER = '100000000000031'; // 15 chữ số như id thật: bridge gửi senderId dạng số, id trên 2^53 sẽ mất chính xác
const T = 1_700_000_000_000;

describe('Facebook E2EE reactions', () => {
  const db = DatabaseService.getInstance();
  let svc: any;
  let emit: jest.SpyInstance;
  const addMsg = (id: string, reactions = '{}') => db.run(
    `INSERT INTO fb_messages (id, account_id, thread_id, sender_id, body, timestamp, reactions, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, ?, ?)`, [id, ACC, PEER, PEER, T, reactions, T]);
  const stored = (id: string) => JSON.parse(db.queryOne<any>(`SELECT reactions FROM fb_messages WHERE id = ?`, [id]).reactions);
  const reaction = (messageId: string, emoji: string) =>
    svc.handleBridgeEvent({ type: 'e2eeReaction', data: { chatJid: `${PEER}@msgr`, messageId, reaction: emoji, senderId: Number(PEER), senderJid: `${PEER}:31@msgr` } });

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  beforeEach(() => {
    svc = new (FacebookService as any)(ACC, 'c_user=1');
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
  });
  afterEach(() => emit.mockRestore());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('peerReactionIsAddedNextToExistingOnes', async () => {
    addMsg('m-add', JSON.stringify({ [OWNER]: '👍' }));
    await reaction('m-add', '❤');
    expect(stored('m-add')).toEqual({ [OWNER]: '👍', [PEER]: '❤' });
    expect(emit).toHaveBeenCalledWith('fb:onReaction', expect.objectContaining({ messageId: 'm-add', threadId: PEER, userId: PEER, emoji: '❤' }));
  });

  // Gỡ cảm xúc tới dưới dạng reaction rỗng; trước đây bị bỏ qua nên cảm xúc cũ còn mãi.
  test('peerRemovingAReactionClearsOnlyTheirs', async () => {
    addMsg('m-remove', JSON.stringify({ [OWNER]: '👍', [PEER]: '❤' }));
    await reaction('m-remove', '');
    expect(stored('m-remove')).toEqual({ [OWNER]: '👍' });
    expect(emit).toHaveBeenCalledWith('fb:onReaction', expect.objectContaining({ messageId: 'm-remove', userId: PEER, emoji: '' }));
  });

  // Thả cảm xúc trong app từng ghi đè cả danh sách bằng riêng cảm xúc của mình.
  test('ownReactionKeepsThePeersReaction', () => {
    addMsg('m-own', JSON.stringify({ [PEER]: '❤' }));
    svc.persistReactionToDB('m-own', OWNER, '😮');
    expect(stored('m-own')).toEqual({ [PEER]: '❤', [OWNER]: '😮' });
    svc.persistReactionToDB('m-own', OWNER, '');
    expect(stored('m-own')).toEqual({ [PEER]: '❤' });
  });

  test('reactionWithoutAMessageIdIsIgnored', async () => {
    await reaction('', '❤');
    expect(emit).not.toHaveBeenCalledWith('fb:onReaction', expect.anything());
  });
});
