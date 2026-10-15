import { classifyLogin, LoginChecker, type LoginCheckerDeps } from '../../services/facebookPoster/loginCheck';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { memoryDb } from './helpers';

function fakeSession(opts: { cookiesSeq: boolean[]; url?: string; gotoError?: Error }) {
  let i = 0;
  const goto = jest.fn(async () => { if (opts.gotoError) throw opts.gotoError; });
  const page = { goto, url: () => opts.url ?? 'https://www.facebook.com/' };
  const context = {
    cookies: jest.fn(async () => {
      const has = opts.cookiesSeq[Math.min(i++, opts.cookiesSeq.length - 1)];
      return has ? [{ name: 'c_user', value: '1' }] : [];
    }),
    pages: () => [page],
    newPage: async () => page,
  };
  return { context: context as any, goto };
}

describe('classifyLogin', () => {
  test('no c_user → logged_out without navigation', async () => {
    const s = fakeSession({ cookiesSeq: [false] });
    await expect(classifyLogin(s)).resolves.toBe('logged_out');
    expect(s.goto).not.toHaveBeenCalled();
  });
  test('/checkpoint/… → checkpoint', async () => {
    const s = fakeSession({ cookiesSeq: [true], url: 'https://www.facebook.com/checkpoint/1501092823525282/' });
    await expect(classifyLogin(s)).resolves.toBe('checkpoint');
    expect(s.goto).toHaveBeenCalledWith('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  });
  test.each(['/two_step_verification/authentication/?encrypted_context=x', '/auth_platform/afad/'])('%s → checkpoint', async (path) => {
    const s = fakeSession({ cookiesSeq: [true], url: `https://www.facebook.com${path}` });
    await expect(classifyLogin(s)).resolves.toBe('checkpoint');
  });
  test('/login.php → logged_out', async () => {
    const s = fakeSession({ cookiesSeq: [true], url: 'https://www.facebook.com/login.php?next=x' });
    await expect(classifyLogin(s)).resolves.toBe('logged_out');
  });
  test('cookie vanishes after load → logged_out', async () => {
    const s = fakeSession({ cookiesSeq: [true, false] });
    await expect(classifyLogin(s)).resolves.toBe('logged_out');
  });
  test('home → ok', async () => {
    const s = fakeSession({ cookiesSeq: [true, true] });
    await expect(classifyLogin(s)).resolves.toBe('ok');
  });
  test('goto timeout throws', async () => {
    const s = fakeSession({ cookiesSeq: [true], gotoError: new Error('Timeout 45000ms') });
    await expect(classifyLogin(s)).rejects.toThrow('Timeout');
  });
});

function setup(over: Partial<LoginCheckerDeps> = {}) {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const events = { problems: [] as any[], finished: [] as any[], progress: [] as any[], changed: 0, opened: [] as string[], closed: [] as string[], live: 0, maxLive: 0 };
  let slotHeld = false;
  const slot = {
    acquire: jest.fn(() => { if (slotHeld) throw new Error(BUSY_ERROR); slotHeld = true; }),
    release: jest.fn(() => { slotHeld = false; }),
  };
  const checker = new LoginChecker({
    store,
    getProfile: (id) => (id === 'ghost' ? null : { id, name: `Name ${id}` }),
    openForAutomation: async (id) => {
      events.opened.push(id);
      events.live += 1; events.maxLive = Math.max(events.maxLive, events.live);
      return { context: {} as any, close: async () => { events.live -= 1; events.closed.push(id); } };
    },
    slot,
    onProblem: (e) => events.problems.push(e),
    onFinished: (e) => events.finished.push(e),
    onProgress: (p) => events.progress.push(p),
    onStatesChanged: () => { events.changed += 1; },
    now: () => 1000,
    newId: () => 'chk-1',
    classify: async () => 'ok',
    ...over,
  });
  return { checker, store, events, slot };
}

describe('LoginChecker', () => {
  test('sequential, closes session on error', async () => {
    const { checker, events, store } = setup({
      classify: async (s: any) => { throw new Error('proxy chết'); },
    });
    const r = checker.check(['a', 'b'], 'manual');
    expect(r).toEqual({ checkId: 'chk-1', profileIds: ['a', 'b'] });
    await checker.whenIdle();
    expect(events.maxLive).toBe(1);
    expect(events.closed).toEqual(['a', 'b']);
    expect(events.finished[0].results.map((x: any) => x.outcome)).toEqual(['error', 'error']);
    expect(events.finished[0].results[0].error).toBe('proxy chết');
    expect(store.listLoginStates()).toEqual([]);
  });

  test('profile open → skipped, no write', async () => {
    const { checker, events, store } = setup({
      openForAutomation: async () => { throw new Error('Profile đang mở. Đóng profile trước khi chạy tự động'); },
    });
    checker.check(['a'], 'manual');
    await checker.whenIdle();
    expect(events.finished[0].results[0].outcome).toBe('skipped');
    expect(store.listLoginStates()).toEqual([]);
    expect(events.problems).toEqual([]);
  });

  test('problem emitted once per transition', async () => {
    const { checker, events } = setup({ classify: async () => 'logged_out' });
    checker.check(['a'], 'manual');
    await checker.whenIdle();
    checker.check(['a'], 'daily');
    await checker.whenIdle();
    expect(events.problems).toEqual([{ profileId: 'a', profileName: 'Name a', state: 'logged_out', source: 'check' }]);
    checker.observe('a', 'ok', 'run');
    checker.observe('a', 'logged_out', 'run');
    expect(events.problems).toHaveLength(2);
    expect(events.problems[1]).toMatchObject({ state: 'logged_out', source: 'run' });
    expect(events.changed).toBeGreaterThan(0);
  });

  test('error keeps state, no problem event', async () => {
    let fail = false;
    const { checker, events, store } = setup({ classify: async () => { if (fail) throw new Error('net'); return 'ok'; } });
    checker.check(['a'], 'manual');
    await checker.whenIdle();
    fail = true;
    checker.check(['a'], 'manual');
    await checker.whenIdle();
    expect(store.listLoginStates()[0]).toMatchObject({ state: 'ok', lastError: 'net' });
    expect(events.problems).toEqual([]);
  });

  test('BUSY when slot taken', async () => {
    const { checker, slot } = setup();
    slot.acquire();
    expect(() => checker.check(['a'], 'manual')).toThrow(BUSY_ERROR);
    expect(checker.isRunning()).toBe(false);
  });

  test('stop() halts after current profile', async () => {
    let checker!: LoginChecker;
    const ctx = setup({ classify: async () => { checker.stop(); return 'ok'; } });
    checker = ctx.checker;
    checker.check(['a', 'b', 'c'], 'manual');
    await checker.whenIdle();
    expect(ctx.events.opened).toEqual(['a']);
    expect(ctx.events.finished[0].results).toHaveLength(1);
    expect(ctx.slot.release).toHaveBeenCalled();
  });

  test('onFinished results', async () => {
    const { checker, events } = setup({ classify: async () => 'checkpoint' });
    checker.check(['a', 'ghost'], 'api');
    await checker.whenIdle();
    expect(events.finished).toEqual([{
      checkId: 'chk-1', source: 'api',
      results: [
        { profileId: 'a', profileName: 'Name a', outcome: 'checkpoint' },
        { profileId: 'ghost', profileName: 'ghost', outcome: 'checkpoint' },
      ],
    }]);
    expect(events.progress).toEqual([{ done: 0, total: 2 }, { done: 1, total: 2 }, { done: 2, total: 2 }, null]);
    expect(checker.isRunning()).toBe(false);
  });
});
