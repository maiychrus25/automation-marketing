import { matchesKeywords } from '../../ui/features/facebookPoster/matchKeywords';

test('ô lọc rỗng hoặc chỉ dấu phẩy: hiện hết', () => {
  expect(matchesKeywords('Việc làm HN', '')).toBe(true);
  expect(matchesKeywords('Việc làm HN', ' , ,')).toBe(true);
});

test('không phân biệt dấu và hoa thường, đ = d', () => {
  expect(matchesKeywords('Việc làm Đà Nẵng', 'viec lam')).toBe(true);
  expect(matchesKeywords('Việc làm Đà Nẵng', 'DA NANG')).toBe(true);
});

test('nhiều từ khoá: khớp bất kỳ từ nào', () => {
  expect(matchesKeywords('Tuyển dụng IT', 'viec lam, tuyen dung')).toBe(true);
  expect(matchesKeywords('Mua bán xe', 'viec lam, tuyen dung')).toBe(false);
});
