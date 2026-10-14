import { ControlError, createControlMethods, describe as describeMethods, toControlError, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';

const ENGINE_MISSING = 'Chưa cài trình duyệt. Hãy tải trình duyệt ở màn hình Trình duyệt.';

function makeDeps() {
    const poster = {
        start: jest.fn(() => ({ runId: 'r1' })),
        scheduleList: jest.fn(() => ({ schedules: [{ id: 's1', draft: false }, { id: 'd1', draft: true }, { id: 'd2', draft: true }], queuedIds: ['s1'] })),
        scheduleUpdate: jest.fn(() => ({ schedule: { id: 's1' } })),
        scheduleDelete: jest.fn(() => undefined),
        draftSave: jest.fn(() => ({ schedule: { id: 'd1' } })),
        draftGet: jest.fn(() => ({ draft: { id: 'd1', name: 'Nháp', params: { mode: 'group', text: 'cũ', mediaPaths: ['a.jpg'] } }, media: [{ path: '/m/a.jpg', size: 1 }] })),
        draftApprove: jest.fn(() => ({ schedule: { id: 'd1' } })),
        cancel: jest.fn(() => undefined),
        current: jest.fn(() => ({ run: null, progress: null })),
        listGroups: jest.fn(() => ({ groups: [] })),
        listRuns: jest.fn(() => ({ runs: [] })),
        getRun: jest.fn(() => ({ run: { id: 'r1' } })),
    };
    const events = {
        listEventsAfter: jest.fn((_seq: number, _limit: number): any[] => []),
        waitForEvent: jest.fn(async (_seq: number, _ms: number) => undefined),
    };
    const deps = {
        poster, events,
        listProfiles: jest.fn(() => [{ id: 'p1' }]),
        systemStatus: jest.fn(() => ({ version: '1' })),
        resolveMedia: jest.fn((ids: string[]) => ids.map((id) => `/inbox/${id}`)),
    };
    return deps;
}

function setup() {
    const deps = makeDeps();
    const methods = createControlMethods(deps as unknown as ControlMethodDeps);
    const call = (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {});
    return { deps, methods, call };
}

const allDepFns = (d: ReturnType<typeof makeDeps>) =>
    [...Object.values(d.poster), ...Object.values(d.events), d.listProfiles, d.systemStatus, d.resolveMedia];

describe('createControlMethods', () => {
    it('maps read methods to deps', async () => {
        const { deps, call } = setup();
        expect(await call('system.status')).toEqual({ version: '1' });
        expect(await call('profiles.list')).toEqual([{ id: 'p1' }]);
        await call('profiles.groups', { profileIds: ['p1'] });
        expect(deps.poster.listGroups).toHaveBeenCalledWith({ profileIds: ['p1'] });
        await call('runs.current');
        expect(deps.poster.current).toHaveBeenCalled();
        await call('runs.list', { limit: 5, offset: 2, kind: 'post', junk: 1 });
        expect(deps.poster.listRuns).toHaveBeenCalledWith({ limit: 5, offset: 2, kind: 'post' });
        await call('runs.get', { runId: 'r1' });
        expect(deps.poster.getRun).toHaveBeenCalledWith({ runId: 'r1' });
        await call('drafts.get', { id: 'd1' });
        expect(deps.poster.draftGet).toHaveBeenCalledWith({ id: 'd1' });
    });

    it('profiles.scanGroups starts a scan_groups run with defaults', async () => {
        const { deps, call } = setup();
        expect(await call('profiles.scanGroups', { profileIds: ['p1', 'p2'] })).toEqual({ runId: 'r1' });
        expect(deps.poster.start).toHaveBeenCalledWith({
            kind: 'scan_groups', params: { profileIds: ['p1', 'p2'], concurrency: 3, staggerMinSec: 30, staggerMaxSec: 90 },
        });
        await call('profiles.scanGroups', { profileIds: ['p1'], concurrency: 5, staggerMinSec: 0, staggerMaxSec: 0 });
        expect(deps.poster.start).toHaveBeenLastCalledWith({
            kind: 'scan_groups', params: { profileIds: ['p1'], concurrency: 5, staggerMinSec: 0, staggerMaxSec: 0 },
        });
    });

    it('drafts.list and schedules.list split drafts from real schedules', async () => {
        const { call } = setup();
        expect(await call('drafts.list', { limit: 1, offset: 1 })).toEqual({ total: 2, items: [{ id: 'd2', draft: true }] });
        expect(await call('schedules.list')).toEqual({ schedules: [{ id: 's1', draft: false }], queuedIds: ['s1'] });
    });

    it('drafts.create resolves mediaIds to mediaPaths and calls draftSave', async () => {
        const { deps, call } = setup();
        await call('drafts.create', { name: 'N', mode: 'group', text: 'Hi', mediaIds: ['m1'], profiles: [{ profileId: 'p1', targets: ['g'] }], junk: 1 });
        expect(deps.resolveMedia).toHaveBeenCalledWith(['m1']);
        expect(deps.poster.draftSave).toHaveBeenCalledWith({
            name: 'N', plannedAt: undefined,
            params: { mode: 'group', text: 'Hi', profiles: [{ profileId: 'p1', targets: ['g'] }], mediaPaths: ['/inbox/m1'] },
        });
    });

    it('drafts.create rejects unknown mediaId with field details', async () => {
        const { deps, call } = setup();
        deps.resolveMedia.mockReturnValueOnce([]);
        await expect(call('drafts.create', { mode: 'group', text: 'x', mediaIds: ['nope'] }))
            .rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'mediaIds' } });
        expect(deps.poster.draftSave).not.toHaveBeenCalled();
        await expect(call('drafts.create', { mode: 'group', text: 'x', mediaIds: 'bad' }))
            .rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'mediaIds' } });
    });

    it('drafts.update merges onto the current draft and keeps existing media unless mediaIds is sent', async () => {
        const { deps, call } = setup();
        await call('drafts.update', { id: 'd1', text: 'mới' });
        expect(deps.poster.draftSave).toHaveBeenCalledWith({
            id: 'd1', name: 'Nháp', plannedAt: undefined,
            params: { mode: 'group', text: 'mới', mediaPaths: ['/m/a.jpg'] },
        });
        await call('drafts.update', { id: 'd1', mediaIds: ['m2'], name: 'Mới' });
        expect(deps.poster.draftSave).toHaveBeenLastCalledWith({
            id: 'd1', name: 'Mới', plannedAt: undefined,
            params: { mode: 'group', text: 'cũ', mediaPaths: ['/inbox/m2'] },
        });
    });

    it('drafts.approve maps when to the app input shape', async () => {
        const { deps, call } = setup();
        await call('drafts.approve', { id: 'd1', when: 'now', confirm: true });
        expect(deps.poster.draftApprove).toHaveBeenLastCalledWith({ id: 'd1', when: 'now' });
        await call('drafts.approve', { id: 'd1', when: { kind: 'once', runAt: 123 } });
        expect(deps.poster.draftApprove).toHaveBeenLastCalledWith({ id: 'd1', when: 'schedule', kind: 'once', runAt: 123, days: undefined, time: undefined });
        await call('drafts.approve', { id: 'd1', when: { kind: 'recurring', days: [1], time: '09:00' } });
        expect(deps.poster.draftApprove).toHaveBeenLastCalledWith({ id: 'd1', when: 'schedule', kind: 'recurring', runAt: undefined, days: [1], time: '09:00' });
    });

    it('schedules.update forwards only known fields', async () => {
        const { deps, call } = setup();
        await call('schedules.update', { id: 's1', enabled: false, name: 'A', junk: 1 });
        expect(deps.poster.scheduleUpdate).toHaveBeenCalledWith({ id: 's1', enabled: false, name: 'A' });
    });

    it('destructive methods run with confirm: true', async () => {
        const { deps, call } = setup();
        await call('drafts.delete', { id: 'd1', confirm: true });
        expect(deps.poster.draftGet).toHaveBeenCalledWith({ id: 'd1' });
        expect(deps.poster.scheduleDelete).toHaveBeenCalledWith({ id: 'd1' });
        await call('schedules.delete', { id: 's1', confirm: true });
        expect(deps.poster.scheduleDelete).toHaveBeenLastCalledWith({ id: 's1' });
        await call('runs.cancel', { confirm: true });
        expect(deps.poster.cancel).toHaveBeenCalled();
    });

    it.each([
        ['drafts.delete', { id: 'd1' }],
        ['schedules.delete', { id: 's1' }],
        ['runs.cancel', {}],
        ['drafts.approve', { id: 'd1', when: 'now' }],
        ['drafts.approve', { id: 'd1', when: 'now', confirm: 'true' }],
    ])('%s without confirm is refused and touches no dep', async (name, params) => {
        const { deps, call } = setup();
        await expect(call(name, params)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
        allDepFns(deps).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });

    it('events.wait returns immediately when events exist, long-polls otherwise, and clamps timeout', async () => {
        const { deps, call } = setup();
        deps.events.listEventsAfter.mockReturnValueOnce([{ seq: 4 }]);
        expect(await call('events.wait', { after: 3, timeoutSec: 10 })).toEqual({ events: [{ seq: 4 }] });
        expect(deps.events.listEventsAfter).toHaveBeenCalledWith(3, 100);
        expect(deps.events.waitForEvent).not.toHaveBeenCalled();

        deps.events.listEventsAfter.mockReturnValueOnce([]).mockReturnValueOnce([{ seq: 9 }]);
        expect(await call('events.wait', { after: 8, timeoutSec: 99 })).toEqual({ events: [{ seq: 9 }] });
        expect(deps.events.waitForEvent).toHaveBeenCalledWith(8, 25_000);

        deps.events.waitForEvent.mockClear();
        await call('events.wait', { after: 0, timeoutSec: 0 });
        expect(deps.events.waitForEvent).not.toHaveBeenCalled();
        await expect(call('events.wait', { after: -1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('maps thrown errors to protocol codes', async () => {
        const { deps, call } = setup();
        deps.poster.start.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
        await expect(call('profiles.scanGroups', { profileIds: ['p'] })).rejects.toMatchObject({ code: 'BUSY' });
        deps.poster.draftGet.mockImplementationOnce(() => { throw new Error('Không tìm thấy bản nháp'); });
        await expect(call('drafts.get', { id: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('toControlError', () => {
    it('passes ControlError through and maps known messages', () => {
        const own = new ControlError('RATE_LIMITED', 'x');
        expect(toControlError(own)).toBe(own);
        expect(toControlError(new Error(BUSY_ERROR)).code).toBe('BUSY');
        expect(toControlError(new Error(`${BUSY_ERROR} khác`)).code).toBe('BUSY');
        expect(toControlError(new Error(ENGINE_MISSING)).code).toBe('ENGINE_MISSING');
        expect(toControlError(new Error('Tối đa 200 lịch cho một workspace')).code).toBe('LIMIT_REACHED');
        expect(toControlError(new Error('Không tìm thấy lịch')).code).toBe('NOT_FOUND');
    });

    it('falls back to INVALID_PARAMS keeping the original message', () => {
        const err = toControlError(new Error('Nội dung bài không được để trống'));
        expect(err).toMatchObject({ code: 'INVALID_PARAMS', message: 'Nội dung bài không được để trống' });
        expect(toControlError('boom').message).toBe('boom');
    });
});

describe('describe', () => {
    it('lists every method with schemas and never exposes native-dialog or UI-only operations', () => {
        const { methods } = setup();
        const d = describeMethods(methods);
        expect(d.protocol).toBe(1);
        expect(d.methods.map((m) => m.name)).toEqual([
            'system.status', 'profiles.list', 'profiles.groups', 'profiles.scanGroups',
            'drafts.list', 'drafts.get', 'drafts.create', 'drafts.update', 'drafts.delete', 'drafts.approve',
            'schedules.list', 'schedules.update', 'schedules.delete',
            'runs.current', 'runs.list', 'runs.get', 'runs.cancel', 'events.wait',
        ]);
        for (const m of d.methods) {
            expect(m.description).toMatch(/\S/);
            expect(m.paramsSchema).toMatchObject({ type: 'object' });
            expect(m.resultSchema).toMatchObject({ type: 'object' });
        }
        const flags = Object.fromEntries(d.methods.map((m) => [m.name, m.destructive]));
        expect(flags['drafts.delete'] && flags['schedules.delete'] && flags['runs.cancel'] && flags['drafts.approve']).toBe(true);
        expect(flags['drafts.create']).toBe(false);
        const text = JSON.stringify(d);
        for (const banned of ['pickMedia', 'exportRunCsv', 'takeMissed']) expect(text).not.toContain(banned);
    });
});
