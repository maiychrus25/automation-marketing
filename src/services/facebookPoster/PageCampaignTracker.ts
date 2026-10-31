import { createHash } from 'crypto';
import type { CampaignObservation, CampaignScope } from '../../models/pageCampaigns';
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
        const due=store.listPublished(scope,campaignId).flatMap(post=>CAMPAIGN_TRACK_MILESTONES.map(milestoneMinutes=>({post,milestoneMinutes,
            existing:measurements.find(row=>row.resultId===post.resultId && row.milestoneMinutes===milestoneMinutes)})))
            .find(({post,milestoneMinutes,existing})=>post.publishedAt!==null && this.deps.now()>=post.publishedAt+milestoneMinutes*60000 && existing?.completedAt==null);
        if(!due)return {checked:0,measured:0,unavailable:0};
        const {post,milestoneMinutes,existing}=due;
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
}
