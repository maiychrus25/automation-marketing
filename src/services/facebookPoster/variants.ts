export const VARIANT_LABELS = ['A', 'B', 'C', 'D', 'E'];
export const MAX_VARIANTS = VARIANT_LABELS.length;
const MAX_VARIANT_TEXT = 63206;

export const variantKey = (profileId: string, url: string): string => `${profileId}\u0000${url}`;

/** Kiểm `variants` (B…E) của tham số bài đăng; vắng hoặc rỗng = không có biến thể. */
export function readVariants(p: { text?: unknown; variants?: unknown }): string[] {
    if (p.variants === undefined || p.variants === null) return [];
    if (!Array.isArray(p.variants)) throw new Error('Biến thể không hợp lệ');
    if (p.variants.length > MAX_VARIANTS - 1) throw new Error(`Tối đa ${MAX_VARIANTS - 1} biến thể ngoài nội dung chính`);
    const seen = new Set<string>([typeof p.text === 'string' ? p.text.trim() : '']);
    return p.variants.map((v, i) => {
        const label = VARIANT_LABELS[i + 1];
        if (typeof v !== 'string' || !v.trim()) throw new Error(`Biến thể ${label} không được để trống`);
        if (v.length > MAX_VARIANT_TEXT) throw new Error(`Biến thể ${label} tối đa ${MAX_VARIANT_TEXT} ký tự`);
        if (seen.has(v.trim())) throw new Error(`Biến thể ${label} trùng với nội dung khác`);
        seen.add(v.trim());
        return v;
    });
}

/** Chia n biến thể cho các cặp (profile, đích): xếp theo url rồi profileId, cặp thứ i nhận (i + offset) mod n. */
export function assignVariants(pairs: { profileId: string; url: string }[], n: number, offset: number): Map<string, number> {
    const sorted = [...pairs].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    const out = new Map<string, number>();
    sorted.forEach((pair, i) => out.set(variantKey(pair.profileId, pair.url), (i + offset) % n));
    return out;
}

/** Chữ của biến thể `index` (0 = `text`). */
export function variantText(params: { text: string; variants?: string[] }, index: number): string {
    return index === 0 ? params.text : (params.variants?.[index - 1] ?? params.text);
}
