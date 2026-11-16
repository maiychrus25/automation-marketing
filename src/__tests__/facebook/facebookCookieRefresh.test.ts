import { mergeRefreshedCookies, refreshedCookiesFrom } from '../../services/facebook/facebookCookieRefresh';

const NOW = Date.UTC(2026, 10, 16);
const COOKIE = 'c_user=100000000008724; xs=old-xs; datr=d1; fr=old-fr; wd=1x1';

describe('refreshedCookiesFrom', () => {
  test('readsNameAndValueAndIgnoresAttributes', () => {
    expect(refreshedCookiesFrom([
      'xs=new%3Axs; expires=Tue, 16-Nov-2027 00:00:00 GMT; Max-Age=31536000; path=/; domain=.facebook.com; secure; httponly',
      'fr=new-fr; Path=/; Domain=.facebook.com',
    ], NOW)).toEqual({ xs: 'new%3Axs', fr: 'new-fr' });
  });

  // Facebook xoá cookie khi đăng xuất bằng giá trị "deleted" và hạn trong quá khứ: không bao giờ được coi là giá trị mới.
  test('skipsDeletedExpiredAndEmptyCookies', () => {
    expect(refreshedCookiesFrom([
      'xs=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/',
      'fr=gone; Max-Age=-1',
      'sb=old; expires=Mon, 16-Nov-2020 00:00:00 GMT',
      'datr=; path=/',
      'no-equals-sign',
    ], NOW)).toEqual({});
  });

  test.each([[undefined], [null], ['xs=one-string'], [[]]])('toleratesOddHeaderShapes_%#', (headers) => {
    expect(() => refreshedCookiesFrom(headers as any, NOW)).not.toThrow();
  });
});

describe('mergeRefreshedCookies', () => {
  test('replacesSessionCookiesAddsMissingOnesAndKeepsTheRest', () => {
    const res = mergeRefreshedCookies(COOKIE, { xs: 'new-xs', fr: 'new-fr', sb: 's1' });
    expect(res.cookie).toBe('c_user=100000000008724; xs=new-xs; datr=d1; fr=new-fr; wd=1x1; sb=s1');
    expect(res.changed).toEqual(['xs', 'fr', 'sb']);
  });

  test('nothingNewMeansTheSameStringAndNoChange', () => {
    expect(mergeRefreshedCookies(COOKIE, { xs: 'old-xs', fr: 'old-fr' })).toEqual({ cookie: COOKIE, changed: [] });
    expect(mergeRefreshedCookies(COOKIE, {})).toEqual({ cookie: COOKIE, changed: [] });
  });

  // Chỉ nhận cookie của phiên; cookie quảng cáo / giao diện / chuyển Page (i_user) không được ghi vào cookie tài khoản.
  test('onlySessionCookiesAreTaken', () => {
    const res = mergeRefreshedCookies(COOKIE, { presence: 'p', wd: '9x9', i_user: '100000000004280', locale: 'vi_VN', xs: 'new-xs' });
    expect(res).toEqual({ cookie: COOKIE.replace('old-xs', 'new-xs'), changed: ['xs'] });
  });

  // Phản hồi của một tài khoản khác (hoặc trang đăng nhập) không được đổi cookie của tài khoản này.
  test('cookiesOfAnotherUserAreRejectedEntirely', () => {
    expect(mergeRefreshedCookies(COOKIE, { c_user: '100000000009999', xs: 'someone-else' })).toEqual({ cookie: COOKIE, changed: [] });
    expect(mergeRefreshedCookies(COOKIE, { c_user: '100000000008724', xs: 'mine' }).changed).toEqual(['xs']);
  });

  test('aCookieWithoutALoginIsLeftAlone', () => {
    expect(mergeRefreshedCookies('datr=d1', { xs: 'new-xs' })).toEqual({ cookie: 'datr=d1', changed: [] });
  });
});
