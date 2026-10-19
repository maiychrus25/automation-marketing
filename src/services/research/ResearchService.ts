// Điều phối lượt quét Nghiên cứu chủ đề: xoay vòng profile, phân trang, giới hạn, huỷ (spec mục 3, 5, 6, 7).
import { BUSY_ERROR } from '../facebookPoster/FacebookPosterService';
import type { ProfileLoginState } from '../../models/facebookPoster';
import type {
    ParsedItem, ResearchErrorCode, ResearchOrigin, ResearchScanStatus, ResearchSource,
} from '../../models/research';
import {
    ResearchError, type GraphqlSession, buildGroupFeedVariables, buildSearchVariables, type CapturedQuery,
} from './graphqlSession';
import {
    describeShape, parseGraphqlChunks, parseGroupFeed, parseSearchGroups, parseSearchPages, parseSearchPosts,
    type ParseResult,
} from './parsers';
import { eligibleProfiles, pickGroupProfile, remainingToday } from './profileRotation';
import type { ResearchConfig } from './researchConfig';
import { DEFAULT_LIMIT, MAX_LIMIT, type ResearchStore } from './ResearchStore';

export const PER_PROFILE_CHUNK = 50;
export const PAGE_DELAY_MIN_MS = 2000;
export const PAGE_DELAY_MAX_MS = 5000;
export const GROUP_DELAY_MIN_MS = 5000;
export const GROUP_DELAY_MAX_MS = 10000;
export const GROUP_FEED_MAX_GROUPS = 20;
export const DEFAULT_LIMIT_PER_GROUP = 30;
export const MAX_LIMIT_PER_GROUP = 100;
export const DEFAULT_SINCE_DAYS = 7;
export const MAX_SINCE_DAYS = 30;
export const PAGE_COUNT = 10;
/** Trần cứng số trang mỗi lượt quét: chặn vòng lặp vô hạn dù Facebook trả con trỏ lạ. */
export const MAX_PAGES_PER_SCAN = 200;
const MAX_EMPTY_PAGES = 2;
const chunkPageBound = (items: number): number => Math.ceil(items / PAGE_COUNT) * 3;
export const MAX_PROFILE_IDS = 50;
const MIN_YEAR = 2010;
const SEARCH_QUERY_NAME = 'SearchCometResultsPaginatedResultsQuery';
const GROUP_FEED_QUERY_NAME = 'GroupsCometFeedRegularStoriesPaginationQuery';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHAPE_DEPTH = 16;
const PROFILE_ERRORS: ResearchErrorCode[] = ['logged_out', 'checkpoint', 'rate_limited'];

/** Phần của GraphqlSession mà service dùng (để test thay bằng bản giả). */
export type ResearchGraphqlSession = Pick<GraphqlSession, 'open' | 'ensureQuery' | 'call' | 'recapture'>;

export interface ResearchServiceDeps {
    store: ResearchStore;
    /** Mở phiên trình duyệt cho profile (Electron: openForAutomation + new GraphqlSession(page, store)). */
    openSession(profileId: string): Promise<{ session: ResearchGraphqlSession; close(): Promise<void> }>;
    listProfiles(): { id: string; name: string }[];
    isProfileBusy(id: string): boolean;
    loginStates(): ProfileLoginState[];
    /** Nhóm mỗi profile đã tham gia (fb_poster_groups); `scannedAt` = lần quét gần nhất (ms) hoặc null. Dùng chọn profile và chọn 20 nhóm mặc định. */
    groupMembership(): Record<string, { url: string; scannedAt: number | null }[]>;
    observeLogin(profileId: string, state: 'logged_out' | 'checkpoint'): void;
    readConfig(): ResearchConfig;
    emit(channel: string, data: unknown): void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    newId?: () => string;
}

export interface SearchParams {
    source: 'posts' | 'groups' | 'pages';
    query: string;
    recent?: boolean;
    year?: number;
    limit?: number;
    profileIds?: string[];
    origin: ResearchOrigin;
}

export interface GroupFeedParams {
    groupUrls?: string[];
    sinceDays?: number;
    limitPerGroup?: number;
    profileIds?: string[];
    origin: ResearchOrigin;
}

interface Outcome { status: Exclude<ResearchScanStatus, 'running'>; errorCode: ResearchErrorCode | ''; error: string }

/** Dừng cả lượt quét (không chỉ một profile). */
class ScanStop extends Error {
    constructor(public readonly outcome: Outcome) { super(outcome.error); }
}

class ProfileOpenError extends Error {}

interface Run {
    scanId: string;
    source: ResearchSource;
    restrictTo?: string[];
    used: string[];
    failed: string[];
    total: number;
    pages: number;
    details: { profiles: Record<string, { items: number; error?: string }>; groups?: Record<string, string>; shape?: string[]; note?: string };
}

interface OpenProfile { id: string; gql: ResearchGraphqlSession; close(): Promise<void> }

const CANCELLED: Outcome = { status: 'cancelled', errorCode: 'cancelled', error: 'Đã huỷ lượt quét.' };

const shortMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);

function inRange(v: unknown, min: number, max: number): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Mã hoặc tên rút gọn của nhóm trong link; rỗng nếu không phải link nhóm. */
function groupKey(url: string): string {
    const m = /\/groups\/([^/?#\s]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : '';
}

export class ResearchService {
    private running: Promise<void> | null = null;
    private cancelled = false;
    private wake: (() => void) | null = null;
    private readonly lastUsedAt: Record<string, number> = {};
    /** Đóng phiên trình duyệt đang mở (nếu có) để huỷ làm lệnh gọi đang treo bị từ chối ngay. */
    private activeClose: (() => Promise<void>) | null = null;
    private wakeSignal: Promise<void> = Promise.resolve();
    private readonly now: () => number;
    private readonly sleepFn: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly newId: () => string;

    constructor(private readonly deps: ResearchServiceDeps) {
        this.now = deps.now ?? Date.now;
        this.sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.random = deps.random ?? Math.random;
        this.newId = deps.newId ?? (() => `rs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    }

    isRunning(): boolean { return this.running !== null; }

    async whenIdle(): Promise<void> { await this.running; }

    /** Huỷ lượt đang chạy (dừng cả khi đang nghỉ). Trả true nếu có lượt đang chạy. */
    cancel(): boolean {
        if (!this.running) return false;
        this.cancelled = true;
        this.wake?.();
        const closeNow = this.activeClose;
        if (closeNow) void closeNow();
        return true;
    }

    /** Dùng khi tắt app. */
    stop(): void { this.cancel(); }

    search(params: SearchParams): { scanId: string } {
        if (!['posts', 'groups', 'pages'].includes(params.source)) throw new Error('Nguồn quét không hợp lệ.');
        const query = typeof params.query === 'string' ? params.query.trim() : '';
        if (query.length < 1 || query.length > 100) throw new Error('Từ khoá phải dài 1–100 ký tự.');
        const limit = params.limit ?? DEFAULT_LIMIT;
        if (!inRange(limit, 1, MAX_LIMIT)) throw new Error(`Số mục tối đa phải từ 1 đến ${MAX_LIMIT}.`);
        if (params.year !== undefined && !inRange(params.year, MIN_YEAR, new Date(this.now()).getFullYear())) {
            throw new Error(`Năm lọc phải từ ${MIN_YEAR} đến năm hiện tại.`);
        }
        if ((params.recent || params.year !== undefined) && params.source !== 'posts') {
            throw new Error('Bộ lọc gần đây/năm chỉ dùng cho bài viết.');
        }
        const profileIds = params.profileIds; // đã kiểm tra ở researchOperationsLogic.checkProfileIds
        const stored = { query, limit, recent: !!params.recent, year: params.year ?? null, profileIds: profileIds ?? null };
        return this.start(params.source, query, stored, params.origin, profileIds,
            (run) => this.runKeyword(run, query, limit, !!params.recent, params.year));
    }

    scanGroupFeeds(params: GroupFeedParams): { scanId: string } {
        const sinceDays = params.sinceDays ?? DEFAULT_SINCE_DAYS;
        if (!inRange(sinceDays, 1, MAX_SINCE_DAYS)) throw new Error(`Số ngày phải từ 1 đến ${MAX_SINCE_DAYS}.`);
        const limitPerGroup = params.limitPerGroup ?? DEFAULT_LIMIT_PER_GROUP;
        if (!inRange(limitPerGroup, 1, MAX_LIMIT_PER_GROUP)) throw new Error(`Số bài mỗi nhóm phải từ 1 đến ${MAX_LIMIT_PER_GROUP}.`);
        const profileIds = params.profileIds; // đã kiểm tra ở researchOperationsLogic.checkProfileIds
        if (params.groupUrls !== undefined
            && (!Array.isArray(params.groupUrls) || params.groupUrls.length > GROUP_FEED_MAX_GROUPS
                || params.groupUrls.some((u) => typeof u !== 'string' || !groupKey(u)))) {
            throw new Error(`Danh sách nhóm phải có tối đa ${GROUP_FEED_MAX_GROUPS} link nhóm hợp lệ.`);
        }
        const stored = { groupUrls: params.groupUrls ?? null, sinceDays, limitPerGroup, profileIds: profileIds ?? null };
        return this.start('group_feed', '', stored, params.origin, profileIds,
            (run) => this.runGroupFeed(run, params.groupUrls, sinceDays, limitPerGroup));
    }

    // ---------- Vòng đời lượt quét ----------

    private start(
        source: ResearchSource, query: string, params: Record<string, unknown>, origin: ResearchOrigin,
        restrictTo: string[] | undefined, body: (run: Run) => Promise<Outcome>,
    ): { scanId: string } {
        if (this.running) throw new Error(BUSY_ERROR);
        const scanId = this.newId();
        this.deps.store.createScan({ id: scanId, source, query, params, profileIds: [], origin, startedAt: this.now() });
        const run: Run = {
            scanId, source, restrictTo, used: [], failed: [], total: 0, pages: 0,
            details: { profiles: {}, ...(source === 'group_feed' ? { groups: {} } : {}) },
        };
        this.cancelled = false;
        this.wakeSignal = new Promise<void>((resolve) => { this.wake = resolve; });
        this.running = this.execute(run, query, body).finally(() => { this.running = null; this.wake = null; });
        return { scanId };
    }

    private async execute(run: Run, query: string, body: (run: Run) => Promise<Outcome>): Promise<void> {
        let outcome: Outcome;
        try {
            outcome = await body(run);
        } catch (e) {
            outcome = e instanceof ScanStop
                ? e.outcome
                : this.cancelled ? CANCELLED : { status: 'failed', errorCode: '', error: `Lỗi nội bộ: ${shortMessage(e)}` };
        }
        let itemCount = run.total;
        let written = false;
        for (let attempt = 0; attempt < 2 && !written; attempt++) {
            try {
                this.deps.store.finishScan(run.scanId, outcome.status, outcome.errorCode, outcome.error, run.details, this.now());
                written = true;
            } catch (e) {
                console.error(`[research] finishScan lỗi (lần ${attempt + 1}): ${shortMessage(e)}`);
            }
        }
        if (!written) return; // không báo trạng thái mà DB không có; failInterruptedScans sẽ sửa khi khởi động lại
        try { itemCount = this.deps.store.getScan(run.scanId)?.itemCount ?? run.total; } catch { /* dùng bộ đếm trong bộ nhớ */ }
        this.emit('research:finished', {
            scanId: run.scanId, source: run.source, query, status: outcome.status, errorCode: outcome.errorCode, itemCount,
        });
    }

    private emit(channel: string, data: unknown): void {
        try { this.deps.emit(channel, data); } catch { /* người nhận lỗi không được chặn lượt quét */ }
    }

    private checkCancel(): void {
        if (this.cancelled) throw new ScanStop(CANCELLED);
    }

    /** Nghỉ ngẫu nhiên [min, max] ms; huỷ thì thoát ngay. */
    private async pause(minMs: number, maxMs: number): Promise<void> {
        this.checkCancel();
        const ms = Math.round(minMs + this.random() * (maxMs - minMs));
        await Promise.race([this.sleepFn(ms), this.wakeSignal]);
        this.checkCancel();
    }

    // ---------- Chọn và mở profile ----------

    private eligible(skip: string[], restrictTo?: string[]): { ids: string[]; remaining(id: string): number } {
        const cfg = this.deps.readConfig();
        const profiles = this.deps.listProfiles();
        const since = this.now() - DAY_MS;
        const used24h: Record<string, number> = {};
        for (const p of profiles) used24h[p.id] = this.deps.store.itemsCapturedSince(p.id, since);
        const ids = eligibleProfiles({
            profiles,
            excluded: cfg.excludedProfileIds,
            busyIds: profiles.filter((p) => this.deps.isProfileBusy(p.id)).map((p) => p.id),
            loginStates: this.deps.loginStates(),
            usedLast24h: used24h,
            lastUsedAt: this.lastUsedAt,
            cap: cfg.perProfileDailyCap,
            restrictTo,
            failedInScan: skip,
        });
        return { ids, remaining: (id) => remainingToday(id, used24h, cfg.perProfileDailyCap) };
    }

    private noProfile(run: Run): Outcome {
        return run.used.length === 0
            ? { status: 'failed', errorCode: 'no_profile_available', error: 'Không có profile nào đủ điều kiện để quét.' }
            : { status: 'done', errorCode: 'no_profile_available', error: 'Hết profile đủ điều kiện trước khi đủ số mục.' };
    }

    private async openProfile(run: Run, id: string): Promise<OpenProfile> {
        if (!run.used.includes(id)) {
            run.used.push(id);
            this.deps.store.updateScanProfiles(run.scanId, run.used);
        }
        run.details.profiles[id] ||= { items: 0 };
        this.lastUsedAt[id] = this.now();
        let opened: { session: ResearchGraphqlSession; close(): Promise<void> };
        try {
            opened = await this.deps.openSession(id);
        } catch (e) {
            throw new ProfileOpenError(shortMessage(e));
        }
        let closing: Promise<void> | null = null;
        const close = (): Promise<void> => closing ||= (async () => {
            try { await opened.close(); } catch { /* đã đóng */ } finally { if (this.activeClose === close) this.activeClose = null; }
        })();
        this.activeClose = close;
        try {
            await opened.session.open();
            return { id, gql: opened.session, close };
        } catch (e) {
            await close();
            throw e;
        }
    }

    /** Lỗi ở một profile: ghi lại và chuyển profile; lỗi cấp lượt quét thì ném ScanStop. */
    private onProfileError(run: Run, id: string, e: unknown, setupPhase: boolean): void {
        if (e instanceof ScanStop) throw e;
        if (this.cancelled) throw new ScanStop(CANCELLED); // huỷ làm phiên bị đóng: lỗi kèm theo không phải lỗi thật
        let code: string;
        if (e instanceof ProfileOpenError) {
            code = `open_failed: ${e.message}`;
        } else if (e instanceof ResearchError) {
            if (e.code === 'query_changed') throw new ScanStop({ status: 'failed', errorCode: 'query_changed', error: e.message });
            if (e.code === 'parse_failed' && !setupPhase) {
                throw new ScanStop({ status: run.total === 0 ? 'failed' : 'done', errorCode: 'parse_failed', error: e.message });
            }
            code = e.code;
            if (e.code === 'logged_out' || e.code === 'checkpoint') {
                try { this.deps.observeLogin(id, e.code); } catch { /* không chặn lượt quét */ }
            }
        } else {
            throw e;
        }
        const entry = (run.details.profiles[id] ||= { items: 0 });
        entry.error = code;
        if (!run.failed.includes(id)) run.failed.push(id);
    }

    private noteShape(run: Run, text: string): void {
        try { run.details.shape = describeShape(parseGraphqlChunks(text), SHAPE_DEPTH); } catch { /* chẩn đoán không bắt buộc */ }
    }

    /** Gọi một trang; doc_id hỏng thì bắt lại đúng một lần rồi gọi lại. */
    private async fetchPage(
        gql: ResearchGraphqlSession, state: { query: CapturedQuery; recapture(): Promise<CapturedQuery> },
        buildVars: (query: CapturedQuery, cursor: string | null) => Record<string, any>,
        parse: (text: string) => ParseResult, cursor: string | null,
    ): Promise<{ res: ParseResult; text: string }> {
        let text = await gql.call(state.query, buildVars(state.query, cursor));
        let res = parse(text);
        if (res.errorCode === 'query_changed') {
            state.query = await state.recapture();
            text = await gql.call(state.query, buildVars(state.query, cursor));
            res = parse(text);
            if (res.errorCode === 'query_changed') throw new ResearchError('query_changed', 'Truy vấn vẫn hỏng sau khi bắt lại.');
        }
        if (res.errorCode && PROFILE_ERRORS.includes(res.errorCode)) {
            throw new ResearchError(res.errorCode, `Facebook báo ${res.errorCode}.`);
        }
        return { res, text };
    }

    /** Lưu tối đa `room` mục MỚI theo thứ tự trang; `leftover` = trang còn mục chưa xét (do hết chỗ). */
    private save(run: Run, items: ParsedItem[], profileId: string, room: number): { added: number; leftover: boolean } {
        let added = 0;
        let leftover = false;
        for (const item of items) {
            if (added >= room) { leftover = true; break; }
            added += this.deps.store.addItems(run.scanId, [item], profileId, this.now());
        }
        run.total += added;
        run.details.profiles[profileId].items += added;
        this.emit('research:progress', { scanId: run.scanId, source: run.source, items: run.total, profileId });
        return { added, leftover };
    }

    // ---------- Quét từ khoá ----------

    private async runKeyword(run: Run, query: string, limit: number, recent: boolean, year?: number): Promise<Outcome> {
        const parse = { posts: parseSearchPosts, groups: parseSearchGroups, pages: parseSearchPages }[run.source as 'posts'];
        const triggerUrl = `https://www.facebook.com/search/${run.source}?q=${encodeURIComponent(query)}`;
        const st = { cursor: null as string | null, finished: false, restarts: 0 };
        while (!st.finished && run.pages < MAX_PAGES_PER_SCAN) {
            this.checkCancel();
            const pool = this.eligible(run.used, run.restrictTo);
            const id = pool.ids[0];
            if (!id) return this.noProfile(run);
            let profile: OpenProfile | null = null;
            let setup = true;
            try {
                profile = await this.openProfile(run, id);
                await this.scanKeywordWithProfile(run, profile, {
                    parse, triggerUrl, query, limit, recent, year, st, cap: pool.remaining(id), ready: () => { setup = false; },
                });
            } catch (e) {
                this.onProfileError(run, id, e, setup);
            } finally {
                await profile?.close();
            }
        }
        return { status: 'done', errorCode: '', error: '' };
    }

    private async scanKeywordWithProfile(run: Run, profile: OpenProfile, o: {
        parse: (text: string) => ParseResult; triggerUrl: string; query: string; limit: number; recent: boolean; year?: number;
        st: { cursor: string | null; finished: boolean; restarts: number }; cap: number; ready(): void;
    }): Promise<void> {
        const { gql, id } = profile;
        const name = SEARCH_QUERY_NAME;
        const state = {
            query: await gql.ensureQuery(run.source, name, o.triggerUrl),
            recapture: () => gql.recapture(run.source, name, o.triggerUrl),
        };
        this.checkCancel();
        o.ready();
        const buildVars = (q: CapturedQuery, cursor: string | null) =>
            buildSearchVariables(q.variables, { query: o.query, source: run.source, recent: o.recent, year: o.year, cursor, count: PAGE_COUNT });
        let inProfile = 0;
        let firstCall = true;
        let emptyStreak = 0;
        let pages = 0;
        let maxPages = chunkPageBound(PER_PROFILE_CHUNK);
        let restarted = false;
        const seen = new Set<string>();
        for (;;) {
            run.pages++;
            pages++;
            if (o.st.cursor !== null) seen.add(o.st.cursor);
            let { res, text } = await this.fetchPage(gql, state, buildVars, o.parse, o.st.cursor);
            if (firstCall && o.st.cursor !== null && (res.items.length === 0 || res.errorCode)) {
                // Con trỏ mang từ profile trước không dùng được: bắt đầu lại, mục trùng sẽ bị bỏ.
                if (++o.st.restarts >= 2) {
                    // Hai profile liên tiếp đều không dùng được con trỏ: con trỏ không chuyển được giữa các tài khoản, xoay vòng không mở rộng được kết quả.
                    run.details.note = 'cursor_not_portable';
                    o.st.finished = true;
                    return;
                }
                restarted = true;
                // Cần đọc lại tới vị trí cũ (các trang trùng chưa tính là trang trống) rồi lấy thêm một phần.
                maxPages = chunkPageBound(run.total + PER_PROFILE_CHUNK);
                o.st.cursor = null;
                seen.clear(); // con trỏ cũ đã bị từ chối; đọc lại từ đầu có thể gặp lại giá trị đó
                ({ res, text } = await this.fetchPage(gql, state, buildVars, o.parse, null));
            }
            if (res.errorCode === 'parse_failed') {
                this.noteShape(run, text);
                throw new ResearchError('parse_failed', 'Không đọc được phản hồi Facebook.');
            }
            if (firstCall && res.items.length === 0) this.noteShape(run, text);
            if (firstCall && o.st.cursor !== null && !restarted) o.st.restarts = 0; // con trỏ mang sang dùng được
            firstCall = false;
            const room = Math.min(o.limit - run.total, PER_PROFILE_CHUNK - inProfile, o.cap - inProfile);
            const { added, leftover } = this.save(run, res.items, id, room);
            inProfile += added;
            if (added > 0) emptyStreak = 0;
            else if (!(restarted && pages < maxPages)) emptyStreak++; // đang đọc lại tới vị trí cũ: trang trùng không tính
            if (run.total >= o.limit) { o.st.finished = true; return; }
            if (leftover) return; // giữ nguyên con trỏ: profile kế tiếp đọc lại trang này, mục trùng bị bỏ
            const next = res.endCursor;
            if (next === null || res.items.length === 0 || seen.has(next) || next === o.st.cursor) { o.st.finished = true; return; }
            o.st.cursor = next;
            if (run.pages >= MAX_PAGES_PER_SCAN) { o.st.finished = true; return; }
            if (inProfile >= PER_PROFILE_CHUNK || inProfile >= o.cap || emptyStreak >= MAX_EMPTY_PAGES || pages >= maxPages) return;
            await this.pause(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS);
        }
    }

    // ---------- Quét bài trong nhóm ----------

    private membershipUrls(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [id, rows] of Object.entries(this.deps.groupMembership())) out[id] = rows.map((r) => r.url);
        return out;
    }

    /** 20 nhóm được quét gần nhất trong các profile đủ điều kiện (spec §8). */
    private recentGroups(restrictTo?: string[]): string[] {
        const membership = this.deps.groupMembership();
        const best = new Map<string, { url: string; scannedAt: number }>();
        for (const id of this.eligible([], restrictTo).ids) {
            for (const row of membership[id] ?? []) {
                const key = groupKey(row.url);
                if (!key) continue;
                const at = row.scannedAt ?? 0;
                if (!best.has(key) || best.get(key)!.scannedAt < at) best.set(key, { url: row.url, scannedAt: at });
            }
        }
        return [...best.values()].sort((a, b) => b.scannedAt - a.scannedAt).slice(0, GROUP_FEED_MAX_GROUPS).map((g) => g.url);
    }

    private async runGroupFeed(run: Run, given: string[] | undefined, sinceDays: number, limitPerGroup: number): Promise<Outcome> {
        const groups = (given ?? this.recentGroups(run.restrictTo)).filter((u) => groupKey(u)).slice(0, GROUP_FEED_MAX_GROUPS);
        if (this.eligible([], run.restrictTo).ids.length === 0) return this.noProfile(run);
        if (groups.length === 0) {
            run.details.note = 'no_groups';
            return { status: 'done', errorCode: '', error: 'Chưa có nhóm nào để quét — hãy quét nhóm ở profile hoặc nhập link nhóm' };
        }
        let current: OpenProfile | null = null;
        let captured = 0;
        let captureFailed = 0;
        try {
            for (let i = 0; i < groups.length; i++) {
                if (run.pages >= MAX_PAGES_PER_SCAN) break;
                if (i > 0) await this.pause(GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS);
                this.checkCancel();
                for (;;) {
                    const pool = this.eligible(run.failed, run.restrictTo);
                    const id = pickGroupProfile(groups[i], this.membershipUrls(), pool.ids);
                    if (!id) return this.noProfile(run);
                    let setup = true;
                    try {
                        if (current?.id !== id) {
                            await current?.close();
                            current = null;
                            current = await this.openProfile(run, id);
                        }
                        const gotQuery = await this.scanGroup(run, current, groups[i], sinceDays, limitPerGroup, pool.remaining(id), () => { setup = false; });
                        if (gotQuery) captured++; else captureFailed++;
                        break;
                    } catch (e) {
                        await current?.close();
                        current = null;
                        this.onProfileError(run, id, e, setup);
                    }
                }
            }
        } finally {
            await current?.close();
        }
        if (captureFailed > 0 && captured === 0) {
            return { status: 'failed', errorCode: 'query_changed', error: 'Không bắt được truy vấn bài viết của nhóm nào.' };
        }
        return { status: 'done', errorCode: '', error: '' };
    }

    /** Trả false khi không lấy được truy vấn của nhóm (chỉ đánh dấu nhóm đó, lượt quét vẫn tiếp tục). */
    private async scanGroup(
        run: Run, profile: OpenProfile, url: string, sinceDays: number, limitPerGroup: number, cap: number, ready: () => void,
    ): Promise<boolean> {
        const { gql, id } = profile;
        const key = groupKey(url);
        const numeric = /^\d+$/.test(key);
        const triggerUrl = `https://www.facebook.com/groups/${key}/?sorting_setting=CHRONOLOGICAL`;
        const query = await this.groupQuery(run, gql, url, triggerUrl, !numeric);
        if (!query) return false;
        const state = {
            query,
            recapture: () => gql.recapture('group_feed', GROUP_FEED_QUERY_NAME, triggerUrl),
        };
        this.checkCancel();
        ready();
        // Link rút gọn: id thật nằm trong truy vấn bắt từ chính trang nhóm; không có id số thì không quét được.
        const idKey = ['id', 'groupID'].find((k) => k in query.variables);
        const groupId = numeric ? key : String(idKey ? query.variables[idKey] : '');
        if (!/^\d+$/.test(groupId)) {
            run.details.groups![url] = 'unresolved';
            return true;
        }
        const buildVars = (q: CapturedQuery, cursor: string | null) => {
            const vars = buildGroupFeedVariables(q.variables, { cursor, count: PAGE_COUNT });
            // Mẫu có thể bắt từ một nhóm khác: chỉ đổi id khi link có mã số; link rút gọn dùng id đã bắt từ chính trang nhóm.
            if (numeric) for (const k of ['id', 'groupID']) if (k in vars) vars[k] = key;
            return vars;
        };
        const parse = (text: string) => parseGroupFeed(text, { groupId });
        const cutoff = this.now() - sinceDays * DAY_MS;
        let cursor: string | null = null;
        let got = 0;
        let emptyStreak = 0;
        let pages = 0;
        const maxPages = chunkPageBound(limitPerGroup);
        const seen = new Set<string>();
        for (let first = true; ; first = false) {
            run.pages++;
            pages++;
            if (cursor !== null) seen.add(cursor);
            const { res, text } = await this.fetchPage(gql, state, buildVars, parse, cursor);
            if (res.items.length === 0) {
                if (first || res.errorCode) {
                    if (!run.details.shape) this.noteShape(run, text);
                    if (first) run.details.groups![url] = res.errorCode ? 'not_member' : 'empty';
                }
                return true;
            }
            const fresh = res.items.filter((it) => it.postedAt === null || it.postedAt >= cutoff);
            const { added, leftover } = this.save(run, fresh, id, Math.min(limitPerGroup - got, cap - got));
            got += added;
            emptyStreak = added === 0 ? emptyStreak + 1 : 0;
            const next = res.endCursor;
            if (fresh.length < res.items.length || leftover || got >= limitPerGroup || got >= cap
                || next === null || seen.has(next) || next === cursor
                || emptyStreak >= MAX_EMPTY_PAGES || pages >= maxPages || run.pages >= MAX_PAGES_PER_SCAN) return true;
            await this.pause(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS);
            cursor = next;
        }
    }

    /** Lấy truy vấn bài viết nhóm; không bắt được thì đánh dấu riêng nhóm này (null), các lỗi khác ném tiếp. */
    private async groupQuery(
        run: Run, gql: ResearchGraphqlSession, url: string, triggerUrl: string, fresh: boolean,
    ): Promise<CapturedQuery | null> {
        try {
            return await gql.ensureQuery('group_feed', GROUP_FEED_QUERY_NAME, triggerUrl, fresh);
        } catch (e) {
            if (e instanceof ResearchError && e.code === 'query_changed') {
                run.details.groups![url] = 'unresolved';
                return null;
            }
            throw e;
        }
    }
}
