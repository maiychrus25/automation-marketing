import { isNewerVersion } from './versionCompare';

/** Pure update state machine (no electron import) so it can be unit-tested. See docs/specs/2026-10-03-auto-update.md. */
export type UpdateState =
    | { status: 'idle' }
    | { status: 'available'; version: string; notes: string; url: string; canInstall: boolean }
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'downloaded'; version: string }
    | { status: 'error'; message: string; version: string | null };

/** The fields of the GitHub "latest release" API response this service reads. */
export interface ReleaseInfo {
    tag_name: string;
    html_url: string;
    body?: string | null;
    draft?: boolean;
    prerelease?: boolean;
}

/** The part of electron-updater's autoUpdater this service uses. */
export interface UpdaterLike {
    /** electron-updater resolves null when inactive, or a result whose isUpdateAvailable says whether latest*.yml offers a newer build. */
    checkForUpdates(): Promise<{ isUpdateAvailable?: boolean } | null | unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
    on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface UpdateServiceDeps {
    currentVersion: string;
    /** Windows NSIS and Linux AppImage install in place; unsigned macOS and .deb only get a link to the release page. */
    canInstall: boolean;
    fetchLatestRelease: () => Promise<ReleaseInfo>;
    updater: UpdaterLike | null;
    /** True while a Facebook posting job runs: restarting then would lose the job. */
    isBusy: () => boolean;
    openExternal: (url: string) => void;
    emit: (state: UpdateState) => void;
    log?: (message: string) => void;
}

export type ActionResult = { success: true } | { success: false; error: string };

const NOTES_MAX_LINES = 3;
const ERROR_MAX_CHARS = 160;
const BUSY_MESSAGE = 'Đang có việc Đăng Facebook chạy. Đợi xong hoặc huỷ rồi khởi động lại.';

/** First lines of a GitHub release body, without Markdown headings, "Full Changelog" links or bullet markers. */
function summarizeNotes(body: string | null | undefined): string {
    return String(body || '').split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && !/^\*\*Full Changelog\*\*/i.test(line))
        .map((line) => line.replace(/^[-*]\s+/, ''))
        .slice(0, NOTES_MAX_LINES)
        .join('\n');
}

export class UpdateService {
    private state: UpdateState = { status: 'idle' };
    private latest: { version: string; url: string } | null = null;
    /** The check in progress, shared by overlapping callers. No intermediate state is emitted, so the card never flickers. */
    private inFlight: Promise<UpdateState> | null = null;

    constructor(private readonly deps: UpdateServiceDeps) {
        const updater = deps.updater;
        if (!updater) return;
        updater.on('download-progress', (progress: { percent?: number }) => {
            if (this.state.status !== 'downloading') return;
            this.setState({ status: 'downloading', version: this.state.version, percent: Math.round(Number(progress?.percent) || 0) });
        });
        updater.on('update-downloaded', () => {
            if (this.state.status !== 'downloading') return;
            this.setState({ status: 'downloaded', version: this.state.version });
        });
        updater.on('error', (err: Error) => {
            if (this.state.status !== 'downloading') return;
            this.fail(err);
        });
    }

    public getState(): UpdateState {
        return this.state;
    }

    /**
     * Asks GitHub for the latest release. A network/404 error is only logged and keeps the current state,
     * so a known update is not lost to a transient failure (and nothing is shown when there was none).
     */
    public check(): Promise<UpdateState> {
        const status = this.state.status;
        if (status === 'downloading' || status === 'downloaded') return Promise.resolve(this.state);
        if (!this.inFlight) {
            this.inFlight = this.runCheck().finally(() => { this.inFlight = null; });
        }
        return this.inFlight;
    }

    private async runCheck(): Promise<UpdateState> {
        let release: ReleaseInfo;
        try {
            release = await this.deps.fetchLatestRelease();
        } catch (err: any) {
            this.deps.log?.(`[AutoUpdate] Không kiểm tra được bản mới: ${err?.message || err}`);
            return this.state;
        }
        // A download may have started while the request was in flight; never overwrite it.
        if (this.state.status === 'downloading' || this.state.status === 'downloaded') return this.state;
        if (release.draft || release.prerelease || !isNewerVersion(release.tag_name, this.deps.currentVersion)) {
            this.latest = null;
            this.setState({ status: 'idle' });
            return this.state;
        }
        const version = release.tag_name.replace(/^v/, '');
        this.latest = { version, url: release.html_url };
        if (this.state.status === 'error' && this.state.version === version) return this.state;
        this.setState({ status: 'available', version, notes: summarizeNotes(release.body), url: release.html_url, canInstall: this.deps.canInstall });
        return this.state;
    }

    /** Starts the download (or opens the release page on platforms that cannot install in place). */
    public async download(): Promise<ActionResult> {
        if (this.state.status === 'downloading') return { success: false, error: 'Đang tải bản cập nhật' };
        if (!this.latest || (this.state.status !== 'available' && this.state.status !== 'error')) {
            return { success: false, error: 'Không có bản mới để tải' };
        }
        if (!this.deps.canInstall || !this.deps.updater) {
            this.deps.openExternal(this.latest.url);
            return { success: true };
        }
        const version = this.latest.version;
        this.setState({ status: 'downloading', version, percent: 0 });
        try {
            const found = await this.deps.updater.checkForUpdates() as { isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null;
            const foundVersion = found?.updateInfo?.version;
            if (!found || found.isUpdateAvailable === false || (foundVersion && foundVersion !== version)) {
                throw new Error(`không có bản ${version} để tải tự động (bản phát hành thiếu latest*.yml hoặc lệch phiên bản)`);
            }
            await this.deps.updater.downloadUpdate();
            return { success: true };
        } catch (err: any) {
            this.fail(err);
            return { success: false, error: (this.state as { message: string }).message };
        }
    }

    /** Quits and installs the downloaded update, then relaunches. Refused while a posting job runs. */
    public install(): ActionResult {
        if (this.state.status !== 'downloaded' || !this.deps.updater) {
            return { success: false, error: 'Chưa tải xong bản cập nhật' };
        }
        if (this.deps.isBusy()) return { success: false, error: BUSY_MESSAGE };
        this.deps.updater.quitAndInstall(false, true);
        return { success: true };
    }

    private fail(err: any): void {
        const full = String(err?.message || err);
        this.deps.log?.(`[AutoUpdate] Không tải được bản cập nhật: ${full}`);
        // electron-updater errors carry HTTP headers and a stack; the card shows only the first line, capped.
        const firstLine = full.split(/\r?\n/)[0].trim();
        const short = firstLine.length > ERROR_MAX_CHARS ? `${firstLine.slice(0, ERROR_MAX_CHARS - 1)}…` : firstLine;
        this.setState({ status: 'error', message: `Không tải được bản cập nhật: ${short}`, version: this.latest?.version ?? null });
    }

    private setState(next: UpdateState): void {
        this.state = next;
        try {
            this.deps.emit(next);
        } catch {
            // The window may be gone (quitting); the state is still correct for the next getState().
        }
    }
}
