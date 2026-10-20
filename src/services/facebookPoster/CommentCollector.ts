import { randomUUID } from 'crypto';
import type { PostTrackingRow } from '../../models/facebookPoster';
import { collectComments, type CollectedComment, type LoginProblem } from './collectComments';
import { BUSY_ERROR } from './FacebookPosterService';
import type { FacebookPosterStore } from './FacebookPosterStore';
import type { LeadDetector } from './LeadDetector';
import { computeNextCommentAt, overdueCommentLabels, type LeadConfig } from './leadRules';
import type { LaunchedPage } from './types';

// Tự thu bình luận của bài đã đăng theo mốc, bằng chính profile đã đăng. Chỉ đọc Facebook.
// Không tạo dòng Lịch sử (fb_poster_runs / results). Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.1.

export const MAX_COMMENT_POSTS = 10;
const POST_DELAY_MIN_SEC = 10;
const POST_DELAY_MAX_SEC = 20;

export interface CommentCollectError { postUrl: string; profileId: string; error: string }
export interface CommentCollectResult {
    jobId: string;
    auto: boolean;
    finishedAt: number;
    cancelled: boolean;
    posts: number;
    collected: number;
    leads: number;
    errors: CommentCollectError[];
}
export interface CommentCollectStatus {
    running: boolean;
    jobId: string | null;
    progress: { done: number; total: number };
    last: CommentCollectResult | null;
}

export interface CommentCollectorDeps {
    store: Pick<FacebookPosterStore,
        'trackingByPostUrls' | 'listDueCommentPosts' | 'loadCommentKeys' | 'insertCommentsReturningNew' | 'updateCommentSchedule'>;
    /** Mở phiên tự động của profile; lỗi có `code` 'logged_out' | 'checkpoint' (như ResearchError) thì được ghi nhận đăng nhập. */
    launchFor(profileId: string): Promise<LaunchedPage & { close(): Promise<void> }>;
    collect: typeof collectComments;
    slot: { acquire(): void; release(): void };
    observeLogin(profileId: string, state: LoginProblem): void;
    detector: Pick<LeadDetector, 'process'>;
    readConfig: () => LeadConfig;
    emit(type: string, payload: unknown): void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    newId?: () => string;
}

export interface CommentCollectParams { postUrls?: string[]; auto?: boolean }

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function loginProblemOfError(e: unknown): LoginProblem | null {
    const code = (e as { code?: unknown } | null)?.code;
    return code === 'logged_out' || code === 'checkpoint' ? code : null;
}

export class CommentCollector {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private cancelled = false;
    private wake: (() => void) | null = null;
    private jobId: string | null = null;
    private progress = { done: 0, total: 0 };
    private last: CommentCollectResult | null = null;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleepFn: (ms: number) => Promise<void>;

    constructor(private readonly deps: CommentCollectorDeps) {
        this.now = deps.now ?? Date.now;
        this.random = deps.random ?? Math.random;
        this.sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /** Đồng bộ đến khi giành được khe (ném BUSY nếu không được), sau đó chạy nền. */
    collect(params: CommentCollectParams = {}): { jobId: string; posts: number } {
        if (this.active) throw new Error(BUSY_ERROR);
        if (params.postUrls !== undefined && (!Array.isArray(params.postUrls) || params.postUrls.some((u) => typeof u !== 'string'))) {
            throw new Error('postUrls phải là danh sách link bài');
        }
        this.deps.slot.acquire();
        let jobId: string;
        let rows: PostTrackingRow[];
        try {
            jobId = (this.deps.newId ?? randomUUID)();
            rows = this.selectRows(params);
        } catch (e) {
            this.deps.slot.release();
            throw e;
        }
        this.active = true;
        this.cancelled = false;
        this.jobId = jobId;
        this.progress = { done: 0, total: rows.length };
        this.running = this.run(jobId, !!params.auto, rows).catch(() => undefined);
        return { jobId, posts: rows.length };
    }

    status(): CommentCollectStatus {
        return { running: this.active, jobId: this.active ? this.jobId : null, progress: { ...this.progress }, last: this.last };
    }

    isRunning(): boolean { return this.active; }

    cancel(): boolean {
        if (!this.active) return false;
        this.cancelled = true;
        this.wake?.();
        return true;
    }

    stop(): void { this.cancel(); }
    whenIdle(): Promise<void> { return this.running; }

    private selectRows(params: CommentCollectParams): PostTrackingRow[] {
        if (!params.postUrls) return this.deps.store.listDueCommentPosts(this.now(), MAX_COMMENT_POSTS);
        const byUrl = this.deps.store.trackingByPostUrls(params.postUrls);
        return [...new Set(params.postUrls)].flatMap((u) => byUrl.get(u) ?? []).slice(0, MAX_COMMENT_POSTS);
    }

    private emit(type: string, payload: unknown): void {
        try { this.deps.emit(type, payload); } catch { /* người nhận lỗi không được chặn lượt thu */ }
    }

    private async pause(minSec: number, maxSec: number): Promise<void> {
        if (this.cancelled) return;
        const ms = Math.round((minSec + this.random() * (maxSec - minSec)) * 1000);
        const woken = new Promise<void>((resolve) => { this.wake = resolve; });
        await Promise.race([this.sleepFn(ms), woken]);
        this.wake = null;
    }

    private async run(jobId: string, auto: boolean, rows: PostTrackingRow[]): Promise<void> {
        const totals = { collected: 0, leads: 0 };
        const errors: CommentCollectError[] = [];
        const byProfile = new Map<string, PostTrackingRow[]>();
        for (const row of rows) byProfile.set(row.profileId, [...(byProfile.get(row.profileId) ?? []), row]);
        // Nhường một nhịp để `collectFinished` luôn phát sau khi `collect()` đã trả về (kể cả khi không có bài nào).
        await Promise.resolve();
        try {
            let index = 0;
            for (const [profileId, profileRows] of byProfile) {
                if (this.cancelled) break;
                if (index++ > 0) await this.pause(POST_DELAY_MIN_SEC, POST_DELAY_MAX_SEC);
                if (this.cancelled) break;
                await this.collectProfile(profileId, profileRows, auto, totals, errors);
                this.progress = { done: this.progress.done + profileRows.length, total: rows.length };
                this.emit('comments.collectProgress', { jobId, ...this.progress });
            }
        } catch (e) {
            errors.push({ postUrl: '', profileId: '', error: errorText(e) });
        } finally {
            const cancelled = this.cancelled;
            this.last = { jobId, auto, finishedAt: this.now(), cancelled, posts: rows.length, ...totals, errors };
            this.active = false;
            this.jobId = null;
            this.deps.slot.release();
            this.emit('comments.collectFinished', { jobId, auto, posts: rows.length, ...totals, errors: errors.length });
        }
    }

    /** Một lần mở trình duyệt cho mọi bài của profile; hết phiên / checkpoint thì bỏ các bài còn lại. */
    private async collectProfile(
        profileId: string, rows: PostTrackingRow[], auto: boolean,
        totals: { collected: number; leads: number }, errors: CommentCollectError[],
    ): Promise<void> {
        let opened: (LaunchedPage & { close(): Promise<void> }) | null = null;
        let failure: unknown = null;
        let result: Awaited<ReturnType<typeof collectComments>> | null = null;
        try {
            result = await this.deps.collect(
                { posts: rows.map((r) => ({ postUrl: r.postUrl as string })), minDelay: POST_DELAY_MIN_SEC, maxDelay: POST_DELAY_MAX_SEC, stopOnLoginProblem: true },
                {
                    launch: async () => {
                        opened = await this.deps.launchFor(profileId);
                        return { ctx: opened.ctx, page: opened.page };
                    },
                    getIsStopping: () => this.cancelled,
                    sendLog: () => undefined,
                    updateProgress: () => undefined,
                    loadKeys: async () => this.deps.store.loadCommentKeys(),
                    saveComments: (fresh) => this.saveComments(profileId, fresh, auto, totals),
                },
            );
        } catch (e) {
            failure = e;
        } finally {
            const session = opened as (LaunchedPage & { close(): Promise<void> }) | null;
            await session?.close().catch(() => undefined);
        }

        const problem = result?.loginProblem ?? loginProblemOfError(failure);
        if (problem) {
            try { this.deps.observeLogin(profileId, problem); } catch { /* quan sát không được làm hỏng lượt thu */ }
        }
        const outcomes = new Map((result?.results ?? []).map((r) => [r.url, r]));
        for (const row of rows) {
            const url = row.postUrl as string;
            const own = outcomes.get(url);
            if (this.cancelled && !own && !problem) continue; // bị huỷ trước khi tới bài này: giữ nguyên mốc
            const error = own ? (own.outcome === 'failed' ? own.error ?? 'error' : null)
                : failure ? errorText(failure) : problem ? 'Phiên Facebook đã hết hoặc cần xác minh' : 'Không quét được bài';
            if (error !== null) errors.push({ postUrl: url, profileId, error });
            this.settle(row);
        }
    }

    private async saveComments(
        profileId: string, fresh: CollectedComment[], auto: boolean, totals: { collected: number; leads: number },
    ): Promise<number> {
        const created = this.deps.store.insertCommentsReturningNew(profileId, fresh, this.now());
        totals.collected += created.length;
        if (created.length > 0) {
            try {
                totals.leads += (await this.deps.detector.process(created, { auto })).length;
            } catch { /* lọc khách lỗi không được làm hỏng lượt thu */ }
        }
        return created.length;
    }

    /** Bài đã xử lý (thành công hay lỗi): mọi mốc đã quá hạn coi như xong, rồi sang mốc tương lai hoặc NULL (không lặp lại). */
    private settle(row: PostTrackingRow): void {
        try {
            const config = this.deps.readConfig();
            const now = this.now();
            const done = [...row.commentsDone, ...overdueCommentLabels(row.postedAt, row.commentsDone, config, now)];
            this.deps.store.updateCommentSchedule(row.resultId, {
                commentsDone: done, nextCommentAt: computeNextCommentAt(row.postedAt, done, config, now),
            });
        } catch { /* lên lịch lại không được làm hỏng lượt thu */ }
    }
}
