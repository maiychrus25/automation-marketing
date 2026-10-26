import { ControlError, createControlMethods, describe as describeMethods, toControlError, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { SCAN_NOT_FOUND_ERROR, UnknownProfilesError } from '../../services/research/researchOperationsLogic';
import { RenderError } from '../../services/video/RenderClient';
import { BUSY_ERROR, ENGINE_MISSING_ERROR } from '../../services/facebookPoster/FacebookPosterService';

function makeDeps() {
    const poster = {
        start: jest.fn(() => ({ runId: 'r1' })),
        scheduleList: jest.fn(() => ({ schedules: [{ id: 's1', draft: false }, { id: 'd1', draft: true }, { id: 'd2', draft: true }], queuedIds: ['s1'] })),
        scheduleUpdate: jest.fn(() => ({ schedule: { id: 's1' } })),
        scheduleDelete: jest.fn(() => undefined),
        draftSave: jest.fn((_input?: any): any => ({ schedule: { id: 'd1' } })),
        draftGet: jest.fn(() => ({ draft: { id: 'd1', name: 'Nháp', params: { mode: 'group', text: 'cũ', mediaPaths: ['a.jpg'] } }, media: [{ path: '/m/a.jpg', size: 1 }] })),
        draftApprove: jest.fn((_input?: any): any => ({ schedule: { id: 'd1' } })),
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
        lastSeq: jest.fn((): number => 42),
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
        const before = Date.now();
        const status: any = await call('system.status');
        const after = Date.now();
        expect(status).toMatchObject({ version: '1', lastEventSeq: 42, utcOffsetMin: -new Date().getTimezoneOffset() });
        expect(typeof status.timezone).toBe('string');
        expect(status.timezone).not.toBe('');
        expect(status.serverNowMs).toBeGreaterThanOrEqual(before);
        expect(status.serverNowMs).toBeLessThanOrEqual(after);
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
            'research.search', 'research.scanGroupFeeds', 'research.list', 'research.get', 'research.trending', 'research.cancel',
            'posts.track', 'posts.trackStatus', 'posts.trackCancel', 'posts.list', 'posts.stats', 'posts.groupScores', 'posts.bestTimes', 'posts.trackConfig',
            'campaigns.list', 'campaigns.get', 'campaigns.create', 'campaigns.update', 'campaigns.delete',
            'comments.collect', 'comments.collectStatus', 'comments.collectCancel', 'comments.list', 'leads.list', 'leads.update', 'leads.config',
            'videos.templates', 'videos.render', 'videos.status', 'videos.list', 'videos.cancel',
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
            trending: jest.fn((_p: any): any => ({ items: [{ fbId: 'hot', score: 100 }] })),
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
        const trending = { queries: ['Serum'], groupIds: ['g1'], sinceHours: 72, limit: 20 };
        expect(await call('research.trending', trending)).toEqual({ items: [{ fbId: 'hot', score: 100 }] });
        expect(research.trending).toHaveBeenCalledWith(trending);
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

    it('describes the six methods as non-destructive with rotation notes', () => {
        const { methods } = setupResearch();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('research.')) as any[];
        expect(found).toHaveLength(6);
        for (const m of found) expect(m.destructive).toBe(false);
        expect(found[0].description).toMatch(/research\.finished/);
        expect(found[0].paramsSchema.properties.profileIds.maxItems).toBe(50);
    });

    it('describes trending parameter limits and the items result', () => {
        const { methods } = setupResearch();
        const method = describeMethods(methods).methods.find((m) => m.name === 'research.trending')!;
        expect(method.paramsSchema).toMatchObject({ type: 'object', properties: {
            queries: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 } },
            groupIds: { type: 'array', maxItems: 20, items: { type: 'string' } },
            sinceHours: { type: 'integer', minimum: 1, maximum: 168 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
        } });
        expect(method.resultSchema).toMatchObject({ type: 'object', required: ['items'], properties: {
            items: { type: 'array', items: { type: 'object' } },
        } });
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
            groupScores: jest.fn((_p?: any): any => ({ groups: [] })),
            bestTimes: jest.fn((_p?: any): any => ({ hours: [], weekdays: [], insufficient: true })),
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

    it('posts.groupScores / posts.bestTimes pass only documented params; posts.stats accepts hour and weekday; old stats call unchanged', async () => {
        const { tracking, call, methods } = setupTracking();
        expect(await call('posts.groupScores', { from: 1, to: 2, campaignId: '', junk: 1 })).toEqual({ groups: [] });
        expect(tracking.groupScores).toHaveBeenLastCalledWith({ from: 1, to: 2, campaignId: '' });
        await call('posts.groupScores');
        expect(tracking.groupScores).toHaveBeenLastCalledWith({});
        expect(await call('posts.bestTimes', { groupUrl: 'g', campaignId: 'c1', from: 1, junk: 1 })).toEqual({ hours: [], weekdays: [], insufficient: true });
        expect(tracking.bestTimes).toHaveBeenLastCalledWith({ groupUrl: 'g', campaignId: 'c1', from: 1 });
        await call('posts.stats', { groupBy: 'hour' });
        expect(tracking.stats).toHaveBeenLastCalledWith({ groupBy: 'hour' });
        await call('posts.stats', { groupBy: 'group', from: 1, to: 2 });
        expect(tracking.stats).toHaveBeenLastCalledWith({ groupBy: 'group', from: 1, to: 2 });
        const byName = Object.fromEntries(describeMethods(methods).methods.map((m: any) => [m.name, m]));
        expect(byName['posts.stats'].paramsSchema.properties.groupBy.enum).toEqual(expect.arrayContaining(['hour', 'weekday', 'group']));
        expect(byName['posts.groupScores'].destructive).toBe(false);
        expect(byName['posts.bestTimes'].destructive).toBe(false);
    });

    it('posts.groupScores / posts.bestTimes map validation errors to INVALID_PARAMS', async () => {
        const { tracking, call } = setupTracking();
        tracking.groupScores.mockImplementationOnce(() => { throw new Error('campaignId không hợp lệ'); });
        expect(await call('posts.groupScores', { campaignId: 3 }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        tracking.bestTimes.mockImplementationOnce(() => { throw new Error('groupUrl không hợp lệ'); });
        expect(await call('posts.bestTimes', { groupUrl: '' }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
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

    it('describes the eight posts methods as non-destructive', () => {
        const { methods } = setupTracking();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('posts.')) as any[];
        expect(found).toHaveLength(8);
        for (const m of found) expect(m.destructive).toBe(false);
        expect(found[0].description).toMatch(/posts\.trackFinished/);
    });
});

describe('campaign and variant fields', () => {
    function setupCampaigns() {
        const campaigns = {
            list: jest.fn((_p?: any): any => ({ campaigns: [] })),
            get: jest.fn((_p?: any): any => ({ campaign: { id: 'c1' } })),
            create: jest.fn((_p?: any): any => ({ campaign: { id: 'c1' } })),
            update: jest.fn((_p?: any): any => ({ campaign: { id: 'c1' } })),
            delete: jest.fn((_p?: any): any => ({ deleted: true })),
        };
        const tracking = {
            list: jest.fn((_p?: any): any => ({ total: 0, rows: [] })),
            stats: jest.fn((_p: any): any => ({ rows: [] })),
        };
        const deps = { ...makeDeps(), campaigns, tracking };
        const methods = createControlMethods(deps as unknown as ControlMethodDeps);
        const call = (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {});
        return { deps, campaigns, tracking, methods, call };
    }

    it('passes only documented params to the campaign port', async () => {
        const { campaigns, call } = setupCampaigns();
        await call('campaigns.list', { status: 'paused', junk: 1 });
        expect(campaigns.list).toHaveBeenCalledWith({ status: 'paused' });
        await call('campaigns.list');
        expect(campaigns.list).toHaveBeenLastCalledWith({});
        await call('campaigns.get', { id: 'c1', junk: 1 });
        expect(campaigns.get).toHaveBeenCalledWith({ id: 'c1' });
        await call('campaigns.create', { name: 'N', goal: 'g', startAt: 1, endAt: 2, junk: 1 });
        expect(campaigns.create).toHaveBeenCalledWith({ name: 'N', goal: 'g', startAt: 1, endAt: 2 });
        await call('campaigns.update', { id: 'c1', status: 'paused', endAt: null, junk: 1 });
        expect(campaigns.update).toHaveBeenCalledWith({ id: 'c1', status: 'paused', endAt: null });
    });

    it('campaigns.delete needs confirmation', async () => {
        const { campaigns, call, methods } = setupCampaigns();
        expect(await call('campaigns.delete', { id: 'c1' }).catch((e) => e)).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
        expect(campaigns.delete).not.toHaveBeenCalled();
        expect(await call('campaigns.delete', { id: 'c1', confirm: true })).toEqual({ deleted: true });
        expect(campaigns.delete).toHaveBeenCalledWith({ id: 'c1' });
        const flags = Object.fromEntries(describeMethods(methods).methods.map((m) => [m.name, m.destructive]));
        expect(flags['campaigns.delete']).toBe(true);
        expect(flags['campaigns.create'] || flags['campaigns.update'] || flags['campaigns.list'] || flags['campaigns.get']).toBe(false);
    });

    it('maps campaign errors', async () => {
        const { campaigns, call } = setupCampaigns();
        campaigns.get.mockImplementationOnce(() => { throw new Error('Không tìm thấy chiến dịch'); });
        expect(await call('campaigns.get', { id: 'x' }).catch((e) => e)).toMatchObject({ code: 'NOT_FOUND' });
        campaigns.delete.mockImplementationOnce(() => { throw new Error('Chiến dịch còn 2 lịch/bài nháp, hãy chuyển hoặc xoá trước'); });
        expect(await call('campaigns.delete', { id: 'c1', confirm: true }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        campaigns.create.mockImplementationOnce(() => { throw new Error('Tên chiến dịch đã tồn tại'); });
        expect(await call('campaigns.create', { name: 'N' }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('drafts.create passes variants in params and campaignId beside name', async () => {
        const { deps, call } = setupCampaigns();
        await call('drafts.create', { mode: 'group', text: 'A', variants: ['B', 'C'], campaignId: 'c1' });
        expect(deps.poster.draftSave).toHaveBeenCalledWith({
            name: undefined, plannedAt: undefined, campaignId: 'c1',
            params: { mode: 'group', text: 'A', variants: ['B', 'C'], mediaPaths: [] },
        });
    });

    it('drafts.update changes campaignId only when sent, and null clears it', async () => {
        const { deps, call } = setupCampaigns();
        await call('drafts.update', { id: 'd1', text: 'mới' });
        expect(deps.poster.draftSave.mock.calls[0][0]).not.toHaveProperty('campaignId');
        await call('drafts.update', { id: 'd1', campaignId: null, variants: ['B'] });
        const input = deps.poster.draftSave.mock.calls[1][0] as any;
        expect(input.campaignId).toBeNull();
        expect(input.params.variants).toEqual(['B']);
    });

    it('drafts.approve forwards campaignId only when sent', async () => {
        const { deps, call } = setupCampaigns();
        await call('drafts.approve', { id: 'd1', when: { kind: 'once', runAt: 5 } });
        expect(deps.poster.draftApprove.mock.calls[0][0]).not.toHaveProperty('campaignId');
        await call('drafts.approve', { id: 'd1', when: 'now', confirm: true, campaignId: 'c1' });
        expect(deps.poster.draftApprove).toHaveBeenLastCalledWith({ id: 'd1', when: 'now', campaignId: 'c1' });
    });

    it('schedules.list and schedules.update forward campaignId', async () => {
        const { deps, call } = setupCampaigns();
        await call('schedules.list', { campaignId: '' });
        expect(deps.poster.scheduleList).toHaveBeenLastCalledWith({ campaignId: '' });
        await call('schedules.list');
        expect(deps.poster.scheduleList).toHaveBeenLastCalledWith({});
        await call('schedules.update', { id: 's1', campaignId: null });
        expect(deps.poster.scheduleUpdate).toHaveBeenLastCalledWith({ id: 's1', campaignId: null });
    });

    it('posts.stats and posts.list forward groupBy variant and filters; old requests are unchanged', async () => {
        const { tracking, call, methods } = setupCampaigns();
        await call('posts.stats', { groupBy: 'variant', campaignId: '', scheduleId: 's1' });
        expect(tracking.stats).toHaveBeenLastCalledWith({ groupBy: 'variant', campaignId: '', scheduleId: 's1' });
        await call('posts.stats', { groupBy: 'group', from: 1 });
        expect(tracking.stats).toHaveBeenLastCalledWith({ groupBy: 'group', from: 1 });
        await call('posts.list', { campaignId: 'c1', scheduleId: 's1', limit: 5 });
        expect(tracking.list).toHaveBeenLastCalledWith({ campaignId: 'c1', scheduleId: 's1', limit: 5 });
        await call('posts.list', { limit: 5 });
        expect(tracking.list).toHaveBeenLastCalledWith({ limit: 5 });
        const stats = describeMethods(methods).methods.find((m) => m.name === 'posts.stats') as any;
        expect(stats.paramsSchema.properties.groupBy.enum).toEqual(expect.arrayContaining(['campaign', 'variant']));
    });

    it('drafts.update forwards variants: [] so the draft can drop its variants; schema allows an empty list', async () => {
        const { deps, call, methods } = setupCampaigns();
        await call('drafts.update', { id: 'd1', variants: [] });
        expect((deps.poster.draftSave.mock.calls[0][0] as any).params.variants).toEqual([]);
        await call('drafts.update', { id: 'd1', text: 'x' });
        expect((deps.poster.draftSave.mock.calls[1][0] as any).params).not.toHaveProperty('variants');
        const update = describeMethods(methods).methods.find((m) => m.name === 'drafts.update') as any;
        expect(update.paramsSchema.properties.variants.minItems).toBe(0);
    });

    it('drafts.create with invalid variants maps to INVALID_PARAMS', async () => {
        const { deps, call } = setupCampaigns();
        deps.poster.draftSave.mockImplementationOnce(() => { throw new Error('Biến thể B trùng với nội dung khác'); });
        expect(await call('drafts.create', { mode: 'group', text: 'A', variants: ['A'] }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('old bots: drafts.create without new fields sends no campaign or variants', async () => {
        const { deps, call } = setupCampaigns();
        await call('drafts.create', { mode: 'group', text: 'A' });
        const input = deps.poster.draftSave.mock.calls[0][0] as any;
        expect(input).not.toHaveProperty('campaignId');
        expect(input.params).not.toHaveProperty('variants');
    });
});

describe('lead and comment methods', () => {
    function setupLeads() {
        const leads = {
            list: jest.fn((_p?: any): any => ({ total: 0, leads: [] })),
            update: jest.fn((_p: any): any => ({ lead: { id: 4 } })),
            getConfig: jest.fn((): any => ({ config: { autoCollect: true } })),
            setConfig: jest.fn((_p: any): any => ({ config: { autoCollect: false } })),
            collect: jest.fn((_p?: any): any => ({ jobId: 'j1', posts: 2 })),
            comments: jest.fn((_p?: any): any => ({ total: 0, comments: [] })),
            collectStatus: jest.fn((): any => ({ running: false, jobId: null, progress: { done: 0, total: 0 }, last: null })),
            collectCancel: jest.fn((): any => ({ cancelled: true })),
        };
        const methods = createControlMethods({ ...makeDeps(), leads } as unknown as ControlMethodDeps);
        const call = (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {});
        return { leads, methods, call };
    }

    it('passes only documented params to the lead port', async () => {
        const { leads, call } = setupLeads();
        expect(await call('comments.collect', { postUrls: ['u'], junk: 1 })).toEqual({ jobId: 'j1', posts: 2 });
        expect(leads.collect).toHaveBeenLastCalledWith({ postUrls: ['u'] });
        await call('comments.list', { postUrl: 'u', since: 5, limit: 10, offset: 2, junk: 1 });
        expect(leads.comments).toHaveBeenLastCalledWith({ postUrl: 'u', since: 5, limit: 10, offset: 2 });
        await call('leads.list', { status: 'new', campaignId: 'c', from: 1, to: 2, search: 'giá', limit: 5, offset: 1, junk: 1 });
        expect(leads.list).toHaveBeenLastCalledWith({ status: 'new', campaignId: 'c', from: 1, to: 2, search: 'giá', limit: 5, offset: 1 });
        expect(await call('leads.update', { id: 4, status: 'won', note: 'n', junk: 1 })).toEqual({ lead: { id: 4 } });
        expect(leads.update).toHaveBeenLastCalledWith({ id: 4, status: 'won', note: 'n' });
    });

    it('leads.config reads without config and saves with config', async () => {
        const { leads, call } = setupLeads();
        expect(await call('leads.config')).toEqual({ config: { autoCollect: true } });
        expect(leads.setConfig).not.toHaveBeenCalled();
        const config = { autoCollect: false };
        expect(await call('leads.config', { config })).toEqual({ config: { autoCollect: false } });
        expect(leads.setConfig).toHaveBeenCalledWith(config);
    });

    it('maps BUSY, NOT_FOUND and invalid params', async () => {
        const { leads, call } = setupLeads();
        leads.collect.mockImplementationOnce(() => { throw new Error(BUSY_ERROR); });
        expect(await call('comments.collect').catch((e) => e)).toMatchObject({ code: 'BUSY' });
        leads.update.mockImplementationOnce(() => { throw new Error('Không tìm thấy khách'); });
        expect(await call('leads.update', { id: 99, status: 'won' }).catch((e) => e)).toMatchObject({ code: 'NOT_FOUND' });
        leads.update.mockImplementationOnce(() => { throw new Error('Cần status hoặc note để cập nhật'); });
        expect(await call('leads.update', { id: 4 }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        leads.setConfig.mockImplementationOnce(() => { throw new Error('aiMinScore không hợp lệ'); });
        expect(await call('leads.config', { config: {} }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
        leads.list.mockImplementationOnce(() => { throw new Error('status phải là new, contacted, won hoặc ignored'); });
        expect(await call('leads.list', { status: 'x' }).catch((e) => e)).toMatchObject({ code: 'INVALID_PARAMS' });
    });

    it('comments.collectStatus caps last.errors at 10 rows and keeps the rest', async () => {
        const { leads, call } = setupLeads();
        const errors = Array.from({ length: 12 }, (_v, i) => ({ postUrl: `u${i}`, profileId: 'p1', error: `e${i}`, extra: 1 }));
        leads.collectStatus.mockReturnValueOnce({ running: false, jobId: null, progress: { done: 1, total: 1 }, last: { jobId: 'j1', cancelled: true, posts: 2, errors } });
        const out: any = await call('comments.collectStatus');
        expect(out.last.errors).toHaveLength(10);
        expect(out.last.errors[9]).toEqual({ postUrl: 'u9', profileId: 'p1', error: 'e9' });
        expect(out.last).toMatchObject({ jobId: 'j1', cancelled: true, posts: 2 });
        expect(out.progress).toEqual({ done: 1, total: 1 });
        leads.collectStatus.mockReturnValueOnce({ running: true, jobId: 'j2', progress: { done: 0, total: 3 }, last: null });
        expect(await call('comments.collectStatus')).toEqual({ running: true, jobId: 'j2', progress: { done: 0, total: 3 }, last: null });
    });

    it('comments.collectCancel calls the port once', async () => {
        const { leads, call } = setupLeads();
        expect(await call('comments.collectCancel')).toEqual({ cancelled: true });
        expect(leads.collectCancel).toHaveBeenCalledTimes(1);
    });

    it('describes the seven methods as non-destructive', () => {
        const { methods } = setupLeads();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('leads.') || m.name.startsWith('comments.')) as any[];
        expect(found).toHaveLength(7);
        for (const m of found) expect(m.destructive).toBe(false);
        expect(found.find((m) => m.name === 'comments.collect').description).toMatch(/leads\.found/);
        expect(found.find((m) => m.name === 'comments.collect').description).toMatch(/comments\.collectFinished/);
    });
});

describe('videos.*', () => {
    const videos = () => ({
        templates: jest.fn(async () => ({ templates: [], music: [] })),
        render: jest.fn(async (_p: any) => ({ videoId: 'v1', status: 'queued' })),
        status: jest.fn((_p: any) => ({ video: { id: 'v1' } })),
        list: jest.fn((_p: any) => ({ videos: [], total: 0 })),
        cancel: jest.fn(async (_p: any) => ({ cancelled: true })),
    });
    const setupVideos = () => {
        const v = videos();
        const methods = createControlMethods({ ...makeDeps(), videos: v } as unknown as ControlMethodDeps);
        return { v, call: (name: string, params: any = {}) => methods.find((m) => m.name === name)!.run(params, {}) };
    };

    it('maps to the video port passing only documented keys', async () => {
        const { v, call } = setupVideos();
        await call('videos.templates');
        expect(v.templates).toHaveBeenCalled();
        const params = { name: 'N', templateId: 't', aspect: '9:16', variables: {}, imageIds: ['a'], musicId: null, musicMediaId: 'm', html: 'h', width: 1, height: 2, assetIds: ['x'], fps: 30, quality: 'high', junk: 1 };
        expect(await call('videos.render', params)).toEqual({ videoId: 'v1', status: 'queued' });
        const { junk, ...documented } = params;
        expect(v.render).toHaveBeenCalledWith(documented);
        await call('videos.status', { videoId: 'v1', junk: 1 });
        expect(v.status).toHaveBeenCalledWith({ videoId: 'v1' });
        await call('videos.list', { status: 'done', limit: 5, offset: 1, junk: 1 });
        expect(v.list).toHaveBeenCalledWith({ status: 'done', limit: 5, offset: 1 });
        expect(await call('videos.cancel', { videoId: 'v1' })).toEqual({ cancelled: true });
        expect(v.cancel).toHaveBeenCalledWith({ videoId: 'v1' });
    });

    it('does not require confirmation for any videos method', () => {
        const methods = createControlMethods(makeDeps() as unknown as ControlMethodDeps);
        for (const m of methods.filter((x) => x.name.startsWith('videos.'))) expect(m.destructive).toBe(false);
    });

    it.each([
        ['unconfigured', 'Chưa cấu hình máy chủ render video', 'INVALID_PARAMS'],
        ['limit', 'Hàng đợi đầy', 'LIMIT_REACHED'],
        ['unreachable', 'Không kết nối được máy chủ render', 'INTERNAL'],
        ['not_found', 'Không tìm thấy video', 'NOT_FOUND'],
        ['invalid', 'Tên video phải có 1–100 ký tự', 'INVALID_PARAMS'],
        ['server', 'Máy chủ render trả lỗi 500', 'INTERNAL'],
    ] as const)('maps RenderError %s to %s keeping the Vietnamese message', async (code, message, expected) => {
        const { v, call } = setupVideos();
        v.render.mockRejectedValueOnce(new RenderError(code, message));
        await expect(call('videos.render', { name: 'x' })).rejects.toMatchObject({ code: expected, message });
    });
});
