jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import Logger from '../../utils/Logger';
import { FacebookPageInbox } from '../../services/facebook/FacebookPageInbox';
import {
  COOKIE, DEVICE, FakeMqtt, INBOX_HTML, LOGIN_HEADER, PAGE, PAGE_VERSION, PEER, historyEndCall, i64, lsResp, messageCall, rangeCall, syncBlock, wireCall,
} from './pageInboxFixtures';

const logged = () => [...(Logger.log as jest.Mock).mock.calls, ...(Logger.warn as jest.Mock).mock.calls].map(c => String(c[0])).join('\n');

/** Một hộp thư với các máy khách MQTT giả: mỗi lần nối tạo một máy khách mới trong `clients`. */
function setup(html: string | (() => Promise<{ status: number; html: string }>) = INBOX_HTML) {
  const clients: FakeMqtt[] = [];
  const connect = jest.fn(() => { const c = new FakeMqtt(); clients.push(c); return c; });
  const fetchPage = jest.fn(typeof html === 'function' ? html : async () => ({ status: 200, html }));
  const inbox = new FacebookPageInbox({ accountId: 'acc-page-1', pageId: PAGE, getCookie: () => COOKIE, getAgent: () => 'AGENT', connect, fetchPage });
  const events: any[] = [];
  const statuses: string[] = [];
  const threads: any[] = [];
  inbox.on('event', e => events.push(e));
  inbox.on('status', s => statuses.push(s));
  inbox.on('threads', (t, c) => threads.push({ threads: t, contacts: c }));
  return { inbox, clients, connect, fetchPage, events, statuses, threads };
}

/** Nối và nhận trả lời đồng bộ đầu tiên. */
async function connected(html?: Parameters<typeof setup>[0]) {
  const s = setup(html);
  await s.inbox.start();
  s.clients[0].emit('connect');
  s.clients[0].receive(lsResp([syncBlock(205, 'CUR2')], 1));
  return { ...s, client: s.clients[0] };
}

describe('FacebookPageInbox', () => {
  beforeEach(() => { jest.useFakeTimers(); (Logger.log as jest.Mock).mockClear(); (Logger.warn as jest.Mock).mockClear(); });
  afterEach(() => { jest.useRealTimers(); });

  test('connectsWithThePageDeviceThenSyncsAndListsThreads', async () => {
    const { inbox, clients, connect, fetchPage, statuses } = setup();
    await inbox.start();
    expect(fetchPage).toHaveBeenCalledWith(PAGE, LOGIN_HEADER, 'AGENT');
    const [url, username, cookieHeader, agent] = connect.mock.calls[0] as any[];
    expect(url).toMatch(new RegExp(`^wss://edge-chat\\.facebook\\.com/chat\\?region=eag&sid=\\d+&cid=${DEVICE}$`));
    expect(username).toMatchObject({ p: PAGE, d: DEVICE });
    expect(cookieHeader).toBe(LOGIN_HEADER);
    expect(agent).toBe('AGENT');

    const client = clients[0];
    client.emit('connect');
    expect(client.publish).toHaveBeenCalledWith('/ls_app_settings', `{"ls_fdid":"","ls_sv":"${PAGE_VERSION}"}`, { qos: 1 });
    expect(client.subscribe).toHaveBeenCalledWith(['/ls_foreground_state', '/ls_resp'], { qos: 0 });
    expect(client.labels()).toEqual(['sync2', '313']);
    expect(client.requests()[0].payload).toContain('"last_applied_cursor":"PAGECUR"');
    expect(inbox.isAlive()).toBe(false); // chưa có trả lời đồng bộ thì chưa coi là sống

    client.receive(lsResp([syncBlock(205, 'CUR2')], 1));
    client.receive(lsResp([syncBlock(205, 'CUR3')]));
    expect(inbox.isAlive()).toBe(true);
    expect(statuses).toEqual(['connected']);
    expect(logged()).not.toMatch(/PAGECUR|CUR2|tok|11111111-2222/); // không lộ con trỏ, cookie, mã thiết bị
  });

  test('liveAndReplayedMessagesBecomeBridgeShapedEvents', async () => {
    const { client, events } = await connected();
    client.receive(lsResp([syncBlock(205, 'CUR3'), messageCall('insertMessage', 'SECRET TEXT', 'mid.$live')]));
    client.receive(lsResp([messageCall('upsertMessage', 'older', 'mid.$old')]));
    expect(events).toEqual([
      { type: 'message', data: expect.objectContaining({ id: 'mid.$live', threadId: PEER, senderId: PEER, text: 'SECRET TEXT', timestampMs: 1700000000000, isHistory: false, attachments: [] }) },
      { type: 'message', data: expect.objectContaining({ id: 'mid.$old', isHistory: true }) },
    ]);
    expect(logged()).not.toContain('SECRET');
  });

  test('threadsAndContactsAreHandedOverTogether', async () => {
    const { client, threads } = await connected();
    client.receive(lsResp([
      wireCall('deleteThenInsertThread', { 0: i64(1700000000000), 2: 'snippet', 7: i64(PEER), 89: i64(2) }),
      wireCall('verifyContactRowExists', { 0: i64(PEER), 2: 'https://x.test/a.jpg', 3: 'Khách A' }),
    ]));
    expect(threads).toEqual([{
      threads: [{ id: PEER, name: '', pictureUrl: '', snippet: 'snippet', lastActivityMs: 1700000000000, unreadCount: 2 }],
      contacts: [{ id: PEER, name: 'Khách A', pictureUrl: 'https://x.test/a.jpg' }],
    }]);
  });

  test('reactionsSeenAndTypingOfTheCustomerBecomeEventsButThePagesOwnDoNot', async () => {
    const { client, events } = await connected();
    client.receive(lsResp([
      wireCall('upsertReaction', { 0: i64(PEER), 1: i64(1700000000000), 2: 'mid.$a', 3: i64(PEER), 4: '❤' }),
      wireCall('deleteReaction', { 0: i64(PEER), 1: 'mid.$a', 2: i64(PEER) }),
      wireCall('updateReadReceipt', { 0: i64(1700000000001), 1: i64(PEER), 2: i64(PEER) }),
      wireCall('updateReadReceipt', { 0: i64(1700000000002), 1: i64(PEER), 2: i64(PAGE) }),
      wireCall('updateTypingIndicator', { 0: i64(PEER), 1: i64(PEER), 2: true }),
      wireCall('updateTypingIndicator', { 0: i64(PEER), 1: i64(PAGE), 2: true }),
    ]));
    expect(events).toEqual([
      { type: 'reaction', data: { messageId: 'mid.$a', threadId: PEER, userId: PEER, emoji: '❤' } },
      { type: 'reaction', data: { messageId: 'mid.$a', threadId: PEER, userId: PEER, emoji: '' } },
      { type: 'seen', data: { threadId: PEER, userId: PEER, timestampMs: 1700000000001 } },
      { type: 'typing', data: { threadId: PEER, userId: PEER, isTyping: true } },
    ]);
  });

  test('fetchMessagesReturnsOnePageAndKeepsItOutOfTheLiveEvents', async () => {
    const { inbox, client, events } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    expect(client.labels()).toEqual(['sync2', '313', '228']);
    expect(client.taskPayload(2)).toEqual({ thread_key: Number(PEER), direction: 0, reference_timestamp_ms: 1700000000000, reference_message_id: 'mid.$anchor', sync_group: 205, cursor: 'CUR2' });

    client.receive(lsResp([wireCall('taskExists', { 0: i64(1) })], 3)); // xác nhận tác vụ: chưa phải dữ liệu
    client.receive(lsResp([
      syncBlock(205, 'CUR3'),
      messageCall('upsertMessage', 'one', 'mid.$1', { 5: i64(1699999990000) }), messageCall('upsertMessage', 'two', 'mid.$2', { 5: i64(1699999995000) }),
      messageCall('upsertMessage', 'other thread', 'mid.$x', { 3: i64('100000000009999'), 5: i64(1699999990000) }),
      messageCall('insertMessage', 'new in the same thread', 'mid.$new', { 5: i64(1700000005000) }),
      rangeCall(PEER, 'mid.$1', 1699999990000, true),
    ]));
    await expect(page).resolves.toEqual({
      threadId: PEER, hasMoreBefore: true, minTimestampMs: 1699999990000, minMessageId: 'mid.$1',
      messages: [expect.objectContaining({ id: 'mid.$1' }), expect.objectContaining({ id: 'mid.$2' })],
    });
    // Tin của hội thoại khác, và tin mới hơn mốc của chính hội thoại đó, vẫn đi đường thường.
    expect(events.map(e => e.data.id)).toEqual(['mid.$x', 'mid.$new']);
  });

  test('theEndOfHistoryResolvesAnEmptyPage', async () => {
    const { inbox, client } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    client.receive(lsResp([historyEndCall(PEER, 1699000000000)])); // dấu hết tin của một yêu cầu khác: chưa phải trả lời
    client.receive(lsResp([historyEndCall(PEER, 1700000000000)]));
    await expect(page).resolves.toEqual({ threadId: PEER, messages: [], hasMoreBefore: false, minTimestampMs: 0 });
  });

  // Danh sách hội thoại cũng mang một khoảng tin (tin cuối của hội thoại): không được nhầm thành trả lời của yêu cầu tin cũ.
  test('aRangeThatIsNotOlderThanTheAnchorDoesNotAnswerTheHistoryRequest', async () => {
    const { inbox, client, events } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    client.receive(lsResp([messageCall('upsertMessage', 'last message', 'mid.$anchor'), rangeCall(PEER, 'mid.$anchor', 1700000000000, true)]));
    expect(events.map(e => e.data.id)).toEqual(['mid.$anchor']);
    client.receive(lsResp([messageCall('upsertMessage', 'older', 'mid.$older', { 5: i64(1699999000000) }), rangeCall(PEER, 'mid.$older', 1699999000000, false)]));
    await expect(page).resolves.toMatchObject({ messages: [expect.objectContaining({ id: 'mid.$older' })], hasMoreBefore: false, minMessageId: 'mid.$older' });
  });

  test('olderMessagesThatArriveBeforeTheirRangeAreKeptForThePage', async () => {
    const { inbox, client, events } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    client.receive(lsResp([messageCall('upsertMessage', 'older 1', 'mid.$o1', { 5: i64(1699999000000) })]));
    client.receive(lsResp([messageCall('upsertMessage', 'older 1 again', 'mid.$o1', { 5: i64(1699999000000) }), messageCall('upsertMessage', 'older 2', 'mid.$o2', { 5: i64(1699998000000) }),
      rangeCall(PEER, 'mid.$o2', 1699998000000, true)]));
    await expect(page).resolves.toMatchObject({ messages: [expect.objectContaining({ id: 'mid.$o1' }), expect.objectContaining({ id: 'mid.$o2' })], hasMoreBefore: true });
    expect(events).toEqual([]);
  });

  test('messagesHeldForARequestThatTimesOutAreStillHandedOver', async () => {
    const { inbox, client, events } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    const failed = expect(page).rejects.toThrow('Facebook không trả lời');
    client.receive(lsResp([messageCall('upsertMessage', 'older', 'mid.$held', { 5: i64(1699999000000) })]));
    expect(events).toEqual([]);
    await jest.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(events.map(e => e.data.id)).toEqual(['mid.$held']);
  });

  // Tin đã thu hồi không có nội dung: báo thu hồi cho tin đã lưu, không tạo bong bóng trống.
  test('unsentMessagesBecomeUnsendEventsAndStayOutOfHistoryPages', async () => {
    const { inbox, client, events } = await connected();
    client.receive(lsResp([messageCall('upsertMessage', '', 'mid.$gone', { 17: true })]));
    expect(events).toEqual([{ type: 'unsend', data: { messageId: 'mid.$gone', threadId: PEER } }]);
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1700000000000, beforeMessageId: 'mid.$anchor' });
    client.receive(lsResp([
      messageCall('upsertMessage', '', 'mid.$gone2', { 5: i64(1699999000000), 17: true }), messageCall('upsertMessage', 'kept', 'mid.$kept', { 5: i64(1699998000000) }),
      rangeCall(PEER, 'mid.$kept', 1699998000000, false),
    ]));
    await expect(page).resolves.toMatchObject({ messages: [expect.objectContaining({ id: 'mid.$kept' })] });
    expect(events[1]).toEqual({ type: 'unsend', data: { messageId: 'mid.$gone2', threadId: PEER } });
  });

  test('aSecondRequestForTheSameThreadIsRefusedWhileTheFirstIsPending', async () => {
    const { inbox, client } = await connected();
    const first = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' });
    await expect(inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' })).rejects.toThrow(/history request already running/);
    expect(client.labels().filter(l => l === '228')).toHaveLength(1);
    client.receive(lsResp([historyEndCall(PEER)]));
    await first;
  });

  test('aHistoryRequestWithoutAnAnswerFailsAfterThirtySecondsAndFreesTheThread', async () => {
    const { inbox, client } = await connected();
    const page = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' });
    const failed = expect(page).rejects.toThrow('Facebook không trả lời');
    await jest.advanceTimersByTimeAsync(30_000);
    await failed;
    const again = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' });
    client.receive(lsResp([historyEndCall(PEER)]));
    await expect(again).resolves.toMatchObject({ threadId: PEER });
  });

  test('historyNeedsALiveConnectionAndAnAnchor', async () => {
    const { inbox } = setup();
    await expect(inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' })).rejects.toThrow('chưa kết nối');
    const live = await connected();
    await expect(live.inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 0, beforeMessageId: '' })).rejects.toThrow('mốc');
    await expect(live.inbox.fetchMessages({ threadId: 'abc', beforeTimestampMs: 1, beforeMessageId: 'mid.$a' })).rejects.toThrow('mốc');
  });

  test('aDroppedConnectionReconnectsFromTheLatestCursorWithoutReloadingThePage', async () => {
    const { inbox, clients, client, fetchPage, statuses } = await connected();
    client.receive(lsResp([syncBlock(205, 'CUR9')]));
    const pending = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' });
    const dropped = expect(pending).rejects.toThrow('Mất kết nối');
    client.emit('close');
    await dropped;
    expect(inbox.isAlive()).toBe(false);
    expect(statuses).toEqual(['connected', 'disconnected']);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    clients[1].emit('connect');
    expect(clients[1].labels()).toEqual(['sync2']); // không xin lại danh sách hội thoại: Facebook phát lại phần bị lỡ từ con trỏ
    expect(clients[1].requests()[0].payload).toContain('"last_applied_cursor":"CUR9"');
    clients[1].receive(lsResp([syncBlock(205, 'CUR10')], 1));
    expect(statuses).toEqual(['connected', 'disconnected', 'connected']);

    client.receive(lsResp([messageCall('insertMessage', 'late', 'mid.$late')])); // máy khách cũ không còn được nghe
    expect(inbox.isAlive()).toBe(true);
  });

  test('eventsOfAReplacedClientAreIgnored', async () => {
    const { clients, client, events } = await connected();
    client.emit('close');
    await jest.advanceTimersByTimeAsync(10_000);
    clients[1].emit('connect');
    client.receive(lsResp([messageCall('insertMessage', 'late', 'mid.$late')]));
    client.emit('close');
    expect(events).toEqual([]);
    expect(clients).toHaveLength(2);
  });

  test('threeFailedConnectionsInARowReloadTheInboxPage', async () => {
    const { inbox, clients, fetchPage } = setup();
    await inbox.start();
    clients[0].emit('close'); // hỏng lần 1 (chưa từng đồng bộ)
    await jest.advanceTimersByTimeAsync(10_000);
    clients[1].emit('close'); // lần 2
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    clients[2].emit('close'); // lần 3
    await jest.advanceTimersByTimeAsync(40_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(4);
    clients[3].emit('connect');
    expect(clients[3].labels()).toEqual(['sync2', '313']); // trang mới: xin lại danh sách hội thoại
  });

  test('aSyncThatIsNeverAnsweredDropsTheConnectionAndReloadsThePage', async () => {
    const { inbox, clients, fetchPage } = setup();
    await inbox.start();
    clients[0].emit('connect');
    clients[0].receive(lsResp([wireCall('updateTypingIndicator', { 0: i64(PEER), 1: i64(PEER), 2: true })])); // sự kiện khác không tính là trả lời đồng bộ
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clients[0].end).toHaveBeenCalledWith(true);
    expect(inbox.isAlive()).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(2);
  });

  test('aPageWithoutCursorOrDeviceIsRetriedLaterWithoutConnecting', async () => {
    let html = '<html>login</html>';
    const { inbox, connect, fetchPage } = setup(async () => ({ status: 200, html }));
    await inbox.start();
    expect(connect).not.toHaveBeenCalled();
    html = INBOX_HTML;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('aFailedPageLoadIsRetriedAndNeverThrows', async () => {
    const { inbox, connect, fetchPage } = setup(jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ status: 200, html: INBOX_HTML }));
    await expect(inbox.start()).resolves.toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test('stopEndsTheConnectionRejectsPendingHistoryAndNeverReconnects', async () => {
    const { inbox, clients, client, statuses } = await connected();
    const pending = inbox.fetchMessages({ threadId: PEER, beforeTimestampMs: 1, beforeMessageId: 'mid.$a' });
    const dropped = expect(pending).rejects.toThrow('Mất kết nối');
    inbox.stop();
    await dropped;
    expect(client.end).toHaveBeenCalledWith(true);
    expect(inbox.isAlive()).toBe(false);
    client.emit('close');
    await jest.advanceTimersByTimeAsync(600_000);
    expect(clients).toHaveLength(1);
    expect(statuses).toEqual(['connected', 'disconnected']);
  });

  test('stoppingWhileThePageIsLoadingNeverConnects', async () => {
    let release: (v: { status: number; html: string }) => void = () => {};
    const { inbox, connect } = setup(() => new Promise(r => { release = r; }));
    const starting = inbox.start();
    inbox.stop();
    release({ status: 200, html: INBOX_HTML });
    await starting;
    expect(connect).not.toHaveBeenCalled();
  });

  test('unreadableFramesOtherTopicsAndSocketErrorsAreSurvived', async () => {
    const { inbox, client, events } = await connected();
    client.emit('message', '/ls_resp', Buffer.from('not json SECRET'));
    client.emit('message', '/ls_resp', Buffer.from(JSON.stringify({ payload: 'not json either' })));
    client.emit('message', '/ls_foreground_state', Buffer.from('{}'));
    client.emit('error', new Error('Invalid header flag bits, must be 0x0 for puback packet')); // gói PUBACK khác chuẩn của Facebook: bỏ qua
    client.emit('error', new Error('boom'));
    client.receive(lsResp([[99, 'future step'], messageCall('insertMessage', 'still works', 'mid.$ok')]));
    expect(events.map(e => e.data.id)).toEqual(['mid.$ok']);
    expect(inbox.isAlive()).toBe(true);
    expect(logged()).toContain('boom');
    expect(logged()).not.toMatch(/SECRET|header flag bits/);
  });

  // Facebook trả lời đồng bộ rồi đóng ngay, lặp lại: phải tính là hỏng (giãn cách dần, rồi tải lại trang), không nối lại đều 10 giây mãi.
  test('sessionsThatSyncButCloseAtOnceCountAsFailures', async () => {
    const { inbox, clients, fetchPage } = setup();
    await inbox.start();
    const syncThenClose = (i: number) => { clients[i].emit('connect'); clients[i].receive(lsResp([syncBlock(205, `C${i}`)], 1)); clients[i].emit('close'); };
    syncThenClose(0);
    await jest.advanceTimersByTimeAsync(10_000);
    syncThenClose(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2); // lần hỏng thứ hai chờ 20 giây
    await jest.advanceTimersByTimeAsync(10_000);
    syncThenClose(2);
    await jest.advanceTimersByTimeAsync(40_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  test('aSessionThatStayedUpResetsTheFailureCount', async () => {
    const { inbox, clients, fetchPage } = setup();
    await inbox.start();
    clients[0].emit('close');
    await jest.advanceTimersByTimeAsync(10_000);
    clients[1].emit('close');
    await jest.advanceTimersByTimeAsync(20_000);
    clients[2].emit('connect');
    clients[2].receive(lsResp([syncBlock(205, 'CUR2')], 1));
    await jest.advanceTimersByTimeAsync(60_000); // phiên ổn định
    clients[2].emit('close');
    await jest.advanceTimersByTimeAsync(10_000); // đếm lại từ đầu: 10 giây, không tải lại trang
    expect(clients).toHaveLength(4);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('resyncDropsALiveConnectionAndReloadsThePage', async () => {
    const { inbox, clients, client, fetchPage, statuses } = await connected();
    inbox.resync();
    expect(client.end).toHaveBeenCalledWith(true);
    expect(inbox.isAlive()).toBe(false);
    expect(statuses).toEqual(['connected', 'disconnected']);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(2);
  });

  test('aConnectThatThrowsIsRetried', async () => {
    const clients: FakeMqtt[] = [];
    const connect = jest.fn(() => { const c = new FakeMqtt(); clients.push(c); return c; }).mockImplementationOnce(() => { throw new Error('socket refused'); });
    const inbox = new FacebookPageInbox({ accountId: 'acc-page-1', pageId: PAGE, getCookie: () => COOKIE, connect, fetchPage: async () => ({ status: 200, html: INBOX_HTML }) });
    await expect(inbox.start()).resolves.toBeUndefined();
    expect(inbox.isAlive()).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(1);
    expect(logged()).toContain('socket refused');
  });

  test('theProxyAgentIsReadAgainForEveryConnection', async () => {
    let agent = 'A1';
    const connect = jest.fn(() => new FakeMqtt());
    const fetchPage = jest.fn(async () => ({ status: 200, html: INBOX_HTML }));
    const inbox = new FacebookPageInbox({ accountId: 'acc-page-1', pageId: PAGE, getCookie: () => COOKIE, getAgent: () => agent, connect, fetchPage });
    await inbox.start();
    agent = 'A2';
    (connect.mock.results[0].value as FakeMqtt).emit('close');
    await jest.advanceTimersByTimeAsync(10_000);
    expect((connect.mock.calls as any[][]).map(c => c[3])).toEqual(['A1', 'A2']);
  });

  describe('sending', () => {
    const confirm = (client: FakeMqtt, messageId: string) => {
      const otid = client.taskPayload(client.requests().length - 1).otid;
      client.receive(lsResp([wireCall('replaceOptimsiticMessage', { 0: otid, 1: messageId })], client.requests().length));
    };

    test('sendTextResolvesWithTheRealMessageIdOnceFacebookConfirms', async () => {
      const { inbox, client } = await connected();
      const sending = inbox.sendText({ threadId: PEER, text: 'SECRET TEXT' });
      expect(client.labels()).toEqual(['sync2', '313', '46']);
      expect(client.taskPayload(2)).toMatchObject({ thread_id: Number(PEER), text: 'SECRET TEXT', sync_group: 205, send_type: 1 });
      client.receive(lsResp([wireCall('taskExists', { 0: i64(1) })], 3)); // chưa phải xác nhận
      confirm(client, 'mid.$sent1');
      await expect(sending).resolves.toEqual({ messageId: 'mid.$sent1' });
      expect(logged()).not.toContain('SECRET');
    });

    test('twoSendsAreConfirmedIndependently', async () => {
      const { inbox, client } = await connected();
      const first = inbox.sendText({ threadId: PEER, text: 'one' });
      const second = inbox.sendText({ threadId: PEER, text: 'two', replyToMessageId: 'mid.$orig' });
      const [otid1, otid2] = [client.taskPayload(2).otid, client.taskPayload(3).otid];
      expect(otid1).not.toBe(otid2);
      expect(client.taskPayload(3).reply_metadata).toMatchObject({ reply_source_id: 'mid.$orig' });
      client.receive(lsResp([wireCall('replaceOptimsiticMessage', { 0: otid2, 1: 'mid.$two' })]));
      client.receive(lsResp([wireCall('replaceOptimsiticMessage', { 0: otid1, 1: 'mid.$one' })]));
      await expect(first).resolves.toEqual({ messageId: 'mid.$one' });
      await expect(second).resolves.toEqual({ messageId: 'mid.$two' });
    });

    // Không biết tin đã tới hay chưa: báo lỗi rõ, không âm thầm coi là đã gửi.
    test('aSendThatFacebookNeverConfirmsFailsAfterTwentySeconds', async () => {
      const { inbox } = await connected();
      const sending = inbox.sendText({ threadId: PEER, text: 'x' });
      const failed = expect(sending).rejects.toThrow('Facebook không xác nhận');
      await jest.advanceTimersByTimeAsync(20_000);
      await failed;
    });

    test('pendingSendsFailWhenTheConnectionDrops', async () => {
      const { inbox, client } = await connected();
      const sending = inbox.sendText({ threadId: PEER, text: 'x' });
      const dropped = expect(sending).rejects.toThrow('Mất kết nối');
      client.emit('close');
      await dropped;
    });

    test('sendingNeedsALiveConnectionAValidThreadAndSomeText', async () => {
      const idle = setup();
      await expect(idle.inbox.sendText({ threadId: PEER, text: 'x' })).rejects.toThrow('chưa kết nối');
      const { inbox, client } = await connected();
      await expect(inbox.sendText({ threadId: 'abc', text: 'x' })).rejects.toThrow('không hợp lệ');
      await expect(inbox.sendText({ threadId: PEER, text: '   ' })).rejects.toThrow('không hợp lệ');
      expect(client.labels()).toEqual(['sync2', '313']);
    });

    test('markReadSendsOneTaskAndIsSilentWhenNotConnected', async () => {
      const idle = setup();
      expect(idle.inbox.markRead(PEER, 1700000000000)).toBe(false);
      const { inbox, client } = await connected();
      expect(inbox.markRead(PEER, 1700000000000)).toBe(true);
      expect(inbox.markRead('abc', 1)).toBe(false);
      expect(client.labels()).toEqual(['sync2', '313', '21']);
      expect(client.taskPayload(2)).toEqual({ thread_id: Number(PEER), last_read_watermark_ts: 1700000000000, sync_group: 205, offline_threading_id: null });
    });
  });

  test('withoutLoginCookiesItDoesNotLoadOrConnect', async () => {
    const connect = jest.fn();
    const fetchPage = jest.fn();
    const inbox = new FacebookPageInbox({ accountId: 'acc-page-1', pageId: PAGE, getCookie: () => 'datr=d', connect, fetchPage });
    await inbox.start();
    await jest.advanceTimersByTimeAsync(600_000);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
