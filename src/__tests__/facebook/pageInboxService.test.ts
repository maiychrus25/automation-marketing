import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-pageinbox-'));
const mockInboxes: any[] = [];

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
// Kết nối thật được kiểm ở facebookPageInbox.test.ts; ở đây chỉ kiểm cách FacebookService dùng nó.
jest.mock('../../services/facebook/FacebookPageInbox', () => {
  const { EventEmitter } = require('events');
  class FacebookPageInbox extends EventEmitter {
    alive = false;
    start = jest.fn().mockResolvedValue(undefined);
    stop = jest.fn();
    resync = jest.fn();
    sendText = jest.fn();
    markRead = jest.fn(() => true);
    fetchMessages = jest.fn();
    constructor(public deps: any) { super(); mockInboxes.push(this); }
    isAlive() { return this.alive; }
  }
  return { FacebookPageInbox };
});

// Trình duyệt Business Suite (đường gửi của Page ở bản này) được thay bằng một bản giả điều khiển được.
const mockBrowserSender = { send: jest.fn(), sendSticker: jest.fn() };
jest.mock('../../services/facebook/pagePlaywrightDriver', () => ({
  getPageBrowserSender: jest.fn(async () => mockBrowserSender),
  closePageBrowserSender: jest.fn(),
}));

import DatabaseService from '../../services/database/DatabaseService';
import EventBroadcaster from '../../services/event/EventBroadcaster';
import FacebookService from '../../services/facebook/FacebookService';

const PARENT_ACC = 'acc-parent-inbox';
const PARENT_FB = '100000000008724';
const PAGE_ACC = 'acc-page-inbox';
const PAGE_FB = '100000000004280';      // id hồ sơ (i_user) của Page
const DELEGATE = '1000000000003955';    // id Page cổ điển: Page gửi tin dưới id này
const PEER = '100000000005141';
const OTHER = '100000000006262';
const COOKIE = `c_user=${PARENT_FB}; xs=tok; i_user=${PAGE_FB}`;

describe('FacebookService with the direct Page inbox', () => {
  const db = DatabaseService.getInstance();
  let emit: jest.SpyInstance;
  const emitted = (name: string) => emit.mock.calls.filter(c => c[0] === name).map(c => c[1]);
  const pageService = (): any => {
    const s = new (FacebookService as any)(PAGE_ACC, COOKIE);
    s.checkAndFetchUserInfo = jest.fn().mockResolvedValue(undefined);
    s.downloadNonE2EEAttachments = jest.fn().mockResolvedValue(undefined);
    return s;
  };
  const parentService = (): any => {
    const s = new (FacebookService as any)(PARENT_ACC, `c_user=${PARENT_FB}; xs=tok`);
    s.checkAndFetchUserInfo = jest.fn().mockResolvedValue(undefined);
    return s;
  };
  const saved = (id: string) => db.queryOne<any>('SELECT type, body, is_self, attachments, thread_id FROM fb_messages WHERE id = ? AND account_id = ?', [id, PAGE_ACC]);
  const contact = (id: string) =>
    db.queryOne<any>("SELECT display_name, avatar_url, unread_count FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'", [PAGE_FB, id]);
  /** Chờ hàng đợi sự kiện và phần lưu bất đồng bộ chạy xong. */
  const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setImmediate(r)); };
  const message = (id: string, extra: any = {}) =>
    ({ id, threadId: PEER, senderId: PEER, text: 'xin chao', timestampMs: Date.now(), attachments: [], isHistory: false, isAdminMsg: false, isUnsent: false, ...extra });

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: PARENT_ACC, facebook_id: PARENT_FB, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBPageAccount({ id: PAGE_ACC, facebook_id: PAGE_FB, name: 'Page', avatar_url: '', parent_facebook_id: PARENT_FB, delegate_page_id: DELEGATE, proxy_id: null });
  });
  beforeEach(() => {
    mockInboxes.length = 0;
    mockBrowserSender.send.mockReset();
    emit = jest.spyOn(EventBroadcaster, 'emit').mockImplementation((() => {}) as any);
    // Mỗi test bắt đầu từ 0 chưa đọc, để số đếm tuyệt đối đúng với mọi thứ tự chạy (các test dùng chung một khách).
    db.run("UPDATE contacts SET unread_count = 0 WHERE channel = 'facebook'");
    db.run('UPDATE fb_threads SET unread_count = 0');
  });
  afterEach(() => {
    emit.mockRestore();
    delete process.env.MAIHUB_FB_PAGE_INBOX;
    (FacebookService as any).instances.clear();
    jest.useRealTimers();
  });
  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('aPageStartsItsInboxWithThePageIdAndItsOwnCookie', () => {
    const svc = pageService();
    svc.startPageInbox();
    expect(mockInboxes).toHaveLength(1);
    expect(mockInboxes[0].deps).toMatchObject({ accountId: PAGE_ACC, pageId: DELEGATE });
    expect(mockInboxes[0].deps.getCookie()).toBe(COOKIE);
    expect(mockInboxes[0].start).toHaveBeenCalledTimes(1);
    expect(svc.historyFetcher.deps.bridge()).toBe(mockInboxes[0]); // tin cũ của Page lấy qua chính kết nối này
    svc.httpsAgent = 'PROXY-2'; // đổi proxy sau khi đã nối: lần nối lại kế tiếp phải dùng proxy mới
    expect(mockInboxes[0].deps.getAgent()).toBe('PROXY-2');
  });

  test('aPersonalAccountNeverStartsOne', () => {
    const svc = parentService();
    svc.startPageInbox();
    expect(mockInboxes).toHaveLength(0);
    expect(svc.isPageInboxLive()).toBe(false);
  });

  test('theKillSwitchKeepsThePageOnTheOldFlowOnly', () => {
    process.env.MAIHUB_FB_PAGE_INBOX = '0';
    const svc = pageService();
    svc.startPageInbox();
    expect(mockInboxes).toHaveLength(0);
  });

  // connect() được gọi lại mỗi khi listener chính chập chờn (ensureConnected). Kết nối hộp thư đang chạy phải được giữ:
  // dựng lại sẽ mất con trỏ trong bộ nhớ và các tin đến trong lúc đó.
  test('startingAgainKeepsARunningInbox', () => {
    const svc = pageService();
    svc.startPageInbox();
    svc.startPageInbox();
    expect(mockInboxes).toHaveLength(1);
    expect(mockInboxes[0].stop).not.toHaveBeenCalled();
    expect(mockInboxes[0].start).toHaveBeenCalledTimes(1);
  });

  test('disconnectingStopsTheInboxAndItsLateEventsAreIgnored', async () => {
    const svc = pageService();
    svc.startPageInbox();
    await svc.stopE2EEBridge(); // disconnect() dừng mọi kết nối phụ qua đây
    expect(mockInboxes[0].stop).toHaveBeenCalled();
    expect(svc.isPageInboxLive()).toBe(false);
    mockInboxes[0].emit('event', { type: 'message', data: message('mid.$afterStop') });
    mockInboxes[0].emit('threads', [{ id: '100000000009595', name: 'Cũ', pictureUrl: '', snippet: '', lastActivityMs: 1, unreadCount: 0 }], []);
    await new Promise(r => setImmediate(r));
    expect(saved('mid.$afterStop')).toBeFalsy();
    expect(contact('100000000009595')).toBeFalsy();

    svc.startPageInbox(); // kết nối lại sau khi ngắt: dựng kết nối mới
    expect(mockInboxes).toHaveLength(2);
  });

  test('anExpiredCookieStopsTheInbox', () => {
    const svc = pageService();
    svc.startPageInbox();
    svc.setStatus('cookie_expired');
    expect(mockInboxes[0].stop).toHaveBeenCalled();
    expect(svc.isPageInboxLive()).toBe(false);
  });

  test('aPersonalAccountStillMarksBridgeMessagesAsGroupMessages', () => {
    const svc = parentService();
    const incoming = jest.spyOn(svc, 'handleIncomingMessage').mockResolvedValue(undefined);
    svc.handleBridgeEvent({ type: 'message', data: message('mid.$personal1') });
    expect(incoming).toHaveBeenCalledWith(expect.objectContaining({ messageID: 'mid.$personal1', type: 'group' }));
  });

  test('aLiveTextMessageIsSavedOnceUnderThePageAndShownAsAOneToOneChat', async () => {
    const svc = pageService();
    svc.startPageInbox();
    const evt = { type: 'message', data: message('mid.$text1') };
    mockInboxes[0].emit('event', evt);
    mockInboxes[0].emit('event', evt); // Facebook phát lại: không lưu, không báo lần hai
    await until(() => emitted('fb:onMessage').length > 0);
    await new Promise(r => setImmediate(r));
    expect(saved('mid.$text1')).toMatchObject({ type: 'text', body: 'xin chao', is_self: 0, thread_id: PEER });
    expect(emitted('fb:onMessage')).toHaveLength(1);
    expect(emitted('fb:onMessage')[0]).toMatchObject({ fbAccountId: PAGE_FB, message: { messageID: 'mid.$text1', type: 'user', replyToID: PEER } });
    expect(contact(PEER).unread_count).toBe(1);
  });

  test('anImageAndAStickerKeepTheirTypeAndUrlAndTheImageIsDownloaded', async () => {
    const svc = pageService();
    svc.startPageInbox();
    mockInboxes[0].emit('event', { type: 'message', data: message('mid.$img1', { text: '', attachments: [{ type: 'image', url: 'https://x.test/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }] }) });
    mockInboxes[0].emit('event', { type: 'message', data: message('mid.$stk1', { text: '', attachments: [{ type: 'sticker', url: 'https://x.test/s.png' }] }) });
    await until(() => emitted('fb:onMessage').length >= 2);
    expect(saved('mid.$img1').type).toBe('image');
    expect(JSON.parse(saved('mid.$img1').attachments)).toEqual([expect.objectContaining({ type: 'image', url: 'https://x.test/a.jpg', name: 'a.jpg' })]);
    expect(saved('mid.$stk1').type).toBe('sticker');
    expect(svc.downloadNonE2EEAttachments).toHaveBeenCalledWith(expect.objectContaining({ messageID: 'mid.$img1' }), PEER);
  });

  // Page gửi tin dưới id Page cổ điển (delegate_page_id), không phải id hồ sơ: vẫn phải là tin của mình.
  test('aMessageSentByThePageElsewhereIsItsOwn', async () => {
    const svc = pageService();
    svc.startPageInbox();
    mockInboxes[0].emit('event', { type: 'message', data: message('mid.$own1', { senderId: DELEGATE, text: 'tra loi' }) });
    await until(() => !!saved('mid.$own1'));
    expect(saved('mid.$own1').is_self).toBe(1);
  });

  test('oldMessagesOfThePageInHistoryAreItsOwnToo', () => {
    const svc = pageService();
    const old = Date.now() - 3_600_000;
    svc.historyFetcher.persistBridgeMessages([
      message('mid.$hist-own', { senderId: DELEGATE, timestampMs: old, isHistory: true }),
      message('mid.$hist-peer', { timestampMs: old + 1, isHistory: true }),
    ], undefined, PEER);
    expect(saved('mid.$hist-own').is_self).toBe(1);
    expect(saved('mid.$hist-peer').is_self).toBe(0);
  });

  test('threadsFromTheInboxAreSavedWithTheContactNameAndPicture', () => {
    const svc = pageService();
    svc.startPageInbox();
    mockInboxes[0].emit('threads',
      [{ id: OTHER, name: '', pictureUrl: '', snippet: 'tin cuoi', lastActivityMs: 1_700_000_000_000, unreadCount: 2 }],
      [{ id: OTHER, name: 'Khách B', pictureUrl: 'https://x.test/b.jpg' }, { id: DELEGATE, name: 'Page', pictureUrl: '' }]);
    expect(db.queryOne<any>('SELECT name, last_message_preview, unread_count FROM fb_threads WHERE id = ? AND account_id = ?', [OTHER, PAGE_ACC]))
      .toMatchObject({ name: 'Khách B', last_message_preview: 'tin cuoi', unread_count: 2 });
    expect(contact(OTHER)).toMatchObject({ display_name: 'Khách B', avatar_url: 'https://x.test/b.jpg' });
    expect(contact(DELEGATE)).toBeFalsy(); // chính Page không thành một hội thoại
    expect(emitted('fb:onContactUpdate')).toEqual([{ fbAccountId: PAGE_FB, contactId: OTHER, name: 'Khách B', avatarUrl: 'https://x.test/b.jpg' }]);
  });

  // Bản cập nhật hội thoại về sau thường không kèm tên và người liên hệ: không được xoá tên và tin cuối đã có.
  test('aLaterThreadUpdateWithoutNameOrSnippetKeepsWhatIsStored', () => {
    const svc = pageService();
    svc.startPageInbox();
    const id = '100000000006363';
    mockInboxes[0].emit('threads', [{ id, name: '', pictureUrl: '', snippet: 'tin dau', lastActivityMs: 1_700_000_000_000, unreadCount: 1 }], [{ id, name: 'Khách D', pictureUrl: '' }]);
    mockInboxes[0].emit('threads', [{ id, name: '', pictureUrl: '', snippet: '', lastActivityMs: 1_700_000_005_000, unreadCount: 0 }], []);
    expect(db.queryOne<any>('SELECT name, last_message_preview, last_message_at FROM fb_threads WHERE id = ? AND account_id = ?', [id, PAGE_ACC]))
      .toEqual({ name: 'Khách D', last_message_preview: 'tin dau', last_message_at: 1_700_000_005_000 });
    mockInboxes[0].emit('threads', [{ id, name: '', pictureUrl: '', snippet: '', lastActivityMs: 0, unreadCount: 0 }], []);
    expect(db.queryOne<any>('SELECT last_message_at FROM fb_threads WHERE id = ? AND account_id = ?', [id, PAGE_ACC]).last_message_at).toBe(1_700_000_005_000);
    expect(contact(id).display_name).toBe('Khách D');
  });

  // Đợt 2: Page gửi tin chữ thẳng qua kết nối hộp thư, không cần trình duyệt Business Suite (máy chưa cài lõi trình duyệt thì
  // trước đây mọi tin gửi từ Page đều không đi được).
  describe('sending text from a Page', () => {
    const sender = () => {
      const svc = pageService();
      svc.ensureConnected = jest.fn().mockResolvedValue(true);
      svc.startPageInbox();
      mockInboxes[0].alive = true;
      return { svc, inbox: mockInboxes[0] };
    };

    test('goesThroughTheLiveInboxAndReturnsTheRealMessageId', async () => {
      const { svc, inbox } = sender();
      inbox.sendText.mockResolvedValue({ messageId: 'mid.$direct1' });
      const res = await svc.sendMessage(PEER, 'tra loi', { typeChat: 'user', replyToMessageId: 'mid.$orig' });
      expect(res).toMatchObject({ success: true, messageId: 'mid.$direct1' });
      expect(inbox.sendText).toHaveBeenCalledWith({ threadId: PEER, text: 'tra loi', replyToMessageId: 'mid.$orig' });
      expect(mockBrowserSender.send).not.toHaveBeenCalled();

      // Tin dội về sau khi đã gửi xong: đường gửi đã lưu và hiển thị tin này, không lưu / phát lần hai.
      inbox.emit('event', { type: 'message', data: message('mid.$direct1', { senderId: DELEGATE, text: 'tra loi' }) });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      expect(saved('mid.$direct1')).toBeFalsy();
      expect(emitted('fb:onMessage')).toHaveLength(0);
    });

    // Thứ tự thật trong bản ghi Business Suite: tin dội về TRƯỚC khi có xác nhận gửi.
    test('anEchoThatArrivesBeforeTheConfirmationIsNotSavedTwice', async () => {
      const { svc, inbox } = sender();
      let confirm: (r: any) => void = () => {};
      inbox.sendText.mockReturnValue(new Promise(r => { confirm = r; }));
      const sending = svc.sendMessage(PEER, 'gui nhanh', { typeChat: 'user' });
      await new Promise(r => setImmediate(r));
      inbox.emit('event', { type: 'message', data: message('mid.$direct2', { senderId: DELEGATE, text: 'gui nhanh' }) });
      inbox.emit('event', { type: 'message', data: message('mid.$elsewhere', { senderId: DELEGATE, text: 'go tu may khac' }) });
      await new Promise(r => setImmediate(r));
      confirm({ messageId: 'mid.$direct2' });
      await expect(sending).resolves.toMatchObject({ success: true, messageId: 'mid.$direct2' });
      await until(() => !!saved('mid.$elsewhere'));
      expect(saved('mid.$direct2')).toBeFalsy();
      expect(emitted('fb:onMessage').map(e => e.message.messageID)).toEqual(['mid.$elsewhere']);
    });

    // Không biết tin đã tới chưa: báo lỗi, KHÔNG gửi lại qua trình duyệt (có thể thành hai tin).
    test('anUnconfirmedSendIsAnErrorAndIsNotRetriedThroughTheBrowser', async () => {
      const { svc, inbox } = sender();
      inbox.sendText.mockRejectedValue(new Error('Facebook không xác nhận tin đã gửi'));
      const res = await svc.sendMessage(PEER, 'x', { typeChat: 'user' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Facebook không xác nhận tin đã gửi');
      expect(mockBrowserSender.send).not.toHaveBeenCalled();
    });

    test('fallsBackToTheBrowserWhenTheInboxIsNotLive', async () => {
      const { svc, inbox } = sender();
      inbox.alive = false;
      mockBrowserSender.send.mockResolvedValue({ success: true, messageId: 'page:1' });
      await expect(svc.sendMessage(PEER, 'x', { typeChat: 'user' })).resolves.toEqual({ success: true, messageId: 'page:1' });
      expect(inbox.sendText).not.toHaveBeenCalled();
    });

    test('openingAThreadMarksItReadThroughTheInboxOncePerNewMessage', async () => {
      const { svc, inbox } = sender();
      db.saveFBMessage({ id: 'mid.$toRead1', account_id: PAGE_ACC, thread_id: OTHER, sender_id: OTHER, body: 'a', timestamp: 1_700_000_100_000, type: 'text', is_self: 0, is_unsent: 0 } as any);
      await svc.markReadOnServer(OTHER);
      await svc.markReadOnServer(OTHER); // mốc không đổi: không gửi lại
      expect(inbox.markRead.mock.calls).toEqual([[OTHER, 1_700_000_100_000]]);
      inbox.alive = false;
      db.saveFBMessage({ id: 'mid.$toRead2', account_id: PAGE_ACC, thread_id: OTHER, sender_id: OTHER, body: 'b', timestamp: 1_700_000_200_000, type: 'text', is_self: 0, is_unsent: 0 } as any);
      await svc.markReadOnServer(OTHER); // hộp thư không sống: không làm gì, lần sau thử lại
      expect(inbox.markRead).toHaveBeenCalledTimes(1);
    });
  });

  // Tin Page gửi từ MaiHub qua trình duyệt được lưu với mã tạm `page:<ms>`; hộp thư dội lại chính tin đó với mã thật.
  describe('the echo of a message the Page sent from MaiHub', () => {
    const sentLocally = (id: string, body: string | null, at: number, type = 'text') =>
      db.saveFBMessage({ id, account_id: PAGE_ACC, thread_id: PEER, sender_id: PAGE_FB, body, timestamp: at, type, is_self: 1, is_unsent: 0 } as any);
    const rowsWith = (body: string) => db.query<any>('SELECT id FROM fb_messages WHERE account_id = ? AND thread_id = ? AND body = ?', [PAGE_ACC, PEER, body]).map(r => r.id);

    test('takesOverTheTemporaryRowInsteadOfAddingASecondOne', async () => {
      const now = Date.now();
      sentLocally('page:fixture-echo', 'tra loi khach', now);
      const svc = pageService();
      svc.startPageInbox();
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$echo1', { senderId: DELEGATE, text: 'tra loi khach', timestampMs: now - 3_000 }) });
      await until(() => rowsWith('tra loi khach').includes('mid.$echo1'));
      expect(rowsWith('tra loi khach')).toEqual(['mid.$echo1']);
      expect(db.hasMessage(PAGE_FB, 'mid.$echo1')).toBe(true);
      expect(db.hasMessage(PAGE_FB, 'page:fixture-echo')).toBe(false);
      expect(emitted('fb:onMessage')).toHaveLength(0);
    });

    test('doesNotSwallowADifferentMessageOrAnOldTemporaryRow', async () => {
      const now = Date.now();
      sentLocally('page:fixture-a', 'cau tra loi A', now);
      sentLocally('page:fixture-old', 'cau tra loi cu', now - 600_000);
      const svc = pageService();
      svc.startPageInbox();
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$other1', { senderId: DELEGATE, text: 'cau tra loi B', timestampMs: now }) }); // gõ từ máy khác
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$other2', { senderId: DELEGATE, text: 'cau tra loi cu', timestampMs: now }) }); // trùng chữ nhưng cách 10 phút
      await until(() => !!saved('mid.$other1') && !!saved('mid.$other2'));
      expect(rowsWith('cau tra loi A')).toEqual(['page:fixture-a']);
      expect(rowsWith('cau tra loi cu').sort()).toEqual(['mid.$other2', 'page:fixture-old'].sort());
    });

    // Thứ tự thường gặp: tin dội về trong lúc trình duyệt còn đang chờ xác nhận gửi, tức là trước khi có dòng mã tạm.
    test('thatArrivesWhileTheBrowserIsStillSendingGivesTheSendItsRealId', async () => {
      let finish: (r: any) => void = () => {};
      mockBrowserSender.send.mockReturnValueOnce(new Promise(r => { finish = r; }));
      const svc = pageService();
      svc.startPageInbox();
      const sending = svc.sendViaPageBrowser(PEER, { text: 'dang gui' });
      await new Promise(r => setImmediate(r));
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$real1', { senderId: DELEGATE, text: 'dang gui' }) });
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$other9', { senderId: DELEGATE, text: 'go tu may khac' }) });
      await new Promise(r => setImmediate(r));
      expect(saved('mid.$real1')).toBeFalsy(); // chưa lưu: chờ lượt gửi nhận
      finish({ success: true, messageId: `page:${Date.now()}` });
      await expect(sending).resolves.toEqual({ success: true, messageId: 'mid.$real1' }); // đường gửi sẽ lưu với mã thật
      await until(() => !!saved('mid.$other9')); // tin gõ từ máy khác trong lúc đó không bị nuốt
      expect(saved('mid.$other9')).toMatchObject({ body: 'go tu may khac', is_self: 1 });
      expect(saved('mid.$real1')).toBeFalsy();
      expect(emitted('fb:onMessage').map(e => e.message.messageID)).toEqual(['mid.$other9']);
    });

    test('ofASendThatTheBrowserReportsAsFailedIsStillSaved', async () => {
      let finish: (r: any) => void = () => {};
      mockBrowserSender.send.mockReturnValueOnce(new Promise(r => { finish = r; }));
      const svc = pageService();
      svc.startPageInbox();
      const sending = svc.sendViaPageBrowser(PEER, { text: 'gui nhung bao loi' });
      await new Promise(r => setImmediate(r));
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$real2', { senderId: DELEGATE, text: 'gui nhung bao loi' }) });
      finish({ success: false, error: 'không xác nhận được' });
      await expect(sending).resolves.toEqual({ success: false, error: 'không xác nhận được' });
      await until(() => !!saved('mid.$real2'));
      expect(saved('mid.$real2')).toMatchObject({ body: 'gui nhung bao loi', is_self: 1 });
    });

    test('aCustomerMessageDuringASendIsNotHeld', async () => {
      let finish: (r: any) => void = () => {};
      mockBrowserSender.send.mockReturnValueOnce(new Promise(r => { finish = r; }));
      const svc = pageService();
      svc.startPageInbox();
      const sending = svc.sendViaPageBrowser(PEER, { text: 'xin chao' });
      await new Promise(r => setImmediate(r));
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$peerDuring', { text: 'xin chao' }) });
      await until(() => !!saved('mid.$peerDuring'));
      expect(saved('mid.$peerDuring').is_self).toBe(0);
      finish({ success: true, messageId: 'page:1' });
      await expect(sending).resolves.toEqual({ success: true, messageId: 'page:1' });
    });

    test('aCustomerMessageWithTheSameTextIsNeverTakenForAnEcho', async () => {
      const now = Date.now();
      sentLocally('page:fixture-ok', 'ok', now);
      const svc = pageService();
      svc.startPageInbox();
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$peerOk', { text: 'ok', timestampMs: now }) });
      await until(() => !!saved('mid.$peerOk'));
      expect(rowsWith('ok').sort()).toEqual(['mid.$peerOk', 'page:fixture-ok'].sort());
    });
  });

  test('aContactWithoutAThreadOnlyFillsAnExistingRow', () => {
    const svc = pageService();
    svc.startPageInbox();
    db.run("INSERT INTO contacts (owner_zalo_id, contact_id, display_name, channel, unread_count) VALUES (?, '100000000007373', '', 'facebook', 0)", [PAGE_FB]);
    mockInboxes[0].emit('threads', [], [{ id: '100000000007373', name: 'Khách C', pictureUrl: '' }, { id: '100000000008484', name: 'Người lạ', pictureUrl: '' }]);
    expect(contact('100000000007373').display_name).toBe('Khách C');
    expect(contact('100000000008484')).toBeFalsy();
  });

  describe('the notification that arrives through the parent account', () => {
    const notification = (messageId: string, body: string) =>
      ({ pageId: DELEGATE, messageId, senderId: PEER, body, title: 'Khách A đến Page', pageName: 'Page', senderAvatarUrl: 'https://x.test/peer.jpg' });

    // Thông báo chỉ có chữ ("đã gửi một ảnh"). Lưu nó ngay sẽ chiếm mã tin và làm mất ảnh của tin thật, nên khi hộp thư Page
    // đang sống thì chờ một nhịp cho tin thật về.
    test('isSkippedWhenThePageInboxDeliversTheMessage', async () => {
      jest.useFakeTimers();
      const page = pageService();
      page.startPageInbox();
      mockInboxes[0].alive = true;
      (FacebookService as any).instances.set(PAGE_ACC, page);
      const handled = parentService().handlePageMessageNotification(notification('mid.$dup1', 'Khách A đã gửi một ảnh.'));
      await jest.advanceTimersByTimeAsync(2_000);
      expect(saved('mid.$dup1')).toBeFalsy(); // chưa lưu gì trong lúc chờ
      db.saveFBMessage({ id: 'mid.$dup1', account_id: PAGE_ACC, thread_id: PEER, sender_id: PEER, body: null, timestamp: Date.now(), type: 'image', is_self: 0, is_unsent: 0 } as any);
      await jest.advanceTimersByTimeAsync(10_000);
      await handled;
      expect(saved('mid.$dup1')).toMatchObject({ type: 'image' });
      expect(emitted('fb:onMessage')).toHaveLength(0);
      expect(mockInboxes[0].resync).not.toHaveBeenCalled();
    });

    // Tin thật đã về qua hộp thư nhưng chưa kịp lưu (khách mới: phải tải tên trước, mạng chậm): thông báo không được chen vào
    // lưu bản chỉ có chữ, và không được coi kết nối là hỏng.
    test('isSkippedWhenTheInboxDeliveredTheMessageButSavingIsStillInProgress', async () => {
      jest.useFakeTimers();
      const page = pageService();
      page.checkAndFetchUserInfo = jest.fn(() => new Promise(() => {})); // tải tên người gửi treo
      page.startPageInbox();
      mockInboxes[0].alive = true;
      (FacebookService as any).instances.set(PAGE_ACC, page);
      mockInboxes[0].emit('event', { type: 'message', data: message('mid.$slow1', { senderId: '100000000001212', threadId: '100000000001212', attachments: [{ type: 'image', url: 'https://x.test/a.jpg' }], text: '' }) });
      const n = { ...notification('mid.$slow1', 'Khách đã gửi một ảnh.'), senderId: '100000000001212' };
      const handled = parentService().handlePageMessageNotification(n);
      await jest.advanceTimersByTimeAsync(10_000);
      await handled;
      expect(saved('mid.$slow1')).toBeFalsy();
      expect(mockInboxes[0].resync).not.toHaveBeenCalled();
    });

    // Kết nối báo còn sống nhưng tin không về (con trỏ hỏng, Facebook ngừng đẩy): không được mất tin của khách.
    test('isSavedAndTheInboxIsResyncedWhenTheLiveInboxMissedTheMessage', async () => {
      jest.useFakeTimers();
      const page = pageService();
      page.startPageInbox();
      mockInboxes[0].alive = true;
      (FacebookService as any).instances.set(PAGE_ACC, page);
      const handled = parentService().handlePageMessageNotification(notification('mid.$missed1', 'tin bi sot'));
      await jest.advanceTimersByTimeAsync(10_000);
      await handled;
      expect(saved('mid.$missed1')).toMatchObject({ type: 'text', body: 'tin bi sot' });
      expect(emitted('fb:onMessage')).toHaveLength(1);
      expect(mockInboxes[0].resync).toHaveBeenCalledTimes(1);
    });

    test('stillSavesTheTextWhenThePageInboxIsDownOrAbsent', async () => {
      const page = pageService();
      page.startPageInbox();
      (FacebookService as any).instances.set(PAGE_ACC, page); // có kết nối nhưng chưa sống
      await parentService().handlePageMessageNotification(notification('mid.$fallback1', 'tin chu'));
      expect(saved('mid.$fallback1')).toMatchObject({ type: 'text', body: 'tin chu' });

      (FacebookService as any).instances.clear(); // Page không có service (ví dụ tắt bằng cờ)
      await parentService().handlePageMessageNotification(notification('mid.$fallback2', 'tin chu 2'));
      expect(saved('mid.$fallback2')).toMatchObject({ type: 'text', body: 'tin chu 2' });
      expect(emitted('fb:onMessage')).toHaveLength(2);
    });
  });
});
