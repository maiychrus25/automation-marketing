import { app, ipcMain, shell, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UpdateService, type ReleaseInfo } from '../../src/services/update/UpdateService';
import { isFacebookPosterBusy } from './facebookPosterIpc';

/** Same repository as `build.publish` in package.json. It is public, so the API needs no token. */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/maiychrus25/automation-marketing/releases/latest';
const FETCH_TIMEOUT_MS = 15000;
const FIRST_CHECK_DELAY_MS = 15000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let service: UpdateService | null = null;

async function fetchLatestRelease(): Promise<ReleaseInfo> {
    const res = await fetch(LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MaiHub/${app.getVersion()}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ReleaseInfo;
}

/** Windows (NSIS) and Linux AppImage replace themselves; unsigned macOS and .deb installs only get a download link. */
function canInstallInPlace(): boolean {
    return process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE);
}

/**
 * Registers update IPC and, outside development, checks GitHub Releases 15 s after start and every 6 hours.
 * See docs/specs/2026-10-03-auto-update.md.
 */
export function registerUpdateIpc(getWindow: () => BrowserWindow | null, isDev: boolean): void {
    const canInstall = canInstallInPlace();
    if (canInstall) {
        autoUpdater.autoDownload = false;
        autoUpdater.autoInstallOnAppQuit = false;
    }
    service = new UpdateService({
        currentVersion: app.getVersion(),
        canInstall,
        fetchLatestRelease,
        updater: canInstall ? autoUpdater : null,
        isBusy: isFacebookPosterBusy,
        openExternal: (url) => { void shell.openExternal(url); },
        emit: (state) => {
            const win = getWindow();
            if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
        },
        // Statement body on purpose: scripts/strip-console.js deletes `console.*(...)` up to the next `;`,
        // so an expression-bodied arrow here would swallow the rest of the call and break the build.
        log: (message) => { console.warn(message); },
    });

    ipcMain.handle('update:get-state', () => service!.getState());
    ipcMain.handle('update:check', () => (isDev ? service!.getState() : service!.check()));
    ipcMain.handle('update:download', () => service!.download());
    ipcMain.handle('update:install', () => service!.install());

    if (isDev) return;
    setTimeout(() => { void service!.check(); }, FIRST_CHECK_DELAY_MS).unref();
    setInterval(() => { void service!.check(); }, CHECK_INTERVAL_MS).unref();
}
