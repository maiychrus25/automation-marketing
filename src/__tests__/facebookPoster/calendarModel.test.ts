process.env.TZ = 'Asia/Ho_Chi_Minh';
import { getCalendarDays, getScheduleOccurrences, buildMovePatch, canDragSchedule, matchesChannels, getUnscheduledDrafts } from '../../ui/features/facebookPoster/calendarModel';
import type { FbPosterScheduleView } from '../../models/facebookPoster';

const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const schedule = (patch: Partial<FbPosterScheduleView> = {}): FbPosterScheduleView => ({
  id: 's1', name: 'Scheduled post', kind: 'once', params: { profiles: [{ profileId: 'p1', targets: [] }] },
  runAt: at(12, 9), days: [], time: '', enabled: true, draft: false, nextRunAt: at(12, 9), lastRunId: null,
  createdAt: at(1), updatedAt: at(1), lastRun: null, ...patch,
});

describe('poster calendar', () => {
  it('starts the week on Monday and does not mutate the anchor', () => {
    const anchor = new Date(at(10, 14));
    const days = getCalendarDays(anchor, 'week');
    expect(days.map(d => d.getDate())).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(anchor.getTime()).toBe(at(10, 14));
    expect(getCalendarDays(anchor, 'day')).toHaveLength(1);
  });
  it('covers a full month with whole Monday-based weeks across the year boundary', () => {
    const days = getCalendarDays(new Date(2027, 0, 15), 'month');
    expect(days[0].getDay()).toBe(1);
    expect(days[0].getFullYear()).toBe(2026);
    expect(days[days.length - 1].getDay()).toBe(0);
    expect(days.filter(d => d.getMonth() === 0 && d.getFullYear() === 2027)).toHaveLength(31);
  });
  it('filters a multi-profile post by any matching channel and keeps paused once posts', () => {
    const days = getCalendarDays(new Date(at(12)), 'week');
    const s = schedule({ enabled: false, nextRunAt: null });
    expect(getScheduleOccurrences([s], days, ['p1'], at(10))).toHaveLength(1);
    expect(getScheduleOccurrences([s], days, [], at(10))).toHaveLength(0);
    expect(getScheduleOccurrences([s], days, ['p2'], at(10))).toHaveLength(0);
    expect(getScheduleOccurrences([s], days, null, at(10))).toHaveLength(1);
  });
  it('projects recurring future posts without inventing historical runs', () => {
    const days = getCalendarDays(new Date(at(12)), 'week');
    const s = schedule({ kind: 'recurring', runAt: null, days: [1, 3, 5], time: '09:30', nextRunAt: at(14, 9, 30),
      lastRun: { status: 'done', startedAt: at(12, 9, 32), error: '' } });
    const entries = getScheduleOccurrences([s], days, null, at(13));
    expect(entries.map(e => e.at)).toEqual([at(12, 9, 32), at(14, 9, 30), at(16, 9, 30)]);
    expect(entries[0].historical).toBe(true);
  });
  it('moves once posts by runAt only', () => {
    expect(buildMovePatch(schedule(), at(13, 11, 30))).toEqual({ id: 's1', runAt: at(13, 11, 30) });
  });

  it('only once posts are draggable: a recurring series shares one time, so moving one occurrence would silently move or drop the others', () => {
    expect(canDragSchedule(schedule())).toBe(true);
    expect(canDragSchedule(schedule({ kind: 'recurring', runAt: null, days: [1, 3, 5], time: '09:00' }))).toBe(false);
  });

  it('handles one thousand recurring schedules and channel filters across six weeks', () => {
    const days = getCalendarDays(new Date(2026, 7, 15), 'month');
    const schedules = Array.from({ length: 1000 }, (_, index) => schedule({ id: `s${index}`, kind: 'recurring', runAt: null,
      days: [0, 1, 2, 3, 4, 5, 6], time: '23:59', nextRunAt: new Date(2026, 7, 1).getTime(), createdAt: new Date(2026, 6, 1).getTime(),
      params: { profiles: [{ profileId: index % 2 ? 'p1' : 'p2' }] } }));
    const entries = getScheduleOccurrences(schedules, days, ['p1'], new Date(2026, 7, 1).getTime());
    expect(entries.length).toBe(days.filter(day => day.getTime() >= new Date(2026, 7, 1).getTime()).length * 500);
    expect(entries.every((entry, index) => !index || entries[index - 1].at <= entry.at)).toBe(true);
  });
  it('ignores invalid recurring times and retains a recorded run without fabricating another', () => {
    const days = getCalendarDays(new Date(at(12)), 'week');
    expect(getScheduleOccurrences([schedule({ kind: 'recurring', runAt: null, days: [1], time: '25:00' })], days, null, at(10))).toEqual([]);
    expect(getScheduleOccurrences([schedule({ kind: 'once', nextRunAt: null, lastRun: { status: 'done', startedAt: at(12, 9), error: '' } })], days, null, at(13))[0].historical).toBe(true);
  });
  it('keeps the queued occurrence distinct from the next recurring projection', () => {
    const s = schedule({ kind: 'recurring', runAt: null, days: [1], time: '09:00', nextRunAt: at(19, 9) });
    const current = getScheduleOccurrences([s], getCalendarDays(new Date(at(12)), 'week'), null, at(12, 9, 1), new Set(['s1']));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ at: at(12, 9), queued: true, historical: false });
    const future = getScheduleOccurrences([s], getCalendarDays(new Date(at(19)), 'week'), null, at(12, 9, 1), new Set(['s1']));
    expect(future).toHaveLength(1);
    expect(future[0].queued).toBeFalsy();
  });

  it('drafts without a profile stay visible under a channel filter; unscheduled drafts are listed separately', () => {
    const planned = schedule({ id: 'p', draft: true, enabled: false, nextRunAt: null, runAt: at(13, 9), params: { profiles: [] } });
    const loose = schedule({ id: 'u', draft: true, enabled: false, nextRunAt: null, runAt: null, params: { profiles: [] } });
    const other = schedule({ id: 'o', params: { profiles: [{ profileId: 'pX', targets: [] }] } });
    const days = getCalendarDays(new Date(at(13)), 'week');
    expect(getScheduleOccurrences([planned, loose, other], days, ['p1'], at(12)).map((e) => e.schedule.id)).toEqual(['p']);
    expect(getUnscheduledDrafts([planned, loose, other], ['p1']).map((s) => s.id)).toEqual(['u']);
    expect(matchesChannels(other, ['p1'])).toBe(false);
    expect(matchesChannels(other, null)).toBe(true);
  });
});
