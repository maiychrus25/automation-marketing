/** Dữ liệu mẫu tự dựng cho các test hộp thư Page nối trực tiếp. Mọi id, chữ và đường dẫn đều giả. */
import { EventEmitter } from 'events';

export const USER = '100000000008724';
export const PAGE = '1000000000003955';
export const PEER = '100000000005141';
export const COOKIE = `c_user=${USER}; xs=tok; datr=d; fr=f; sb=s; wd=1x1; i_user=100000000004280`;
export const LOGIN_HEADER = `c_user=${USER}; xs=tok; datr=d; fr=f; sb=s`;
export const DEVICE = '11111111-2222-3333-4444-555555555555';
export const BLOKS = 'ab'.repeat(32);
export const PAGE_VERSION = '29437738132519999';
export const DTSG = 'DTSG-TOKEN:12:1700000000';
export const LSD = 'LSD-TOKEN';
export const JAZOEST = '25999';

// Trang hộp thư Business Suite nhúng sẵn kết quả đồng bộ đầu tiên của hộp thư Page (JSON lồng trong JSON nên dấu nháy bị thoát).
export const INBOX_HTML = `<script>["DTSGInitialData",[],{"token":"${DTSG}"},258],["LSD",[],{"token":"${LSD}"},323],{"sprinkle":"&jazoest=${JAZOEST}"}["MqttWebDeviceID",[],{"clientID":"${DEVICE}"},5003]{"variables":{"requestPayload":"{\\"database\\":205,\\"epoch_id\\":0,\\"last_applied_cursor\\":null,`
  + `\\"sync_params\\":\\"{\\\\\\"locale\\\\\\":\\\\\\"vi_VN\\\\\\",\\\\\\"bloks_version\\\\\\":\\\\\\"${BLOKS}\\\\\\"}\\",\\"version\\":${PAGE_VERSION}}","requestType":1}}`
  + `{"payload":"{\\"step\\":[1,[5,\\"executeFirstBlockForSyncTransactionV4\\",[19,\\"2\\"],[19,\\"1\\"],[9],\\"CONTACTS\\"],`
  + `[5,\\"executeFirstBlockForSyncTransactionV4\\",[19,\\"205\\"],[19,\\"7000000000000000001\\"],[9],\\"PAGECUR\\",[19,\\"1\\"]],[5,\\"upsertMessage\\",\\"SECRET TEXT\\"]]}"}</script>`;

export const i64 = (v: string | number) => [19, String(v)];

/** Một lời gọi thủ tục ở dạng dây, các trường đặt theo số thứ tự, phần còn lại là [9] (trống). */
export const wireCall = (name: string, fields: Record<number, unknown>) => {
  const args: unknown[] = Array(Math.max(-1, ...Object.keys(fields).map(Number)) + 1).fill([9]);
  for (const [i, v] of Object.entries(fields)) args[Number(i)] = v;
  return [5, name, ...args];
};

export const syncBlock = (database: number, nextCursor: string) =>
  wireCall('executeFirstBlockForSyncTransactionV4', { 0: i64(database), 1: i64('7000000000000000001'), 2: 'CUR0', 3: nextCursor, 4: i64(1), 5: i64(2) });

export const messageCall = (name: string, text: string, id: string, extra: Record<number, unknown> = {}) =>
  wireCall(name, { 0: text, 3: i64(PEER), 5: i64(1700000000000), 8: id, 10: i64(PEER), 12: false, 17: false, ...extra });

export const rangeCall = (threadId: string, minMessageId: string, minTimestampMs: number, hasMoreBefore: boolean) =>
  wireCall('insertNewMessageRange', { 0: i64(threadId), 3: minMessageId, 5: i64(minTimestampMs), 7: hasMoreBefore });

/** Dấu "hết tin cũ" của một hội thoại; referenceTs = mốc thời gian của yêu cầu mà nó trả lời (0 = không rõ). */
export const historyEndCall = (threadId: string, referenceTs = 0) =>
  wireCall('updateExistingMessageRange', { 0: i64(threadId), 1: i64(referenceTs), 2: true });

/** Thân một gói /ls_resp. requestId bỏ trống = phản hồi do máy chủ tự đẩy. */
export const lsResp = (calls: unknown[], requestId?: number) =>
  ({ request_id: requestId ?? null, sp: [], target: 3, payload: JSON.stringify({ name: null, step: [1, [1, ...calls]] }) });

export class FakeMqtt extends EventEmitter {
  publish = jest.fn();
  subscribe = jest.fn();
  end = jest.fn();
  receive(body: unknown) { this.emit('message', '/ls_resp', Buffer.from(JSON.stringify(body)), { qos: 0 }); }
  requests() { return this.publish.mock.calls.filter(c => c[0] === '/ls_req').map(c => JSON.parse(c[1])); }
  /** Nhãn của từng yêu cầu đã gửi: `sync1` / `sync2` cho đồng bộ, số nhãn cho tác vụ. */
  labels() { return this.requests().map(r => (r.type === 3 ? JSON.parse(r.payload).tasks[0].label : `sync${r.type}`)); }
  taskPayload(index: number) { return JSON.parse(JSON.parse(this.requests()[index].payload).tasks[0].payload); }
}
