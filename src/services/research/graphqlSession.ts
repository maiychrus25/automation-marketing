import type { Page } from 'playwright-core';
import type { ResearchStore } from './ResearchStore';
import type { ResearchErrorCode, ResearchSource } from '../../models/research';

const FB_HOME = 'https://www.facebook.com/';
const GRAPHQL_PATH = '/api/graphql/';
const MAX_SCROLLS = 6;
/** Một lệnh gọi GraphQL trong trang quá thời gian này thì huỷ (tránh treo cả lượt quét). */
export const FETCH_TIMEOUT_MS = 30000;

export class ResearchError extends Error {
    constructor(public readonly code: ResearchErrorCode, message: string) {
        super(message);
        this.name = 'ResearchError';
    }
}

/** Truy vấn đã bắt được: tên thật, doc_id và biến mẫu (đối tượng). */
export interface CapturedQuery {
    friendlyName: string;
    docId: string;
    variables: Record<string, any>;
}

interface SessionTokens { dtsg: string; lsd: string; userId: string }

interface SessionDeps {
    /** Main-process guard only; never passed into page.evaluate. */
    assertCurrent?: () => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

/** Chạy TRONG trang: đọc mã phiên (không log, không lưu). */
export function readTokensInPage(): { dtsg: string; lsd: string; userId: string; loginForm: boolean } {
    const req = (globalThis as any).require;
    const mod = (name: string): any => {
        try { return typeof req === 'function' ? req(name) : null; } catch { return null; }
    };
    let html = '';
    try { html = document.documentElement.outerHTML; } catch { html = ''; }
    const rx = (pattern: RegExp): string => { const m = html.match(pattern); return m ? m[1] : ''; };
    let dtsg = mod('DTSGInitialData')?.token || '';
    if (!dtsg) dtsg = rx(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
    if (!dtsg) {
        try { dtsg = (document.querySelector('input[name="fb_dtsg"]') as HTMLInputElement | null)?.value || ''; } catch { dtsg = ''; }
    }
    let lsd = mod('LSD')?.token || '';
    if (!lsd) lsd = rx(/"LSD",\[\],\{"token":"([^"]+)"/);
    let userId = mod('CurrentUserInitialData')?.USER_ID || '';
    if (!userId) userId = rx(/"USER_ID":"(\d+)"/);
    if (userId === '0') userId = '';
    let loginForm = false;
    try { loginForm = !!document.querySelector('form[action*="/login"], input[name="pass"]'); } catch { loginForm = false; }
    return { dtsg: String(dtsg), lsd: String(lsd), userId: String(userId), loginForm };
}

/** Chạy TRONG trang: gọi fetch cùng nguồn gốc, trả mã HTTP và text thô. */
async function fetchInPage(arg: { body: string; name: string; lsd: string; timeoutMs: number }): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), arg.timeoutMs);
    try {
        const res = await fetch('/api/graphql/', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-fb-friendly-name': arg.name,
                'x-fb-lsd': arg.lsd,
            },
            body: arg.body,
            signal: controller.signal,
        });
        return { status: res.status, text: await res.text() };
    } finally {
        clearTimeout(timer);
    }
}

function shortMessage(e: unknown): string {
    const m = e instanceof Error ? e.message : String(e);
    return m.replace(/\s+/g, ' ').slice(0, 120);
}

function isAborted(e: unknown): boolean {
    return /abort/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
}

function isConnectionLost(e: unknown): boolean {
    return /closed|destroyed|detached|disconnected|crashed/i.test(e instanceof Error ? e.message : String(e));
}

/** Chuyển lỗi điều hướng thành ResearchError (không lộ mã phiên). */
async function gotoOrThrow(page: Page, url: string): Promise<void> {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
        if (e instanceof ResearchError) throw e;
        throw new ResearchError('parse_failed', isConnectionLost(e)
            ? `Mất kết nối với trang: ${shortMessage(e)}`
            : `Không tải được trang: ${shortMessage(e)}`);
    }
}

function fallbackMatches(source: ResearchSource, name: string): boolean {
    return source === 'group_feed' ? name.includes('GroupsCometFeed') : name.includes('Search') && name.includes('Results');
}

export class GraphqlSession {
    private tokens: SessionTokens | null = null;
    private recaptured = false;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly assertCurrent: () => void;

    constructor(
        private readonly page: Page,
        private readonly store: Pick<ResearchStore, 'getQuery' | 'saveQuery'>,
        deps: SessionDeps = {},
    ) {
        this.assertCurrent = deps.assertCurrent ?? (() => {});
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.random = deps.random ?? Math.random;
    }

    async open(): Promise<void> {
        this.assertCurrent();
        try { await gotoOrThrow(this.page, FB_HOME); } finally { this.assertCurrent(); }
        this.assertNotRedirected();
        let t: ReturnType<typeof readTokensInPage>;
        try { t = await this.page.evaluate(readTokensInPage); } finally { this.assertCurrent(); }
        if (!t.dtsg) {
            throw new ResearchError('logged_out', t.loginForm
                ? 'Profile chưa đăng nhập Facebook (thấy form đăng nhập).'
                : 'Không đọc được mã phiên Facebook (fb_dtsg); coi như chưa đăng nhập.');
        }
        let userId = t.userId;
        if (!userId) {
            let cookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>;
            try { cookies = await this.page.context().cookies(); } finally { this.assertCurrent(); }
            userId = cookies.find((c) => c.name === 'c_user')?.value || '';
        }
        if (!userId) throw new ResearchError('logged_out', 'Không đọc được ID người dùng Facebook; coi như chưa đăng nhập.');
        this.tokens = { dtsg: t.dtsg, lsd: t.lsd, userId };
    }

    /** Mã người dùng Facebook của profile (đọc khi open()); chỉ đọc. */
    userId(): string {
        this.assertCurrent();
        if (!this.tokens) throw new ResearchError('logged_out', 'Phiên GraphQL chưa mở (gọi open() trước).');
        return this.tokens.userId;
    }

    /** Trang vừa tải bị đưa sang /checkpoint hoặc /login thì ném đúng mã. */
    private assertNotRedirected(): void {
        let path = '';
        try { path = new URL(this.page.url()).pathname; } catch { path = ''; }
        if (path.startsWith('/checkpoint')) throw new ResearchError('checkpoint', 'Profile bị Facebook yêu cầu xác minh (checkpoint).');
        if (path.startsWith('/login')) throw new ResearchError('logged_out', 'Profile chưa đăng nhập Facebook.');
    }

    /** `fresh`: bỏ qua mẫu đã lưu, bắt từ chính trang `triggerUrl` (nhóm có link rút gọn cần id thật của nhóm đó). */
    async ensureQuery(source: ResearchSource, friendlyName: string, triggerUrl: string, fresh = false): Promise<CapturedQuery> {
        this.assertCurrent();
        const stored = fresh ? undefined : this.store.getQuery(`${friendlyName}:${source}`);
        this.assertCurrent();
        if (stored) {
            try {
                const parsed = JSON.parse(stored.variablesTemplate);
                if (parsed && typeof parsed.friendlyName === 'string' && parsed.variables && typeof parsed.variables === 'object') {
                    return { friendlyName: parsed.friendlyName, docId: stored.docId, variables: parsed.variables };
                }
            } catch { /* mẫu hỏng: bắt lại */ }
        }
        return this.capture(source, friendlyName, triggerUrl);
    }

    /** Bắt lại truy vấn (doc_id hết hạn). Tối đa 1 lần cho mỗi phiên. */
    async recapture(source: ResearchSource, friendlyName: string, triggerUrl: string): Promise<CapturedQuery> {
        this.assertCurrent();
        if (this.recaptured) {
            throw new ResearchError('query_changed', `Truy vấn ${friendlyName} vẫn hỏng sau khi bắt lại.`);
        }
        this.recaptured = true;
        return this.capture(source, friendlyName, triggerUrl);
    }

    async call(query: CapturedQuery, variables: Record<string, unknown>): Promise<string> {
        this.assertCurrent();
        const t = this.tokens;
        if (!t) throw new ResearchError('logged_out', 'Phiên GraphQL chưa mở (gọi open() trước).');
        const body = new URLSearchParams({
            av: t.userId,
            __user: t.userId,
            __a: '1',
            fb_dtsg: t.dtsg,
            lsd: t.lsd,
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: query.friendlyName,
            variables: JSON.stringify(variables),
            server_timestamps: 'true',
            doc_id: query.docId,
        }).toString();
        let res: { status: number; text: string };
        try {
            res = await this.page.evaluate(fetchInPage, { body, name: query.friendlyName, lsd: t.lsd, timeoutMs: FETCH_TIMEOUT_MS });
        } catch (e) {
            if (isAborted(e)) throw new ResearchError('rate_limited', `Facebook không phản hồi trong ${FETCH_TIMEOUT_MS / 1000} giây`);
            throw new ResearchError('parse_failed', isConnectionLost(e)
                ? `Mất kết nối với trang: ${shortMessage(e)}`
                : `Lỗi mạng khi gọi Facebook: ${shortMessage(e)}`);
        } finally {
            this.assertCurrent();
        }
        // 401/403 có thể do mã chống giả mạo hết hạn: chỉ bỏ qua profile này, KHÔNG coi là đăng xuất (đăng xuất chỉ nhận qua chuyển trang /login).
        if (res.status === 401 || res.status === 403) throw new ResearchError('rate_limited', `Facebook từ chối yêu cầu (HTTP ${res.status}).`);
        if (res.status === 429) throw new ResearchError('rate_limited', 'Facebook giới hạn tần suất (HTTP 429).');
        if (res.status >= 400) throw new ResearchError('parse_failed', `Facebook trả HTTP ${res.status}.`);
        return res.text;
    }

    private async capture(source: ResearchSource, friendlyName: string, triggerUrl: string): Promise<CapturedQuery> {
        this.assertCurrent();
        let exact: { name: string; docId: string; variables: string } | null = null;
        let fallback: typeof exact = null;
        const onRequest = (request: any) => {
            try {
                if (request.method() !== 'POST' || !String(request.url()).includes(GRAPHQL_PATH)) return;
                const form = new URLSearchParams(request.postData() || '');
                const name = form.get('fb_api_req_friendly_name') || '';
                const docId = form.get('doc_id') || '';
                const variables = form.get('variables') || '';
                if (!name || !docId || !variables) return;
                if (name === friendlyName) exact = exact || { name, docId, variables };
                else if (fallbackMatches(source, name)) fallback = fallback || { name, docId, variables };
            } catch { /* bỏ qua request không đọc được */ }
        };
        this.page.on('request', onRequest);
        try {
            try { await gotoOrThrow(this.page, triggerUrl); } finally { this.assertCurrent(); }
            this.assertNotRedirected();
            for (let i = 0; i < MAX_SCROLLS && !exact; i++) {
                try { await this.page.mouse.wheel(0, 1500); } finally { this.assertCurrent(); }
                try { await this.sleep(1500 + Math.floor(this.random() * 1500)); } finally { this.assertCurrent(); }
            }
        } finally {
            this.page.off('request', onRequest);
        }
        this.assertCurrent();
        const hit = (exact || fallback) as { name: string; docId: string; variables: string } | null;
        if (!hit) {
            throw new ResearchError('query_changed', `Không bắt được truy vấn ${friendlyName} khi mở ${triggerUrl}.`);
        }
        let variables: Record<string, any>;
        try { variables = JSON.parse(hit.variables); } catch {
            throw new ResearchError('query_changed', `Biến của truy vấn ${hit.name} không đọc được (${triggerUrl}).`);
        }
        this.assertCurrent();
        this.store.saveQuery(`${friendlyName}:${source}`, hit.docId, JSON.stringify({ friendlyName: hit.name, variables }), this.now());
        this.assertCurrent();
        return { friendlyName: hit.name, docId: hit.docId, variables };
    }
}

export interface SearchVariableOptions {
    query: string;
    source: ResearchSource;
    recent?: boolean;
    year?: number;
    cursor: string | null;
    count: number;
}

/** Thay text/filters/cursor/count trên bản sao của mẫu; giữ nguyên mọi khoá khác. */
export function buildSearchVariables(template: Record<string, any>, opts: SearchVariableOptions): Record<string, any> {
    const out: Record<string, any> = JSON.parse(JSON.stringify(template));
    out.cursor = opts.cursor;
    out.count = opts.count;
    if (out.args && typeof out.args === 'object') {
        out.args.text = opts.query;
        const filters: string[] = [];
        if (opts.recent) filters.push(JSON.stringify({ name: 'recent_posts', args: '' }));
        if (opts.year) {
            const y = String(opts.year);
            filters.push(JSON.stringify({
                name: 'creation_time',
                args: JSON.stringify({ start_year: y, start_month: `${y}-1`, end_year: y, end_month: `${y}-12` }),
            }));
        }
        out.args.filters = filters;
    }
    return out;
}

export function buildGroupFeedVariables(template: Record<string, any>, opts: { cursor: string | null; count: number }): Record<string, any> {
    const out: Record<string, any> = JSON.parse(JSON.stringify(template));
    out.cursor = opts.cursor;
    out.count = opts.count;
    return out;
}
