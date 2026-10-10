import assert from 'node:assert';
import type { Page } from 'playwright-core';
import {
  evaluateComment,
  matchSnippet,
  postFirstComment,
  evaluatePostState,
  markCommentSendButtonInPage,
  readPostStateInPage,
  freePointOnBoxInPage,
  commentTypedInPage,
} from '../../services/facebookPoster/firstComment';
import { fakeLocators, runWithFakeTimers } from './helpers';

test('evaluateComment: số tăng VÀ thấy chữ thì mới coi là đã lên', () => {
  const result = evaluateComment(3, 4, true);
  assert.strictEqual(result.ok, true);
});

test('evaluateComment: số không tăng thì hỏng, dù có thấy chữ', () => {
  // Đoạn chữ có thể nằm sẵn trong thân bài. Thấy chữ mà số không tăng nghĩa là
  // bình luận chưa gửi được.
  const result = evaluateComment(3, 3, true);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /không tăng/);
});

test('evaluateComment: số tăng nhưng KHÔNG thấy chữ cũng là hỏng', () => {
  // Facebook nạp thêm bình luận cũ trong lúc mình gõ thì số cũng tăng. Chỉ đếm
  // số là báo thành công cho một bình luận chưa hề gửi.
  const result = evaluateComment(3, 5, false);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /không thấy đúng nội dung/);
});

test('evaluateComment: đếm hỏng thì KHÔNG được coi là thành công', () => {
  assert.strictEqual(evaluateComment(null, 4, true).ok, false);
  assert.strictEqual(evaluateComment(3, undefined, true).ok, false);
  assert.match(evaluateComment(NaN, 4, true).reason, /không xác minh được/i);
});

test('matchSnippet: lấy dòng đầu và cắt ngắn', () => {
  // Facebook thu gọn bình luận dài thành "… Xem thêm", tìm cả đoạn sẽ trượt
  // dù bình luận đã lên.
  assert.strictEqual(matchSnippet('Liên hệ: 0900\nĐịa chỉ: Hà Nội'), 'Liên hệ: 0900');
  assert.strictEqual(matchSnippet('x'.repeat(100)).length, 40);
  assert.strictEqual(matchSnippet(''), '');
  assert.strictEqual(matchSnippet(null), '');
});

test('postFirstComment: không có nội dung thì bỏ qua, không đụng trình duyệt', async () => {
  let called = false;
  const page = { goto: async () => { called = true; } } as unknown as Page;
  const out = await postFirstComment(page, { postUrl: 'https://x/posts/1', comment: '  ', text: '' });
  assert.strictEqual(out.status, 'not_requested');
  assert.strictEqual(called, false);
});

test('postFirstComment: không có link bài thì báo RIÊNG, không gộp vào "failed"', async () => {
  // Hai nguyên nhân khác nhau và cách xử lý cũng khác: không có link thì người
  // dùng phải tự vào nhóm dán tay, còn hỏng thì có thể thử lại.
  let called = false;
  const page = { goto: async () => { called = true; } } as unknown as Page;
  const out = await postFirstComment(page, { postUrl: null, comment: 'Liên hệ 0900', text: '' });
  assert.strictEqual(out.status, 'no_post_url');
  assert.match(out.reason, /dán tay/);
  assert.strictEqual(called, false);
});

test('postFirstComment: lỗi giữa chừng thì trả "failed", KHÔNG ném ra ngoài', async () => {
  // Bài đã đăng thành công rồi. Ném lỗi lên trên sẽ làm cả lượt đăng tính là
  // hỏng, người dùng đăng lại và thành hai bài trùng trong nhóm.
  const page = { goto: async () => { throw new Error('mạng chết'); } } as unknown as Page;
  const out = await postFirstComment(page, { postUrl: 'https://x/posts/1', comment: 'a', text: '' });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.reason, /mạng chết/);
});

// ---------------------------------------------------------------------------
// Bài vào hàng chờ duyệt của nhóm thì chưa hiện — bình luận vào đó là vô nghĩa.
// ---------------------------------------------------------------------------

test('thấy nội dung bài trên trang thì mới coi là đã duyệt', () => {
  assert.strictEqual(evaluatePostState({ found: true }).status, 'approved');
});

test('không thấy bài mà có dấu hiệu chờ duyệt thì báo ĐÚNG lý do đó', () => {
  const result = evaluatePostState({ found: false, pendingMarker: 'đang chờ phê duyệt' });
  assert.strictEqual(result.status, 'pending_approval');
  assert.match(result.reason, /phê duyệt/);
  assert.match(result.reason, /vào bình luận giúp/);
});

test('không thấy bài và cũng không có dấu hiệu gì thì KHÔNG đoán bừa là đã duyệt', () => {
  // Danh sách câu chữ "chờ duyệt" chưa đo trên trang thật. Suy ngược từ
  // "không thấy chữ chờ duyệt" thành "chắc là đã duyệt" sẽ đẩy công cụ đi bình
  // luận vào một bài chưa hề hiện.
  const result = evaluatePostState({ found: false, pendingMarker: null });
  assert.strictEqual(result.status, 'post_not_found');
  assert.match(result.reason, /Chưa bình luận/);
});

test('thấy bài thì dấu hiệu chờ duyệt trên trang KHÔNG lật ngược kết luận', () => {
  // Trang nhóm có thể có băng thông báo chung về việc kiểm duyệt bài. Bài mình
  // đã hiện rồi thì vẫn bình luận được.
  const result = evaluatePostState({ found: true, pendingMarker: 'chờ phê duyệt' });
  assert.strictEqual(result.status, 'approved');
});

test('đầu vào rỗng thì không được coi là đã duyệt', () => {
  assert.strictEqual(evaluatePostState().status, 'post_not_found');
  assert.strictEqual(evaluatePostState({}).status, 'post_not_found');
});

test('send button is clicked through a trusted locator, not element.click()', async () => {
  const clicked: string[] = [];
  const counts = [3, 4];
  const byName: Record<string, () => unknown> = {
    readPostStateInPage: () => ({ found: true, pendingMarker: null }),
    countCommentBlocksInPage: () => counts.shift(),
    openCommentBoxInPage: () => true,
    markCommentBoxInPage: () => true,
    commentTypedInPage: () => true,
    markCommentSendButtonInPage: () => true,
    commentTextVisibleInPage: () => true,
  };
  const targetLocator = fakeLocators(clicked);
  const page = {
    goto: async () => undefined,
    evaluate: async (fn: { name: string }) => (byName[fn.name] ? byName[fn.name]() : undefined),
    // The comment box locator is clicked directly; the send button goes through .first().click().
    locator: (selector: string) => (/data-maihub-target/.test(selector)
      ? targetLocator(selector)
      : { click: async () => undefined, focus: async () => undefined }),
    keyboard: { type: async () => undefined, press: async () => undefined },
  } as unknown as Page;
  const out = await runWithFakeTimers(() => postFirstComment(page, {
    postUrl: 'https://www.facebook.com/groups/1/posts/2/',
    comment: 'Liên hệ 0900',
    text: 'Bài',
  }));
  assert.strictEqual(out.status, 'posted');
  assert.deepStrictEqual(clicked.filter((c) => c === 'comment-send'), ['comment-send']);
});

test('markCommentSendButtonInPage clears a stale mark even when no send button is found', () => {
  const stale: any = { attrs: { 'data-maihub-target': 'publish' }, removeAttribute(k: string) { delete this.attrs[k]; } };
  const g = global as unknown as { document: unknown };
  const old = g.document;
  g.document = {
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === '[data-maihub-target]' ? [stale].filter(n => 'data-maihub-target' in n.attrs) : []),
  };
  try {
    assert.strictEqual(markCommentSendButtonInPage({ mark: 'data-maihub-comment-box', labels: ['Gửi'] }), false);
  } finally { g.document = old; }
  assert.ok(!('data-maihub-target' in stale.attrs), 'dấu cũ phải bị gỡ');
});

// Đo thật 2026-10-10: bài của Trang/cá nhân mở dạng hộp "Bài viết của …" — chữ bài CÓ trên trang nhưng không nằm
// trong div[role="article"] nào (log: articles=2, inBody=true). Trước đây báo post_not_found và bỏ bình luận.
function withFakePage(href: string, bodyText: string, commentTexts: string[], fn: () => void) {
  const g = global as unknown as { document: unknown; location: unknown };
  const old = { document: g.document, location: g.location };
  const comments = commentTexts.map((t) => ({ innerText: t, getAttribute: () => 'Bình luận của Ai đó' }));
  g.location = { href };
  g.document = { body: { innerText: bodyText }, querySelectorAll: () => comments };
  try { fn(); } finally { g.document = old.document; g.location = old.location; }
}

test('readPostStateInPage: bài Trang/cá nhân không nằm trong article nhưng có trên trang bài thì coi là thấy', () => {
  withFakePage('https://www.facebook.com/61592412314280/posts/122131437117413743/', 'Bài viết của Media Soec\nhehe\nThích', [], () => {
    assert.strictEqual(readPostStateInPage({ snippet: 'hehe', markers: [] }).found, true);
  });
});

test('readPostStateInPage: chữ chỉ nằm trong bình luận trích lại thì KHÔNG coi là thấy bài', () => {
  withFakePage('https://www.facebook.com/1/posts/2/', 'Bài viết\nAi đó: hehe', ['Ai đó: hehe'], () => {
    assert.strictEqual(readPostStateInPage({ snippet: 'hehe', markers: [] }).found, false);
  });
});

test('readPostStateInPage: bị chuyển hướng khỏi trang bài (về bảng tin) thì KHÔNG coi là thấy bài', () => {
  withFakePage('https://www.facebook.com/', 'Bảng tin\nhehe', [], () => {
    assert.strictEqual(readPostStateInPage({ snippet: 'hehe', markers: [] }).found, false);
  });
});

// Đo thật 2026-10-10 (nhóm, bài đăng dưới tên Trang): điểm giữa ô "Bình luận dưới tên …" bị chính hàng biểu tượng
// của khung bình luận đè lên, locator.click() thử 30 giây rồi bỏ. Phải tìm điểm trên ô mà ô thật sự nhận chuột.
test('freePointOnBoxInPage: điểm giữa bị che thì chọn điểm khác trên ô mà ô nhận chuột', () => {
  const box: any = { getBoundingClientRect: () => ({ left: 160, top: 739, width: 450, height: 20, right: 610, bottom: 759 }) };
  box.contains = (e: unknown) => e === box;
  const toolbar = {};
  const g = global as unknown as { document: unknown };
  const old = g.document;
  g.document = {
    querySelector: () => box,
    // Hàng biểu tượng che từ x ≥ 200 trở đi; phần đầu ô (chỗ con trỏ chữ) còn trống.
    elementFromPoint: (x: number) => (x < 200 ? box : toolbar),
  };
  try {
    const pt = freePointOnBoxInPage('data-maihub-comment-box');
    assert.ok(pt, 'phải tìm được điểm trống');
    assert.ok(pt!.x < 200 && pt!.y >= 739 && pt!.y <= 759, JSON.stringify(pt));
  } finally { g.document = old; }
});

test('freePointOnBoxInPage: cả ô bị che thì trả null (để quay về cách bấm cũ)', () => {
  const box: any = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }), contains: () => false };
  const g = global as unknown as { document: unknown };
  const old = g.document;
  g.document = { querySelector: () => box, elementFromPoint: () => ({}) };
  try { assert.strictEqual(freePointOnBoxInPage('data-maihub-comment-box'), null); } finally { g.document = old; }
});

test('postFirstComment: có điểm trống thì bấm chuột thật vào đúng toạ độ đó', async () => {
  const mouse: [number, number][] = [];
  const counts = [3, 4];
  const byName: Record<string, () => unknown> = {
    readPostStateInPage: () => ({ found: true, pendingMarker: null }),
    countCommentBlocksInPage: () => counts.shift(),
    openCommentBoxInPage: () => true,
    markCommentBoxInPage: () => true,
    freePointOnBoxInPage: () => ({ x: 170, y: 749 }),
    commentTypedInPage: () => true,
    markCommentSendButtonInPage: () => true,
    commentTextVisibleInPage: () => true,
  };
  const page = {
    goto: async () => undefined,
    url: () => 'https://www.facebook.com/groups/1/posts/2/',
    evaluate: async (fn: { name: string }) => (byName[fn.name] ? byName[fn.name]() : undefined),
    mouse: { click: async (x: number, y: number) => { mouse.push([x, y]); } },
    locator: () => ({ click: async () => { throw new Error('không được bấm locator ô nhập khi đã có điểm trống'); }, first: () => ({ click: async () => undefined }) }),
    keyboard: { type: async () => undefined, press: async () => undefined },
  } as unknown as Page;
  const out = await runWithFakeTimers(() => postFirstComment(page, { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'hi', text: 'Bài' }));
  assert.strictEqual(out.status, 'posted', JSON.stringify(out));
  assert.deepStrictEqual(mouse, [[170, 749]]);
});

// Đo thật 2026-10-10 15:36 (nhóm): cả ô nhập bị các lớp của khung bình luận đè — không có điểm nào bấm được.
function commentPage(over: Record<string, () => unknown>, calls: string[]) {
  const counts = [3, 4];
  const byName: Record<string, () => unknown> = {
    readPostStateInPage: () => ({ found: true, pendingMarker: null }),
    countCommentBlocksInPage: () => counts.shift(),
    openCommentBoxInPage: () => true,
    markCommentBoxInPage: () => true,
    freePointOnBoxInPage: () => null,
    commentTypedInPage: () => true,
    markCommentSendButtonInPage: () => true,
    commentTextVisibleInPage: () => true,
    ...over,
  };
  return {
    goto: async () => undefined,
    url: () => 'https://www.facebook.com/groups/1/posts/2/',
    evaluate: async (fn: { name: string }) => (byName[fn.name] ? byName[fn.name]() : undefined),
    mouse: { click: async () => { calls.push('mouse'); } },
    locator: (sel: string) => ({
      click: async () => { calls.push(/data-maihub-target/.test(sel) ? 'send' : 'box-click'); throw new Error('intercepts pointer events'); },
      focus: async () => { calls.push('box-focus'); },
      first: () => ({ click: async () => { calls.push('send'); } }),
    }),
    keyboard: { type: async () => { calls.push('type'); }, press: async () => undefined },
  } as unknown as Page;
}

test('postFirstComment: cả ô bị che thì focus bằng Playwright rồi gõ, không bấm ô', async () => {
  const calls: string[] = [];
  const out = await runWithFakeTimers(() => postFirstComment(commentPage({}, calls), { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'hi', text: 'Bài' }));
  assert.strictEqual(out.status, 'posted', JSON.stringify(out));
  assert.deepStrictEqual(calls, ['box-focus', 'type', 'send']);
});

test('postFirstComment: gõ xong mà ô vẫn trống thì báo hỏng và KHÔNG bấm gửi', async () => {
  const calls: string[] = [];
  const out = await runWithFakeTimers(() => postFirstComment(commentPage({ commentTypedInPage: () => false }, calls), { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'hi', text: 'Bài' }));
  assert.strictEqual(out.status, 'failed');
  assert.match(out.reason, /Không gõ được/);
  assert.ok(!calls.includes('send'), JSON.stringify(calls));
});

test('commentTypedInPage: ô có đoạn chữ vừa gõ thì true, trống thì false', () => {
  const g = global as unknown as { document: unknown };
  const old = g.document;
  try {
    g.document = { querySelector: () => ({ innerText: 'Liên hệ 0900' }) };
    assert.strictEqual(commentTypedInPage({ mark: 'm', snippet: 'Liên hệ' }), true);
    g.document = { querySelector: () => ({ innerText: '' }) };
    assert.strictEqual(commentTypedInPage({ mark: 'm', snippet: 'Liên hệ' }), false);
  } finally { g.document = old; }
});

// Đo thật 2026-10-10 15:51 (nhóm): chữ đã vào ô nhưng nút "Đăng bình luận" bị nút "Bình luận bằng nhãn dán" đè.
test('postFirstComment: nút gửi bị che thì nhấn Enter trong ô (Facebook gửi bình luận bằng Enter)', async () => {
  const calls: string[] = [];
  const page = commentPage({}, calls) as unknown as Record<string, any>;
  page.locator = (sel: string) => ({
    click: async () => { throw new Error('intercepts pointer events'); },
    focus: async () => { calls.push('box-focus'); },
    first: () => ({ click: async () => { calls.push('send-blocked'); throw new Error('Bình luận bằng nhãn dán intercepts pointer events'); } }),
  });
  page.keyboard = { type: async () => { calls.push('type'); }, press: async (k: string) => { calls.push(`press:${k}`); } };
  const out = await runWithFakeTimers(() => postFirstComment(page as unknown as Page, { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'hi', text: 'Bài' }));
  assert.strictEqual(out.status, 'posted', JSON.stringify(out));
  assert.deepStrictEqual(calls, ['box-focus', 'type', 'send-blocked', 'press:Enter']);
});

test('postFirstComment: bấm được nút gửi thì KHÔNG nhấn thêm Enter', async () => {
  const calls: string[] = [];
  const page = commentPage({}, calls) as unknown as Record<string, any>;
  page.keyboard = { type: async () => { calls.push('type'); }, press: async (k: string) => { calls.push(`press:${k}`); } };
  const out = await runWithFakeTimers(() => postFirstComment(page as unknown as Page, { postUrl: 'https://www.facebook.com/groups/1/posts/2/', comment: 'hi', text: 'Bài' }));
  assert.strictEqual(out.status, 'posted', JSON.stringify(out));
  assert.ok(!calls.includes('press:Enter'), JSON.stringify(calls));
});
