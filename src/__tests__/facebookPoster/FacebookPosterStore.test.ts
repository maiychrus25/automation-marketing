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
    targetName: 'G1', outcome: 'posted', error: '', errorCode: '', attempts: 1, postUrl: null as string | null,
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
    assert.strictEqual(run.error, 'App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook.');
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

describe('login state', () => {
  test('setLoginState returns previous', () => {
    const s = store();
    expect(s.setLoginState('p1', 'ok', 'check', 10)).toBeNull();
    expect(s.setLoginState('p1', 'logged_out', 'run', 20)).toBe('ok');
  });

  test('setLoginError keeps state', () => {
    const s = store();
    s.setLoginState('p1', 'ok', 'check', 10);
    s.setLoginError('p1', 'timeout', 30);
    expect(s.listLoginStates()).toEqual([
      { profileId: 'p1', state: 'ok', checkedAt: 10, source: 'check', lastError: 'timeout', lastErrorAt: 30 },
    ]);
    s.setLoginState('p1', 'ok', 'check', 40);
    expect(s.listLoginStates()[0]).toMatchObject({ lastError: null, lastErrorAt: null, checkedAt: 40 });
  });

  test('setLoginError without a row does not insert', () => {
    const s = store();
    s.setLoginError('p9', 'boom', 5);
    expect(s.listLoginStates()).toEqual([]);
  });

  test('list maps rows', () => {
    const s = store();
    s.setLoginState('a', 'checkpoint', 'run', 7);
    expect(s.listLoginStates()).toEqual([
      { profileId: 'a', state: 'checkpoint', checkedAt: 7, source: 'run', lastError: null, lastErrorAt: null },
    ]);
  });
});

describe('error code columns', () => {
  test('migration adds error_code/attempts with defaults to an old DB', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE fb_poster_results (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      profile_name TEXT NOT NULL, target_url TEXT NOT NULL, target_name TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '', post_url TEXT DEFAULT NULL, comment_status TEXT NOT NULL DEFAULT 'not_requested',
      identity TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES ('r1', 'p', 'P', 'u', 'failed', 1)`);
    const s = new FacebookPosterStore(db);
    s.ensureSchema();
    s.createRun(newRun('r1', 1));
    const [row] = s.getRun('r1')!.results;
    expect(row.errorCode).toBe('');
    expect(row.attempts).toBe(1);
  });

  test('getRun returns errorCode/attempts', () => {
    const s = store();
    s.createRun(newRun('r1', 1));
    s.addResult(newResult('r1', { outcome: 'failed', errorCode: 'submit_not_found', attempts: 3 }));
    const [row] = s.getRun('r1')!.results;
    expect(row).toMatchObject({ errorCode: 'submit_not_found', attempts: 3 });
  });
});

// ─── Theo dõi bài đã đăng ────────────────────────────────────────────────────

describe('post tracking store', () => {
  const DAY = 24 * 3600_000;
  function trackRow(resultId: number, over: Record<string, unknown> = {}) {
    return {
      resultId, runId: 'r1', scheduleId: null as string | null, profileId: 'p1', groupUrl: 'https://www.facebook.com/groups/1/', groupId: '',
      postId: '', postUrl: null as string | null, postedAt: 1000, textHead: 'xin chào', linkStatus: 'missing' as const,
      removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null as number | null,
      statsDone: [] as string[], ...over,
    } as any;
  }

  test('createTracking là INSERT OR IGNORE và listTracking đọc lại đủ trường', () => {
    const s = store();
    s.createTracking(trackRow(1, { nextCheckAt: 50, statsDone: ['60m'] }));
    s.createTracking(trackRow(1, { postId: 'dup' }));
    const [got] = s.listTracking({});
    expect(got).toMatchObject({ resultId: 1, postId: '', linkStatus: 'missing', removedSuspected: false, nextCheckAt: 50, statsDone: ['60m'], lastSeenAt: null });
    expect(s.listTracking({})).toHaveLength(1);
  });

  test('listTracking lọc theo linkStatus, cặp và sinceMs', () => {
    const s = store();
    s.createTracking(trackRow(1, { postedAt: 100 }));
    s.createTracking(trackRow(2, { postedAt: 900, linkStatus: 'known', postId: 'x' }));
    s.createTracking(trackRow(3, { postedAt: 900, profileId: 'p2' }));
    expect(s.listTracking({ linkStatus: 'known' }).map((r) => r.resultId)).toEqual([2]);
    expect(s.listTrackingForPair('p1', 'https://www.facebook.com/groups/1/', 500).map((r) => r.resultId)).toEqual([2]);
    expect(s.listTrackingForPair('p1', 'https://www.facebook.com/groups/1/', 0).map((r) => r.resultId).sort()).toEqual([1, 2]);
  });

  test('updateTracking vá từng trường', () => {
    const s = store();
    s.createTracking(trackRow(1));
    s.updateTracking(1, { postId: 'pid', postUrl: 'https://x/', linkStatus: 'known', removedSuspected: true, nextCheckAt: null, statsDone: ['60m', '1440m'], checkCount: 3, lastSeenAt: 7, lastCheckedAt: 8 });
    expect(s.listTracking({})[0]).toMatchObject({ postId: 'pid', postUrl: 'https://x/', linkStatus: 'known', removedSuspected: true, nextCheckAt: null, statsDone: ['60m', '1440m'], checkCount: 3, lastSeenAt: 7, lastCheckedAt: 8 });
    s.updateTracking(1, {});
  });

  test('listDuePairs: chỉ dòng đến hạn, ưu tiên chờ duyệt rồi missing, mỗi cặp một lần, có limit', () => {
    const s = store();
    s.createTracking(trackRow(1, { profileId: 'pa', nextCheckAt: 10, linkStatus: 'known', postId: 'x' }));
    s.createTracking(trackRow(2, { profileId: 'pb', nextCheckAt: 20, linkStatus: 'missing' }));
    s.createTracking(trackRow(3, { profileId: 'pc', nextCheckAt: 30, linkStatus: 'pending_approval' }));
    s.createTracking(trackRow(4, { profileId: 'pc', nextCheckAt: 5, linkStatus: 'known', postId: 'y' }));
    s.createTracking(trackRow(5, { profileId: 'pd', nextCheckAt: 999 }));
    s.createTracking(trackRow(6, { profileId: 'pe', nextCheckAt: null }));
    expect(s.listDuePairs(100, 10).map((p) => p.profileId)).toEqual(['pc', 'pb', 'pa']);
    expect(s.listDuePairs(100, 2).map((p) => p.profileId)).toEqual(['pc', 'pb']);
    expect(s.listDuePairs(1, 10)).toEqual([]);
  });

  test('addPostStats và latestStats trả lần đo mới nhất mỗi bài', () => {
    const s = store();
    s.addPostStats(1, { capturedAt: 10, reactions: 1, comments: 0, shares: 0 });
    s.addPostStats(1, { capturedAt: 30, reactions: 5, comments: 2, shares: null });
    s.addPostStats(2, { capturedAt: 20, reactions: 9, comments: 9, shares: 9 });
    const got = s.latestStats([1, 2, 3]);
    expect(got.map((g) => [g.resultId, g.reactions, g.shares])).toEqual([[1, 5, null], [2, 9, 9]]);
    expect(s.latestStats([])).toEqual([]);
  });

  describe('statsReport', () => {
    function seed() {
      const s = store();
      const db = (s as any).db;
      db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('s1', 'Lịch sáng', 'once', '{}', 1, 1)`);
      db.run(`INSERT INTO fb_poster_results (id, run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES (1, 'r1', 'p1', 'Profile Một', 'u', 'posted', 1)`);
      db.run(`INSERT INTO fb_poster_results (id, run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES (2, 'r1', 'p1', 'Profile Một', 'u', 'posted', 1)`);
      db.run(`INSERT INTO fb_poster_results (id, run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES (3, 'r2', 'p2', 'Profile Hai', 'u', 'posted', 1)`);
      const g1 = 'https://www.facebook.com/groups/1/';
      s.createTracking(trackRow(1, { scheduleId: 's1', groupUrl: g1, groupId: '111', postedAt: 5 * DAY, linkStatus: 'known', postId: 'a', postUrl: 'https://f/a', textHead: 'bài một' }));
      s.createTracking(trackRow(2, { scheduleId: 's1', groupUrl: g1, groupId: '111', postedAt: 5 * DAY + 1000, linkStatus: 'pending_approval' }));
      s.createTracking(trackRow(3, { profileId: 'p2', groupUrl: 'https://www.facebook.com/groups/2/', postedAt: 6 * DAY, linkStatus: 'known', postId: 'c', removedSuspected: true }));
      s.addPostStats(1, { capturedAt: 1, reactions: 1, comments: 1, shares: 1 });
      s.addPostStats(1, { capturedAt: 2, reactions: 10, comments: 4, shares: 2 });
      s.addPostStats(3, { capturedAt: 3, reactions: 2, comments: null, shares: null });
      return s;
    }
    const range = { from: 0, to: 10 * DAY, limit: 100 };

    test('groupBy group: tổng, trung bình trên bài đã đo, engagementRate null khi không có research', () => {
      const rows = seed().statsReport({ ...range, groupBy: 'group' });
      const g1 = rows.find((r) => r.key === 'https://www.facebook.com/groups/1/')!;
      expect(g1).toMatchObject({ posts: 2, withLink: 1, pending: 1, notFound: 0, removedSuspected: 0, reactions: 10, comments: 4, shares: 2, measured: 1, avgEngagement: 16, engagementRate: null });
      const g2 = rows.find((r) => r.key === 'https://www.facebook.com/groups/2/')!;
      expect(g2).toMatchObject({ posts: 1, removedSuspected: 1, reactions: 2, avgEngagement: 2 });
    });

    test('engagementRate dùng member_count mới nhất của nhóm trong research_items', () => {
      const s = seed();
      const db = (s as any).db;
      db.exec(`CREATE TABLE research_items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, fb_id TEXT, url TEXT, member_count INTEGER, captured_at INTEGER)`);
      db.run(`INSERT INTO research_items (kind, fb_id, url, member_count, captured_at) VALUES ('group', '111', '', 100, 1)`);
      db.run(`INSERT INTO research_items (kind, fb_id, url, member_count, captured_at) VALUES ('group', '111', '', 200, 2)`);
      const g1 = s.statsReport({ ...range, groupBy: 'group' }).find((r) => r.key === 'https://www.facebook.com/groups/1/')!;
      expect(g1.engagementRate).toBeCloseTo(16 / 200);
    });

    test('groupBy profile dùng tên profile, schedule dùng tên lịch (null-safe)', () => {
      const s = seed();
      const byProfile = s.statsReport({ ...range, groupBy: 'profile' });
      expect(byProfile.map((r) => [r.key, r.label, r.posts]).sort()).toEqual([['p1', 'Profile Một', 2], ['p2', 'Profile Hai', 1]]);
      const bySchedule = s.statsReport({ ...range, groupBy: 'schedule' });
      expect(bySchedule.find((r) => r.key === 's1')).toMatchObject({ label: 'Lịch sáng', posts: 2 });
      expect(bySchedule.find((r) => r.key === '')).toMatchObject({ label: '', posts: 1 });
    });

    test('groupBy day gom theo ngày đăng', () => {
      const rows = seed().statsReport({ ...range, groupBy: 'day' });
      expect(rows.map((r) => r.posts).sort()).toEqual([1, 2]);
      expect(rows[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('groupBy post: mỗi bài một dòng kèm chuỗi lần đo; lọc from/to và limit', () => {
      const s = seed();
      const rows = s.statsReport({ ...range, groupBy: 'post' });
      expect(rows).toHaveLength(3);
      const p1 = rows.find((r) => r.key === '1')!;
      expect(p1.post).toMatchObject({ resultId: 1, postUrl: 'https://f/a', text: 'bài một', linkStatus: 'known' });
      expect(p1.post!.snapshots.map((x) => x.capturedAt)).toEqual([1, 2]);
      expect(s.statsReport({ from: 5 * DAY + 500, to: 10 * DAY, groupBy: 'post', limit: 100 }).map((r) => r.key).sort()).toEqual(['2', '3']);
      expect(s.statsReport({ ...range, groupBy: 'post', limit: 1 })).toHaveLength(1);
    });
  });

  test('pruneTrackingOlderThan xoá dòng và lần đo cũ', () => {
    const s = store();
    s.createTracking(trackRow(1, { postedAt: 10 }));
    s.createTracking(trackRow(2, { postedAt: 500 }));
    s.addPostStats(1, { capturedAt: 11, reactions: 1, comments: 1, shares: 1 });
    s.addPostStats(2, { capturedAt: 501, reactions: 1, comments: 1, shares: 1 });
    expect(s.pruneTrackingOlderThan(100)).toBe(1);
    expect(s.listTracking({}).map((r) => r.resultId)).toEqual([2]);
    expect(s.latestStats([1, 2]).map((x) => x.resultId)).toEqual([2]);
  });
});
