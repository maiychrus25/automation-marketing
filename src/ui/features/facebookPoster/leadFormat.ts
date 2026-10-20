import type { FbPosterLead, LeadStatus } from '../../../models/facebookPoster';

export type LeadTone = 'info' | 'warning' | 'success' | 'muted';
export interface LeadChip { label: string; cls: string }

const TONE_CLASS: Record<LeadTone, string> = {
  info: 'text-blue-400 border-blue-500/30',
  warning: 'text-orange-400 border-orange-500/30',
  success: 'text-green-400 border-green-500/30',
  muted: 'text-gray-400 border-gray-600',
};

const STATUS_META: Record<LeadStatus, { label: string; tone: LeadTone }> = {
  new: { label: 'Mới', tone: 'info' },
  contacted: { label: 'Đã liên hệ', tone: 'warning' },
  won: { label: 'Chốt đơn', tone: 'success' },
  ignored: { label: 'Bỏ qua', tone: 'muted' },
};

export const LEAD_STATUS_OPTIONS: { value: LeadStatus; label: string }[] =
  (Object.keys(STATUS_META) as LeadStatus[]).map((value) => ({ value, label: STATUS_META[value].label }));

export function leadStatusChip(status: LeadStatus): LeadChip {
  const meta = STATUS_META[status];
  return { label: meta.label, cls: TONE_CLASS[meta.tone] };
}

/** "giá, ib · SĐT · AI 82": từ khoá khớp, số điện thoại, điểm AI; "—" khi không có gì. */
export function formatLeadMatch(lead: Pick<FbPosterLead, 'matched' | 'aiScore'>): string {
  const keywords = lead.matched.filter((m) => m !== 'phone');
  const parts: string[] = [];
  if (keywords.length) parts.push(keywords.join(', '));
  if (lead.matched.includes('phone')) parts.push('SĐT');
  if (lead.aiScore !== null) parts.push(`AI ${lead.aiScore}`);
  return parts.length ? parts.join(' · ') : '—';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Thời điểm bình luận là ước tính từ nhãn tương đối nên luôn có "~"; "—" khi không đọc được. */
export function formatLeadTime(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `~${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "giá, ib, còn hàng" thành danh sách từ khoá (bỏ ô rỗng); kiểm độ dài do server. */
export function parseKeywordText(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
