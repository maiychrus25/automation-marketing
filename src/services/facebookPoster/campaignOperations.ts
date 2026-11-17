import type { CampaignStatus, FbPosterCampaign, PostStatsReportRow } from '../../models/facebookPoster';
import type { FacebookPosterStore, SqlDatabase } from './FacebookPosterStore';
import { isCampaignRunnable, validateCampaignInput } from './campaigns';
import { PageCampaignStore } from '../dailyBrief/PageCampaignStore';
import { cancelCampaignGrantAuthority } from '../dailyBrief/PageCampaignExecutionStore';
import { readProfileScope } from './profileScope';

function invalidateManagedCampaign(db:SqlDatabase,id:string,now:number,deleted=false):void {
    const table=db.queryOne<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='page_campaign_links'");
    if (!table) throw new Error('Không đọc được phạm vi chiến dịch');
    if (!table.n) return;
    const campaigns=new PageCampaignStore(db); const link=campaigns.getLink(id);
    if (!link) return;
    for (const grant of campaigns.listGrants(id).filter(grant => grant.status === 'active')) {
        campaigns.revokeGrant(link,grant.id,grant.revision,now);
        cancelCampaignGrantAuthority(db,grant,now);
    }
    db.run('UPDATE page_campaign_links SET revision=revision+1, deleted_at=? WHERE campaign_id=? AND revision=?',
        [deleted ? now : link.deletedAt,id,link.revision]);
    if (db.queryOne<{n:number}>('SELECT changes() AS n')?.n !== 1) throw new Error('Chiến dịch đã thay đổi');
}

const STATUSES: CampaignStatus[] = ['active', 'paused', 'archived'];

export interface CampaignOperationsDeps {
    store: () => FacebookPosterStore;
    /** Profiles a campaign's schedules, runs, posts and leads belong to (a Page-managed campaign includes a marker no scope covers); null = no such campaign. Needed only for employee-scoped calls. */
    campaignProfiles?: (id: string) => string[] | null;
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
    const view = (store: FacebookPosterStore, c: FbPosterCampaign, scope?: readonly string[]): CampaignView => {
        const now = deps.now();
        // With a scope the counts come from the schedules the scope may see, never from the whole table.
        const counts = scope === undefined ? store.countCampaignSchedules(c.id) : (() => {
            const visible = store.listSchedules({ campaignId: c.id, profileIds: scope });
            return { schedules: visible.filter((s) => !s.draft).length, drafts: visible.filter((s) => s.draft).length };
        })();
        const summary = store.statsReport({ from: c.createdAt, to: now, groupBy: 'campaign', limit: 10, campaignId: c.id, profileIds: scope })[0] ?? null;
        return { ...c, scheduleCount: counts.schedules, draftCount: counts.drafts, runnable: isCampaignRunnable(c, now), summary };
    };
    /** An employee-scoped call reaches only campaigns whose every profile is in scope (empty ones too); anything else looks absent. */
    const inScope = (id: string, scope: readonly string[] | undefined): boolean => {
        if (scope === undefined) return true;
        if (!deps.campaignProfiles) throw new Error('Không đọc được phạm vi chiến dịch');
        return (deps.campaignProfiles(id) ?? []).every((profile) => scope.includes(profile));
    };
    const requireCampaign = (store: FacebookPosterStore, id: unknown, scope?: readonly string[]): FbPosterCampaign => {
        const c = typeof id === 'string' && id ? store.getCampaign(id) : null;
        if (!c || !inScope(c.id, scope)) throw new Error('Không tìm thấy chiến dịch');
        return c;
    };
    return {
        list: (params?: any) => {
            const status = params?.status;
            if (status !== undefined && !STATUSES.includes(status)) throw new Error('Trạng thái chiến dịch không hợp lệ');
            const store = deps.store();
            const scope = readProfileScope(params);
            return { campaigns: store.listCampaigns(status ? { status } : {}).filter((c) => inScope(c.id, scope)).map((c) => view(store, c, scope)) };
        },

        get: (params?: any) => {
            const store = deps.store();
            const scope = readProfileScope(params);
            const campaign = requireCampaign(store, params?.id, scope);
            const schedules = store.listSchedules({ campaignId: campaign.id, profileIds: scope }).map((s) => ({
                id: s.id, name: s.name, kind: s.kind, enabled: s.enabled, draft: s.draft, nextRunAt: s.nextRunAt,
            }));
            return { campaign: { ...view(store, campaign, scope), schedules } };
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
            const scope = readProfileScope(params);
            const existing = requireCampaign(store, params?.id, scope);
            const input = validateCampaignInput(params ?? {}, { existing, findByName: (n) => store.findCampaignByName(n) });
            store.transaction(db => {
                const now=deps.now();
                store.updateCampaign(existing.id, input, now);
                invalidateManagedCampaign(db,existing.id,now);
            });
            deps.reschedule();
            return { campaign: view(store, store.getCampaign(existing.id)!, scope) };
        },

        delete: (params?: any) => {
            const store = deps.store();
            const campaign = requireCampaign(store, params?.id, readProfileScope(params));
            const counts = store.countCampaignSchedules(campaign.id);
            const total = counts.schedules + counts.drafts;
            if (total > 0) throw new Error(`Chiến dịch còn ${total} lịch/bài nháp, hãy chuyển hoặc xoá trước`);
            store.transaction(db => {
                invalidateManagedCampaign(db,campaign.id,deps.now(),true);
                store.deleteCampaign(campaign.id);
            });
            deps.reschedule();
            return { deleted: true };
        },
    };
}
