/**
 * relayAudience - Quyết định ai được nhận một sự kiện relay (thuần, không I/O).
 * Đóng mặc định: sự kiện gắn tài khoản mà thiếu mã tài khoản thì không tới ai.
 */
export type RelayAudience =
  | { kind: 'everyone' }
  | { kind: 'nobody' }
  | { kind: 'accounts'; ids: string[] }
  | { kind: 'employees'; ids: string[] }
  | { kind: 'module'; module: string };

/** Kênh gửi cho mọi nhân viên chỉ khi payload không mang mã tài khoản nào (có mã thì theo tài khoản như mọi kênh khác). */
export const GLOBAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'library:itemAdded',
  'library:itemUpdated',
  'library:itemDeleted',
]);

/** Kênh không gắn tài khoản mà thuộc một module: chỉ nhân viên có module đó nhận (HttpRelayService xác định danh sách). */
export const MODULE_RELAY_CHANNELS: ReadonlyMap<string, string> = new Map([
  ['workflow:executed', 'workflow'],
  ['integration:payment', 'integration'],
  ['integration:webhook', 'integration'],
]);

export function moduleForRelayChannel(channel: string): string | undefined {
  return MODULE_RELAY_CHANNELS.get(channel);
}

/** Sự kiện Facebook chuyển cho nhân viên theo Page (fbAccountId). Cố ý không có fb:onTyping, fb:onPresence: quá ồn. */
export const FACEBOOK_RELAY_CHANNELS: readonly string[] = [
  'fb:onMessage',
  'fb:onReaction',
  'fb:onSeen',
  'fb:onUnsend',
  'fb:onEdit',
  'fb:onContactUpdate',
  'fb:onThreadInfoUpdate',
  'fb:onConnectionStatus',
];

const ACCOUNT_KEYS = ['zaloId', 'zalo_id', 'ownerZaloId', 'owner_zalo_id', 'accountId', 'account_id', 'fbAccountId'];

const ACCOUNT_LIST_KEYS = ['zaloIds', 'ownerZaloIds'];

/** Mảng hoặc chuỗi phân cách bằng dấu phẩy. */
function asIds(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return parts.map((p) => asId(typeof p === 'string' ? p.trim() : p)).filter((p): p is string => !!p);
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function classifyRelayEvent(channel: string, data: unknown): RelayAudience {
  const payload = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  // Nhãn không gắn tài khoản nào áp dụng cho mọi tài khoản; cờ này chỉ có nghĩa trên kênh nhãn.
  if (channel === 'db:localLabelChanged' && payload.allAccounts === true) return { kind: 'everyone' };
  // Hợp của mọi mã tài khoản ở mọi khoá được nhận diện (không khoá nào "thắng" khoá khác).
  const ids = new Set<string>();
  for (const key of ACCOUNT_KEYS) { const id = asId(payload[key]); if (id) ids.add(id); }
  const nested = asId(payload.message?.zaloId);
  if (nested) ids.add(nested);
  for (const key of ACCOUNT_LIST_KEYS) asIds(payload[key]).forEach((id) => ids.add(id));
  if (ids.size) return { kind: 'accounts', ids: [...ids] };
  return GLOBAL_RELAY_CHANNELS.has(channel) ? { kind: 'everyone' } : { kind: 'nobody' };
}

export function canReceiveRelayEvent(audience: RelayAudience, employeeId: string, allowed: readonly string[], hasModule?: (module: string) => boolean): boolean {
  switch (audience.kind) {
    case 'everyone': return true;
    case 'employees': return audience.ids.includes(employeeId);
    case 'module': return hasModule?.(audience.module) === true;
    case 'accounts': return audience.ids.some((id) => allowed.includes(id));
    default: return false;
  }
}
