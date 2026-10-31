import { app, ipcMain, safeStorage } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { ControlStore } from '../../src/services/control/ControlStore';
import { ControlEventRecorder } from '../../src/services/control/ControlEventRecorder';
import { IdempotencyCache } from '../../src/services/control/IdempotencyCache';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import { scopedRequestHash, validateScopedKeyPolicy, type ScopedKeyPolicy } from '../../src/services/control/controlAuthorization';
import { isWorkspaceSwitchInProgress } from './workspaceIpc';
import { PairingTickets } from '../../src/services/control/PairingTickets';
import { AuthLockout, RateLimiter } from '../../src/services/control/controlSecurity';
import { ControlApiServer } from '../../src/services/control/ControlApiServer';
import { createControlMethods, ControlError, type ControlContext, type PosterPort } from '../../src/services/control/ControlMethods';
import { createPageOperationMethods } from '../../src/services/control/pageOperationMethods';
import type { ControlPrincipal, PageContext } from '../../src/models/pageOperations';
import { PageWorkStore } from '../../src/services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../src/services/dailyBrief/PageCampaignStore';
import { PageBusinessStore } from '../../src/services/dailyBrief/PageBusinessStore';
import { DailyBriefStore } from '../../src/services/dailyBrief/DailyBriefStore';
import { FacebookPosterStore } from '../../src/services/facebookPoster/FacebookPosterStore';
import { assertPagePreparationIdle } from '../../src/services/dailyBrief/pageWorkOperations';
import { createCertificate } from '../../src/services/control/certificate';
import { CertificateKeyUnreadableError, CertificateStore } from '../../src/services/control/CertificateStore';
import { toSafeProfiles } from '../../src/services/control/controlProfiles';
import {
    CONTROL_CONFIG_SETTING_KEY, ControlConfigError, buildFirewallCommand, buildInstallCommand, buildPairingCode, detectPublicIpv4, parseBotIp, parseStoredConfig, validatePublicHost, withStoredPublicHost, resolveAppVersion, validateConfigInput, type ControlConfig,
} from '../../src/services/control/controlConfig';
import { getBoundPageCampaignCollector, setPageCampaignExecutionContext, stopPageCampaignExecution, checkFacebookLogins, listFacebookLoginStates, isFacebookPosterEmployeeBlocked, isFacebookPosterSchedulerRunning, createBoundPageWorkDependencies, createBoundPageApprovalDependencies, posterOperations, trackingOperations, campaignOperations, leadOperations } from './facebookPosterIpc';
import { researchOperations, cancelOwnedResearchScan } from './researchIpc';
import { briefOperations, pageOperations, getDailyBriefStore } from './dailyBriefIpc';
import { videoOperations } from './videoIpc';
import { getInboxMediaStore } from './inboxMedia';
import { getBrowserEngineStatus, getBrowserProfileService, getBrowserSandboxState } from './browserProfileIpc';

const HOUR_MS = 3_600_000;
const MODE_CHECK_MS = 15_000;
const BIND_HOST = '0.0.0.0';
const MAX_KEY_NAME = 60;

interface Runtime {
    server: ControlApiServer;
    store: ControlStore;
    timers: NodeJS.Timeout[];
}

let runtime: Runtime | null = null;
let lastError: string | null = null;
let queue: Promise<void> = Promise.resolve();
let modeTimer: NodeJS.Timeout | null = null;
let lastBlocked = false;
let quitting = false;
let workspaceGeneration = 0;
const protectedCalls = new Set<Promise<unknown>>();
let pageScope: { db: DatabaseService; dbPath: string; workspaceId: string; retired: boolean; works: PageWorkStore } | null = null;
export const PAGE_PREPARATION_NOT_STOPPED_ERROR = 'Công việc Page chưa dừng an toàn. Thử lại sau.';
function workPageIds(boundDb: DatabaseService, workspaceId: string): string[] {
    const params = [workspaceId];
    const rows = boundDb.query<{ page_id: string }>('SELECT DISTINCT page_id FROM page_work_items WHERE workspace_id = ?', params);
    const count = boundDb.queryOne<{ n: number }>('SELECT COUNT(DISTINCT page_id) AS n FROM page_work_items WHERE workspace_id = ?', params);
    if (!count || count.n !== rows.length) throw new ControlError('INTERNAL', 'Không đọc đủ công việc Page');
    return rows.map(row => row.page_id);
}

/** Retire authority synchronously; never let an owned await outlive the actual DB connection. */
export async function stopPagePreparationForWorkspaceSwitch(timeoutMs = 20000): Promise<boolean> {
    workspaceGeneration++;
    const generation = workspaceGeneration;
    const scope = pageScope;
    if (scope) scope.retired = true;
    recorder.notifier?.notify();
    if (!await stopPageCampaignExecution()) return false;
    if (!scope) return protectedCalls.size === 0;
    try {
        if (db() !== scope.db || db().getDbPath() !== scope.dbPath) return false;
        const items = scope.works.list(workPageIds(scope.db, scope.workspaceId));
        for (const item of items) {
            if (item.workspaceId !== scope.workspaceId) continue;
            if (item.status === 'running') scope.works.invalidateLease(item.id, Date.now());
            else if (['pending', 'waiting'].includes(item.status) && scope.works.hasUnresolvedSteps(item.id)) scope.works.stopPreparation(item.id, 'needs_review', Date.now());
            if (item.researchId) cancelOwnedResearchScan(item.researchId);
        }
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([Promise.allSettled([...protectedCalls]), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
        } finally { clearTimeout(timer); }
        if (protectedCalls.size || generation !== workspaceGeneration || db() !== scope.db || db().getDbPath() !== scope.dbPath) return false;
        for (const item of items) assertPagePreparationIdle(scope.db, item.id);
        return true;
    } catch { return false; }
}
const recorder = new ControlEventRecorder();
const poster: PosterPort = posterOperations;
/** Mức module: vé ghép nối phải sống qua mọi lần apply() dừng/chạy lại server. */
const pairing = new PairingTickets();
let bridge: { buffer: Buffer; sha256: string } | null = null;

const db = () => DatabaseService.getInstance();
const controlDir = () => path.join(app.getPath('userData'), 'control-api');
const appVersion = () => resolveAppVersion({
    reported: app.getVersion(),
    // __dirname = dist-electron/electron/ipc khi build: ba cấp lên là gốc repo. Bản đóng gói đọc package.json trong app.
    packageJsonPaths: [path.join(__dirname, '..', '..', '..', 'package.json'), path.join(app.getAppPath(), 'package.json')],
    readFile: (file) => fs.readFileSync(file, 'utf8'),
});

/** Bản đóng gói: resources/maihub-bridge; chạy dev: gốc repo (cùng cách dò package.json ở appVersion). */
function loadBridge(): void {
    const candidates = [
        ...(process.resourcesPath ? [path.join(process.resourcesPath, 'maihub-bridge', 'maihub_bridge.py')] : []),
        path.join(__dirname, '..', '..', '..', 'tools', 'maihub-bridge', 'maihub_bridge.py'),
    ];
    bridge = null;
    for (const file of candidates) {
        try {
            const buffer = fs.readFileSync(file);
            bridge = { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
            return;
        } catch { /* thử đường dẫn kế tiếp */ }
    }
    Logger.error(`[controlApi] không tìm thấy tệp maihub_bridge.py đi kèm, đã thử: ${candidates.join(' | ')}`);
}

const inbox = getInboxMediaStore;
const currentStore = () => new ControlStore(db());

let certStoreInstance: CertificateStore | null = null;
/** Lazy: built on first use so importing this module needs no Electron app/safeStorage (workspaceIpc imports it). */
function certStoreOf(): CertificateStore {
    certStoreInstance ??= new CertificateStore(
        controlDir(),
        {
            isAvailable: () => safeStorage.isEncryptionAvailable(),
            encrypt: (plain) => safeStorage.encryptString(plain),
            decrypt: (data) => safeStorage.decryptString(data),
            isWeak: () => process.platform === 'linux' && (safeStorage as any).getSelectedStorageBackend?.() === 'basic_text',
        },
        createCertificate,
    );
    return certStoreInstance;
}

function readConfig(): ControlConfig {
    return parseStoredConfig(db().getSetting(CONTROL_CONFIG_SETTING_KEY));
}

/** Local provisioning must not carry a policy across workspace/identity changes. */
function assertProvisioningCurrent(workspaceId: string, dbPath: string, policy?: ScopedKeyPolicy): void {
    if (isFacebookPosterEmployeeBlocked()) throw new Error('Control API chỉ dùng được ở chế độ Boss/Standalone');
    if (isWorkspaceSwitchInProgress() || !workspaceId || WorkspaceManager.getInstance().getActiveWorkspace()?.id !== workspaceId || db().getDbPath() !== dbPath) {
        throw new Error('Workspace đã đổi hoặc đang chuyển, hãy tải lại phạm vi khoá');
    }
    if (!policy) return;
    if (policy.workspaceId !== workspaceId) throw new Error('Phạm vi khoá không thuộc workspace đang mở');
    const identities = getDailyBriefStore().listIdentities();
    for (const assignment of policy.assignments) {
        for (const profileId of assignment.profileIds) {
            if (!db().getBrowserProfileById(profileId) || !identities.some(identity => identity.profileId === profileId && identity.kind === 'page' && identity.pageId === assignment.pageId)) {
                throw new Error('Page/profile chưa được học hoặc không còn khớp phạm vi khoá');
            }
        }
    }
}

function provisioningContext(inputPolicy: unknown) {
    const policy = inputPolicy === undefined ? undefined : validateScopedKeyPolicy(inputPolicy);
    const workspaceId = WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? '';
    const dbPath = db().getDbPath();
    const generation = workspaceGeneration;
    const assertCurrent = () => {
        if (generation !== workspaceGeneration) throw new Error('Workspace đã đổi, hãy tải lại cấu hình');
        assertProvisioningCurrent(workspaceId, dbPath, policy);
    };
    assertCurrent();
    return { policy, assertCurrent, workspaceId, workspaceGeneration: generation };
}

function describeBindError(err: any, port: number): string {
    if (err?.code === 'EADDRINUSE') return `Cổng ${port} đang được chương trình khác dùng, hãy chọn cổng khác`;
    if (err?.code === 'EACCES') return `Không có quyền mở cổng ${port}`;
    return `Không khởi động được Control API: ${err?.message ?? err}`;
}

async function stopRuntime(): Promise<void> {
    if (pageScope) pageScope.retired = true;
    recorder.notifier?.notify();
    if (!await stopPageCampaignExecution()) throw new Error(PAGE_PREPARATION_NOT_STOPPED_ERROR);
    const current = runtime;
    runtime = null;
    if (!current) return;
    current.timers.forEach(clearInterval);
    await current.server.stop();
}

/** Startup/hourly maintenance on the captured current DB only. Never follows a retired singleton handle. */
function housekeeping(store: ControlStore, works: PageWorkStore, workspaceId: string, assertCurrent: () => void): void {
    try { assertCurrent(); } catch { return; }
    try { inbox().cleanup(Date.now()); } catch (err) { Logger.error(`[controlApi] inbox cleanup failed: ${(err as Error).message}`); }
    try { store.pruneOld(Date.now()); } catch (err) { Logger.error(`[controlApi] prune failed: ${(err as Error).message}`); }
    try { works.prune(Date.now(), workspaceId); } catch (err) { Logger.error(`[controlApi] work prune failed: ${(err as Error).message}`); }
}

async function startRuntime(config: ControlConfig): Promise<void> {
    const store = currentStore();
    const notifier = recorder.notifier;
    const mediaStore = inbox();
    const profiles = () => getBrowserProfileService();
    const methods = createControlMethods({
        poster,
        briefs: briefOperations,
        pages: pageOperations,
        protectedWritesEnabled: () => readConfig().protectedWritesEnabled,
        research: {
            search: (p) => researchOperations.search(p, 'api'),
            scanGroupFeeds: (p) => researchOperations.scanGroupFeeds(p, 'api'),
            list: researchOperations.list,
            get: researchOperations.get,
            trending: researchOperations.trending,
            cancel: researchOperations.cancel,
        },
        tracking: {
            track: (p) => trackingOperations.track(p, false),
            status: trackingOperations.status,
            cancel: trackingOperations.cancel,
            list: trackingOperations.list,
            stats: trackingOperations.stats,
            groupScores: trackingOperations.groupScores,
            bestTimes: trackingOperations.bestTimes,
            getConfig: trackingOperations.getConfig,
            setConfig: trackingOperations.setConfig,
        },
        campaigns: {
            list: campaignOperations.list,
            get: campaignOperations.get,
            create: campaignOperations.create,
            update: campaignOperations.update,
            delete: campaignOperations.delete,
        },
        leads: {
            list: leadOperations.list,
            update: leadOperations.update,
            getConfig: leadOperations.getConfig,
            setConfig: leadOperations.setConfig,
            collect: leadOperations.collect,
            collectStatus: leadOperations.collectStatus,
            collectCancel: leadOperations.collectCancel,
            comments: leadOperations.comments,
        },
        videos: {
            templates: videoOperations.templates,
            render: (p) => videoOperations.render(p, 'bot'),
            adCreate: (p) => videoOperations.adCreate(p, 'bot'),
            status: (p) => videoOperations.status(p, 'bot'),
            list: (p) => videoOperations.list(p, 'bot'),
            cancel: videoOperations.cancel,
        },
        listProfiles: () => {
            const list = db().getBrowserProfiles();
            const scanned = poster.listGroups({ profileIds: list.map((p) => p.id) }).groups;
            return toSafeProfiles(list, db().getBrowserProfileGroups(), profiles().getRunningIds(), scanned, listFacebookLoginStates());
        },
        checkLogins: (ids) => checkFacebookLogins(ids, 'api'),
        systemStatus: async () => {
            const ws = WorkspaceManager.getInstance().getActiveWorkspace();
            return {
                appVersion: appVersion(),
                workspace: ws ? { id: ws.id, name: ws.name } : null,
                browserEngine: getBrowserEngineStatus(),
                sandbox: await getBrowserSandboxState().catch(() => 'unknown' as const),
                schedulerRunning: isFacebookPosterSchedulerRunning(),
                currentRun: poster.current(),
            };
        },
        resolveMedia: (ids) => mediaStore.resolve(ids),
        events: { listEventsAfter: (s, l) => store.listEventsAfter(s, l), waitForEvent: (a, t, sig) => notifier.waitForEvent(a, t, sig), workspaceId: () => WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? null, lastSeq: () => store.lastEventSeq() },
    });
    const boundDb = db(); const boundPath = boundDb.getDbPath();
    const workspaceId = WorkspaceManager.getInstance().getActiveWorkspace()?.id ?? '';
    const generation = workspaceGeneration;
    const works = new PageWorkStore(boundDb); works.ensureSchema();
    const campaigns = new PageCampaignStore(boundDb); campaigns.ensureSchema(); campaigns.registerSettledResults(workspaceId);
    const boundControl = new ControlStore(boundDb);
    const business = new PageBusinessStore(boundDb); const briefs = new DailyBriefStore(boundDb);
    const scope = { db: boundDb, dbPath: boundPath, workspaceId, retired: false, works };
    pageScope = scope;
    const deny = (): never => { throw new ControlError('FORBIDDEN', 'Không có quyền thực hiện thao tác này'); };
    const assertRuntimeCurrent = () => {
        if (quitting || scope.retired || generation !== workspaceGeneration || isWorkspaceSwitchInProgress()
            || isFacebookPosterEmployeeBlocked() || db() !== boundDb || boundDb.getDbPath() !== boundPath
            || WorkspaceManager.getInstance().getActiveWorkspace()?.id !== workspaceId) deny();
    };
    setPageCampaignExecutionContext({db:boundDb,baseDir:path.dirname(boundPath),workspaceId,assertCurrent:assertRuntimeCurrent,now:Date.now,
        profileExists:id=>!!boundDb.getBrowserProfileById(id),
        protectedWritesEnabled:()=>{assertRuntimeCurrent(); return parseStoredConfig(boundDb.getSetting(CONTROL_CONFIG_SETTING_KEY)).protectedWritesEnabled;}});
    // Crash/restart recovery is journal-only: no render, media adoption or agent invocation at startup.
    for (const item of works.list(workPageIds(boundDb, workspaceId))) {
        if (item.workspaceId !== workspaceId) continue;
        if (item.status === 'running') works.invalidateLease(item.id, Date.now());
        else if (['pending', 'waiting'].includes(item.status) && works.hasUnresolvedSteps(item.id)) works.stopPreparation(item.id, 'needs_review', Date.now());
    }
    const authorizationResources = (principal: Exclude<ControlPrincipal, { kind: 'legacy' }>) => {
        const assertCurrent = () => {
            assertRuntimeCurrent();
            const active = boundControl.findActiveKeyById(principal.keyId);
            if (!active?.policy || scopedRequestHash({...active.policy, keyId:active.id}, '', {}) !== scopedRequestHash(principal, '', {})) deny();
            if (principal.workspaceId !== workspaceId || principal.assignments.some(a => a.profileIds.some(id => !boundDb.getBrowserProfileById(id)))) deny();
        };
        assertCurrent();
        const pageAllowed = (pageId: unknown) => principal.assignments.some(a => a.pageId === pageId);
        const scopedWork = (id: unknown, pageId: unknown) => {
            const row = typeof id === 'string' ? works.get(id) : null;
            if (!row || row.workspaceId !== workspaceId || row.pageId !== pageId
                || !principal.assignments.some(a => a.pageId === row.pageId && a.profileIds.includes(row.profileId))) deny();
            return row;
        };
        return { workspaceId, assertCurrent,
            protectedWritesEnabled: () => { assertCurrent(); return parseStoredConfig(boundDb.getSetting(CONTROL_CONFIG_SETTING_KEY)).protectedWritesEnabled; },
            getPageIdentity: (id: string) => { assertCurrent(); return briefs.getIdentity(id) ?? null; },
            getWork: (id: string) => { assertCurrent(); return works.get(id); },
            getResourceOwner: (ref: Parameters<PageWorkStore['getResourceOwner']>[0]) => { assertCurrent(); return works.getResourceOwner(ref); },
            getCampaignResource: (kind: 'campaign' | 'proposal' | 'grant', id: string) => {
                assertCurrent(); return kind === 'campaign' ? campaigns.getLink(id) : kind === 'proposal' ? campaigns.getProposal(id) : campaigns.getGrant(id);
            },
            authorizeApproval: (method: string, p: Record<string, any>) => {
                assertCurrent(); if (principal.kind !== 'page_receiver') return deny();
                if (method === 'pageApprovals.prepare') {
                    const action = p.action;
                    if (!action || typeof action !== 'object' || !pageAllowed(action.pageId)) deny();
                    if (action.workId !== undefined) scopedWork(action.workId, action.pageId);
                    if (action.kind === 'approveDraft' || action.kind === 'linkResource') {
                        const ref = action.kind === 'approveDraft' ? { kind: 'draft' as const, id: action.draftId } : action.resource;
                        if (!ref || typeof ref.id !== 'string' || !['draft','research','video','media','campaign'].includes(ref.kind)) deny();
                        const owner = works.getResourceOwner(ref);
                        if (!owner || owner.workspaceId !== workspaceId || owner.pageId !== action.pageId || (action.workId !== undefined && owner.workId !== action.workId)) deny();
                        if (action.kind === 'approveDraft') {
                            const draft = new FacebookPosterStore(boundDb).getSchedule(ref.id); const profiles = draft?.params.profiles;
                            if (!draft || draft.params.mode !== 'page' || !Array.isArray(profiles) || profiles.length !== 1) deny();
                            const entry = profiles[0] as { profileId?: unknown; targets?: unknown };
                            const identity = typeof entry?.profileId === 'string' ? briefs.getIdentity(entry.profileId) : null;
                            if (!identity || identity.kind !== 'page' || identity.pageId !== action.pageId
                                || !principal.assignments.some(a => a.pageId === action.pageId && a.profileIds.includes(identity.profileId))
                                || !Array.isArray(entry.targets) || entry.targets.length !== 1 || entry.targets[0] !== 'https://www.facebook.com/') deny();
                        } else scopedWork(owner.workId, action.pageId);
                    }
                    if (action.kind === 'confirmFact' && action.factId !== undefined && !business.get(action.pageId)?.facts.some(f => f.id === action.factId)) deny();
                    if (action.kind === 'setPrimaryProfile') {
                        const identity = typeof action.profileId === 'string' ? briefs.getIdentity(action.profileId) : null;
                        if (!identity || identity.kind !== 'page' || identity.pageId !== action.pageId
                            || !principal.assignments.some(a => a.pageId === action.pageId && a.profileIds.includes(action.profileId))) deny();
                    }
                } else if (method === 'pageApprovals.bindMessage' || method === 'pageApprovals.confirm') {
                    const ticket = typeof p.ticketId === 'string' ? works.getApproval(p.ticketId) : null;
                    if (!ticket || ticket.receiverKeyId !== principal.keyId || ticket.workspaceId !== workspaceId || !pageAllowed(ticket.pageId)
                        || ticket.chatId !== principal.ownerChatId || ticket.senderId !== principal.ownerSenderId) deny();
                    const identity = method === 'pageApprovals.confirm' ? p.update : p;
                    if (!identity || identity.chatId !== ticket.chatId || identity.senderId !== ticket.senderId) deny();
                    if (method === 'pageApprovals.confirm' && identity.replyToMessageId !== ticket.messageId) deny();
                } else deny();
                assertCurrent();
            },
        };
    };
    methods.push(...createPageOperationMethods({ bindRequest: (ctx: ControlContext) => {
        assertRuntimeCurrent(); ctx.assertCurrent?.();
        const principal = ctx.principal;
        if (!principal || principal.kind === 'legacy') return deny();
        const guard = () => { assertRuntimeCurrent(); ctx.assertCurrent!(); };
        const context = (id: string): PageContext => {
            guard(); const row = works.get(id);
            if (!row || row.workspaceId !== workspaceId || !principal.assignments.some(a => a.pageId === row.pageId && a.profileIds.includes(row.profileId))) deny();
            return { workspaceId, dbPath: boundPath, pageId: row.pageId, profileId: row.profileId };
        };
        return { db: boundDb, dbPath: boundPath, workspaceId, assertCurrent: guard, now: Date.now,
            protectedWritesEnabled: () => { guard(); return parseStoredConfig(boundDb.getSetting(CONTROL_CONFIG_SETTING_KEY)).protectedWritesEnabled; },
            get campaignCollector() { guard(); return getBoundPageCampaignCollector(boundDb); },
            get work() { guard(); const deps = createBoundPageWorkDependencies(context, guard); if (deps.db !== boundDb) deny(); return deps; },
            get approval() { guard(); const deps = createBoundPageApprovalDependencies(guard); if (deps.db !== boundDb) deny(); return deps; },
            waitForEvent: (after, ms, signal) => notifier.waitForEvent(after, ms, signal), notify: () => notifier.notify() };
    } }));
    for (const method of methods) {
        if (!['pageCampaigns.collect', 'pageWork.research', 'pageWork.saveDraft', 'pageWork.reconcile', 'pageApprovals.confirm'].includes(method.name)) continue;
        const run = method.run;
        method.run = (params, context) => {
            const pending = run(params, context);
            if (context.principal?.kind !== 'legacy') {
                protectedCalls.add(pending);
                void pending.then(() => protectedCalls.delete(pending), () => protectedCalls.delete(pending));
            }
            return pending;
        };
    }
    loadBridge();
    const tls = await certStoreOf().ensure();
    const retired = () => quitting || scope.retired || generation !== workspaceGeneration || db() !== boundDb
        || boundDb.getDbPath() !== boundPath || WorkspaceManager.getInstance().getActiveWorkspace()?.id !== workspaceId || isFacebookPosterEmployeeBlocked();
    if (retired()) return;
    const server = new ControlApiServer({
        tls, port: config.port, host: BIND_HOST, allowList: config.allowList, store, methods,
        idempotency: new IdempotencyCache(store), rateLimiter: new RateLimiter(60), lockout: new AuthLockout(),
        saveMedia: (name, contentType, stream) => mediaStore.save(name, contentType, stream),
        isBlocked: isFacebookPosterEmployeeBlocked,
        authorizationResources,
        openVideoFile: (videoId, kind) => videoOperations.openFile({ videoId, kind }),
        pairing: {
            consume: (ticket, ip) => {
                const info = pairing.consume(ticket, ip);
                if (!info) return null;
                try { provisioningContext(info.policy); return info; } catch { return null; }
            },
            onPaired: (info) => EventBroadcaster.emit('controlApi:paired', { keyName: info.keyName, ip: info.ip }),
        },
        bridgeScript: () => bridge?.buffer ?? null,
    });
    await server.start();
    if (retired()) { scope.retired = true; await server.stop(); return; }
    const maintain = () => housekeeping(store, works, workspaceId, () => { if (retired()) deny(); });
    maintain();
    const timer = setInterval(maintain, HOUR_MS);
    timer.unref();
    runtime = { server, store, timers: [timer] };
}

/**
 * Synchronous (no await): install or remove the event sink for the ACTIVE workspace DB. Must run before the poster scheduler starts
 * (app start, after a workspace DB switch) so schedule.missed / run.started fired synchronously are not lost. Independent of the server.
 */
export function syncControlEventSink(): void {
    if (quitting) { recorder.deactivate(); return; }
    try {
        recorder.sync(readConfig().enabled, isFacebookPosterEmployeeBlocked(), currentStore);
    } catch (err: any) {
        recorder.deactivate();
        Logger.error(`[controlApi] event sink setup failed: ${err?.message ?? err}`);
    }
}

/** Stop, then (re)start from the active workspace's config. Serialized so concurrent callers never overlap. */
function apply(opts: { regenerateCertificate?: boolean } = {}): Promise<void> {
    syncControlEventSink(); // synchronous part first: the sink follows the config with no window while the server restarts
    const run = async () => {
        await stopRuntime();
        lastError = null;
        lastBlocked = isFacebookPosterEmployeeBlocked();
        if (quitting) return;
        try {
            if (opts.regenerateCertificate) await certStoreOf().regenerate();
            if (lastBlocked) return;
            const config = readConfig();
            if (!config.enabled) return;
            await startRuntime(config);
        } catch (err: any) {
            await stopRuntime();
            lastError = err instanceof CertificateKeyUnreadableError ? err.message : describeBindError(err, readConfig().port);
            Logger.error(`[controlApi] start failed: ${err?.message ?? err}`);
        }
    };
    queue = queue.then(run, run);
    return queue;
}

/** App start (after DB init, before the poster scheduler): sink is installed synchronously, then the server starts if enabled; also watches for a switch into/out of employee mode. */
export function startControlApi(): Promise<void> {
    if (!modeTimer) {
        modeTimer = setInterval(() => {
            if (isFacebookPosterEmployeeBlocked() !== lastBlocked) void apply();
        }, MODE_CHECK_MS);
        modeTimer.unref();
    }
    return apply();
}

/** Workspace switch: stop serving and recording until restartControlApi(). */
export function stopControlApi(): Promise<void> {
    workspaceGeneration++;
    recorder.deactivate();
    pairing.clear(); // vé ghép nối thuộc workspace cũ; chỉ đường chuyển workspace đi qua đây (lưu cấu hình thường không dừng server)
    const run = () => stopRuntime();
    queue = queue.then(run, run);
    return queue;
}

/** before-quit: synchronously drop the sink and close the listener (before DatabaseService.close()); no apply may start afterwards. */
export function shutdownControlApi(): Promise<void> {
    quitting = true;
    workspaceGeneration++;
    if (pageScope) pageScope.retired = true;
    recorder.notifier?.notify();
    recorder.deactivate();
    if (modeTimer) { clearInterval(modeTimer); modeTimer = null; }
    const current = runtime;
    runtime = null;
    current?.timers.forEach(clearInterval);
    const closing = current ? current.server.stop() : Promise.resolve(); // stop() closes the listener and sockets synchronously
    const run = () => closing.then(() => stopRuntime());
    queue = queue.then(run, run);
    return queue;
}

/** After the workspace DB changed (or a switch was rolled back): rebuild against the active DB with its own config. Never throws. */
export function restartControlApi(): Promise<void> {
    return apply().catch((err) => Logger.error(`[controlApi] restart failed: ${err?.message ?? err}`));
}

function getConfigView() {
    const { workspaceId, workspaceGeneration } = provisioningContext(undefined);
    const config = readConfig();
    return {
        ...config, workspaceId, workspaceGeneration,
        fingerprint: certStoreOf().fingerprint(),
        detectedPublicHost: detectPublicIpv4(os.networkInterfaces()),
        bridgeSha256: bridge?.sha256 ?? null,
        running: runtime !== null,
        ...(lastError ? { error: lastError } : {}),
        ...(certStoreOf().warning ? { warning: certStoreOf().warning } : {}),
    };
}

function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (isFacebookPosterEmployeeBlocked()) {
                return { success: false, error: 'Control API chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            if (!(err instanceof ControlConfigError)) Logger.error(`[controlApi] ${channel} error: ${err.message}`);
            return { success: false, error: err.message, ...(err instanceof ControlConfigError && err.invalid.length ? { invalid: err.invalid } : {}) };
        }
    });
}

export function registerControlApiIpc(): void {
    handle('controlApi:getConfig', () => getConfigView());

    handle('controlApi:getScopeOptions', () => {
        const { workspaceId, workspaceGeneration } = provisioningContext(undefined);
        return { workspaceId, workspaceGeneration, identities: getDailyBriefStore().listIdentities() };
    });

    handle('controlApi:setConfig', async (params) => {
        const context = provisioningContext(undefined);
        // Legacy callers that omit the gate still edit current config; explicit gate changes require a trusted-view binding.
        if (params.protectedWritesEnabled !== undefined || params.workspaceId !== undefined || params.workspaceGeneration !== undefined) {
            if (params.workspaceId !== context.workspaceId || !Number.isSafeInteger(params.workspaceGeneration) || params.workspaceGeneration !== context.workspaceGeneration) {
                throw new Error('Workspace đã đổi hoặc thiếu phạm vi cấu hình, hãy tải lại trước khi lưu');
            }
        }
        const current = readConfig();
        const next = validateConfigInput(withStoredPublicHost(params, current.publicHost), current.protectedWritesEnabled);
        context.assertCurrent();
        db().setSetting(CONTROL_CONFIG_SETTING_KEY, JSON.stringify(next));
        await apply(); // always stop then start: reused keep-alive sockets must not outlive a new allow-list
        context.assertCurrent();
        return getConfigView();
    });

    handle('controlApi:createPairing', async (params) => {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > MAX_KEY_NAME) throw new Error(`Tên khoá phải có 1–${MAX_KEY_NAME} ký tự`);
        const { policy, assertCurrent } = provisioningContext(params.policy);
        const botIp = parseBotIp(params.botIp);
        const publicHost = validatePublicHost(params.publicHost);
        loadBridge(); // kiểm tra trước khi đổi bất kỳ cấu hình nào
        if (!bridge) throw new Error('Không tìm thấy tệp bridge đi kèm MaiHub');
        const current = readConfig();
        const next = validateConfigInput({
            enabled: true, port: current.port, publicHost,
            allowList: current.allowList.includes(botIp) ? current.allowList : [...current.allowList, botIp],
        }, current.protectedWritesEnabled);
        assertCurrent();
        db().setSetting(CONTROL_CONFIG_SETTING_KEY, JSON.stringify(next));
        await apply();
        assertCurrent();
        if (!runtime) throw new Error(lastError ?? 'Không khởi động được Control API');
        const bridgeSha256 = bridge.sha256;
        const fingerprint = certStoreOf().fingerprint();
        if (!fingerprint) throw new Error('Chưa có chứng chỉ Control API');
        const { ticket, expiresAt } = pairing.create(name, botIp, policy);
        const code = buildPairingCode({ url: `https://${publicHost}:${next.port}`, fingerprint, ticket, name });
        const command = buildInstallCommand({ host: publicHost, port: next.port, sha256: bridgeSha256, code, kind: policy?.kind });
        return { code, command, firewall: buildFirewallCommand(next), expiresAt, ...getConfigView() };
    });

    handle('controlApi:cancelPairing', (params) => {
        pairing.cancel(parseBotIp(params.botIp));
    });

    handle('controlApi:createKey', (params) => {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > MAX_KEY_NAME) throw new Error(`Tên khoá phải có 1–${MAX_KEY_NAME} ký tự`);
        const { policy } = provisioningContext(params.policy);
        const created = currentStore().createKey(name, policy);
        return { key: created.key, id: created.id, name: created.name };
    });

    handle('controlApi:listKeys', () => ({ keys: currentStore().listKeys() }));

    handle('controlApi:revokeKey', (params) => {
        if (typeof params.id !== 'string' || !params.id) throw new Error('Thiếu mã khoá');
        return { revoked: currentStore().revokeKey(params.id) };
    });

    handle('controlApi:listAudit', (params) => {
        const limit = Number.isInteger(params.limit) && params.limit >= 1 ? Math.min(params.limit, 500) : 100;
        return { audit: currentStore().listAudit(limit) };
    });

    handle('controlApi:firewallCommand', () => ({ command: buildFirewallCommand(readConfig()) }));

    handle('controlApi:regenerateCertificate', async () => {
        await apply({ regenerateCertificate: true }); // same queue as every other restart; the new certificate is served after it
        return getConfigView();
    });
}
