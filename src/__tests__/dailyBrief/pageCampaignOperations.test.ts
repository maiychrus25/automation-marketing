import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { memoryDb } from '../facebookPoster/helpers';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { saveDraft } from '../../services/facebookPoster/drafts';
import { createCampaignOperations } from '../../services/facebookPoster/campaignOperations';
import { resolveScheduleMedia } from '../../services/facebookPoster/scheduleMedia';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { createPageCampaignOperations } from '../../services/dailyBrief/pageCampaignOperations';
import { ControlError } from '../../services/control/ControlMethods';
import { ControlStore } from '../../services/control/ControlStore';
import { ResearchStore } from '../../services/research/ResearchStore';
import { campaignContentRevision } from '../../services/dailyBrief/pageCampaignOperations';
import https from 'https';
import { ControlApiServer } from '../../services/control/ControlApiServer';
import { IdempotencyCache } from '../../services/control/IdempotencyCache';
import { AuthLockout, RateLimiter } from '../../services/control/controlSecurity';
import { createCertificate } from '../../services/control/certificate';

let certificate:ReturnType<typeof createCertificate>|undefined;
async function optimizationHttp(s:Awaited<ReturnType<typeof optimizationSetup>>,pending=false) {
    const cert=await (certificate ??= createCertificate());
    const cache=new IdempotencyCache(s.keys);
    let entered!:()=>void,release!:()=>void,secondEntered!:()=>void;
    const waiting=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
    const second=new Promise<void>(resolve=>secondEntered=resolve);
    let calls=0,requests=0;
    const runCache=cache.run.bind(cache);
    cache.run=((...args:any[])=>{requests++;if(requests===2)secondEntered();return (runCache as any)(...args);}) as any;
    const key=s.keys.createKey('HTTP runner',{kind:'page_runner',workspaceId:'workspace',assignments:[{pageId:'page',profileIds:['profile']}]});
    s.deps.principal.keyId=key.id;
    const operations=createPageCampaignOperations({...s.deps,draft:s.draft,media:s.media});
    const resources={workspaceId:'workspace',assertCurrent:s.deps.assertCurrent,protectedWritesEnabled:()=>true,
        getPageIdentity:(id:string)=>new DailyBriefStore(s.db).getIdentity(id) ?? null,
        getWork:(id:string)=>s.works.get(id),getResourceOwner:(ref:any)=>s.works.getResourceOwner(ref),
        getCampaignResource:(kind:string,id:string)=>kind==='grant'?s.campaigns.getGrant(id):s.campaigns.getLink(id)};
    const server=new ControlApiServer({tls:{key:cert.key,cert:cert.cert},host:'127.0.0.1',port:0,allowList:['127.0.0.1'],store:s.keys,
        idempotency:cache,rateLimiter:new RateLimiter(100),lockout:new AuthLockout(),authorizationResources:()=>resources,
        methods:[{name:'pageCampaigns.optimize',description:'Controlled durable optimize',destructive:false,paramsSchema:{type:'object'},resultSchema:{type:'object'},run:async p=>{
            const value=await operations.optimize({workId:p.workId,claimedAt:p.claimedAt},p.campaignId,p.draftId,p.expectedDraftRevision,p.grantId,p.expectedGrantRevision);
            if(pending && ++calls===1){entered();await barrier;}return value;
        }},{name:'pageCampaigns.get',description:'Scoped read',destructive:false,paramsSchema:{type:'object'},resultSchema:{type:'object'},run:async()=>({})}],
        saveMedia:async()=>{throw new Error('No provider or media side effects');}});
    const {port}=await server.start();
    const params={...s.lease,campaignId:s.row.campaignId,draftId:'draft',expectedDraftRevision:s.row.revision,grantId:s.scheduleInput.grantId,expectedGrantRevision:1};
    const call=(extra:Record<string,unknown>={},method='pageCampaigns.optimize')=>new Promise<any>((resolve,reject)=>{
        const req=https.request({host:'127.0.0.1',port,path:'/v1/call',method:'POST',rejectUnauthorized:false,agent:false,
            headers:{authorization:`Bearer ${key.key}`,'content-type':'application/json'}},res=>{
            const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));
        });req.on('error',reject);req.end(JSON.stringify({method,params:{...params,...extra},idempotencyKey:'controlled-optimization'}));
    });
    return {server,call,waiting,second,release};
}
it.each(['grant','source','owner','effect','lease','receiver'])('HTTP cached optimization rejects stale %s through durable replay',async change=>{
    const s=await optimizationSetup();s.pair();const http=await optimizationHttp(s);
    try {
        const first=await http.call();expect(first.ok).toBe(true);expect(await http.call()).toEqual(first);
        expect((await http.call({expectedDraftRevision:s.row.revision+1})).error.code).toBe('CONFLICT');
        expect((await http.call({pageId:'page'},'pageCampaigns.get')).error.code).toBe('CONFLICT');
        if(change==='grant')s.campaigns.revokeGrant(s.context,s.scheduleInput.grantId,1,now);
        if(change==='source')s.db.run('DELETE FROM research_items');
        if(change==='owner')s.poster.updateSchedule('draft',{runAt:now+240000},now);
        if(change==='effect')s.execution.beginSubmit('draft','controlled-run',now+120000);
        if(change==='lease')s.db.run('UPDATE page_work_items SET claimed_at=claimed_at+1');
        if(change==='receiver')s.keys.revokeKey(s.receiver.id);
        const before=s.poster.getSchedule('draft');expect((await http.call()).ok).toBe(false);
        expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.db.query('SELECT * FROM page_campaign_decisions')).toHaveLength(1);
    }finally{await http.server.stop();}
});
it.each(['valid','source','owner','effect','grant'])('HTTP pending optimization validates each returning caller %s',async change=>{
    const s=await optimizationSetup();s.pair();const http=await optimizationHttp(s,true);
    try {
        const first=http.call();await http.waiting;
        const second=http.call();await http.second;
        if(change==='source')s.db.run('DELETE FROM research_items');
        if(change==='owner')s.poster.updateSchedule('draft',{runAt:now+240000},now);
        if(change==='effect')s.execution.beginSubmit('draft','controlled-run',now+120000);
        if(change==='grant')s.campaigns.revokeGrant(s.context,s.scheduleInput.grantId,1,now);
        const before=s.poster.getSchedule('draft');http.release();
        const results=await Promise.all([first,second]);
        if(change==='valid'){expect(results[0].ok).toBe(true);expect(results[1]).toEqual(results[0]);}
        else expect(results[1].ok).toBe(false);
        expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.db.query('SELECT * FROM page_campaign_decisions')).toHaveLength(1);
    }finally{http.release();await http.server.stop();}
});

async function optimizationSetup(planned=true) {
    const s=await scheduleSetup();
    const keys=new ControlStore(s.db);
    const policy={workspaceId:'workspace',assignments:[{pageId:'page',profileIds:['profile']}]};
    const runner=keys.createKey('Controlled runner',{...policy,kind:'page_runner'});
    const receiver=keys.createKey('Controlled receiver',{...policy,kind:'page_receiver',ownerChatId:'1',ownerSenderId:'2'});
    s.deps.principal.keyId=runner.id;
    s.db.run('UPDATE page_campaign_grants SET receiver_key_id=? WHERE id=?',[receiver.id,s.scheduleInput.grantId]);
    if(planned)s.poster.updateSchedule('draft',{runAt:now+120000},now);
    const operations=createPageCampaignOperations({...s.deps,draft:s.draft,media:s.media});
    const row=s.poster.getSchedule('draft')!;
    const revision=campaignContentRevision(s.draft.baseDir,row);
    const research=new ResearchStore(s.db);research.ensureSchema();
    const add=(id:number,variant='A',known=true,minute=600,contentRevision=revision,score=variant==='B'?10:1)=>{
        const publishedAt=now-96*3600000,observedAt=now-24*3600000,sourceRef=`controlled-${id}`,postUrl=`https://www.facebook.com/page/posts/${id}`;
        const post={workspaceId:'workspace',pageId:'page',profileId:'profile',resultId:id,campaignId:row.campaignId!,runId:`run-${id}`,scheduleId:`history-${id}`,
            runnerKeyId:runner.id,grantId:s.scheduleInput.grantId,selection:{variant,contentRevision,factIds:[]},publishedAt,
            comparison:{format:'image',minute},postId:known?String(id):null,postUrl:known?postUrl:null,sourceRef:known?'controlled-publish':null,reason:known?'':'unconfirmed_post_target'};
        s.db.run('INSERT INTO page_campaign_published VALUES (?,?,?,?,?,?)',[id,'workspace','page','profile',row.campaignId,JSON.stringify(post)]);
        if(!known)return;
        s.campaigns.reserveMeasurement(s.context,row.campaignId!,id,4320,sourceRef);
        research.createScan({id:sourceRef,source:'posts',query:postUrl,params:{query:postUrl,profileIds:['profile']},profileIds:['profile'],origin:'api',startedAt:observedAt});
        research.addItems(sourceRef,[{kind:'post',fbId:String(id),url:postUrl,authorKind:'page',authorId:'page',reactions:score,comments:0,shares:0} as any],'profile',observedAt);
        research.finishScan(sourceRef,'done','','',{},observedAt);
        s.campaigns.recordObservation({resultId:id,postId:String(id),postUrl,pageId:'page',campaignId:row.campaignId!,publishedAt,observedAt,milestoneMinutes:4320,sourceRef,status:'measured',reason:'',reactions:score,comments:0,shares:0});
    };
    const pair=()=>{for(let i=1;i<=5;i++){add(i,'A');add(100+i,'B');}};
    const optimize=()=> (operations as any).optimize(s.lease,row.campaignId,'draft',row.revision,s.scheduleInput.grantId,1);
    return {...s,operations,row,revision,add,pair,optimize,keys,receiver};
}
it.each([false,true])('realMultiMilestoneHistoryPreservesComparisonAndNeverBorrowsEarlyCounts missing4320=%s',async missing=>{
    const baseline=await optimizationSetup();baseline.pair();const original=(await baseline.optimize()).decision;
    const s=await optimizationSetup();s.pair();const research=new ResearchStore(s.db);
    const observations=s.campaigns.listObservations(s.context,s.row.campaignId!,0,now);
    for(const row of observations)for(const milestoneMinutes of [60,1440] as const){
        const sourceRef=`${row.sourceRef}-${milestoneMinutes}`,observedAt=row.publishedAt!+milestoneMinutes*60000;
        s.campaigns.reserveMeasurement(s.context,s.row.campaignId!,row.resultId,milestoneMinutes,sourceRef);
        research.createScan({id:sourceRef,source:'posts',query:row.postUrl,params:{query:row.postUrl,profileIds:['profile']},profileIds:['profile'],origin:'api',startedAt:observedAt});
        research.addItems(sourceRef,[{kind:'post',fbId:row.postId,url:row.postUrl,authorKind:'page',authorId:'page',reactions:999,comments:0,shares:0} as any],'profile',observedAt);
        research.finishScan(sourceRef,'done','','',{},observedAt);
        s.campaigns.recordObservation({...row,milestoneMinutes,sourceRef,observedAt,reactions:999});
    }
    expect(s.campaigns.listObservations(s.context,s.row.campaignId!,0,now)).toHaveLength(30);
    if(missing)s.db.run('DELETE FROM page_campaign_measurements WHERE milestone_minutes=4320');
    const before=s.poster.getSchedule('draft');const result=await s.optimize();
    if(missing){
        expect(result).toMatchObject({scheduleId:null,decision:{kind:'keep',sampleSizes:{'variant:A':0,'variant:B':0},coverage:{'variant:A':0,'variant:B':0},observationRefs:[]}});
        expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toBeNull();
    }else{
        expect(result).toMatchObject({scheduleId:'draft',decision:{kind:'variant',before:'A',after:'B',sampleSizes:{'variant:A':5,'variant:B':5},coverage:{'variant:A':1,'variant:B':1}}});
        for(const key of ['kind','before','after','sampleSizes','coverage','observationRefs'])expect(result.decision[key]).toEqual(original[key]);
        expect(s.execution.get('draft')).toMatchObject({selection:{variant:'B'},revision:1});
    }
});
it.each(['items','scan','measurement','post'])('latestDecisionRemainsHistoricalAfterWorkPruningAndSourceLoss %s',async loss=>{
    const s=await optimizationSetup();s.pair();const result=await s.optimize();
    const receiver=createPageCampaignOperations({...s.deps,principal:{...s.deps.principal,kind:'page_receiver',ownerChatId:'1',ownerSenderId:'2'},
        context:()=>{throw new Error('Read must not resolve pruned work');},now:()=>now+90*86400000,protectedWritesEnabled:()=>false});
    expect((receiver.get('page',s.row.campaignId!) as any).latestDecision).toEqual({decision:result.decision,evidenceAvailable:true});
    s.campaigns.revokeGrant(s.context,s.scheduleInput.grantId,1,now);
    s.db.run('DELETE FROM page_work_items');
    const before=s.poster.getSchedule('draft'),execution=s.execution.get('draft');
    const read=()=>receiver.get('page',s.row.campaignId!) as any;
    expect(read().latestDecision).toEqual({decision:result.decision,evidenceAvailable:true});
    const table={items:'research_items',scan:'research_scans',measurement:'page_campaign_measurements',post:'page_campaign_published'}[loss];
    s.db.run(`DELETE FROM ${table}`);
    expect(read().latestDecision).toEqual({decision:result.decision,evidenceAvailable:false});
    expect(JSON.stringify(read())).not.toMatch(/requestHash|stateHash|executionRevision|receiverKeyId|confirmationRef/);
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toEqual(execution);
    expect(()=>receiver.get('foreign',s.row.campaignId!)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
    s.revoke();expect(read).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
});
it('latestDecisionWithoutRefsDoesNotInventMeasurementProof',async()=>{
    const s=await optimizationSetup(false);
    expect((s.operations.get('page',s.row.campaignId!) as any).latestDecision).toBeNull();
    const result=await s.optimize();
    expect(result.decision.observationRefs).toEqual([]);
    expect((s.operations.get('page',s.row.campaignId!) as any).latestDecision).toEqual({decision:result.decision,evidenceAvailable:false});
});

it('optimizePromotesOneFactorAndReplaysDurablyWithoutQuotaDuplication',async()=>{
    const s=await optimizationSetup();s.pair();const before=s.poster.getSchedule('draft')!;
    const result=await s.optimize();expect(result).toMatchObject({scheduleId:'draft',decision:{kind:'variant',before:'A',after:'B',grantRevision:1}});
    expect(s.execution.get('draft')).toMatchObject({selection:{variant:'B',contentRevision:s.revision},revision:1});
    expect(s.poster.getSchedule('draft')).toMatchObject({params:before.params,runAt:before.runAt,authorityKind:'autonomy'});
    const snapshot={row:s.poster.getSchedule('draft'),execution:s.execution.get('draft')};
    const recreated=createPageCampaignOperations({...s.deps,draft:s.draft,media:s.media}) as any;
    for(let i=0;i<10;i++)expect(await recreated.optimize(s.lease,before.campaignId,'draft',before.revision,s.scheduleInput.grantId,1)).toEqual(result);
    expect({row:s.poster.getSchedule('draft'),execution:s.execution.get('draft')}).toEqual(snapshot);
    expect(s.db.query('SELECT * FROM page_campaign_decisions')).toHaveLength(1);
    expect(s.db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
});
it.each(['missing_planned_time','insufficient','unconfirmed','pruned','unknown_group','changed_revision'])('optimizeKeepsWithoutMutation %s',async reason=>{
    const s=await optimizationSetup(reason!=='missing_planned_time');
    if(reason!=='insufficient')s.pair();
    if(reason==='unconfirmed'){s.add(6,'A',false);s.add(7,'A',false);}
    if(reason==='pruned')s.db.run('DELETE FROM research_items');
    if(reason==='unknown_group')s.db.run("UPDATE page_campaign_published SET record_json=json_remove(record_json,'$.comparison') WHERE result_id=1");
    if(reason==='changed_revision')s.db.run("UPDATE page_campaign_published SET record_json=json_set(record_json,'$.selection.contentRevision','old') WHERE result_id=1");
    const before=s.poster.getSchedule('draft');const result=await s.optimize();
    expect(result).toMatchObject({scheduleId:null,decision:{kind:'keep'}});
    if(reason==='missing_planned_time')expect(result.decision.reason).toBe(reason);
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toBeNull();
    expect(await s.optimize()).toEqual(result);
});
it.each(['minute','format','variant','publishedAt'])('partiallyMissingGroupingCannotImproveCoverage %s',async field=>{
    const s=await optimizationSetup();s.pair();s.add(6,'A',false);s.add(7,'A',false);
    const jsonPath=field==='publishedAt'?'$.publishedAt':field==='variant'?'$.selection.variant':`$.comparison.${field}`;
    s.db.run('UPDATE page_campaign_published SET record_json=json_remove(record_json,?) WHERE result_id IN (6,7)',[jsonPath]);
    const before=s.poster.getSchedule('draft');
    expect(await s.optimize()).toMatchObject({scheduleId:null,decision:{kind:'keep',reason:'unknown_comparison_provenance'}});
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toBeNull();
});
it.each(['slot','format','page','campaign'])('comparisonCannotBorrowOtherHistoricalFactorsOrScopes %s',async change=>{
    const s=await optimizationSetup();s.pair();
    if(change==='slot')s.db.run("UPDATE page_campaign_published SET record_json=json_set(record_json,'$.comparison.minute',720) WHERE result_id>100");
    if(change==='format')s.db.run("UPDATE page_campaign_published SET record_json=json_set(record_json,'$.comparison.format','video') WHERE result_id>100");
    if(change==='page')s.db.run("UPDATE page_campaign_published SET page_id='other' WHERE result_id>100");
    if(change==='campaign')s.db.run("UPDATE page_campaign_published SET campaign_id='other' WHERE result_id>100");
    const before=s.poster.getSchedule('draft');expect(await s.optimize()).toMatchObject({scheduleId:null,decision:{kind:'keep'}});
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toBeNull();
});
it.each(['draft','grant','lease','gate','owner'])('optimizationRejectsStaleAuthorityBeforeSavingDecision %s',async change=>{
    const s=await optimizationSetup();s.pair();
    if(change==='draft')s.poster.updateSchedule('draft',{runAt:now+240000},now);
    if(change==='grant')s.campaigns.revokeGrant(s.context,s.scheduleInput.grantId,1,now);
    if(change==='lease')s.db.run('UPDATE page_work_items SET claimed_at=claimed_at+1');
    if(change==='gate')s.deps.protectedWritesEnabled=()=>false;
    if(change==='owner')s.db.run("UPDATE page_work_resources SET work_id='other' WHERE resource_kind='draft'");
    const ops=createPageCampaignOperations({...s.deps,draft:s.draft,media:s.media});
    const before=s.poster.getSchedule('draft');
    await expect(ops.optimize(s.lease,s.row.campaignId!,'draft',s.row.revision,s.scheduleInput.grantId,1)).rejects.toBeDefined();
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.db.query('SELECT * FROM page_campaign_decisions')).toEqual([]);
});
it('promotionReplayDoesNotRequireANewUpdatePermission',async()=>{
    const s=await optimizationSetup();s.pair();const grant=s.campaigns.getGrant(s.scheduleInput.grantId)!;
    s.db.run('UPDATE page_campaign_grants SET policy_json=? WHERE id=?',[JSON.stringify({...grant.policy,actions:['schedulePost']}),grant.id]);
    const result=await s.optimize();expect(result.decision.kind).toBe('variant');
    expect(await s.optimize()).toEqual(result);
});
it('timeAdjustmentUsesOnlyAllowedMinuteOnExistingPlannedDay',async()=>{
    const s=await optimizationSetup();const grant=s.campaigns.getGrant(s.scheduleInput.grantId)!;
    s.db.run('UPDATE page_campaign_grants SET policy_json=? WHERE id=?',[JSON.stringify({...grant.policy,allowedMinutes:[600,720]}),grant.id]);
    s.deps.clock.minutes=(at=now)=>new Date(at).getHours()*60+new Date(at).getMinutes();
    const planned=new Date(now+86400000);planned.setHours(10,0,0,0);
    s.poster.updateSchedule('draft',{runAt:planned.getTime()},now);
    await s.operations.schedule(s.lease,{...s.scheduleInput,variant:'A',expectedDraftRevision:s.poster.getSchedule('draft')!.revision,runAt:planned.getTime()});
    const row=s.poster.getSchedule('draft')!;
    for(let i=1;i<=5;i++){s.add(i,'A',true,600);s.add(100+i,'A',true,720,s.revision,10);}
    const result=await s.operations.optimize(s.lease,row.campaignId!,'draft',row.revision,grant.id,1);
    expect(result.decision).toMatchObject({kind:'time',before:600,after:720});
    const changed=s.poster.getSchedule('draft')!;
    expect(new Date(changed.runAt!).getDate()).toBe(planned.getDate());
    expect(new Date(changed.runAt!).getHours()).toBe(12);
    expect(changed.params).toEqual(row.params);expect(s.execution.get('draft')!.selection.variant).toBe('A');
});
it('optimizeUpdatesReservedSelectionWithoutReorderingTextOrChangingTime',async()=>{
    const s=await optimizationSetup();s.pair();
    await s.operations.schedule(s.lease,{...s.scheduleInput,variant:'A',expectedDraftRevision:s.row.revision});
    const before=s.poster.getSchedule('draft')!;
    const result=await (s.operations as any).optimize(s.lease,before.campaignId,'draft',before.revision,s.scheduleInput.grantId,1);
    expect(result.decision).toMatchObject({kind:'variant',before:'A',after:'B'});
    expect(s.poster.getSchedule('draft')).toMatchObject({params:before.params,runAt:before.runAt});
    expect(s.execution.get('draft')).toMatchObject({selection:{variant:'B'},revision:2});
});
it.each(['grant','key','owner','effect','source'])('successfulOptimizeReplayRevalidates %s',async change=>{
    const s=await optimizationSetup();s.pair();await s.optimize();
    if(change==='grant')s.campaigns.revokeGrant(s.context,s.scheduleInput.grantId,1,now);
    if(change==='key')s.keys.revokeKey(s.receiver.id);
    if(change==='owner')s.poster.updateSchedule('draft',{runAt:now+240000},now);
    if(change==='effect')s.execution.beginSubmit('draft','controlled-run',now+120000);
    if(change==='source')s.db.run('DELETE FROM research_items');
    const before=s.poster.getSchedule('draft');await expect(s.optimize()).rejects.toBeDefined();
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.db.query('SELECT * FROM page_campaign_decisions')).toHaveLength(1);
});
it('decisionAndApplyRollbackTogetherIncludingLastMomentRevoke',async()=>{
    const s=await optimizationSetup();s.pair();const before=s.poster.getSchedule('draft');
    s.db.exec("CREATE TRIGGER reject_decision BEFORE INSERT ON page_campaign_decisions BEGIN SELECT RAISE(ABORT,'decision failure'); END");
    await expect(s.optimize()).rejects.toMatchObject({message:'decision failure',code:'SQLITE_CONSTRAINT_TRIGGER'});
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.execution.get('draft')).toBeNull();
    expect(s.db.query('SELECT * FROM page_campaign_decisions')).toEqual([]);
    s.db.exec('DROP TRIGGER reject_decision');
    s.deps.assertCurrent=()=>{if(!s.poster.getSchedule('draft')!.draft)throw new ControlError('FORBIDDEN','revoked before commit');};
    const ops=createPageCampaignOperations({...s.deps,draft:s.draft,media:s.media}) as any;
    await expect(ops.optimize(s.lease,s.row.campaignId,'draft',s.row.revision,s.scheduleInput.grantId,1)).rejects.toBeDefined();
    expect(s.poster.getSchedule('draft')).toEqual(before);expect(s.db.query('SELECT * FROM page_campaign_decisions')).toEqual([]);
});

const now = Date.parse('2026-10-28T10:00:00Z');
const dirs:string[]=[];
afterAll(() => dirs.forEach(dir => fs.rmSync(dir,{recursive:true,force:true})));
function setup() {
    const db = memoryDb(); const clock = {date:() => '2026-10-28', minutes:() => 600};
    const works = new PageWorkStore(db, clock); works.ensureSchema();
    const campaigns = new PageCampaignStore(db); campaigns.ensureSchema();
    new FacebookPosterStore(db).ensureSchema();
    const briefs = new DailyBriefStore(db, clock); briefs.saveBrief('profile', {time:'07:00', draftsPerDay:1}, now);
    briefs.upsertIdentity({profileId:'profile', kind:'page', pageId:'page', pageName:'Page', category:'', about:'', recentPosts:[], learnedAt:now, errorCode:'', error:''});
    const business = new PageBusinessStore(db); business.ensure('page', 'profile', now);
    business.setEnabled('page', true, 0, {confirmedAt:now, confirmationRef:'owner'});
    const context = {workspaceId:'workspace', dbPath:':memory:', pageId:'page', profileId:'profile'};
    const work = works.claimDue(context, now)!; const lease = {workId:work.id, claimedAt:work.claimedAt!};
    let active = true;
    const deps = {db, clock, principal:{kind:'page_runner' as const, keyId:'runner', workspaceId:'workspace', assignments:[{pageId:'page', profileIds:['profile']}]},
        context:() => context, now:() => now, assertCurrent:() => {if (!active) throw new ControlError('FORBIDDEN', 'stale');}, protectedWritesEnabled:() => true};
    const operations = createPageCampaignOperations(deps);
    const input = {name:'Pilot', goal:'Engagement', policy:{startsAt:now, expiresAt:now + 604800000, maxPostsPerDay:1, maxPostsTotal:7,
        allowedMinutes:[420], timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone, actions:['schedulePost' as const]}};
    return {db, campaigns, operations, deps, input, lease, context, revoke:() => {active = false;}};
}
async function scheduleSetup() {
    const s=setup(); const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-ops-')); dirs.push(baseDir);
    const poster=new FacebookPosterStore(s.db); const works=new PageWorkStore(s.db,s.deps.clock);
    const media=new InboxMediaStore(path.join(baseDir,'inbox'));
    const saved=await media.save('photo.jpg','image/jpeg',Readable.from(['original']));
    works.linkResource(s.lease.workId,{kind:'media',id:saved.mediaId});
    const draft={baseDir,maxSchedules:200,newId:()=>'draft',now:()=>now,
        env:{profileExists:()=>true,fileExists:fs.existsSync,fileSize:(p:string)=>fs.statSync(p).size}};
    const input={...s.input,policy:{...s.input.policy,allowedMinutes:[600],actions:['schedulePost' as const,'updateScheduledPost' as const]}};
    const proposal=s.operations.propose(s.lease,input,null);
    const accepted=s.campaigns.acceptProposal(s.context,proposal.id,1,{receiverKeyId:'receiver',confirmedAt:now,confirmationRef:'owner'},now);
    const row=saveDraft({...draft,store:poster},{params:{mode:'page',text:'Original',variants:['Second'],comment:'First comment',mediaIds:[saved.mediaId],
        mediaPaths:media.resolve([saved.mediaId]),profiles:[{profileId:'profile',targets:['https://www.facebook.com/']}]},campaignId:accepted.campaignId});
    works.linkResource(s.lease.workId,{kind:'draft',id:row.id});
    const execution=new PageCampaignExecutionStore(s.db,s.deps.clock); execution.ensureSchema();
    const operations=createPageCampaignOperations({...s.deps,draft,media} as any) as any;
    const scheduleInput={draftId:row.id,expectedDraftRevision:row.revision,campaignId:accepted.campaignId,grantId:accepted.grantId,
        expectedGrantRevision:1,runAt:now+120000,variant:'A',factIds:[]};
    return {...s,operations,poster,works,media,draft,execution,scheduleInput};
}
it('promoteIsAtomicIdempotentAndDoesNotForgeOwnerApproval',async()=>{
    const s=await scheduleSetup();
    const result=await s.operations.schedule(s.lease,s.scheduleInput);
    expect(s.poster.getSchedule(result.scheduleId)).toMatchObject({draft:false,enabled:true,authorityKind:'autonomy',runAt:now+120000});
    const before=s.execution.get(result.scheduleId);
    expect(before).toMatchObject({workId:s.lease.workId,status:'reserved',grantId:s.scheduleInput.grantId,revision:1});
    expect(await s.operations.schedule(s.lease,s.scheduleInput)).toEqual(result);
    expect(s.execution.get(result.scheduleId)).toEqual(before);
    expect(s.db.query<any>("SELECT * FROM control_events WHERE type='draft.approved'")).toEqual([]);
    expect(s.db.query<any>("SELECT * FROM control_events WHERE type='pageCampaigns.scheduleChanged'")).toHaveLength(1);
});
it('promotedContentUpdateIsAtomicAndBindsMediaBytes',async()=>{
    const s=await scheduleSetup(); const result=await s.operations.schedule(s.lease,s.scheduleInput);
    const before=s.execution.get(result.scheduleId)!;
    const {draftId:_draftId,expectedDraftRevision:_draftRevision,...input}=s.scheduleInput;
    const update={...input,expectedScheduleRevision:s.poster.getSchedule(result.scheduleId)!.revision,content:{text:'Replacement',variants:['Alternative'],comment:'New comment'}};
    const changed=await s.operations.updateSchedule(s.lease,result.scheduleId,before.revision,update);
    expect(s.execution.get(result.scheduleId)!.selection.contentRevision).not.toBe(before.selection.contentRevision);
    expect(s.execution.get(result.scheduleId)!.authorityFingerprint).not.toBe(before.authorityFingerprint);
    const snapshot={row:s.poster.getSchedule(result.scheduleId),execution:s.execution.get(result.scheduleId)};
    await expect(s.operations.updateSchedule(s.lease,result.scheduleId,before.revision,update)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(s.operations.updateSchedule(s.lease,result.scheduleId,changed.revision,{...update,expectedScheduleRevision:snapshot.row!.revision,content:{text:'Bad',mediaIds:['foreign']}})).rejects.toBeDefined();
    expect({row:s.poster.getSchedule(result.scheduleId),execution:s.execution.get(result.scheduleId)}).toEqual(snapshot);
    s.poster.updateSchedule(result.scheduleId,{nextRunAt:now+180000,lastRunId:'bookkeeping'},now);
    expect(s.execution.get(result.scheduleId)!.authorityFingerprint).toBe(snapshot.execution!.authorityFingerprint);
});
it.each(['text','comment','media'] as const)('replacementContentRevisionBindsEachContentChange(%s)',async change=>{
    const s=await scheduleSetup(); const result=await s.operations.schedule(s.lease,s.scheduleInput);
    const before=s.execution.get(result.scheduleId)!; const row=s.poster.getSchedule(result.scheduleId)!;
    const ids=row.params.mediaIds as string[];
    expect(ids).toHaveLength(1);
    if(change==='media') fs.writeFileSync(s.media.resolve(ids)[0],'changed source bytes');
    const {draftId:_draftId,expectedDraftRevision:_draftRevision,...input}=s.scheduleInput;
    await s.operations.updateSchedule(s.lease,row.id,before.revision,{...input,expectedScheduleRevision:row.revision,
        content:{text:change==='text'?'Changed text':'Original',variants:['Second'],comment:change==='comment'?'Changed comment':'First comment',mediaIds:ids}});
    expect(s.execution.get(row.id)!.selection.contentRevision).not.toBe(before.selection.contentRevision);
    expect(s.execution.get(row.id)!.authorityFingerprint).not.toBe(before.authorityFingerprint);
});
it('factsNeedConfirmedBasisAndContentRevisionCannotBeInjected',async()=>{
    const s=await scheduleSetup(); const business=new PageBusinessStore(s.db);
    const proposed=business.propose('page',{topic:'price',value:'100',reason:'unconfirmed',status:'hypothesis',sourceType:'page',sourceRef:'local',observedAt:now},1,now);
    await expect(s.operations.schedule(s.lease,{...s.scheduleInput,factIds:[proposed.facts[0].id]})).rejects.toMatchObject({code:'NEEDS_REVIEW'});
    await expect(s.operations.schedule(s.lease,{...s.scheduleInput,contentRevision:'forged'})).rejects.toMatchObject({code:'INVALID_PARAMS'});
    expect(s.poster.getSchedule('draft')!.draft).toBe(true); expect(s.execution.get('draft')).toBeNull();
    business.confirmFact('page',proposed.facts[0].id,2,{confirmedAt:now,confirmationRef:'owner'});
    const result=await s.operations.schedule(s.lease,{...s.scheduleInput,factIds:[proposed.facts[0].id]});
    expect(s.execution.get(result.scheduleId)!.selection.factIds).toEqual([proposed.facts[0].id]);
    const row=s.poster.getSchedule(result.scheduleId)!; const before=s.execution.get(row.id)!;
    const {draftId:_draftId,expectedDraftRevision:_draftRevision,...input}=s.scheduleInput;
    const pending=business.propose('page',{topic:'capacity',value:'Unknown',reason:'Needs confirmation',status:'hypothesis',sourceType:'page',sourceRef:'local',observedAt:now},3,now);
    const unconfirmed=pending.facts.find(f=>f.topic==='capacity')!;
    await expect(s.operations.updateSchedule(s.lease,row.id,before.revision,{...input,expectedScheduleRevision:row.revision,
        factIds:[unconfirmed.id],content:{text:'Must remain review'}})).rejects.toMatchObject({code:'NEEDS_REVIEW'});
    expect(s.poster.getSchedule(row.id)).toEqual(row); expect(s.execution.get(row.id)).toEqual(before);
    s.db.run('UPDATE page_business_facts SET value=? WHERE id=?',['Changed confirmed basis',proposed.facts[0].id]);
    await expect(s.operations.updateSchedule(s.lease,row.id,before.revision,{...input,expectedScheduleRevision:row.revision,
        factIds:[proposed.facts[0].id]})).rejects.toMatchObject({code:'CONFLICT'});
    expect(s.poster.getSchedule(row.id)).toEqual(row); expect(s.execution.get(row.id)).toEqual(before);
});
it('reservationAndPromotionRollBackTogetherOnWriteFailure',async()=>{
    const s=await scheduleSetup(); const before=s.poster.getSchedule('draft');
    s.db.exec("CREATE TRIGGER reject_promotion BEFORE UPDATE ON fb_poster_schedules WHEN NEW.draft=0 BEGIN SELECT RAISE(ABORT,'promotion failure'); END");
    await expect(s.operations.schedule(s.lease,s.scheduleInput)).rejects.toMatchObject({message:'promotion failure',code:'SQLITE_CONSTRAINT_TRIGGER'});
    expect(s.poster.getSchedule('draft')).toEqual(before); expect(s.execution.get('draft')).toBeNull();
});
it('cancelIsIdempotentAndSharedOwnerEditCannotRenewAutonomy',async()=>{
    const s=await scheduleSetup(); const result=await s.operations.schedule(s.lease,s.scheduleInput);
    for(let i=0;i<10;i++) s.operations.cancelSchedule(s.lease,result.scheduleId,result.revision);
    expect(s.execution.get(result.scheduleId)).toMatchObject({status:'cancelled',revision:2});
    expect(s.poster.getSchedule(result.scheduleId)).toMatchObject({enabled:false,nextRunAt:null});
    const other=await scheduleSetup(); const scheduled=await other.operations.schedule(other.lease,other.scheduleInput);
    const row=other.poster.getSchedule(scheduled.scheduleId)!;
    other.poster.updateSchedule(row.id,{runAt:now+240000,enabled:true,nextRunAt:now+240000},now);
    expect(other.execution.get(row.id)!.status).toBe('cancelled');
    expect(other.poster.getSchedule(row.id)!.authorityKind).toBe('owner');
    await expect(other.operations.updateSchedule(other.lease,row.id,1,{...other.scheduleInput,expectedScheduleRevision:other.poster.getSchedule(row.id)!.revision})).rejects.toBeDefined();
});
it('genericOwnerCampaignEditRevokesOnlyItsAuthorityWithoutRegranting',async()=>{
    const s=await scheduleSetup(); const result=await s.operations.schedule(s.lease,s.scheduleInput);
    const owner=createCampaignOperations({store:()=>s.poster,now:()=>now,newId:()=> 'owner-campaign',reschedule:()=>{}});
    const unrelated=owner.create({name:'Independent owner',goal:'Manual'}).campaign;
    s.poster.createSchedule({id:'owner',name:'Owner schedule',kind:'once',params:{mode:'page',text:'Manual',profiles:[{profileId:'profile',targets:['https://www.facebook.com/']}]},
        runAt:now+240000,days:[],time:'',enabled:true,nextRunAt:now+240000,createdAt:now,campaignId:s.scheduleInput.campaignId});
    const before=s.poster.getSchedule('owner');
    const proposal=s.operations.propose(s.lease,{...s.input,name:'Other managed'},null);
    const other=s.campaigns.acceptProposal(s.context,proposal.id,1,{receiverKeyId:'receiver',confirmedAt:now,confirmationRef:'other'},now);
    owner.update({id:s.scheduleInput.campaignId,goal:'Owner changed goal'});
    expect(s.campaigns.getGrant(s.scheduleInput.grantId)).toMatchObject({status:'revoked',revision:2});
    expect(s.execution.get(result.scheduleId)!.status).toBe('cancelled');
    expect(s.poster.getSchedule('owner')).toEqual(before);
    expect(s.poster.getCampaign(unrelated.id)).toMatchObject({goal:'Manual',status:'active'});
    expect(s.campaigns.getLink(s.scheduleInput.campaignId)!.revision).toBe(2);
    expect(s.campaigns.getGrant(other.grantId)).toMatchObject({status:'active',revision:1});
});
it('mediaByteChangesInvalidateContentRevisionAndStaleAuthority',async()=>{
    const s=await scheduleSetup(); const result=await s.operations.schedule(s.lease,s.scheduleInput);
    const before=s.execution.get(result.scheduleId)!;
    const row=s.poster.getSchedule(result.scheduleId)!;
    fs.writeFileSync(resolveScheduleMedia(s.draft.baseDir,row.id,row.params.mediaPaths as string[])[0],'changed bytes');
    const {draftId:_draftId,expectedDraftRevision:_draftRevision,...input}=s.scheduleInput;
    await expect(s.operations.updateSchedule(s.lease,row.id,before.revision,{...input,expectedScheduleRevision:row.revision})).rejects.toMatchObject({code:'CONFLICT'});
    expect(s.execution.get(row.id)).toEqual(before);
});

it('proposal CAS and redacted campaign reads survive pruning without transferring owners', () => {
    const s = setup(); const proposal = s.operations.propose(s.lease, s.input, null);
    expect(proposal).toMatchObject({revision:1, status:'pending'});
    expect(() => s.operations.propose(s.lease, s.input, null)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    const accepted = s.campaigns.acceptProposal(s.context, proposal.id, 1, {receiverKeyId:'receiver', confirmationRef:'private', confirmedAt:now}, now);
    s.db.run('DELETE FROM page_work_items');
    const view = s.operations.get('page', accepted.campaignId);
    expect(view.grants).toHaveLength(1); expect(JSON.stringify(view)).not.toMatch(/receiverKeyId|confirmationRef|private/);
    expect(s.operations.list('page').campaigns).toHaveLength(1);
    expect(s.db.query('SELECT * FROM page_work_resources')).toEqual([]);
    expect(() => s.operations.get('other', accepted.campaignId)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
    s.revoke(); expect(() => s.operations.list('page')).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
});
it('rejects policy exceeding the lower daily brief limit before persisting', () => {
    const s = setup();
    expect(() => s.operations.propose(s.lease, {...s.input, policy:{...s.input.policy, maxPostsPerDay:2}}, null)).toThrow(expect.objectContaining({code:'INVALID_PARAMS'}));
    expect(s.campaigns.listProposals(s.context)).toEqual([]);
});
it('post-write current-context check rolls back proposal and event together', () => {
    const s = setup(); const before = s.db.query('SELECT * FROM control_events');
    s.deps.assertCurrent = () => {if (s.campaigns.listProposals(s.context).length) throw new ControlError('FORBIDDEN', 'stale');};
    expect(() => s.operations.propose(s.lease, s.input, null)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
    expect(s.campaigns.listProposals(s.context)).toEqual([]); expect(s.db.query('SELECT * FROM control_events')).toEqual(before);
});
it('unknown owner fields and absent gate never grant authority', () => {
    const s = setup();
    expect(() => s.operations.propose(s.lease, {...s.input, owner:true} as any, null)).toThrow(expect.objectContaining({code:'INVALID_PARAMS'}));
    s.deps.protectedWritesEnabled = () => false;
    expect(() => s.operations.propose(s.lease, s.input, null)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
    expect(s.campaigns.list(s.context)).toEqual([]);
});
