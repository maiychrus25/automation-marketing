import { WebSocketServer } from 'ws';
import {
  connectInbox, historyRequest, pageInboxLogin, pageInboxUsername, readInboxPage, syncRequest, threadListRequest,
} from '../../services/facebook/pageInboxProtocol';
import { BLOKS, COOKIE, DEVICE, INBOX_HTML, LOGIN_HEADER, PAGE, PAGE_VERSION, USER } from './pageInboxFixtures';

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

  // Con trỏ của trang gắn với mã thiết bị trang cấp (kết quả 26.37.12): cả hai phải đọc được từ cùng một trang.
  test('inboxPageGivesTheMailboxCursorVersionsAndDeviceWithoutContent', () => {
    expect(readInboxPage(INBOX_HTML)).toEqual({ cursor: 'PAGECUR', version: PAGE_VERSION, bloksVersion: BLOKS, deviceId: DEVICE });
    expect(readInboxPage('<html>login</html>')).toEqual({ cursor: null, version: null, bloksVersion: null, deviceId: null });
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
