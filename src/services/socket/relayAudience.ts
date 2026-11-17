/**
 * relayAudience - Quyết định ai được nhận một sự kiện relay (thuần, không I/O).
 * Đóng mặc định: sự kiện gắn tài khoản mà thiếu mã tài khoản thì không tới ai.
 */
export type RelayAudience =
  | { kind: 'everyone' }
  | { kind: 'nobody' }
  | { kind: 'accounts'; ids: string[] }
  | { kind: 'employees'; ids: string[] }
  | { kind: 'module'; module: string }
  /** Sự kiện của Facebook Poster gắn hồ sơ trình duyệt: nhân viên nhận khi mọi hồ sơ nằm trong số được gán (kèm quyền fb_poster, do resolver bảo đảm). */
  | { kind: 'profiles'; ids: string[] };

/** Kênh chỉ có giá trị tức thời: phát trực tiếp, không vào bộ đệm nhận bù. */
export const EPHEMERAL_RELAY_CHANNELS: ReadonlySet<string> = new Set([
  'event:typing',
  'event:userPresence',
  'event:telegramEntityHydrated', // đợt hydrate thành viên nhóm dồn dập: không để chúng đẩy sự kiện thật ra khỏi bộ đệm
  'event:groupMemberAvatar',
  'fb:onTyping',
  'fb:onPresence',
  'facebookPoster:log', // nhật ký và tiến độ của lượt đăng dồn dập; trạng thái cuối đã có ở runFinished và ở lần tải lại
  'facebookPoster:progress',
  'facebookPoster:trackProgress', // progress of background jobs; their ...Finished events stay buffered
  'facebookPoster:commentCollectProgress',
  // facebookPoster:loginCheckProgress is NOT here: its final `null` is the only "check finished" signal, so it must be replayed
]);

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

/**
 * Sự kiện Facebook Poster chuyển cho nhân viên (posterRelayEvents.ts quyết định ai nhận và gửi gì).
 * Cố ý không có scheduleMissed, browserProfile:*, engagement.*, autonomy.*: chỉ boss.
 */
export const POSTER_RELAY_CHANNELS: readonly string[] = [
  'facebookPoster:log',
  'facebookPoster:progress',
  'facebookPoster:runFinished',
  'facebookPoster:schedulesChanged',
  'facebookPoster:loginStateChanged',
  'facebookPoster:loginCheckProgress',
  'facebookPoster:leadsFound',
  'facebookPoster:trackProgress',
  'facebookPoster:trackFinished',
  'facebookPoster:commentCollectProgress',
  'facebookPoster:commentCollectFinished',
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

/** Hợp của mọi mã tài khoản ở mọi khoá được nhận diện (không khoá nào "thắng" khoá khác). */
export function relayEventAccountIds(data: unknown): string[] {
  const payload = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  const ids = new Set<string>();
  for (const key of ACCOUNT_KEYS) { const id = asId(payload[key]); if (id) ids.add(id); }
  const nested = asId(payload.message?.zaloId);
  if (nested) ids.add(nested);
  for (const key of ACCOUNT_LIST_KEYS) asIds(payload[key]).forEach((id) => ids.add(id));
  return [...ids];
}

export function classifyRelayEvent(channel: string, data: unknown): RelayAudience {
  const payload = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  // Nhãn không gắn tài khoản nào áp dụng cho mọi tài khoản; cờ này chỉ có nghĩa trên kênh nhãn.
  if (channel === 'db:localLabelChanged' && payload.allAccounts === true) return { kind: 'everyone' };
  const ids = new Set(relayEventAccountIds(payload));
  if (ids.size) return { kind: 'accounts', ids: [...ids] };
  return GLOBAL_RELAY_CHANNELS.has(channel) ? { kind: 'everyone' } : { kind: 'nobody' };
}

export function canReceiveRelayEvent(
  audience: RelayAudience, employeeId: string, allowed: readonly string[], hasModule?: (module: string) => boolean, allowedProfiles?: readonly string[],
): boolean {
  switch (audience.kind) {
    case 'everyone': return true;
    case 'employees': return audience.ids.includes(employeeId);
    case 'module': return hasModule?.(audience.module) === true;
    case 'accounts': return audience.ids.some((id) => allowed.includes(id));
    case 'profiles': return audience.ids.length > 0 && !!allowedProfiles && audience.ids.every((id) => allowedProfiles.includes(id));
    default: return false;
  }
}
