import { createHash } from 'crypto';
import type { CampaignMeasurement, CampaignObservation, CampaignPublishedPost, CampaignScope, PageCampaignLink } from '../../models/pageCampaigns';
import type { PostStatsSnapshot } from '../../models/facebookPoster';
import { PageCampaignStore, campaignPostTarget, campaignPostId } from '../dailyBrief/PageCampaignStore';
import type { ResearchOwnership, ResearchService } from '../research/ResearchService';
import type { ResearchStore } from '../research/ResearchStore';
import type { SqlDatabase } from './FacebookPosterStore';
import { BUSY_ERROR } from './FacebookPosterService';

export const CAMPAIGN_TRACK_MILESTONES = [60,1440,4320] as const;
export const CAMPAIGN_LOOKUP_LIMIT = 10;
export interface PageCampaignTrackerDeps {
    db: SqlDatabase;
    research: Pick<ResearchService,'reserveSearch'|'whenIdle'|'cancelOwned'>;
    researchStore: ResearchStore;
    now():number;
    assertCurrent():void;
}
type CollectionResult={checked:number;measured:number;unavailable:number};
type TrackedMilestone={status:'pending'}|{status:'unavailable';reason:string}|{status:'ready';snapshot:PostStatsSnapshot};
/** Same 24 h overdue limit as the PostTracker milestones (STATS_OVERDUE_LIMIT_MS). */
export const TRACKED_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
const isTracked=(post:CampaignPublishedPost)=>!!post.sourceRef?.startsWith('post-tracking:');

/** DB-only: the bound Page row's earliest stats in [milestone, milestone + 24 h]; the PostTracker owns the browser read. */
export function trackedMilestone(db:SqlDatabase,post:CampaignPublishedPost,milestoneMinutes:60|1440|4320,now:number):TrackedMilestone {
    if(post.publishedAt===null)return {status:'pending'};
    const from=post.publishedAt+milestoneMinutes*60000;
    const row=db.queryOne<any>('SELECT * FROM fb_poster_post_tracking WHERE result_id=?',[post.resultId]);
    if(post.sourceRef!==`post-tracking:${post.resultId}` || !row || row.target_kind!=='page' || row.page_id!==post.pageId || row.post_id!==post.postId)return {status:'unavailable',reason:'source_mismatch'};
    const stats=db.queryOne<any>('SELECT * FROM fb_poster_post_stats WHERE result_id=? AND captured_at>=? AND captured_at<=? ORDER BY captured_at,id LIMIT 1',[post.resultId,from,from+TRACKED_STATS_WINDOW_MS]);
    if(stats)return {status:'ready',snapshot:{id:stats.id,resultId:stats.result_id,capturedAt:stats.captured_at,
        reactions:stats.reactions ?? null,comments:stats.comments ?? null,shares:stats.shares ?? null}};
    const done=String(row.stats_done ?? '').split(',').includes(`${milestoneMinutes}m`);
    return done || row.link_status==='not_found' || now>from+TRACKED_STATS_WINDOW_MS ? {status:'unavailable',reason:'exact_post_not_found'} : {status:'pending'};
}
function dueMilestone(db:SqlDatabase,post:CampaignPublishedPost,measurements:CampaignMeasurement[],now:number) {
    for(const milestoneMinutes of CAMPAIGN_TRACK_MILESTONES){
        const existing=measurements.find(row=>row.resultId===post.resultId && row.milestoneMinutes===milestoneMinutes);
        if(post.publishedAt===null || now<post.publishedAt+milestoneMinutes*60000 || existing?.completedAt!=null)continue;
        // A pending tracked milestone waits for the PostTracker and must not occupy the timer's turn.
        if(isTracked(post) && trackedMilestone(db,post,milestoneMinutes,now).status==='pending')continue;
        if(!post.sourceRef && awaitingLink(db,post,milestoneMinutes,now))continue;
        return {milestoneMinutes,existing};
    }
    return null;
}
/** Unbound post whose Page row is still being re-found inside the milestone window: wait instead of losing the milestone. */
function awaitingLink(db:SqlDatabase,post:CampaignPublishedPost,milestoneMinutes:number,now:number):boolean {
    if(post.publishedAt===null || now>post.publishedAt+milestoneMinutes*60000+TRACKED_STATS_WINDOW_MS)return false;
    const row=db.queryOne<{link_status:string}>("SELECT link_status FROM fb_poster_post_tracking WHERE result_id=? AND target_kind='page' AND page_id=?",[post.resultId,post.pageId]);
    return row?.link_status==='missing' || row?.link_status==='pending_approval';
}
export function hasDueCampaignMilestone(db:SqlDatabase,post:CampaignPublishedPost,measurements:CampaignMeasurement[],now:number):boolean {
    return dueMilestone(db,post,measurements,now)!==null;
}
/** Timer candidates in link order; one broken campaign is reported and skipped, never hiding the others. */
export function* dueCampaignPosts(db:SqlDatabase,workspaceId:string,now:number,onError:(campaignId:string,error:unknown)=>void):Generator<{scope:PageCampaignLink;post:CampaignPublishedPost}> {
    const campaigns=new PageCampaignStore(db);
    const links=db.query<{campaign_id:string}>('SELECT campaign_id FROM page_campaign_links WHERE workspace_id=? AND deleted_at IS NULL',[workspaceId]);
    for(const entry of links){
        let found:{scope:PageCampaignLink;post:CampaignPublishedPost}|undefined;
        try {
            const scope=campaigns.getLink(entry.campaign_id)!;
            const measurements=campaigns.listMeasurements(scope,scope.campaignId);
            const post=campaigns.listPublished(scope,scope.campaignId).find(row=>hasDueCampaignMilestone(db,row,measurements,now));
            if(post)found={scope,post};
        } catch(error) { onError(entry.campaign_id,error); continue; }
        if(found)yield found;
    }
}

/** One milestone per job, on the existing research/browser slot. No timer or provider instance. */
export class PageCampaignTracker {
    private running:Promise<CollectionResult>|null=null;
    private scanId:string|null=null;
    private cancelled=false;
    constructor(private readonly deps:PageCampaignTrackerDeps) {}
    isRunning():boolean {return this.running!==null;}
    async whenIdle():Promise<void> {await this.running?.catch(()=>undefined);}
    cancel():void {this.cancelled=true;if(this.scanId)this.deps.research.cancelOwned(this.scanId);}
    collect(scope:CampaignScope,campaignId:string,assertCurrent:()=>void,priority:ResearchOwnership['priority']='interactive'):Promise<CollectionResult> {
        if(this.running)throw new Error(BUSY_ERROR);
        this.cancelled=false;
        const guard=()=>{this.deps.assertCurrent();assertCurrent();if(this.cancelled)throw new Error('Campaign collection cancelled');};
        guard();
        const pending=this.run(scope,campaignId,guard,priority);
        this.running=pending;
        void pending.then(()=>{this.running=null;this.scanId=null;},()=>{this.running=null;this.scanId=null;});
        return pending;
    }
    private async run(scope:CampaignScope,campaignId:string,guard:()=>void,priority:ResearchOwnership['priority']):Promise<CollectionResult> {
        const store=new PageCampaignStore(this.deps.db);guard();
        const measurements=store.listMeasurements(scope,campaignId);
        const now=this.deps.now();
        let due:{post:CampaignPublishedPost}&NonNullable<ReturnType<typeof dueMilestone>>|undefined;
        for(const post of store.listPublished(scope,campaignId)){const hit=dueMilestone(this.deps.db,post,measurements,now);if(hit){due={post,...hit};break;}}
        if(!due)return {checked:0,measured:0,unavailable:0};
        const {post,milestoneMinutes,existing}=due;
        if(isTracked(post))return this.fromStats(store,scope,campaignId,post,milestoneMinutes,existing,guard);
        const scanId=existing?.scanId ?? 'campaign-'+createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.pageId,scope.profileId,campaignId,post.resultId,milestoneMinutes])).digest('hex');
        const target=post.postUrl ? campaignPostTarget(post.postUrl) : null;
        const reason=!post.sourceRef || !target || target.postId!==post.postId ? 'unconfirmed_post_target'
            : target.postUrl.length>100 ? 'unsupported_lookup_url' : null;
        const unavailable=(reason:string):CollectionResult=>{
            guard();store.finishMeasurement(scope,campaignId,post.resultId,milestoneMinutes,reason,this.deps.now());
            return {checked:1,measured:0,unavailable:1};
        };
        if(reason){
            guard();this.deps.db.transaction(()=>{
                if(!existing)store.reserveMeasurement(scope,campaignId,post.resultId,milestoneMinutes,scanId);
                unavailable(reason);
            });
            return {checked:1,measured:0,unavailable:1};
        }
        let reserved:ReturnType<PageCampaignTrackerDeps['research']['reserveSearch']>|undefined;
        try { this.deps.db.transaction(()=>{
            guard();
            if(!existing){
                // Reservation and scan commit together; BUSY rolls back without consuming an attempt.
                store.reserveMeasurement(scope,campaignId,post.resultId,milestoneMinutes,scanId);
                reserved=this.deps.research.reserveSearch({source:'posts',query:target!.postUrl,origin:'api',limit:CAMPAIGN_LOOKUP_LIMIT},
                    {scanId,pageId:scope.pageId,profileId:scope.profileId,assertCurrent:guard,priority});
            }
        }); } catch(error) {
            if(reserved){this.deps.research.cancelOwned(scanId);await this.deps.research.whenIdle();}
            throw error;
        }
        this.scanId=scanId;
        if(reserved){reserved.start();await this.deps.research.whenIdle();}
        guard();
        const scan=this.deps.researchStore.getScan(scanId);
        if(!scan || scan.status!=='done')return unavailable(scan?.status==='running'?'interrupted_scan':'lookup_unavailable');
        if(scan.source!=='posts' || scan.origin!=='api' || scan.query!==target!.postUrl || scan.profileIds.length!==1 || scan.profileIds[0]!==scope.profileId)
            return unavailable('source_mismatch');
        const result=this.deps.researchStore.listItems(scanId,{limit:CAMPAIGN_LOOKUP_LIMIT});
        if(result.total>CAMPAIGN_LOOKUP_LIMIT)return unavailable('source_mismatch');
        const hit=result.items.find(item=>{
            const parsed=campaignPostTarget(item.url);
            return item.kind==='post' && item.scanId===scanId && item.profileId===scope.profileId && campaignPostId(item.fbId,scope.pageId)===post.postId
                && parsed?.postId===post.postId && parsed.postUrl===target!.postUrl && item.authorKind==='page' && item.authorId===scope.pageId;
        });
        if(!hit)return unavailable('exact_post_not_found');
        const counts=[hit.reactions,hit.comments,hit.shares];
        if(counts.some(n=>n!==null && (!Number.isSafeInteger(n) || n<0)))return unavailable('invalid_counts');
        const complete=counts.every(n=>n!==null);
        const observation:CampaignObservation={resultId:post.resultId,postId:post.postId!,postUrl:target!.postUrl,pageId:scope.pageId,campaignId,
            publishedAt:post.publishedAt,observedAt:hit.capturedAt,milestoneMinutes,sourceRef:scanId,status:complete?'measured':'unavailable',
            reason:complete?'':'missing_counts',reactions:hit.reactions,comments:hit.comments,shares:hit.shares};
        guard();store.recordObservation(observation);
        return {checked:1,measured:complete?1:0,unavailable:complete?0:1};
    }
    /** Bound Page post: one milestone from fb_poster_post_stats, reserved and decided in one transaction. */
    private fromStats(store:PageCampaignStore,scope:CampaignScope,campaignId:string,post:CampaignPublishedPost,milestoneMinutes:60|1440|4320,
        existing:CampaignMeasurement|undefined,guard:()=>void):CollectionResult {
        const scanId=`post-stats:${post.resultId}:${milestoneMinutes}`,now=this.deps.now();
        const found:TrackedMilestone=existing && existing.scanId!==scanId ? {status:'unavailable',reason:'source_mismatch'} : trackedMilestone(this.deps.db,post,milestoneMinutes,now);
        if(found.status==='pending')return {checked:0,measured:0,unavailable:0};
        const snapshot=found.status==='ready' ? found.snapshot : null;
        const counts=snapshot ? [snapshot.reactions,snapshot.comments,snapshot.shares] : [];
        const reason=found.status==='unavailable' ? found.reason : counts.some(n=>n!==null && (!Number.isSafeInteger(n) || n<0)) ? 'invalid_counts' : null;
        const complete=counts.every(n=>n!==null);
        guard();
        this.deps.db.transaction(()=>{
            if(!existing)store.reserveMeasurement(scope,campaignId,post.resultId,milestoneMinutes,scanId);
            if(reason!==null || !snapshot)store.finishMeasurement(scope,campaignId,post.resultId,milestoneMinutes,reason ?? 'exact_post_not_found',now);
            else store.recordObservation({resultId:post.resultId,postId:post.postId!,postUrl:post.postUrl!,pageId:scope.pageId,campaignId,
                publishedAt:post.publishedAt,observedAt:snapshot.capturedAt,milestoneMinutes,sourceRef:scanId,status:complete?'measured':'unavailable',
                reason:complete?'':'missing_counts',reactions:snapshot.reactions,comments:snapshot.comments,shares:snapshot.shares});
        });
        return reason!==null || !snapshot ? {checked:1,measured:0,unavailable:1} : {checked:1,measured:complete?1:0,unavailable:complete?0:1};
    }
}
