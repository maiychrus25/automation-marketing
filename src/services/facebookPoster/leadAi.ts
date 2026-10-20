// Prompt và đọc kết quả AI cho "Khách tiềm năng". Thuần: không gọi AI, bộ điều phối (Task 5) nối vào AIAssistantService.
// Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.2.

export type LeadIntent = 'buy' | 'question' | 'other';
export interface LeadVerdict { intent: LeadIntent; score: number; reason: string }
/** `null` = AI không dùng được (chưa cấu hình, hết hạn mức, JSON hỏng...). Phần tử `null` = không đọc được kết quả của bình luận đó. */
export type LeadClassifier = (comments: { text: string }[]) => Promise<(LeadVerdict | null)[] | null>;

const SYSTEM_PROMPT = [
    'Bạn là trợ lý phân loại bình luận cho người bán hàng trên Facebook.',
    'Mỗi bình luận nằm dưới một bài đăng bán hàng của người bán. Hãy đánh giá ý định mua hàng của người bình luận.',
    'Với mỗi bình luận, trả về: "i" (số thứ tự bình luận, bắt đầu từ 0), "intent" ("buy" nếu muốn mua / để lại liên hệ,',
    '"question" nếu hỏi thông tin về sản phẩm, "other" nếu không liên quan), "score" (số nguyên 0-100: khả năng là khách thật), "reason" (lý do ngắn gọn, tiếng Việt).',
    'Chỉ trả về MỘT mảng JSON hợp lệ, không giải thích thêm, không dùng khối code. Ví dụ: [{"i":0,"intent":"buy","score":85,"reason":"Hỏi giá và xin ship"}]',
].join('\n');

export function buildLeadPrompt(comments: { text: string }[]): { role: 'system' | 'user'; content: string }[] {
    const lines = comments.map((c, i) => `${i}. ${JSON.stringify(String(c.text ?? ''))}`);
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Phân loại ${comments.length} bình luận sau:\n${lines.join('\n')}` },
    ];
}

const INTENTS: readonly string[] = ['buy', 'question', 'other'];

/** Tìm mảng JSON đầu tiên trong văn bản (bỏ khối code và chữ thừa); null nếu không có. */
function extractArray(text: string): unknown[] | null {
    const body = text.replace(/```(?:json)?/gi, ' ');
    for (let start = body.indexOf('['); start !== -1; start = body.indexOf('[', start + 1)) {
        for (let end = body.lastIndexOf(']'); end > start; end = body.lastIndexOf(']', end - 1)) {
            try {
                const parsed = JSON.parse(body.slice(start, end + 1));
                if (Array.isArray(parsed)) return parsed;
            } catch { /* thử đoạn ngắn hơn */ }
        }
    }
    return null;
}

/** Kết quả theo vị trí trong lô (độ dài `count`); mục sai hoặc thiếu là null; score kẹp 0-100. Không đọc được gì thì trả null. */
export function parseLeadVerdicts(text: string, count: number): (LeadVerdict | null)[] | null {
    const items = extractArray(String(text ?? ''));
    if (!items) return null;
    const out: (LeadVerdict | null)[] = Array.from({ length: count }, () => null);
    let valid = 0;
    for (const item of items) {
        const v = item as { i?: unknown; intent?: unknown; score?: unknown; reason?: unknown } | null;
        if (!v || typeof v !== 'object') continue;
        const score = typeof v.score === 'number' ? v.score : typeof v.score === 'string' ? Number(v.score) : NaN;
        if (!Number.isInteger(v.i) || (v.i as number) < 0 || (v.i as number) >= count
            || typeof v.intent !== 'string' || !INTENTS.includes(v.intent) || !Number.isFinite(score)) continue;
        out[v.i as number] = {
            intent: v.intent as LeadIntent,
            score: Math.min(100, Math.max(0, Math.round(score))),
            reason: typeof v.reason === 'string' ? v.reason : '',
        };
        valid += 1;
    }
    return valid > 0 ? out : null;
}
