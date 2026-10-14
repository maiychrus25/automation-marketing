import { app, ipcMain, safeStorage } from 'electron';
import * as path from 'path';
import DatabaseService from '../../src/services/database/DatabaseService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { ControlStore } from '../../src/services/control/ControlStore';
import { EventNotifier } from '../../src/services/control/EventNotifier';
import { IdempotencyCache } from '../../src/services/control/IdempotencyCache';
import { AuthLockout, RateLimiter } from '../../src/services/control/controlSecurity';
import { ControlApiServer } from '../../src/services/control/ControlApiServer';
import { createControlMethods } from '../../src/services/control/ControlMethods';
import { createCertificate } from '../../src/services/control/certificate';
import { CertificateStore } from '../../src/services/control/CertificateStore';
import { InboxMediaStore } from '../../src/services/control/InboxMediaStore';
import { setControlEventSink } from '../../src/services/control/controlEvents';
import { toSafeProfiles } from '../../src/services/control/controlProfiles';
import {
    CONTROL_CONFIG_SETTING_KEY, ControlConfigError, buildFirewallCommand, parseStoredConfig, validateConfigInput, type ControlConfig,
} from '../../src/services/control/controlConfig';
import { isFacebookPosterEmployeeBlocked, isFacebookPosterSchedulerRunning, posterOperations } from './facebookPosterIpc';
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

const db = () => DatabaseService.getInstance();
const controlDir = () => path.join(app.getPath('userData'), 'control-api');
const inbox = () => new InboxMediaStore(path.join(controlDir(), 'inbox'));
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
        },
        createCertificate,
    );
    return certStoreInstance;
}

function readConfig(): ControlConfig {
    return parseStoredConfig(db().getSetting(CONTROL_CONFIG_SETTING_KEY));
}

function describeBindError(err: any, port: number): string {
    if (err?.code === 'EADDRINUSE') return `Cổng ${port} đang được chương trình khác dùng, hãy chọn cổng khác`;
    if (err?.code === 'EACCES') return `Không có quyền mở cổng ${port}`;
    return `Không khởi động được Control API: ${err?.message ?? err}`;
}

async function stopRuntime(): Promise<void> {
    const current = runtime;
    runtime = null;
    setControlEventSink(null);
    if (!current) return;
    current.timers.forEach(clearInterval);
    await current.server.stop();
}

/** Hourly: inbox files older than 24 h and old audit/event/idempotency rows. Never throws. */
function housekeeping(store: ControlStore): void {
    try { inbox().cleanup(Date.now()); } catch (err) { Logger.error(`[controlApi] inbox cleanup failed: ${(err as Error).message}`); }
    try { store.pruneOld(Date.now()); } catch (err) { Logger.error(`[controlApi] prune failed: ${(err as Error).message}`); }
}

async function startRuntime(config: ControlConfig): Promise<void> {
    const store = currentStore();
    const notifier = new EventNotifier(store);
    const mediaStore = inbox();
    const profiles = () => getBrowserProfileService();
    const methods = createControlMethods({
        poster: posterOperations as any,
        listProfiles: () => toSafeProfiles(db().getBrowserProfiles(), db().getBrowserProfileGroups(), profiles().getRunningIds()),
        systemStatus: async () => {
            const ws = WorkspaceManager.getInstance().getActiveWorkspace();
            return {
                appVersion: app.getVersion(),
                workspace: ws ? { id: ws.id, name: ws.name } : null,
                browserEngine: getBrowserEngineStatus(),
                sandbox: await getBrowserSandboxState(),
                schedulerRunning: isFacebookPosterSchedulerRunning(),
                currentRun: posterOperations.current(),
            };
        },
        resolveMedia: (ids) => mediaStore.resolve(ids),
        events: { listEventsAfter: (s, l) => store.listEventsAfter(s, l), waitForEvent: (a, t, sig) => notifier.waitForEvent(a, t, sig) },
    });
    const tls = await certStoreOf().ensure();
    const server = new ControlApiServer({
        tls, port: config.port, host: BIND_HOST, allowList: config.allowList, store, methods,
        idempotency: new IdempotencyCache(store), rateLimiter: new RateLimiter(60), lockout: new AuthLockout(),
        saveMedia: (name, contentType, stream) => mediaStore.save(name, contentType, stream),
    });
    await server.start();
    housekeeping(store);
    const timer = setInterval(() => housekeeping(store), HOUR_MS);
    timer.unref();
    runtime = { server, store, timers: [timer] };
    setControlEventSink((type, payload) => {
        store.addEvent(type, payload);
        notifier.notify();
    });
}

/** Stop, then (re)start from the active workspace's config. Serialized so concurrent callers never overlap. */
function apply(): Promise<void> {
    const run = async () => {
        await stopRuntime();
        lastError = null;
        lastBlocked = isFacebookPosterEmployeeBlocked();
        if (lastBlocked) return;
        const config = readConfig();
        if (!config.enabled) return;
        try {
            await startRuntime(config);
        } catch (err: any) {
            await stopRuntime();
            lastError = describeBindError(err, config.port);
            Logger.error(`[controlApi] start failed: ${err?.message ?? err}`);
        }
    };
    queue = queue.then(run, run);
    return queue;
}

/** App start (after DB init): start if enabled; also watches for a switch into/out of employee mode. */
export function startControlApi(): Promise<void> {
    if (!modeTimer) {
        modeTimer = setInterval(() => {
            if (isFacebookPosterEmployeeBlocked() !== lastBlocked) void apply();
        }, MODE_CHECK_MS);
        modeTimer.unref();
    }
    return apply();
}

/** before-quit and workspace switch: stop serving. */
export function stopControlApi(): Promise<void> {
    const run = () => stopRuntime();
    queue = queue.then(run, run);
    return queue;
}

/** After the workspace DB changed (or a switch was rolled back): rebuild against the active DB with its own config. Never throws. */
export function restartControlApi(): Promise<void> {
    return apply().catch((err) => Logger.error(`[controlApi] restart failed: ${err?.message ?? err}`));
}

function getConfigView() {
    const config = readConfig();
    return {
        ...config,
        fingerprint: certStoreOf().fingerprint(),
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

    handle('controlApi:setConfig', async (params) => {
        const next = validateConfigInput(params);
        db().setSetting(CONTROL_CONFIG_SETTING_KEY, JSON.stringify(next));
        await apply(); // always stop then start: reused keep-alive sockets must not outlive a new allow-list
        return getConfigView();
    });

    handle('controlApi:createKey', (params) => {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > MAX_KEY_NAME) throw new Error(`Tên khoá phải có 1–${MAX_KEY_NAME} ký tự`);
        const created = currentStore().createKey(name);
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

    handle('controlApi:firewallCommand', () => {
        try { return { command: buildFirewallCommand(readConfig()) }; }
        catch (err: any) { throw new Error(err.message); }
    });

    handle('controlApi:regenerateCertificate', async () => {
        await certStoreOf().regenerate();
        await apply(); // restart so the server presents the new certificate
        return getConfigView();
    });
}
