import type { PageContext } from './pageOperations';
import type { Page } from 'playwright-core';

/** Main-process only; never part of StartParams or an IPC payload. */
export interface AutonomyExecutionGuard {
    readonly variantIndex: number;
    assertCurrent(): void;
    assertPost(input: {text:string; comment:string|null; mediaPaths:string[]; targetUrl:string}): void;
    beforeEffect(page: Page, kind: 'publish' | 'firstComment'): Promise<void>;
    settle(outcome: 'posted' | 'uncertain', resultId: number | null): void;
}

export type CampaignScope = Pick<PageContext, 'workspaceId' | 'pageId' | 'profileId'>;
export type CampaignPolicy = {
    startsAt: number;
    expiresAt: number;
    maxPostsPerDay: number;
    maxPostsTotal: number;
    allowedMinutes: number[];
    timeZone: string;
    actions: Array<'schedulePost' | 'updateScheduledPost'>;
};
export type CampaignProposalInput = {
    name: string;
    goal: string;
    policy: CampaignPolicy;
    campaignId?: string;
    expectedCampaignRevision?: number;
};
export type CampaignProposal = CampaignScope & {
    id: string;
    workId: string;
    revision: number;
    input: CampaignProposalInput;
    status: 'pending' | 'accepted' | 'cancelled';
    createdAt: number;
    updatedAt: number;
};
export type PageCampaignLink = CampaignScope & {
    campaignId: string;
    revision: number;
    managed: true;
    proposalId: string;
    createdAt: number;
    deletedAt: number | null;
};
export type CampaignGrant = CampaignScope & {
    id: string;
    campaignId: string;
    campaignRevision: number;
    revision: number;
    policy: CampaignPolicy;
    status: 'active' | 'revoked';
    receiverKeyId: string;
    confirmedAt: number;
    confirmationRef: string;
};
export type CampaignDraftSelection = {
    variant: 'A' | 'B' | 'C' | 'D' | 'E';
    contentRevision: string;
    factIds: string[];
};
export type CampaignScheduleInput = {
    draftId: string;
    expectedDraftRevision: number;
    campaignId: string;
    grantId: string;
    expectedGrantRevision: number;
    runAt: number;
    variant: CampaignDraftSelection['variant'];
    factIds: string[];
};
export type CampaignScheduleUpdateInput = Omit<CampaignScheduleInput, 'draftId' | 'expectedDraftRevision'> & {
    expectedScheduleRevision: number;
    content?: { text: string; variants?: string[]; comment?: string; mediaIds?: string[] };
};
export type CampaignComparison = { format: 'text' | 'image' | 'video'; minute: number };
export type CampaignExecution = CampaignScope & {
    /** Absent on historical executions; never backfilled from mutable schedules. */
    comparison?: CampaignComparison | null;
    scheduleId: string;
    workId: string;
    campaignId: string;
    grantId: string;
    grantRevision: number;
    runnerKeyId: string;
    authorityFingerprint: string;
    selection: CampaignDraftSelection;
    plannedDate: string;
    actualDate: string | null;
    status: 'reserved' | 'submitting' | 'posted' | 'uncertain' | 'cancelled';
    runId: string | null;
    resultId: number | null;
    revision: number;
};
export type CampaignPublishedPost = CampaignScope & {
    comparison?: CampaignComparison | null;
    resultId: number; campaignId: string; runId: string; scheduleId: string;
    runnerKeyId: string; grantId: string; selection: CampaignDraftSelection;
    publishedAt: number | null; postId: string | null; postUrl: string | null;
    sourceRef: string | null; reason: string;
};
export type CampaignMeasurement = {
    resultId: number; milestoneMinutes: 60 | 1440 | 4320; scanId: string;
    completedAt: number | null; reason: string;
};
export type CampaignObservation = {
    resultId: number;
    postId: string;
    postUrl: string;
    pageId: string;
    campaignId: string;
    publishedAt: number | null;
    observedAt: number;
    milestoneMinutes: 60 | 1440 | 4320;
    sourceRef: string;
    status: 'measured' | 'unavailable';
    reason: string;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
};
export type CampaignReport = {
    measurementWindow: { milestoneMinutes: 4320; minAgeHours: 72; maxAgeHours: 96 };
    observations: Array<CampaignObservation & { sourceAvailable: boolean }>;
    campaignId: string;
    pageId: string;
    from: number;
    to: number;
    published: number;
    eligible: number;
    measured: number;
    coverage: number | null;
    totalEngagement: number | null;
    uniqueLeads: number;
    lastObservedAt: number | null;
    missingReasons: string[];
    finance: { status: 'unavailable'; reason: 'missing_financial_source' };
};
export type CampaignCohort = {
    kind: 'variant' | 'time';
    key: string;
    format: 'text' | 'image' | 'video';
    contentRevision: string;
    eligibleResultIds: number[];
    observationRefs: string[];
};
export type CampaignDecisionInput = Omit<CampaignDecision, 'id' | 'campaignId' | 'grantId' | 'grantRevision' | 'createdAt'>;
export type CampaignDecision = {
    id: string;
    campaignId: string;
    grantId: string;
    grantRevision: number;
    kind: 'keep' | 'variant' | 'time';
    before: string | number | null;
    after: string | number | null;
    observationRefs: string[];
    sampleSizes: Record<string, number>;
    coverage: Record<string, number>;
    reason: string;
    createdAt: number;
};
