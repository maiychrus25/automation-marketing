import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-unread-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookService from '../../services/facebook/FacebookService';

// Real production path: FacebookService.handleIncomingMessage / handlePageMessageNotification on a temp DB.
const ACC = 'acc-parent';
const OWNER = 'fb-owner-1';
const PAGE_ACC = 'acc-page';
const PAGE_FB = 'fb-page-1';
const DELEGATE = 'delegate-1';
const SENDER = '100200300';
const PAGE_SENDER = '100200400'; // fb_threads.id is a global primary key, so the Page thread needs its own id

describe('incoming Facebook message counts unread once', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  const make = (): any => {
    const s = new (FacebookService as any)(ACC, 'c_user=1');
    s.checkAndFetchUserInfo = jest.fn().mockResolvedValue(undefined);
    return s;
  };
  const fbMessageEmits = () => emit.mock.calls.filter(c => c[0] === 'fb:onMessage').length;
  const unread = (owner: string, contactId: string) =>
    db.queryOne<any>("SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [owner, contactId])!.unread_count;
  const threadUnread = (acc: string, id: string) =>
    db.queryOne<any>('SELECT unread_count FROM fb_threads WHERE id=? AND account_id=?', [id, acc])!.unread_count;

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBPageAccount({ id: PAGE_ACC, facebook_id: PAGE_FB, name: 'Page', avatar_url: '', parent_facebook_id: OWNER, delegate_page_id: DELEGATE, proxy_id: null });
    db.saveFBThread({ id: SENDER, account_id: ACC, name: 'Khach', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0 });
    db.saveFBThread({ id: PAGE_SENDER, account_id: PAGE_ACC, name: 'Khach', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0 });
    // Contact rows exist up front so no test depends on another test having created them (randomized order).
    for (const [owner, id] of [[OWNER, SENDER], [PAGE_FB, PAGE_SENDER]]) {
      db.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, channel, unread_count) VALUES (?, ?, 'Khach', 'facebook', 0)`, [owner, id]);
    }
  });
  beforeEach(() => {
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
    // Each test starts from zero unread, so absolute counts hold in any (randomized) order.
    db.run("UPDATE contacts SET unread_count = 0 WHERE channel = 'facebook'");
    db.run('UPDATE fb_threads SET unread_count = 0');
  });
  afterEach(() => emit.mockRestore());
  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('personalMessageCountedOnceAndReplayIsSilent', async () => {
    const service = make();
    const msg = { messageID: 'mid.personal1', userID: SENDER, replyToID: SENDER, body: 'hi', timestamp: '1000', type: 'user', attachments: { id: 0, url: null } } as any;
    await service.handleIncomingMessage({ ...msg });
    expect(unread(OWNER, SENDER)).toBe(1);
    expect(threadUnread(ACC, SENDER)).toBe(1);
    expect(fbMessageEmits()).toBe(1);

    await service.handleIncomingMessage({ ...msg });
    expect(unread(OWNER, SENDER)).toBe(1);
    expect(threadUnread(ACC, SENDER)).toBe(1);
    expect(fbMessageEmits()).toBe(1);
  });

  test('pageMessageCountedOnceAndReplayIsSilent', async () => {
    const n = { pageId: DELEGATE, messageId: 'mid.page1', senderId: PAGE_SENDER, body: 'xin chao', title: 'Khach den Page', pageName: 'Page', senderAvatarUrl: '' };
    await make().handlePageMessageNotification(n);
    expect(unread(PAGE_FB, PAGE_SENDER)).toBe(1);
    expect(threadUnread(PAGE_ACC, PAGE_SENDER)).toBe(1);
    expect(fbMessageEmits()).toBe(1);

    // fresh service = in-memory dedupe set is empty (e.g. after restart); the DB must still stop the replay
    await make().handlePageMessageNotification(n);
    expect(unread(PAGE_FB, PAGE_SENDER)).toBe(1);
    expect(threadUnread(PAGE_ACC, PAGE_SENDER)).toBe(1);
    expect(fbMessageEmits()).toBe(1);
  });

  test('emptyRowFilledByLaterDeliveryUpdatesUiWithoutNewUnread', async () => {
    const service = make();
    const base = { messageID: 'mid.template1', userID: SENDER, replyToID: SENDER, timestamp: '3000', type: 'user', attachments: { id: 0, url: null } } as any;
    const before = unread(OWNER, SENDER);
    const threadBefore = threadUnread(ACC, SENDER);
    await service.handleIncomingMessage({ ...base, body: null });
    expect(unread(OWNER, SENDER)).toBe(before + 1);
    expect(fbMessageEmits()).toBe(1);
    const editEmits = () => emit.mock.calls.filter(c => c[0] === 'fb:onEdit');

    await service.handleIncomingMessage({ ...base, body: 'Tiêu đề mẫu\n• Xem ngay — https://example.com/a' });
    expect(db.queryOne<any>("SELECT content, msg_type FROM messages WHERE msg_id='mid.template1' AND channel='facebook'")).toEqual({ content: 'Tiêu đề mẫu\n• Xem ngay — https://example.com/a', msg_type: 'text' });
    expect(unread(OWNER, SENDER)).toBe(before + 1);
    expect(threadUnread(ACC, SENDER)).toBe(threadBefore + 1);
    expect(fbMessageEmits()).toBe(1);
    expect(editEmits()).toHaveLength(1);
    expect(editEmits()[0][1]).toMatchObject({ messageId: 'mid.template1', threadId: SENDER, repair: true, newText: 'Tiêu đề mẫu\n• Xem ngay — https://example.com/a' });

    await service.handleIncomingMessage({ ...base, body: 'Tiêu đề mẫu\n• Xem ngay — https://example.com/a' });
    expect(editEmits()).toHaveLength(1);
    expect(fbMessageEmits()).toBe(1);
  });

  test('pageMessageOverEmptyStoredRowIsNotAnnouncedAsNew', async () => {
    db.saveFBMessage({ id: 'mid.pageEmpty', account_id: PAGE_ACC, thread_id: PAGE_SENDER, sender_id: PAGE_SENDER, body: undefined, timestamp: 4000, type: 'text', is_self: 0, is_unsent: 0 } as any);
    const before = unread(PAGE_FB, PAGE_SENDER);
    const n = { pageId: DELEGATE, messageId: 'mid.pageEmpty', senderId: PAGE_SENDER, body: 'Có chữ', title: 'Khach den Page', pageName: 'Page', senderAvatarUrl: '' };
    await make().handlePageMessageNotification(n);
    expect(db.queryOne<any>("SELECT content FROM messages WHERE msg_id='mid.pageEmpty' AND channel='facebook'")!.content).toBe('Có chữ');
    expect(fbMessageEmits()).toBe(0);
    expect(unread(PAGE_FB, PAGE_SENDER)).toBe(before);
  });
});
