import { randomUUID } from 'crypto';
import type { AutomationSession } from '../browser/BrowserProfileService';
import type { PageIdentity, PageIdentityKind } from '../../models/dailyBrief';
import type { DailyBriefStore } from './DailyBriefStore';
import { PageLoginProblem, readPageIdentity } from './pageIdentity';
import { BUSY_ERROR } from '../facebookPoster/FacebookPosterService';
import { PROFILE_OPEN_PREFIX } from '../facebookPoster/loginCheck';

export const LEARN_FRESH_MS = 86400000;
export const LEARN_PAUSE_MIN_MS = 20000;
export const LEARN_PAUSE_MAX_MS = 60000;

export interface LearnResult { profileId: string; kind: PageIdentityKind | 'skipped'; pageName: string; error?: string }
export interface PageLearnerDeps {
    store: () => DailyBriefStore;
    openForAutomation: (id: string) => Promise<AutomationSession>;
    slot: { acquire(): void; release(): void };
    shouldYield: () => boolean;
    isResearchRunning: () => boolean;
    observeLogin: (id: string, state: 'ok' | 'checkpoint' | 'logged_out') => void;
    onFinished: (e: { jobId: string; results: LearnResult[] }) => void;
    read: typeof readPageIdentity;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    newId?: () => string;
}

/** Learns sequentially in the poster's shared slot; each job keeps its original workspace store. */
export class PageLearner {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private stopping = false;
    private wake: (() => void) | null = null;

    constructor(private readonly deps: PageLearnerDeps) {}

    learn(profileIds: string[], force: boolean): { jobId: string; profileIds: string[] } {
        if (this.active) throw new Error(BUSY_ERROR);
        // Reserve locally before calling injected code, which can reenter learn().
        this.active = true;
        this.stopping = false;
        let acquired = false;
        try {
            if (this.deps.isResearchRunning()) throw new Error(BUSY_ERROR);
            this.deps.slot.acquire();
            acquired = true;
            const store = this.deps.store();
            const jobId = (this.deps.newId ?? randomUUID)();
            const ids = [...profileIds];
            this.running = Promise.resolve().then(() => this.run(store, jobId, ids, force));
            return { jobId, profileIds: [...ids] };
        } catch (error) {
            try { if (acquired) this.deps.slot.release(); } finally { this.active = false; }
            throw error;
        }
    }

    isRunning(): boolean { return this.active; }
    stop(): void { this.stopping = true; this.wake?.(); }
    whenIdle(): Promise<void> { return this.running; }

    private async pause(): Promise<void> {
        if (this.stopping) return;
        let timer: NodeJS.Timeout | undefined;
        try {
            const woken = new Promise<void>((resolve) => { this.wake = resolve; });
            const ms = Math.round(LEARN_PAUSE_MIN_MS + (this.deps.random ?? Math.random)() * (LEARN_PAUSE_MAX_MS - LEARN_PAUSE_MIN_MS));
            const sleeping = this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
            await Promise.race([sleeping, woken]);
        } finally { clearTimeout(timer); this.wake = null; }
    }

    private async run(store: DailyBriefStore, jobId: string, ids: string[], force: boolean): Promise<void> {
        const results: LearnResult[] = [];
        let attempted = false;
        try {
            for (const profileId of ids) {
                if (this.stopping || this.deps.shouldYield()) break;
                const previous = store.getIdentity(profileId);
                const now = (this.deps.now ?? Date.now)();
                if (!force && previous && previous.kind !== 'unknown' && !previous.errorCode && !previous.error
                    && previous.learnedAt > 0 && now >= previous.learnedAt && now - previous.learnedAt < LEARN_FRESH_MS) {
                    results.push({ profileId, kind: 'skipped', pageName: previous.pageName });
                    continue;
                }
                if (attempted) await this.pause();
                if (this.stopping || this.deps.shouldYield()) break;
                attempted = true;
                results.push(await this.learnOne(store, profileId, previous));
            }
        } catch {
            // An injected dependency failure still completes the job and releases the shared slot.
        } finally {
            for (const profileId of ids.slice(results.length)) results.push({ profileId, kind: 'skipped', pageName: '' });
            try { this.deps.slot.release(); } catch { /* completion must survive a broken release callback */ }
            this.active = false;
            try { this.deps.onFinished({ jobId, results }); } catch { /* listeners cannot reject the background job */ }
        }
    }

    private async learnOne(store: DailyBriefStore, profileId: string, previous: PageIdentity | undefined): Promise<LearnResult> {
        const skipped: LearnResult = { profileId, kind: 'skipped', pageName: previous?.pageName ?? '' };
        let session: AutomationSession | null = null;
        try {
            session = await this.deps.openForAutomation(profileId);
            let reading: Awaited<ReturnType<typeof readPageIdentity>>;
            let readFailed = false;
            try {
                if (this.stopping) return skipped;
                const page = session.context.pages()[0] ?? await session.context.newPage();
                if (this.stopping) return skipped;
                reading = await this.deps.read(page);
            } catch (error) {
                readFailed = true;
                throw error;
            } finally {
                try { await session.close(); } catch (error) { if (!readFailed) throw error; }
            }
            if (this.stopping) return skipped;
            if (reading.kind === 'unknown') return this.failed(store, profileId, previous, 'unknown', 'Chưa xác định được danh tính Page');
            store.upsertIdentity({ ...reading, profileId, learnedAt: (this.deps.now ?? Date.now)(), errorCode: '', error: '' });
            try { this.deps.observeLogin(profileId, 'ok'); } catch { /* login listeners cannot corrupt successful learning */ }
            return { profileId, kind: reading.kind, pageName: reading.pageName };
        } catch (error) {
            if (this.stopping) return skipped;
            if (!session && error instanceof Error && error.message.startsWith(PROFILE_OPEN_PREFIX)) return skipped;
            if (error instanceof PageLoginProblem) {
                const result = this.failed(store, profileId, previous, error.state === 'logged_out' ? 'not_logged_in' : 'checkpoint', error.message);
                try { this.deps.observeLogin(profileId, error.state); } catch { /* login listeners cannot interrupt learning */ }
                return result;
            }
            return this.failed(store, profileId, previous, 'error', 'Không đọc được danh tính Page');
        }
    }

    private failed(store: DailyBriefStore, profileId: string, previous: PageIdentity | undefined, errorCode: string, error: string): LearnResult {
        // learnedAt describes successful evidence, never an unsuccessful attempt.
        store.upsertIdentity({
            ...(previous ?? { profileId, kind: 'unknown', pageId: '', pageName: '', category: '', about: '', recentPosts: [], learnedAt: 0 }),
            errorCode, error,
        });
        return { profileId, kind: 'unknown', pageName: previous?.pageName ?? '', error };
    }
}
