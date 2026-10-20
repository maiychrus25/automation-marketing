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
    /** Lý do chặn theo chiến dịch của lịch (tạm dừng / lưu trữ / ngoài thời gian), null khi không có chiến dịch hoặc chạy được; bỏ trống = không chặn (nối thật ở Electron). */
    campaignBlock?: (schedule: FbPosterSchedule, t: number) => string | null;
}

interface QueueItem { scheduleId: string; enqueuedAt: number; }

/** Fires due schedules, queues them while another job runs (one job at a time) and records missed/failed runs. */
export class FacebookPosterScheduler {
    private queue: QueueItem[] = [];
    /** Lịch vừa được duyệt "Đăng ngay": lệnh trực tiếp nên không bị chiến dịch chặn (spec 3.1). Chỉ giữ trong bộ nhớ. */
    private readonly gateBypass = new Set<string>();
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
        this.gateBypass.clear();
    }

    reschedule(): void {
        if (!this.stopped) this.arm();
    }

    onRunFinished(): void {
        if (this.stopped) return;
        this.pump();
        this.deps.onChanged();
    }

    /** Lượt kế tiếp của lịch này bỏ qua kiểm tra chiến dịch (dùng cho "Đăng ngay"). */
    bypassCampaignGateOnce(scheduleId: string): void {
        this.gateBypass.add(scheduleId);
    }

    /** Bỏ cờ bỏ-qua-chiến-dịch của lịch (khi lịch bị sửa, tránh cờ cũ áp vào lượt tự động sau). */
    clearCampaignGateBypass(scheduleId: string): void {
        this.gateBypass.delete(scheduleId);
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
                    this.gateBypass.delete(s.id);
                    this.recordMissed(s.id, MISSED_APP_CLOSED, s.nextRunAt, s);
                } else {
                    const reason = this.blockReason(s, t);
                    if (reason !== null) {
                        // Lịch lặp bỏ qua lặng lẽ (vẫn sang lần sau); lịch một lần không còn lần sau nên ghi bỏ lỡ.
                        if (s.kind === 'once') this.recordMissed(s.id, reason, s.nextRunAt ?? t, s);
                    } else if (!this.queue.some((q) => q.scheduleId === s.id)) {
                        this.queue.push({ scheduleId: s.id, enqueuedAt: t });
                    }
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
            this.gateBypass.delete(item.scheduleId);
            this.recordMissed(item.scheduleId, MISSED_QUEUE_TIMEOUT, t);
            return false;
        });
        while (this.queue.length > 0 && !this.deps.isBusy()) {
            const item = this.queue.shift()!;
            const s = store.getSchedule(item.scheduleId);
            if (!s || !s.enabled || s.draft) { this.gateBypass.delete(item.scheduleId); continue; }
            const blocked = this.blockReason(s, now());
            if (blocked !== null) { this.recordMissed(s.id, blocked, now(), s); continue; }
            let runId: string;
            try {
                runId = this.deps.startRun(this.deps.resolveParams(s), s.id).runId;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message === BUSY_ERROR) { this.queue.unshift(item); break; }
                this.gateBypass.delete(s.id);
                const id = this.deps.newId();
                store.recordScheduleRun({ id, scheduleId: s.id, params: s.params, at: now(), status: 'failed', reason: message });
                store.updateSchedule(s.id, { lastRunId: id }, now());
                continue;
            }
            this.gateBypass.delete(s.id);
            // The job is already running: a failed bookkeeping write must not turn it into a failed run.
            try {
                store.updateSchedule(s.id, { lastRunId: runId }, now());
            } catch (err) {
                Logger.error(`[FacebookPosterScheduler] could not save lastRunId: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    /** Lỗi đọc chiến dịch không được làm lịch ngừng chạy: coi như không bị chặn. */
    private blockReason(s: FbPosterSchedule, t: number): string | null {
        if (this.gateBypass.has(s.id)) return null;
        try {
            return this.deps.campaignBlock?.(s, t) ?? null;
        } catch (err) {
            Logger.error(`[FacebookPosterScheduler] campaignBlock failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
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
