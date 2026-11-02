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
    /** Nguồn lệnh: 'api' = bot duyệt qua Control API (bị bộ giới hạn tự vận hành chặn bớt), 'app' = anh thao tác. */
    origin?: 'api' | 'app';
}

export interface FbPosterSchedule {
    id: string;
    revision: number;
    name: string;
    kind: 'once' | 'recurring';
    params: Record<string, unknown>; // StartParams kiểu 'post'; mediaPaths là tên tệp đã lưu
    runAt: number | null;
    days: number[];
    time: string;
    enabled: boolean;
    /** Bản nháp: luôn enabled = false, nextRunAt = null; chỉ thành lịch thật khi được duyệt. */
    draft: boolean;
    /** Server provenance only; optional for legacy in-memory shapes, required on persisted rows. */
    authorityKind?: 'owner' | 'autonomy';
    /** Nguồn lệnh khi duyệt bản nháp; lượt từ lịch kế thừa. Dòng cũ là 'app'. */
    origin?: 'api' | 'app';
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
    /** Thời điểm ước tính đổi từ commentedAt; null nếu không đọc được. */
    commentedAtMs: number | null;
    collectedAt: number;
}

export type LeadStatus = 'new' | 'contacted' | 'won' | 'ignored';

/** Khách tiềm năng lọc từ bình luận (bảng fb_poster_leads). */
export interface FbPosterLead {
    id: number;
    commentKey: string;
    postUrl: string;
    resultId: number | null;
    groupUrl: string;
    campaignId: string | null;
    variant: string;
    profileId: string;
    authorId: string;
    authorName: string;
    authorUrl: string;
    text: string;
    commentedAtMs: number | null;
    /** Từ khoá khớp; có thêm 'phone' nếu khớp số điện thoại. */
    matched: string[];
    aiIntent: 'buy' | 'question' | 'other' | null;
    aiScore: number | null;
    aiReason: string | null;
    status: LeadStatus;
    note: string;
    detectedAt: number;
    updatedAt: number;
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

/** Loại đích của dòng theo dõi (spec 2026-10-31 §4.2); dòng cũ là 'group'. */
export type TrackTargetKind = 'group' | 'page';

/** Một lần chụp số người theo dõi của Page; tối đa một dòng mỗi Page mỗi ngày địa phương. */
export interface PageFollowerRow {
    pageId: string;
    profileId: string;
    capturedOn: string;
    capturedAt: number;
    followers: number;
    /** Chữ gốc trên Facebook ('1,3K'); '' với dòng cũ. */
    followersText?: string;
    /** Số đã làm tròn theo đơn vị K/Tr; vắng = chính xác. */
    approximate?: boolean;
}

export interface PostTrackingRow {
    resultId: number;
    runId: string;
    scheduleId: string | null;
    campaignId: string | null;
    variant: string;
    profileId: string;
    targetKind: TrackTargetKind;
    /** Id Page chủ bài với dòng 'page' (đã xác minh hoặc '' khi chưa học được Page); '' với dòng 'group'. */
    pageId: string;
    /** Với dòng 'page': URL đích của kết quả (thường là trang chủ), không phải URL nhóm. */
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
    /** Nhãn các mốc thu bình luận đã làm, dạng `${phút}m`. */
    commentsDone: string[];
    nextCommentAt: number | null;
}

export interface PostStatsSnapshot {
    id: number;
    resultId: number;
    capturedAt: number;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
}

/** 'group' chỉ bài nhóm, 'page' chỉ bài Page (theo page_id); các cách gom khác tính cả hai. */
export type PostStatsGroupBy = 'group' | 'page' | 'profile' | 'schedule' | 'campaign' | 'variant' | 'day' | 'post' | 'hour' | 'weekday';

/** Một Page trong `pages.metrics` / `facebookPoster:pageMetrics` (spec 2026-10-31 §6); chỉ bài Page đã biết Page. */
export interface PageMetrics {
    pageId: string;
    /** Tên Page đã học, chưa có thì là pageId. */
    pageName: string;
    /** Mới nhất trước; `snapshots` là mọi lần đo, cũ trước. */
    posts: { resultId: number; postId: string; postUrl: string | null; postedAt: number; linkStatus: LinkStatus; text: string; snapshots: PostStatsSnapshot[] }[];
    /** Theo ngày tăng dần; rỗng khi chưa đọc được (không có số 0 giả). */
    followers: PageFollowerRow[];
}

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
    /** `measured` < MIN_MEASURED_FOR_COMPARISON: chưa đủ dữ liệu để so sánh. */
    insufficient: boolean;
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

export type LeadReplyStatus = 'queued' | 'running' | 'posted' | 'skipped' | 'failed' | 'uncertain';
export interface FbPosterLeadReply {
    id: number;
    leadId: number;
    profileId: string;
    postUrl: string;
    authorId: string;
    text: string;
    status: LeadReplyStatus;
    reason: string;
    reservationId: number | null;
    createdAt: number;
    finishedAt: number | null;
}
/** Khách + bài gốc để trả lời; `fromAppPost` chỉ đúng khi khách thuộc kết quả `posted` của một lượt `kind='post'`. */
export interface LeadReplySource { leadId: number; postUrl: string; authorId: string; profileId: string; fromAppPost: boolean; postText: string }
