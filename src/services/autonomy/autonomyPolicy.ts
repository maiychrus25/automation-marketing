export const AUTONOMY_POLICY_SETTING_KEY = 'autonomy_policy';

export interface AutonomyPolicy {
    enabled: boolean;
    quietStart: string;
    quietEnd: string;
    pageCampaignDays: number;
    pagePostsPerDay: number;
    pagePostsTotal: number;
    pageWindowStart: string;
    pageWindowEnd: string;
    groupPostsPerDay: number;
    groupRepeatDays: number;
    leadRepliesPerDay: number;
    facebookActionsPerDay: number;
    videosPerDay: number;
    videoReserveLast: boolean;
    agentRunsPerDay: number;
    engagementSuggestionsPerDay: number;
    engagementCommentsPerDay: number;
}

export const DEFAULT_QUIET_START = '22:00';
export const DEFAULT_QUIET_END = '07:00';
export const DEFAULT_PAGE_CAMPAIGN_DAYS = 7;
export const DEFAULT_PAGE_POSTS_PER_DAY = 1;
export const DEFAULT_PAGE_POSTS_TOTAL = 7;
export const DEFAULT_GROUP_POSTS_PER_DAY = 3;
export const DEFAULT_GROUP_REPEAT_DAYS = 3;
export const DEFAULT_LEAD_REPLIES_PER_DAY = 10;
export const DEFAULT_FACEBOOK_ACTIONS_PER_DAY = 12;
export const DEFAULT_VIDEOS_PER_DAY = 2;
export const DEFAULT_AGENT_RUNS_PER_DAY = 12;
export const DEFAULT_ENGAGEMENT_SUGGESTIONS_PER_DAY = 20;
export const DEFAULT_ENGAGEMENT_COMMENTS_PER_DAY = 10;
export const MAX_PAGE_CAMPAIGN_DAYS = 30;

export const DEFAULT_AUTONOMY_POLICY: Readonly<AutonomyPolicy> = Object.freeze({
    enabled: false,
    quietStart: DEFAULT_QUIET_START,
    quietEnd: DEFAULT_QUIET_END,
    pageCampaignDays: DEFAULT_PAGE_CAMPAIGN_DAYS,
    pagePostsPerDay: DEFAULT_PAGE_POSTS_PER_DAY,
    pagePostsTotal: DEFAULT_PAGE_POSTS_TOTAL,
    pageWindowStart: '08:00',
    pageWindowEnd: '21:00',
    groupPostsPerDay: DEFAULT_GROUP_POSTS_PER_DAY,
    groupRepeatDays: DEFAULT_GROUP_REPEAT_DAYS,
    leadRepliesPerDay: DEFAULT_LEAD_REPLIES_PER_DAY,
    facebookActionsPerDay: DEFAULT_FACEBOOK_ACTIONS_PER_DAY,
    videosPerDay: DEFAULT_VIDEOS_PER_DAY,
    videoReserveLast: true,
    agentRunsPerDay: DEFAULT_AGENT_RUNS_PER_DAY,
    engagementSuggestionsPerDay: DEFAULT_ENGAGEMENT_SUGGESTIONS_PER_DAY,
    engagementCommentsPerDay: DEFAULT_ENGAGEMENT_COMMENTS_PER_DAY,
});

const BOOLEAN_FIELDS = ['enabled', 'videoReserveLast'] as const;
const TIME_FIELDS = ['quietStart', 'quietEnd', 'pageWindowStart', 'pageWindowEnd'] as const;
const COUNT_FIELDS = ['pageCampaignDays', 'pagePostsPerDay', 'pagePostsTotal', 'groupPostsPerDay', 'groupRepeatDays', 'leadRepliesPerDay', 'facebookActionsPerDay', 'videosPerDay', 'agentRunsPerDay', 'engagementSuggestionsPerDay', 'engagementCommentsPerDay'] as const;
const KNOWN_FIELDS = new Set<string>([...BOOLEAN_FIELDS, ...TIME_FIELDS, ...COUNT_FIELDS]);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number {
    const match = HHMM.exec(hhmm);
    if (!match) throw new Error(`Giờ không hợp lệ: ${hhmm}`);
    return Number(match[1]) * 60 + Number(match[2]);
}

function plainObject(input: unknown, label: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} phải là một đối tượng`);
    return input as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>): void {
    const unknown = Object.keys(obj).filter((key) => !KNOWN_FIELDS.has(key));
    if (unknown.length) throw new Error(`Mục chính sách không hợp lệ: ${unknown.join(', ')}`);
}

/** Strict: requires every field, so a stored or merged object is always complete. */
export function validateAutonomyPolicy(input: unknown): AutonomyPolicy {
    const obj = plainObject(input, 'Chính sách tự vận hành');
    rejectUnknown(obj);
    for (const key of BOOLEAN_FIELDS) if (typeof obj[key] !== 'boolean') throw new Error(`${key} phải là true hoặc false`);
    for (const key of TIME_FIELDS) if (typeof obj[key] !== 'string' || !HHMM.test(obj[key] as string)) throw new Error(`${key} phải có dạng HH:MM`);
    for (const key of COUNT_FIELDS) if (!Number.isSafeInteger(obj[key]) || (obj[key] as number) < 0) throw new Error(`${key} phải là số nguyên không âm`);
    const policy = obj as unknown as AutonomyPolicy;
    if (policy.pageCampaignDays < 1 || policy.pageCampaignDays > MAX_PAGE_CAMPAIGN_DAYS) throw new Error(`pageCampaignDays phải từ 1 đến ${MAX_PAGE_CAMPAIGN_DAYS}`);
    if (minutesOf(policy.pageWindowStart) >= minutesOf(policy.pageWindowEnd)) throw new Error('Khung giờ đăng Page: giờ bắt đầu phải trước giờ kết thúc');
    return { ...policy };
}

export function mergeAutonomyPolicy(current: AutonomyPolicy, patch: unknown): AutonomyPolicy {
    const obj = plainObject(patch, 'Thay đổi chính sách');
    rejectUnknown(obj);
    return validateAutonomyPolicy({ ...current, ...obj });
}

export function parseAutonomyPolicy(raw: string | null): AutonomyPolicy {
    if (!raw) return { ...DEFAULT_AUTONOMY_POLICY };
    try {
        return mergeAutonomyPolicy({ ...DEFAULT_AUTONOMY_POLICY }, JSON.parse(raw));
    } catch {
        return { ...DEFAULT_AUTONOMY_POLICY };
    }
}

/** quietStart > quietEnd wraps midnight; equal means no quiet hours. */
export function inQuietHours(policy: Pick<AutonomyPolicy, 'quietStart' | 'quietEnd'>, minuteOfDay: number): boolean {
    const start = minutesOf(policy.quietStart);
    const end = minutesOf(policy.quietEnd);
    if (start === end) return false;
    return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}
