import type { ControlPrincipal } from '../../models/pageOperations';
import type { CampaignScope } from '../../models/pageCampaigns';
import { AutonomyLimiter } from '../autonomy/AutonomyLimiter';
import { minutesOf } from '../autonomy/autonomyPolicy';
import { DailyBriefStore, systemClock, type LocalClock } from '../dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../dailyBrief/PageBusinessStore';
import { PageCampaignError, PageCampaignStore } from '../dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore, cancelCampaignGrantAuthority } from '../dailyBrief/PageCampaignExecutionStore';
import { FacebookPosterStore, type SqlDatabase } from '../facebookPoster/FacebookPosterStore';
import { ControlError } from './ControlMethods';
import { ControlStore } from './ControlStore';

export type OwnerRunnerPrincipal = Extract<ControlPrincipal, { kind: 'page_runner' }>;
type Clock = LocalClock & { timeZone?(): string };

const DAY_MS = 86_400_000;
/** Marks grants confirmed by the owner key (`pageCampaigns.start`); receiver grants use `telegram:…`. */
export const OWNER_CONFIRMATION_PREFIX = 'owner:';
const forbidden = (): never => { throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); };

/** Plan R1: the owner key acts as a runner over every learned Page (Page identity, no read error, profile still present). */
export function ownerRunnerPrincipal(db: SqlDatabase, workspaceId: string, keyId: string): OwnerRunnerPrincipal {
    const pages = new Map<string, string[]>();
    // A workspace that never learned a Page has no identity table yet: no assignments, not an internal error.
    const learned = db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='fb_page_identities'")?.n;
    for (const identity of learned ? new DailyBriefStore(db).listIdentities() : []) {
        if (identity.kind !== 'page' || !identity.pageId || identity.errorCode
            || !db.queryOne('SELECT 1 FROM browser_profiles WHERE id = ?', [identity.profileId])) continue;
        pages.set(identity.pageId, [...(pages.get(identity.pageId) ?? []), identity.profileId]);
    }
    return { kind: 'page_runner', keyId, workspaceId, assignments: [...pages].map(([pageId, profileIds]) => ({ pageId, profileIds })) };
}

/** Active key without a scoped policy: the owner (legacy) key. */
export function isOwnerKey(control: Pick<ControlStore, 'findActiveKeyById'>, keyId: string): boolean {
    const key = control.findActiveKeyById(keyId);
    return !!key && !key.policy;
}

/** Live key check for campaign authority: the owner key fills both roles; a scoped key only its exact role and assignment. */
export function campaignKeyAuthorized(control: Pick<ControlStore, 'findActiveKeyById'>, keyId: string, role: 'page_runner' | 'page_receiver', scope: CampaignScope): boolean {
    const key = control.findActiveKeyById(keyId);
    if (!key) return false;
    if (!key.policy) return true;
    return key.policy.kind === role && key.policy.workspaceId === scope.workspaceId
        && key.policy.assignments.some(a => a.pageId === scope.pageId && a.profileIds.includes(scope.profileId));
}

export interface OwnerCampaignDeps {
    db: SqlDatabase;
    principal: Pick<OwnerRunnerPrincipal, 'keyId' | 'workspaceId' | 'assignments'>;
    now(): number;
    clock?: Clock;
    protectedWritesEnabled(): boolean;
}

/** Cancels one reserved campaign execution, turns its schedule off and announces it; false when nothing was reserved. */
function cancelReservedSchedule(db: SqlDatabase, scheduleId: string, now: number, clock?: Clock): boolean {
    return db.transaction(() => {
        const executions = new PageCampaignExecutionStore(db, clock);
        const execution = executions.get(scheduleId);
        if (execution?.status !== 'reserved') return false;
        executions.cancel(scheduleId, execution.revision, now);
        const poster = new FacebookPosterStore(db); const row = poster.getSchedule(scheduleId);
        if (row?.authorityKind === 'autonomy') poster.updateAutonomySchedule(scheduleId, { enabled: false, nextRunAt: null }, now, row.revision);
        new ControlStore(db).addEvent('pageCampaigns.scheduleChanged', { campaignId: execution.campaignId, scheduleId, revision: execution.revision + 1, status: 'cancelled' });
        return true;
    });
}

/** `pageCampaigns.start`: the owner key confirms a pending proposal within the autonomy caps (spec §5, plan R2). */
export function startOwnerCampaign(deps: OwnerCampaignDeps, proposalId: string, expectedRevision: number): { campaignId: string; grantId: string } {
    const { db, principal } = deps;
    const campaigns = new PageCampaignStore(db);
    const proposal = campaigns.getProposal(proposalId);
    if (!proposal || proposal.workspaceId !== principal.workspaceId
        || !principal.assignments.some(a => a.pageId === proposal.pageId && a.profileIds.includes(proposal.profileId))) return forbidden();
    const limiter = new AutonomyLimiter(db, { now: deps.now, clock: deps.clock ?? systemClock, protectedWritesEnabled: deps.protectedWritesEnabled });
    limiter.ensureSchema();
    // Outside the transaction below: a refusal records its blocked row.
    limiter.check({ action: 'page_post', origin: 'api', profileId: proposal.profileId }, 'switches');
    const scope: CampaignScope = { workspaceId: proposal.workspaceId, pageId: proposal.pageId, profileId: proposal.profileId };
    const confirmationRef = `${OWNER_CONFIRMATION_PREFIX}${proposalId}:${expectedRevision}`;
    try {
        return db.transaction(() => {
            // A replay keeps the first confirmation time, so acceptProposal answers with the same campaign and grant.
            const replay = db.queryOne<{ confirmed_at: number }>('SELECT confirmed_at FROM page_campaign_grants WHERE proposal_id = ? AND confirmation_ref = ?', [proposalId, confirmationRef]);
            const { policy } = proposal.input;
            if (!replay) {
                const caps = limiter.policy(); const open = minutesOf(caps.pageWindowStart); const close = minutesOf(caps.pageWindowEnd);
                if (policy.maxPostsPerDay > caps.pagePostsPerDay || policy.maxPostsTotal > caps.pagePostsTotal
                    || policy.expiresAt - policy.startsAt > caps.pageCampaignDays * DAY_MS || policy.allowedMinutes.some(m => m < open || m >= close))
                    throw new ControlError('INVALID_PARAMS', 'Chính sách chiến dịch vượt trần tự vận hành');
                // Same live context a receiver confirmation requires, so the grant can actually run.
                const page = new PageBusinessStore(db).get(scope.pageId); const brief = new DailyBriefStore(db, deps.clock).getBrief(scope.profileId);
                if (!page?.enabled || page.primaryProfileId !== scope.profileId || !brief?.enabled || policy.maxPostsPerDay > brief.draftsPerDay
                    || policy.timeZone !== (deps.clock?.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone))
                    throw new ControlError('CONFLICT', 'Ngữ cảnh chiến dịch Page đã thay đổi');
            }
            const changed = new Set(!replay && proposal.input.campaignId
                ? campaigns.listGrants(proposal.input.campaignId).filter(g => g.status === 'active').map(g => g.id) : []);
            const result = campaigns.acceptProposal(scope, proposalId, expectedRevision,
                { receiverKeyId: principal.keyId, confirmationRef, confirmedAt: replay?.confirmed_at ?? deps.now() }, deps.now());
            if (!replay) {
                changed.add(result.grantId);
                for (const grant of campaigns.listGrants(result.campaignId).filter(g => changed.has(g.id))) {
                    if (grant.status === 'revoked') cancelCampaignGrantAuthority(db, grant, deps.now(), deps.clock);
                    new ControlStore(db).addEvent('pageCampaigns.grantChanged', { campaignId: grant.campaignId, grantId: grant.id, revision: grant.revision, status: grant.status });
                }
            }
            return result;
        });
    } catch (error) {
        if (error instanceof PageCampaignError) throw new ControlError(error.code, error.message);
        throw error;
    }
}

/** `pageCampaigns.stop`: revoke every active grant and cancel the reserved schedules; history stays. */
export function stopOwnerCampaign(deps: Omit<OwnerCampaignDeps, 'protectedWritesEnabled'>, campaignId: string): { revokedGrants: number; cancelledSchedules: number } {
    const { db } = deps;
    return db.transaction(() => {
        const campaigns = new PageCampaignStore(db); const link = campaigns.getLink(campaignId);
        if (!link || link.workspaceId !== deps.principal.workspaceId) return forbidden();
        const scope: CampaignScope = { workspaceId: link.workspaceId, pageId: link.pageId, profileId: link.profileId };
        let cancelledSchedules = 0;
        for (const row of db.query<{ schedule_id: string }>('SELECT schedule_id FROM page_campaign_executions WHERE campaign_id = ?', [campaignId])) {
            if (cancelReservedSchedule(db, row.schedule_id, deps.now(), deps.clock)) cancelledSchedules += 1;
        }
        let revokedGrants = 0;
        for (const grant of campaigns.listGrants(campaignId)) {
            if (grant.status !== 'active') continue;
            campaigns.revokeGrant(scope, grant.id, grant.revision, deps.now());
            const revoked = campaigns.getGrant(grant.id)!;
            // Same revocation as a receiver revoke: also stops this campaign's open preparation work.
            cancelCampaignGrantAuthority(db, revoked, deps.now(), deps.clock);
            new ControlStore(db).addEvent('pageCampaigns.grantChanged', { campaignId, grantId: revoked.id, revision: revoked.revision, status: revoked.status });
            revokedGrants += 1;
        }
        return { revokedGrants, cancelledSchedules };
    });
}

/** Emergency stop (spec §4.3): cancel reserved executions of owner-confirmed grants; grants stay so `autonomy.resume` can continue. */
export function cancelOwnerCampaignSchedules(db: SqlDatabase, now: number, clock?: Clock): number {
    if (!db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_executions'")?.n) return 0;
    const rows = db.query<{ schedule_id: string }>(`SELECT e.schedule_id FROM page_campaign_executions e JOIN page_campaign_grants g ON g.id = e.grant_id
        WHERE e.status = 'reserved' AND substr(g.confirmation_ref, 1, ?) = ?`, [OWNER_CONFIRMATION_PREFIX.length, OWNER_CONFIRMATION_PREFIX]);
    let cancelled = 0;
    for (const row of rows) {
        try { if (cancelReservedSchedule(db, row.schedule_id, now, clock)) cancelled += 1; } catch { /* one failure must not keep the others running */ }
    }
    return cancelled;
}
