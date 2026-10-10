import type { FbPosterSchedule } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { validateDraftParams, validateStartParams, type StartParamsEnv } from './validateStartParams';
import { copyScheduleMedia, replaceScheduleMedia, resolveScheduleMedia, removeScheduleMedia } from './scheduleMedia';
import { readName, readTiming } from './scheduleUpdate';
import { computeNextRun } from './scheduleTime';

/**
 * Bản nháp (GĐ2): một dòng fb_poster_schedules với draft = 1, luôn enabled = 0 và next_run_at = NULL nên scheduler
 * không bao giờ chạy. Chỉ approveDraft mới biến nó thành lịch thật. Module thuần, phụ thuộc truyền vào để test được.
 */
export interface DraftDeps {
    store: FacebookPosterStore;
    env: StartParamsEnv;
    baseDir: string;
    now: () => number;
    newId: () => string;
    maxSchedules: number;
}
export interface SaveDraftInput { id?: unknown; name?: unknown; plannedAt?: unknown; params: unknown }
export interface DraftForEdit { draft: FbPosterSchedule; media: { path: string; size: number }[] }
export type ApproveDraftInput =
    | { id: unknown; when: 'now' }
    | { id: unknown; when: 'schedule'; kind: unknown; runAt?: unknown; days?: unknown; time?: unknown };

const NOT_FOUND = 'Không tìm thấy bản nháp';

const mediaNames = (s: FbPosterSchedule): string[] =>
    (Array.isArray(s.params.mediaPaths) ? s.params.mediaPaths : []).filter((n): n is string => typeof n === 'string');

function requireDraft(deps: DraftDeps, id: unknown): FbPosterSchedule {
    const s = typeof id === 'string' && id ? deps.store.getSchedule(id) : null;
    if (!s || !s.draft) throw new Error(NOT_FOUND);
    return s;
}

/** Giờ dự kiến: null = chưa xếp lịch. Chỉ kiểm "ở tương lai" khi giờ đổi, để sửa nháp đã quá giờ dự kiến vẫn lưu được. */
function readPlannedAt(value: unknown, current: number | null, now: number): number | null {
    if (value === undefined || value === current) return current;
    if (value === null) return null;
    return readTiming('once', { runAt: value }, now).runAt;
}

export function saveDraft(deps: DraftDeps, input: SaveDraftInput): FbPosterSchedule {
    const { store, env, baseDir } = deps;
    const now = deps.now();
    const params = validateDraftParams(input.params, env);
    const name = readName(input.name) || String(params.text).trim().slice(0, 40);
    const sources = params.mediaPaths as string[];
    const id = typeof input.id === 'string' && input.id ? input.id : null;

    if (id) {
        const existing = store.getSchedule(id);
        if (!existing) throw new Error(NOT_FOUND);
        if (!existing.draft) throw new Error('Chỉ sửa được bản nháp');
        const runAt = readPlannedAt(input.plannedAt, existing.runAt, now);
        const names = replaceScheduleMedia(baseDir, id, sources);
        store.updateSchedule(id, { name, runAt, params: { ...params, mediaPaths: names } }, now);
        return store.getSchedule(id)!;
    }

    if (store.countSchedules() >= deps.maxSchedules) throw new Error(`Tối đa ${deps.maxSchedules} lịch cho một workspace`);
    const runAt = readPlannedAt(input.plannedAt, null, now);
    const newId = deps.newId();
    const names = copyScheduleMedia(baseDir, newId, sources);
    try {
        store.createSchedule({
            id: newId, name, kind: 'once', params: { ...params, mediaPaths: names },
            runAt, days: [], time: '', enabled: false, nextRunAt: null, createdAt: now, draft: true,
        });
    } catch (err) {
        removeScheduleMedia(baseDir, newId);
        throw err;
    }
    return store.getSchedule(newId)!;
}

export function getDraft(deps: DraftDeps, id: unknown): DraftForEdit {
    const draft = requireDraft(deps, id);
    const paths = resolveScheduleMedia(deps.baseDir, draft.id, mediaNames(draft));
    return { draft, media: paths.map((p) => ({ path: p, size: deps.env.fileExists(p) ? deps.env.fileSize(p) : 0 })) };
}

export function approveDraft(deps: DraftDeps, input: ApproveDraftInput): FbPosterSchedule {
    const { store, env, baseDir } = deps;
    const now = deps.now();
    const draft = requireDraft(deps, input.id);
    const names = mediaNames(draft);
    // Kiểm đầy đủ như đăng bài thật; lỗi thì ném trước khi ghi gì, nháp giữ nguyên.
    const checked = validateStartParams(
        { kind: 'post', params: { ...draft.params, mediaPaths: resolveScheduleMedia(baseDir, draft.id, names) } }, env);
    if (checked.kind !== 'post') throw new Error('Loại lịch không hợp lệ');
    const params = { ...checked, mediaPaths: names };

    if (input.when === 'now') {
        store.updateSchedule(draft.id, {
            kind: 'once', runAt: now, days: [], time: '', params, draft: false, enabled: true, nextRunAt: now,
        }, now);
    } else {
        if (input.kind !== 'once' && input.kind !== 'recurring') throw new Error('Loại lịch không hợp lệ');
        const kind: 'once' | 'recurring' = input.kind;
        const timing = readTiming(kind, input, now);
        store.updateSchedule(draft.id, {
            kind, ...timing, params, draft: false, enabled: true, nextRunAt: computeNextRun({ kind, ...timing }, now),
        }, now);
    }
    return store.getSchedule(draft.id)!;
}
