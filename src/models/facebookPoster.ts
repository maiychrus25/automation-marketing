export type FbPosterKind = 'post' | 'join' | 'scan_groups' | 'collect_comments';
export type FbPosterMode = 'group' | 'page';
export type FbPosterRunStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface FbPosterRun {
    id: string;
    kind: FbPosterKind;
    mode: FbPosterMode | '';
    params: Record<string, unknown>;
    status: FbPosterRunStatus;
    error: string;
    startedAt: number;
    finishedAt: number | null;
}

export interface FbPosterResult {
    id: number;
    runId: string;
    profileId: string;
    profileName: string;
    targetUrl: string;
    targetName: string;
    outcome: string;
    error: string;
    postUrl: string | null;
    commentStatus: string;
    identity: string;
    createdAt: number;
}

export interface FbPosterGroup {
    profileId: string;
    url: string;
    name: string;
    scannedAt: number;
}

export interface FbPosterComment {
    key: string;
    profileId: string;
    postUrl: string;
    authorId: string;
    authorName: string;
    authorUrl: string;
    text: string;
    commentedAt: string;
    collectedAt: number;
}
