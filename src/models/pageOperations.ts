export interface PageContext {
    workspaceId: string;
    dbPath: string;
    pageId: string;
    profileId: string;
}

export interface PageFact {
    id: string;
    topic: string;
    value: string;
    status: 'observed' | 'hypothesis' | 'confirmed';
    sourceType: 'page' | 'research' | 'owner';
    sourceRef: string;
    reason: string;
    observedAt: number;
    updatedAt: number;
    confirmedAt: number | null;
    confirmationRef: string | null;
}

export interface PageFactInput {
    id?: string;
    topic: string;
    value: string;
    status: 'observed' | 'hypothesis';
    sourceType: 'page' | 'research';
    sourceRef: string;
    reason: string;
    observedAt: number;
}

/** Metadata supplied only by the trusted owner-confirmation path. */
export interface PageConfirmation {
    confirmedAt: number;
    confirmationRef: string;
}

export interface PageBusiness {
    pageId: string;
    primaryProfileId: string | null;
    revision: number;
    updatedAt: number;
    enabled: boolean;
    protectedSince: number | null;
    facts: PageFact[];
}

export interface PageDraftInput {
    id?: string;
    expectedRevision?: number;
    name?: string;
    plannedAt?: number | null;
    text: string;
    variants?: string[];
    mediaIds?: string[];
    comment?: string;
    campaignId?: string | null;
}

export type PageDraftView = Omit<PageDraftInput, 'expectedRevision'> & { id: string; revision: number };
export type PageDraftProjection = PageDraftView | { id: string; status: 'promoted' | 'removed' };
export type PageResearchInput = { kind: 'search'; keywords: string[] } | { kind: 'group_feed'; groupIds: string[] };

export interface WorkLease {
    workId: string;
    claimedAt: number;
}

export interface PageResourceRef {
    kind: 'research' | 'video' | 'draft' | 'media' | 'campaign';
    id: string;
}

export interface PageResourceOwner {
    workspaceId: string;
    pageId: string;
    workId: string;
}

export interface WorkStep {
    workId: string;
    stepKey: string;
    requestHash: string;
    status: 'intent' | 'succeeded' | 'uncertain';
    resourceKind: PageResourceRef['kind'] | null;
    resourceId: string | null;
    resultRevision?: number | null;
}

export interface PageWork {
    id: string;
    workspaceId: string;
    pageId: string;
    profileId: string;
    briefDate: string;
    campaignId: string | null;
    status: 'pending' | 'running' | 'waiting' | 'needs_review' | 'completed' | 'failed' | 'cancelled';
    step: string | null;
    claimedAt: number | null;
    attempts: number;
    waitFor: 'video' | null;
    nextCheckAt: number | null;
    researchId: string | null;
    videoId: string | null;
    draftIds: string[];
    reason: string;
    evidenceRefs: string[];
    lastError: string | null;
    updatedAt: number;
}

export type OwnerDraftTiming = { when: 'now' }
    | { when: 'schedule'; kind: 'once'; runAt: number }
    | { when: 'schedule'; kind: 'recurring'; days: number[]; time: string };

/** Closed commands accepted only from the authenticated receiver, never runner intent. */
export type OwnerAction =
    | { kind: 'grantCampaign'; pageId: string; proposalId: string; expectedProposalRevision: number }
    | { kind: 'revokeCampaignGrant'; pageId: string; grantId: string; expectedGrantRevision: number }
    | ({ kind: 'confirmFact'; pageId: string; expectedRevision: number } &
        ({ factId: string; fact?: never } | { fact: { topic: string; value: string; reason: string }; factId?: never }))
    | { kind: 'setPrimaryProfile'; pageId: string; expectedRevision: number; profileId: string }
    | { kind: 'setEnabled'; pageId: string; expectedRevision: number; enabled: boolean }
    | { kind: 'resolveWork'; pageId: string; workId: string; resolution: 'resume' | 'cancel' }
    | { kind: 'linkResource'; pageId: string; workId: string; resource: PageResourceRef }
    | { kind: 'approveDraft'; pageId: string; draftId: string; expectedRevision: number; timing: OwnerDraftTiming };

export interface OwnerUpdate {
    updateId: number;
    messageId: number;
    chatId: string;
    senderId: string;
    replyToMessageId: number;
}

/** Private receiver state: never serialize in runner views, events or caches. */
export interface ApprovalTicket {
    id: string;
    receiverKeyId: string;
    workspaceId: string;
    pageId: string;
    action: OwnerAction;
    fingerprint: string;
    chatId: string;
    senderId: string;
    messageId: number | null;
    expiresAt: number;
    consumedAt: number | null;
    update: OwnerUpdate | null;
    resourceId: string | null;
}

export interface PageAssignment {
    pageId: string;
    profileIds: string[];
}

export type ControlPrincipal =
    | { kind: 'legacy'; keyId: string }
    | { kind: 'page_runner'; keyId: string; workspaceId: string; assignments: PageAssignment[] }
    | { kind: 'page_receiver'; keyId: string; workspaceId: string; assignments: PageAssignment[]; ownerChatId: string; ownerSenderId: string };
