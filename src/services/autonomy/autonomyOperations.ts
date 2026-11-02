import { ControlError } from '../control/ControlMethods';
import type { ControlEventType } from '../control/controlEvents';
import { buildAutonomyChanged, buildAutonomyPaused, buildAutonomyStopped } from '../control/controlEvents';
import type { LocalClock } from '../dailyBrief/DailyBriefStore';
import type { LoginState } from '../../models/facebookPoster';
import type { AutonomyLimiter, PolicyChange } from './AutonomyLimiter';
import { inQuietHours, type AutonomyPolicy } from './autonomyPolicy';
import type { AutonomyDueWork } from './autonomyDueWork';

export const AGENT_RUN_OUTCOMES = ['ok', 'error', 'timeout'] as const;
export type AgentRunOutcome = (typeof AGENT_RUN_OUTCOMES)[number];

export interface AutonomyOperationsDeps {
    limiter(): AutonomyLimiter;
    dueWork(): AutonomyDueWork;
    emit(type: ControlEventType, payload: unknown): void;
    cancelApiWork(): { cancelledRuns: number; disabledSchedules: number };
    /** Dừng khẩn cũng huỷ các bình luận đã duyệt chưa đăng (`approved`); trả số dòng đã huỷ. */
    cancelApprovedEngagement?(): number;
    now(): number;
    clock: LocalClock;
    masterOn(): boolean;
    timeZone?(): string;
    log?(message: string): void;
}

interface ProfileRemaining { pagePosts: number; groupPosts: number; leadReplies: number; facebookActions: number }

const left = (cap: number, used: number) => Math.max(0, cap - used);
const profileRemaining = (p: AutonomyPolicy, used?: ProfileRemaining): ProfileRemaining => ({
    pagePosts: left(p.pagePostsPerDay, used?.pagePosts ?? 0),
    groupPosts: left(p.groupPostsPerDay, used?.groupPosts ?? 0),
    leadReplies: left(p.leadRepliesPerDay, used?.leadReplies ?? 0),
    facebookActions: left(p.facebookActionsPerDay, used?.facebookActions ?? 0),
});

/** Shared by the Control API and IPC; `actor` is the key name for the bot and 'app' for the desktop UI. */
export function createAutonomyOperations(deps: AutonomyOperationsDeps) {
    const applyPolicy = (patch: unknown, actor: string) => {
        const result = deps.limiter().setPolicy(patch, actor);
        if (result.changes.length) deps.emit('autonomy.changed', buildAutonomyChanged({ actor, changes: result.changes }));
        return result;
    };

    /** Emergency stop: cancels the bot's work and reports, even if cancelling fails (spec §4.3). */
    const cancelAndReport = (actor: string) => {
        let cancelledRuns = 0;
        let disabledSchedules = 0;
        try { ({ cancelledRuns, disabledSchedules } = deps.cancelApiWork()); }
        catch (err) { deps.log?.(`[autonomy] cancelApiWork failed: ${err instanceof Error ? err.message : String(err)}`); }
        let cancelledEngagement = 0;
        try { cancelledEngagement = deps.cancelApprovedEngagement?.() ?? 0; }
        catch (err) { deps.log?.(`[autonomy] cancelApprovedEngagement failed: ${err instanceof Error ? err.message : String(err)}`); }
        if (cancelledEngagement) deps.log?.(`[autonomy] emergency stop cancelled ${cancelledEngagement} approved comment(s)`);
        deps.emit('autonomy.stopped', buildAutonomyStopped({ actor, cancelledRuns, disabledSchedules, cancelledEngagement }));
        return { cancelledRuns, disabledSchedules, cancelledEngagement };
    };

    return {
        status() {
            const limiter = deps.limiter();
            const policy = limiter.policy();
            const usage = limiter.usage();
            const now = deps.now();
            const profiles: Record<string, ProfileRemaining> = {};
            for (const [id, used] of Object.entries(usage.profiles)) profiles[id] = profileRemaining(policy, used);
            return {
                policy,
                enabled: policy.enabled,
                masterOn: deps.masterOn(),
                quietNow: inQuietHours(policy, deps.clock.minutes(now)),
                usage,
                // Per-day caps minus today's use; `profileDefault` applies to a profile with no use yet.
                remaining: {
                    videos: left(policy.videosPerDay, usage.workspace.videos),
                    agentRuns: left(policy.agentRunsPerDay, usage.workspace.agentRuns),
                    profileDefault: profileRemaining(policy),
                    profiles,
                },
                pausedProfiles: limiter.pausedProfiles(),
                due: deps.dueWork(),
                now,
                timeZone: deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            };
        },

        config: () => ({ policy: deps.limiter().policy() }),

        changes: (sinceMs: number): { changes: PolicyChange[] } => ({ changes: deps.limiter().changes(sinceMs) }),

        setConfig(patch: unknown, actor: string) {
            const result = applyPolicy(patch, actor);
            // Turning autonomy off is an emergency stop too (spec §4.3).
            if (result.changes.some((c) => c.field === 'enabled' && c.before === true && c.after === false)) cancelAndReport(actor);
            return result;
        },

        stop(actor: string) {
            applyPolicy({ enabled: false }, actor);
            // The stop switch must report and stay off even if cancelling the bot's work fails.
            return { enabled: false, ...cancelAndReport(actor) };
        },

        resume(actor: string) {
            applyPolicy({ enabled: true }, actor);
            return { enabled: true };
        },

        resumeProfile(profileId: string, actor: string) {
            const limiter = deps.limiter();
            const reason = limiter.pausedProfiles().find((p) => p.profileId === profileId)?.reason;
            const resumed = limiter.resumeProfile(profileId);
            if (resumed) deps.emit('autonomy.changed', buildAutonomyChanged({ actor, profileId,
                changes: [{ at: deps.now(), actor, field: 'profileResumed', before: reason ?? null, after: 'resumed' }] }));
            return { resumed };
        },

        recordAgentRun(params: { outcome: AgentRunOutcome }) {
            if (!AGENT_RUN_OUTCOMES.includes(params?.outcome)) throw new ControlError('INVALID_PARAMS', `outcome phải là một trong: ${AGENT_RUN_OUTCOMES.join(', ')}`, { field: 'outcome' });
            const limiter = deps.limiter();
            const id = limiter.reserve({ action: 'agent_run', origin: 'api', ref: params.outcome });
            const recorded = id !== null && limiter.commit(id);
            return { recorded, remaining: left(limiter.policy().agentRunsPerDay, limiter.usage().workspace.agentRuns) };
        },

        /** Only checkpoint and logged_out stop a profile; the event is emitted once per pause. */
        pauseOnLoginProblem(e: { profileId: string; profileName: string; state: LoginState }): boolean {
            if (e.state !== 'checkpoint' && e.state !== 'logged_out') return false;
            if (!deps.limiter().pauseProfile(e.profileId, e.state)) return false;
            deps.emit('autonomy.paused', buildAutonomyPaused({ profileId: e.profileId, profileName: e.profileName, reason: e.state }));
            return true;
        },
    };
}

export type AutonomyOperations = ReturnType<typeof createAutonomyOperations>;
export type AutonomyStatus = ReturnType<AutonomyOperations['status']>;
