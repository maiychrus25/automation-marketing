import assert from 'node:assert';
import type { TaskDeps } from '../../services/facebookPoster/types';
import { parseGroupLinks, scanGroups } from '../../services/facebookPoster/scanGroups';

test('cắt tham số notif_id và dựng URL chuẩn', () => {
  const out = parseGroupLinks([{
    href: 'https://www.facebook.com/groups/1794004381977227/?notif_id=1785727072000000&notif_t=group_milestone&ref=notif',
    text: 'Haha',
  }]);
  assert.deepStrictEqual(out, [{
    id: '1794004381977227',
    name: 'Haha',
    url: 'https://www.facebook.com/groups/1794004381977227/',
  }]);
});

test('cắt tham số __cft__ và nhận href tương đối', () => {
  const out = parseGroupLinks([{
    href: '/groups/1794004381977227/?__cft__[0]=AZaJy3xBAatHnZB2Su0irXHZmt9gMYr6',
    text: 'Haha',
  }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].url, 'https://www.facebook.com/groups/1794004381977227/');
});

test('loại các link điều hướng của Facebook', () => {
  const out = parseGroupLinks([
    { href: '/groups/feed/', text: 'Your feed' },
    { href: '/groups/discover/', text: 'Discover' },
    { href: '/groups/joins/?nav_source=tab&ordering=viewer_added', text: 'Your groups' },
    { href: '/groups/create/', text: 'Create new group' },
  ]);
  assert.deepStrictEqual(out, []);
});

test('gộp trùng theo id dù khác tham số', () => {
  const out = parseGroupLinks([
    { href: '/groups/111/?ref=notif', text: 'Nhóm A' },
    { href: 'https://www.facebook.com/groups/111/', text: 'Nhóm A' },
  ]);
  assert.strictEqual(out.length, 1);
});

test('lấy dòng đầu của text làm tên', () => {
  const out = parseGroupLinks([
    { href: '/groups/222/', text: 'Haha\nLast active 4 hours ago' },
  ]);
  assert.strictEqual(out[0].name, 'Haha');
});

test('trùng id thì bỏ qua bản không có chữ, lấy bản có tên', () => {
  const out = parseGroupLinks([
    { href: '/groups/333/', text: '' },
    { href: '/groups/333/', text: 'Cộng đồng XYZ' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Cộng đồng XYZ');
});

// Đo trên trang thật: trong [role="main"] một nhóm có ba link theo thứ tự
// link ảnh (không chữ) -> link tên -> nút "View group". Tiêu chí "tên dài nhất"
// chọn trúng "View group"; phải lấy tên ĐẦU TIÊN không rỗng.
test('không lấy nhãn nút hành động làm tên nhóm', () => {
  const out = parseGroupLinks([
    { href: '/groups/444/', text: '' },
    { href: '/groups/444/', text: 'Haha' },
    { href: '/groups/444/', text: 'View group' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Haha');
});

test('id dạng chữ (vanity url) vẫn nhận', () => {
  const out = parseGroupLinks([{ href: '/groups/ten-nhom-cua-toi/', text: 'Tên nhóm' }]);
  assert.strictEqual(out[0].id, 'ten-nhom-cua-toi');
});

test('mảng rỗng trả mảng rỗng, không ném lỗi', () => {
  assert.deepStrictEqual(parseGroupLinks([]), []);
  assert.deepStrictEqual(parseGroupLinks(undefined), []);
});

test('bỏ qua phần tử thiếu href', () => {
  const out = parseGroupLinks([{ text: 'không có href' }, { href: '/groups/444/', text: 'OK' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '444');
});

type AnyFn = { name: string };
type FakePage = Record<string, unknown>;

function loggedInCtx(closed: boolean[]) {
  return {
    cookies: async () => [{ name: 'c_user', value: '1' }],
    close: async () => { closed.push(true); },
  };
}

/** TaskDeps đủ dùng cho test; `extra` ghi đè từng phần (settleMs, maxScrolls, ...). */
function makeDeps(ctx: unknown, page: FakePage, extra: Partial<Parameters<typeof scanGroups>[0]> = {}) {
  return {
    launch: async () => ({ ctx, page }) as unknown as Awaited<ReturnType<TaskDeps['launch']>>,
    getIsStopping: () => false,
    sendLog: () => {},
    updateProgress: () => {},
    ...extra,
  };
}

test('scanGroups trả danh sách đã lọc và đóng context', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = {
    goto: async () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'scrollToBottomInPage') return 1000;
      return [
        { href: '/groups/feed/', text: 'Your feed' },
        { href: '/groups/1794004381977227/?ref=notif', text: 'Haha\nLast active 4 hours ago' },
      ];
    },
  };

  const result = await scanGroups(makeDeps(ctx, page, { settleMs: 0, scrollWaitMs: 0 }));

  assert.deepStrictEqual(result.groups, [{
    id: '1794004381977227',
    name: 'Haha',
    url: 'https://www.facebook.com/groups/1794004381977227/',
  }]);
  assert.strictEqual(closed.length, 1);
});

test('scanGroups chưa đăng nhập thì ném lỗi, KHÔNG vào trang nhóm, vẫn đóng context', async () => {
  const closed: boolean[] = [];
  const visited: string[] = [];
  const ctx = { cookies: async () => [], close: async () => { closed.push(true); } };
  // Ghi lại URL đã vào: nếu không ghi thì đảo thứ tự (vào trang nhóm trước rồi
  // mới kiểm đăng nhập) vẫn pass, đúng thứ mà test này sinh ra để chặn.
  const page = {
    goto: async (url: string) => { visited.push(url); },
    evaluate: async (fn: AnyFn) => (fn.name === 'scrollToBottomInPage' ? 1000 : []),
  };

  await assert.rejects(
    scanGroups(makeDeps(ctx, page, { settleMs: 0, scrollWaitMs: 0 })),
    /Chưa đăng nhập/,
  );
  assert.strictEqual(closed.length, 1);
  assert.ok(
    !visited.some(u => u.includes('/groups/joins')),
    'chưa đăng nhập thì không được vào trang Your groups',
  );
});

/**
 * Page giả mô phỏng trang cuộn vô hạn: mỗi lần cuộn nạp thêm `perScroll` nhóm,
 * đến tối đa `total` nhóm thì thôi. `scrollCount` để test đếm. `stallOn` mô
 * phỏng một vòng cuộn Facebook trả chậm, không nạp thêm gì rồi chạy tiếp —
 * đây là lý do quy tắc dừng phải là NHIỀU vòng liên tiếp không tăng, không
 * phải một. `stallOn` nhận một số hoặc một mảng số vòng bị khựng.
 */
function infiniteScrollPage({ total, perScroll = 5, throwOnScroll = null, stallOn = null }: {
  total: number; perScroll?: number; throwOnScroll?: number | null; stallOn?: number | number[] | null;
}) {
  const stalled = stallOn === null ? [] : ([] as number[]).concat(stallOn);
  const p = {
    scrollCount: 0,
    visible: perScroll,
    goto: async () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'scrollToBottomInPage') {
        p.scrollCount += 1;
        if (throwOnScroll && p.scrollCount === throwOnScroll) throw new Error('cuộn hỏng');
        if (!stalled.includes(p.scrollCount)) p.visible = Math.min(total, p.visible + perScroll);
        return 1000;
      }
      // collectGroupLinksInPage
      const out = [];
      for (let i = 0; i < p.visible; i++) {
        out.push({ href: `/groups/${1000 + i}/`, text: `Nhóm ${i}` });
      }
      return out;
    },
  };
  return p;
}

const NO_WAIT = { settleMs: 0, scrollWaitMs: 0 };

test('cuộn đến khi hai vòng liên tiếp không tăng thì dừng, gom đủ nhóm', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 37, perScroll: 5 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 37, 'phải gom đủ 37 nhóm, không dừng ở màn hình đầu');
  assert.strictEqual(result.hitScrollLimit, false);
  assert.strictEqual(result.scrollError, false, 'đường bình thường không được báo có lỗi cuộn');
  assert.strictEqual(closed.length, 1);
});

// M2: chốt chặn cho quy tắc "hai vòng liên tiếp không tăng mới dừng". Một
// vòng khựng đơn lẻ (mạng chậm, Facebook chưa trả kịp lô sau) không được
// làm quét dừng sớm — nếu code lùi về "một vòng không tăng là dừng"
// (noGrowth >= 1), test này sẽ chỉ gom được 15/37 nhóm và ĐỎ.
test('một vòng cuộn khựng giữa chừng rồi chạy tiếp vẫn phải gom đủ nhóm', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 37, perScroll: 5, stallOn: 3 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 37, 'một vòng khựng không được coi là hết nhóm');
});

test('không cuộn thì chỉ lấy được màn hình đầu — chốt chặn cho chính lỗi này', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 37, perScroll: 5 });
  await scanGroups(makeDeps(ctx, page, NO_WAIT));
  assert.ok(page.scrollCount > 0, 'phải có cuộn, nếu không thì lỗi 20 nhóm quay lại');
});

test('chạm trần maxScrolls thì báo hitScrollLimit true', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // 1000 nhóm, mỗi lần cuộn thêm 5 -> không bao giờ hết trước trần 3 vòng.
  const page = infiniteScrollPage({ total: 1000, perScroll: 5 });

  const result = await scanGroups(makeDeps(ctx, page, { ...NO_WAIT, maxScrolls: 3 }));

  assert.strictEqual(result.hitScrollLimit, true);
  assert.strictEqual(result.scrollRounds, 3);
  assert.ok(result.groups.length > 0, 'chạm trần vẫn phải trả về phần đã gom');
});

test('hết nhóm trước khi chạm trần thì hitScrollLimit false', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 8, perScroll: 5 });
  const result = await scanGroups(makeDeps(ctx, page, { ...NO_WAIT, maxScrolls: 15 }));
  assert.strictEqual(result.hitScrollLimit, false);
  assert.strictEqual(result.groups.length, 8);
});

test('đếm theo nhóm DUY NHẤT, không theo số link', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // Cùng một nhóm xuất hiện 3 link (ảnh, tên, nút) — đúng như trang thật.
  const page = {
    goto: async () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'scrollToBottomInPage') return 1000;
      return [
        { href: '/groups/111/', text: '' },
        { href: '/groups/111/', text: 'Nhóm A' },
        { href: '/groups/111/?ref=x', text: 'View group' },
      ];
    },
  };
  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));
  assert.strictEqual(result.groups.length, 1);
  assert.strictEqual(result.groups[0].name, 'Nhóm A');
});

test('cuộn ném lỗi thì vẫn trả phần đã gom, không ném ra ngoài', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 100, perScroll: 5, throwOnScroll: 2 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.ok(result.groups.length >= 5, 'giữ lại phần đã gom được');
  assert.strictEqual(result.hitScrollLimit, false);
  assert.strictEqual(result.scrollError, true, 'phải báo có lỗi cuộn, không được lẫn với danh sách đầy đủ');
  assert.strictEqual(closed.length, 1, 'vẫn phải đóng context');
});

// --- Quét cho HẾT danh sách ---
// Hai lỗi thật người dùng gặp: trần cuộn đặt quá thấp nên cắt cụt danh sách,
// và mạng ì làm vòng lặp kết luận "hết nhóm" quá sớm rồi báo thành công.

test('tài khoản nhiều nhóm: quét đủ, không chạm trần', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // 420 nhóm, 5 nhóm mỗi vòng -> cần ~84 vòng. Trần cũ 15 vòng cắt còn 80.
  const page = infiniteScrollPage({ total: 420, perScroll: 5 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 420, 'phải gom đủ, không được cắt cụt');
  assert.strictEqual(result.hitScrollLimit, false);
});

test('mạng ì BA vòng liên tiếp: vẫn chạy tiếp, không kết luận sớm', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // Vòng 3, 4, 5 Facebook trả chậm, không thêm nhóm nào. Kiên nhẫn thấp hơn 4
  // sẽ dừng ngay ở đây và báo "xong" với danh sách cụt — không cờ nào bật,
  // người dùng tin là đã đủ. Đây là nửa thứ hai của lỗi người dùng gặp.
  const page = infiniteScrollPage({ total: 40, perScroll: 5, stallOn: [3, 4, 5] });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 40, 'khựng ba nhịp không có nghĩa là hết nhóm');
  assert.strictEqual(result.hitScrollLimit, false);
});

test('kiên nhẫn có giới hạn: hết nhóm thật thì vẫn dừng, không chạy tới trần', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 12, perScroll: 5 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 12);
  assert.strictEqual(result.hitScrollLimit, false);
  assert.ok(result.scrollRounds < 10, `dừng sớm khi hết nhóm, không chạy hết trần (đã cuộn ${result.scrollRounds} vòng)`);
});

test('trần vẫn là lưới an toàn: trang nạp mãi thì dừng và BÁO chạm trần', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  const page = infiniteScrollPage({ total: 999999, perScroll: 5 });

  const result = await scanGroups(makeDeps(ctx, page, { ...NO_WAIT, maxScrolls: 6 }));

  assert.strictEqual(result.hitScrollLimit, true, 'chạm trần phải báo, không im lặng cắt');
  assert.strictEqual(result.scrollRounds, 6);
});

/**
 * Trang ảo hoá: Facebook GỠ node cũ khỏi DOM khi cuộn xuống, mỗi lúc chỉ giữ
 * một cửa sổ `windowSize` mục quanh vị trí đang xem. Đây là hình dạng thật của
 * nhiều trang cuộn vô hạn, và nó phá vỡ giả định "đọc lại DOM là thấy hết".
 */
function virtualizedPage({ total, perScroll = 5, windowSize = 20 }: { total: number; perScroll?: number; windowSize?: number }) {
  const p = {
    scrollCount: 0,
    loaded: perScroll,
    goto: async () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'scrollToBottomInPage') {
        p.scrollCount += 1;
        p.loaded = Math.min(total, p.loaded + perScroll);
        return 1000;
      }
      // Chỉ trả về cửa sổ CUỐI, phần đầu đã bị gỡ khỏi DOM.
      const start = Math.max(0, p.loaded - windowSize);
      const out = [];
      for (let i = start; i < p.loaded; i++) {
        out.push({ href: `/groups/${1000 + i}/`, text: `Nhóm ${i}` });
      }
      return out;
    },
  };
  return p;
}

test('trang ảo hoá gỡ node cũ: vẫn phải gom đủ, không mất nhóm đã thấy', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // 100 nhóm nhưng DOM chỉ giữ 20 mục một lúc. Ghi đè thay vì cộng dồn sẽ
  // trả về đúng 20 — và không cờ nào bật, người dùng tin là đủ.
  const page = virtualizedPage({ total: 100, perScroll: 5, windowSize: 20 });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 100, 'phải giữ lại nhóm đã gom ở các vòng trước');
  assert.strictEqual(result.hitScrollLimit, false);
  assert.strictEqual(result.scrollError, false);
});

test('số nhóm dao động không được làm vòng lặp chạy tới trần rồi báo nhầm', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // Tài khoản chỉ 30 nhóm, nhưng DOM chớp nháy nên số đọc được lên xuống.
  // Ghi đè thì bộ đếm "không tăng" reset mãi, chạy hết trần rồi báo
  // "danh sách quá dài, quét lại" — đúng câu người dùng phàn nàn.
  const page = virtualizedPage({ total: 30, perScroll: 5, windowSize: 12 });

  const result = await scanGroups(makeDeps(ctx, page, { ...NO_WAIT, maxScrolls: 60 }));

  assert.strictEqual(result.groups.length, 30);
  assert.strictEqual(result.hitScrollLimit, false, 'tài khoản 30 nhóm không được báo chạm trần');
  assert.ok(result.scrollRounds < 20, `phải dừng sớm, không chạy tới trần (đã cuộn ${result.scrollRounds} vòng)`);
});

test('mạng ì RẢI RÁC nhiều nhịp không liên tiếp vẫn phải gom đủ', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  // Khựng ở vòng 2, 5, 8, 11 — rời rạc, không liên tiếp. Nếu bộ đếm không
  // được reset khi có tiến triển trở lại, bốn nhịp rải rác này cộng dồn
  // thành "hết nhóm" và cắt cụt danh sách.
  const page = infiniteScrollPage({ total: 60, perScroll: 5, stallOn: [2, 5, 8, 11] });

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.groups.length, 60, 'khựng rải rác không phải là hết nhóm');
  assert.strictEqual(result.hitScrollLimit, false);
});

test('đọc DOM ném lỗi giữa chừng cũng phải báo scrollError, không mất phần đã gom', async () => {
  const closed: boolean[] = [];
  const ctx = loggedInCtx(closed);
  let readCount = 0;
  const page = {
    goto: async () => {},
    evaluate: async (fn: AnyFn) => {
      if (fn.name === 'scrollToBottomInPage') return 1000;
      readCount += 1;
      if (readCount > 2) throw new Error('trang đã điều hướng đi chỗ khác');
      return [{ href: '/groups/111/', text: 'Nhóm A' }, { href: '/groups/222/', text: 'Nhóm B' }];
    },
  };

  const result = await scanGroups(makeDeps(ctx, page, NO_WAIT));

  assert.strictEqual(result.scrollError, true, 'đọc hỏng cũng là danh sách cụt, phải báo');
  assert.strictEqual(result.groups.length, 2, 'giữ phần đã gom');
  assert.strictEqual(closed.length, 1);
});
