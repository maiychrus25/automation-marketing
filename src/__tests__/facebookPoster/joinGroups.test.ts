import assert from 'node:assert';
import {
  buildSearchUrl,
  searchGroupsByKeyword,
  searchAndJoinGroups,
} from '../../services/facebookPoster/joinGroups';
import { fakeLocators } from './helpers';

// Fake DOM/phần tử dùng kiểu lỏng: chỉ cần đủ hình dạng cho các hàm chạy trong trình duyệt.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

test('buildSearchUrl encode từ khoá có dấu và khoảng trắng', () => {
  assert.strictEqual(
    buildSearchUrl('việc làm thái nguyên'),
    'https://www.facebook.com/search/groups/?q=vi%E1%BB%87c%20l%C3%A0m%20th%C3%A1i%20nguy%C3%AAn',
  );
});

test('buildSearchUrl cắt khoảng trắng thừa hai đầu', () => {
  assert.strictEqual(buildSearchUrl('  abc  '), 'https://www.facebook.com/search/groups/?q=abc');
});

test('buildSearchUrl từ khoá rỗng thì ném lỗi', () => {
  assert.throws(() => buildSearchUrl('   '), /rỗng/);
  assert.throws(() => buildSearchUrl(undefined as Any), /rỗng/);
});

function loggedInCtx(closed: boolean[]): Any {
  return {
    cookies: async () => [{ name: 'c_user', value: '1' }],
    close: async () => { closed.push(true); },
  };
}

test('searchGroupsByKeyword lọc kết quả và đóng context', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = {
    goto: async () => {},
    // Mô phỏng đúng thứ tự đo được trên trang thật: link ảnh không chữ, rồi
    // link tên. Thêm một link Trang (quảng cáo) để chắc nó bị loại.
    evaluate: async () => ([
      { href: '/groups/111/', text: '' },
      { href: '/groups/111/', text: 'Việc Làm Thái Nguyên' },
      { href: '/TokkiSongCong/', text: 'Tokki Sông Công Thái Nguyên' },
    ]),
  };

  const out = await searchGroupsByKeyword({
    keyword: 'việc làm', launch: async () => ({ ctx, page }) as Any, settleMs: 0,
  });

  assert.deepStrictEqual(out, [{
    id: '111', name: 'Việc Làm Thái Nguyên',
    url: 'https://www.facebook.com/groups/111/',
  }]);
  assert.strictEqual(closed.length, 1);
});

test('searchGroupsByKeyword chưa đăng nhập thì ném lỗi, KHÔNG vào trang tìm, vẫn đóng context', async () => {
  const closed: boolean[] = [];
  const visited: string[] = [];
  const ctx = { cookies: async () => [], close: async () => { closed.push(true); } };
  const page = { goto: async (url: string) => { visited.push(url); }, evaluate: async () => [] };

  await assert.rejects(
    searchGroupsByKeyword({ keyword: 'x', launch: async () => ({ ctx, page }) as Any, settleMs: 0 }),
    /Chưa đăng nhập/,
  );
  assert.strictEqual(closed.length, 1);
  assert.ok(!visited.some(u => u.includes('/search/groups')), 'chưa đăng nhập thì không được vào trang tìm');
});

/** Tạo phần tử giả. Ghi lại thuộc tính do hàm trong trang đặt/gỡ (dấu data-maihub-target). */
function fakeEl(props: Record<string, Any> = {}): Any {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    getAttribute: (name: string) => {
      if (name in attrs) return attrs[name];
      if (name === 'role') return 'button';
      if (name === 'aria-label') return props['aria-label'] || '';
      return props[name] || null;
    },
    setAttribute: (name: string, value: string) => { attrs[name] = value; },
    removeAttribute: (name: string) => { delete attrs[name]; },
    innerText: props.innerText || '',
    click: () => { props.clicked = true; },
    parentElement: null,
    querySelectorAll: () => [],
  };
}

/** Tạo DOM giả cho một nhóm. */
function fakeDOM(config: { buttons?: Any[]; dialogs?: Any[] } = {}): Any {
  const { buttons = [], dialogs = [] } = config;
  const doc: Any = {
    querySelector: (sel: string) => {
      if (sel === '[role="main"]') return doc;
      if (sel === 'div[role="dialog"]') return dialogs[0] || null;
      return null;
    },
    querySelectorAll: (sel: string) => {
      if (sel === 'div[role="dialog"]') return dialogs;
      if (sel === 'div[role="button"], a[role="button"]') return buttons;
      // Hàm đánh dấu gỡ dấu cũ bằng selector này: trả đúng các phần tử đang mang dấu.
      if (sel === '[data-maihub-target]') return buttons.filter(b => b.attrs && 'data-maihub-target' in b.attrs);
      return [];
    },
  };

  // Đảm bảo dialogs cũng có querySelectorAll
  dialogs.forEach(d => {
    if (!d.querySelectorAll) {
      d.querySelectorAll = (sel: string) => {
        if (sel === 'div[role="button"], a[role="button"]') return d.closeButtons || [];
        if (sel.includes('textarea') || sel.includes('input') || sel.includes('contenteditable')) {
          return d.hasInput ? [fakeEl({})] : [];
        }
        return [];
      };
    }
    if (!d.querySelector) {
      d.querySelector = (sel: string) => {
        if (sel.includes('textarea') || sel.includes('input') || sel.includes('contenteditable')) {
          return d.hasInput ? fakeEl({}) : null;
        }
        return null;
      };
    }
  });

  return doc;
}

/** Trình duyệt giả: ghi lại URL, các lần bấm locator, và chạy hàm với DOM giả. */
function fakeBrowser(domByGroupId: Record<string, Any>, closed: boolean[]): Any {
  const visited: string[] = [];
  const clicked: string[] = [];
  const ctx = loggedInCtx(closed);
  const page: Any = {
    goto: async (url: string) => { visited.push(url); },
    locator: fakeLocators(clicked),
    evaluate: async (fn: Any, arg: Any) => {
      const currentUrl = visited[visited.length - 1] || '';
      const match = currentUrl.match(/\/groups\/([^/?#]+)/);
      const groupId = match ? match[1] : '';
      const fakeDoc = domByGroupId[groupId] || fakeDOM({});

      // Chạy hàm thật với DOM giả: gán vào global.document trong Node
      const g = global as Any;
      const savedDoc = g.document;
      g.document = fakeDoc;
      try {
        return await fn(arg);
      } finally {
        g.document = savedDoc;
      }
    },
  };
  return { ctx, page, visited, clicked };
}

const emptyScan = async () => ({ groups: [], hitScrollLimit: false, scrollRounds: 0, scrollError: false });

/** Deps đủ dùng cho test: mọi thời gian chờ về 0, `extra` ghi đè từng phần. */
function makeDeps(b: Any, extra: Record<string, Any> = {}): Any {
  return {
    launch: async () => b,
    getIsStopping: () => false,
    sendLog: () => {},
    updateProgress: () => {},
    settleMs: 0, groupSettleMs: 0, pollMs: 0, joinWaitMs: 0,
    scan: emptyScan,
    ...extra,
  };
}

const ZERO = { minDelay: 0, maxDelay: 0 };
const joinAndJoined = () => fakeDOM({ buttons: [fakeEl({ innerText: 'Join' }), fakeEl({ innerText: 'Joined' })] });

test('searchAndJoinGroups keywords rỗng thì ném lỗi trước khi mở trình duyệt', async () => {
  let launched = false;
  const deps = { ...makeDeps(null), launch: async () => { launched = true; return undefined as Any; } };
  await assert.rejects(searchAndJoinGroups({ keywords: [] }, deps), /từ khoá/i);
  await assert.rejects(searchAndJoinGroups({ keywords: 'abc' as Any }, deps), /từ khoá/i);
  assert.strictEqual(launched, false);
});

test('searchAndJoinGroups bỏ qua nhóm đã tham gia', async () => {
  const closed: boolean[] = [];
  const b = fakeBrowser({
    '222': fakeDOM({ buttons: [
      fakeEl({ innerText: 'Join' }),
      fakeEl({ innerText: 'Cancel request' }),
    ] }),
  }, closed);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      scan: async () => ({ groups: [{ id: '111', name: 'Đã vào', url: 'u' }], hitScrollLimit: false, scrollRounds: 0, scrollError: false }),
      search: async () => ([
        { id: '111', name: 'Đã vào', url: 'https://www.facebook.com/groups/111/' },
        { id: '222', name: 'Nhóm mới', url: 'https://www.facebook.com/groups/222/' },
      ]),
    }),
  );
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0].id, '222');
  assert.strictEqual(out.pending, 1);
  assert.strictEqual(closed.length, 1);
});

// I-1: scanGroups trả bốn trường (groups, hitScrollLimit, scrollRounds, scrollError).
// searchAndJoinGroups phải đọc hitScrollLimit/scrollError và cảnh báo — nếu không, danh sách
// "đã ở trong" bị cụt trong im lặng, rồi search trả lại đúng nhóm bị sót,
// gửi lại yêu cầu, ghi outcome 'failed' cho một nhóm thực ra đã tham gia.
test('quét bị chạm trần thì cảnh báo danh sách có thể thiếu', async () => {
  const logs: { message: string; type: string }[] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(fakeBrowser({}, []), {
      scan: async () => ({ groups: [], hitScrollLimit: true, scrollRounds: 15, scrollError: false }),
      search: async () => [],
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  const warning = logs.find(l => l.message.includes('CÓ THỂ THIẾU'));
  assert.ok(warning, 'phải cảnh báo khi hitScrollLimit true');
  assert.strictEqual(warning.type, 'warning');
});

test('quét bị lỗi cuộn giữa chừng thì cảnh báo danh sách có thể thiếu', async () => {
  const logs: { message: string; type: string }[] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(fakeBrowser({}, []), {
      scan: async () => ({ groups: [], hitScrollLimit: false, scrollRounds: 3, scrollError: true }),
      search: async () => [],
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  const warning = logs.find(l => l.message.includes('CÓ THỂ THIẾU'));
  assert.ok(warning, 'phải cảnh báo khi scrollError true');
  assert.strictEqual(warning.type, 'warning');
});

test('quét bình thường (không chạm trần, không lỗi cuộn) thì không cảnh báo thiếu', async () => {
  const logs: { message: string; type: string }[] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(fakeBrowser({}, []), {
      scan: async () => ({ groups: [], hitScrollLimit: false, scrollRounds: 3, scrollError: false }),
      search: async () => [],
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  assert.ok(!logs.some(l => l.message.includes('CÓ THỂ THIẾU')), 'đường bình thường không được cảnh báo thiếu');
});

test('searchAndJoinGroups không vượt quá limit khi hai từ khoá', async () => {
  const closed: boolean[] = [];
  const b = fakeBrowser({
    '1': joinAndJoined(), '2': joinAndJoined(), '3': joinAndJoined(), '4': joinAndJoined(),
  }, closed);
  const out = await searchAndJoinGroups(
    { keywords: ['a', 'b'], ...ZERO, limit: 3 },
    makeDeps(b, {
      search: async ({ keyword }: { keyword: string }) => {
        // Keyword 'a' returns groups 1,2; keyword 'b' returns groups 3,4
        if (keyword === 'a') return [1, 2].map(n => ({
          id: String(n), name: 'A' + n, url: `https://www.facebook.com/groups/${n}/`,
        }));
        return [3, 4].map(n => ({
          id: String(n), name: 'B' + n, url: `https://www.facebook.com/groups/${n}/`,
        }));
      },
    }),
  );
  assert.strictEqual(out.results.length, 3);
  assert.strictEqual(out.joined, 3);
});

test('searchAndJoinGroups không gửi trùng khi hai từ khoá cùng ra một nhóm', async () => {
  const b = fakeBrowser({ '9': joinAndJoined() }, []);
  const one = { id: '9', name: 'Trùng', url: 'https://www.facebook.com/groups/9/' };
  const out = await searchAndJoinGroups(
    { keywords: ['a', 'b'], ...ZERO },
    makeDeps(b, { search: async () => ([one]) }),
  );
  assert.strictEqual(out.results.length, 1);
});

test('searchAndJoinGroups nhận Pending khi bấm Join xong trả Pending', async () => {
  const b = fakeBrowser({
    'g1': fakeDOM({ buttons: [fakeEl({ innerText: 'Join' }), fakeEl({ innerText: 'Pending' })] }),
  }, []);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]) }),
  );
  assert.strictEqual(out.results[0].outcome, 'pending');
  assert.ok(b.clicked.includes('join'), 'phải bấm Join bằng locator tin cậy');
});

test('searchAndJoinGroups nhận Joined khi bấm Join xong trả Joined', async () => {
  const b = fakeBrowser({ 'g1': joinAndJoined() }, []);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]) }),
  );
  assert.strictEqual(out.results[0].outcome, 'joined');
  assert.ok(b.clicked.includes('join'), 'phải bấm Join bằng locator tin cậy');
});

test('searchAndJoinGroups page.goto ném lỗi ở nhóm đầu thì nhóm sau vẫn được xử lý', async () => {
  const b = fakeBrowser({
    '1': fakeDOM({ buttons: [fakeEl({ innerText: 'Join' })] }),
    '2': joinAndJoined(),
    '3': joinAndJoined(),
  }, []);
  const origGoto = b.page.goto;
  const gotoErrors: Record<string, boolean> = { '1': true };
  b.page.goto = async (url: string) => {
    const match = url.match(/\/groups\/([^/?#]+)/);
    const groupId = match ? match[1] : '';
    if (gotoErrors[groupId]) {
      throw new Error('Network error on group ' + groupId);
    }
    return origGoto(url);
  };
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([
        { id: '1', name: 'N1', url: 'https://www.facebook.com/groups/1/' },
        { id: '2', name: 'N2', url: 'https://www.facebook.com/groups/2/' },
        { id: '3', name: 'N3', url: 'https://www.facebook.com/groups/3/' },
      ]),
    }),
  );
  assert.strictEqual(out.results.length, 3);
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.strictEqual(out.results[1].outcome, 'joined');
  assert.strictEqual(out.results[2].outcome, 'joined');
});

test('searchAndJoinGroups dừng khi getIsStopping() trả true', async () => {
  const b = fakeBrowser({ '1': joinAndJoined(), '2': joinAndJoined() }, []);
  let stopAfterN = 2;  // Called once during search phase, once at start of first target loop
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([
        { id: '1', name: 'N1', url: 'https://www.facebook.com/groups/1/' },
        { id: '2', name: 'N2', url: 'https://www.facebook.com/groups/2/' },
      ]),
      getIsStopping: () => stopAfterN-- <= 0,
    }),
  );
  assert.strictEqual(out.results.length, 1);
});

test('searchAndJoinGroups không có ứng viên thì trả đúng kết quả trống', async () => {
  const b = fakeBrowser({}, []);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => [] }),
  );
  assert.deepStrictEqual(out, { joined: 0, pending: 0, skipped: 0, failed: 0, results: [] });
});

// Nhóm hỏi câu hỏi thành viên: người dùng chọn KHÔNG trả lời, chỉ đóng hộp
// thoại rồi xếp vào chờ duyệt. Hai nhánh dưới đây là hai kết cục khác nhau và
// phải được phân biệt trong nhật ký, vì đóng hộp câu hỏi rất có thể đã huỷ
// luôn yêu cầu — ghi "đã gửi" khi chưa gửi là đúng loại lỗi dự án đã trả giá.
test('nhóm có câu hỏi, đóng xong nút KHÔNG đổi: vẫn pending nhưng nhật ký nói rõ chưa xác nhận', async () => {
  const dialog = fakeEl({ innerText: 'Question' });
  dialog.hasInput = true;
  const b = fakeBrowser({
    'g1': fakeDOM({
      buttons: [fakeEl({ innerText: 'Join' })],
      dialogs: [dialog],
    }),
  }, []);
  const logs: { message: string; type: string }[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'pending');
  assert.strictEqual(out.pending, 1);
  assert.strictEqual(out.skipped, 0, 'không còn xếp vào skipped nữa');
  const warning = logs.find(l => l.message.includes('CHƯA xác nhận'));
  assert.ok(warning, 'phải có dòng nhật ký nói rõ chưa xác nhận được yêu cầu đã gửi');
  assert.strictEqual(warning.type, 'warning', 'không được ghi là success');
});

test('nhóm có câu hỏi, đóng xong nút ĐỔI sang Pending: ghi pending và báo thành công', async () => {
  const dialog = fakeEl({ innerText: 'Question' });
  dialog.hasInput = true;

  // DOM tự đổi sau khi đóng hộp thoại: hộp biến mất và nút thành "Pending",
  // mô phỏng trường hợp Facebook vẫn ghi nhận yêu cầu.
  const joinButton = fakeEl({ innerText: 'Join' });
  const dialogs = [dialog];
  const buttons = [joinButton];
  const closeButton = {
    getAttribute: (name: string) => (name === 'aria-label' ? 'Close' : null),
    click: () => { dialogs.length = 0; buttons[0] = fakeEl({ innerText: 'Pending' }); },
  };
  // fakeEl đã tự có querySelectorAll trả rỗng, nên fakeDOM sẽ KHÔNG gắn bản
  // nhận biết nút đóng. Phải ghi đè, không thì closeDialogInPage không tìm
  // thấy nút nào và hộp thoại chẳng bao giờ đóng trong fake.
  dialog.querySelectorAll = (sel: string) =>
    (sel === 'div[role="button"], a[role="button"]' ? [closeButton] : []);

  const b = fakeBrowser({ 'g1': fakeDOM({ buttons, dialogs }) }, []);
  const logs: { message: string; type: string }[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'pending');
  assert.ok(logs.some(l => l.type === 'success' && l.message.includes('nút đã đổi')),
    'nút đã đổi thật thì được báo thành công');
  assert.ok(!logs.some(l => l.message.includes('CHƯA xác nhận')),
    'không được cảnh báo nhầm khi đã có bằng chứng');
});

test('markJoinButtonInPage bỏ qua nút của nhóm gợi ý có link khác trước nút của nhóm đúng', async () => {
  // Tạo DOM giả với chuỗi tổ tiên: nút 999 trong wrapper có link /groups/999/, nút 111 trong wrapper có link /groups/111/
  const btn999 = fakeEl({ innerText: 'Join' });
  const btn111 = fakeEl({ innerText: 'Join' });

  // Tạo wrapper cho nút 999 với link /groups/999/
  const wrapper999 = fakeEl({ innerText: '' });
  wrapper999.querySelector = (sel: string) => {
    if (sel.includes('/groups/')) {
      return fakeEl({ href: '/groups/999/some-group/' });
    }
    return null;
  };
  btn999.parentElement = wrapper999;
  wrapper999.parentElement = null; // Nó là con của root

  // Tạo wrapper cho nút 111 với link /groups/111/
  const wrapper111 = fakeEl({ innerText: '' });
  wrapper111.querySelector = (sel: string) => {
    if (sel.includes('/groups/')) {
      return fakeEl({ href: '/groups/111/my-group/' });
    }
    return null;
  };
  btn111.parentElement = wrapper111;
  wrapper111.parentElement = null; // Nó là con của root

  const b = fakeBrowser({ '111': fakeDOM({ buttons: [btn999, btn111] }) }, []);

  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: '111', name: 'Test', url: 'https://www.facebook.com/groups/111/' }]) }),
  );
  // Bên Node bấm bằng locator tin cậy; thứ cần kiểm là phần tử NÀO mang dấu.
  assert.strictEqual(btn111.attrs['data-maihub-target'], 'join', 'phải đánh dấu nút của nhóm 111');
  assert.ok(!('data-maihub-target' in btn999.attrs), 'không được đánh dấu nút của nhóm 999');
  assert.deepStrictEqual(b.clicked, ['join']);
});

test('searchAndJoinGroups để lỗi từ search nổi lên và KHÔNG mở trình duyệt', async () => {
  let launched = false;
  await assert.rejects(
    searchAndJoinGroups(
      { keywords: ['x'], ...ZERO },
      makeDeps(null, {
        launch: async () => { launched = true; return {}; },
        search: async () => { throw new Error('tìm hỏng'); },
      }),
    ),
    /tìm hỏng/,
  );
  assert.strictEqual(launched, false);
});

test('searchAndJoinGroups chỉ thấy nút Join mãi mãi thì outcome failed và log "không rõ kết quả"', async () => {
  // Nút Join không bao giờ đổi thành Joined/Pending — mô phỏng Facebook không
  // phản hồi trong lúc chờ.
  const b = fakeBrowser({ g1: fakeDOM({ buttons: [fakeEl({ innerText: 'Join' })] }) }, []);
  const logs: string[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      joinWaitMs: 30,
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (msg: string) => logs.push(msg),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.ok(logs.some(m => m.includes('không rõ kết quả')), 'phải log không rõ kết quả');
});

test('searchAndJoinGroups không có nút Tham gia nào khớp thì outcome failed và log "Không tìm thấy nút Tham gia"', async () => {
  const b = fakeBrowser({ g1: fakeDOM({ buttons: [] }) }, []);
  const logs: string[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (msg: string) => logs.push(msg),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.ok(logs.some(m => m.includes('Không tìm thấy nút Tham gia')), 'phải log không tìm thấy nút');
  assert.deepStrictEqual(b.clicked, [], 'không có nút khớp thì không được bấm gì');
});

test('searchAndJoinGroups đọc lại nhiều lần cho tới khi có dấu hiệu dương (vòng lặp poll thật sự chạy)', async () => {
  const buttons = [fakeEl({ innerText: 'Join' })]; // ban đầu chỉ có Join
  const b = fakeBrowser({ g1: fakeDOM({ buttons }) }, []);
  let readCalls = 0;
  const origEvaluate = b.page.evaluate;
  b.page.evaluate = async (fn: Any, arg: Any) => {
    if (fn.name === 'readJoinOutcomeInPage') {
      readCalls += 1;
      if (readCalls === 2) {
        // Lần đọc thứ hai: DOM "cập nhật" — Facebook đã phản hồi Joined
        buttons.push(fakeEl({ innerText: 'Joined' }));
      }
    }
    return origEvaluate(fn, arg);
  };
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      joinWaitMs: 5000,
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
    }),
  );
  assert.ok(readCalls >= 2, 'phải thật sự đọc lại nhiều lần, không phải một lần rồi kết luận');
  assert.strictEqual(out.results[0].outcome, 'joined');
});

test('markJoinButtonInPage dừng ở tổ tiên gần nhất, không bị tổ tiên xa ghi đè (chuỗi nhiều cấp)', async () => {
  // Chuỗi thật đo được: nút trong card(/groups/111/) nằm trong column mà
  // link /groups/ ĐẦU TIÊN trong column lại là thẻ nhóm gợi ý /groups/999/.
  const btn = fakeEl({ innerText: 'Join' });

  const card = fakeEl({ innerText: '' });
  card.querySelector = (sel: string) => (sel.includes('/groups/') ? fakeEl({ href: '/groups/111/' }) : null);
  const column = fakeEl({ innerText: '' });
  column.querySelector = (sel: string) => (sel.includes('/groups/') ? fakeEl({ href: '/groups/999/' }) : null);

  btn.parentElement = card;
  card.parentElement = column;
  column.parentElement = null;

  const b = fakeBrowser({ '111': fakeDOM({ buttons: [btn] }) }, []);
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: '111', name: 'Test', url: 'https://www.facebook.com/groups/111/' }]) }),
  );
  assert.strictEqual(btn.attrs['data-maihub-target'], 'join', 'phải đánh dấu nút đúng dù tổ tiên xa trỏ nhóm khác');
  assert.deepStrictEqual(b.clicked, ['join']);
});

test('markJoinButtonInPage bỏ qua nút Tham gia nằm trong [role="article"] (nút của Sự kiện trong feed)', async () => {
  const btn = fakeEl({ innerText: 'Join' });
  // Phần tử tổ tiên có role="article" — vd. một bài đăng trong feed nhóm
  // chứa thẻ Sự kiện với nút Tham gia riêng của sự kiện đó.
  const article = {
    getAttribute: (name: string) => (name === 'role' ? 'article' : null),
    parentElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  btn.parentElement = article;

  const b = fakeBrowser({ '111': fakeDOM({ buttons: [btn] }) }, []);
  const logs: string[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([{ id: '111', name: 'Test', url: 'https://www.facebook.com/groups/111/' }]),
      sendLog: (msg: string) => logs.push(msg),
    }),
  );
  assert.ok(!('data-maihub-target' in btn.attrs), 'không được đánh dấu nút Tham gia của Sự kiện trong feed');
  assert.deepStrictEqual(b.clicked, [], 'không được bấm nút của Sự kiện trong feed');
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.ok(logs.some(m => m.includes('Không tìm thấy nút Tham gia')));
});

test('readJoinOutcomeInPage bỏ qua nhãn Joined của nhóm liên quan (khác nhóm), không kết luận sớm', async () => {
  const joinBtn = fakeEl({ innerText: 'Join' });
  const joinWrap = fakeEl({ innerText: '' });
  joinWrap.querySelector = (sel: string) => (sel.includes('/groups/') ? fakeEl({ href: '/groups/111/' }) : null);
  joinBtn.parentElement = joinWrap;

  // Thẻ "Nhóm liên quan" lạc trong main, thuộc nhóm khác (999), đã hiện Joined
  const strayJoined = fakeEl({ innerText: 'Joined' });
  const strayWrap = fakeEl({ innerText: '' });
  strayWrap.querySelector = (sel: string) => (sel.includes('/groups/') ? fakeEl({ href: '/groups/999/' }) : null);
  strayJoined.parentElement = strayWrap;

  const b = fakeBrowser({ '111': fakeDOM({ buttons: [joinBtn, strayJoined] }) }, []);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      joinWaitMs: 30,
      search: async () => ([{ id: '111', name: 'Test', url: 'https://www.facebook.com/groups/111/' }]),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'failed', 'nhãn Joined của nhóm khác không được tính là dấu hiệu dương');
});

test('searchAndJoinGroups thật sự gọi closeDialogInPage khi gặp câu hỏi thành viên (không chỉ suy luận từ outcome)', async () => {
  // Không dùng fakeEl() cho dialog: nó đã tự gán querySelectorAll mặc định
  // (trả về []), nên fakeDOM không có chỗ chèn querySelectorAll riêng cho
  // dialog (chỉ chèn khi thiếu). Dựng object trần để fakeDOM tự lắp đủ hai
  // hàm (querySelector cho hasInput, querySelectorAll cho closeButtons).
  const dialog: Any = { hasInput: true };
  const closeBtn = fakeEl({ 'aria-label': 'Close' });
  let closeClicked = false;
  closeBtn.click = () => { closeClicked = true; };
  dialog.closeButtons = [closeBtn];
  const b = fakeBrowser({
    g1: fakeDOM({ buttons: [fakeEl({ innerText: 'Join' })], dialogs: [dialog] }),
  }, []);
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]) }),
  );
  assert.strictEqual(closeClicked, true, 'phải thật sự bấm nút đóng hộp thoại, không chỉ đổi outcome');
});

test('readJoinOutcomeInPage trả giá trị lạ thì rơi về failed, không báo thành công', async () => {
  const b = fakeBrowser({ g1: fakeDOM({ buttons: [fakeEl({ innerText: 'Join' })] }) }, []);
  const origEvaluate = b.page.evaluate;
  b.page.evaluate = async (fn: Any, arg: Any) => {
    if (fn.name === 'readJoinOutcomeInPage') return undefined; // giá trị lạ
    return origEvaluate(fn, arg);
  };
  const logs: { msg: string; type: string }[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      joinWaitMs: 30,
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (msg: string, type: string) => logs.push({ msg, type }),
    }),
  );
  assert.strictEqual(out.results[0].outcome, 'failed');
  assert.ok(!logs.some(l => l.type === 'success'), 'không được log thành công khi giá trị lạ');
});

test('searchAndJoinGroups phân biệt "không tìm thấy nhóm" và "tất cả ứng viên đã tham gia"', async () => {
  const b = fakeBrowser({}, []);

  const logsNoResult: string[] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => [], // từ khoá không ra nhóm nào
      sendLog: (msg: string) => logsNoResult.push(msg),
    }),
  );

  const logsAllJoined: string[] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      scan: async () => ({ groups: [{ id: '1' }], hitScrollLimit: false, scrollRounds: 0, scrollError: false }),
      search: async () => ([{ id: '1', name: 'Đã vào', url: 'https://www.facebook.com/groups/1/' }]),
      sendLog: (msg: string) => logsAllJoined.push(msg),
    }),
  );

  assert.ok(logsNoResult.includes('Không tìm thấy nhóm nào khớp từ khoá đã nhập.'));
  assert.ok(logsAllJoined.includes(
    'Tìm thấy nhóm nhưng tất cả đều đã tham gia hoặc trùng lặp — không có nhóm mới để gửi yêu cầu.',
  ));
});

test('searchAndJoinGroups bấm huỷ giữa lúc nghỉ thì cắt sớm, không xử lý nhóm còn lại', async () => {
  const b = fakeBrowser({ 1: joinAndJoined(), 2: joinAndJoined() }, []);
  let calls = 0;
  const start = Date.now();
  const out = await searchAndJoinGroups(
    { keywords: ['x'], minDelay: 5, maxDelay: 5 }, // 5 giây nghỉ giữa hai nhóm nếu KHÔNG bị huỷ
    makeDeps(b, {
      restCheckMs: 10, // lát ngủ nhỏ để test nhanh, vẫn chứng minh được việc cắt sớm
      search: async () => ([
        { id: '1', name: 'N1', url: 'https://www.facebook.com/groups/1/' },
        { id: '2', name: 'N2', url: 'https://www.facebook.com/groups/2/' },
      ]),
      // false trong lúc tìm/xử lý nhóm 1, true ngay khi vừa vào giấc nghỉ
      // (mô phỏng người dùng bấm Huỷ trong lúc job đang ngủ giữa hai nhóm)
      getIsStopping: () => (calls += 1) > 3,
    }),
  );
  const elapsed = Date.now() - start;
  assert.strictEqual(out.results.length, 1, 'không được xử lý nhóm còn lại sau khi huỷ giữa giấc nghỉ');
  assert.ok(elapsed < 500, `phải cắt sớm, không chờ hết 5 giây (mất ${elapsed}ms)`);
});

test('searchAndJoinGroups đóng context kể cả khi vòng lặp ném lỗi giữa chừng', async () => {
  const closed: boolean[] = [];
  const b = fakeBrowser({ '1': fakeDOM({ buttons: [fakeEl({ innerText: 'Join' })] }) }, closed);
  await assert.rejects(
    searchAndJoinGroups(
      { keywords: ['x'], ...ZERO },
      makeDeps(b, {
        search: async () => ([{ id: '1', name: 'N', url: 'https://www.facebook.com/groups/1/' }]),
        updateProgress: () => { throw new Error('vỡ giữa chừng'); },
      }),
    ),
    /vỡ giữa chừng/,
  );
  assert.strictEqual(closed.length, 1, 'context phải được đóng trong finally');
});

test('không truyền scan thì dùng scanGroups thật — chốt chặn hợp đồng giữa hai module', async () => {
  // Mọi test khác đều tự truyền `scan`, nên nhánh mặc định `scan = scanGroups`
  // chưa bao giờ được chạy. Đổi kiểu trả về của scanGroups mà không sửa
  // searchAndJoinGroups sẽ làm tính năng vỡ khi chạy thật mà test vẫn xanh.
  const ctx = {
    cookies: async () => [{ name: 'c_user', value: '1' }],
    close: async () => {},
  };
  const page = {
    goto: async () => {},
    evaluate: async (fn: Any) => {
      if (fn.name === 'scrollToBottomInPage') return 1000;
      return [{ href: '/groups/111/', text: 'Nhóm đã vào' }];
    },
  };

  const logs: string[] = [];
  await searchAndJoinGroups(
    { keywords: ['abc'], ...ZERO },
    makeDeps({ ctx, page }, {
      scan: undefined,
      settleMs: 0,
      scrollWaitMs: 0,
      search: async () => [],
      sendLog: (m: string) => logs.push(m),
    }),
  );

  assert.ok(
    logs.some(m => /đang ở trong 1 nhóm/i.test(m)),
    'phải đọc được đúng 1 nhóm qua scanGroups thật, không ném TypeError',
  );
});

// --- Bổ sung riêng cho bản MaiHub (click tin cậy, onResult, launch không tham số) ---

test('markJoinButtonInPage gỡ dấu cũ trước khi tìm: không có nút khớp thì không còn dấu nào để locator bấm nhầm', async () => {
  // Nút mang dấu "join" còn sót từ lần trước, nhưng lần này nó không còn là nút
  // Tham gia (nhãn đã đổi). locator .first() sẽ bấm nhầm nó nếu dấu cũ không bị gỡ.
  const stale = fakeEl({ innerText: 'Share' });
  stale.setAttribute('data-maihub-target', 'join');
  const b = fakeBrowser({ g1: fakeDOM({ buttons: [stale] }) }, []);
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, { search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]) }),
  );
  assert.ok(!('data-maihub-target' in stale.attrs), 'dấu cũ phải được gỡ');
  assert.deepStrictEqual(b.clicked, []);
  assert.strictEqual(out.results[0].outcome, 'failed');
});

test('click locator ném lỗi thì không làm hỏng luồng: ghi cảnh báo và để bằng chứng đọc lại quyết định', async () => {
  const b = fakeBrowser({
    g1: fakeDOM({ buttons: [fakeEl({ innerText: 'Join' }), fakeEl({ innerText: 'Pending' })] }),
  }, []);
  b.page.locator = () => ({ first: () => ({ click: async () => { throw new Error('timeout 10000ms'); } }) });
  const logs: { message: string; type: string }[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  assert.ok(logs.some(l => l.type === 'warning' && l.message.includes('timeout 10000ms')), 'phải ghi cảnh báo lỗi bấm');
  // Quyết định nằm ở phần đọc lại (bằng chứng dương), không ở việc click.
  assert.strictEqual(out.results[0].outcome, 'pending');
});

test('gọi onResult sau mỗi nhóm; lỗi trong onResult không làm dừng các nhóm còn lại', async () => {
  const b = fakeBrowser({ '1': joinAndJoined(), '2': joinAndJoined() }, []);
  const seen: string[] = [];
  const logs: { message: string; type: string }[] = [];
  const out = await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      search: async () => ([
        { id: '1', name: 'N1', url: 'https://www.facebook.com/groups/1/' },
        { id: '2', name: 'N2', url: 'https://www.facebook.com/groups/2/' },
      ]),
      onResult: (r: { id: string; outcome: string }) => {
        seen.push(`${r.id}:${r.outcome}`);
        throw new Error('ghi lịch sử hỏng');
      },
      sendLog: (message: string, type: string) => logs.push({ message, type }),
    }),
  );
  assert.deepStrictEqual(seen, ['1:joined', '2:joined']);
  assert.strictEqual(out.results.length, 2);
  assert.ok(logs.some(l => l.type === 'warning' && l.message.includes('ghi lịch sử hỏng')));
});

test('launch của vòng tham gia được gọi đúng một lần và không đối số (scan đã bị thay bằng bản giả)', async () => {
  const b = fakeBrowser({ g1: joinAndJoined() }, []);
  const launchArgs: unknown[][] = [];
  await searchAndJoinGroups(
    { keywords: ['x'], ...ZERO },
    makeDeps(b, {
      launch: async (...args: unknown[]) => { launchArgs.push(args); return b; },
      search: async () => ([{ id: 'g1', name: 'Test', url: 'https://www.facebook.com/groups/g1/' }]),
    }),
  );
  assert.deepStrictEqual(launchArgs, [[]]);
});
