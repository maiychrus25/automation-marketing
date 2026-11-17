import { CHANNEL } from './channelHelper';

export type AssignableGroupKey = 'zalo' | 'facebook_page' | 'telegram' | 'facebook_personal';

export interface AssignableGroup<T> {
  key: AssignableGroupKey;
  label: string;
  assignable: boolean;
  note?: string;
  accounts: T[];
}

type AccountLike = { zalo_id: string; channel?: string | null; parent_zalo_id?: string | null };

const GROUPS: { key: AssignableGroupKey; label: string; assignable: boolean; note?: string }[] = [
  { key: 'zalo', label: 'Zalo', assignable: true },
  { key: 'facebook_page', label: 'Page Facebook', assignable: true },
  { key: 'telegram', label: 'Telegram', assignable: true },
  { key: 'facebook_personal', label: 'Facebook cá nhân', assignable: false, note: 'Chưa mở cho nhân viên' },
];

function groupKeyOf(a: AccountLike): AssignableGroupKey {
  if (a.channel === CHANNEL.FACEBOOK) return a.parent_zalo_id ? 'facebook_page' : 'facebook_personal';
  if (a.channel === CHANNEL.TELEGRAM_USER || a.channel === CHANNEL.TELEGRAM_BOT) return 'telegram';
  return 'zalo'; // kênh lạ hoặc thiếu channel (dòng Zalo cũ) vẫn gán được như Zalo
}

/** Chia tài khoản theo kênh để boss gán cho nhân viên; nhóm rỗng bị bỏ. */
export function groupAssignableAccounts<T extends AccountLike>(accounts: readonly T[]): AssignableGroup<T>[] {
  return GROUPS
    .map((g) => ({ ...g, accounts: accounts.filter((a) => groupKeyOf(a) === g.key) }))
    .filter((g) => g.accounts.length > 0);
}

export function assignableAccountIds<T extends AccountLike>(accounts: readonly T[]): string[] {
  return groupAssignableAccounts(accounts).filter((g) => g.assignable).flatMap((g) => g.accounts.map((a) => a.zalo_id));
}
