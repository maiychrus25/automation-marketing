/**
 * THỬ NGHIỆM, sẽ gỡ sau khi có kết quả: bridge Go có nối được dưới danh nghĩa một Page hay không
 * (cookie của tài khoản cha cộng `i_user` của Page), có nhận tin trực tiếp và tải được lịch sử không.
 * Chỉ chạy khi app được mở với MAIHUB_FB_PAGE_BRIDGE_PROBE=1. Chỉ ghi log: không lưu tin, không gửi gì,
 * không đăng ký thiết bị mã hoá. Log không bao giờ chứa nội dung tin.
 */
import Logger from '../../utils/Logger';
import { FacebookE2EEBridge } from './FacebookE2EEBridge';
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

export async function runPageBridgeProbe(
  accountId: string,
  cookie: string,
  deps: { createBridge?: () => ProbeBridge } = {},
): Promise<{ close: () => Promise<void> } | null> {
  const cookies = pageBridgeCookies(cookie);
  if (!cookies) return null;
  const tag = `[PageBridgeProbe:${accountId.slice(0, 8)}]`;
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
