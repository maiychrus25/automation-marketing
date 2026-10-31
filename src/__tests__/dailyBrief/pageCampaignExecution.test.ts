import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb, runWithFakeTimers } from '../facebookPoster/helpers';
import { postToTargets } from '../../services/facebookPoster/postToTargets';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { createPageCampaignOperations } from '../../services/dailyBrief/pageCampaignOperations';
import { createPageCampaignExecutionGuard, recoverPageCampaignExecutions } from '../../services/dailyBrief/pageCampaignExecution';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { saveDraft } from '../../services/facebookPoster/drafts';
import { resolveScheduleMedia } from '../../services/facebookPoster/scheduleMedia';
import { FacebookPosterScheduler } from '../../services/facebookPoster/FacebookPosterScheduler';
import { ProfileJobQueue } from '../../services/browser/ProfileJobQueue';

const now=Date.parse('2026-10-28T10:00:00Z');
const dirs:string[]=[];
afterAll(()=>dirs.forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
async function setup(withMedia=false) {
    const db=memoryDb(); db.exec(CONTROL_SCHEMA_SQL);
    const clock={date:(n:number)=>new Date(n).toISOString().slice(0,10),minutes:()=>600};
    const scope={workspaceId:'workspace',pageId:'12345',profileId:'profile'};
    const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-effect-')); dirs.push(baseDir);
    const poster=new FacebookPosterStore(db); poster.ensureSchema();
    const works=new PageWorkStore(db,clock); works.ensureSchema();
    const campaigns=new PageCampaignStore(db); campaigns.ensureSchema();
    const briefs=new DailyBriefStore(db,clock); briefs.saveBrief('profile',{time:'10:00',draftsPerDay:1},now);
    briefs.upsertIdentity({profileId:'profile',kind:'page',pageId:'12345',pageName:'Page',category:'',about:'',recentPosts:[],learnedAt:now,errorCode:'',error:''});
    const business=new PageBusinessStore(db); business.ensure('12345','profile',now); business.setEnabled('12345',true,0,{confirmedAt:now,confirmationRef:'owner'});
    const work=works.claimDue({...scope,dbPath:':memory:'},now)!;
    const control=new ControlStore(db); const assignments=[{pageId:'12345',profileIds:['profile']}];
    const runner=control.createKey('Runner',{kind:'page_runner',workspaceId:'workspace',assignments});
    const receiver=control.createKey('Receiver',{kind:'page_receiver',workspaceId:'workspace',assignments,ownerChatId:'1',ownerSenderId:'2'});
    const proposal=campaigns.saveProposal(scope,{workId:work.id,claimedAt:work.claimedAt!},{name:'Pilot',goal:'Engagement',policy:{startsAt:now,expiresAt:now+604800000,maxPostsPerDay:1,maxPostsTotal:7,allowedMinutes:[600],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,actions:['schedulePost']}},null,now);
    const accepted=campaigns.acceptProposal(scope,proposal.id,1,{receiverKeyId:receiver.id,confirmedAt:now,confirmationRef:'owner'},now);
    const draft={baseDir,store:poster,maxSchedules:200,newId:()=> 'draft',now:()=>now,env:{profileExists:()=>true,fileExists:fs.existsSync,fileSize:(p:string)=>fs.statSync(p).size}};
    const source=path.join(baseDir,'fixture.jpg'); if(withMedia) fs.writeFileSync(source,'synthetic media');
    const row=saveDraft(draft,{params:{mode:'page',text:'Original',variants:['Second'],comment:'First',mediaPaths:withMedia?[source]:[],profiles:[{profileId:'profile',targets:['https://www.facebook.com/']}]},campaignId:accepted.campaignId});
    works.linkResource(work.id,{kind:'draft',id:row.id});
    const executions=new PageCampaignExecutionStore(db,clock); executions.ensureSchema();
    let current=true; let time=now; let gate=true;
    const assertCurrent=()=>{if(!current) throw new Error('retired');};
    const operations=createPageCampaignOperations({db,clock,principal:{kind:'page_runner',keyId:runner.id,workspaceId:'workspace',assignments},context:()=>({...scope,dbPath:':memory:'}),now:()=>time,assertCurrent,protectedWritesEnabled:()=>gate,draft,media:{resolve:()=>[]}});
    await operations.schedule({workId:work.id,claimedAt:work.claimedAt!},{draftId:row.id,expectedDraftRevision:row.revision,campaignId:accepted.campaignId,grantId:accepted.grantId,expectedGrantRevision:1,runAt:now+120000,variant:'B',factIds:[]});
    time=now+120000;
    const stored=poster.getSchedule('draft')!;
    const payload={...stored.params,mediaPaths:resolveScheduleMedia(baseDir,stored.id,(stored.params.mediaPaths ?? []) as string[]),kind:'post',campaignId:accepted.campaignId} as any;
    const deps={db,clock,baseDir,workspaceId:'workspace',profileExists:()=>true,assertCurrent,now:()=>time,protectedWritesEnabled:()=>gate,payload};
    const page=(pageId='12345')=>({url:()=> 'https://www.facebook.com/',content:async()=>{
        const actor={id:'99999',is_profile_plus:true,delegate_page_id:pageId};
        const data={viewer:{actor},user:{id:'99999',delegate_page:{id:pageId,name:'Page',viewer:{actor}}}};
        return '<script type="application/json">'+JSON.stringify({define:[['CurrentUserInitialData',[],{USER_ID:'99999'}]],require:[['RelayPrefetchedStreamCache','next',[],[null,{__bbox:{result:{data}}}]]]})+'</script>';
    }} as any);
    return {db,poster,executions,control,runner,receiver,deps,payload,page,guard:()=>createPageCampaignExecutionGuard(deps,'draft','run'),retire:()=>{current=false;},disable:()=>{gate=false;}};
}
it.each(['direct','fallback'] as const)('browserEffectAndCrashRecoveryUseRealGuard(%s)',async route=>{
    const s=await setup(); const guard=s.guard(); let clicks=0;
    s.poster.createRun({id:'run',kind:'post',mode:'page',params:s.payload,startedAt:now+120000,scheduleId:'draft',campaignId:s.payload.campaignId});
    const click=async()=>{expect(s.executions.get('draft')!.status).toBe('submitting'); clicks++;};
    const page={...s.page(),goto:async()=>{},$:async()=>null,on:()=>{},off:()=>{},
        evaluate:async(fn:{name:string})=>['composerIsOpenInPage','focusEditorInPage'].includes(fn.name) || fn.name==='markPublishButtonInPage' && route==='direct',
        locator:()=>({first:()=>({click})}),keyboard:{type:async()=>{}},
        waitForSelector:async(_selector:string,opts?:{state?:string})=>{if(opts?.state==='hidden') throw new Error('no acknowledgement'); return {click};}};
    const ctx={cookies:async()=>[{name:'c_user',value:'synthetic'}],close:async()=>{}};
    const result=await runWithFakeTimers(()=>postToTargets({text:'Second',comment:'First',targets:['https://www.facebook.com/'],minDelay:0,maxDelay:0},
        {launch:async()=>({ctx,page} as any),getIsStopping:()=>false,sendLog:()=>{},updateProgress:()=>{},autonomyGuard:guard}));
    expect(clicks).toBe(1); expect(result.results[0].errorCode).toBe('uncertain_after_submit');
    recoverPageCampaignExecutions(s.deps);
    expect(s.executions.get('draft')!.status).toBe('uncertain'); expect(()=>s.guard()).toThrow();
    expect(s.poster.getSchedule('draft')!.enabled).toBe(false);
});
it('reservedAutonomyRunIsNotCountedAgainAsUnknownOwnerAtSubmit',async()=>{
    const s=await setup(); const guard=s.guard();
    s.poster.createRun({id:'run',kind:'post',mode:'page',params:s.payload,startedAt:now+120000,scheduleId:'draft',campaignId:s.payload.campaignId});
    await guard.beforeEffect(s.page(),'publish');
    expect(s.executions.get('draft')!.status).toBe('submitting');
});
it('bookkeepingRevisionDoesNotInvalidateContentAuthority',async()=>{
    const s=await setup(); const guard=s.guard(); s.poster.updateSchedule('draft',{nextRunAt:null,lastRunId:'run'},now);
    await guard.beforeEffect(s.page(),'publish'); guard.assertCurrent();
    expect(s.executions.get('draft')).toMatchObject({status:'submitting',runId:'run'});
    expect(guard.variantIndex).toBe(1);
});
it.each(['text','mode','profiles','variants','comment'] as const)('changedPersistedPayloadIsRejected(%s)',async field=>{
    const s=await setup(); const guard=s.guard(); const row=s.poster.getSchedule('draft')!;
    s.db.run('UPDATE fb_poster_schedules SET params_json=? WHERE id=?',[JSON.stringify({...row.params,[field]:field==='profiles'?[]:'changed'}),'draft']);
    expect(()=>guard.assertCurrent()).toThrow(); expect(s.executions.get('draft')!.status).toBe('reserved');
});
it('mediaByteChangesInvalidateAuthorityBeforePublish',async()=>{
    const s=await setup(true); const guard=s.guard(); fs.writeFileSync(s.payload.mediaPaths[0],'different media');
    await expect(guard.beforeEffect(s.page(),'publish')).rejects.toThrow();
    expect(s.executions.get('draft')!.status).toBe('reserved');
});
it('selectedBrowserPayloadMustMatchAuthorizedVariantAndTarget',async()=>{
    const s=await setup(); const guard=s.guard();
    expect(()=>guard.assertPost({text:'Original',comment:'First',mediaPaths:[],targetUrl:'https://www.facebook.com/'})).toThrow();
    expect(()=>guard.assertPost({text:'Second',comment:'Injected',mediaPaths:[],targetUrl:'https://www.facebook.com/'})).toThrow();
    expect(()=>guard.assertPost({text:'Second',comment:'First',mediaPaths:['foreign.jpg'],targetUrl:'https://www.facebook.com/'})).toThrow();
    expect(()=>guard.assertPost({text:'Second',comment:'First',mediaPaths:[],targetUrl:'https://www.facebook.com/groups/1/'})).toThrow();
    expect(()=>guard.assertPost({text:'Second',comment:'First',mediaPaths:[],targetUrl:'https://www.facebook.com/'})).not.toThrow();
});
it('actualDispatchedPayloadCannotDifferFromAuthorizedContent',async()=>{
    const s=await setup(); s.payload.text='Injected'; expect(()=>s.guard()).toThrow();
});
it.each(['wrong','unknown'])('identityChangeUsesPostingBrowser(%s)',async kind=>{
    const s=await setup(); const page=kind==='wrong'?s.page('54321'):{url:()=> 'https://www.facebook.com/',content:async()=>''};
    await expect(s.guard().beforeEffect(page as any,'publish')).rejects.toThrow();
    expect(s.executions.get('draft')!.status).toBe('reserved');
});
it('revocationDuringIdentityAwaitPreventsSubmit',async()=>{
    const s=await setup(); const guard=s.guard(); const page=s.page(); const read=page.content;
    page.content=async()=>{const value=await read(); s.control.revokeKey(s.runner.id); return value;};
    await expect(guard.beforeEffect(page,'publish')).rejects.toThrow(); expect(s.executions.get('draft')!.status).toBe('reserved');
});
it('currentPageIdentityAloneCannotAuthorizeAnAutonomousCommentTarget',async()=>{
    const s=await setup(); const guard=s.guard(); await guard.beforeEffect(s.page(),'publish');
    await expect(guard.beforeEffect(s.page(),'firstComment')).rejects.toThrow();
    guard.settle('posted',null); expect(s.executions.get('draft')!.status).toBe('posted');
});
it('firstCommentHasOwnBarrierAndRevocationCannotErasePostedOutcome',async()=>{
    const s=await setup(); const guard=s.guard(); await guard.beforeEffect(s.page(),'publish');
    s.control.revokeKey(s.receiver.id);
    await expect(guard.beforeEffect(s.page(),'firstComment')).rejects.toThrow();
    guard.settle('posted',null); expect(s.executions.get('draft')!.status).toBe('posted');
});
it('crashAfterSubmitKeepsReservationAndStopsResend',async()=>{
    const s=await setup(); await s.guard().beforeEffect(s.page(),'publish');
    recoverPageCampaignExecutions(s.deps); expect(s.executions.get('draft')!.status).toBe('uncertain');
    expect(()=>s.guard()).toThrow();
});
it('recoveryKeepsExplicitlyMissedRunStoppedEvenWithinGrace',async()=>{
    const s=await setup();
    s.poster.recordScheduleRun({id:'missed',scheduleId:'draft',params:s.payload,at:now+120000,status:'missed',reason:'paused'});
    s.poster.updateSchedule('draft',{lastRunId:'missed',nextRunAt:null},now+120000);
    recoverPageCampaignExecutions(s.deps);
    expect(s.executions.get('draft')!.status).toBe('cancelled'); expect(s.poster.getSchedule('draft')!.enabled).toBe(false);
});
it('uncertainRecoveryRequiresExactScopedResultEvidence',async()=>{
    const s=await setup(); s.poster.createRun({id:'run',kind:'post',mode:'page',params:s.payload,startedAt:now+120000,scheduleId:'draft',campaignId:s.payload.campaignId});
    await s.guard().beforeEffect(s.page(),'publish'); s.executions.settle('draft','uncertain',null,now+120000);
    const add=(profileId:string)=>s.poster.addResult({runId:'run',profileId,profileName:'Page',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now+120000});
    add('other'); recoverPageCampaignExecutions(s.deps); expect(s.executions.get('draft')!.status).toBe('uncertain');
    const id=add('profile'); recoverPageCampaignExecutions({...s.deps,workspaceId:'other'});
    expect(s.executions.get('draft')!.status).toBe('uncertain');
    recoverPageCampaignExecutions(s.deps); expect(s.executions.get('draft')).toMatchObject({status:'posted',resultId:id});
});
it('deletedBrowserProfileInvalidatesLiveAuthority',async()=>{
    const s=await setup(); const guard=s.guard(); s.deps.profileExists=()=>false;
    expect(()=>guard.assertCurrent()).toThrow();
});
it('executionCannotStartBeforeScheduledTime',async()=>{
    const s=await setup(); expect(()=>createPageCampaignExecutionGuard({...s.deps,now:()=>now},'draft','run')).toThrow();
});
it('recoveryDoesNotReviveMissedReservation',async()=>{
    const s=await setup(); recoverPageCampaignExecutions({...s.deps,now:()=>now+240000});
    expect(s.executions.get('draft')!.status).toBe('cancelled'); expect(s.poster.getSchedule('draft')!.enabled).toBe(false);
});
it('retiredFactoryMustRejectBeforeReadingItsCapturedDatabase',async()=>{
    const s=await setup(); s.retire(); const query=jest.spyOn(s.db,'query');
    expect(()=>s.guard()).toThrow(); expect(query).not.toHaveBeenCalled();
});
it('recoveryRejectsIncompleteScheduleEnumeration',async()=>{
    const s=await setup(); const query=s.db.query.bind(s.db);
    jest.spyOn(s.db,'query').mockImplementation((sql:string,args?:unknown[])=>/FROM fb_poster_schedules s LEFT JOIN/i.test(sql)?[]:query(sql,args));
    expect(()=>recoverPageCampaignExecutions(s.deps)).toThrow();
});
it('retiredContextAndDisabledGateBlockNewEffects',async()=>{
    const s=await setup(); const guard=s.guard(); s.retire(); expect(()=>guard.assertCurrent()).toThrow();
    const other=await setup(); other.disable(); expect(()=>other.guard()).toThrow();
});
describe('autonomy preflight cost on resource pumps', () => {
    const PREFLIGHT_DENIED='Không kiểm được quyền lịch tự động';
    it('queuedAutonomyScheduleDoesNotHashMediaWhileBusyYetRevokedGrantIsRefusedBeforeStart',async()=>{
        const s=await setup(true); let busy=true; const started:string[]=[]; const missed:string[]=[];
        const scheduler=new FacebookPosterScheduler({store:s.poster,now:s.deps.now,setTimer:()=>({}),clearTimer:()=>{},isBusy:()=>busy,
            resolveParams:()=>s.payload,canStart:()=>true,startRun:(_p,id)=>{started.push(id);return {runId:'run'};},newId:()=> 'missed-id',
            onMissed:n=>missed.push(n.reason),onChanged:()=>{},
            // Same wiring as production: a scheduler-preflight guard over the captured campaign execution context.
            assertAutonomyCurrent:row=>createPageCampaignExecutionGuard(s.deps,row.id,'scheduler-preflight').assertCurrent()});
        const read=jest.spyOn(fs,'readFileSync');
        try {
            scheduler.start(); expect(scheduler.queuedIds()).toEqual(['draft']);
            read.mockClear();
            for(let i=0;i<20;i++) scheduler.onResourcesChanged();
            expect(read).not.toHaveBeenCalled();
            s.control.revokeKey(s.runner.id); busy=false; scheduler.onResourcesChanged();
            expect(started).toEqual([]); expect(missed).toEqual([PREFLIGHT_DENIED]); expect(scheduler.queuedIds()).toEqual([]);
        } finally { read.mockRestore(); scheduler.stop(); }
    });
    it('queuedAutonomyScheduleWithFreeSlotButBusyProfileDoesNotHashMediaUntilTheProfileFrees',async()=>{
        const s=await setup(true); let profileBusy=true; const started:string[]=[]; const missed:string[]=[];
        const preflight=jest.fn((row:any)=>createPageCampaignExecutionGuard(s.deps,row.id,'scheduler-preflight').assertCurrent());
        const scheduler=new FacebookPosterScheduler({store:s.poster,now:s.deps.now,setTimer:()=>({}),clearTimer:()=>{},isBusy:()=>false,
            canStartSchedule:()=>!profileBusy,canStart:()=>!profileBusy,
            resolveParams:()=>s.payload,startRun:(_p,id)=>{started.push(id);return {runId:'run'};},newId:()=> 'missed-id',
            onMissed:n=>missed.push(n.reason),onChanged:()=>{},
            assertAutonomyCurrent:preflight});
        const read=jest.spyOn(fs,'readFileSync');
        try {
            scheduler.start(); expect(scheduler.queuedIds()).toEqual(['draft']);
            read.mockClear(); preflight.mockClear();
            for(let i=0;i<20;i++) scheduler.onResourcesChanged();
            expect(read).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled(); expect(started).toEqual([]);
            s.control.revokeKey(s.runner.id); profileBusy=false; scheduler.onResourcesChanged();
            expect(preflight).toHaveBeenCalledTimes(1);
            expect(started).toEqual([]); expect(missed).toEqual([PREFLIGHT_DENIED]); expect(scheduler.queuedIds()).toEqual([]);
        } finally { read.mockRestore(); scheduler.stop(); }
    });
    it('autonomyRunWaitingForProfileDoesNotHashMediaOnPumpsYetRevokedGrantIsRefusedBeforeLaunch',async()=>{
        const s=await setup(true); const guard=s.guard();
        let held=true; const listeners=new Set<()=>void>(); const opened:string[]=[];
        // Native boundary only: one profile that is busy until released.
        const browser={onAvailabilityChanged:(fn:()=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);},
            canReserveAutomation:()=>!held,tryReserveAutomation:(profileId:string)=>held?null:{profileId},releaseAutomationReservation:()=>{},
            isRunning:()=>false,openForAutomation:async(id:string)=>{opened.push(id);return {context:{once(){}},close:async()=>{}};}} as any;
        const queue=new ProfileJobQueue({browser});
        const read=jest.spyOn(fs,'readFileSync');
        try {
            const waiting=queue.acquire({profileId:'profile',owner:{workspaceId:'workspace',generation:1,jobId:'run'},priority:'scheduled',
                signal:new AbortController().signal,assertCurrent:()=>guard.assertCurrent()}).catch(e=>e);
            read.mockClear();
            for(let i=0;i<20;i++) queue.notifyAvailability();
            expect(read).not.toHaveBeenCalled();
            s.control.revokeKey(s.runner.id); held=false; listeners.forEach(fn=>fn());
            expect(await waiting).toBeInstanceOf(Error);
            expect(opened).toEqual([]); expect(queue.isBusy()).toBe(false);
        } finally { read.mockRestore(); queue.retire(); }
    });
});
