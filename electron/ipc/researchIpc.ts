import { dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { ResearchService } from '../../src/services/research/ResearchService';
import { MAX_LIMIT, ResearchStore } from '../../src/services/research/ResearchStore';
import { parseTrendingParams, rankTrending } from '../../src/services/research/trending';
import { GraphqlSession } from '../../src/services/research/graphqlSession';
import { readPageIdentity } from '../../src/services/dailyBrief/pageIdentity';
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
    assertFacebookJobAdmission, getProfileJobBinding, getBoundFacebookLoginObserver, isFacebookPosterEmployeeBlocked, listFacebookLoginStates, listFacebookPosterRunProfileIds,
} from './facebookPosterIpc';

export const WORKSPACE_SWITCHING_ERROR = 'Đang đổi workspace, thử lại sau';
export const INVALID_LINK_ERROR = 'Link không hợp lệ: chỉ mở được link Facebook (https).';
export const RESEARCH_NOT_STOPPED_ERROR = 'Lượt quét Nghiên cứu chưa dừng được. Thử lại sau.';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 180 * DAY_MS;
const STOP_GRACE_MS = 20000;

let service: ResearchService | null = null;
let preparedDbPath: string | null = null;

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

/** Store Nghiên cứu của workspace hiện tại; theo dõi bài dùng chung bảng research_queries. */
export function getResearchStore(): ResearchStore {
    return store();
}

export function isResearchRunning(): boolean { return service?.isRunning() ?? false; }

function profileList(): { id: string; name: string }[] {
    return db().getBrowserProfiles().map((p) => ({ id: p.id, name: p.name }));
}

function isBusy(id: string): boolean {
    return getBrowserProfileService().isRunning(id) || listFacebookPosterRunProfileIds().includes(id);
}

function readConfig() {
    return parseResearchConfig(db().getSetting(RESEARCH_CONFIG_SETTING_KEY));
}

/** Trusted main-process consumers only; ownership controls never come from request payloads. */
export function getResearchService(): ResearchService {
    if (!service) assertFacebookJobAdmission();
    const researchStore = store();
    if (!service) {
        assertFacebookJobAdmission();
        const boundDb = db();
        const boundPath = boundDb.getDbPath();
        const binding = getProfileJobBinding();
        const boundProfiles = () => boundDb.getBrowserProfiles().map(p => ({ id: p.id, name: p.name }));
        const posterStore = new FacebookPosterStore(boundDb);
        const observer = getBoundFacebookLoginObserver();
        let stale = false;
        let instance: ResearchService;
        const assertCurrent = () => {
            if (service !== instance) throw new Error(WORKSPACE_SWITCHING_ERROR);
            binding.assertCurrent();
            stale ||= db() !== boundDb || db().getDbPath() !== boundPath || isWorkspaceSwitchInProgress();
            if (stale) throw new Error(WORKSPACE_SWITCHING_ERROR);
            if (isFacebookPosterEmployeeBlocked()) throw new Error('Nghiên cứu không khả dụng ở chế độ nhân viên.');
        };
        instance = new ResearchService({
            store: researchStore,
            assertCanStart: assertFacebookJobAdmission,
            assertCurrent,
            openSession: async (profileId, guard, context) => {
                guard();
                let session: Awaited<ReturnType<ReturnType<typeof getBrowserProfileService>['openForAutomation']>> | undefined;
                try {
                    session = await binding.openForAutomation(profileId, context);
                    guard();
                    const page = session.context.pages()[0] ?? await session.context.newPage();
                    guard();
                    const opened = session;
                    return {
                        session: new GraphqlSession(page, {
                            getQuery: (...args) => { guard(); return researchStore.getQuery(...args); },
                            saveQuery: (...args) => { guard(); return researchStore.saveQuery(...args); },
                        }, { assertCurrent: guard }),
                        readIdentity: async () => {
                            guard();
                            const identity = await readPageIdentity(page, { assertCurrent: guard });
                            guard();
                            return identity;
                        },
                        close: () => opened.close(),
                    };
                } catch (err) {
                    try { await session?.close(); } catch { /* startup cleanup must preserve the original error */ }
                    throw err;
                }
            },
            listProfiles: boundProfiles,
            isProfileBusy: binding.isProfileBusy,
            loginStates: () => posterStore.listLoginStates(),
            groupMembership: () => {
                const groups = posterStore.listGroups(boundProfiles().map((p) => p.id));
                const out: Record<string, { url: string; scannedAt: number | null }[]> = {};
                for (const [id, rows] of Object.entries(groups)) out[id] = rows.map((g) => ({ url: g.url, scannedAt: g.scannedAt ?? null }));
                return out;
            },
            observeLogin: observer,
            readConfig: () => parseResearchConfig(boundDb.getSetting(RESEARCH_CONFIG_SETTING_KEY)),
            emit: (channel, data) => {
                try { assertCurrent(); } catch { return; }
                EventBroadcaster.emit(channel, data);
                if (channel === 'research:finished') emitControlEvent('research.finished', buildResearchFinished(data as any));
            },
        });
        service = instance;
    }
    return service;
}

/** Called by the aggregate only after every owner has settled, before DB retarget. */
export function retireResearchService(): void {
    if (service?.isRunning()) throw new Error(RESEARCH_NOT_STOPPED_ERROR);
    service = null;
    preparedDbPath = null;
}

/** Cleanup must not create a service after admission has paused, including historical persisted scan IDs. */
export function cancelOwnedResearchScan(scanId: string): boolean {
    return service?.cancelOwned(scanId) ?? false;
}

/** Huỷ lượt quét đang chạy (khi thoát app). */
export function cancelResearch(): void {
    service?.stop();
}

/** Huỷ và chờ (tối đa 20 giây) để lượt quét không ghi vào DB workspace kế tiếp. True = không còn lượt nào chạy. Không ném lỗi. */
export async function cancelAndWaitResearch(): Promise<boolean> {
    const current = service;
    if (!current?.isRunning()) { service = null; return true; }
    let timer: NodeJS.Timeout | undefined;
    try {
        current.cancel();
        const settled = await Promise.race([
            current.whenIdle().then(() => true, () => false),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), STOP_GRACE_MS); timer.unref?.(); }),
        ]);
        const idle = settled && !current.isRunning();
        if (idle && service === current) service = null;
        return idle;
    } catch { return false; }
    finally { clearTimeout(timer); }
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
        assertFacebookJobAdmission();
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const profileIds = checkProfileIds(params?.profileIds, profileList().map((p) => p.id));
        return getResearchService().search({
            source: params?.source, query: params?.query, recent: params?.recent, year: params?.year,
            limit: params?.limit, profileIds, origin,
        });
    },

    scanGroupFeeds: (params: any, origin: ResearchOrigin) => {
        assertFacebookJobAdmission();
        if (isWorkspaceSwitchInProgress()) throw new Error(WORKSPACE_SWITCHING_ERROR);
        const profileIds = checkProfileIds(params?.profileIds, profileList().map((p) => p.id));
        return getResearchService().scanGroupFeeds({
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

    trending: (p: any) => {
        const { queries, groupIds, sinceHours, limit } = parseTrendingParams(p);
        const now = Date.now();
        const rows = store().trendingRows({ queries, groupIds, since: now - sinceHours * 3600000 });
        return { items: rankTrending(rows, now, limit) };
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
