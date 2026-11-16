/**
 * THỬ NGHIỆM, sẽ gỡ sau khi có kết quả: bridge Go có nối được dưới danh nghĩa một Page hay không
 * (cookie của tài khoản cha cộng `i_user` của Page), có nhận tin trực tiếp và tải được lịch sử không.
 * Chỉ chạy khi app được mở với MAIHUB_FB_PAGE_BRIDGE_PROBE=1. Chỉ ghi log: không lưu tin, không gửi gì,
 * không đăng ký thiết bị mã hoá. Log không bao giờ chứa nội dung tin.
 */
import axios from 'axios';
import Logger from '../../utils/Logger';
import { FacebookE2EEBridge } from './FacebookE2EEBridge';
import { fbHeaders } from './FacebookSession';
import { parseCookieString, resolveE2EEBinaryPath } from './FacebookUtils';

type ProbeBridge = Pick<FacebookE2EEBridge, 'on' | 'spawn' | 'newClient' | 'connect' | 'fetchMessages' | 'close'>;

const BRIDGE_COOKIE_NAMES = ['c_user', 'xs', 'datr', 'fr', 'sb', 'i_user'];
const tail = (id: unknown, n = 4) => `…${String(id ?? '').replace(/@.*$/, '').slice(-n)}`;

export const isPageBridgeProbeEnabled = (): boolean => process.env.MAIHUB_FB_PAGE_BRIDGE_PROBE === '1';

/** Cookie cho bridge của một Page; null nếu không phải cookie Page hoặc thiếu cookie đăng nhập. */
export function pageBridgeCookies(cookie: string): Record<string, string> | null {
  const all = parseCookieString(cookie);
  if (!all.i_user || !all.c_user || !all.xs) return null;
  const picked: Record<string, string> = {};
  for (const name of BRIDGE_COOKIE_NAMES) if (all[name]) picked[name] = all[name];
  return picked;
}

/** Tóm tắt một sự kiện của bridge, không có nội dung tin. */
export function describeProbeEvent(evt: any): string {
  const data = evt?.data;
  if (evt?.type === 'message') {
    return `message id=${tail(data?.id, 6)} thread=${tail(data?.threadId)} sender=${tail(data?.senderId)} hasText=${!!data?.text}`
      + ` attachments=${Array.isArray(data?.attachments) ? data.attachments.length : 0} isHistory=${!!data?.isHistory}`;
  }
  if (evt?.type === 'raw') {
    const tables = data?.type === 'LSTable' && data.data && typeof data.data === 'object' ? ` tables=${Object.keys(data.data).join(',')}` : '';
    return `raw ${data?.from}/${data?.type}${tables}`;
  }
  return String(evt?.type);
}

/** Các trang hộp thư thử tải bằng cookie của Page, để biết Facebook phục vụ Page ở đâu. */
const INBOX_PAGES = ['https://www.facebook.com/messages/', 'https://www.messenger.com/', 'https://business.facebook.com/latest/inbox/all'];
const PAGE_MARKERS = ['CurrentUserInitialData', 'MessengerWebInitData', 'LSPlatformGraphQLLightspeedRequest', 'MWChat', 'BizInbox', 'checkpoint', 'login_form'];

type FetchedPage = { status: number; finalUrl: string; html: string };

/** Dấu hiệu của một trang hộp thư: danh tính Facebook ghi trong trang và vài mốc nhận dạng. Không có nội dung trang. */
export function describeInboxPage(html: string, finalUrl: string, status: number): string {
  const ids = (name: string) => {
    const found = [...new Set([...html.matchAll(new RegExp(`"${name}":"(\\d+)"`, 'g'))].map(m => m[1]))].slice(0, 5);
    return found.length ? found.map(id => (id === '0' ? '0' : tail(id))).join(',') : '-';
  };
  let url = '?';
  try { const u = new URL(finalUrl); url = u.host + u.pathname; } catch { /* giữ '?' */ }
  const markers = PAGE_MARKERS.filter(m => html.includes(m));
  return `page status=${status} url=${url} len=${html.length} userIds=${ids('USER_ID')} accountIds=${ids('ACCOUNT_ID')} markers=${markers.join(',') || '-'}`;
}

async function fetchInboxPage(url: string, cookieHeader: string): Promise<FetchedPage> {
  const res = await axios.get(url, { headers: fbHeaders(cookieHeader), timeout: 30_000, maxRedirects: 5, validateStatus: () => true, responseType: 'text' });
  return { status: res.status, finalUrl: res.request?.res?.responseUrl || url, html: typeof res.data === 'string' ? res.data : '' };
}

export async function runPageBridgeProbe(
  accountId: string,
  cookie: string,
  deps: { createBridge?: () => ProbeBridge; fetchPage?: (url: string, cookieHeader: string) => Promise<FetchedPage> } = {},
): Promise<{ close: () => Promise<void> } | null> {
  const cookies = pageBridgeCookies(cookie);
  if (!cookies) return null;
  const tag = `[PageBridgeProbe:${accountId.slice(0, 8)}]`;
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  // Đối chứng: cùng trang, cookie của tài khoản cha (bỏ i_user), để biết khác biệt là do i_user chứ không do cách tải.
  const parentHeader = Object.entries(cookies).filter(([k]) => k !== 'i_user').map(([k, v]) => `${k}=${v}`).join('; ');
  const pages: Array<[string, string, string]> = [
    ...INBOX_PAGES.map((url): [string, string, string] => [url, cookieHeader, url.replace('https://', '')]),
    [INBOX_PAGES[0], parentHeader, 'control(no i_user) www.facebook.com/messages/'],
  ];
  for (const [url, header, where] of pages) {
    await (deps.fetchPage ?? fetchInboxPage)(url, header)
      .then(p => Logger.log(`${tag} ${where} -> ${describeInboxPage(p.html, p.finalUrl, p.status)}`))
      .catch((err: Error) => Logger.log(`${tag} ${where} -> fetch failed: ${err.message}`));
  }
  const bridge = (deps.createBridge ?? (() => FacebookE2EEBridge.create(resolveE2EEBinaryPath())))();
  let historyAsked = false;
  bridge.on('error', (err: Error) => Logger.log(`${tag} bridge error: ${err.message}`));
  bridge.on('event', (evt: any) => {
    Logger.log(`${tag} ${describeProbeEvent(evt)}`);
    const threadId = String(evt?.data?.threadId ?? '').replace(/@.*$/, '');
    if (evt?.type !== 'message' || evt.data?.isHistory || historyAsked || !/^\d+$/.test(threadId)) return;
    historyAsked = true; // một lần: đủ để biết lịch sử có tải được không
    bridge.fetchMessages({ threadId, beforeTimestampMs: 0, beforeMessageId: '' })
      .then(page => Logger.log(`${tag} history thread=${tail(threadId)} messages=${page?.messages?.length ?? 0} hasMoreBefore=${!!page?.hasMoreBefore}`))
      .catch((err: Error) => Logger.log(`${tag} history failed: ${err.message}`));
  });
  try {
    bridge.spawn();
    await bridge.newClient({ cookies, logLevel: 'error', e2eeMemoryOnly: true });
    const info: any = await bridge.connect(30_000);
    const userId = String(info?.user?.id ?? '');
    Logger.log(`${tag} connected user=${tail(userId)} asPage=${userId === cookies.i_user}`);
    return { close: () => bridge.close().catch(() => {}) };
  } catch (err: any) {
    Logger.log(`${tag} connect failed: ${err?.message}`);
    await bridge.close().catch(() => {});
    return null;
  }
}
