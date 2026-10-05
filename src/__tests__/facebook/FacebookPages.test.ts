import {
  stripPageCookie, buildPageCookie, parseManagedPages, mergePageList, pickFBCookie, isOwnSender,
  FBAccountCookieRow, ManagedPage,
} from '../../services/facebook/FacebookPages';

const node = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, profile_picture: { uri: `https://cdn.example/${id}.jpg` }, unseen_message_count: 0, ...extra,
});

describe('stripPageCookie', () => {
  it('trả nguyên chuỗi khi không có i_user', () => {
    expect(stripPageCookie('c_user=100; xs=abc;')).toBe('c_user=100; xs=abc;');
  });
  it('bỏ mọi cặp i_user, giữ các cặp khác', () => {
    expect(stripPageCookie('c_user=100;i_user=615; xs=abc; i_user=999')).toBe('c_user=100; xs=abc');
  });
});

describe('buildPageCookie', () => {
  it('nối i_user vào cookie không có i_user', () => {
    expect(buildPageCookie('c_user=100; xs=abc', '61592412314280')).toBe('c_user=100; xs=abc; i_user=61592412314280');
  });
  it('thay i_user cũ, xử lý dấu ; cuối và khoảng trắng', () => {
    expect(buildPageCookie(' c_user=100 ; i_user=1;xs=abc; ', '61592412314280')).toBe('c_user=100; xs=abc; i_user=61592412314280');
  });
});

describe('parseManagedPages', () => {
  it('lấy Page từ nhiều chỗ xuất hiện khóa, khử trùng theo id, chịu được ngoặc và nháy trong tên', () => {
    const media = node('61592412314280', 'Media Soec', { delegate_page_id: '1254744041053955' });
    const ahv = node('61500000000001', 'AHV {Holding} "Careers"');
    const html = '<html><script type="application/json">'
      + `{"require":[["x",{"additional_profiles_with_biz_tools":{"edges":[{"node":${JSON.stringify(media)}},{"node":${JSON.stringify(ahv)}}]}}]]}`
      + '</script><script>'
      + `{"additional_profiles_with_biz_tools" : {"nodes":[${JSON.stringify(media)}]}}`
      + '</script></html>';
    expect(parseManagedPages(html)).toEqual<ManagedPage[]>([
      { profileId: '61592412314280', name: 'Media Soec', delegatePageId: '1254744041053955', avatarUrl: 'https://cdn.example/61592412314280.jpg' },
      { profileId: '61500000000001', name: 'AHV {Holding} "Careers"', delegatePageId: null, avatarUrl: 'https://cdn.example/61500000000001.jpg' },
    ]);
  });
  it('trả [] khi không có khóa', () => {
    expect(parseManagedPages('<html>không có gì</html>')).toEqual([]);
  });
  it('bỏ qua khóa không có dấu : theo sau', () => {
    expect(parseManagedPages('["additional_profiles_with_biz_tools",{"id":"1","name":"x"}]')).toEqual([]);
  });
  it('bỏ qua đoạn JSON hỏng nhưng vẫn đọc đoạn lành phía sau', () => {
    const html = '{"additional_profiles_with_biz_tools":{"edges":[{"node":{"id":"1","name":"x"]}}'
      + `<p>{"additional_profiles_with_biz_tools":{"nodes":[${JSON.stringify(node('615', 'Lành'))}]}}</p>`;
    expect(parseManagedPages(html).map((p) => p.profileId)).toEqual(['615']);
  });
  it('JSON bị cắt cụt thì trả []', () => {
    expect(parseManagedPages('{"additional_profiles_with_biz_tools":{"edges":[{"node":{"id":"1","name":"x"}')).toEqual([]);
  });
});

describe('mergePageList', () => {
  const remote: ManagedPage[] = [
    { profileId: '1', name: 'A', delegatePageId: null, avatarUrl: null },
    { profileId: '2', name: 'B', delegatePageId: 'd2', avatarUrl: 'u2' },
  ];
  it('đánh dấu enabled theo dòng con enabled = 1', () => {
    const out = mergePageList(remote, [{ facebook_id: '2', enabled: 1 }, { facebook_id: '1', enabled: 0 }]);
    expect(out.map((p) => [p.profileId, p.enabled])).toEqual([['1', false], ['2', true]]);
  });
  it('giữ Page đang bật đã mất quyền quản trị, lấy tên/ảnh từ DB', () => {
    const out = mergePageList(remote, [{ facebook_id: '9', name: 'Cũ', avatar_url: 'u9', delegate_page_id: 'd9', enabled: 1 }]);
    expect(out[2]).toEqual({ profileId: '9', name: 'Cũ', delegatePageId: 'd9', avatarUrl: 'u9', enabled: true });
  });
  it('không thêm Page đã tắt mà Facebook không còn trả', () => {
    expect(mergePageList(remote, [{ facebook_id: '9', enabled: 0 }])).toHaveLength(2);
  });
});

describe('pickFBCookie', () => {
  const parent: FBAccountCookieRow = { id: 'uuid-parent', facebook_id: '100', cookie_encrypted: 'c_user=100; xs=abc' };
  const page: FBAccountCookieRow = { id: 'uuid-page', facebook_id: '615', cookie_encrypted: '', parent_facebook_id: '100' };
  const read = (a: FBAccountCookieRow) => a.cookie_encrypted || null;
  const find = (rows: FBAccountCookieRow[]) => (fbId: string) => rows.find((r) => r.facebook_id === fbId);

  it('tài khoản cá nhân: đọc cookie đã lưu', () => {
    expect(pickFBCookie(parent, find([parent]), read)).toBe('c_user=100; xs=abc');
  });
  it('Page: dựng từ cookie cha tra bằng facebook_id (uuid cha đổi vẫn được)', () => {
    const reAdded = { ...parent, id: 'uuid-new' };
    expect(pickFBCookie(page, find([reAdded]), read)).toBe('c_user=100; xs=abc; i_user=615');
  });
  it('Page: không có cha hoặc cha không có cookie thì null', () => {
    expect(pickFBCookie(page, find([]), read)).toBeNull();
    expect(pickFBCookie(page, find([{ ...parent, cookie_encrypted: '' }]), read)).toBeNull();
  });
  it('Page: cha cũng là Page thì null', () => {
    expect(pickFBCookie(page, find([{ ...parent, parent_facebook_id: '1' }]), read)).toBeNull();
  });
});

describe('isOwnSender', () => {
  it('khớp FacebookID', () => expect(isOwnSender('615', '615', null)).toBe(true));
  it('khớp delegate_page_id', () => expect(isOwnSender('125', '615', '125')).toBe(true));
  it('không khớp', () => expect(isOwnSender('777', '615', '125')).toBe(false));
  it('userId rỗng không bao giờ là mình', () => {
    expect(isOwnSender('', '', '')).toBe(false);
    expect(isOwnSender(undefined, undefined, null)).toBe(false);
  });
});
