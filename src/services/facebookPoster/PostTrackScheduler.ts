import { BUSY_ERROR } from './FacebookPosterService';
import { AUTO_TRACK_GROUPS, type TrackPair } from './PostTracker';
import { DEFAULT_POST_TRACKING_CONFIG, type PostTrackingConfig } from './postTracking';

// Tự động theo dõi bài: mỗi chu kỳ lấy các cặp (profile, nhóm) đến hạn rồi chạy. Spec mục 4.5.

export const TRACK_TICK_MINUTES = 15;

export interface PostTrackSchedulerDeps {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    readConfig: () => PostTrackingConfig;
    isBusy: () => boolean;
    duePairs: (now: number, limit: number) => TrackPair[];
    /** Đồng bộ; ném `BUSY_ERROR` khi đang có việc chạy. Luôn gọi với `auto = true`. */
    runTrack: (pairs: TrackPair[], auto: true) => void;
    log: (msg: string) => void;
    /** Captured Page composition; true only when one job has been accepted. */
    runDueCampaignTracking?: () => boolean;
}

export class PostTrackScheduler {
    private timer: unknown = null;
    private stopped = true;
    private preferPage = false;

    constructor(private readonly deps: PostTrackSchedulerDeps) {}

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
        const { now, readConfig, isBusy, duePairs, runTrack, log } = this.deps;
        try {
            let config: PostTrackingConfig;
            try {
                config = readConfig();
            } catch (err) {
                log(`[PostTrackScheduler] đọc cấu hình lỗi, dùng mặc định: ${errorMessage(err)}`);
                config = DEFAULT_POST_TRACKING_CONFIG;
            }
            if (isBusy()) return;
            if (this.preferPage && this.deps.runDueCampaignTracking?.()) { this.preferPage=false; return; }
            const pairs = config.autoEnabled ? duePairs(now(), AUTO_TRACK_GROUPS) : [];
            if (pairs.length) { runTrack(pairs, true); this.preferPage=true; return; }
            if (this.deps.runDueCampaignTracking?.()) this.preferPage=false;
        } catch (err) {
            const message = errorMessage(err);
            if (message !== BUSY_ERROR) log(`[PostTrackScheduler] theo dõi tự động lỗi: ${message}`);
        }
    }

    private arm(): void {
        this.clear();
        this.timer = this.deps.setTimer(() => this.fire(), TRACK_TICK_MINUTES * 60_000);
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
