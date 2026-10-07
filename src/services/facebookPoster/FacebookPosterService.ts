import { randomUUID } from 'crypto';
import type { AutomationSession } from '../browser/BrowserProfileService';
import type { FbPosterMode, FbPosterRun } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import type { LaunchedPage, LogLevel, TaskDeps } from './types';
import { collectComments } from './collectComments';
import { searchAndJoinGroups } from './joinGroups';
import { isLoggedIn, FB_HOME } from './loginState';
import { postToTargets } from './postToTargets';
import { scanGroups } from './scanGroups';
import { normalizeTarget } from './targets';

export interface ProfileInfo { id: string; name: string; }

export type StartParams =
    | { kind: 'post'; mode: FbPosterMode; text: string; mediaPaths: string[]; comment: string | null; profiles: { profileId: string; targets: string[] }[]; minDelaySec: number; maxDelaySec: number; concurrency: number; staggerMinSec: number; staggerMaxSec: number }
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
    tasks?: Partial<{ postToTargets: typeof postToTargets; scanGroups: typeof scanGroups; searchAndJoinGroups: typeof searchAndJoinGroups; collectComments: typeof collectComments }>;
}

const BUSY_ERROR = 'Đang có việc chạy';
const NOT_LOGGED_IN_ERROR = 'Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập';
const STOPPED_REASON = 'Đã dừng';
const POST_FAILED_DEFAULT = 'Không đăng được, xem nhật ký';
const SCAN_ERROR_MESSAGE = 'Quét nhóm bị lỗi giữa chừng, giữ danh sách cũ';
const SCAN_LIMIT_MESSAGE = 'Danh sách có thể thiếu (chạm trần cuộn)';
const JOINS_URL = 'https://www.facebook.com/groups/joins/';
const STAGGER_MIN_MS = 30000;
const STAGGER_SPREAD_MS = 60000;
const SLEEP_SLICE_MS = 500;

interface PlannedTarget { url: string; name: string; }
interface ProfilePlan { profileId: string; name: string; targets: PlannedTarget[]; progress: ProfileProgress; started: boolean; }
interface ActiveRun { run: FbPosterRun; params: StartParams; plans: ProfilePlan[]; concurrency: number; staggerMs: { min: number; spread: number }; }
interface ResultRow { url: string; name: string; outcome: string; error: string; postUrl?: string | null; commentStatus?: string; identity?: string; }

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
    private stopping = false;
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
        if (this.active) throw new Error(BUSY_ERROR);
        const plans = this.plan(params);
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
        };
        this.store.createRun({ id: run.id, kind: run.kind, mode: run.mode, params: run.params, startedAt: run.startedAt, scheduleId: run.scheduleId });
        this.stopping = false;
        this.storeError = null;
        const parallel = params.kind === 'post' || params.kind === 'scan_groups' ? params : null;
        const concurrency = parallel ? Math.max(1, parallel.concurrency) : 1;
        // Profile k starts a random staggerMin..staggerMax after profile k-1, so accounts never light up in the same second.
        const staggerMs = parallel
            ? { min: parallel.staggerMinSec * 1000, spread: Math.max(0, parallel.staggerMaxSec - parallel.staggerMinSec) * 1000 }
            : { min: STAGGER_MIN_MS, spread: STAGGER_SPREAD_MS };
        this.active = { run, params, plans, concurrency, staggerMs };
        this.idle = this.execute(this.active);
        return { runId: run.id };
    }

    cancel(): void {
        if (this.active) this.stopping = true;
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

    // ─── Planning ────────────────────────────────────────────────────────────

    private plan(params: StartParams): ProfilePlan[] {
        const make = (profileId: string, targets: PlannedTarget[], total: number): ProfilePlan => ({
            profileId,
            name: this.deps.getProfile(profileId)?.name ?? profileId,
            targets,
            progress: { profileId, state: 'waiting', done: 0, total },
            started: false,
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

        const sessions: AutomationSession[] = [];
        let loginChecked = false;
        let launchError: unknown = null;
        // Called once by most tasks and twice by join; every call opens a new session.
        const launch = async (): Promise<LaunchedPage> => {
            try {
                const session = await this.deps.openForAutomation(profileId);
                sessions.push(session);
                if (!loginChecked) {
                    loginChecked = true;
                    if (!(await isLoggedIn(session.context))) {
                        await session.close().catch(() => undefined);
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
        };

        let failed = false;
        try {
            await this.runTask(active, plan, taskDeps);
            if (params.kind !== 'join') this.skipRemaining(active, plan);
        } catch (err) {
            failed = true;
            const message = errorMessage(err);
            if (params.kind === 'join') {
                this.record(active, plan, { url: '', name: '', outcome: 'failed', error: message });
            } else {
                // Open/login errors hit every target alike; a mid-run error (window closed) fails only the one in progress.
                this.failRemaining(active, plan, message, err === launchError);
            }
        } finally {
            await Promise.allSettled(sessions.map((session) => session.close()));
        }
        plan.progress.state = failed ? 'failed' : this.stopping ? 'cancelled' : 'done';
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
                        mediaPaths: params.mediaPaths,
                        comment: params.comment,
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
                            postUrl: r.postUrl,
                            commentStatus: r.commentStatus,
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
                for (const r of results) this.record(active, plan, { url: r.url, name: '', outcome: r.outcome, error: r.error ?? '' });
                return;
            }
        }
    }

    // ─── Recording ───────────────────────────────────────────────────────────

    /** Writes one result immediately and bumps the profile's counter. Never throws: a store error is remembered instead. */
    private record(active: ActiveRun, plan: ProfilePlan, row: ResultRow): void {
        try {
            this.store.addResult({
                runId: active.run.id,
                profileId: plan.profileId,
                profileName: plan.name,
                targetUrl: row.url,
                targetName: row.name,
                outcome: row.outcome,
                error: row.error,
                postUrl: row.postUrl ?? null,
                commentStatus: row.commentStatus ?? 'not_requested',
                identity: row.identity ?? '',
                createdAt: this.now(),
            });
        } catch (err) {
            this.rememberStoreError(err);
        }
        plan.progress.done += 1;
        this.emitProgress(active);
    }

    /** Targets with no result yet: the first one carries the error, the rest were never reached (or all fail when the error hit every target alike). */
    private failRemaining(active: ActiveRun, plan: ProfilePlan, message: string, allFailed: boolean): void {
        plan.targets.slice(plan.progress.done).forEach((target, i) => {
            const failedOne = allFailed || i === 0;
            this.record(active, plan, { url: target.url, name: target.name, outcome: failedOne ? 'failed' : 'skipped', error: failedOne ? message : STOPPED_REASON });
        });
    }

    private skipRemaining(active: ActiveRun, plan: ProfilePlan): void {
        for (const target of plan.targets.slice(plan.progress.done)) {
            this.record(active, plan, { url: target.url, name: target.name, outcome: 'skipped', error: STOPPED_REASON });
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
