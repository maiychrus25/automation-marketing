const FB_ORIGIN = 'https://www.facebook.com';
const MAX_JSON_NODES = 200000;
const MAX_JSON_DEPTH = 60;
const UNITS: Record<string, number> = { k: 1e3, m: 1e6, tr: 1e6, 'triệu': 1e6 };
const LABEL = /^(\d[\d.,]*(?:\s*(?:triệu|tr|k|m))?)\s+(?:người theo dõi|followers?)$/iu;

export interface FollowerCount { value: number; approximate: boolean; step: number }

/** Có đơn vị: dấu `,`/`.` là thập phân (≤ 2 chữ số). Không đơn vị: dấu phải tách đúng nhóm 3 chữ số. */
export function parseFollowerCount(text: string): FollowerCount | null {
    const match = /^(\d+(?:[.,]\d+)*)\s*(triệu|tr|k|m)?$/iu.exec(text.trim());
    if (!match) return null;
    const unit = match[2] ? UNITS[match[2].toLowerCase()] : 0;
    if (!unit) {
        if (!/^(?:\d+|\d{1,3}(?:[.,]\d{3})+)$/.test(match[1])) return null;
        const value = Number(match[1].replace(/[.,]/g, ''));
        return Number.isSafeInteger(value) ? { value, approximate: false, step: 1 } : null;
    }
    const parts = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(match[1]);
    if (!parts) return null;
    const decimals = parts[2]?.length ?? 0;
    return { value: Math.round(Number(`${parts[1]}.${parts[2] ?? '0'}`) * unit), approximate: true, step: unit / 10 ** decimals };
}

/** Link người theo dõi của đúng Page: `/<slug>/followers` (slug từ URL hoặc pageId) hoặc profile.php?id=<pageId>&sk=followers. */
function isOwnFollowersLink(href: string, slug: string, pageId: string): boolean {
    let url: URL;
    try { url = new URL(href); } catch { return false; }
    if (url.origin !== FB_ORIGIN || url.username || url.password) return false;
    if (url.pathname === '/profile.php') return !!pageId && url.searchParams.get('id') === pageId && url.searchParams.get('sk') === 'followers';
    const seg = /^\/([^/]+)\/followers\/?$/.exec(url.pathname)?.[1];
    return !!seg && (seg === slug || seg === pageId);
}

function labelled(text: string): { raw: string; count: FollowerCount } | null {
    const raw = LABEL.exec(text.trim())?.[1];
    const count = raw ? parseFollowerCount(raw) : null;
    return raw && count ? { raw: raw.trim(), count } : null;
}

/**
 * Chỉ nhận số gắn với link người theo dõi của chính Page: thẻ `<a href>` trong HTML và đối tượng JSON `{uri, text}`.
 * Hai dạng cùng có mà khác số thì null.
 */
export function readPageFollowers(html: string, roots: unknown[], finalUrl: string, pageId: string): { followers: number; text: string; approximate: boolean } | null {
    let slug = '';
    try { slug = new URL(finalUrl).pathname.split('/')[1] ?? ''; } catch { return null; }
    if (slug === 'me' || slug === 'profile.php') slug = '';
    const found = (forms: { raw: string; count: FollowerCount }[]) => forms.length > 0 && forms.every((f) => f.count.value === forms[0].count.value) ? forms[0] : forms.length ? undefined : null;

    const fromHtml: { raw: string; count: FollowerCount }[] = [];
    for (const m of html.matchAll(/<a\b(?:[^>]*?\s)?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        if (!isOwnFollowersLink(m[1].replace(/&amp;/g, '&'), slug, pageId)) continue;
        const parsed = labelled(m[2].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '));
        if (parsed) fromHtml.push(parsed);
    }
    const fromJson: { raw: string; count: FollowerCount }[] = [];
    const stack: { node: unknown; depth: number }[] = roots.map((node) => ({ node, depth: 0 }));
    for (let visited = 0; stack.length && visited < MAX_JSON_NODES; visited++) {
        const { node, depth } = stack.pop()!;
        if (typeof node !== 'object' || node === null) continue;
        if (!Array.isArray(node)) {
            const o = node as Record<string, unknown>;
            const text = typeof o.text === 'string' ? o.text : (o.text as { text?: unknown } | null)?.text;
            if (typeof o.uri === 'string' && typeof text === 'string' && isOwnFollowersLink(o.uri, slug, pageId)) {
                const parsed = labelled(text);
                if (parsed) fromJson.push(parsed);
            }
        }
        if (depth < MAX_JSON_DEPTH) for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
    }
    const h = found(fromHtml);
    const j = found(fromJson);
    if (h === undefined || j === undefined) return null;
    if (h && j && h.count.value !== j.count.value) return null;
    const pick = h ?? j;
    return pick ? { followers: pick.count.value, text: pick.raw, approximate: pick.count.approximate } : null;
}
