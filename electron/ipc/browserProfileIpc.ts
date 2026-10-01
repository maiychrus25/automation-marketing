import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import { BrowserEngineManager } from '../../src/services/browser/BrowserEngineManager';
import { BrowserProfileService } from '../../src/services/browser/BrowserProfileService';
import { generateFingerprint, isValidLanguage, isValidTimezone } from '../../src/services/browser/fingerprint';

const MAX_NAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 1000;
const PROGRESS_INTERVAL_MS = 250;

let engineManager: BrowserEngineManager | null = null;
let profileService: BrowserProfileService | null = null;

function db(): DatabaseService {
    return DatabaseService.getInstance();
}

function getEngineManager(): BrowserEngineManager {
    if (!engineManager) {
        engineManager = new BrowserEngineManager(path.join(app.getPath('userData'), 'browser-engine'));
    }
    return engineManager;
}

/** Browser data lives next to the active workspace's database, so each workspace has its own profiles. */
function getProfilesDir(): string {
    return path.join(path.dirname(db().getDbPath()), 'browser-profiles');
}

function getProfileService(): BrowserProfileService {
    if (!profileService) {
        profileService = new BrowserProfileService({
            store: {
                getBrowserProfileById: (id) => db().getBrowserProfileById(id),
                getProxyById: (id) => db().getProxyById(id),
                touchBrowserProfileOpened: (id) => db().touchBrowserProfileOpened(id),
            },
            getExecutablePath: () => getEngineManager().getExecutablePath(),
            getProfilesDir,
            onStatusChanged: (runningIds) => EventBroadcaster.emit('browserProfile:statusChanged', { runningIds }),
        });
    }
    return profileService;
}

/** Closes every running browser. Called on app quit and before the workspace database is switched. */
export function closeAllBrowserProfiles(): void {
    profileService?.closeAll();
}

// ─── Input validation ────────────────────────────────────────────────────────

function requireName(value: any): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw new Error('Tên profile không được để trống');
    if (name.length > MAX_NAME_LENGTH) throw new Error(`Tên profile tối đa ${MAX_NAME_LENGTH} ký tự`);
    return name;
}

function optionalNote(value: any): string {
    const note = typeof value === 'string' ? value : '';
    if (note.length > MAX_NOTE_LENGTH) throw new Error(`Ghi chú tối đa ${MAX_NOTE_LENGTH} ký tự`);
    return note;
}

function optionalProxyId(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !db().getProxyById(id)) throw new Error('Proxy không tồn tại');
    return id;
}

function optionalGroupId(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !db().getBrowserProfileGroupById(id)) throw new Error('Nhóm không tồn tại');
    return id;
}

function requireLanguage(value: any): string {
    if (!isValidLanguage(value)) throw new Error('Ngôn ngữ không hợp lệ');
    return value;
}

function requireTimezone(value: any): string {
    if (!isValidTimezone(value)) throw new Error('Múi giờ không hợp lệ');
    return value;
}

function requireIds(value: any): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id)) {
        throw new Error('Danh sách profile không hợp lệ');
    }
    return value;
}

function requireProfile(id: any) {
    const profile = typeof id === 'string' ? db().getBrowserProfileById(id) : null;
    if (!profile) throw new Error('Không tìm thấy profile');
    return profile;
}

/** Registers one handler with the shared employee-mode guard and error envelope. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (AppModeManager.getInstance().isEmployeeMode()) {
                return { success: false, error: 'Tính năng Trình duyệt chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            Logger.error(`[browserProfileIpc] ${channel} error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

export function registerBrowserProfileIpc(): void {
    handle('browserProfile:list', () => ({
        profiles: db().getBrowserProfiles(),
        groups: db().getBrowserProfileGroups(),
        runningIds: getProfileService().getRunningIds(),
    }));

    handle('browserProfile:create', (params) => {
        const overrides: { language?: string; timezone?: string } = {};
        if (params.language) overrides.language = requireLanguage(params.language);
        if (params.timezone) overrides.timezone = requireTimezone(params.timezone);
        const profile = db().createBrowserProfile({
            id: randomUUID(),
            name: requireName(params.name),
            group_id: optionalGroupId(params.groupId),
            proxy_id: optionalProxyId(params.proxyId),
            fingerprint: generateFingerprint(overrides),
            note: optionalNote(params.note),
        });
        return { profile };
    });

    handle('browserProfile:update', (params) => {
        const current = requireProfile(params.id);
        const fields: Parameters<DatabaseService['updateBrowserProfile']>[1] = {};
        if (params.name !== undefined) fields.name = requireName(params.name);
        if (params.groupId !== undefined) fields.group_id = optionalGroupId(params.groupId);
        if (params.proxyId !== undefined) fields.proxy_id = optionalProxyId(params.proxyId);
        if (params.note !== undefined) fields.note = optionalNote(params.note);

        const changesFingerprint = params.regenerateFingerprint || params.language !== undefined || params.timezone !== undefined;
        if (changesFingerprint) {
            if (getProfileService().isRunning(current.id)) throw new Error('Hãy đóng profile trước khi đổi fingerprint');
            const language = params.language !== undefined ? requireLanguage(params.language) : current.fingerprint.language;
            const timezone = params.timezone !== undefined ? requireTimezone(params.timezone) : current.fingerprint.timezone;
            fields.fingerprint = params.regenerateFingerprint
                ? generateFingerprint({ language, timezone })
                : { ...current.fingerprint, language, timezone };
        }
        db().updateBrowserProfile(current.id, fields);
        return { profile: db().getBrowserProfileById(current.id) };
    });

    handle('browserProfile:delete', (params) => {
        const service = getProfileService();
        let deleted = 0;
        const skippedRunning: string[] = [];
        for (const id of requireIds(params.ids)) {
            const profile = db().getBrowserProfileById(id);
            if (!profile) continue;
            if (service.isRunning(profile.id)) {
                skippedRunning.push(profile.id);
                continue;
            }
            db().deleteBrowserProfile(profile.id);
            fs.rmSync(service.getProfileDir(profile.id), { recursive: true, force: true });
            deleted++;
        }
        return { deleted, skippedRunning };
    });

    handle('browserProfile:setProxy', (params) => {
        const ids = requireIds(params.ids);
        const service = getProfileService();
        if (ids.some((id) => service.isRunning(id))) throw new Error('Hãy đóng các profile đang mở trước khi đổi proxy');
        return { updated: db().setBrowserProfilesProxy(ids, optionalProxyId(params.proxyId)) };
    });

    handle('browserProfile:open', async (params) => {
        await getProfileService().open(requireProfile(params.id).id);
    });

    handle('browserProfile:close', (params) => {
        getProfileService().close(requireProfile(params.id).id);
    });

    handle('browserProfile:saveGroup', (params) => {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name) throw new Error('Tên nhóm không được để trống');
        if (name.length > MAX_NAME_LENGTH) throw new Error(`Tên nhóm tối đa ${MAX_NAME_LENGTH} ký tự`);
        const id = params.id ? optionalGroupId(params.id) : null;
        const color = typeof params.color === 'string' ? params.color.slice(0, 20) : '';
        return { group: db().saveBrowserProfileGroup({ id: id || undefined, name, color }) };
    });

    handle('browserProfile:deleteGroup', (params) => {
        const id = optionalGroupId(params.id);
        if (id === null) throw new Error('Nhóm không tồn tại');
        db().deleteBrowserProfileGroup(id);
    });

    handle('browserProfile:engineStatus', () => getEngineManager().getStatus());

    handle('browserProfile:installEngine', async () => {
        let lastEmit = 0;
        await getEngineManager().install((progress) => {
            const now = Date.now();
            if (now - lastEmit < PROGRESS_INTERVAL_MS && progress.received !== progress.total) return;
            lastEmit = now;
            EventBroadcaster.emit('browserProfile:engineProgress', progress);
        });
        return getEngineManager().getStatus();
    });
}
