/**
 * THỬ NGHIỆM, sẽ gỡ sau khi có kết quả: nối thẳng vào hộp thư Page theo cách Meta Business Suite làm
 * (đăng nhập bằng cookie tài khoản cá nhân, gói kết nối nêu tên Page, hộp thư là nhóm đồng bộ 205), xem có nhận
 * tin trực tiếp và tải được tin cũ không. Chỉ chạy khi app được mở với MAIHUB_FB_PAGE_BRIDGE_PROBE=1.
 * Chỉ đọc và ghi log: không lưu tin, không gửi tin, không đánh dấu đã đọc. Log không bao giờ chứa nội dung tin.
 */
import mqtt from 'mqtt';
import WebSocket from 'ws';
import Logger from '../../utils/Logger';
import { generateClientId, generateSessionId, parseCookieString } from './FacebookUtils';

const ENDPOINT = 'wss://edge-chat.facebook.com/chat';
const ORIGIN = 'https://business.facebook.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BUSINESS_SUITE_APP_ID = '514771569228061';
// shortcut: phiên bản lược đồ chép từ một phiên Business Suite ngày 16/11/2026; khi thành tính năng thật phải đọc từ trang hộp thư.
const LS_VERSION = '29437738132510565';
const PAGE_MAILBOX = 205;
const LOGIN_COOKIE_NAMES = ['c_user', 'xs', 'datr', 'fr', 'sb'];
const MESSAGE_CALLS = ['insertMessage', 'upsertMessage'];

const tail = (id: unknown, n = 4) => `…${String(id ?? '').slice(-n)}`;
// Số vượt 2^53 (version, epoch_id, id hội thoại) đi qua JSON bằng chuỗi đánh dấu rồi bỏ dấu nháy, để không mất chữ số.
const big = (digits: string) => `@big:${digits}`;
const toJson = (value: unknown) => JSON.stringify(value).replace(/"@big:(-?\d+)"/g, '$1');
const epochId = () => (BigInt(Date.now()) << BigInt(22)).toString();

export const isPageBridgeProbeEnabled = (): boolean => process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE === '1';

/** Đăng nhập của tài khoản cá nhân lấy từ cookie Page (bỏ `i_user`); null nếu thiếu cookie đăng nhập. */
export function pageInboxLogin(cookie: string): { userId: string; cookieHeader: string } | null {
  const all = parseCookieString(cookie);
  if (!all.c_user || !all.xs) return null;
  return { userId: all.c_user, cookieHeader: LOGIN_COOKIE_NAMES.filter(n => all[n]).map(n => `${n}=${all[n]}`).join('; ') };
}

/** Username của gói MQTT CONNECT như Business Suite gửi: người dùng là tài khoản cá nhân, `p` / `aids.PAGE` nêu Page. */
export function pageInboxUsername(userId: string, pageId: string, sessionId: number, deviceId: string): Record<string, unknown> {
  return {
    a: USER_AGENT, asi: null, aid: Number(BUSINESS_SUITE_APP_ID), aids: { PAGE: pageId }, chat_on: false, cp: 3, ct: 'websocket',
    d: deviceId, dc: '', ecp: 10, fg: true, gas: null, mqtt_sid: '', no_auto_fg: true, p: pageId, pack: [], php_override: '',
    pm: [], s: sessionId, st: [], u: userId,
  };
}

const lsRequest = (requestId: number, type: number, payload: string) =>
  JSON.stringify({ app_id: BUSINESS_SUITE_APP_ID, payload, request_id: requestId, type });

const taskRequest = (requestId: number, taskId: number, label: string, queueName: string, payload: string) =>
  lsRequest(requestId, 3, toJson({
    epoch_id: big(epochId()),
    tasks: [{ failure_count: null, label, payload, queue_name: queueName, task_id: taskId }],
    version_id: LS_VERSION,
  }));

/** Xin đồng bộ một cơ sở dữ liệu từ con trỏ đã có (null = từ đầu). */
export function syncRequest(requestId: number, database: number, cursor: string | null): string {
  return lsRequest(requestId, 2, toJson({
    database, epoch_id: big(epochId()), failure_count: null, last_applied_cursor: cursor, sync_params: null, version: big(LS_VERSION),
  }));
}

/** Xin trang đầu danh sách hội thoại của hộp thư Page. */
export function threadListRequest(requestId: number, taskId: number, cursor: string): string {
  return taskRequest(requestId, taskId, '313', 'trq', toJson({
    cursor, filter: 0, is_after: 0, parent_thread_key: 0, reference_activity_timestamp: 9999999999999, reference_thread_key: 0,
    secondary_filter: 24, filter_value: '', sync_group: PAGE_MAILBOX,
  }));
}

/** Xin các tin cũ hơn một tin đã biết trong một hội thoại. */
export function historyRequest(requestId: number, taskId: number, from: Pick<LsMessage, 'threadKey' | 'messageId' | 'timestampMs'>, cursor: string): string {
  return taskRequest(requestId, taskId, '228', `mrq.${from.threadKey}`, toJson({
    thread_key: big(from.threadKey), direction: 0, reference_timestamp_ms: big(from.timestampMs), reference_message_id: from.messageId,
    sync_group: PAGE_MAILBOX, cursor,
  }));
}

export interface LsMessage { threadKey: string; senderId: string; messageId: string; timestampMs: string; hasText: boolean; sticker: boolean; live: boolean }
export interface LsResponse { requestId: number | null; cursor: string | null; calls: Record<string, number>; messages: LsMessage[] }

// Giá trị trong lời gọi thủ tục: chuỗi/số để nguyên, [19, "số"] là số 64 bit, còn lại ([9] = không có, phép tính) coi như trống.
const argValue = (arg: unknown): string | null => {
  if (Array.isArray(arg)) return arg[0] === 19 ? String(arg[1]) : null;
  return arg === null || arg === undefined ? null : String(arg);
};

/**
 * Đọc một phản hồi /ls_resp: tên các thủ tục được gọi, con trỏ mới của hộp thư Page và các tin có trong đó.
 * shortcut: duyệt mọi nhánh thay vì chạy chương trình lightspeed nên số đếm có thể dư ở nhánh điều kiện; đủ cho bản thử,
 * tính năng thật phải dùng bộ giải mã đầy đủ.
 */
export function readLsResponse(body: any): LsResponse {
  const out: LsResponse = { requestId: typeof body?.request_id === 'number' ? body.request_id : null, cursor: null, calls: {}, messages: [] };
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node[0] === 5 && typeof node[1] === 'string') {
      const name: string = node[1];
      const args = node.slice(2);
      out.calls[name] = (out.calls[name] || 0) + 1;
      if (name.startsWith('executeFirstBlockForSyncTransaction') && argValue(args[0]) === String(PAGE_MAILBOX)) out.cursor = argValue(args[3]);
      if (MESSAGE_CALLS.includes(name)) {
        const stickerId = argValue(args[11]);
        out.messages.push({
          threadKey: argValue(args[3]) ?? '', senderId: argValue(args[10]) ?? '', messageId: argValue(args[8]) ?? '', timestampMs: argValue(args[5]) ?? '',
          hasText: !!argValue(args[0]), sticker: !!stickerId && stickerId !== '0', live: name === 'insertMessage',
        });
      }
    }
    node.forEach(walk);
  };
  walk(JSON.parse(body.payload).step);
  return out;
}

/** Tóm tắt một phản hồi, không có nội dung tin. */
export function describeLsResponse(resp: LsResponse): string {
  const calls = Object.entries(resp.calls).map(([name, n]) => `${name}×${n}`).join(',') || '-';
  const messages = resp.messages.slice(0, 5).map(m =>
    `${m.live ? 'live' : 'old'} thread=${tail(m.threadKey)} sender=${tail(m.senderId)} id=${tail(m.messageId, 6)} text=${m.hasText} sticker=${m.sticker}`).join('; ');
  const more = resp.messages.length > 5 ? ` (+${resp.messages.length - 5})` : '';
  return `resp request=${resp.requestId ?? '-'} cursor=${resp.cursor ? 'yes' : 'no'} calls=${calls}${messages ? ` messages=[${messages}]${more}` : ''}`;
}

type InboxClient = {
  on(event: string, cb: (...args: any[]) => void): unknown;
  publish(topic: string, message: string, opts: { qos: 0 | 1 }): unknown;
  subscribe(topics: string[], opts: { qos: 0 | 1 }): unknown;
  end(force?: boolean): unknown;
};
type ConnectInbox = (url: string, username: Record<string, unknown>, cookieHeader: string, agent?: unknown) => InboxClient;

// Cùng cách nối với FacebookMQTTListener (MQTT 3.1 qua WebSocket, không gửi subprotocol); không tự nối lại: bản thử chỉ cần một phiên.
export const connectInbox: ConnectInbox = (url, username, cookieHeader, agent) => mqtt.connect(url, {
  protocolId: 'MQIsdp', protocolVersion: 3, clientId: 'mqttwsclient', clean: true, keepalive: 15, connectTimeout: 20000, reconnectPeriod: 0,
  username: JSON.stringify(username),
  createWebsocket: (wsUrl: string) => new WebSocket(wsUrl, {
    headers: { Cookie: cookieHeader, Origin: ORIGIN, 'User-Agent': USER_AGENT, Host: 'edge-chat.facebook.com' }, agent: agent as any,
  }) as any,
} as any) as unknown as InboxClient;

export async function runPageBridgeProbe(
  accountId: string,
  cookie: string,
  pageId: string | null,
  deps: { connect?: ConnectInbox; agent?: unknown } = {},
): Promise<{ close: () => Promise<void> } | null> {
  const login = pageInboxLogin(cookie);
  if (!login || !pageId || !/^\d+$/.test(pageId)) return null;
  const tag = `[PageBridgeProbe:${accountId.slice(0, 8)}]`;
  const sessionId = generateSessionId();
  const deviceId = generateClientId();
  const client = (deps.connect ?? connectInbox)(
    `${ENDPOINT}?region=eag&sid=${sessionId}&cid=${deviceId}`, pageInboxUsername(login.userId, pageId, sessionId, deviceId), login.cookieHeader, deps.agent,
  );
  let requestId = 0;
  let taskId = 0;
  let cursor: string | null = null;
  let threadsAsked = false;
  let historyAsked = false;
  const send = (request: string) => client.publish('/ls_req', request, { qos: 1 });

  client.on('connect', () => {
    Logger.log(`${tag} connected page=${tail(pageId)} user=${tail(login.userId)}`);
    client.publish('/ls_app_settings', JSON.stringify({ ls_fdid: '', ls_sv: LS_VERSION }), { qos: 1 });
    client.subscribe(['/ls_foreground_state', '/ls_resp'], { qos: 0 });
    send(syncRequest(++requestId, PAGE_MAILBOX, cursor));
  });
  client.on('message', (topic: string, payload: Buffer) => {
    if (topic !== '/ls_resp') return;
    let resp: LsResponse;
    try { resp = readLsResponse(JSON.parse(payload.toString('utf8'))); } catch { Logger.log(`${tag} unreadable response len=${payload.length}`); return; }
    Logger.log(`${tag} ${describeLsResponse(resp)}`);
    if (resp.cursor) cursor = resp.cursor;
    if (!cursor) return;
    if (!threadsAsked) { threadsAsked = true; send(threadListRequest(++requestId, taskId++, cursor)); }
    const first = resp.messages.find(m => /^\d+$/.test(m.threadKey) && /^\d+$/.test(m.timestampMs) && m.messageId);
    if (first && !historyAsked) {
      historyAsked = true; // một lần: đủ để biết tin cũ có tải được không
      Logger.log(`${tag} asking history thread=${tail(first.threadKey)}`);
      send(historyRequest(++requestId, taskId++, first, cursor));
    }
  });
  client.on('error', (err: Error) => Logger.log(`${tag} error: ${err?.message}`));
  client.on('close', () => Logger.log(`${tag} closed`));
  return { close: async () => { client.end(true); } };
}
