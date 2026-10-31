import type { PageBusiness, PageContext, PageFact, PageFactInput, PageWork } from '../../models/pageOperations';
import { DailyBriefStore, type LocalClock } from '../dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../dailyBrief/PageCampaignExecutionStore';
import { createPageCampaignOperations } from '../dailyBrief/pageCampaignOperations';
import { assertPagePreparationIdle, createPageWorkOperations, type PageWorkOperationsDeps } from '../dailyBrief/pageWorkOperations';
import { createPageApprovalOperations, type PageApprovalDeps } from '../dailyBrief/pageApprovalOperations';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { ResearchStore } from '../research/ResearchStore';
import { ControlError, toControlError, EVENTS_PAGE_LIMIT, EVENTS_MAX_TIMEOUT_SEC, type ControlContext, type ControlMethod, type ControlParams } from './ControlMethods';
import { authorizeMethod, isPageRunnerMutation } from './controlAuthorization';
import { ControlStore } from './ControlStore';
import { projectPageCampaignEvent, projectPageWorkEvent } from './controlEvents';

/** Captured once for this request, on the SAME handle used by preparation and receiver approvals. */
export interface PageOperationRequest {
    db: SqlDatabase;
    dbPath: string;
    workspaceId: string;
    assertCurrent(): void;
    protectedWritesEnabled(): boolean;
    now(): number;
    clock?: LocalClock;
    campaignCollector?: Pick<import('../facebookPoster/PageCampaignTracker').PageCampaignTracker,'collect'>;
    work: Omit<PageWorkOperationsDeps, 'db' | 'context' | 'assertCurrent' | 'now' | 'clock'>;
    approval: Omit<PageApprovalDeps, 'db' | 'receiver' | 'assertCurrent' | 'now' | 'clock'>;
    waitForEvent(after: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    /** Post-commit wake hint only, must not insert another event. */
    notify(): void;
}
export interface PageOperationMethodDeps {
    /** Runtime must capture workspace/path/generation and live credential, never a mutable current principal. */
    bindRequest(context: ControlContext): PageOperationRequest;
}

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
    items?: Schema; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; oneOf?: Schema[] };
const text: Schema = { type: 'string', minLength: 1 };
const integer: Schema = { type: 'integer', minimum: 0 };
const reason: Schema = { type: 'string', maxLength: 1000 };
const array = (items: Schema): Schema => ({ type: 'array', items });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
    ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (type: string): Schema => ({ type: [type, 'null'] });
function invalid(): never { throw new ControlError('INVALID_PARAMS', 'Tham số công việc Page không hợp lệ'); }
function forbidden(): never { throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); }
function validate(value: unknown, schema: Schema): void {
    if (schema.oneOf) {
        if (schema.oneOf.filter(option => { try { validate(value, option); return true; } catch { return false; } }).length !== 1) invalid();
        return;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value)
        : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === type)) invalid();
    if (schema.enum && !schema.enum.includes(value)) invalid();
    if (typeof value === 'string' && ((schema.minLength !== undefined && (!value.trim() || value.length < schema.minLength)) || (schema.maxLength !== undefined && value.length > schema.maxLength))) invalid();
    if (typeof value === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) invalid();
    if (Array.isArray(value) && schema.items) for (const item of value) validate(item, schema.items);
    if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
        const row = value as Record<string, unknown>;
        if (schema.required?.some(key => !(key in row)) || Object.keys(row).some(key => !Object.prototype.hasOwnProperty.call(schema.properties, key))) invalid();
        for (const key of Object.keys(row)) validate(row[key], schema.properties[key]);
    }
}
const lease = { workId: text, claimedAt: integer };
const fact = object({ id: text, topic: text, value: { ...text, maxLength: 2000 }, status: { type: 'string', enum: ['observed', 'hypothesis'] },
    sourceType: { type: 'string', enum: ['page', 'research'] }, sourceRef: { ...text, maxLength: 500 }, reason, observedAt: integer },
['topic', 'value', 'status', 'sourceType', 'sourceRef', 'reason', 'observedAt']);
const draft = object({ id: text, expectedRevision: { ...integer, minimum: 1 }, name: { type: 'string' }, plannedAt: nullable('integer'), text,
    variants: array(text), mediaIds: array(text), comment: { type: 'string' }, campaignId: nullable('string') }, ['text']);
const resource = object({ kind: { type: 'string', enum: ['research', 'video', 'draft', 'media', 'campaign'] }, id: text });
const actionBase = { pageId: text, expectedRevision: integer };
const action = { oneOf: [
    object({pageId:text, kind:{type:'string', enum:['grantCampaign']}, proposalId:text, expectedProposalRevision:{...integer, minimum:1}}),
    object({pageId:text, kind:{type:'string', enum:['revokeCampaignGrant']}, grantId:text, expectedGrantRevision:{...integer, minimum:1}}),
    object({ ...actionBase, kind: { type: 'string', enum: ['confirmFact'] }, factId: text }),
    object({ ...actionBase, kind: { type: 'string', enum: ['confirmFact'] }, fact: object({ topic: text, value: text, reason }) }),
    object({ ...actionBase, kind: { type: 'string', enum: ['setPrimaryProfile'] }, profileId: text }),
    object({ ...actionBase, kind: { type: 'string', enum: ['setEnabled'] }, enabled: { type: 'boolean' } }),
    object({ pageId: text, kind: { type: 'string', enum: ['resolveWork'] }, workId: text, resolution: { type: 'string', enum: ['resume', 'cancel'] } }),
    object({ pageId: text, kind: { type: 'string', enum: ['linkResource'] }, workId: text, resource }),
    object({ pageId: text, kind: { type: 'string', enum: ['approveDraft'] }, draftId: text, expectedRevision: integer, timing: { oneOf: [
        object({ when: { type: 'string', enum: ['now'] } }),
        object({ when: { type: 'string', enum: ['schedule'] }, kind: { type: 'string', enum: ['once'] }, runAt: integer }),
        object({ when: { type: 'string', enum: ['schedule'] }, kind: { type: 'string', enum: ['recurring'] }, days: array(integer), time: text }),
    ] } }),
] };
const campaignInput = object({name:text, goal:{type:'string'}, campaignId:text, expectedCampaignRevision:{...integer, minimum:1},
    policy:object({startsAt:integer, expiresAt:integer, maxPostsPerDay:{...integer, minimum:1}, maxPostsTotal:{...integer, minimum:1},
        allowedMinutes:array({...integer, maximum:1439}), timeZone:text,
        actions:array({type:'string', enum:['schedulePost', 'updateScheduledPost']})})}, ['name', 'goal', 'policy']);
const scheduleInput = {campaignId:text, grantId:text, expectedGrantRevision:{...integer, minimum:1}, runAt:integer,
    variant:{type:'string',enum:['A','B','C','D','E']} as Schema, factIds:array(text)};
const schemas: Record<string, Schema> = {
    'pageCampaigns.optimize':object({...lease,campaignId:text,draftId:text,expectedDraftRevision:{...integer,minimum:1},grantId:text,expectedGrantRevision:{...integer,minimum:1}}),
    'pageCampaigns.collect':object({...lease,campaignId:text}),
    'pageCampaigns.report':object({pageId:text,campaignId:text,from:integer,to:integer},['pageId','campaignId']),
    'pageCampaigns.schedule':object({...lease,input:object({...scheduleInput,draftId:text,expectedDraftRevision:{...integer,minimum:1}})}),
    'pageCampaigns.updateSchedule':object({...lease,scheduleId:text,expectedExecutionRevision:{...integer,minimum:1},input:object({...scheduleInput,
        expectedScheduleRevision:{...integer,minimum:1},content:object({text,variants:array(text),comment:{type:'string'},mediaIds:array(text)},['text'])},[...Object.keys(scheduleInput),'expectedScheduleRevision'])}),
    'pageCampaigns.cancelSchedule':object({...lease,scheduleId:text,expectedExecutionRevision:{...integer,minimum:1}}),
    'pageCampaigns.list':object({pageId:text}), 'pageCampaigns.get':object({pageId:text, campaignId:text}),
    'pageCampaigns.propose':object({...lease, input:campaignInput, expectedRevision:{oneOf:[{...integer, minimum:1}, {type:'null'}]}}),
    'system.capabilities': object({}), 'pageBusiness.get': object({ pageId: text }),
    'pageBusiness.propose': object({ ...lease, expectedRevision: integer, fact }),
    'pageWork.list': object({}), 'pageWork.get': object({ workId: text }), 'pageWork.claimDue': object({ pageId: text }),
    'pageWork.research': object({ ...lease, input: { oneOf: [object({ kind: { type: 'string', enum: ['search'] }, keywords: array(text) }),
        object({ kind: { type: 'string', enum: ['group_feed'] }, groupIds: array(text) })] } }),
    'pageWork.researchResult': object({ workId: text, scanId: text }),
    'pageWork.saveDraft': object({ ...lease, draftIndex: integer, draft }), 'pageWork.draft': object({ workId: text, draftId: text }),
    'pageWork.waitVideo': object({ ...lease, videoId: text }), 'pageWork.reconcile': object({ workId: text }),
    'pageWork.finish': object({ ...lease, reason, evidenceRefs: array({ ...text, maxLength: 500 }) }),
    'pageWork.fail': object({ ...lease, code: { ...text, maxLength: 100 }, reason }),
    'pageApprovals.prepare': object({ action }),
    'pageApprovals.bindMessage': object({ ticketId: text, chatId: text, senderId: text, messageId: { ...integer, minimum: 1 } }),
    'pageApprovals.confirm': object({ ticketId: text, update: object({ updateId: integer, messageId: { ...integer, minimum: 1 }, chatId: text, senderId: text, replyToMessageId: { ...integer, minimum: 1 } }) }),
    'pageWork.events': object({ after: integer, timeoutSec: { ...integer, maximum: EVENTS_MAX_TIMEOUT_SEC } }, ['after']),
};
const campaignDecision = object({id:text,campaignId:text,grantId:text,grantRevision:integer,kind:{type:'string',enum:['keep','variant','time']},
    before:{type:['string','number','null']},after:{type:['string','number','null']},observationRefs:array(text),sampleSizes:{type:'object'},coverage:{type:'object'},reason:text,createdAt:integer});
const resultSchemas: Record<string, Schema> = {
    'pageCampaigns.optimize':object({decision:campaignDecision,scheduleId:nullable('string')}),
    'pageCampaigns.collect':object({checked:integer,measured:integer,unavailable:integer}),
    'pageCampaigns.report':object({measurementWindow:object({milestoneMinutes:integer,minAgeHours:integer,maxAgeHours:integer}),observations:array({type:'object'}),campaignId:text,pageId:text,from:integer,to:integer,published:integer,eligible:integer,measured:integer,
        coverage:nullable('number'),totalEngagement:nullable('number'),uniqueLeads:integer,lastObservedAt:nullable('integer'),missingReasons:array(text),
        finance:object({status:{type:'string',enum:['unavailable']},reason:{type:'string',enum:['missing_financial_source']}})}),
    'pageCampaigns.schedule':object({scheduleId:text,revision:integer}),
    'pageCampaigns.updateSchedule':object({scheduleId:text,revision:integer}),
    'pageCampaigns.cancelSchedule':object({cancelled:{type:'boolean'}}),
    'pageCampaigns.list':object({campaigns:array({type:'object'}), proposals:array({type:'object'})}),
    'pageCampaigns.get':object({campaign:{type:'object'}, grants:array({type:'object'}),
        latestDecision:{oneOf:[{type:'null'},object({decision:campaignDecision,evidenceAvailable:{type:'boolean'}})]}}),
    'pageCampaigns.propose':{type:'object'},
    'system.capabilities': object({ pageOperations: integer, principal: object({ kind: text, workspaceId: text, assignments: array(object({ pageId: text, profileIds: array(text) })) }), protectedWritesEnabled: { type: 'boolean' } }),
    'pageBusiness.get': object({ business: nullable('object'), evidenceAvailability: array(object({ factId: text, available: { type: 'boolean' } })) }),
    'pageBusiness.propose': object({ business: { type: 'object' } }), 'pageWork.list': object({ items: array({ type: 'object' }) }),
    'pageWork.get': object({ work: { type: 'object' }, preparation: { oneOf: [object({ niche: { type: 'string' }, keywords: array(text), groupIds: array(text),
        tone: { type: 'string' }, notes: { type: 'string' }, time: text, draftsPerDay: integer }), { type: 'null' }] } }),
    'pageWork.research': object({ scanId: text }), 'pageWork.researchResult': object({ scan: { type: 'object' }, items: array({ type: 'object' }) }),
    'pageWork.saveDraft': object({ draftId: text, revision: integer }), 'pageWork.draft': object({ draft: { oneOf: [object({ id: text, revision: integer, name: { type: 'string' },
        plannedAt: nullable('integer'), text, variants: array(text), mediaIds: array(text), comment: { type: 'string' }, campaignId: nullable('string') }, ['id', 'revision', 'text']),
        object({ id: text, status: { type: 'string', enum: ['promoted', 'removed'] } })] } }),
    'pageApprovals.prepare': object({ ticket: { type: 'object' } }), 'pageApprovals.bindMessage': object({ bound: { type: 'boolean' } }),
    'pageApprovals.confirm': object({ resourceId: text, replayed: { type: 'boolean' } }),
    'pageWork.events': object({ events: array({ type: 'object' }), nextCursor: integer, workspaceId: text }),
};

/** Public module only: registration and pre-cache authorization are deliberately owned by runtime assembly. */
export function createPageOperationMethods(deps: PageOperationMethodDeps): ControlMethod[] {
    return Object.entries(schemas).map(([name, paramsSchema]) => ({
        name, description: `Thao tác Page có phạm vi: ${name}`, destructive: false, paramsSchema,
        resultSchema: resultSchemas[name] ?? object({ work: nullable('object') }),
        async run(params: ControlParams, ctx: ControlContext): Promise<unknown> {
            let recheck: (() => void) | undefined;
            try {
                if (!ctx.principal || ctx.principal.kind === 'legacy' || !ctx.assertCurrent || !ctx.resources) forbidden();
                ctx.assertCurrent();
                const principal = { ...ctx.principal, assignments: ctx.principal.assignments.map(a => ({ pageId: a.pageId, profileIds: [...a.profileIds] })) };
                const bound = deps.bindRequest(ctx);
                const works = new PageWorkStore(bound.db, bound.clock);
                const business = new PageBusinessStore(bound.db);
                const briefs = new DailyBriefStore(bound.db, bound.clock);
                const research = new ResearchStore(bound.db);
                const events = new ControlStore(bound.db);
                const campaigns = new PageCampaignStore(bound.db);
                const resources = { ...ctx.resources, protectedWritesEnabled: bound.protectedWritesEnabled, workspaceId: bound.workspaceId, assertCurrent: () => { ctx.assertCurrent!(); bound.assertCurrent(); },
                    getWork: (id: string) => works.get(id), getResourceOwner: (ref: Parameters<PageWorkStore['getResourceOwner']>[0]) => works.getResourceOwner(ref),
                    getPageIdentity: (id: string) => briefs.getIdentity(id) ?? null,
                    getCampaignResource: (kind: 'campaign' | 'proposal' | 'grant', id: string) => kind === 'campaign' ? campaigns.getLink(id)
                        : kind === 'proposal' ? campaigns.getProposal(id) : campaigns.getGrant(id) };
                const guard = () => {
                    resources.assertCurrent();
                    if (principal.workspaceId !== bound.workspaceId) forbidden();
                    if (isPageRunnerMutation(name) && bound.protectedWritesEnabled() !== true) forbidden();
                    authorizeMethod(principal, name, params, resources);
                };
                recheck = guard;
                guard(); validate(params, paramsSchema);
                if (['pageCampaigns.optimize','pageCampaigns.schedule','pageCampaigns.updateSchedule','pageCampaigns.cancelSchedule'].includes(name))
                    new PageCampaignExecutionStore(bound.db,bound.clock).ensureSchema();
                const visible = (work: PageWork) => work.workspaceId === principal.workspaceId && principal.assignments.some(a => a.pageId === work.pageId && a.profileIds.includes(work.profileId));
                const context = (id: string): PageContext => {
                    guard(); const work = works.get(id); if (!work || !visible(work)) forbidden();
                    const identity = briefs.getIdentity(work.profileId);
                    if (!identity || identity.kind !== 'page' || identity.pageId !== work.pageId || identity.errorCode) forbidden();
                    if (isPageRunnerMutation(name) && !['completed', 'failed', 'cancelled', 'needs_review'].includes(work.status)) {
                        const page = business.get(work.pageId); const brief = briefs.getBrief(work.profileId);
                        if (!page?.enabled || page.primaryProfileId !== work.profileId || !brief?.enabled)
                            throw new ControlError('CONFLICT', 'Ngữ cảnh chuẩn bị Page đã thay đổi');
                        if (work.status === 'running' && name !== 'pageWork.reconcile') works.assertLease({ workId: work.id, claimedAt: work.claimedAt! }, bound.now());
                    }
                    return { workspaceId: bound.workspaceId, dbPath: bound.dbPath, pageId: work.pageId, profileId: work.profileId };
                };
                const operations = () => createPageWorkOperations({ ...bound.work, db: bound.db, now: bound.now, clock: bound.clock, context, assertCurrent: guard });
                const approvals = () => {
                    if (principal.kind !== 'page_receiver') forbidden();
                    return createPageApprovalOperations({ ...bound.approval, db: bound.db, now: bound.now, clock: bound.clock, receiver: principal, assertCurrent: guard });
                };
                function scanRows(work: PageWork, scanId: string) {
                    const owner = works.getResourceOwner({ kind: 'research', id: scanId });
                    const scan = research.getScan(scanId);
                    if (!owner || owner.workId !== work.id || owner.workspaceId !== work.workspaceId || owner.pageId !== work.pageId || work.researchId !== scanId
                        || !scan || !scan.profileIds.includes(work.profileId)) return null;
                    // No ResearchStore cross-scan place-members join: counts and derived values must not cross Pages.
                    const rows = bound.db.query<{ id: number; url: string; captured_at: number; kind: string; fb_id: string; title: string;
                        reactions: number | null; comments: number | null; shares: number | null; posted_at: number | null }>(
                        'SELECT id, url, captured_at, kind, fb_id, title, reactions, comments, shares, posted_at FROM research_items WHERE scan_id = ? AND profile_id = ? ORDER BY id', [scanId, work.profileId]);
                    const count = bound.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM research_items WHERE scan_id = ? AND profile_id = ?', [scanId, work.profileId]);
                    if (!count || count.n !== rows.length) throw new ControlError('INTERNAL', 'Không đọc đủ bằng chứng Page');
                    return { scan, rows };
                }
                function resolveEvidence(pageId: string, input: Pick<PageFact, 'sourceType' | 'sourceRef'> & { observedAt?: number }, work?: PageWork): boolean {
                    if (input.sourceType === 'owner') return true;
                    const assignment = principal.assignments.find(a => a.pageId === pageId);
                    if (!assignment) return false;
                    if (input.sourceType === 'page') return assignment.profileIds.some(profileId => {
                        const row = briefs.getIdentity(profileId);
                        return row?.kind === 'page' && row.pageId === pageId && !row.errorCode && (input.observedAt === undefined || row.learnedAt === input.observedAt)
                            && (input.sourceRef === `page:${profileId}:${row.learnedAt}` || row.recentPosts.some(post => post.url === input.sourceRef));
                    });
                    const candidates = work ? [work] : works.list([pageId]).filter(visible);
                    return candidates.some(candidate => {
                        if (!candidate.researchId) return false;
                        const result = scanRows(candidate, candidate.researchId);
                        if (!result || result.scan.status !== 'done') return false;
                        return input.sourceRef === `research:${result.scan.id}` && (input.observedAt === undefined || input.observedAt === result.scan.finishedAt)
                            || result.rows.some(row => (input.sourceRef === row.url || input.sourceRef === `research:${result.scan.id}:${row.id}`) && (input.observedAt === undefined || input.observedAt === row.captured_at));
                    });
                }
                const businessView = (row: PageBusiness | null) => row && ({ ...row,
                    primaryProfileId: principal.assignments.some(a => a.pageId === row.pageId && a.profileIds.includes(row.primaryProfileId ?? '')) ? row.primaryProfileId : null,
                    facts: row.facts.map(f => ({ id: f.id, topic: f.topic, value: f.value, status: f.status, sourceType: f.sourceType,
                        sourceRef: f.sourceType === 'owner' ? 'owner' : f.sourceRef, reason: f.reason, observedAt: f.observedAt, updatedAt: f.updatedAt, confirmedAt: f.confirmedAt })) });
                const work = () => { const row = works.get(params.workId); if (!row || !visible(row)) forbidden(); return row; };
                const currentLease = () => { context(params.workId); return works.assertLease({ workId: params.workId, claimedAt: params.claimedAt }, bound.now()); };
                const mutate = <T>(body: () => T): T => bound.db.transaction(() => { guard(); const saved = body(); guard(); return saved; });
                const campaignOperations = () => createPageCampaignOperations({db:bound.db, principal, context,
                    now:bound.now, clock:bound.clock, assertCurrent:guard, protectedWritesEnabled:bound.protectedWritesEnabled,
                    get draft(){return bound.work.draft;},get media(){return bound.work.media;},
                    get collector(){return bound.campaignCollector;}});
                let result: unknown;
                switch (name) {
                    case 'pageCampaigns.optimize': currentLease(); result=await campaignOperations().optimize({workId:params.workId,claimedAt:params.claimedAt},params.campaignId,params.draftId,params.expectedDraftRevision,params.grantId,params.expectedGrantRevision);break;
                    case 'pageCampaigns.collect': currentLease(); result=await campaignOperations().collect({workId:params.workId,claimedAt:params.claimedAt},params.campaignId);break;
                    case 'pageCampaigns.report': result=campaignOperations().report(params.pageId,params.campaignId,params.from,params.to);break;
                    case 'pageCampaigns.schedule': result = await campaignOperations().schedule({workId:params.workId,claimedAt:params.claimedAt},params.input); break;
                    case 'pageCampaigns.updateSchedule': result = await campaignOperations().updateSchedule({workId:params.workId,claimedAt:params.claimedAt},params.scheduleId,params.expectedExecutionRevision,params.input); break;
                    case 'pageCampaigns.cancelSchedule': campaignOperations().cancelSchedule({workId:params.workId,claimedAt:params.claimedAt},params.scheduleId,params.expectedExecutionRevision); result={cancelled:true}; break;
                    case 'pageCampaigns.list': result = campaignOperations().list(params.pageId); break;
                    case 'pageCampaigns.get': result = campaignOperations().get(params.pageId, params.campaignId); break;
                    case 'pageCampaigns.propose': result = campaignOperations().propose({workId:params.workId, claimedAt:params.claimedAt}, params.input, params.expectedRevision); break;
                    case 'system.capabilities': result = { pageOperations: 1, principal: { kind: principal.kind, workspaceId: principal.workspaceId, assignments: principal.assignments }, protectedWritesEnabled: bound.protectedWritesEnabled() === true }; break;
                    case 'pageBusiness.get': {
                        const row = business.get(params.pageId);
                        result = { business: businessView(row), evidenceAvailability: row?.facts.map(f => ({ factId: f.id, available: resolveEvidence(params.pageId, f) })) ?? [] }; break;
                    }
                    case 'pageBusiness.propose': result = mutate(() => {
                        const row = currentLease(); const input = params.fact as PageFactInput;
                        if (!resolveEvidence(row.pageId, input, row)) forbidden();
                        const saved = business.propose(row.pageId, input, params.expectedRevision, bound.now());
                        return { business: businessView(saved) };
                    }); break;
                    case 'pageWork.list': result = { items: works.list(principal.assignments.map(a => a.pageId)).filter(visible) }; break;
                    case 'pageWork.get': {
                        const row = work(); const brief = briefs.getBrief(row.profileId);
                        result = { work: row, preparation: brief ? { niche: brief.niche, keywords: brief.keywords, groupIds: brief.groupIds,
                            tone: brief.tone, notes: brief.notes, time: brief.time, draftsPerDay: brief.draftsPerDay } : null }; break;
                    }
                    case 'pageWork.claimDue': result = mutate(() => {
                        const row = business.get(params.pageId); const profileId = row?.primaryProfileId;
                        if (!profileId || !principal.assignments.some(a => a.pageId === params.pageId && a.profileIds.includes(profileId))) return { work: null };
                        const identity = briefs.getIdentity(profileId);
                        if (!identity || identity.kind !== 'page' || identity.pageId !== params.pageId || identity.errorCode) forbidden();
                        for (const active of works.list([params.pageId]).filter(w => w.status === 'running')) assertPagePreparationIdle(bound.db, active.id);
                        return { work: works.claimDue({ workspaceId: bound.workspaceId, dbPath: bound.dbPath, pageId: params.pageId, profileId }, bound.now()) };
                    }); break;
                    case 'pageWork.research': currentLease(); result = await operations().research({ workId: params.workId, claimedAt: params.claimedAt }, params.input); break;
                    case 'pageWork.researchResult': {
                        const scoped = scanRows(work(), params.scanId); if (!scoped) forbidden();
                        const scan = scoped.scan;
                        result = { scan: { id: scan.id, source: scan.source, query: scan.query, status: scan.status, errorCode: scan.errorCode,
                            profileIds: [work().profileId], itemCount: scoped.rows.length, startedAt: scan.startedAt, finishedAt: scan.finishedAt },
                        items: scoped.rows.map(row => ({ id: row.id, scanId: scan.id, profileId: work().profileId, kind: row.kind, fbId: row.fb_id,
                            url: row.url, title: row.title, reactions: row.reactions, comments: row.comments, shares: row.shares, postedAt: row.posted_at, capturedAt: row.captured_at })) }; break;
                    }
                    case 'pageWork.saveDraft': currentLease(); result = await operations().saveDraft({ workId: params.workId, claimedAt: params.claimedAt }, params.draftIndex, params.draft); break;
                    case 'pageWork.draft': result = { draft: operations().getDraft(params.workId, params.draftId) }; break;
                    case 'pageWork.waitVideo': result = mutate(() => {
                        const row = currentLease(); if (row.videoId !== params.videoId) forbidden();
                        return { work: works.transition({ workId: row.id, claimedAt: params.claimedAt }, 'waiting', { waitFor: 'video', nextCheckAt: bound.now() + 60000 }, bound.now()) };
                    }); break;
                    case 'pageWork.reconcile': context(params.workId); result = { work: await operations().reconcile(params.workId) }; break;
                    case 'pageWork.finish': result = mutate(() => {
                        const row = currentLease(); const brief = briefs.getBrief(row.profileId);
                        const poster = new FacebookPosterStore(bound.db);
                        const durable = row.draftIds.filter(id => {
                            const owner = works.getResourceOwner({ kind: 'draft', id }); const draft = poster.getSchedule(id);
                            const profiles = draft?.params.profiles as { profileId: string; targets: string[] }[] | undefined;
                            return owner?.workId === row.id && owner.workspaceId === row.workspaceId && owner.pageId === row.pageId && draft
                                && draft.params.mode === 'page' && profiles?.length === 1 && profiles[0].profileId === row.profileId
                                && profiles[0].targets.length === 1 && profiles[0].targets[0] === 'https://www.facebook.com/';
                        });
                        if (!brief || new Set(durable).size < brief.draftsPerDay) throw new ControlError('CONFLICT', 'Chưa đủ bản nháp bền vững đã liên kết');
                        for (const ref of params.evidenceRefs) {
                            if (!resolveEvidence(row.pageId, { sourceType: 'page', sourceRef: ref }, row)
                                && !resolveEvidence(row.pageId, { sourceType: 'research', sourceRef: ref }, row)) forbidden();
                        }
                        return { work: works.transition({ workId: row.id, claimedAt: params.claimedAt }, 'completed', { reason: params.reason, evidenceRefs: params.evidenceRefs }, bound.now()) };
                    }); break;
                    case 'pageWork.fail': result = mutate(() => {
                        const row = currentLease();
                        const retryable = ['rate_limited', 'no_profile_available', 'busy'].includes(params.code);
                        const status = works.hasUnresolvedSteps(row.id) ? 'needs_review' : retryable ? 'pending'
                            : ['invalid_input', 'unsupported_source'].includes(params.code) ? 'failed' : 'needs_review';
                        return { work: works.transition({ workId: row.id, claimedAt: params.claimedAt }, status,
                            { reason: params.reason, lastError: retryable ? 'Tạm thời chưa thể chuẩn bị' : 'Cần kiểm tra công việc', ...(status === 'pending' ? { nextCheckAt: bound.now() + 60000 } : {}) }, bound.now()) };
                    }); break;
                    case 'pageApprovals.prepare': {
                        const ticket = approvals().prepare(params.action, principal);
                        if (ticket.action.kind === 'grantCampaign' || ticket.action.kind === 'revokeCampaignGrant') {
                            const {receiverKeyId: _receiverKeyId, ...publicTicket} = ticket;
                            result = {ticket:publicTicket};
                        } else result = {ticket};
                        break;
                    }
                    case 'pageApprovals.bindMessage': approvals().bindMessage(params.ticketId, params.chatId, params.senderId, params.messageId); result = { bound: true }; break;
                    case 'pageApprovals.confirm': result = await approvals().confirm(params.ticketId, params.update, principal); break;
                    case 'pageWork.events': {
                        let cursor = params.after; let projected: unknown[] = [];
                        const read = () => {
                            const end = events.lastEventSeq();
                            while (cursor < end && projected.length < EVENTS_PAGE_LIMIT) {
                                guard(); const rows = events.listEventsAfter(cursor, EVENTS_PAGE_LIMIT); if (!rows.length) { cursor = end; break; }
                                for (const event of rows) {
                                    if (event.seq > end) { cursor = end; break; }
                                    if (projected.length === EVENTS_PAGE_LIMIT) break;
                                    cursor = event.seq;
                                    const safe = projectPageWorkEvent(event, principal, id => works.get(id)) ?? projectPageCampaignEvent(event, principal, campaigns);
                                    if (safe) projected.push(safe);
                                }
                            }
                        };
                        read();
                        if (!projected.length && (params.timeoutSec ?? EVENTS_MAX_TIMEOUT_SEC) > 0) { await bound.waitForEvent(cursor, (params.timeoutSec ?? EVENTS_MAX_TIMEOUT_SEC) * 1000, ctx.signal); guard(); read(); }
                        result = { events: projected, nextCursor: cursor, workspaceId: bound.workspaceId }; break;
                    }
                    default: throw new ControlError('UNKNOWN_METHOD', 'Không tìm thấy phương thức');
                }
                guard();
                if (isPageRunnerMutation(name) || name === 'pageApprovals.confirm') { try { bound.notify(); } catch { /* committed state wins */ } }
                return result;
            } catch (error) {
                try { recheck?.(); } catch (stale) { throw toControlError(stale); }
                throw toControlError(error);
            }
        },
    }));
}
