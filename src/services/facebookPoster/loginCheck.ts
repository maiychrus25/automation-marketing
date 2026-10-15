import { randomUUID } from 'crypto';
import type { AutomationSession } from '../browser/BrowserProfileService';
import type { LoginCheckOutcome, LoginCheckSource, LoginState } from '../../models/facebookPoster';
import type { FacebookPosterStore } from './FacebookPosterStore';
import type { ProfileInfo } from './FacebookPosterService';
import { FB_HOME, isLoggedIn } from './loginState';

const GOTO_TIMEOUT_MS = 45000;
const PROFILE_OPEN_PREFIX = 'Profile đang mở';

/** Tải đúng một trang chủ Facebook rồi xem đường dẫn; không bấm, không gõ, không cuộn. Lỗi điều hướng thì ném. */
export async function classifyLogin(session: Pick<AutomationSession, 'context'>, timeoutMs = GOTO_TIMEOUT_MS): Promise<LoginState> {
    const ctx = session.context;
    if (!(await isLoggedIn(ctx))) return 'logged_out';
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const path = new URL(page.url()).pathname;
    if (path.startsWith('/checkpoint')) return 'checkpoint';
    if (path.startsWith('/login') || !(await isLoggedIn(ctx))) return 'logged_out';
    return 'ok';
}

export interface LoginCheckResult { profileId: string; profileName: string; outcome: LoginCheckOutcome; error?: string; }

export interface LoginCheckerDeps {
    store: FacebookPosterStore;
    getProfile: (id: string) => ProfileInfo | null;
    openForAutomation: (profileId: string) => Promise<AutomationSession>;
    slot: { acquire(): void; release(): void };
    onProblem: (e: { profileId: string; profileName: string; state: LoginState; source: 'check' | 'run' }) => void;
    onFinished: (e: { checkId: string; source: LoginCheckSource; results: LoginCheckResult[] }) => void;
    onProgress: (p: { done: number; total: number } | null) => void;
    onStatesChanged: () => void;
    now?: () => number;
    newId?: () => string;
    classify?: typeof classifyLogin;
}

/** Kiểm tra đăng nhập lần lượt từng profile, giữ khe việc của FacebookPosterService trong lúc chạy. */
export class LoginChecker {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private stopping = false;

    constructor(private readonly deps: LoginCheckerDeps) {}

    /** Đồng bộ đến khi giành được khe (ném BUSY nếu không được), sau đó chạy nền. */
    check(profileIds: string[], source: LoginCheckSource): { checkId: string; profileIds: string[] } {
        this.deps.slot.acquire();
        const checkId = (this.deps.newId ?? randomUUID)();
        this.active = true;
        this.stopping = false;
        this.running = this.run(checkId, profileIds, source);
        return { checkId, profileIds };
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
    stop(): void { this.stopping = true; }
    whenIdle(): Promise<void> { return this.running; }

    private nameOf(profileId: string): string {
        return this.deps.getProfile(profileId)?.name ?? profileId;
    }

    private async run(checkId: string, profileIds: string[], source: LoginCheckSource): Promise<void> {
        const results: LoginCheckResult[] = [];
        try {
            for (const profileId of profileIds) {
                if (this.stopping) break;
                results.push(await this.checkOne(profileId));
                this.deps.onProgress({ done: results.length, total: profileIds.length });
            }
        } finally {
            this.active = false;
            this.deps.slot.release();
            this.deps.onProgress(null);
            this.deps.onFinished({ checkId, source, results });
        }
    }

    private async checkOne(profileId: string): Promise<LoginCheckResult> {
        const profileName = this.nameOf(profileId);
        let session: AutomationSession | null = null;
        try {
            session = await this.deps.openForAutomation(profileId);
            const state = await (this.deps.classify ?? classifyLogin)(session);
            this.observe(profileId, state, 'check');
            return { profileId, profileName, outcome: state };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!session && message.startsWith(PROFILE_OPEN_PREFIX)) return { profileId, profileName, outcome: 'skipped' };
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
