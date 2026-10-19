// Nguồn: docs/specs/2026-10-19-topic-research.md mục 4.1 và 7.
export type ResearchSource = 'posts' | 'groups' | 'pages' | 'group_feed';
export type ResearchScanStatus = 'running' | 'done' | 'failed' | 'cancelled';
export type ResearchOrigin = 'manual' | 'api';
export type ResearchItemKind = 'post' | 'group' | 'page';
export type ResearchSort = 'engagement' | 'recent' | 'members';

export type ResearchErrorCode =
    | 'logged_out' | 'checkpoint' | 'rate_limited' | 'query_changed'
    | 'parse_failed' | 'no_profile_available' | 'cancelled';

export interface ResearchScan {
    id: string;
    source: ResearchSource;
    query: string;
    params: Record<string, unknown>;
    profileIds: string[];
    details: Record<string, unknown>;
    origin: ResearchOrigin;
    status: ResearchScanStatus;
    errorCode: ResearchErrorCode | '';
    error: string;
    itemCount: number;
    startedAt: number;
    finishedAt: number | null;
}

/** Mục do bộ đọc trả về, trước khi gắn scan/profile. */
export interface ResearchItemInput {
    kind: ResearchItemKind;
    fbId: string;
    url: string;
    title: string;
    placeKind?: 'group' | 'page' | 'person' | 'unknown';
    placeId?: string;
    placeName?: string;
    authorKind?: 'person' | 'page' | 'unknown';
    authorId?: string;
    authorName?: string;
    authorUrl?: string;
    privacy?: 'public' | 'private' | '';
    memberCount?: number | null;
    followerCount?: number | null;
    reactions?: number | null;
    comments?: number | null;
    shares?: number | null;
    postedAt?: number | null;
}

/** Mục do bộ đọc GraphQL trả về: đủ mọi trường của research_items (trừ id, scan, thời điểm thu, profile). */
export type ParsedItem = Required<ResearchItemInput>;

export interface ResearchItem extends Required<ResearchItemInput> {
    id: number;
    scanId: string;
    capturedAt: number;
    profileId: string;
    engagement: number | null;
    engagementRate: number | null;
}

export interface ResearchQuery { friendlyName: string; docId: string; variablesTemplate: string; capturedAt: number; }
