import type { LinkStatus, PostStatsSnapshot, PostStatsGroupBy } from '../../../models/facebookPoster';

export interface LinkChip { label: string; cls: string; title: string }

/** Chip trạng thái link theo spec 7; null khi đã có link và không nghi bị xoá (không cần chip). */
export function linkChip(linkStatus: LinkStatus, removedSuspected: boolean): LinkChip | null {
  if (removedSuspected) return { label: 'Có thể đã bị xoá', cls: 'text-red-400 border-red-500/30', title: 'Bài từng thấy nhưng lần kiểm tra gần nhất không còn thấy' };
  switch (linkStatus) {
    case 'pending_approval': return { label: 'Chờ duyệt', cls: 'text-orange-400 border-orange-500/30', title: 'Bài đang chờ quản trị viên nhóm duyệt' };
    case 'missing': return { label: 'Chưa có link', cls: 'text-gray-400 border-gray-600', title: 'Chưa lấy được link bài, MaiHub sẽ thử lại' };
    case 'not_found': return { label: 'Không tìm thấy', cls: 'text-gray-400 border-gray-600', title: 'Đã thử hết các mốc nhưng không thấy bài trong nhóm' };
    default: return null;
  }
}

const num = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('vi-VN') : '—');

/** `👍 n · 💬 n · ↗ n` */
export function formatStatsLine(s: Pick<PostStatsSnapshot, 'reactions' | 'comments' | 'shares'>): string {
  return `👍 ${num(s.reactions)} · 💬 ${num(s.comments)} · ↗ ${num(s.shares)}`;
}

export const GROUP_BY_OPTIONS: { value: Extract<PostStatsGroupBy, 'group' | 'profile' | 'schedule'>; label: string }[] = [
  { value: 'group', label: 'Nhóm' },
  { value: 'profile', label: 'Profile' },
  { value: 'schedule', label: 'Lịch' },
];

export const RANGE_OPTIONS = [{ days: 7, label: '7 ngày' }, { days: 30, label: '30 ngày' }];

/** "30, 120, 360" thành [30, 120, 360]; null khi có phần tử không phải số nguyên dương hoặc danh sách rỗng. */
export function parseMinutesList(raw: string): number[] | null {
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

export const formatMinutesList = (list: number[]): string => list.join(', ');

/** Phút thành nhãn ngắn: 30 phút, 2 giờ, 3 ngày. */
export function minutesLabel(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} ngày`;
  if (min % 60 === 0) return `${min / 60} giờ`;
  return `${min} phút`;
}
