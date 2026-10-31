import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { PageCampaignTracker, trackedMilestone, hasDueCampaignMilestone, dueCampaignPosts, TRACKED_STATS_WINDOW_MS } from '../../services/facebookPoster/PageCampaignTracker';
import { ResearchStore } from '../../services/research/ResearchStore';
import { ResearchService } from '../../services/research/ResearchService';
import type { CampaignExecution } from '../../models/pageCampaigns';

const scope = {workspaceId:'workspace',pageId:'67890',profileId:'profile'};
const publishedAt = 1000000;
const url = 'https://www.facebook.com/67890/posts/12345';
function setup(target: string | null = url) {
    const db=memoryDb(); const poster=new FacebookPosterStore(db); poster.ensureSchema();
    const store=new PageCampaignStore(db); store.ensureSchema();
    const executions=new PageCampaignExecutionStore(db); executions.ensureSchema();
    const researchStore=new ResearchStore(db); researchStore.ensureSchema();
    db.run("INSERT INTO page_campaign_links VALUES ('campaign',?,?,?,1,1,'proposal',?,NULL)",[scope.workspaceId,scope.pageId,scope.profileId,publishedAt]);
    poster.createRun({id:'run',kind:'post',mode:'page',params:{},startedAt:publishedAt-1,scheduleId:'schedule',campaignId:'campaign'});
    const resultId=poster.addResult({runId:'run',profileId:scope.profileId,profileName:'',targetUrl:'https://www.facebook.com/',targetName:'',outcome:'posted',error:'',errorCode:'',attempts:1,postUrl:target,commentStatus:'not_requested',identity:'',createdAt:publishedAt});
    const execution:CampaignExecution={...scope,scheduleId:'schedule',workId:'work',campaignId:'campaign',grantId:'grant',grantRevision:1,runnerKeyId:'runner',authorityFingerprint:'fingerprint',selection:{variant:'A',contentRevision:'revision',factIds:[]},plannedDate:'2026-01-01',actualDate:'2026-01-01',status:'submitting',runId:'run',resultId:null,revision:1};
    db.run('INSERT INTO page_campaign_executions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[execution.scheduleId,scope.workspaceId,scope.pageId,scope.profileId,execution.workId,execution.campaignId,execution.grantId,execution.plannedDate,execution.actualDate,execution.status,execution.revision,JSON.stringify(execution)]);
    executions.settle('schedule','posted',resultId,publishedAt);
    // Controlled current-publish proof only. Production settlement never supplies this evidence.
    if (target) store.registerPostedResult({...execution,status:'posted',resultId}, {postId:'12345',postUrl:target,sourceRef:'controlled-publish-proof'});
    return {db,store,researchStore,resultId,execution};
}
function collector(f:ReturnType<typeof setup>, rows: any[] = []) {
    const startedScans:string[]=[]; let idle=Promise.resolve();
    const research={reserveSearch(params:any,ownership:any) {
        ownership.assertCurrent();
        expect(params).toMatchObject({source:'posts',origin:'api',limit:10});
        expect(params.query).not.toContain('?');
        f.researchStore.createScan({id:ownership.scanId,source:'posts',query:params.query,params,profileIds:[scope.profileId],origin:'api',startedAt:publishedAt+3600000});
        return {scanId:ownership.scanId,start() {
            startedScans.push(ownership.scanId);
            idle=Promise.resolve().then(()=>{
                ownership.assertCurrent();
                f.researchStore.addItems(ownership.scanId,rows,scope.profileId,publishedAt+3600000);
                f.researchStore.finishScan(ownership.scanId,'done','','',{},publishedAt+3600000);
            });
        }};
    },whenIdle:()=>idle,cancelOwned:(_id:string)=>false};
    const tracker=new PageCampaignTracker({db:f.db,research,researchStore:f.researchStore,now:()=>publishedAt+3600000,assertCurrent:()=>{}});
    return {tracker,startedScans};
}
const item=(patch:any={})=>({kind:'post',fbId:'12345',url:url+'?tracking=ignored',authorKind:'page',authorId:'67890',reactions:0,comments:0,shares:0,...patch});

describe('Page campaign measurement',()=>{
    it('rolledBackReservationReleasesOnlyItsResearchAdmission',async()=>{
        const f=setup();let opens=0;
        const research=new ResearchService({store:f.researchStore,
            openSession:async()=>{opens++;throw new Error('must not open');},listProfiles:()=>[{id:scope.profileId,name:''}],isProfileBusy:()=>false,
            loginStates:()=>[],groupMembership:()=>({}),observeLogin(){},readConfig:()=>({excludedProfileIds:[],perProfileDailyCap:100}),emit(){},now:()=>publishedAt+3600000});
        const transaction=f.db.transaction;
        f.db.transaction=fn=>transaction(()=>{const value=fn();if(research.isRunning())throw new Error('commit failure');return value;});
        const tracker=new PageCampaignTracker({db:f.db,research,researchStore:f.researchStore,now:()=>publishedAt+3600000,assertCurrent(){}});
        await expect(tracker.collect(scope,'campaign',()=>{})).rejects.toThrow('commit failure');
        await new Promise(resolve=>setImmediate(resolve));
        expect(research.isRunning()).toBe(false);expect(research.isRunning()).toBe(false);expect(opens).toBe(0);
        expect(f.store.listMeasurements(scope,'campaign')).toEqual([]);
    });
    it('busyDoesNotConsumeAttemptOrCreateScan',async()=>{
        const f=setup();const research={reserveSearch(){throw new Error('busy');},whenIdle:async()=>{},cancelOwned:()=>false};
        const tracker=new PageCampaignTracker({db:f.db,research,researchStore:f.researchStore,now:()=>publishedAt+3600000,assertCurrent(){}});
        await expect(tracker.collect(scope,'campaign',()=>{})).rejects.toThrow('busy');
        expect(f.store.listMeasurements(scope,'campaign')).toEqual([]);expect(f.researchStore.countScans()).toBe(0);
    });
    it('oldTask4RecoverySettlesBeforeExplicitMeasurementSchemaAndBackfillsUnavailable',()=>{
        const f=setup(null);f.db.exec('DROP TABLE page_campaign_measurements; DROP TABLE page_campaign_published;');
        f.db.run("UPDATE page_campaign_executions SET status='submitting',revision=1,execution_json=?",[JSON.stringify(f.execution)]);
        new PageCampaignExecutionStore(f.db).settle('schedule','posted',f.resultId,publishedAt);
        expect(new PageCampaignExecutionStore(f.db).get('schedule')?.status).toBe('posted');
        expect(f.db.queryOne("SELECT name FROM sqlite_master WHERE name='page_campaign_published'")).toBeUndefined();
        f.store.ensureSchema();f.store.registerSettledResults(scope.workspaceId);
        expect(f.store.listPublished(scope,'campaign')).toMatchObject([{resultId:f.resultId,postId:null,reason:'unconfirmed_post_target'}]);
    });
    it('pagePostRegistersDurableMeasurement',()=>{
        const f=setup();
        expect(new PageCampaignStore(f.db).listPublished(scope,'campaign')).toMatchObject([{resultId:f.resultId,postId:'12345',postUrl:url,publishedAt}]);
        expect(f.db.query('SELECT * FROM fb_poster_post_tracking')).toEqual([]);
    });
    it('untrustedAndMissingTargetsRemainRegisteredWithoutInventedIds',()=>{
        const f=setup(null);
        expect(f.store.listPublished(scope,'campaign')).toMatchObject([{resultId:f.resultId,postId:null,postUrl:null,reason:'unconfirmed_post_target',publishedAt}]);
        expect(()=>f.store.listPublished({...scope,pageId:'other'},'campaign')).toThrow();
    });
    it('exactPostAndAuthorMatchOnly',async()=>{
        const f=setup();const {tracker,startedScans}=collector(f,[item({fbId:'444',url:'https://www.facebook.com/67890/posts/444'}),item({fbId:'555',authorKind:'person',authorId:'67890'}),item()]);
        expect(await tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER).map(x=>x.postId)).toEqual(['12345']);
        await tracker.collect(scope,'campaign',()=>{});
        expect(startedScans).toHaveLength(1);
    });
    it.each([{authorKind:'person'},{authorId:'other'},{authorKind:'unknown',authorId:'',placeId:'67890'}])('rejects mismatched author %j',async patch=>{
        const f=setup();const {tracker}=collector(f,[item(patch)]);
        expect(await tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
    });
    it('unsupportedLookupDoesNotTruncateOrSearch',async()=>{
        const f=setup('https://www.facebook.com/'+ 'a'.repeat(90)+'/posts/12345');const {tracker,startedScans}=collector(f);
        await tracker.collect(scope,'campaign',()=>{});
        expect(f.store.listMeasurements(scope,'campaign')[0].reason).toBe('unsupported_lookup_url');
        expect(startedScans).toHaveLength(0);
    });
    it('scanIdDependsOnlyOnCanonicalScopeNotCallerMetadata',async()=>{
        const first=collector(setup(),[item()]),second=collector(setup(),[item()]);
        await first.tracker.collect(scope,'campaign',()=>{});
        const extended={...scope,dbPath:'captured-path',revision:2};await second.tracker.collect(extended,'campaign',()=>{});
        expect(second.startedScans).toEqual(first.startedScans);
    });
    it.each(['interactive', 'background'] as const)('real research preserves %s priority and measured source',async priority=>{
        const f=setup();
        const priorities: string[] = [];
        const research=new ResearchService({store:f.researchStore,
            openSession:async(_id, _guard, context)=>{ priorities.push(context.priority); return {session:{open:async()=>{},ensureQuery:async()=>({friendlyName:'SearchCometResultsPaginatedResultsQuery',docId:'controlled-doc',variables:{args:{text:'',filters:[]}}}),
                call:async()=>JSON.stringify({data:{serpResponse:{results:{edges:[{rendering_strategy:{view_model:{click_model:{story:{post_id:'12345',url,
                    actors:[{__typename:'Page',id:scope.pageId}],feedback:{reaction_count:{count:0},comment_count:{total_count:0},share_count:{count:0}}}}}}}],page_info:{has_next_page:false,end_cursor:null}}}}})} as any,
                readIdentity:async()=>({kind:'page',pageId:scope.pageId}),close:async()=>{}}; },
            listProfiles:()=>[{id:scope.profileId,name:''}],isProfileBusy:()=>false,loginStates:()=>[],groupMembership:()=>({}),observeLogin(){},
            readConfig:()=>({excludedProfileIds:[],perProfileDailyCap:100}),emit(){},now:()=>publishedAt+3600000,sleep:async()=>{}});
        const tracker=new PageCampaignTracker({db:f.db,research,researchStore:f.researchStore,now:()=>publishedAt+3600000,assertCurrent(){}});
        expect(await tracker.collect(scope,'campaign',()=>{}, priority)).toEqual({checked:1,measured:1,unavailable:0});expect(research.isRunning()).toBe(false);
        expect(priorities).toEqual([priority]);
    });
    it('normalizesOnlyAnExactPagePrefixedPostId',async()=>{
        const f=setup();const {tracker}=collector(f,[item({fbId:'67890_12345'})]);
        expect(await tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
    });
    it('reconcilesACompletedOwnScanWithoutStartingAnother',async()=>{
        const f=setup();const first=collector(f,[item()]);await first.tracker.collect(scope,'campaign',()=>{});
        f.db.run('UPDATE page_campaign_measurements SET completed_at=NULL,observation_json=NULL');
        const resumed=collector(f,[]);expect(await resumed.tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
        expect(resumed.startedScans).toEqual([]);expect(f.researchStore.countScans()).toBe(1);
    });
    it('interruptedOwnScanIsUnavailableAndNeverBlindlyResubmitted',async()=>{
        const f=setup();const first=collector(f,[item()]);await first.tracker.collect(scope,'campaign',()=>{});
        f.db.run('UPDATE page_campaign_measurements SET completed_at=NULL,observation_json=NULL');
        f.db.run("UPDATE research_scans SET status='running'");
        const resumed=collector(f,[]);expect(await resumed.tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(f.store.listMeasurements(scope,'campaign')[0].reason).toBe('interrupted_scan');expect(resumed.startedScans).toEqual([]);
    });
    it('missingCountsRemainUnknown',async()=>{
        const f=setup();const {tracker}=collector(f,[item({reactions:10,comments:null,shares:2})]);
        expect(await tracker.collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)[0]).toMatchObject({reactions:10,comments:null,shares:2,status:'unavailable'});
    });
    it('cancellationAndRetirementDoNotPersistAfterAwait',async()=>{
        const f=setup();let current=true;
        const {tracker}=collector(f,[item()]);
        const pending=tracker.collect(scope,'campaign',()=>{if(!current)throw new Error('retired');});
        current=false;
        await expect(pending).rejects.toThrow('retired');
        await tracker.whenIdle();expect(tracker.isRunning()).toBe(false);
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
});

// Spec 2026-10-31 §4.5: a bound Page row is measured from fb_poster_post_stats only; no research, no runner-supplied counts.
const minute=60000;
function tracked(linkStatus:'known'|'missing'|'pending_approval'|'not_found',statsDone:string[]=[]) {
    const f=setup(null);const poster=new FacebookPosterStore(f.db);
    const known=linkStatus==='known';
    const row={resultId:f.resultId,runId:'run',scheduleId:'schedule',profileId:scope.profileId,targetKind:'page' as const,pageId:scope.pageId,
        groupUrl:'https://www.facebook.com/',groupId:'',postId:known?'12345':'',postUrl:known?url:null,postedAt:publishedAt,textHead:'',linkStatus,
        removedSuspected:false,lastSeenAt:null,lastCheckedAt:null,checkCount:0,nextCheckAt:null,statsDone};
    poster.createTracking(row);
    const stats=(at:number,counts:(number|null)[])=>poster.addPostStats(f.resultId,{capturedAt:at,reactions:counts[0],comments:counts[1],shares:counts[2]});
    // What PostTracker + onPagePostKnown do when the post is found: one stats row for the due milestones, then the binding.
    const find=(at:number,done:string[],counts:(number|null)[]|null)=>{
        poster.updateTracking(f.resultId,{linkStatus:'known',postId:'12345',postUrl:url,statsDone:done});
        if(counts)stats(at,counts);
        return new PageCampaignExecutionStore(f.db).bindTrackedPost({...row,linkStatus:'known',postId:'12345',postUrl:url},at,scope.workspaceId);
    };
    const tracker=(at:number)=>new PageCampaignTracker({db:f.db,now:()=>at,assertCurrent(){},researchStore:f.researchStore,
        research:{reserveSearch(){throw new Error('research must not run');},whenIdle:async()=>{},cancelOwned:()=>false}});
    const post=()=>f.store.listPublished(scope,'campaign')[0];
    return {...f,poster,stats,find,tracker,post};
}
function bound(statsDone:string[]=[],linkStatus:'known'|'not_found'='known') {
    const f=tracked('known',statsDone);
    expect(f.find(publishedAt,statsDone,null)).toBe('bound');
    if(linkStatus!=='known')f.poster.updateTracking(f.resultId,{linkStatus});
    return f;
}
describe('Page campaign measurement from tracked post stats',()=>{
    it('statsSourceRecordsMeasuredObservationAt4320',async()=>{
        const f=bound(['60m','1440m','4320m']);
        f.stats(publishedAt+60*minute+5*minute,[1,0,0]);f.stats(publishedAt+1440*minute+5*minute,[2,1,0]);
        const observedAt=publishedAt+4320*minute+5*minute;f.stats(observedAt,[5,2,1]);
        const at=publishedAt+4320*minute+10*minute;
        for(let i=0;i<3;i++)expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
        expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:0,measured:0,unavailable:0});
        const observations=f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER);
        expect(observations.map(o=>[o.milestoneMinutes,o.sourceRef,o.reactions])).toEqual([60,1440,4320].map((m,i)=>[m,`post-stats:${f.resultId}:${m}`,[1,2,5][i]]));
        expect(observations[2]).toEqual({resultId:f.resultId,postId:'12345',postUrl:url,pageId:scope.pageId,campaignId:'campaign',publishedAt,observedAt,
            milestoneMinutes:4320,sourceRef:`post-stats:${f.resultId}:4320`,status:'measured',reason:'',reactions:5,comments:2,shares:1});
        expect(f.store.observationSourceAvailable(observations[2],f.post())).toBe(true);
        expect(f.researchStore.countScans()).toBe(0);
    });
    it('statsSourcePendingUntilTrackerMarksMilestone',async()=>{
        const f=bound();const at=publishedAt+61*minute;
        expect(trackedMilestone(f.db,f.post(),60,at)).toEqual({status:'pending'});
        expect(hasDueCampaignMilestone(f.db,f.post(),[],at)).toBe(false);
        expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:0,measured:0,unavailable:0});
        expect(f.store.listMeasurements(scope,'campaign')).toEqual([]);
        f.poster.updateTracking(f.resultId,{statsDone:['60m']});
        expect(hasDueCampaignMilestone(f.db,f.post(),[],at)).toBe(true);
        // Past the 24 h window the milestone is decided even if the tracker never marked it.
        const late=bound();const after=publishedAt+60*minute+24*60*minute+1;
        expect(trackedMilestone(late.db,late.post(),60,after)).toEqual({status:'unavailable',reason:'exact_post_not_found'});
        expect(trackedMilestone(late.db,late.post(),1440,after)).toEqual({status:'pending'});
    });
    it('statsSourceUnavailableWhenMilestoneDoneWithoutSnapshot',async()=>{
        const f=bound(['60m']);const at=publishedAt+61*minute;
        expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(f.store.listMeasurements(scope,'campaign')).toEqual([{resultId:f.resultId,milestoneMinutes:60,scanId:`post-stats:${f.resultId}:60`,completedAt:at,reason:'exact_post_not_found'}]);
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([]);
        const lost=bound([],'not_found');
        expect(trackedMilestone(lost.db,lost.post(),60,at)).toEqual({status:'unavailable',reason:'exact_post_not_found'});
        const foreign=bound();foreign.db.run("UPDATE fb_poster_post_tracking SET page_id='other'");foreign.stats(publishedAt+65*minute,[1,1,1]);
        expect(trackedMilestone(foreign.db,foreign.post(),60,at)).toEqual({status:'unavailable',reason:'source_mismatch'});
        const group=bound();group.db.run("UPDATE fb_poster_post_tracking SET target_kind='group'");group.stats(publishedAt+65*minute,[1,1,1]);
        expect(trackedMilestone(group.db,group.post(),60,at)).toEqual({status:'unavailable',reason:'source_mismatch'});
    });
    it('nullCountsStayUnavailable',async()=>{
        const f=bound(['60m']);f.stats(publishedAt+65*minute,[null,3,0]);
        expect(await f.tracker(publishedAt+70*minute).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([expect.objectContaining({
            milestoneMinutes:60,status:'unavailable',reason:'missing_counts',reactions:null,comments:3,shares:0,sourceRef:`post-stats:${f.resultId}:60`})]);
    });
    it('unboundPostFoundAtMinute120KeepsMilestone60',async()=>{
        const f=tracked('missing');const at=publishedAt+61*minute;
        expect(hasDueCampaignMilestone(f.db,f.post(),[],at)).toBe(false);
        expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:0,measured:0,unavailable:0});
        expect(f.store.listMeasurements(scope,'campaign')).toEqual([]);
        expect(f.find(publishedAt+120*minute,['60m'],[3,1,0])).toBe('bound');
        expect(await f.tracker(publishedAt+121*minute).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([expect.objectContaining({
            milestoneMinutes:60,observedAt:publishedAt+120*minute,sourceRef:`post-stats:${f.resultId}:60`,status:'measured',reactions:3,comments:1,shares:0})]);
        expect(f.researchStore.countScans()).toBe(0);
    });
    it('unboundPostFoundWithin4320WindowMeasures4320',async()=>{
        const f=tracked('pending_approval');const at=publishedAt+4321*minute;
        // 60 and 1440 windows have passed without a link: recorded unavailable as before; 4320 still waits.
        for(let i=0;i<2;i++)expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(await f.tracker(at).collect(scope,'campaign',()=>{})).toEqual({checked:0,measured:0,unavailable:0});
        expect(f.store.listMeasurements(scope,'campaign').map(m=>[m.milestoneMinutes,m.reason])).toEqual([[60,'unconfirmed_post_target'],[1440,'unconfirmed_post_target']]);
        expect(f.find(publishedAt+4400*minute,['60m','1440m','4320m'],[7,2,1])).toBe('bound');
        expect(await f.tracker(publishedAt+4401*minute).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:1,unavailable:0});
        expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([expect.objectContaining({
            milestoneMinutes:4320,observedAt:publishedAt+4400*minute,sourceRef:`post-stats:${f.resultId}:4320`,status:'measured'})]);
    });
    it('notFoundOrExpiredUnboundPostIsUnavailableAndNeverMeasuredFromUnverifiedSource',async()=>{
        const lost=tracked('not_found');lost.stats(publishedAt+65*minute,[9,9,9]);
        expect(await lost.tracker(publishedAt+70*minute).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        expect(lost.store.listMeasurements(scope,'campaign')).toEqual([expect.objectContaining({milestoneMinutes:60,reason:'unconfirmed_post_target'})]);
        const late=tracked('missing');late.stats(publishedAt+65*minute,[9,9,9]);
        expect(await late.tracker(publishedAt+60*minute+TRACKED_STATS_WINDOW_MS+1).collect(scope,'campaign',()=>{})).toEqual({checked:1,measured:0,unavailable:1});
        for(const f of [lost,late]){
            expect(f.store.listObservations(scope,'campaign',0,Number.MAX_SAFE_INTEGER)).toEqual([]);
            expect(f.researchStore.countScans()).toBe(0);
        }
    });
    it('oneBrokenCampaignDoesNotHideOtherDueCampaigns',()=>{
        const f=bound(['60m']);const at=publishedAt+61*minute;
        f.db.run("INSERT INTO page_campaign_published (result_id,workspace_id,page_id,profile_id,campaign_id,record_json) VALUES (8001,?,?,?,'campaign','{broken')",[scope.workspaceId,scope.pageId,scope.profileId]);
        f.db.run("INSERT INTO page_campaign_links VALUES ('second',?,?,?,1,1,'proposal-2',?,NULL)",[scope.workspaceId,scope.pageId,scope.profileId,publishedAt]);
        f.db.run('INSERT INTO page_campaign_published (result_id,workspace_id,page_id,profile_id,campaign_id,record_json) VALUES (8002,?,?,?,?,?)',[scope.workspaceId,scope.pageId,scope.profileId,'second',
            JSON.stringify({...scope,resultId:8002,campaignId:'second',runId:'run-2',scheduleId:'schedule-2',runnerKeyId:'runner',grantId:'grant',selection:null,comparison:null,publishedAt,postId:null,postUrl:null,sourceRef:null,reason:'unconfirmed_post_target'})]);
        const errors:string[]=[];
        const due=[...dueCampaignPosts(f.db,scope.workspaceId,at,campaignId=>errors.push(campaignId))];
        expect(due.map(entry=>[entry.scope.campaignId,entry.post.resultId])).toEqual([['second',8002]]);
        expect(errors).toEqual(['campaign']);
    });
});
