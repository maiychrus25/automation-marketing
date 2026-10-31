import type { Page } from 'playwright-core';
import type { AutonomyExecutionGuard } from '../../models/pageCampaigns';
import type { StartParams } from '../facebookPoster/FacebookPosterService';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { resolveScheduleMedia } from '../facebookPoster/scheduleMedia';
import { GRACE_MS } from '../facebookPoster/FacebookPosterScheduler';
import { ControlStore } from '../control/ControlStore';
import { ControlError } from '../control/ControlMethods';
import { DailyBriefStore, systemClock, type LocalClock } from './DailyBriefStore';
import { PageBusinessStore } from './PageBusinessStore';
import { PageCampaignStore } from './PageCampaignStore';
import { PageCampaignExecutionStore } from './PageCampaignExecutionStore';
import { PageWorkStore } from './PageWorkStore';
import { campaignAuthorityFingerprint, campaignContentRevision } from './pageCampaignOperations';
import { parseIdentityHtml, type PageIdentityRead } from './pageIdentity';

export interface PageCampaignExecutionDeps {
    db: SqlDatabase;
    baseDir: string;
    workspaceId: string;
    assertCurrent(): void;
    profileExists(id:string): boolean;
    protectedWritesEnabled(): boolean;
    now(): number;
    clock?: LocalClock & {timeZone?():string};
    payload?: StartParams;
}
const deny=():never=>{throw new ControlError('CONFLICT','Quyền thực thi chiến dịch không còn hợp lệ');};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** Only reads the posting browser; profile-page fixtures do not establish live composer support. */
export async function readPostingIdentity(page:Page):Promise<PageIdentityRead> {
    const identity=parseIdentityHtml(await page.content(),page.url());
    return identity.kind==='page' && /^\d+$/.test(identity.pageId) ? identity
        : {kind:'unknown',pageId:'',pageName:'',category:'',about:'',recentPosts:[]};
}

export function createPageCampaignExecutionGuard(deps:PageCampaignExecutionDeps,scheduleId:string,runId:string):AutonomyExecutionGuard {
    deps.assertCurrent();
    const executions=new PageCampaignExecutionStore(deps.db,deps.clock);
    const initial=executions.get(scheduleId);
    if (!initial || initial.status!=='reserved' || !runId) return deny();
    const variantIndex='ABCDE'.indexOf(initial.selection.variant);
    const poster=new FacebookPosterStore(deps.db);
    const campaigns=new PageCampaignStore(deps.db);
    const business=new PageBusinessStore(deps.db);
    const briefs=new DailyBriefStore(deps.db,deps.clock);
    const works=new PageWorkStore(deps.db,deps.clock);
    const control=new ControlStore(deps.db);
    const clock=deps.clock ?? systemClock;
    function assertCurrent():void {
        deps.assertCurrent();
        if (!deps.protectedWritesEnabled() || !deps.profileExists(initial!.profileId)) deny();
        const execution=executions.get(scheduleId);
        if (!execution || execution.authorityFingerprint!==initial!.authorityFingerprint
            || !same(execution.selection,initial!.selection) || execution.workspaceId!==deps.workspaceId
            || !same([execution.workId,execution.pageId,execution.profileId,execution.grantId,execution.runnerKeyId],
                [initial!.workId,initial!.pageId,initial!.profileId,initial!.grantId,initial!.runnerKeyId])
            || !(execution.status==='reserved' || execution.status==='submitting' && execution.runId===runId)) deny();
        const grant=campaigns.getGrant(initial!.grantId); const link=campaigns.getLink(initial!.campaignId);
        const row=poster.getSchedule(scheduleId); const profile=business.get(initial!.pageId);
        const identity=briefs.getIdentity(initial!.profileId); const work=works.get(initial!.workId);
        if (!grant || !link || !row || !work) return deny();
        if ([grant,link,work].some(value=>value.workspaceId!==initial!.workspaceId || value.pageId!==initial!.pageId || value.profileId!==initial!.profileId)
            || grant.status!=='active' || grant.revision!==initial!.grantRevision || grant.campaignRevision!==link.revision
            || grant.campaignId!==initial!.campaignId || link.deletedAt!==null
            || deps.now()<grant.policy.startsAt || deps.now()>=grant.policy.expiresAt || !grant.policy.actions.includes('schedulePost')
            || grant.policy.timeZone!==(deps.clock?.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
            || !grant.policy.allowedMinutes.includes(clock.minutes(deps.now())) || clock.date(deps.now())!==initial!.plannedDate
            || !profile?.enabled || profile.primaryProfileId!==initial!.profileId || !briefs.getBrief(initial!.profileId)?.enabled
            || identity?.kind!=='page' || identity.pageId!==initial!.pageId || identity.errorCode
            || row.authorityKind!=='autonomy' || row.draft || !row.enabled || row.kind!=='once' || row.runAt===null || row.runAt>deps.now()
            || row.campaignId!==initial!.campaignId || poster.getCampaign(initial!.campaignId)?.status!=='active'
            || row.params.mode!=='page' || !same(row.params.profiles,[{profileId:initial!.profileId,targets:['https://www.facebook.com/']}])) deny();
        for (const [keyId,kind] of [[initial!.runnerKeyId,'page_runner'],[grant.receiverKeyId,'page_receiver']]) {
            const policy=control.findActiveKeyById(keyId)?.policy;
            if (!policy || policy.kind!==kind || policy.workspaceId!==deps.workspaceId
                || !policy.assignments.some(a=>a.pageId===initial!.pageId && a.profileIds.includes(initial!.profileId))) deny();
        }
        for (const ref of [{kind:'draft' as const,id:scheduleId},...((row.params.mediaIds ?? []) as string[]).map(id=>({kind:'media' as const,id}))]) {
            const owner=works.getResourceOwner(ref);
            if (!owner || owner.workId!==initial!.workId || owner.workspaceId!==initial!.workspaceId || owner.pageId!==initial!.pageId) deny();
        }
        if (campaignContentRevision(deps.baseDir,row)!==initial!.selection.contentRevision
            || campaignAuthorityFingerprint(deps.baseDir,business,row,initial!,grant)!==initial!.authorityFingerprint) deny();
        if (deps.payload) {
            const actual=deps.payload;
            if (actual.kind!=='post' || actual.mode!=='page' || actual.campaignId!==row.campaignId
                || actual.text!==row.params.text || !same(actual.variants ?? [],row.params.variants ?? [])
                || (actual.comment ?? '')!==(row.params.comment ?? '') || !same(actual.profiles,row.params.profiles)
                || !same(actual.mediaPaths,resolveScheduleMedia(deps.baseDir,row.id,(row.params.mediaPaths ?? []) as string[]))) deny();
        }
        deps.assertCurrent();
    }
    assertCurrent();
    return {
        variantIndex,
        assertCurrent,
        assertPost(input) {
            assertCurrent();
            const row=poster.getSchedule(scheduleId)!;
            if (input.text!==[row.params.text,...(row.params.variants as string[] ?? [])][variantIndex]
                || (input.comment ?? '')!==(row.params.comment ?? '') || input.targetUrl!=='https://www.facebook.com/'
                || !same(input.mediaPaths,resolveScheduleMedia(deps.baseDir,row.id,(row.params.mediaPaths ?? []) as string[]))) deny();
        },
        async beforeEffect(page,kind) {
            assertCurrent();
            // shortcut: no supported request-correlated post evidence yet; add it before enabling autonomous comments.
            if (kind==='firstComment') throw new ControlError('NEEDS_REVIEW','Chưa chứng minh được định danh bài vừa đăng để bình luận');
            const identity=await readPostingIdentity(page);
            assertCurrent();
            if (identity.kind!=='page' || identity.pageId!==initial.pageId) deny();
            executions.beginSubmit(scheduleId,runId,deps.now());
            assertCurrent();
        },
        settle(outcome,resultId) {
            // Recording an already-sent effect must survive revocation; lifecycle waits before closing this DB.
            const execution=executions.get(scheduleId);
            if (execution?.runId!==runId || !['submitting','uncertain'].includes(execution.status)) return;
            executions.settle(scheduleId,outcome,resultId,deps.now());
        },
    };
}

/** Called before legacy interrupted-run handling and scheduler reload. No provider calls or schema installation. */
export function recoverPageCampaignExecutions(deps:Pick<PageCampaignExecutionDeps,'db'|'now'|'clock'> & {workspaceId?:string}):void {
    const poster=new FacebookPosterStore(deps.db); const executions=new PageCampaignExecutionStore(deps.db,deps.clock);
    const clock=deps.clock ?? systemClock; const now=deps.now();
    deps.db.transaction(()=>{
        const schedules=poster.listSchedules();
        if (deps.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM fb_poster_schedules')?.n!==schedules.length) deny();
        const marked=schedules.filter(row=>row.authorityKind==='autonomy');
        const table=deps.db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_executions'");
        if (!table || !table.n && marked.length) deny();
        if (!table.n) return;
        for (const row of marked) if (!executions.get(row.id)) deny();
        const entries=deps.db.query<{schedule_id:string}>('SELECT schedule_id FROM page_campaign_executions');
        if (deps.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM page_campaign_executions')?.n!==entries.length) deny();
        for (const entry of entries) {
            const execution=executions.get(entry.schedule_id)!; const row=poster.getSchedule(entry.schedule_id);
            if (execution.status==='submitting' || execution.status==='uncertain') {
                const result=execution.workspaceId===deps.workspaceId ? deps.db.queryOne<any>(`SELECT r.id FROM fb_poster_results r JOIN fb_poster_runs u ON u.id=r.run_id
                    WHERE u.id=? AND u.schedule_id=? AND u.campaign_id=? AND u.mode='page' AND r.profile_id=? AND r.outcome='posted'
                    AND r.target_url='https://www.facebook.com/'`,
                    [execution.runId,execution.scheduleId,execution.campaignId,execution.profileId]) : null;
                if (result || execution.status==='submitting') executions.settle(execution.scheduleId,result?'posted':'uncertain',result?.id ?? null,now);
            }
            if (!row || row.authorityKind!=='autonomy') continue;
            const lastRun=row.lastRunId ? poster.getRun(row.lastRunId)?.run : null;
            if (execution.status==='reserved' && execution.workspaceId===deps.workspaceId && lastRun?.status!=='missed' && row.enabled && !row.draft && row.runAt!==null
                && row.runAt>=now-GRACE_MS && clock.date(row.runAt)===execution.plannedDate
                && (row.runAt>=now || clock.date(now)===execution.plannedDate)) {
                poster.updateAutonomySchedule(row.id,{nextRunAt:row.runAt},now,row.revision);
            } else {
                if (execution.status==='reserved') executions.cancel(row.id,execution.revision,now);
                poster.updateAutonomySchedule(row.id,{enabled:false,nextRunAt:null},now,row.revision);
            }
        }
    });
}
