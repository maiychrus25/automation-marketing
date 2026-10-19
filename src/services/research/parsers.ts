// Bộ đọc thuần phản hồi GraphQL của Facebook cho Nghiên cứu chủ đề.
// Nguồn cấu trúc: docs/reports/2026-10-19-topic-research-spike.md mục 4-6 (chưa đo trên trang thật),
// nên mọi trường đều đọc theo đường dẫn dự kiến trước, rồi dự phòng bằng tìm theo tên khoá. Không bao giờ ném lỗi.
import type { ParsedItem, ResearchErrorCode } from '../../models/research';

export interface ParseResult {
    items: ParsedItem[];
    endCursor: string | null;
    errorCode: ResearchErrorCode | null;
}

export interface GroupFeedContext { groupId?: string; groupName?: string }

const MAX_DEPTH = 12;
const MAX_TITLE = 5000;
const FB_ORIGIN = 'https://www.facebook.com/';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

// ---------- Tìm kiếm trong cây JSON ----------

function getPath(root: unknown, path: string[]): unknown {
    let cur = root;
    for (const key of path) {
        if (!isObj(cur)) return undefined;
        cur = cur[key];
    }
    return cur;
}

/** Duyệt theo bề rộng; trả về phần tử đầu tiên mà `visit` trả về khác undefined. */
function walk<T>(root: unknown, visit: (node: Obj) => T | undefined): T | undefined {
    let level: unknown[] = [root];
    for (let depth = 0; depth <= MAX_DEPTH && level.length > 0; depth++) {
        const next: unknown[] = [];
        for (const v of level) {
            if (Array.isArray(v)) { next.push(...v); continue; }
            if (!isObj(v)) continue;
            const hit = visit(v);
            if (hit !== undefined) return hit;
            next.push(...Object.values(v));
        }
        level = next;
    }
    return undefined;
}

function findKey(root: unknown, key: string, accept: (v: unknown) => boolean = (v) => v !== undefined && v !== null): unknown {
    return walk(root, (n) => (key in n && accept(n[key]) ? n[key] : undefined));
}

/** Mọi giá trị của khoá `key` (không đi sâu vào bên trong giá trị đã khớp). */
function findAllKeys(root: unknown, key: string, accept: (v: unknown) => boolean): unknown[] {
    const found: unknown[] = [];
    const rec = (v: unknown, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        if (Array.isArray(v)) { v.forEach((x) => rec(x, depth + 1)); return; }
        if (!isObj(v)) return;
        for (const [k, child] of Object.entries(v)) {
            if (k === key && accept(child)) found.push(child);
            else rec(child, depth + 1);
        }
    };
    rec(root, 0);
    return found;
}

function findString(root: unknown, accept: (s: string) => boolean): string | undefined {
    return walk(root, (n) => {
        for (const v of Object.values(n)) if (typeof v === 'string' && accept(v)) return v;
        return undefined;
    });
}

/** Tìm chuỗi khoá lồng nhau (vd. ['reaction_count','count']) ở độ sâu nông nhất. */
function findChain(root: unknown, chain: string[], accept: (v: unknown) => boolean): unknown {
    return walk(root, (n) => {
        const v = getPath(n, chain);
        return v !== undefined && accept(v) ? v : undefined;
    });
}

// ---------- Số dạng chữ ----------

const SUFFIX_MULTIPLIER: Record<string, number> = {
    k: 1e3, n: 1e3, nghìn: 1e3, ngàn: 1e3, m: 1e6, tr: 1e6, triệu: 1e6,
};
const COMPACT_RE = /^\s*(\d[\d.,]*)(?:\s*(nghìn|ngàn|triệu|tr|k|n|m)(?!\p{L}))?/iu;

/** "1,2K" -> 1200, "12 N" -> 12000, "1,5 Tr" -> 1500000, "1.234" -> 1234. Không phải số -> null. */
export function parseCompactNumber(text: string): number | null {
    if (typeof text !== 'string') return null;
    const m = COMPACT_RE.exec(text);
    if (!m) return null;
    const num = m[1].replace(/[.,]+$/, '');
    const mult = m[2] ? SUFFIX_MULTIPLIER[m[2].toLowerCase()] : 1;
    let value: number;
    if (m[2]) {
        const lastSep = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
        value = num.includes('.') && num.includes(',')
            ? parseFloat(`${num.slice(0, lastSep).replace(/[.,]/g, '')}.${num.slice(lastSep + 1)}`)
            : parseFloat(num.replace(',', '.'));
    } else if (/^\d{1,3}([.,]\d{3})+$/.test(num)) value = parseInt(num.replace(/[.,]/g, ''), 10);
    else value = parseFloat(num.replace(',', '.'));
    return Number.isFinite(value) ? Math.round(value * mult) : null;
}

function toCount(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    return typeof v === 'string' ? parseCompactNumber(v) : null;
}
const isCount = (v: unknown): boolean => toCount(v) !== null;

// ---------- Tách phản hồi và nhận diện lỗi ----------

/** Bỏ `for (;;);`, tách nhiều dòng JSON; dòng hỏng bị bỏ qua. */
export function parseGraphqlChunks(text: string): unknown[] {
    if (typeof text !== 'string') return [];
    const body = text.replace(/^\s*for\s*\(;;\);\s*/, '').replace(/\nfor\s*\(;;\);/g, '\n');
    const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
    const whole = tryParse(body.trim());
    if (whole !== undefined) return [whole];
    const out: unknown[] = [];
    for (const line of body.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const v = tryParse(t);
        if (v !== undefined) out.push(v);
    }
    return out;
}

function detectError(chunks: unknown[]): ResearchErrorCode | null {
    const codes = new Set<string>();
    let text = '';
    const add = (v: unknown): void => {
        if (typeof v === 'number') codes.add(String(v));
        else if (typeof v === 'string') { if (/^\d+$/.test(v)) codes.add(v); else text += ` ${v}`; }
    };
    for (const c of chunks) {
        if (!isObj(c)) continue;
        add(c.error); add(c.errorSummary); add(c.errorDescription);
        if (Array.isArray(c.errors)) {
            for (const e of c.errors) {
                if (!isObj(e)) { add(e); continue; }
                add(e.code); add(e.message); add(e.summary); add(e.description);
            }
        }
    }
    const t = text.toLowerCase();
    if (t.includes('checkpoint')) return 'checkpoint';
    if (codes.has('1357001') || codes.has('1357004')) return 'logged_out';
    if (['1390008', '368', '1675004'].some((c) => codes.has(c))
        || /temporarily blocked|tạm thời bị chặn|rate limit|too many/.test(t)) return 'rate_limited';
    if (/persistedquerynotfound|doc_id|not found/.test(t)) return 'query_changed';
    return null;
}

function finish(items: ParsedItem[], chunks: unknown[], endCursor: string | null): ParseResult {
    const seen = new Set<string>();
    const unique = items.filter((i) => {
        const key = `${i.kind}:${i.fbId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (unique.length > 0) return { items: unique, endCursor, errorCode: null };
    const error = detectError(chunks);
    if (error) return { items: [], endCursor, errorCode: error };
    const hasData = chunks.some((c) => isObj(c) && isObj(c.data));
    return { items: [], endCursor, errorCode: hasData ? null : 'parse_failed' };
}

function collectEdges(chunks: unknown[], documented: string[]): unknown[] {
    const direct = chunks.flatMap((c) => {
        const e = getPath(c, documented);
        return Array.isArray(e) ? e : [];
    });
    if (direct.length > 0) return direct;
    return chunks.flatMap((c) => findAllKeys(c, 'edges', Array.isArray).flatMap((e) => e as unknown[]));
}

function findCursor(chunks: unknown[], documented: string[]): string | null {
    for (const c of chunks) {
        const v = getPath(c, documented);
        if (typeof v === 'string' && v) return v;
    }
    for (const c of chunks) {
        const v = findKey(c, 'end_cursor', (x) => typeof x === 'string' && x !== '');
        if (typeof v === 'string') return v;
    }
    return null;
}

const emptyItem = (kind: ParsedItem['kind'], fbId: string, url: string, title: string): ParsedItem => ({
    kind, fbId, url, title,
    placeKind: 'unknown', placeId: '', placeName: '',
    authorKind: 'unknown', authorId: '', authorName: '', authorUrl: '',
    privacy: '', memberCount: null, followerCount: null,
    reactions: null, comments: null, shares: null, postedAt: null,
});

// ---------- Bài viết ----------

function postIdFromUrl(url: string): string {
    const m = /\/(?:posts|permalink)\/(\d+)/.exec(url) ?? /story_fbid=(\d+)/.exec(url);
    return m ? m[1] : '';
}

function placeKindOf(typename: unknown): ParsedItem['placeKind'] {
    return typename === 'Group' ? 'group' : typename === 'Page' ? 'page' : typename === 'User' ? 'person' : 'unknown';
}

function parseStory(story: Obj, ctx?: GroupFeedContext): ParsedItem | null {
    let url = ['url', 'wwwURL', 'permalink_url'].map((k) => str(story[k])).find((u) => u.startsWith(FB_ORIGIN)) ?? '';
    if (!url) {
        url = findString(story, (s) => s.startsWith(FB_ORIGIN) && /\/posts\/|\/permalink\/|story_fbid/.test(s)) ?? '';
    }
    const fbId = str(story.post_id) || str(findKey(story, 'post_id', (v) => str(v) !== '')) || postIdFromUrl(url);
    if (!fbId) return null;

    const textValue = getPath(story, ['comet_sections', 'content', 'story', 'message', 'text'])
        ?? findChain(story, ['message', 'text'], (v) => typeof v === 'string');
    const item = emptyItem('post', fbId, url, str(textValue).slice(0, MAX_TITLE));

    const actors = findKey(story, 'actors', (v) => Array.isArray(v) && isObj(v[0]));
    const actor = Array.isArray(actors) && isObj(actors[0]) ? actors[0] : null;
    if (actor) {
        item.authorKind = actor.__typename === 'User' ? 'person' : actor.__typename === 'Page' ? 'page' : 'unknown';
        item.authorId = str(actor.id);
        item.authorName = str(actor.name);
        item.authorUrl = str(actor.url) || str(actor.profile_url);
    }

    const to = findKey(story, 'to', (v) => isObj(v) && str(v.id) !== '');
    const groupFromUrl = /\/groups\/(\d+)/.exec(url)?.[1];
    if (isObj(to)) {
        item.placeKind = placeKindOf(to.__typename);
        item.placeId = str(to.id);
        item.placeName = str(to.name);
    } else if (ctx?.groupId) {
        item.placeKind = 'group';
        item.placeId = ctx.groupId;
        item.placeName = ctx.groupName ?? '';
    } else if (groupFromUrl) {
        item.placeKind = 'group';
        item.placeId = groupFromUrl;
    }

    item.reactions = toCount(findChain(story, ['reaction_count', 'count'], isCount));
    item.comments = toCount(findChain(story, ['comment_rendering_instance', 'comments', 'total_count'], isCount)
        ?? findChain(story, ['comment_count', 'total_count'], isCount));
    item.shares = toCount(findChain(story, ['share_count', 'count'], isCount));

    const created = getPath(story, ['comet_sections', 'timestamp', 'story', 'creation_time'])
        ?? findKey(story, 'creation_time', (v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)));
    const seconds = typeof created === 'string' ? Number(created) : created;
    item.postedAt = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
    return item;
}

function hasPostId(n: Obj): boolean { return str(n.post_id) !== ''; }

function storyOfSearchEdge(edge: unknown): Obj | null {
    if (!isObj(edge)) return null;
    const vm = getPath(edge, ['rendering_strategy', 'view_model']) ?? getPath(edge, ['relay_rendering_strategy', 'view_model']);
    const documented = getPath(vm, ['click_model', 'story']);
    if (isObj(documented)) return documented;
    return walk(edge, (n) => (hasPostId(n) ? n : undefined))
        ?? (findKey(edge, 'story', isObj) as Obj | undefined) ?? null;
}

export function parseSearchPosts(text: string): ParseResult {
    const chunks = parseGraphqlChunks(text);
    const items: ParsedItem[] = [];
    for (const edge of collectEdges(chunks, ['data', 'serpResponse', 'results', 'edges'])) {
        const story = storyOfSearchEdge(edge);
        const item = story ? parseStory(story) : null;
        if (item) items.push(item);
    }
    return finish(items, chunks, findCursor(chunks, ['data', 'serpResponse', 'results', 'page_info', 'end_cursor']));
}

export function parseGroupFeed(text: string, ctx?: GroupFeedContext): ParseResult {
    const chunks = parseGraphqlChunks(text);
    const items: ParsedItem[] = [];
    for (const edge of collectEdges(chunks, ['data', 'node', 'group_feed', 'edges'])) {
        const node = isObj(edge) && isObj(edge.node) ? edge.node : null;
        if (!node) continue;
        const story = hasPostId(node) ? node : (walk(node, (n) => (hasPostId(n) ? n : undefined)) ?? node);
        const item = parseStory(story, ctx);
        if (item) items.push(item);
    }
    return finish(items, chunks, findCursor(chunks, ['data', 'node', 'group_feed', 'page_info', 'end_cursor']));
}

// ---------- Nhóm và trang ----------

function viewModelOf(edge: unknown): Obj | null {
    if (!isObj(edge)) return null;
    const vm = getPath(edge, ['rendering_strategy', 'view_model']) ?? getPath(edge, ['relay_rendering_strategy', 'view_model']);
    if (isObj(vm)) return vm;
    const found = findKey(edge, 'view_model', isObj);
    return isObj(found) ? found : isObj(findKey(edge, 'profile', isObj)) ? edge : null;
}

function profileOf(vm: Obj): Obj | null {
    const p = isObj(vm.profile) ? vm.profile : findKey(vm, 'profile', (v) => isObj(v) && str(v.id) !== '');
    return isObj(p) && str(p.id) !== '' ? p : null;
}

/** Phần của đoạn mô tả (tách theo " · ") khớp mẫu; tìm trong mọi chuỗi của view model. */
function snippetParts(vm: Obj, pattern: RegExp): { parts: string[]; hit?: string } {
    const snippet = str(getPath(vm, ['primary_snippet_text_with_entities', 'text']));
    const text = pattern.test(snippet) ? snippet : (findString(vm, (s) => pattern.test(s)) ?? snippet);
    const parts = text.split('·').map((p) => p.trim()).filter(Boolean);
    return { parts, hit: parts.find((p) => pattern.test(p)) };
}

function parseProfileResults(text: string, kind: 'group' | 'page'): ParseResult {
    const chunks = parseGraphqlChunks(text);
    const items: ParsedItem[] = [];
    for (const edge of collectEdges(chunks, ['data', 'serpResponse', 'results', 'edges'])) {
        const vm = viewModelOf(edge);
        const profile = vm ? profileOf(vm) : null;
        if (!vm || !profile) continue;
        const item = emptyItem(kind, str(profile.id), str(profile.url), str(profile.name));
        if (kind === 'group') {
            const { parts, hit } = snippetParts(vm, /thành viên|member/i);
            const privacy = parts.find((p) => /^(công khai|public|riêng tư|private)/i.test(p));
            item.privacy = privacy ? (/^(công khai|public)/i.test(privacy) ? 'public' : 'private') : '';
            item.memberCount = hit ? parseCompactNumber(hit) : null;
        } else {
            const { hit } = snippetParts(vm, /theo dõi|follow/i);
            item.followerCount = hit ? parseCompactNumber(hit) : null;
        }
        items.push(item);
    }
    return finish(items, chunks, findCursor(chunks, ['data', 'serpResponse', 'results', 'page_info', 'end_cursor']));
}

export const parseSearchGroups = (text: string): ParseResult => parseProfileResults(text, 'group');
export const parseSearchPages = (text: string): ParseResult => parseProfileResults(text, 'page');

// ---------- Chẩn đoán hình dạng ----------

const MAX_SHAPE_BYTES = 20 * 1024;

/** Danh sách "đường.dẫn:kiểu" của JSON, KHÔNG kèm giá trị (báo cáo spike mục 6). Độ sâu tính theo số khoá. */
export function describeShape(value: unknown, maxDepth = 8, maxKeys = 400): string[] {
    const out = new Set<string>();
    let bytes = 0;
    const add = (line: string): boolean => {
        if (out.has(line)) return true;
        if (out.size >= maxKeys || bytes + line.length + 1 > MAX_SHAPE_BYTES) return false;
        out.add(line);
        bytes += line.length + 1;
        return true;
    };
    const rec = (v: unknown, path: string, depth: number): void => {
        if (depth > maxDepth) return;
        if (Array.isArray(v)) {
            if (path && !add(`${path}:array[${v.length}]`)) return;
            v.slice(0, 5).forEach((el) => rec(el, `${path}[]`, depth));
        } else if (isObj(v)) {
            if (path && !add(`${path}:object`)) return;
            for (const [k, child] of Object.entries(v)) {
                if (out.size >= maxKeys) return;
                rec(child, path ? `${path}.${k}` : k, depth + 1);
            }
        } else if (path) {
            add(`${path}:${v === null ? 'null' : typeof v === 'boolean' ? 'bool' : typeof v}`);
        }
    };
    try { rec(value, '', 0); } catch { /* chẩn đoán không được làm hỏng luồng chính */ }
    return [...out];
}
