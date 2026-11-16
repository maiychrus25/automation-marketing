/**
 * Chạy chương trình `step` trong một phản hồi lightspeed của Messenger (topic /ls_resp) và trả về các lời gọi thủ tục
 * theo đúng thứ tự. Viết từ giao thức quan sát được trên hộp thư Page của Business Suite (11/2026).
 *
 * Máy chủ gửi lệnh kiểm tra phía máy khách ("tin đã có chưa, chưa có thì chèn"). Ở đây không có cơ sở dữ liệu máy khách
 * của Messenger, nên mọi kiểm tra coi là "được" và nhánh chèn luôn chạy; việc chống trùng do cơ sở dữ liệu của app
 * quyết định theo mã tin.
 */

export type LsValue = string | number | boolean | null;
export interface LsCall { name: string; args: LsValue[] }

const BLOCK = 1, LOAD = 2, STORE = 3, STORE_ARRAY = 4, CALL = 5, UNDEFINED = 9, I64_FROM_STRING = 19, IF = 23, NOT = 26;
// Phép tạo mảng / map / cộng số: chỉ dùng để dựng tham số phụ mà app không đọc, coi như trống và không báo.
const IGNORED_VALUE_STEPS = new Set([50, 51, 52, 53, 54, 55, 69]);

const isTruthy = (v: LsValue): boolean =>
  v === true || (typeof v === 'number' && v > 0) || (typeof v === 'string' && /^\d+$/.test(v) && !/^0+$/.test(v));

export function decodeLightspeed(step: unknown, onUnknownStep?: (type: number) => void): LsCall[] {
  const calls: LsCall[] = [];
  const vars = new Map<unknown, LsValue>();

  const run = (node: unknown): LsValue => {
    if (!Array.isArray(node)) {
      return typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' ? node : null;
    }
    const [type, ...rest] = node;
    switch (type) {
      case BLOCK:
        rest.forEach(run);
        return null;
      case LOAD:
        return vars.get(rest[0]) ?? null;
      case STORE:
        vars.set(rest[0], run(rest[1]));
        return null;
      case STORE_ARRAY: // [4, biến, giá trị, ...các bước]: đặt biến (kết quả của lệnh kiểm tra) rồi chạy các bước
        vars.set(rest[0], typeof rest[1] === 'number' ? rest[1] : null);
        rest.slice(2).forEach(run);
        return null;
      case CALL:
        if (typeof rest[0] === 'string') calls.push({ name: rest[0], args: rest.slice(1).map(run) });
        return null;
      case UNDEFINED:
        return null;
      case I64_FROM_STRING:
        return typeof rest[0] === 'string' || typeof rest[0] === 'number' ? String(rest[0]) : null;
      case IF:
        if (isTruthy(run(rest[0]))) run(rest[1]);
        else if (rest.length > 2) run(rest[2]);
        return null;
      case NOT: // giữ nguyên giá trị: "chưa có" coi là đúng để nhánh chèn chạy (xem chú thích đầu tệp)
        return run(rest[0]);
      default:
        if (typeof type === 'number' && !IGNORED_VALUE_STEPS.has(type)) onUnknownStep?.(type);
        return null;
    }
  };

  run(step);
  return calls;
}
