import type { EngagementStatus, FbPosterEngagementItem } from '../../../models/facebookPoster';
import { validateEngagementText } from '../../../services/facebookPoster/engagementRules';

// Logic thuần của mục "Chờ duyệt" (spec 2026-11-02 §10): tách khỏi React để test trong môi trường node.

export type EngagementFilterKey = 'pending' | 'approved' | 'posted' | 'rejected' | 'expired' | 'problem';

const FILTER_STATUSES: Record<EngagementFilterKey, EngagementStatus[]> = {
  pending: ['pending'],
  approved: ['approved', 'posting'],
  posted: ['posted'],
  rejected: ['rejected'],
  expired: ['expired'],
  problem: ['failed', 'uncertain', 'skipped'],
};

export const ENGAGEMENT_FILTERS: { key: EngagementFilterKey; label: string }[] = [
  { key: 'pending', label: 'Chờ duyệt' },
  { key: 'approved', label: 'Đã duyệt' },
  { key: 'posted', label: 'Đã đăng' },
  { key: 'rejected', label: 'Đã bỏ' },
  { key: 'expired', label: 'Hết hạn' },
  { key: 'problem', label: 'Lỗi' },
];

/** `engagement:list` nhận một trạng thái mỗi lần; tab gom nhiều trạng thái thì gọi từng cái rồi `mergeItems`. */
export const statusesFor = (key: EngagementFilterKey): EngagementStatus[] => FILTER_STATUSES[key];

/** Chờ duyệt: sắp hết hạn trước; các tab còn lại: mới gợi ý trước. */
export function mergeItems(key: EngagementFilterKey, items: FbPosterEngagementItem[]): FbPosterEngagementItem[] {
  return [...items].sort(key === 'pending' ? (a, b) => a.expiresAt - b.expiresAt : (a, b) => b.suggestedAt - a.suggestedAt);
}

export function expiryLabel(expiresAt: number, now: number): string {
  const minutes = Math.floor((expiresAt - now) / 60_000);
  if (expiresAt <= now) return 'Đã hết hạn';
  if (minutes < 1) return 'dưới 1 phút';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} giờ` : '', m ? `${m} phút` : ''].filter(Boolean).join(' ');
}

const KIND_LABELS = { comment: 'Bình luận mới', reply: 'Trả lời bình luận' } as const;

function resultLabel(item: FbPosterEngagementItem): string {
  switch (item.status) {
    case 'rejected': return item.rejectReason ? `Đã bỏ: ${item.rejectReason}` : 'Đã bỏ';
    case 'expired': return 'Hết hạn, chưa duyệt';
    case 'approved': case 'posting': return 'Đã duyệt, đang chờ đăng';
    case 'posted': return 'Đã đăng';
    case 'failed': return `Lỗi: ${item.resultReason || 'không rõ'}`;
    case 'skipped': return `Bỏ qua: ${item.resultReason || 'không rõ'}`;
    case 'uncertain': return `Chưa rõ đã đăng chưa: ${item.resultReason || 'cần kiểm tra trên Facebook'}`;
    default: return '';
  }
}

export interface CardRow { label: string; value: string }

/** Các dòng thông tin của thẻ; thẻ đang chờ hiện đếm ngược, thẻ đã xử lý hiện kết quả. */
export function cardRows(item: FbPosterEngagementItem, names: Record<string, string>, now: number): CardRow[] {
  const rows: CardRow[] = [
    { label: 'Profile', value: names[item.profileId] || item.profileId },
    { label: 'Kiểu', value: KIND_LABELS[item.kind] ?? item.kind },
  ];
  if (item.postExcerpt) rows.push({ label: 'Bài', value: item.postExcerpt });
  if (item.kind === 'reply' && (item.targetExcerpt || item.targetAuthor)) {
    rows.push({ label: 'Bình luận được trả lời', value: [item.targetAuthor, item.targetExcerpt].filter(Boolean).join(': ') });
  }
  if (item.reason) rows.push({ label: 'Lý do của bot', value: item.reason });
  rows.push(item.status === 'pending' ? { label: 'Còn lại', value: expiryLabel(item.expiresAt, now) } : { label: 'Kết quả', value: resultLabel(item) });
  return rows;
}

/** Chỉ huỷ được khi đã duyệt mà chưa bắt đầu đăng (`posting` có thể đã bấm gửi). */
export const canCancel = (item: FbPosterEngagementItem): boolean => item.status === 'approved';

/** Đúng một `id`; `text` chỉ có khi anh sửa khác câu gợi ý. */
export function approvePayload(item: FbPosterEngagementItem, draft: string): { id: number; text?: string } {
  const text = draft.trim();
  return text === item.suggestedText.trim() ? { id: item.id } : { id: item.id, text };
}

/** Cùng quy tắc với máy chủ (1–600 ký tự, không link); rỗng nghĩa là hợp lệ. */
export function draftError(draft: string): string {
  try { validateEngagementText(draft); return ''; } catch (err) { return err instanceof Error ? err.message : 'Câu không hợp lệ'; }
}

export interface ActionError { kind: 'field' | 'limit' | 'general'; message: string }

/** IPC chỉ trả chuỗi lỗi: nhận ra lỗi câu (hiện dưới ô câu) và lỗi hết lượt theo nội dung thông báo của máy chủ. */
export function classifyActionError(message: string | undefined): ActionError {
  if (!message) return { kind: 'general', message: 'Không thực hiện được' };
  if (/^Câu bình luận /.test(message)) return { kind: 'field', message };
  if (/hết lượt trong ngày/.test(message)) {
    // Trần bình luận được duyệt và trần tổng thao tác Facebook từ chối cùng một câu nên nêu cả hai.
    return { kind: 'limit', message: 'Hết lượt hôm nay (trần bình luận được duyệt hoặc tổng thao tác Facebook của profile). Anh thử lại vào ngày mai hoặc tăng trần ở Cài đặt > Tự vận hành.' };
  }
  return { kind: 'general', message };
}
