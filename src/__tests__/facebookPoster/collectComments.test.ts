import assert from 'node:assert';
import type { LogLevel } from '../../services/facebookPoster/types';
import {
  collectComments, keyOf, readCommentsInPage, hasCommentAreaInPage, countCommentsInPage, clickLabelInPage,
  MORE_COMMENTS, SORT_TRIGGER, SORT_ALL, type CollectedComment,
} from '../../services/facebookPoster/collectComments';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Nút giả: đếm số lần bị bấm. */
function fakeButton(text: string, { role = 'button', tag = 'div' } = {}) {
  const el: any = {
    tagName: tag.toUpperCase(), textContent: text, clickCount: 0,
    attrs: { role },
    getAttribute: (k: string) => (k in el.attrs ? el.attrs[k] : null),
    click: () => { el.clickCount += 1; },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
  };
  return el;
}

/** Khối bình luận giả. `nestedBlocks`: các khối phản hồi (do commentBlock
 * dựng sẵn) lồng bên trong — DOM thật lồng con trong cha, nên
 * querySelectorAll('a') của cha cũng trả về thẻ <a> của mọi khối con. */
function commentBlock({
  label, authorHref, authorName, parts = [], timeHref = null, timeText = '',
  nestedBlocks = [], timeFirst = false,
}: {
  label: string; authorHref: string | null; authorName: string;
  parts?: { text: string; inLink?: boolean; inButton?: boolean; otherBlock?: boolean }[];
  timeHref?: string | null; timeText?: string; nestedBlocks?: any[]; timeFirst?: boolean;
}) {
  const el: any = {
    tagName: 'DIV',
    attrs: { role: 'article', 'aria-label': label },
    getAttribute: (k: string) => (k in el.attrs ? el.attrs[k] : null),
  };
  // Link tác giả/thời gian của chính khối này: closest('div[role="article"]')
  // phải trả về chính el, để chốt lọc "thuộc khối này" trong mã thật khớp.
  const makeLink = (text: string, href: string) => ({
    tagName: 'A', textContent: text,
    getAttribute: (k: string) => (k === 'href' ? href : null),
    closest: (sel: string) => (sel === 'div[role="article"]' ? el : null),
  });
  const links: any[] = [];
  const authorLink = authorHref !== null ? makeLink(authorName, authorHref) : null;
  const timeLink = timeHref ? makeLink(timeText, timeHref) : null;
  // timeFirst: mô phỏng DOM thật nơi link thời gian đứng TRƯỚC link tác
  // giả trong thứ tự các thẻ <a> — để chứng minh chốt "bỏ qua link
  // comment_id" có tác dụng thật, không chỉ đúng vì link tác giả luôn được
  // querySelectorAll trả về trước.
  const order = timeFirst ? [timeLink, authorLink] : [authorLink, timeLink];
  for (const l of order) if (l) links.push(l);
  for (const child of nestedBlocks) links.push(...child.querySelectorAll('a'));
  const divs = parts.map(d => ({
    tagName: 'DIV', textContent: d.text,
    getAttribute: (k: string) => (k === 'dir' ? 'auto' : null),
    // closest trả về el nếu node thuộc khối này, trả về d.inLink/d.inButton
    // cho hai bộ lọc kia.
    closest: (sel: string) => {
      if (sel === 'a') return d.inLink ? { tagName: 'A' } : null;
      if (sel === '[role="button"]') return d.inButton ? { tagName: 'DIV' } : null;
      if (sel === 'div[role="article"]') return d.otherBlock ? { other: true } : el;
      return null;
    },
  }));
  el.querySelectorAll = (sel: string) => {
    if (sel === 'a') return links;
    if (sel === 'a[href*="comment_id"]') return links.filter(l => /comment_id/.test(l.getAttribute('href') || ''));
    if (sel === 'div[dir="auto"]') return divs;
    return [];
  };
  el.querySelector = (sel: string) => (sel.includes('comment_id') ? links.find(l => /comment_id/.test(l.getAttribute('href'))) || null : null);
  return el;
}

/** Đặt document giả, chạy fn, khôi phục. Không để lại rác cho test khác. */
function inPage<T>(nodes: any[], bodyText: string, fn: () => T): T {
  const g = global as any;
  const saved = g.document;
  g.document = {
    body: { textContent: bodyText },
    querySelectorAll: (sel: string) => {
      if (sel === 'div[role="article"]') {
        return nodes.filter(n => n.getAttribute('role') === 'article');
      }
      return nodes.filter(n => n.getAttribute('role') !== 'article');
    },
  };
  try {
    return fn();
  } finally {
    g.document = saved;
  }
}

const readAs = (selfId: string | null) => (): any[] => (readCommentsInPage as any)({ selfId });

test('đọc đúng tên, link, nội dung, thời gian', () => {
  const k = commentBlock({
    label: 'Bình luận của Nguyễn Văn A',
    authorHref: 'https://www.facebook.com/groups/111/user/789/?__cft__[0]=abc',
    authorName: 'Nguyễn Văn A',
    parts: [{ text: 'cho mình xin giá' }],
    timeHref: '/groups/111/posts/222/?comment_id=333',
    timeText: '2 giờ',
  });
  const out = inPage([k], '', readAs(null));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].authorName, 'Nguyễn Văn A');
  assert.strictEqual(out[0].authorId, '789');
  assert.strictEqual(out[0].authorUrl, 'https://www.facebook.com/789');
  assert.strictEqual(out[0].text, 'cho mình xin giá');
  assert.strictEqual(out[0].commentedAt, '2 giờ');
});

test('bỏ bài đăng: role=article nhưng aria-label không khớp', () => {
  const post = commentBlock({
    label: 'Bài viết của Cửa hàng ABC',
    authorHref: '/abc', authorName: 'Cửa hàng ABC', parts: [{ text: 'nội dung bài' }],
  });
  const out = inPage([post], '', readAs(null));
  assert.deepStrictEqual(out, []);
});

test('chuẩn hoá cả ba dạng link và cắt query', () => {
  const cases = [
    ['https://www.facebook.com/groups/1/user/55/?x=1', '55'],
    ['https://www.facebook.com/profile.php?id=66&sk=about', '66'],
    ['https://www.facebook.com/ten.tuy.chinh?__cft__[0]=abc123', 'ten.tuy.chinh'],
  ];
  for (const [href, id] of cases) {
    const k = commentBlock({ label: 'Bình luận của X', authorHref: href, authorName: 'X', parts: [{ text: 'a' }] });
    const out = inPage([k], '', readAs(null));
    assert.strictEqual(out[0].authorId, id, href);
    assert.strictEqual(out[0].authorUrl, `https://www.facebook.com/${id}`, href);
  }
});

test('link bài đăng không bị nhận nhầm là link tác giả', () => {
  // Trên bài của Trang, link thời gian có dạng /<slug>/posts/<id>. Nếu nhận
  // nhầm, mọi bình luận sẽ mang authorId là tên Trang.
  for (const href of ['/cuahangabc/posts/222/', '/groups/111/posts/222/', '/permalink.php?story_fbid=1&id=2']) {
    const k = commentBlock({ label: 'Bình luận của X', authorHref: href, authorName: 'X', parts: [{ text: 'a' }] });
    assert.deepStrictEqual(inPage([k], '', readAs(null)), [], href);
  }
});

test('chốt comment_id: bỏ qua link thời gian dù nó đứng TRƯỚC link tác giả trong DOM', () => {
  // /permalink/ (không phải permalink.php) không nằm trong danh sách chặn
  // của normalizeAuthorLink, nên nếu thiếu chốt "comment_id=" thì link thời gian
  // này sẽ bị đọc nhầm thành link tác giả, gán authorId="permalink" và
  // authorName="2 giờ" cho một người không tồn tại.
  const k = commentBlock({
    label: 'Bình luận của Nguyễn Văn A',
    authorHref: '/groups/111/user/789/',
    authorName: 'Nguyễn Văn A',
    parts: [{ text: 'cho mình xin giá' }],
    timeHref: '/permalink/222/?comment_id=333',
    timeText: '2 giờ',
    timeFirst: true,
  });
  const out = inPage([k], '', readAs(null));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].authorId, '789');
  assert.strictEqual(out[0].authorName, 'Nguyễn Văn A');
});

test('profile.php: nhận id ngay cả khi id= không đứng ngay sau dấu ?', () => {
  const k = commentBlock({
    label: 'Bình luận của X',
    authorHref: '/profile.php?ref=x&id=123',
    authorName: 'X',
    parts: [{ text: 'a' }],
  });
  const out = inPage([k], '', readAs(null));
  assert.strictEqual(out.length, 1, 'bình luận không được bị bỏ im lặng');
  assert.strictEqual(out[0].authorId, '123');
  assert.strictEqual(out[0].authorUrl, 'https://www.facebook.com/123');
});

test('nhãn "Xem thêm bình luận" khớp cả dạng có số lẫn không số', () => {
  for (const text of ['Xem thêm bình luận', 'Xem thêm 5 bình luận', 'Xem 12 bình luận',
    'View more comments', 'View 8 more comments']) {
    const n = fakeButton(text);
    assert.strictEqual(inPage([n], '', () => clickLabelInPage(MORE_COMMENTS)), true, text);
    assert.strictEqual(n.clickCount, 1, text);
  }
});

test('bỏ bình luận của chính mình theo selfId', () => {
  const k = commentBlock({
    label: 'Bình luận của Tôi', authorHref: '/groups/1/user/999/', authorName: 'Tôi',
    parts: [{ text: 'tự bình luận' }],
  });
  assert.deepStrictEqual(inPage([k], '', readAs('999')), []);
  assert.strictEqual(inPage([k], '', readAs('111')).length, 1);
});

test('bỏ đoạn nằm trong link, trong nút, và của khối lồng bên trong', () => {
  const k = commentBlock({
    label: 'Bình luận của A', authorHref: '/a', authorName: 'A',
    parts: [
      { text: 'nội dung thật' },
      { text: 'A', inLink: true },
      { text: 'Thích', inButton: true },
      { text: 'phản hồi lồng bên trong', otherBlock: true },
    ],
  });
  const out = inPage([k], '', readAs(null));
  assert.strictEqual(out[0].text, 'nội dung thật');
});

test('khối không tìm được link tác giả thì bỏ qua', () => {
  const k = commentBlock({ label: 'Bình luận của ?', authorHref: null, authorName: '', parts: [{ text: 'a' }] });
  assert.deepStrictEqual(inPage([k], '', readAs(null)), []);
});

test('cha không phân giải được tác giả của chính mình thì bị bỏ, không nhận nhầm tác giả của phản hồi con lồng bên trong', () => {
  // DOM thật: phản hồi nằm lồng trong khối bình luận cha, nên
  // querySelectorAll('a') của cha cũng trả về thẻ <a> tác giả của con. Nếu
  // vòng lặp tìm tác giả không tự giới hạn trong khối của chính mình, cha sẽ
  // "mượn" danh tính của con khi link tác giả của chính cha không phân giải
  // được (ví dụ href rỗng vì tài khoản đã bị vô hiệu hoá).
  const child = commentBlock({
    label: 'Phản hồi của B', authorHref: '/groups/1/user/999/', authorName: 'B',
    parts: [{ text: 'phản hồi' }],
  });
  const parent = commentBlock({
    label: 'Bình luận của A', authorHref: '', authorName: '',
    parts: [{ text: 'nội dung cha' }],
    nestedBlocks: [child],
  });
  const out = inPage([parent, child], '', readAs(null));
  // Chỉ được có đúng bản ghi của con (id 999) — bản ghi cha phải bị bỏ hẳn,
  // không được xuất hiện mang danh tính của con.
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].authorId, '999');
});

test('hasCommentAreaInPage: thấy khối bình luận', () => {
  const k = commentBlock({ label: 'Bình luận của A', authorHref: '/a', authorName: 'A', parts: [] });
  assert.strictEqual(inPage([k], '', () => hasCommentAreaInPage()), true);
});

test('hasCommentAreaInPage: không có khối nhưng có ô viết bình luận', () => {
  assert.strictEqual(inPage([], 'Viết bình luận công khai...', () => hasCommentAreaInPage()), true);
});

test('hasCommentAreaInPage: trang trắng thì false', () => {
  assert.strictEqual(inPage([], 'Nội dung này hiện không có sẵn', () => hasCommentAreaInPage()), false);
});

test('countCommentsInPage đếm đúng số khối bình luận', () => {
  const a = commentBlock({ label: 'Bình luận của A', authorHref: '/a', authorName: 'A', parts: [] });
  const b = commentBlock({ label: 'Phản hồi của B', authorHref: '/b', authorName: 'B', parts: [] });
  const post = commentBlock({ label: 'Bài viết của C', authorHref: '/c', authorName: 'C', parts: [] });
  assert.strictEqual(inPage([a, b, post], '', () => countCommentsInPage()), 2);
});

test('clickLabelInPage bấm đúng nút và trả true', () => {
  const n = fakeButton('Xem thêm 5 bình luận');
  const other = fakeButton('Chia sẻ');
  const out = inPage([n, other], '', () => clickLabelInPage(MORE_COMMENTS));
  assert.strictEqual(out, true);
  assert.strictEqual(n.clickCount, 1);
  assert.strictEqual(other.clickCount, 0);
});

test('clickLabelInPage trả false khi không có nút nào khớp', () => {
  assert.strictEqual(inPage([fakeButton('Chia sẻ')], '', () => clickLabelInPage(MORE_COMMENTS)), false);
});

test('clickLabelInPage bỏ qua chuỗi quá dài (tránh bấm nhầm nội dung bài)', () => {
  const long = fakeButton(`Xem thêm bình luận ${'x'.repeat(80)}`);
  assert.strictEqual(inPage([long], '', () => clickLabelInPage(MORE_COMMENTS)), false);
  assert.strictEqual(long.clickCount, 0);
});

test('nhãn sắp xếp nhận cả tiếng Việt lẫn tiếng Anh', () => {
  const vi = fakeButton('Phù hợp nhất');
  assert.strictEqual(inPage([vi], '', () => clickLabelInPage(SORT_TRIGGER)), true);
  const en = fakeButton('All comments');
  assert.strictEqual(inPage([en], '', () => clickLabelInPage(SORT_ALL)), true);
});

test('keyOf ghép authorId, postUrl, text bằng \\u0000 và bỏ thời gian', () => {
  const base = { authorId: '7', postUrl: 'https://www.facebook.com/groups/1/posts/2/', text: 'xin giá' };
  assert.strictEqual(keyOf(base), `7\u0000${base.postUrl}\u0000xin giá`);
  assert.strictEqual(keyOf({ ...base, commentedAt: '2 giờ' } as any), keyOf({ ...base, commentedAt: '3 giờ' } as any));
});

/**
 * Trình duyệt giả. page.evaluate CHẠY THẬT hàm được truyền vào, trên một
 * document giả do kịch bản trang cung cấp — không trả kết quả đóng hộp theo
 * tên hàm. Kiểm thử mà giả kết quả thì hàm DOM không bao giờ được chạy.
 */
function fakeBrowser(pagesByUrl: Record<string, any>) {
  const closed = { value: false };
  const visited: string[] = [];
  let current: any = null;
  let currentUrl: string | null = null;

  const ctx = {
    cookies: async () => [{ name: 'c_user', value: '999' }],
    close: async () => { closed.value = true; },
  };
  const page = {
    goto: async (url: string) => {
      visited.push(url);
      current = pagesByUrl[url];
      if (current && current.throws) throw new Error(current.throws);
      // Mặc định URL sau khi goto trùng URL đã gọi. Kịch bản khai báo
      // `urlAfterRedirect` để giả lập Facebook chuyển hướng đi nơi khác (link
      // hỏng, bài đã xoá...).
      currentUrl = (current && current.urlAfterRedirect) || url;
    },
    url: () => currentUrl,
    evaluate: async (fn: (arg: any) => any, arg: any) => {
      const g = global as any;
      const saved = g.document;
      g.document = current ? current.document() : { body: { textContent: '' }, querySelectorAll: () => [] };
      try {
        return fn(arg);
      } finally {
        g.document = saved;
      }
    },
  };
  return { ctx, page, closed, visited, launch: async () => ({ ctx, page }) as any };
}

/** Kịch bản một trang bài: n bình luận, có/không vùng bình luận. */
function postPage({ commentCount = 0, hasCommentArea = true, personName = (i: number) => `Người ${i}` } = {}) {
  return {
    document: () => {
      const nodes: any[] = [];
      for (let i = 0; i < commentCount; i++) {
        nodes.push(commentBlock({
          label: 'Bình luận của X',
          authorHref: `/groups/1/user/${100 + i}/`,
          authorName: personName(i),
          parts: [{ text: `bình luận ${i}` }],
        }));
      }
      return {
        body: { textContent: hasCommentArea ? 'Viết bình luận' : 'Nội dung này hiện không có sẵn' },
        querySelectorAll: (sel: string) => (sel === 'div[role="article"]' ? nodes : []),
      };
    },
  };
}

/** Kho bình luận giả trong bộ nhớ: loadKeys đọc lại những gì saveComments đã ghi, như kho thật. */
function fakeStore() {
  const rows: CollectedComment[] = [];
  return {
    rows,
    loadKeys: async () => new Set(rows.map(keyOf)),
    saveComments: async (fresh: CollectedComment[]) => { rows.push(...fresh); return fresh.length; },
  };
}

interface Log { msg: string; type: LogLevel }

function makeDeps(fake: ReturnType<typeof fakeBrowser>, store: ReturnType<typeof fakeStore>, over: Record<string, any> = {}) {
  return {
    launch: fake.launch,
    getIsStopping: () => false,
    sendLog: () => {},
    updateProgress: () => {},
    loadKeys: store.loadKeys,
    saveComments: store.saveComments,
    ...over,
  };
}

// settleMs: 0 làm MỌI khoảng chờ trong collectFromPost sập về 0. Thiếu nó thì mỗi
// bài trong test chờ thật 3 giây.
const NO_WAIT = { minDelay: 0, maxDelay: 0, settleMs: 0 };

test('thu một bài, lưu bình luận, trả outcome done', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/2/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 3 }) });
  const store = fakeStore();
  const out = await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, store));
  assert.strictEqual(out.scanned, 1);
  assert.strictEqual(out.failed, 0);
  assert.strictEqual(out.added, 3);
  assert.strictEqual(out.results[0].outcome, 'done');
  assert.strictEqual(out.results[0].url, url);
  assert.strictEqual(out.results[0].added, 3);
  assert.strictEqual(store.rows.length, 3);
  assert.strictEqual(store.rows[0].postUrl, url);
  assert.deepStrictEqual(Object.keys(store.rows[0]).sort(),
    ['authorId', 'authorName', 'authorUrl', 'commentedAt', 'postUrl', 'text']);
  assert.strictEqual(store.rows[0].authorName, 'Người 0');
  assert.strictEqual(store.rows[0].authorId, '100');
  assert.strictEqual(store.rows[0].text, 'bình luận 0');
});

test('không thấy vùng bình luận thì FAILED, không phải done với added 0', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/9/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 0, hasCommentArea: false }) });
  const out = await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, fakeStore()));
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.strictEqual(out.failed, 1);
  assert.match(out.results[0].error as string, /không mở được|bị xoá/i);
});

test('bị chuyển hướng khỏi bài (link hỏng) thì FAILED, không cào nhầm bình luận của bảng tin', async () => {
  // Bảng tin (nơi Facebook chuyển hướng tới khi link hỏng) luôn có chữ "Viết
  // bình luận" — hasCommentAreaInPage một mình sẽ báo nhầm là có vùng bình
  // luận rồi cào các bình luận đang hiện trên bảng tin của người lạ.
  const url = 'https://www.facebook.com/permalink.php';
  const fake = fakeBrowser({
    [url]: { ...postPage({ commentCount: 8 }), urlAfterRedirect: 'https://www.facebook.com/' },
  });
  const store = fakeStore();
  const out = await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, store));
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.strictEqual(out.results[0].added, 0);
  assert.match(out.results[0].error as string, /chuyển hướng/i);
  assert.strictEqual(store.rows.length, 0);
});

test('thấy vùng bình luận nhưng rỗng thì done với added 0', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/8/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 0, hasCommentArea: true }) });
  const out = await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, fakeStore()));
  assert.strictEqual(out.results[0].outcome, 'done');
  assert.strictEqual(out.results[0].added, 0);
});

test('goto ném lỗi thì bài đó failed, các bài sau vẫn chạy', async () => {
  const a = 'https://www.facebook.com/groups/1/posts/1/';
  const b = 'https://www.facebook.com/groups/1/posts/2/';
  const fake = fakeBrowser({ [a]: { throws: 'mạng hỏng', document: () => ({}) }, [b]: postPage({ commentCount: 2 }) });
  const out = await collectComments({ posts: [{ postUrl: a }, { postUrl: b }], ...NO_WAIT }, makeDeps(fake, fakeStore()));
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.match(out.results[0].error as string, /mạng hỏng/);
  assert.strictEqual(out.results[1].outcome, 'done');
  assert.strictEqual(out.results[1].added, 2);
});

test('bỏ bình luận của chính mình theo cookie c_user', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/3/';
  const fake = fakeBrowser({
    [url]: {
      document: () => ({
        body: { textContent: 'Viết bình luận' },
        querySelectorAll: (sel: string) => (sel === 'div[role="article"]' ? [
          commentBlock({ label: 'Bình luận của Tôi', authorHref: '/groups/1/user/999/', authorName: 'Tôi', parts: [{ text: 'của mình' }] }),
          commentBlock({ label: 'Bình luận của A', authorHref: '/groups/1/user/1/', authorName: 'A', parts: [{ text: 'của khách' }] }),
        ] : []),
      }),
    },
  });
  const store = fakeStore();
  const out = await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, store));
  assert.strictEqual(out.results[0].added, 1);
  assert.deepStrictEqual(store.rows.map(r => r.authorId), ['1']);
});

test('chống trùng: thu lại cùng bài không nhân đôi', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/4/';
  const store = fakeStore();
  const run = () => collectComments(
    { posts: [{ postUrl: url }], ...NO_WAIT },
    makeDeps(fakeBrowser({ [url]: postPage({ commentCount: 2 }) }), store),
  );
  const first = await run();
  const second = await run();
  assert.strictEqual(first.added, 2);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(second.results[0].outcome, 'done', 'vẫn done, chỉ không lưu thêm');
  assert.strictEqual(store.rows.length, 2);
});

test('chạm trần maxPerPost thì cắt bớt', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/5/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 10 }) });
  const out = await collectComments({ posts: [{ postUrl: url }], maxPerPost: 4, ...NO_WAIT }, makeDeps(fake, fakeStore()));
  assert.strictEqual(out.results[0].added, 4);
});

test('chạm trần maxPerPost thì ghi log cảnh báo, không im lặng cắt bớt', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/50/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 10 }) });
  const logs: Log[] = [];
  const out = await collectComments(
    { posts: [{ postUrl: url }], maxPerPost: 4, ...NO_WAIT },
    makeDeps(fake, fakeStore(), { sendLog: (msg: string, type: LogLevel) => logs.push({ msg, type }) }),
  );
  assert.strictEqual(out.results[0].added, 4);
  assert.ok(
    logs.some(l => l.type === 'warning' && /chạm trần|tối đa mỗi bài/i.test(l.msg)),
    JSON.stringify(logs),
  );
});

// Ca thường gặp nhất: vòng lặp tải thêm ở collectFromPost thoát ngay khi
// count >= maxPerPost (không đợi nạp dư), nên blocks.length hầu như luôn đúng
// BẰNG trần, không lớn hơn. So sánh bằng ">" sẽ bỏ sót đúng ca này.
test('bài có số bình luận đúng bằng trần maxPerPost cũng phải cảnh báo', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/53/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 4 }) });
  const logs: Log[] = [];
  const out = await collectComments(
    { posts: [{ postUrl: url }], maxPerPost: 4, ...NO_WAIT },
    makeDeps(fake, fakeStore(), { sendLog: (msg: string, type: LogLevel) => logs.push({ msg, type }) }),
  );
  assert.strictEqual(out.results[0].added, 4);
  assert.ok(
    logs.some(l => l.type === 'warning' && /chạm trần|tối đa mỗi bài/i.test(l.msg)),
    JSON.stringify(logs),
  );
});

test('ghi kho hỏng (saveComments trả 0) thì báo error với số liệu đúng, không báo success với số bịa', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/51/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 2 }) });
  const logs: Log[] = [];
  const out = await collectComments(
    { posts: [{ postUrl: url }], ...NO_WAIT },
    makeDeps(fake, fakeStore(), {
      saveComments: async () => 0,
      sendLog: (msg: string, type: LogLevel) => logs.push({ msg, type }),
    }),
  );
  assert.strictEqual(out.added, 0, 'không được cộng số bịa khi ghi hỏng');
  assert.strictEqual(out.results[0].added, 0);
  assert.ok(
    logs.some(l => l.type === 'error' && /không ghi được|chỉ ghi được/i.test(l.msg)),
    JSON.stringify(logs),
  );
  assert.ok(
    !logs.some(l => l.type === 'success'),
    'không được báo success khi ghi thất bại',
  );
});

test('saveComments ném lỗi thì coi như ghi được 0: báo error, các bài sau vẫn chạy', async () => {
  // Kho cũ (appendComments) nuốt lỗi ghi và trả 0; kho mới phải cho cùng hành vi
  // để một lần ghi hỏng không làm sập cả đợt thu.
  const a = 'https://www.facebook.com/groups/1/posts/61/';
  const b = 'https://www.facebook.com/groups/1/posts/62/';
  const fake = fakeBrowser({ [a]: postPage({ commentCount: 2 }), [b]: postPage({ commentCount: 1 }) });
  const logs: Log[] = [];
  let calls = 0;
  const out = await collectComments(
    { posts: [{ postUrl: a }, { postUrl: b }], ...NO_WAIT },
    makeDeps(fake, fakeStore(), {
      saveComments: async (rows: CollectedComment[]) => { calls += 1; if (calls === 1) throw new Error('disk full'); return rows.length; },
      sendLog: (msg: string, type: LogLevel) => logs.push({ msg, type }),
    }),
  );
  assert.strictEqual(out.results.length, 2);
  assert.strictEqual(out.results[0].added, 0);
  assert.strictEqual(out.results[1].added, 1);
  assert.strictEqual(out.added, 1);
  assert.ok(logs.some(l => l.type === 'error' && /disk full/.test(l.msg)), JSON.stringify(logs));
});

test('huỷ giữa chừng thì không nhảy updateProgress lên 100% "Hoàn tất"', async () => {
  const a = 'https://www.facebook.com/groups/1/posts/1/';
  const b = 'https://www.facebook.com/groups/1/posts/2/';
  const fake = fakeBrowser({ [a]: postPage({ commentCount: 2 }), [b]: postPage({ commentCount: 2 }) });
  let n = 0;
  const progress: { percent: number; label: string }[] = [];
  await collectComments(
    { posts: [{ postUrl: a }, { postUrl: b }], ...NO_WAIT },
    makeDeps(fake, fakeStore(), {
      getIsStopping: () => (n++ > 0),
      updateProgress: (percent: number, label: string) => progress.push({ percent, label }),
    }),
  );
  assert.ok(
    !progress.some(t => t.percent === 100 && t.label === 'Hoàn tất'),
    'huỷ giữa chừng ở bài dở dang không được coi là đã hoàn tất',
  );
});

test('bị dừng giữa chừng khi đang tải thêm bình luận thì ghi log cảnh báo, không im lặng báo xong', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/52/';
  const fake = fakeBrowser({ [url]: postPage({ commentCount: 1 }) });
  const logs: Log[] = [];
  let n = 0;
  // false ở lần gọi đầu (đầu vòng lặp ngoài, trước khi mở bài này), true từ
  // lần thứ hai — đúng lúc collectFromPost đang xét có tải thêm bình luận hay
  // không, tức là dừng GIỮA lúc thu một bài, không phải giữa hai bài.
  const getIsStopping = () => { n += 1; return n > 1; };
  const out = await collectComments(
    { posts: [{ postUrl: url }], ...NO_WAIT },
    makeDeps(fake, fakeStore(), { getIsStopping, sendLog: (msg: string, type: LogLevel) => logs.push({ msg, type }) }),
  );
  assert.strictEqual(out.results[0].outcome, 'done');
  assert.ok(
    logs.some(l => l.type === 'warning' && /dừng|chưa đầy đủ/i.test(l.msg)),
    JSON.stringify(logs),
  );
});

test('huỷ giữa chừng dừng ở ranh giới bài và giữ dữ liệu đã ghi', async () => {
  const a = 'https://www.facebook.com/groups/1/posts/1/';
  const b = 'https://www.facebook.com/groups/1/posts/2/';
  const fake = fakeBrowser({ [a]: postPage({ commentCount: 2 }), [b]: postPage({ commentCount: 2 }) });
  const store = fakeStore();
  let n = 0;
  const out = await collectComments(
    { posts: [{ postUrl: a }, { postUrl: b }], ...NO_WAIT },
    makeDeps(fake, store, { getIsStopping: () => (n++ > 0) }),
  );
  assert.strictEqual(out.results.length, 1, 'chỉ thu được bài đầu');
  assert.strictEqual(store.rows.length, 2, 'dữ liệu bài đầu vẫn được giữ');
});

test('luôn đóng context kể cả khi mọi bài đều hỏng', async () => {
  const url = 'https://www.facebook.com/groups/1/posts/7/';
  const fake = fakeBrowser({ [url]: { throws: 'toang', document: () => ({}) } });
  await collectComments({ posts: [{ postUrl: url }], ...NO_WAIT }, makeDeps(fake, fakeStore()));
  assert.strictEqual(fake.closed.value, true);
});

test('danh sách bài rỗng thì ném lỗi rõ ràng, không mở trình duyệt', async () => {
  let opened = false;
  await assert.rejects(
    () => collectComments({ posts: [] }, makeDeps(fakeBrowser({}), fakeStore(), { launch: async () => { opened = true; } })),
    /trống/i,
  );
  assert.strictEqual(opened, false);
});
