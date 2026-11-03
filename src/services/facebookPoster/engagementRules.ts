// Quy tắc thuần của bình luận góp ý chờ duyệt (spec 2026-11-02 §4–§6).

export const ENGAGEMENT_TTL_MS = 86_400_000;
/** Profile có từ chừng này gợi ý `pending` thì không còn chỗ nhận gợi ý mới (autonomy `engagementSlots`). */
export const ENGAGEMENT_MAX_PENDING = 10;
/** Một profile chỉ nhận lượt nghiên cứu gợi ý mới khi lần thử gần nhất cũ hơn mức này (giữ ngân sách lượt AI của `auto-tick`). */
export const ENGAGEMENT_RESEARCH_INTERVAL_MS = 4 * 3_600_000;
/** `app_settings`: JSON `{ [profileId]: lần thử nghiên cứu gần nhất (epoch ms) }`. */
export const ENGAGEMENT_RESEARCH_SETTING_KEY = 'engagement_research_last';
/** `app_settings`: thời điểm (epoch ms) lần dừng khẩn gần nhất; dòng duyệt trước hoặc đúng mốc này không được đăng nữa. */
export const ENGAGEMENT_STOP_EPOCH_SETTING_KEY = 'engagement_stop_epoch';
export const ENGAGEMENT_MAX_TEXT = 600;

/** Đọc khoan dung: giá trị hỏng hoặc sai kiểu coi như chưa nghiên cứu lần nào. */
export function parseResearchLast(raw: string | null | undefined): Record<string, number> {
    try {
        const value = JSON.parse(raw ?? '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
    } catch { return {}; }
}
export const LINK_IN_TEXT_ERROR = 'Câu bình luận không được chứa link';

const LINK_PATTERNS = [
    /\b(?:https?|ftp):\/\//i,
    /\bwww\./i,
    /\b[a-z0-9-]+\.(?:com|net|org|vn|me|ly|io|co|info|biz|xyz|link|site|online|shop|store|app|page|to|gl)\b/i,
];

export function containsLink(text: string): boolean {
    return LINK_PATTERNS.some((p) => p.test(text));
}

/** Trim, 1–600 ký tự, không link. Ném `Error` thuần (tiếng Việt) để Control API đổi thành INVALID_PARAMS. */
export function validateEngagementText(text: unknown): string {
    const t = typeof text === 'string' ? text.trim() : '';
    if (t.length < 1 || t.length > ENGAGEMENT_MAX_TEXT) throw new Error(`Câu bình luận phải dài 1–${ENGAGEMENT_MAX_TEXT} ký tự`);
    if (containsLink(t)) throw new Error(LINK_IN_TEXT_ERROR);
    return t;
}
