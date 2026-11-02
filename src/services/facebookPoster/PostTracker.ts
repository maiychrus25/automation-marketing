import { randomUUID } from 'crypto';
import type { ProfileTaskContext } from '../browser/ProfileJobQueue';
import type { LinkStatus, PostTrackingRow } from '../../models/facebookPoster';
import type { ParsedItem } from '../../models/research';
import { systemClock } from '../dailyBrief/DailyBriefStore';
import { PageLoginProblem, type PageIdentityRead } from '../dailyBrief/pageIdentity';
import { ResearchError, type GraphqlSession } from '../research/graphqlSession';
import { fetchGraphqlPage, groupKey, isUnresolved, prepareGroupFeed } from '../research/groupFeed';
import { describeShape, parseGraphqlChunks, parseGroupFeed } from '../research/parsers';
import Logger from '../../utils/Logger';
import { BUSY_ERROR } from './FacebookPosterService';
import { DEFAULT_LEAD_CONFIG, computeNextCommentAt, type LeadConfig } from './leadRules';
import type { FacebookPosterStore } from './FacebookPosterStore';
import {
    DEFAULT_POST_TRACKING_CONFIG, computeNextCheckAt, linkRetryExhausted, markOverdueStatsDone, matchPagePosts, pickBestMatch,
    type PostTrackingConfig,
} from './postTracking';

// Theo dõi bài đã đăng: đọc bảng tin nhóm bằng chính profile đã đăng để lấy link và đo tương tác.
// Chỉ đọc Facebook (không đăng, không bấm). Spec: docs/specs/2026-10-19-post-performance.md mục 4.

export const MAX_TRACK_GROUPS = 30;
export const AUTO_TRACK_GROUPS = 10;
export const MAX_TRACK_PAGES_PER_GROUP = 10;
export const DEFAULT_TRACK_SINCE_DAYS = 3;
export const MAX_TRACK_SINCE_DAYS = 14;
export const TRACK_PAGE_COUNT = 10;
const PAGE_DELAY_MIN_MS = 3000;
const PAGE_DELAY_MAX_MS = 6000;
const GROUP_DELAY_MIN_MS = 8000;
const GROUP_DELAY_MAX_MS = 15000;
const MAX_EMPTY_PAGES = 2;
const STOP_MARGIN_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_LIMIT = 5000;
const SHAPE_DEPTH = 16;

/** Có `pageId` (kể cả `''` khi chưa học được Page) là cặp (profile, Page); không có là cặp (profile, nhóm). */
export interface TrackPair { profileId: string; groupUrl: string; pageId?: string }
export interface TrackParams {
    sinceDays?: number;
    groupUrls?: string[];
    profileIds?: string[];
    auto?: boolean;
    /** Chỉ các cặp này (bộ hẹn giờ truyền các cặp đến hạn); bỏ qua groupUrls/profileIds. */
    pairs?: TrackPair[];
}
export interface TrackError { groupUrl: string; profileId: string; error: string }
export interface TrackResult {
    jobId: string;
    auto: boolean;
    finishedAt: number;
    cancelled: boolean;
    groups: number;
    checked: number;
    found: number;
    linked: number;
    removedSuspected: number;
    notFound: number;
    errors: TrackError[];
    shape?: string[];
}
export interface TrackStatus {
    running: boolean;
    jobId: string | null;
    progress: { done: number; total: number };
    last: TrackResult | null;
}

export type TrackSession = Pick<GraphqlSession, 'open' | 'ensureQuery' | 'call' | 'recapture' | 'userId'>;

export interface PostTrackerDeps {
    store: Pick<FacebookPosterStore,
        'listTracking' | 'listTrackingForPair' | 'updateTracking' | 'addPostStats' | 'updateCommentSchedule'
        | 'recordPageFollowers' | 'hasPageFollowersOn'>;
    openSession(profileId: string, context: ProfileTaskContext): Promise<{ session: TrackSession; close(): Promise<void> }>;
    assertCurrent?: () => void;
    observeLogin(profileId: string, state: 'logged_out' | 'checkpoint'): void;
    emit(type: string, payload: unknown): void;
    /** Cấu hình mốc kiểm tra; thiếu thì dùng mặc định. */
    getConfig?: () => PostTrackingConfig;
    /** Cấu hình khách tiềm năng (mốc thu bình luận); thiếu thì dùng mặc định. */
    getLeadConfig?: () => LeadConfig;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    newId?: () => string;
    /** Đọc Page của profile (đi qua hàng chờ profile bằng đúng context của lượt); thiếu thì cặp Page chỉ lên lịch lại. */
    readPage?(profileId: string, context: ProfileTaskContext): Promise<PageIdentityRead>;
    /** Ngày địa phương YYYY-MM-DD cho ảnh chụp người theo dõi. */
    localDate?: (ms: number) => string;
    /** Dòng Page vừa có link khi tìm lại. */
    onPagePostKnown?: (row: PostTrackingRow) => void;
}

interface Counters { checked: number; found: number; linked: number; removedSuspected: number; notFound: number }
interface PairReading { items: ParsedItem[]; oldest: number | null; groupId: string; userId: string }

const isPending = (s: LinkStatus) => s === 'missing' || s === 'pending_approval';

export class PostTracker {
    private running: Promise<void> = Promise.resolve();
    private active = false;
    private cancelled = false;
    private abort = new AbortController();
    private wake: (() => void) | null = null;
    private jobId: string | null = null;
    private progress = { done: 0, total: 0 };
    private last: TrackResult | null = null;
    /** Cặp vừa xử lý có mở trình duyệt (kể cả mở lỗi). */
    private openedBrowser = false;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly sleepFn: (ms: number) => Promise<void>;

    constructor(private readonly deps: PostTrackerDeps) {
        this.now = deps.now ?? Date.now;
        this.random = deps.random ?? Math.random;
        this.sleepFn = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /** Giữ admission riêng đồng bộ (ném BUSY khi job trước còn sống), sau đó chạy nền. */
    track(params: TrackParams = {}): { jobId: string; pairs: TrackPair[] } {
        if (this.active) throw new Error(BUSY_ERROR);
        const sinceDays = params.sinceDays ?? DEFAULT_TRACK_SINCE_DAYS;
        if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_TRACK_SINCE_DAYS) {
            throw new Error(`sinceDays phải là số nguyên từ 1 đến ${MAX_TRACK_SINCE_DAYS}`);
        }
        if (params.groupUrls && (!Array.isArray(params.groupUrls) || params.groupUrls.length > MAX_TRACK_GROUPS
            || params.groupUrls.some((u) => typeof u !== 'string'))) {
            throw new Error(`groupUrls tối đa ${MAX_TRACK_GROUPS} link nhóm`);
        }
        this.active = true;
        this.cancelled = false;
        this.abort = new AbortController();
        let jobId: string;
        let pairs: TrackPair[];
        try {
            this.deps.assertCurrent?.();
            jobId = (this.deps.newId ?? randomUUID)();
            pairs = this.selectPairs(params, sinceDays);
        } catch (e) {
            this.active = false;
            throw e;
        }
        this.jobId = jobId;
        this.progress = { done: 0, total: pairs.length };
        // Cặp của bộ hẹn giờ nạp mọi dòng đến hạn (trackPair làm nguội dòng quá cũ), không giới hạn theo ngày.
        const sinceMs = params.pairs ? 0 : this.now() - sinceDays * DAY_MS;
        this.running = this.run(jobId, !!params.auto, pairs, sinceMs).catch(() => undefined);
        return { jobId, pairs };
    }

    status(): TrackStatus {
        return { running: this.active, jobId: this.active ? this.jobId : null, progress: { ...this.progress }, last: this.last };
    }

    isRunning(): boolean { return this.active; }

    cancel(): boolean {
        if (!this.active) return false;
        this.cancelled = true;
        this.abort.abort();
        this.wake?.();
        return true;
    }

    stop(): void { this.cancel(); }
    whenIdle(): Promise<void> { return this.running; }

    // ---------- Chọn cặp (spec 4.1) ----------

    private selectPairs(params: TrackParams, sinceDays: number): TrackPair[] {
        if (params.pairs) {
            return params.pairs.slice(0, MAX_TRACK_GROUPS).map((p) => (p.pageId === undefined
                ? { profileId: p.profileId, groupUrl: p.groupUrl } : { profileId: p.profileId, groupUrl: p.groupUrl, pageId: p.pageId }));
        }
        const sinceMs = this.now() - sinceDays * DAY_MS;
        const wantedGroups = params.groupUrls ? new Set(params.groupUrls.map(groupKey).filter(Boolean)) : null;
        const wantedProfiles = params.profileIds ? new Set(params.profileIds) : null;
        const groups = new Map<string, { pair: TrackPair; priority: number; checked: number }>();
        for (const row of this.deps.store.listTracking({ sinceMs, limit: ROW_LIMIT })) {
            if (row.linkStatus === 'not_found') continue;
            // Page chưa học được thì không có gì để đọc; bộ hẹn giờ tự lên lịch lại các dòng đó.
            if (row.targetKind === 'page' && row.pageId === '') continue;
            if (wantedProfiles && !wantedProfiles.has(row.profileId)) continue;
            if (wantedGroups && !wantedGroups.has(groupKey(row.groupUrl))) continue;
            const page = row.targetKind === 'page';
            const key = `${row.profileId}\u0000${row.groupUrl}${page ? `\u0000${row.pageId}` : ''}`;
            const pair: TrackPair = page ? { profileId: row.profileId, groupUrl: row.groupUrl, pageId: row.pageId } : { profileId: row.profileId, groupUrl: row.groupUrl };
            const entry = groups.get(key) ?? { pair, priority: 1, checked: Infinity };
            if (isPending(row.linkStatus)) entry.priority = 0;
            entry.checked = Math.min(entry.checked, row.lastCheckedAt ?? 0);
            groups.set(key, entry);
        }
        return [...groups.values()]
            .sort((a, b) => a.priority - b.priority || a.checked - b.checked
                || a.pair.profileId.localeCompare(b.pair.profileId) || a.pair.groupUrl.localeCompare(b.pair.groupUrl))
            .slice(0, MAX_TRACK_GROUPS).map((g) => g.pair);
    }

    // ---------- Chạy nền ----------

    private emit(type: string, payload: unknown): void {
        try { this.deps.emit(type, payload); } catch { /* người nhận lỗi không được chặn lượt theo dõi */ }
    }

    /** Nghỉ ngẫu nhiên [min, max] ms; huỷ thì thoát ngay. */
    private async pause(minMs: number, maxMs: number): Promise<void> {
        if (this.cancelled) return;
        const ms = Math.round(minMs + this.random() * (maxMs - minMs));
        const woken = new Promise<void>((resolve) => { this.wake = resolve; });
        await Promise.race([this.sleepFn(ms), woken]);
        this.wake = null;
    }

    private async run(jobId: string, auto: boolean, pairs: TrackPair[], sinceMs: number): Promise<void> {
        const totals: Counters = { checked: 0, found: 0, linked: 0, removedSuspected: 0, notFound: 0 };
        const errors: TrackError[] = [];
        const skipped = new Set<string>();
        const shape: { value?: string[] } = {};
        this.openedBrowser = false;
        // Nhường một nhịp để `trackFinished` luôn phát sau khi `track()` đã trả về (kể cả khi không có cặp nào).
        await Promise.resolve();
        try {
          try {
            for (let i = 0; i < pairs.length && !this.cancelled; i++) {
                const pair = pairs[i];
                // Chỉ nghỉ sau cặp đã mở trình duyệt; cặp bị bỏ qua / lên lịch lại không mở gì thì không nghỉ.
                if (this.openedBrowser) await this.pause(GROUP_DELAY_MIN_MS, GROUP_DELAY_MAX_MS);
                this.openedBrowser = false;
                if (this.cancelled) break;
                if (skipped.has(pair.profileId)) {
                    this.backOffPair(pair, totals);
                } else {
                    try {
                        await this.trackPair(pair, sinceMs, totals, shape);
                    } catch (e) {
                        this.backOffPair(pair, totals);
                        const code = e instanceof ResearchError ? e.code : e instanceof PageLoginProblem ? e.state : 'error';
                        const message = code !== 'error' ? code : (e instanceof Error ? e.message : String(e));
                        errors.push({ groupUrl: pair.groupUrl, profileId: pair.profileId, error: message });
                        if (code === 'logged_out' || code === 'checkpoint') {
                            try { this.deps.observeLogin(pair.profileId, code); } catch { /* quan sát không được làm hỏng lượt */ }
                            skipped.add(pair.profileId);
                        } else if (code === 'rate_limited') {
                            skipped.add(pair.profileId);
                        }
                    }
                }
                this.progress = { done: i + 1, total: pairs.length };
                this.emit('posts.trackProgress', { jobId, done: i + 1, total: pairs.length });
            }
          } catch (e) {
            // Lỗi ngoài từng cặp (ví dụ sleep bị từ chối): ghi nhận, không để promise nền bị từ chối.
            errors.push({ groupUrl: '', profileId: '', error: e instanceof Error ? e.message : String(e) });
          }
        } finally {
            const cancelled = this.cancelled;
            this.last = {
                jobId, auto, finishedAt: this.now(), cancelled, groups: pairs.length, ...totals, errors,
                ...(shape.value ? { shape: shape.value } : {}),
            };
            this.active = false;
            this.jobId = null;
            this.emit('posts.trackFinished', {
                jobId, auto, cancelled, groups: pairs.length, ...totals, errors: errors.length,
            });
        }
    }

    /** Dòng còn theo dõi của cặp; dòng quá cửa sổ 14 ngày không đọc nữa mà làm nguội để không đến hạn mãi (spec 4.5). */
    private freshRows(pair: TrackPair, sinceMs: number, totals: Counters): PostTrackingRow[] {
        const all = this.deps.store.listTrackingForPair(pair.profileId, pair.groupUrl, sinceMs, pair.pageId)
            .filter((r) => r.linkStatus !== 'not_found');
        const staleBefore = this.now() - MAX_TRACK_SINCE_DAYS * DAY_MS;
        this.settleUnread(all.filter((r) => r.postedAt < staleBefore && this.isDue(r)), totals);
        return all.filter((r) => r.postedAt >= staleBefore);
    }

    private taskContext(): ProfileTaskContext {
        return { jobId: this.jobId!, signal: this.abort.signal, priority: 'background', assertCurrent: () => { this.deps.assertCurrent?.(); } };
    }

    private async trackPair(pair: TrackPair, sinceMs: number, totals: Counters, shape: { value?: string[] }): Promise<void> {
        if (pair.pageId !== undefined) return this.trackPagePair(pair, pair.pageId, sinceMs, totals);
        const rows = this.freshRows(pair, sinceMs, totals);
        if (rows.length === 0) return;
        this.openedBrowser = true;
        const opened = await this.deps.openSession(pair.profileId, this.taskContext());
        try {
            this.deps.assertCurrent?.();
            if (this.cancelled) return;
            const reading = await this.readFeed(opened.session, pair, rows, shape);
            this.applyReading(rows, reading, totals);
        } finally {
            await opened.close().catch(() => undefined);
        }
    }

    private isDue(row: PostTrackingRow): boolean {
        return row.nextCheckAt !== null && row.nextCheckAt <= this.now();
    }

    /** Cặp lỗi: các dòng đến hạn được lên lịch như một lần kiểm tra không đọc được gì, để không bị chọn lại ở nhịp sau. */
    private backOffPair(pair: TrackPair, totals: Counters): void {
        try {
            const rows = this.deps.store.listTrackingForPair(pair.profileId, pair.groupUrl, 0, pair.pageId)
                .filter((r) => r.linkStatus !== 'not_found' && this.isDue(r));
            this.settleUnread(rows, totals);
        } catch { /* lên lịch lại không được làm hỏng lượt theo dõi */ }
    }

    /** Lần kiểm tra không đọc được gì: hết mốc lấy link thì not_found, mốc đo đã qua coi như xong, rồi sang mốc tương lai hoặc NULL. */
    private settleUnread(rows: PostTrackingRow[], totals: Counters): void {
        const config = this.deps.getConfig?.() ?? DEFAULT_POST_TRACKING_CONFIG;
        const now = this.now();
        for (const row of rows) {
            const patch: Partial<PostTrackingRow> = {};
            if (row.linkStatus !== 'known' && linkRetryExhausted(row, config, now)) {
                patch.linkStatus = 'not_found';
                totals.notFound++;
            } else if (row.linkStatus === 'known') {
                patch.statsDone = markOverdueStatsDone(row, config, now);
            }
            this.deps.store.updateTracking(row.resultId, {
                ...patch, nextCheckAt: computeNextCheckAt({ ...row, ...patch }, config, now),
            });
        }
    }

    /** Đọc bảng tin nhóm từ mới đến cũ cho tới khi gặp một điều kiện dừng (spec 4.2). */
    private async readFeed(
        session: TrackSession, pair: TrackPair, rows: PostTrackingRow[], shape: { value?: string[] },
    ): Promise<PairReading> {
        await session.open();
        const userId = session.userId();
        const prepared = await prepareGroupFeed(session, pair.groupUrl, TRACK_PAGE_COUNT);
        if (isUnresolved(prepared)) throw new Error('unresolved');
        const state = { query: prepared.query, recapture: prepared.recapture };
        const parse = (text: string) => parseGroupFeed(text, { groupId: prepared.groupId });
        const threshold = Math.min(...rows.map((r) => r.postedAt)) - STOP_MARGIN_MS;
        const items: PairReading['items'] = [];
        const seen = new Set<string>();
        let oldest: number | null = null;
        let cursor: string | null = null;
        let emptyStreak = 0;
        for (let pages = 1; ; pages++) {
            if (cursor !== null) seen.add(cursor);
            const { res, text } = await fetchGraphqlPage(session, state, prepared.buildVars, parse, cursor);
            if (pages === 1 && res.items.length === 0 && !shape.value) {
                try { shape.value = describeShape(parseGraphqlChunks(text), SHAPE_DEPTH); } catch { /* chẩn đoán không bắt buộc */ }
            }
            if (res.errorCode && pages === 1) throw new ResearchError(res.errorCode, `Facebook báo ${res.errorCode}.`);
            for (const item of res.items) {
                items.push(item);
                if (item.postedAt !== null && item.postedAt !== undefined && (oldest === null || item.postedAt < oldest)) oldest = item.postedAt;
            }
            emptyStreak = res.items.length === 0 ? emptyStreak + 1 : 0;
            const next = res.endCursor;
            if ((oldest !== null && oldest < threshold) || next === null || seen.has(next) || next === cursor
                || emptyStreak >= MAX_EMPTY_PAGES || pages >= MAX_TRACK_PAGES_PER_GROUP || res.errorCode || this.cancelled) break;
            await this.pause(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS);
            if (this.cancelled) break;
            cursor = next;
        }
        return { items, oldest, groupId: prepared.groupId, userId };
    }

    /** Cặp (profile, Page): đọc Page một lần qua hàng chờ profile, ghi người theo dõi, đối chiếu bài (spec page-publish-proof-metrics 4.4). */
    private async trackPagePair(pair: TrackPair, pageId: string, sinceMs: number, totals: Counters): Promise<void> {
        // Chưa biết Page (hoặc không có bộ đọc): không mở trình duyệt, chỉ lên lịch lại theo mốc như lần đọc lỗi.
        if (pageId === '' || !this.deps.readPage) return this.backOffPair(pair, totals);
        const rows = this.freshRows(pair, sinceMs, totals);
        if (rows.length === 0) return;
        this.openedBrowser = true;
        const read = await this.deps.readPage(pair.profileId, this.taskContext());
        this.deps.assertCurrent?.();
        if (this.cancelled) return;
        if (read.kind !== 'page' || read.pageId !== pageId) throw new Error('page_mismatch');
        const now = this.now();
        const today = (this.deps.localDate ?? systemClock.date)(now);
        // Chỉ số đã xác minh mới được ghi; null/thiếu thì không ghi dòng nào.
        if (typeof read.followers === 'number' && Number.isFinite(read.followers)) {
            try {
                if (!this.deps.store.hasPageFollowersOn(pageId, today)) {
                    this.deps.store.recordPageFollowers({ pageId, profileId: pair.profileId, capturedOn: today, capturedAt: now, followers: read.followers, followersText: read.followersText ?? '', approximate: read.followersApproximate === true });
                }
            } catch (err) {
                // Ghi người theo dõi lỗi không được làm mất số liệu bài của cùng lượt đọc.
                Logger.warn(`[PostTracker] không ghi được người theo dõi Page ${pageId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const config = this.deps.getConfig?.() ?? DEFAULT_POST_TRACKING_CONFIG;
        const hits = matchPagePosts(rows, read.recentPosts);
        for (const row of rows) {
            totals.checked++;
            const hit = hits.get(row.resultId);
            let patch: Partial<PostTrackingRow> = {};
            if (hit) {
                const url = `https://www.facebook.com/${pageId}/posts/${hit.postId}`;
                patch = this.foundPatch(row, { fbId: hit.postId, url, reactions: hit.reactions, comments: hit.comments, shares: hit.shares }, '', config, now, totals);
            } else if (row.linkStatus === 'known') {
                // Trôi khỏi 10 bài gần nhất: mốc đó không có dữ liệu, không kết luận bài bị xóa (spec mục 5).
                patch.statsDone = markOverdueStatsDone(row, config, now);
            } else if (linkRetryExhausted(row, config, now)) {
                totals.notFound++;
                patch.linkStatus = 'not_found';
            }
            const merged: PostTrackingRow = { ...row, ...patch, lastCheckedAt: now };
            merged.nextCheckAt = computeNextCheckAt(merged, config, now);
            this.deps.store.updateTracking(row.resultId, { ...patch, lastCheckedAt: now, nextCheckAt: merged.nextCheckAt });
            if (hit && row.linkStatus !== 'known') {
                try { this.deps.onPagePostKnown?.(merged); } catch { /* người nhận lỗi không được làm hỏng lượt theo dõi */ }
            }
        }
    }

    /** Đối chiếu từng dòng với các mục đã đọc (spec 4.3) rồi ghi kết quả. */
    private applyReading(rows: PostTrackingRow[], reading: PairReading, totals: Counters): void {
        const config = this.deps.getConfig?.() ?? DEFAULT_POST_TRACKING_CONFIG;
        const now = this.now();
        const claimed = new Set<string>();
        const byId = new Map(reading.items.map((it) => [it.fbId, it]));
        const hits = new Map<number, ParsedItem>();
        // Bài đã có post_id khớp theo mã trước, để bài chưa có link không giành nhầm mục đó.
        for (const row of rows) {
            if (row.postId === '') continue;
            const hit = byId.get(row.postId);
            if (hit) { hits.set(row.resultId, hit); claimed.add(hit.fbId); }
        }
        for (const row of rows) {
            if (hits.has(row.resultId) || (row.postId !== '' && row.linkStatus === 'known')) continue;
            const free = reading.items.filter((it) => !claimed.has(it.fbId));
            const hit = pickBestMatch(row, free, reading.userId);
            if (hit) { hits.set(row.resultId, hit); claimed.add(hit.fbId); }
        }
        for (const row of rows) {
            totals.checked++;
            const hit = hits.get(row.resultId);
            const patch = hit ? this.foundPatch(row, hit, reading.groupId, config, now, totals)
                : this.missPatch(row, reading.oldest !== null && reading.oldest < row.postedAt, config, now, totals);
            // Đã kiểm tra mà không thấy: mốc đo đã qua coi như xong để lần sau sang mốc tương lai (không kết luận gì thêm).
            if (!hit && row.linkStatus === 'known') patch.statsDone = markOverdueStatsDone(row, config, now);
            const merged: PostTrackingRow = { ...row, ...patch, lastCheckedAt: now };
            this.deps.store.updateTracking(row.resultId, {
                ...patch, lastCheckedAt: now, nextCheckAt: computeNextCheckAt(merged, config, now),
            });
            // Vừa gắn được link cho bài chờ duyệt / thiếu link: bắt đầu lịch thu bình luận nếu chưa có.
            if (hit && row.linkStatus !== 'known' && row.nextCommentAt === null && row.commentsDone.length === 0) {
                this.deps.store.updateCommentSchedule(row.resultId, {
                    commentsDone: [],
                    nextCommentAt: computeNextCommentAt(row.postedAt, [], this.deps.getLeadConfig?.() ?? DEFAULT_LEAD_CONFIG, now),
                });
            }
        }
    }

    private foundPatch(
        row: PostTrackingRow, item: Pick<ParsedItem, 'fbId' | 'url' | 'reactions' | 'comments' | 'shares'>, groupId: string, config: PostTrackingConfig, now: number, totals: Counters,
    ): Partial<PostTrackingRow> {
        totals.found++;
        if (row.linkStatus !== 'known') totals.linked++;
        this.deps.store.addPostStats(row.resultId, {
            capturedAt: now, reactions: item.reactions ?? null, comments: item.comments ?? null, shares: item.shares ?? null,
        });
        // Một lần đo tính cho mọi mốc đã đến hạn (spec 4.5 + phán quyết của Task 1).
        const done = markOverdueStatsDone(row, config, now);
        return {
            postId: item.fbId, postUrl: row.postUrl ?? (item.url || null), groupId: row.groupId || groupId,
            linkStatus: 'known', lastSeenAt: now, checkCount: 0, removedSuspected: false, statsDone: done,
        };
    }

    /** Không thấy: chỉ kết luận khi đã đọc qua mốc thời gian đăng của bài (spec 4.3.4 và 4.3.5). */
    private missPatch(
        row: PostTrackingRow, readPast: boolean, config: PostTrackingConfig, now: number, totals: Counters,
    ): Partial<PostTrackingRow> {
        const pending = row.linkStatus !== 'known';
        // Qua mốc cuối thì bỏ cuộc dù bảng tin dừng sớm (spec 4.5), tránh dòng "missing" treo vĩnh viễn.
        if (pending && linkRetryExhausted(row, config, now)) {
            totals.notFound++;
            return { checkCount: readPast ? row.checkCount + 1 : row.checkCount, linkStatus: 'not_found' };
        }
        if (!readPast) return {};
        if (!pending) {
            if (row.lastSeenAt === null || row.removedSuspected) return {};
            totals.removedSuspected++;
            return { removedSuspected: true };
        }
        return { checkCount: row.checkCount + 1 };
    }
}
