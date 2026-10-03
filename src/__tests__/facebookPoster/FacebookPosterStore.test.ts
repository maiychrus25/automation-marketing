import Database from 'better-sqlite3';
import assert from 'node:assert';
import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';
import { keyOf, type CollectedComment } from '../../services/facebookPoster/collectComments';

function memoryDb(): SqlDatabase {
  const db = new Database(':memory:');
  return {
    exec: (sql) => { db.exec(sql); },
    run: (sql, p = []) => { db.prepare(sql).run(...p); },
    runInsert: (sql, p = []) => Number(db.prepare(sql).run(...p).lastInsertRowid),
    transaction: (fn) => db.transaction(fn)(),
    // Spread: .all() trả mảng của realm Node; jest chạy test trong realm khác nên deepStrictEqual sẽ báo lệch prototype.
    query: (sql, p = []) => [...db.prepare(sql).all(...p)] as any,
    // Giống DatabaseService.queryOne: không có dòng thì trả undefined.
    queryOne: (sql, p = []) => db.prepare(sql).get(...p) as any,
  };
}
function store() { const s = new FacebookPosterStore(memoryDb()); s.ensureSchema(); return s; }

function newRun(id: string, startedAt: number, kind: 'post' | 'join' = 'post') {
  return { id, kind, mode: (kind === 'post' ? 'group' : '') as 'group' | '', params: { text: 'xin chào', n: 2 }, startedAt };
}
function newResult(runId: string, over: Record<string, unknown> = {}) {
  return {
    runId, profileId: 'p1', profileName: 'Profile 1', targetUrl: 'https://www.facebook.com/groups/1/',
    targetName: 'G1', outcome: 'posted', error: '', postUrl: null as string | null,
    commentStatus: 'not_requested', identity: '', createdAt: 1, ...over,
  };
}
function comment(over: Partial<CollectedComment> = {}): CollectedComment {
  return { authorId: 'a1', authorName: 'An', authorUrl: 'https://www.facebook.com/an', text: 'hi', commentedAt: '2 giờ', postUrl: 'https://www.facebook.com/groups/1/posts/1/', ...over };
}

test('ensureSchema chạy hai lần không lỗi', () => {
  const s = store();
  s.ensureSchema();
});

test('createRun rồi getRun trả lại params JSON và trạng thái running', () => {
  const s = store();
  s.createRun(newRun('r1', 100));
  const got = s.getRun('r1')!;
  assert.deepStrictEqual(got.run, {
    id: 'r1', kind: 'post', mode: 'group', params: { text: 'xin chào', n: 2 },
    status: 'running', error: '', startedAt: 100, finishedAt: null,
  });
  assert.deepStrictEqual(got.results, []);
  assert.strictEqual(s.getRun('nope'), null);
});

test('finishRun ghi status, error, finishedAt', () => {
  const s = store();
  s.createRun(newRun('r1', 100));
  s.finishRun('r1', 'failed', 'hỏng', 250);
  const run = s.getRun('r1')!.run;
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.error, 'hỏng');
  assert.strictEqual(run.finishedAt, 250);
});

test('failInterruptedRuns chỉ đổi run đang running và trả số lượng', () => {
  const s = store();
  s.createRun(newRun('a', 1));
  s.createRun(newRun('b', 2));
  s.createRun(newRun('c', 3));
  s.finishRun('c', 'done', '', 5);
  assert.strictEqual(s.failInterruptedRuns(999), 2);
  for (const id of ['a', 'b']) {
    const run = s.getRun(id)!.run;
    assert.strictEqual(run.status, 'failed');
    assert.strictEqual(run.error, 'App đóng khi việc đang chạy');
    assert.strictEqual(run.finishedAt, 999);
  }
  const c = s.getRun('c')!.run;
  assert.strictEqual(c.status, 'done');
  assert.strictEqual(c.finishedAt, 5);
  assert.strictEqual(s.failInterruptedRuns(1000), 0);
});

test('addResult trả id và getRun trả kết quả theo id tăng dần', () => {
  const s = store();
  s.createRun(newRun('r1', 1));
  s.createRun(newRun('r2', 2));
  const id1 = s.addResult(newResult('r1', { targetName: 'first' }));
  const idOther = s.addResult(newResult('r2'));
  const id2 = s.addResult(newResult('r1', { targetName: 'second', postUrl: 'https://x/p/1', commentStatus: 'posted', createdAt: 0 }));
  assert.ok(id1 < idOther && idOther < id2);
  const results = s.getRun('r1')!.results;
  assert.deepStrictEqual(results.map((r) => [r.id, r.targetName]), [[id1, 'first'], [id2, 'second']]);
  assert.strictEqual(results[0].postUrl, null);
  assert.strictEqual(results[1].postUrl, 'https://x/p/1');
  assert.strictEqual(results[1].commentStatus, 'posted');
  assert.strictEqual(results[0].runId, 'r1');
  assert.strictEqual(results[0].profileName, 'Profile 1');
});

test('listRuns mới nhất trước, có total, lọc theo kind, phân trang', () => {
  const s = store();
  s.createRun(newRun('old', 10));
  s.createRun(newRun('join1', 20, 'join'));
  s.createRun(newRun('new', 30));
  const all = s.listRuns({ limit: 10, offset: 0 });
  assert.strictEqual(all.total, 3);
  assert.deepStrictEqual(all.runs.map((r) => r.id), ['new', 'join1', 'old']);
  const page = s.listRuns({ limit: 1, offset: 1 });
  assert.strictEqual(page.total, 3);
  assert.deepStrictEqual(page.runs.map((r) => r.id), ['join1']);
  const joins = s.listRuns({ limit: 10, offset: 0, kind: 'join' });
  assert.strictEqual(joins.total, 1);
  assert.deepStrictEqual(joins.runs.map((r) => r.id), ['join1']);
  assert.deepStrictEqual(joins.runs[0].params, { text: 'xin chào', n: 2 });
});

test('replaceGroups chỉ thay dòng của profile đó', () => {
  const s = store();
  s.replaceGroups('p1', [{ url: 'u1', name: 'One' }, { url: 'u2', name: 'Two' }], 10);
  s.replaceGroups('p2', [{ url: 'u9', name: 'Nine' }], 10);
  s.replaceGroups('p1', [{ url: 'u3', name: 'Three' }], 20);
  const g = s.listGroups(['p1', 'p2']);
  assert.deepStrictEqual(g.p1, [{ profileId: 'p1', url: 'u3', name: 'Three', scannedAt: 20 }]);
  assert.deepStrictEqual(g.p2.map((x) => x.url), ['u9']);
});

test('replaceGroups là nguyên tử: URL trùng làm hỏng giữa chừng thì dòng cũ còn nguyên', () => {
  const s = store();
  s.replaceGroups('p1', [{ url: 'old', name: 'Old' }], 10);
  assert.throws(() => s.replaceGroups('p1', [{ url: 'dup', name: 'A' }, { url: 'dup', name: 'B' }], 20));
  assert.deepStrictEqual(s.listGroups(['p1']).p1.map((x) => x.url), ['old']);
});

test('listGroups trả [] cho id không có và mọi id yêu cầu đều là key', () => {
  const s = store();
  s.replaceGroups('p1', [{ url: 'u1', name: 'One' }], 10);
  const g = s.listGroups(['p1', 'ghost']);
  assert.deepStrictEqual(Object.keys(g).sort(), ['ghost', 'p1']);
  assert.deepStrictEqual(g.ghost, []);
  assert.deepStrictEqual(s.listGroups([]), {});
});

test('deleteGroupsOfProfile chỉ xóa profile đó', () => {
  const s = store();
  s.replaceGroups('p1', [{ url: 'u1', name: '' }], 1);
  s.replaceGroups('p2', [{ url: 'u2', name: '' }], 1);
  s.deleteGroupsOfProfile('p1');
  const g = s.listGroups(['p1', 'p2']);
  assert.deepStrictEqual(g.p1, []);
  assert.strictEqual(g.p2.length, 1);
});

test('saveComments bỏ qua trùng theo keyOf và trả số dòng mới', () => {
  const s = store();
  const a = comment();
  const b = comment({ text: 'khác' });
  assert.strictEqual(s.saveComments('p1', [a, b], 100), 2);
  // a trùng (chỉ khác commentedAt, vốn không nằm trong khoá), c mới
  const c = comment({ authorId: 'a2' });
  assert.strictEqual(s.saveComments('p2', [{ ...a, commentedAt: '3 giờ' }, c, c], 200), 1);
  const { comments, total } = s.listComments({ limit: 10, offset: 0 });
  assert.strictEqual(total, 3);
  const kept = comments.find((x) => x.key === keyOf(a))!;
  assert.strictEqual(kept.profileId, 'p1');
  assert.strictEqual(kept.commentedAt, '2 giờ');
  assert.strictEqual(kept.collectedAt, 100);
});

test('loadCommentKeys chứa các khoá đã lưu', () => {
  const s = store();
  const a = comment();
  const b = comment({ postUrl: 'https://x/other' });
  s.saveComments('p1', [a, b], 1);
  assert.deepStrictEqual(s.loadCommentKeys(), new Set([keyOf(a), keyOf(b)]));
});

test('listComments lọc theo postUrl và phân trang', () => {
  const s = store();
  const p1 = 'https://x/p1';
  const p2 = 'https://x/p2';
  s.saveComments('p1', [comment({ postUrl: p1, text: '1' }), comment({ postUrl: p1, text: '2' }), comment({ postUrl: p1, text: '3' }), comment({ postUrl: p2, text: '4' })], 1);
  const onlyP1 = s.listComments({ postUrl: p1, limit: 10, offset: 0 });
  assert.strictEqual(onlyP1.total, 3);
  assert.ok(onlyP1.comments.every((c) => c.postUrl === p1));
  const page = s.listComments({ postUrl: p1, limit: 2, offset: 2 });
  assert.strictEqual(page.total, 3);
  assert.strictEqual(page.comments.length, 1);
  const first = page.comments[0];
  assert.deepStrictEqual(Object.keys(first).sort(), ['authorId', 'authorName', 'authorUrl', 'collectedAt', 'commentedAt', 'key', 'postUrl', 'profileId', 'text']);
});

test('listPostedUrls: chỉ dòng có post_url, mỗi URL một lần, mới nhất trước', () => {
  const s = store();
  s.createRun(newRun('r1', 1));
  s.addResult(newResult('r1', { postUrl: null, createdAt: 50 }));
  s.addResult(newResult('r1', { postUrl: 'https://x/a', createdAt: 10, profileId: 'p1' }));
  s.addResult(newResult('r1', { postUrl: 'https://x/b', createdAt: 30, profileId: 'p2', profileName: 'P2' }));
  s.addResult(newResult('r1', { postUrl: 'https://x/a', createdAt: 20, profileId: 'p3', profileName: 'P3' }));
  const list = s.listPostedUrls(10);
  assert.deepStrictEqual(list.map((x) => [x.postUrl, x.createdAt]), [['https://x/b', 30], ['https://x/a', 20]]);
  assert.deepStrictEqual(list[1], { postUrl: 'https://x/a', profileId: 'p3', profileName: 'P3', targetUrl: 'https://www.facebook.com/groups/1/', createdAt: 20 });
  assert.strictEqual(s.listPostedUrls(1).length, 1);
});

test('listPostedUrls: bỏ kết quả mồ côi (run đã bị xóa)', () => {
  const s = store();
  s.createRun(newRun('r1', 1));
  s.addResult(newResult('r1', { postUrl: 'https://x/kept', createdAt: 10 }));
  s.addResult(newResult('ghost', { postUrl: 'https://x/orphan', createdAt: 20 }));
  assert.deepStrictEqual(s.listPostedUrls(10).map((x) => x.postUrl), ['https://x/kept']);
});
