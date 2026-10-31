import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import type { PageCampaignTracker } from '../facebookPoster/PageCampaignTracker';
import { buildCampaignReport, chooseCampaignAdjustment, CAMPAIGN_REPORT_WINDOW_DAYS } from './pageCampaignMetrics';
import type { CampaignCohort, CampaignDecision, CampaignDraftSelection } from '../../models/pageCampaigns';
import type { CampaignProposalInput, CampaignScope, CampaignScheduleInput, CampaignScheduleUpdateInput, CampaignExecution, CampaignGrant } from '../../models/pageCampaigns';
import type { FbPosterSchedule } from '../../models/facebookPoster';
import type { InboxMediaStore } from '../control/InboxMediaStore';
import { promoteDraft, type DraftDeps } from '../facebookPoster/drafts';
import { validateStartParams } from '../facebookPoster/validateStartParams';
import { prepareScheduleMedia, resolveScheduleMedia } from '../facebookPoster/scheduleMedia';
import { readTiming } from '../facebookPoster/scheduleUpdate';
import { PageCampaignExecutionStore, campaignFormat } from './PageCampaignExecutionStore';
import type { ControlPrincipal, PageContext, WorkLease } from '../../models/pageOperations';
import { ControlError } from '../control/ControlMethods';
import { ControlStore } from '../control/ControlStore';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { DailyBriefStore, systemClock, type LocalClock } from './DailyBriefStore';
import { PageBusinessStore } from './PageBusinessStore';
import { PageCampaignStore } from './PageCampaignStore';
import { PageWorkStore } from './PageWorkStore';

export interface PageCampaignOperationsDeps {
    db: SqlDatabase;
    principal: Exclude<ControlPrincipal, {kind:'legacy'}>;
    context(workId: string): PageContext;
    now(): number;
    clock?: LocalClock & {timeZone?():string};
    assertCurrent(): void;
    protectedWritesEnabled(): boolean;
    /** Local preparation only; absent on proposal/read-only composition means no scheduling authority. */
    draft?: Omit<DraftDeps, 'store' | 'newId'>;
    media?: Pick<InboxMediaStore, 'resolve'>;
    collector?: Pick<PageCampaignTracker,'collect'>;
}

const campaignHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function campaignContentRevision(baseDir:string,row:FbPosterSchedule):string {
    const paths=resolveScheduleMedia(baseDir,row.id,(row.params.mediaPaths ?? []) as string[]);
    return campaignHash({text:row.params.text,variants:row.params.variants ?? [],comment:row.params.comment ?? '',media:paths.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'))});
}
export function campaignAuthorityFingerprint(baseDir:string,business:PageBusinessStore,row:FbPosterSchedule,execution:CampaignExecution,grant:CampaignGrant):string {
    const profile=business.get(execution.pageId);
    const facts=execution.selection.factIds.map(id => {
        const fact=profile?.facts.find(fact => fact.id === id);
        if (!fact || fact.status !== 'confirmed') throw new ControlError('NEEDS_REVIEW','Dữ kiện cần được chủ xác nhận; provenance không tự chứng minh câu chữ tự do');
        return fact;
    });
    const variants=[row.params.text,...(row.params.variants as string[] ?? [])];
    if (!variants['ABCDE'.indexOf(execution.selection.variant)]) throw new ControlError('INVALID_PARAMS','Biến thể chưa được lưu');
    return campaignHash({content:campaignContentRevision(baseDir,row),selection:execution.selection,profiles:row.params.profiles,workspaceId:execution.workspaceId,
        pageId:execution.pageId,profileId:execution.profileId,campaignId:row.campaignId,grantId:grant.id,grantRevision:grant.revision,
        campaignRevision:grant.campaignRevision,basis:facts,primaryProfileId:profile?.primaryProfileId,runAt:row.runAt});
}

/** Internal timer and leased requests share the same live Page/key/grant checks. */
export function assertCampaignCollection(db:SqlDatabase,scope:CampaignScope,campaignId:string,runnerKeyId:string,now:number):void {
    const deny=():never=>{throw new ControlError('FORBIDDEN','Không có quyền thu số liệu chiến dịch');};
    const campaigns=new PageCampaignStore(db),link=campaigns.getLink(campaignId);
    if(!link || link.deletedAt!==null || link.workspaceId!==scope.workspaceId || link.pageId!==scope.pageId || link.profileId!==scope.profileId)deny();
    const briefs=new DailyBriefStore(db),identity=briefs.getIdentity(scope.profileId),business=new PageBusinessStore(db).get(scope.pageId);
    if(identity?.kind!=='page'||identity.pageId!==scope.pageId||identity.errorCode||!briefs.getBrief(scope.profileId)?.enabled
        ||!business?.enabled||business.primaryProfileId!==scope.profileId||new FacebookPosterStore(db).getCampaign(campaignId)?.status!=='active')deny();
    const grant=campaigns.listGrants(campaignId).find(g=>g.status==='active' && g.campaignRevision===link!.revision && now>=g.policy.startsAt && now<g.policy.expiresAt);
    if(!grant) return deny();
    for(const [id,kind] of [[runnerKeyId,'page_runner'],[grant.receiverKeyId,'page_receiver']]){
        const policy=new ControlStore(db).findActiveKeyById(id)?.policy;
        if(!policy||policy.kind!==kind||policy.workspaceId!==scope.workspaceId||!policy.assignments.some(a=>a.pageId===scope.pageId&&a.profileIds.includes(scope.profileId)))deny();
    }
}

/** Local campaign authority; collector runtime readiness is not advertised. */
export function createPageCampaignOperations(deps: PageCampaignOperationsDeps) {
    const store = new PageCampaignStore(deps.db);
    const works = new PageWorkStore(deps.db, deps.clock);
    const briefs = new DailyBriefStore(deps.db, deps.clock);
    const business = new PageBusinessStore(deps.db);
    const principal = JSON.parse(JSON.stringify(deps.principal)) as typeof deps.principal;
    function forbidden(): never { throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); }
    function page(pageId: string) {
        deps.assertCurrent();
        const assignment = principal.assignments.find(a => a.pageId === pageId);
        if (!assignment) forbidden();
        return assignment;
    }
    function visible(row: CampaignScope, pageId: string): boolean {
        return row.workspaceId === principal.workspaceId && row.pageId === pageId && page(pageId).profileIds.includes(row.profileId);
    }
    const poster = new FacebookPosterStore(deps.db);
    const executions = new PageCampaignExecutionStore(deps.db, deps.clock);
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const fail = (code:'CONFLICT'|'INVALID_PARAMS'|'NEEDS_REVIEW', message:string):never => {throw new ControlError(code,message);};
    function closed(value:unknown, keys:string[]):void {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_PARAMS','Tham số lịch không hợp lệ');
    }
    function preparation():DraftDeps {
        if (!deps.draft || !deps.media) forbidden();
        return {...deps.draft,store:poster,newId:() => {throw new Error('Không tạo draft qua promotion');},now:deps.now};
    }
    function owned(workId:string, kind:'draft'|'media', id:string):void {
        const owner=works.getResourceOwner({kind,id}); const context=deps.context(workId);
        if (!owner || owner.workId !== workId || owner.workspaceId !== context.workspaceId || owner.pageId !== context.pageId) forbidden();
    }
    function authority(lease:WorkLease, input:Pick<CampaignScheduleInput,'campaignId'|'grantId'|'expectedGrantRevision'>, action:'schedulePost'|'updateScheduledPost') {
        deps.assertCurrent();
        if (principal.kind !== 'page_runner' || deps.protectedWritesEnabled() !== true) forbidden();
        const context=deps.context(lease.workId); const work=works.assertLease(lease,deps.now());
        if (!visible(context,context.pageId) || work.workspaceId !== context.workspaceId || work.pageId !== context.pageId || work.profileId !== context.profileId) forbidden();
        const grant=store.getGrant(input.grantId); const link=store.getLink(input.campaignId);
        if (!grant || !link || !visible(grant,context.pageId) || !visible(link,context.pageId) || grant.profileId !== context.profileId || link.profileId !== context.profileId) forbidden();
        const profile=business.get(context.pageId); const brief=briefs.getBrief(context.profileId); const identity=briefs.getIdentity(context.profileId);
        if (!profile?.enabled || profile.primaryProfileId !== context.profileId || !brief?.enabled || !identity || identity.kind !== 'page' || identity.pageId !== context.pageId || identity.errorCode
            || link.deletedAt !== null || grant.campaignId !== input.campaignId || grant.revision !== input.expectedGrantRevision || grant.status !== 'active'
            || grant.campaignRevision !== link.revision || deps.now() < grant.policy.startsAt || deps.now() >= grant.policy.expiresAt
            || !grant.policy.actions.includes(action) || grant.policy.timeZone !== (deps.clock?.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
            || poster.getCampaign(input.campaignId)?.status !== 'active') fail('CONFLICT','Quyền hoặc ngữ cảnh chiến dịch đã thay đổi');
        return {context,grant,profile};
    }
    function validateInput(input:CampaignScheduleInput|CampaignScheduleUpdateInput, update=false):void {
        closed(input,['campaignId','grantId','expectedGrantRevision','runAt','variant','factIds',...(update ? ['expectedScheduleRevision','content'] : ['draftId','expectedDraftRevision'])]);
        if (!Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 1 || !Number.isSafeInteger(input.runAt)
            || !['A','B','C','D','E'].includes(input.variant) || !Array.isArray(input.factIds) || new Set(input.factIds).size !== input.factIds.length
            || input.factIds.some(id => typeof id !== 'string' || !id) || !input.campaignId || !input.grantId) fail('INVALID_PARAMS','Nội dung lịch không hợp lệ');
        if (update) {
            const value=input as CampaignScheduleUpdateInput;
            if (!Number.isSafeInteger(value.expectedScheduleRevision) || value.expectedScheduleRevision < 1) fail('INVALID_PARAMS','Phiên bản lịch không hợp lệ');
            if (value.content !== undefined) closed(value.content,['text','variants','comment','mediaIds']);
        } else {
            const value=input as CampaignScheduleInput;
            if (typeof value.draftId !== 'string' || !value.draftId || !Number.isSafeInteger(value.expectedDraftRevision) || value.expectedDraftRevision < 1) fail('INVALID_PARAMS','Phiên bản draft không hợp lệ');
        }
    }
    const contentRevision=(row:FbPosterSchedule) => campaignContentRevision(preparation().baseDir,row);
    const fingerprint=(row:FbPosterSchedule,execution:CampaignExecution,grant:CampaignGrant) => campaignAuthorityFingerprint(preparation().baseDir,business,row,execution,grant);
    function scopedRow(lease:WorkLease,id:string):FbPosterSchedule {
        owned(lease.workId,'draft',id);
        const context=deps.context(lease.workId); const row=poster.getSchedule(id); const profiles=row?.params.profiles as {profileId:string;targets:string[]}[]|undefined;
        if (!row || row.params.mode !== 'page' || profiles?.length !== 1 || profiles[0].profileId !== context.profileId || profiles[0].targets.length !== 1 || profiles[0].targets[0] !== 'https://www.facebook.com/') fail('CONFLICT','Đích lịch đã thay đổi');
        const ids=row.params.mediaIds ?? [];
        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return fail('INVALID_PARAMS','Media lịch không hợp lệ');
        for (const id of ids) owned(lease.workId,'media',id);
        return row;
    }
    function executionFor(lease:WorkLease,id:string):CampaignExecution {
        const execution=executions.get(id);
        if (!execution || execution.workId !== lease.workId || execution.runnerKeyId !== principal.keyId || !visible(execution,deps.context(lease.workId).pageId)) forbidden();
        return execution;
    }
    // Synchronous local primitives also let optimize commit its decision with the existing scheduling transaction.
    function schedule(lease:WorkLease,input:CampaignScheduleInput):{scheduleId:string;revision:number} {
            validateInput(input); preparation();
            return deps.db.transaction(() => {
                const {context,grant}=authority(lease,input,'schedulePost'); const row=scopedRow(lease,input.draftId);
                if (row.campaignId !== input.campaignId) fail('CONFLICT','Chiến dịch draft đã thay đổi');
                const key=`campaign:schedule:${input.draftId}:${input.expectedDraftRevision}:${input.grantId}`; const requestHash=hash(input);
                const step=works.getStep(lease.workId,key);
                if (step) {
                    if (step.requestHash !== requestHash || step.status !== 'succeeded' || !step.resultRevision) fail('CONFLICT','Ý định lịch đã thay đổi');
                    const execution=executionFor(lease,row.id);
                    if (execution.status !== 'reserved' || row.authorityKind !== 'autonomy' || fingerprint(row,execution,grant) !== execution.authorityFingerprint) fail('CONFLICT','Quyền lịch đã thay đổi');
                    return {scheduleId:row.id,revision:step.resultRevision};
                }
                if (!row.draft || row.revision !== input.expectedDraftRevision) fail('CONFLICT','Draft đã thay đổi');
                const planned={...row,runAt:readTiming('once',{runAt:input.runAt},deps.now()).runAt};
                const execution:CampaignExecution={workspaceId:context.workspaceId,pageId:context.pageId,profileId:context.profileId,scheduleId:row.id,
                    workId:lease.workId,campaignId:input.campaignId,grantId:input.grantId,grantRevision:grant.revision,runnerKeyId:principal.keyId,
                    authorityFingerprint:'',selection:{variant:input.variant,contentRevision:contentRevision(row),factIds:[...input.factIds]},
                    plannedDate:(deps.clock ?? systemClock).date(input.runAt),actualDate:null,status:'reserved',runId:null,resultId:null,revision:1};
                execution.authorityFingerprint=fingerprint(planned,execution,grant);
                works.beginStep(lease,key,requestHash,deps.now(),{kind:'draft',id:row.id});
                // DB-only promotion and reservation share this transaction; no owner ticket or owner event is fabricated.
                promoteDraft(preparation(),{id:row.id,expectedRevision:row.revision,when:'schedule',kind:'once',runAt:input.runAt},'autonomy');
                executions.reserve(execution,deps.now());
                works.finishStep(lease,key,{kind:'draft',id:row.id},deps.now(),execution.revision);
                new ControlStore(deps.db).addEvent('pageCampaigns.scheduleChanged',{campaignId:input.campaignId,scheduleId:row.id,revision:1,status:'reserved'});
                authority(lease,input,'schedulePost'); deps.assertCurrent(); return {scheduleId:row.id,revision:1};
            });
    }
    function updateSchedule(lease:WorkLease,scheduleId:string,expectedExecutionRevision:number,input:CampaignScheduleUpdateInput):{scheduleId:string;revision:number} {
            validateInput(input,true); preparation();
            let media:ReturnType<typeof prepareScheduleMedia>|undefined;
            try {
                return deps.db.transaction(() => {
                    const {grant}=authority(lease,input,'updateScheduledPost'); const previous=executionFor(lease,scheduleId); const row=scopedRow(lease,scheduleId);
                    if (previous.status !== 'reserved' || previous.revision !== expectedExecutionRevision || row.revision !== input.expectedScheduleRevision || row.authorityKind !== 'autonomy'
                        || previous.campaignId !== input.campaignId || previous.grantId !== input.grantId || fingerprint(row,previous,grant) !== previous.authorityFingerprint)
                        fail('CONFLICT','Lịch hoặc authority đã thay đổi');
                    const timing=readTiming('once',{runAt:input.runAt},deps.now());
                    let params=row.params;
                    if (input.content !== undefined) {
                        const ids=input.content.mediaIds ?? [];
                        if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) fail('INVALID_PARAMS','Media không hợp lệ');
                        for (const id of ids) owned(lease.workId,'media',id);
                        const checked=validateStartParams({kind:'post',params:{...row.params,text:input.content.text,variants:input.content.variants,
                            comment:input.content.comment ?? '',mediaIds:ids,mediaPaths:deps.media!.resolve(ids)}},preparation().env);
                        if (checked.kind !== 'post') return fail('INVALID_PARAMS','Nội dung không hợp lệ');
                        media=prepareScheduleMedia(preparation().baseDir,row.id,row.revision+1,checked.mediaPaths);
                        params={...checked,mediaIds:ids,mediaPaths:media.names};
                    } else {
                        validateStartParams({kind:'post',params:{...params,mediaPaths:resolveScheduleMedia(preparation().baseDir,row.id,(params.mediaPaths ?? []) as string[])}},preparation().env);
                    }
                    const planned={...row,...timing,params};
                    const execution:CampaignExecution={...previous,grantRevision:grant.revision,selection:{variant:input.variant,contentRevision:contentRevision(planned),factIds:[...input.factIds]},
                        plannedDate:(deps.clock ?? systemClock).date(input.runAt),revision:previous.revision+1};
                    execution.authorityFingerprint=fingerprint(planned,execution,grant);
                    poster.updateAutonomySchedule(row.id,{...timing,params,nextRunAt:input.runAt},deps.now(),row.revision);
                    executions.reserve(execution,deps.now());
                    new ControlStore(deps.db).addEvent('pageCampaigns.scheduleChanged',{campaignId:input.campaignId,scheduleId,revision:execution.revision,status:execution.status});
                    authority(lease,input,'updateScheduledPost'); deps.assertCurrent(); return {scheduleId,revision:execution.revision};
                });
            } catch(error) {media?.cleanup(); throw error;}
    }
    return {
        async schedule(lease:WorkLease,input:CampaignScheduleInput) { return schedule(lease,input); },
        async updateSchedule(lease:WorkLease,scheduleId:string,expectedExecutionRevision:number,input:CampaignScheduleUpdateInput) {
            return updateSchedule(lease,scheduleId,expectedExecutionRevision,input);
        },
        async optimize(lease:WorkLease,campaignId:string,draftId:string,expectedDraftRevision:number,grantId:string,expectedGrantRevision:number):Promise<{decision:CampaignDecision;scheduleId:string|null}> {
            if(![campaignId,draftId,grantId].every(id=>typeof id==='string'&&id.length>0)
                || ![expectedDraftRevision,expectedGrantRevision].every(n=>Number.isSafeInteger(n)&&n>0))fail('INVALID_PARAMS','Phiên bản tối ưu không hợp lệ');
            preparation();
            return deps.db.transaction(()=>{
                const input={campaignId,grantId,expectedGrantRevision};
                const key=`campaign:optimize:${draftId}:${expectedDraftRevision}:${grantId}`;
                const saved=store.getDecision(deps.context(lease.workId),campaignId,lease.workId,key);
                const row=scopedRow(lease,draftId),action=saved?.action ?? (row.draft?'schedulePost':'updateScheduledPost');
                const check=()=>{
                    const current=authority(lease,input,action);
                    for(const [id,kind] of [[principal.keyId,'page_runner'],[current.grant.receiverKeyId,'page_receiver']]){
                        const policy=new ControlStore(deps.db).findActiveKeyById(id)?.policy;
                        if(!policy || policy.kind!==kind || policy.workspaceId!==current.context.workspaceId
                            || !policy.assignments.some(a=>a.pageId===current.context.pageId&&a.profileIds.includes(current.context.profileId)))forbidden();
                    }
                    return current;
                };
                const {context,grant}=check();
                if(row.campaignId!==campaignId)fail('CONFLICT','Chiến dịch draft đã thay đổi');
                const execution=row.draft?null:executionFor(lease,draftId);
                if(execution && (execution.status!=='reserved' || execution.campaignId!==campaignId || execution.grantId!==grantId
                    || execution.grantRevision!==expectedGrantRevision || row.authorityKind!=='autonomy'
                    || !row.enabled || row.runAt===null || row.runAt<deps.now()+60000
                    || fingerprint(row,execution,grant)!==execution.authorityFingerprint))fail('CONFLICT','Lịch không còn được tối ưu');
                const requestHash=hash({campaignId,draftId,expectedDraftRevision,grantId,expectedGrantRevision});
                const stateHash=()=>hash({row:poster.getSchedule(draftId),execution:executions.get(draftId)});
                const posts=store.listPublished(context,campaignId);
                const now=deps.now(),from=Math.max(0,now-CAMPAIGN_REPORT_WINDOW_DAYS*86400000);
                const observations=store.listObservations(context,campaignId,from,now).filter(o=>{
                    const post=posts.find(p=>p.resultId===o.resultId);
                    return post && post.workspaceId===context.workspaceId && post.profileId===context.profileId && post.pageId===context.pageId
                        && post.campaignId===campaignId && o.pageId===context.pageId && o.campaignId===campaignId
                        && o.publishedAt===post.publishedAt && store.observationSourceAvailable(o,post);
                });
                const step=works.getStep(lease.workId,key);
                if(saved || step){
                    if(!saved || !step || step.status!=='succeeded' || step.requestHash!==requestHash || saved.requestHash!==requestHash
                        || saved.stateHash!==stateHash() || saved.executionRevision!==(execution?.revision ?? null)
                        || saved.decision.observationRefs.some(ref=>!observations.some(o=>o.sourceRef===ref)))fail('CONFLICT','Quyết định hoặc bằng chứng đã thay đổi');
                    check();return {decision:saved.decision,scheduleId:saved.scheduleId};
                }
                if(row.revision!==expectedDraftRevision)fail('CONFLICT','Draft đã thay đổi');
                const current:CampaignDraftSelection=execution?.selection ?? {variant:'A',contentRevision:contentRevision(row),factIds:[]};
                const clock=deps.clock ?? systemClock;
                const minute=row.runAt===null?-1:clock.minutes(row.runAt),format=campaignFormat(row.params);
                const eligible=posts.filter(p=>!Number.isSafeInteger(p.publishedAt) || p.publishedAt!<0 || p.publishedAt!>=from && now-p.publishedAt!>=4320*60000);
                const unknown=eligible.some(p=>!p.comparison || !['text','image','video'].includes(p.comparison.format)
                    || !Number.isSafeInteger(p.comparison.minute) || p.comparison.minute<0 || p.comparison.minute>1439
                    || !Number.isSafeInteger(p.publishedAt) || p.publishedAt!<0 || !p.selection?.contentRevision
                    || !['A','B','C','D','E'].includes(p.selection.variant));
                const variants=[row.params.text,...(row.params.variants as string[] ?? [])].map((_,i)=>'ABCDE'[i]);
                const cohorts:CampaignCohort[]=[];
                if(format && !unknown){
                    for(const kind of ['variant','time'] as const){
                        for(const value of kind==='variant'?variants:grant.policy.allowedMinutes.map(String)){
                            const members=eligible.filter(p=>p.comparison?.format===format && p.selection.contentRevision===current.contentRevision
                                && (kind==='variant'?p.comparison.minute===minute && p.selection.variant===value:p.selection.variant===current.variant && p.comparison.minute===Number(value)));
                            cohorts.push({kind,key:value,format,contentRevision:current.contentRevision,eligibleResultIds:members.map(p=>p.resultId),
                                observationRefs:observations.filter(o=>members.some(p=>p.resultId===o.resultId)).map(o=>o.sourceRef)});
                        }
                    }
                }
                let chosen=chooseCampaignAdjustment({observations,current,currentMinute:minute,allowedMinutes:grant.policy.allowedMinutes,now},cohorts);
                if(row.runAt===null)chosen={...chosen,kind:'keep',before:null,after:null,reason:'missing_planned_time'};
                else if(unknown || !format)chosen={...chosen,kind:'keep',before:null,after:null,reason:'unknown_comparison_provenance'};
                let scheduleId:string|null=null;
                if(chosen.kind!=='keep'){
                    let runAt=row.runAt!;
                    if(chosen.kind==='time'){
                        const date=new Date(runAt),target=Number(chosen.after);
                        date.setHours(Math.floor(target/60),target%60,0,0);runAt=date.getTime();
                        if(clock.date(runAt)!==clock.date(row.runAt!) || clock.minutes(runAt)!==target)fail('CONFLICT','Giờ đăng không tồn tại trong ngày đã chọn');
                    }
                    const selection={...input,runAt,variant:chosen.kind==='variant'?chosen.after as CampaignDraftSelection['variant']:current.variant,factIds:current.factIds};
                    check();
                    const applied=execution ? updateSchedule(lease,draftId,execution.revision,{...selection,expectedScheduleRevision:row.revision})
                        : schedule(lease,{...selection,draftId,expectedDraftRevision:row.revision});
                    scheduleId=applied.scheduleId;
                }
                works.beginStep(lease,key,requestHash,now,{kind:'draft',id:draftId});
                const decision:CampaignDecision={...chosen,id:randomUUID(),campaignId,grantId,grantRevision:expectedGrantRevision,createdAt:now};
                store.saveDecision(context,lease.workId,key,{decision,scheduleId,stateHash:stateHash(),requestHash,action,executionRevision:executions.get(draftId)?.revision ?? null});
                works.finishStep(lease,key,{kind:'draft',id:draftId},now,poster.getSchedule(draftId)!.revision);
                check();deps.assertCurrent();return {decision,scheduleId};
            });
        },
        cancelSchedule(lease:WorkLease,scheduleId:string,expectedExecutionRevision:number):void {
            deps.db.transaction(() => {
                const execution=executionFor(lease,scheduleId);
                authority(lease,{campaignId:execution.campaignId,grantId:execution.grantId,expectedGrantRevision:execution.grantRevision},'updateScheduledPost');
                const row=scopedRow(lease,scheduleId);
                executions.cancel(scheduleId,expectedExecutionRevision,deps.now());
                if (execution.status !== 'cancelled') {
                    poster.updateAutonomySchedule(scheduleId,{enabled:false,nextRunAt:null},deps.now(),row.revision);
                    new ControlStore(deps.db).addEvent('pageCampaigns.scheduleChanged',{campaignId:execution.campaignId,scheduleId,revision:execution.revision+1,status:'cancelled'});
                }
                deps.assertCurrent();
            });
        },
        report(pageId:string,campaignId:string,from:number|undefined=undefined,to=deps.now()) {
            from ??= Math.max(0,to-CAMPAIGN_REPORT_WINDOW_DAYS*86400000);
            const link=store.getLink(campaignId);if(!link||!visible(link,pageId))forbidden();
            const result=buildCampaignReport({scope:link,campaignId,from,to},deps.db);deps.assertCurrent();return result;
        },
        async collect(lease:WorkLease,campaignId:string) {
            const guard=()=>{
                deps.assertCurrent();
                if(principal.kind!=='page_runner'||!deps.protectedWritesEnabled())forbidden();
                const work=works.assertLease(lease,deps.now()),context=deps.context(lease.workId);
                if(!visible(work,context.pageId)||work.profileId!==context.profileId)forbidden();
                assertCampaignCollection(deps.db,context,campaignId,principal.keyId,deps.now());
            };
            guard();if(!deps.collector)throw new ControlError('NEEDS_REVIEW','Bộ thu số liệu chưa được gắn');
            const result=await deps.collector.collect(deps.context(lease.workId),campaignId,guard);guard();return result;
        },
        list(pageId: string) {
            const assignment = page(pageId);
            const scopes = assignment.profileIds.map(profileId => ({workspaceId:principal.workspaceId, pageId, profileId}));
            const result = {campaigns:scopes.flatMap(scope => store.list(scope)), proposals:scopes.flatMap(scope => store.listProposals(scope))};
            deps.assertCurrent(); return result;
        },
        get(pageId: string, campaignId: string) {
            page(pageId);
            const campaign = store.getLink(campaignId);
            if (!campaign || !visible(campaign, pageId)) forbidden();
            const grants = store.listGrants(campaignId).map(grant => {
                if (!visible(grant, pageId) || grant.profileId !== campaign.profileId) forbidden();
                const {receiverKeyId: _receiver, confirmationRef: _confirmation, ...publicGrant} = grant;
                return publicGrant;
            });
            const decision=store.getLatestDecision(campaign,campaignId);
            let latestDecision:{decision:CampaignDecision;evidenceAvailable:boolean}|null=null;
            if(decision){
                const posts=store.listPublished(campaign,campaignId);
                const observations=store.listObservations(campaign,campaignId,0,Number.MAX_SAFE_INTEGER);
                const evidenceAvailable=decision.observationRefs.length>0 && decision.observationRefs.every(ref=>observations.some(observation=>{
                    const post=posts.find(row=>row.resultId===observation.resultId);
                    return observation.sourceRef===ref && observation.pageId===pageId && observation.campaignId===campaignId
                        && post?.workspaceId===campaign.workspaceId && post.profileId===campaign.profileId && post.pageId===pageId
                        && post.campaignId===campaignId && observation.publishedAt===post.publishedAt
                        && store.observationSourceAvailable(observation,post);
                }));
                latestDecision={decision,evidenceAvailable};
            }
            deps.assertCurrent(); return {campaign, grants, latestDecision};
        },
        propose(lease: WorkLease, input: CampaignProposalInput, expectedRevision: number | null) {
            deps.assertCurrent();
            if (principal.kind !== 'page_runner' || deps.protectedWritesEnabled() !== true) forbidden();
            return deps.db.transaction(() => {
                const context = deps.context(lease.workId);
                if (!visible(context, context.pageId)) forbidden();
                const work = works.assertLease(lease, deps.now());
                if (work.workspaceId !== context.workspaceId || work.pageId !== context.pageId || work.profileId !== context.profileId) forbidden();
                const profile = business.get(context.pageId); const brief = briefs.getBrief(context.profileId);
                const identity = briefs.getIdentity(context.profileId);
                if (!identity || identity.kind !== 'page' || identity.pageId !== context.pageId || identity.errorCode) forbidden();
                if (!profile?.enabled || profile.primaryProfileId !== context.profileId || !brief?.enabled)
                    throw new ControlError('CONFLICT', 'Ngữ cảnh đề nghị Page đã thay đổi');
                if (input?.policy?.maxPostsPerDay > brief.draftsPerDay)
                    throw new ControlError('INVALID_PARAMS', 'Hạn mức chiến dịch vượt giới hạn daily brief');
                const proposal = store.saveProposal(context, lease, input, expectedRevision, deps.now());
                new ControlStore(deps.db).addEvent('pageCampaigns.proposalChanged', {proposalId:proposal.id, revision:proposal.revision, status:proposal.status});
                deps.assertCurrent(); return proposal;
            });
        },
    };
}
