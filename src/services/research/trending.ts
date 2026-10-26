export const TRENDING_MAX_AGE_MS = 604800000;
const HOUR_MS = 3600000;

export interface TrendingRow {
    fbId: string;
    url: string;
    title: string;
    placeName: string;
    placeId: string;
    reactions: number | null;
    comments: number | null;
    shares: number | null;
    postedAt: number | null;
    capturedAt: number;
}

export interface TrendingItem {
    fbId: string;
    url: string;
    text: string;
    placeName: string;
    placeId: string;
    engagement: number;
    score: number;
    basis: 'growth' | 'age';
    seen: number;
    postedAt: number;
}

const engagement = (row: TrendingRow): number => (row.reactions ?? 0) + (row.comments ?? 0) + (row.shares ?? 0);

export function rankTrending(rows: TrendingRow[], now: number, limit: number): TrendingItem[] {
    const groups = new Map<string, { first: TrendingRow; last: TrendingRow; seen: number }>();
    for (const row of rows) {
        const group = groups.get(row.fbId);
        if (!group) groups.set(row.fbId, { first: row, last: row, seen: 1 });
        else {
            if (row.capturedAt < group.first.capturedAt) group.first = row;
            if (row.capturedAt > group.last.capturedAt) group.last = row;
            group.seen++;
        }
    }
    const items: TrendingItem[] = [];
    for (const { first, last, seen } of groups.values()) {
        if (last.postedAt === null || now - last.postedAt > TRENDING_MAX_AGE_MS) continue;
        const hours = (last.capturedAt - first.capturedAt) / HOUR_MS;
        const e = engagement(last);
        const growth = hours >= 1;
        items.push({
            fbId: last.fbId, url: last.url, text: last.title.slice(0, 500), placeName: last.placeName, placeId: last.placeId,
            engagement: e,
            score: growth ? (e - engagement(first)) / hours : e / Math.max(1, (last.capturedAt - last.postedAt) / HOUR_MS),
            basis: growth ? 'growth' : 'age', seen, postedAt: last.postedAt,
        });
    }
    return items.sort((a, b) => b.score - a.score).slice(0, limit);
}

function stringList(value: unknown, name: string, maxItems: number, maxLength?: number): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${name} phải là danh sách chuỗi`);
    if (value.length > maxItems) throw new Error(`${name} tối đa ${maxItems} mục`);
    return value.map((entry) => {
        if (typeof entry !== 'string' || !entry.trim() || (maxLength !== undefined && entry.trim().length > maxLength)) {
            throw new Error(`${name} chứa ${name === 'queries' ? 'từ khoá' : 'mã nhóm'} không hợp lệ`);
        }
        return entry.trim();
    });
}

function intInRange(value: unknown, name: string, max: number, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} phải là số nguyên từ 1 đến ${max}`);
    }
    return value;
}

export function parseTrendingParams(p: any): { queries: string[]; groupIds: string[]; sinceHours: number; limit: number } {
    const queries = stringList(p?.queries, 'queries', 10, 80);
    const groupIds = stringList(p?.groupIds, 'groupIds', 20);
    if (!queries.length && !groupIds.length) throw new Error('Cần ít nhất một từ khoá hoặc mã nhóm');
    return {
        queries, groupIds,
        sinceHours: intInRange(p?.sinceHours, 'sinceHours', 168, 72),
        limit: intInRange(p?.limit, 'limit', 100, 20),
    };
}
