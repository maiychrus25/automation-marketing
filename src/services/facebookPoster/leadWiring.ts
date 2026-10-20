// Các phần nối của "Khách tiềm năng" với bên ngoài (AI, trình duyệt, tệp Excel), tách khỏi IPC để kiểm thử được.
// Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.
import type { FbPosterLead, LeadStatus } from '../../models/facebookPoster';
import type { LaunchedPage } from './types';
import { buildLeadPrompt, parseLeadVerdicts, type LeadClassifier } from './leadAi';

/** Một lô AI chạy trong khe việc chung nên phải có hạn: quá hạn thì coi như AI không dùng được. */
export const AI_BATCH_TIMEOUT_MS = 60_000;

export interface LeadClassifierDeps {
    /** Trợ lý AI mặc định; null = chưa cấu hình. */
    getAssistantId: () => string | null;
    chat: (assistantId: string, messages: { role: string; content: string }[]) => Promise<{ result: string }>;
    timeoutMs?: number;
}

/** Adapter AI cho LeadDetector. Không bao giờ ném lỗi: lỗi / hết hạn / chưa cấu hình / JSON hỏng đều trả null. */
export function createLeadClassifier(deps: LeadClassifierDeps): LeadClassifier {
    return async (comments) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const assistantId = deps.getAssistantId();
            if (!assistantId) return null;
            const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs ?? AI_BATCH_TIMEOUT_MS); });
            const reply = await Promise.race([deps.chat(assistantId, buildLeadPrompt(comments)), timeout]);
            return reply ? parseLeadVerdicts(reply.result, comments.length) : null;
        } catch {
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
}

export const NOT_LOGGED_IN_COLLECT_ERROR = 'Profile chưa đăng nhập Facebook';

/** Mở phiên để thu bình luận; chưa đăng nhập thì đóng phiên và ném lỗi có `code = 'logged_out'` (CommentCollector đọc mã này). */
export async function openLoggedInSession(
    open: () => Promise<{ context: LaunchedPage['ctx']; close(): Promise<void> }>,
    isLoggedIn: (ctx: LaunchedPage['ctx']) => Promise<boolean>,
): Promise<LaunchedPage & { close(): Promise<void> }> {
    const session = await open();
    try {
        if (!(await isLoggedIn(session.context))) {
            throw Object.assign(new Error(NOT_LOGGED_IN_COLLECT_ERROR), { code: 'logged_out' });
        }
        const ctx = session.context;
        return { ctx, page: ctx.pages()[0] ?? await ctx.newPage(), close: () => session.close() };
    } catch (err) {
        await session.close().catch(() => undefined);
        throw err;
    }
}

const STATUS_LABELS: Record<LeadStatus, string> = { new: 'Mới', contacted: 'Đã liên hệ', won: 'Chốt đơn', ignored: 'Bỏ qua' };

/** Dòng của tệp Excel khách tiềm năng (tiêu đề cột tiếng Việt). */
export function buildLeadSheetRows(leads: FbPosterLead[]): Record<string, string | number>[] {
    const time = (ms: number | null) => (ms === null ? '' : new Date(ms).toLocaleString('vi-VN'));
    return leads.map((l) => ({
        'Phát hiện lúc': time(l.detectedAt),
        'Người bình luận': l.authorName,
        'Trang cá nhân': l.authorUrl,
        'Nội dung': l.text,
        'Bình luận lúc': time(l.commentedAtMs),
        'Từ khoá khớp': l.matched.join(', '),
        'Điểm AI': l.aiScore ?? '',
        'Ý định AI': l.aiIntent ?? '',
        'Lý do AI': l.aiReason ?? '',
        'Trạng thái': STATUS_LABELS[l.status] ?? l.status,
        'Ghi chú': l.note,
        'Link bài': l.postUrl,
        'Nhóm': l.groupUrl,
    }));
}
