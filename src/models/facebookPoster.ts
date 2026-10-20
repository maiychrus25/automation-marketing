export type FbPosterKind = 'post' | 'join' | 'scan_groups' | 'collect_comments';
export type FbPosterMode = 'group' | 'page';
export type FbPosterRunStatus = 'running' | 'done' | 'cancelled' | 'failed' | 'missed';

export type CampaignStatus = 'active' | 'paused' | 'archived';

export interface FbPosterCampaign {
    id: string;
    name: string;
    goal: string;
    status: CampaignStatus;
    startAt: number | null;
    endAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface FbPosterRun {
    id: string;
    kind: FbPosterKind;
    mode: FbPosterMode | '';
    params: Record<string, unknown>;
    status: FbPosterRunStatus;
    error: string;
    startedAt: number;
    finishedAt: number | null;
    scheduleId: string | null;
    scheduleName: string | null; // null khi lịch đã bị xóa
    campaignId: string | null;
}

export interface FbPosterSchedule {
    id: string;
    name: string;
    kind: 'once' | 'recurring';
    params: Record<string, unknown>; // StartParams kiểu 'post'; mediaPaths là tên tệp đã lưu
    runAt: number | null;
    days: number[];
    time: string;
    enabled: boolean;
    /** Bản nháp: luôn enabled = false, nextRunAt = null; chỉ thành lịch thật khi được duyệt. */
    draft: boolean;
    campaignId: string | null;
    nextRunAt: number | null;
    lastRunId: string | null;
    createdAt: number;
    updatedAt: number;
}

export interface FbPosterScheduleView extends FbPosterSchedule {
    lastRun: { status: FbPosterRunStatus; startedAt: number; error: string } | null;
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
    /** Mã lỗi ổn định ('' khi không lỗi hoặc không phải việc đăng). */
    errorCode: string;
    /** Số lần thử đăng (1 khi không thử lại). */
    attempts: number;
    /** Nhãn biến thể đã đăng ('A'..'E'), '' khi lịch không có biến thể. */
    variant: string;
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

export type LoginState = 'ok' | 'logged_out' | 'checkpoint';
export type LoginCheckOutcome = LoginState | 'error' | 'skipped';
export type LoginCheckSource = 'manual' | 'api' | 'daily';

export interface ProfileLoginState {
    profileId: string;
    state: LoginState | 'unknown';
    checkedAt: number | null;
    source: 'check' | 'run' | null;
    lastError: string | null;
    lastErrorAt: number | null;
}

// ─── Theo dõi bài đã đăng (docs/specs/2026-10-19-post-performance.md) ───────────

export type LinkStatus = 'known' | 'missing' | 'pending_approval' | 'not_found';

export interface PostTrackingRow {
    resultId: number;
    runId: string;
    scheduleId: string | null;
    campaignId: string | null;
    variant: string;
    profileId: string;
    groupUrl: string;
    groupId: string;
    postId: string;
    postUrl: string | null;
    postedAt: number;
    textHead: string;
    linkStatus: LinkStatus;
    removedSuspected: boolean;
    lastSeenAt: number | null;
    lastCheckedAt: number | null;
    checkCount: number;
    nextCheckAt: number | null;
    /** Nhãn các mốc đo đã làm, dạng `${phút}m` (ví dụ "60m", "1440m"). */
    statsDone: string[];
}

export interface PostStatsSnapshot {
    id: number;
    resultId: number;
    capturedAt: number;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
}

export type PostStatsGroupBy = 'group' | 'profile' | 'schedule' | 'day' | 'post';

export interface PostStatsReportRow {
    key: string;
    label: string;
    posts: number;
    withLink: number;
    pending: number;
    notFound: number;
    removedSuspected: number;
    reactions: number;
    comments: number;
    shares: number;
    /** Số bài đã có ít nhất một lần đo. */
    measured: number;
    avgEngagement: number | null;
    engagementRate: number | null;
    /** Chỉ có với groupBy = 'post'. */
    post?: {
        resultId: number;
        postUrl: string | null;
        groupUrl: string;
        text: string;
        postedAt: number;
        linkStatus: LinkStatus;
        snapshots: PostStatsSnapshot[];
    };
}
