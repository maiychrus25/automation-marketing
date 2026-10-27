import type { DailyBrief, DailyBriefPatch } from '../../models/dailyBrief';
import { BRIEF_MAX_ROWS, type DailyBriefStore } from './DailyBriefStore';

export const BRIEF_NOT_FOUND_ERROR = 'Không tìm thấy kế hoạch Page';

export interface BriefOperationsDeps {
    store: () => DailyBriefStore;
    now: () => number;
    profileExists: (id: string) => boolean;
    emitFinished: (payload: { profileId: string; pageName: string; ok: boolean; draftIds: string[]; error?: string; attempts?: number; attemptDate?: string | null }) => void;
}

/** Trí nhớ từng Page dùng chung cho Control API; chỉ cho sửa các trường nội dung/cấu hình. */
export function createBriefOperations(deps: BriefOperationsDeps) {
    const profileIdOf = (params: any): string => {
        if (typeof params?.profileId !== 'string' || !params.profileId.trim()) throw new Error('profileId phải là chuỗi không rỗng');
        return params.profileId;
    };
    const view = (store: DailyBriefStore, brief: DailyBrief): DailyBrief & { pageName: string } =>
        ({ ...brief, pageName: store.getIdentity(brief.profileId)?.pageName ?? '' });

    return {
        list: () => {
            const store = deps.store();
            return { briefs: store.listBriefs().map((brief) => view(store, brief)) };
        },
        get: (params?: any) => {
            const profileId = profileIdOf(params);
            const store = deps.store();
            const brief = store.getBrief(profileId);
            if (!brief) throw new Error(BRIEF_NOT_FOUND_ERROR);
            return { brief: view(store, brief) };
        },
        save: (params?: any) => {
            const profileId = profileIdOf(params);
            const store = deps.store();
            if (!deps.profileExists(profileId)) throw new Error('Profile không tồn tại');
            if (store.getIdentity(profileId)?.kind !== 'page') throw new Error('Profile không phải Page đã học');
            const existing = store.getBrief(profileId);
            if (!existing && params.keywords === undefined) throw new Error('Kế hoạch Page mới cần keywords');
            const patch: DailyBriefPatch = {};
            for (const [field, max] of [['niche', 300], ['tone', 500], ['notes', 1000]] as const) {
                const value = params[field];
                if (value === undefined) continue;
                if (typeof value !== 'string' || value.length > max) throw new Error(`${field} phải là chuỗi tối đa ${max} ký tự`);
                patch[field] = value;
            }
            if (params.keywords !== undefined) {
                const value = params.keywords;
                if (!Array.isArray(value) || value.length < 1 || value.length > 10
                    || !value.every((s) => typeof s === 'string' && s.trim().length > 0 && s.length <= 80)) {
                    throw new Error('keywords phải có 1–10 chuỗi không rỗng, mỗi chuỗi tối đa 80 ký tự');
                }
                patch.keywords = value;
            }
            if (params.groupIds !== undefined) {
                const value = params.groupIds;
                if (!Array.isArray(value) || value.length > 20 || !value.every((s) => typeof s === 'string' && s.trim().length > 0)) {
                    throw new Error('groupIds phải là danh sách tối đa 20 mã nhóm không rỗng');
                }
                patch.groupIds = value;
            }
            if (params.time !== undefined) {
                if (typeof params.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(params.time)) throw new Error('time phải đúng dạng HH:MM (00:00–23:59)');
                patch.time = params.time;
            }
            if (params.draftsPerDay !== undefined) {
                if (!Number.isInteger(params.draftsPerDay) || params.draftsPerDay < 1 || params.draftsPerDay > 5) throw new Error('draftsPerDay phải là số nguyên từ 1 đến 5');
                patch.draftsPerDay = params.draftsPerDay;
            }
            if (params.enabled !== undefined) {
                if (typeof params.enabled !== 'boolean') throw new Error('enabled phải là boolean');
                patch.enabled = params.enabled;
            }
            if (!existing && store.countBriefs() >= BRIEF_MAX_ROWS) throw new Error(`Tối đa ${BRIEF_MAX_ROWS} kế hoạch Page`);
            return { brief: view(store, store.saveBrief(profileId, patch, deps.now())) };
        },
        delete: (params?: any) => {
            const profileId = profileIdOf(params);
            if (!deps.store().deleteBrief(profileId)) throw new Error(BRIEF_NOT_FOUND_ERROR);
            return { deleted: true as const };
        },
        claimDue: (params?: any) => {
            const profileId = params?.profileId === undefined ? undefined : profileIdOf(params);
            const store = deps.store();
            const briefs = store.claimDue(deps.now(), (id) => deps.profileExists(id) && store.getIdentity(id)?.kind === 'page',
                profileId, (expired) => deps.emitFinished({
                    profileId: expired.profileId, pageName: view(store, expired).pageName, ok: false, draftIds: [],
                    error: 'Lượt đề xuất hết hạn', attempts: expired.attempts, attemptDate: expired.attemptDate,
                }));
            return { briefs: briefs.map((brief) => view(store, brief)) };
        },
        finish: (params?: any) => {
            const profileId = profileIdOf(params);
            if (!Number.isInteger(params.claimedAt)) throw new Error('claimedAt phải là số nguyên mili giây epoch từ briefs.claimDue');
            if (typeof params.ok !== 'boolean') throw new Error('ok phải là boolean');
            if (params.draftIds !== undefined && (!Array.isArray(params.draftIds) || !params.draftIds.every((id) => typeof id === 'string'))) {
                throw new Error('draftIds phải là danh sách chuỗi');
            }
            if (params.error !== undefined && typeof params.error !== 'string') throw new Error('error phải là chuỗi');
            const store = deps.store();
            const brief = view(store, store.finishBrief(profileId, params.ok, deps.now(), params.claimedAt));
            deps.emitFinished({
                profileId, pageName: brief.pageName, ok: params.ok, draftIds: params.draftIds ?? [],
                ...(!params.ok ? { attempts: brief.attempts, attemptDate: brief.attemptDate } : {}),
                ...(params.error !== undefined ? { error: params.error.slice(0, 500) } : {}),
            });
            return { brief };
        },
    };
}
