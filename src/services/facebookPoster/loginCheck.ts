import { randomUUID } from 'crypto';
import type { AutomationSession } from '../browser/BrowserProfileService';
import type { ProfileTaskContext } from '../browser/ProfileJobQueue';
import type { LoginCheckOutcome, LoginCheckSource, LoginState } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import { BUSY_ERROR, type ProfileInfo } from './FacebookPosterService';
import { FB_HOME, isLoggedIn } from './loginState';

const GOTO_TIMEOUT_MS = 45000;
export const PROFILE_OPEN_PREFIX = 'Profile đang mở';
/** Các luồng xác minh của Facebook (checkpoint cũ và xác minh hai bước / auth_platform mới). */
export const CHECKPOINT_PATHS = ['/checkpoint', '/two_step_verification', '/auth_platform'];

/** Đường dẫn của URL cho biết profile đang bị xác minh hay bị đá ra đăng nhập; URL hỏng hoặc bình thường thì null. */
export function loginProblemAt(url: string): 'checkpoint' | 'logged_out' | null {
    let path: string;
    try { path = new URL(url).pathname; } catch { return null; }
    if (CHECKPOINT_PATHS.some((prefix) => path.startsWith(prefix))) return 'checkpoint';
    if (path.startsWith('/login')) return 'logged_out';
    return null;
}

/** Tải đúng một trang chủ Facebook rồi xem đường dẫn; không bấm, không gõ, không cuộn. Lỗi điều hướng thì ném. */
export async function classifyLogin(session: Pick<AutomationSession, 'context'>, timeoutMs = GOTO_TIMEOUT_MS): Promise<LoginState> {
    const ctx = session.context;
    if (!(await isLoggedIn(ctx))) return 'logged_out';
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const problem = loginProblemAt(page.url());
    if (problem) return problem;
    if (!(await isLoggedIn(ctx))) return 'logged_out';
    return 'ok';
}

export interface LoginCheckResult { profileId: string; profileName: string; outcome: LoginCheckOutcome; error?: string; }

export interface LoginCheckerDeps {
    store: FacebookPosterStore;
    getProfile: (id: string) => ProfileInfo | null;
    openForAutomation: (profileId: string, context: ProfileTaskContext) => Promise<AutomationSession>;
    assertCurrent?: () => void;
    onProblem: (e: { profileId: string; profileName: string; state: LoginState; source: 'check' | 'run' }) => void;
    onFinished: (e: { checkId: string; source: LoginCheckSource; results: LoginCheckResult[] }) => void;
    onProgress: (p: { done: number; total: number } | null) => void;
    onStatesChanged: () => void;
    now?: () => number;
    newId?: () => string;
    classify?: typeof classifyLogin;
}

/** Kiểm tra lần lượt từng profile qua queue, giữ một job riêng trong lúc chạy. */
export class LoginChecker {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private stopping = false;
    private abort = new AbortController();

    constructor(private readonly deps: LoginCheckerDeps) {}

    /** Giữ admission riêng đồng bộ (ném BUSY khi job trước còn sống), sau đó chạy nền. */
    check(profileIds: string[], source: LoginCheckSource): { checkId: string; profileIds: string[] } {
        if (this.active) throw new Error(BUSY_ERROR);
        this.active = true;
        this.stopping = false;
        this.abort = new AbortController();
        try {
            const ids = [...profileIds];
            this.deps.assertCurrent?.();
            const checkId = (this.deps.newId ?? randomUUID)();
            this.running = Promise.resolve().then(() => this.run(checkId, ids, source));
            return { checkId, profileIds: [...ids] };
        } catch (error) {
            this.active = false;
            throw error;
        }
    }

    /** Ghi trạng thái quan sát được (kiểm tra hoặc lượt đăng); chỉ báo sự cố khi chuyển sang logged_out/checkpoint. */
    observe(profileId: string, state: LoginState, source: 'check' | 'run'): void {
        const previous = this.deps.store.setLoginState(profileId, state, source, (this.deps.now ?? Date.now)());
        this.deps.onStatesChanged();
        if ((state === 'logged_out' || state === 'checkpoint') && state !== previous) {
            this.deps.onProblem({ profileId, profileName: this.nameOf(profileId), state, source });
        }
    }

    isRunning(): boolean { return this.active; }
    stop(): void { this.stopping = true; this.abort.abort(); }
    whenIdle(): Promise<void> { return this.running; }

    private nameOf(profileId: string): string {
        return this.deps.getProfile(profileId)?.name ?? profileId;
    }

    private async run(checkId: string, profileIds: string[], source: LoginCheckSource): Promise<void> {
        const results: LoginCheckResult[] = [];
        try {
            this.deps.onProgress({ done: 0, total: profileIds.length });
            for (const profileId of profileIds) {
                if (this.stopping) break;
                results.push(await this.checkOne(profileId, { jobId: checkId, signal: this.abort.signal,
                    priority: source === 'daily' ? 'background' : 'interactive', assertCurrent: () => { this.deps.assertCurrent?.(); } }));
                this.deps.onProgress({ done: results.length, total: profileIds.length });
            }
        } finally {
            this.active = false;
            this.deps.onProgress(null);
            this.deps.onFinished({ checkId, source, results });
        }
    }

    private async checkOne(profileId: string, context: ProfileTaskContext): Promise<LoginCheckResult> {
        const profileName = this.nameOf(profileId);
        let session: AutomationSession | null = null;
        try {
            session = await this.deps.openForAutomation(profileId, context);
            context.assertCurrent();
            if (this.stopping) return { profileId, profileName, outcome: 'skipped' };
            const state = await (this.deps.classify ?? classifyLogin)(session);
            this.observe(profileId, state, 'check');
            return { profileId, profileName, outcome: state };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = (err as { code?: string })?.code;
            // A queue wait that was cancelled or timed out says nothing about the login: skip it without writing last_error.
            if (!session && (message.startsWith(PROFILE_OPEN_PREFIX) || code === 'profile_wait_cancelled' || code === 'profile_wait_timeout')) {
                return { profileId, profileName, outcome: 'skipped' };
            }
            try {
                this.deps.store.setLoginError(profileId, message, (this.deps.now ?? Date.now)());
                this.deps.onStatesChanged();
            } catch { /* không ghi được lỗi thì vẫn báo kết quả */ }
            return { profileId, profileName, outcome: 'error', error: message };
        } finally {
            await session?.close().catch(() => undefined);
        }
    }
}
