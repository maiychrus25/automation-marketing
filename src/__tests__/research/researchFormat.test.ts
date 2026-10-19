import { errorLabel, formatCount, formatRate, parseBoundedInt, parseUrlList } from '../../ui/features/facebookPoster/researchFormat';

test('nhãn mã lỗi tiếng Việt, mã lạ giữ nguyên', () => {
  expect(errorLabel('logged_out')).toBe('Hết phiên');
  expect(errorLabel('no_profile_available')).toBe('Hết profile dùng được');
  expect(errorLabel('zzz')).toBe('zzz');
});

test('tỉ lệ và số: null là —', () => {
  expect(formatRate(0.0123)).toBe('1.23%');
  expect(formatRate(null)).toBe('—');
  expect(formatCount(null)).toBe('—');
  expect(formatCount(0)).toBe('0');
});

test('parseBoundedInt kiểm tra khoảng', () => {
  expect(parseBoundedInt('200', 1, 500)).toBe(200);
  expect(parseBoundedInt('501', 1, 500)).toBeNull();
  expect(parseBoundedInt('', 1, 500)).toBeNull();
  expect(parseBoundedInt('1.5', 1, 500)).toBeNull();
});

test('parseUrlList bỏ rỗng và trùng', () => {
  expect(parseUrlList('a\n\n b ,a')).toEqual(['a', 'b']);
});
