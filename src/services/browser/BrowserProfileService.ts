import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { EventEmitter } from 'events';
import type { BrowserContext } from 'playwright-core';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';
import { buildLaunchArgs, hostPersona, type Persona } from './fingerprint';
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

export interface AutomationSession {
    context: BrowserContext;
    /** Idempotent. */
    close(): Promise<void>;
}

export type LaunchAutomation = (executablePath: string, userDataDir: string, args: string[]) => Promise<BrowserContext>;

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
    /** Launches the engine through Playwright (--remote-debugging-pipe). Defaults to automationLauncher. */
    launchAutomation?: LaunchAutomation;
}

interface RunningEntry {
    /** Set only once the browser has actually spawned. */
    child: BrowserProcess | null;
    forwarder: ForwarderLike | null;
    /** close() was called while the browser was still starting; open() closes it right after the spawn. */
    closeRequested: boolean;
    exited: boolean;
    forceKillTimer: NodeJS.Timeout | null;
    /** Set only for automation sessions (openForAutomation). */
    context: BrowserContext | null;
    closing: Promise<void> | null;
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
        // Not SIGTERM: Chromium treats it as an OS session end and takes a fast shutdown that can drop
        // recently written cookies. SIGINT (like SIGHUP) closes all browsers normally and flushes them.
        child.kill(force ? 'SIGKILL' : 'SIGINT');
    };
}

/** Opens and closes browser profiles and tracks which ones are running. Running state lives in memory only. */
export class BrowserProfileService {
    private readonly running = new Map<string, RunningEntry>();
    private readonly platform: NodeJS.Platform;
    private readonly spawnBrowser: (executable: string, args: string[]) => BrowserProcess;
    private readonly createForwarder: (proxy: ProxyConfig) => ForwarderLike;
    private readonly terminate: (child: BrowserProcess, force: boolean) => void;
    private readonly launchAutomation: LaunchAutomation;

    constructor(private readonly deps: BrowserProfileServiceDeps) {
        this.platform = deps.platform || process.platform;
        this.spawnBrowser = deps.spawnBrowser || ((executable, args) => spawn(executable, args, { stdio: 'ignore' }));
        this.createForwarder = deps.createForwarder || ((proxy) => new ProxyForwarder(proxy));
        this.terminate = deps.terminate || defaultTerminate(this.platform);
        // Lazy require keeps playwright-core out of app start-up.
        this.launchAutomation = deps.launchAutomation
            || ((exe, dir, args) => require('./automationLauncher').launchAutomationBrowser(exe, dir, args));
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

    /** Checks shared by open() and openForAutomation(); throws before anything is reserved. */
    private prepareOpen(id: string, busyMessage: string): { profile: BrowserProfile; proxy: ProxyConfig | null; persona: Persona; executable: string } {
        if (this.running.has(id)) throw new Error(busyMessage);
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
        return { profile, proxy, persona, executable };
    }

    public async open(id: string): Promise<void> {
        const { profile, proxy, persona, executable } = this.prepareOpen(id, 'Profile đang mở');

        // Reserve the slot before the first await so a second open() of the same profile is rejected.
        const entry: RunningEntry = { child: null, forwarder: null, closeRequested: false, exited: false, forceKillTimer: null, context: null, closing: null };
        this.running.set(id, entry);
        try {
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
                this.assertNotCancelled(id, entry);
            }
            const userDataDir = this.getProfileDir(id);
            fs.mkdirSync(userDataDir, { recursive: true });
            const child = this.spawnBrowser(
                executable,
                buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort }),
            );
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', () => resolve());
                child.once('error', reject);
            });
            this.assertNotCancelled(id, entry, child);
            entry.child = child;
            child.once('exit', () => {
                entry.exited = true;
                if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
                this.release(id, entry);
            });
            child.on('error', () => undefined);
        } catch (error: any) {
            this.release(id, entry);
            throw new Error(`Không mở được trình duyệt: ${error?.message || error}`);
        }
        try {
            this.deps.store.touchBrowserProfileOpened(id);
        } catch (error: any) {
            // The browser is already running; failing to record the open time must not fail open().
            console.warn(`Không ghi được thời điểm mở profile ${id}:`, error?.message || error);
        }
        this.notify();
        if (entry.closeRequested) this.close(id);
    }

    /** Opens the profile under Playwright's control (pipe) so a job can drive its pages. Counts as a running profile. */
    public async openForAutomation(id: string): Promise<AutomationSession> {
        const { profile, proxy, persona, executable } = this.prepareOpen(id, 'Profile đang mở. Đóng profile trước khi chạy tự động');
        // Reserve the slot before the first await, same as open().
        const entry: RunningEntry = { child: null, forwarder: null, closeRequested: false, exited: false, forceKillTimer: null, context: null, closing: null };
        this.running.set(id, entry);
        let context: BrowserContext;
        try {
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
                this.assertNotCancelled(id, entry);
            }
            const userDataDir = this.getProfileDir(id);
            fs.mkdirSync(userDataDir, { recursive: true });
            const args = ['--remote-debugging-pipe', ...buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort })];
            context = await this.launchAutomation(executable, userDataDir, args);
            if (this.running.get(id) !== entry) {
                await context.close().catch(() => undefined);
                entry.forwarder?.stop().catch(() => undefined);
                throw new Error('Đã hủy mở trình duyệt');
            }
            entry.context = context;
            context.on('close', () => {
                entry.exited = true;
                this.release(id, entry);
            });
        } catch (error: any) {
            this.release(id, entry);
            throw new Error(`Không mở được trình duyệt: ${error?.message || error}`);
        }
        try {
            this.deps.store.touchBrowserProfileOpened(id);
        } catch (error: any) {
            // The browser is already running; failing to record the open time must not fail openForAutomation().
            console.warn(`Không ghi được thời điểm mở profile ${id}:`, error?.message || error);
        }
        this.notify();
        const session: AutomationSession = { context, close: () => this.closeAutomation(id, entry) };
        if (entry.closeRequested) void session.close();
        return session;
    }

    // ponytail: a persistent context exposes no browser process, so a hung close() only releases our slot; the browser may linger until it exits by itself.
    /** Graceful context.close() so Chromium flushes cookies; never waits longer than FORCE_KILL_DELAY_MS. Idempotent. */
    private closeAutomation(id: string, entry: RunningEntry): Promise<void> {
        if (!entry.context) {
            entry.closeRequested = true;
            return Promise.resolve();
        }
        if (!entry.closing) {
            const ctx = entry.context;
            entry.closing = Promise.race([
                ctx.close().catch(() => undefined),
                new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, FORCE_KILL_DELAY_MS);
                    (timer as any).unref?.();
                }),
            ]).then(() => { this.release(id, entry); });
        }
        return entry.closing;
    }

    /** Called after each await in open(): closeAll() may have released the entry meanwhile. */
    private assertNotCancelled(id: string, entry: RunningEntry, spawned?: BrowserProcess): void {
        if (this.running.get(id) === entry) return;
        if (spawned) this.terminate(spawned, true);
        // release() may have stopped the forwarder before its start() finished; stop() is idempotent.
        entry.forwarder?.stop().catch(() => undefined);
        throw new Error('Đã hủy mở trình duyệt');
    }

    /** Asks the browser to exit gracefully, then force-kills it if it is still alive after FORCE_KILL_DELAY_MS. */
    public close(id: string): void {
        const entry = this.running.get(id);
        if (!entry) return;
        if (entry.context || entry.closing) {
            void this.closeAutomation(id, entry);
            return;
        }
        if (!entry.child) {
            entry.closeRequested = true;
            return;
        }
        this.terminateWithFallback(entry, entry.child);
    }

    private terminateWithFallback(entry: RunningEntry, child: BrowserProcess): void {
        this.terminate(child, false);
        if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = setTimeout(() => {
            if (!entry.exited) this.terminate(child, true);
        }, FORCE_KILL_DELAY_MS);
        entry.forceKillTimer.unref?.();
    }

    /** Used on app quit and workspace switch: graceful exit (then force-kill if still alive) for every browser, state cleared immediately. */
    public closeAll(): void {
        const entries = Array.from(this.running.entries());
        for (const [id, entry] of entries) {
            if (entry.context) void this.closeAutomation(id, entry);
            if (entry.child) this.terminateWithFallback(entry, entry.child);
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
