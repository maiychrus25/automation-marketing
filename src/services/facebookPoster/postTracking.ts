import type { PostTrackingRow } from '../../models/facebookPoster';

// Quy tắc thuần của "Theo dõi bài": đối chiếu bài và lịch kiểm tra kế tiếp.
// Spec: docs/specs/2026-10-19-post-performance.md mục 4.3 và 4.5.

export const POST_TRACKING_SETTING_KEY = 'fb_poster_post_tracking_config';

export interface PostTrackingConfig {
    autoEnabled: boolean;
    /** Mốc thử lấy link, tính bằng phút kể từ lúc đăng. */
    linkRetryMinutes: number[];
    /** Mốc đo tương tác, tính bằng phút kể từ lúc đăng. Nhãn trong `statsDone` là `${phút}m`. */
    statsAtMinutes: number[];
}

export const DEFAULT_POST_TRACKING_CONFIG: PostTrackingConfig = {
    autoEnabled: true,
    linkRetryMinutes: [30, 120, 360, 1440, 2880, 4320, 10080],
    statsAtMinutes: [60, 1440, 4320],
};

const MIN_MILESTONE = 5;
const MAX_MILESTONE = 20160;
const MAX_MILESTONES = 10;
const MINUTE_MS = 60_000;
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const MATCH_HEAD_CHARS = 60;
const TEXT_HEAD_CHARS = 200;
/** Mốc đo cuối trễ quá ngần này thì bỏ, tránh đo bài quá cũ. */
const STATS_OVERDUE_LIMIT_MS = 24 * 60 * 60 * 1000;

function validateMilestones(value: unknown, name: string): number[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MILESTONES) {
        throw new Error(`${name} phải có từ 1 đến ${MAX_MILESTONES} mốc`);
    }
    let previous = 0;
    for (const m of value) {
        if (!Number.isInteger(m) || m < MIN_MILESTONE || m > MAX_MILESTONE) {
            throw new Error(`${name}: mỗi mốc phải là số nguyên từ ${MIN_MILESTONE} đến ${MAX_MILESTONE} phút`);
        }
        if (m <= previous) throw new Error(`${name} phải tăng dần`);
        previous = m;
    }
    return [...value];
}

export function validatePostTrackingConfig(input: any): PostTrackingConfig {
    if (!input || typeof input.autoEnabled !== 'boolean') throw new Error('Cấu hình theo dõi bài không hợp lệ');
    return {
        autoEnabled: input.autoEnabled,
        linkRetryMinutes: validateMilestones(input.linkRetryMinutes, 'linkRetryMinutes'),
        statsAtMinutes: validateMilestones(input.statsAtMinutes, 'statsAtMinutes'),
    };
}

/** Đọc cấu hình đã lưu; thiếu hoặc hỏng thì dùng mặc định. */
export function parsePostTrackingConfig(raw: string | null): PostTrackingConfig {
    const fallback = (): PostTrackingConfig => ({
        ...DEFAULT_POST_TRACKING_CONFIG,
        linkRetryMinutes: [...DEFAULT_POST_TRACKING_CONFIG.linkRetryMinutes],
        statsAtMinutes: [...DEFAULT_POST_TRACKING_CONFIG.statsAtMinutes],
    });
    if (!raw) return fallback();
    try {
        return validatePostTrackingConfig(JSON.parse(raw));
    } catch {
        return fallback();
    }
}

/** NFC, bỏ ký tự độ rộng 0 (Facebook hay chèn), chữ thường, gộp mọi khoảng trắng Unicode, cắt 200 ký tự. */
export function normalizeHead(text: string): string {
    return String(text ?? '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').toLowerCase()
        .replace(/\s+/g, ' ').trim().slice(0, TEXT_HEAD_CHARS);
}

/** Phần của mục Nghiên cứu (ResearchItemInput) mà việc đối chiếu cần. */
export interface TrackableItem {
    fbId: string;
    title: string;
    authorId: string;
    postedAt: number | null;
}

/** Bài của mình khi trùng tác giả, cách giờ đăng ≤ 2 giờ và trùng 60 ký tự đầu (spec 4.3). */
export function matchesOwnPost(
    row: Pick<PostTrackingRow, 'postedAt' | 'textHead'>, item: TrackableItem, userId: string,
): boolean {
    if (!userId || item.authorId !== userId) return false;
    if (item.postedAt === null || item.postedAt === undefined) return false;
    if (Math.abs(item.postedAt - row.postedAt) > MATCH_WINDOW_MS) return false;
    const rowHead = row.textHead.slice(0, MATCH_HEAD_CHARS);
    if (rowHead === '') return false;
    const itemHead = normalizeHead(item.title).slice(0, MATCH_HEAD_CHARS);
    return itemHead !== '' && itemHead === rowHead;
}

/** Mục khớp có thời gian gần nhất; bằng nhau thì lấy mục đầu tiên. */
export function pickBestMatch<T extends TrackableItem>(
    row: Pick<PostTrackingRow, 'postedAt' | 'textHead'>, items: T[], userId: string,
): T | null {
    let best: T | null = null;
    let bestGap = Infinity;
    for (const item of items) {
        if (!matchesOwnPost(row, item, userId)) continue;
        const gap = Math.abs((item.postedAt as number) - row.postedAt);
        if (gap < bestGap) { best = item; bestGap = gap; }
    }
    return best;
}

const isLinkPending = (row: Pick<PostTrackingRow, 'linkStatus'>) =>
    row.linkStatus === 'missing' || row.linkStatus === 'pending_approval';

/** Hết mốc thử lấy link mà vẫn chưa có link: người gọi đặt `not_found`. */
export function linkRetryExhausted(row: PostTrackingRow, config: PostTrackingConfig, now: number): boolean {
    return isLinkPending(row) && !config.linkRetryMinutes.some((m) => row.postedAt + m * MINUTE_MS > now);
}

/** Các mốc đo chưa làm, theo thứ tự tăng dần; rỗng nếu mốc cuối đã trễ quá 24 giờ. */
function pendingStatsMilestones(row: PostTrackingRow, config: PostTrackingConfig, now: number): number[] {
    const todo = config.statsAtMinutes.filter((m) => !row.statsDone.includes(`${m}m`));
    if (todo.length === 0) return [];
    const last = config.statsAtMinutes[config.statsAtMinutes.length - 1];
    if (now - (row.postedAt + last * MINUTE_MS) > STATS_OVERDUE_LIMIT_MS) return [];
    return todo;
}

/** Lần tự kiểm tra kế tiếp (ms) hoặc null khi không còn gì cần làm (spec 4.5). Mốc đã qua trả về đúng mốc đó (đến hạn ngay). */
export function computeNextCheckAt(row: PostTrackingRow, config: PostTrackingConfig, now: number): number | null {
    if (row.linkStatus === 'not_found') return null;
    if (isLinkPending(row)) {
        const next = config.linkRetryMinutes.map((m) => row.postedAt + m * MINUTE_MS).find((t) => t > now);
        return next ?? null;
    }
    if (row.removedSuspected) return null;
    const todo = pendingStatsMilestones(row, config, now);
    return todo.length === 0 ? null : row.postedAt + todo[0] * MINUTE_MS;
}

/** Nhãn (`${phút}m`) của mốc đo sớm nhất đã đến hạn và chưa làm, hoặc null. */
export function dueStatsMilestone(row: PostTrackingRow, config: PostTrackingConfig, now: number): string | null {
    if (row.linkStatus !== 'known' || row.removedSuspected) return null;
    const m = pendingStatsMilestones(row, config, now).find((x) => row.postedAt + x * MINUTE_MS <= now);
    return m === undefined ? null : `${m}m`;
}
