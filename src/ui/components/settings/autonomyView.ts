import { DEFAULT_AUTONOMY_POLICY, MAX_PAGE_CAMPAIGN_DAYS, type AutonomyPolicy } from '../../../services/autonomy/autonomyPolicy';
import type { AutonomyStatus } from '../../../services/autonomy/autonomyOperations';
import type { FbPosterLeadReply, LeadReplyStatus } from '../../../models/facebookPoster';

// Logic thuần của tab "Tự vận hành" và mục "Trả lời khách": tách khỏi React để test trong môi trường node.

type CountKey = 'pageCampaignDays' | 'pagePostsPerDay' | 'pagePostsTotal' | 'groupPostsPerDay' | 'groupRepeatDays' | 'leadRepliesPerDay' | 'facebookActionsPerDay' | 'videosPerDay' | 'agentRunsPerDay';
type TimeKey = 'quietStart' | 'quietEnd' | 'pageWindowStart' | 'pageWindowEnd';
export type PolicyFieldKey = CountKey | TimeKey | 'videoReserveLast';

export interface PolicyRow {
  key: PolicyFieldKey;
  label: string;
  hint?: string;
  kind: 'count' | 'time' | 'flag';
  min?: number;
  max?: number;
  value: number | string | boolean;
  defaultValue: number | string | boolean;
  isDefault: boolean;
}

const FIELDS: { key: PolicyFieldKey; label: string; kind: PolicyRow['kind']; hint?: string; min?: number; max?: number }[] = [
  { key: 'quietStart', label: 'Giờ im lặng: bắt đầu', kind: 'time', hint: 'Bot không đăng hay trả lời trong khoảng này' },
  { key: 'quietEnd', label: 'Giờ im lặng: kết thúc', kind: 'time' },
  { key: 'pageCampaignDays', label: 'Chiến dịch Page: số ngày', kind: 'count', min: 1, max: MAX_PAGE_CAMPAIGN_DAYS },
  { key: 'pagePostsPerDay', label: 'Bài Page mỗi ngày (mỗi Page)', kind: 'count', min: 0 },
  { key: 'pagePostsTotal', label: 'Tổng bài mỗi chiến dịch', kind: 'count', min: 0 },
  { key: 'pageWindowStart', label: 'Khung giờ đăng Page: từ', kind: 'time' },
  { key: 'pageWindowEnd', label: 'Khung giờ đăng Page: đến', kind: 'time' },
  { key: 'groupPostsPerDay', label: 'Đăng nhóm mỗi ngày (mỗi profile)', kind: 'count', min: 0 },
  { key: 'groupRepeatDays', label: 'Cùng nhóm cách tối thiểu (ngày)', kind: 'count', min: 0 },
  { key: 'leadRepliesPerDay', label: 'Trả lời khách mỗi ngày (mỗi profile)', kind: 'count', min: 0 },
  { key: 'facebookActionsPerDay', label: 'Tổng thao tác Facebook mỗi ngày (mỗi profile)', kind: 'count', min: 0, hint: 'Gồm đăng và trả lời' },
  { key: 'videosPerDay', label: 'Video mỗi ngày (cả workspace)', kind: 'count', min: 0 },
  { key: 'videoReserveLast', label: 'Giữ lượt video cuối cho anh', kind: 'flag' },
  { key: 'agentRunsPerDay', label: 'Lượt AI mỗi ngày', kind: 'count', min: 0 },
];

export const policyFieldLabel = (key: string): string => FIELDS.find((f) => f.key === key)?.label ?? (key === 'enabled' ? 'Công tắc tự vận hành' : key);

export function buildPolicyRows(policy: AutonomyPolicy): PolicyRow[] {
  return FIELDS.map((f) => ({
    ...f,
    value: policy[f.key],
    defaultValue: DEFAULT_AUTONOMY_POLICY[f.key],
    isDefault: policy[f.key] === DEFAULT_AUTONOMY_POLICY[f.key],
  }));
}

export interface UsageCell { key: 'pagePosts' | 'groupPosts' | 'leadReplies' | 'facebookActions'; label: string; used: number; cap: number; remaining: number }
export interface ProfileRow {
  profileId: string;
  /** Tên profile, không biết thì dùng mã. */
  name: string;
  cells: UsageCell[];
  paused: { reason: string; reasonLabel: string; pausedAt: number } | null;
  canResume: boolean;
}

const PAUSE_LABELS: Record<string, string> = {
  checkpoint: 'Facebook yêu cầu xác minh (checkpoint)',
  logged_out: 'Profile đã đăng xuất Facebook',
};

const CELLS: { key: UsageCell['key']; label: string; cap: keyof AutonomyPolicy }[] = [
  { key: 'pagePosts', label: 'Bài Page', cap: 'pagePostsPerDay' },
  { key: 'groupPosts', label: 'Đăng nhóm', cap: 'groupPostsPerDay' },
  { key: 'leadReplies', label: 'Trả lời khách', cap: 'leadRepliesPerDay' },
  { key: 'facebookActions', label: 'Tổng thao tác', cap: 'facebookActionsPerDay' },
];

/** Hợp profile đã dùng hôm nay và profile đang dừng; profile chưa dùng lấy `profileDefault`. */
export function buildProfileRows(status: AutonomyStatus, names: Record<string, string> = {}): ProfileRow[] {
  const ids = new Set([...Object.keys(status.usage.profiles), ...status.pausedProfiles.map((p) => p.profileId)]);
  return [...ids].sort().map((profileId) => {
    const used = status.usage.profiles[profileId];
    const remaining = status.remaining.profiles[profileId] ?? status.remaining.profileDefault;
    const pause = status.pausedProfiles.find((p) => p.profileId === profileId);
    return {
      profileId,
      name: names[profileId] || profileId,
      cells: CELLS.map((c) => ({ key: c.key, label: c.label, used: used?.[c.key] ?? 0, cap: status.policy[c.cap] as number, remaining: remaining[c.key] })),
      paused: pause ? { reason: pause.reason, reasonLabel: PAUSE_LABELS[pause.reason] ?? pause.reason, pausedAt: pause.pausedAt } : null,
      canResume: !!pause,
    };
  });
}

export function buildWorkspaceRows(status: AutonomyStatus) {
  return [
    { key: 'videos', label: 'Video', used: status.usage.workspace.videos, cap: status.policy.videosPerDay, remaining: status.remaining.videos },
    { key: 'agentRuns', label: 'Lượt AI', used: status.usage.workspace.agentRuns, cap: status.policy.agentRunsPerDay, remaining: status.remaining.agentRuns },
  ];
}

/** IPC chỉ trả chuỗi lỗi: `validateAutonomyPolicy` luôn mở đầu bằng tên trường ("pagePostsPerDay phải ..."); không mở đầu bằng tên trường thì là lỗi chung của form. */
export function fieldFromError(message: string | undefined): { field: PolicyFieldKey; message: string } | null {
  const lead = message?.match(/^(\w+)\s/)?.[1];
  const found = lead ? FIELDS.find((f) => f.key === lead) : undefined;
  return found && message ? { field: found.key, message } : null;
}

const groupThousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Số đã làm tròn theo K/Tr hiện "≈" phía trước (spec mục 9 và 11). */
export function formatFollowers(current: number | null, approximate: boolean): string {
  if (current === null) return 'chưa đủ dữ liệu';
  return `${approximate ? '≈ ' : ''}${groupThousands(current)}`;
}

const REPLY_STATUS: Record<LeadReplyStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info' }> = {
  queued: { label: 'Đang chờ', tone: 'info' },
  running: { label: 'Đang gửi', tone: 'info' },
  posted: { label: 'Đã gửi', tone: 'ok' },
  skipped: { label: 'Bỏ qua', tone: 'muted' },
  failed: { label: 'Lỗi', tone: 'bad' },
  uncertain: { label: 'Chưa rõ kết quả', tone: 'warn' },
};

const MAX_REPLY_TEXT = 80;

export function leadReplyRows(replies: FbPosterLeadReply[], names: Record<string, string> = {}) {
  return replies.map((r) => ({
    id: r.id,
    profileId: r.profileId,
    profileName: names[r.profileId] || r.profileId,
    postUrl: r.postUrl,
    status: r.status,
    statusLabel: REPLY_STATUS[r.status]?.label ?? r.status,
    tone: REPLY_STATUS[r.status]?.tone ?? 'muted',
    text: r.text.length > MAX_REPLY_TEXT ? `${r.text.slice(0, MAX_REPLY_TEXT - 1)}…` : r.text,
    reason: r.reason,
    at: r.finishedAt ?? r.createdAt,
  }));
}

export async function confirmThenCall<T>(confirm: () => Promise<boolean>, call: () => Promise<T>): Promise<{ ran: false } | { ran: true; value: T }> {
  if (!(await confirm())) return { ran: false };
  return { ran: true, value: await call() };
}
