import { ControlError, createControlMethods, describe as describeMethods, toControlError, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { SCAN_NOT_FOUND_ERROR, UnknownProfilesError } from '../../services/research/researchOperationsLogic';
import { BUSY_ERROR, ENGINE_MISSING_ERROR } from '../../services/facebookPoster/FacebookPosterService';

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
        workspaceId: jest.fn((): string | null => 'ws1'),
    };
    const deps = {
        poster, events,
        listProfiles: jest.fn(() => [{ id: 'p1' }]),
        checkLogins: jest.fn((ids: string[] | null) => ({ checkId: 'c1', profileIds: ids ?? ['p1'] })),
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
        expect(await call('profiles.list')).toEqual({ profiles: [{ id: 'p1' }] });
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

    it('runs.get exposes errorCode and attempts', async () => {
        const { deps, call } = setup();
        const detail = { run: { id: 'r1' }, results: [{ outcome: 'failed', error: 'x', errorCode: 'submit_not_found', attempts: 3 }] };
        (deps.poster.getRun as jest.Mock).mockReturnValueOnce(detail);
        expect(await call('runs.get', { runId: 'r1' })).toEqual(detail);
    });

    it('profiles.scanGroups starts a scan_groups run passing only provided keys', async () => {
        const { deps, call } = setup();
        expect(await call('profiles.scanGroups', { profileIds: ['p1', 'p2'] })).toEqual({ runId: 'r1' });
        expect(deps.poster.start).toHaveBeenCalledWith({
            kind: 'scan_groups', params: { profileIds: ['p1', 'p2'] },
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
    ])('%s without confirm is refused and touches no dep (case %#)', async (name, params) => {
        const { deps, call } = setup();
        await expect(call(name, params)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
        allDepFns(deps).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });

    it('events.wait returns immediately when events exist, long-polls otherwise, and clamps timeout', async () => {
        const { deps, call } = setup();
        deps.events.listEventsAfter.mockReturnValueOnce([{ seq: 4 }]);
        expect(await call('events.wait', { after: 3, timeoutSec: 10 })).toEqual({ events: [{ seq: 4 }], workspaceId: 'ws1' });
        expect(deps.events.listEventsAfter).toHaveBeenCalledWith(3, 100);
        expect(deps.events.waitForEvent).not.toHaveBeenCalled();

        deps.events.listEventsAfter.mockReturnValueOnce([]).mockReturnValueOnce([{ seq: 9 }]);
        expect(await call('events.wait', { after: 8, timeoutSec: 99 })).toEqual({ events: [{ seq: 9 }], workspaceId: 'ws1' });
        expect(deps.events.waitForEvent).toHaveBeenCalledWith(8, 25_000, undefined);

        deps.events.waitForEvent.mockClear();
        await call('events.wait', { after: 0, timeoutSec: 0 });
        expect(deps.events.waitForEvent).not.toHaveBeenCalled();
        deps.events.workspaceId.mockReturnValue(null);
        expect(await call('events.wait', { after: 0 })).toEqual({ events: [], workspaceId: null });
        await expect(call('events.wait', { after: -1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('schedules.delete validates id and returns NOT_FOUND for unknown schedule', async () => {
        const { deps, call } = setup();
        await expect(call('schedules.delete', { confirm: true })).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'id' } });
        await expect(call('schedules.delete', { id: 'zzz', confirm: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(deps.poster.scheduleDelete).not.toHaveBeenCalled();
    });

    it('drafts.delete and drafts.update on a non-draft do not write', async () => {
        const { deps, call } = setup();
        deps.poster.draftGet.mockImplementation(() => { throw new Error('Không tìm thấy bản nháp'); });
        await expect(call('drafts.delete', { id: 's1', confirm: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(call('drafts.update', { id: 's1', text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(deps.poster.scheduleDelete).not.toHaveBeenCalled();
        expect(deps.poster.draftSave).not.toHaveBeenCalled();
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
        expect(toControlError(new Error(ENGINE_MISSING_ERROR)).code).toBe('ENGINE_MISSING');
        // Cùng chuỗi với WORKSPACE_SWITCHING_ERROR của facebookPosterIpc/researchIpc.
        expect(toControlError(new Error('Đang đổi workspace, thử lại sau')).code).toBe('BUSY');
        expect(toControlError(new Error('Tối đa 200 lịch cho một workspace')).code).toBe('LIMIT_REACHED');
        for (const m of ['Không tìm thấy lịch', 'Không tìm thấy bản nháp', 'Không tìm thấy lần chạy']) {
            expect(toControlError(new Error(m)).code).toBe('NOT_FOUND');
        }
        expect(toControlError(new Error('Tối đa 50 lịch cho một workspace')).code).toBe('LIMIT_REACHED');
    });

    it('keeps validation messages about profile or file as INVALID_PARAMS', () => {
        expect(toControlError(new Error('Không tìm thấy profile')).code).toBe('INVALID_PARAMS');
        expect(toControlError(new Error('Không tìm thấy tệp ảnh/video')).code).toBe('INVALID_PARAMS');
    });

    it('maps unexpected failures to INTERNAL without leaking the raw message', () => {
        const cases = [new TypeError('x is undefined'), Object.assign(new Error("EPERM: open '/home/u/secret'"), { code: 'EPERM' }), 'boom', null];
        for (const c of cases) {
            const e = toControlError(c);
            expect(e.code).toBe('INTERNAL');
            expect(e.message).toBe('Lỗi nội bộ của MaiHub, thử lại sau');
        }
    });

    it('falls back to INVALID_PARAMS keeping the original message', () => {
        const err = toControlError(new Error('Nội dung bài không được để trống'));
        expect(err).toMatchObject({ code: 'INVALID_PARAMS', message: 'Nội dung bài không được để trống' });
    });
});

describe('describe', () => {
    it('lists every method with schemas and never exposes native-dialog or UI-only operations', () => {
        const { methods } = setup();
        const d = describeMethods(methods);
        expect(d.protocol).toBe(1);
        expect(d.methods.map((m) => m.name)).toEqual([
            'system.status', 'profiles.list', 'profiles.groups', 'profiles.scanGroups', 'profiles.check',
            'drafts.list', 'drafts.get', 'drafts.create', 'drafts.update', 'drafts.delete', 'drafts.approve',
            'schedules.list', 'schedules.update', 'schedules.delete',
            'runs.current', 'runs.list', 'runs.get', 'runs.cancel', 'events.wait',
            'research.search', 'research.scanGroupFeeds', 'research.list', 'research.get', 'research.cancel',
            'posts.track', 'posts.trackStatus', 'posts.trackCancel', 'posts.list', 'posts.stats', 'posts.trackConfig',
        ]);
        for (const m of d.methods) {
            expect(m.description).toMatch(/\S/);
            expect(m.paramsSchema).toMatchObject({ type: 'object' });
            expect(m.resultSchema).toMatchObject({ type: 'object' });
        }
        const flags = Object.fromEntries(d.methods.map((m) => [m.name, m.destructive]));
        expect(flags['drafts.delete'] && flags['schedules.delete'] && flags['runs.cancel'] && flags['drafts.approve']).toBe(true);
        expect(flags['drafts.create']).toBe(false);
        const byName = Object.fromEntries(d.methods.map((m: any) => [m.name, m]));
        expect(byName['drafts.approve'].destructiveWhen).toEqual({ when: 'now' });
        expect(byName['drafts.delete'].destructiveWhen).toBeUndefined();
        expect(byName['drafts.create'].paramsSchema.properties.plannedAt.type).toEqual(['integer', 'null']);
        expect(byName['drafts.approve'].paramsSchema.properties.when.anyOf).toHaveLength(2);
        expect(byName['drafts.create'].paramsSchema.properties.name.maxLength).toBe(100);
        const text = JSON.stringify(d);
        for (const banned of ['pickMedia', 'exportRunCsv', 'takeMissed']) expect(text).not.toContain(banned);
    });
});

describe('profiles.check', () => {
    const setupTwo = () => {
        const base = setup();
        base.deps.listProfiles.mockReturnValue([{ id: 'p1' }, { id: 'p2' }]);
        return base;
    };
    it('profiles.check: starts and returns checkId', async () => {
        const { deps, call } = setupTwo();
        expect(await call('profiles.check', { profileIds: ['p1', 'p1', 'p2'] })).toEqual({ checkId: 'c1', profileIds: ['p1', 'p2'] });
        expect(deps.checkLogins).toHaveBeenLastCalledWith(['p1', 'p2']);
        await call('profiles.check', {});
        expect(deps.checkLogins).toHaveBeenLastCalledWith(null);
    });
    it('empty profileIds → INVALID_PARAMS (absent means all)', async () => {
        const { deps, call } = setupTwo();
        expect(await call('profiles.check', { profileIds: [] }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'profileIds' } });
        expect(deps.checkLogins).not.toHaveBeenCalled();
    });
    it('missing ids → NOT_FOUND with details.missing', async () => {
        const { deps, call } = setupTwo();
        const err = await call('profiles.check', { profileIds: ['p1', 'zz'] }).catch((e) => e);
        expect(err).toMatchObject({ code: 'NOT_FOUND', details: { missing: ['zz'] } });
        expect(deps.checkLogins).not.toHaveBeenCalled();
    });
    it('>50 ids → INVALID_PARAMS', async () => {
        const { deps, call } = setupTwo();
        const ids = Array.from({ length: 51 }, (_, i) => `p${i}`);
        expect(await call('profiles.check', { profileIds: ids }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'profileIds' } });
        expect(await call('profiles.check', { profileIds: [''] }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'profileIds' } });
        expect(await call('profiles.check', { profileIds: 'p1' }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'profileIds' } });
        expect(deps.checkLogins).not.toHaveBeenCalled();
    });
    it('BUSY mapped', async () => {
        const { deps, call } = setupTwo();
        deps.checkLogins.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
        const err = await call('profiles.check', {}).catch((e) => toControlError(e));
        expect(err).toMatchObject({ code: 'BUSY' });
    });
    it('describe lists profiles.check', () => {
        const { methods } = setupTwo();
        const m = describeMethods(methods).methods.find((x) => x.name === 'profiles.check') as any;
        expect(m.destructive).toBe(false);
        expect(m.paramsSchema.properties.profileIds.maxItems).toBe(50);
    });
});

describe('research methods', () => {
    function setupResearch() {
        const research = {
            search: jest.fn((_p: any): any => ({ scanId: 's1' })),
            scanGroupFeeds: jest.fn((_p: any): any => ({ scanId: 's2' })),
            list: jest.fn((_p?: any): any => ({ total: 0, scans: [] })),
            get: jest.fn((_p: any): any => ({ scan: { id: 's1' }, total: 0, items: [] })),
            cancel: jest.fn((): any => ({ cancelled: true })),
        };
        const deps = { ...makeDeps(), research };
        const methods = createControlMethods(deps as unknown as ControlMethodDeps);
        const call = (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {});
        return { research, methods, call };
    }

    it('passes params through to the research port', async () => {
        const { research, call } = setupResearch();
        const search = { source: 'posts', query: 'kem', limit: 10, profileIds: ['p1'] };
        expect(await call('research.search', search)).toEqual({ scanId: 's1' });
        expect(research.search).toHaveBeenCalledWith(search);
        const feeds = { groupUrls: ['https://facebook.com/groups/1'], sinceDays: 3 };
        expect(await call('research.scanGroupFeeds', feeds)).toEqual({ scanId: 's2' });
        expect(research.scanGroupFeeds).toHaveBeenCalledWith(feeds);
        await call('research.list', { limit: 5, source: 'groups' });
        expect(research.list).toHaveBeenCalledWith({ limit: 5, source: 'groups' });
        await call('research.get', { scanId: 's1', sort: 'recent' });
        expect(research.get).toHaveBeenCalledWith({ scanId: 's1', sort: 'recent' });
        expect(await call('research.cancel')).toEqual({ cancelled: true });
    });

    it('maps unknown scanId, unknown profiles, empty profileIds and BUSY', async () => {
        const { research, call } = setupResearch();
        research.get.mockImplementationOnce(() => { throw new Error(SCAN_NOT_FOUND_ERROR); });
        expect(await call('research.get', { scanId: 'x' }).catch((e) => e)).toMatchObject({ code: 'NOT_FOUND' });
        research.search.mockImplementationOnce(() => { throw new UnknownProfilesError(['zz']); });
        expect(await call('research.search', { profileIds: ['zz'] }).catch((e) => e)).toMatchObject({ code: 'NOT_FOUND', details: { missing: ['zz'] } });
        research.search.mockImplementationOnce(() => { throw new Error('profileIds không được rỗng'); });
        expect(await call('research.search', { profileIds: [] }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        research.scanGroupFeeds.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
        expect(await call('research.scanGroupFeeds', {}).catch((e) => e)).toMatchObject({ code: 'BUSY' });
    });

    it('describes the five methods as non-destructive with rotation notes', () => {
        const { methods } = setupResearch();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('research.')) as any[];
        expect(found).toHaveLength(5);
        for (const m of found) expect(m.destructive).toBe(false);
        expect(found[0].description).toMatch(/research\.finished/);
        expect(found[0].paramsSchema.properties.profileIds.maxItems).toBe(50);
    });
});

describe('posts tracking methods', () => {
    function setupTracking() {
        const tracking = {
            track: jest.fn((_p: any): any => ({ jobId: 'j1', pairs: [] })),
            status: jest.fn((): any => ({ running: false, jobId: null, progress: { done: 0, total: 0 }, last: null })),
            cancel: jest.fn((): any => ({ cancelled: true })),
            list: jest.fn((_p?: any): any => ({ total: 0, rows: [] })),
            stats: jest.fn((_p: any): any => ({ rows: [] })),
            getConfig: jest.fn((): any => ({ config: { autoEnabled: true } })),
            setConfig: jest.fn((_p: any): any => ({ config: { autoEnabled: false } })),
        };
        const methods = createControlMethods({ ...makeDeps(), tracking } as unknown as ControlMethodDeps);
        const call = (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {});
        return { tracking, methods, call };
    }

    it('passes only documented params to the tracking port', async () => {
        const { tracking, call } = setupTracking();
        expect(await call('posts.track', { sinceDays: 3, groupUrls: ['g'], profileIds: ['p1'], extra: 1 })).toEqual({ jobId: 'j1', pairs: [] });
        expect(tracking.track).toHaveBeenCalledWith({ sinceDays: 3, groupUrls: ['g'], profileIds: ['p1'] });
        await call('posts.trackStatus');
        expect(tracking.status).toHaveBeenCalled();
        expect(await call('posts.trackCancel')).toEqual({ cancelled: true });
        await call('posts.list', { limit: 5, linkStatus: 'missing', junk: 1 });
        expect(tracking.list).toHaveBeenCalledWith({ limit: 5, linkStatus: 'missing' });
        await call('posts.stats', { groupBy: 'group', from: 1, to: 2 });
        expect(tracking.stats).toHaveBeenCalledWith({ groupBy: 'group', from: 1, to: 2 });
    });

    it('posts.trackConfig reads without config and saves with config', async () => {
        const { tracking, call } = setupTracking();
        expect(await call('posts.trackConfig')).toEqual({ config: { autoEnabled: true } });
        expect(tracking.setConfig).not.toHaveBeenCalled();
        const config = { autoEnabled: false, linkRetryMinutes: [30], statsAtMinutes: [60] };
        expect(await call('posts.trackConfig', { config })).toEqual({ config: { autoEnabled: false } });
        expect(tracking.setConfig).toHaveBeenCalledWith(config);
    });

    it('maps BUSY, unknown profiles and invalid params', async () => {
        const { tracking, call } = setupTracking();
        tracking.track.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
        expect(await call('posts.track', {}).catch((e) => e)).toMatchObject({ code: 'BUSY' });
        tracking.track.mockImplementationOnce(() => { throw new UnknownProfilesError(['zz']); });
        expect(await call('posts.track', { profileIds: ['zz'] }).catch((e) => e)).toMatchObject({ code: 'NOT_FOUND', details: { missing: ['zz'] } });
        tracking.track.mockImplementationOnce(() => { throw new Error('sinceDays phải là số nguyên từ 1 đến 30'); });
        expect(await call('posts.track', { sinceDays: 0 }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        tracking.setConfig.mockImplementationOnce(() => { throw new Error('config không hợp lệ'); });
        expect(await call('posts.trackConfig', { config: {} }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('describes the six methods as non-destructive', () => {
        const { methods } = setupTracking();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('posts.')) as any[];
        expect(found).toHaveLength(6);
        for (const m of found) expect(m.destructive).toBe(false);
        expect(found[0].description).toMatch(/posts\.trackFinished/);
    });
});
