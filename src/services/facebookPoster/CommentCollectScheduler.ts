import type { PostTrackingRow } from '../../models/facebookPoster';
import { MAX_COMMENT_POSTS } from './CommentCollector';
import { BUSY_ERROR } from './FacebookPosterService';
import { DEFAULT_LEAD_CONFIG, type LeadConfig } from './leadRules';

// Tự thu bình luận: mỗi chu kỳ lấy các bài đến mốc rồi chạy. Spec mục 6.1.

export const COMMENT_TICK_MINUTES = 15;

export interface CommentCollectSchedulerDeps {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    readConfig: () => LeadConfig;
    isBusy: () => boolean;
    /** Mốc (ms) trước đó không được tự thu vì lần ghi kho gần nhất bị lỗi. */
    blockedUntil?: () => number;
    duePosts: (now: number, limit: number) => PostTrackingRow[];
    /** Đồng bộ; ném `BUSY_ERROR` khi đang có việc chạy. Luôn thu với `auto = true`. */
    runCollect: (rows: PostTrackingRow[]) => void;
    log: (msg: string) => void;
}

export class CommentCollectScheduler {
    private timer: unknown = null;
    private stopped = true;

    constructor(private readonly deps: CommentCollectSchedulerDeps) {}

    start(): void {
        this.stopped = false;
        this.arm();
    }

    stop(): void {
        this.stopped = true;
        this.clear();
    }

    /** Chạy một chu kỳ ngay (cho test). Không bao giờ ném lỗi. */
    tickNow(): void {
        const { now, readConfig, isBusy, duePosts, runCollect, log } = this.deps;
        try {
            let config: LeadConfig;
            try {
                config = readConfig();
            } catch (err) {
                log(`[CommentCollectScheduler] đọc cấu hình lỗi, dùng mặc định: ${errorMessage(err)}`);
                config = DEFAULT_LEAD_CONFIG;
            }
            if (!config.autoCollect || isBusy()) return;
            if (now() < (this.deps.blockedUntil?.() ?? 0)) return;
            const rows = duePosts(now(), MAX_COMMENT_POSTS);
            if (rows.length === 0) return;
            runCollect(rows);
        } catch (err) {
            const message = errorMessage(err);
            if (message !== BUSY_ERROR) log(`[CommentCollectScheduler] thu bình luận tự động lỗi: ${message}`);
        }
    }

    private arm(): void {
        this.clear();
        this.timer = this.deps.setTimer(() => this.fire(), COMMENT_TICK_MINUTES * 60_000);
    }

    private fire(): void {
        if (this.stopped) return;
        this.timer = null;
        this.tickNow();
        if (!this.stopped) this.arm();
    }

    private clear(): void {
        if (this.timer !== null) this.deps.clearTimer(this.timer);
        this.timer = null;
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
