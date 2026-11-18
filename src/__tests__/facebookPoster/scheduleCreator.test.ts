import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { memoryDb } from './helpers';

function makeStore() {
  const db = memoryDb();
  const store = new FacebookPosterStore(db);
  store.ensureSchema();
  return { db, store };
}

function add(store: FacebookPosterStore, id: string, over: { createdByEmployee?: string | null; enabled?: boolean; draft?: boolean; profiles?: string[] } = {}) {
  const enabled = over.enabled ?? true;
  const draft = over.draft ?? false;
  store.createSchedule({
    id, name: id, kind: 'once', params: { mode: 'group', text: 't', profiles: (over.profiles ?? ['P1']).map((profileId) => ({ profileId, targets: [] })) },
    runAt: 5000, days: [], time: '', enabled: enabled && !draft, nextRunAt: enabled && !draft ? 5000 : null, createdAt: 1, draft,
    createdByEmployee: over.createdByEmployee,
  });
}

test('createSchedule stores the creator and readers return it; absent reads as null', () => {
  const { store } = makeStore();
  add(store, 'a', { createdByEmployee: 'emp1' });
  add(store, 'b');
  expect(store.getSchedule('a')!.createdByEmployee).toBe('emp1');
  expect(store.getSchedule('b')!.createdByEmployee).toBeNull();
  expect(store.listSchedules().map((s) => [s.id, s.createdByEmployee]).sort()).toEqual([['a', 'emp1'], ['b', null]]);
  expect(store.listDueSchedules(10000).map((s) => [s.id, s.createdByEmployee]).sort()).toEqual([['a', 'emp1'], ['b', null]]);
});

test('migration: an old database gains the column and old rows read as null', () => {
  const { db, store } = makeStore();
  db.exec('ALTER TABLE fb_poster_schedules DROP COLUMN created_by_employee');
  db.run(`INSERT INTO fb_poster_schedules (id, name, kind, params_json, enabled, created_at, updated_at) VALUES ('old', 'old', 'once', '{}', 1, 1, 1)`);
  store.ensureSchema();
  expect(store.getSchedule('old')!.createdByEmployee).toBeNull();
});

describe('pauseSchedulesCreatedBy', () => {
  test('pauses only enabled non-draft schedules of that creator and returns their ids', () => {
    const { store } = makeStore();
    add(store, 'mine', { createdByEmployee: 'e1' });
    add(store, 'mine-off', { createdByEmployee: 'e1', enabled: false });
    add(store, 'mine-draft', { createdByEmployee: 'e1', draft: true });
    add(store, 'other', { createdByEmployee: 'e2' });
    add(store, 'boss');
    const before = store.getSchedule('mine')!;
    expect(store.pauseSchedulesCreatedBy('e1')).toEqual(['mine']);
    const after = store.getSchedule('mine')!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(after.revision).toBe(before.revision + 1);
    expect(store.getSchedule('mine-draft')!.draft).toBe(true);
    expect(store.getSchedule('other')!.enabled).toBe(true);
    expect(store.getSchedule('boss')!.enabled).toBe(true);
    expect(store.pauseSchedulesCreatedBy('e1')).toEqual([]);
  });

  test('profile filter: pauses when a stored profile is among the removed ones, otherwise leaves it', () => {
    const { store } = makeStore();
    add(store, 's', { createdByEmployee: 'e1', profiles: ['P1', 'P2'] });
    expect(store.pauseSchedulesCreatedBy('e1', ['P3'])).toEqual([]);
    expect(store.getSchedule('s')!.enabled).toBe(true);
    expect(store.pauseSchedulesCreatedBy('e1', ['P2'])).toEqual(['s']);
    expect(store.getSchedule('s')!.enabled).toBe(false);
  });
});
