import { authorizeMethod, authorizeRoute, scopedRequestHash, validateScopedKeyPolicy, visibleMethods, type ControlAuthorizationResources } from '../../services/control/controlAuthorization';
import { ControlError, createControlMethods } from '../../services/control/ControlMethods';
import type { ControlPrincipal, PageWork } from '../../models/pageOperations';

const runner: ControlPrincipal = { kind: 'page_runner', keyId: 'key1', workspaceId: 'ws1', assignments: [{ pageId: 'page1', profileIds: ['p1', 'unknown'] }] };
const receiver: ControlPrincipal = { ...runner, kind: 'page_receiver', ownerChatId: '-100', ownerSenderId: '9007199254740993' };
function resources(): ControlAuthorizationResources {
  return { workspaceId: 'ws1', assertCurrent: () => {}, protectedWritesEnabled: () => true, getPageIdentity: (id) => id === 'unknown' ? null : ({ profileId: id, pageId: id === 'p1' ? 'page1' : 'other', kind: 'page' }), getWork: (id) => id === 'work1' ? ({ id, workspaceId: 'ws1', pageId: 'page1', profileId: 'p1' } as PageWork) : null, getResourceOwner: (ref) => ref.id === 'linked' ? ({ workspaceId: 'ws1', pageId: 'page1', workId: 'work1' }) : null };
}
const forbidden = (fn: () => void) => expect(fn).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));

describe('scoped Control authorization', () => {
  it('durable campaign authority does not depend on work ownership and rejects foreign scopes', () => {
    const r = {...resources(), getWork:() => null, getResourceOwner:() => null,
      getCampaignResource:() => ({workspaceId:'ws1', pageId:'page1', profileId:'p1'})};
    expect(() => authorizeMethod(runner, 'pageCampaigns.get', {pageId:'page1', campaignId:'campaign'}, r)).not.toThrow();
    forbidden(() => authorizeMethod(runner, 'pageCampaigns.get', {pageId:'page1', campaignId:'campaign'}, {...r, getCampaignResource:undefined}));
    forbidden(() => authorizeMethod(runner, 'pageCampaigns.get', {pageId:'page1', campaignId:'campaign'}, {...r, getCampaignResource:() => ({workspaceId:'ws1', pageId:'page1', profileId:'foreign'})}));
    forbidden(() => authorizeMethod(receiver, 'pageCampaigns.propose', {workId:'work1'}, resources()));
    forbidden(() => authorizeMethod(runner, 'pageApprovals.prepare', {action:{kind:'grantCampaign', pageId:'page1', proposalId:'p'}}, r));
  });
  it('managed campaign references never transfer draft or media ownership', () => {
    const r={...resources(),getCampaignResource:() => ({workspaceId:'ws1',pageId:'page1',profileId:'p1'})};
    expect(() => authorizeMethod(runner,'pageWork.saveDraft',{workId:'work1',draft:{campaignId:'managed'}},r)).not.toThrow();
    forbidden(() => authorizeMethod(runner,'pageWork.saveDraft',{workId:'work1',draft:{campaignId:'managed',id:'foreign'}},r));
    forbidden(() => authorizeMethod(runner,'pageWork.saveDraft',{workId:'work1',draft:{campaignId:'managed',mediaIds:['foreign']}},r));
    forbidden(() => authorizeMethod(runner,'pageWork.saveDraft',{workId:'work1',draft:{campaignId:'managed'}},{...r,getCampaignResource:() => ({workspaceId:'ws1',pageId:'other',profileId:'p1'})}));
  });
  it.each(['pageCampaigns.schedule','pageCampaigns.updateSchedule','pageCampaigns.cancelSchedule'])('autonomy mutation is scoped runner-only and gated: %s',method=>{
    const r={...resources(),getCampaignResource:() => ({workspaceId:'ws1',pageId:'page1',profileId:'p1'})};
    const p={workId:'work1',scheduleId:'linked',input:{draftId:'linked',campaignId:'managed',grantId:'grant'}};
    expect(() => authorizeMethod(runner,method,p,r)).not.toThrow();
    forbidden(() => authorizeMethod(receiver,method,p,r));
    forbidden(() => authorizeMethod(runner,method,p,{...r,protectedWritesEnabled:()=>false}));
    forbidden(() => authorizeMethod(runner,method,{...p,scheduleId:'foreign',input:{...p.input,draftId:'foreign'}},r));
  });
  it('optimizeRequiresScopedGrantCampaignAndOriginalWorkDraft',()=>{
    const r={...resources(),getCampaignResource:(_kind:string,id:string)=>id==='foreign'?null:({workspaceId:'ws1',pageId:'page1',profileId:'p1'})};
    const p={workId:'work1',draftId:'linked',campaignId:'campaign',grantId:'grant'};
    expect(()=>authorizeMethod(runner,'pageCampaigns.optimize',p,r)).not.toThrow();
    for(const key of ['draftId','campaignId','grantId'])forbidden(()=>authorizeMethod(runner,'pageCampaigns.optimize',{...p,[key]:'foreign'},r));
    forbidden(()=>authorizeMethod(receiver,'pageCampaigns.optimize',p,r));
    forbidden(()=>authorizeMethod(runner,'pageCampaigns.optimize',p,{...r,protectedWritesEnabled:()=>false}));
    forbidden(()=>authorizeMethod(runner,'pageCampaigns.optimize',p,{...r,getResourceOwner:()=>({workspaceId:'ws1',pageId:'page1',workId:'other'})}));
  });
  it.each(['runs.active', 'runs.cancel'])('owner-only %s is neither visible nor callable for scoped principals, with or without runId', (method) => {
    const methods = createControlMethods({} as any);
    expect(methods.some((m) => m.name === method)).toBe(true);
    for (const principal of [runner, receiver]) {
      expect(visibleMethods(principal, methods).map((m) => m.name)).not.toContain(method);
      for (const params of [{}, { confirm: true }, { confirm: true, runId: 'r1' }]) forbidden(() => authorizeMethod(principal, method, params, resources()));
    }
    expect(() => authorizeMethod({ kind: 'legacy', keyId: 'old' }, method, { confirm: true }, resources())).not.toThrow();
  });
  it('fails closed without current runner mutation gate authority, not for reads/receiver/legacy', () => {
    const absent = { ...resources(), protectedWritesEnabled: undefined };
    forbidden(() => authorizeMethod(runner, 'pageWork.claimDue', { pageId: 'page1' }, absent));
    forbidden(() => authorizeMethod(runner, 'pages.learn', { profileIds: ['p1'] }, absent));
    expect(() => authorizeMethod(runner, 'pageWork.list', {}, absent)).not.toThrow();
    expect(() => authorizeMethod(receiver, 'pageWork.events', {}, absent)).not.toThrow();
    expect(() => authorizeMethod({ kind: 'legacy', keyId: 'old' }, 'pages.learn', {}, absent)).not.toThrow();
  });
  it('scopedRunnerRejectsEveryNonAllowlistedMethod across the actual registry', () => {
    const methods = createControlMethods({} as any);
    for (const { name } of methods) {
      if (['profiles.list', 'pages.list', 'pages.learn'].includes(name)) continue;
      forbidden(() => authorizeMethod(runner, name, { confirm: true }, resources()));
    }
    for (const name of ['pageWork.delete', 'pageBusiness.confirm', 'pageApprovals.confirm', 'system.status', 'videos.create', 'events.wait']) forbidden(() => authorizeMethod(runner, name, { confirm: true }, resources()));
  });
  it('allows only exact scoped methods and distinguishes runner from receiver', () => {
    for (const name of ['system.capabilities', 'profiles.list', 'pages.list', 'pageWork.list']) expect(() => authorizeMethod(runner, name, {}, resources())).not.toThrow();
    for (const name of ['pageWork.get', 'pageBusiness.propose', 'pageWork.research', 'pageWork.reconcile', 'pageWork.finish', 'pageWork.fail', 'pageWork.saveDraft']) expect(() => authorizeMethod(runner, name, { workId: 'work1' }, resources())).not.toThrow();
    expect(() => authorizeMethod(runner, 'pageWork.claimDue', { pageId: 'page1' }, resources())).not.toThrow();
    forbidden(() => authorizeMethod(receiver, 'pageBusiness.propose', { workId: 'work1' }, resources()));
    forbidden(() => authorizeMethod(receiver, 'pages.learn', { profileIds: ['p1'] }, resources()));
    forbidden(() => authorizeMethod(runner, 'pageWork.events', {}, resources()));
    expect(() => authorizeMethod(receiver, 'pageWork.events', {}, resources())).not.toThrow();
  });
  it('requires assigned Pages, workspace, work and linked resources without exposing existence', () => {
    for (const pageId of ['missing', 'other', undefined]) forbidden(() => authorizeMethod(runner, 'pageBusiness.get', { pageId }, resources()));
    expect(() => authorizeMethod(runner, 'pageBusiness.get', { pageId: 'page1' }, resources())).not.toThrow();
    forbidden(() => authorizeMethod(runner, 'pageWork.get', { workId: 'missing' }, resources()));
    forbidden(() => authorizeMethod(runner, 'profiles.list', { workspaceId: 'ws1' }, { ...resources(), workspaceId: 'other' }));
    forbidden(() => authorizeMethod(runner, 'pageWork.get', { workId: 'work1' }, { ...resources(), getWork: () => ({ workspaceId: 'other', pageId: 'page1', profileId: 'p1' } as PageWork) }));
    for (const [method, field] of [['pageWork.researchResult', 'scanId'], ['pageWork.draft', 'draftId'], ['pageWork.waitVideo', 'videoId']]) {
      expect(() => authorizeMethod(runner, method, { workId: 'work1', [field]: 'linked' }, resources())).not.toThrow();
      forbidden(() => authorizeMethod(runner, method, { workId: 'work1', [field]: 'unlinked' }, resources()));
      forbidden(() => authorizeMethod(runner, method, { workId: 'work1', [field]: 'linked' }, { ...resources(), getResourceOwner: () => ({ workspaceId: 'ws1', pageId: 'page1', workId: 'otherWork' }) }));
    }
    forbidden(() => authorizeMethod(runner, 'pageWork.saveDraft', { workId: 'work1', draft: { id: 'unlinked' } }, resources()));
    forbidden(() => authorizeMethod(runner, 'pageWork.saveDraft', { workId: 'work1', draft: { mediaIds: ['unlinked'] } }, resources()));
    forbidden(() => authorizeMethod(runner, 'pageWork.saveDraft', { workId: 'work1', draft: { campaignId: 'unlinked' } }, resources()));
  });
  it('pages.learn requires explicit assigned IDs without force or a changed Page', () => {
    for (const params of [{}, { profileIds: [] }, { profileIds: ['other'] }, { profileIds: ['p1'], force: true }, { profileIds: ['p1'], force: 'false' }]) forbidden(() => authorizeMethod(runner, 'pages.learn', params, resources()));
    expect(() => authorizeMethod(runner, 'pages.learn', { profileIds: ['p1', 'unknown'], force: false }, resources())).not.toThrow();
    forbidden(() => authorizeMethod(runner, 'pages.learn', { profileIds: ['p1'] }, { ...resources(), getPageIdentity: () => ({ profileId: 'p1', kind: 'page', pageId: 'changed' }) }));
  });
  it('approval checks are receiver-only, required, non-consuming and rechecked', () => {
    let count = 0;
    const bound = { ...resources(), authorizeApproval: () => { count++; } };
    for (const name of ['pageApprovals.prepare', 'pageApprovals.bindMessage', 'pageApprovals.confirm']) {
      forbidden(() => authorizeMethod(runner, name, {}, bound));
      forbidden(() => authorizeMethod(receiver, name, {}, resources()));
      forbidden(() => authorizeMethod({ kind: 'legacy', keyId: 'k' }, name, {}, bound));
      expect(() => authorizeMethod(receiver, name, { ticketId: 't' }, bound)).not.toThrow();
      expect(() => authorizeMethod(receiver, name, { ticketId: 't' }, bound)).not.toThrow();
    }
    expect(count).toBe(6);
  });
  it('denies before stale resource access and keeps persisted video ownership after work pruning', () => {
    const stale = { ...resources(), assertCurrent: () => { throw new ControlError('FORBIDDEN', 'Không có quyền'); }, getResourceOwner: jest.fn() };
    forbidden(() => authorizeRoute(runner, '/v1/videos/file', { kind: 'video', id: 'linked' }, stale));
    expect(stale.getResourceOwner).not.toHaveBeenCalled();
    forbidden(() => authorizeRoute(runner, '/v1/media', undefined, resources()));
    expect(() => authorizeRoute(runner, '/v1/videos/file', { kind: 'video', id: 'linked' }, { ...resources(), getWork: () => null })).not.toThrow();
    forbidden(() => authorizeRoute(runner, '/v1/videos/file', { kind: 'video', id: 'unlinked' }, resources()));
    forbidden(() => authorizeRoute(runner, '/v1/videos/file', { kind: 'draft', id: 'linked' }, resources()));
  });
  it('visible methods and fingerprints cannot be widened by a name or reordered params', () => {
    const methods = createControlMethods({} as any);
    expect(visibleMethods(runner, methods).map((m) => m.name)).toEqual(['profiles.list', 'pages.learn', 'pages.list']);
    const first = scopedRequestHash(runner, 'pageWork.get', { nested: { b: 2, a: 1 }, arr: [1, 2] });
    expect(scopedRequestHash(runner, 'pageWork.get', { arr: [1, 2], nested: { a: 1, b: 2 } })).toBe(first);
    expect(scopedRequestHash(runner, 'pageWork.get', { nested: { b: 3, a: 1 }, arr: [1, 2] })).not.toBe(first);
    expect(scopedRequestHash({ ...runner, workspaceId: 'other' }, 'pageWork.get', { nested: { b: 2, a: 1 }, arr: [1, 2] })).not.toBe(first);
    expect(scopedRequestHash({ ...runner, assignments: [{ pageId: 'other', profileIds: ['p1'] }] }, 'pageWork.get', { nested: { b: 2, a: 1 }, arr: [1, 2] })).not.toBe(first);
    expect(validateScopedKeyPolicy({ kind: 'page_runner', workspaceId: 'ws1', assignments: [{ pageId: 'page1', profileIds: ['p1'] }] })).toMatchObject({ kind: 'page_runner' });
  });
  it.each([Infinity, -Infinity, NaN])('rejects non-finite numeric fingerprint inputs: %s', (value) => {
    for (const params of [{ value }, { outer: { value } }, { outer: [value] }]) {
      expect(() => scopedRequestHash(runner, 'profiles.list', params)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    }
  });

});
