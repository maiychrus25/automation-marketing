import { app, dialog, ipcMain, safeStorage } from 'electron';
import * as path from 'path';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import Logger from '../../src/utils/Logger';
import { emitControlEvent } from '../../src/services/control/controlEvents';
import { AhvAdClient } from '../../src/services/video/AhvAdClient';
import { loadAhvSettings, saveAhvSettings } from '../../src/services/video/ahvSettings';
import { RenderClient } from '../../src/services/video/RenderClient';
import { VideoService } from '../../src/services/video/VideoService';
import { VideoStore } from '../../src/services/video/VideoStore';
import { createVideoOperations, routeVideoEvent, type VideoOperationsDeps } from '../../src/services/video/videoOperations';
import { createSafeStorageCrypto, loadVideoSettings, saveVideoSettings } from '../../src/services/video/videoSettings';
import { getInboxMediaStore } from './inboxMedia';
import { isFacebookPosterEmployeeBlocked } from './facebookPosterIpc';

let service: VideoService | null = null;
let preparedDbPath: string | null = null;
let polling = false;

const db = () => DatabaseService.getInstance();
const crypto = createSafeStorageCrypto(safeStorage);
const client = () => {
    const settings = loadVideoSettings(db(), crypto);
    return new RenderClient(settings.url, settings.apiKey);
};
const adClient = () => {
    const settings = loadAhvSettings(db(), crypto);
    return new AhvAdClient(settings.baseUrl, settings.apiKey);
};

/** Service gắn với DB workspace hiện tại: DB mới thì tạo schema và dựng service mới (service cũ dừng theo dõi). */
function getVideoService(): VideoService {
    const dbPath = db().getDbPath();
    if (!service || dbPath !== preparedDbPath) {
        service?.stop();
        const store = new VideoStore(db());
        store.ensureSchema();
        service = new VideoService({
            store, client, adClient, mediaInbox: getInboxMediaStore(),
            emit: (type, payload) => routeVideoEvent({
                broadcast: (channel) => EventBroadcaster.emit(channel, {}),
                emitControl: emitControlEvent,
            }, type, payload),
            now: Date.now,
            setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
            clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
            videosDir: path.join(app.getPath('userData'), 'videos'),
        });
        preparedDbPath = dbPath;
        if (polling) service.startPolling();
    }
    return service;
}

/** Handler bodies dùng chung cho IPC `video:*` và Control API `videos.*` (kiểm tra tham số nằm ở createVideoOperations). */
const videoDeps: VideoOperationsDeps = {
    service: getVideoService,
    loadSettings: () => loadVideoSettings(db(), crypto),
    saveSettings: (input) => saveVideoSettings(db(), crypto, input),
    client,
    loadAhvSettings: () => loadAhvSettings(db(), crypto),
    saveAhvSettings: (input) => saveAhvSettings(db(), crypto, input),
    adClient,
    resolveMedia: (ids) => getInboxMediaStore().resolve(ids),
    pickSavePath: async (defaultName) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'Video MP4', extensions: ['mp4'] }] });
        return result.canceled || !result.filePath ? null : result.filePath;
    },
};
export const videoOperations = createVideoOperations(videoDeps);

/** Capture this workspace's library; owned polling must never follow the active workspace getter. */
export function getPageWorkVideoOperations() {
    const bound = getVideoService();
    const operations = createVideoOperations({ ...videoDeps, service: () => bound });
    return { status: operations.status, openFile: operations.openFile };
}

/** App sẵn sàng hoặc sau khi đổi workspace: theo dõi tiếp các việc dở của DB hiện tại (không chạy ở chế độ nhân viên). */
export function startVideoPolling(): void {
    if (isFacebookPosterEmployeeBlocked()) return;
    polling = true;
    getVideoService().startPolling();
}

/** Thoát app hoặc sắp đổi workspace. Đồng bộ, không ném. */
export function stopVideoPolling(): void {
    polling = false;
    service?.stop();
}

/** Cùng chặn chế độ nhân viên và phong bì kết quả như researchIpc. */
function handle(channel: string, handler: (params: any) => Promise<Record<string, any> | void> | Record<string, any> | void): void {
    ipcMain.handle(channel, async (_event, params) => {
        try {
            if (isFacebookPosterEmployeeBlocked()) {
                return { success: false, error: 'Tính năng Video chỉ dùng được ở chế độ Boss/Standalone' };
            }
            const result = await handler(params || {});
            return { success: true, ...(result || {}) };
        } catch (err: any) {
            Logger.error(`[videoIpc] ${channel} error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });
}

export function registerVideoIpc(): void {
    handle('video:settingsGet', videoOperations.settingsGet);
    handle('video:settingsSet', videoOperations.settingsSet);
    handle('video:testConnection', videoOperations.testConnection);
    handle('video:templates', videoOperations.templates);
    handle('video:musicPreview', videoOperations.musicPreview);
    handle('video:render', (p) => videoOperations.render(p, 'app'));
    handle('video:ahvSettingsGet', videoOperations.ahvSettingsGet);
    handle('video:ahvSettingsSet', videoOperations.ahvSettingsSet);
    handle('video:ahvTestConnection', videoOperations.ahvTestConnection);
    handle('video:voices', videoOperations.voices);
    handle('video:adCreate', (p) => videoOperations.adCreate(p, 'app'));
    handle('video:status', (p) => videoOperations.status(p, 'app'));
    handle('video:list', (p) => videoOperations.list(p, 'app'));
    handle('video:cancel', videoOperations.cancel);
    handle('video:delete', videoOperations.delete);
    handle('video:exportFile', videoOperations.exportFile);
}
