import { PageLearner, LEARN_FRESH_MS, LEARN_PAUSE_MIN_MS, LEARN_PAUSE_MAX_MS, type PageLearnerDeps } from '../../services/dailyBrief/PageLearner';
import { PageLoginProblem, type PageIdentityRead } from '../../services/dailyBrief/pageIdentity';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { PROFILE_OPEN_PREFIX } from '../../services/facebookPoster/loginCheck';
import { memoryDb } from '../facebookPoster/helpers';

const NOW = 100 * 86400000;
const page: PageIdentityRead = { kind: 'page', pageId: '123', pageName: 'Page', category: 'School', about: 'About', recentPosts: [] };
const empty: PageIdentityRead = { kind: 'person', pageId: '', pageName: '', category: '', about: '', recentPosts: [] };
function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
function setup() {
    const store = new DailyBriefStore(memoryDb());
    store.ensureSchema();
    const close = jest.fn(async () => undefined);
    const newPage = jest.fn(async () => ({}));
    const session = { context: { pages: () => [], newPage }, close };
    const deps = {
        store: jest.fn(() => store), openForAutomation: jest.fn(async (_id: string) => session),
        slot: { acquire: jest.fn(), release: jest.fn() }, shouldYield: jest.fn(() => false),
        isResearchRunning: jest.fn(() => false), observeLogin: jest.fn(), onFinished: jest.fn(),
        read: jest.fn(async () => page), now: () => NOW, sleep: jest.fn(async (_ms: number) => undefined),
        random: () => 0.5, newId: () => 'j1',
    };
    const learner = new PageLearner(deps as unknown as PageLearnerDeps);
    const seed = (patch = {}) => store.upsertIdentity({ ...page, profileId: 'p1', learnedAt: NOW - LEARN_FRESH_MS, errorCode: '', error: '', ...patch });
    const results = () => deps.onFinished.mock.calls[0][0].results;
    return { store, close, newPage, session, deps, learner, seed, results };
}

test('constants match the brief verbatim', () => {
    expect([LEARN_FRESH_MS, LEARN_PAUSE_MIN_MS, LEARN_PAUSE_MAX_MS]).toEqual([86400000, 20000, 60000]);
});

test('an empty workspace finishes asynchronously and releases its slot once', async () => {
    const { learner, deps, results } = setup();
    learner.learn([], false);
    expect(deps.onFinished).not.toHaveBeenCalled();
    await learner.whenIdle();
    expect(results()).toEqual([]);
    expect(deps.openForAutomation).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test('learns Page/person and preserves learned checkpoint metadata, then continues', async () => {
    const { learner, deps, store, seed, close, results } = setup();
    seed({ profileId: 'p3' });
    deps.read.mockResolvedValueOnce(page).mockResolvedValueOnce(empty as any)
        .mockRejectedValueOnce(new PageLoginProblem('checkpoint')).mockResolvedValueOnce(page);
    expect(learner.learn(['p1', 'p2', 'p3', 'p4'], false)).toEqual({ jobId: 'j1', profileIds: ['p1', 'p2', 'p3', 'p4'] });
    expect(learner.isRunning()).toBe(true);
    expect(deps.onFinished).not.toHaveBeenCalled();
    await learner.whenIdle();
    expect(store.listIdentities()).toHaveLength(4);
    expect(store.getIdentity('p1')).toEqual({ ...page, profileId: 'p1', learnedAt: NOW, errorCode: '', error: '' });
    expect(store.getIdentity('p2')?.kind).toBe('person');
    expect(store.getIdentity('p3')).toMatchObject({ ...page, learnedAt: NOW - LEARN_FRESH_MS, errorCode: 'checkpoint' });
    expect(deps.observeLogin).toHaveBeenCalledWith('p3', 'checkpoint');
    expect(results().map((r: any) => r.kind)).toEqual(['page', 'person', 'unknown', 'page']);
    expect(close).toHaveBeenCalledTimes(4);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});

test('logged_out maps only the stored code to not_logged_in', async () => {
    const { learner, deps, store } = setup();
    deps.read.mockRejectedValue(new PageLoginProblem('logged_out'));
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(store.getIdentity('p1')).toMatchObject({ kind: 'unknown', learnedAt: 0, errorCode: 'not_logged_in' });
    expect(deps.observeLogin).toHaveBeenCalledWith('p1', 'logged_out');
});

test('skips a fresh successful identity, force rereads it, and the exact boundary expires', async () => {
    const { learner, deps, seed, results } = setup();
    seed({ learnedAt: NOW - 1 });
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(results()).toEqual([{ profileId: 'p1', kind: 'skipped', pageName: 'Page' }]);
    expect(deps.openForAutomation).not.toHaveBeenCalled();
    expect(deps.observeLogin).not.toHaveBeenCalled();
    learner.learn(['p1'], true);
    await learner.whenIdle();
    seed();
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(deps.openForAutomation).toHaveBeenCalledTimes(2);
});

test.each([{ errorCode: 'checkpoint' }, { kind: 'unknown' }, { learnedAt: NOW + 1 }])('does not treat %p as fresh proof', async (patch) => {
    const { learner, deps, seed } = setup();
    seed({ learnedAt: NOW - 1, ...patch });
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(deps.read).toHaveBeenCalledTimes(1);
});

test('BUSY is synchronous for research, a second learn and the shared slot', async () => {
    const { learner, deps } = setup();
    deps.isResearchRunning.mockReturnValueOnce(true);
    expect(() => learner.learn(['p1'], false)).toThrow(BUSY_ERROR);
    expect(deps.slot.acquire).not.toHaveBeenCalled();
    deps.slot.acquire.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
    expect(() => learner.learn(['p1'], false)).toThrow(BUSY_ERROR);
    expect(learner.isRunning()).toBe(false);
    expect(deps.slot.release).not.toHaveBeenCalled();
    learner.learn(['p1'], false);
    expect(() => learner.learn(['p2'], false)).toThrow(BUSY_ERROR);
    await learner.whenIdle();
});

test.each(['store', 'newId'] as const)('releases a reserved slot if %s throws', async (key) => {
    const { learner, deps } = setup();
    deps[key] = jest.fn(() => { throw new Error('setup failed'); });
    expect(() => learner.learn(['p1'], false)).toThrow('setup failed');
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).not.toHaveBeenCalled();
    expect(learner.isRunning()).toBe(false);
});

test('blocks reentrant setup and copies the requested IDs', async () => {
    const { learner, deps } = setup();
    deps.store.mockImplementationOnce(() => {
        expect(() => learner.learn(['other'], false)).toThrow(BUSY_ERROR);
        return deps.store.getMockImplementation()!();
    });
    const ids = ['p1'];
    const started = learner.learn(ids, false);
    ids.push('p2');
    started.profileIds.push('p3');
    await learner.whenIdle();
    expect(deps.openForAutomation.mock.calls.map(([id]) => id)).toEqual(['p1']);
});

test('yields after the first profile and skips the remainder, releasing once', async () => {
    const { learner, deps, results } = setup();
    deps.read.mockImplementationOnce(async () => { deps.shouldYield.mockReturnValue(true); return page; });
    learner.learn(['p1', 'p2', 'p3'], false);
    await learner.whenIdle();
    expect(results().map((r: any) => r.kind)).toEqual(['page', 'skipped', 'skipped']);
    expect(deps.openForAutomation).toHaveBeenCalledTimes(1);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});

test('manual-open profiles skip without overwriting metadata', async () => {
    const { learner, deps, store, seed, results } = setup();
    seed();
    const before = store.getIdentity('p1');
    deps.openForAutomation.mockRejectedValueOnce(new Error(`${PROFILE_OPEN_PREFIX} tay`));
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(results()[0].kind).toBe('skipped');
    expect(store.getIdentity('p1')).toEqual(before);
});

test.each([0, 0.5, 1])('pauses between profiles within inclusive 20–60s, random %s', async (random) => {
    const { learner, deps } = setup();
    deps.random = () => random;
    learner.learn(['p1', 'p2', 'p3'], false);
    await learner.whenIdle();
    expect(deps.sleep.mock.calls).toEqual([[20000 + 40000 * random], [20000 + 40000 * random]]);
});

test('stop interrupts an injected pause and leaves no next profile', async () => {
    const { learner, deps, results } = setup();
    deps.sleep.mockImplementation(() => new Promise(() => {}));
    learner.learn(['p1', 'p2'], false);
    await tick();
    learner.stop(); learner.stop();
    await learner.whenIdle();
    expect(deps.openForAutomation).toHaveBeenCalledTimes(1);
    expect(results().map((r: any) => r.kind)).toEqual(['page', 'skipped']);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test.each(['open', 'read', 'close'] as const)('stop during %s waits for cleanup and prevents late writes/observations', async (phase) => {
    const { learner, deps, session, close, store } = setup();
    const gate = deferred<any>();
    if (phase === 'open') deps.openForAutomation.mockReturnValueOnce(gate.promise);
    if (phase === 'read') deps.read.mockReturnValueOnce(gate.promise);
    if (phase === 'close') close.mockReturnValueOnce(gate.promise);
    learner.learn(['p1', 'p2'], false);
    await tick();
    learner.stop();
    let idle = false;
    const waiting = learner.whenIdle().then(() => { idle = true; });
    await tick();
    expect(idle).toBe(false);
    gate.resolve(phase === 'open' ? session : phase === 'read' ? page : undefined);
    await waiting;
    expect(store.listIdentities()).toEqual([]);
    expect(deps.observeLogin).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(deps.openForAutomation).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test('captures the workspace store once for a whole job', async () => {
    const { learner, deps, store } = setup();
    const other = new DailyBriefStore(memoryDb()); other.ensureSchema();
    deps.read.mockImplementationOnce(async () => { deps.store.mockReturnValue(other); return page; });
    learner.learn(['p1', 'p2'], false);
    await learner.whenIdle();
    expect(store.listIdentities()).toHaveLength(2);
    expect(other.listIdentities()).toEqual([]);
    expect(deps.store).toHaveBeenCalledTimes(1);
});

test('a login rejection arriving after stop cannot save or emit a stale login observation', async () => {
    const { learner, deps, store } = setup();
    const gate = deferred<void>();
    deps.read.mockImplementationOnce(async () => { await gate.promise; throw new PageLoginProblem('checkpoint'); });
    learner.learn(['p1'], false); await tick();
    learner.stop(); gate.resolve(); await learner.whenIdle();
    expect(store.listIdentities()).toEqual([]);
    expect(deps.observeLogin).not.toHaveBeenCalled();
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test.each(['read', 'open', 'newPage', 'close', 'unknown'] as const)('%s failure preserves metadata and freshness, reports safe error and permits retry', async (phase) => {
    const { learner, deps, seed, store, close, newPage, results } = setup();
    seed(); const before = store.getIdentity('p1')!;
    const secret = new Error('navigation access_token=SECRET <html>private</html>');
    if (phase === 'read') deps.read.mockRejectedValueOnce(secret);
    if (phase === 'open') deps.openForAutomation.mockRejectedValueOnce(secret);
    if (phase === 'newPage') newPage.mockRejectedValueOnce(secret);
    if (phase === 'close') close.mockRejectedValueOnce(secret);
    if (phase === 'unknown') deps.read.mockResolvedValueOnce({ ...empty, kind: 'unknown' } as any);
    learner.learn(['p1'], false);
    await learner.whenIdle();
    expect(deps.observeLogin).not.toHaveBeenCalled();
    expect(store.getIdentity('p1')).toMatchObject({ ...before, errorCode: expect.any(String), error: expect.any(String) });
    expect(store.getIdentity('p1')?.errorCode).not.toBe('');
    expect(results()[0]).toMatchObject({ kind: 'unknown', error: expect.any(String) });
    expect(JSON.stringify(results())).not.toContain('SECRET');
    expect(close).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1);
    learner.learn(['p1'], false); await learner.whenIdle();
    expect(store.getIdentity('p1')).toMatchObject({ learnedAt: NOW, errorCode: '', error: '' });
});

test('unproven unknown never gains a successful freshness timestamp', async () => {
    const { learner, deps, store } = setup();
    deps.read.mockResolvedValue({ ...empty, kind: 'unknown' } as any);
    learner.learn(['p1'], false); await learner.whenIdle();
    learner.learn(['p1'], false); await learner.whenIdle();
    expect(store.getIdentity('p1')).toMatchObject({ kind: 'unknown', learnedAt: 0, errorCode: 'unknown' });
    expect(deps.read).toHaveBeenCalledTimes(2);
});

test.each(['shouldYield', 'sleep', 'observeLogin', 'onFinished'] as const)('%s throwing never leaks the slot or completion', async (key) => {
    const { learner, deps } = setup();
    deps[key] = jest.fn(() => { throw new Error('callback failed'); }) as any;
    if (key === 'observeLogin') deps.read.mockRejectedValueOnce(new PageLoginProblem('checkpoint'));
    learner.learn(['p1', 'p2'], false);
    await expect(learner.whenIdle()).resolves.toBeUndefined();
    expect(learner.isRunning()).toBe(false);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test('a finish callback may start a new job without the old finalizer resetting it', async () => {
    const { learner, deps } = setup();
    const readGate = deferred<any>();
    deps.read.mockResolvedValueOnce(page).mockReturnValueOnce(readGate.promise);
    deps.onFinished.mockImplementationOnce(() => { learner.learn(['p2'], false); });
    learner.learn(['p1'], false);
    await learner.whenIdle(); await tick();
    expect(learner.isRunning()).toBe(true);
    readGate.resolve(page); await learner.whenIdle();
    expect(deps.onFinished).toHaveBeenCalledTimes(2);
    expect(deps.slot.release).toHaveBeenCalledTimes(2);
});

test('read/login error retains priority if session close also rejects', async () => {
    const { learner, deps, close, store } = setup();
    deps.read.mockRejectedValueOnce(new PageLoginProblem('logged_out'));
    close.mockRejectedValueOnce(new Error('close failed'));
    learner.learn(['p1'], false); await learner.whenIdle();
    expect(store.getIdentity('p1')?.errorCode).toBe('not_logged_in');
    expect(deps.observeLogin).toHaveBeenCalledWith('p1', 'logged_out');
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});

test('stopping an owned timer clears it and a subsequent job can run', async () => {
    jest.useFakeTimers();
    try {
        const { learner, deps } = setup();
        delete (deps as Partial<typeof deps>).sleep;
        learner.learn(['p1', 'p2'], false);
        for (let i = 0; i < 15; i++) await Promise.resolve();
        expect(jest.getTimerCount()).toBe(1);
        learner.stop(); await learner.whenIdle();
        expect(jest.getTimerCount()).toBe(0);
        learner.learn(['p3'], false); await learner.whenIdle();
        expect(deps.openForAutomation.mock.calls.map(([id]) => id)).toEqual(['p1', 'p3']);
    } finally { jest.useRealTimers(); }
});

test('a throwing slot release still clears active and calls onFinished once', async () => {
    const { learner, deps } = setup();
    deps.slot.release.mockImplementationOnce(() => { throw new Error('release failed'); });
    learner.learn(['p1'], false); await learner.whenIdle();
    expect(learner.isRunning()).toBe(false);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
});

test('stop reentered while choosing the pause length cannot leave a sleeping job', async () => {
    const { learner, deps } = setup();
    deps.random = () => { learner.stop(); return 0.5; };
    deps.sleep.mockImplementation(() => new Promise(() => {}));
    learner.learn(['p1', 'p2'], false);
    await learner.whenIdle();
    expect(deps.openForAutomation).toHaveBeenCalledTimes(1);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
}, 1000);

test('50 fresh identities complete without browser attempts or pauses, looking up each profile once', async () => {
    const { learner, deps, store, seed, results } = setup();
    const ids = Array.from({ length: 50 }, (_, i) => `fresh-${i}`);
    for (const profileId of ids) seed({ profileId, pageName: profileId, learnedAt: NOW - 1 });
    const lookup = jest.spyOn(store, 'getIdentity');
    learner.learn(ids, false); await learner.whenIdle();
    expect(deps.openForAutomation).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(results()).toEqual(ids.map((profileId) => ({ profileId, kind: 'skipped', pageName: profileId })));
    expect(lookup.mock.calls).toEqual(ids.map((id) => [id]));
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
    expect(learner.isRunning()).toBe(false);
});

test.each([
    { ids: ['fresh-a', 'stale-a'], trace: ['open:stale-a', 'close'] },
    { ids: ['stale-a', 'fresh-a', 'stale-b'], trace: ['open:stale-a', 'close', 'sleep:40000', 'open:stale-b', 'close'] },
    { ids: ['stale-a', 'fresh-a'], trace: ['open:stale-a', 'close'] },
    {
        ids: ['fresh-a', 'fresh-b', 'stale-a', 'fresh-c', 'stale-b', 'fresh-d', 'stale-c', 'fresh-e'],
        trace: ['open:stale-a', 'close', 'sleep:40000', 'open:stale-b', 'close', 'sleep:40000', 'open:stale-c', 'close'],
    },
])('paces only eligible attempts with leading/interleaved/trailing fresh profiles: $ids', async ({ ids, trace: expected }) => {
    const { learner, deps, store, seed, session, close, results } = setup();
    for (const profileId of ids.filter((id) => id.startsWith('fresh-'))) seed({ profileId, learnedAt: NOW - 1 });
    const trace: string[] = [];
    deps.openForAutomation.mockImplementation(async (id) => { trace.push(`open:${id}`); return session; });
    close.mockImplementation(async () => { trace.push('close'); });
    deps.sleep.mockImplementation(async (ms) => { trace.push(`sleep:${ms}`); });
    const lookup = jest.spyOn(store, 'getIdentity');
    learner.learn(ids, false); await learner.whenIdle();
    expect(trace).toEqual(expected);
    expect(results().map((r: any) => r.profileId)).toEqual(ids);
    expect(results().map((r: any) => r.kind)).toEqual(ids.map((id) => id.startsWith('fresh-') ? 'skipped' : 'page'));
    expect(lookup.mock.calls).toEqual(ids.map((id) => [id]));
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});

test('failed opens and manual-open refusals still count as attempts for pacing', async () => {
    const { learner, deps, seed, session, results } = setup();
    const ids = ['fresh-a', 'stale-error', 'fresh-b', 'stale-manual', 'fresh-c', 'stale-ok', 'fresh-d'];
    for (const profileId of ids.filter((id) => id.startsWith('fresh-'))) seed({ profileId, learnedAt: NOW - 1 });
    const trace: string[] = [];
    deps.openForAutomation.mockImplementation(async (id) => {
        trace.push(`open:${id}`);
        if (id === 'stale-error') throw new Error('synthetic open failure');
        if (id === 'stale-manual') throw new Error(`${PROFILE_OPEN_PREFIX} tay`);
        return session;
    });
    deps.sleep.mockImplementation(async (ms) => { trace.push(`sleep:${ms}`); });
    learner.learn(ids, false); await learner.whenIdle();
    expect(trace).toEqual(['open:stale-error', 'sleep:40000', 'open:stale-manual', 'sleep:40000', 'open:stale-ok']);
    expect(results().map((r: any) => r.profileId)).toEqual(ids);
    expect(results().map((r: any) => r.kind)).toEqual(['skipped', 'unknown', 'skipped', 'skipped', 'skipped', 'page', 'skipped']);
    expect(deps.onFinished).toHaveBeenCalledTimes(1);
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});

test('force retains pacing between every browser attempt even for fresh profiles', async () => {
    const { learner, deps, store, seed, session, results } = setup();
    const ids = ['fresh-a', 'fresh-b', 'fresh-c'];
    for (const profileId of ids) seed({ profileId, learnedAt: NOW - 1 });
    const trace: string[] = [];
    deps.openForAutomation.mockImplementation(async (id) => { trace.push(`open:${id}`); return session; });
    deps.sleep.mockImplementation(async (ms) => { trace.push(`sleep:${ms}`); });
    const lookup = jest.spyOn(store, 'getIdentity');
    learner.learn(ids, true); await learner.whenIdle();
    expect(trace).toEqual(['open:fresh-a', 'sleep:40000', 'open:fresh-b', 'sleep:40000', 'open:fresh-c']);
    expect(results().map((r: any) => r.profileId)).toEqual(ids);
    expect(results().every((r: any) => r.kind === 'page')).toBe(true);
    expect(lookup.mock.calls).toEqual(ids.map((id) => [id]));
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});


test('observes ok only after successful read, close and storage; listener failure retains success', async () => {
    const { learner, deps, store, close, results } = setup();
    const observed: unknown[] = [];
    deps.observeLogin.mockImplementation((id: string, state: string) => {
        observed.push({ state, closed: close.mock.calls.length, identity: store.getIdentity(id) });
        throw new Error('listener');
    });
    learner.learn(['p1'], true); await learner.whenIdle();
    expect(deps.observeLogin).toHaveBeenCalledWith('p1', 'ok');
    expect(observed).toEqual([{ state: 'ok', closed: 1, identity: expect.objectContaining({ kind: 'page', errorCode: '' }) }]);
    expect(results()).toEqual([{ profileId: 'p1', kind: 'page', pageName: 'Page' }]);
    expect(store.getIdentity('p1')?.errorCode).toBe('');
    expect(deps.slot.release).toHaveBeenCalledTimes(1);
});
