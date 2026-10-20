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
    status: 'running', error: '', startedAt: 100, finishedAt: null, scheduleId: null, scheduleName: null, campaignId: null,
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

  test('latestStats chunks large id lists (more than 500 ids)', () => {
    const s = store();
    const ids = Array.from({ length: 1200 }, (_, i) => i + 1);
    for (const id of [1, 600, 1200]) s.addPostStats(id, { capturedAt: 10, reactions: id, comments: 0, shares: 0 });
    s.addPostStats(600, { capturedAt: 20, reactions: 7, comments: 0, shares: 0 });
    expect(s.latestStats(ids).map((g) => [g.resultId, g.reactions])).toEqual([[1, 1], [600, 7], [1200, 1200]]);
  });

  test('listTracking untilMs filters posted_at in SQL', () => {
    const s = store();
    s.createTracking(trackRow(1, { postedAt: 100 }));
    s.createTracking(trackRow(2, { postedAt: 200 }));
    s.createTracking(trackRow(3, { postedAt: 300 }));
    expect(s.listTracking({ sinceMs: 100, untilMs: 200 }).map((r) => r.resultId)).toEqual([2, 1]);
    expect(s.listTracking({ untilMs: 200, limit: 1 }).map((r) => r.resultId)).toEqual([2]);
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

    test('nhãn nhóm: ưu tiên tên do profile đăng quét được, rồi tên profile khác quét được, cuối cùng là link', () => {
      const s = seed();
      const db = (s as any).db;
      const label = (key: string) => s.statsReport({ ...range, groupBy: 'group' }).find((r) => r.key === key)!.label;
      expect(label('https://www.facebook.com/groups/2/')).toBe('https://www.facebook.com/groups/2/');
      db.run(`INSERT INTO fb_poster_groups (profile_id, url, name, scanned_at) VALUES ('p1', 'https://www.facebook.com/groups/2/', 'Tên profile khác quét', 1)`);
      expect(label('https://www.facebook.com/groups/2/')).toBe('Tên profile khác quét');
      db.run(`INSERT INTO fb_poster_groups (profile_id, url, name, scanned_at) VALUES ('p2', 'https://www.facebook.com/groups/2/', 'Tên đã quét', 1)`);
      expect(label('https://www.facebook.com/groups/2/')).toBe('Tên đã quét');
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

  describe('statsReport hour / weekday / groupUrl', () => {
    test('groupBy hour: 23:59 và 00:00 vào hai khung, sắp theo key tăng dần', () => {
      const s = store();
      s.createTracking(trackRow(1, { postedAt: new Date(2026, 0, 6, 23, 59).getTime() }));
      s.createTracking(trackRow(2, { postedAt: new Date(2026, 0, 7, 0, 0).getTime() }));
      s.createTracking(trackRow(3, { postedAt: new Date(2026, 0, 7, 9, 5).getTime() }));
      s.createTracking(trackRow(4, { postedAt: new Date(2026, 0, 8, 9, 30).getTime() }));
      const rows = s.statsReport({ from: 0, to: Date.now() * 2, groupBy: 'hour', limit: 100 });
      expect(rows.map((r) => [r.key, r.label, r.posts, r.insufficient])).toEqual([['00', '00h', 1, true], ['09', '09h', 2, true], ['23', '23h', 1, true]]);
    });

    test('groupBy weekday: Chủ nhật = 7, Thứ 2 = 1, sắp theo key', () => {
      const s = store();
      s.createTracking(trackRow(1, { postedAt: new Date(2026, 0, 4, 10).getTime() })); // Chủ nhật
      s.createTracking(trackRow(2, { postedAt: new Date(2026, 0, 5, 10).getTime() })); // Thứ 2
      s.createTracking(trackRow(3, { postedAt: new Date(2026, 0, 5, 11).getTime() }));
      const rows = s.statsReport({ from: 0, to: Date.now() * 2, groupBy: 'weekday', limit: 100 });
      expect(rows.map((r) => [r.key, r.label, r.posts])).toEqual([['1', 'Thứ 2', 2], ['7', 'Chủ nhật', 1]]);
    });

    test('lọc groupUrl', () => {
      const s = store();
      s.createTracking(trackRow(1, { groupUrl: 'g-a', postedAt: 10 }));
      s.createTracking(trackRow(2, { groupUrl: 'g-b', postedAt: 11 }));
      const rows = s.statsReport({ from: 0, to: 100, groupBy: 'day', limit: 100, groupUrl: 'g-a' });
      expect(rows.map((r) => r.posts)).toEqual([1]);
    });
  });

  describe('groupScoreInputs', () => {
    const G1 = 'https://www.facebook.com/groups/1/';
    const G2 = 'https://www.facebook.com/groups/2/';
    const G3 = 'https://www.facebook.com/groups/3/';
    const range = { from: 0, to: 10_000 };

    test('bỏ lỗi do profile, chỉ tính lượt đăng nhóm, ghép hai phía và nhóm chỉ có lỗi', () => {
      const s = store();
      s.createRun({ ...newRun('r1', 100) });
      s.createRun({ ...newRun('rj', 100, 'join') });
      s.createRun({ ...newRun('rold', 99_999) });
      for (const outcome of ['posted', 'posted']) s.addResult(newResult('r1', { outcome }));
      s.addResult(newResult('r1', { outcome: 'failed', errorCode: 'not_logged_in' }));
      s.addResult(newResult('r1', { outcome: 'failed', errorCode: 'launch_failed' }));
      s.addResult(newResult('r1', { outcome: 'failed', errorCode: 'stopped' }));
      s.addResult(newResult('r1', { outcome: 'failed', errorCode: 'post_failed' }));
      s.addResult(newResult('r1', { outcome: 'skipped' }));
      s.addResult(newResult('rj', { outcome: 'posted' }));
      s.addResult(newResult('rold', { outcome: 'posted', createdAt: 99_999 })); // ngoài khoảng theo thời điểm ghi kết quả
      s.addResult(newResult('r1', { targetUrl: G3, targetName: 'Nhóm 3', outcome: 'failed', errorCode: 'post_failed' }));
      s.createTracking(trackRow(1, { groupUrl: G1, postedAt: 150, linkStatus: 'known' }));
      s.createTracking(trackRow(2, { groupUrl: G1, postedAt: 160, linkStatus: 'not_found' }));
      s.createTracking(trackRow(3, { groupUrl: G2, postedAt: 170, linkStatus: 'pending_approval', removedSuspected: true }));
      s.addPostStats(1, { capturedAt: 1, reactions: 4, comments: 0, shares: 0 });

      const rows = s.groupScoreInputs(range);
      const by = (u: string) => rows.find((r) => r.groupUrl === u)!;
      expect(rows).toHaveLength(3);
      expect(by(G1)).toMatchObject({ attempted: 3, posted: 2, failed: 1, held: 1, removed: 0, withLink: 1, measured: 1, avgEngagement: 4 });
      expect(by(G2)).toMatchObject({ attempted: 1, posted: 1, failed: 0, held: 1, removed: 1, withLink: 0, measured: 0 });
      expect(by(G3)).toMatchObject({ label: 'Nhóm 3', attempted: 1, posted: 0, failed: 1, held: 0, measured: 0, avgEngagement: null });
    });

    test('lọc chiến dịch theo run; chuỗi rỗng = không thuộc chiến dịch', () => {
      const s = store();
      (s as any).db.run(`INSERT INTO fb_poster_campaigns (id, name, created_at, updated_at) VALUES ('c1', 'CD', 1, 1)`);
      s.createRun({ ...newRun('r1', 100), campaignId: 'c1' });
      s.createRun({ ...newRun('r2', 100) });
      s.addResult(newResult('r1'));
      s.addResult(newResult('r2', { targetUrl: G2 }));
      expect(s.groupScoreInputs({ ...range, campaignId: 'c1' }).map((r) => r.groupUrl)).toEqual([G1]);
      expect(s.groupScoreInputs({ ...range, campaignId: '' }).map((r) => r.groupUrl)).toEqual([G2]);
      expect(s.groupScoreInputs(range).map((r) => r.groupUrl).sort()).toEqual([G1, G2]);
    });
  });

  test('statsReport: limit giữ bài mới nhất (post/day) và nhóm nhiều bài nhất (group)', () => {
    const s = store();
    s.createTracking(trackRow(1, { postedAt: 1 * DAY, groupUrl: 'g-old' }));
    s.createTracking(trackRow(2, { postedAt: 2 * DAY, groupUrl: 'g-busy' }));
    s.createTracking(trackRow(3, { postedAt: 3 * DAY, groupUrl: 'g-busy' }));
    s.createTracking(trackRow(4, { postedAt: 4 * DAY, groupUrl: 'g-new' }));
    s.addPostStats(4, { capturedAt: 1, reactions: 1, comments: 0, shares: 0 });
    s.addPostStats(3, { capturedAt: 1, reactions: 2, comments: 0, shares: 0 });
    const r = { from: 0, to: 10 * DAY };
    const posts = s.statsReport({ ...r, groupBy: 'post', limit: 2 });
    expect(posts.map((x) => x.key)).toEqual(['4', '3']);
    expect(posts.map((x) => x.post!.snapshots.length)).toEqual([1, 1]);
    expect(s.statsReport({ ...r, groupBy: 'day', limit: 2 }).map((x) => x.posts)).toHaveLength(2);
    expect(s.statsReport({ ...r, groupBy: 'group', limit: 2 }).map((x) => x.key)).toEqual(['g-busy', 'g-new']);
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

// ─── Chiến dịch và biến thể ──────────────────────────────────────────────────

describe('campaigns', () => {
  function camp(id: string, over: Record<string, unknown> = {}) {
    return { id, name: `CD ${id}`, goal: '', status: 'active' as const, startAt: null, endAt: null, createdAt: 1, updatedAt: 1, ...over };
  }
  function sched(id: string, over: Record<string, unknown> = {}) {
    return {
      id, name: `L ${id}`, kind: 'once' as const, params: { kind: 'post' }, runAt: 10, days: [] as number[], time: '',
      enabled: true, nextRunAt: 10, createdAt: 1, ...over,
    } as any;
  }

  test('CRUD khứ hồi', () => {
    const s = store();
    s.createCampaign(camp('a', { goal: 'mục tiêu', startAt: 5, endAt: 9 }));
    expect(s.getCampaign('a')).toEqual(camp('a', { goal: 'mục tiêu', startAt: 5, endAt: 9 }));
    s.updateCampaign('a', { name: 'Mới', status: 'paused', endAt: null }, 77);
    expect(s.getCampaign('a')).toMatchObject({ name: 'Mới', status: 'paused', startAt: 5, endAt: null, updatedAt: 77, createdAt: 1 });
    s.deleteCampaign('a');
    expect(s.getCampaign('a')).toBeNull();
  });

  test('listCampaigns bỏ archived mặc định, includeArchived và lọc status', () => {
    const s = store();
    s.createCampaign(camp('a', { createdAt: 1 }));
    s.createCampaign(camp('b', { status: 'paused', createdAt: 2 }));
    s.createCampaign(camp('c', { status: 'archived', createdAt: 3 }));
    expect(s.listCampaigns().map((c) => c.id)).toEqual(['b', 'a']);
    expect(s.listCampaigns({ includeArchived: true }).map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(s.listCampaigns({ status: 'archived' }).map((c) => c.id)).toEqual(['c']);
    expect(s.listCampaigns({ status: 'paused' }).map((c) => c.id)).toEqual(['b']);
  });

  test('findCampaignByName trim và không phân biệt hoa thường', () => {
    const s = store();
    s.createCampaign(camp('a', { name: 'Khuyến Mãi Tết' }));
    expect(s.findCampaignByName('  khuyến mãi tết ')?.id).toBe('a');
    expect(s.findCampaignByName('khác')).toBeNull();
  });

  test('countCampaignSchedules tách lịch và bản nháp', () => {
    const s = store();
    s.createSchedule(sched('1', { campaignId: 'a' }));
    s.createSchedule(sched('2', { campaignId: 'a' }));
    s.createSchedule(sched('3', { campaignId: 'a', draft: true, enabled: false, nextRunAt: null }));
    s.createSchedule(sched('4', { campaignId: 'b' }));
    expect(s.countCampaignSchedules('a')).toEqual({ schedules: 2, drafts: 1 });
    expect(s.countCampaignSchedules('zz')).toEqual({ schedules: 0, drafts: 0 });
  });

  test('countStartedRuns chỉ tính running/done/cancelled', () => {
    const s = store();
    s.createSchedule(sched('1'));
    for (const [id, st] of [['r1', 'running'], ['r2', 'done'], ['r3', 'cancelled'], ['r4', 'failed'], ['r5', 'missed']] as const) {
      s.createRun({ ...newRun(id, 1), scheduleId: '1' });
      if (st !== 'running') s.finishRun(id, st, '', 2);
    }
    s.createRun({ ...newRun('other', 1), scheduleId: '2' });
    expect(s.countStartedRuns('1')).toBe(3);
  });

  test('campaign_id/variant đọc ghi đúng ở schedules, runs, results, tracking', () => {
    const s = store();
    s.createSchedule(sched('1', { campaignId: 'a' }));
    s.createSchedule(sched('2'));
    expect(s.getSchedule('1')!.campaignId).toBe('a');
    expect(s.getSchedule('2')!.campaignId).toBeNull();
    s.updateSchedule('2', { campaignId: 'b' }, 5);
    expect(s.getSchedule('2')!.campaignId).toBe('b');
    s.updateSchedule('2', { campaignId: null }, 6);
    expect(s.getSchedule('2')!.campaignId).toBeNull();

    s.createRun({ ...newRun('r1', 1), campaignId: 'a' });
    s.createRun(newRun('r2', 2));
    expect(s.getRun('r1')!.run.campaignId).toBe('a');
    expect(s.getRun('r2')!.run.campaignId).toBeNull();

    const rid = s.addResult(newResult('r1', { variant: 'B' }));
    s.addResult(newResult('r2'));
    expect(s.getRun('r1')!.results[0].variant).toBe('B');
    expect(s.getRun('r2')!.results[0].variant).toBe('');

    s.createTracking({ resultId: rid, runId: 'r1', scheduleId: null, campaignId: 'a', variant: 'B', profileId: 'p1', groupUrl: 'u', groupId: '', postId: '', postUrl: null, postedAt: 1, textHead: 'x', linkStatus: 'missing', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [] });
    s.createTracking({ resultId: 99, runId: 'r2', scheduleId: null, profileId: 'p1', groupUrl: 'u', groupId: '', postId: '', postUrl: null, postedAt: 1, textHead: 'x', linkStatus: 'missing', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [] });
    const rows = s.listTracking({});
    expect(rows.find((r) => r.resultId === rid)).toMatchObject({ campaignId: 'a', variant: 'B' });
    expect(rows.find((r) => r.resultId === 99)).toMatchObject({ campaignId: null, variant: '' });
  });

  test('listSchedules lọc theo campaignId và campaignId rỗng', () => {
    const s = store();
    s.createSchedule(sched('1', { campaignId: 'a' }));
    s.createSchedule(sched('2', { campaignId: 'b' }));
    s.createSchedule(sched('3'));
    expect(s.listSchedules().map((x) => x.id).sort()).toEqual(['1', '2', '3']);
    expect(s.listSchedules({ campaignId: 'a' }).map((x) => x.id)).toEqual(['1']);
    expect(s.listSchedules({ campaignId: '' }).map((x) => x.id)).toEqual(['3']);
  });

  test('DB cũ không có cột mới: migration thêm cột, chạy hai lần không lỗi', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE fb_poster_schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL,
      run_at INTEGER DEFAULT NULL, days TEXT NOT NULL DEFAULT '', time TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      draft INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER DEFAULT NULL, last_run_id TEXT DEFAULT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE fb_poster_post_tracking (result_id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, schedule_id TEXT DEFAULT NULL,
      profile_id TEXT NOT NULL, group_url TEXT NOT NULL, group_id TEXT NOT NULL DEFAULT '', post_id TEXT NOT NULL DEFAULT '', post_url TEXT DEFAULT NULL,
      posted_at INTEGER NOT NULL, text_head TEXT NOT NULL DEFAULT '', link_status TEXT NOT NULL, removed_suspected INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER DEFAULT NULL, last_checked_at INTEGER DEFAULT NULL, check_count INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER DEFAULT NULL, stats_done TEXT NOT NULL DEFAULT '')`);
    db.exec(`CREATE TABLE fb_poster_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', params_json TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER DEFAULT NULL)`);
    db.exec(`CREATE TABLE fb_poster_results (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_name TEXT NOT NULL,
      target_url TEXT NOT NULL, target_name TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', post_url TEXT DEFAULT NULL,
      comment_status TEXT NOT NULL DEFAULT 'not_requested', identity TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
    db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('old', 'Cũ', 'once', '{}', 1, 1)`);
    const s = new FacebookPosterStore(db);
    s.ensureSchema();
    s.ensureSchema();
    const columns = (table: string) => db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    expect(columns('fb_poster_runs')).toContain('campaign_id');
    expect(columns('fb_poster_results')).toEqual(expect.arrayContaining(['variant', 'error_code', 'attempts']));
    expect(columns('fb_poster_post_tracking')).toEqual(expect.arrayContaining(['campaign_id', 'variant']));
    const indexes = db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`).map((i) => i.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_fb_poster_schedules_campaign', 'idx_fb_poster_post_tracking_campaign']));
    expect(s.getSchedule('old')!.campaignId).toBeNull();
    expect(s.listSchedules({ campaignId: '' }).map((x) => x.id)).toEqual(['old']);
    s.createCampaign(camp('a'));
    expect(s.listCampaigns()).toHaveLength(1);
  });
});

describe('statsReport by campaign and variant', () => {
  const G = 'https://www.facebook.com/groups/1/';
  function seed() {
    const s = store();
    const sched = (id: string, name: string, campaignId: string | null) => s.createSchedule({
      id, name, kind: 'once', params: { kind: 'post' }, runAt: 10, days: [], time: '', enabled: true, nextRunAt: 10, createdAt: 1, campaignId,
    } as any);
    s.createCampaign({ id: 'c1', name: 'Tết', goal: '', status: 'active', startAt: null, endAt: null, createdAt: 1, updatedAt: 1 });
    sched('s1', 'Lịch 1', 'c1');
    sched('s2', 'Lịch 2', null);
    let id = 0;
    const track = (scheduleId: string | null, campaignId: string | null, variant: string, postedAt: number) => {
      id++;
      s.createTracking({
        resultId: id, runId: 'r', scheduleId, campaignId, variant, profileId: 'p1', groupUrl: G, groupId: '', postId: '', postUrl: null,
        postedAt, textHead: 'x', linkStatus: 'missing', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0,
        nextCheckAt: null, statsDone: [],
      } as any);
      return id;
    };
    track('s1', 'c1', 'A', 100);
    track('s1', 'c1', 'B', 101);
    track('s2', null, 'A', 102);
    track('s2', 'gone', '', 103);
    track(null, null, '', 104);
    track(null, null, 'B', 105);
    track('s-gone', null, 'A', 106);
    return { s, track };
  }
  const range = { from: 0, to: 1000, limit: 100 };

  test('groupBy campaign: có chiến dịch, không chiến dịch, đã xoá', () => {
    const { s } = seed();
    const rows = s.statsReport({ ...range, groupBy: 'campaign' });
    const by = Object.fromEntries(rows.map((r) => [r.key, [r.label, r.posts]]));
    expect(by).toEqual({ c1: ['Tết', 2], '': ['Không thuộc chiến dịch', 4], gone: ['(chiến dịch đã xoá)', 1] });
  });

  test('groupBy variant: A của lịch 1 khác A của lịch 2', () => {
    const { s } = seed();
    const by = Object.fromEntries(s.statsReport({ ...range, groupBy: 'variant' }).map((r) => [r.key, [r.label, r.posts]]));
    expect(by).toEqual({
      's1:A': ['Lịch 1 · A', 1], 's1:B': ['Lịch 1 · B', 1], 's2:A': ['Lịch 2 · A', 1], 's2:': ['Lịch 2', 1], ':': ['Đăng ngay', 1],
      ':B': ['Đăng ngay · B', 1], 's-gone:A': ['(lịch đã xoá) · A', 1],
    });
  });

  test('lọc campaignId (kể cả rỗng) và scheduleId cho mọi groupBy', () => {
    const { s } = seed();
    for (const groupBy of ['group', 'profile', 'schedule', 'day', 'campaign', 'variant'] as const) {
      expect(s.statsReport({ ...range, groupBy, campaignId: 'c1' }).reduce((n, r) => n + r.posts, 0)).toBe(2);
      expect(s.statsReport({ ...range, groupBy, campaignId: '' }).reduce((n, r) => n + r.posts, 0)).toBe(4);
      expect(s.statsReport({ ...range, groupBy, scheduleId: 's2' }).reduce((n, r) => n + r.posts, 0)).toBe(2);
      expect(s.statsReport({ ...range, groupBy, campaignId: 'c1', scheduleId: 's2' })).toEqual([]);
    }
    expect(s.statsReport({ ...range, groupBy: 'post', campaignId: 'c1' })).toHaveLength(2);
  });

  test('insufficient: 4 bài đã đo là thiếu, 5 là đủ', () => {
    const { s, track } = seed();
    const ids = [1, 2, 3, 4, 5].map((n) => track('s1', 'c9', '', 200 + n));
    for (const id of ids.slice(0, 4)) s.addPostStats(id, { capturedAt: 1, reactions: 1, comments: 0, shares: 0 });
    const find = () => s.statsReport({ ...range, groupBy: 'campaign' }).find((r) => r.key === 'c9')!;
    expect(find()).toMatchObject({ measured: 4, insufficient: true });
    s.addPostStats(ids[4], { capturedAt: 1, reactions: 1, comments: 0, shares: 0 });
    expect(find()).toMatchObject({ measured: 5, insufficient: false });
  });

  test('listTracking lọc campaignId và scheduleId', () => {
    const { s } = seed();
    expect(s.listTracking({ campaignId: 'c1' }).map((r) => r.resultId).sort()).toEqual([1, 2]);
    expect(s.listTracking({ campaignId: '' }).map((r) => r.resultId).sort()).toEqual([3, 5, 6, 7]);
    expect(s.listTracking({ scheduleId: 's2' }).map((r) => r.resultId).sort()).toEqual([3, 4]);
  });
});
