const GROUP_BASE = 'https://www.facebook.com/groups/';

/**
 * Chuẩn hoá một phần tử trong mảng targets thành URL đầy đủ.
 * - Không bắt đầu bằng http  → coi là group id, ghép vào GROUP_BASE
 * - URL có /groups/          → group, giữ nguyên
 * - URL khác                 → page, giữ nguyên
 */
export function normalizeTarget(raw: unknown): { url: string; kind: 'group' | 'page' } {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('Phần tử trong danh sách nhóm/trang bị rỗng');
    }
    if (!/^https?:\/\//i.test(text)) {
        return { url: `${GROUP_BASE}${text}/`, kind: 'group' };
    }
    return { url: text, kind: /\/groups\//i.test(text) ? 'group' : 'page' };
}

/** Bốc ngẫu nhiên số giây nghỉ giữa hai lần đăng. Chịu được min > max. */
export function pickDelaySeconds(min: number, max: number): number {
    const lo = Math.min(Number(min), Number(max));
    const hi = Math.max(Number(min), Number(max));
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
