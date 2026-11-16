jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import Logger from '../../utils/Logger';
import {
  connectInbox, describeLsResponse, historyRequest, isPageBridgeProbeEnabled, pageInboxLogin, pageInboxUsername,
  readLsResponse, runPageBridgeProbe, syncRequest, threadListRequest,
} from '../../services/facebook/pageBridgeProbe';

const USER = '100000000008724';
const PAGE = '1000000000003955';
const PEER = '100000000005141';
const COOKIE = `c_user=${USER}; xs=tok; datr=d; fr=f; sb=s; wd=1x1; i_user=100000000004280`;
const logged = () => (Logger.log as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');

const i64 = (v: string | number) => [19, String(v)];
const syncBlock = (database: number, nextCursor: string) => [5, 'executeFirstBlockForSyncTransactionV4', i64(database), i64('7000000000000000001'), 'CUR0', nextCursor, i64(1)];
const messageCall = (name: string, text: string, id: string, stickerId?: string) =>
  [5, name, text, [9], i64(0), i64(PEER), i64(0), i64(1700000000000), i64(1), [9], id, 'otid', i64(PEER), stickerId ? i64(stickerId) : [9]];
const lsResp = (calls: unknown[], requestId?: number) =>
  ({ request_id: requestId ?? null, sp: [], target: 3, payload: JSON.stringify({ name: null, step: [1, [1, ...calls]] }) });

class FakeMqtt extends EventEmitter {
  publish = jest.fn();
  subscribe = jest.fn();
  end = jest.fn();
  receive(body: unknown) { this.emit('message', '/ls_resp', Buffer.from(JSON.stringify(body))); }
  requests() { return this.publish.mock.calls.filter(c => c[0] === '/ls_req').map(c => JSON.parse(c[1])); }
}

describe('pageBridgeProbe', () => {
  beforeEach(() => (Logger.log as jest.Mock).mockClear());
  afterEach(() => { delete process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE; });

  test('onlyRunsWhenTheLaunchFlagIsSet', () => {
    expect(isPageBridgeProbeEnabled()).toBe(false);
    process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE = '1';
    expect(isPageBridgeProbeEnabled()).toBe(true);
  });

  // Business Suite đăng nhập bằng tài khoản cá nhân: cookie i_user của Page làm Facebook trả USER_ID 0 (kết quả 26.37.9).
  test('loginUsesThePersonalCookiesWithoutThePageSwitch', () => {
    expect(pageInboxLogin(COOKIE)).toEqual({ userId: USER, cookieHeader: `c_user=${USER}; xs=tok; datr=d; fr=f; sb=s` });
    expect(pageInboxLogin('xs=tok; datr=d')).toBeNull();
    expect(pageInboxLogin(`c_user=${USER}`)).toBeNull();
  });

  test('usernameNamesThePageOnTopOfThePersonalLogin', () => {
    const u: any = pageInboxUsername(USER, PAGE, 42, 'dev-1');
    expect(u).toMatchObject({ u: USER, p: PAGE, aids: { PAGE }, aid: 514771569228061, s: 42, d: 'dev-1', ct: 'websocket', cp: 3, ecp: 10, st: [] });
  });

  // version và epoch_id vượt 2^53: phải nằm trong JSON đúng từng chữ số, không qua kiểu number của JS.
  test('syncRequestKeepsBigNumbersExact', () => {
    const req = JSON.parse(syncRequest(7, 205, null));
    expect(req).toMatchObject({ app_id: '514771569228061', request_id: 7, type: 2 });
    expect(req.payload).toMatch(/^\{"database":205,"epoch_id":\d{19},"failure_count":null,"last_applied_cursor":null,"sync_params":null,"version":29437738132510565\}$/);
    expect(JSON.parse(syncRequest(8, 205, 'CUR')).payload).toContain('"last_applied_cursor":"CUR"');
  });

  test('threadListAndHistoryAreTasksOnThePageMailbox', () => {
    const threads = JSON.parse(JSON.parse(threadListRequest(2, 0, 'CUR')).payload);
    expect(threads.version_id).toBe('29437738132510565');
    expect(threads.tasks[0]).toMatchObject({ label: '313', queue_name: 'trq', task_id: 0, failure_count: null });
    expect(JSON.parse(threads.tasks[0].payload)).toMatchObject({ cursor: 'CUR', sync_group: 205, secondary_filter: 24, reference_activity_timestamp: 9999999999999 });

    const outer = JSON.parse(historyRequest(3, 1, { threadKey: '9007199254740993123', messageId: 'mid.$a', timestampMs: '1700000000000' }, 'CUR'));
    expect(outer.type).toBe(3);
    const task = JSON.parse(outer.payload).tasks[0];
    expect(task).toMatchObject({ label: '228', queue_name: 'mrq.9007199254740993123', task_id: 1 });
    expect(task.payload).toBe('{"thread_key":9007199254740993123,"direction":0,"reference_timestamp_ms":1700000000000,"reference_message_id":"mid.$a","sync_group":205,"cursor":"CUR"}');
  });

  test('responseSummaryCarriesShapeButNeverContent', () => {
    const resp = readLsResponse(lsResp([
      syncBlock(205, 'CUR2'),
      messageCall('insertMessage', 'SECRET TEXT', 'mid.$abcdef123456'),
      messageCall('upsertMessage', '', 'mid.$sticker000001', '369239263222822'),
      [23, [2, 1], [5, 'insertStickerAttachment', 'https://SECRET/url']],
    ], 7));
    expect(resp.requestId).toBe(7);
    expect(resp.cursor).toBe('CUR2');
    expect(resp.messages).toEqual([
      { threadKey: PEER, senderId: PEER, messageId: 'mid.$abcdef123456', timestampMs: '1700000000000', hasText: true, sticker: false, live: true },
      { threadKey: PEER, senderId: PEER, messageId: 'mid.$sticker000001', timestampMs: '1700000000000', hasText: false, sticker: true, live: false },
    ]);
    const line = describeLsResponse(resp);
    expect(line).toBe('resp request=7 cursor=yes calls=executeFirstBlockForSyncTransactionV4×1,insertMessage×1,upsertMessage×1,insertStickerAttachment×1'
      + ' messages=[live thread=…5141 sender=…5141 id=…123456 text=true sticker=false; old thread=…5141 sender=…5141 id=…000001 text=false sticker=true]');
    expect(line).not.toContain('SECRET');
  });

  test('aCursorOfAnotherDatabaseIsNotTakenForTheMailbox', () => {
    expect(readLsResponse(lsResp([syncBlock(2, 'CONTACTS')])).cursor).toBeNull();
  });

  test('connectsSyncsListsThreadsAndAsksHistoryOnce', async () => {
    const client = new FakeMqtt();
    const connect = jest.fn().mockReturnValue(client);
    const probe = await runPageBridgeProbe('acc-page-1', COOKIE, PAGE, { connect, agent: 'AGENT' });
    const [url, username, cookieHeader, agent] = connect.mock.calls[0];
    expect(url).toMatch(/^wss:\/\/edge-chat\.facebook\.com\/chat\?region=eag&sid=\d+&cid=[a-z0-9-]+$/);
    expect(username).toMatchObject({ u: USER, p: PAGE });
    expect(cookieHeader).not.toContain('i_user');
    expect(agent).toBe('AGENT');

    client.emit('connect');
    expect(client.publish).toHaveBeenCalledWith('/ls_app_settings', '{"ls_fdid":"","ls_sv":"29437738132510565"}', { qos: 1 });
    expect(client.subscribe).toHaveBeenCalledWith(['/ls_foreground_state', '/ls_resp'], { qos: 0 });
    expect(client.requests().map(r => r.type)).toEqual([2]);
    expect(client.requests()[0].payload).toContain('"database":205');

    client.receive(lsResp([syncBlock(205, 'CUR2')], 1)); // có con trỏ: xin danh sách hội thoại
    client.receive(lsResp([messageCall('insertMessage', 'SECRET TEXT', 'mid.$abcdef123456')])); // tin đầu tiên: xin tin cũ
    client.receive(lsResp([messageCall('insertMessage', 'SECRET TEXT', 'mid.$abcdef123457')])); // tin sau: không xin nữa
    const labels = client.requests().slice(1).map(r => JSON.parse(r.payload).tasks[0].label);
    expect(labels).toEqual(['313', '228']);
    expect(client.requests()[2].payload).toContain('CUR2');
    expect(client.requests().map(r => r.request_id)).toEqual([1, 2, 3]);
    expect(logged()).toContain('[PageBridgeProbe:acc-page] connected page=…3955 user=…8724');
    expect(logged()).toContain('asking history thread=…5141');
    expect(logged()).not.toContain('SECRET');

    await probe!.close();
    expect(client.end).toHaveBeenCalledWith(true);
  });

  test('unreadableFramesAndErrorsAreLoggedWithoutStoppingTheProbe', async () => {
    const client = new FakeMqtt();
    await runPageBridgeProbe('acc-page-1', COOKIE, PAGE, { connect: () => client });
    client.emit('message', '/ls_resp', Buffer.from('not json SECRET'));
    client.emit('message', '/ls_foreground_state', Buffer.from('{}'));
    client.emit('error', new Error('boom'));
    client.emit('close');
    expect(logged()).toContain('unreadable response len=15');
    expect(logged()).toContain('error: boom');
    expect(logged()).toContain('closed');
    expect(logged()).not.toContain('SECRET');
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

  test('doesNothingWithoutALoginOrAPageId', async () => {
    const connect = jest.fn();
    await expect(runPageBridgeProbe('acc-page-1', 'datr=d', PAGE, { connect })).resolves.toBeNull();
    await expect(runPageBridgeProbe('acc-page-1', COOKIE, null, { connect })).resolves.toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});
