import assert from 'node:assert';
import type { Page } from 'playwright-core';
import {
  evaluateComment,
  matchSnippet,
  postFirstComment,
  evaluatePostState,
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
      : { click: async () => undefined }),
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
