import { createControlMethods, describe as describeMethods, type ControlContext, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { visibleMethods, authorizeMethod } from '../../services/control/controlAuthorization';
import type { ControlPrincipal } from '../../models/pageOperations';

const NAMES = ['autonomy.status', 'autonomy.config', 'autonomy.setConfig', 'autonomy.stop', 'autonomy.resume', 'autonomy.resumeProfile', 'autonomy.recordAgentRun'];

function setup() {
    const autonomy = {
        status: jest.fn(() => ({ enabled: false })),
        config: jest.fn(() => ({ policy: {} })),
        setConfig: jest.fn((patch: unknown) => {
            if (patch && typeof patch === 'object' && 'nope' in (patch as object)) throw new Error('Mục chính sách không hợp lệ: nope');
            return { policy: {}, changes: [] };
        }),
        stop: jest.fn(() => ({ enabled: false, cancelledRuns: 0, disabledSchedules: 0 })),
        resume: jest.fn(() => ({ enabled: true })),
        resumeProfile: jest.fn(() => ({ resumed: true })),
        recordAgentRun: jest.fn(() => ({ recorded: true })),
    };
    const methods = createControlMethods({ autonomy } as unknown as ControlMethodDeps);
    const call = (name: string, params: any = {}, ctx: ControlContext = {}) => methods.find((m) => m.name === name)!.run(params, ctx);
    return { autonomy, methods, call };
}

const scoped = (kind: 'page_runner' | 'page_receiver'): ControlPrincipal => kind === 'page_runner'
    ? { kind, keyId: 'k', workspaceId: 'ws', assignments: [{ pageId: 'pg', profileIds: ['p1'] }] }
    : { kind, keyId: 'k', workspaceId: 'ws', assignments: [{ pageId: 'pg', profileIds: ['p1'] }], ownerChatId: '1', ownerSenderId: '2' } as ControlPrincipal;
const resources = () => ({ workspaceId: 'ws', assertCurrent() {}, protectedWritesEnabled: () => true, getPageIdentity: () => null, getWork: () => null, getResourceOwner: () => null }) as any;

describe('autonomy control methods', () => {
    it('declaresSevenNonDestructiveMethodsWithVietnameseDescriptions', () => {
        const { methods } = setup();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('autonomy.'));
        expect(found.map((m) => m.name)).toEqual(NAMES);
        for (const m of found) {
            expect(m.destructive).toBe(false);
            expect(m.description).toMatch(/Chỉ owner/);
        }
        const byName = Object.fromEntries(found.map((m) => [m.name, m.description]));
        for (const name of ['autonomy.recordAgentRun', 'autonomy.setConfig']) expect(byName[name]).toMatch(/LIMIT_REACHED|details\.reason/);
    });

    it('setConfigRejectsUnknownKeyAsInvalidParams', async () => {
        const { call, autonomy } = setup();
        await expect(call('autonomy.setConfig', { nope: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('autonomy.setConfig', { patch: { enabled: true } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        expect(autonomy.setConfig).not.toHaveBeenCalled();
    });

    it('usesKeyNameAsActorAndDefaultsToBot', async () => {
        const { call, autonomy } = setup();
        await call('autonomy.stop', {}, { keyName: 'bot-1' });
        await call('autonomy.resume');
        await call('autonomy.resumeProfile', { profileId: 'p1' }, { keyName: 'bot-1' });
        await call('autonomy.setConfig', { groupPostsPerDay: 1 }, { keyName: 'bot-1' });
        expect(autonomy.stop).toHaveBeenCalledWith('bot-1');
        expect(autonomy.resume).toHaveBeenCalledWith('bot');
        expect(autonomy.resumeProfile).toHaveBeenCalledWith('p1', 'bot-1');
        expect(autonomy.setConfig).toHaveBeenCalledWith({ groupPostsPerDay: 1 }, 'bot-1');
    });

    it('validatesParams', async () => {
        const { call } = setup();
        await expect(call('autonomy.resumeProfile', {})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('autonomy.recordAgentRun', { outcome: 'x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('autonomy.status', { junk: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        expect(await call('autonomy.recordAgentRun', { outcome: 'ok' })).toEqual({ recorded: true });
    });

    it.each(NAMES)('autonomyMethodsAreOwnerOnly %s', async (name) => {
        const { methods, call, autonomy } = setup();
        for (const kind of ['page_runner', 'page_receiver'] as const) {
            const principal = scoped(kind);
            expect(visibleMethods(principal, methods).map((m) => m.name)).not.toContain(name);
            expect(() => authorizeMethod(principal, name, {}, resources())).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            await expect(call(name, { profileId: 'p1', outcome: 'ok' }, { principal, assertCurrent() {}, resources: resources() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
        expect(Object.values(autonomy).every((fn) => fn.mock.calls.length === 0)).toBe(true);
        expect(() => authorizeMethod({ kind: 'legacy', keyId: 'old' }, name, {}, resources())).not.toThrow();
    });
});
