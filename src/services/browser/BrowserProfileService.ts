import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { EventEmitter } from 'events';
import type { BrowserContext } from 'playwright-core';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';
import { buildLaunchArgs, hostPersona, type Persona } from './fingerprint';
import { ProxyForwarder } from './ProxyForwarder';
import type { SandboxState } from './sandboxSupport';

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

export interface AutomationReservation { readonly profileId: string }

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
    /** Whether the engine can run with its sandbox. Defaults to the old behaviour: Linux runs without it. */
    resolveSandbox?: (executable: string) => Promise<SandboxState>;
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
    cancelOpening?: boolean;
    releasing?: Promise<void>;
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
    private readonly reservations = new Map<string, { token: AutomationReservation; released: boolean }>();
    private readonly availabilityListeners = new Set<() => void>();
    private admissionPaused = false;
    private retired = false;
    private readonly platform: NodeJS.Platform;
    private readonly spawnBrowser: (executable: string, args: string[]) => BrowserProcess;
    private readonly createForwarder: (proxy: ProxyConfig) => ForwarderLike;
    private readonly terminate: (child: BrowserProcess, force: boolean) => void;
    private readonly launchAutomation: LaunchAutomation;
    private readonly resolveSandbox: (executable: string) => Promise<SandboxState>;

    constructor(private readonly deps: BrowserProfileServiceDeps) {
        this.platform = deps.platform || process.platform;
        this.spawnBrowser = deps.spawnBrowser || ((executable, args) => spawn(executable, args, { stdio: 'ignore' }));
        this.createForwarder = deps.createForwarder || ((proxy) => new ProxyForwarder(proxy));
        this.terminate = deps.terminate || defaultTerminate(this.platform);
        this.resolveSandbox = deps.resolveSandbox || (async () => (this.platform === 'linux' ? 'disabled' : 'enabled'));
        // Lazy require keeps playwright-core out of app start-up.
        this.launchAutomation = deps.launchAutomation
            || ((exe, dir, args) => require('./automationLauncher').launchAutomationBrowser(exe, dir, args));
    }

    public pauseAdmission(): void { this.admissionPaused = true; }

    public resumeAdmission(): void {
        if (this.retired) return;
        this.admissionPaused = false;
        this.notifyAvailability();
    }

    /** Retirement is permanent, and may not discard pending native ownership. */
    public retire(): void {
        if (!this.isIdle()) throw new Error('Trình duyệt chưa đóng xong. Thử lại sau.');
        this.admissionPaused = true;
        this.retired = true;
    }

    public tryReserveAutomation(profileId: string): AutomationReservation | null {
        if (this.admissionPaused || this.retired) return null;
        if (!this.deps.store.getBrowserProfileById(profileId)) throw new Error('Không tìm thấy profile');
        if (!this.canReserveAutomation(profileId)) return null;
        const token = Object.freeze({ profileId });
        this.reservations.set(profileId, { token, released: false });
        this.notifyAvailability();
        return token;
    }

    public canReserveAutomation(profileId: string): boolean {
        return !this.admissionPaused && !this.retired && !this.running.has(profileId) && !this.reservations.has(profileId)
            && this.occupiedCount() < MAX_RUNNING_PROFILES
            && this.deps.store.getBrowserProfileById(profileId) !== null;
    }

    public releaseAutomationReservation(token: AutomationReservation): void {
        const reservation = this.reservations.get(token.profileId);
        if (reservation?.token !== token) return;
        if (this.running.has(token.profileId)) reservation.released = true;
        else this.reservations.delete(token.profileId);
        this.notifyAvailability();
    }

    public onAvailabilityChanged(listener: () => void): () => void {
        this.availabilityListeners.add(listener);
        return () => { this.availabilityListeners.delete(listener); };
    }

    public isIdle(): boolean { return this.running.size === 0 && this.reservations.size === 0; }

    public waitUntilIdle(timeoutMs: number): Promise<boolean> {
        if (this.isIdle()) return Promise.resolve(true);
        return new Promise(resolve => {
            const finish = (idle: boolean) => { clearTimeout(timer); unsubscribe(); resolve(idle); };
            const unsubscribe = this.onAvailabilityChanged(() => { if (this.isIdle()) finish(true); });
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }

    private occupiedCount(): number {
        return new Set([...this.running.keys(), ...this.reservations.keys()]).size;
    }

    private notifyAvailability(): void {
        for (const listener of Array.from(this.availabilityListeners)) listener();
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
    private prepareOpen(id: string, busyMessage: string, token?: AutomationReservation): { profile: BrowserProfile; proxy: ProxyConfig | null; persona: Persona; executable: string } {
        if (this.admissionPaused || this.retired) throw new Error('Trình duyệt đang dừng, thử lại sau.');
        const reservation = this.reservations.get(id);
        if (token && (reservation?.token !== token || reservation.released)) throw new Error('Quyền giữ profile không còn hiệu lực');
        if (this.running.has(id) || (reservation && reservation.token !== token)) throw new Error(busyMessage);
        if (!reservation && this.occupiedCount() >= MAX_RUNNING_PROFILES) {
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
            const userDataDir = this.getProfileDir(id);
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
                this.assertNotCancelled(id, entry);
            }
            fs.mkdirSync(userDataDir, { recursive: true });
            const noSandbox = (await this.resolveSandbox(executable)) === 'disabled';
            this.assertNotCancelled(id, entry);
            const child = this.spawnBrowser(
                executable,
                buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort, noSandbox }),
            );
            child.once('exit', () => {
                entry.exited = true;
                if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
                this.release(id, entry);
            });
            child.on('error', () => undefined);
            await new Promise<void>((resolve, reject) => {
                child.once('spawn', () => { entry.child = child; resolve(); });
                child.once('error', reject);
            });
            this.assertNotCancelled(id, entry, child);
        } catch (error: any) {
            if (!entry.child || entry.exited) this.release(id, entry);
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
    public async openForAutomation(id: string, reservation?: AutomationReservation): Promise<AutomationSession> {
        const { profile, proxy, persona, executable } = this.prepareOpen(id, 'Profile đang mở. Đóng profile trước khi chạy tự động', reservation);
        // Reserve the slot before the first await, same as open().
        const entry: RunningEntry = { child: null, forwarder: null, closeRequested: false, exited: false, forceKillTimer: null, context: null, closing: null };
        this.running.set(id, entry);
        let context: BrowserContext;
        try {
            const userDataDir = this.getProfileDir(id);
            let proxyPort: number | null = null;
            if (proxy) {
                entry.forwarder = this.createForwarder(proxy);
                proxyPort = await entry.forwarder.start();
                this.assertNotCancelled(id, entry);
            }
            fs.mkdirSync(userDataDir, { recursive: true });
            const noSandbox = (await this.resolveSandbox(executable)) === 'disabled';
            this.assertNotCancelled(id, entry);
            const args = ['--remote-debugging-pipe', ...buildLaunchArgs({ userDataDir, fingerprint: profile.fingerprint, persona, proxyPort, noSandbox })];
            context = await this.launchAutomation(executable, userDataDir, args);
            entry.context = context;
            context.on('close', () => {
                entry.exited = true;
                this.release(id, entry);
            });
            if (entry.cancelOpening) {
                void this.closeAutomation(id, entry);
                throw new Error('Đã hủy mở trình duyệt');
            }
        } catch (error: any) {
            if (!entry.context || entry.exited) this.release(id, entry);
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

    /** Bounds the caller's wait, but retains authority until close succeeds or a close event confirms exit. */
    private closeAutomation(id: string, entry: RunningEntry): Promise<void> {
        if (entry.exited) return entry.releasing ?? Promise.resolve();
        if (!entry.context) {
            entry.closeRequested = true;
            return Promise.resolve();
        }
        if (!entry.closing) {
            const ctx = entry.context;
            let timer: NodeJS.Timeout;
            const closed = (async () => {
                try {
                    await ctx.close();
                    entry.exited = true;
                    this.release(id, entry);
                } catch {
                    // A rejected close is not evidence that the browser has stopped.
                } finally {
                    entry.closing = null;
                }
            })();
            entry.closing = Promise.race([
                closed,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, FORCE_KILL_DELAY_MS);
                    timer.unref?.();
                }),
            ]).finally(() => clearTimeout(timer));
        }
        return entry.closing;
    }

    /** Pending launches stay tracked until cancellation cleanup is confirmed. */
    private assertNotCancelled(id: string, entry: RunningEntry, spawned?: BrowserProcess): void {
        if (this.running.get(id) === entry && !entry.cancelOpening) return;
        if (spawned && !entry.exited) this.terminate(spawned, true);
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

    /** Used on app quit and workspace switch; authority remains until confirmed cleanup. */
    public closeAll(): void {
        for (const reservation of Array.from(this.reservations.values())) {
            this.releaseAutomationReservation(reservation.token);
        }
        for (const [id, entry] of Array.from(this.running.entries())) {
            if (entry.exited) { this.release(id, entry); continue; }
            entry.cancelOpening = true;
            entry.closeRequested = true;
            if (entry.context) void this.closeAutomation(id, entry);
            if (entry.child) this.terminateWithFallback(entry, entry.child);
        }
    }

    private release(id: string, entry: RunningEntry): void {
        if (this.running.get(id) !== entry || entry.releasing) return;
        entry.exited = true;
        if (entry.forwarder) {
            entry.releasing = entry.forwarder.stop().then(() => {
                entry.forwarder = null;
                entry.releasing = undefined;
                this.release(id, entry);
            }, () => {
                // Retain ownership until a later cleanup attempt confirms proxy shutdown.
                entry.releasing = undefined;
            });
            return;
        }
        this.running.delete(id);
        if (this.reservations.get(id)?.released) this.reservations.delete(id);
        this.notify();
    }

    private notify(): void {
        this.deps.onStatusChanged?.(this.getRunningIds());
        this.notifyAvailability();
    }
}
