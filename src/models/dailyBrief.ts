export type PageIdentityKind = 'page' | 'person' | 'unknown';

export interface PagePostSample {
    text: string;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    postedAt: number | null;
    url: string;
}

export interface PageIdentity {
    profileId: string;
    kind: PageIdentityKind;
    pageId: string;
    pageName: string;
    category: string;
    about: string;
    recentPosts: PagePostSample[];
    learnedAt: number;
    errorCode: string;
    error: string;
}

export interface DailyBrief {
    profileId: string;
    niche: string;
    keywords: string[];
    groupIds: string[];
    tone: string;
    notes: string;
    time: string;
    draftsPerDay: number;
    enabled: boolean;
    lastRunDate: string | null;
    status: 'idle' | 'running';
    attemptDate: string | null;
    attempts: number;
    claimedAt: number | null;
    claimedDate: string | null;
    updatedAt: number;
}

export type DailyBriefPatch = Partial<Pick<DailyBrief,
    'niche' | 'keywords' | 'groupIds' | 'tone' | 'notes' | 'time' | 'draftsPerDay' | 'enabled'
>>;
