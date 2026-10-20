import type { CampaignStatus, FbPosterCampaign, PostStatsReportRow } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { isCampaignRunnable, validateCampaignInput } from './campaigns';

const STATUSES: CampaignStatus[] = ['active', 'paused', 'archived'];

export interface CampaignOperationsDeps {
    store: () => FacebookPosterStore;
    now: () => number;
    newId: () => string;
    /** Gọi sau khi tạo/sửa/xoá để scheduler tính lại cổng chiến dịch. */
    reschedule: () => void;
}

export interface CampaignView extends FbPosterCampaign {
    scheduleCount: number;
    draftCount: number;
    runnable: boolean;
    summary: PostStatsReportRow | null;
}

/** Các thao tác chiến dịch (spec §6), dùng chung cho IPC và Control API; kiểm tham số ở đây. */
export function createCampaignOperations(deps: CampaignOperationsDeps) {
    const view = (store: FacebookPosterStore, c: FbPosterCampaign): CampaignView => {
        const now = deps.now();
        const counts = store.countCampaignSchedules(c.id);
        const summary = store.statsReport({ from: c.createdAt, to: now, groupBy: 'campaign', limit: 10, campaignId: c.id })[0] ?? null;
        return { ...c, scheduleCount: counts.schedules, draftCount: counts.drafts, runnable: isCampaignRunnable(c, now), summary };
    };
    const requireCampaign = (store: FacebookPosterStore, id: unknown): FbPosterCampaign => {
        const c = typeof id === 'string' && id ? store.getCampaign(id) : null;
        if (!c) throw new Error('Không tìm thấy chiến dịch');
        return c;
    };

    return {
        list: (params?: any) => {
            const status = params?.status;
            if (status !== undefined && !STATUSES.includes(status)) throw new Error('Trạng thái chiến dịch không hợp lệ');
            const store = deps.store();
            return { campaigns: store.listCampaigns(status ? { status } : {}).map((c) => view(store, c)) };
        },

        get: (params?: any) => {
            const store = deps.store();
            const campaign = requireCampaign(store, params?.id);
            const schedules = store.listSchedules({ campaignId: campaign.id }).map((s) => ({
                id: s.id, name: s.name, kind: s.kind, enabled: s.enabled, draft: s.draft, nextRunAt: s.nextRunAt,
            }));
            return { campaign: { ...view(store, campaign), schedules } };
        },

        create: (params?: any) => {
            const store = deps.store();
            const input = validateCampaignInput(params ?? {}, { findByName: (n) => store.findCampaignByName(n) });
            const now = deps.now();
            const id = deps.newId();
            store.createCampaign({ id, ...input, createdAt: now, updatedAt: now });
            deps.reschedule();
            return { campaign: view(store, store.getCampaign(id)!) };
        },

        update: (params?: any) => {
            const store = deps.store();
            const existing = requireCampaign(store, params?.id);
            const input = validateCampaignInput(params ?? {}, { existing, findByName: (n) => store.findCampaignByName(n) });
            store.updateCampaign(existing.id, input, deps.now());
            deps.reschedule();
            return { campaign: view(store, store.getCampaign(existing.id)!) };
        },

        delete: (params?: any) => {
            const store = deps.store();
            const campaign = requireCampaign(store, params?.id);
            const counts = store.countCampaignSchedules(campaign.id);
            const total = counts.schedules + counts.drafts;
            if (total > 0) throw new Error(`Chiến dịch còn ${total} lịch/bài nháp, hãy chuyển hoặc xoá trước`);
            store.deleteCampaign(campaign.id);
            deps.reschedule();
            return { deleted: true };
        },
    };
}
