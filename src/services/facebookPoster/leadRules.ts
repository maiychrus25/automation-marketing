// Quy tắc thuần của "Khách tiềm năng": cấu hình, khớp từ khoá / số điện thoại, lịch thu bình luận.
// Spec: docs/specs/2026-10-20-group-scores-times-leads.md mục 6.1 và 6.2.

export const LEAD_CONFIG_SETTING_KEY = 'fb_poster_lead_config';

export const DEFAULT_LEAD_KEYWORDS: readonly string[] = [
    'giá', 'bao nhiêu', 'bn', 'ib', 'inbox', 'nhắn', 'ship', 'mua', 'đặt', 'order',
    'còn hàng', 'còn không', 'sđt', 'số điện thoại', 'zalo', 'liên hệ', 'tư vấn', 'địa chỉ', 'size',
];

export interface LeadConfig {
    autoCollect: boolean;
    /** Mốc thu bình luận, phút kể từ lúc đăng. Nhãn trong `commentsDone` là `${phút}m`. */
    collectAtMinutes: number[];
    keywords: string[];
    detectPhone: boolean;
    aiEnabled: boolean;
    aiMinScore: number;
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
    autoCollect: true,
    collectAtMinutes: [120, 1440, 4320],
    keywords: [...DEFAULT_LEAD_KEYWORDS],
    detectPhone: true,
    aiEnabled: false,
    aiMinScore: 60,
};

const MIN_MILESTONE = 30;
const MAX_MILESTONE = 20160;
const MAX_MILESTONES = 10;
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 40;
const MINUTE_MS = 60_000;

/** Bỏ dấu tiếng Việt, đ → d, chữ thường. Cùng quy tắc `stripAccents` của src/ui/features/facebookPoster/matchKeywords.ts (service không import từ src/ui). */
export function stripAccents(value: string): string {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase();
}

function validateMilestones(value: unknown): number[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MILESTONES) {
        throw new Error(`collectAtMinutes phải có từ 1 đến ${MAX_MILESTONES} mốc`);
    }
    let previous = 0;
    for (const m of value) {
        if (!Number.isInteger(m) || m < MIN_MILESTONE || m > MAX_MILESTONE) {
            throw new Error(`collectAtMinutes: mỗi mốc phải là số nguyên từ ${MIN_MILESTONE} đến ${MAX_MILESTONE} phút`);
        }
        if (m <= previous) throw new Error('collectAtMinutes phải tăng dần');
        previous = m;
    }
    return [...value];
}

function validateKeywords(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEYWORDS) {
        throw new Error(`Từ khoá phải có từ 1 đến ${MAX_KEYWORDS} mục`);
    }
    return value.map((k) => {
        const text = typeof k === 'string' ? k.trim() : '';
        if (text.length < 1 || text.length > MAX_KEYWORD_LENGTH) {
            throw new Error(`Mỗi từ khoá phải dài từ 1 đến ${MAX_KEYWORD_LENGTH} ký tự`);
        }
        return text;
    });
}

export function validateLeadConfig(input: unknown): LeadConfig {
    const c = input as Partial<Record<keyof LeadConfig, unknown>> | null;
    if (!c || typeof c !== 'object'
        || typeof c.autoCollect !== 'boolean' || typeof c.detectPhone !== 'boolean' || typeof c.aiEnabled !== 'boolean') {
        throw new Error('Cấu hình khách tiềm năng không hợp lệ');
    }
    if (!Number.isInteger(c.aiMinScore) || (c.aiMinScore as number) < 0 || (c.aiMinScore as number) > 100) {
        throw new Error('aiMinScore phải là số nguyên từ 0 đến 100');
    }
    return {
        autoCollect: c.autoCollect,
        collectAtMinutes: validateMilestones(c.collectAtMinutes),
        keywords: validateKeywords(c.keywords),
        detectPhone: c.detectPhone,
        aiEnabled: c.aiEnabled,
        aiMinScore: c.aiMinScore as number,
    };
}

/** Đọc cấu hình đã lưu (chuỗi JSON hoặc object); thiếu hoặc hỏng thì dùng mặc định. */
export function parseLeadConfig(raw: unknown): LeadConfig {
    try {
        return validateLeadConfig(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
        return validateLeadConfig(DEFAULT_LEAD_CONFIG);
    }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Số điện thoại VN: bắt đầu 0, 84 hoặc +84; các chữ số có thể cách nhau bằng 1 dấu cách / chấm / gạch.
 * Sau khi bỏ dấu và đổi đầu 84 thành 0 phải có 9–11 chữ số (0 + 8–10 chữ số).
 * Không được dính chữ số liền trước / liền sau, nên số 8 chữ số, giá "250.000", năm 2025 đều không khớp.
 */
const PHONE_PATTERN = /(?<!\d)(?<!\d[.-])(?:\+?84|0)(?:[ .-]?\d){8,10}(?![ .-]?\d)/g;

function hasPhone(stripped: string): boolean {
    for (const m of stripped.matchAll(PHONE_PATTERN)) {
        const digits = m[0].replace(/[^\d]/g, '').replace(/^84/, '0');
        if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) return true;
    }
    return false;
}

/** Các từ khoá khớp (theo ranh giới từ, không dấu), thêm 'phone' nếu có số điện thoại; null nếu không khớp. */
export function matchLead(text: string, config: Pick<LeadConfig, 'keywords' | 'detectPhone'>): string[] | null {
    const stripped = stripAccents(String(text ?? '').normalize('NFC')).trim();
    if (stripped === '') return null;
    const hits: string[] = [];
    for (const keyword of config.keywords) {
        const needle = stripAccents(keyword).trim();
        if (needle === '' || hits.includes(keyword)) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u');
        if (re.test(stripped)) hits.push(keyword);
    }
    if (config.detectPhone && hasPhone(stripped)) hits.push('phone');
    return hits.length > 0 ? hits : null;
}

/** Mốc thu bình luận đầu tiên chưa làm và còn ở tương lai (ms), hoặc null. Mốc đã qua mà chưa thu bị bỏ qua. */
export function computeNextCommentAt(
    postedAt: number, done: string[], config: Pick<LeadConfig, 'collectAtMinutes'>, now: number,
): number | null {
    for (const m of config.collectAtMinutes) {
        if (done.includes(`${m}m`)) continue;
        const at = postedAt + m * MINUTE_MS;
        if (at > now) return at;
    }
    return null;
}

/** Nhãn (`${phút}m`) các mốc đã đến hạn mà chưa làm, theo thứ tự tăng dần. */
export function overdueCommentLabels(
    postedAt: number, done: string[], config: Pick<LeadConfig, 'collectAtMinutes'>, now: number,
): string[] {
    return config.collectAtMinutes
        .filter((m) => !done.includes(`${m}m`) && postedAt + m * MINUTE_MS <= now)
        .map((m) => `${m}m`);
}
