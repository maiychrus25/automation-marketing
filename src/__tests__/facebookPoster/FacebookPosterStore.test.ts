import assert from 'node:assert';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { memoryDb } from './helpers';
import { keyOf, type CollectedComment } from '../../services/facebookPoster/collectComments';

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
    status: 'running', error: '', startedAt: 100, finishedAt: null, scheduleId: null, scheduleName: null,
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

function newSchedule(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: `Lịch ${id}`, kind: 'recurring' as 'once' | 'recurring', params: { kind: 'post', mode: 'group', mediaPaths: ['01-a.jpg'] },
    runAt: null as number | null, days: [1, 3, 5], time: '09:30', enabled: true, nextRunAt: 100 as number | null, createdAt: 1, ...over,
  };
}

describe('schedules', () => {
  test('ensureSchema hai lần vẫn ổn và run lưu/đọc được scheduleId', () => {
    const s = store();
    s.ensureSchema();
    s.createRun({ ...newRun('r1', 1), scheduleId: 'sch-1' });
    s.createRun(newRun('r2', 2));
    assert.strictEqual(s.getRun('r1')!.run.scheduleId, 'sch-1');
    assert.strictEqual(s.getRun('r2')!.run.scheduleId, null);
  });

  test('listRuns trả scheduleName qua LEFT JOIN: có lịch thì có tên, lịch đã xóa hoặc chạy tay thì null', () => {
    const s = store();
    s.createSchedule(newSchedule('a'));
    s.createSchedule(newSchedule('b'));
    s.createRun({ ...newRun('r1', 1), scheduleId: 'a' });
    s.createRun({ ...newRun('r2', 2), scheduleId: 'b' });
    s.createRun(newRun('r3', 3));
    s.deleteSchedule('b');
    const names = Object.fromEntries(s.listRuns({ limit: 10, offset: 0 }).runs.map(r => [r.id, r.scheduleName]));
    assert.deepStrictEqual(names, { r1: 'Lịch a', r2: null, r3: null });
    assert.deepStrictEqual(s.listRuns({ limit: 10, offset: 0, kind: 'post' }).runs.map(r => r.id), ['r3', 'r2', 'r1']);
    assert.strictEqual(s.getRun('r1')!.run.scheduleName, 'Lịch a');
  });

  test('create/get/update/delete schedule khứ hồi', () => {
    const s = store();
    s.createSchedule(newSchedule('a'));
    const got = s.getSchedule('a')!;
    assert.deepStrictEqual(got.days, [1, 3, 5]);
    assert.strictEqual(got.enabled, true);
    assert.deepStrictEqual(got.params, { kind: 'post', mode: 'group', mediaPaths: ['01-a.jpg'] });
    assert.strictEqual(got.lastRunId, null);
    assert.strictEqual(got.updatedAt, 1);
    s.updateSchedule('a', { name: 'Mới', enabled: false, days: [0], time: '10:00', nextRunAt: null, lastRunId: 'r1' }, 50);
    const upd = s.getSchedule('a')!;
    assert.deepStrictEqual([upd.name, upd.enabled, upd.days, upd.time, upd.nextRunAt, upd.lastRunId, upd.updatedAt], ['Mới', false, [0], '10:00', null, 'r1', 50]);
    s.createSchedule(newSchedule('o', { kind: 'once', days: [], time: '', runAt: 500 }));
    assert.deepStrictEqual(s.getSchedule('o')!.days, []);
    assert.strictEqual(s.countSchedules(), 2);
    s.deleteSchedule('a');
    assert.strictEqual(s.getSchedule('a'), null);
    assert.strictEqual(s.countSchedules(), 1);
  });

  test('listDueSchedules chỉ lấy lịch bật có next_run_at <= t, theo thứ tự', () => {
    const s = store();
    s.createSchedule(newSchedule('late', { nextRunAt: 20, createdAt: 1 }));
    s.createSchedule(newSchedule('early', { nextRunAt: 10, createdAt: 2 }));
    s.createSchedule(newSchedule('off', { nextRunAt: 5, enabled: false }));
    s.createSchedule(newSchedule('null', { nextRunAt: null }));
    s.createSchedule(newSchedule('future', { nextRunAt: 99 }));
    assert.deepStrictEqual(s.listDueSchedules(20).map((x) => x.id), ['early', 'late']);
  });

  test('nextScheduledAt bỏ qua lịch tắt và null', () => {
    const s = store();
    assert.strictEqual(s.nextScheduledAt(), null);
    s.createSchedule(newSchedule('off', { nextRunAt: 5, enabled: false }));
    s.createSchedule(newSchedule('null', { nextRunAt: null }));
    assert.strictEqual(s.nextScheduledAt(), null);
    s.createSchedule(newSchedule('a', { nextRunAt: 30 }));
    s.createSchedule(newSchedule('b', { nextRunAt: 12 }));
    assert.strictEqual(s.nextScheduledAt(), 12);
  });

  test('recordScheduleRun ghi run missed không có kết quả', () => {
    const s = store();
    s.recordScheduleRun({ id: 'm1', scheduleId: 'sch-1', params: { kind: 'post', mode: 'page' }, at: 777, status: 'missed', reason: 'App tắt lúc đến giờ' });
    const { run, results } = s.getRun('m1')!;
    assert.deepStrictEqual([run.kind, run.mode, run.status, run.error, run.scheduleId, run.startedAt, run.finishedAt], ['post', 'page', 'missed', 'App tắt lúc đến giờ', 'sch-1', 777, 777]);
    assert.deepStrictEqual(results, []);
  });

  test('listSchedules kèm lastRun và sắp xếp bật trước, sớm trước, null sau', () => {
    const s = store();
    s.recordScheduleRun({ id: 'm1', scheduleId: 'x', params: { mode: 'group' }, at: 9, status: 'missed', reason: 'lý do' });
    s.createSchedule(newSchedule('off', { nextRunAt: 1, enabled: false }));
    s.createSchedule(newSchedule('none', { nextRunAt: null }));
    s.createSchedule(newSchedule('b', { nextRunAt: 50 }));
    s.createSchedule(newSchedule('a', { nextRunAt: 40 }));
    s.updateSchedule('a', { lastRunId: 'm1' }, 2);
    const list = s.listSchedules();
    assert.deepStrictEqual(list.map((x) => x.id), ['a', 'b', 'none', 'off']);
    assert.deepStrictEqual(list[0].lastRun, { status: 'missed', startedAt: 9, error: 'lý do' });
    assert.strictEqual(list[1].lastRun, null);
  });
  test('draft: mặc định false, ghi/đọc được; updateSchedule đổi kind/draft/params', () => {
    const s = store();
    s.createSchedule(newSchedule('a'));
    assert.strictEqual(s.getSchedule('a')!.draft, false);
    s.createSchedule(newSchedule('d', { kind: 'once', days: [], time: '', runAt: null, enabled: false, nextRunAt: null, draft: true }));
    assert.strictEqual(s.getSchedule('d')!.draft, true);
    s.updateSchedule('d', { draft: false, kind: 'recurring', params: { kind: 'post', text: 'mới' } }, 5);
    const d = s.getSchedule('d')!;
    assert.deepStrictEqual([d.draft, d.kind, d.params], [false, 'recurring', { kind: 'post', text: 'mới' }]);
  });

  test('listDueSchedules/nextScheduledAt bỏ qua nháp kể cả khi dữ liệu lệch (enabled = 1)', () => {
    const s = store();
    s.createSchedule(newSchedule('d', { nextRunAt: 10, draft: true }));
    s.createSchedule(newSchedule('a', { nextRunAt: 20 }));
    assert.deepStrictEqual(s.listDueSchedules(100).map((x) => x.id), ['a']);
    assert.strictEqual(s.nextScheduledAt(), 20);
  });

  test('migration thêm cột draft cho bảng cũ chưa có cột', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE fb_poster_schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      params_json TEXT NOT NULL, run_at INTEGER DEFAULT NULL, days TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER DEFAULT NULL, last_run_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('old', 'x', 'once', '{}', 1, 1)`);
    const s = new FacebookPosterStore(db);
    s.ensureSchema();
    assert.strictEqual(s.getSchedule('old')!.draft, false);
  });
});
