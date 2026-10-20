import Logger from '../../utils/Logger';
import { errorText } from './controlSecurity';
import type { FbPosterResult, FbPosterRun, FbPosterSchedule, LoginCheckOutcome, LoginCheckSource, LoginState } from '../../models/facebookPoster';

export type ControlEventType = 'run.started' | 'run.finished' | 'schedule.missed' | 'draft.approved' | 'profile.loginProblem' | 'profiles.checkFinished' | 'research.finished' | 'posts.trackFinished' | 'leads.found' | 'videos.finished';

export function buildRunStarted(run: { runId: string; kind: string; scheduleId: string | null }) {
    return { runId: run.runId, kind: run.kind, scheduleId: run.scheduleId };
}

/** `status` là trạng thái cuối của run; posted/failed/skipped đếm theo `outcome` của từng kết quả. */
export function buildRunFinished(run: Pick<FbPosterRun, 'id' | 'kind' | 'status' | 'scheduleId'>, results: Pick<FbPosterResult, 'outcome'>[], scheduleName: string | null = null) {
    const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
    return {
        runId: run.id, kind: run.kind, status: run.status, scheduleId: run.scheduleId, scheduleName,
        posted: count('posted'), failed: count('failed'), skipped: count('skipped'),
    };
}

export function buildScheduleMissed(notice: { scheduleId: string; name: string; reason: string; at: number }) {
    return { scheduleId: notice.scheduleId, name: notice.name, reason: notice.reason, at: notice.at };
}

export function buildDraftApproved(schedule: Pick<FbPosterSchedule, 'id' | 'name' | 'kind' | 'nextRunAt'>, when: unknown) {
    return { scheduleId: schedule.id, name: schedule.name, when: when === 'now' ? 'now' : 'scheduled', kind: schedule.kind, nextRunAt: schedule.nextRunAt };
}

export function buildLoginProblem(e: { profileId: string; profileName: string; state: LoginState; source: 'check' | 'run' }) {
    return { profileId: e.profileId, profileName: e.profileName, state: e.state, source: e.source };
}

/** `error` chỉ có khi lần kiểm tra của profile đó lỗi. */
export function buildCheckFinished(e: { checkId: string; source: LoginCheckSource; results: { profileId: string; profileName: string; outcome: LoginCheckOutcome; error?: string }[] }) {
    return {
        checkId: e.checkId,
        source: e.source,
        results: e.results.map((r) => ({
            profileId: r.profileId, profileName: r.profileName, outcome: r.outcome,
            ...(r.error !== undefined ? { error: r.error } : {}),
        })),
    };
}

/** Lượt quét Nghiên cứu kết thúc; chỉ giữ các trường đã công bố. */
export function buildResearchFinished(scan: { scanId: string; source: string; query: string; status: string; errorCode: string; itemCount: number }) {
    return { scanId: scan.scanId, source: scan.source, query: scan.query, status: scan.status, errorCode: scan.errorCode, itemCount: scan.itemCount };
}

/** Lượt theo dõi bài đăng kết thúc; chỉ giữ các trường đã công bố. */
export function buildTrackFinished(e: {
    jobId: string; auto: boolean; cancelled: boolean; groups: number; checked: number; found: number;
    linked: number; removedSuspected: number; notFound: number; errors: number;
}) {
    return {
        jobId: e.jobId, auto: e.auto, cancelled: e.cancelled, groups: e.groups, checked: e.checked, found: e.found,
        linked: e.linked, removedSuspected: e.removedSuspected, notFound: e.notFound, errors: e.errors,
    };
}

/** Có khách tiềm năng mới; chỉ giữ các trường đã công bố, tối đa 3 mẫu. */
export function buildLeadsFound(e: { count: number; auto: boolean; samples: { authorName: string; text: string; postUrl: string }[] }) {
    return {
        count: e.count, auto: e.auto,
        samples: e.samples.slice(0, 3).map((s) => ({ authorName: s.authorName, text: s.text, postUrl: s.postUrl })),
    };
}

/** Video render xong hoặc lỗi; `error` chỉ khi lỗi, `mediaId` chỉ với video do bot tạo. */
export function buildVideoFinished(e: { videoId: string; name: string; ok: boolean; error?: string; durationSec?: number; sizeBytes?: number; mediaId?: string }) {
    return {
        videoId: e.videoId, name: e.name, ok: e.ok,
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.durationSec !== undefined ? { durationSec: e.durationSec } : {}),
        ...(e.sizeBytes !== undefined ? { sizeBytes: e.sizeBytes } : {}),
        ...(e.mediaId !== undefined ? { mediaId: e.mediaId } : {}),
    };
}

type Sink = (type: ControlEventType, payload: unknown) => void;
let sink: Sink | null = null;

/** Control API đặt sink khi chạy (ghi vào ControlStore rồi notify) và gỡ khi dừng; nơi phát sự kiện không cần biết API có bật hay không. */
export function setControlEventSink(next: Sink | null): void {
    sink = next;
}

export function hasControlEventSink(): boolean {
    return sink !== null;
}

/** Không bao giờ ném: sự kiện Control API không được làm hỏng luồng Đăng Facebook. */
export function emitControlEvent(type: ControlEventType, payload: unknown): void {
    try {
        sink?.(type, payload);
    } catch (err) {
        Logger.error('[control] Không ghi được sự kiện:', errorText(err));
    }
}
