import type { FbPosterResult, FbPosterRun, FbPosterSchedule } from '../../models/facebookPoster';

export type ControlEventType = 'run.started' | 'run.finished' | 'schedule.missed' | 'draft.approved';

export function buildRunStarted(run: { runId: string; kind: string; scheduleId: string | null }) {
    return { runId: run.runId, kind: run.kind, scheduleId: run.scheduleId };
}

/** `status` là trạng thái cuối của run; posted/failed/skipped đếm theo `outcome` của từng kết quả. */
export function buildRunFinished(run: Pick<FbPosterRun, 'id' | 'kind' | 'status' | 'scheduleId'>, results: Pick<FbPosterResult, 'outcome'>[]) {
    const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
    return {
        runId: run.id, kind: run.kind, status: run.status, scheduleId: run.scheduleId,
        posted: count('posted'), failed: count('failed'), skipped: count('skipped'),
    };
}

export function buildScheduleMissed(notice: { scheduleId: string; name: string; reason: string; at: number }) {
    return { scheduleId: notice.scheduleId, name: notice.name, reason: notice.reason, at: notice.at };
}

export function buildDraftApproved(schedule: Pick<FbPosterSchedule, 'id' | 'name' | 'kind' | 'nextRunAt'>, when: unknown) {
    return { scheduleId: schedule.id, name: schedule.name, when: when === 'now' ? 'now' : 'scheduled', kind: schedule.kind, nextRunAt: schedule.nextRunAt };
}

type Sink = (type: ControlEventType, payload: unknown) => void;
let sink: Sink | null = null;

/** Control API đặt sink khi chạy (ghi vào ControlStore rồi notify) và gỡ khi dừng; nơi phát sự kiện không cần biết API có bật hay không. */
export function setControlEventSink(next: Sink | null): void {
    sink = next;
}

/** Không bao giờ ném: sự kiện Control API không được làm hỏng luồng Đăng Facebook. */
export function emitControlEvent(type: ControlEventType, payload: unknown): void {
    try {
        sink?.(type, payload);
    } catch (err) {
        console.error('[control] Không ghi được sự kiện:', err);
    }
}
