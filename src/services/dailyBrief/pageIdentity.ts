import type { Page } from 'playwright-core';
import type { PageIdentityKind, PagePostSample } from '../../models/dailyBrief';
import { loginProblemAt } from '../facebookPoster/loginCheck';

const MAX_POSTS = 10;
const MAX_POST_TEXT = 500;
const MAX_ABOUT = 1000;
const GOTO_TIMEOUT_MS = 45000;
const MAX_TRANSPORT_DEPTH = 4;
// 241 root + một wrapper/root = 482 envelope; budget 1024 còn 542 envelope dự phòng.
const MAX_TRANSPORT_ENVELOPES = 1024;
const FB_ORIGIN = 'https://www.facebook.com';

export interface PageIdentityRead {
    kind: PageIdentityKind;
    pageId: string;
    pageName: string;
    category: string;
    about: string;
    recentPosts: PagePostSample[];
}

export class PageLoginProblem extends Error {
    constructor(public readonly state: 'checkpoint' | 'logged_out') {
        super(state === 'checkpoint' ? 'Profile cần xác minh Facebook' : 'Profile chưa đăng nhập Facebook');
        this.name = 'PageLoginProblem';
    }
}

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const id = (value: unknown): string => typeof value === 'string' && value.trim() === value ? value : '';

function at(root: unknown, ...keys: string[]): unknown {
    let value = root;
    for (const key of keys) value = isObj(value) ? value[key] : undefined;
    return value;
}

function facebookUrl(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim() !== value) return false;
    try {
        const url = new URL(value);
        return url.origin === FB_ORIGIN && !url.username && !url.password;
    } catch { return false; }
}

function emptyIdentity(kind: PageIdentityKind = 'unknown'): PageIdentityRead {
    return { kind, pageId: '', pageName: '', category: '', about: '', recentPosts: [] };
}

/** Chỉ JSON trong script nội tuyến có type chính xác; không thực thi mã hay đọc script bên ngoài. */
function embeddedJson(html: string): unknown[] {
    const result: unknown[] = [];
    const scripts = /<!--[\s\S]*?(?:-->|$)|<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
    for (const match of html.matchAll(scripts)) {
        if (match[1] === undefined) continue;
        const attributes = [...match[1].matchAll(/(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)];
        const types = attributes.filter((attr) => attr[1].toLowerCase() === 'type');
        if (types.length !== 1 || (types[0][2] ?? types[0][3] ?? types[0][4]) !== 'application/json'
            || attributes.some((attr) => attr[1].toLowerCase() === 'src')) continue;
        try { result.push(JSON.parse(match[2])); } catch { /* bỏ riêng JSON hỏng, không làm hỏng lượt học */ }
    }
    return result;
}

/** Chỉ nối những User ở đúng ngữ cảnh đã quan sát; không tìm đệ quy Page/actor bất kỳ. */
export function parseIdentityHtml(html: string, finalUrl: string): PageIdentityRead {
    if (typeof html !== 'string' || !facebookUrl(finalUrl)) return emptyIdentity();
    const roots = embeddedJson(html).map((root) => ({ root, depth: 0 }));
    const currentIds = new Set<string>();
    const payloads: unknown[] = [];
    for (let index = 0; index < roots.length; index++) {
        if (roots.length > MAX_TRANSPORT_ENVELOPES) return emptyIdentity();
        const { root, depth } = roots[index];
        for (const definition of array(at(root, 'define'))) {
            if (!Array.isArray(definition) || definition[0] !== 'CurrentUserInitialData') continue;
            const currentId = id(at(definition[2], 'USER_ID'));
            if (!currentId) return emptyIdentity();
            currentIds.add(currentId);
        }
        for (const entry of array(at(root, 'require'))) {
            if (!Array.isArray(entry) || !Array.isArray(entry[3])) continue;
            if (entry[0] === 'ScheduledServerJS' && entry[1] === 'handle' && entry[2] === null) {
                for (const argument of entry[3]) {
                    const child = at(argument, '__bbox');
                    if (!isObj(child)) continue;
                    if (depth >= MAX_TRANSPORT_DEPTH || roots.length >= MAX_TRANSPORT_ENVELOPES) return emptyIdentity();
                    roots.push({ root: child, depth: depth + 1 });
                }
            }
            if (entry[0] !== 'RelayPrefetchedStreamCache') continue;
            payloads.push(at(entry[3][1], '__bbox', 'result', 'data'));
        }
    }
    if (currentIds.size !== 1) return emptyIdentity();
    const activeId = [...currentIds][0];
    const flags = new Set<boolean>();
    const pageIds = new Set<string>();
    const delegates: { headerName: string; page: Obj }[] = [];
    let invalidPage = false;
    let pageEvidence = false;
    const addPageId = (value: unknown): void => {
        pageEvidence = true;
        const pageId = id(value);
        if (!pageId || pageId === activeId) invalidPage = true;
        else pageIds.add(pageId);
    };
    const observeActor = (actor: unknown): void => {
        if (!isObj(actor) || actor.id !== activeId) return;
        if (typeof actor.is_profile_plus === 'boolean') flags.add(actor.is_profile_plus);
        if (actor.delegate_page_id != null) addPageId(actor.delegate_page_id);
    };
    for (const data of payloads) {
        observeActor(at(data, 'viewer', 'actor'));
        const user = at(data, 'user');
        if (!isObj(user) || user.id !== activeId) continue;
        const header = at(user, 'profile_header_renderer', 'user');
        for (const context of [user, at(user, 'comet_profile_entity_menu', 'user'), header]) {
            if (!isObj(context) || context.id !== activeId || context.delegate_page == null) continue;
            addPageId(at(context.delegate_page, 'id'));
            if (!isObj(context.delegate_page)) continue;
            delegates.push({ headerName: context === header ? string(context.name) : '', page: context.delegate_page });
            observeActor(at(context.delegate_page, 'viewer', 'actor'));
        }
    }
    if (invalidPage || flags.size !== 1 || pageIds.size > 1) return emptyIdentity();
    if (flags.has(false)) return emptyIdentity(pageEvidence ? 'unknown' : 'person');
    if (pageIds.size !== 1 || !delegates.length) return emptyIdentity();
    const pageId = [...pageIds][0];
    const names = new Set<string>();
    const categories = new Set<string>();
    const descriptions = new Set<string>();
    for (const { headerName, page } of delegates) {
        for (const name of [string(page.name), headerName]) if (name) names.add(name);
        const category = string(page.category_name);
        if (category) categories.add(category);
        const about = string(at(page, 'best_description', 'text'));
        if (about) descriptions.add(about);
    }
    if (names.size > 1 || categories.size > 1 || descriptions.size > 1) return emptyIdentity();
    const feeds = payloads.filter((data) => at(data, 'user', 'id') === activeId && at(data, 'user', 'delegate_page', 'id') === pageId);
    return {
        kind: 'page', pageId, pageName: [...names][0] ?? '', category: [...categories][0] ?? '',
        about: ([...descriptions][0] ?? '').slice(0, MAX_ABOUT), recentPosts: postsFromFeeds(feeds),
    };
}

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function metric(renderers: unknown[], ...path: string[]): number | null {
    const values = renderers.map((renderer) => at(renderer, 'feedback', ...path)).filter((value) => value !== undefined);
    const first = count(values[0]);
    return first !== null && values.every((value) => value === first) ? first : null;
}

function postsFromFeeds(feeds: unknown[]): PagePostSample[] {
    const posts: PagePostSample[] = [];
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    for (const data of feeds) {
        const activeId = id(at(data, 'user', 'id'));
        const pageId = id(at(data, 'user', 'delegate_page', 'id'));
        if (!activeId || !pageId || activeId === pageId) continue;
        for (const edge of array(at(data, 'user', 'timeline_list_feed_units', 'edges'))) {
            const story = at(edge, 'node');
            if (!isObj(story) || story.__typename !== 'Story') continue;
            const actors = array(story.actors);
            if (!actors.length || !actors.every((actor) => at(actor, 'id') === activeId)) continue;
            const postId = id(story.post_id);
            if (!postId || !facebookUrl(story.permalink_url)) continue;
            const permalink = new URL(string(story.permalink_url));
            // shortcut: chỉ nhận định danh trong path, mở rộng URL dựa query khi có fixture đã xác minh.
            if (!/^\/(?:(?:reel|posts|permalink)\/[A-Za-z0-9]+|[A-Za-z0-9.-]+\/posts\/[A-Za-z0-9]+)\/?$/.test(permalink.pathname)) continue;
            // Không đưa query/fragment có thể chứa token hoặc mã theo dõi vào kết quả.
            const url = `${permalink.origin}${permalink.pathname}`;
            if (seenIds.has(postId) || seenUrls.has(url)) continue;
            seenIds.add(postId);
            seenUrls.add(url);
            const renderers = array(at(story, 'comet_sections', 'feedback', 'story', 'story_ufi_container', 'story',
                'feedback_context', 'feedback_target_with_context', 'comet_ufi_summary_and_actions_renderer',
                'feedback', 'adaptive_ufi_action_renderers'));
            const seconds = count(story.creation_time);
            const milliseconds = seconds === null ? null : seconds * 1000;
            posts.push({
                text: string(at(story, 'comet_sections', 'content', 'story', 'message', 'text')).slice(0, MAX_POST_TEXT),
                reactions: metric(renderers, 'reaction_count', 'count'),
                comments: metric(renderers, 'comment_rendering_instance', 'comments', 'total_count'),
                shares: metric(renderers, 'share_count', 'count'),
                postedAt: milliseconds !== null && Number.isSafeInteger(milliseconds) && milliseconds <= 8640000000000000
                    ? milliseconds : null,
                url,
            });
            if (posts.length === MAX_POSTS) return posts;
        }
    }
    return posts;
}

/** Nhận một payload feed đã chọn, không nhận toàn bộ cây trang hay news feed. */
export function parsePagePosts(json: unknown): PagePostSample[] {
    return postsFromFeeds([json]);
}

/** Một lần điều hướng có giới hạn; không bấm, gõ, cuộn hay chủ động gọi GraphQL. */
export async function readPageIdentity(page: Page, opts?: { gotoTimeoutMs?: number }): Promise<PageIdentityRead> {
    const timeout = Number.isFinite(opts?.gotoTimeoutMs) && opts.gotoTimeoutMs > 0 ? opts.gotoTimeoutMs : GOTO_TIMEOUT_MS;
    try {
        const response = await page.goto(`${FB_ORIGIN}/me`, { waitUntil: 'load', timeout });
        const problem = loginProblemAt(page.url());
        if (problem) throw new PageLoginProblem(problem);
        if (response && response.status() >= 400) throw new Error(`Không thể tải trang Facebook (HTTP ${response.status()})`);
        const html = await page.content();
        const finalUrl = page.url();
        const finalProblem = loginProblemAt(finalUrl);
        if (finalProblem) throw new PageLoginProblem(finalProblem);
        return parseIdentityHtml(html, finalUrl);
    } catch (error) {
        const problem = loginProblemAt(page.url());
        if (problem) throw new PageLoginProblem(problem);
        throw error;
    }
}
