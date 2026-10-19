import { dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { ResearchService } from '../../src/services/research/ResearchService';
import { MAX_LIMIT, ResearchStore } from '../../src/services/research/ResearchStore';
import { GraphqlSession } from '../../src/services/research/graphqlSession';
import {
    RESEARCH_CONFIG_SETTING_KEY, parseResearchConfig, validateResearchConfig,
} from '../../src/services/research/researchConfig';
import {
    SCAN_NOT_FOUND_ERROR, buildSheetRows, checkProfileIds, exportFileName, parseGetParams, parseListParams, safeFacebookUrl,
} from '../../src/services/research/researchOperationsLogic';
import type { ResearchItem, ResearchOrigin } from '../../src/models/research';
import { buildResearchFinished, emitControlEvent } from '../../src/services/control/controlEvents';
import { getBrowserProfileService } from './browserProfileIpc';
import { isWorkspaceSwitchInProgress } from './workspaceIpc';
import {
    isFacebookPosterEmployeeBlocked, listFacebookLoginStates, listFacebookPosterRunProfileIds, observeFacebookLogin,
} from './facebookPosterIpc';

export const WORKSPACE_SWITCHING_ERROR = 'Đang đổi workspace, thử lại sau';
export const INVALID_LINK_ERROR = 'Link không hợp lệ: chỉ mở được link Facebook (https).';
export const RESEARCH_NOT_STOPPED_ERROR = 'Lượt quét Nghiên cứu chưa dừng được. Thử lại sau.';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 180 * DAY_MS;
const STOP_GRACE_MS = 20000;

let service: ResearchService | null = null;
let preparedDbPath: string | null = null;
// Profile do chính lượt quét đang mở: không tính là "bận" khi chọn profile kế tiếp.
const openedByResearch = new Set<string>();

function db(): DatabaseService {
    return DatabaseService.getInstance();
}

/** Store trên DB workspace hiện tại; mỗi DB chỉ chuẩn bị một lần (schema, lượt dở dang, dọn dữ liệu cũ). */
function store(): ResearchStore {
    const s = new ResearchStore(db());
    const dbPath = db().getDbPath();
    if (dbPath !== preparedDbPath) {
        const now = Date.now();
        s.ensureSchema();
        s.failInterruptedScans(now);
        s.pruneOlderThan(now - RETENTION_MS);
        preparedDbPath = dbPath;
        // Service gắn với một store: DB mới thì cần service mới (không bao giờ khi đang quét).
        if (service && !service.isRunning()) service = null;
    }
    return s;
}

function profileList(): { id: string; name: string }[] {
    return db().getBrowserProfiles().map((p) => ({ id: p.id, name: p.name }));
}

function isBusy(id: string): boolean {
    return (getBrowserProfileService().isRunning(id) && !openedByResearch.has(id)) || listFacebookPosterRunProfileIds().includes(id);
}

function readConfig() {
    return parseResearchConfig(db().getSetting(RESEARCH_CONFIG_SETTING_KEY));
}

function getService(): ResearchService {
    const researchStore = store();
    if (!service) {
        service = new ResearchService({
            store: researchStore,
            openSession: async (profileId) => {
                openedByResearch.add(profileId);
                try {
                    const session = await getBrowserProfileService().openForAutomation(profileId);
                    const page = session.context.pages()[0] ?? await session.context.newPage();
                    return {
                        session: new GraphqlSession(page, researchStore),
                        close: async () => { try { await session.close(); } finally { openedByResearch.delete(profileId); } },
                    };
                } catch (err) {
                    openedByResearch.delete(profileId);
                    throw err;
                }
            },
            listProfiles: profileList,
            // Bận = đang mở trình duyệt (kể cả đang kiểm tra đăng nhập, vì kiểm tra cũng mở profile) hoặc nằm trong lượt Đăng Facebook hiện tại.
            isProfileBusy: isBusy,
            loginStates: listFacebookLoginStates,
            groupMembership: () => {
                const groups = new FacebookPosterStore(db()).listGroups(profileList().map((p) => p.id));
                const out: Record<string, { url: string; scannedAt: number | null }[]> = {};
                for (const [id, rows] of Object.entries(groups)) out[id] = rows.map((g) => ({ url: g.url, scannedAt: g.scannedAt ?? null }));
                return out;
            },
            observeLogin: observeFacebookLogin,
            readConfig,
            emit: (channel, data) => {
                EventBroadcaster.emit(channel, data);
                if (channel === 'research:finished') emitControlEvent('research.finished', buildResearchFinished(data as any));
            },
        });
    }
    return service;
}

/** Huỷ lượt quét đang chạy (khi thoát app). */
export function cancelResearch(): void {
    service?.stop();
}

/** Huỷ và chờ (tối đa 20 giây) để lượt quét không ghi vào DB workspace kế tiếp. True = không còn lượt nào chạy. Không ném lỗi. */
export async function cancelAndWaitResearch(): Promise<boolean> {
    const current = service;
    if (!current?.isRunning()) return true;
    current.cancel();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_GRACE_MS); timer.unref?.(); });
    await Promise.race([current.whenIdle().catch(() => undefined), timedOut]);
    clearTimeout(timer);
    return !current.isRunning();
}

/** Handler bodies dùng chung cho IPC và Control API. Người gọi lo chặn chế độ nhân viên và phong bì kết quả. */
export const researchOperations = {
    getConfig: () => ({ config: readConfig() }),

    setConfig: (params: any) => {
        const config = validateResearchConfig(params);
        db().setSetting(RESEARCH_CONFIG_SETTING_KEY, JSON.stringify(config));
        return { config };
    },

    search: (params: any, origin: ResearchOrigin) => {
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const profileIds = checkProfileIds(params?.profileIds, profileList().map((p) => p.id));
        return getService().search({
            source: params?.source, query: params?.query, recent: params?.recent, year: params?.year,
            limit: params?.limit, profileIds, origin,
        });
    },

    scanGroupFeeds: (params: any, origin: ResearchOrigin) => {
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const profileIds = checkProfileIds(params?.profileIds, profileList().map((p) => p.id));
        return getService().scanGroupFeeds({
            groupUrls: params?.groupUrls, sinceDays: params?.sinceDays, limitPerGroup: params?.limitPerGroup, profileIds, origin,
        });
    },

    list: (params?: any) => {
        const opts = parseListParams(params);
        const s = store();
        return { total: s.countScans(opts.source), scans: s.listScans(opts) };
    },

    get: (params: any) => {
        const opts = parseGetParams(params);
        const s = store();
        const scan = s.getScan(opts.scanId);
        if (!scan) throw new Error(SCAN_NOT_FOUND_ERROR);
        const { total, items } = s.listItems(opts.scanId, opts);
        return { scan, total, items };
    },

    cancel: () => ({ cancelled: service?.cancel() ?? false }),

    status: () => service?.status() ?? { running: false, scanId: null },

    /** Mở link lấy từ dữ liệu quét (không tin cậy): chỉ https tới facebook.com. */
    openLink: async (params: any) => {
        const url = safeFacebookUrl(params?.url);
        if (!url) throw new Error(INVALID_LINK_ERROR);
        await shell.openExternal(url);
        return {};
    },
};

function profileUsage() {
    const s = store();
    const cfg = readConfig();
    const since = Date.now() - DAY_MS;
    const states = new Map(listFacebookLoginStates().map((l) => [l.profileId, l.state]));
    return profileList().map((p) => ({
        id: p.id,
        name: p.name,
        itemsLast24h: s.itemsCapturedSince(p.id, since),
        cap: cfg.perProfileDailyCap,
        loginState: states.get(p.id) ?? 'unknown',
        excluded: cfg.excludedProfileIds.includes(p.id),
        busy: isBusy(p.id),
    }));
}

async function exportXlsx(params: any): Promise<{ saved: boolean; path?: string }> {
    const scanId = typeof params?.scanId === 'string' ? params.scanId : '';
    const s = store();
    const scan = scanId ? s.getScan(scanId) : undefined;
    if (!scan) throw new Error(SCAN_NOT_FOUND_ERROR);
    const result = await dialog.showSaveDialog({
        defaultPath: exportFileName(scan.source, Date.now()),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    // Xuất toàn bộ mục của lượt quét, đọc từng trang MAX_LIMIT (store giới hạn mỗi lần đọc).
    const items: ResearchItem[] = [];
    for (;;) {
        const page = s.listItems(scanId, { sort: 'engagement', limit: MAX_LIMIT, offset: items.length });
        items.push(...page.items);
        if (page.items.length === 0 || items.length >= page.total) break;
    }
    const rows = buildSheetRows(scan.source, items);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Nghiên cứu');
    await fs.promises.writeFile(result.filePath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
    return { saved: true, path: result.filePath };
}

/** Cùng chặn chế độ nhân viên và phong bì kết quả như facebookPosterIpc. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (isFacebookPosterEmployeeBlocked()) {
                return { success: false, error: 'Tính năng Nghiên cứu chủ đề chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            Logger.error(`[researchIpc] ${channel} error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

export function registerResearchIpc(): void {
    handle('research:getConfig', researchOperations.getConfig);
    handle('research:setConfig', researchOperations.setConfig);
    handle('research:search', (p) => researchOperations.search(p, 'manual'));
    handle('research:scanGroupFeeds', (p) => researchOperations.scanGroupFeeds(p, 'manual'));
    handle('research:list', researchOperations.list);
    handle('research:get', researchOperations.get);
    handle('research:cancel', researchOperations.cancel);
    handle('research:status', researchOperations.status);
    handle('research:openLink', researchOperations.openLink);
    handle('research:profileUsage', () => ({ profiles: profileUsage() }));
    handle('research:exportXlsx', exportXlsx);
}
