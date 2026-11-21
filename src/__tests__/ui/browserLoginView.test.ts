import { browserLoginStatusText } from '../../ui/lib/facebook/browserLoginView';

describe('browserLoginStatusText', () => {
  it('maps the five statuses', () => {
    expect(browserLoginStatusText('opening')).toBe('Đang mở trình duyệt…');
    expect(browserLoginStatusText('waiting')).toBe('Hãy đăng nhập Facebook trong cửa sổ trình duyệt vừa mở');
    expect(browserLoginStatusText('wrong_account')).toBe('Đang đăng nhập tài khoản Facebook khác. Hãy đăng xuất rồi đăng nhập đúng tài khoản này.');
    expect(browserLoginStatusText('check_failed')).toBe('Chưa dùng được phiên này');
    expect(browserLoginStatusText('saving')).toBe('Đang lưu cookie…');
  });
  it('appends detail to check_failed only', () => {
    expect(browserLoginStatusText('check_failed', 'hết hạn')).toBe('Chưa dùng được phiên này: hết hạn');
    expect(browserLoginStatusText('saving', 'x')).toBe('Đang lưu cookie…');
  });
  it('returns empty for unknown status', () => {
    expect(browserLoginStatusText('zzz')).toBe('');
  });
});
