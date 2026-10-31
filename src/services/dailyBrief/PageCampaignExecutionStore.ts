import type { CampaignExecution, CampaignGrant, CampaignComparison } from '../../models/pageCampaigns';
import { IMAGE_EXTENSIONS, extensionOf, isVideo } from '../facebookPoster/mediaRules';

export function campaignFormat(params:Record<string,unknown>):CampaignComparison['format']|null {
    const media=params.mediaPaths;
    if(!Array.isArray(media) || media.some(p=>typeof p!=='string'))return null;
    if(!media.length)return 'text';
    if(media.length===1 && isVideo(media[0]))return 'video';
    return media.every(p=>IMAGE_EXTENSIONS.includes(extensionOf(p)))?'image':null;
}
import { ControlError } from '../control/ControlMethods';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL } from '../facebookPoster/schema';
import { computeNextRun } from '../facebookPoster/scheduleTime';
import { DailyBriefStore, systemClock, type LocalClock } from './DailyBriefStore';
import { PageCampaignStore } from './PageCampaignStore';
import { PageWorkStore } from './PageWorkStore';

/** Internal DB-only revocation; the caller wraps grant, reservation and ticket changes atomically. */
export function cancelCampaignGrantAuthority(db:SqlDatabase, grant:CampaignGrant, now:number, clock?:LocalClock):void {
    const executions=new PageCampaignExecutionStore(db,clock); const poster=new FacebookPosterStore(db); const works=new PageWorkStore(db,clock);
    const params=[grant.workspaceId,grant.pageId,grant.campaignId,grant.id];
    const from='page_campaign_executions WHERE workspace_id=? AND page_id=? AND campaign_id=? AND grant_id=?';
    const table=db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_executions'");
    if (!table) throw new ControlError('INTERNAL','Không đọc được schema reservation');
    const marked=db.query<{id:string}>("SELECT id FROM fb_poster_schedules WHERE campaign_id=? AND authority_kind='autonomy'",[grant.campaignId]);
    const markedCount=db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM fb_poster_schedules WHERE campaign_id=? AND authority_kind='autonomy'",[grant.campaignId]);
    if (!markedCount || markedCount.n !== marked.length || (!table.n && marked.length))
        throw new ControlError('INTERNAL','Lịch tự động thiếu journal reservation');
    for (const schedule of marked) {
        const execution=executions.get(schedule.id);
        if (!execution || execution.workspaceId !== grant.workspaceId || execution.pageId !== grant.pageId || execution.campaignId !== grant.campaignId)
            throw new ControlError('INTERNAL','Lịch tự động thiếu authority');
    }
    const rows=table.n ? db.query<{schedule_id:string;work_id:string}>(`SELECT schedule_id,work_id FROM ${from}`,params) : [];
    const count=table.n ? db.queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM ${from}`,params) : {n:0};
    if (!count || count.n !== rows.length) throw new ControlError('INTERNAL','Không đọc đủ lịch để thu hồi');
    for (const row of rows) {
        const execution=executions.get(row.schedule_id)!; const schedule=poster.getSchedule(row.schedule_id);
        if (execution.status !== 'reserved') continue;
        executions.cancel(execution.scheduleId,execution.revision,now);
        if (schedule?.authorityKind === 'autonomy') poster.updateAutonomySchedule(schedule.id,{enabled:false,nextRunAt:null},now,schedule.revision);
    }
    const workIds=new Set(rows.map(row => row.work_id));
    for (const item of works.list([grant.pageId])) {
        if (item.workspaceId !== grant.workspaceId || item.profileId !== grant.profileId || ['completed','cancelled','failed'].includes(item.status)) continue;
        if (item.campaignId === grant.campaignId || workIds.has(item.id)) works.stopPreparation(item.id,'cancelled',now);
    }
}

export const CAMPAIGN_SCHEDULE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

const fail = (code:'CONFLICT'|'LIMIT_EXCEEDED'|'FORBIDDEN'|'INTERNAL', message:string):never => {throw new ControlError(code,message);};

/** Internal, same-connection authority ledger. No provider effects; callers atomically promote the schedule. */
export class PageCampaignExecutionStore {
    constructor(private readonly db:SqlDatabase, private readonly clock:LocalClock & {timeZone?():string}=systemClock) {}
    ensureSchema():void {
        this.db.transaction(() => {
            this.db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
            for (const row of this.checked<{id:string;campaign_id:string|null}>("fb_poster_schedules WHERE authority_kind='autonomy'")) {
                const execution=this.get(row.id);
                if (!execution || execution.scheduleId !== row.id || execution.campaignId !== row.campaign_id) fail('CONFLICT','Lịch tự động thiếu authority');
            }
        });
    }
    get(scheduleId:string):CampaignExecution|null {
        return this.rows('WHERE schedule_id = ?', [scheduleId])[0] ?? null;
    }
    reserve(input:CampaignExecution, now:number):CampaignExecution {
        return this.db.transaction(() => {
            // Acquire the SQLite writer before quota reads, including on a second connection.
            this.db.run('UPDATE page_campaign_executions SET revision = revision WHERE schedule_id = ?', [input.scheduleId]);
            const previous=this.get(input.scheduleId);
            if (input.status !== 'reserved' || input.actualDate !== null || input.runId !== null || input.resultId !== null
                || input.revision !== (previous?.revision ?? 0)+1 || (previous && (previous.status !== 'reserved'
                    || ['workspaceId','pageId','profileId','workId','campaignId','grantId','runnerKeyId'].some(key => previous[key as keyof CampaignExecution] !== input[key as keyof CampaignExecution]))))
                fail('CONFLICT','Reservation đã thay đổi');
            const grant=this.authority(input,now);
            const schedule=new FacebookPosterStore(this.db).getSchedule(input.scheduleId);
            if (!schedule || schedule.kind !== 'once' || schedule.runAt === null || this.clock.date(schedule.runAt) !== input.plannedDate
                || schedule.runAt < now+60000 || schedule.runAt > now+CAMPAIGN_SCHEDULE_HORIZON_MS
                || schedule.runAt < grant.policy.startsAt || schedule.runAt >= grant.policy.expiresAt
                || !grant.policy.allowedMinutes.includes(this.clock.minutes(schedule.runAt))) fail('CONFLICT','Giờ đăng ngoài quyền chiến dịch');
            this.quota(input, grant, input.plannedDate, now);
            this.write(input,previous?.revision);
            return this.get(input.scheduleId)!;
        });
    }
    cancel(scheduleId:string, expectedRevision:number, _now:number):void {
        this.db.transaction(() => {
            const execution=this.get(scheduleId);
            if (!execution) fail('FORBIDDEN','Không có quyền lịch tự động');
            if (execution.status === 'cancelled' && (expectedRevision === execution.revision || expectedRevision === execution.revision-1)) return;
            if (execution.status !== 'reserved' || execution.revision !== expectedRevision) fail('CONFLICT','Lịch đã gửi hoặc đã thay đổi');
            this.write({...execution,status:'cancelled',revision:execution.revision+1},expectedRevision);
        });
    }
    beginSubmit(scheduleId:string, runId:string, now:number):CampaignExecution {
        return this.db.transaction(() => {
            this.db.run('UPDATE page_campaign_executions SET revision = revision WHERE schedule_id = ?', [scheduleId]);
            const execution=this.get(scheduleId);
            if (!execution || execution.status !== 'reserved' || !runId) fail('CONFLICT','Lịch không còn chờ gửi');
            const grant=this.authority(execution,now);
            const actualDate=this.clock.date(now);
            if (execution.plannedDate !== actualDate || !grant.policy.allowedMinutes.includes(this.clock.minutes(now)))
                fail('CONFLICT','Không chạy bù lịch qua ngày hoặc khung giờ');
            const run=new FacebookPosterStore(this.db).getRun(runId)?.run;
            const format=run && run.scheduleId===scheduleId && run.campaignId===execution.campaignId && run.kind==='post' && run.mode==='page'
                ? campaignFormat(run.params) : null;
            const comparison=format ? {format,minute:this.clock.minutes(now)} : null;
            const saved={...execution,comparison,actualDate,status:'submitting' as const,runId,revision:execution.revision+1};
            // Bind the run before quota reads so this same-transaction run is not mistaken for an owner effect.
            this.write(saved,execution.revision);
            this.quota(saved,grant,actualDate,now);
            return this.get(scheduleId)!;
        });
    }
    settle(scheduleId:string, outcome:'posted'|'uncertain', resultId:number|null, _now:number):void {
        this.db.transaction(() => {
            const execution=this.get(scheduleId);
            if (!execution || !['posted','uncertain'].includes(outcome) || (resultId !== null && (!Number.isSafeInteger(resultId) || resultId < 1)))
                fail('CONFLICT','Kết quả lịch không hợp lệ');
            if (execution.status === outcome && execution.resultId === resultId) {
                if (outcome==='posted' && resultId!==null) this.recordMeasurement(execution);
                return;
            }
            if (execution.status !== 'submitting' && !(execution.status === 'uncertain' && outcome === 'posted'))
                fail('CONFLICT','Không thể đổi kết quả đã ghi');
            const settled={...execution,status:outcome,resultId,revision:execution.revision+1};
            this.write(settled,execution.revision);
            if (outcome==='posted' && resultId!==null) this.recordMeasurement(settled);
        });
    }
    private recordMeasurement(execution:CampaignExecution):void {
        const table=this.db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_published'");
        if(!table)fail('INTERNAL','Không đọc được schema số liệu');
        // Task4 crash recovery precedes explicit Task5 composition; startup backfills after installation.
        if(table.n)new PageCampaignStore(this.db).registerPostedResult(execution);
    }
    private authority(input:CampaignExecution, now:number):CampaignGrant {
        const campaigns=new PageCampaignStore(this.db); const grant=campaigns.getGrant(input.grantId); const link=campaigns.getLink(input.campaignId);
        if (!grant || !link || link.deletedAt !== null || grant.status !== 'active' || grant.revision !== input.grantRevision
            || grant.campaignId !== input.campaignId || grant.campaignRevision !== link.revision
            || [grant,link].some(row => row.workspaceId !== input.workspaceId || row.pageId !== input.pageId || row.profileId !== input.profileId)
            || now < grant.policy.startsAt || now >= grant.policy.expiresAt
            || grant.policy.timeZone !== (this.clock.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone)) fail('CONFLICT','Quyền chiến dịch không còn hiệu lực');
        return grant;
    }
    private quota(input:CampaignExecution, grant:CampaignGrant, date:string, now:number):void {
        const executions=this.rows("WHERE workspace_id = ? AND page_id = ? AND status != 'cancelled'",[input.workspaceId,input.pageId])
            .filter(row => row.scheduleId !== input.scheduleId);
        if (executions.filter(row => row.grantId === input.grantId).length >= grant.policy.maxPostsTotal)
            fail('LIMIT_EXCEEDED','Đã hết hạn mức toàn grant');
        const brief=new DailyBriefStore(this.db,this.clock).getBrief(input.profileId);
        if (!brief?.enabled) fail('CONFLICT','Daily brief đã dừng');
        const grants=this.checked<any>("page_campaign_grants WHERE workspace_id = ? AND page_id = ? AND status = 'active'",[input.workspaceId,input.pageId])
            .map(row => JSON.parse(row.policy_json) as CampaignGrant['policy']).filter(policy => now >= policy.startsAt && now < policy.expiresAt);
        const daily=Math.min(brief.draftsPerDay,grant.policy.maxPostsPerDay,...grants.map(policy => policy.maxPostsPerDay));
        const occupied=executions.filter(row => (row.actualDate ?? row.plannedDate) === date).length + this.ownerUsage(input,date,now);
        if (!Number.isSafeInteger(daily) || daily < 1 || occupied >= daily) fail('LIMIT_EXCEEDED','Đã hết hạn mức Page trong ngày');
    }
    private ownerUsage(input:CampaignExecution, date:string, now:number):number {
        const briefs=new DailyBriefStore(this.db,this.clock);
        const samePage=(profileId:string):boolean => {
            const identity=briefs.getIdentity(profileId);
            if (!identity || identity.kind !== 'page' || !identity.pageId || identity.errorCode) {
                if (profileId === input.profileId) fail('CONFLICT','Không xác định được Page của lịch chủ');
                return false;
            }
            return identity.pageId === input.pageId;
        };
        const seen=new Set<string>();
        let effects=0;
        // Owner history has no immutable Page attribution: charge possible effects, not guessed Pages.
        const inInterval=(start:number,end:number):boolean => {
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
                fail('CONFLICT','Không xác định được thời gian lượt chủ');
            return this.clock.date(start) <= date && date <= this.clock.date(end);
        };
        for (const result of this.checked<any>('fb_poster_results')) {
            if (!this.db.queryOne('SELECT id FROM fb_poster_runs WHERE id=?',[result.run_id]))
                fail('CONFLICT','Kết quả chủ thiếu lượt chạy để đối soát');
        }
        for (const run of this.checked<any>("fb_poster_runs WHERE kind='post' AND mode='page'")) {
            const execution=run.schedule_id ? this.get(run.schedule_id) : null;
            if (execution?.runId === run.id) continue;
            // Only a still-reserved execution of another Page charges this running run to its own Page; an
            // invalidated (cancelled) one may now drive an owner run here, so it stays conservatively charged.
            if (execution && execution.status === 'reserved' && execution.runId === null && run.status === 'running'
                && (execution.workspaceId !== input.workspaceId || execution.pageId !== input.pageId)) continue;
            const results=this.checked<any>('fb_poster_results WHERE run_id=?',[run.id]);
            for (const result of results) {
                // A legacy failed/skipped label alone is not durable proof that no request was sent.
                if (inInterval(run.started_at,result.created_at)) {
                    effects++;
                    seen.add(`run:${run.id}`);
                }
            }
            if (run.status === 'missed') continue;
            if (run.status === 'running') {
                if (!Number.isSafeInteger(run.started_at)) fail('CONFLICT','Không xác định được thời gian lượt chủ');
                if (date < this.clock.date(run.started_at)) continue;
            } else if (!inInterval(run.started_at,run.finished_at)) continue;
            let profiles:unknown;
            try {profiles=JSON.parse(run.params_json).profiles;} catch {fail('CONFLICT','Không đọc được lượt chủ');}
            if (!Array.isArray(profiles) || !profiles.length || profiles.some(p => !p || typeof p.profileId !== 'string' || !p.profileId))
                return fail('CONFLICT','Không xác định được số effect tối đa của lượt chủ');
            const remaining=new Map<string,number>();
            for (const profile of profiles) remaining.set(profile.profileId,(remaining.get(profile.profileId) ?? 0)+1);
            for (const result of results) {
                const count=remaining.get(result.profile_id) ?? 0;
                if (count > 0) remaining.set(result.profile_id,count-1);
            }
            const unresolved=[...remaining.values()].reduce((sum,count) => sum+count,0);
            if (unresolved) {effects+=unresolved; seen.add(`run:${run.id}`);}
        }
        const schedules=new FacebookPosterStore(this.db).listSchedules();
        const count=this.db.queryOne<{n:number}>('SELECT COUNT(*) AS n FROM fb_poster_schedules');
        if (!count || count.n !== schedules.length) fail('INTERNAL','Không đọc đủ lịch chủ');
        for (const schedule of schedules) {
            if (schedule.id === input.scheduleId) continue;
            if (schedule.authorityKind === 'autonomy') {
                const execution=this.get(schedule.id);
                if (!execution || execution.scheduleId !== schedule.id || execution.campaignId !== schedule.campaignId) fail('CONFLICT','Lịch tự động thiếu authority');
                const profiles=schedule.params.profiles;
                if (!Array.isArray(profiles)) return fail('CONFLICT','Không xác định được Page của lịch tự động');
                if (profiles.some(p => samePage(p.profileId)) && (execution.workspaceId !== input.workspaceId || execution.pageId !== input.pageId))
                    fail('CONFLICT','Lịch tự động thiếu authority');
                continue;
            }
            if (schedule.draft || !schedule.enabled || schedule.params.mode !== 'page') continue;
            const profiles=schedule.params.profiles;
            if (!Array.isArray(profiles) || !profiles.length || profiles.some(p => !p || typeof p.profileId!=='string' || !p.profileId))
                return fail('CONFLICT','Không xác định được Page của lịch chủ');
            // Future owner effects have no immutable Page binding either; preserve their full capacity.
            for (const profile of profiles) samePage(profile.profileId);
            let occurrence=schedule.nextRunAt;
            for (let i=0;occurrence !== null && i<9;i++) {
                const localDate=this.clock.date(occurrence);
                if (localDate > date) break;
                if (localDate === date) {
                    const last=schedule.lastRunId ? this.db.queryOne<any>('SELECT * FROM fb_poster_runs WHERE id = ?',[schedule.lastRunId]) : null;
                    const consumed=last && last.schedule_id === schedule.id && occurrence <= last.started_at
                        && this.clock.date(last.started_at) === localDate && seen.has(`run:${last.id}`);
                    if (!consumed) profiles.forEach((_profile,index) => seen.add(`schedule:${schedule.id}:${occurrence}:${index}`));
                }
                if (schedule.kind === 'once') break;
                const next=computeNextRun(schedule,Math.max(occurrence,now));
                if (next !== null && next <= occurrence) fail('CONFLICT','Không tính được lần chạy của lịch chủ');
                occurrence=next;
            }
        }
        return effects+[...seen].filter(key => key.startsWith('schedule:')).length;
    }
    private rows(where:string, params:unknown[]=[]):CampaignExecution[] {
        return this.checked<any>(`page_campaign_executions ${where}`,params).map(row => JSON.parse(row.execution_json));
    }
    private checked<T>(from:string,params:unknown[]=[]):T[] {
        const count=this.db.queryOne<{n:number}>(`SELECT COUNT(*) AS n FROM ${from}`,params);
        const rows=this.db.query<T>(`SELECT * FROM ${from}`,params);
        if (!count || count.n !== rows.length) fail('INTERNAL','Không đọc đủ dữ liệu quota');
        return rows;
    }
    private write(input:CampaignExecution, previousRevision?:number):void {
        const fields=[input.workspaceId,input.pageId,input.profileId,input.workId,input.campaignId,input.grantId,input.plannedDate,input.actualDate,input.status,input.revision,JSON.stringify(input)];
        if (previousRevision === undefined) this.db.run(`INSERT INTO page_campaign_executions
            (workspace_id,page_id,profile_id,work_id,campaign_id,grant_id,planned_date,actual_date,status,revision,execution_json,schedule_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[...fields,input.scheduleId]);
        else this.db.run(`UPDATE page_campaign_executions SET workspace_id=?,page_id=?,profile_id=?,work_id=?,campaign_id=?,grant_id=?,planned_date=?,actual_date=?,status=?,revision=?,execution_json=?
            WHERE schedule_id=? AND revision=?`,[...fields,input.scheduleId,previousRevision]);
        if (this.db.queryOne<{n:number}>('SELECT changes() AS n')?.n !== 1) fail('CONFLICT','Reservation đã thay đổi');
        if (this.get(input.scheduleId)?.revision !== input.revision) fail('INTERNAL','Không ghi được reservation');
    }
}
