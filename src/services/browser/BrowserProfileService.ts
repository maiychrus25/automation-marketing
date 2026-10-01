import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { EventEmitter } from 'events';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';
import { buildLaunchArgs, hostPersona } from './fingerprint';
import { ProxyForwarder } from './ProxyForwarder';

export const MAX_RUNNING_PROFILES = 30;
/** How long close() waits for a graceful exit before force-killing the browser. */
export const FORCE_KILL_DELAY_MS = 5000;

export interface ProfileStore {
    getBrowserProfileById(id: string): BrowserProfile | null;
    getProxyById(id: number): ProxyConfig | null;
    touchBrowserProfileOpened(id: string): void;
}

export interface ForwarderLike {
    start(): Promise<number>;
    stop(): Promise<void>;
}

/** The part of ChildProcess the service relies on. */
export interface BrowserProcess extends EventEmitter {
    pid?: number;
    kill(signal?: NodeJS.Signals): boolean;
}

export interface BrowserProfileServiceDeps {
    store: ProfileStore;
    getExecutablePath: () => string | null;
    /** Directory that holds one sub-directory of browser data per profile (depends on the active workspace). */
    getProfilesDir: () => string;
    platform?: NodeJS.Platform;
    spawnBrowser?: (executable: string, args: string[]) => BrowserProcess;
    createForwarder?: (proxy: ProxyConfig) => ForwarderLike;
    /** Asks the browser to exit. force=false must let Chromium flush cookies to disk. */
    terminate?: (child: BrowserProcess, force: boolean) => void;
    onStatusChanged?: (runningIds: string[]) => void;
}

interface RunningEntry {
    child: BrowserProcess | null;
    forwarder: ForwarderLike | null;
}

function defaultTerminate(platform: NodeJS.Platform): (child: BrowserProcess, force: boolean) => void {
    return (child, force) => {
        if (platform === 'win32') {
            // Without /F taskkill posts WM_CLOSE, which lets Chromium save the session.
            const args = ['/pid', String(child.pid), '/T'];
            if (force) args.push('/F');
            spawn('taskkill', args, { stdio: 'ignore' }).once('error', () => undefined);
            return;
        }
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
    };
}

/** Opens and closes browser profiles and tracks which ones are running. Running state lives in memory only. */
export class BrowserProfileService {
    private readonly running = new Map<string, RunningEntry>();
    private readonly platform: NodeJS.Platform;
    private readonly spawnBrowser: (executable: string, args: string[]) => BrowserProcess;
    private readonly createForwarder: (proxy: ProxyConfig) => ForwarderLike;
    private readonly terminate: (child: BrowserProcess, force: boolean) => void;

    constructor(private readonly deps: BrowserProfileServiceDeps) {
        this.platform = deps.platform || process.platform;
        this.spawnBrowser = deps.spawnBrowser || ((executable, args) => spawn(executable, args, { stdio: 'ignore' }));
        this.createForwarder = deps.createForwarder || ((proxy) => new ProxyForwarder(proxy));
        this.terminate = deps.terminate || defaultTerminate(this.platform);
    }

    public getRunningIds(): string[] {
        return Array.from(this.running.keys());
    }

    public isRunning(id: string): boolean {
        return this.running.has(id);
    }

    public getProfileDir(id: string): string {
        return path.join(this.deps.getProfilesDir(), id);
    }

    public async open(id: string): Promise<void> {
        if (this.running.has(id)) throw new Error('Profile đang mở');
        if (this.running.size >= MAX_RUNNING_PROFILES) {
            throw new Error(`Đã đạt giới hạn ${MAX_RUNNING_PROFILES} profile mở cùng lúc`);
        }
        const persona = hostPersona(this.platform);
        if (!persona) throw new Error('Hệ điều hành này chưa được hỗ trợ');
        const executable = this.deps.getExecutablePath();
        if (!executable) throw new Error('Chưa cài trình duyệt. Hãy tải trình duyệt trước.');
        const profile = this.deps.store.getBrowserProfileById(id);
        if (!profile) throw new Error('Không tìm thấy profile');
        let proxy: ProxyConfig | null = null;
        if (profile.proxy_id !== null && profile.proxy_id !== undefined) {
            proxy = this.deps.store.getProxyById(profile.proxy_id);
            if (!proxy) throw new Error('Proxy của profile không còn tồn tại. Hãy chọn proxy khác.');
        }

        // Reserve the slot before the first await so a second open() of the same profile is rejected.
        const entry: RunningEntry = { child: null, forwarder: null };
        this.running.set(id, entry);
        try {
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
            }
            const userDataDir = this.getProfileDir(id);
            fs.mkdirSync(userDataDir, { recursive: true });
            const child = this.spawnBrowser(
                executable,
                buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort }),
            );
            entry.child = child;
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', () => resolve());
                child.once('error', reject);
            });
            child.once('exit', () => this.release(id, entry));
            child.on('error', () => undefined);
        } catch (error: any) {
            this.release(id, entry);
            throw new Error(`Không mở được trình duyệt: ${error?.message || error}`);
        }
        this.deps.store.touchBrowserProfileOpened(id);
        this.notify();
    }

    /** Asks the browser to exit gracefully, then force-kills it if it is still alive after FORCE_KILL_DELAY_MS. */
    public close(id: string): void {
        const entry = this.running.get(id);
        if (!entry || !entry.child) return;
        const child = entry.child;
        this.terminate(child, false);
        const timer = setTimeout(() => {
            if (this.running.get(id) === entry) this.terminate(child, true);
        }, FORCE_KILL_DELAY_MS);
        timer.unref?.();
    }

    /** Used on app quit and workspace switch: graceful exit for every browser, state cleared immediately. */
    public closeAll(): void {
        const entries = Array.from(this.running.entries());
        for (const [id, entry] of entries) {
            if (entry.child) this.terminate(entry.child, false);
            this.release(id, entry);
        }
    }

    private release(id: string, entry: RunningEntry): void {
        if (this.running.get(id) !== entry) return;
        this.running.delete(id);
        entry.forwarder?.stop().catch(() => undefined);
        this.notify();
    }

    private notify(): void {
        this.deps.onStatusChanged?.(this.getRunningIds());
    }
}
