import { randomUUID } from 'crypto';
import type { AutomationSession } from '../browser/BrowserProfileService';
import type { FbPosterMode, FbPosterRun, LinkStatus } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import type { LaunchedPage, LogLevel, TaskDeps } from './types';
import { collectComments } from './collectComments';
import { searchAndJoinGroups } from './joinGroups';
import { isLoggedIn, FB_HOME } from './loginState';
import { postToTargets } from './postToTargets';
import { assignVariants, variantKey, variantText, VARIANT_LABELS } from './variants';
import { scanGroups } from './scanGroups';
import { normalizeTarget } from './targets';
import { computeNextCheckAt, DEFAULT_POST_TRACKING_CONFIG, normalizeHead, type PostTrackingConfig } from './postTracking';

export interface ProfileInfo { id: string; name: string; }

export type StartParams =
    | { kind: 'post'; mode: FbPosterMode; text: string; mediaPaths: string[]; comment: string | null; commentDelayMin?: number; profiles: { profileId: string; targets: string[] }[]; minDelaySec: number; maxDelaySec: number; concurrency: number; staggerMinSec: number; staggerMaxSec: number; variants?: string[]; campaignId?: string | null }
    | { kind: 'scan_groups'; profileIds: string[]; concurrency: number; staggerMinSec: number; staggerMaxSec: number }
    | { kind: 'join'; profileId: string; keywords: string[]; limit: number; minDelaySec: number; maxDelaySec: number }
    | { kind: 'collect_comments'; profileId: string; postUrls: string[] };

export interface ProfileProgress { profileId: string; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; done: number; total: number; }
export interface ProgressSnapshot { runId: string; done: number; total: number; profiles: ProfileProgress[]; }

export interface FacebookPosterServiceDeps {
    store: FacebookPosterStore;
    getProfile: (id: string) => ProfileInfo | null;
    openForAutomation: (profileId: string) => Promise<AutomationSession>;
    emit: (channel: 'facebookPoster:log' | 'facebookPoster:progress' | 'facebookPoster:runFinished', data: unknown) => void;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number, isStopping: () => boolean) => Promise<void>;
    newId?: () => string;
    /** Cấu hình theo dõi bài (mốc thử lấy link/đo); mặc định DEFAULT_POST_TRACKING_CONFIG. */
    readTrackingConfig?: () => PostTrackingConfig;
    /** Báo trạng thái đăng nhập quan sát được trong lượt đăng (lỗi của hàm này bị bỏ qua). */
    onLoginObserved?: (profileId: string, state: 'ok' | 'logged_out') => void;
    tasks?: Partial<{ postToTargets: typeof postToTargets; scanGroups: typeof scanGroups; searchAndJoinGroups: typeof searchAndJoinGroups; collectComments: typeof collectComments }>;
}

export const BUSY_ERROR = 'Đang có việc chạy';
export const ENGINE_MISSING_ERROR = 'Chưa cài trình duyệt. Hãy tải trình duyệt ở màn hình Trình duyệt.';
const NOT_LOGGED_IN_ERROR = 'Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập';
const STOPPED_REASON = 'Đã dừng';
const FORCED_CLOSE_ERROR = 'Đã đóng khi đang chờ kết quả — kiểm tra bài trên Facebook';
const FORCED_CLOSE_JOIN_ERROR = 'Đã đóng khi đang chờ kết quả — kiểm tra yêu cầu vào nhóm trên Facebook';
const POST_FAILED_DEFAULT = 'Không đăng được, xem nhật ký';
const UNCERTAIN_SUFFIX = ' — có thể bài đã lên, kiểm tra trước khi đăng lại';

/** Mã lỗi của lỗi ném từ launch(): chưa đăng nhập, bị dừng khi đang mở, còn lại là không mở được profile. */
function launchErrorCode(message: string): string {
    if (message === NOT_LOGGED_IN_ERROR) return 'not_logged_in';
    if (message === STOPPED_REASON) return 'stopped';
    return 'launch_failed';
}
const SCAN_ERROR_MESSAGE = 'Quét nhóm bị lỗi giữa chừng, giữ danh sách cũ';
const SCAN_LIMIT_MESSAGE = 'Danh sách có thể thiếu (chạm trần cuộn)';
const JOINS_URL = 'https://www.facebook.com/groups/joins/';
const STAGGER_MIN_MS = 30000;
const STAGGER_SPREAD_MS = 60000;
const SLEEP_SLICE_MS = 500;

interface PlannedTarget { url: string; name: string; }
interface ProfilePlan {
    profileId: string; name: string; targets: PlannedTarget[]; progress: ProfileProgress; started: boolean;
    sessions: AutomationSession[];
    /** Inside an irreversible step (publish/join click until its result is known): cancel must not close the browser. */
    critical: boolean;
    /** The result being recorded came from a step that was critical; a failure there is real, not a cancel side effect. */
    reachedCritical: boolean;
    /** Có ít nhất một kết quả 'posted': tài khoản chắc chắn còn đăng nhập. */
    posted: boolean;
}
interface ActiveRun { run: FbPosterRun; params: StartParams; plans: ProfilePlan[]; concurrency: number; staggerMs: { min: number; spread: number };
    /** Chỉ có khi bài có biến thể: chỉ số biến thể (0 = A) của cặp (profile, đích), chia một lần cho cả lượt. */
    variantIndex?: (profileId: string, url: string) => number | undefined; }
interface ResultRow { url: string; name: string; outcome: string; error: string; postUrl?: string | null; commentStatus?: string; pendingApproval?: boolean; identity?: string; errorCode?: string; attempts?: number; }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function defaultSleep(ms: number, isStopping: () => boolean): Promise<void> {
    let left = ms;
    while (left > 0 && !isStopping()) {
        const slice = Math.min(SLEEP_SLICE_MS, left);
        await new Promise<void>((resolve) => setTimeout(resolve, slice));
        left -= slice;
    }
}

function normalizedUrl(raw: string): string {
    try { return normalizeTarget(raw).url; } catch { return raw; }
}

/** Runs one job at a time across browser profiles; records each result as it arrives. */
export class FacebookPosterService {
    private readonly store: FacebookPosterStore;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleep: (ms: number, isStopping: () => boolean) => Promise<void>;
    private readonly newId: () => string;
    private readonly tasks: Required<NonNullable<FacebookPosterServiceDeps['tasks']>>;

    private active: ActiveRun | null = null;
    private exclusive = false;
    private stopping = false;
    private forced = false;
    private idle: Promise<void> = Promise.resolve();
    /** First store error seen outside a task; the run ends 'failed' with it (tasks swallow errors thrown by their callbacks). */
    private storeError: string | null = null;

    constructor(private readonly deps: FacebookPosterServiceDeps) {
        this.store = deps.store;
        this.now = deps.now ?? Date.now;
        this.random = deps.random ?? Math.random;
        this.sleep = deps.sleep ?? defaultSleep;
        this.newId = deps.newId ?? randomUUID;
        this.tasks = { postToTargets, scanGroups, searchAndJoinGroups, collectComments, ...deps.tasks };
    }

    start(params: StartParams, scheduleId?: string): { runId: string } {
        if (this.active || this.exclusive) throw new Error(BUSY_ERROR);
        if (params.kind === 'post' && params.campaignId) {
            const campaign = this.store.getCampaign(params.campaignId);
            if (!campaign) throw new Error('Không tìm thấy chiến dịch');
            if (campaign.status === 'archived') throw new Error('Chiến dịch đã lưu trữ');
        }
        const plans = this.plan(params);
        // Đếm trước khi tạo run để lượt mới không tự tính vào độ lệch.
        const variantIndex = this.assignRunVariants(params, plans, scheduleId);
        const run: FbPosterRun = {
            id: this.newId(),
            kind: params.kind,
            mode: params.kind === 'post' ? params.mode : '',
            params: params as unknown as Record<string, unknown>,
            status: 'running',
            error: '',
            startedAt: this.now(),
            finishedAt: null,
            scheduleId: scheduleId ?? null,
            campaignId: params.kind === 'post' ? params.campaignId ?? null : null,
            scheduleName: null,
        };
        this.store.createRun({ id: run.id, kind: run.kind, mode: run.mode, params: run.params, startedAt: run.startedAt, scheduleId: run.scheduleId, campaignId: run.campaignId });
        this.stopping = false;
        this.forced = false;
        this.storeError = null;
        const parallel = params.kind === 'post' || params.kind === 'scan_groups' ? params : null;
        const concurrency = parallel ? Math.max(1, parallel.concurrency) : 1;
        // Profile k starts a random staggerMin..staggerMax after profile k-1, so accounts never light up in the same second.
        const staggerMs = parallel
            ? { min: parallel.staggerMinSec * 1000, spread: Math.max(0, parallel.staggerMaxSec - parallel.staggerMinSec) * 1000 }
            : { min: STAGGER_MIN_MS, spread: STAGGER_SPREAD_MS };
        this.active = { run, params, plans, concurrency, staggerMs, variantIndex };
        this.idle = this.execute(this.active);
        return { runId: run.id };
    }

    /** Giữ khe việc cho việc khác (kiểm tra đăng nhập): từ chối khi đang đăng hoặc đã có người giữ. */
    acquireExclusive(): void {
        if (this.active || this.exclusive) throw new Error(BUSY_ERROR);
        this.exclusive = true;
    }

    releaseExclusive(): void {
        this.exclusive = false;
    }

    isBusy(): boolean {
        return this.active !== null || this.exclusive;
    }

    private observeLogin(profileId: string, state: 'ok' | 'logged_out'): void {
        try { this.deps.onLoginObserved?.(profileId, state); } catch { /* quan sát không được làm hỏng lượt đăng */ }
    }

    cancel(): void {
        if (!this.active) return;
        this.stopping = true;
        // Closing a session rejects the profile's pending browser calls, so the task stops now instead of at its next check.
        for (const plan of this.active.plans) if (!plan.critical) this.closeSessions(plan);
    }

    /** Stops the job and waits for it: graceful first, then closes every browser (critical ones too). True when nothing runs anymore. */
    async stopAndWait(graceMs = 45000, forceMs = 10000): Promise<boolean> {
        if (!this.active) return true;
        this.cancel();
        if (await this.waitIdle(graceMs)) return true;
        this.forceStop();
        return this.waitIdle(forceMs);
    }

    cancelAll(): void {
        this.cancel();
    }

    current(): { run: FbPosterRun; progress: ProgressSnapshot } | null {
        return this.active ? { run: { ...this.active.run }, progress: this.snapshot(this.active) } : null;
    }

    whenIdle(): Promise<void> {
        return this.idle;
    }

    private async waitIdle(ms: number): Promise<boolean> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
        try {
            return await Promise.race([this.idle.then(() => true, () => true), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    private forceStop(): void {
        this.forced = true;
        for (const plan of this.active?.plans ?? []) this.closeSessions(plan);
    }

    /** Fire and forget: close() is idempotent and its failure must not surface. */
    private closeSessions(plan: ProfilePlan): void {
        void Promise.allSettled(plan.sessions.map((session) => session.close()));
    }

    /** Chia biến thể A/B một lần cho cả lượt; undefined khi bài không có biến thể. */
    private assignRunVariants(params: StartParams, plans: ProfilePlan[], scheduleId?: string): ActiveRun['variantIndex'] {
        if (params.kind !== 'post' || !params.variants?.length) return undefined;
        const offset = scheduleId ? this.store.countStartedRuns(scheduleId) : 0;
        const pairs = plans.flatMap((p) => p.targets.map((t) => ({ profileId: p.profileId, url: t.url })));
        const assigned = assignVariants(pairs, params.variants.length + 1, offset);
        return (profileId, url) => assigned.get(variantKey(profileId, url));
    }

    // ─── Planning ────────────────────────────────────────────────────────────

    private plan(params: StartParams): ProfilePlan[] {
        const make = (profileId: string, targets: PlannedTarget[], total: number): ProfilePlan => ({
            profileId,
            name: this.deps.getProfile(profileId)?.name ?? profileId,
            targets,
            progress: { profileId, state: 'waiting', done: 0, total },
            started: false,
            sessions: [],
            critical: false,
            reachedCritical: false,
            posted: false,
        });
        switch (params.kind) {
            case 'post':
                return params.profiles.map(({ profileId, targets }) => {
                    const planned = (params.mode === 'page' ? [FB_HOME] : targets.map(normalizedUrl)).map((url) => ({ url, name: '' }));
                    return make(profileId, planned, planned.length);
                });
            case 'scan_groups':
                return params.profileIds.map((id) => make(id, [{ url: JOINS_URL, name: '' }], 1));
            case 'join':
                // Group rows only appear as the task reports them, so there is no fixed target list.
                return [make(params.profileId, [], params.limit)];
            case 'collect_comments':
                return [make(params.profileId, params.postUrls.map((url) => ({ url, name: '' })), params.postUrls.length)];
        }
    }

    // ─── Run ─────────────────────────────────────────────────────────────────

    private async execute(active: ActiveRun): Promise<void> {
        const { run } = active;
        let fatal: string | null = null;
        try {
            await this.runPool(active.plans, active.concurrency, active.staggerMs, (plan) => this.runProfile(active, plan));
            for (const plan of active.plans) {
                if (plan.started) continue;
                this.skipRemaining(active, plan);
                plan.progress.state = 'cancelled';
                this.emitProgress(active);
            }
        } catch (err) {
            fatal = errorMessage(err);
        }

        let error = this.storeError ?? fatal ?? '';
        let status: 'done' | 'cancelled' | 'failed' = error ? 'failed' : this.stopping ? 'cancelled' : 'done';
        try {
            this.store.finishRun(run.id, status, error, this.now());
        } catch (err) {
            status = 'failed';
            error = errorMessage(err);
        }
        run.status = status;
        run.error = error;
        this.active = null;
        this.emit('facebookPoster:runFinished', { runId: run.id, status });
    }

    private async runPool<T>(items: T[], limit: number, stagger: { min: number; spread: number }, worker: (item: T, index: number) => Promise<void>): Promise<void> {
        let next = 0;
        let lastStart = 0;
        const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
            while (next < items.length && !this.stopping) {
                const index = next++;
                if (index === 0) {
                    lastStart = this.now();
                } else {
                    // Reserve this start slot BEFORE sleeping so runners waiting at the same time
                    // are spaced from each other, not all from the same previous start.
                    const gap = stagger.min + this.random() * stagger.spread;
                    const startAt = Math.max(this.now(), lastStart + gap);
                    lastStart = startAt;
                    const wait = startAt - this.now();
                    if (wait > 0) await this.sleep(wait, () => this.stopping);
                    if (this.stopping) break;
                }
                await worker(items[index], index);
            }
        });
        await Promise.all(runners);
    }

    private async runProfile(active: ActiveRun, plan: ProfilePlan): Promise<void> {
        const { run, params } = active;
        const { profileId } = plan;
        plan.started = true;
        plan.progress.state = 'running';
        this.emitProgress(active);

        let loginChecked = false;
        let launchError: unknown = null;
        // Called once by most tasks and twice by join; every call opens a new session.
        const launch = async (): Promise<LaunchedPage> => {
            try {
                // A profile deleted after a schedule was saved fails only its own targets.
                if (!this.deps.getProfile(profileId)) throw new Error('Không tìm thấy profile');
                const session = await this.deps.openForAutomation(profileId);
                plan.sessions.push(session);
                if (this.stopping) {
                    // Cancel came while the browser was still opening: nothing was started, so close it and stop.
                    await session.close().catch(() => undefined);
                    throw new Error(STOPPED_REASON);
                }
                if (!loginChecked) {
                    loginChecked = true;
                    if (!(await isLoggedIn(session.context))) {
                        await session.close().catch(() => undefined);
                        this.observeLogin(profileId, 'logged_out');
                        throw new Error(NOT_LOGGED_IN_ERROR);
                    }
                }
                const ctx = session.context;
                return { ctx, page: ctx.pages()[0] ?? await ctx.newPage() };
            } catch (err) {
                launchError = err;
                throw err;
            }
        };
        const taskDeps: TaskDeps = {
            launch,
            getIsStopping: () => this.stopping,
            sendLog: (message: string, level: LogLevel) => this.emit('facebookPoster:log', { runId: run.id, profileId, level, message, at: this.now() }),
            updateProgress: () => undefined,
            enterCritical: () => { plan.critical = true; plan.reachedCritical = true; },
            leaveCritical: () => { plan.critical = false; },
            clearReachedCritical: () => { plan.reachedCritical = false; },
        };

        let failed = false;
        try {
            await this.runTask(active, plan, taskDeps);
            if (params.kind !== 'join') this.skipRemaining(active, plan);
        } catch (err) {
            failed = true;
            const wasCritical = plan.critical || plan.reachedCritical;
            const message = errorMessage(err);
            if (params.kind === 'join') {
                this.record(active, plan, { url: '', name: '', outcome: 'failed', error: message, errorCode: err === launchError ? launchErrorCode(message) : '' });
            } else {
                // Open/login errors hit every target alike; a mid-run error (window closed) fails only the one in progress.
                if (err !== launchError && params.kind === 'post' && wasCritical) {
                    // Closed after the Post click: the post may be live, so it is never a plain failure.
                    this.failRemaining(active, plan, `${message}${UNCERTAIN_SUFFIX}`, false, 'uncertain_after_submit');
                } else {
                    this.failRemaining(active, plan, message, err === launchError, err === launchError ? launchErrorCode(message) : 'unknown');
                }
            }
        } finally {
            await Promise.allSettled(plan.sessions.map((session) => session.close()));
        }
        if (plan.posted) this.observeLogin(profileId, 'ok');
        // A failure caused by our own cancel is not a profile failure (a forced close still is).
        plan.progress.state = failed && !(this.stopping && !this.forced) ? 'failed' : this.stopping ? 'cancelled' : 'done';
        // The join total was only a cap (`limit`); settle it to what was actually reported.
        if (params.kind === 'join') plan.progress.total = plan.progress.done;
        this.emitProgress(active);
    }

    private async runTask(active: ActiveRun, plan: ProfilePlan, deps: TaskDeps): Promise<void> {
        const { params } = active;
        const { profileId } = plan;
        switch (params.kind) {
            case 'post':
                await this.tasks.postToTargets(
                    {
                        text: params.text,
                        ...(active.variantIndex ? { textFor: (url: string) => variantText(params, active.variantIndex!(profileId, url) ?? 0) } : {}),
                        mediaPaths: params.mediaPaths,
                        comment: params.comment,
                        commentDelayMin: params.commentDelayMin ?? 0,
                        targets: plan.targets.map((t) => t.url),
                        minDelay: params.minDelaySec,
                        maxDelay: params.maxDelaySec,
                    },
                    {
                        ...deps,
                        onResult: (r) => this.record(active, plan, {
                            url: r.url,
                            name: '',
                            outcome: r.ok ? 'posted' : 'failed',
                            error: r.error ?? (r.ok ? '' : POST_FAILED_DEFAULT),
                            errorCode: r.errorCode || (r.ok ? '' : 'unknown'),
                            attempts: r.attempts,
                            postUrl: r.postUrl,
                            commentStatus: r.commentStatus,
                            pendingApproval: r.pendingApproval,
                            identity: r.identity,
                        }),
                    },
                );
                return;
            case 'scan_groups': {
                const { groups, scrollError, hitScrollLimit } = await this.tasks.scanGroups(deps);
                if (scrollError) {
                    // A truncated list must not overwrite the saved one: fail the profile instead.
                    deps.sendLog(SCAN_ERROR_MESSAGE, 'warning');
                    throw new Error(SCAN_ERROR_MESSAGE);
                }
                let saveError = '';
                try {
                    this.store.replaceGroups(profileId, groups.map((g) => ({ url: g.url, name: g.name })), this.now());
                } catch (err) {
                    this.rememberStoreError(err);
                    saveError = errorMessage(err);
                }
                this.record(active, plan, saveError
                    ? { url: JOINS_URL, name: '', outcome: 'failed', error: saveError }
                    : { url: JOINS_URL, name: `${groups.length} nhóm`, outcome: 'done', error: hitScrollLimit ? SCAN_LIMIT_MESSAGE : '' });
                if (hitScrollLimit && !saveError) deps.sendLog(SCAN_LIMIT_MESSAGE, 'warning');
                return;
            }
            case 'join':
                await this.tasks.searchAndJoinGroups(
                    { keywords: params.keywords, limit: params.limit, minDelay: params.minDelaySec, maxDelay: params.maxDelaySec },
                    { ...deps, onResult: (r) => this.record(active, plan, { url: r.url, name: r.name, outcome: r.outcome, error: '' }) },
                );
                return;
            case 'collect_comments': {
                const { results } = await this.tasks.collectComments(
                    { posts: params.postUrls.map((postUrl) => ({ postUrl })), minDelay: 10, maxDelay: 20 },
                    {
                        ...deps,
                        loadKeys: async () => this.store.loadCommentKeys(),
                        saveComments: async (rows) => {
                            try {
                                return this.store.saveComments(profileId, rows, this.now());
                            } catch (err) {
                                this.rememberStoreError(err);
                                throw err;
                            }
                        },
                    },
                );
                // Only the last row can be the one a cancel cut off; earlier rows finished normally.
                results.forEach((r, i) => this.record(active, plan, { url: r.url, name: '', outcome: r.outcome, error: r.error ?? '' }, { stopAware: i === results.length - 1 }));
                return;
            }
        }
    }

    // ─── Recording ───────────────────────────────────────────────────────────

    /** Writes one result immediately and bumps the profile's counter. Never throws: a store error is remembered instead. */
    private record(active: ActiveRun, plan: ProfilePlan, original: ResultRow, { stopAware = true } = {}): void {
        const row = stopAware ? this.stopAwareRow(active, plan, original) : original;
        try {
            const resultId = this.store.addResult({
                runId: active.run.id,
                profileId: plan.profileId,
                profileName: plan.name,
                targetUrl: row.url,
                targetName: row.name,
                outcome: row.outcome,
                error: row.error,
                // Only posting records a code and attempts; other kinds keep the defaults.
                errorCode: active.params.kind === 'post' ? row.errorCode ?? '' : '',
                attempts: active.params.kind === 'post' ? row.attempts ?? 1 : 1,
                postUrl: row.postUrl ?? null,
                commentStatus: row.commentStatus ?? 'not_requested',
                identity: row.identity ?? '',
                variant: VARIANT_LABELS[active.variantIndex?.(plan.profileId, row.url) ?? -1] ?? '',
                createdAt: this.now(),
            });
            this.trackPostedResult(active, plan, row, resultId);
        } catch (err) {
            this.rememberStoreError(err);
        }
        if (row.outcome === 'posted') plan.posted = true;
        plan.reachedCritical = false;
        plan.progress.done += 1;
        this.emitProgress(active);
    }

    /** Tạo dòng theo dõi cho bài nhóm đã đăng. Mọi lỗi chỉ ghi log, không ảnh hưởng kết quả đăng. */
    private trackPostedResult(active: ActiveRun, plan: ProfilePlan, row: ResultRow, resultId: number): void {
        const params = active.params;
        if (params.kind !== 'post' || params.mode !== 'group' || row.outcome !== 'posted') return;
        try {
            const postedAt = this.now();
            const index = active.variantIndex?.(plan.profileId, row.url) ?? 0;
            const variantLabel = VARIANT_LABELS[active.variantIndex?.(plan.profileId, row.url) ?? -1] ?? '';
            const postUrl = row.postUrl ?? null;
            const linkStatus: LinkStatus = postUrl ? 'known'
                : row.pendingApproval || row.commentStatus === 'pending_approval' ? 'pending_approval' : 'missing';
            const tracking = {
                resultId, runId: active.run.id, scheduleId: active.run.scheduleId, campaignId: active.run.campaignId, variant: variantLabel, profileId: plan.profileId,
                groupUrl: row.url,
                groupId: /\/groups\/(\d+)/.exec(row.url)?.[1] ?? '',
                postId: postUrl ? /\/(?:posts|permalink)\/(\d+)|[?&]story_fbid=(\d+)/.exec(postUrl)?.slice(1).find(Boolean) ?? '' : '',
                postUrl, postedAt, textHead: normalizeHead(variantText(params, index)), linkStatus,
                removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null as number | null, statsDone: [] as string[],
            };
            const config = this.deps.readTrackingConfig?.() ?? DEFAULT_POST_TRACKING_CONFIG;
            tracking.nextCheckAt = computeNextCheckAt(tracking, config, postedAt);
            this.store.createTracking(tracking);
        } catch (err) {
            this.emit('facebookPoster:log', { runId: active.run.id, profileId: plan.profileId, level: 'warning', message: `Không tạo được dòng theo dõi bài: ${errorMessage(err)}`, at: this.now() });
        }
    }

    /** A failure caused by our own cancel is a stop, not an error; one after a critical step stays a failure (forced close gets its own text). */
    private stopAwareRow(active: ActiveRun, plan: ProfilePlan, row: ResultRow): ResultRow {
        if (row.outcome !== 'failed' || !this.stopping) return row;
        if (!plan.critical && !plan.reachedCritical) return { ...row, outcome: 'skipped', error: STOPPED_REASON, errorCode: 'stopped' };
        return this.forced ? { ...row, error: active.params.kind === 'join' ? FORCED_CLOSE_JOIN_ERROR : FORCED_CLOSE_ERROR, errorCode: 'uncertain_after_submit' } : row;
    }

    /** Targets with no result yet: the first one carries the error, the rest were never reached (or all fail when the error hit every target alike). */
    private failRemaining(active: ActiveRun, plan: ProfilePlan, message: string, allFailed: boolean, errorCode: string): void {
        plan.targets.slice(plan.progress.done).forEach((target, i) => {
            const failedOne = allFailed || i === 0;
            this.record(active, plan, { url: target.url, name: target.name, outcome: failedOne ? 'failed' : 'skipped', error: failedOne ? message : STOPPED_REASON, errorCode: failedOne ? errorCode : 'stopped' });
        });
    }

    private skipRemaining(active: ActiveRun, plan: ProfilePlan): void {
        for (const target of plan.targets.slice(plan.progress.done)) {
            this.record(active, plan, { url: target.url, name: target.name, outcome: 'skipped', error: STOPPED_REASON, errorCode: 'stopped' });
        }
    }

    private rememberStoreError(err: unknown): void {
        this.storeError ??= errorMessage(err);
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    private snapshot(active: ActiveRun): ProgressSnapshot {
        const profiles = active.plans.map((p) => ({ ...p.progress }));
        return {
            runId: active.run.id,
            done: profiles.reduce((sum, p) => sum + p.done, 0),
            total: profiles.reduce((sum, p) => sum + p.total, 0),
            profiles,
        };
    }

    private emitProgress(active: ActiveRun): void {
        this.emit('facebookPoster:progress', this.snapshot(active));
    }

    /** A broken listener must not break the job. */
    private emit(channel: Parameters<FacebookPosterServiceDeps['emit']>[0], data: unknown): void {
        try {
            this.deps.emit(channel, data);
        } catch {
            // Renderer gone; results are already in the store.
        }
    }
}
