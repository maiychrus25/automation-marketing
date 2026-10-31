import type { FbPosterSchedule } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { validateDraftParams, validateStartParams, type StartParamsEnv } from './validateStartParams';
import { copyScheduleMedia, replaceScheduleMedia, resolveScheduleMedia, removeScheduleMedia, prepareScheduleMedia } from './scheduleMedia';
import { readName, readTiming } from './scheduleUpdate';
import { computeNextRun } from './scheduleTime';
import { readCampaignRef } from './campaigns';

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
export interface SaveDraftInput { id?: unknown; expectedRevision?: unknown; name?: unknown; plannedAt?: unknown; campaignId?: unknown; params: unknown }
export interface DraftForEdit { draft: FbPosterSchedule; media: { path: string; size: number }[] }
export type ApproveDraftInput =
    | { id: unknown; expectedRevision?: number; when: 'now'; campaignId?: unknown }
    | { id: unknown; expectedRevision?: number; when: 'schedule'; kind: unknown; runAt?: unknown; days?: unknown; time?: unknown; campaignId?: unknown };

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

/** Chiến dịch mới của bản nháp/lịch: giữ nguyên khi không đổi (kể cả đã lưu trữ), chỉ kiểm khi gắn sang chiến dịch khác. */
function readCampaignChange(deps: DraftDeps, value: unknown, current: string | null): string | null | undefined {
    return value === current ? undefined : readCampaignRef(value, (id) => deps.store.getCampaign(id));
}

export function saveDraft(deps: DraftDeps, input: SaveDraftInput): FbPosterSchedule {
    const protectedEdit = typeof input.id === 'string' && !!input.id && deps.store.isWorkOwnedDraft(input.id);
    if (input.expectedRevision !== undefined || protectedEdit) {
        const prepared = prepareDraft(deps, protectedEdit && input.expectedRevision === undefined
            ? { ...input, expectedRevision: requireDraft(deps, input.id).revision } : input);
        try { return prepared.commit(); } catch (error) { prepared.cleanup(); throw error; }
    }
    const { store, env, baseDir } = deps;
    const now = deps.now();
    const params = validateDraftParams(input.params, env);
    const name = readName(input.name) || String(params.text).trim().slice(0, 40);
    const sources = params.mediaPaths as string[];
    const id = typeof input.id === 'string' && input.id ? input.id : null;
    const existingDraft = id ? store.getSchedule(id) : null;
    const campaignId = readCampaignChange(deps, input.campaignId, existingDraft?.campaignId ?? null);

    if (id) {
        const existing = store.getSchedule(id);
        if (!existing) throw new Error(NOT_FOUND);
        if (!existing.draft) throw new Error('Chỉ sửa được bản nháp');
        const runAt = readPlannedAt(input.plannedAt, existing.runAt, now);
        const names = replaceScheduleMedia(baseDir, id, sources);
        store.updateSchedule(id, { name, runAt, campaignId, params: { ...params, mediaPaths: names } }, now);
        return store.getSchedule(id)!;
    }

    if (store.countSchedules() >= deps.maxSchedules) throw new Error(`Tối đa ${deps.maxSchedules} lịch cho một workspace`);
    const runAt = readPlannedAt(input.plannedAt, null, now);
    const newId = deps.newId();
    const names = copyScheduleMedia(baseDir, newId, sources);
    try {
        store.createSchedule({
            id: newId, name, kind: 'once', params: { ...params, mediaPaths: names },
            runAt, days: [], time: '', enabled: false, nextRunAt: null, createdAt: now, draft: true, campaignId: campaignId ?? null,
        });
    } catch (err) {
        removeScheduleMedia(baseDir, newId);
        throw err;
    }
    return store.getSchedule(newId)!;
}

/** Validation/read-only planning shared by preflight and immutable preparation. */
function planDraft(deps: DraftDeps, input: SaveDraftInput) {
    const { store, env } = deps;
    const now = deps.now();
    const editing = input.id !== undefined;
    const existing = editing ? requireDraft(deps, input.id) : null;
    if (editing ? !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== existing!.revision : input.expectedRevision !== undefined)
        throw new Error('Bản nháp đã thay đổi, vui lòng tải lại');
    if (!editing && store.countSchedules() >= deps.maxSchedules)
        throw new Error(`Tối đa ${deps.maxSchedules} lịch cho một workspace`);
    const params = validateDraftParams(input.params, env);
    const name = readName(input.name) || String(params.text).trim().slice(0, 40);
    const campaignId = readCampaignChange(deps, input.campaignId, existing?.campaignId ?? null);
    const runAt = readPlannedAt(input.plannedAt, existing?.runAt ?? null, now);
    const id = existing?.id ?? deps.newId();
    if (!editing && store.getSchedule(id)) throw new Error('Bản nháp đã tồn tại');
    const revision = existing ? existing.revision + 1 : 1;
    return { now, existing, params, name, campaignId, runAt, id, revision };
}

/** Validate without writes; invoke the returned preparation only after reserving the effect. */
export function validateDraft(deps: DraftDeps, input: SaveDraftInput) {
    const plan = planDraft(deps, input);
    return () => prepareValidatedDraft(deps, plan);
}

/** Trusted preparation seam: copy first, then commit DB-only inside the owner's transaction. */
export function prepareDraft(deps: DraftDeps, input: SaveDraftInput) {
    return validateDraft(deps, input)();
}

function prepareValidatedDraft(deps: DraftDeps, plan: ReturnType<typeof planDraft>) {
    const { store, baseDir } = deps;
    const { now, existing, params, name, campaignId, runAt, id, revision } = plan;
    const media = prepareScheduleMedia(baseDir, id, revision, params.mediaPaths as string[]);
    const savedParams = { ...params, mediaPaths: media.names };
    let committed = false;
    return {
        id, revision,
        commit(): FbPosterSchedule {
            if (existing) {
                store.updateSchedule(id, { name, runAt, campaignId, params: savedParams }, now, existing.revision);
            } else {
                if (store.countSchedules() >= deps.maxSchedules) throw new Error(`Tối đa ${deps.maxSchedules} lịch cho một workspace`);
                store.createSchedule({ id, name, kind: 'once', params: savedParams, runAt, days: [], time: '',
                    enabled: false, nextRunAt: null, createdAt: now, draft: true, campaignId: campaignId ?? null });
            }
            const saved = store.getSchedule(id);
            if (!saved || saved.revision !== revision) throw new Error('Không ghi được bản nháp');
            committed = true;
            return saved;
        },
        cleanup(): void {
            if (committed) return;
            // A caller may lose the response after COMMIT; never remove files now referenced by the row.
            const current = store.getSchedule(id);
            if (!current || mediaNames(current).some((name) => media.names.includes(name))) return;
            media.cleanup();
        },
    };
}

export function getDraft(deps: DraftDeps, id: unknown): DraftForEdit {
    const draft = requireDraft(deps, id);
    const paths = resolveScheduleMedia(deps.baseDir, draft.id, mediaNames(draft));
    return { draft, media: paths.map((p) => ({ path: p, size: deps.env.fileExists(p) ? deps.env.fileSize(p) : 0 })) };
}

export function approveDraft(deps: DraftDeps, input: ApproveDraftInput): FbPosterSchedule {
    return promoteDraft(deps, input, 'owner');
}

/** Shared validated promotion, without owner tickets or owner-approval events. Trusted service only. */
export function promoteDraft(deps: DraftDeps, input: ApproveDraftInput, authority: 'owner' | 'autonomy'): FbPosterSchedule {
    const { store, env, baseDir } = deps;
    const write: FacebookPosterStore['updateSchedule'] = (id, fields, at, revision) => authority === 'autonomy'
        ? store.updateAutonomySchedule(id, fields, at, revision!) : store.updateSchedule(id, fields, at, revision);
    const now = deps.now();
    const draft = requireDraft(deps, input.id);
    if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== draft.revision))
        throw new Error('Bản nháp đã thay đổi, vui lòng tải lại');
    const names = mediaNames(draft);
    // Kiểm đầy đủ như đăng bài thật; lỗi thì ném trước khi ghi gì, nháp giữ nguyên.
    const checked = validateStartParams(
        { kind: 'post', params: { ...draft.params, mediaPaths: resolveScheduleMedia(baseDir, draft.id, names) } }, env);
    if (checked.kind !== 'post') throw new Error('Loại lịch không hợp lệ');
    const params = { ...checked, mediaPaths: names, ...(Array.isArray(draft.params.mediaIds) ? {mediaIds:draft.params.mediaIds} : {}) };
    const campaignId = readCampaignChange(deps, input.campaignId, draft.campaignId);

    if (input.when === 'now') {
        // Đăng ngay vào chiến dịch đã lưu trữ sẽ chỉ thất bại muộn ở service.start: từ chối sớm, trước khi ghi.
        const effectiveId = campaignId === undefined ? draft.campaignId : campaignId;
        if (effectiveId && deps.store.getCampaign(effectiveId)?.status === 'archived') throw new Error('Chiến dịch đã lưu trữ');
        write(draft.id, {
            kind: 'once', runAt: now, days: [], time: '', params, campaignId, draft: false, enabled: true, nextRunAt: now,
        }, now, input.expectedRevision);
    } else {
        if (input.kind !== 'once' && input.kind !== 'recurring') throw new Error('Loại lịch không hợp lệ');
        const kind: 'once' | 'recurring' = input.kind;
        const timing = readTiming(kind, input, now);
        write(draft.id, {
            kind, ...timing, params, campaignId, draft: false, enabled: true, nextRunAt: computeNextRun({ kind, ...timing }, now),
        }, now, input.expectedRevision);
    }
    return store.getSchedule(draft.id)!;
}
