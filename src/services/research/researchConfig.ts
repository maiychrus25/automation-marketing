export const RESEARCH_CONFIG_SETTING_KEY = 'research_config';

export interface ResearchConfig { excludedProfileIds: string[]; perProfileDailyCap: number; }

export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = { excludedProfileIds: [], perProfileDailyCap: 500 };
export const MIN_DAILY_CAP = 50;
export const MAX_DAILY_CAP = 5000;

export function validateResearchConfig(input: any): ResearchConfig {
    const ids = input?.excludedProfileIds;
    const cap = input?.perProfileDailyCap;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')
        || !Number.isInteger(cap) || cap < MIN_DAILY_CAP || cap > MAX_DAILY_CAP) {
        throw new Error('Cấu hình nghiên cứu chủ đề không hợp lệ');
    }
    return { excludedProfileIds: [...new Set<string>(ids)], perProfileDailyCap: cap };
}

/** Đọc cấu hình đã lưu; thiếu hoặc hỏng thì dùng mặc định. */
export function parseResearchConfig(raw: string | null): ResearchConfig {
    if (!raw) return { ...DEFAULT_RESEARCH_CONFIG, excludedProfileIds: [] };
    try {
        return validateResearchConfig(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_RESEARCH_CONFIG, excludedProfileIds: [] };
    }
}
