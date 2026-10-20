import type { CampaignStatus } from '../../../models/facebookPoster';

export type CampaignTone = 'success' | 'warning' | 'muted' | 'info';
export interface CampaignChip { label: string; tone: CampaignTone }

interface CampaignWindow { status: CampaignStatus; startAt: number | null; endAt: number | null }

/** Chip trạng thái theo spec 7: trạng thái do anh đặt trước, rồi mới xét khoảng ngày. */
export function campaignStatusChip(c: CampaignWindow, now: number): CampaignChip {
  if (c.status === 'archived') return { label: 'Lưu trữ', tone: 'muted' };
  if (c.status === 'paused') return { label: 'Tạm dừng', tone: 'warning' };
  if (c.startAt !== null && now < c.startAt) return { label: 'Chưa bắt đầu', tone: 'info' };
  if (c.endAt !== null && now > c.endAt) return { label: 'Đã kết thúc', tone: 'muted' };
  return { label: 'Đang chạy', tone: 'success' };
}

export const CAMPAIGN_TONE_CLASS: Record<CampaignTone, string> = {
  success: 'text-green-400 border-green-500/30',
  warning: 'text-orange-400 border-orange-500/30',
  info: 'text-blue-400 border-blue-500/30',
  muted: 'text-gray-400 border-gray-600',
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayLabel = (ms: number) => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };

export function formatCampaignRange(startAt: number | null, endAt: number | null): string {
  if (startAt === null && endAt === null) return 'Không giới hạn ngày';
  if (startAt !== null && endAt !== null) return `${dayLabel(startAt)} – ${dayLabel(endAt)}`;
  return startAt !== null ? `Từ ${dayLabel(startAt)}` : `Đến ${dayLabel(endAt as number)}`;
}

/** `YYYY-MM-DD` (input type=date) sang 00:00:00.000 giờ máy; null khi rỗng hoặc sai. */
export function dateInputToStartAt(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime() : null;
}

/** `YYYY-MM-DD` sang 23:59:59.999 giờ máy; null khi rỗng hoặc sai. */
export function dateInputToEndAt(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime() : null;
}

/** Epoch ms sang giá trị cho input type=date (giờ máy); '' khi null. */
export function toDateInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
