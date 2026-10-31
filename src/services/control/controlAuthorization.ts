import { createHash } from 'crypto';
import type { ControlPrincipal, PageResourceOwner, PageResourceRef, PageWork } from '../../models/pageOperations';
import type { CampaignScope } from '../../models/pageCampaigns';
import type { PageIdentity } from '../../models/dailyBrief';
import { ControlError, type ControlMethod, type ControlParams } from './ControlMethods';

export type ScopedKeyPolicy =
    | Omit<Extract<ControlPrincipal, { kind: 'page_runner' }>, 'keyId'>
    | Omit<Extract<ControlPrincipal, { kind: 'page_receiver' }>, 'keyId'>;

/** Bound to this authenticated principal and a captured workspace/DB, never to mutable current-principal state. */
export interface ControlAuthorizationResources {
    workspaceId: string;
    assertCurrent(): void;
    /** Required current deployment authority for runner mutations, including cache replay. */
    protectedWritesEnabled?(): boolean;
    getPageIdentity(profileId: string): Pick<PageIdentity, 'profileId' | 'pageId' | 'kind'> | null;
    getWork(workId: string): PageWork | null;
    getResourceOwner(resource: PageResourceRef): PageResourceOwner | null;
    /** Non-consuming check of the action Page/ticket AND receiver key; missing/out-of-scope tickets must be FORBIDDEN. */
    authorizeApproval?(method: string, params: ControlParams): void;
    /** Durable scope from this request's captured DB, independent of work journal retention. */
    getCampaignResource?(kind: 'campaign' | 'proposal' | 'grant', id: string): CampaignScope | null;
}

const READ_METHODS = ['pageCampaigns.report', 'pageCampaigns.list', 'pageCampaigns.get', 'system.capabilities', 'profiles.list', 'pages.list', 'pageBusiness.get', 'pageWork.list', 'pageWork.get', 'pageWork.researchResult', 'pageWork.draft'];
const RUNNER_MUTATIONS = new Set(['pageCampaigns.optimize', 'pageCampaigns.collect', 'pageCampaigns.schedule', 'pageCampaigns.updateSchedule', 'pageCampaigns.cancelSchedule', 'pageCampaigns.propose', 'pages.learn', 'pageBusiness.propose', 'pageWork.claimDue', 'pageWork.research', 'pageWork.saveDraft', 'pageWork.waitVideo', 'pageWork.reconcile', 'pageWork.finish', 'pageWork.fail']);
export function isPageRunnerMutation(method: string): boolean { return RUNNER_MUTATIONS.has(method); }
const RUNNER_METHODS = new Set([...READ_METHODS, ...RUNNER_MUTATIONS]);
const APPROVAL_METHODS = new Set(['pageApprovals.prepare', 'pageApprovals.bindMessage', 'pageApprovals.confirm']);
const RECEIVER_METHODS = new Set([...READ_METHODS, ...APPROVAL_METHODS, 'pageWork.events']);

function deny(): never { throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;

/** Validate public policy, reject unknown fields, and detach every persisted collection from its caller. */
export function validateScopedKeyPolicy(value: unknown): ScopedKeyPolicy {
    const invalid = (): never => { throw new ControlError('INVALID_PARAMS', 'Phạm vi khoá điều khiển không hợp lệ'); };
    if (!isRecord(value) || (value.kind !== 'page_runner' && value.kind !== 'page_receiver') || !isId(value.workspaceId)) return invalid();
    const allowed = ['kind', 'workspaceId', 'assignments', ...(value.kind === 'page_receiver' ? ['ownerChatId', 'ownerSenderId'] : [])];
    if (Object.keys(value).some((key) => !allowed.includes(key)) || !Array.isArray(value.assignments) || !value.assignments.length) return invalid();
    const pages = new Set<string>();
    const profiles = new Set<string>();
    const assignments = value.assignments.map((entry) => {
        if (!isRecord(entry) || Object.keys(entry).some((key) => !['pageId', 'profileIds'].includes(key)) || !isId(entry.pageId) || pages.has(entry.pageId) || !Array.isArray(entry.profileIds) || !entry.profileIds.length) return invalid();
        pages.add(entry.pageId);
        const profileIds = entry.profileIds.map((id) => {
            if (!isId(id) || profiles.has(id)) return invalid();
            profiles.add(id);
            return id;
        });
        return { pageId: entry.pageId, profileIds };
    });
    const base = { workspaceId: value.workspaceId, assignments };
    if (value.kind === 'page_runner') return { kind: value.kind, ...base };
    // Keep Telegram IDs as decimal strings; Number would silently lose precision.
    if (typeof value.ownerChatId !== 'string' || !/^-?[1-9]\d*$/.test(value.ownerChatId) || typeof value.ownerSenderId !== 'string' || !/^[1-9]\d*$/.test(value.ownerSenderId)) return invalid();
    return { kind: value.kind, ...base, ownerChatId: value.ownerChatId, ownerSenderId: value.ownerSenderId };
}

function allowed(principal: ControlPrincipal, method: string): boolean {
    if (APPROVAL_METHODS.has(method)) return principal.kind === 'page_receiver';
    return principal.kind === 'legacy' || (principal.kind === 'page_runner' ? RUNNER_METHODS : RECEIVER_METHODS).has(method);
}

function assertResources(principal: Exclude<ControlPrincipal, { kind: 'legacy' }>, resources: ControlAuthorizationResources): void {
    if (!resources || typeof resources.assertCurrent !== 'function' || typeof resources.getPageIdentity !== 'function' || typeof resources.getWork !== 'function' || typeof resources.getResourceOwner !== 'function') deny();
    resources.assertCurrent();
    if (resources.workspaceId !== principal.workspaceId) deny();
}

/** Exact-name visibility only; method schemas are not authority. */
export function visibleMethods(principal: ControlPrincipal, methods: ControlMethod[]): ControlMethod[] {
    return methods.filter((method) => allowed(principal, method.name));
}

export function authorizeMethod(principal: ControlPrincipal, method: string, params: ControlParams, resources: ControlAuthorizationResources): void {
    if (!allowed(principal, method)) deny();
    if (principal.kind === 'legacy') return;
    assertResources(principal, resources);
    if (principal.kind === 'page_runner' && isPageRunnerMutation(method) && resources.protectedWritesEnabled?.() !== true) deny();
    const pageAllowed = (pageId: unknown) => typeof pageId === 'string' && principal.assignments.some((entry) => entry.pageId === pageId);
    const linked = (kind: PageResourceRef['kind'], id: unknown, workId?: string) => {
        if (!isId(id)) deny();
        const owner = resources.getResourceOwner({ kind, id });
        if (!owner || owner.workspaceId !== principal.workspaceId || !pageAllowed(owner.pageId) || (workId !== undefined && owner.workId !== workId)) deny();
    };
    const campaignResource = (kind: 'campaign' | 'proposal' | 'grant', id: unknown, pageId: unknown) => {
        if (!isId(id) || !pageAllowed(pageId)) deny();
        const row = resources.getCampaignResource?.(kind, id);
        if (!row || row.workspaceId !== principal.workspaceId || row.pageId !== pageId
            || !principal.assignments.some(a => a.pageId === row.pageId && a.profileIds.includes(row.profileId))) deny();
    };
    if (APPROVAL_METHODS.has(method)) {
        if (method === 'pageApprovals.prepare' && isRecord(params.action)) {
            if (params.action.kind === 'grantCampaign') campaignResource('proposal', params.action.proposalId, params.action.pageId);
            if (params.action.kind === 'revokeCampaignGrant') campaignResource('grant', params.action.grantId, params.action.pageId);
        }
        if (principal.kind !== 'page_receiver' || !resources.authorizeApproval) deny();
        resources.authorizeApproval(method, params);
    } else if (method === 'pages.learn') {
        if (!Array.isArray(params.profileIds) || !params.profileIds.length || (params.force !== undefined && params.force !== false)) deny();
        for (const id of params.profileIds) {
            const assignment = principal.assignments.find((entry) => entry.profileIds.includes(id));
            if (!isId(id) || !assignment) deny();
            const identity = resources.getPageIdentity(id);
            if (identity && identity.kind !== 'unknown' && (identity.profileId !== id || identity.kind !== 'page' || identity.pageId !== assignment.pageId)) deny();
        }
    } else if (method === 'pageCampaigns.get' || method === 'pageCampaigns.report') {
        campaignResource('campaign', params.campaignId, params.pageId);
    } else if (method === 'pageCampaigns.list' || method === 'pageBusiness.get' || method === 'pageWork.claimDue') {
        if (!pageAllowed(params.pageId)) deny();
    } else if (!['system.capabilities', 'profiles.list', 'pages.list', 'pageWork.list', 'pageWork.events'].includes(method)) {
        if (!isId(params.workId)) deny();
        const work = resources.getWork(params.workId);
        if (!work || work.workspaceId !== principal.workspaceId || !principal.assignments.some((entry) => entry.pageId === work.pageId && entry.profileIds.includes(work.profileId))) deny();
        if (method === 'pageCampaigns.optimize') {
            campaignResource('campaign',params.campaignId,work.pageId);
            campaignResource('grant',params.grantId,work.pageId);
            linked('draft',params.draftId,work.id);
        }
        if (method === 'pageCampaigns.collect') campaignResource('campaign',params.campaignId,work.pageId);
        if (method === 'pageCampaigns.propose' && isRecord(params.input) && params.input.campaignId !== undefined)
            campaignResource('campaign', params.input.campaignId, work.pageId);
        if (['pageCampaigns.schedule','pageCampaigns.updateSchedule'].includes(method) && isRecord(params.input)) {
            campaignResource('campaign',params.input.campaignId,work.pageId);
            campaignResource('grant',params.input.grantId,work.pageId);
            if (method === 'pageCampaigns.schedule') linked('draft',params.input.draftId,work.id);
            if (isRecord(params.input.content) && Array.isArray(params.input.content.mediaIds)) for (const id of params.input.content.mediaIds) linked('media',id,work.id);
        }
        if (['pageCampaigns.updateSchedule','pageCampaigns.cancelSchedule'].includes(method)) linked('draft',params.scheduleId,work.id);
        if (method === 'pageWork.researchResult') linked('research', params.scanId, work.id);
        if (method === 'pageWork.draft') linked('draft', params.draftId, work.id);
        if (method === 'pageWork.waitVideo') linked('video', params.videoId, work.id);
        if (method === 'pageWork.saveDraft' && isRecord(params.draft)) {
            if (params.draft.id !== undefined) linked('draft', params.draft.id, work.id);
            if (Array.isArray(params.draft.mediaIds)) for (const id of params.draft.mediaIds) linked('media', id, work.id);
            if (params.draft.campaignId != null) {
                const campaign = typeof params.draft.campaignId === 'string' ? resources.getCampaignResource?.('campaign',params.draft.campaignId) : null;
                if (campaign) {
                    campaignResource('campaign',params.draft.campaignId,work.pageId);
                    if (campaign.profileId !== work.profileId) deny();
                } else linked('campaign', params.draft.campaignId, work.id);
            }
        }
    }
    resources.assertCurrent();
}

export function authorizeRoute(principal: ControlPrincipal, route: string, resource: PageResourceRef | undefined, resources: ControlAuthorizationResources): void {
    if (principal.kind === 'legacy') return;
    assertResources(principal, resources);
    if (route === '/v1/describe' || route === '/v1/call') return;
    if (route !== '/v1/videos/file' || resource?.kind !== 'video' || !isId(resource.id)) deny();
    const owner = resources.getResourceOwner(resource);
    if (!owner || owner.workspaceId !== principal.workspaceId || !principal.assignments.some((entry) => entry.pageId === owner.pageId)) deny();
    // Ownership survives work journal pruning; do not require getWork(owner.workId).
    resources.assertCurrent();
}

/** Canonical JSON object keys, retaining array order and primitive values from the parsed request. */
function canonical(value: unknown): string {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ControlError('INVALID_PARAMS', 'Tham số số phải là giá trị hữu hạn');
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export function scopedRequestHash(principal: Exclude<ControlPrincipal, { kind: 'legacy' }>, method: string, params: ControlParams): string {
    return createHash('sha256').update(canonical({ principal, method, params })).digest('hex');
}
