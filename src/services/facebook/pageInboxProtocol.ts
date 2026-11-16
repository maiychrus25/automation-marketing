/**
 * Phần "dây" của hộp thư Page nối trực tiếp: đăng nhập, gói kết nối, các yêu cầu /ls_req và việc đọc trang hộp thư
 * Business Suite. Đã kiểm trên tài khoản thật ở các bản thử 26.37.11–26.37.13 (SYSTEM_DOCUMENTATION.md mục 4.11):
 * đăng nhập bằng cookie tài khoản cá nhân, gói CONNECT nêu tên Page, hộp thư là cơ sở dữ liệu 205, và kết nối phải
 * dùng đúng mã thiết bị mà trang hộp thư cấp cùng con trỏ đồng bộ.
 */
import axios from 'axios';
import mqtt from 'mqtt';
import WebSocket from 'ws';
import { fbHeaders } from './FacebookSession';
import { parseCookieString } from './FacebookUtils';
import { PAGE_MAILBOX_DB } from './pageInboxTables';
import { FB_USER_AGENT } from './facebookIdentity';

export const PAGE_INBOX_ENDPOINT = 'wss://edge-chat.facebook.com/chat';
const ORIGIN = 'https://business.facebook.com';
const BUSINESS_SUITE_APP_ID = '514771569228061';
/** Dự phòng khi trang hộp thư không cho phiên bản lược đồ: chép từ một phiên Business Suite ngày 16/11/2026. */
export const FALLBACK_LS_VERSION = '29437738132510565';
const LOGIN_COOKIE_NAMES = ['c_user', 'xs', 'datr', 'fr', 'sb'];

// Số vượt 2^53 (version, epoch_id, id hội thoại) đi qua JSON bằng chuỗi đánh dấu rồi bỏ dấu nháy, để không mất chữ số.
const big = (digits: string | number) => `@big:${digits}`;
const toJson = (value: unknown) => JSON.stringify(value).replace(/"@big:(-?\d+)"/g, '$1');
const epochId = () => (BigInt(Date.now()) << BigInt(22)).toString();

/** Đăng nhập của tài khoản cá nhân lấy từ cookie Page (bỏ `i_user`); null nếu thiếu cookie đăng nhập. */
export function pageInboxLogin(cookie: string): { userId: string; cookieHeader: string } | null {
  const all = parseCookieString(cookie);
  if (!all.c_user || !all.xs) return null;
  return { userId: all.c_user, cookieHeader: LOGIN_COOKIE_NAMES.filter(n => all[n]).map(n => `${n}=${all[n]}`).join('; ') };
}

/** Username của gói MQTT CONNECT như Business Suite gửi: người dùng là tài khoản cá nhân, `p` / `aids.PAGE` nêu Page. */
export function pageInboxUsername(userId: string, pageId: string, sessionId: number, deviceId: string): Record<string, unknown> {
  return {
    a: FB_USER_AGENT, asi: null, aid: Number(BUSINESS_SUITE_APP_ID), aids: { PAGE: pageId }, chat_on: false, cp: 3, ct: 'websocket',
    d: deviceId, dc: '', ecp: 10, fg: true, gas: null, mqtt_sid: '', no_auto_fg: true, p: pageId, pack: [], php_override: '',
    pm: [], s: sessionId, st: [], u: userId,
  };
}

const lsRequest = (requestId: number, type: number, payload: string) =>
  JSON.stringify({ app_id: BUSINESS_SUITE_APP_ID, payload, request_id: requestId, type });

interface LsTask { label: string; queueName: string; payload: string }

/** Một yêu cầu loại 3 gồm một hay nhiều tác vụ; tác vụ thứ i mang task_id = firstTaskId + i. */
const tasksRequest = (requestId: number, firstTaskId: number, tasks: LsTask[], version: string) =>
  lsRequest(requestId, 3, toJson({
    epoch_id: big(epochId()),
    tasks: tasks.map((t, i) => ({ failure_count: null, label: t.label, payload: t.payload, queue_name: t.queueName, task_id: firstTaskId + i })),
    version_id: version,
  }));

const taskRequest = (requestId: number, taskId: number, label: string, queueName: string, payload: string, version: string) =>
  tasksRequest(requestId, taskId, [{ label, queueName, payload }], version);

const markReadTask = (threadId: string, watermarkMs: number): LsTask => ({
  label: '21', queueName: threadId,
  payload: toJson({ thread_id: big(threadId), last_read_watermark_ts: big(Math.trunc(watermarkMs)), sync_group: PAGE_MAILBOX_DB, offline_threading_id: null }),
});

let otidCounter = 0;
/** Mã tạm của một tin sắp gửi (19 chữ số: thời điểm << 22 cộng số đếm); Facebook trả lại nó kèm mã tin thật khi xác nhận. */
export function newOfflineThreadingId(): string {
  otidCounter = (otidCounter + 1) % 4194304; // 22 bit
  return ((BigInt(Date.now()) << BigInt(22)) | BigInt(otidCounter)).toString();
}

/**
 * Gửi một tin chữ vào hội thoại của Page, như Business Suite: tác vụ gửi (46) rồi tác vụ đánh dấu đã đọc (21) trong cùng
 * một yêu cầu, dùng hai task_id liên tiếp bắt đầu từ `firstTaskId`.
 */
export function sendTextRequest(
  requestId: number, firstTaskId: number,
  message: { threadId: string; text: string; otid: string; nowMs: number; replyToMessageId?: string },
  version = FALLBACK_LS_VERSION,
): string {
  const send: LsTask = {
    label: '46', queueName: message.threadId,
    payload: toJson({
      thread_id: big(message.threadId), otid: message.otid, source: 4456448, send_type: 1, sync_group: PAGE_MAILBOX_DB, mark_thread_read: 1,
      ...(message.replyToMessageId ? { reply_metadata: { reply_source_id: message.replyToMessageId, reply_source_type: 1, reply_type: 0 } } : {}),
      text: message.text,
    }),
  };
  return tasksRequest(requestId, firstTaskId, [send, markReadTask(message.threadId, message.nowMs)], version);
}

/**
 * Gửi một đính kèm đã tải lên (ảnh, video, tệp) vào hội thoại của Page: một tác vụ gửi duy nhất, không kèm đánh dấu đã đọc,
 * đúng như Business Suite (bản ghi 16/11/2026). `attachmentId` là mã do bước tải lên trả về.
 */
export function sendAttachmentRequest(
  requestId: number, taskId: number, message: { threadId: string; otid: string; attachmentId: string }, version = FALLBACK_LS_VERSION,
): string {
  return taskRequest(requestId, taskId, '46', message.threadId, toJson({
    thread_id: big(message.threadId), otid: message.otid, source: 0, send_type: 3, sync_group: PAGE_MAILBOX_DB, mark_thread_read: 0,
    text: null, attachment_fbids: [big(message.attachmentId)],
  }), version);
}

/** Gửi một nhãn dán vào hội thoại của Page: tác vụ gửi (46) rồi tác vụ đánh dấu đã đọc (21), như tin chữ. */
export function sendStickerRequest(
  requestId: number, firstTaskId: number, message: { threadId: string; otid: string; stickerId: string; nowMs: number }, version = FALLBACK_LS_VERSION,
): string {
  const send: LsTask = {
    label: '46', queueName: message.threadId,
    payload: toJson({
      thread_id: big(message.threadId), otid: message.otid, source: 4456448, send_type: 2, sync_group: PAGE_MAILBOX_DB, mark_thread_read: 1,
      sticker_id: big(message.stickerId),
    }),
  };
  return tasksRequest(requestId, firstTaskId, [send, markReadTask(message.threadId, message.nowMs)], version);
}

/** Thả cảm xúc đứng tên Page lên một tin (`emoji` rỗng = gỡ). Mỗi tin có hàng đợi riêng. */
export function reactionRequest(
  requestId: number, taskId: number, reaction: { threadId: string; messageId: string; pageId: string; emoji: string; nowMs: number },
  version = FALLBACK_LS_VERSION,
): string {
  return taskRequest(requestId, taskId, '29', `reaction:${reaction.messageId}`, toJson({
    thread_key: big(reaction.threadId), timestamp_ms: big(Math.trunc(reaction.nowMs)), message_id: reaction.messageId, actor_id: big(reaction.pageId),
    reaction: reaction.emoji, reaction_style: null, sync_group: PAGE_MAILBOX_DB, send_attribution: 4456448, dataclass_params: null,
    attachment_fbid: null, offline_threading_id: null,
  }), version);
}

/** Đánh dấu đã đọc một hội thoại của Page tới mốc thời gian cho trước. */
export function markReadRequest(requestId: number, taskId: number, threadId: string, watermarkMs: number, version = FALLBACK_LS_VERSION): string {
  return tasksRequest(requestId, taskId, [markReadTask(threadId, watermarkMs)], version);
}

/** Xin đồng bộ một cơ sở dữ liệu: tiếp từ con trỏ đã có (loại 2), hoặc lần đầu kèm tham số đồng bộ (loại 1). */
export function syncRequest(requestId: number, database: number, cursor: string | null, syncParams: string | null, version = FALLBACK_LS_VERSION): string {
  return lsRequest(requestId, cursor ? 2 : 1, toJson({
    database, epoch_id: big(epochId()), failure_count: null, last_applied_cursor: cursor, sync_params: cursor ? null : syncParams, version: big(version),
  }));
}

/**
 * Xin một trang danh sách hội thoại của hộp thư Page: trang đầu, hoặc (có `before`) các hội thoại cũ hơn hội thoại đã cho,
 * tính theo thời điểm hoạt động cuối và id của nó.
 */
export function threadListRequest(
  requestId: number, taskId: number, cursor: string, version = FALLBACK_LS_VERSION, before?: { timestampMs: number; threadKey: string },
): string {
  return taskRequest(requestId, taskId, '313', 'trq', toJson({
    cursor, filter: 0, is_after: 0, parent_thread_key: 0,
    reference_activity_timestamp: before ? big(Math.trunc(before.timestampMs)) : 9999999999999, reference_thread_key: before ? big(before.threadKey) : 0,
    secondary_filter: 24, filter_value: '', sync_group: PAGE_MAILBOX_DB,
  }), version);
}

/** Xin các tin cũ hơn một tin đã biết trong một hội thoại. */
export function historyRequest(
  requestId: number, taskId: number, from: { threadId: string; messageId: string; timestampMs: number }, cursor: string, version = FALLBACK_LS_VERSION,
): string {
  return taskRequest(requestId, taskId, '228', `mrq.${from.threadId}`, toJson({
    thread_key: big(from.threadId), direction: 0, reference_timestamp_ms: big(Math.trunc(from.timestampMs)), reference_message_id: from.messageId,
    sync_group: PAGE_MAILBOX_DB, cursor,
  }), version);
}

export interface InboxPageInfo {
  cursor: string | null; version: string | null; bloksVersion: string | null; deviceId: string | null;
  /** Mã phiên của trang (phiên tài khoản cá nhân ở business.facebook.com): cần cho việc tải tệp lên và các truy vấn của trang. */
  fbDtsg: string | null; lsd: string | null; jazoest: string | null;
}

/** Phiên web của hộp thư Page: đủ để gọi các địa chỉ HTTP của Business Suite (tải tệp lên, danh sách nhãn dán). */
export interface PageWebSession {
  pageId: string; userId: string; cookieHeader: string; agent?: unknown; fbDtsg: string; lsd: string | null; jazoest: string;
}

/**
 * Trang hộp thư Business Suite nhúng sẵn lần đồng bộ đầu của hộp thư Page: lấy con trỏ tiếp theo, phiên bản lược đồ,
 * bloks_version, mã thiết bị và mã phiên của trang. JSON trong trang lồng nhiều lớp nên dấu nháy có thể đi kèm một hay nhiều
 * dấu gạch chéo ngược.
 */
export function readInboxPage(html: string): InboxPageInfo {
  const q = String.raw`\\*"`;
  const i64 = String.raw`\[19,\s*${q}-?\d+${q}\]`;
  const cursor = new RegExp(String.raw`executeFirstBlockForSyncTransaction\w*${q},\s*\[19,\s*${q}${PAGE_MAILBOX_DB}${q}\],\s*${i64},\s*(?:\[9\]|${q}[^"\\]*${q}),\s*${q}([^"\\]+)${q}`).exec(html);
  const version = new RegExp(String.raw`${q}database${q}:${PAGE_MAILBOX_DB},.{0,600}?${q}version${q}:(\d+)`).exec(html);
  const bloks = new RegExp(String.raw`bloks_version${q}:${q}([0-9a-f]{64})`).exec(html);
  // Con trỏ trên là của lần đồng bộ máy chủ đã làm cho đúng mã thiết bị này: kết nối MQTT phải dùng lại nó.
  const device = /"MqttWebDeviceID",\[\],\{"clientID":"([0-9a-zA-Z-]{8,64})"/.exec(html);
  const fbDtsg = /"DTSGInitialData",\[\],\{"token":"([^"\\]+)"/.exec(html)?.[1] ?? null;
  const lsd = /"LSD",\[\],\{"token":"([^"\\]+)"/.exec(html)?.[1] ?? null;
  // Trang không in sẵn jazoest thì tính từ fb_dtsg như trình duyệt: "2" + tổng mã ký tự.
  const jazoest = /jazoest=(\d+)/.exec(html)?.[1] ?? (fbDtsg ? `2${[...fbDtsg].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)}` : null);
  return {
    cursor: cursor?.[1] ?? null, version: version?.[1] ?? null, bloksVersion: bloks?.[1] ?? null, deviceId: device?.[1] ?? null, fbDtsg, lsd, jazoest,
  };
}

export type FetchInboxPage = (pageId: string, cookieHeader: string, agent?: unknown) => Promise<{ status: number; html: string }>;

export const fetchInboxPage: FetchInboxPage = async (pageId, cookieHeader, agent) => {
  const res = await axios.get(`https://business.facebook.com/latest/inbox/all/?asset_id=${pageId}`, {
    headers: fbHeaders(cookieHeader), httpsAgent: agent, timeout: 30_000, maxRedirects: 5, validateStatus: () => true, responseType: 'text',
  });
  return { status: res.status, html: typeof res.data === 'string' ? res.data : '' };
};

export interface InboxClient {
  on(event: string, cb: (...args: any[]) => void): unknown;
  publish(topic: string, message: string, opts: { qos: 0 | 1 }): unknown;
  subscribe(topics: string[], opts: { qos: 0 | 1 }): unknown;
  end(force?: boolean): unknown;
}
export type ConnectInbox = (url: string, username: Record<string, unknown>, cookieHeader: string, agent?: unknown) => InboxClient;

// Cùng cách nối với FacebookMQTTListener (MQTT 3.1 qua WebSocket, không gửi subprotocol). Không để thư viện tự nối lại:
// FacebookPageInbox tự quản việc đó vì mỗi lần nối lại phải quyết định dùng con trỏ cũ hay tải lại trang.
export const connectInbox: ConnectInbox = (url, username, cookieHeader, agent) => mqtt.connect(url, {
  protocolId: 'MQIsdp', protocolVersion: 3, clientId: 'mqttwsclient', clean: true, keepalive: 15, connectTimeout: 20000, reconnectPeriod: 0,
  username: JSON.stringify(username),
  createWebsocket: (wsUrl: string) => new WebSocket(wsUrl, {
    headers: { Cookie: cookieHeader, Origin: ORIGIN, 'User-Agent': FB_USER_AGENT, Host: 'edge-chat.facebook.com' }, agent: agent as any,
  }) as any,
} as any) as unknown as InboxClient;
