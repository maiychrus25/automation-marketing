import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { FacebookPosterScheduler } from '../../services/facebookPoster/FacebookPosterScheduler';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { ControlEventRecorder } from '../../services/control/ControlEventRecorder';
import { buildScheduleMissed, emitControlEvent, hasControlEventSink, setControlEventSink } from '../../services/control/controlEvents';

afterEach(() => setControlEventSink(null));

function controlStore() {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  return new ControlStore(db);
}

describe('ControlEventRecorder', () => {
  test('sync() installs the sink only when enabled and not blocked', () => {
    const recorder = new ControlEventRecorder();
    const store = controlStore();
    recorder.sync(false, false, () => store);
    expect(hasControlEventSink()).toBe(false);
    recorder.sync(true, true, () => store);
    expect(hasControlEventSink()).toBe(false);
    recorder.sync(true, false, () => store);
    expect(hasControlEventSink()).toBe(true);
    emitControlEvent('run.started', { runId: 'r' });
    expect(store.listEventsAfter(0, 10).map((e) => e.type)).toEqual(['run.started']);
    recorder.sync(true, true, () => store);
    expect(hasControlEventSink()).toBe(false);
  });

  test('swapping to another store is atomic and a waiter is woken by new events', async () => {
    const recorder = new ControlEventRecorder();
    const a = controlStore();
    const b = controlStore();
    recorder.sync(true, false, () => a);
    const waiting = recorder.notifier.waitForEvent(0, 5000);
    recorder.sync(true, false, () => b);
    expect(hasControlEventSink()).toBe(true);
    emitControlEvent('draft.approved', { scheduleId: 's' });
    await waiting;
    expect(a.listEventsAfter(0, 10)).toHaveLength(0);
    expect(b.listEventsAfter(0, 10)).toHaveLength(1);
  });

  test('an overdue schedule fired by scheduler.start() right after sync() leaves a schedule.missed row', () => {
    const recorder = new ControlEventRecorder();
    const control = controlStore();
    recorder.sync(true, false, () => control); // before the scheduler starts, with no await in between
    const poster = new FacebookPosterStore(memoryDb());
    poster.ensureSchema();
    const T0 = new Date(2026, 9, 7, 12, 0, 0).getTime();
    poster.createSchedule({
      id: 'a', name: 'Lịch a', kind: 'once', params: { kind: 'post', mode: 'group' }, runAt: T0 - 300000, days: [], time: '',
      enabled: true, nextRunAt: T0 - 300000, createdAt: 1,
    } as Parameters<FacebookPosterStore['createSchedule']>[0]);
    new FacebookPosterScheduler({
      store: poster, now: () => T0, setTimer: () => 0, clearTimer: () => undefined, isBusy: () => false,
      resolveParams: () => ({ kind: 'post' }) as never, startRun: () => ({ runId: 'x' }), newId: () => 'gen',
      onMissed: (n) => emitControlEvent('schedule.missed', buildScheduleMissed(n)), onChanged: () => undefined,
    }).start();
    const rows = control.listEventsAfter(0, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'schedule.missed', payload: { scheduleId: 'a', name: 'Lịch a' } });
  });
});
