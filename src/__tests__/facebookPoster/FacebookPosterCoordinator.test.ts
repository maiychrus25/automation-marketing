import Database from 'better-sqlite3';
import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';
import { FacebookPosterService, BUSY_ERROR, type StartParams } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterCoordinator, PosterRunSelectionError } from '../../services/facebookPoster/FacebookPosterCoordinator';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const params = (): StartParams => ({ kind: 'scan_groups', profileIds: ['p1'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 });
function harness() {
  const db = new Database(':memory:');
  const sql: SqlDatabase = {
    exec: s => { db.exec(s); }, run: (s, p = []) => { db.prepare(s).run(...p); },
    runInsert: (s, p = []) => Number(db.prepare(s).run(...p).lastInsertRowid),
    query: (s, p = []) => [...db.prepare(s).all(...p)] as any,
    queryOne: (s, p = []) => db.prepare(s).get(...p) as any, transaction: fn => db.transaction(fn)(),
  };
  const store = new FacebookPosterStore(sql); store.ensureSchema();
  const gates = new Map<string, () => void>();
  let sequence = 0;
  const createWorker = (runId: string) => new FacebookPosterService({
    store, newId: () => runId, now: () => 100, getProfile: id => ({ id, name: id }), emit: () => {},
    acquireProfile: async profileId => ({ profileId, release: () => {}, open: async () => { throw new Error('unused'); } }),
    tasks: { scanGroups: async () => { await new Promise<void>(resolve => gates.set(runId, resolve)); return { groups: [], complete: true } as any; } },
  });
  const coordinator = new FacebookPosterCoordinator({ store, createWorker, newId: () => `run-${String.fromCharCode(97 + sequence++)}` });
  return { coordinator, store, gates, createWorker, close: () => db.close() };
}

test('two independent live runs, third rejected without persistence; cancellation selects exactly one', async () => {
  const h = harness();
  h.coordinator.start(params()); h.coordinator.start(params()); await tick();
  expect(h.coordinator.active().map(x => x.run.id)).toEqual(['run-a', 'run-b']);
  expect(() => h.coordinator.start(params())).toThrow(BUSY_ERROR);
  expect(h.store.listRuns({ limit: 10, offset: 0 }).runs).toHaveLength(2);
  expect(() => h.coordinator.cancel()).toThrow(PosterRunSelectionError);
  expect(h.coordinator.cancel('run-a')).toBe(true);
  expect(h.coordinator.active().some(x => x.run.id === 'run-b')).toBe(true);
  h.gates.get('run-a')!(); await tick();
  expect(h.coordinator.cancel('run-a')).toBe(false);
  expect(() => h.coordinator.cancel('missing')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  h.gates.get('run-b')!(); await h.coordinator.whenIdle();
  expect(h.coordinator.cancel()).toBe(false); expect(h.coordinator.hasCapacity()).toBe(true); h.close();
});

test('retirement rejects live ownership and cannot be undone by a retained coordinator reference', async () => {
  const h = harness(); h.coordinator.start(params()); await tick();
  let error: unknown;
  try { h.coordinator.retire(); } catch (caught) { error = caught; }
  h.gates.get('run-a')!(); await h.coordinator.whenIdle();
  try {
    expect(error).toEqual(new Error(BUSY_ERROR));
    h.coordinator.retire(); h.coordinator.resume();
    expect(h.coordinator.hasCapacity()).toBe(false);
    expect(() => h.coordinator.start(params())).toThrow(BUSY_ERROR);
    expect(h.store.listRuns({ limit: 10, offset: 0 }).total).toBe(1);
  } finally { h.close(); }
});

test('duplicate-ID admission cleanup cannot delete the existing live entry', async () => {
  const h = harness(); const coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: h.createWorker, newId: () => 'same-id' });
  coordinator.start(params()); await tick();
  expect(() => coordinator.start(params())).toThrow('Lượt đã tồn tại');
  expect(coordinator.cancel('same-id')).toBe(true); expect(coordinator.active()).toHaveLength(1);
  h.gates.get('same-id')!(); await coordinator.whenIdle(); h.close();
});

test('current sorts equal start times by run ID and cancelAll settles both workers', async () => {
  const h = harness(); const ids = ['z-run', 'a-run'];
  const coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: h.createWorker, newId: () => ids.shift()! });
  coordinator.start(params()); coordinator.start(params()); await tick();
  expect(coordinator.current()!.run.id).toBe('a-run'); coordinator.cancelAll();
  for (const resolve of h.gates.values()) resolve(); await coordinator.whenIdle();
  expect(h.store.listRuns({ limit: 10, offset: 0 }).runs.map(run => run.status)).toEqual(['cancelled', 'cancelled']);
  expect(await coordinator.stopAndWait()).toBe(true); h.close();
});

test('nested targets and media remain captured after caller mutation', async () => {
  const h = harness(); const gate = new Promise<void>(resolve => h.gates.set('post', resolve));
  let seen: any;
  const coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: id => new FacebookPosterService({
    store: h.store, newId: () => id, getProfile: profileId => ({ id: profileId, name: profileId }), emit: () => {},
    acquireProfile: async profileId => { await gate; return { profileId, open: async () => { throw new Error('unused'); }, release: () => {} }; },
    tasks: { postToTargets: async (input: any) => { seen = input; return { posted: 0, failed: 0, results: [] }; } },
  }) });
  const input: StartParams = { kind: 'post', mode: 'group', text: 'body', mediaPaths: ['image.png'], comment: null,
    profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/1/'] }], minDelaySec: 0, maxDelaySec: 0, concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 };
  coordinator.start(input); input.mediaPaths[0] = 'changed.png'; input.profiles[0].targets.push('changed');
  h.gates.get('post')!(); await coordinator.whenIdle(); expect(seen.mediaPaths).toEqual(['image.png']); expect(seen.targets).toHaveLength(1); h.close();
});

test('guard failure frees admission before persistence and worker effects', () => {
  const h = harness();
  const coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: id => new FacebookPosterService({
    store: h.store, newId: () => id, getProfile: profileId => ({ id: profileId, name: profileId }), emit: () => {},
    assertCurrent: () => { throw new Error('stale'); }, acquireProfile: async () => { throw new Error('must not acquire'); },
  }) });
  expect(() => coordinator.start(params())).toThrow('stale'); expect(coordinator.hasCapacity()).toBe(true);
  expect(h.store.listRuns({ limit: 10, offset: 0 }).total).toBe(0); h.close();
});

test('failed createRun frees admission but preserves any persisted effect', () => {
  const h = harness(); const original = h.store.createRun.bind(h.store);
  jest.spyOn(h.store, 'createRun').mockImplementation(row => { original(row); throw new Error('after insert'); });
  expect(() => h.coordinator.start(params())).toThrow('after insert');
  expect(h.coordinator.isBusy()).toBe(false); expect(h.store.listRuns({ limit: 10, offset: 0 }).total).toBe(1); h.close();
});

test('instant completion releases slots before notifying observers that start another run', async () => {
  const h = harness(); let sequence = 0; let coordinator: FacebookPosterCoordinator;
  coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: h.createWorker, newId: () => `instant-${++sequence}`,
    onChanged: () => { if (!coordinator.isBusy() && sequence === 1) coordinator.start({ ...params(), profileIds: [] } as StartParams); },
  });
  coordinator.start({ ...params(), profileIds: [] } as StartParams); await coordinator.whenIdle();
  expect(sequence).toBe(2); expect(coordinator.active()).toEqual([]); h.close();
});

test('shutdown cannot report idle when a completion observer admits another run', async () => {
  const h = harness(); let sequence = 0; let coordinator: FacebookPosterCoordinator;
  coordinator = new FacebookPosterCoordinator({ store: h.store, createWorker: h.createWorker, newId: () => `shutdown-${++sequence}`,
    onChanged: () => { if (!coordinator.isBusy() && sequence === 1) coordinator.start(params()); },
  });
  coordinator.start(params()); await tick(); const stopped = coordinator.stopAndWait();
  h.gates.get('shutdown-1')!();
  expect(await stopped).toBe(false);
  await tick(); h.gates.get('shutdown-2')!(); await coordinator.whenIdle(); h.close();
});

test('shutdown applies one shared grace and force budget to two workers', async () => {
  const h = harness(); h.coordinator.start(params()); h.coordinator.start(params()); await tick();
  jest.useFakeTimers();
  try {
    const stopped = h.coordinator.stopAndWait(45, 10);
    await jest.advanceTimersByTimeAsync(55);
    expect(await stopped).toBe(false);
    for (const resolve of h.gates.values()) resolve(); await h.coordinator.whenIdle();
  } finally { jest.useRealTimers(); h.close(); }
});

test('snapshots nested inputs and returns isolated active snapshots', async () => {
  const h = harness(); const input = params(); h.coordinator.start(input);
  (input as any).profileIds.push('mutated');
  const snapshot = h.coordinator.current()!; (snapshot.run.params as any).profileIds.push('mutated-again');
  expect(h.coordinator.current()!.run.params.profileIds).toEqual(['p1']);
  await tick(); h.gates.get('run-a')!(); await h.coordinator.whenIdle(); h.close();
});

test('reserves admission before factories and releases failed admission', async () => {
  const h = harness(); let count = 0; let coordinator: FacebookPosterCoordinator;
  coordinator = new FacebookPosterCoordinator({ store: h.store, newId: () => `nested-${++count}`, createWorker: id => {
    if (count === 1) coordinator.start(params());
    else expect(() => coordinator.start(params())).toThrow(BUSY_ERROR);
    return h.createWorker(id);
  } });
  coordinator.start(params()); await tick(); expect(coordinator.active()).toHaveLength(2);
  for (const resolve of h.gates.values()) resolve(); await coordinator.whenIdle();
  const failing = new FacebookPosterCoordinator({ store: h.store, createWorker: () => { throw new Error('factory'); } });
  expect(() => failing.start(params())).toThrow('factory'); expect(failing.hasCapacity()).toBe(true);
  failing.pause(); expect(() => failing.start(params())).toThrow(BUSY_ERROR); failing.resume(); expect(failing.hasCapacity()).toBe(true); h.close();
});
