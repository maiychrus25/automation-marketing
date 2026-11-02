import type { FbPosterEngagementItem } from '../../models/facebookPoster';
import {
  ENGAGEMENT_FILTERS, approvePayload, canCancel, cardRows, classifyActionError, draftError, expiryLabel, statusesFor, mergeItems,
} from '../../ui/features/facebookPoster/engagementView';

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const item = (patch: Partial<FbPosterEngagementItem> = {}): FbPosterEngagementItem => ({
  id: 7, profileId: 'p1', kind: 'comment', postUrl: 'https://www.facebook.com/groups/1/posts/2', postKey: 'k', targetCommentId: '', targetAuthor: '',
  targetExcerpt: '', postExcerpt: 'Ai biết cách chọn máy lọc nước?', suggestedText: 'Anh chị nên xem lưu lượng trước nhé', approvedText: '',
  reason: 'Bài hỏi đúng chủ đề Page', sourceRef: '', status: 'pending', rejectReason: '', resultReason: '', suggestedAt: NOW - HOUR, expiresAt: NOW + 3 * HOUR + 20 * 60_000,
  decidedAt: null, postedAt: null, reservationId: null, ...patch,
});

describe('engagementView', () => {
  test('cardRowsShowExpiryAndKind', () => {
    const rows = cardRows(item(), { p1: 'Page Mai' }, NOW);
    expect(rows).toEqual([
      { label: 'Profile', value: 'Page Mai' },
      { label: 'Kiểu', value: 'Bình luận mới' },
      { label: 'Bài', value: 'Ai biết cách chọn máy lọc nước?' },
      { label: 'Lý do của bot', value: 'Bài hỏi đúng chủ đề Page' },
      { label: 'Còn lại', value: '3 giờ 20 phút' },
    ]);
    // Unknown profile falls back to its id; reply items show the target comment.
    const reply = cardRows(item({ kind: 'reply', targetAuthor: 'Lan', targetExcerpt: 'Giá bao nhiêu?', reason: '' }), {}, NOW);
    expect(reply[0]).toEqual({ label: 'Profile', value: 'p1' });
    expect(reply[1]).toEqual({ label: 'Kiểu', value: 'Trả lời bình luận' });
    expect(reply).toContainEqual({ label: 'Bình luận được trả lời', value: 'Lan: Giá bao nhiêu?' });
    expect(reply.map((r) => r.label)).not.toContain('Lý do của bot');
    expect(expiryLabel(NOW + 12 * 60_000, NOW)).toBe('12 phút');
    expect(expiryLabel(NOW + 30_000, NOW)).toBe('dưới 1 phút');
    expect(expiryLabel(NOW - 1, NOW)).toBe('Đã hết hạn');
    expect(expiryLabel(NOW + 2 * HOUR, NOW)).toBe('2 giờ');
  });

  test('cardRowsOfFinishedItemShowResultNotCountdown', () => {
    const rows = cardRows(item({ status: 'failed', resultReason: 'cannot_comment', approvedText: 'x' }), {}, NOW);
    expect(rows.map((r) => r.label)).not.toContain('Còn lại');
    expect(rows).toContainEqual({ label: 'Kết quả', value: 'Lỗi: cannot_comment' });
    expect(cardRows(item({ status: 'rejected', rejectReason: 'Không hợp' }), {}, NOW)).toContainEqual({ label: 'Kết quả', value: 'Đã bỏ: Không hợp' });
    expect(cardRows(item({ status: 'posted' }), {}, NOW)).toContainEqual({ label: 'Kết quả', value: 'Đã đăng' });
  });

  test('approvePayloadCarriesSingleIdAndEditedText', () => {
    const it = item();
    expect(approvePayload(it, it.suggestedText)).toEqual({ id: 7 });
    expect(approvePayload(it, `  ${it.suggestedText}  `)).toEqual({ id: 7 });
    expect(approvePayload(it, 'Câu đã sửa')).toEqual({ id: 7, text: 'Câu đã sửa' });
    expect(Object.keys(approvePayload(it, 'Câu đã sửa')).sort()).toEqual(['id', 'text']);
  });

  test('linkInEditedTextShowsFieldError', () => {
    expect(draftError('Xem thêm tại https://abc.com')).toMatch(/link/);
    expect(draftError('vào shop.vn nhé')).toMatch(/link/);
    expect(draftError('   ')).toMatch(/1–600/);
    expect(draftError('a'.repeat(601))).toMatch(/1–600/);
    expect(draftError('Câu bình thường')).toBe('');
    // Server errors route to the field (text) or to the limit message.
    expect(classifyActionError('Câu bình luận không được chứa link')).toEqual({ kind: 'field', message: 'Câu bình luận không được chứa link' });
    expect(classifyActionError('Câu bình luận phải dài 1–600 ký tự').kind).toBe('field');
    const limit = classifyActionError('Đã hết lượt trong ngày cho thao tác này');
    expect(limit.kind).toBe('limit');
    // The engagement cap and the shared facebookActionsPerDay cap refuse with the same message: name both.
    expect(limit.message).toMatch(/^Hết lượt hôm nay \(trần bình luận được duyệt hoặc tổng thao tác Facebook của profile\)/);
    expect(classifyActionError('Gợi ý không còn chờ duyệt')).toEqual({ kind: 'general', message: 'Gợi ý không còn chờ duyệt' });
    expect(classifyActionError(undefined)).toEqual({ kind: 'general', message: 'Không thực hiện được' });
  });

  test('cancelIsOfferedOnlyForApprovedNotYetPosting', () => {
    expect(canCancel(item({ status: 'approved' }))).toBe(true);
    for (const status of ['pending', 'posting', 'posted', 'failed', 'uncertain', 'skipped', 'rejected', 'expired'] as const)
      expect(canCancel(item({ status }))).toBe(false);
  });

  test('filtersByStatus', () => {
    expect(ENGAGEMENT_FILTERS.map((f) => f.label)).toEqual(['Chờ duyệt', 'Đã duyệt', 'Đã đăng', 'Đã bỏ', 'Hết hạn', 'Lỗi']);
    expect(statusesFor('pending')).toEqual(['pending']);
    expect(statusesFor('approved')).toEqual(['approved', 'posting']);
    expect(statusesFor('problem')).toEqual(['failed', 'uncertain', 'skipped']);
    // No status is hidden from every tab.
    const covered = new Set(ENGAGEMENT_FILTERS.flatMap((f) => statusesFor(f.key)));
    for (const s of ['pending', 'approved', 'posting', 'posted', 'skipped', 'failed', 'uncertain', 'rejected', 'expired']) expect(covered.has(s as never)).toBe(true);
    // Merging per-status pages sorts newest suggestion first, pending oldest-expiry first.
    const a = item({ id: 1, suggestedAt: 10 }); const b = item({ id: 2, suggestedAt: 30 });
    expect(mergeItems('approved', [a, b]).map((i) => i.id)).toEqual([2, 1]);
    const c = item({ id: 3, expiresAt: 500 }); const d = item({ id: 4, expiresAt: 100 });
    expect(mergeItems('pending', [c, d]).map((i) => i.id)).toEqual([4, 3]);
  });
});
