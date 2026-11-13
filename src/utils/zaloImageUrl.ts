/**
 * Ảnh JPEG XL của Zalo: Zalo điện thoại bản mới gửi một số ảnh dạng `https://…/jxl/<…>/<id>.jxl`,
 * Chromium/Electron không hiển thị được. CDN luôn có bản JPG: `/jxl/` → `/jpg/`, `.jxl` → `.jpg`,
 * bỏ tham số `jxlstatus`. URL E2EE (`?e2esession`) không đổi được → giữ nguyên.
 * Chỉ đổi URL thuộc host media của Zalo. Dùng chung main process và renderer: giữ thuần, không import Node.
 */

const JXL_URL_RE = /^https?:\/\/.*\/jxl\/.*\.jxl/i;
// Zalo hay escape "/" trong chuỗi JSON lồng (`https:\/\/…\/jxl\/…`) → dò "jxl" rồi parse mới kiểm tra đúng URL.
const JXL_HINT_RE = /jxl/i;
const ZALO_MEDIA_HOST_RE = /(^|\.)(zdn\.vn|zadn\.vn|zalo\.me|zaloapp\.com)$/i;

const CONTENT_URL_KEYS = ['href', 'thumb', 'hd', 'hdUrl', 'normalUrl', 'oriUrl', 'thumbUrl', 'raw', 'rawUrl'];
const PARAMS_URL_KEYS = ['hd', 'rawUrl', 'href', 'thumb'];

/** URL ảnh JXL của Zalo → URL bản JPG tương ứng. URL khác (kể cả host ngoài Zalo) giữ nguyên. */
export function toZaloJpgUrl(url: string): string {
    if (typeof url !== 'string' || !JXL_URL_RE.test(url) || url.includes('?e2esession')) return url;
    try {
        if (!ZALO_MEDIA_HOST_RE.test(new URL(url).hostname)) return url; // new URL chỉ để kiểm tra host
        // Sửa trên chuỗi để giữ nguyên từng byte phần còn lại (query ký/encode đặc biệt, #hash).
        const [, head, query = '', hash = ''] = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/) as RegExpMatchArray;
        const authorityEnd = head.indexOf('/', head.indexOf('//') + 2);
        const rewritten = head.slice(0, authorityEnd) + head.slice(authorityEnd).replace('/jxl/', '/jpg/').replace(/\.jxl$/i, '.jpg');
        const kept = query.slice(1).split('&').filter((param) => param.split('=')[0] !== 'jxlstatus').join('&');
        return rewritten + (kept ? `?${kept}` : '') + hash;
    } catch {
        return url;
    }
}

function convertKeys(target: Record<string, any>, keys: string[]): boolean {
    let changed = false;
    for (const key of keys) {
        const value = target[key];
        if (typeof value !== 'string') continue;
        const next = toZaloJpgUrl(value);
        if (next !== value) {
            target[key] = next;
            changed = true;
        }
    }
    return changed;
}

/** Đổi URL JXL trong content tin ảnh (object hoặc chuỗi JSON) sang JPG; trả đúng tham chiếu cũ nếu không đổi. */
export function normalizeZaloPhotoContent<T>(content: T): T {
    if (typeof content === 'string') {
        if (!JXL_HINT_RE.test(content)) return content;
        try {
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content;
            const next = normalizeZaloPhotoContent(parsed);
            return (next === parsed ? content : JSON.stringify(next)) as unknown as T;
        } catch {
            return content;
        }
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
    const copy: Record<string, any> = { ...(content as Record<string, any>) };
    let changed = convertKeys(copy, CONTENT_URL_KEYS);
    const params = copy.params;
    if (typeof params === 'string' && JXL_HINT_RE.test(params)) {
        try {
            const parsedParams = JSON.parse(params);
            if (parsedParams && typeof parsedParams === 'object' && convertKeys(parsedParams, PARAMS_URL_KEYS)) {
                copy.params = JSON.stringify(parsedParams);
                changed = true;
            }
        } catch { /* params không phải JSON */ }
    } else if (params && typeof params === 'object' && !Array.isArray(params)) {
        const paramsCopy = { ...params };
        if (convertKeys(paramsCopy, PARAMS_URL_KEYS)) {
            copy.params = paramsCopy;
            changed = true;
        }
    }
    return (changed ? copy : content) as T;
}

/** Đổi URL JXL trong tin zca-js (`data.content` + `data.quote.attach`) TRƯỚC khi lưu/gửi renderer. Sửa tại chỗ; true nếu có đổi. */
export function normalizeZaloMessageImages(message: any): boolean {
    const data = message?.data;
    if (!data || typeof data !== 'object') return false;
    let changed = false;
    const content = normalizeZaloPhotoContent(data.content);
    if (content !== data.content) {
        data.content = content;
        changed = true;
    }
    const quote = data.quote;
    if (quote && typeof quote === 'object' && quote.attach) {
        const attach = normalizeZaloPhotoContent(quote.attach);
        if (attach !== quote.attach) {
            quote.attach = attach;
            changed = true;
        }
    }
    return changed;
}

/** File ảnh cục bộ đã tải dạng .jxl (không hiển thị được) → bubble nên dùng URL JPG từ CDN. */
export function isJxlLocalPath(path: unknown): boolean {
    return typeof path === 'string' && /\.jxl$/i.test(path);
}
