import { DEFAULT_AUTONOMY_POLICY, type AutonomyPolicy } from '../../services/autonomy/autonomyPolicy';
import type { AutonomyStatus } from '../../services/autonomy/autonomyOperations';
import type { FbPosterLeadReply } from '../../models/facebookPoster';
import {
  buildPolicyRows, buildProfileRows, buildWorkspaceRows, confirmThenCall, fieldFromError, formatFollowers, leadReplyRows,
} from '../../ui/components/settings/autonomyView';

const policy = (patch: Partial<AutonomyPolicy> = {}): AutonomyPolicy => ({ ...DEFAULT_AUTONOMY_POLICY, ...patch });

const status = (patch: Partial<AutonomyStatus> = {}): AutonomyStatus => ({
  policy: policy({ leadRepliesPerDay: 10 }),
  enabled: true, masterOn: true, quietNow: false,
  usage: { date: '2026-11-02', workspace: { videos: 1, agentRuns: 4 }, profiles: { p1: { pagePosts: 1, groupPosts: 2, leadReplies: 3, facebookActions: 6 } } },
  remaining: {
    videos: 1, agentRuns: 8,
    profileDefault: { pagePosts: 1, groupPosts: 3, leadReplies: 10, facebookActions: 12 },
    profiles: { p1: { pagePosts: 0, groupPosts: 1, leadReplies: 7, facebookActions: 6 } },
  },
  pausedProfiles: [], due: {} as AutonomyStatus['due'], now: 0, timeZone: 'UTC',
  ...patch,
} as AutonomyStatus);

const reply = (patch: Partial<FbPosterLeadReply>): FbPosterLeadReply => ({
  id: 1, leadId: 1, profileId: 'p1', postUrl: 'https://facebook.com/x', authorId: 'a', text: 'Cảm ơn anh chị',
  status: 'posted', reason: '', reservationId: null, createdAt: 1000, finishedAt: 2000, ...patch,
});

describe('autonomyView', () => {
  test('rendersDefaultsAndUsage', () => {
    const rows = buildPolicyRows(policy({ groupPostsPerDay: 5 }));
    const group = rows.find((r) => r.key === 'groupPostsPerDay')!;
    expect(group).toMatchObject({ value: 5, defaultValue: 3, isDefault: false, kind: 'count' });
    expect(rows.find((r) => r.key === 'leadRepliesPerDay')).toMatchObject({ value: 10, defaultValue: 10, isDefault: true });
    expect(rows.find((r) => r.key === 'quietStart')).toMatchObject({ kind: 'time', defaultValue: '22:00' });
    expect(rows.map((r) => r.key as string)).not.toContain('enabled');

    const [p1] = buildProfileRows(status());
    expect(p1.profileId).toBe('p1');
    expect(p1.cells.find((c) => c.key === 'leadReplies')).toMatchObject({ used: 3, cap: 10, remaining: 7 });
    expect(p1.cells.find((c) => c.key === 'pagePosts')).toMatchObject({ used: 1, cap: 1, remaining: 0 });

    const ws = buildWorkspaceRows(status());
    expect(ws).toEqual([
      { key: 'videos', label: 'Video', used: 1, cap: 2, remaining: 1 },
      { key: 'agentRuns', label: 'Lượt AI', used: 4, cap: 12, remaining: 8 },
    ]);
  });

  test('engagementUsageCellsAndHint', () => {
    const [p1] = buildProfileRows(status({
      usage: { date: '2026-11-02', workspace: { videos: 0, agentRuns: 0 }, profiles: { p1: { pagePosts: 0, groupPosts: 0, leadReplies: 0, facebookActions: 3, engagementSuggestions: 4, engagementComments: 10 } } },
    }));
    expect(p1.cells.find((c) => c.key === 'engagementSuggestions')).toMatchObject({ label: 'Gợi ý bình luận', used: 4, cap: 20, remaining: 16 });
    expect(p1.cells.find((c) => c.key === 'engagementComments')).toMatchObject({ label: 'Bình luận được duyệt', used: 10, cap: 10, remaining: 0 });
    // A profile with no engagement usage yet still shows both cells at zero.
    const [other] = buildProfileRows(status({ pausedProfiles: [{ profileId: 'p9', reason: 'checkpoint', pausedAt: 1 }] }));
    expect(other.cells.filter((c) => c.key.startsWith('engagement')).map((c) => c.used)).toEqual([0, 0]);
    expect(buildPolicyRows(policy()).find((r) => r.key === 'facebookActionsPerDay')?.hint).toBe('Gồm đăng, trả lời khách và bình luận được duyệt');
  });

  test('invalidCapShowsFieldError', () => {
    expect(fieldFromError('pagePostsPerDay phải là số nguyên không âm')).toEqual({ field: 'pagePostsPerDay', message: 'pagePostsPerDay phải là số nguyên không âm' });
    expect(fieldFromError('pageCampaignDays phải từ 1 đến 30')?.field).toBe('pageCampaignDays');
    // Rule about a pair of fields: no single cell owns it, so it stays a form-level error.
    expect(fieldFromError('Khung giờ đăng Page: giờ bắt đầu phải trước giờ kết thúc')).toBeNull();
    expect(fieldFromError('Lỗi lạ')).toBeNull();
    expect(fieldFromError(undefined)).toBeNull();
  });

  test('fieldErrorPicksTheNamedFieldNotAMentionedOne', () => {
    expect(fieldFromError('pagePostsTotal phải nhỏ hơn pagePostsPerDay')?.field).toBe('pagePostsTotal');
    expect(fieldFromError('Mục chính sách không hợp lệ: pagePostsPerDay, foo')).toBeNull();
    expect(fieldFromError('Không lưu được pageCampaignDays')).toBeNull();
  });

  test('profileRowsUseNamesWithIdFallback', () => {
    const rows = buildProfileRows(status({ pausedProfiles: [{ profileId: 'p2', reason: 'logged_out', pausedAt: 5 }] }), { p1: 'Mai Shop' });
    expect(rows.find((r) => r.profileId === 'p1')!.name).toBe('Mai Shop');
    expect(rows.find((r) => r.profileId === 'p2')!.name).toBe('p2');
    expect(buildProfileRows(status())[0].name).toBe('p1');
  });

  test('pausedProfileShowsResumeButton', () => {
    const rows = buildProfileRows(status({ pausedProfiles: [{ profileId: 'p2', reason: 'checkpoint', pausedAt: 5 }] }));
    const p2 = rows.find((r) => r.profileId === 'p2')!;
    expect(p2.paused).toEqual({ reason: 'checkpoint', reasonLabel: 'Facebook yêu cầu xác minh (checkpoint)', pausedAt: 5 });
    expect(p2.canResume).toBe(true);
    expect(p2.cells.find((c) => c.key === 'facebookActions')).toMatchObject({ used: 0, cap: 12, remaining: 12 });
    expect(rows.find((r) => r.profileId === 'p1')!.canResume).toBe(false);
  });

  test('performanceShowsApproximateFollowers', () => {
    expect(formatFollowers(1300, true)).toBe('≈ 1.300');
    expect(formatFollowers(1300, false)).toBe('1.300');
    expect(formatFollowers(1234567, true)).toBe('≈ 1.234.567');
    expect(formatFollowers(null, true)).toBe('chưa đủ dữ liệu');
  });

  test('performanceListsLeadReplies', () => {
    const rows = leadReplyRows([
      reply({ id: 1, status: 'posted' }),
      reply({ id: 2, status: 'skipped', reason: 'quota' }),
      reply({ id: 3, status: 'uncertain', text: 'x'.repeat(200) }),
    ]);
    expect(rows.map((r) => r.statusLabel)).toEqual(['Đã gửi', 'Bỏ qua', 'Chưa rõ kết quả']);
    expect(rows.map((r) => r.tone)).toEqual(['ok', 'muted', 'warn']);
    expect(rows[1].reason).toBe('quota');
    expect(rows[2].text.length).toBeLessThanOrEqual(80);
    expect(rows[2].text.endsWith('…')).toBe(true);
    expect(rows[0].at).toBe(2000);
  });

  test('stopAsksConfirmationThenCallsIpc', async () => {
    const call = jest.fn().mockResolvedValue('done');
    expect(await confirmThenCall(async () => false, call)).toEqual({ ran: false });
    expect(call).not.toHaveBeenCalled();
    expect(await confirmThenCall(async () => true, call)).toEqual({ ran: true, value: 'done' });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
