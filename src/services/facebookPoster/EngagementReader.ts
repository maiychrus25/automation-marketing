import { ControlError } from '../control/ControlMethods';
import { JOB_WORKSPACE_REVOKED_ERROR, type ProfileTaskContext } from '../browser/ProfileJobQueue';
import type { LaunchedPage } from './types';
import type { CollectedComment, collectComments } from './collectComments';
import { FACEBOOK_URL } from './engagementOperations';

// Đọc bình luận công khai của một bài ứng viên cho `engagement.readComments`: chỉ đọc, giữ trong bộ nhớ, không ghi kho bình luận/khách.

export const READ_COMMENTS_MAX = 50;
export const READ_COMMENT_TEXT_MAX = 500;
export const READ_WAIT_MS = 60_000;

export interface EngagementReaderDeps {
    profileExists(id: string): boolean;
    /** Giờ im lặng + profile đang dừng, không đếm trần; ném `LIMIT_REACHED`. */
    gate(profileId: string): void;
    launchFor(profileId: string, context: ProfileTaskContext): Promise<LaunchedPage & { close(): Promise<void> }>;
    collect: typeof collectComments;
    observeLogin?(profileId: string, state: 'logged_out' | 'checkpoint'): void;
    assertCurrent?(): void;
    newId?(): string;
    now?(): number;
}

export interface ReadComment { authorName: string; text: string; commentedAt: string }

const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code;

export async function readEngagementComments(deps: EngagementReaderDeps, p: { profileId: unknown; postUrl: unknown }): Promise<{ comments: ReadComment[] }> {
    const { profileId, postUrl } = p;
    if (typeof profileId !== 'string' || !profileId.trim()) throw new ControlError('INVALID_PARAMS', 'profileId không hợp lệ', { field: 'profileId' });
    if (!deps.profileExists(profileId)) throw new ControlError('NOT_FOUND', 'Không tìm thấy profile');
    if (typeof postUrl !== 'string' || postUrl.length > 2000 || !FACEBOOK_URL.test(postUrl)) throw new ControlError('INVALID_PARAMS', 'postUrl phải là link bài trên Facebook', { field: 'postUrl' });
    const current = () => { try { deps.assertCurrent?.(); } catch { throw new ControlError('BUSY', 'Workspace đang chuyển, thử lại sau'); } };
    deps.gate(profileId);
    current();

    const rows: CollectedComment[] = [];
    let opened: (LaunchedPage & { close(): Promise<void> }) | null = null;
    const abort = new AbortController();
    const loginProblem = (state: 'logged_out' | 'checkpoint') => {
        try { deps.observeLogin?.(profileId, state); } catch { /* observing must not break the read */ }
        return new ControlError('CONFLICT', 'Profile cần đăng nhập lại Facebook, đã dừng tự động cho profile này', { reason: state });
    };
    try {
        const result = await deps.collect(
            { posts: [{ postUrl }], maxPerPost: READ_COMMENTS_MAX, stopOnLoginProblem: true },
            {
                launch: async () => {
                    opened = await deps.launchFor(profileId, {
                        jobId: deps.newId?.() ?? `engagement-read-${Date.now()}`, signal: abort.signal, priority: 'background',
                        // Short wait: the Control API call times out long before the queue's own limit, and a late job must not outlive the caller.
                        deadlineAt: (deps.now?.() ?? Date.now()) + READ_WAIT_MS,
                        assertCurrent: current, // a switch during the queue wait is BUSY, not INTERNAL
                    });
                    deps.gate(profileId); // the wait may have crossed quiet hours or a pause; the session is closed in finally
                    return { ctx: opened.ctx, page: opened.page };
                },
                getIsStopping: () => { try { deps.assertCurrent?.(); return false; } catch { return true; } },
                sendLog: () => undefined, // never log other people's comment text
                updateProgress: () => undefined,
                loadKeys: async () => new Set<string>(),
                saveComments: async (fresh) => { rows.push(...fresh); return fresh.length; },
            },
        );
        if (result.loginProblem) throw loginProblem(result.loginProblem);
        if (result.results.some((r) => r.outcome === 'failed')) throw new ControlError('INTERNAL', 'Không đọc được bình luận của bài này, thử lại sau');
    } catch (err) {
        if (err instanceof ControlError) throw err;
        const code = codeOf(err);
        if (code === 'logged_out' || code === 'checkpoint') throw loginProblem(code);
        if (code === 'profile_wait_timeout') throw new ControlError('BUSY', 'Profile đang bận, thử lại sau');
        // A workspace switch pauses/retires the queue before the caller's own assertCurrent runs.
        if (code === 'profile_wait_cancelled' || (err instanceof Error && err.message === JOB_WORKSPACE_REVOKED_ERROR)) throw new ControlError('BUSY', 'Workspace đang chuyển, thử lại sau');
        throw new ControlError('INTERNAL', 'Không đọc được bình luận của bài này, thử lại sau');
    } finally {
        await (opened as { close(): Promise<void> } | null)?.close().catch(() => undefined);
    }
    current();
    return {
        comments: rows.slice(0, READ_COMMENTS_MAX).map((c) => ({ authorName: c.authorName, text: c.text.slice(0, READ_COMMENT_TEXT_MAX), commentedAt: c.commentedAt })),
    };
}
