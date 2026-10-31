import { randomUUID } from 'crypto';
import type { CampaignExecution, CampaignPublishedPost, CampaignObservation, CampaignMeasurement, CampaignDecision } from '../../models/pageCampaigns';

export type StoredCampaignDecision = {
    decision: CampaignDecision; scheduleId: string | null; stateHash: string;
    requestHash: string; executionRevision: number | null;
    action: 'schedulePost' | 'updateScheduledPost';
};
import { ResearchStore } from '../research/ResearchStore';

export function campaignPostId(value:string,pageId:string):string {
    return value.startsWith(pageId+'_') && /^\d+$/.test(value.slice(pageId.length+1)) ? value.slice(pageId.length+1) : value;
}

/** Post URLs only; query tracking is discarded, never shorten a lookup to fit search limits. */
export function campaignPostTarget(raw: string): { postId: string; postUrl: string } | null {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !['facebook.com','www.facebook.com','m.facebook.com'].includes(url.hostname)
            || url.username || url.password || url.port) return null;
        const path = url.pathname.replace(/\/+$/, '');
        const match = /^\/([A-Za-z0-9.]+)\/(?:posts|permalink)\/(\d+|pfbid[A-Za-z0-9]+)$/.exec(path);
        if (match) return {postId: match[2], postUrl: `https://www.facebook.com/${match[1]}/posts/${match[2]}`};
        const id=url.searchParams.get('id'), post=url.searchParams.get('story_fbid');
        if (['/permalink.php','/story.php'].includes(path) && id && /^\d+$/.test(id) && post && /^(\d+|pfbid[A-Za-z0-9]+)$/.test(post))
            return {postId:post,postUrl:`https://www.facebook.com/${id}/posts/${post}`};
        return null;
    } catch { return null; }
}
import type { CampaignGrant, CampaignPolicy, CampaignProposal, CampaignProposalInput, CampaignScope, PageCampaignLink } from '../../models/pageCampaigns';
import type { PageConfirmation, WorkLease } from '../../models/pageOperations';
import { FacebookPosterStore, SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { validateCampaignInput } from '../facebookPoster/campaigns';
import { PageWorkStore } from './PageWorkStore';

type Confirmation = PageConfirmation & { receiverKeyId: string };

export class PageCampaignError extends Error {
    constructor(public readonly code: 'INVALID_PARAMS' | 'FORBIDDEN' | 'CONFLICT' | 'INTERNAL', message: string) {
        super(message);
        this.name = 'PageCampaignError';
    }
}
function invalid(): never { throw new PageCampaignError('INVALID_PARAMS', 'Đề nghị chiến dịch không hợp lệ'); }
function text(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) invalid();
}
function integer(value: unknown, min = 0): void {
    if (!Number.isSafeInteger(value) || (value as number) < min) invalid();
}
function fields(value: unknown, allowed: string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function scopeParams(scope: CampaignScope): string[] {
    if (!scope) invalid();
    const params = [scope.workspaceId, scope.pageId, scope.profileId];
    params.forEach(text);
    return params;
}
function assertScope(scope: CampaignScope, value: CampaignScope | null): asserts value is CampaignScope {
    scopeParams(scope);
    if (!value || value.workspaceId !== scope.workspaceId || value.pageId !== scope.pageId || value.profileId !== scope.profileId)
        throw new PageCampaignError('FORBIDDEN', 'Chiến dịch không thuộc phạm vi Page');
}
function mapScope(row: any): CampaignScope {
    return { workspaceId: row.workspace_id, pageId: row.page_id, profileId: row.profile_id };
}
function mapProposal(row: any): CampaignProposal {
    return { ...mapScope(row), id: row.id, workId: row.work_id, revision: row.revision, input: JSON.parse(row.input_json),
        status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function validatePolicy(policy: CampaignPolicy): void {
    fields(policy, ['startsAt', 'expiresAt', 'maxPostsPerDay', 'maxPostsTotal', 'allowedMinutes', 'timeZone', 'actions']);
    integer(policy.startsAt); integer(policy.expiresAt);
    integer(policy.maxPostsPerDay, 1); integer(policy.maxPostsTotal, 1);
    if (policy.startsAt >= policy.expiresAt || !Array.isArray(policy.allowedMinutes) || !policy.allowedMinutes.length
        || new Set(policy.allowedMinutes).size !== policy.allowedMinutes.length
        || Array.from(policy.allowedMinutes).some(minute => !Number.isSafeInteger(minute) || minute < 0 || minute > 1439)
        || !Array.isArray(policy.actions) || !policy.actions.length || new Set(policy.actions).size !== policy.actions.length
        || Array.from(policy.actions).some(action => !['schedulePost', 'updateScheduledPost'].includes(action))) invalid();
    text(policy.timeZone);
    try { new Intl.DateTimeFormat('en', { timeZone: policy.timeZone }); } catch { invalid(); }
}

/** Local persistence only. Trusted callers enforce live identity, gates and receiver authentication. */
export class PageCampaignStore {
    constructor(private readonly db: SqlDatabase) {}

    /** Explicit/additive; no constructor migration or runtime registration. Uses the caller's DB handle. */
    ensureSchema(): void {
        this.db.transaction(() => this.db.exec(`
            CREATE TABLE IF NOT EXISTS page_campaign_links (
                campaign_id TEXT PRIMARY KEY NOT NULL,
                workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, profile_id TEXT NOT NULL,
                revision INTEGER NOT NULL, managed INTEGER NOT NULL CHECK (managed = 1),
                proposal_id TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS page_campaign_proposals (
                id TEXT PRIMARY KEY NOT NULL,
                workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, profile_id TEXT NOT NULL,
                work_id TEXT NOT NULL, revision INTEGER NOT NULL, input_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'cancelled')),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                accepted_revision INTEGER, accepted_campaign_id TEXT, accepted_grant_id TEXT UNIQUE,
                CHECK ((status = 'accepted' AND accepted_revision IS NOT NULL AND accepted_campaign_id IS NOT NULL AND accepted_grant_id IS NOT NULL)
                    OR (status != 'accepted' AND accepted_revision IS NULL AND accepted_campaign_id IS NULL AND accepted_grant_id IS NULL))
            );
            CREATE UNIQUE INDEX IF NOT EXISTS page_campaign_one_pending_work ON page_campaign_proposals(work_id) WHERE status = 'pending';
            CREATE TABLE IF NOT EXISTS page_campaign_grants (
                id TEXT PRIMARY KEY NOT NULL,
                workspace_id TEXT NOT NULL, page_id TEXT NOT NULL, profile_id TEXT NOT NULL,
                campaign_id TEXT NOT NULL, campaign_revision INTEGER NOT NULL, revision INTEGER NOT NULL,
                proposal_id TEXT NOT NULL UNIQUE, policy_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
                receiver_key_id TEXT NOT NULL, confirmed_at INTEGER NOT NULL, confirmation_ref TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS page_campaign_grants_campaign ON page_campaign_grants(campaign_id);
            CREATE TABLE IF NOT EXISTS page_campaign_published (
                result_id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL,
                profile_id TEXT NOT NULL, campaign_id TEXT NOT NULL, record_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS page_campaign_decisions (
                id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL,
                profile_id TEXT NOT NULL, campaign_id TEXT NOT NULL, work_id TEXT NOT NULL,
                step_key TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(work_id,step_key)
            );
            CREATE TABLE IF NOT EXISTS page_campaign_measurements (
                result_id INTEGER NOT NULL, milestone_minutes INTEGER NOT NULL CHECK (milestone_minutes IN (60,1440,4320)),
                scan_id TEXT NOT NULL UNIQUE, completed_at INTEGER, reason TEXT NOT NULL DEFAULT '', observation_json TEXT,
                PRIMARY KEY (result_id,milestone_minutes)
            );
        `));
    }

    /** Explicit captured startup reconciliation after schema installation, never a migration in a constructor. */
    registerSettledResults(workspaceId:string):void {
        const table=this.db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_executions'");
        if(!table)this.failedRead();
        if(!table.n)return;
        this.db.transaction(()=>{
            for(const row of this.rows<{execution_json:string}>("page_campaign_executions WHERE workspace_id=? AND status='posted'",[workspaceId])){
                const execution:CampaignExecution=JSON.parse(row.execution_json);
                if(execution.resultId!==null)this.registerPostedResult(execution);
            }
        });
    }
    /** Internal current-publish evidence only. A legacy result URL is deliberately not proof. */
    registerPostedResult(execution: CampaignExecution, target?: {postId:string;postUrl:string;sourceRef:string}): void {
        this.db.transaction(() => {
            const link=this.getLink(execution.campaignId); assertScope(execution,link);
            const persisted=this.db.queryOne<{execution_json:string}>('SELECT execution_json FROM page_campaign_executions WHERE schedule_id=?',[execution.scheduleId]);
            const actual:CampaignExecution|null=persisted ? JSON.parse(persisted.execution_json) : null;
            if (!actual || actual.status!=='posted' || actual.resultId!==execution.resultId || actual.runId!==execution.runId) invalid();
            assertScope(execution,actual);
            const result=this.db.queryOne<any>(`SELECT r.*,u.started_at,u.schedule_id,u.campaign_id,u.mode,u.kind FROM fb_poster_results r
                JOIN fb_poster_runs u ON u.id=r.run_id WHERE r.id=?`,[execution.resultId]);
            if (!result || result.outcome!=='posted' || result.run_id!==execution.runId || result.schedule_id!==execution.scheduleId
                || result.campaign_id!==execution.campaignId || result.profile_id!==execution.profileId || result.kind!=='post'
                || result.mode!=='page' || result.target_url!=='https://www.facebook.com/') invalid();
            const normalized=target ? campaignPostTarget(target.postUrl) : null;
            if (target && (!normalized || normalized.postId!==target.postId || !target.sourceRef)) invalid();
            const existing=this.listPublished(execution,execution.campaignId).find(row=>row.resultId===execution.resultId);
            if (existing?.sourceRef && target && (existing.postId!==normalized?.postId || existing.postUrl!==normalized?.postUrl || existing.sourceRef!==target.sourceRef)) invalid();
            if (existing && (!target || existing.sourceRef)) return;
            const publishedAt=Number.isSafeInteger(result.created_at) && result.created_at>=result.started_at ? result.created_at : null;
            const row:CampaignPublishedPost={workspaceId:execution.workspaceId,pageId:execution.pageId,profileId:execution.profileId,
                resultId:result.id,campaignId:execution.campaignId,runId:result.run_id,scheduleId:execution.scheduleId,
                runnerKeyId:actual.runnerKeyId,grantId:actual.grantId,selection:actual.selection,comparison:actual.comparison ?? null,publishedAt,
                postId:normalized?.postId ?? null,postUrl:normalized?.postUrl ?? null,sourceRef:target?.sourceRef ?? null,
                reason:normalized ? '' : 'unconfirmed_post_target'};
            this.db.run(`INSERT INTO page_campaign_published VALUES (?,?,?,?,?,?) ON CONFLICT(result_id) DO UPDATE SET record_json=excluded.record_json`,
                [row.resultId,...scopeParams(row),row.campaignId,JSON.stringify(row)]);
            this.changes();
        });
    }

    listPublished(scope:CampaignScope,campaignId:string):CampaignPublishedPost[] {
        assertScope(scope,this.getLink(campaignId));
        return this.rows<any>('page_campaign_published WHERE workspace_id=? AND page_id=? AND profile_id=? AND campaign_id=?',[...scopeParams(scope),campaignId])
            .map(row=>JSON.parse(row.record_json));
    }
    listMeasurements(scope:CampaignScope,campaignId:string):CampaignMeasurement[] {
        const posts=this.listPublished(scope,campaignId);
        return posts.flatMap(post=>this.rows<any>('page_campaign_measurements WHERE result_id=?',[post.resultId]).map(row=>({
            resultId:row.result_id,milestoneMinutes:row.milestone_minutes,scanId:row.scan_id,completedAt:row.completed_at,reason:row.reason,
        })));
    }
    reserveMeasurement(scope:CampaignScope,campaignId:string,resultId:number,milestoneMinutes:CampaignObservation['milestoneMinutes'],scanId:string):void {
        if (!this.listPublished(scope,campaignId).some(row=>row.resultId===resultId) || ![60,1440,4320].includes(milestoneMinutes) || !scanId) invalid();
        this.db.run('INSERT INTO page_campaign_measurements (result_id,milestone_minutes,scan_id) VALUES (?,?,?)',[resultId,milestoneMinutes,scanId]);
        this.changes();
    }
    finishMeasurement(scope:CampaignScope,campaignId:string,resultId:number,milestoneMinutes:number,reason:string,at:number):void {
        if (!this.listPublished(scope,campaignId).some(row=>row.resultId===resultId)) invalid();
        integer(at); text(reason);
        this.db.run('UPDATE page_campaign_measurements SET completed_at=?,reason=? WHERE result_id=? AND milestone_minutes=? AND completed_at IS NULL',[at,reason,resultId,milestoneMinutes]);
        this.changes();
    }
    /** Recheck source on reads too: retention must not turn deleted evidence into durable authority. */
    observationSourceAvailable(observation:CampaignObservation,post:CampaignPublishedPost):boolean {
        const measurement=this.db.queryOne<any>('SELECT * FROM page_campaign_measurements WHERE result_id=? AND milestone_minutes=?',[post.resultId,observation.milestoneMinutes]);
        if (!measurement || measurement.scan_id!==observation.sourceRef || !post.sourceRef || post.postId!==observation.postId || post.postUrl!==observation.postUrl) return false;
        const research=new ResearchStore(this.db),scan=research.getScan(observation.sourceRef);
        if (!scan || scan.source!=='posts' || scan.origin!=='api' || scan.status!=='done' || scan.query!==post.postUrl
            || scan.profileIds.length!==1 || scan.profileIds[0]!==post.profileId || scan.startedAt>observation.observedAt) return false;
        const {items,total}=research.listItems(scan.id,{limit:10});
        if (total>10) return false;
        return items.some(item=>{
            const target=campaignPostTarget(item.url);
            return item.kind==='post' && item.scanId===scan.id && item.profileId===post.profileId
                && campaignPostId(item.fbId,post.pageId)===post.postId && target?.postId===post.postId && target.postUrl===post.postUrl
                && item.authorKind==='page' && item.authorId===post.pageId && item.capturedAt===observation.observedAt
                && item.reactions===observation.reactions && item.comments===observation.comments && item.shares===observation.shares;
        });
    }
    recordObservation(observation:CampaignObservation):void {
        this.db.transaction(()=>{
            const row=this.db.queryOne<any>('SELECT record_json FROM page_campaign_published WHERE result_id=?',[observation.resultId]);
            const post:CampaignPublishedPost|null=row ? JSON.parse(row.record_json) : null;
            if (!post || observation.pageId!==post.pageId || observation.campaignId!==post.campaignId || observation.publishedAt!==post.publishedAt
                || !this.observationSourceAvailable(observation,post)) invalid();
            integer(observation.observedAt);
            const counts=[observation.reactions,observation.comments,observation.shares];
            counts.forEach(count=>{if(count!==null)integer(count);});
            if ((counts.every(count=>count!==null) ? 'measured' : 'unavailable')!==observation.status) invalid();
            this.db.run('UPDATE page_campaign_measurements SET completed_at=?,reason=?,observation_json=? WHERE result_id=? AND milestone_minutes=? AND completed_at IS NULL',
                [observation.observedAt,observation.reason,JSON.stringify(observation),post.resultId,observation.milestoneMinutes]);
            this.changes();
        });
    }
    listObservations(scope:CampaignScope,campaignId:string,from:number,to:number):CampaignObservation[] {
        integer(from);integer(to);if(from>to)invalid();
        return this.listPublished(scope,campaignId).flatMap(post=>this.rows<any>(
            'page_campaign_measurements WHERE result_id=? AND completed_at>=? AND completed_at<=? AND observation_json IS NOT NULL',[post.resultId,from,to])
            .map(row=>JSON.parse(row.observation_json)));
    }

    getLatestDecision(scope:CampaignScope,campaignId:string):CampaignDecision|null {
        assertScope(scope,this.getLink(campaignId));
        const row=this.rows<{record_json:string}>(`page_campaign_decisions WHERE id=(SELECT id FROM page_campaign_decisions
            WHERE workspace_id=? AND page_id=? AND profile_id=? AND campaign_id=?
            ORDER BY json_extract(record_json,'$.decision.createdAt') DESC,id DESC LIMIT 1)`,[...scopeParams(scope),campaignId])[0];
        if(!row)return null;
        const {id,campaignId:recordCampaignId,grantId,grantRevision,kind,before,after,observationRefs,sampleSizes,coverage,reason,createdAt}=JSON.parse(row.record_json).decision;
        return {id,campaignId:recordCampaignId,grantId,grantRevision,kind,before,after,observationRefs,sampleSizes,coverage,reason,createdAt};
    }

    getDecision(scope:CampaignScope,campaignId:string,workId:string,stepKey:string):StoredCampaignDecision|null {
        assertScope(scope,this.getLink(campaignId));
        const row=this.rows<{record_json:string}>('page_campaign_decisions WHERE workspace_id=? AND page_id=? AND profile_id=? AND campaign_id=? AND work_id=? AND step_key=?',
            [...scopeParams(scope),campaignId,workId,stepKey])[0];
        return row ? JSON.parse(row.record_json) : null;
    }
    saveDecision(scope:CampaignScope,workId:string,stepKey:string,record:StoredCampaignDecision):void {
        assertScope(scope,this.getLink(record.decision.campaignId));
        this.db.run('INSERT INTO page_campaign_decisions VALUES (?,?,?,?,?,?,?,?)',
            [record.decision.id,...scopeParams(scope),record.decision.campaignId,workId,stepKey,JSON.stringify(record)]);
        this.changes();
        if(!this.getDecision(scope,record.decision.campaignId,workId,stepKey))this.failedRead();
    }

    getLink(campaignId: string): PageCampaignLink | null {
        const row = this.rows<any>('page_campaign_links WHERE campaign_id = ?', [campaignId])[0];
        return row ? { ...mapScope(row), campaignId: row.campaign_id, revision: row.revision, managed: true,
            proposalId: row.proposal_id, createdAt: row.created_at, deletedAt: row.deleted_at } : null;
    }

    list(scope: CampaignScope): PageCampaignLink[] {
        return this.rows<any>('page_campaign_links WHERE workspace_id = ? AND page_id = ? AND profile_id = ?', scopeParams(scope))
            .map(row => this.getLink(row.campaign_id)!);
    }

    listProposals(scope: CampaignScope): CampaignProposal[] {
        return this.rows<any>('page_campaign_proposals WHERE workspace_id = ? AND page_id = ? AND profile_id = ?', scopeParams(scope)).map(mapProposal);
    }

    getProposal(id: string): CampaignProposal | null {
        const row = this.rows<any>('page_campaign_proposals WHERE id = ?', [id])[0];
        return row ? mapProposal(row) : null;
    }

    saveProposal(scope: CampaignScope, lease: WorkLease, input: CampaignProposalInput, expectedRevision: number | null, now: number): CampaignProposal {
        scopeParams(scope); integer(now);
        if (expectedRevision !== null) integer(expectedRevision, 1);
        return this.db.transaction(() => {
            assertScope(scope, new PageWorkStore(this.db).assertLease(lease, now));
            const validated = this.validateInput(scope, input);
            const pending = this.rows<any>("page_campaign_proposals WHERE work_id = ? AND status = 'pending'", [lease.workId])[0];
            if ((pending?.revision ?? null) !== expectedRevision)
                throw new PageCampaignError('CONFLICT', 'Đề nghị đã thay đổi, cần đọc lại');
            if (pending) assertScope(scope, mapScope(pending));
            const id = pending?.id ?? randomUUID();
            if (pending) {
                this.db.run(`UPDATE page_campaign_proposals SET input_json = ?, revision = revision + 1, updated_at = ?
                    WHERE id = ? AND revision = ? AND status = 'pending'`, [JSON.stringify(validated), now, id, expectedRevision]);
            } else {
                this.db.run(`INSERT INTO page_campaign_proposals
                    (id, workspace_id, page_id, profile_id, work_id, revision, input_json, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?)`, [id, ...scopeParams(scope), lease.workId, JSON.stringify(validated), now, now]);
            }
            this.changes();
            const saved = this.getProposal(id);
            if (!saved || saved.revision !== (expectedRevision ?? 0) + 1) this.failedRead();
            return saved;
        });
    }

    getGrant(id: string): CampaignGrant | null {
        const row = this.rows<any>('page_campaign_grants WHERE id = ?', [id])[0];
        return row ? { ...mapScope(row), id: row.id, campaignId: row.campaign_id, campaignRevision: row.campaign_revision,
            revision: row.revision, policy: JSON.parse(row.policy_json), status: row.status, receiverKeyId: row.receiver_key_id,
            confirmedAt: row.confirmed_at, confirmationRef: row.confirmation_ref } : null;
    }

    listGrants(campaignId: string): CampaignGrant[] {
        return this.rows<any>('page_campaign_grants WHERE campaign_id = ?', [campaignId]).map(row => {
            const grant = this.getGrant(row.id);
            if (!grant) this.failedRead();
            return grant;
        });
    }

    /** Internal trusted receiver method; never a runner endpoint. No scheduler/effects inside the transaction. */
    acceptProposal(scope: CampaignScope, proposalId: string, expectedRevision: number, confirmation: Confirmation, now: number): { campaignId: string; grantId: string } {
        scopeParams(scope); text(proposalId); integer(expectedRevision, 1); integer(now);
        if (!confirmation) invalid();
        integer(confirmation.confirmedAt); text(confirmation.confirmationRef); text(confirmation.receiverKeyId);
        if (confirmation.confirmedAt > now) invalid();
        return this.db.transaction(() => {
            const row = this.rows<any>('page_campaign_proposals WHERE id = ?', [proposalId])[0];
            const proposal = row ? mapProposal(row) : null;
            assertScope(scope, proposal);
            if (!proposal) this.failedRead();
            // Replay survives work pruning, grant revocation and campaign tombstones; it never issues new authority.
            if (proposal.status === 'accepted') {
                const grant = this.getGrant(row.accepted_grant_id);
                if (!grant) this.failedRead();
                assertScope(scope, grant);
                if (row.accepted_revision !== expectedRevision || grant.receiverKeyId !== confirmation.receiverKeyId
                    || grant.confirmationRef !== confirmation.confirmationRef || grant.confirmedAt !== confirmation.confirmedAt)
                    throw new PageCampaignError('CONFLICT', 'Xác nhận không khớp đề nghị đã nhận');
                return { campaignId: row.accepted_campaign_id, grantId: grant.id };
            }
            if (proposal.status !== 'pending' || proposal.revision !== expectedRevision)
                throw new PageCampaignError('CONFLICT', 'Đề nghị đã thay đổi, cần đọc lại');
            const input = this.validateInput(scope, proposal.input);
            if (input.policy.expiresAt <= now) throw new PageCampaignError('CONFLICT', 'Đề nghị đã hết hạn');
            const poster = new FacebookPosterStore(this.db);
            const campaignId = input.campaignId ?? randomUUID();
            const campaignRevision = input.expectedCampaignRevision === undefined ? 1 : input.expectedCampaignRevision + 1;
            const campaign = { name: input.name, goal: input.goal, startAt: input.policy.startsAt, endAt: input.policy.expiresAt };
            if (input.campaignId) {
                // A newly confirmed policy supersedes previous authority without deleting its audit record.
                for (const grant of this.listGrants(campaignId)) {
                    if (grant.status === 'active') this.revokeGrant(scope, grant.id, grant.revision, now);
                }
                poster.updateCampaign(campaignId, campaign, now);
                this.changes();
                this.db.run(`UPDATE page_campaign_links SET revision = revision + 1, proposal_id = ?
                    WHERE campaign_id = ? AND revision = ? AND deleted_at IS NULL`, [proposalId, campaignId, input.expectedCampaignRevision]);
            } else {
                poster.createCampaign({ ...campaign, id: campaignId, status: 'active', createdAt: now, updatedAt: now });
                this.changes();
                this.db.run(`INSERT INTO page_campaign_links
                    (campaign_id, workspace_id, page_id, profile_id, revision, managed, proposal_id, created_at, deleted_at)
                    VALUES (?, ?, ?, ?, 1, 1, ?, ?, NULL)`, [campaignId, ...scopeParams(scope), proposalId, now]);
            }
            this.changes();
            if (!poster.getCampaign(campaignId)) this.failedRead();
            const grantId = randomUUID();
            this.db.run(`INSERT INTO page_campaign_grants
                (id, workspace_id, page_id, profile_id, campaign_id, campaign_revision, revision, proposal_id, policy_json,
                    status, receiver_key_id, confirmed_at, confirmation_ref)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?, ?)`, [grantId, ...scopeParams(scope), campaignId,
                campaignRevision, proposalId, JSON.stringify(input.policy), confirmation.receiverKeyId, confirmation.confirmedAt, confirmation.confirmationRef]);
            this.changes();
            this.db.run(`UPDATE page_campaign_proposals SET status = 'accepted', revision = revision + 1, updated_at = ?,
                accepted_revision = ?, accepted_campaign_id = ?, accepted_grant_id = ? WHERE id = ? AND revision = ? AND status = 'pending'`,
            [now, expectedRevision, campaignId, grantId, proposalId, expectedRevision]);
            this.changes();
            if (!this.getGrant(grantId) || this.getLink(campaignId)?.revision !== campaignRevision
                || this.getProposal(proposalId)?.status !== 'accepted') this.failedRead();
            return { campaignId, grantId };
        });
    }

    /** Internal trusted receiver method. Schedule cancellation belongs to the later operations layer. */
    revokeGrant(scope: CampaignScope, grantId: string, expectedRevision: number, now: number): void {
        scopeParams(scope); text(grantId); integer(expectedRevision, 1); integer(now);
        this.db.transaction(() => {
            const grant = this.getGrant(grantId);
            assertScope(scope, grant);
            if (!grant || grant.revision !== expectedRevision || grant.status !== 'active')
                throw new PageCampaignError('CONFLICT', 'Quyền chiến dịch đã thay đổi');
            this.db.run(`UPDATE page_campaign_grants SET status = 'revoked', revision = revision + 1
                WHERE id = ? AND revision = ? AND status = 'active'`, [grantId, expectedRevision]);
            this.changes();
            const saved = this.getGrant(grantId);
            if (saved?.revision !== expectedRevision + 1 || saved.status !== 'revoked') this.failedRead();
        });
    }

    private validateInput(scope: CampaignScope, input: CampaignProposalInput): CampaignProposalInput {
        fields(input, ['name', 'goal', 'policy', 'campaignId', 'expectedCampaignRevision']);
        text(input.name);
        if (typeof input.goal !== 'string') invalid();
        validatePolicy(input.policy);
        if ((input.campaignId !== undefined) !== (input.expectedCampaignRevision !== undefined)) invalid();
        const poster = new FacebookPosterStore(this.db);
        let existing;
        if (input.campaignId !== undefined) {
            text(input.campaignId); integer(input.expectedCampaignRevision, 1);
            const link = this.getLink(input.campaignId);
            assertScope(scope, link);
            if (!link || link.deletedAt !== null || link.revision !== input.expectedCampaignRevision)
                throw new PageCampaignError('CONFLICT', 'Liên kết chiến dịch đã thay đổi hoặc bị xoá');
            existing = poster.getCampaign(input.campaignId);
            if (!existing) this.failedRead();
            if (existing.status === 'archived') throw new PageCampaignError('CONFLICT', 'Chiến dịch đã lưu trữ');
        }
        // Shared validator's name lookup needs the same fail-closed count check as our own tables.
        const campaignRows = this.rows<any>('fb_poster_campaigns');
        const campaigns = poster.listCampaigns({ includeArchived: true });
        if (campaigns.length !== campaignRows.length) this.failedRead();
        let validated;
        try {
            validated = validateCampaignInput({ name: input.name, goal: input.goal }, { existing,
                findByName: name => campaigns.find(c => c.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null });
        } catch (error) {
            throw new PageCampaignError('INVALID_PARAMS', (error as Error).message);
        }
        return { ...input, name: validated.name, goal: validated.goal };
    }

    private rows<T>(from: string, params: unknown[] = []): T[] {
        const count = this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from}`, params);
        if (!count || !Number.isSafeInteger(count.n) || count.n < 0) this.failedRead();
        const rows = this.db.query<T>(`SELECT * FROM ${from} ORDER BY rowid`, params);
        if (rows.length !== count.n) this.failedRead();
        return rows;
    }
    private changes(): void {
        const row = this.db.queryOne<{ n: number }>('SELECT changes() AS n');
        if (!row || row.n !== 1) throw new PageCampaignError('INTERNAL', 'Không ghi được chiến dịch Page');
    }
    private failedRead(): never { throw new PageCampaignError('INTERNAL', 'Không đọc đủ chiến dịch Page'); }
}
