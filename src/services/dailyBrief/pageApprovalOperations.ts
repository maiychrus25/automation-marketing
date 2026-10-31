import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import type { ApprovalTicket, ControlPrincipal, OwnerAction, OwnerUpdate, PageResourceRef, PageWork } from '../../models/pageOperations';
import { ControlError } from '../control/ControlMethods';
import { ControlStore } from '../control/ControlStore';
import { scopedRequestHash, validateScopedKeyPolicy } from '../control/controlAuthorization';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { approveDraft, getDraft, type DraftDeps } from '../facebookPoster/drafts';
import { readTiming } from '../facebookPoster/scheduleUpdate';
import { DailyBriefStore, type LocalClock } from './DailyBriefStore';
import { PageBusinessStore, PAGE_FACT_MAX_VALUE, PAGE_FACT_MAX_REASON } from './PageBusinessStore';
import { PageWorkStore } from './PageWorkStore';
import { PageCampaignStore } from './PageCampaignStore';
import { cancelCampaignGrantAuthority } from './PageCampaignExecutionStore';
import type { CampaignScope } from '../../models/pageCampaigns';
import { assertPagePreparationIdle } from './pageWorkOperations';

export const PAGE_APPROVAL_TTL_MS = 15 * 60 * 1000;
type Receiver = Extract<ControlPrincipal, { kind: 'page_receiver' }>;
export interface PageApprovalDeps {
    db: SqlDatabase;
    receiver: Receiver;
    draft: Omit<DraftDeps, 'store'>;
    now(): number;
    clock?: LocalClock;
    assertCurrent(): void;
    /** Read-only local evidence, supplied by main process, never runner payload. Null means expired/missing. */
    inspectResource(resource: PageResourceRef, work: PageWork): {
        workspaceId: string; pageId: string; profileId: string; fingerprint: string;
    } | null;
    /** Wake/event hints only; the committed DB remains authoritative. No ticket data is delivered. */
    afterCommit(result: { resourceId: string; action: OwnerAction['kind']; when?: 'now' | 'schedule' }): void;
}
function fail(code: 'FORBIDDEN' | 'CONFLICT' | 'INVALID_PARAMS' | 'NEEDS_REVIEW'): never {
    throw new ControlError(code, code === 'FORBIDDEN' ? 'Không có quyền thực hiện thao tác này' : 'Đề nghị đã thay đổi hoặc chưa đủ bằng chứng, cần kiểm tra lại');
};
function text(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail('INVALID_PARAMS');
}
function integer(value: unknown, min = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < min) fail('INVALID_PARAMS');
}
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('INVALID_PARAMS');
}
function normalize(action: OwnerAction, now: number): OwnerAction {
    const common = ['kind', 'pageId'];
    if (!action || typeof action !== 'object') fail('INVALID_PARAMS');
    text(action.pageId);
    switch (action.kind) {
        case 'grantCampaign':
            closed(action, [...common, 'proposalId', 'expectedProposalRevision']); text(action.proposalId); integer(action.expectedProposalRevision, 1); break;
        case 'revokeCampaignGrant':
            closed(action, [...common, 'grantId', 'expectedGrantRevision']); text(action.grantId); integer(action.expectedGrantRevision, 1); break;
        case 'confirmFact':
            closed(action, [...common, 'expectedRevision', 'factId', 'fact']); integer(action.expectedRevision);
            if (action.factId !== undefined) {
                text(action.factId); if (action.fact !== undefined) fail('INVALID_PARAMS');
            } else {
                closed(action.fact, ['topic', 'value', 'reason']);
                if (typeof action.fact.topic !== 'string' || !action.fact.topic.trim() || typeof action.fact.value !== 'string'
                    || !action.fact.value.trim() || typeof action.fact.reason !== 'string') fail('INVALID_PARAMS');
                if (action.fact.value.length > PAGE_FACT_MAX_VALUE || action.fact.reason.length > PAGE_FACT_MAX_REASON) throw new ControlError('LIMIT_EXCEEDED', 'Thông tin Page vượt giới hạn');
            }
            break;
        case 'setPrimaryProfile':
            closed(action, [...common, 'expectedRevision', 'profileId']); integer(action.expectedRevision); text(action.profileId); break;
        case 'setEnabled':
            closed(action, [...common, 'expectedRevision', 'enabled']); integer(action.expectedRevision);
            if (typeof action.enabled !== 'boolean') fail('INVALID_PARAMS'); break;
        case 'resolveWork':
            closed(action, [...common, 'workId', 'resolution']); text(action.workId);
            if (!['resume', 'cancel'].includes(action.resolution)) fail('INVALID_PARAMS'); break;
        case 'linkResource':
            closed(action, [...common, 'workId', 'resource']); text(action.workId); closed(action.resource, ['kind', 'id']);
            text(action.resource.id); if (!['research', 'video', 'draft', 'media', 'campaign'].includes(action.resource.kind)) fail('INVALID_PARAMS'); break;
        case 'approveDraft': {
            closed(action, [...common, 'draftId', 'expectedRevision', 'timing']); text(action.draftId); integer(action.expectedRevision, 1);
            if (action.timing?.when === 'now') closed(action.timing, ['when']);
            else if (action.timing?.when === 'schedule') {
                if (action.timing.kind === 'once') { closed(action.timing, ['when', 'kind', 'runAt']); integer(action.timing.runAt); }
                else if (action.timing.kind === 'recurring') closed(action.timing, ['when', 'kind', 'days', 'time']);
                else fail('INVALID_PARAMS');
                const timing = readTiming(action.timing.kind, action.timing, now);
                return { ...action, timing: action.timing.kind === 'once' ? {when:'schedule', kind:'once', runAt:timing.runAt!}
                    : {when:'schedule', kind:'recurring', days:timing.days, time:timing.time} };
            } else fail('INVALID_PARAMS');
            break;
        }
        default: fail('INVALID_PARAMS');
    }
    return JSON.parse(JSON.stringify(action));
}

/** Hash bytes, not just filenames/mtime: legacy edits and in-place file replacement also revoke approval. */
function fileHash(file: string): string {
    const hash = createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(64 * 1024);
        let length: number;
        while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
}

export function createPageApprovalOperations(deps: PageApprovalDeps) {
    // Construct every writer on this actual handle, not caller-supplied stores with unknown connections.
    const work = new PageWorkStore(deps.db, deps.clock);
    const business = new PageBusinessStore(deps.db);
    const poster = new FacebookPosterStore(deps.db);
    const campaigns = new PageCampaignStore(deps.db);
    const briefs = new DailyBriefStore(deps.db);
    const draft: DraftDeps = { ...deps.draft, store: poster, now: deps.now };
    const { keyId, ...policyInput } = deps.receiver;
    const policy = validateScopedKeyPolicy(policyInput);
    if (policy.kind !== 'page_receiver') fail('FORBIDDEN');
    const receiver: Receiver = { ...policy, keyId };
    // Schema installation is additive, and performed only on the caller's captured workspace connection.
    work.ensureSchema();
    const hash = (value: unknown) => scopedRequestHash(receiver, 'pageApproval', {value});
    const receiverHash = hash(receiver);
    function authorize(principal: ControlPrincipal, pageId?: string): void {
        deps.assertCurrent();
        if (principal.kind !== 'page_receiver' || hash(principal) !== receiverHash
            || (pageId !== undefined && !receiver.assignments.some(a => a.pageId === pageId))) fail('FORBIDDEN');
    }
    function identity(pageId: string, profileId: string): void {
        if (!receiver.assignments.some(a => a.pageId === pageId && a.profileIds.includes(profileId))) fail('FORBIDDEN');
        const learned = briefs.getIdentity(profileId);
        if (!learned || learned.kind !== 'page' || learned.pageId !== pageId || learned.errorCode) fail('FORBIDDEN');
    }
    function scopedWork(pageId: string, id: string): PageWork {
        const item = work.get(id);
        if (!item || item.workspaceId !== receiver.workspaceId || item.pageId !== pageId
            || !receiver.assignments.some(a => a.pageId === pageId && a.profileIds.includes(item.profileId))) fail('FORBIDDEN');
        return item;
    }
    function evidence(resource: PageResourceRef, item: PageWork) {
        const owner = work.getResourceOwner(resource);
        if (owner && (owner.workspaceId !== receiver.workspaceId || owner.pageId !== item.pageId || owner.workId !== item.id)) fail('FORBIDDEN');
        const proof = deps.inspectResource(resource, item);
        if (!proof || proof.workspaceId !== receiver.workspaceId || proof.pageId !== item.pageId || proof.profileId !== item.profileId || !proof.fingerprint) fail('FORBIDDEN');
        return {owner, proof};
    }
    function campaignScope(pageId: string, row: CampaignScope | null): CampaignScope {
        if (!row || row.workspaceId !== receiver.workspaceId || row.pageId !== pageId
            || !receiver.assignments.some(a => a.pageId === pageId && a.profileIds.includes(row.profileId))) fail('FORBIDDEN');
        return {workspaceId:row.workspaceId, pageId:row.pageId, profileId:row.profileId};
    }
    function snapshot(action: OwnerAction): unknown {
        authorize(receiver, action.pageId);
        const profile = business.get(action.pageId);
        if (!profile) {
            if (action.kind !== 'setPrimaryProfile') fail('FORBIDDEN');
            if (action.expectedRevision !== 0) fail('CONFLICT');
            identity(action.pageId, action.profileId);
            return { profile: null, identity: briefs.getIdentity(action.profileId), active: work.list([action.pageId]) };
        }
        if ('expectedRevision' in action && action.kind !== 'approveDraft' && profile.revision !== action.expectedRevision) fail('CONFLICT');
        switch (action.kind) {
            case 'grantCampaign': {
                const proposal = campaigns.getProposal(action.proposalId);
                const scope = campaignScope(action.pageId, proposal);
                if (!proposal || proposal.status !== 'pending' || proposal.revision !== action.expectedProposalRevision) fail('CONFLICT');
                identity(scope.pageId, scope.profileId);
                const brief = briefs.getBrief(scope.profileId);
                if (!profile.enabled || profile.primaryProfileId !== scope.profileId || !brief?.enabled
                    || proposal.input.policy.maxPostsPerDay > brief.draftsPerDay
                    || proposal.input.policy.expiresAt <= deps.now()
                    || proposal.input.policy.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone) fail('CONFLICT');
                const link = proposal.input.campaignId ? campaigns.getLink(proposal.input.campaignId) : null;
                if (proposal.input.campaignId) {
                    campaignScope(action.pageId, link);
                    if (!link || link.deletedAt !== null || link.revision !== proposal.input.expectedCampaignRevision) fail('CONFLICT');
                }
                return {proposal, link, profile, brief, identity:briefs.getIdentity(scope.profileId), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
            }
            case 'revokeCampaignGrant': {
                const grant = campaigns.getGrant(action.grantId); campaignScope(action.pageId, grant);
                if (!grant || grant.status !== 'active' || grant.revision !== action.expectedGrantRevision) fail('CONFLICT');
                return {grant, link:campaigns.getLink(grant.campaignId)};
            }
            case 'confirmFact': {
                const fact = action.factId === undefined ? null : profile.facts.find(f => f.id === action.factId);
                if (action.factId !== undefined && !fact) fail('FORBIDDEN');
                if (fact?.status === 'confirmed') fail('CONFLICT');
                return profile;
            }
            case 'setPrimaryProfile':
                identity(action.pageId, action.profileId);
                return {profile, active: work.list([action.pageId]).filter(w => !['completed','failed','cancelled'].includes(w.status))};
            case 'setEnabled':
                if (action.enabled) { if (!profile.primaryProfileId) fail('CONFLICT'); identity(action.pageId, profile.primaryProfileId); }
                return {profile, active: work.list([action.pageId]).filter(w => !['completed','failed','cancelled'].includes(w.status))};
            case 'resolveWork': {
                const item = scopedWork(action.pageId, action.workId);
                if (action.resolution === 'resume') {
                    if (item.status !== 'needs_review' || work.hasUnresolvedSteps(item.id)) fail('NEEDS_REVIEW');
                    if (!profile.enabled || profile.primaryProfileId !== item.profileId) fail('CONFLICT');
                    identity(item.pageId, item.profileId);
                    const refs: PageResourceRef[] = [...item.draftIds.map(id => ({kind:'draft' as const, id})),
                        ...(item.videoId ? [{kind:'video' as const, id:item.videoId}] : []), ...(item.researchId ? [{kind:'research' as const, id:item.researchId}] : [])];
                    return {item, proof: refs.map(ref => evidence(ref, item))};
                }
                if (['completed','failed','cancelled'].includes(item.status)) fail('CONFLICT');
                return item;
            }
            case 'linkResource': {
                const item = scopedWork(action.pageId, action.workId);
                return {item, evidence: evidence(action.resource, item)};
            }
            case 'approveDraft': {
                const owner = work.getResourceOwner({kind:'draft', id:action.draftId});
                if (!owner || owner.workspaceId !== receiver.workspaceId || owner.pageId !== action.pageId) fail('FORBIDDEN');
                const row = poster.getSchedule(action.draftId);
                if (!row) fail('FORBIDDEN');
                if (!row.draft || row.enabled || row.nextRunAt !== null || row.revision !== action.expectedRevision) fail('CONFLICT');
                const entries = row.params.profiles;
                if (row.params.mode !== 'page' || !Array.isArray(entries) || entries.length !== 1) fail('FORBIDDEN');
                const entry = entries[0] as { profileId?: unknown; targets?: unknown };
                if (typeof entry?.profileId !== 'string' || !Array.isArray(entry.targets)
                    || entry.targets.length !== 1 || entry.targets[0] !== 'https://www.facebook.com/') fail('FORBIDDEN');
                identity(action.pageId, entry.profileId);
                const media = getDraft(draft, action.draftId).media.map(file => ({size:file.size, hash:fileHash(file.path)}));
                return {owner, row, media};
            }
        }
    }
    function fingerprint(action: OwnerAction): string { return hash({action, snapshot:snapshot(action)}); }
    function ticketFor(id: string): ApprovalTicket {
        authorize(receiver);
        const ticket = work.getApproval(id);
        if (!ticket || ticket.receiverKeyId !== receiver.keyId || ticket.workspaceId !== receiver.workspaceId
            || ticket.chatId !== receiver.ownerChatId || ticket.senderId !== receiver.ownerSenderId) fail('FORBIDDEN');
        authorize(receiver, ticket.pageId);
        return ticket;
    }
    function guardPreparation(action: OwnerAction): void {
        if (action.kind === 'setPrimaryProfile' || (action.kind === 'setEnabled' && !action.enabled)) {
            for (const item of work.list([action.pageId]).filter(w => !['completed','failed','cancelled'].includes(w.status))) {
                scopedWork(action.pageId, item.id); assertPagePreparationIdle(deps.db, item.id);
            }
        } else if (action.kind === 'resolveWork') assertPagePreparationIdle(deps.db, action.workId);
    }
    function apply(action: OwnerAction, update: OwnerUpdate, now: number): string {
        const confirmation = {confirmedAt:now, confirmationRef:`telegram:${update.chatId}:${update.senderId}:${update.messageId}:${update.updateId}`};
        switch (action.kind) {
            case 'grantCampaign': {
                const scope = campaignScope(action.pageId, campaigns.getProposal(action.proposalId));
                const proposal = campaigns.getProposal(action.proposalId)!;
                const changedIds = new Set(proposal.input.campaignId
                    ? campaigns.listGrants(proposal.input.campaignId).filter(grant => grant.status === 'active').map(grant => grant.id) : []);
                const result = campaigns.acceptProposal(scope, action.proposalId, action.expectedProposalRevision,
                    {...confirmation, receiverKeyId:receiver.keyId}, now);
                changedIds.add(result.grantId);
                for (const grant of campaigns.listGrants(result.campaignId).filter(grant => changedIds.has(grant.id))) {
                    if (grant.status === 'revoked') cancelCampaignGrantAuthority(deps.db,grant,now,deps.clock);
                    new ControlStore(deps.db).addEvent('pageCampaigns.grantChanged',
                        {campaignId:grant.campaignId, grantId:grant.id, revision:grant.revision, status:grant.status});
                }
                return result.campaignId;
            }
            case 'revokeCampaignGrant': {
                const scope = campaignScope(action.pageId, campaigns.getGrant(action.grantId));
                campaigns.revokeGrant(scope, action.grantId, action.expectedGrantRevision, now);
                const grant = campaigns.getGrant(action.grantId)!;
                cancelCampaignGrantAuthority(deps.db,grant,now,deps.clock);
                new ControlStore(deps.db).addEvent('pageCampaigns.grantChanged',
                    {campaignId:grant.campaignId, grantId:grant.id, revision:grant.revision, status:grant.status});
                return action.grantId;
            }
            case 'confirmFact':
                if (action.factId !== undefined) { business.confirmFact(action.pageId, action.factId, action.expectedRevision, confirmation); return action.factId; }
                return business.createOwnerFact(action.pageId, action.fact, action.expectedRevision, confirmation).facts.slice(-1)[0].id;
            case 'setPrimaryProfile':
            case 'setEnabled':
                if (action.kind === 'setPrimaryProfile' || !action.enabled) {
                    for (const item of work.list([action.pageId])) {
                        if (!['completed','failed','cancelled'].includes(item.status)) work.stopPreparation(item.id, 'needs_review', now);
                    }
                }
                if (action.kind === 'setPrimaryProfile') {
                    // First selection is created only inside the approval/consumption transaction.
                    if (!business.get(action.pageId)) business.ensure(action.pageId, null, now);
                    business.setPrimaryProfile(action.pageId, action.profileId, action.expectedRevision, confirmation);
                }
                else business.setEnabled(action.pageId, action.enabled, action.expectedRevision, confirmation);
                return action.pageId;
            case 'resolveWork':
                if (action.resolution === 'cancel') work.stopPreparation(action.workId, 'cancelled', now);
                else work.resumeReviewedWork(action.workId, now);
                return action.workId;
            case 'linkResource': work.linkResource(action.workId, action.resource); return action.resource.id;
            case 'approveDraft': return approveDraft(draft, {id:action.draftId, expectedRevision:action.expectedRevision, ...action.timing}).id;
        }
    }
    return {
        prepare(action: OwnerAction, principal: ControlPrincipal): ApprovalTicket {
            authorize(principal);
            const now = deps.now(); integer(now);
            const normalized = normalize(action, now);
            authorize(principal, normalized.pageId);
            return work.transaction(() => {
                const ticket: ApprovalTicket = {id:randomUUID(), receiverKeyId:receiver.keyId, workspaceId:receiver.workspaceId,
                    pageId:normalized.pageId, action:normalized, fingerprint:fingerprint(normalized), chatId:receiver.ownerChatId,
                    senderId:receiver.ownerSenderId, messageId:null, expiresAt:now + PAGE_APPROVAL_TTL_MS, consumedAt:null, update:null, resourceId:null};
                authorize(principal, normalized.pageId); work.createApproval(ticket); return ticket;
            });
        },
        bindMessage(ticketId: string, chatId: string, senderId: string, messageId: number): void {
            work.transaction(() => {
                const ticket = ticketFor(ticketId);
                if (chatId !== ticket.chatId || senderId !== ticket.senderId || !Number.isSafeInteger(messageId) || messageId <= 0) fail('FORBIDDEN');
                if (ticket.consumedAt !== null || deps.now() >= ticket.expiresAt) fail('CONFLICT');
                if (ticket.messageId === messageId) return;
                if (ticket.messageId !== null) fail('CONFLICT');
                authorize(receiver, ticket.pageId); work.bindApproval(ticketId, messageId);
            });
        },
        async confirm(ticketId: string, update: OwnerUpdate, principal: ControlPrincipal): Promise<{resourceId:string; replayed:boolean}> {
            authorize(principal);
            let committedAction: OwnerAction | undefined;
            const result = work.transaction(() => {
                const ticket = ticketFor(ticketId);
                if (!update || Object.keys(update).some(k => !['updateId','messageId','chatId','senderId','replyToMessageId'].includes(k))
                    || !Number.isSafeInteger(update.updateId) || update.updateId < 0 || !Number.isSafeInteger(update.messageId) || update.messageId <= 0
                    || !Number.isSafeInteger(update.replyToMessageId) || update.replyToMessageId <= 0
                    || update.chatId !== ticket.chatId || update.senderId !== ticket.senderId || update.replyToMessageId !== ticket.messageId) fail('FORBIDDEN');
                const previous = work.approvalForUpdate(update);
                if (previous && previous.id !== ticketId) fail('CONFLICT');
                if (ticket.consumedAt !== null) {
                    if (hash(update) !== hash(ticket.update) || ticket.resourceId === null) fail('CONFLICT');
                    return {resourceId:ticket.resourceId, replayed:true};
                }
                const now = deps.now(); integer(now);
                if (now >= ticket.expiresAt) fail('CONFLICT');
                if (fingerprint(ticket.action) !== ticket.fingerprint) fail('CONFLICT');
                guardPreparation(ticket.action);
                authorize(principal, ticket.pageId);
                const resourceId = apply(ticket.action, update, now);
                authorize(principal, ticket.pageId);
                work.consumeApproval(ticket.id, update, resourceId, now);
                committedAction = ticket.action;
                return {resourceId, replayed:false};
            });
            if (committedAction) {
                // A lost hint cannot uncommit an approval; retry reads the stored result without another effect.
                try {
                    deps.assertCurrent();
                    deps.afterCommit({resourceId:result.resourceId, action:committedAction.kind,
                        ...(committedAction.kind === 'approveDraft' ? {when:committedAction.timing.when} : {})});
                } catch { /* durable state wins */ }
            }
            return result;
        },
    };
}
