import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { campaignKeyAuthorized, isOwnerKey, ownerRunnerPrincipal } from '../../services/control/ownerPageRunner';
import { authorizeMethod, visibleMethods } from '../../services/control/controlAuthorization';
import { createPageOperationMethods } from '../../services/control/pageOperationMethods';
import type { ControlContext } from '../../services/control/ControlMethods';

function setup() {
    const db = memoryDb(); db.exec(CONTROL_SCHEMA_SQL);
    db.exec('CREATE TABLE browser_profiles (id TEXT PRIMARY KEY)');
    const briefs = new DailyBriefStore(db); briefs.ensureSchema();
    const learn = (profileId: string, pageId: string, kind: 'page' | 'person' = 'page', errorCode = '') => {
        briefs.upsertIdentity({ profileId, kind, pageId, pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: 1, errorCode, error: errorCode });
    };
    const profile = (id: string) => db.run('INSERT INTO browser_profiles (id) VALUES (?)', [id]);
    return { db, control: new ControlStore(db), learn, profile };
}

test('ownerPrincipalCoversOnlyLearnedPages', () => {
    const s = setup();
    for (const id of ['p1', 'p2', 'p3', 'p4']) s.profile(id);
    s.learn('p1', 'A'); s.learn('p2', 'A');
    s.learn('p3', 'B', 'page', 'checkpoint'); // Page read failed
    s.learn('p4', 'C', 'person');             // not a Page
    s.learn('p5', 'D');                       // profile deleted
    expect(ownerRunnerPrincipal(s.db, 'workspace', 'owner')).toEqual({
        kind: 'page_runner', keyId: 'owner', workspaceId: 'workspace', assignments: [{ pageId: 'A', profileIds: ['p1', 'p2'] }],
    });
});

test('campaignKeyAuthorizedAcceptsOwnerAndExactRoleOnly', () => {
    const s = setup();
    const scope = { workspaceId: 'workspace', pageId: 'A', profileId: 'p1' };
    const assignments = [{ pageId: 'A', profileIds: ['p1'] }];
    const owner = s.control.createKey('Owner');
    const runner = s.control.createKey('Runner', { kind: 'page_runner', workspaceId: 'workspace', assignments });
    const receiver = s.control.createKey('Receiver', { kind: 'page_receiver', workspaceId: 'workspace', assignments, ownerChatId: '1', ownerSenderId: '2' });
    expect(campaignKeyAuthorized(s.control, owner.id, 'page_runner', scope)).toBe(true);
    expect(campaignKeyAuthorized(s.control, owner.id, 'page_receiver', scope)).toBe(true);
    expect(campaignKeyAuthorized(s.control, runner.id, 'page_runner', scope)).toBe(true);
    expect(campaignKeyAuthorized(s.control, runner.id, 'page_receiver', scope)).toBe(false);
    expect(campaignKeyAuthorized(s.control, receiver.id, 'page_receiver', scope)).toBe(true);
    expect(campaignKeyAuthorized(s.control, receiver.id, 'page_runner', scope)).toBe(false);
    expect(campaignKeyAuthorized(s.control, runner.id, 'page_runner', { ...scope, profileId: 'p2' })).toBe(false);
    expect(campaignKeyAuthorized(s.control, runner.id, 'page_runner', { ...scope, workspaceId: 'other' })).toBe(false);
    expect(campaignKeyAuthorized(s.control, 'missing', 'page_runner', scope)).toBe(false);
    expect(isOwnerKey(s.control, owner.id)).toBe(true);
    expect(isOwnerKey(s.control, runner.id)).toBe(false);
    s.control.revokeKey(owner.id);
    expect(isOwnerKey(s.control, owner.id)).toBe(false);
    expect(campaignKeyAuthorized(s.control, owner.id, 'page_runner', scope)).toBe(false);
});

test('scopedPrincipalCannotStartOrStop', async () => {
    const methods = createPageOperationMethods({ bindRequest: () => { throw new Error('scoped start/stop must not bind a request'); } });
    const names = ['pageCampaigns.start', 'pageCampaigns.stop'];
    expect(methods.map(m => m.name)).toEqual(expect.arrayContaining(names));
    const assignments = [{ pageId: 'A', profileIds: ['p1'] }];
    const runner = { kind: 'page_runner' as const, keyId: 'runner', workspaceId: 'workspace', assignments };
    const receiver = { kind: 'page_receiver' as const, keyId: 'receiver', workspaceId: 'workspace', assignments, ownerChatId: '1', ownerSenderId: '2' };
    const resources = { workspaceId: 'workspace', assertCurrent() {}, protectedWritesEnabled: () => true, getPageIdentity: () => null, getWork: () => null, getResourceOwner: () => null };
    const params: Record<string, Record<string, unknown>> = { 'pageCampaigns.start': { proposalId: 'p', expectedRevision: 1 }, 'pageCampaigns.stop': { campaignId: 'c' } };
    for (const principal of [runner, receiver]) {
        const ctx: ControlContext = { principal, assertCurrent() {}, resources };
        for (const name of names) {
            await expect(methods.find(m => m.name === name)!.run(params[name], ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
            expect(() => authorizeMethod(principal, name, params[name], resources)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        }
        expect(visibleMethods(principal, methods).map(m => m.name)).not.toEqual(expect.arrayContaining([names[0]]));
        expect(visibleMethods(principal, methods).map(m => m.name)).not.toEqual(expect.arrayContaining([names[1]]));
    }
    expect(visibleMethods({ kind: 'legacy', keyId: 'owner' }, methods).map(m => m.name)).toEqual(expect.arrayContaining(names));
});
