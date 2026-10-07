import { validateStartParams } from '../../services/facebookPoster/validateStartParams';

const env = {
  profileExists: (id: string) => id === 'p1' || id === 'p2',
  fileExists: (p: string) => p !== '/missing.jpg',
  fileSize: () => 1,
};

const post = (over: Record<string, unknown> = {}) => ({
  kind: 'post',
  params: { mode: 'group', text: 'hello', profiles: [{ profileId: 'p1', targets: ['123'] }], ...over },
});

const fails = (input: { kind?: unknown; params?: unknown }, message: string) =>
  expect(() => validateStartParams(input, env)).toThrow(new Error(message));

describe('validateStartParams: common', () => {
  test('unknown kind', () => {
    fails({ kind: 'nope', params: {} }, 'Loại việc không hợp lệ');
    fails({ params: {} }, 'Loại việc không hợp lệ');
  });
});

describe('validateStartParams: post', () => {
  test('valid group job gets defaults and normalized targets', () => {
    expect(validateStartParams(post(), env)).toEqual({
      kind: 'post', mode: 'group', text: 'hello', mediaPaths: [], comment: null,
      profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123/'] }],
      minDelaySec: 300, maxDelaySec: 900, concurrency: 3, staggerMinSec: 30, staggerMaxSec: 90,
    });
  });

  test('mode must be group or page', () => fails(post({ mode: 'x' }), 'Chế độ đăng không hợp lệ'));

  test('text must be non-empty', () => {
    fails(post({ text: '' }), 'Nội dung bài không được để trống');
    fails(post({ text: '  \n ' }), 'Nội dung bài không được để trống');
    fails(post({ text: 5 }), 'Nội dung bài không được để trống');
  });

  test('text length limit 63206', () => {
    expect(() => validateStartParams(post({ text: 'a'.repeat(63206) }), env)).not.toThrow();
    fails(post({ text: 'a'.repeat(63207) }), 'Nội dung bài tối đa 63206 ký tự');
  });

  test('comment limit 8000 and whitespace-only becomes null', () => {
    expect(() => validateStartParams(post({ comment: 'a'.repeat(8000) }), env)).not.toThrow();
    fails(post({ comment: 'a'.repeat(8001) }), 'Bình luận tối đa 8000 ký tự');
    expect((validateStartParams(post({ comment: '  \n' }), env) as any).comment).toBeNull();
    expect((validateStartParams(post({ comment: 'hi' }), env) as any).comment).toBe('hi');
  });

  test('profiles: none, unknown', () => {
    fails(post({ profiles: [] }), 'Chưa chọn profile');
    fails(post({ profiles: undefined }), 'Chưa chọn profile');
    fails(post({ profiles: [{ profileId: 'zz', targets: ['1'] }] }), 'Không tìm thấy profile');
  });

  test('page mode with zero profiles is rejected', () => fails(post({ mode: 'page', profiles: [] }), 'Chưa chọn profile'));

  test('group mode: profile with no targets', () => {
    fails(post({ profiles: [{ profileId: 'p1', targets: [] }] }), 'Profile "p1" chưa có nhóm nào');
    fails(post({ profiles: [{ profileId: 'p1', targets: ['  ', ''] }] }), 'Profile "p1" chưa có nhóm nào');
  });

  test('group mode: invalid target lines', () => {
    fails(post({ profiles: [{ profileId: 'p1', targets: ['ok1', 'bad id!'] }] }), 'Đích không hợp lệ: bad id!');
    fails(post({ profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/SomePage'] }] }), 'Đích không hợp lệ: https://www.facebook.com/SomePage');
    fails(post({ profiles: [{ profileId: 'p1', targets: [42 as any] }] }), 'Đích không hợp lệ: 42');
  });

  test('group mode accepts ids, slugs and group URLs', () => {
    const out = validateStartParams(post({ profiles: [{ profileId: 'p1', targets: ['my.group-1_x', 'https://www.facebook.com/groups/abc'] }] }), env) as any;
    expect(out.profiles[0].targets).toEqual(['https://www.facebook.com/groups/my.group-1_x/', 'https://www.facebook.com/groups/abc']);
  });

  test('duplicates within a profile collapse after normalization', () => {
    const out = validateStartParams(post({ profiles: [{ profileId: 'p1', targets: ['123', ' 123 ', 'https://www.facebook.com/groups/123/'] }] }), env) as any;
    expect(out.profiles[0].targets).toEqual(['https://www.facebook.com/groups/123/']);
  });

  test('same target in different profiles is kept for each', () => {
    const out = validateStartParams(post({ profiles: [{ profileId: 'p1', targets: ['1'] }, { profileId: 'p2', targets: ['1'] }] }), env) as any;
    expect(out.profiles.map((p: any) => p.targets.length)).toEqual([1, 1]);
  });

  test('total target limit 10000 counts after de-dup', () => {
    const ids = (n: number, start = 1) => Array.from({ length: n }, (_, i) => String(start + i));
    // 10,000 unique targets after de-duplication should pass.
    expect(() => validateStartParams(post({ profiles: [{ profileId: 'p1', targets: [...ids(5000), ...ids(5000)] }, { profileId: 'p2', targets: ids(5000) }] }), env)).not.toThrow();
    // 10,001 unique targets across profiles should fail.
    fails(post({ profiles: [{ profileId: 'p1', targets: ids(5001) }, { profileId: 'p2', targets: ids(5000, 5002) }] }), 'Tối đa 10000 đích cho một lần chạy');
  });

  test('page mode ignores targets', () => {
    const out = validateStartParams(post({ mode: 'page', profiles: [{ profileId: 'p1', targets: ['bad id!'] }, { profileId: 'p2' }] }), env) as any;
    expect(out.profiles).toEqual([
      { profileId: 'p1', targets: ['https://www.facebook.com/'] },
      { profileId: 'p2', targets: ['https://www.facebook.com/'] },
    ]);
  });

  test('mediaPaths: missing file and bad extension', () => {
    fails(post({ mediaPaths: ['/missing.jpg'] }), 'Không tìm thấy tệp ảnh/video');
    fails(post({ mediaPaths: ['/a/doc.pdf'] }), 'Chỉ hỗ trợ ảnh/video: jpg, jpeg, png, gif, webp, mp4, mov, webm');
    for (const ext of ['jpg', 'JPEG', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm']) {
      expect((validateStartParams(post({ mediaPaths: [`/a/f.${ext}`] }), env) as any).mediaPaths).toEqual([`/a/f.${ext}`]);
    }
  });

  test('mediaPaths: 10 files pass, duplicates collapse, 11 fail', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `/a/${i}.jpg`);
    expect((validateStartParams(post({ mediaPaths: ten }), env) as any).mediaPaths).toEqual(ten);
    expect((validateStartParams(post({ mediaPaths: ['/a/1.jpg', '/a/1.jpg'] }), env) as any).mediaPaths).toEqual(['/a/1.jpg']);
    fails(post({ mediaPaths: [...ten, '/a/10.jpg'] }), 'Tối đa 10 ảnh mỗi bài');
  });

  test('mediaPaths: sizes come from env.fileSize', () => {
    const big = { ...env, fileSize: () => 21 * 1024 * 1024 };
    expect(() => validateStartParams(post({ mediaPaths: ['/a/big.jpg'] }), big)).toThrow(new Error('Ảnh "big.jpg" lớn hơn 20 MB'));
  });

  test('legacy mediaPath becomes mediaPaths; null, empty and missing give []', () => {
    expect((validateStartParams(post({ mediaPath: '/x.jpg' }), env) as any).mediaPaths).toEqual(['/x.jpg']);
    expect((validateStartParams(post({ mediaPath: null }), env) as any).mediaPaths).toEqual([]);
    expect((validateStartParams(post({ mediaPath: '' }), env) as any).mediaPaths).toEqual([]);
    expect((validateStartParams(post(), env) as any).mediaPaths).toEqual([]);
  });

  test('delays', () => {
    const bad = 'Thời gian nghỉ không hợp lệ';
    fails(post({ minDelaySec: -1 }), bad);
    fails(post({ minDelaySec: 10, maxDelaySec: 5 }), bad);
    fails(post({ maxDelaySec: 86401 }), bad);
    fails(post({ minDelaySec: NaN }), bad);
    fails(post({ minDelaySec: '5' }), bad);
    // omitted max defaults to 900, so a larger explicit min is invalid
    fails(post({ minDelaySec: 1000 }), bad);
    const out = validateStartParams(post({ minDelaySec: 0, maxDelaySec: 86400 }), env) as any;
    expect([out.minDelaySec, out.maxDelaySec]).toEqual([0, 86400]);
  });

  test('stagger defaults to 30-90 s, accepts 0-0, rejects max < min or out of range', () => {
    const ok = validateStartParams(post(), env) as any;
    expect([ok.staggerMinSec, ok.staggerMaxSec]).toEqual([30, 90]);
    const zero = validateStartParams(post({ staggerMinSec: 0, staggerMaxSec: 0 }), env) as any;
    expect([zero.staggerMinSec, zero.staggerMaxSec]).toEqual([0, 0]);
    const bad = 'Giãn cách khởi động không hợp lệ';
    fails(post({ staggerMinSec: 50, staggerMaxSec: 10 }), bad);
    fails(post({ staggerMinSec: -1 }), bad);
    fails(post({ staggerMaxSec: 3601 }), bad);
    fails(post({ staggerMinSec: 'x' }), bad);
    const scan = validateStartParams({ kind: 'scan_groups', params: { profileIds: ['p1'], staggerMinSec: 5, staggerMaxSec: 5 } }, env) as any;
    expect([scan.staggerMinSec, scan.staggerMaxSec]).toEqual([5, 5]);
  });

  test('concurrency must be an integer 1-10', () => {
    const bad = 'Số profile song song phải từ 1 đến 10';
    for (const c of [0, 11, 2.5, NaN, '3']) fails(post({ concurrency: c }), bad);
    expect((validateStartParams(post({ concurrency: 10 }), env) as any).concurrency).toBe(10);
    expect((validateStartParams(post({ concurrency: 1 }), env) as any).concurrency).toBe(1);
  });

  test('duplicate profile ids are merged', () => {
    const out = validateStartParams(post({ profiles: [{ profileId: 'p1', targets: ['1'] }, { profileId: 'p1', targets: ['1', '2'] }] }), env) as any;
    expect(out.profiles).toEqual([{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] }]);
  });
});

describe('validateStartParams: scan_groups', () => {
  const scan = (over: Record<string, unknown> = {}) => ({ kind: 'scan_groups', params: { profileIds: ['p1', 'p2'], ...over } });

  test('valid with default concurrency', () => {
    expect(validateStartParams(scan(), env)).toEqual({ kind: 'scan_groups', profileIds: ['p1', 'p2'], concurrency: 3, staggerMinSec: 30, staggerMaxSec: 90 });
  });
  test('rejects no or unknown profiles and bad concurrency', () => {
    fails(scan({ profileIds: [] }), 'Chưa chọn profile');
    fails(scan({ profileIds: ['zz'] }), 'Không tìm thấy profile');
    fails(scan({ concurrency: 11 }), 'Số profile song song phải từ 1 đến 10');
  });
  test('duplicate ids collapse', () => {
    expect((validateStartParams(scan({ profileIds: ['p1', 'p1'] }), env) as any).profileIds).toEqual(['p1']);
  });
});

describe('validateStartParams: join', () => {
  const join = (over: Record<string, unknown> = {}) => ({ kind: 'join', params: { profileId: 'p1', keywords: ['  cooking ', '', 'cooking', 'travel'], ...over } });

  test('valid with defaults, trimmed de-duplicated keywords', () => {
    expect(validateStartParams(join(), env)).toEqual({ kind: 'join', profileId: 'p1', keywords: ['cooking', 'travel'], limit: 10, minDelaySec: 300, maxDelaySec: 900 });
  });
  test('unknown profile', () => fails(join({ profileId: 'zz' }), 'Không tìm thấy profile'));
  test('no keyword', () => {
    fails(join({ keywords: [] }), 'Chưa nhập từ khóa');
    fails(join({ keywords: [' ', ''] }), 'Chưa nhập từ khóa');
    fails(join({ keywords: undefined }), 'Chưa nhập từ khóa');
  });
  test('limit must be an integer 1-200', () => {
    for (const l of [0, 201, 1.5, NaN, '5']) fails(join({ limit: l }), 'Giới hạn nhóm phải từ 1 đến 200');
    expect((validateStartParams(join({ limit: 200 }), env) as any).limit).toBe(200);
  });
  test('delays validated', () => fails(join({ minDelaySec: 9, maxDelaySec: 1 }), 'Thời gian nghỉ không hợp lệ'));
  test('explicit 60-180 delays pass through', () => {
    const out = validateStartParams(join({ minDelaySec: 60, maxDelaySec: 180 }), env) as any;
    expect([out.minDelaySec, out.maxDelaySec]).toEqual([60, 180]);
  });
});

describe('validateStartParams: facebook-only group targets', () => {
  const withTarget = (t: string) => ({ kind: 'post', params: { mode: 'group', text: 'hi', profiles: [{ profileId: 'p1', targets: [t] }] } });
  test('rejects lookalike hosts and non-https', () => {
    for (const bad of ['https://evil.com/groups/x', 'https://www.facebook.com.evil.com/groups/x', 'http://www.facebook.com/groups/x', 'javascript:alert(1)']) {
      fails(withTarget(bad), `Đích không hợp lệ: ${bad}`);
    }
  });
  test('accepts m. and bare facebook.com', () => {
    expect((validateStartParams(withTarget('https://m.facebook.com/groups/x'), env) as any).profiles[0].targets).toEqual(['https://m.facebook.com/groups/x']);
    expect((validateStartParams(withTarget('https://facebook.com/groups/x'), env) as any).profiles[0].targets).toEqual(['https://facebook.com/groups/x']);
  });
});

describe('validateStartParams: collect_comments', () => {
  const collect = (over: Record<string, unknown> = {}) => ({ kind: 'collect_comments', params: { profileId: 'p1', postUrls: ['https://www.facebook.com/groups/1/posts/2/'], ...over } });

  test('valid', () => {
    expect(validateStartParams(collect(), env)).toEqual({ kind: 'collect_comments', profileId: 'p1', postUrls: ['https://www.facebook.com/groups/1/posts/2/'] });
  });
  test('unknown profile', () => fails(collect({ profileId: 'zz' }), 'Không tìm thấy profile'));
  test('no post url', () => {
    fails(collect({ postUrls: [] }), 'Chưa chọn bài');
    fails(collect({ postUrls: ['  '] }), 'Chưa chọn bài');
    fails(collect({ postUrls: undefined }), 'Chưa chọn bài');
  });
  test('urls are trimmed and de-duplicated', () => {
    expect((validateStartParams(collect({ postUrls: [' https://www.facebook.com/p/1 ', 'https://www.facebook.com/p/1', 'https://www.facebook.com/p/2'] }), env) as any).postUrls).toEqual(['https://www.facebook.com/p/1', 'https://www.facebook.com/p/2']);
  });
  test('rejects non-Facebook or non-https post urls', () => {
    for (const bad of ['https://evil.com/groups/x', 'https://www.facebook.com.evil.com/p/1', 'http://www.facebook.com/p/1', 'file:///etc/passwd', 'javascript:alert(1)']) {
      fails(collect({ postUrls: [bad] }), `Link bài không hợp lệ: ${bad}`);
    }
    expect((validateStartParams(collect({ postUrls: ['https://m.facebook.com/p/1'] }), env) as any).postUrls).toEqual(['https://m.facebook.com/p/1']);
  });
});
