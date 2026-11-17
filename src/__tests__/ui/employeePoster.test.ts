import {
  EMPLOYEE_POSTER_SECTIONS, visiblePosterSections, posterSectionFor, canOpenView, formatFileSize,
  POSTER_EMPLOYEE_NOTICE, POSTER_HISTORY_EMPLOYEE_NOTICE, POSTER_NO_PROFILE_NOTICE,
  showsNoProfileNotice, sameProfileIds, profileIdsKey, joinFileNames, redactPaths, REDACT_MAX_LENGTH, EMPLOYEE_POSTER_RELOAD_DEBOUNCE_MS, keepAssigned, keepSelectedChannels,
} from '../../ui/lib/employeePoster';

const ALL = ['schedule', 'campaigns', 'video', 'join', 'comments', 'leads', 'research', 'engagement', 'history'].map((id) => ({ id, label: id }));

describe('employeePoster', () => {
  it('lists the six employee sections in the boss order', () => {
    expect(EMPLOYEE_POSTER_SECTIONS).toEqual(['schedule', 'campaigns', 'join', 'comments', 'leads', 'history']);
  });

  describe('visiblePosterSections', () => {
    it('shows an employee exactly the six sections, in the original order', () => {
      expect(visiblePosterSections(ALL, true).map((s) => s.id)).toEqual(['schedule', 'campaigns', 'join', 'comments', 'leads', 'history']);
    });
    it('keeps the item objects and shows the boss every section', () => {
      expect(visiblePosterSections(ALL, false)).toEqual(ALL);
      expect(visiblePosterSections(ALL, true)[0]).toBe(ALL[0]);
    });
  });

  describe('posterSectionFor', () => {
    it('sends a hidden section of an employee to schedule', () => {
      for (const s of ['video', 'research', 'engagement', 'unknown', '']) expect(posterSectionFor(s, true)).toBe('schedule');
    });
    it('keeps an allowed section for an employee and every section for the boss', () => {
      for (const s of EMPLOYEE_POSTER_SECTIONS) expect(posterSectionFor(s, true)).toBe(s);
      for (const s of ['video', 'research', 'engagement', 'history']) expect(posterSectionFor(s, false)).toBe(s);
    });
  });

  describe('canOpenView', () => {
    const all = () => true;
    const none = () => false;
    it('lets an employee open facebookPoster only with fb_poster', () => {
      const asked: string[] = [];
      expect(canOpenView('facebookPoster', true, (m) => { asked.push(m); return m === 'fb_poster'; })).toBe(true);
      expect(asked).toEqual(['fb_poster']);
      expect(canOpenView('facebookPoster', true, none)).toBe(false);
    });
    it('never lets an employee open browser, even with every permission', () => {
      expect(canOpenView('browser', true, all)).toBe(false);
    });
    it('leaves the boss and every other view to the existing guard', () => {
      expect(canOpenView('browser', false, none)).toBe(true);
      expect(canOpenView('facebookPoster', false, none)).toBe(true);
      expect(canOpenView('chat', true, none)).toBe(true);
      expect(canOpenView('dashboard', true, none)).toBe(true);
    });
  });

  describe('formatFileSize', () => {
    it('formats bytes, KB and MB', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(999)).toBe('999 B');
      expect(formatFileSize(2048)).toBe('2.0 KB');
      expect(formatFileSize(5 * 1024 * 1024 + 512 * 1024)).toBe('5.5 MB');
    });
    it('tolerates a missing or invalid size', () => {
      expect(formatFileSize(undefined)).toBe('');
      expect(formatFileSize(-1)).toBe('');
      expect(formatFileSize(NaN)).toBe('');
    });
  });

  it('keeps the fixed Vietnamese notices verbatim', () => {
    expect(POSTER_EMPLOYEE_NOTICE).toBe('Lượt chạy diễn ra trên máy Boss, dùng hồ sơ được gán cho bạn.');
    expect(POSTER_HISTORY_EMPLOYEE_NOTICE).toBe('Chỉ hiện các lượt chạy dùng hồ sơ của bạn, trong 1000 lượt gần nhất.');
    expect(POSTER_NO_PROFILE_NOTICE).toBe('Bạn chưa được gán hồ sơ đăng Facebook nào. Hãy nhờ Boss gán hồ sơ cho bạn.');
  });

  describe('showsNoProfileNotice', () => {
    it('is true only for an employee with zero assigned profiles', () => {
      expect(showsNoProfileNotice(true, 0)).toBe(true);
      expect(showsNoProfileNotice(true, 1)).toBe(false);
      expect(showsNoProfileNotice(false, 0)).toBe(false);
      expect(showsNoProfileNotice(false, 3)).toBe(false);
    });
  });

  describe('sameProfileIds / profileIdsKey', () => {
    it('compares by content, not by identity or order', () => {
      expect(sameProfileIds(['a', 'b'], ['b', 'a'])).toBe(true);
      expect(sameProfileIds([], [])).toBe(true);
      expect(sameProfileIds(['a'], ['a', 'b'])).toBe(false);
      expect(sameProfileIds(['a', 'b'], ['a', 'c'])).toBe(false);
      expect(sameProfileIds(['a', 'a'], ['a', 'b'])).toBe(false);
    });
    it('gives equal keys for equal content', () => {
      expect(profileIdsKey(['b', 'a'])).toBe(profileIdsKey(['a', 'b']));
      expect(profileIdsKey(['a'])).not.toBe(profileIdsKey(['a', 'b']));
      expect(profileIdsKey([])).toBe('');
    });
  });

  describe('file names for employees', () => {
    it('joinFileNames drops directories of both separators', () => {
      expect(joinFileNames(['/Users/boss/Pictures/a.jpg', 'C:\\Users\\boss\\b.mp4', 'plain.png'])).toBe('a.jpg, b.mp4, plain.png');
      expect(joinFileNames([])).toBe('');
    });
    it('redactPaths turns absolute paths into names and keeps links', () => {
      expect(redactPaths('Không đọc được /Users/boss/Pictures/a.jpg do lỗi')).toBe('Không đọc được a.jpg do lỗi');
      expect(redactPaths('ENOENT C:\\Users\\boss\\b.mp4.')).toBe('ENOENT b.mp4.');
      expect(redactPaths('Mở https://www.facebook.com/groups/123/posts/4 xong')).toBe('Mở https://www.facebook.com/groups/123/posts/4 xong');
      expect(redactPaths('Lỗi tải 1/2 bài')).toBe('Lỗi tải 1/2 bài');
    });

    it('redactPaths handles folders with spaces (macOS "Application Support", user names)', () => {
      expect(redactPaths('/Users/bossuser/Library/Application Support/MaiHub/media/x.jpg')).toBe('x.jpg');
      expect(redactPaths('Không đọc được /Users/Boss User/Library/Application Support/MaiHub/facebook-poster-media/abc/01-anh.png do lỗi'))
        .toBe('Không đọc được 01-anh.png do lỗi');
      expect(redactPaths('ENOENT C:\\Users\\Boss User\\AppData\\Roaming\\MaiHub\\b.mp4.')).toBe('ENOENT b.mp4.');
      expect(redactPaths('/Users/boss.user/Library/x.jpg')).toBe('x.jpg');
      expect(redactPaths('a /tmp/a b/x.jpg và /tmp/y.log xong')).toBe('a x.jpg và y.log xong');
    });

    it('redactPaths never leaves the home folder name of a path without a file extension', () => {
      const posix = redactPaths('Mở /Users/Boss User/Library/Application Support/MaiHub/browser-profiles/abc');
      expect(posix).not.toContain('Boss User');
      expect(posix).not.toContain('/Users');
      const win = redactPaths('Mở C:\\Users\\Boss User\\AppData\\Roaming\\MaiHub\\profiles');
      expect(win).not.toContain('Boss User');
      expect(win).not.toContain('C:');
    });

    it('redactPaths does not treat a slash after a Vietnamese letter as the start of a path', () => {
      expect(redactPaths('Lỗi đã/chưa đăng, xem thư mục ảnh/b.png xong')).toBe('Lỗi đã/chưa đăng, xem thư mục ảnh/b.png xong');
    });

    it('redactPaths stays fast on a very long text of slashes and cuts the result', () => {
      const long = 'Đích không hợp lệ: ' + '/a '.repeat(80_000);
      const started = Date.now();
      const out = redactPaths(long);
      expect(Date.now() - started).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(REDACT_MAX_LENGTH + 1);
      expect(out.endsWith('…')).toBe(true);
      expect(redactPaths('x'.repeat(REDACT_MAX_LENGTH))).toBe('x'.repeat(REDACT_MAX_LENGTH));
    });

    it('redactPaths leaves ordinary text and links with file names alone', () => {
      expect(redactPaths('đọc / ghi tệp a/b.txt')).toBe('đọc / ghi tệp a/b.txt');
      expect(redactPaths('Ảnh https://scontent.fbcdn.net/v/t1/abc.jpg?x=1 lỗi')).toBe('Ảnh https://scontent.fbcdn.net/v/t1/abc.jpg?x=1 lỗi');
    });
  });

  it('debounces employee reloads by 250 ms', () => {
    expect(EMPLOYEE_POSTER_RELOAD_DEBOUNCE_MS).toBe(250);
  });

  describe('assignment change (U5)', () => {
    it('keepAssigned drops ids that are no longer assigned and keeps order', () => {
      expect(keepAssigned(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
      expect(keepAssigned(['a'], [])).toEqual([]);
    });
    it('keepAssigned returns the same array when nothing is dropped', () => {
      const ids = ['a', 'b'];
      expect(keepAssigned(ids, ['a', 'b', 'z'])).toBe(ids);
    });
    it('keepSelectedChannels keeps null, drops unassigned ids and returns to all (null) when none are left', () => {
      expect(keepSelectedChannels(null, ['a'])).toBeNull();
      expect(keepSelectedChannels(['a', 'b'], ['b'])).toEqual(['b']);
      expect(keepSelectedChannels(['a'], ['b'])).toBeNull();
      expect(keepSelectedChannels([], ['b'])).toEqual([]);
    });
  });
});
