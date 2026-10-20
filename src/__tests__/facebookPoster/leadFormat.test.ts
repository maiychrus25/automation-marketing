import { leadStatusChip, formatLeadMatch, formatLeadTime, parseKeywordText, LEAD_STATUS_OPTIONS } from '../../ui/features/facebookPoster/leadFormat';

describe('leadFormat', () => {
  test('status chip has a Vietnamese label per status', () => {
    expect(leadStatusChip('new').label).toBe('Mới');
    expect(leadStatusChip('contacted').label).toBe('Đã liên hệ');
    expect(leadStatusChip('won').label).toBe('Chốt đơn');
    expect(leadStatusChip('ignored').label).toBe('Bỏ qua');
    expect(LEAD_STATUS_OPTIONS.map((o) => o.value)).toEqual(['new', 'contacted', 'won', 'ignored']);
  });

  test('match line joins keywords, phone and AI score', () => {
    expect(formatLeadMatch({ matched: ['giá', 'ib', 'phone'], aiScore: 82 })).toBe('giá, ib · SĐT · AI 82');
    expect(formatLeadMatch({ matched: ['phone'], aiScore: null })).toBe('SĐT');
    expect(formatLeadMatch({ matched: ['giá'], aiScore: null })).toBe('giá');
    expect(formatLeadMatch({ matched: [], aiScore: null })).toBe('—');
  });

  test('time is estimated with a leading tilde, dash when unknown', () => {
    const at = new Date(2026, 9, 20, 14, 5).getTime();
    expect(formatLeadTime(at)).toBe('~20/10/2026 14:05');
    expect(formatLeadTime(null)).toBe('—');
  });

  test('keyword text splits on commas, trims and drops empties', () => {
    expect(parseKeywordText(' giá, ib ,, còn hàng ')).toEqual(['giá', 'ib', 'còn hàng']);
    expect(parseKeywordText('  ')).toEqual([]);
  });
});
