import { planScheduleUpdate, LEAD_ERROR, DRAFT_ENABLE_ERROR } from '../../services/facebookPoster/scheduleUpdate';
import type { FbPosterSchedule } from '../../models/facebookPoster';

const NOW = new Date(2026, 9, 7, 10, 0, 0).getTime(); // Wed 2026-10-07 10:00 local
const base: FbPosterSchedule = {
    id: 's1', name: 'old', kind: 'recurring', params: {}, runAt: null, days: [0, 1, 2, 3, 4, 5, 6], time: '09:00',
    enabled: true, draft: false, nextRunAt: NOW - 1000, lastRunId: null, createdAt: 0, updatedAt: 0,
};
const once: FbPosterSchedule = { ...base, kind: 'once', runAt: NOW - 5000, days: [], time: '', nextRunAt: null };

describe('planScheduleUpdate', () => {
    it('renaming a fired one-time schedule writes only the name', () => {
        expect(planScheduleUpdate(once, { name: ' new ' }, NOW)).toEqual({ name: 'new' });
    });
    it('renaming a due recurring schedule leaves nextRunAt alone', () => {
        const f = planScheduleUpdate(base, { name: 'x' }, NOW);
        expect(f).toEqual({ name: 'x' });
        expect('nextRunAt' in f).toBe(false);
    });
    it('disabling clears nextRunAt', () => {
        expect(planScheduleUpdate(base, { enabled: false }, NOW)).toEqual({ enabled: false, nextRunAt: null });
    });
    it('enabling a recurring schedule sets the next occurrence', () => {
        const f = planScheduleUpdate({ ...base, enabled: false, nextRunAt: null }, { enabled: true }, NOW);
        expect(f.nextRunAt).toBe(new Date(2026, 9, 8, 9, 0, 0).getTime());
    });
    it('enabling an expired one-time schedule throws', () => {
        expect(() => planScheduleUpdate({ ...once, enabled: false }, { enabled: true }, NOW)).toThrow(LEAD_ERROR);
    });
    it('a once runAt less than 1 minute ahead throws', () => {
        expect(() => planScheduleUpdate(once, { runAt: NOW + 30000 }, NOW)).toThrow(LEAD_ERROR);
    });
    it('a new once runAt is recomputed', () => {
        const at = NOW + 3600000;
        expect(planScheduleUpdate(once, { runAt: at }, NOW)).toMatchObject({ runAt: at, nextRunAt: at });
    });
    it('new days/time on a recurring schedule are recomputed', () => {
        const f = planScheduleUpdate(base, { days: [3], time: '11:30' }, NOW);
        expect(f).toMatchObject({ days: [3], time: '11:30', nextRunAt: new Date(2026, 9, 7, 11, 30, 0).getTime() });
    });
    it('an empty name throws', () => {
        expect(() => planScheduleUpdate(base, { name: '  ' }, NOW)).toThrow('Tên lịch không được để trống');
    });
    it('a draft cannot be enabled through scheduleUpdate', () => {
        expect(() => planScheduleUpdate({ ...once, draft: true, enabled: false, runAt: NOW + 3_600_000 }, { enabled: true }, NOW)).toThrow(DRAFT_ENABLE_ERROR);
    });
    it('a draft can move its planned time and stays disabled', () => {
        expect(planScheduleUpdate({ ...once, draft: true, enabled: false }, { runAt: NOW + 3_600_000 }, NOW)).toEqual({ runAt: NOW + 3_600_000, nextRunAt: null });
    });
});
