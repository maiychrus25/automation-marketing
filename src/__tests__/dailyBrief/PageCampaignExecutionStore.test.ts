import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { planScheduleUpdate } from '../../services/facebookPoster/scheduleUpdate';
import { PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL } from '../../services/facebookPoster/schema';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import type { CampaignExecution } from '../../models/pageCampaigns';

const now = Date.parse('2026-10-28T10:00:00Z');
const clock = {date:(n:number) => new Date(n).toISOString().slice(0,10), minutes:() => 600};
const scope = {workspaceId:'workspace', pageId:'page', profileId:'profile'};
const dirs:string[] = [];
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, {recursive:true, force:true})));
function disk(file:string) {
    const raw = new Database(file);
    const db:SqlDatabase = {exec:s => {raw.exec(s);}, run:(s,p=[]) => {raw.prepare(s).run(...p);},
        runInsert:(s,p=[]) => Number(raw.prepare(s).run(...p).lastInsertRowid), transaction:fn => raw.transaction(fn)(),
        query:(s,p=[]) => [...raw.prepare(s).all(...p)] as any, queryOne:(s,p=[]) => raw.prepare(s).get(...p) as any};
    return {raw, db};
}
function setup(db=memoryDb(), daily=1) {
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const works = new PageWorkStore(db, clock); works.ensureSchema();
    const campaigns = new PageCampaignStore(db); campaigns.ensureSchema();
    const briefs = new DailyBriefStore(db, clock); briefs.saveBrief('profile', {time:'07:00', draftsPerDay:daily}, now);
    briefs.upsertIdentity({profileId:'profile', kind:'page', pageId:'page', pageName:'Page', category:'', about:'', recentPosts:[], learnedAt:now, errorCode:'', error:''});
    const business = new PageBusinessStore(db); business.ensure('page','profile',now);
    business.setEnabled('page',true,0,{confirmedAt:now, confirmationRef:'owner'});
    const work = works.claimDue({...scope, dbPath:'test'},now)!;
    const policy = {startsAt:now, expiresAt:now + 7*86400000, maxPostsPerDay:daily, maxPostsTotal:7,
        allowedMinutes:[600], timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone, actions:['schedulePost' as const,'updateScheduledPost' as const]};
    function grant(name:string) {
        const proposal = campaigns.saveProposal(scope,{workId:work.id,claimedAt:work.claimedAt!},{name,goal:'Engagement',policy},null,now);
        return campaigns.acceptProposal(scope,proposal.id,1,{receiverKeyId:'receiver',confirmedAt:now,confirmationRef:name},now);
    }
    const accepted = grant('Pilot');
    const store = new PageCampaignExecutionStore(db,clock); store.ensureSchema();
    function input(id:string, day=0, authority=accepted):CampaignExecution {
        const runAt = now + 120000 + day*86400000;
        poster.createSchedule({id,name:id,kind:'once',params:{mode:'page',text:'Hello',profiles:[{profileId:'profile',targets:['https://www.facebook.com/']}]},
            runAt,days:[],time:'',enabled:false,draft:true,nextRunAt:null,createdAt:now,campaignId:authority.campaignId});
        return {...scope,scheduleId:id,workId:work.id,campaignId:authority.campaignId,grantId:authority.grantId,grantRevision:1,
            runnerKeyId:'runner',authorityFingerprint:'hash',selection:{variant:'A',contentRevision:'content',factIds:[]},
            plannedDate:clock.date(runAt),actualDate:null,status:'reserved',runId:null,resultId:null,revision:1};
    }
    return {db,poster,works,work,campaigns,briefs,policy,grant,store,input,accepted};
}
it('capturesComparisonFromRunBeforeSubmitAndNeverFromLaterSchedule',()=>{
    const s=setup();s.store.reserve(s.input('captured'),now);
    s.poster.createRun({id:'captured-run',kind:'post',mode:'page',params:{mode:'page',text:'Hello',mediaPaths:['captured.mp4'],profiles:[{profileId:'profile',targets:['https://www.facebook.com/']}]},startedAt:now+120000,scheduleId:'captured',campaignId:s.accepted.campaignId});
    const submitted=s.store.beginSubmit('captured','captured-run',now+120000);
    expect(submitted).toMatchObject({comparison:{format:'video',minute:600}});
    s.db.run("UPDATE fb_poster_schedules SET params_json=? WHERE id='captured'",[JSON.stringify({mediaPaths:['later.jpg']})]);
    s.store.settle('captured','uncertain',null,now+120000);
    expect(s.store.get('captured')).toMatchObject({comparison:{format:'video',minute:600}});
    const resultId=s.poster.addResult({runId:'captured-run',profileId:'profile',profileName:'',targetUrl:'https://www.facebook.com/',targetName:'',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'',createdAt:now+120000});
    s.store.settle('captured','posted',resultId,now+120000);
    expect(s.campaigns.listPublished(scope,s.accepted.campaignId)).toEqual([expect.objectContaining({comparison:{format:'video',minute:600},selection:{variant:'A',contentRevision:'content',factIds:[]},postId:null,sourceRef:null,reason:'unconfirmed_post_target'})]);
    const missing=setup();missing.store.reserve(missing.input('unknown'),now);
    expect((missing.store.beginSubmit('unknown','missing-run',now+120000) as any).comparison).toBeNull();
});
it('twoReservationsCannotSpendOneSlotAcrossConnectionsAndGrants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'campaign-quota-')); dirs.push(dir);
    const first = disk(path.join(dir,'quota.sqlite')); const s = setup(first.db);
    const second = disk(path.join(dir,'quota.sqlite'));
    try {
        const other = new PageCampaignExecutionStore(second.db,clock);
        const another = s.grant('Another');
        const candidates = [s.input('one'), s.input('two',0,another)];
        const winners = candidates.filter((input,index) => {try {(index ? other:s.store).reserve(input,now); return true;} catch {return false;}});
        expect(winners).toHaveLength(1);
        expect(other.get(winners[0].scheduleId)).toEqual(s.store.get(winners[0].scheduleId));
    } finally {second.raw.close(); first.raw.close();}
});
it('concurrentConnectionsHaveOnlyOneQuotaWinner', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-contention-')); dirs.push(dir);
    const file=path.join(dir,'quota.sqlite'); const opened=disk(file); const s=setup(opened.db);
    const candidates=[s.input('one'),s.input('two',0,s.grant('Another'))]; opened.raw.close();
    const barrier=new SharedArrayBuffer(8); const workers:Worker[]=[];
    const script=`
        const {workerData:d,parentPort}=require('worker_threads');
        const fs=require('fs'), ts=require(d.typescript);
        require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText,f);
        const Database=require(d.sqlite); const raw=new Database(d.file,{timeout:5000});
        const db={exec:s=>raw.exec(s),run:(s,p=[])=>raw.prepare(s).run(...p),runInsert:(s,p=[])=>Number(raw.prepare(s).run(...p).lastInsertRowid),
            transaction:fn=>raw.transaction(fn)(),query:(s,p=[])=>raw.prepare(s).all(...p),queryOne:(s,p=[])=>raw.prepare(s).get(...p)};
        const {PageCampaignExecutionStore}=require(d.store);
        const clock={date:n=>new Date(n).toISOString().slice(0,10),minutes:()=>600};
        parentPort.postMessage({ready:true}); Atomics.wait(new Int32Array(d.barrier),1,0);
        try {new PageCampaignExecutionStore(db,clock).reserve(d.input,d.now); parentPort.postMessage({winner:true});}
        catch(e) {parentPort.postMessage({winner:false,code:e.code,message:e.message});}
        finally {raw.close();}
    `;
    try {
        const results=candidates.map(input=>new Promise<any>((resolve,reject)=>{
            const worker=new Worker(script,{eval:true,workerData:{file,input,now,barrier,typescript:require.resolve('typescript'),sqlite:require.resolve('better-sqlite3'),
                store:path.resolve(__dirname,'../../services/dailyBrief/PageCampaignExecutionStore.ts')}});
            workers.push(worker); worker.on('error',reject);
            worker.on('message',message=>{
                if(message.ready) {
                    if(Atomics.add(new Int32Array(barrier),0,1)===1) {Atomics.store(new Int32Array(barrier),1,1); Atomics.notify(new Int32Array(barrier),1);}
                } else resolve(message);
            });
        }));
        const settled=await Promise.all(results);
        expect(settled.filter(result=>result.winner)).toHaveLength(1);
        expect(settled.filter(result=>!result.winner)).toEqual([expect.objectContaining({code:'LIMIT_EXCEEDED'})]);
    } finally {await Promise.all(workers.map(worker=>worker.terminate()));}
},30000);

it('grantLifetimeLimitAndCancelReleaseExactlyOnce', () => {
    const s = setup(undefined,2);
    const cancelled = s.input('cancelled'); s.store.reserve(cancelled,now);
    for (let i=0;i<10;i++) s.store.cancel(cancelled.scheduleId,1,now);
    expect(s.store.get('cancelled')).toMatchObject({status:'cancelled',revision:2});
    for (let i=0;i<7;i++) s.store.reserve(s.input(`post-${i}`,Math.floor(i/2)),now);
    expect(() => s.store.reserve(s.input('eighth',4),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('submittingAndUncertainPersistWithoutReleasingQuota', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-recovery-')); dirs.push(dir);
    const file=path.join(dir,'quota.sqlite'); const first=disk(file); const s=setup(first.db);
    s.store.reserve(s.input('one'),now);
    const submitting=s.store.beginSubmit('one','run-1',now+120000);
    expect(submitting).toMatchObject({status:'submitting',actualDate:'2026-10-28',runId:'run-1'});
    expect(() => s.store.cancel('one',submitting.revision,now)).toThrow();
    first.raw.close(); const reopened=disk(file);
    try {
        const recovered=new PageCampaignExecutionStore(reopened.db,clock);
        recovered.settle('one','uncertain',null,now+120000);
        expect(recovered.get('one')).toMatchObject({status:'uncertain',runId:'run-1'});
        const before=recovered.get('one'); recovered.settle('one','uncertain',null,now+120000);
        expect(recovered.get('one')).toEqual(before);
        const poster=new FacebookPosterStore(reopened.db);
        poster.createSchedule({...poster.getSchedule('one')!,id:'second',draft:true,enabled:false,nextRunAt:null});
        expect(() => recovered.reserve({...before!,scheduleId:'second',status:'reserved',actualDate:null,runId:null,resultId:null,revision:1},now))
            .toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
    } finally {reopened.raw.close();}
});
it('multiProfileOwnerScheduleReservesEveryPossiblePageEffect',()=>{
    const s=setup(undefined,2); s.input('owner'); const row=s.poster.getSchedule('owner')!;
    s.briefs.upsertIdentity({profileId:'second-profile',kind:'page',pageId:'page',pageName:'Page',category:'',about:'',recentPosts:[],learnedAt:now,errorCode:'',error:''});
    s.poster.updateSchedule('owner',{draft:false,enabled:true,nextRunAt:now+120000,params:{...row.params,profiles:[{profileId:'profile',targets:['https://www.facebook.com/']},{profileId:'second-profile',targets:['https://www.facebook.com/']}]}},now);
    const before=s.poster.getSchedule('owner');
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow(); expect(s.poster.getSchedule('owner')).toEqual(before);
});
it('ownerScheduleKeepsPriorityAndDefaultAuthority', () => {
    const s=setup(); s.input('owner');
    s.poster.updateSchedule('owner',{draft:false,enabled:true,nextRunAt:now+120000},now);
    const before=s.poster.getSchedule('owner');
    expect(before).toMatchObject({authorityKind:'owner'});
    expect(() => s.store.reserve(s.input('autonomy'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
    expect(s.poster.getSchedule('owner')).toEqual(before);
});
it('ownerPostedRunAndRecurringOccurrenceAreNotDoubleCounted',()=>{
    const s=setup(undefined,2); s.input('owner');
    const postedTime=[new Date(now).getHours(),new Date(now).getMinutes()].map(value=>String(value).padStart(2,'0')).join(':');
    s.poster.updateSchedule('owner',{draft:false,kind:'recurring',days:[0,1,2,3,4,5,6],time:postedTime,enabled:true,nextRunAt:now,lastRunId:'owner-run'},now);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:s.poster.getSchedule('owner')!.params,startedAt:now,scheduleId:'owner'});
    s.poster.addResult({runId:'owner-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    expect(s.store.reserve(s.input('one'),now)).toMatchObject({status:'reserved'});
    expect(()=>s.store.reserve(s.input('two'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('retimedOwnerRecurringOccurrenceIsAdditionalToItsPostedRunToday',()=>{
    const s=setup(undefined,2); s.input('owner');
    const localTime=(ms:number)=>{const d=new Date(ms);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
    s.poster.updateSchedule('owner',{draft:false,kind:'recurring',runAt:null,days:[0,1,2,3,4,5,6],time:localTime(now),enabled:true,nextRunAt:now,lastRunId:'owner-run'},now);
    const consumed=s.poster.getSchedule('owner')!;
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:consumed.params,startedAt:now,scheduleId:'owner'});
    s.poster.addResult({runId:'owner-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    s.poster.finishRun('owner-run','done','',now);
    s.poster.updateSchedule('owner',planScheduleUpdate(consumed,{time:localTime(now+2*3600000)},now+60000),now+60000);
    const retimed=s.poster.getSchedule('owner')!;
    expect(retimed.nextRunAt).toBe(now+2*3600000);
    expect(()=>s.store.reserve(s.input('autonomy'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
    expect(s.poster.getSchedule('owner')).toEqual(retimed);
    expect(s.store.get('autonomy')).toBeNull();
});
it('differentScheduleLastRunCannotDeduplicateAnOwnerOccurrence',()=>{
    const s=setup(undefined,2); s.input('owner');
    s.poster.updateSchedule('owner',{draft:false,enabled:true,nextRunAt:now,lastRunId:'other-run'},now);
    s.poster.createRun({id:'other-run',kind:'post',mode:'page',params:s.poster.getSchedule('owner')!.params,startedAt:now,scheduleId:'other-schedule'});
    s.poster.addResult({runId:'other-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    s.poster.finishRun('other-run','done','',now);
    expect(()=>s.store.reserve(s.input('autonomy'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('runningOwnerRunConsumesSlotBeforeItsResultArrives',()=>{
    const s=setup(); s.input('owner');
    const row=s.poster.getSchedule('owner')!;
    s.poster.updateSchedule(row.id,{draft:false,enabled:true,nextRunAt:null,lastRunId:'owner-run'},now);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:row.params,startedAt:now,scheduleId:'owner'});
    expect(()=>s.store.reserve(s.input('one'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('interruptedOwnerWithoutResultMustNotReleaseAutonomyQuota',()=>{
    const s=setup(); s.input('owner');
    const row=s.poster.getSchedule('owner')!;
    s.poster.updateSchedule(row.id,{draft:false,enabled:true,nextRunAt:null,lastRunId:'owner-run'},now);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:row.params,startedAt:now,scheduleId:'owner'});
    expect(s.poster.failInterruptedRuns(now+1000)).toBe(1);
    expect(s.db.queryOne<{status:string}>("SELECT status FROM fb_poster_runs WHERE id='owner-run'")?.status).toBe('failed');
    expect(()=>s.store.reserve(s.input('after-restart'),now)).toThrow();
    expect(s.store.get('after-restart')).toBeNull();
});
it('historicalOwnerPostCannotDisappearWhenItsProfileLearnsAnotherPage',()=>{
    const s=setup(); s.input('owner');
    const row=s.poster.getSchedule('owner')!;
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:row.params,startedAt:now,scheduleId:'owner'});
    s.poster.addResult({runId:'owner-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    s.poster.finishRun('owner-run','done','',now);
    const historical=s.db.query('SELECT * FROM fb_poster_results');
    s.briefs.upsertIdentity({profileId:'profile',kind:'page',pageId:'another-page',pageName:'Another',category:'',about:'',recentPosts:[],learnedAt:now+1000,errorCode:'',error:''});
    expect(()=>s.store.reserve(s.input('after-identity-change'),now)).toThrow();
    expect(s.store.get('after-identity-change')).toBeNull();
    expect(s.db.query('SELECT * FROM fb_poster_results')).toEqual(historical);
});
it('multipleOwnerResultsInOneRunConsumeSeparatePossibleEffects',()=>{
    const s=setup(undefined,2); s.input('owner');
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:[{profileId:'profile'},{profileId:'second-profile'}]},startedAt:now});
    for (const profileId of ['profile','second-profile']) s.poster.addResult({runId:'owner-run',profileId,profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    s.poster.finishRun('owner-run','done','',now);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it('interruptedMultiProfileRunChargesAllPossibleEffectsOnLaterDate',()=>{
    const s=setup(undefined,2);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:[{profileId:'profile'},{profileId:'second-profile'}]},startedAt:now-86400000});
    s.poster.failInterruptedRuns(now);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it('interruptedOwnerWithMalformedCardinalityFailsClosed',()=>{
    const s=setup(undefined,2);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:null},startedAt:now});
    s.poster.failInterruptedRuns(now);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it('unfinishedOwnerRunKeepsCapacityOnFutureReservedDates',()=>{
    const s=setup();
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:[{profileId:'profile'}]},startedAt:now});
    expect(()=>s.store.reserve(s.input('tomorrow',1),now)).toThrow();
});
it('completedOwnerWithMissingResultsDoesNotProveNoEffect',()=>{
    const s=setup();
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:[{profileId:'profile'}]},startedAt:now});
    s.poster.finishRun('owner-run','done','',now);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it.each(['failed','unrecognized'])('ownerResultWithoutReliableNoEffectEvidenceKeepsCapacity(%s)',outcome=>{
    const s=setup();
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:{profiles:[{profileId:'profile'}]},startedAt:now});
    s.poster.addResult({runId:'owner-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome,error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    s.poster.finishRun('owner-run','failed','',now);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it('orphanOwnerResultCannotDisappearFromConservativeAccounting',()=>{
    const s=setup();
    s.db.exec('PRAGMA foreign_keys=OFF');
    s.poster.addResult({runId:'missing-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow();
});
it('ownerTakeoverResultsStillConsumePageQuotaAfterAutonomyWasCancelled',()=>{
    const s=setup(); const input=s.input('taken-over'); s.store.reserve(input,now);
    s.poster.updateAutonomySchedule('taken-over',{draft:false,enabled:true,nextRunAt:now+120000},now,1);
    s.poster.updateSchedule('taken-over',{enabled:false,nextRunAt:null},now);
    s.poster.createRun({id:'owner-run',kind:'post',mode:'page',params:s.poster.getSchedule('taken-over')!.params,startedAt:now,scheduleId:'taken-over'});
    s.poster.addResult({runId:'owner-run',profileId:'profile',profileName:'Owner',targetUrl:'https://www.facebook.com/',targetName:'Page',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:null,commentStatus:'not_requested',identity:'Page',createdAt:now});
    expect(()=>s.store.reserve(s.input('one'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('markedAutonomyWithoutExecutionCannotDisappearFromQuotaAccounting',()=>{
    const s=setup(); s.input('orphan');
    s.poster.updateAutonomySchedule('orphan',{draft:false,enabled:true,nextRunAt:now+120000},now,1);
    expect(()=>s.store.reserve(s.input('one'),now)).toThrow(expect.objectContaining({code:'CONFLICT'}));
});
it.each([
    {name:'disabled',enabled:false,draft:false,nextRunAt:null},
    {name:'draft',enabled:false,draft:true,nextRunAt:null},
    {name:'not-due',enabled:true,draft:false,nextRunAt:now+86400000},
])('recreatedJournalCannotEraseInactiveSubmittingAuthority($name)',state=>{
    const s=setup(); const input=s.input('lost-authority'); s.store.reserve(input,now);
    s.poster.updateAutonomySchedule(input.scheduleId,{draft:false,enabled:true,nextRunAt:now+120000},now,1);
    s.store.beginSubmit(input.scheduleId,'submitted-run',now+120000);
    const {name:_name,...flags}=state;
    s.poster.updateAutonomySchedule(input.scheduleId,flags,now,2);
    const marked=s.poster.getSchedule(input.scheduleId);
    const candidate=s.input('candidate');
    expect(()=>s.store.reserve(candidate,now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
    s.db.exec('DROP TABLE page_campaign_executions');
    s.db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
    expect(()=>s.store.reserve(candidate,now)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(s.poster.getSchedule(input.scheduleId)).toEqual(marked);
    expect(s.poster.getSchedule('candidate')).toMatchObject({draft:true,enabled:false,authorityKind:'owner'});
});
it('explicitJournalInstallationRefusesToReplaceLostAuthorityWithEmptyHistory',()=>{
    const s=setup(); const input=s.input('lost-authority'); s.store.reserve(input,now);
    s.poster.updateAutonomySchedule(input.scheduleId,{draft:false,enabled:true,nextRunAt:now+120000},now,1);
    s.store.beginSubmit(input.scheduleId,'submitted-run',now+120000);
    s.poster.updateAutonomySchedule(input.scheduleId,{enabled:false,nextRunAt:null},now,2);
    s.db.exec('DROP TABLE page_campaign_executions');
    expect(()=>s.store.ensureSchema()).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(s.db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='page_campaign_executions'")!.n).toBe(0);
});
it('journalValidationPreservesExistingPageScopeChecks',()=>{
    const s=setup(); const input=s.input('wrong-scope'); s.store.reserve(input,now);
    s.poster.updateAutonomySchedule(input.scheduleId,{draft:false,enabled:true,nextRunAt:now+120000},now,1);
    s.db.run("UPDATE page_campaign_executions SET page_id='other',execution_json=json_set(execution_json,'$.pageId','other') WHERE schedule_id=?",[input.scheduleId]);
    expect(()=>s.store.reserve(s.input('candidate'),now)).toThrow(expect.objectContaining({code:'CONFLICT'}));
});
it('unknownPageOnSameProfileBlocksAutonomyWithoutChangingOwner',()=>{
    const s=setup(); s.input('owner'); s.poster.updateSchedule('owner',{draft:false,enabled:true,nextRunAt:now+120000},now);
    const before=s.poster.getSchedule('owner'); s.db.run('DELETE FROM fb_page_identities');
    expect(()=>s.store.reserve(s.input('autonomy'),now)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(s.poster.getSchedule('owner')).toEqual(before);
});
it('lowerActiveGrantCapAppliesAcrossCampaignsAndProfiles',()=>{
    const s=setup(undefined,2); const other=s.grant('Another');
    const grant=s.campaigns.getGrant(other.grantId)!;
    s.db.run('UPDATE page_campaign_grants SET policy_json=? WHERE id=?',[JSON.stringify({...grant.policy,maxPostsPerDay:1}),other.grantId]);
    s.store.reserve(s.input('one'),now);
    expect(()=>s.store.reserve(s.input('two'),now)).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});

it('staleCASAndDateOrTimeZoneChangesDoNotMutateReservation', () => {
    const s=setup(); const input=s.input('one'); s.store.reserve(input,now); const before=s.store.get('one');
    expect(() => s.store.reserve({...input,revision:3},now)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(() => s.store.beginSubmit('one','run',now+86400000)).toThrow(expect.objectContaining({code:'CONFLICT'}));
    expect(s.store.get('one')).toEqual(before);
    s.db.run('UPDATE page_campaign_grants SET policy_json=? WHERE id=?',[JSON.stringify({...s.policy,timeZone:'Etc/GMT+12'}),s.accepted.grantId]);
    expect(() => s.store.beginSubmit('one','run',now+120000)).toThrow();
    expect(s.store.get('one')).toEqual(before);
});
// Background-jobs concurrency: a run whose execution belongs to another Page is skipped only while that reservation charges it.
function foreignExecution(s:ReturnType<typeof setup>, id:string, profileId:string, pageId:string) {
    const runAt=now+120000;
    s.poster.createSchedule({id,name:id,kind:'once',params:{mode:'page',text:'Other',profiles:[{profileId,targets:['https://www.facebook.com/']}]},
        runAt,days:[],time:'',enabled:false,draft:true,nextRunAt:null,createdAt:now,campaignId:`${id}-campaign`});
    const execution:CampaignExecution={...scope,pageId,profileId,scheduleId:id,workId:`${id}-work`,campaignId:`${id}-campaign`,grantId:`${id}-grant`,grantRevision:1,
        runnerKeyId:'runner',authorityFingerprint:'hash',selection:{variant:'A',contentRevision:'content',factIds:[]},
        plannedDate:clock.date(runAt),actualDate:null,status:'reserved',runId:null,resultId:null,revision:1};
    s.db.run(`INSERT INTO page_campaign_executions (workspace_id,page_id,profile_id,work_id,campaign_id,grant_id,planned_date,actual_date,status,revision,execution_json,schedule_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[scope.workspaceId,pageId,profileId,execution.workId,execution.campaignId,execution.grantId,execution.plannedDate,null,'reserved',1,JSON.stringify(execution),id]);
    s.poster.updateAutonomySchedule(id,{draft:false,enabled:true,nextRunAt:null},now,1);
    return s.poster.getSchedule(id)!;
}
function submitOwn(s:ReturnType<typeof setup>) {
    s.store.reserve(s.input('own'),now);
    s.poster.createRun({id:'own-run',kind:'post',mode:'page',params:s.poster.getSchedule('own')!.params,startedAt:now+120000,scheduleId:'own',campaignId:s.accepted.campaignId});
    return () => s.store.beginSubmit('own','own-run',now+120000);
}
it('invalidatedForeignExecutionDoesNotHideARunningOwnerRunOfThisPage',()=>{
    const s=setup(); const submit=submitOwn(s);
    const row=foreignExecution(s,'foreign','profile','page-b');
    s.poster.updateSchedule(row.id,{enabled:true},now);
    expect(s.poster.getSchedule('foreign')!.authorityKind).toBe('owner');
    expect(s.db.queryOne<{status:string;page_id:string}>("SELECT status,page_id FROM page_campaign_executions WHERE schedule_id='foreign'")).toEqual({status:'cancelled',page_id:'page-b'});
    s.poster.createRun({id:'foreign-run',kind:'post',mode:'page',params:row.params,startedAt:now+60000,scheduleId:'foreign'});
    expect(submit).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
it('reservedRunOfAnotherPageBeforeSubmitIsNotChargedToThisPage',()=>{
    const s=setup(); const submit=submitOwn(s);
    s.briefs.upsertIdentity({profileId:'profile-b',kind:'page',pageId:'page-b',pageName:'B',category:'',about:'',recentPosts:[],learnedAt:now,errorCode:'',error:''});
    const row=foreignExecution(s,'foreign','profile-b','page-b');
    s.poster.createRun({id:'foreign-run',kind:'post',mode:'page',params:row.params,startedAt:now+60000,scheduleId:'foreign'});
    expect(submit()).toMatchObject({status:'submitting',runId:'own-run'});
});
it('reservedRunOfThisPageBeforeSubmitStillCountsAgainstThisPage',()=>{
    const s=setup(undefined,2); const submit=submitOwn(s);
    const row=foreignExecution(s,'same-page','profile','page');
    s.poster.createRun({id:'same-run',kind:'post',mode:'page',params:row.params,startedAt:now+60000,scheduleId:'same-page'});
    expect(submit).toThrow(expect.objectContaining({code:'LIMIT_EXCEEDED'}));
});
