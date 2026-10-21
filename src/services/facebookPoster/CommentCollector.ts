import { randomUUID } from 'crypto';
import type { FbPosterComment, FbPosterLead, PostTrackingRow } from '../../models/facebookPoster';
import { collectComments, type CollectedComment, type LoginProblem } from './collectComments';
import { PROFILE_OPEN_PREFIX } from './loginCheck';
import { BUSY_ERROR } from './FacebookPosterService';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { buildLeadsFoundPayload, type LeadAiState, type LeadDetector } from './LeadDetector';
import { computeNextCommentAt, overdueCommentLabels, type LeadConfig } from './leadRules';
import type { LaunchedPage, LogLevel } from './types';

// Tự thu bình luận của bài đã đăng theo mốc, bằng chính profile đã đăng. Chỉ đọc Facebook.
// Không tạo dòng Lịch sử (fb_poster_runs / results). Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.1.

export const MAX_COMMENT_POSTS = 10;
const POST_DELAY_MIN_SEC = 10;
const POST_DELAY_MAX_SEC = 20;
/** Sau khi ghi kho lỗi, không tự thu lại trong khoảng này (tránh mở lại cùng các bài mỗi chu kỳ khi kho hỏng). */
export const STORE_FAILURE_BACKOFF_MS = 60 * 60_000;
/** Profile đang mở tay / bởi Nghiên cứu: thử lại sau một chu kỳ tự thu (15 phút). */
export const BUSY_PROFILE_RETRY_MS = 15 * 60_000;

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
        'trackingByPostUrls' | 'listDueCommentPosts' | 'loadCommentKeys' | 'insertCommentsReturningNew' | 'updateCommentSchedule' | 'listLoginStates'>;
    /** Mở phiên tự động của profile; lỗi có `code` 'logged_out' | 'checkpoint' (như ResearchError) thì được ghi nhận đăng nhập. */
    launchFor(profileId: string): Promise<LaunchedPage & { close(): Promise<void> }>;
    collect: typeof collectComments;
    slot: { acquire(): void; release(): void };
    observeLogin(profileId: string, state: LoginProblem): void;
    detector: Pick<LeadDetector, 'process'>;
    readConfig: () => LeadConfig;
    emit(type: string, payload: unknown): void;
    /** Nhật ký của lượt thu (lỗi ghi kho, bài không quét được...). */
    log?(message: string, level: LogLevel): void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    newId?: () => string;
}

export interface CommentCollectParams { postUrls?: string[]; auto?: boolean }

interface RunTotals { collected: number; leads: number; found: FbPosterLead[]; aiState: LeadAiState }

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
    private aborted = false;
    private abortError: string | null = null;
    private blockedUntilMs = 0;
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
        this.aborted = false;
        this.abortError = null;
        this.jobId = jobId;
        this.progress = { done: 0, total: rows.length };
        this.running = this.run(jobId, !!params.auto, rows).catch(() => undefined);
        return { jobId, posts: rows.length };
    }

    status(): CommentCollectStatus {
        return { running: this.active, jobId: this.active ? this.jobId : null, progress: { ...this.progress }, last: this.last };
    }

    isRunning(): boolean { return this.active; }

    /** Mốc (ms) đến khi bộ lập lịch không được tự thu nữa vì lần ghi kho gần nhất bị lỗi; 0 = không chặn. */
    get blockedUntil(): number { return this.blockedUntilMs; }

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
        const totals = { collected: 0, leads: 0, found: [] as FbPosterLead[], aiState: { failed: false } as LeadAiState };
        const errors: CommentCollectError[] = [];
        const byProfile = new Map<string, PostTrackingRow[]>();
        for (const row of rows) byProfile.set(row.profileId, [...(byProfile.get(row.profileId) ?? []), row]);
        let loginStates = new Map<string, string>();
        if (auto) {
            try { loginStates = new Map(this.deps.store.listLoginStates().map((l) => [l.profileId, l.state])); } catch { /* không đọc được thì cứ thu */ }
        }
        // Nhường một nhịp để `collectFinished` luôn phát sau khi `collect()` đã trả về (kể cả khi không có bài nào).
        await Promise.resolve();
        try {
            let index = 0;
            for (const [profileId, profileRows] of byProfile) {
                if (this.cancelled || this.aborted) break;
                if (index++ > 0) await this.pause(POST_DELAY_MIN_SEC, POST_DELAY_MAX_SEC);
                if (this.cancelled || this.aborted) break;
                await this.collectProfile(profileId, profileRows, auto, totals, errors, loginStates.get(profileId));
                this.progress = { done: this.progress.done + profileRows.length, total: rows.length };
                this.emit('comments.collectProgress', { jobId, ...this.progress });
            }
        } catch (e) {
            errors.push({ postUrl: '', profileId: '', error: errorText(e) });
        } finally {
            if (this.abortError) errors.push({ postUrl: '', profileId: '', error: this.abortError });
            const cancelled = this.cancelled;
            const summary = { collected: totals.collected, leads: totals.leads };
            this.last = { jobId, auto, finishedAt: this.now(), cancelled, posts: rows.length, ...summary, errors };
            this.active = false;
            this.jobId = null;
            this.deps.slot.release();
            // Một sự kiện khách mới cho cả lượt (không phải mỗi bài).
            if (totals.found.length > 0) this.emit('leads.found', buildLeadsFoundPayload(totals.found, auto));
            this.emit('comments.collectFinished', { jobId, auto, cancelled, posts: rows.length, ...summary, errors: errors.length });
        }
    }

    /** Một lần mở trình duyệt cho mọi bài của profile; hết phiên / checkpoint thì bỏ các bài còn lại. */
    private async collectProfile(
        profileId: string, rows: PostTrackingRow[], auto: boolean,
        totals: RunTotals, errors: CommentCollectError[], knownState?: string,
    ): Promise<void> {
        if (auto && (knownState === 'logged_out' || knownState === 'checkpoint')) {
            // Đã biết phiên hỏng: không mở trình duyệt; dời các bài sang mốc kế tiếp như khi gặp lỗi đăng nhập.
            for (const row of rows) {
                errors.push({ postUrl: row.postUrl as string, profileId, error: 'Phiên Facebook đã hết hoặc cần xác minh' });
                if (!this.settle(row)) break;
            }
            return;
        }
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
                    getIsStopping: () => this.cancelled || this.aborted,
                    sendLog: (message, level) => this.log(message, level),
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

        if (failure && errorText(failure).startsWith(PROFILE_OPEN_PREFIX)) {
            // Profile đang được mở thủ công / bởi Nghiên cứu: không mở Facebook nên chưa tiêu mốc, lần sau thử lại.
            const error = errorText(failure);
            this.log(`Bỏ qua lượt thu của profile ${profileId}: ${error}`, 'warning');
            for (const row of rows) {
                errors.push({ postUrl: row.postUrl as string, profileId, error });
                // Dời sang chu kỳ sau (không tiêu mốc) để các bài này không chiếm chỗ của profile khác trong hàng đợi.
                if (auto) {
                    try {
                        this.deps.store.updateCommentSchedule(row.resultId, { commentsDone: row.commentsDone, nextCommentAt: this.now() + BUSY_PROFILE_RETRY_MS });
                    } catch (e) {
                        this.abortForStoreFailure(`Không lưu được lịch thu bình luận: ${errorText(e)}`);
                        break;
                    }
                }
            }
            return;
        }
        const problem = result?.loginProblem ?? loginProblemOfError(failure);
        if (problem) {
            try { this.deps.observeLogin(profileId, problem); } catch { /* quan sát không được làm hỏng lượt thu */ }
        }
        const outcomes = new Map((result?.results ?? []).map((r) => [r.url, r]));
        for (const row of rows) {
            const url = row.postUrl as string;
            const own = outcomes.get(url);
            if ((this.cancelled || this.aborted) && !own && !problem) continue; // bị huỷ trước khi tới bài này: giữ nguyên mốc
            const error = own ? (own.outcome === 'failed' ? own.error ?? 'error' : null)
                : failure ? errorText(failure) : problem ? 'Phiên Facebook đã hết hoặc cần xác minh' : 'Không quét được bài';
            if (error !== null) errors.push({ postUrl: url, profileId, error });
            if (this.aborted) break; // kho đang lỗi: để nguyên mốc, bộ lập lịch sẽ nghỉ
            if (!this.settle(row)) break;
        }
    }

    private async saveComments(
        profileId: string, fresh: CollectedComment[], auto: boolean, totals: RunTotals,
    ): Promise<number> {
        let created: FbPosterComment[];
        try {
            created = this.deps.store.insertCommentsReturningNew(profileId, fresh, this.now());
        } catch (e) {
            this.abortForStoreFailure(`Không ghi được bình luận: ${errorText(e)}`);
            throw e;
        }
        totals.collected += created.length;
        if (created.length > 0) {
            try {
                const leads = await this.deps.detector.process(created, { auto, emit: false, aiState: totals.aiState });
                totals.leads += leads.length;
                totals.found.push(...leads);
            } catch (e) {
                this.log(`Lọc khách tiềm năng lỗi: ${errorText(e)}`, 'warning'); // lọc khách lỗi không được làm hỏng lượt thu
            }
        }
        return created.length;
    }

    /** Bài đã xử lý (thành công hay lỗi): mọi mốc đã quá hạn coi như xong, rồi sang mốc tương lai hoặc NULL (không lặp lại). */
    private settle(row: PostTrackingRow): boolean {
        try {
            const config = this.deps.readConfig();
            const now = this.now();
            const done = [...row.commentsDone, ...overdueCommentLabels(row.postedAt, row.commentsDone, config, now)];
            this.deps.store.updateCommentSchedule(row.resultId, {
                commentsDone: done, nextCommentAt: computeNextCommentAt(row.postedAt, done, config, now),
            });
            return true;
        } catch (e) {
            this.abortForStoreFailure(`Không lưu được lịch thu bình luận: ${errorText(e)}`);
            return false;
        }
    }

    /** Ghi kho lỗi (đĩa đầy, chỉ đọc...): ghi nhật ký, dừng phần còn lại của lượt và chặn tự thu một giờ. */
    private abortForStoreFailure(message: string): void {
        if (!this.aborted) this.abortError = message;
        this.aborted = true;
        this.blockedUntilMs = this.now() + STORE_FAILURE_BACKOFF_MS;
        this.log(`${message}. Dừng lượt thu và tạm nghỉ tự thu 60 phút.`, 'error');
    }

    private log(message: string, level: LogLevel): void {
        try { this.deps.log?.(message, level); } catch { /* nhật ký hỏng không được làm hỏng lượt thu */ }
    }
}
