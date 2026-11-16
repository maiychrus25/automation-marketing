import { WebSocketServer } from 'ws';
import {
  connectInbox, historyRequest, markReadRequest, newOfflineThreadingId, pageInboxLogin, pageInboxUsername, reactionRequest, readInboxPage,
  sendAttachmentRequest, sendStickerRequest, sendTextRequest, syncRequest, threadListRequest,
} from '../../services/facebook/pageInboxProtocol';
import { BLOKS, COOKIE, DEVICE, DTSG, INBOX_HTML, JAZOEST, LOGIN_HEADER, LSD, PAGE, PAGE_VERSION, USER } from './pageInboxFixtures';

describe('pageInboxProtocol', () => {
  // Business Suite đăng nhập bằng tài khoản cá nhân: cookie i_user của Page làm Facebook trả USER_ID 0 (kết quả 26.37.9).
  test('loginUsesThePersonalCookiesWithoutThePageSwitch', () => {
    expect(pageInboxLogin(COOKIE)).toEqual({ userId: USER, cookieHeader: LOGIN_HEADER });
    expect(pageInboxLogin('xs=tok; datr=d')).toBeNull();
    expect(pageInboxLogin(`c_user=${USER}`)).toBeNull();
  });

  test('usernameNamesThePageOnTopOfThePersonalLogin', () => {
    const u: any = pageInboxUsername(USER, PAGE, 42, 'dev-1');
    expect(u).toMatchObject({ u: USER, p: PAGE, aids: { PAGE }, aid: 514771569228061, s: 42, d: 'dev-1', ct: 'websocket', cp: 3, ecp: 10, st: [] });
  });

  // version và epoch_id vượt 2^53: phải nằm trong JSON đúng từng chữ số, không qua kiểu number của JS.
  test('syncRequestKeepsBigNumbersExact', () => {
    const req = JSON.parse(syncRequest(7, 205, 'CUR', null));
    expect(req).toMatchObject({ app_id: '514771569228061', request_id: 7, type: 2 });
    expect(req.payload).toMatch(/^\{"database":205,"epoch_id":\d{19},"failure_count":null,"last_applied_cursor":"CUR","sync_params":null,"version":29437738132510565\}$/);
    expect(JSON.parse(syncRequest(8, 205, 'CUR', null, PAGE_VERSION)).payload).toContain(`"version":${PAGE_VERSION}}`);
  });

  // Lần đồng bộ đầu (chưa có con trỏ) phải kèm tham số, như trang Business Suite làm; xin từ con trỏ rỗng thì Facebook không trả lời (kết quả 26.37.11).
  test('aFirstSyncCarriesSyncParamsInsteadOfACursor', () => {
    const req = JSON.parse(syncRequest(1, 205, null, '{"locale":"vi_VN"}'));
    expect(req.type).toBe(1);
    expect(JSON.parse(req.payload)).toMatchObject({ database: 205, last_applied_cursor: null, sync_params: '{"locale":"vi_VN"}' });
  });

  test('threadListAndHistoryAreTasksOnThePageMailbox', () => {
    const threads = JSON.parse(JSON.parse(threadListRequest(2, 0, 'CUR', PAGE_VERSION)).payload);
    expect(threads.version_id).toBe(PAGE_VERSION);
    expect(threads.tasks[0]).toMatchObject({ label: '313', queue_name: 'trq', task_id: 0, failure_count: null });
    expect(JSON.parse(threads.tasks[0].payload)).toMatchObject({ cursor: 'CUR', sync_group: 205, secondary_filter: 24, reference_activity_timestamp: 9999999999999 });

    const outer = JSON.parse(historyRequest(3, 1, { threadId: '9007199254740993123', messageId: 'mid.$a', timestampMs: 1700000000000 }, 'CUR'));
    expect(outer.type).toBe(3);
    const task = JSON.parse(outer.payload).tasks[0];
    expect(task).toMatchObject({ label: '228', queue_name: 'mrq.9007199254740993123', task_id: 1 });
    expect(task.payload).toBe('{"thread_key":9007199254740993123,"direction":0,"reference_timestamp_ms":1700000000000,"reference_message_id":"mid.$a","sync_group":205,"cursor":"CUR"}');
  });

  // Bản ghi Business Suite 16/11/2026 (23:35): trang hội thoại kế tiếp được xin từ hội thoại cũ nhất đã có, bằng thời điểm
  // hoạt động cuối và id của nó.
  test('olderThreadsAreAskedForFromTheOldestThreadAlreadyListed', () => {
    const task = JSON.parse(JSON.parse(threadListRequest(2, 5, 'CUR', PAGE_VERSION, { timestampMs: 1700000000123, threadKey: '9007199254740993123' })).payload).tasks[0];
    expect(task).toMatchObject({ label: '313', queue_name: 'trq', task_id: 5 });
    expect(task.payload).toBe('{"cursor":"CUR","filter":0,"is_after":0,"parent_thread_key":0,"reference_activity_timestamp":1700000000123,'
      + '"reference_thread_key":9007199254740993123,"secondary_filter":24,"filter_value":"","sync_group":205}');
  });

  // Đúng gói Business Suite gửi (bản ghi 16/11/2026): một yêu cầu hai tác vụ, gửi tin (46) rồi đánh dấu đã đọc (21),
  // cả hai xếp hàng theo id hội thoại.
  test('sendingTextIsASendTaskFollowedByAMarkReadTask', () => {
    const outer = JSON.parse(sendTextRequest(9, 4, { threadId: '9007199254740993123', text: 'xin "chào"\n', otid: '7000000000000000042', nowMs: 1700000000000 }, PAGE_VERSION));
    expect(outer).toMatchObject({ app_id: '514771569228061', request_id: 9, type: 3 });
    const payload = JSON.parse(outer.payload);
    expect(payload.version_id).toBe(PAGE_VERSION);
    expect(payload.tasks.map((t: any) => [t.label, t.queue_name, t.task_id, t.failure_count])).toEqual([
      ['46', '9007199254740993123', 4, null], ['21', '9007199254740993123', 5, null],
    ]);
    expect(payload.tasks[0].payload).toBe('{"thread_id":9007199254740993123,"otid":"7000000000000000042","source":4456448,"send_type":1,"sync_group":205,"mark_thread_read":1,"text":"xin \\"chào\\"\\n"}');
    expect(payload.tasks[1].payload).toBe('{"thread_id":9007199254740993123,"last_read_watermark_ts":1700000000000,"sync_group":205,"offline_threading_id":null}');
  });

  test('aReplyCarriesTheMessageItAnswers', () => {
    const outer = JSON.parse(sendTextRequest(9, 4, { threadId: '100000000005141', text: 'ok', otid: '7000000000000000042', nowMs: 1, replyToMessageId: 'mid.$orig' }));
    expect(JSON.parse(JSON.parse(outer.payload).tasks[0].payload).reply_metadata).toEqual({ reply_source_id: 'mid.$orig', reply_source_type: 1, reply_type: 0 });
    const plain = JSON.parse(sendTextRequest(9, 4, { threadId: '100000000005141', text: 'ok', otid: '7000000000000000042', nowMs: 1 }));
    expect(JSON.parse(plain.payload).tasks[0].payload).not.toContain('reply_metadata');
  });

  test('markReadIsOneTaskOnTheThreadQueue', () => {
    const payload = JSON.parse(JSON.parse(markReadRequest(3, 7, '100000000005141', 1700000000123, PAGE_VERSION)).payload);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]).toMatchObject({ label: '21', queue_name: '100000000005141', task_id: 7 });
    expect(payload.tasks[0].payload).toBe('{"thread_id":100000000005141,"last_read_watermark_ts":1700000000123,"sync_group":205,"offline_threading_id":null}');
  });

  test('offlineThreadingIdsAreNineteenDigitsAndDistinct', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newOfflineThreadingId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^\d{19}$/);
  });

  // Con trỏ của trang gắn với mã thiết bị trang cấp (kết quả 26.37.12): cả hai phải đọc được từ cùng một trang.
  test('inboxPageGivesTheMailboxCursorVersionsAndDeviceWithoutContent', () => {
    expect(readInboxPage(INBOX_HTML)).toMatchObject({ cursor: 'PAGECUR', version: PAGE_VERSION, bloksVersion: BLOKS, deviceId: DEVICE });
    expect(readInboxPage('<html>login</html>')).toEqual({ cursor: null, version: null, bloksVersion: null, deviceId: null, fbDtsg: null, lsd: null, jazoest: null });
  });

  // Tải tệp lên cho Page cần mã phiên của trang hộp thư (phiên tài khoản cá nhân ở business.facebook.com).
  test('inboxPageGivesTheTokensForUploads', () => {
    expect(readInboxPage(INBOX_HTML)).toMatchObject({ fbDtsg: DTSG, lsd: LSD, jazoest: JAZOEST });
    // Trang không in sẵn jazoest: tính từ fb_dtsg như trình duyệt làm ("2" + tổng mã ký tự).
    const sum = [...DTSG].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    expect(readInboxPage(INBOX_HTML.replace(`&jazoest=${JAZOEST}`, '')).jazoest).toBe(`2${sum}`);
  });

  // Bản ghi Business Suite 16/11/2026 (23:35): đính kèm đi một tác vụ gửi duy nhất, không kèm đánh dấu đã đọc,
  // và mã đính kèm là số nguyên (16 chữ số, có thể vượt 2^53).
  test('sendingAnAttachmentIsASingleSendTask', () => {
    const payload = JSON.parse(JSON.parse(sendAttachmentRequest(9, 4, { threadId: '9007199254740993123', otid: '7000000000000000042', attachmentId: '9007199254740993' }, PAGE_VERSION)).payload);
    expect(payload.version_id).toBe(PAGE_VERSION);
    expect(payload.tasks.map((t: any) => [t.label, t.queue_name, t.task_id, t.failure_count])).toEqual([['46', '9007199254740993123', 4, null]]);
    expect(payload.tasks[0].payload).toBe('{"thread_id":9007199254740993123,"otid":"7000000000000000042","source":0,"send_type":3,"sync_group":205,"mark_thread_read":0,"text":null,"attachment_fbids":[9007199254740993]}');
  });

  test('sendingAStickerIsASendTaskFollowedByAMarkReadTask', () => {
    const payload = JSON.parse(JSON.parse(sendStickerRequest(9, 4, { threadId: '100000000005141', otid: '7000000000000000042', stickerId: '369239263222822', nowMs: 1700000000000 })).payload);
    expect(payload.tasks.map((t: any) => [t.label, t.queue_name, t.task_id])).toEqual([['46', '100000000005141', 4], ['21', '100000000005141', 5]]);
    expect(payload.tasks[0].payload).toBe('{"thread_id":100000000005141,"otid":"7000000000000000042","source":4456448,"send_type":2,"sync_group":205,"mark_thread_read":1,"sticker_id":369239263222822}');
    expect(payload.tasks[1].payload).toBe('{"thread_id":100000000005141,"last_read_watermark_ts":1700000000000,"sync_group":205,"offline_threading_id":null}');
  });

  // Thả cảm xúc đứng tên Page (actor_id là id Page), xếp hàng theo từng tin; cảm xúc rỗng là gỡ.
  test('aReactionIsOneTaskQueuedPerMessageAndAnEmptyOneRemovesIt', () => {
    const outer = JSON.parse(reactionRequest(9, 4, { threadId: '100000000005141', messageId: 'mid.$a', pageId: PAGE, emoji: '👍', nowMs: 1700000000123 }, PAGE_VERSION));
    const payload = JSON.parse(outer.payload);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]).toMatchObject({ label: '29', queue_name: 'reaction:mid.$a', task_id: 4, failure_count: null });
    expect(payload.tasks[0].payload).toBe(`{"thread_key":100000000005141,"timestamp_ms":1700000000123,"message_id":"mid.$a","actor_id":${PAGE},"reaction":"👍","reaction_style":null,`
      + '"sync_group":205,"send_attribution":4456448,"dataclass_params":null,"attachment_fbid":null,"offline_threading_id":null}');
    const removal = JSON.parse(reactionRequest(9, 4, { threadId: '100000000005141', messageId: 'mid.$a', pageId: PAGE, emoji: '', nowMs: 1 }));
    expect(JSON.parse(JSON.parse(removal.payload).tasks[0].payload).reaction).toBe('');
  });

  // Gói CONNECT thật do thư viện mqtt tạo ra, so với gói Business Suite gửi (bản ghi 16/11/2026): MQIsdp v3, cờ 0x82, keepalive 15.
  test('theConnectPacketMatchesWhatBusinessSuiteSends', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(r => server.once('listening', r));
    const seen = new Promise<{ headers: any; url: string; packet: Buffer }>(resolve =>
      server.once('connection', (socket, req) => {
        let packet = Buffer.alloc(0);
        socket.on('message', data => { // thư viện mqtt ghi một gói thành nhiều khung WebSocket: gom đến khi đủ tên đăng nhập
          packet = Buffer.concat([packet, data as Buffer]);
          if (packet.includes('"u":')) resolve({ headers: req.headers, url: req.url || '', packet });
        });
      }));
    const username = pageInboxUsername(USER, PAGE, 42, 'dev-1');
    const client: any = connectInbox(`ws://127.0.0.1:${(server.address() as any).port}/chat?region=eag&sid=42&cid=dev-1`, username, 'c_user=1; xs=tok');
    client.on('error', () => {});
    try {
      const { headers, url, packet } = await seen;
      expect(url).toBe('/chat?region=eag&sid=42&cid=dev-1');
      expect(headers.cookie).toBe('c_user=1; xs=tok');
      expect(headers.origin).toBe('https://business.facebook.com');
      expect(headers['sec-websocket-protocol']).toBeUndefined();
      expect(packet[0]).toBe(0x10); // CONNECT
      const body = packet.subarray(packet.indexOf('MQIsdp') - 2);
      expect(body.subarray(0, 12)).toEqual(Buffer.from([0, 6, ...Buffer.from('MQIsdp'), 3, 0x82, 0, 15]));
      const clientIdLength = body.readUInt16BE(12);
      expect(body.subarray(14, 14 + clientIdLength).toString()).toBe('mqttwsclient');
      const usernameLength = body.readUInt16BE(14 + clientIdLength);
      expect(JSON.parse(body.subarray(16 + clientIdLength, 16 + clientIdLength + usernameLength).toString())).toEqual(username);
      expect(body.length).toBe(16 + clientIdLength + usernameLength); // không có mật khẩu hay will
    } finally {
      client.end(true);
      await new Promise(r => server.close(r));
    }
  });
});
