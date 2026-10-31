import type { AutomationReservation, AutomationSession, BrowserProfileService } from './BrowserProfileService';

export const PROFILE_JOB_WAIT_MS = 7200000;
export type ProfileJobOwner = { workspaceId: string; generation: number; jobId: string };
export type ProfileJobPriority = 'scheduled' | 'interactive' | 'background';
export type ProfileTaskContext = {
    jobId: string;
    signal: AbortSignal;
    priority: ProfileJobPriority;
    deadlineAt?: number;
    assertCurrent: () => void;
    onWaiting?: (reason: string) => void;
};
export type ProfileJobRequest = Omit<ProfileTaskContext, 'jobId'> & { owner: ProfileJobOwner; profileId: string };
export type ProfileJobLease = { profileId: string; open(): Promise<AutomationSession>; release(): void };
export interface ProfileJobQueueDeps {
    browser: BrowserProfileService;
    now?: () => number;
    deferUntil?: (request: ProfileJobRequest, now: number) => number | null;
    onChanged?: () => void;
}

interface Waiter {
    request: ProfileJobRequest;
    deadline: number;
    sequence: number;
    resolve: (lease: ProfileJobLease) => void;
    reject: (error: unknown) => void;
    abort: () => void;
    waiting: boolean;
}

interface HeldLease {
    token: AutomationReservation;
    released: boolean;
}

function waitError(code: 'profile_wait_timeout' | 'profile_wait_cancelled'): Error & { code: string } {
    return Object.assign(new Error(code === 'profile_wait_timeout' ? 'Hết thời gian chờ profile' : 'Đã hủy chờ profile'), { code });
}

const PRIORITY: Record<ProfileJobPriority, number> = { scheduled: 0, interactive: 1, background: 2 };

export class ProfileJobQueue {
    private readonly now: () => number;
    private readonly waiters = new Set<Waiter>();
    private readonly held = new Set<HeldLease>();
    private readonly idleListeners = new Set<() => void>();
    private readonly unsubscribe: () => void;
    private scope: { workspaceId: string; generation: number } | null = null;
    private sequence = 0;
    private paused = false;
    private retired = false;
    private pumping = false;
    private pumpAgain = false;
    private notifyingChanged = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly deps: ProfileJobQueueDeps) {
        this.now = deps.now || Date.now;
        this.unsubscribe = deps.browser.onAvailabilityChanged(() => this.notifyAvailability());
    }

    public acquire(request: ProfileJobRequest): Promise<ProfileJobLease> {
        const captured = { ...request, owner: { ...request.owner } };
        return new Promise((resolve, reject) => {
            try {
                // Cheap check only: a paused queue still accepts waiters, and the caller's full authority check runs at grant.
                this.assertLive(captured);
                if (!this.scope) this.scope = { workspaceId: captured.owner.workspaceId, generation: captured.owner.generation };
            } catch (error) { reject(error); return; }
            const waiter: Waiter = {
                request: captured,
                deadline: Math.min(captured.deadlineAt ?? Infinity, this.now() + PROFILE_JOB_WAIT_MS),
                sequence: this.sequence++, resolve, reject, waiting: false,
                abort: () => { this.remove(waiter); reject(waitError('profile_wait_cancelled')); this.notifyAvailability(); },
            };
            this.waiters.add(waiter);
            captured.signal.addEventListener('abort', waiter.abort, { once: true });
            this.notifyAvailability();
        });
    }

    public async open(request: ProfileJobRequest): Promise<AutomationSession> {
        const lease = await this.acquire(request);
        try {
            const session = await lease.open();
            session.context.once('close', () => lease.release());
            let closing: Promise<void> | undefined;
            return { context: session.context, close: () => {
                if (!closing) closing = session.close().finally(() => lease.release());
                return closing;
            } };
        } catch (error) { lease.release(); throw error; }
    }

    public canAcquire(profileId: string): boolean {
        return !this.paused && !this.retired && this.deps.browser.canReserveAutomation(profileId);
    }

    public isBusy(): boolean { return this.waiters.size > 0 || this.held.size > 0; }

    public notifyAvailability(): void {
        if (this.pumping) { this.pumpAgain = true; return; }
        this.pumping = true;
        try {
            do {
                this.pumpAgain = false;
                clearTimeout(this.timer);
                this.timer = undefined;
                for (const held of this.held) {
                    if (held.released && !this.deps.browser.isRunning(held.token.profileId)) this.held.delete(held);
                }
                let nextWake = Infinity;
                const ordered = [...this.waiters].sort((a, b) => PRIORITY[a.request.priority] - PRIORITY[b.request.priority] || a.sequence - b.sequence);
                for (const waiter of ordered) {
                    if (!this.waiters.has(waiter)) continue;
                    try {
                        // Cheap checks on every pass; the caller's full authority check runs only once a profile is reserved.
                        this.assertLive(waiter.request);
                        const now = this.now();
                        if (now >= waiter.deadline) throw waitError('profile_wait_timeout');
                        const defer = this.paused ? null : this.deps.deferUntil?.(waiter.request, now);
                        if (defer != null && defer > now) {
                            nextWake = Math.min(nextWake, defer, waiter.deadline);
                        } else {
                            const token = this.paused ? null : this.deps.browser.tryReserveAutomation(waiter.request.profileId);
                            // A synchronous availability callback may pause admission: hand the reservation back and keep waiting.
                            if (token && this.paused) this.deps.browser.releaseAutomationReservation(token);
                            else if (token) {
                                try {
                                    this.assertRequest(waiter.request);
                                    if (!this.waiters.has(waiter)) throw waitError('profile_wait_cancelled');
                                } catch (error) {
                                    this.deps.browser.releaseAutomationReservation(token);
                                    throw error;
                                }
                                this.remove(waiter);
                                waiter.resolve(this.makeLease(waiter.request, token));
                                continue;
                            }
                            nextWake = Math.min(nextWake, waiter.deadline);
                        }
                        if (!waiter.waiting) {
                            waiter.waiting = true;
                            waiter.request.onWaiting?.('Đang chờ profile khả dụng');
                        }
                    } catch (error) {
                        this.remove(waiter);
                        waiter.reject(error);
                    }
                }
                if (Number.isFinite(nextWake)) {
                    this.timer = setTimeout(() => this.notifyAvailability(), Math.max(0, nextWake - this.now()));
                    this.timer.unref?.();
                }
            } while (this.pumpAgain);
        } finally { this.pumping = false; }
        if (this.retired && !this.isBusy()) this.unsubscribe();
        for (const listener of Array.from(this.idleListeners)) listener();
        if (!this.notifyingChanged) {
            this.notifyingChanged = true;
            try { this.deps.onChanged?.(); } finally { this.notifyingChanged = false; }
        }
    }

    /** Stops new grants; existing waiters keep their original deadlines and leave only by their own abort, timeout or retire(). */
    public pause(): void {
        this.paused = true;
        this.notifyAvailability();
    }

    public resume(): void {
        if (this.retired) return;
        this.paused = false;
        this.notifyAvailability();
    }

    public retire(): void {
        this.retired = true;
        this.paused = true;
        for (const waiter of this.waiters) {
            this.remove(waiter);
            waiter.reject(waitError('profile_wait_cancelled'));
        }
        this.notifyAvailability();
    }

    public waitUntilIdle(timeoutMs: number): Promise<boolean> {
        if (!this.isBusy()) return Promise.resolve(true);
        return new Promise(resolve => {
            const finish = (idle: boolean) => { clearTimeout(timer); this.idleListeners.delete(changed); resolve(idle); };
            const changed = () => { if (!this.isBusy()) finish(true); };
            this.idleListeners.add(changed);
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }

    /** Full check at grant and launch: admission open plus the caller's own authority. */
    private assertRequest(request: ProfileJobRequest): void {
        if (this.paused) throw waitError('profile_wait_cancelled');
        this.assertLive(request);
        request.assertCurrent();
    }

    /** Cheap per-pump check: retirement, the job's own cancel, and the captured workspace generation. */
    private assertLive(request: ProfileJobRequest): void {
        if (this.retired || request.signal.aborted) throw waitError('profile_wait_cancelled');
        if (this.scope && (request.owner.workspaceId !== this.scope.workspaceId || request.owner.generation !== this.scope.generation)) {
            throw new Error('Quyền workspace của công việc không còn hiệu lực');
        }
    }

    private remove(waiter: Waiter): void {
        this.waiters.delete(waiter);
        waiter.request.signal.removeEventListener('abort', waiter.abort);
    }

    private makeLease(request: ProfileJobRequest, token: AutomationReservation): ProfileJobLease {
        const held: HeldLease = { token, released: false };
        this.held.add(held);
        const release = () => {
            if (held.released) return;
            held.released = true;
            this.deps.browser.releaseAutomationReservation(token);
            this.notifyAvailability();
        };
        return { profileId: token.profileId, release, open: async () => {
            if (held.released) throw new Error('Quyền giữ profile không còn hiệu lực');
            this.assertRequest(request);
            // A multi-session owner retains its lease through launch retry; open() convenience releases on failure.
            return this.deps.browser.openForAutomation(token.profileId, token);
        } };
    }
}
