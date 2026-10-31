import type { CampaignReport, CampaignScope, CampaignObservation, CampaignDraftSelection, CampaignCohort, CampaignDecisionInput } from '../../models/pageCampaigns';
import type { SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { PageCampaignStore, campaignPostTarget } from './PageCampaignStore';

export const CAMPAIGN_COMPARISON_MINUTES = 4320;
export const CAMPAIGN_COMPARISON_MAX_AGE_HOURS = 96;
export const CAMPAIGN_REPORT_WINDOW_DAYS = 28;

export const CAMPAIGN_MINIMUM_SAMPLES = 5;
export const CAMPAIGN_MINIMUM_COVERAGE = 0.8;

/** Cohorts are server-owned, already scoped and holding the other factor fixed. */
export function chooseCampaignAdjustment(input:{observations:CampaignObservation[];current:CampaignDraftSelection;currentMinute:number;allowedMinutes:number[];now:number},cohorts:CampaignCohort[]):CampaignDecisionInput {
    const evidence:CampaignDecisionInput={kind:'keep',before:null,after:null,observationRefs:[],sampleSizes:{},coverage:{},reason:'insufficient_evidence'};
    for(const kind of ['variant','time'] as const){
        const candidates=cohorts.filter(c=>c.kind===kind);
        const scores=new Map<string,number>();let complete=true;
        const seenResults=new Set<number>();
        for(const cohort of candidates){
            const label=`${kind}:${cohort.key}`,ids=[...new Set(cohort.eligibleResultIds)];
            const snapshots=ids.flatMap(id=>{
                if(seenResults.has(id))complete=false;
                seenResults.add(id);
                const matches=input.observations.filter(o=>o.resultId===id && o.milestoneMinutes===CAMPAIGN_COMPARISON_MINUTES && cohort.observationRefs.includes(o.sourceRef));
                // Conflicting polling evidence cannot be cherry-picked into a valid sample.
                const unique=new Map(matches.map(o=>[JSON.stringify(o),o]));
                if(unique.size!==1)return [];
                const o=[...unique.values()][0],age=o.publishedAt===null ? -1 : o.observedAt-o.publishedAt;
                if(!Number.isSafeInteger(o.publishedAt) || !Number.isSafeInteger(o.observedAt) || o.publishedAt!<0
                    || o.milestoneMinutes!==CAMPAIGN_COMPARISON_MINUTES || o.status!=='measured' || !o.sourceRef
                    || o.observedAt<input.now-CAMPAIGN_REPORT_WINDOW_DAYS*86400000 || o.observedAt>input.now
                    || age<CAMPAIGN_COMPARISON_MINUTES*60000 || age>CAMPAIGN_COMPARISON_MAX_AGE_HOURS*3600000
                    || [o.reactions,o.comments,o.shares].some(n=>!Number.isSafeInteger(n)||n===null||n<0))return [];
                const total=o.reactions!+o.comments!+o.shares!;
                return Number.isSafeInteger(total) ? [{total,ref:o.sourceRef}] : [];
            });
            evidence.sampleSizes[label]=snapshots.length;evidence.coverage[label]=ids.length?snapshots.length/ids.length:0;
            evidence.observationRefs.push(...snapshots.map(s=>s.ref));
            if(snapshots.length<CAMPAIGN_MINIMUM_SAMPLES || evidence.coverage[label]<CAMPAIGN_MINIMUM_COVERAGE)complete=false;
            const sum=snapshots.reduce((total,s)=>total+s.total,0);
            if(!Number.isSafeInteger(sum))complete=false;
            scores.set(cohort.key,sum/snapshots.length);
        }
        evidence.observationRefs=[...new Set(evidence.observationRefs)].sort();
        const current=kind==='variant'?input.current.variant:String(input.currentMinute);
        if(candidates.length<2 || scores.size!==candidates.length || !scores.has(current) || !complete
            || candidates.some(c=>c.contentRevision!==input.current.contentRevision || c.format!==candidates[0].format
                || (kind==='time' ? !input.allowedMinutes.includes(Number(c.key)) : !['A','B','C','D','E'].includes(c.key))))continue;
        const ranked=[...scores].sort((a,b)=>b[1]-a[1]);
        if(!Number.isFinite(ranked[0][1]) || ranked[0][1]===ranked[1][1])return {...evidence,reason:'tied_scores'};
        if(ranked[0][0]===current)return {...evidence,reason:'current_is_best'};
        return {...evidence,kind,before:kind==='variant'?current:Number(current),after:kind==='variant'?ranked[0][0]:Number(ranked[0][0]),reason:'measured_mean_engagement'};
    }
    return evidence;
}

/** Read-only, scoped evidence. No guessed totals or financial adapters. */
export function buildCampaignReport(input:{scope:CampaignScope;campaignId:string;from:number;to:number},db:SqlDatabase):CampaignReport {
    const {scope,campaignId,from,to}=input;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>to)throw new Error('Invalid campaign report period');
    const store=new PageCampaignStore(db);
    const posts=store.listPublished(scope,campaignId).filter(post=>post.publishedAt===null || post.publishedAt>=from && post.publishedAt<=to);
    const observations=store.listObservations(scope,campaignId,from,to).filter(row=>posts.some(post=>post.resultId===row.resultId))
        .map(row=>({...row,sourceAvailable:store.observationSourceAvailable(row,posts.find(post=>post.resultId===row.resultId)!)}));
    const measurements=store.listMeasurements(scope,campaignId);
    const missing=new Set<string>();let eligible=0,measured=0,total=0;
    for(const post of posts){
        if(post.reason)missing.add(post.reason);
        if(post.publishedAt===null){missing.add('unknown_published_at');continue;}
        if(to-post.publishedAt<CAMPAIGN_COMPARISON_MINUTES*60000)continue;
        eligible++;
        const snapshot=observations.find(row=>row.resultId===post.resultId && row.milestoneMinutes===CAMPAIGN_COMPARISON_MINUTES);
        if(!snapshot){missing.add(measurements.find(row=>row.resultId===post.resultId && row.milestoneMinutes===4320)?.reason || 'missing_snapshot');continue;}
        if(!snapshot.sourceAvailable){missing.add('source_unavailable');continue;}
        const age=snapshot.observedAt-post.publishedAt;
        if(age<CAMPAIGN_COMPARISON_MINUTES*60000 || age>CAMPAIGN_COMPARISON_MAX_AGE_HOURS*3600000){missing.add('outside_comparison_window');continue;}
        if(snapshot.status!=='measured'||[snapshot.reactions,snapshot.comments,snapshot.shares].some(n=>n===null)){
            missing.add(snapshot.reason||'missing_counts');continue;
        }
        measured++;total+=snapshot.reactions!+snapshot.comments!+snapshot.shares!;
    }
    const leads=db.query<{id:number;post_url:string;profile_id:string}>(
        'SELECT id,post_url,profile_id FROM fb_poster_leads WHERE profile_id=? AND detected_at>=? AND detected_at<=?',[scope.profileId,from,to]);
    const uniqueLeads=new Set(leads.filter(lead=>{
        const target=campaignPostTarget(lead.post_url);
        return target && posts.some(post=>post.sourceRef && post.postId===target.postId && post.postUrl===target.postUrl);
    }).map(lead=>lead.id)).size;
    return {measurementWindow:{milestoneMinutes:4320,minAgeHours:72,maxAgeHours:96},observations,
        campaignId,pageId:scope.pageId,from,to,published:posts.length,eligible,measured,coverage:eligible?measured/eligible:null,
        totalEngagement:eligible>0&&measured===eligible?total:null,uniqueLeads,
        lastObservedAt:observations.length?Math.max(...observations.map(row=>row.observedAt)):null,missingReasons:[...missing].sort(),
        finance:{status:'unavailable',reason:'missing_financial_source'}};
}
