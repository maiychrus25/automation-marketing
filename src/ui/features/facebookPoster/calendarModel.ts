import type { FbPosterScheduleView } from '../../../models/facebookPoster';

export type CalendarView = 'day' | 'week' | 'month';
export interface ScheduleOccurrence { schedule: FbPosterScheduleView; at: number; historical: boolean; queued?: boolean }

export function getCalendarDays(anchor: Date, view: CalendarView): Date[] {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), view === 'month' ? 1 : anchor.getDate());
  if (view !== 'day') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = view === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0) : new Date(start);
  end.setDate(end.getDate() + (view === 'week' ? 6 : view === 'month' ? (7 - end.getDay()) % 7 : 0));
  const days: Date[] = [];
  for (const date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) days.push(new Date(date));
  return days;
}

export function getScheduleOccurrences(
  schedules: FbPosterScheduleView[], days: Date[], selected: string[] | null, now: number, queued: ReadonlySet<string> = new Set(),
): ScheduleOccurrence[] {
  if (!days.length) return [];
  const start = days[0].getTime();
  const end = new Date(days[days.length - 1]);
  end.setDate(end.getDate() + 1);
  const entries: ScheduleOccurrence[] = [];
  const add = (schedule: FbPosterScheduleView, at: number | null, historical: boolean, pending = false) => {
    if (at !== null && at >= start && at < end.getTime()) entries.push({ schedule, at, historical, queued: pending });
  };
  for (const schedule of schedules) {
    const profiles = (schedule.params.profiles ?? []) as { profileId: string }[];
    if (selected !== null && !profiles.some(p => selected.includes(p.profileId))) continue;
    if (schedule.kind === 'once') {
      add(schedule, schedule.runAt, !!schedule.lastRun && schedule.nextRunAt === null && !queued.has(schedule.id), queued.has(schedule.id));
      continue;
    }
    if (schedule.lastRun) add(schedule, schedule.lastRun.startedAt, true);
    const [hour, minute] = schedule.time.split(':').map(Number);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    // The scheduler advances nextRunAt on enqueue; the pending occurrence is the most recent due slot.
    if (queued.has(schedule.id)) {
      for (let offset = 0; offset <= 7; offset++) {
        const date = new Date(now);
        date.setDate(date.getDate() - offset);
        date.setHours(hour, minute, 0, 0);
        if (date.getTime() <= now && date.getTime() >= schedule.createdAt && schedule.days.includes(date.getDay())) {
          add(schedule, date.getTime(), false, true);
          break;
        }
      }
    }
    for (const day of days) {
      if (!schedule.days.includes(day.getDay())) continue;
      const at = new Date(day);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() >= Math.max(now, schedule.createdAt, schedule.nextRunAt ?? now)) add(schedule, at.getTime(), false);
    }
  }
  return entries.sort((a, b) => a.at - b.at);
}

/**
 * Only one-off posts can be dragged. A recurring series stores one shared time for all its days,
 * so moving a single occurrence would silently move the other days too (or drop one if the target
 * day is already in the series). Recurring times are changed through "Sửa giờ" instead.
 */
export function canDragSchedule(schedule: FbPosterScheduleView): boolean {
  return schedule.kind === 'once';
}

export function buildMovePatch(schedule: FbPosterScheduleView, target: number) {
  return { id: schedule.id, runAt: target };
}
