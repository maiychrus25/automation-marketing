import assert from 'node:assert';
import type { TaskDeps } from '../../services/facebookPoster/types';
import {
  COMPOSER_INVITE,
  PUBLISH_LABELS,
  isPublishLabel,
  markComposerInviteInPage,
  markPublishButtonInPage,
  readUploadStateInPage,
  postToTargets,
  type PostTargetResult,
} from '../../services/facebookPoster/postToTargets';
import { fakeLocators, runWithFakeTimers } from './helpers';

/**
 * postToSingleTarget dùng delayRandom (setTimeout thật) rất nhiều lần cho mỗi
 * target. Dùng fake timers của jest để "tua nhanh" các setTimeout đó thay vì
 * chờ thật — nếu không mỗi test sẽ mất nhiều giây.
 */

/** Context giả đã đăng nhập, đóng lại ghi nhận vào closed[]. */
function loggedInCtx(closed: boolean[]) {
  return {
    cookies: async () => [{ name: 'c_user', value: '1' }],
    close: async () => { closed.push(true); },
  };
}

type AnyFn = { name: string };
type FakePage = Record<string, unknown>;

/** TaskDeps đủ dùng cho test; `extra` ghi đè từng phần. */
function makeDeps(ctx: unknown, page: FakePage, extra: Partial<TaskDeps> & { onResult?: (r: PostTargetResult) => void } = {}) {
  return {
    launch: async () => ({ ctx, page }) as unknown as Awaited<ReturnType<TaskDeps['launch']>>,
    getIsStopping: () => false,
    sendLog: () => {},
    updateProgress: () => {},
    ...extra,
  };
}

test('nhận đúng nhãn nút đăng của group', () => {
  assert.ok(isPublishLabel('Đăng'));
  assert.ok(isPublishLabel('Post'));
  assert.ok(isPublishLabel('Chia sẻ'));
  assert.ok(isPublishLabel('Share'));
});

test('nhận đúng nhãn nút đăng của page', () => {
  assert.ok(isPublishLabel('Đăng ngay'));
  assert.ok(isPublishLabel('Publish'));
});

test('cắt khoảng trắng trước khi so khớp', () => {
  assert.ok(isPublishLabel('  Đăng  '));
});

test('không nhận nhầm nhãn khác', () => {
  assert.strictEqual(isPublishLabel('Đăng nhập'), false);
  assert.strictEqual(isPublishLabel('Posts'), false);
  assert.strictEqual(isPublishLabel(''), false);
  assert.strictEqual(isPublishLabel(undefined), false);
});

test('text rỗng thì ném lỗi trước khi mở trình duyệt', async () => {
  let launched = false;
  await assert.rejects(
    postToTargets(
      { text: '   ', targets: ['123'] },
      { ...makeDeps(null, {}), launch: async () => { launched = true; return undefined as never; } },
    ),
    /không được để trống/,
  );
  assert.strictEqual(launched, false);
});

test('targets rỗng thì ném lỗi trước khi mở trình duyệt', async () => {
  let launched = false;
  await assert.rejects(
    postToTargets(
      { text: 'xin chào', targets: [] },
      { ...makeDeps(null, {}), launch: async () => { launched = true; return undefined as never; } },
    ),
    /trống/,
  );
  assert.strictEqual(launched, false);
});

test('targets không phải mảng thì ném lỗi', async () => {
  await assert.rejects(
    postToTargets({ text: 'xin chào', targets: '123' as unknown as string[] }, makeDeps(null, {})),
    /trống/,
  );
});

test('chưa đăng nhập thì reject và vẫn đóng context', async () => {
  const closed: boolean[] = [];
  const ctx = { cookies: async () => [], close: async () => { closed.push(true); } };
  const page = { goto: async () => {} };

  await assert.rejects(
    postToTargets(
      { text: 'xin chào', targets: ['123'], minDelay: 0, maxDelay: 0 },
      makeDeps(ctx, page),
    ),
    { message: 'Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập' },
  );
  assert.strictEqual(closed.length, 1);
});

// Hồi quy: lối tắt cũ click "Ảnh/Video" ngoài feed để mở thẳng composer kèm
// đính kèm. Đo thật trên trang group: nó bắt trúng nút của ô BÌNH LUẬN
// (aria-label "Attach a photo or video"), mở file picker cho bình luận và
// không bao giờ mở dialog. Luồng đúng: mở composer trước, rồi tìm nút
// "Photo/video" BÊN TRONG dialog.
test('có media vẫn phải mở hộp soạn thảo trước, rồi mới tìm nút Ảnh/Video trong dialog', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const order: string[] = [];
  const page = {
    goto: async () => {},
    on: () => {},
    evaluate: async (fn: AnyFn) => {
      order.push(fn.name);
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'clickMediaButtonInDialog') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    $: async () => null, // input file không bao giờ gắn được
    waitForSelector: async () => { throw new Error('input chưa gắn (giả lập)'); },
    keyboard: { type: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'a', mediaPaths: ['/tmp/x.jpg'], targets: ['123'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));

  assert.ok(!order.includes('clickMediaButtonInPage'), 'lối tắt cũ phải bị bỏ hẳn');
  assert.ok(
    order.indexOf('composerIsOpenInPage') < order.indexOf('clickMediaButtonInDialog'),
    'phải kiểm tra composer đã mở TRƯỚC khi tìm nút Ảnh/Video',
  );
  // Không lấy được input file thì phải bỏ cuộc, không được đăng bài thiếu ảnh.
  assert.ok(!order.includes('markPublishButtonInPage'), 'không có input file thì không được bấm đăng');
  assert.ok(!clicked.includes('publish'), 'không có input file thì không được bấm đăng');
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(closed.length, 1);
});

test('publish click failure is logged as a click error and the dialog-close evidence still decides', async () => {
  const closed: boolean[] = [];
  const logs: string[] = [];
  const page = {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => (fn.name === 'markPublishButtonInPage' || fn.name === 'composerIsOpenInPage' || fn.name === 'focusEditorInPage'),
    locator: () => ({ first: () => ({ click: async () => { throw new Error('boom'); } }) }),
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    click: async () => {},
    keyboard: { type: async () => {} },
  };
  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets: ['123'], minDelay: 0, maxDelay: 0 },
    makeDeps(loggedInCtx(closed), page, { sendLog: (m: string) => logs.push(m) }),
  ));
  assert.strictEqual(result.posted, 1);
  assert.ok(logs.includes('Bấm nút Đăng không được: boom'), logs.join('\n'));
  assert.ok(!logs.some((m) => m.includes('Lỗi tìm nút Đăng bằng evaluate')));
});

test('đăng thành công 2 targets: tổng hợp kết quả đúng, đóng context, tiến độ đạt 100%', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const progressCalls: { percent: number; label: string }[] = [];
  const page = {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'markComposerInviteInPage') return false;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    // state 'hidden' = chờ dialog đóng sau khi bấm Đăng: đóng được nghĩa là bài đã đi.
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    click: async () => {},
    keyboard: { type: async () => {} },
  };

  const targets = ['123456789', 'https://www.facebook.com/mytrang'];
  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets, minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { updateProgress: (percent, label) => progressCalls.push({ percent, label }) }),
  ));

  assert.deepStrictEqual(result, {
    posted: 2,
    failed: 0,
    results: [
      // Không có phản hồi GraphQL và không có bài "[role=article]" nào trong
      // DOM giả lập, nên đường dự phòng cũng không bắt được link — đúng theo
      // thiết kế: thà không có link còn hơn vớ nhầm bài của người khác.
      { url: 'https://www.facebook.com/groups/123456789/', ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' },
      { url: 'https://www.facebook.com/mytrang', ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' },
    ],
  });
  assert.deepStrictEqual(clicked, ['publish', 'publish'], 'nút Đăng phải được bấm bằng click tin cậy qua locator, mỗi đích một lần');
  assert.strictEqual(closed.length, 1);
  assert.strictEqual(progressCalls[progressCalls.length - 1].percent, 100);
});

// --- Hồi quy: lỗi thật gặp khi đăng vào group "Haha" (1794004381977227) ---
// Trang group đã có sẵn một bài, nên ô BÌNH LUẬN của bài đó là một
// contenteditable[role=textbox] đang hiện. Code cũ thấy có textbox liền tưởng
// hộp soạn thảo đã mở, gõ chữ vào ô bình luận, rồi markPublishButtonInPage quét
// toàn trang và bắt trúng nút "Share" ở header group (4 nhãn "Share" đứng
// trước 2 nhãn "Post" theo thứ tự DOM). Kết quả: báo SUCCESS mà không có bài.
test('không mở được hộp soạn thảo thì phải báo lỗi, không gõ chữ, không bấm đăng', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const seen: string[] = [];
  let typed = '';
  const page = {
    goto: async () => {},
    $: async () => null,
    evaluate: async (fn: AnyFn) => {
      seen.push(fn.name);
      if (fn.name === 'composerIsOpenInPage') return false; // dialog không bao giờ mở
      return false;
    },
    locator: fakeLocators(clicked),
    waitForSelector: async () => { throw new Error('không có dialog (giả lập)'); },
    click: async () => {},
    keyboard: { type: async (c: string) => { typed += c; } },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'noi dung', targets: ['1794004381977227'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));

  assert.deepStrictEqual(result.results, [
    {
      url: 'https://www.facebook.com/groups/1794004381977227/',
      ok: false,
      // postToSingleTarget ném lỗi (page.waitForFunction không có trong mock) thay vì
      // trả về false êm — nên error là message của exception, không phải
      // câu mặc định 'Không đăng được (xem nhật ký)'.
      error: 'page.waitForFunction is not a function',
      postUrl: null,
      commentStatus: 'not_requested',
      identity: '',
    },
  ]);
  assert.strictEqual(result.posted, 0);
  assert.strictEqual(typed, '', 'không được gõ ký tự nào khi chưa mở được hộp soạn thảo');
  assert.ok(!seen.includes('focusEditorInPage'), 'không được focus editor');
  assert.ok(!seen.includes('markPublishButtonInPage'), 'không được bấm nút đăng');
  assert.deepStrictEqual(clicked, [], 'không được click gì khi chưa mở được hộp soạn thảo');
  assert.strictEqual(closed.length, 1);
});

test('bấm đăng xong mà dialog không đóng thì coi như chưa đăng được', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const page = {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    // dialog vẫn mở => Facebook chưa nhận bài
    waitForSelector: async () => { throw new Error('dialog vẫn còn (giả lập)'); },
    click: async () => {},
    keyboard: { type: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets: ['123'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));

  assert.strictEqual(result.posted, 0);
  assert.strictEqual(result.failed, 1);
  // Chốt: phải fail êm qua nhánh dialog-không-đóng (ok:false), không phải vì
  // mock thiếu method rồi ném lỗi lên tận postToTargets — hai lý do fail rất
  // khác nhau nhưng posted/failed giống hệt nhau nên dễ lẫn.
  assert.strictEqual(result.results[0].error, null,
    'phải fail êm qua ok:false, không phải fail vì mock thiếu method');
  assert.ok(clicked.includes('publish'), 'đã click Đăng (click tin cậy) nhưng không có bằng chứng bài đi');
  assert.strictEqual(closed.length, 1);
});

// Composer của Page là luồng 2 bước. Chờ cứng 3-4.5s sau khi bấm "Next" là
// chưa đủ: click rơi vào lúc bước 2 render dở, dialog không bao giờ đóng và
// bài không lên. Phải chờ tới khi nhãn đăng bài thật sự xuất hiện.
test('bấm Next xong mà bước cuối không hiện nút Đăng thì phải bỏ cuộc', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const seen: string[] = [];
  const page = {
    goto: async () => {},
    $: async () => null,
    evaluate: async (fn: AnyFn) => {
      seen.push(fn.name);
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'clickNextInDialog') return true;   // là Page
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    // bước 2 không bao giờ sẵn sàng
    waitForFunction: async () => { throw new Error('quá hạn (giả lập)'); },
    waitForSelector: async () => { throw new Error('không tìm thấy (giả lập)'); },
    keyboard: { type: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets: ['https://www.facebook.com/mypage'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));

  assert.strictEqual(result.posted, 0);
  assert.ok(!seen.includes('markPublishButtonInPage'), 'chưa sẵn sàng thì không được bấm Đăng');
  assert.ok(!clicked.includes('publish'), 'chưa sẵn sàng thì không được bấm Đăng');
  assert.strictEqual(closed.length, 1);
});

// --- Task 4: bắt link bài lúc đăng ---

/**
 * Page giả cho luồng đăng thành công, có kênh 'response' để giả lập phản hồi
 * GraphQL. `graphqlBody: null` nghĩa là không phát sự kiện nào.
 */
function pageSuccessful({ graphqlBody = null, graphqlThrows = false, clicked = [] }: { graphqlBody?: string | null; graphqlThrows?: boolean; clicked?: string[] } = {}) {
  const listeners: Record<string, ((arg: unknown) => void)[]> = { response: [] };
  const page: FakePage = {
    goto: async () => {},
    $: async () => null,
    keyboard: { type: async () => {} },
    locator: fakeLocators(clicked),
    on: (name: string, fn: (arg: unknown) => void) => { (listeners[name] = listeners[name] || []).push(fn); },
    off: (name: string, fn: unknown) => {
      listeners[name] = (listeners[name] || []).filter(x => x !== fn);
    },
    remainingListeners: () => (listeners.response || []).length,
    // Dialog đóng lại = bài đã đi. Đây là tín hiệu postToSingleTarget chờ.
    waitForSelector: async () => true,
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') {
        // Bấm Đăng: phát phản hồi GraphQL cho listener đang gắn.
        if (graphqlBody !== null || graphqlThrows) {
          for (const fn2 of listeners.response) {
            fn2({
              url: () => 'https://www.facebook.com/api/graphql/',
              text: async () => {
                if (graphqlThrows) throw new Error('phản hồi đã bị huỷ');
                return graphqlBody;
              },
            });
          }
        }
        return true;
      }
      // Đường dự phòng DOM không tìm thấy gì.
      return false;
    },
  };
  return page;
}

test('bắt được post_id từ phản hồi GraphQL và ghép thành link nhóm', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({
    graphqlBody: '{"data":{"story_create":{"story":{"post_id":"123456","id":"abc"}}}}',
  });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/groups/777/posts/123456/');
});

test('đích là Trang thì ghép link dạng /<slug>/posts/<id>', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: '{"data":{"story_create":{"story":{"story_fbid":"999"}}}}' });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/cuahangabc'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/cuahangabc/posts/999');
});

// Đo thật 2026-10-10: chế độ Trang đăng từ trang chủ (đích "https://www.facebook.com/", không có slug).
// Facebook trả story.id base64 "S:_I<id người/Trang đăng>:<id bài>" — đủ ghép link; trước đây trả null nên
// bình luận đầu bị bỏ (comment_status = no_post_url).
test('đích là trang chủ: ghép link từ story.id base64 (id người đăng + id bài)', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({
    graphqlBody: '{"data":{"story_create":{"story_id":null,"post_id":null,"publishing_flow":"FALLBACK","story":{"id":"UzpfSTYxNTkxNDAyOTc4NzI0OjEyMjEzNTgxOTUyMzM4MDA5OQ==","post_id":"122135819523380099"}}}}',
  });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/61591402978724/posts/122135819523380099');
});

// Đo thật 2026-10-10 14:48: đăng dưới danh tính Trang thì Facebook trả "story_id" base64 và "story":null.
test('đích là trang chủ, đăng dưới tên Trang: ghép link từ "story_id" base64', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({
    graphqlBody: '{"data":{"story_create":{"story_id":"UzpfSTEyNTQ3NDQwNDEwNTM5NTU6MTIyMTMxNDM1ODIxNDEzNzQz","post_id":"122131435821413743","publishing_flow":"ASYNC_SILENT","story":null,"feed_story_edge":null}}}',
  });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/1254744041053955/posts/122131435821413743');
});

// Đích profile.php: id nằm ở query (?id=...), bị cắt mất bởi split(/[?#]/)[0]
// khi ghép slug. Ghép mù sẽ ra "facebook.com/profile.php/posts/N" — một URL
// không tồn tại, nguồn gây quét nhầm bảng tin (xem test "bị chuyển hướng
// khỏi bài" ở comments.test.js).
test('đích là profile.php thì không ghép ra link sai, đăng vẫn thành công nhưng postUrl null', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: '{"data":{"story_create":{"story":{"post_id":"123"}}}}' });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/profile.php?id=555'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true, 'bài vẫn đăng thành công dù không lấy được link');
  assert.strictEqual(ra.results[0].postUrl, null, 'không được ghép ra profile.php/posts/N — url không tồn tại');
});

// Trong cửa sổ chờ dialog đóng, Facebook còn bắn các truy vấn bảng tin ngầm —
// thân của chúng cũng chứa "post_id", nhưng là của bài NGƯỜI KHÁC. Không có
// dấu hiệu mutation tạo bài thì phải bỏ qua, thà thiếu link còn hơn lưu nhầm
// link bài lạ rồi đi quét bình luận của người ta.
test('phản hồi bảng tin ngầm có post_id nhưng không phải mutation tạo bài thì bỏ qua', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: '{"data":{"newsfeed_story":{"post_id":"999999"}}}' });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, null);
});

test('không bắt được link thì vẫn báo đăng thành công, postUrl null', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: null });
  const logs: { m: string; level: string }[] = [];
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { sendLog: (m, level) => logs.push({ m, level }) }),
  ));
  assert.strictEqual(ra.results[0].ok, true, 'đăng vẫn phải tính thành công');
  assert.strictEqual(ra.results[0].postUrl, null);
  assert.ok(logs.some(l => l.level === 'warning' && /không lấy được link/i.test(l.m)));
});

test('đọc thân phản hồi ném lỗi thì nuốt, không làm hỏng việc đăng', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlThrows: true });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, null);
});

// --- Chốt an toàn của đường dự phòng DOM: chỉ nhận bài của CHÍNH MÌNH ---
// findOwnPostUrl chỉ tồn tại vì lý do này. Chốt so sánh id nằm BÊN TRONG hàm
// chạy trong trang (findOwnPostLinkInPage) — nên mock phải CHẠY THẬT hàm đó
// trên một document giả, chứ không được đoán kết quả theo tham số rồi trả
// thẳng ra; làm vậy thì chốt so id không bao giờ được thực thi dưới test.

/** Thẻ <a> giả, chỉ cần getAttribute('href') như code thật dùng tới. */
function fakeLink(href: string) {
  return { getAttribute: (k: string) => (k === 'href' ? href : null) };
}

/** Khối "[role=article]" giả: đủ mỗi querySelectorAll('a') mà findOwnPostLinkInPage cần. */
function fakeArticle(...hrefs: string[]) {
  const links = hrefs.map(fakeLink);
  return { querySelectorAll: (sel: string) => (sel === 'a' ? links : []) };
}

/**
 * page.evaluate() giả: với findOwnPostLinkInPage (đường dự phòng DOM), chạy
 * THẬT nó trên document giả gồm các `articles` rồi khôi phục document gốc; các
 * hàm DOM khác của composer vẫn định tuyến theo fn.name như những test còn lại.
 */
function evaluateWithFakeDom(articles: unknown[]) {
  return async (fn: ((arg: unknown) => unknown) & AnyFn, arg: unknown) => {
    if (fn.name === 'composerIsOpenInPage') return true;
    if (fn.name === 'focusEditorInPage') return true;
    if (fn.name === 'markPublishButtonInPage') return true;
    if (fn.name === 'findOwnPostLinkInPage') {
      const g = global as unknown as { document: unknown };
      const old = g.document;
      g.document = { querySelectorAll: (sel: string) => (sel === '[role="article"]' ? articles : []) };
      try { return fn(arg); } finally { g.document = old; }
    }
    return false;
  };
}

test('đường dự phòng DOM lấy đúng link khi id khớp c_user trong cookie', async () => {
  const ctx = { cookies: async () => [{ name: 'c_user', value: '42' }], close: async () => {} };
  const page = pageSuccessful({ graphqlBody: null });
  page.evaluate = evaluateWithFakeDom([
    fakeArticle('/groups/1/user/42/', '/groups/1/posts/555/'),
  ]);
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/groups/1/posts/555/');
});

// Cùng DOM có một bài, nhưng link tác giả của bài đó là user 999 (khác cookie
// c_user='42'): không được vớ nhầm — thà không có link còn hơn đi quét bình
// luận của người lạ.
test('đường dự phòng DOM không lấy link khi id không khớp c_user trong cookie', async () => {
  const ctx = { cookies: async () => [{ name: 'c_user', value: '42' }], close: async () => {} };
  const page = pageSuccessful({ graphqlBody: null });
  page.evaluate = evaluateWithFakeDom([
    fakeArticle('/groups/1/user/999/', '/groups/1/posts/555/'),
  ]);
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, null);
});

// Hình dạng thật của bảng tin sau khi đăng: nhiều bài liên tiếp. Bài đứng
// TRƯỚC là của người khác, bài đứng SAU mới là của mình — phải lấy đúng link
// bài sau, không được dừng lại và bỏ cuộc (hay vớ nhầm) ngay ở bài đầu.
test('hai bài liền nhau, bài đầu của người khác — vẫn tìm đúng link ở bài sau của mình', async () => {
  const ctx = { cookies: async () => [{ name: 'c_user', value: '42' }], close: async () => {} };
  const page = pageSuccessful({ graphqlBody: null });
  page.evaluate = evaluateWithFakeDom([
    fakeArticle('/groups/1/user/999/', '/groups/1/posts/111/'), // bài của người khác — đứng trước
    fakeArticle('/groups/1/user/42/', '/groups/1/posts/222/'),  // bài của mình — đứng sau
  ]);
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, 'https://www.facebook.com/groups/1/posts/222/');
});

test('ctx.cookies ném lỗi thì đường dự phòng DOM trả null, bài vẫn ok true', async () => {
  let callCount = 0;
  const ctx = {
    // Lần đầu isLoggedIn() gọi cookies() để xác nhận đã đăng nhập — phải qua
    // được thì mới đăng bài. Lần thứ hai là do findOwnPostUrl gọi, mô
    // phỏng phiên hỏng giữa chừng — lỗi này phải bị nuốt, không hỏng việc đăng.
    cookies: async () => {
      callCount += 1;
      if (callCount === 1) return [{ name: 'c_user', value: '1' }];
      throw new Error('phiên hỏng');
    },
    close: async () => {},
  };
  const page = pageSuccessful({ graphqlBody: null });
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(ra.results[0].ok, true);
  assert.strictEqual(ra.results[0].postUrl, null);
});

test('gỡ listener sau mỗi bài, không để rò sang bài sau', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: '{"post_id":"111"}' });
  await runWithFakeTimers(() => postToTargets(
    {
      text: 'nội dung',
      targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'],
      minDelay: 0, maxDelay: 0,
    },
    makeDeps(ctx, page),
  ));
  assert.strictEqual((page.remainingListeners as () => number)(), 0, 'mọi listener response phải được gỡ');
});

test('bình luận hỏng thì bài VẪN tính thành công, chỉ báo riêng phần bình luận', async () => {
  // Bài đã nằm trên nhóm rồi. Báo cả lượt là hỏng sẽ khiến người dùng đăng lại
  // và thành HAI bài trùng trong nhóm — tệ hơn hẳn việc thiếu một bình luận.
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const warnings: string[] = [];
  const page = {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'markComposerInviteInPage') return false;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      // countCommentBlocksInPage trả 0, openCommentBoxInPage trả false
      // => không mở được ô bình luận => trạng thái 'failed'.
      return false;
    },
    locator: fakeLocators(clicked),
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    click: async () => {},
    keyboard: { type: async () => {}, press: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', comment: 'Liên hệ 0900', targets: ['123456789'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { sendLog: (m, type) => { if (type === 'warning') warnings.push(m); } }),
  ));

  assert.strictEqual(result.posted, 1, 'bài phải vẫn tính là đăng thành công');
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.results[0].ok, true);
  // Mock không có cookie c_user nên không lấy được link bài -> đúng trạng thái
  // là 'no_post_url'. Điều cần bảo đảm là nó KHÔNG phải 'posted' và bài vẫn
  // tính thành công.
  assert.ok(
    ['failed', 'no_post_url'].includes(result.results[0].commentStatus),
    `trạng thái bình luận phải là một trong hai kiểu hỏng, đang là ${result.results[0].commentStatus}`,
  );
  assert.ok(
    warnings.some(m => /[Bb]ình luận/.test(m)),
    'phải có cảnh báo nói rõ bình luận chưa vào được',
  );
});

test('không nhập bình luận thì KHÔNG đụng tới bước bình luận', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const visited: string[] = [];
  const page = {
    goto: async (u: string) => { visited.push(u); },
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'markComposerInviteInPage') return false;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    click: async () => {},
    keyboard: { type: async () => {}, press: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets: ['123456789'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));

  assert.strictEqual(result.results[0].commentStatus, 'not_requested');
  // Không có lời gọi goto nào tới trang bài: bước bình luận bị bỏ hẳn.
  assert.ok(!visited.some(u => /\/posts\//.test(String(u))), 'không được mở trang bài khi không có bình luận');
});

// ---------------------------------------------------------------------------
// Composer PAGE dạng trang riêng (/post/create) — Facebook đổi từ 30/09/2026.
// Đo được: không có dialog, ô soạn trong div[role="form"], nút Post ngoài form,
// không có bước Next, bằng chứng đăng xong là rời trang /post/create.
// ---------------------------------------------------------------------------

/** Page giả cho composer dạng trang riêng. */
function pageStandalone({ buttonDisabled = false, leftPage = true, called = [], clicked = [] }: { buttonDisabled?: boolean; leftPage?: boolean; called?: string[]; clicked?: string[] } = {}) {
  return {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      called.push(fn.name);
      if (fn.name === 'composerIsOpenInPage') return true;
      if (fn.name === 'markComposerInviteInPage') return false;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'isStandaloneComposerInPage') return true;
      if (fn.name === 'isPublishDisabledInPage') return buttonDisabled;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    // Trang riêng KHÔNG được chờ dialog đóng — nếu mã còn gọi waitForSelector
    // với state hidden thì test này phải đỏ.
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') throw new Error('KHÔNG được chờ dialog ở composer trang riêng');
      throw new Error('không tìm thấy (giả lập)');
    },
    waitForFunction: async (fn: AnyFn) => {
      if (fn.name === 'hasLeftCreatePageInPage' && leftPage) return true;
      throw new Error('vẫn ở /post/create (giả lập)');
    },
    click: async () => {},
    keyboard: { type: async () => {}, press: async () => {} },
  };
}

test('composer trang riêng: đăng được mà không cần dialog, không bấm Next, bằng chứng là rời /post/create', async () => {
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const called: string[] = [];
  const page = pageStandalone({ called, clicked });
  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'bai page', targets: ['https://www.facebook.com/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page),
  ));
  assert.strictEqual(result.posted, 1);
  assert.strictEqual(result.results[0].ok, true);
  assert.ok(!called.includes('clickNextInDialog'), 'trang riêng không có bước Next, không được bấm');
  assert.ok(called.includes('isPublishDisabledInPage'), 'phải kiểm nút Đăng có tắt không trước khi bấm');
  assert.deepStrictEqual(clicked, ['publish']);
  assert.strictEqual(closed.length, 1);
});

test('composer trang riêng: nút Đăng đang TẮT thì báo đúng nguyên nhân và KHÔNG bấm', async () => {
  // Bấm một nút đang tắt thì không có gì xảy ra, rồi công cụ chờ 30 giây và
  // báo mơ hồ — đúng triệu chứng "không click nút đăng bài được".
  const closed: boolean[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const called: string[] = [];
  const errors: string[] = [];
  const page = pageStandalone({ buttonDisabled: true, called, clicked });
  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'bai page', targets: ['https://www.facebook.com/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { sendLog: (m, type) => { if (type === 'error') errors.push(m); } }),
  ));
  assert.strictEqual(result.failed, 1);
  assert.ok(!called.includes('markPublishButtonInPage'), 'không được bấm nút Đăng đang tắt');
  assert.deepStrictEqual(clicked, [], 'không được click nút Đăng đang tắt');
  assert.ok(errors.some(m => /đang tắt/.test(m)), `phải nói rõ nút đang tắt, đang có: ${errors.join(' | ')}`);
});

test('composer trang riêng: bấm Đăng xong mà vẫn ở /post/create thì KHÔNG được báo thành công', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const errors: string[] = [];
  const page = pageStandalone({ leftPage: false });
  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'bai page', targets: ['https://www.facebook.com/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { sendLog: (m, type) => { if (type === 'error') errors.push(m); } }),
  ));
  assert.strictEqual(result.failed, 1);
  assert.ok(errors.some(m => /post\/create/.test(m)), `phải nói rõ vẫn ở /post/create, đang có: ${errors.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// Mới trong MaiHub: click tin cậy, onResult, danh tính.
// ---------------------------------------------------------------------------

test('onResult is called once per target, in order, as soon as each target finishes', async () => {
  const ctx = loggedInCtx([]);
  const clicked: string[] = [];
  const events: string[] = [];
  let currentUrl = '';
  const page = {
    goto: async (u: string) => { currentUrl = u; events.push(`goto:${u}`); },
    $: async () => null,
    on: () => {},
    off: () => {},
    // Đích thứ hai không bao giờ mở được composer => ok:false.
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'composerIsOpenInPage') return !currentUrl.includes('/groups/2/');
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    waitForFunction: async () => { throw new Error('composer không mở (giả lập)'); },
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    keyboard: { type: async () => {}, press: async () => {} },
  };

  const received: PostTargetResult[] = [];
  const result = await runWithFakeTimers(() => postToTargets(
    {
      text: 'hi',
      targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'],
      minDelay: 0, maxDelay: 0,
    },
    makeDeps(ctx, page, { onResult: r => { received.push(r); events.push(`result:${r.ok}`); } }),
  ));

  assert.strictEqual(received.length, 2);
  assert.deepStrictEqual(received.map(r => r.ok), [true, false]);
  assert.deepStrictEqual(received, result.results);
  // Kết quả đích 1 phải ra TRƯỚC khi đích 2 bắt đầu, không dồn tới cuối lượt.
  assert.deepStrictEqual(events, [
    'goto:https://www.facebook.com/',
    'goto:https://www.facebook.com/groups/1/',
    'result:true',
    'goto:https://www.facebook.com/groups/2/',
    'result:false',
  ]);
});

test('identity read from the composer is stored on each result', async () => {
  const ctx = loggedInCtx([]);
  const clicked: string[] = [];
  const logs: string[] = [];
  const page = {
    goto: async () => {},
    $: async () => null,
    on: () => {},
    off: () => {},
    evaluate: async (fn: AnyFn) => {
      // Composer chỉ "mở" sau khi click tin cậy vào lời mời.
      if (fn.name === 'composerIsOpenInPage') return clicked.includes('composer-invite');
      if (fn.name === 'readComposerIdentityInPage') return 'Media Soec ơi, bạn đang nghĩ gì thế?';
      if (fn.name === 'markComposerInviteInPage') return true;
      if (fn.name === 'focusEditorInPage') return true;
      if (fn.name === 'markPublishButtonInPage') return true;
      return false;
    },
    locator: fakeLocators(clicked),
    waitForFunction: async () => true,
    waitForSelector: async (_sel: string, opts?: { state?: string }) => {
      if (opts && opts.state === 'hidden') return null;
      throw new Error('không tìm thấy (giả lập)');
    },
    keyboard: { type: async () => {}, press: async () => {} },
  };

  const result = await runWithFakeTimers(() => postToTargets(
    { text: 'hi', targets: ['https://www.facebook.com/groups/1/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, { sendLog: m => logs.push(m) }),
  ));

  assert.strictEqual(result.results[0].ok, true);
  assert.strictEqual(result.results[0].identity, 'Media Soec ơi, bạn đang nghĩ gì thế?');
  assert.ok(logs.some(m => m.includes('Danh tính sẽ đứng tên bài: Media Soec ơi')), 'vẫn phải nói ra danh tính trong nhật ký');
  // Cả hai thao tác mở composer và Đăng đều đi qua click tin cậy, đúng thứ tự.
  assert.deepStrictEqual(clicked, ['composer-invite', 'publish']);
});

// ---------------------------------------------------------------------------
// Hàm đánh dấu chạy thật trên DOM giả: phải GỠ dấu cũ TRƯỚC khi tìm, kể cả khi
// không tìm thấy gì — không thì locator `.first()` bấm nhầm phần tử còn dấu.
// ---------------------------------------------------------------------------

interface FakeNode {
  attrs: Record<string, string>;
  textContent: string;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  closest(sel: string): FakeNode | null;
  querySelectorAll(sel: string): FakeNode[];
}

function fakeNode(init: { attrs?: Record<string, string>; text?: string; closest?: Record<string, FakeNode | null>; children?: Record<string, FakeNode[]> } = {}): FakeNode {
  const node: FakeNode = {
    attrs: { ...(init.attrs || {}) },
    textContent: init.text || '',
    setAttribute(k, v) { node.attrs[k] = v; },
    removeAttribute(k) { delete node.attrs[k]; },
    getAttribute(k) { return k in node.attrs ? node.attrs[k] : null; },
    closest: sel => (init.closest && sel in init.closest ? init.closest[sel] : null),
    querySelectorAll: sel => (init.children && init.children[sel]) || [],
  };
  return node;
}

/** Chạy `fn` với global.document giả. `lists` ánh xạ selector -> phần tử trả về. */
function withFakeDocument<T>(all: FakeNode[], lists: Record<string, FakeNode[]>, pathname: string, fn: () => T): T {
  const g = global as unknown as { document: unknown; location: unknown };
  const oldDocument = g.document;
  const oldLocation = g.location;
  g.document = {
    querySelectorAll: (sel: string) => {
      if (sel === '[data-maihub-target]') return all.filter(n => 'data-maihub-target' in n.attrs);
      return lists[sel] || [];
    },
  };
  g.location = { pathname };
  try { return fn(); } finally { g.document = oldDocument; g.location = oldLocation; }
}

test('markComposerInviteInPage marks the invite and clears a stale mark first', () => {
  const stale = fakeNode({ attrs: { 'data-maihub-target': 'publish' } });
  const other = fakeNode({ text: 'Chia sẻ' });
  const invite = fakeNode({ text: 'Bạn viết gì đi...' });
  const found = withFakeDocument([stale, other, invite], { 'div[role="button"], div.x1i10hfl': [other, invite] }, '/groups/1/',
    () => markComposerInviteInPage(COMPOSER_INVITE));
  assert.strictEqual(found, true);
  assert.strictEqual(stale.getAttribute('data-maihub-target'), null, 'dấu cũ phải bị gỡ');
  assert.strictEqual(invite.getAttribute('data-maihub-target'), 'composer-invite');
  assert.strictEqual(other.getAttribute('data-maihub-target'), null);
});

test('markComposerInviteInPage clears the stale mark even when nothing matches', () => {
  const stale = fakeNode({ attrs: { 'data-maihub-target': 'composer-invite' } });
  const other = fakeNode({ text: 'Chia sẻ' });
  const found = withFakeDocument([stale, other], { 'div[role="button"], div.x1i10hfl': [other] }, '/groups/1/',
    () => markComposerInviteInPage(COMPOSER_INVITE));
  assert.strictEqual(found, false);
  assert.strictEqual(stale.getAttribute('data-maihub-target'), null);
});

test('markPublishButtonInPage marks the aria-label button inside the dialog, not a header Share', () => {
  const stale = fakeNode({ attrs: { 'data-maihub-target': 'composer-invite' } });
  const share = fakeNode({ attrs: { 'aria-label': 'Share' } });
  const publish = fakeNode({ attrs: { 'aria-label': 'Đăng' } });
  const dialog = fakeNode({ children: { 'div[role="button"], button': [publish] } });
  const found = withFakeDocument([stale, share, publish], { 'div[role="dialog"]': [dialog] }, '/groups/1/',
    () => markPublishButtonInPage(PUBLISH_LABELS));
  assert.strictEqual(found, true);
  assert.strictEqual(stale.getAttribute('data-maihub-target'), null);
  assert.strictEqual(publish.getAttribute('data-maihub-target'), 'publish');
  assert.strictEqual(share.getAttribute('data-maihub-target'), null, 'ngoài dialog thì không được đụng');
});

test('markPublishButtonInPage falls back to the span label and marks the wrapping button', () => {
  const wrapper = fakeNode();
  const span = fakeNode({ text: 'Post', closest: { '.x1ja2u2z': null, '[role="button"]': wrapper } });
  const dialog = fakeNode({ children: { 'div[role="button"], button': [], span: [span] } });
  const found = withFakeDocument([wrapper, span], { 'div[role="dialog"]': [dialog] }, '/groups/1/',
    () => markPublishButtonInPage(PUBLISH_LABELS));
  assert.strictEqual(found, true);
  assert.strictEqual(wrapper.getAttribute('data-maihub-target'), 'publish');
  assert.strictEqual(span.getAttribute('data-maihub-target'), null);
});

test('markPublishButtonInPage uses the whole page on /post/create and clears the stale mark when nothing matches', () => {
  const stale = fakeNode({ attrs: { 'data-maihub-target': 'publish' } });
  // Không có dialog nào; trên /post/create gốc tìm là chính document (không có nút nào khớp).
  const found = withFakeDocument([stale], {}, '/post/create/', () => markPublishButtonInPage(PUBLISH_LABELS));
  assert.strictEqual(found, false);
  assert.strictEqual(stale.getAttribute('data-maihub-target'), null);
});

// --- Nhiều ảnh trong một bài ---------------------------------------------

type FakeInput = { evaluate: () => Promise<boolean>; setInputFiles: (f: unknown) => Promise<void> };

/** Trang giả đủ để chạy tới bước đăng; `$` trả ô tải tệp theo `inputs` (hết thì null). */
function mediaPage(opts: {
  multiple: boolean;
  progress?: () => number;
  inputsAvailable?: number;
}) {
  const calls: unknown[] = [];
  const clicked: string[] = [];
  const order: string[] = [];
  let lookups = 0;
  const makeInput = (): FakeInput => ({
    evaluate: async () => opts.multiple,
    setInputFiles: async f => { calls.push(f); },
  });
  const page = {
    goto: async () => {},
    on: () => {},
    evaluate: async (fn: AnyFn) => {
      order.push(fn.name);
      if (fn.name === 'readUploadStateInPage') return { progress: opts.progress ? opts.progress() : 0, publishDisabled: true };
      if (['composerIsOpenInPage', 'focusEditorInPage', 'markPublishButtonInPage'].includes(fn.name)) return true;
      return false;
    },
    locator: fakeLocators(clicked),
    $: async () => {
      lookups += 1;
      return opts.inputsAvailable === undefined || lookups <= opts.inputsAvailable ? makeInput() : null;
    },
    waitForSelector: async () => {},
    keyboard: { type: async () => {} },
  };
  return { page, calls, clicked, order, lookups: () => lookups };
}

function runMedia(page: FakePage, mediaPaths: string[], logs: string[] = []) {
  return runWithFakeTimers(() => postToTargets(
    { text: 'a', mediaPaths, targets: ['123'], minDelay: 0, maxDelay: 0 },
    makeDeps(loggedInCtx([]), page, { sendLog: m => { logs.push(m); } }),
  ));
}

test('ô tải tệp multiple: đúng một lần setInputFiles với đủ mảng theo thứ tự', async () => {
  const m = mediaPage({ multiple: true });
  await runMedia(m.page, ['/a.jpg', '/b.jpg', '/c.jpg']);
  assert.deepStrictEqual(m.calls, [['/a.jpg', '/b.jpg', '/c.jpg']]);
  assert.ok(m.order.includes('readUploadStateInPage'));
});

test('ô tải tệp không multiple: mỗi ảnh một lần, tìm lại ô trước mỗi ảnh từ ảnh thứ hai', async () => {
  const m = mediaPage({ multiple: false });
  await runMedia(m.page, ['/a.jpg', '/b.jpg', '/c.jpg']);
  assert.deepStrictEqual(m.calls, ['/a.jpg', '/b.jpg', '/c.jpg']);
  // 1 lần tìm ban đầu + 2 lần tìm lại (ảnh 2 và 3).
  assert.strictEqual(m.lookups(), 3);
});

test('không multiple, ô biến mất trước ảnh thứ 3: đích failed, không bấm Đăng', async () => {
  const m = mediaPage({ multiple: false, inputsAvailable: 2 });
  const logs: string[] = [];
  const result = await runMedia(m.page, ['/a.jpg', '/b.jpg', '/c.jpg'], logs);
  assert.deepStrictEqual(m.calls, ['/a.jpg', '/b.jpg']);
  assert.ok(logs.some(l => l.includes('Không đính kèm được ảnh thứ 3')));
  assert.ok(!m.order.includes('markPublishButtonInPage'));
  assert.ok(!m.clicked.includes('publish'));
  assert.strictEqual(result.failed, 1);
});

test('thanh tải không bao giờ về 0: đích failed "Ảnh chưa tải lên xong", không bấm Đăng', async () => {
  const m = mediaPage({ multiple: true, progress: () => 1 });
  const logs: string[] = [];
  const result = await runMedia(m.page, ['/a.jpg'], logs);
  assert.ok(logs.some(l => l.includes('Ảnh chưa tải lên xong')));
  assert.ok(!m.order.includes('markPublishButtonInPage'));
  assert.ok(!m.clicked.includes('publish'));
  assert.strictEqual(result.failed, 1);
  // 15 + 5 × 1 = 20 lần đọc, không hơn.
  assert.strictEqual(m.order.filter(n => n === 'readUploadStateInPage').length, 20);
});

test('thanh tải về 0 sau vài lần đọc thì đi tiếp tới bước đăng', async () => {
  let reads = 0;
  const m = mediaPage({ multiple: true, progress: () => (++reads < 3 ? 1 : 0) });
  await runMedia(m.page, ['/a.jpg']);
  assert.strictEqual(reads, 3);
  assert.ok(m.order.includes('markPublishButtonInPage'));
});

test('mediaPaths rỗng: không tìm ô tải tệp, không đọc trạng thái tải', async () => {
  const m = mediaPage({ multiple: true });
  await runMedia(m.page, []);
  assert.strictEqual(m.lookups(), 0);
  assert.ok(!m.order.includes('readUploadStateInPage'));
});

test('filechooser: multiple nhận cả mảng; một tệp qua hộp không multiple vẫn được gắn', async () => {
  for (const [multiple, files, expected] of [
    [true, ['/a.jpg', '/b.jpg'], [['/a.jpg', '/b.jpg']]],
    [false, ['/a.jpg'], ['/a.jpg']],
  ] as const) {
    const m = mediaPage({ multiple: true });
    let handler: ((c: unknown) => Promise<void>) | undefined;
    (m.page as FakePage).on = (ev: string, h: (c: unknown) => Promise<void>) => { if (ev === 'filechooser') handler = h; };
    await runMedia(m.page, [...files]);
    const set: unknown[] = [];
    await handler!({ isMultiple: () => multiple, setFiles: async (f: unknown) => { set.push(f); } });
    assert.deepStrictEqual(set, expected);
  }
});

test('filechooser không multiple với nhiều ảnh: không gắn gì, đích thất bại "ảnh thứ 2", không đăng', async () => {
  const m = mediaPage({ multiple: true });
  let handler: ((c: unknown) => Promise<void>) | undefined;
  (m.page as FakePage).on = (ev: string, h: (c: unknown) => Promise<void>) => { if (ev === 'filechooser') handler = h; };
  const set: unknown[] = [];
  const baseEvaluate = (m.page as FakePage).evaluate as unknown as (fn: AnyFn, arg?: unknown) => Promise<unknown>;
  // Hộp chọn tệp gốc bật lên trong lúc ảnh đang tải.
  (m.page as FakePage).evaluate = async (fn: AnyFn, arg?: unknown) => {
    if (fn.name === 'readUploadStateInPage' && handler) {
      await handler({ isMultiple: () => false, setFiles: async (f: unknown) => { set.push(f); } });
    }
    return baseEvaluate(fn, arg);
  };
  const logs: string[] = [];
  const out = await runMedia(m.page, ['/a.jpg', '/b.jpg'], logs);
  assert.deepStrictEqual(set, []);
  assert.strictEqual(out.posted, 0);
  assert.strictEqual(out.failed, 1);
  assert.ok(logs.some(l => l.includes('Không đính kèm được ảnh thứ 2')));
  assert.ok(!m.order.includes('markPublishButtonInPage'));
});

test('readUploadStateInPage counts progress bars only inside the composer dialog', () => {
  const bar = fakeNode();
  const publish = fakeNode({ attrs: { 'aria-label': 'Đăng', 'aria-disabled': 'true' } });
  const composer = fakeNode({ children: {
    'div[data-lexical-editor="true"]': [fakeNode()],
    '[role="progressbar"]': [bar, bar],
    'div[role="button"], button': [publish],
  } });
  const other = fakeNode({ children: { '[role="progressbar"]': [bar, bar, bar] } });
  const arg = { editorSelectors: ['div[data-lexical-editor="true"]'], labels: PUBLISH_LABELS };
  const state = withFakeDocument([], { 'div[role="dialog"]': [other, composer] }, '/groups/1/',
    () => readUploadStateInPage(arg));
  assert.deepStrictEqual(state, { progress: 2, publishDisabled: true });
  // Không có gốc soạn bài nào: không có gì đang tải.
  assert.deepStrictEqual(
    withFakeDocument([], {}, '/groups/1/', () => readUploadStateInPage(arg)),
    { progress: 0, publishDisabled: null },
  );
});

test('first upload-state read happens only after the settle wait (4000 + 1000*(n-1) ms)', async () => {
  for (const n of [1, 10]) {
    const m = mediaPage({ multiple: true });
    const paths = Array.from({ length: n }, (_, i) => `/${i}.jpg`);
    const origEval = (m.page as FakePage).evaluate as (fn: AnyFn, arg?: unknown) => Promise<unknown>;
    let start = 0;
    let firstRead = -1;
    (m.page as FakePage).on = () => {};
    (m.page as FakePage).evaluate = async (fn: AnyFn, arg: unknown) => {
      if (fn.name === 'readUploadStateInPage' && firstRead < 0) firstRead = Date.now() - start;
      return origEval(fn, arg);
    };
    // Mốc tính từ lúc setInputFiles (sau đó chỉ còn settle wait trước lần đọc đầu).
    const inputs = m.page.$;
    (m.page as FakePage).$ = async () => {
      const el = (await inputs()) as { setInputFiles: (f: unknown) => Promise<void> };
      const orig = el.setInputFiles;
      el.setInputFiles = async f => { start = Date.now(); return orig(f); };
      return el;
    };
    await runMedia(m.page, paths);
    assert.ok(firstRead >= 4000 + 1000 * (n - 1), `n=${n}: first read at ${firstRead} ms`);
  }
});

// Bình luận sau X phút (phương án A, duyệt 2026-10-10): đăng xong chờ X phút mới bình luận; thời gian chờ trừ vào
// khoảng nghỉ trước đích kế tiếp để lần chạy không dài thêm.
const GROUP_POST_BODY = '{"data":{"story_create":{"story":{"post_id":"123456","id":"abc"}}}}';
function timedLogs() {
  const logs: { at: number; msg: string }[] = [];
  return { logs, sendLog: (msg: string) => { logs.push({ at: Date.now(), msg }); } };
}

test('commentDelayMin: chờ đủ X phút sau khi đăng rồi mới bình luận, và trừ vào khoảng nghỉ', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: GROUP_POST_BODY });
  const { logs, sendLog } = timedLogs();
  await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', comment: 'cmt', commentDelayMin: 5, targets: ['https://www.facebook.com/groups/777/', 'https://www.facebook.com/groups/888/'], minDelay: 600, maxDelay: 600 },
    makeDeps(ctx, page, { sendLog }),
  ));
  const posted = logs.find((l) => l.msg.includes('[SUCCESS]'))!;
  const commented = logs.find((l) => l.msg.startsWith('[Bình luận]'))!;
  assert.ok(logs.some((l) => l.msg.includes('Chờ 5 phút rồi bình luận')), 'phải báo đang chờ');
  assert.ok(commented && commented.at - posted.at >= 5 * 60_000, `bình luận sau ${(commented?.at - posted.at) / 1000}s, cần ≥ 300s`);
  assert.ok(logs.some((l) => l.msg.includes('Nghỉ 300 giây trước bài viết tiếp theo')), 'khoảng nghỉ 600s phải trừ 300s đã chờ');
});

test('commentDelayMin: bấm Huỷ trong lúc chờ thì không bình luận', async () => {
  const ctx = loggedInCtx([]);
  const page = pageSuccessful({ graphqlBody: GROUP_POST_BODY });
  const { logs, sendLog } = timedLogs();
  let stopping = false;
  const ra = await runWithFakeTimers(() => postToTargets(
    { text: 'nội dung', comment: 'cmt', commentDelayMin: 10, targets: ['https://www.facebook.com/groups/777/'], minDelay: 0, maxDelay: 0 },
    makeDeps(ctx, page, {
      sendLog: (msg: string) => { sendLog(msg); if (msg.includes('Chờ 10 phút')) setTimeout(() => { stopping = true; }, 60_000); },
      getIsStopping: () => stopping,
    }),
  ));
  assert.strictEqual(ra.results[0].ok, true, 'bài đã đăng thì vẫn là thành công');
  assert.strictEqual(ra.results[0].commentStatus, 'failed');
  assert.ok(!logs.some((l) => l.msg.startsWith('[Bình luận]')), 'không được mở bài để bình luận sau khi huỷ');
});
