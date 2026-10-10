import type { FbPosterSchedule } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { BUSY_ERROR, type StartParams } from './FacebookPosterService';
import { computeNextRun } from './scheduleTime';
import Logger from '../../utils/Logger';

export const GRACE_MS = 60 * 1000;
export const QUEUE_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
/** Minimum re-arm delay after a store error, so a persistent fault cannot spin the timer. */
export const ERROR_RETRY_MS = 30 * 1000;
export const MISSED_APP_CLOSED = 'App tắt lúc đến giờ';
export const MISSED_QUEUE_TIMEOUT = 'Chờ quá 2 giờ vì đang có việc khác';
export const MISSED_APP_QUIT = 'App đóng khi lượt đang chờ';

export interface MissedNotice { scheduleId: string; name: string; reason: string; at: number; }

export interface SchedulerDeps {
    store: FacebookPosterStore;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    isBusy: () => boolean;
    /** Resolves media + validates; throws Error with a user-facing message (e.g. 'Không tìm thấy tệp ảnh/video'). */
    resolveParams: (schedule: FbPosterSchedule) => StartParams;
    startRun: (params: StartParams, scheduleId: string) => { runId: string };
    newId: () => string;
    onMissed: (notice: MissedNotice) => void;
    onChanged: () => void;
}

interface QueueItem { scheduleId: string; enqueuedAt: number; }

/** Fires due schedules, queues them while another job runs (one job at a time) and records missed/failed runs. */
export class FacebookPosterScheduler {
    private queue: QueueItem[] = [];
    private timer: unknown = null;
    private stopped = false;
    private lastRunFailed = false;

    constructor(private readonly deps: SchedulerDeps) {}

    start(): void {
        this.stopped = false;
        this.fire();
    }

    stop(): void {
        this.stopped = true;
        this.clear();
        const at = this.deps.now();
        for (const item of this.queue) this.recordMissed(item.scheduleId, MISSED_APP_QUIT, at);
        this.queue = [];
    }

    reschedule(): void {
        if (!this.stopped) this.arm();
    }

    onRunFinished(): void {
        if (this.stopped) return;
        this.pump();
        this.deps.onChanged();
    }

    queuedIds(): string[] {
        return this.queue.map((q) => q.scheduleId);
    }

    private fire(): void {
        if (this.stopped) return;
        this.lastRunFailed = false;
        try {
            const { store, now } = this.deps;
            const t = now();
            for (const s of store.listDueSchedules(t)) {
                if (s.nextRunAt !== null && s.nextRunAt < t - GRACE_MS) {
                    this.recordMissed(s.id, MISSED_APP_CLOSED, s.nextRunAt, s);
                } else if (!this.queue.some((q) => q.scheduleId === s.id)) {
                    this.queue.push({ scheduleId: s.id, enqueuedAt: t });
                }
                store.updateSchedule(s.id, { nextRunAt: computeNextRun(s, t) }, t);
            }
            this.pump();
        } catch (err) {
            this.lastRunFailed = true;
            Logger.error(`[FacebookPosterScheduler] fire failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.arm();
            this.deps.onChanged();
        }
    }

    private pump(): void {
        this.lastRunFailed = false;
        try {
            this.pumpQueue();
        } catch (err) {
            this.lastRunFailed = true;
            Logger.error(`[FacebookPosterScheduler] pump failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.arm();
        }
    }

    private pumpQueue(): void {
        const { store, now } = this.deps;
        const t = now();
        this.queue = this.queue.filter((item) => {
            if (t - item.enqueuedAt <= QUEUE_MAX_WAIT_MS) return true;
            this.recordMissed(item.scheduleId, MISSED_QUEUE_TIMEOUT, t);
            return false;
        });
        while (this.queue.length > 0 && !this.deps.isBusy()) {
            const item = this.queue.shift()!;
            const s = store.getSchedule(item.scheduleId);
            if (!s || !s.enabled || s.draft) continue;
            let runId: string;
            try {
                runId = this.deps.startRun(this.deps.resolveParams(s), s.id).runId;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message === BUSY_ERROR) { this.queue.unshift(item); break; }
                const id = this.deps.newId();
                store.recordScheduleRun({ id, scheduleId: s.id, params: s.params, at: now(), status: 'failed', reason: message });
                store.updateSchedule(s.id, { lastRunId: id }, now());
                continue;
            }
            // The job is already running: a failed bookkeeping write must not turn it into a failed run.
            try {
                store.updateSchedule(s.id, { lastRunId: runId }, now());
            } catch (err) {
                Logger.error(`[FacebookPosterScheduler] could not save lastRunId: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    private arm(): void {
        this.clear();
        let delay: number;
        try {
            const { store, now } = this.deps;
            const candidates: number[] = [];
            const next = store.nextScheduledAt();
            if (next !== null) candidates.push(next);
            if (this.queue.length > 0) candidates.push(this.queue[0].enqueuedAt + QUEUE_MAX_WAIT_MS);
            if (candidates.length === 0 && !this.lastRunFailed) return;
            delay = candidates.length === 0 ? 0 : Math.min(Math.max(0, Math.min(...candidates) - now()), MAX_TIMER_MS);
            if (this.lastRunFailed) delay = Math.max(delay, ERROR_RETRY_MS);
        } catch (err) {
            Logger.error(`[FacebookPosterScheduler] arm failed: ${err instanceof Error ? err.message : String(err)}`);
            delay = ERROR_RETRY_MS;
        }
        this.timer = this.deps.setTimer(() => this.fire(), delay);
    }

    private clear(): void {
        if (this.timer !== null) this.deps.clearTimer(this.timer);
        this.timer = null;
    }

    private recordMissed(scheduleId: string, reason: string, at: number, known?: FbPosterSchedule): void {
        const { store, now } = this.deps;
        const s = known ?? store.getSchedule(scheduleId);
        if (!s) return;
        const id = this.deps.newId();
        store.recordScheduleRun({ id, scheduleId, params: s.params, at, status: 'missed', reason });
        store.updateSchedule(scheduleId, { lastRunId: id }, now());
        this.deps.onMissed({ scheduleId, name: s.name, reason, at });
    }
}
