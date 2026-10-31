import { PageLearner, type PageLearnerDeps } from '../../services/dailyBrief/PageLearner';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { memoryDb } from '../facebookPoster/helpers';
import { createControlMethods, type ControlMethodDeps, type ControlContext } from '../../services/control/ControlMethods';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { ResearchStore } from '../../services/research/ResearchStore';
import { ResearchService } from '../../services/research/ResearchService';
import { createPageOperationMethods, type PageOperationRequest } from '../../services/control/pageOperationMethods';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { ControlError } from '../../services/control/ControlMethods';

const identity = { kind: 'page' as const, pageId: 'page', pageName: 'Page', category: '', about: '', recentPosts: [] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('protectedWritesFailClosed for scoped pages.learn', async () => {
    let started = false;
    const deps = { pages: { learn: () => { started = true; return { jobId: 'job' }; }, list: () => ({ identities: [] }) } } as unknown as ControlMethodDeps;
    const method = createControlMethods(deps).find(m => m.name === 'pages.learn')!;
    const context: ControlContext = {
        principal: { kind: 'page_runner', keyId: 'runner', workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }] },
        assertCurrent() {},
        resources: { workspaceId: 'workspace', assertCurrent() {}, getPageIdentity: () => ({ kind: 'page', pageId: 'page', profileId: 'profile' }), getWork: () => null, getResourceOwner: () => null },
    };
    await expect(method.run({ profileIds: ['profile'] }, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(started).toBe(false);
});

test('scoped method retains its request guard after returning the job ID', async () => {
    const store = new DailyBriefStore(memoryDb()); store.ensureSchema();
    let release!: () => void; let enabled = true; let closed = false; let passedGuard = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const learner = new PageLearner({
        store: () => store,
        openForAutomation: async () => ({ context: { pages: () => [{}] }, close: async () => { closed = true; } }) as any,
        read: async (_page, options) => { passedGuard = typeof options?.assertCurrent === 'function'; await pending; options?.assertCurrent?.(); return identity; },
        shouldYield: () => false,
        observeLogin() {}, onFinished() {},
    });
    const deps = {
        pages: { learn: (p: { profileIds: string[]; force: boolean }, guard?: () => void) => learner.learn(p.profileIds, p.force, guard), list: () => ({ identities: [] }) },
        protectedWritesEnabled: () => enabled,
    } as unknown as ControlMethodDeps;
    const context: ControlContext = {
        principal: { kind: 'page_runner', keyId: 'runner', workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }] },
        assertCurrent() {},
        resources: { workspaceId: 'workspace', assertCurrent() {}, protectedWritesEnabled: () => enabled, getPageIdentity: () => ({ kind: 'page', pageId: 'page', profileId: 'profile' }), getWork: () => null, getResourceOwner: () => null },
    };
    const method = createControlMethods(deps).find(m => m.name === 'pages.learn')!;
    expect(await method.run({ profileIds: ['profile'] }, context)).toMatchObject({ jobId: expect.any(String) });
    await tick(); enabled = false; release(); await learner.whenIdle();
    expect(passedGuard).toBe(true); expect(closed).toBe(true); expect(store.listIdentities()).toEqual([]);
});

const coreScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'page-methods-'));
afterAll(() => fs.rmSync(coreScratch, { recursive: true, force: true }));
const coreNow = Date.parse('2026-10-28T10:00:00Z');
const coreClock = { date: (n: number) => new Date(n).toISOString().slice(0, 10), minutes: () => 600 };
function coreSetup() {
    const db = memoryDb(); db.exec(CONTROL_SCHEMA_SQL);
    new PageCampaignStore(db).ensureSchema();
    const works = new PageWorkStore(db, coreClock); works.ensureSchema();
    const briefs = new DailyBriefStore(db, coreClock);
    briefs.saveBrief('profile', { time: '07:00', draftsPerDay: 2 }, coreNow);
    briefs.upsertIdentity({ ...identity, profileId: 'profile', learnedAt: coreNow, errorCode: '', error: '' });
    const business = new PageBusinessStore(db); business.ensure('page', 'profile', coreNow);
    business.setEnabled('page', true, 0, { confirmedAt: coreNow, confirmationRef: 'owner' });
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const research = new ResearchStore(db); research.ensureSchema();
    const events = new ControlStore(db);
    let enabled = true; let active = true; let time = coreNow;
    const assertCurrent = () => { if (!active) throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); };
    const context: ControlContext = {
        principal: { kind: 'page_runner', keyId: 'runner', workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }] },
        assertCurrent,
        resources: { workspaceId: 'workspace', assertCurrent, getPageIdentity: id => briefs.getIdentity(id) ?? null,
            getWork: id => works.get(id), getResourceOwner: ref => works.getResourceOwner(ref), authorizeApproval() {} },
    };
    const draft = { baseDir: path.join(coreScratch, 'core-draft-fixtures'), now: () => time, newId: () => 'unused', maxSchedules: 200,
        env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (file: string) => fs.statSync(file).size } };
    const researchService = new ResearchService({ store: research, shouldYield: () => false,
        openSession: async () => ({ session: { open: async () => undefined,
            ensureQuery: async () => ({ friendlyName: 'SearchCometResultsPaginatedResultsQuery', docId: 'd', variables: { args: { text: 'x', filters: [] } } }),
            call: async () => JSON.stringify({ data: { serpResponse: { results: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } }) } as any,
            readIdentity: async () => ({ kind: 'page', pageId: 'page' }), close: async () => undefined }),
        listProfiles: () => [{ id: 'profile', name: 'profile' }], isProfileBusy: () => false, loginStates: () => [], groupMembership: () => ({}),
        observeLogin() {}, readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), emit() {}, now: () => time, sleep: async () => undefined });
    const bound: PageOperationRequest = { db, dbPath: ':memory:', workspaceId: 'workspace', assertCurrent, now: () => time, clock: coreClock,
        protectedWritesEnabled: () => enabled,
        work: { draft, assertActor: async () => undefined, media: new InboxMediaStore(path.join(coreScratch, 'core-inbox')),
            research: researchService, researchStore: research,
            video: { status() { throw new Error('external boundary not configured'); }, openFile: async () => { throw new Error('external boundary not configured'); } } },
        approval: { draft, inspectResource: () => null, afterCommit() {} },
        waitForEvent: async () => undefined, notify() {},
    };
    const methods = createPageOperationMethods({ bindRequest: () => bound });
    const run = (name: string, p = {}, ctx = context): Promise<any> => methods.find((m: any) => m.name === name).run(p, ctx);
    const claim = () => run('pageWork.claimDue', { pageId: 'page' });
    const receiver = (): ControlContext => ({ ...context, principal: { ...context.principal as any, kind: 'page_receiver', keyId: 'receiver', ownerChatId: '1', ownerSenderId: '2' } });
    return { db, works, briefs, business, poster, research, events, context, bound, methods, run, claim, receiver,
        gateOff: () => { enabled = false; }, revoke: () => { active = false; }, advance: (n: number) => { time += n; } };
}
const factInput = (sourceType = 'page', sourceRef = `page:profile:${coreNow}`, observedAt = coreNow) =>
    ({ topic: 'product', value: 'Known product', status: 'observed', sourceType, sourceRef, observedAt, reason: '' });

test('optimizeRouteUsesServerEvidenceAndRejectsInjectedCountsAndAuthority',async()=>{
    const s=coreSetup();const policy={workspaceId:'workspace',assignments:[{pageId:'page',profileIds:['profile']}]};
    const runner=s.events.createKey('Local runner',{...policy,kind:'page_runner'});
    const receiver=s.events.createKey('Local receiver',{...policy,kind:'page_receiver',ownerChatId:'1',ownerSenderId:'2'});
    s.context.principal!.keyId=runner.id;
    const {work}=await s.claim();const lease={workId:work.id,claimedAt:work.claimedAt};
    const proposal=await s.run('pageCampaigns.propose',{...lease,input:{name:'Local optimization',goal:'Measured engagement',policy:{startsAt:coreNow,expiresAt:coreNow+604800000,maxPostsPerDay:1,maxPostsTotal:7,allowedMinutes:[600],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,actions:['schedulePost','updateScheduledPost']}},expectedRevision:null});
    const accepted=new PageCampaignStore(s.db).acceptProposal({workspaceId:'workspace',pageId:'page',profileId:'profile'},proposal.id,1,{receiverKeyId:receiver.id,confirmedAt:coreNow,confirmationRef:'controlled'},coreNow);
    const saved=await s.run('pageWork.saveDraft',{...lease,draftIndex:0,draft:{text:'Original',variants:['Alternative'],campaignId:accepted.campaignId}});
    const p={...lease,campaignId:accepted.campaignId,draftId:saved.draftId,expectedDraftRevision:saved.revision,grantId:accepted.grantId,expectedGrantRevision:1};
    const before=s.poster.getSchedule(saved.draftId);
    const result=await s.run('pageCampaigns.optimize',p);
    expect(result).toMatchObject({scheduleId:null,decision:{kind:'keep',reason:'missing_planned_time'}});
    expect(s.poster.getSchedule(saved.draftId)).toEqual(before);
    for(const extra of [{cohorts:[]},{reactions:99},{current:{variant:'B'}},{confirm:true}])await expect(s.run('pageCampaigns.optimize',{...p,...extra})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(s.run('pageCampaigns.optimize',p,s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(s.run('pageCampaigns.optimize',{...p,draftId:'foreign'})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(s.run('pageCampaigns.optimize',{...p,claimedAt:work.claimedAt+1})).rejects.toMatchObject({code:'CONFLICT'});
    expect(await s.run('system.capabilities')).not.toHaveProperty('pageCampaigns');
    s.gateOff();await expect(s.run('pageCampaigns.optimize',p)).rejects.toMatchObject({code:'FORBIDDEN'});
});

test('campaignGetAdvertisesPublicLatestDecisionAndReadsWithoutWorkOrGate',async()=>{
    const s=coreSetup();
    const get=s.methods.find(m=>m.name==='pageCampaigns.get')!.resultSchema as any;
    const optimize=s.methods.find(m=>m.name==='pageCampaigns.optimize')!.resultSchema as any;
    expect(get.properties.latestDecision).toEqual({oneOf:[{type:'null'}, {
        type:'object',additionalProperties:false,required:['decision','evidenceAvailable'],
        properties:{decision:optimize.properties.decision,evidenceAvailable:{type:'boolean'}}}]});
    s.db.run("INSERT INTO page_campaign_links VALUES ('campaign','workspace','page','profile',1,1,'proposal',?,NULL)",[coreNow]);
    const scope={workspaceId:'workspace',pageId:'page',profileId:'profile'};
    const decision={id:'decision',campaignId:'campaign',grantId:'historical-grant',grantRevision:1,kind:'keep' as const,
        before:null,after:null,observationRefs:[],sampleSizes:{},coverage:{},reason:'insufficient_evidence',createdAt:coreNow};
    const p={pageId:'page',campaignId:'campaign'};
    expect(await s.run('pageCampaigns.get',p,s.receiver())).toMatchObject({latestDecision:null});
    new PageCampaignStore(s.db).saveDecision(scope,'pruned','step',{decision,scheduleId:null,stateHash:'private-state',requestHash:'private-request',executionRevision:null,action:'schedulePost'});
    s.gateOff();
    const result=await s.run('pageCampaigns.get',p,s.receiver());
    expect(result.latestDecision).toEqual({decision,evidenceAvailable:false});
    expect(JSON.stringify(result)).not.toMatch(/stateHash|requestHash|executionRevision|private-|receiverKeyId|confirmationRef/);
    for(const principal of [
        {...s.receiver().principal!,workspaceId:'foreign'},
        {...s.receiver().principal!,assignments:[{pageId:'page',profileIds:['foreign']}]},
    ])await expect(s.run('pageCampaigns.get',p,{...s.receiver(),principal})).rejects.toMatchObject({code:'FORBIDDEN'});
    s.revoke();await expect(s.run('pageCampaigns.get',p,s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
});

describe('Task5 scoped measurement routes',()=>{
    test('report survives work pruning and collect requires runner lease without count submission',async()=>{
        const s=coreSetup();
        expect(s.methods.map(m=>m.name)).toEqual(expect.arrayContaining(['pageCampaigns.report','pageCampaigns.collect']));
        s.db.run("INSERT INTO page_campaign_links VALUES ('campaign','workspace','page','profile',1,1,'proposal',?,NULL)",[coreNow]);
        const p={pageId:'page',campaignId:'campaign',from:coreNow-86400000,to:coreNow};
        expect(await s.run('pageCampaigns.report',p,s.receiver())).toMatchObject({published:0,finance:{status:'unavailable'}});
        await expect(s.run('pageCampaigns.report',{...p,from:coreNow+1})).rejects.toMatchObject({code:'INVALID_PARAMS'});
        expect(await s.run('pageCampaigns.report',{pageId:'page',campaignId:'campaign',to:coreNow-86400000})).toMatchObject({from:coreNow-29*86400000,to:coreNow-86400000});
        await expect(s.run('pageCampaigns.report',{...p,pageId:'foreign'},s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
        const {work}=await s.claim();const collect={workId:work.id,claimedAt:work.claimedAt,campaignId:'campaign'};
        await expect(s.run('pageCampaigns.collect',collect,s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
        await expect(s.run('pageCampaigns.collect',{...collect,reactions:10})).rejects.toMatchObject({code:'INVALID_PARAMS'});
        s.gateOff();await expect(s.run('pageCampaigns.collect',collect)).rejects.toMatchObject({code:'FORBIDDEN'});
        expect(await s.run('system.capabilities')).not.toHaveProperty('pageCampaigns');
    });
});

describe('public Page operation core', () => {
    test('campaign routes are scoped proposals only and do not advertise posting readiness', async () => {
        const s = coreSetup();
        expect(s.methods.map(m => m.name)).toEqual(expect.arrayContaining(['pageCampaigns.list', 'pageCampaigns.get', 'pageCampaigns.propose']));
        const {work} = await s.claim();
        const input = {name:'Pilot', goal:'Engagement', policy:{startsAt:coreNow, expiresAt:coreNow + 604800000, maxPostsPerDay:1,
            maxPostsTotal:7, allowedMinutes:[420], timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone, actions:['schedulePost']}};
        const p = {workId:work.id, claimedAt:work.claimedAt, input, expectedRevision:null};
        const proposal = await s.run('pageCampaigns.propose', p);
        expect(proposal).toMatchObject({revision:1, status:'pending'});
        const prepared = await s.run('pageApprovals.prepare', {action:{kind:'grantCampaign', pageId:'page', proposalId:proposal.id, expectedProposalRevision:1}}, s.receiver());
        expect(prepared.ticket).not.toHaveProperty('receiverKeyId');
        expect(await s.run('pageCampaigns.list', {pageId:'page'}, s.receiver())).toMatchObject({campaigns:[], proposals:[{id:proposal.id}]});
        await expect(s.run('pageCampaigns.list', {pageId:'foreign'})).rejects.toMatchObject({code:'FORBIDDEN'});
        await expect(s.run('pageCampaigns.propose', {...p, input:{...input, owner:true}})).rejects.toMatchObject({code:'INVALID_PARAMS'});
        await expect(s.run('pageCampaigns.propose', p, s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
        expect(await s.run('system.capabilities')).not.toHaveProperty('pageCampaigns');
        s.gateOff(); await expect(s.run('pageCampaigns.propose', {...p, expectedRevision:1})).rejects.toMatchObject({code:'FORBIDDEN'});
    });
    test('exact method metadata and strict params with no legacy authority', async () => {
        const s = coreSetup();
        expect(s.methods.map((m: any) => m.name).sort()).toEqual(['pageCampaigns.optimize', 'pageCampaigns.collect', 'pageCampaigns.report', 'pageCampaigns.schedule', 'pageCampaigns.updateSchedule', 'pageCampaigns.cancelSchedule', 'pageCampaigns.list', 'pageCampaigns.get', 'pageCampaigns.propose', 'system.capabilities', 'pageBusiness.get', 'pageBusiness.propose',
            'pageWork.list', 'pageWork.get', 'pageWork.claimDue', 'pageWork.research', 'pageWork.researchResult', 'pageWork.saveDraft', 'pageWork.draft',
            'pageWork.waitVideo', 'pageWork.reconcile', 'pageWork.finish', 'pageWork.fail', 'pageApprovals.prepare', 'pageApprovals.bindMessage', 'pageApprovals.confirm', 'pageWork.events'].sort());
        for (const method of s.methods) { expect(method.description).toBeTruthy(); expect(method.paramsSchema).toMatchObject({ additionalProperties: false }); expect(method.resultSchema).toBeDefined(); expect(method.destructive).toBe(false); }
        await expect(s.run('pageWork.list', { all: true })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(s.run('pageWork.list', {}, { principal: { kind: 'legacy', keyId: 'old' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const caps = await s.run('system.capabilities', {}, s.receiver());
        expect(caps).toEqual({ pageOperations: 1, principal: { kind: 'page_receiver', workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }] }, protectedWritesEnabled: true });
    });
    test('scoped variants and autonomy methods reject forged provenance without advertising runtime',async()=>{
        const s=coreSetup(); const {work}=await s.claim(); const lease={workId:work.id,claimedAt:work.claimedAt};
        const campaigns=new PageCampaignStore(s.db);
        const proposal=await s.run('pageCampaigns.propose',{...lease,input:{name:'Managed',goal:'Engagement',policy:{startsAt:coreNow,expiresAt:coreNow+604800000,
            maxPostsPerDay:1,maxPostsTotal:7,allowedMinutes:[600],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,actions:['schedulePost','updateScheduledPost']}},expectedRevision:null});
        const accepted=campaigns.acceptProposal(work,proposal.id,1,{receiverKeyId:'receiver',confirmedAt:coreNow,confirmationRef:'owner'},coreNow);
        const saved=await s.run('pageWork.saveDraft',{...lease,draftIndex:0,draft:{text:'Main',variants:['Alternative'],campaignId:accepted.campaignId}});
        expect((await s.run('pageWork.draft',{workId:work.id,draftId:saved.draftId})).draft).toMatchObject({variants:['Alternative']});
        const input={draftId:saved.draftId,expectedDraftRevision:saved.revision,campaignId:accepted.campaignId,grantId:accepted.grantId,expectedGrantRevision:1,runAt:coreNow+120000,variant:'B',factIds:[]};
        for(const injection of [{authority_kind:'owner'},{authorityKind:'owner'},{contentRevision:'fake'},{owner:true},{runnerKeyId:'forged'}])
            await expect(s.run('pageCampaigns.schedule',{...lease,input:{...input,...injection}})).rejects.toMatchObject({code:'INVALID_PARAMS'});
        const scheduled=await s.run('pageCampaigns.schedule',{...lease,input});
        expect(s.poster.getSchedule(scheduled.scheduleId)).toMatchObject({authorityKind:'autonomy',draft:false});
        const {draftId:_draftId,expectedDraftRevision:_draftRevision,...update}=input;
        const changed=await s.run('pageCampaigns.updateSchedule',{...lease,scheduleId:scheduled.scheduleId,expectedExecutionRevision:scheduled.revision,input:{...update,expectedScheduleRevision:s.poster.getSchedule(scheduled.scheduleId)!.revision,content:{text:'Changed',variants:['New alternative']}}});
        await expect(s.run('pageCampaigns.cancelSchedule',{...lease,scheduleId:scheduled.scheduleId,expectedExecutionRevision:changed.revision},s.receiver())).rejects.toMatchObject({code:'FORBIDDEN'});
        expect(await s.run('pageCampaigns.cancelSchedule',{...lease,scheduleId:scheduled.scheduleId,expectedExecutionRevision:changed.revision})).toEqual({cancelled:true});
        expect(await s.run('system.capabilities')).not.toHaveProperty('pageCampaigns');
    });
    test('public research delegates to production reservation/service and waiting preserves budget', async () => {
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        const result = await s.run('pageWork.research', { ...lease, input: { kind: 'search', keywords: ['product'] } });
        expect(s.research.getScan(result.scanId)?.status).toBe('done');
        expect(s.works.getResourceOwner({ kind: 'research', id: result.scanId })?.workId).toBe(work.id);
        s.works.linkResource(work.id, { kind: 'video', id: 'video' });
        const waiting = await s.run('pageWork.waitVideo', { ...lease, videoId: 'video' });
        expect(waiting.work).toMatchObject({ status: 'waiting', waitFor: 'video', attempts: 1 });
        s.bound.work.video.status = (() => ({ video: { status: 'running' } })) as any;
        expect((await s.run('pageWork.reconcile', { workId: work.id })).work).toMatchObject({ status: 'waiting', attempts: 1 });
    });
    test('arbitraryUrlIsNotReadEvidence and deletedEvidenceIsReportedUnavailable', async () => {
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        await expect(s.run('pageBusiness.propose', { ...lease, expectedRevision: 1, fact: factInput('page', 'https://evil.example/') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const result = await s.run('pageBusiness.propose', { ...lease, expectedRevision: 1, fact: factInput() });
        expect(result.business.facts[0]).toMatchObject({ status: 'observed', confirmedAt: null });
        expect((await s.run('pageBusiness.get', { pageId: 'page' })).evidenceAvailability[0].available).toBe(true);
        s.db.run('DELETE FROM fb_page_identities');
        const after = await s.run('pageBusiness.get', { pageId: 'page' });
        expect(after.business.facts).toHaveLength(1); expect(after.evidenceAvailability[0].available).toBe(false);
    });
    test('unownedResearchCannotBecomeEvidence and historyCountsDoNotLeakOtherPages', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.research.createScan({ id: 'scan', source: 'posts', query: 'test', params: {}, profileIds: ['profile', 'foreign'], origin: 'api', startedAt: coreNow });
        s.research.addItems('scan', [{ kind: 'post', fbId: 'one', url: 'https://facebook.com/one', title: 'Own' }], 'profile', coreNow);
        s.research.addItems('scan', [{ kind: 'post', fbId: 'two', url: 'https://facebook.com/two', title: 'Secret' }], 'foreign', coreNow);
        s.research.finishScan('scan', 'done', '', '', { secret: 'hidden' }, coreNow);
        const p = { workId: work.id, claimedAt: work.claimedAt, expectedRevision: 1, fact: factInput('research', 'https://facebook.com/one') };
        await expect(s.run('pageBusiness.propose', p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        s.works.linkResource(work.id, { kind: 'research', id: 'scan' });
        const result = await s.run('pageWork.researchResult', { workId: work.id, scanId: 'scan' });
        expect(result.items).toHaveLength(1); expect(result.scan.itemCount).toBe(1); expect(result.scan.profileIds).toEqual(['profile']);
        expect(JSON.stringify(result)).not.toMatch(/foreign|Secret|hidden/);
        await expect(s.run('pageBusiness.propose', { ...p, fact: factInput('research', 'https://facebook.com/two') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect((await s.run('pageBusiness.propose', p)).business.facts).toHaveLength(1);
        s.db.run('DELETE FROM research_items');
        expect((await s.run('pageBusiness.get', { pageId: 'page' })).evidenceAvailability[0].available).toBe(false);
    });
    test('secondaryBriefDoesNotClaim and protectedWritesFailClosed including reconcile', async () => {
        const s = coreSetup();
        s.context.principal = { ...s.context.principal as any, assignments: [{ pageId: 'page', profileIds: ['secondary'] }] };
        expect(await s.claim()).toEqual({ work: null });
        s.context.principal = { ...s.context.principal as any, assignments: [{ pageId: 'page', profileIds: ['profile'] }] };
        const { work } = await s.claim(); s.gateOff();
        const params: Record<string, any> = { 'pageWork.claimDue': { pageId: 'page' }, 'pageBusiness.propose': { workId: work.id, claimedAt: work.claimedAt, expectedRevision: 1, fact: factInput() },
            'pageWork.research': { workId: work.id, claimedAt: work.claimedAt, input: { kind: 'search', keywords: ['x'] } },
            'pageWork.saveDraft': { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'draft' } },
            'pageWork.waitVideo': { workId: work.id, claimedAt: work.claimedAt, videoId: 'video' }, 'pageWork.reconcile': { workId: work.id },
            'pageWork.finish': { workId: work.id, claimedAt: work.claimedAt, reason: '', evidenceRefs: [] },
            'pageWork.fail': { workId: work.id, claimedAt: work.claimedAt, code: 'rate_limited', reason: '' } };
        for (const [name, p] of Object.entries(params)) await expect(s.run(name, p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect((await s.run('pageWork.get', { workId: work.id })).work.status).toBe('running');
        expect(s.works.get(work.id)?.attempts).toBe(1);
    });
    test('completion needs sufficient durable drafts, not approval; stale leases and paths stay blocked', async () => {
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        const finish = () => s.run('pageWork.finish', { ...lease, reason: 'prepared', evidenceRefs: [] });
        await expect(finish()).rejects.toMatchObject({ code: 'CONFLICT' });
        const one = await s.run('pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'First' } });
        await expect(finish()).rejects.toMatchObject({ code: 'CONFLICT' });
        await s.run('pageWork.saveDraft', { ...lease, draftIndex: 1, draft: { text: 'Second' } });
        const view = await s.run('pageWork.draft', { workId: work.id, draftId: one.draftId });
        expect(JSON.stringify(view)).not.toMatch(/mediaPaths|baseDir|params|\/private\//);
        expect((await finish()).work.status).toBe('completed'); expect(s.poster.getSchedule(one.draftId)?.draft).toBe(true);
        await expect(s.run('pageWork.fail', { ...lease, code: 'rate_limited', reason: '' })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    test('eventsAdvancePastHiddenRows and only receiver sees safe bounded events', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.db.run('DELETE FROM control_events');
        for (let i = 0; i < 205; i++) s.events.addEvent('run.started', { secret: 'never expose' });
        s.events.addEvent('pageWork.changed', { workId: work.id, workspaceId: 'workspace', pageId: 'page', status: 'running', secret: 'strip' });
        const result = await s.run('pageWork.events', { after: 0, timeoutSec: 0 }, s.receiver());
        expect(result.nextCursor).toBeGreaterThan(205); expect(result.events).toHaveLength(1);
        expect(JSON.stringify(result)).not.toMatch(/secret|strip|never expose/);
        expect((await s.run('pageWork.events', { after: result.nextCursor, timeoutSec: 0 }, s.receiver())).events).toEqual([]);
        await expect(s.run('pageWork.events', { after: 0, timeoutSec: 0 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    test('primary preparation projection is explicit, scoped, optional and matches completion target', async () => {
        const s = coreSetup();
        s.briefs.saveBrief('profile', { niche: 'Primary niche', keywords: ['primary'], groupIds: ['group'], tone: 'calm', notes: 'instructions', time: '07:00', draftsPerDay: 2 }, coreNow);
        s.briefs.saveBrief('foreign', { niche: 'Foreign secret' }, coreNow);
        const { work } = await s.claim();
        expect(await s.run('pageWork.get', { workId: work.id })).toEqual({ work: s.works.get(work.id), preparation: {
            niche: 'Primary niche', keywords: ['primary'], groupIds: ['group'], tone: 'calm', notes: 'instructions', time: '07:00', draftsPerDay: 2 } });
        const foreign = { ...s.context, principal: { ...s.context.principal as any, assignments: [{ pageId: 'other', profileIds: ['foreign'] }] } };
        await expect(s.run('pageWork.get', { workId: work.id }, foreign)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        s.db.run('DELETE FROM daily_briefs WHERE profile_id = ?', ['profile']);
        expect((await s.run('pageWork.get', { workId: work.id })).preparation).toBeNull();
        expect(s.works.get(work.id)?.status).toBe('running');
    });
    test('runner business views never expose owner confirmation metadata or foreign primary profile', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.business.createOwnerFact('page', { topic: 'owner', value: 'Product', reason: '' }, 1,
            { confirmedAt: coreNow, confirmationRef: 'telegram:secret-chat:secret-sender:42' });
        const first = await s.run('pageBusiness.get', { pageId: 'page' });
        expect(first.business.facts[0].status).toBe('confirmed');
        expect(JSON.stringify(first)).not.toMatch(/telegram|secret-chat|secret-sender|confirmationRef/);
        const result = await s.run('pageBusiness.propose', { workId: work.id, claimedAt: work.claimedAt, expectedRevision: 2, fact: factInput() });
        expect(JSON.stringify(result)).not.toMatch(/telegram|secret-chat|confirmationRef/);
        await expect(s.run('pageBusiness.propose', { workId: work.id, claimedAt: work.claimedAt, expectedRevision: 3, fact: { ...factInput(), id: first.business.facts[0].id } })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(s.business.get('page')?.facts[0].value).toBe('Product');
        s.context.principal = { ...s.context.principal as any, assignments: [{ pageId: 'page', profileIds: ['secondary'] }] };
        expect((await s.run('pageBusiness.get', { pageId: 'page' })).business.primaryProfileId).toBeNull();
    });
    test.each([false, true])('revocation after awaited draft actor prevents writes and result exposure (reject=%s)', async reject => {
        const s = coreSetup(); const { work } = await s.claim(); let release!: () => void;
        s.bound.work.assertActor = async () => { await new Promise<void>(resolve => { release = resolve; }); if (reject) throw new Error('actor boundary rejected'); };
        const pending = s.run('pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Never saved' } });
        s.revoke(); release();
        await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(s.works.get(work.id)?.draftIds).toEqual([]);
        expect(s.db.query('SELECT * FROM fb_poster_schedules')).toEqual([]);
    });
    test('disabled or changed preparation context blocks reconcile and missing brief blocks mutations', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.business.setEnabled('page', false, 1, { confirmedAt: coreNow, confirmationRef: 'owner' });
        await expect(s.run('pageWork.reconcile', { workId: work.id })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((await s.run('pageWork.get', { workId: work.id })).work.status).toBe('running');
        s.business.setEnabled('page', true, 2, { confirmedAt: coreNow, confirmationRef: 'owner' });
        s.db.run('DELETE FROM daily_briefs WHERE profile_id = ?', ['profile']);
        await expect(s.run('pageBusiness.propose', { workId: work.id, claimedAt: work.claimedAt, expectedRevision: 3, fact: factInput() })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    test('finish resolves item timestamps from local evidence rather than assuming scan completion time', async () => {
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        s.research.createScan({ id: 'scan', source: 'posts', query: 'test', params: {}, profileIds: ['profile'], origin: 'api', startedAt: coreNow - 10 });
        s.research.addItems('scan', [{ kind: 'post', fbId: 'one', url: 'https://facebook.com/one', title: 'Own' }], 'profile', coreNow - 5);
        s.research.finishScan('scan', 'done', '', '', {}, coreNow); s.works.linkResource(work.id, { kind: 'research', id: 'scan' });
        await s.run('pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'One' } });
        await s.run('pageWork.saveDraft', { ...lease, draftIndex: 1, draft: { text: 'Two' } });
        expect((await s.run('pageWork.finish', { ...lease, reason: '', evidenceRefs: ['https://facebook.com/one'] })).work.status).toBe('completed');
    });
    test('events insert failure rolls back the actual state write', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON control_events BEGIN SELECT RAISE(ABORT, 'event storage failure'); END;");
        await expect(s.run('pageWork.fail', { workId: work.id, claimedAt: work.claimedAt, code: 'invalid_input', reason: '' })).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(s.works.get(work.id)?.status).toBe('running');
    });
    test('failure classification never clears uncertain effects or consumes extra attempts', async () => {
        for (const [code, expected] of [['rate_limited', 'pending'], ['invalid_input', 'failed'], ['unexpected', 'needs_review']]) {
            const s = coreSetup(); const { work } = await s.claim();
            const result = await s.run('pageWork.fail', { workId: work.id, claimedAt: work.claimedAt, code, reason: 'operator-safe reason' });
            expect(result.work.status).toBe(expected); expect(result.work.attempts).toBe(1);
        }
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        s.works.beginStep(lease, 'unknown', 'hash', coreNow);
        expect((await s.run('pageWork.fail', { ...lease, code: 'rate_limited', reason: '' })).work.status).toBe('needs_review');
        expect(s.works.getStep(work.id, 'unknown')?.status).toBe('intent');
    });
    test('running reconciliation releases expired leases without consuming attempts', async () => {
        const s = coreSetup(); const { work } = await s.claim();
        s.advance(3600000);
        expect((await s.run('pageWork.reconcile', { workId: work.id })).work.status).toBe('pending');
        expect(s.works.get(work.id)?.attempts).toBe(1);
        await expect(s.run('pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Stale' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    test('receiver approval delegation binds real tickets and cannot be used by runner', async () => {
        const s = coreSetup(); const receiver = s.receiver();
        const p = { action: { kind: 'confirmFact', pageId: 'page', expectedRevision: 1, fact: { topic: 'product', value: 'Owner fact', reason: '' } } };
        await expect(s.run('pageApprovals.prepare', p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const { ticket } = await s.run('pageApprovals.prepare', p, receiver);
        expect(s.works.getApproval(ticket.id)?.receiverKeyId).toBe('receiver');
        await s.run('pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 }, receiver);
        const update = { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 };
        const result = await s.run('pageApprovals.confirm', { ticketId: ticket.id, update }, receiver);
        expect(result.replayed).toBe(false); expect(s.business.get('page')?.facts[0].status).toBe('confirmed');
        expect((await s.run('pageApprovals.confirm', { ticketId: ticket.id, update }, receiver)).replayed).toBe(true);
        await expect(s.run('pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10, extra: true }, receiver)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    });
    test('actual SQLite state/event rollback and revision replay produce no duplicate event', async () => {
        const s = coreSetup(); const { work } = await s.claim(); const lease = { workId: work.id, claimedAt: work.claimedAt };
        const before = s.events.lastEventSeq();
        expect(() => s.works.transaction(() => { s.works.transition(lease, 'needs_review', {}, coreNow); throw new Error('rollback'); })).toThrow('rollback');
        expect(s.events.lastEventSeq()).toBe(before); expect(s.works.get(work.id)?.status).toBe('running');
        const p = { ...lease, draftIndex: 0, draft: { text: 'One' } }; await s.run('pageWork.saveDraft', p);
        const cursor = s.events.lastEventSeq(); await s.run('pageWork.saveDraft', p); expect(s.events.lastEventSeq()).toBe(cursor);
        expect(s.events.listEventsAfter(before, 100).filter(e => e.type === 'pageWork.draftSaved')).toHaveLength(1);
    });
});

describe('scoped learning request lifetime', () => {
    test.each(['open', 'newPage', 'read', 'close'] as const)('workspaceSwitchInvalidatesOldCallbacks at %s', async stage => {
        for (const reject of [false, true]) {
            const store = new DailyBriefStore(memoryDb()); store.ensureSchema();
            let active = true;
            let release!: () => void;
            const pending = new Promise<void>(resolve => { release = resolve; });
            let closed = 0; let observed = 0; let exposed = 0;
            const pause = async (at: string) => { if (at === stage) { await pending; if (reject) throw new Error('read failed'); } };
            const deps = {
                store: () => store,
                openForAutomation: async () => { await pause('open'); return {
                    context: { pages: () => [], newPage: async () => { await pause('newPage'); return {}; } },
                    close: async () => { closed++; await pause('close'); },
                }; },
                read: async () => { await pause('read'); return identity; },
                shouldYield: () => false,
                observeLogin: () => { observed++; }, onFinished: () => { exposed++; },
            } as unknown as PageLearnerDeps;
            const learner = new PageLearner(deps);
            const guard = () => { if (!active) throw new Error('revoked'); };
            // The cast lets RED exercise the old implementation rather than fail TypeScript compilation.
            (learner.learn as (ids: string[], force: boolean, guard: () => void) => unknown)(['profile'], false, guard);
            await tick(); active = false; release(); await learner.whenIdle();
            expect(store.listIdentities()).toEqual([]);
            expect(observed).toBe(0); expect(exposed).toBe(0);
            expect(learner.isRunning()).toBe(false);
            expect(closed).toBe(stage === 'open' && reject ? 0 : 1);
            // A later legacy job cannot inherit the revoked principal.
            learner.learn(['legacy'], false); await learner.whenIdle();
            if (!reject) expect(store.getIdentity('legacy')?.pageId).toBe('page');
        }
    });
});
