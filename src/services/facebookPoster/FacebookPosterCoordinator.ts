import { randomUUID } from 'crypto';
import { BUSY_ERROR, FacebookPosterService, type RunSnapshot, type RunStartOptions, type StartParams } from './FacebookPosterService';
import type { FacebookPosterStore } from './FacebookPosterStore';

export const MAX_ACTIVE_POSTER_RUNS = 2;
export class PosterRunSelectionError extends Error {
    constructor(public readonly code: 'CONFLICT' | 'NOT_FOUND') {
        super(code === 'CONFLICT' ? 'Chọn lượt cần dừng' : 'Không tìm thấy lượt');
    }
}
export interface FacebookPosterCoordinatorDeps {
    store: FacebookPosterStore;
    createWorker: (runId: string) => FacebookPosterService;
    newId?: () => string;
    onChanged?: () => void;
}
interface Entry { worker?: FacebookPosterService; settled: Promise<void>; resolve: () => void; }

/** Admission includes factories and profile waiters, not just running browsers. */
export class FacebookPosterCoordinator {
    private readonly entries = new Set<Entry>();
    private readonly runs = new Map<string, Entry>();
    private paused = false;
    private retired = false;

    constructor(private readonly deps: FacebookPosterCoordinatorDeps) {}

    start(params: StartParams, scheduleId?: string, options?: RunStartOptions): { runId: string } {
        if (!this.hasCapacity()) throw new Error(BUSY_ERROR);
        let resolve!: () => void;
        const entry: Entry = { settled: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
        this.entries.add(entry);
        let runId: string | undefined;
        try {
            const captured = structuredClone(params);
            const capturedOptions = options ? { ...options } : undefined;
            runId = (this.deps.newId ?? randomUUID)();
            if (this.runs.has(runId) || this.deps.store.getRun(runId)) throw new Error('Lượt đã tồn tại');
            this.runs.set(runId, entry);
            entry.worker = this.deps.createWorker(runId);
            const result = entry.worker.start(captured, scheduleId, capturedOptions);
            void entry.worker.whenIdle().then(() => this.release(runId!, entry), () => this.release(runId!, entry));
            this.changed();
            return result;
        } catch (error) {
            this.release(runId, entry);
            throw error;
        }
    }

    active(): RunSnapshot[] {
        return Array.from(this.entries).flatMap(entry => {
            const snapshot = entry.worker?.current();
            return snapshot ? [snapshot] : [];
        }).sort((a, b) => a.run.startedAt - b.run.startedAt || a.run.id.localeCompare(b.run.id));
    }
    current(): RunSnapshot | null { return this.active()[0] ?? null; }
    hasCapacity(): boolean { return !this.paused && this.entries.size < MAX_ACTIVE_POSTER_RUNS; }
    isBusy(): boolean { return this.entries.size > 0; }
    cancel(runId?: string): boolean {
        if (runId === undefined) {
            if (this.entries.size > 1) throw new PosterRunSelectionError('CONFLICT');
            const entry = this.entries.values().next().value as Entry | undefined;
            if (!entry?.worker?.current()) return false;
            entry.worker.cancel();
            return true;
        }
        const entry = this.runs.get(runId);
        if (entry?.worker?.current()) { entry.worker.cancel(); return true; }
        if (entry || this.deps.store.getRun(runId)) return false;
        throw new PosterRunSelectionError('NOT_FOUND');
    }
    cancelAll(): void { for (const entry of this.entries) entry.worker?.cancel(); }
    async whenIdle(): Promise<void> {
        while (this.entries.size) await Promise.all(Array.from(this.entries, entry => entry.settled));
    }
    async stopAndWait(graceMs = 45000, forceMs = 10000): Promise<boolean> {
        const stopped = await Promise.all(Array.from(this.entries, entry => entry.worker?.stopAndWait(graceMs, forceMs) ?? Promise.resolve(false)));
        return stopped.every(Boolean) && !this.isBusy();
    }
    pause(): void { this.paused = true; }
    resume(): void { if (!this.retired) { this.paused = false; this.changed(); } }
    retire(): void {
        if (this.isBusy()) throw new Error(BUSY_ERROR);
        this.paused = true;
        this.retired = true;
    }

    private release(runId: string | undefined, entry: Entry): void {
        this.entries.delete(entry);
        if (runId !== undefined && this.runs.get(runId) === entry) this.runs.delete(runId);
        entry.resolve();
        this.changed();
    }
    private changed(): void {
        try { this.deps.onChanged?.(); } catch { /* Observers cannot change admission or completion. */ }
    }
}
