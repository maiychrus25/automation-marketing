import { createControlMethods, describe as describeMethods, type ControlMethodDeps } from '../../services/control/ControlMethods';
import { visibleMethods } from '../../services/control/controlAuthorization';
import type { ControlPrincipal } from '../../models/pageOperations';

function setup() {
    const engagement = {
        suggest: jest.fn((_p: any): any => ({ id: 1, status: 'pending', expiresAt: 1 })),
        list: jest.fn((_p?: any): any => ({ total: 0, items: [] })),
        withdraw: jest.fn((_p: any): any => ({ id: 1, status: 'rejected' })),
        readComments: jest.fn((_p: any): any => ({ comments: [] })),
        markResearched: jest.fn((_p: any): any => ({ marked: 1 })),
    };
    const stub = new Proxy({}, { get: () => jest.fn() });
    const methods = createControlMethods({ poster: stub, research: stub, tracking: stub, campaigns: stub, leads: stub, videos: stub, engagement } as unknown as ControlMethodDeps);
    const call = (name: string, p: any = {}, ctx: any = {}) => methods.find((m) => m.name === name)!.run(p, ctx);
    return { engagement, methods, call };
}
const valid = { profileId: 'p1', kind: 'comment', postUrl: 'https://www.facebook.com/x/posts/1/', postExcerpt: 'e', text: 't', reason: 'r' };

describe('engagement.* control methods', () => {
    it('describes the five non-destructive owner methods', () => {
        const { methods } = setup();
        const found = describeMethods(methods).methods.filter((m) => m.name.startsWith('engagement.')) as any[];
        expect(found.map((m) => m.name).sort()).toEqual(['engagement.list', 'engagement.markResearched', 'engagement.readComments', 'engagement.suggest', 'engagement.withdraw']);
        expect(found.every((m) => m.destructive === false)).toBe(true);
    });

    it('controlApiCannotApproveOrEdit', async () => {
        const { methods, call, engagement } = setup();
        const names = methods.map((m) => m.name).filter((n) => n.startsWith('engagement.'));
        for (const n of names) expect(n).not.toMatch(/approve|reject|edit|post|cancel/i);
        const inputs = JSON.stringify(describeMethods(methods).methods.filter((m: any) => m.name.startsWith('engagement.')).map((m: any) => m.paramsSchema));
        expect(inputs).not.toMatch(/approvedText|decidedAt|reservationId/);
        for (const extra of [{ approvedText: 'x' }, { status: 'approved' }, { decidedAt: 1 }, { reservationId: 1 }])
            await expect(call('engagement.suggest', { ...valid, ...extra })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('engagement.withdraw', { id: 1, approvedText: 'x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('engagement.withdraw', { id: 1, status: 'approved' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(call('engagement.list', { approvedText: 'x' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        expect(engagement.suggest).not.toHaveBeenCalled();
        expect(engagement.withdraw).not.toHaveBeenCalled();
    });

    it('passes only declared fields and validates required ones', async () => {
        const { call, engagement } = setup();
        expect(await call('engagement.suggest', valid)).toEqual({ id: 1, status: 'pending', expiresAt: 1 });
        expect(engagement.suggest).toHaveBeenCalledWith(valid);
        await expect(call('engagement.withdraw', { id: 0 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await call('engagement.withdraw', { id: 3 });
        expect(engagement.withdraw).toHaveBeenCalledWith({ id: 3 });
        await call('engagement.list', { status: 'pending', limit: 5 });
        expect(engagement.list).toHaveBeenCalledWith({ status: 'pending', limit: 5 });
    });

    it('engagementMethodsAreOwnerOnly', async () => {
        const { methods, call } = setup();
        const runner: ControlPrincipal = { kind: 'page_runner', keyId: 'k', workspaceId: 'w', assignments: [{ pageId: 'pg', profileIds: ['p1'] }] };
        const receiver = { ...runner, kind: 'page_receiver', ownerChatId: '-100', ownerSenderId: '9' } as ControlPrincipal;
        for (const principal of [runner, receiver])
            expect(visibleMethods(principal, methods).map((m) => m.name).filter((n) => n.startsWith('engagement.'))).toEqual([]);
        // Direct call with a scoped principal is refused before the port.
        await expect(call('engagement.suggest', valid, { principal: runner })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(call('engagement.suggest', valid, { principal: { kind: 'legacy', keyId: 'k' } })).resolves.toBeTruthy();
    });

    it('readCommentsPassesOnlyDeclaredFieldsAndIsOwnerOnly', async () => {
        const { methods, call, engagement } = setup();
        await call('engagement.readComments', { profileId: 'p1', postUrl: 'https://www.facebook.com/x/posts/1/' });
        expect(engagement.readComments).toHaveBeenCalledWith({ profileId: 'p1', postUrl: 'https://www.facebook.com/x/posts/1/' });
        await expect(call('engagement.readComments', { profileId: 'p1', postUrl: 'u', save: true })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        const runner: ControlPrincipal = { kind: 'page_runner', keyId: 'k', workspaceId: 'w', assignments: [{ pageId: 'pg', profileIds: ['p1'] }] };
        expect(visibleMethods(runner, methods).map((m) => m.name)).not.toContain('engagement.readComments');
        await expect(call('engagement.readComments', { profileId: 'p1', postUrl: 'u' }, { principal: runner })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('markResearchedIsOwnerOnlyAndValidates', async () => {
        const { methods, call, engagement } = setup();
        expect(await call('engagement.markResearched', { profileIds: ['p1'] })).toEqual({ marked: 1 });
        expect(engagement.markResearched).toHaveBeenCalledWith({ profileIds: ['p1'] });
        await expect(call('engagement.markResearched', { profileIds: ['p1'], extra: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        const runner: ControlPrincipal = { kind: 'page_runner', keyId: 'k', workspaceId: 'w', assignments: [{ pageId: 'pg', profileIds: ['p1'] }] };
        expect(visibleMethods(runner, methods).map((m) => m.name)).not.toContain('engagement.markResearched');
        await expect(call('engagement.markResearched', { profileIds: ['p1'] }, { principal: runner })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
});
