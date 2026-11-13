// Port sát từ babyvibe/deplao-builder (MIT) src/services/zalo/mobileSync/zcaMobileSync.ts @2162f07
/**
 * Mở rộng zca-js cho tính năng "đồng bộ lịch sử từ điện thoại", không fork thư viện:
 *   - 3 lệnh đăng ký qua điểm mở rộng chính thức `api.custom(...)`.
 *   - Sự kiện điều khiển `act_type="syncmsgmb"` (WS cmd 601) đọc bằng listener phụ gắn vào websocket của zca-js.
 * Endpoint/params bám theo Zalo Web (zpw_type=30, client mà zca-js giả lập).
 */
import Logger from '../../../utils/Logger';
import { decodeWsEventData } from '../zaloReadElsewhere';

/** pc_name mà Zalo Web gửi lên — điện thoại hiển thị tên này và trả lại trong các sự kiện. */
export const DEFAULT_SYNC_PC_NAME = 'Web';

const CMD_CONTROL = 601;
const SYNC_ACT_TYPE = 'syncmsgmb';
const ZNOISE_FALLBACK_URL = 'https://zwid.api.zalo.me/api/znoise';

/** act: 'user_confirm' | 'transfer_error' | 'syncmsg_info' | khác. */
export interface SyncEvent {
  type: 'user_confirm' | 'transfer_error' | 'syncmsg_info' | string;
  data: any;
}

export interface MobileSyncApi {
  pullMobile(p: { public_key: string; pc_name: string; from_seq_id: number; min_seq_id: number }): Promise<unknown>;
  cancelPullMobile(p: { public_key: string; pc_name: string }): Promise<unknown>;
  getNoisedIds(p: { uids: string[]; gids: string[] }): Promise<{ uids: string[]; gids: string[] }>;
}

/**
 * pull_mobile_msg / cancel_pull_mobile_msg trả `data` rỗng → resolve của zca-js có thể lỗi khi JSON.parse
 * chuỗi rỗng. Server đã nhận yêu cầu nếu error_code ngoài cùng = 0.
 */
async function resolveLenient(utils: any, response: any): Promise<any> {
  const copy = typeof response?.clone === 'function' ? response.clone() : null;
  try {
    return await utils.resolve(response);
  } catch (err) {
    let json: any = null;
    try { json = copy ? await copy.json() : null; } catch { /* không phải JSON */ }
    if (json && Number(json.error_code) === 0) return null;
    throw err;
  }
}

/** zca-js chỉ lưu service map ở `api.zpwServiceMap` — `ctx.zpwServiceMap` có trong type nhưng không bao giờ được gán. */
function serviceDomain(api: any, ctx: any, key: 'file' | 'profile'): string {
  const domain = api?.zpwServiceMap?.[key]?.[0]
    || ctx?.loginInfo?.zpw_service_map_v3?.[key]?.[0]
    || ctx?.zpwServiceMap?.[key]?.[0];
  if (!domain) throw new Error(`Thiếu ${key} service domain`);
  return domain;
}

function normalizeNoised(list: any, expected: number, stripGroupPrefix: boolean): string[] {
  const arr = Array.isArray(list) ? list : [];
  const out: string[] = [];
  for (let i = 0; i < expected; i++) {
    let v = arr[i] == null ? '' : String(arr[i]);
    if (stripGroupPrefix && v.startsWith('g')) v = v.slice(1);
    out.push(v === '0' ? '' : v);
  }
  return out;
}

/** `api.custom` định nghĩa property không ghi đè được (đăng ký lần 2 sẽ ném) nên mỗi lệnh chỉ cài khi chưa có. */
export function installMobileSyncApis(api: any): MobileSyncApi {
  if (!api || typeof api.custom !== 'function') {
    throw new Error('zca-js API không hỗ trợ api.custom (cần zca-js >= 2.0)');
  }
  const define = (name: string, fn: (arg: any) => Promise<any>) => {
    if (typeof api[name] !== 'function') api.custom(name, fn);
  };

  define('pullMobile', async ({ ctx, utils, props }: any) => {
    const fileDomain = serviceDomain(api, ctx, 'file');
    const encrypted = utils.encodeAES(JSON.stringify({
      pc_name: props.pc_name,
      public_key: props.public_key,
      from_seq_id: props.from_seq_id ?? 0,
      is_retry: props.is_retry ?? 0,
      min_seq_id: props.min_seq_id ?? 0,
      temp_key: props.temp_key ?? '',
      imei: ctx.imei,
    }));
    if (!encrypted) throw new Error('Không mã hoá được params pullMobile');
    const url = utils.makeURL(`${fileDomain}/api/message/pull_mobile_msg`, { params: encrypted });
    return resolveLenient(utils, await utils.request(url, { method: 'GET' }));
  });

  define('cancelPullMobile', async ({ ctx, utils, props }: any) => {
    const fileDomain = serviceDomain(api, ctx, 'file');
    const encrypted = utils.encodeAES(JSON.stringify({
      pc_name: props.pc_name,
      public_key: props.public_key,
      imei: ctx.imei,
    }));
    if (!encrypted) throw new Error('Không mã hoá được params cancelPullMobile');
    const url = utils.makeURL(`${fileDomain}/api/message/cancel_pull_mobile_msg`, { params: encrypted });
    return resolveLenient(utils, await utils.request(url, { method: 'GET' }));
  });

  define('getNoisedIds', async ({ ctx, utils, props }: any) => {
    const uids: string[] = props.uids || [];
    const gids: string[] = props.gids || [];
    if (uids.length === 0 && gids.length === 0) return { uids: [], gids: [] };

    const payload: Record<string, number[]> = {};
    if (uids.length) payload.fids = uids.map(id => Number.parseInt(id, 10));
    if (gids.length) payload.gids = gids.map(id => Number.parseInt(id, 10));
    const encrypted = utils.encodeAES(JSON.stringify(payload));
    if (!encrypted) throw new Error('Không mã hoá được params getNoisedIds');

    let data: any;
    try {
      // Zalo Web: GET {profile}/api/znoise
      const url = utils.makeURL(`${serviceDomain(api, ctx, 'profile')}/api/znoise`, { params: encrypted });
      data = await utils.resolve(await utils.request(url, { method: 'GET' }));
    } catch (err: any) {
      // Zalo PC: POST https://zwid.api.zalo.me/api/znoise
      Logger.warn(`[MobileSync] znoise qua profile domain lỗi (${err?.name || 'Error'}) → thử zwid.api.zalo.me`);
      const url = utils.makeURL(ZNOISE_FALLBACK_URL);
      data = await utils.resolve(await utils.request(url, {
        method: 'POST',
        body: new URLSearchParams({ params: encrypted }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }));
    }
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = {}; }
    }
    return {
      uids: normalizeNoised(data?.fids, uids.length, false),
      gids: normalizeNoised(data?.gids, gids.length, true),
    };
  });

  return api as MobileSyncApi;
}

/** Các sự kiện syncmsgmb trong 1 frame WS; frame khác/ngắn → []. Không bao giờ ném; frame cmd 601 hỏng chỉ log tên lỗi (không log nội dung). */
export function extractSyncEvents(frame: Buffer, cipherKey: string | null | undefined): SyncEvent[] {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame[0] !== 1 || frame[3] !== 0) return [];
  if (frame.readUInt16LE(1) !== CMD_CONTROL) return [];
  const text = frame.subarray(4).toString('utf8');
  if (!text.includes('"data"')) return [];
  let decoded: any;
  try {
    decoded = decodeWsEventData(JSON.parse(text), cipherKey);
  } catch (err: any) {
    Logger.warn(`[MobileSync] Không giải mã được control event: ${err?.name || 'Error'}`);
    return [];
  }
  const controls: any[] = decoded?.data?.controls || decoded?.controls || [];
  const events: SyncEvent[] = [];
  for (const control of Array.isArray(controls) ? controls : []) {
    const content = control?.content;
    if (!content || content.act_type !== SYNC_ACT_TYPE) continue;
    let data = content.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* giữ nguyên chuỗi */ }
    }
    events.push({ type: String(content.act || 'unknown'), data });
  }
  return events;
}

/** Gắn handler vào websocket hiện tại của listener, gắn lại sau mỗi `connected` (zca-js tạo WebSocket mới). */
export function attachSyncEventListener(api: any, onEvent: (event: SyncEvent) => void): () => void {
  const listener = api?.listener;
  if (!listener || typeof listener.on !== 'function') return () => {};

  let boundWs: any = null;
  const onFrame = (data: any) => {
    // Chỉ cmd 601: kiểm tra header trước khi decode để không tốn chi phí cho tin thường.
    if (!Buffer.isBuffer(data) || data.length < 4 || data[0] !== 1 || data.readUInt16LE(1) !== CMD_CONTROL) return;
    try {
      for (const event of extractSyncEvents(data, listener.cipherKey)) onEvent(event);
    } catch (err: any) {
      // Chỉ log loại lỗi: message của JSON.parse có thể chứa đoạn nội dung frame.
      Logger.warn(`[MobileSync] Không đọc được control event: ${err?.name || 'Error'}`);
    }
  };
  const bind = () => {
    const ws = listener.ws;
    if (!ws || ws === boundWs || typeof ws.on !== 'function') return;
    boundWs?.off?.('message', onFrame);
    boundWs = ws;
    ws.on('message', onFrame);
  };

  listener.on('connected', bind);
  bind();
  return () => {
    listener.off?.('connected', bind);
    boundWs?.off?.('message', onFrame);
    boundWs = null;
  };
}
