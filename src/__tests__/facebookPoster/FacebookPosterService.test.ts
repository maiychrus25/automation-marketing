import Database from 'better-sqlite3';
import { FacebookPosterService, type StartParams, type FacebookPosterServiceDeps } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';

const NOT_LOGGED_IN = 'Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập';
const JOINS_URL = 'https://www.facebook.com/groups/joins/';
const HOME = 'https://www.facebook.com/';

function memoryDb(): SqlDatabase {
  const db = new Database(':memory:');
  return {
    exec: (sql) => { db.exec(sql); },
    run: (sql, p = []) => { db.prepare(sql).run(...p); },
    runInsert: (sql, p = []) => Number(db.prepare(sql).run(...p).lastInsertRowid),
    transaction: (fn) => db.transaction(fn)(),
    // Spread: .all() trả mảng của realm Node; jest chạy test trong realm khác nên so sánh sâu sẽ báo lệch prototype.
    query: (sql, p = []) => [...db.prepare(sql).all(...p)] as any,
    queryOne: (sql, p = []) => db.prepare(sql).get(...p) as any,
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

interface Harness {
  service: FacebookPosterService;
  store: FacebookPosterStore;
  emitted: { channel: string; data: any }[];
  order: string[];
  opened: string[];
  closeCalls: string[];
  maxLive: () => number;
  sleeps: number[];
  sessions: { ctx: any; page: any }[];
  openFail: Map<string, Error>;
  loggedIn: Map<string, boolean>;
  results: (runId: string) => any[];
  run: (runId: string) => any;
}

function harness(tasks: Record<string, any> = {}, over: Partial<FacebookPosterServiceDeps> = {}): Harness {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const emitted: Harness['emitted'] = [];
  const order: string[] = [];
  const opened: string[] = [];
  const closeCalls: string[] = [];
  const sleeps: number[] = [];
  const sessions: Harness['sessions'] = [];
  const openFail = new Map<string, Error>();
  const loggedIn = new Map<string, boolean>();
  let live = 0;
  let max = 0;
  let clock = 1_000_000;
  let idSeq = 0;

  const createRun = store.createRun.bind(store);
  const finishRun = store.finishRun.bind(store);
  jest.spyOn(store, 'createRun').mockImplementation((r) => { order.push('createRun'); createRun(r); });
  jest.spyOn(store, 'finishRun').mockImplementation((...a) => { order.push(`finishRun:${a[1]}`); finishRun(...a); });

  const service = new FacebookPosterService({
    store,
    getProfile: (id) => (id === 'ghost' ? null : { id, name: `Name ${id}` }),
    openForAutomation: async (profileId) => {
      order.push(`open:${profileId}`);
      opened.push(profileId);
      const err = openFail.get(profileId);
      if (err) throw err;
      live += 1;
      max = Math.max(max, live);
      const page = { id: `page-${profileId}` };
      const ctx = {
        cookies: jest.fn(async () => (loggedIn.get(profileId) === false ? [] : [{ name: 'c_user', value: '1' }])),
        pages: jest.fn(() => [page]),
        newPage: jest.fn(async () => page),
      };
      sessions.push({ ctx, page });
      let closed = false;
      return {
        context: ctx as any,
        close: async () => {
          if (closed) return;
          closed = true;
          live -= 1;
          closeCalls.push(profileId);
        },
      };
    },
    emit: (channel, data) => { order.push(`emit:${channel}`); emitted.push({ channel, data }); },
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    newId: () => `run-${++idSeq}`,
    tasks: tasks as any,
    ...over,
  });
  return {
    service, store, emitted, order, opened, closeCalls, maxLive: () => max, sleeps, sessions, openFail, loggedIn,
    results: (runId) => store.getRun(runId)!.results,
    run: (runId) => store.getRun(runId)!.run,
  };
}

function postParams(over: Partial<Extract<StartParams, { kind: 'post' }>> = {}): StartParams {
  return {
    kind: 'post', mode: 'group', text: 'xin chào', mediaPaths: [], comment: null,
    profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] }],
    minDelaySec: 5, maxDelaySec: 9, concurrency: 3, staggerMinSec: 30, staggerMaxSec: 90, ...over,
  };
}

/** Fake postToTargets: reports every target as posted. */
function postAll(extra?: (deps: any, input: any) => Promise<void> | void) {
  return jest.fn(async (input: any, deps: any) => {
    await deps.launch();
    await extra?.(deps, input);
    for (const url of input.targets) {
      deps.onResult({ url, ok: true, error: null, postUrl: `${url}posts/1/`, commentStatus: 'posted', identity: 'Me' });
    }
    return { posted: input.targets.length, failed: 0, results: [] };
  });
}

afterEach(() => jest.restoreAllMocks());

describe('FacebookPosterService', () => {
  // 1
  test('start khi đang có việc thì ném "Đang có việc chạy", xong việc thì start lại được', async () => {
    const gate = deferred();
    const h = harness({ postToTargets: postAll(() => gate.promise) });
    h.service.start(postParams());
    expect(() => h.service.start(postParams())).toThrow('Đang có việc chạy');
    gate.resolve();
    await h.service.whenIdle();
    expect(h.service.current()).toBeNull();
    const second = h.service.start(postParams());
    expect(second.runId).toBe('run-2');
    await h.service.whenIdle();
    expect(h.run('run-2').status).toBe('done');
  });

  // 2
  test('createRun trước khi mở profile; finishRun đúng một lần; runFinished phát sau finishRun', async () => {
    const h = harness({ postToTargets: postAll() });
    const { runId } = h.service.start(postParams());
    await h.service.whenIdle();
    expect(h.order.indexOf('createRun')).toBe(0);
    expect(h.order.indexOf('createRun')).toBeLessThan(h.order.indexOf('open:p1'));
    expect(h.order.filter((e) => e.startsWith('finishRun'))).toEqual(['finishRun:done']);
    expect(h.order.indexOf('finishRun:done')).toBeLessThan(h.order.indexOf('emit:facebookPoster:runFinished'));
    const finished = h.emitted.filter((e) => e.channel === 'facebookPoster:runFinished');
    expect(finished).toEqual([{ channel: 'facebookPoster:runFinished', data: { runId, status: 'done' } }]);
    const run = h.run(runId);
    expect(run.kind).toBe('post');
    expect(run.mode).toBe('group');
    expect(run.finishedAt).not.toBeNull();
  });

  // 3
  test.each([
    ['post', 2, 5],
    ['scan_groups', 3, 6],
  ] as const)('%s: tối đa concurrency=%i profile chạy cùng lúc', async (kind, concurrency, count) => {
    const ids = Array.from({ length: count }, (_, i) => `p${i + 1}`);
    const body = async (deps: any) => { await deps.launch(); await tick(); await tick(); };
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => { await body(deps); for (const url of input.targets) deps.onResult({ url, ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' }); }),
      scanGroups: jest.fn(async (deps: any) => { await body(deps); return { groups: [], hitScrollLimit: false, scrollRounds: 1, scrollError: false }; }),
    });
    const params: StartParams = kind === 'post'
      ? postParams({ profiles: ids.map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })), concurrency })
      : { kind: 'scan_groups', profileIds: ids, concurrency, staggerMinSec: 30, staggerMaxSec: 90 };
    h.service.start(params);
    await h.service.whenIdle();
    expect(h.opened).toHaveLength(count);
    expect(h.maxLive()).toBe(concurrency);
  });

  // 4
  test('lệch giờ: profile k>=1 chờ 30000 + random*60000 ms tính từ lúc profile k-1 bắt đầu', async () => {
    const h = harness({ postToTargets: postAll() });
    h.service.start(postParams({
      profiles: ['p1', 'p2', 'p3'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1,
    }));
    await h.service.whenIdle();
    // random() = 0.5 -> khoảng cách 60000; đồng hồ giả chỉ nhích khi sleep, nên mỗi lần chờ đủ 60000.
    expect(h.sleeps).toEqual([60000, 60000]);
    expect(h.opened).toEqual(['p1', 'p2', 'p3']);
  });

  test('giãn cách 0: các profile bắt đầu ngay, không sleep', async () => {
    const h = harness({ postToTargets: postAll() });
    h.service.start(postParams({
      profiles: ['p1', 'p2', 'p3'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 3, staggerMinSec: 0, staggerMaxSec: 0,
    }));
    await h.service.whenIdle();
    expect(h.sleeps).toEqual([]);
    expect(h.maxLive()).toBe(3);
  });

  test('giãn cách tùy chỉnh 5-5 s: mỗi profile cách nhau 5000 ms', async () => {
    const h = harness({ postToTargets: postAll() });
    h.service.start(postParams({
      profiles: ['p1', 'p2'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1, staggerMinSec: 5, staggerMaxSec: 5,
    }));
    await h.service.whenIdle();
    expect(h.sleeps).toEqual([5000]);
  });

  test('lệch giờ: thời gian profile trước đã chạy được trừ vào khoảng chờ', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const h = harness(
      { postToTargets: postAll(() => { clock += 45000; }) },
      { now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } },
    );
    h.service.start(postParams({
      profiles: ['p1', 'p2'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1,
    }));
    await h.service.whenIdle();
    expect(sleeps).toEqual([15000]);
  });

  test('lệch giờ với concurrency >= 2: mỗi profile bắt đầu cách profile liền trước 30-90 s', async () => {
    let clock = 0;
    // Đồng hồ giả: chờ song song, nên sleep chỉ kéo đồng hồ tới mốc đích (không cộng dồn).
    const sleep = async (ms: number) => { const target = clock + ms; await tick(); clock = Math.max(clock, target); };
    const gaps = [0, 0.99, 0.5];
    let g = 0;
    const starts: Record<string, number> = {};
    const order: string[] = [];
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => { await deps.launch(); order.push(input.targets[0]); starts[input.targets[0]] = clock; for (const url of input.targets) deps.onResult({ url, ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' }); }),
    }, { now: () => clock, sleep, random: () => gaps[g++ % gaps.length] });
    h.service.start(postParams({
      profiles: [1, 2, 3, 4].map((n) => ({ profileId: `p${n}`, targets: [`https://www.facebook.com/groups/${n}/`] })),
      concurrency: 3,
    }));
    await h.service.whenIdle();
    const times = order.map((url) => starts[url]);
    expect(order).toHaveLength(4);
    const diffs = times.slice(1).map((t, i) => t - times[i]);
    for (const d of diffs) { expect(d).toBeGreaterThanOrEqual(30000); expect(d).toBeLessThanOrEqual(90000); }
    expect(diffs[0]).toBeCloseTo(30000, 0);
    expect(diffs[1]).toBeCloseTo(89400, 0);
    expect(diffs[2]).toBeCloseTo(60000, 0);
  });

  // 5
  test('launch mở phiên mới mỗi lần gọi, trả page đầu tiên, đóng mọi phiên kể cả khi tác vụ ném lỗi', async () => {
    const seen: any[] = [];
    const h = harness({
      searchAndJoinGroups: jest.fn(async (_input: any, deps: any) => {
        seen.push(await deps.launch());
        seen.push(await deps.launch());
        throw new Error('boom');
      }),
    });
    h.service.start({ kind: 'join', profileId: 'p1', keywords: ['k'], limit: 3, minDelaySec: 1, maxDelaySec: 2 });
    await h.service.whenIdle();
    expect(h.opened).toEqual(['p1', 'p1']);
    expect(seen[0].ctx).toBe(h.sessions[0].ctx);
    expect(seen[0].page).toBe(h.sessions[0].page);
    expect(seen[1].page).toBe(h.sessions[1].page);
    expect(h.closeCalls).toEqual(['p1', 'p1']);
  });

  test('launch dùng newPage khi phiên chưa có trang nào', async () => {
    const h = harness({
      scanGroups: jest.fn(async (deps: any) => {
        const { page } = await deps.launch();
        expect(page).toEqual({ id: 'fresh' });
        return { groups: [], hitScrollLimit: false, scrollRounds: 0, scrollError: false };
      }),
    }, {
      openForAutomation: async () => ({
        context: { cookies: async () => [{ name: 'c_user', value: '1' }], pages: () => [], newPage: async () => ({ id: 'fresh' }) } as any,
        close: async () => {},
      }),
    });
    h.service.start({ kind: 'scan_groups', profileIds: ['p1'], concurrency: 1, staggerMinSec: 30, staggerMaxSec: 90 });
    await h.service.whenIdle();
    expect(h.run('run-1').status).toBe('done');
    expect(h.results('run-1')[0].outcome).toBe('done');
  });

  // 6
  test('chưa đăng nhập: đóng phiên, không mở thêm, mọi đích failed với đúng thông báo', async () => {
    const h = harness({ postToTargets: postAll() });
    h.loggedIn.set('p1', false);
    const { runId } = h.service.start(postParams());
    await h.service.whenIdle();
    expect(h.opened).toEqual(['p1']);
    expect(h.closeCalls).toEqual(['p1']);
    const rows = h.results(runId);
    expect(rows.map((r) => [r.outcome, r.error])).toEqual([['failed', NOT_LOGGED_IN], ['failed', NOT_LOGGED_IN]]);
    expect(h.run(runId).status).toBe('done');
  });

  test('kiểm tra đăng nhập chỉ ở lần launch đầu của profile', async () => {
    const h = harness({
      searchAndJoinGroups: jest.fn(async (_input: any, deps: any) => { await deps.launch(); await deps.launch(); return { joined: 0, pending: 0, skipped: 0, failed: 0, results: [] }; }),
    });
    h.service.start({ kind: 'join', profileId: 'p1', keywords: ['k'], limit: 3, minDelaySec: 1, maxDelaySec: 2 });
    await h.service.whenIdle();
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].ctx.cookies).toHaveBeenCalledTimes(1);
    expect(h.sessions[1].ctx.cookies).not.toHaveBeenCalled();
  });

  // 7
  test('profile đang mở tay: mọi đích của nó failed, profile khác vẫn chạy, run done', async () => {
    const h = harness({ postToTargets: postAll() });
    h.openFail.set('p1', new Error('Profile đang mở. Đóng profile trước khi chạy tự động'));
    const { runId } = h.service.start(postParams({
      profiles: [
        { profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] },
        { profileId: 'p2', targets: ['https://www.facebook.com/groups/3/'] },
      ],
    }));
    await h.service.whenIdle();
    const rows = h.results(runId);
    expect(rows.filter((r) => r.profileId === 'p1').map((r) => [r.outcome, r.error])).toEqual([
      ['failed', 'Profile đang mở. Đóng profile trước khi chạy tự động'],
      ['failed', 'Profile đang mở. Đóng profile trước khi chạy tự động'],
    ]);
    expect(rows.filter((r) => r.profileId === 'p2').map((r) => r.outcome)).toEqual(['posted']);
    expect(h.run(runId).status).toBe('done');
  });

  // 8
  test('onResult ghi addResult ngay, đủ outcome, postUrl, commentStatus, identity, profileName', async () => {
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: 'https://www.facebook.com/groups/1/posts/9/', commentStatus: 'posted', identity: 'An' });
        // Đã ghi trước khi tác vụ chạy tiếp.
        expect(h.results('run-1')).toHaveLength(1);
        deps.onResult({ url: input.targets[1], ok: false, error: 'hỏng', postUrl: null, commentStatus: 'not_requested', identity: '' });
        deps.onResult({ url: input.targets[2], ok: false, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' });
      }),
    });
    const { runId } = h.service.start(postParams({
      profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/', 'https://www.facebook.com/groups/3/'] }],
    }));
    await h.service.whenIdle();
    const rows = h.results(runId);
    expect(rows[0]).toMatchObject({
      profileId: 'p1', profileName: 'Name p1', targetUrl: 'https://www.facebook.com/groups/1/', outcome: 'posted', error: '',
      postUrl: 'https://www.facebook.com/groups/1/posts/9/', commentStatus: 'posted', identity: 'An',
    });
    expect(rows[1]).toMatchObject({ outcome: 'failed', error: 'hỏng', postUrl: null, commentStatus: 'not_requested' });
    expect(rows[2]).toMatchObject({ outcome: 'failed' });
    expect(rows[2].error).not.toBe('');
  });

  test('truyền thẳng giây nghỉ, nội dung, tệp, bình luận cho tác vụ; mode page dùng đích là trang chủ', async () => {
    const task = postAll();
    const h = harness({ postToTargets: task });
    h.service.start(postParams({
      mode: 'page', text: 'nội dung', mediaPaths: ['/tmp/a.png'], comment: 'bl', minDelaySec: 7, maxDelaySec: 11,
      profiles: [{ profileId: 'p1', targets: [] }],
    }));
    await h.service.whenIdle();
    expect(task.mock.calls[0][0]).toEqual({
      text: 'nội dung', mediaPaths: ['/tmp/a.png'], comment: 'bl', targets: [HOME], minDelay: 7, maxDelay: 11,
    });
    const rows = h.results('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].targetUrl).toBe(HOME);
    expect(h.run('run-1').mode).toBe('page');
  });

  test('profile không còn trong danh sách vẫn ghi được, tên rơi về id', async () => {
    const h = harness({ postToTargets: postAll() });
    h.service.start(postParams({ profiles: [{ profileId: 'ghost', targets: ['https://www.facebook.com/groups/1/'] }] }));
    await h.service.whenIdle();
    expect(h.results('run-1')[0].profileName).toBe('ghost');
  });

  test('profile đã bị xóa: chỉ đích của nó failed "Không tìm thấy profile", profile khác vẫn đăng', async () => {
    const h = harness({ postToTargets: postAll() });
    h.service.start(postParams({
      profiles: [
        { profileId: 'p1', targets: ['https://www.facebook.com/groups/1/'] },
        { profileId: 'ghost', targets: ['https://www.facebook.com/groups/2/', 'https://www.facebook.com/groups/3/'] },
      ],
    }));
    await h.service.whenIdle();
    const rows = h.results('run-1');
    expect(rows.filter((r) => r.profileId === 'p1').map((r) => r.outcome)).toEqual(['posted']);
    const ghost = rows.filter((r) => r.profileId === 'ghost');
    expect(ghost.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(ghost.every((r) => r.error === 'Không tìm thấy profile')).toBe(true);
    expect(h.opened).toEqual(['p1']);
  });

  // 9
  test('cửa sổ đóng giữa chừng: đích đầu chưa có kết quả failed với lỗi, phần còn lại skipped "Đã dừng"', async () => {
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' });
        throw new Error('Target page, context or browser has been closed');
      }),
    });
    const { runId } = h.service.start(postParams({
      profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/', 'https://www.facebook.com/groups/3/', 'https://www.facebook.com/groups/4/'] }],
    }));
    await h.service.whenIdle();
    expect(h.results(runId).map((r) => [r.targetUrl.slice(-2), r.outcome, r.error])).toEqual([
      ['1/', 'posted', ''],
      ['2/', 'failed', 'Target page, context or browser has been closed'],
      ['3/', 'skipped', 'Đã dừng'],
      ['4/', 'skipped', 'Đã dừng'],
    ]);
    expect(h.closeCalls).toEqual(['p1']);
    expect(h.run(runId).status).toBe('done');
  });

  // 10
  test('cancel trong lúc tác vụ chạy: getIsStopping true, profile chưa bắt đầu skipped, run cancelled, phiên đã đóng', async () => {
    let service!: FacebookPosterService;
    const stoppingSeen: boolean[] = [];
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        stoppingSeen.push(deps.getIsStopping());
        service.cancel();
        stoppingSeen.push(deps.getIsStopping());
        // Tác vụ thật dừng ở đây: đích chưa làm không có kết quả.
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' });
      }),
    });
    service = h.service;
    const { runId } = h.service.start(postParams({
      profiles: [
        { profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] },
        { profileId: 'p2', targets: ['https://www.facebook.com/groups/3/'] },
      ],
      concurrency: 1,
    }));
    await h.service.whenIdle();
    expect(stoppingSeen).toEqual([false, true]);
    expect(h.opened).toEqual(['p1']);
    expect(h.results(runId).map((r) => [r.profileId, r.outcome, r.error])).toEqual([
      ['p1', 'posted', ''],
      ['p1', 'skipped', 'Đã dừng'],
      ['p2', 'skipped', 'Đã dừng'],
    ]);
    expect(h.run(runId).status).toBe('cancelled');
    expect(h.closeCalls).toEqual(['p1']);
    expect(h.emitted.filter((e) => e.channel === 'facebookPoster:runFinished')[0].data).toEqual({ runId, status: 'cancelled' });
  });

  test('cancel trong lúc chờ lệch giờ: sleep nhận isStopping, profile chưa bắt đầu skipped', async () => {
    let service!: FacebookPosterService;
    const stoppingAtSleep: boolean[] = [];
    const h = harness({ postToTargets: postAll() }, {
      sleep: async (_ms, isStopping) => { service.cancel(); stoppingAtSleep.push(isStopping()); },
    });
    service = h.service;
    const { runId } = h.service.start(postParams({
      profiles: ['p1', 'p2', 'p3'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1,
    }));
    await h.service.whenIdle();
    expect(stoppingAtSleep).toEqual([true]);
    expect(h.opened).toEqual(['p1']);
    expect(h.results(runId).map((r) => [r.profileId, r.outcome, r.error])).toEqual([
      ['p1', 'posted', ''],
      ['p2', 'skipped', 'Đã dừng'],
      ['p3', 'skipped', 'Đã dừng'],
    ]);
    expect(h.run(runId).status).toBe('cancelled');
  });

  test('cancel khi rảnh là no-op; cancelAll giống cancel', async () => {
    const gate = deferred();
    const h = harness({ postToTargets: postAll(() => gate.promise) });
    h.service.cancel();
    h.service.cancelAll();
    h.service.start(postParams());
    h.service.cancelAll();
    gate.resolve();
    await h.service.whenIdle();
    expect(h.run('run-1').status).toBe('cancelled');
    // Cờ dừng không rò sang việc sau.
    h.service.start(postParams());
    await h.service.whenIdle();
    expect(h.run('run-2').status).toBe('done');
  });

  // 11
  test('scan_groups: replaceGroups cho mỗi profile, một dòng kết quả mỗi profile (done hoặc failed)', async () => {
    const h = harness({
      scanGroups: jest.fn(async (deps: any) => {
        const { page } = await deps.launch();
        if ((page as any).id === 'page-p2') throw new Error('quét hỏng');
        return {
          groups: [{ id: '1', name: 'Nhóm A', url: 'https://www.facebook.com/groups/1/' }, { id: '2', name: 'Nhóm B', url: 'https://www.facebook.com/groups/2/' }],
          hitScrollLimit: false, scrollRounds: 3, scrollError: false,
        };
      }),
    });
    const { runId } = h.service.start({ kind: 'scan_groups', profileIds: ['p1', 'p2'], concurrency: 1, staggerMinSec: 30, staggerMaxSec: 90 });
    await h.service.whenIdle();
    const groups = h.store.listGroups(['p1', 'p2']);
    expect(groups.p1.map((g) => [g.url, g.name, g.scannedAt])).toEqual([
      ['https://www.facebook.com/groups/1/', 'Nhóm A', expect.any(Number)],
      ['https://www.facebook.com/groups/2/', 'Nhóm B', expect.any(Number)],
    ]);
    expect(groups.p2).toEqual([]);
    const rows = h.results(runId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ profileId: 'p1', targetUrl: JOINS_URL, targetName: '2 nhóm', outcome: 'done', error: '' });
    expect(rows[1]).toMatchObject({ profileId: 'p2', targetUrl: JOINS_URL, outcome: 'failed', error: 'quét hỏng' });
    expect(h.run(runId).mode).toBe('');
  });

  test('scan_groups: quét lỗi giữa chừng thì giữ danh sách cũ, dòng failed, cảnh báo trong nhật ký', async () => {
    const message = 'Quét nhóm bị lỗi giữa chừng, giữ danh sách cũ';
    const h = harness({
      scanGroups: jest.fn(async (deps: any) => {
        await deps.launch();
        return { groups: [{ id: '9', name: 'Mới', url: 'https://www.facebook.com/groups/9/' }], hitScrollLimit: false, scrollRounds: 2, scrollError: true };
      }),
    });
    h.store.replaceGroups('p1', [{ url: 'https://www.facebook.com/groups/old/', name: 'Cũ' }], 1);
    const { runId } = h.service.start({ kind: 'scan_groups', profileIds: ['p1'], concurrency: 1, staggerMinSec: 30, staggerMaxSec: 90 });
    await h.service.whenIdle();
    expect(h.store.listGroups(['p1']).p1.map((g) => g.url)).toEqual(['https://www.facebook.com/groups/old/']);
    expect(h.results(runId).map((r) => [r.targetUrl, r.outcome, r.error])).toEqual([[JOINS_URL, 'failed', message]]);
    const logs = h.emitted.filter((e) => e.channel === 'facebookPoster:log').map((e) => e.data);
    expect(logs).toContainEqual({ runId, profileId: 'p1', level: 'warning', message, at: expect.any(Number) });
    expect(h.closeCalls).toEqual(['p1']);
  });

  test('scan_groups: chạm trần cuộn thì vẫn ghi đè danh sách, dòng done kèm cảnh báo', async () => {
    const message = 'Danh sách có thể thiếu (chạm trần cuộn)';
    const h = harness({
      scanGroups: jest.fn(async (deps: any) => {
        await deps.launch();
        return { groups: [{ id: '9', name: 'Mới', url: 'https://www.facebook.com/groups/9/' }], hitScrollLimit: true, scrollRounds: 200, scrollError: false };
      }),
    });
    h.store.replaceGroups('p1', [{ url: 'https://www.facebook.com/groups/old/', name: 'Cũ' }], 1);
    const { runId } = h.service.start({ kind: 'scan_groups', profileIds: ['p1'], concurrency: 1, staggerMinSec: 30, staggerMaxSec: 90 });
    await h.service.whenIdle();
    expect(h.store.listGroups(['p1']).p1.map((g) => g.url)).toEqual(['https://www.facebook.com/groups/9/']);
    expect(h.results(runId).map((r) => [r.targetName, r.outcome, r.error])).toEqual([['1 nhóm', 'done', message]]);
    const logs = h.emitted.filter((e) => e.channel === 'facebookPoster:log').map((e) => e.data);
    expect(logs).toContainEqual({ runId, profileId: 'p1', level: 'warning', message, at: expect.any(Number) });
  });

  // 12
  test('join: mỗi nhóm một dòng từ onResult, truyền keywords/limit/giây nghỉ', async () => {
    const task = jest.fn(async (_input: any, deps: any) => {
      await deps.launch();
      deps.onResult({ id: '1', name: 'Nhóm A', url: 'https://www.facebook.com/groups/1/', outcome: 'joined' });
      deps.onResult({ id: '2', name: 'Nhóm B', url: 'https://www.facebook.com/groups/2/', outcome: 'pending' });
      return { joined: 1, pending: 1, skipped: 0, failed: 0, results: [] };
    });
    const h = harness({ searchAndJoinGroups: task });
    const { runId } = h.service.start({ kind: 'join', profileId: 'p1', keywords: ['a', 'b'], limit: 5, minDelaySec: 3, maxDelaySec: 4 });
    await h.service.whenIdle();
    expect(task.mock.calls[0][0]).toEqual({ keywords: ['a', 'b'], limit: 5, minDelay: 3, maxDelay: 4 });
    expect(h.results(runId).map((r) => [r.targetUrl, r.targetName, r.outcome, r.profileName])).toEqual([
      ['https://www.facebook.com/groups/1/', 'Nhóm A', 'joined', 'Name p1'],
      ['https://www.facebook.com/groups/2/', 'Nhóm B', 'pending', 'Name p1'],
    ]);
    expect(h.run(runId).status).toBe('done');
  });

  test('join: tác vụ ném lỗi thì thêm một dòng failed', async () => {
    const h = harness({ searchAndJoinGroups: jest.fn(async () => { throw new Error('không quét được'); }) });
    const { runId } = h.service.start({ kind: 'join', profileId: 'p1', keywords: ['a'], limit: 5, minDelaySec: 3, maxDelaySec: 4 });
    await h.service.whenIdle();
    expect(h.results(runId).map((r) => [r.outcome, r.error])).toEqual([['failed', 'không quét được']]);
  });

  // 13
  test('collect_comments: loadKeys từ store, saveComments ghi qua store, một dòng mỗi bài', async () => {
    const comment = { authorId: 'a1', authorName: 'An', authorUrl: 'u', text: 'hi', commentedAt: '2 giờ', postUrl: 'https://www.facebook.com/groups/1/posts/1/' };
    let keysLoaded: Set<string> | null = null;
    let written = -1;
    const task = jest.fn(async (input: any, deps: any) => {
      await deps.launch();
      keysLoaded = await deps.loadKeys();
      written = await deps.saveComments([comment]);
      return {
        scanned: 1, failed: 1, added: written,
        results: [
          { url: input.posts[0].postUrl, outcome: 'done', error: null, added: written },
          { url: input.posts[1].postUrl, outcome: 'failed', error: 'không mở được', added: 0 },
        ],
      };
    });
    const h = harness({ collectComments: task });
    const { runId } = h.service.start({
      kind: 'collect_comments', profileId: 'p1',
      postUrls: ['https://www.facebook.com/groups/1/posts/1/', 'https://www.facebook.com/groups/1/posts/2/'],
    });
    await h.service.whenIdle();
    expect(task.mock.calls[0][0]).toEqual({
      posts: [{ postUrl: 'https://www.facebook.com/groups/1/posts/1/' }, { postUrl: 'https://www.facebook.com/groups/1/posts/2/' }],
      minDelay: 10, maxDelay: 20,
    });
    expect([...keysLoaded!]).toEqual([]);
    expect(written).toBe(1);
    const saved = h.store.listComments({ limit: 10, offset: 0 });
    expect(saved.total).toBe(1);
    expect(saved.comments[0]).toMatchObject({ profileId: 'p1', text: 'hi', collectedAt: expect.any(Number) });
    expect(h.results(runId).map((r) => [r.targetUrl.slice(-2), r.outcome, r.error])).toEqual([
      ['1/', 'done', ''],
      ['2/', 'failed', 'không mở được'],
    ]);
    expect(h.run(runId).status).toBe('done');
  });

  // 14
  test('tiến độ: phát progress sau mỗi kết quả, done/total và trạng thái từng profile đúng; current() trả cùng ảnh chụp', async () => {
    const gate = deferred();
    let snapshotInTask: any = null;
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' });
        snapshotInTask ??= h.service.current();
        await gate.promise;
        if (input.targets[1]) deps.onResult({ url: input.targets[1], ok: false, error: 'x', postUrl: null, commentStatus: 'not_requested', identity: '' });
      }),
    });
    const { runId } = h.service.start(postParams({
      profiles: [
        { profileId: 'p1', targets: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] },
        { profileId: 'p2', targets: ['https://www.facebook.com/groups/3/'] },
      ],
      concurrency: 1,
    }));
    await tick();
    await tick();
    gate.resolve();
    await h.service.whenIdle();

    const progress = h.emitted.filter((e) => e.channel === 'facebookPoster:progress').map((e) => e.data);
    expect(snapshotInTask.run).toMatchObject({ id: runId, status: 'running', kind: 'post' });
    expect(snapshotInTask.progress).toEqual({
      runId, done: 1, total: 3,
      profiles: [
        { profileId: 'p1', state: 'running', done: 1, total: 2 },
        { profileId: 'p2', state: 'waiting', done: 0, total: 1 },
      ],
    });
    // Ảnh chụp trong lúc chạy trùng với một sự kiện đã phát.
    expect(progress).toContainEqual(snapshotInTask.progress);
    const last = progress[progress.length - 1];
    expect(last).toEqual({
      runId, done: 3, total: 3,
      profiles: [
        { profileId: 'p1', state: 'done', done: 2, total: 2 },
        { profileId: 'p2', state: 'done', done: 1, total: 1 },
      ],
    });
    // Mỗi kết quả (3) cộng thêm các lần đổi trạng thái đều phát: ít nhất một sự kiện cho mỗi giá trị done = 1, 2, 3.
    expect(new Set(progress.map((p: any) => p.done))).toEqual(new Set([0, 1, 2, 3]));
  });

  test('tiến độ: profile bị huỷ có state cancelled', async () => {
    let service!: FacebookPosterService;
    const h = harness({
      postToTargets: jest.fn(async (_input: any, deps: any) => { await deps.launch(); service.cancel(); }),
    });
    service = h.service;
    h.service.start(postParams({
      profiles: ['p1', 'p2', 'p3'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1,
    }));
    await h.service.whenIdle();
    const last = h.emitted.filter((e) => e.channel === 'facebookPoster:progress').pop()!.data;
    expect(last.profiles.map((p: any) => [p.profileId, p.state, p.done])).toEqual([
      ['p1', 'cancelled', 1],
      ['p2', 'cancelled', 1],
      ['p3', 'cancelled', 1],
    ]);
  });

  test('tiến độ: profile không mở được có state failed, các profile khác done', async () => {
    const h = harness({ postToTargets: postAll() });
    h.openFail.set('p2', new Error('no'));
    h.service.start(postParams({
      profiles: ['p1', 'p2', 'p3'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
      concurrency: 1,
    }));
    await h.service.whenIdle();
    const last = h.emitted.filter((e) => e.channel === 'facebookPoster:progress').pop()!.data;
    expect(last.profiles.map((p: any) => [p.profileId, p.state, p.done])).toEqual([
      ['p1', 'done', 1],
      ['p2', 'failed', 1],
      ['p3', 'done', 1],
    ]);
  });

  // 15
  test('sendLog của tác vụ phát facebookPoster:log với runId, profileId, level, message, at', async () => {
    const h = harness({
      postToTargets: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        deps.sendLog('đang đăng', 'info');
        deps.sendLog('xong', 'success');
        deps.updateProgress(50, 'nửa chừng');
        deps.onResult({ url: input.targets[0], ok: true, error: null, postUrl: null, commentStatus: 'not_requested', identity: '' });
      }),
    });
    const { runId } = h.service.start(postParams({ profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/'] }] }));
    await h.service.whenIdle();
    const logs = h.emitted.filter((e) => e.channel === 'facebookPoster:log').map((e) => e.data);
    expect(logs).toEqual([
      { runId, profileId: 'p1', level: 'info', message: 'đang đăng', at: expect.any(Number) },
      { runId, profileId: 'p1', level: 'success', message: 'xong', at: expect.any(Number) },
    ]);
  });

  // 16
  test('addResult ném lỗi: run failed với thông báo đó, phiên vẫn đóng', async () => {
    const h = harness({ postToTargets: postAll() });
    jest.spyOn(h.store, 'addResult').mockImplementation(() => { throw new Error('disk full'); });
    const { runId } = h.service.start(postParams());
    await h.service.whenIdle();
    const run = h.run(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('disk full');
    expect(h.closeCalls).toEqual(['p1']);
    expect(h.order.filter((e) => e.startsWith('finishRun'))).toEqual(['finishRun:failed']);
    expect(h.emitted.filter((e) => e.channel === 'facebookPoster:runFinished')[0].data).toEqual({ runId, status: 'failed' });
  });

  test('saveComments ném lỗi trong thu bình luận: run failed với thông báo đó', async () => {
    const h = harness({
      collectComments: jest.fn(async (input: any, deps: any) => {
        await deps.launch();
        const written = await deps.saveComments([{ authorId: 'a', authorName: '', authorUrl: '', text: 't', commentedAt: '', postUrl: input.posts[0].postUrl }]).catch(() => 0);
        return { scanned: 1, failed: 0, added: written, results: [{ url: input.posts[0].postUrl, outcome: 'done', error: null, added: written }] };
      }),
    });
    jest.spyOn(h.store, 'saveComments').mockImplementation(() => { throw new Error('read-only database'); });
    const { runId } = h.service.start({ kind: 'collect_comments', profileId: 'p1', postUrls: ['https://www.facebook.com/groups/1/posts/1/'] });
    await h.service.whenIdle();
    expect(h.run(runId)).toMatchObject({ status: 'failed', error: 'read-only database' });
    expect(h.closeCalls).toEqual(['p1']);
  });

  test('replaceGroups ném lỗi: run failed, dòng kết quả của profile là failed', async () => {
    const h = harness({
      scanGroups: jest.fn(async (deps: any) => { await deps.launch(); return { groups: [{ id: '1', name: 'A', url: 'u' }], hitScrollLimit: false, scrollRounds: 1, scrollError: false }; }),
    });
    jest.spyOn(h.store, 'replaceGroups').mockImplementation(() => { throw new Error('locked'); });
    const { runId } = h.service.start({ kind: 'scan_groups', profileIds: ['p1'], concurrency: 1, staggerMinSec: 30, staggerMaxSec: 90 });
    await h.service.whenIdle();
    expect(h.run(runId)).toMatchObject({ status: 'failed', error: 'locked' });
    expect(h.results(runId).map((r) => [r.outcome, r.error])).toEqual([['failed', 'locked']]);
  });

  test('emit ném lỗi không làm hỏng run', async () => {
    const h = harness({ postToTargets: postAll() }, { emit: () => { throw new Error('renderer gone'); } });
    h.service.start(postParams());
    await h.service.whenIdle();
    expect(h.run('run-1').status).toBe('done');
    expect(h.results('run-1')).toHaveLength(2);
  });

  test('sleep mặc định chia lát 500 ms và dừng sớm khi isStopping', async () => {
    jest.useFakeTimers();
    try {
      const store = new FacebookPosterStore(memoryDb());
      store.ensureSchema();
      const service = new FacebookPosterService({
        store, getProfile: (id) => ({ id, name: id }), emit: () => {},
        openForAutomation: async () => ({ context: { cookies: async () => [{ name: 'c_user', value: '1' }], pages: () => [{}], newPage: async () => ({}) } as any, close: async () => {} }),
        tasks: { postToTargets: postAll() as any },
        random: () => 0, // khoảng cách 30000 ms
      });
      const { runId } = service.start(postParams({
        profiles: ['p1', 'p2'].map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/1/'] })),
        concurrency: 1,
      }));
      await jest.advanceTimersByTimeAsync(10_000);
      expect(service.current()!.progress.profiles.map((p) => p.state)).toEqual(['done', 'waiting']);
      service.cancel();
      await jest.advanceTimersByTimeAsync(500);
      await service.whenIdle();
      const { run, results } = store.getRun(runId)!;
      expect(run.status).toBe('cancelled');
      expect(results.map((r) => [r.profileId, r.outcome])).toEqual([['p1', 'posted'], ['p2', 'skipped']]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('FacebookPosterService scheduleId', () => {
  test('start(params, scheduleId) lưu scheduleId; start(params) lưu null', async () => {
    const h = harness({ postToTargets: postAll() });
    const first = h.service.start(postParams(), 'sch-1');
    await h.service.whenIdle();
    expect(h.run(first.runId).scheduleId).toBe('sch-1');
    const second = h.service.start(postParams());
    await h.service.whenIdle();
    expect(h.run(second.runId).scheduleId).toBeNull();
  });
});
