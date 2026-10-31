import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { buildCampaignReport } from '../../services/dailyBrief/pageCampaignMetrics';
import { ResearchStore } from '../../services/research/ResearchStore';
import * as metrics from '../../services/dailyBrief/pageCampaignMetrics';
import type { CampaignObservation } from '../../models/pageCampaigns';

const comparisonNow=Date.parse('2026-10-28T10:00:00Z');
function comparison(measured=5,eligible=6) {
    const observations:CampaignObservation[]=[];
    const cohorts=['A','B'].map((key,index)=>{
        const ids=Array.from({length:eligible},(_,i)=>index*100+i+1);
        const refs:string[]=[];
        ids.slice(0,measured).forEach(resultId=>{
            const sourceRef=`scan-${resultId}`;refs.push(sourceRef);
            observations.push({resultId,sourceRef,postId:String(resultId),postUrl:`https://www.facebook.com/67890/posts/${resultId}`,
                pageId:'67890',campaignId:'campaign',publishedAt:comparisonNow-96*3600000,observedAt:comparisonNow-24*3600000,
                milestoneMinutes:4320,status:'measured',reason:'',reactions:index?10:1,comments:0,shares:0});
        });
        return {kind:'variant' as const,key,format:'text' as const,contentRevision:'revision',eligibleResultIds:ids,observationRefs:refs};
    });
    const input={observations,current:{variant:'A' as const,contentRevision:'revision',factIds:[]},currentMinute:600,allowedMinutes:[600,720],now:comparisonNow};
    const choose=()=> (metrics as any).chooseCampaignAdjustment(input,cohorts);
    return {input,cohorts,choose};
}
describe('Conservative campaign adjustment',()=>{
    it.each([[5,6,'variant'],[4,5,'keep'],[5,7,'keep'],[8,10,'variant']])('fiveSamplesAndEightyPercentBoundary %i/%i', (measured,eligible,kind)=>{
        const f=comparison(measured as number,eligible as number);
        expect(f.choose()).toMatchObject({kind,...(kind==='variant'?{before:'A',after:'B'}:{})});
        expect(f.choose().sampleSizes).toMatchObject({'variant:A':measured,'variant:B':measured});
    });
    it.each([[72*3600000,'variant'],[96*3600000,'variant'],[72*3600000-1,'keep'],[96*3600000+1,'keep']])('ageWindowAndLookbackAreExact %i',(age,kind)=>{
        const f=comparison();f.input.observations.forEach(o=>o.observedAt=o.publishedAt!+Number(age));
        f.input.now=comparisonNow+1;
        expect(f.choose().kind).toBe(kind);
    });
    it('otherMilestonesDoNotConflictWithComparisonSnapshots',()=>{
        const f=comparison();const baseline=f.choose();
        expect(baseline).toMatchObject({kind:'variant',before:'A',after:'B',sampleSizes:{'variant:A':5,'variant:B':5},coverage:{'variant:A':5/6,'variant:B':5/6}});
        const comparisonRows=[...f.input.observations];
        for(const row of comparisonRows)for(const milestoneMinutes of [60,1440] as const){
            const sourceRef=`${row.sourceRef}-${milestoneMinutes}`;
            f.input.observations.push({...row,milestoneMinutes,sourceRef,observedAt:row.publishedAt!+milestoneMinutes*60000,reactions:999});
            f.cohorts.find(c=>c.eligibleResultIds.includes(row.resultId))!.observationRefs.push(sourceRef);
        }
        expect(f.choose()).toEqual(baseline);
        f.input.observations.push(...comparisonRows.map(row=>({...row})));
        expect(f.choose()).toEqual(baseline);
        f.input.observations=f.input.observations.filter(row=>row.milestoneMinutes!==4320);
        expect(f.choose()).toMatchObject({kind:'keep',sampleSizes:{'variant:A':0,'variant:B':0},coverage:{'variant:A':0,'variant:B':0},observationRefs:[]});
    });
    it.each(['count','status','age'])('conflictingComparisonSnapshotCannotBeFilteredIntoSuccess %s',change=>{
        const f=comparison();const row={...f.input.observations[0]};
        if(change==='count')row.comments=null;
        if(change==='status')row.status='unavailable';
        if(change==='age')row.observedAt=row.publishedAt!+97*3600000;
        f.input.observations.push(row);
        expect(f.choose()).toMatchObject({kind:'keep',sampleSizes:{'variant:A':4,'variant:B':5},coverage:{'variant:A':4/6,'variant:B':5/6}});
        expect(f.choose().observationRefs).not.toContain(row.sourceRef);
    });
    it('oldSnapshotsAndRepeatedPollingDoNotBecomeIndependentPosts',()=>{
        const f=comparison(4,5);f.input.observations.push(...f.input.observations.map(o=>({...o})));
        expect(f.choose().kind).toBe('keep');
        const old=comparison();old.input.observations.forEach(o=>{o.observedAt-=29*86400000;o.publishedAt!-=29*86400000;});
        expect(old.choose().kind).toBe('keep');
    });
    it.each(['tie','missing','negative','unsafe','revision','format','single'])('tiesAndIncompleteCandidatesKeep %s',change=>{
        const f=comparison();
        if(change==='tie')f.input.observations.forEach(o=>o.reactions=1);
        if(change==='missing')f.input.observations[0].shares=null;
        if(change==='negative')f.input.observations[0].shares=-1;
        if(change==='unsafe')f.input.observations[0].shares=Number.MAX_SAFE_INTEGER+1;
        if(change==='revision')f.cohorts[1].contentRevision='changed';
        if(change==='format')(f.cohorts[1] as any).format='image';
        if(change==='single')f.cohorts.pop();
        expect(f.choose().kind).toBe('keep');
    });
    it.each(['invalid_time','unsafe_aggregate'])('invalidEvidenceCannotWin %s',kind=>{
        const f=comparison();
        if(kind==='invalid_time')f.input.observations[0].publishedAt=NaN;
        else f.input.observations.forEach(o=>o.reactions=Number.MAX_SAFE_INTEGER-(o.reactions===10?100:200));
        expect(f.choose().kind).toBe('keep');
    });
    it('oneFactorOnlyAndTimeMustBeAllowed',()=>{
        const f=comparison();const times=f.cohorts.map((c,i)=>({...c,kind:'time',key:String(i?720:600)}));
        expect((metrics as any).chooseCampaignAdjustment(f.input,[...f.cohorts,...times])).toMatchObject({kind:'variant',after:'B'});
        expect((metrics as any).chooseCampaignAdjustment(f.input,times)).toMatchObject({kind:'time',before:600,after:720});
        expect((metrics as any).chooseCampaignAdjustment({...f.input,allowedMinutes:[600]},times).kind).toBe('keep');
    });
});

const scope={workspaceId:'workspace',pageId:'67890',profileId:'profile'};
const hour=3600000;const publishedAt=1000000;const to=publishedAt+100*hour;
function setup() {
    const db=memoryDb();new FacebookPosterStore(db).ensureSchema();const store=new PageCampaignStore(db);store.ensureSchema();
    const research=new ResearchStore(db);research.ensureSchema();
    db.run("INSERT INTO page_campaign_links VALUES ('campaign',?,?,?,1,1,'proposal',?,NULL)",[scope.workspaceId,scope.pageId,scope.profileId,publishedAt]);
    const add=(id:number,age:number|null,counts:(number|null)[]|null,known=true)=>{
        const postUrl=known?`https://www.facebook.com/67890/posts/${id}`:null;
        db.run('INSERT INTO page_campaign_published (result_id,workspace_id,page_id,profile_id,campaign_id,record_json) VALUES (?,?,?,?,?,?)',
            [id,scope.workspaceId,scope.pageId,scope.profileId,'campaign',JSON.stringify({...scope,resultId:id,campaignId:'campaign',runId:`run-${id}`,scheduleId:`schedule-${id}`,runnerKeyId:'runner',grantId:'grant',publishedAt:age===null?null:publishedAt,postId:known?String(id):null,postUrl,sourceRef:known?'controlled-proof':null,reason:known?'':'unconfirmed_post_target',selection:{variant:'A',contentRevision:'revision',factIds:[]}})]);
        if(counts && age!==null){
            const observedAt=publishedAt+age*hour;const scanId=`controlled-scan-${id}`;
            store.reserveMeasurement(scope,'campaign',id,4320,scanId);
            research.createScan({id:scanId,source:'posts',query:postUrl!,params:{query:postUrl,profileIds:[scope.profileId]},profileIds:[scope.profileId],origin:'api',startedAt:observedAt});
            research.addItems(scanId,[{kind:'post',fbId:String(id),url:postUrl!,authorKind:'page',authorId:scope.pageId,reactions:counts[0],comments:counts[1],shares:counts[2]} as any],scope.profileId,observedAt);
            research.finishScan(scanId,'done','','',{},observedAt);
            store.recordObservation({resultId:id,postId:String(id),postUrl:postUrl!,pageId:scope.pageId,campaignId:'campaign',publishedAt,observedAt,milestoneMinutes:4320,sourceRef:scanId,status:counts.every(x=>x!==null)?'measured':'unavailable',reason:counts.every(x=>x!==null)?'':'missing_counts',reactions:counts[0],comments:counts[1],shares:counts[2]});
        }
    };
    const report=()=>buildCampaignReport({scope,campaignId:'campaign',from:0,to},db);
    return {db,store,research,add,report};
}
describe('Campaign metrics',()=>{
    it('missingDeletedLateStayInDenominator',()=>{
        const f=setup();for(let i=1;i<=8;i++)f.add(i,72,[0,0,0]);f.add(9,72,null,false);f.add(10,72,null);
        expect(f.report()).toMatchObject({published:10,eligible:10,measured:8,coverage:0.8,totalEngagement:null});
        f.add(11,97,[1,2,3]);
        expect(f.report()).toMatchObject({published:11,eligible:11,measured:8,lastObservedAt:publishedAt+97*hour});
        expect(f.report().missingReasons).toContain('outside_comparison_window');
        expect(f.report().observations).toEqual(expect.arrayContaining([expect.objectContaining({resultId:11,observedAt:publishedAt+97*hour,reactions:1,sourceAvailable:true})]));
        expect(f.report().measurementWindow).toEqual({milestoneMinutes:4320,minAgeHours:72,maxAgeHours:96});
    });
    it('zeroIsMeasuredButPartialCountsAreNotTotals',()=>{
        const f=setup();f.add(1,72,[0,0,0]);
        expect(f.report()).toMatchObject({measured:1,totalEngagement:0,coverage:1});
        f.add(2,72,[10,null,2]);expect(f.report()).toMatchObject({measured:1,totalEngagement:null,coverage:0.5});
    });
    it('unknownPublishedAtNeverEntersAgeCohortAndScopeSurvivesWorkPruning',()=>{
        const f=setup();f.add(1,null,null,false);
        expect(f.report()).toMatchObject({published:1,eligible:0,measured:0,coverage:null,totalEngagement:null});
        expect(f.report().missingReasons).toContain('unknown_published_at');
        expect(()=>buildCampaignReport({scope:{...scope,workspaceId:'other'},campaignId:'campaign',from:0,to},f.db)).toThrow();
    });
    it('leadWonIsNotRevenue',()=>{
        const f=setup();f.add(1,72,[1,2,3]);
        f.db.run("INSERT INTO fb_poster_leads (id,comment_key,post_url,profile_id,status,detected_at,updated_at) VALUES (1,'comment','https://www.facebook.com/67890/posts/1?tracking=ignored','profile','won',?,?)",[publishedAt,publishedAt]);
        expect(f.report()).toMatchObject({uniqueLeads:1,finance:{status:'unavailable',reason:'missing_financial_source'}});
    });
    it('prunedSourceCannotRemainMeasured',()=>{
        const f=setup();f.add(1,72,[1,2,3]);f.db.run('DELETE FROM research_items');
        expect(f.report()).toMatchObject({published:1,eligible:1,measured:0,totalEngagement:null});
        expect(f.report().missingReasons).toContain('source_unavailable');
    });
});
