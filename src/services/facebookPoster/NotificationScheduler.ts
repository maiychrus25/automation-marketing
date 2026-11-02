import type { FbPosterLead, TrackTargetKind } from '../../models/facebookPoster';
import { engagementOf, type FacebookPosterStore } from './FacebookPosterStore';
import { buildLeadsFoundPayload } from './LeadDetector';
import { parseFollowerCount } from '../dailyBrief/pageFollowers';
import type { AutonomySummary } from '../autonomy/AutonomyLimiter';
import { buildLeadsDigest } from '../control/controlEvents';
import {
    LEAD_DIGEST_BUSY_ERROR, LEAD_DIGEST_CURSOR_SETTING_KEY, NOTIFICATION_TICK_MS, REPORT_PERIOD_SETTING_KEY,
    clockLabel, latestReportPeriod, type LeadCursor, type NotificationConfig, type ReportPeriod,
} from './notificationRules';

// Báo cáo 📊 theo kỳ và gom 🎯 khách tiềm năng thành sự kiện Control API (bridge định dạng tin). Spec mục 5, 6.
// Chống spam: mỗi kỳ đúng một `metrics.report` (khóa kỳ lưu bền), tắt app qua giờ gửi thì bù đúng một tin cho kỳ gần nhất,
// bật lần đầu / đổi lịch thì chỉ ghi kỳ hiện tại; mỗi khoảng gom một `leads.digest`, con trỏ lead chỉ dời cùng giao dịch
// với lần ghi sự kiện nên khởi động lại hay ghi lỗi không làm mất hay trùng lead.

export interface MetricsReportPayload {
    cadence: 'daily' | 'weekly';
    periodKey: string;
    from: number;
    to: number;
    /** `dd/MM–dd/MM` theo giờ địa phương. */
    label: string;
    posts: number;
    /** Số bài có số liệu đo thật (lần đo mới nhất có ít nhất một số). */
    measured: number;
    /** Tổng tương tác của các bài đã đo; null khi chưa bài nào đo được (không ghi 0 giả). */
    engagement: number | null;
    notFound: number;
    top: { resultId: number; targetKind: TrackTargetKind; text: string; postUrl: string | null; engagement: number }[];
    /** `current`/`change` null nghĩa là chưa đủ dữ liệu. */
    followers: { pageId: string; pageName: string; current: number | null; change: number | null; approximate: boolean }[];
    /** Việc bot tự làm trong kỳ; bỏ trường khi không có hoạt động tự vận hành. */
    autonomy?: AutonomySummary;
    /** Gợi ý bình luận trong kỳ; bỏ trường khi toàn 0. (`engagement` đã là tổng tương tác.) */
    commentSuggestions?: { suggested: number; approved: number; posted: number; rejected: number; expired: number };
}

export interface NotificationSchedulerDeps {
    now(): number;
    timeZone(): string;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    readConfig(): NotificationConfig;
    readSetting(key: string): string | null;
    writeSetting(key: string, value: string): void;
    atomically<T>(fn: () => T): T;
    /** True khi Control API đang ghi sự kiện cho workspace này. */
    canPublish(): boolean;
    /** True khi có lượt thu bình luận (tự động hoặc tay) đang chạy: lead của lượt chỉ được phát `leads.found` lúc lượt xong. */
    isCollecting(): boolean;
    /** Ném khi không ghi được; khi đó trạng thái giữ nguyên để lần sau thử lại. */
    publish(type: 'metrics.report' | 'leads.digest', payload: unknown): void;
    buildReport(period: ReportPeriod, cadence: 'daily' | 'weekly'): MetricsReportPayload;
    leadsAfter(cursor: LeadCursor): FbPosterLead[];
    latestLeadCursor(): LeadCursor | null;
    log(msg: string): void;
}

const TOP_POSTS = 3;
const REPORT_ROWS_LIMIT = 5000;

type ReportState = { key: string; rule: string };
type CursorState = LeadCursor & { minutes: number };

// Thứ chỉ thuộc lịch tuần: đổi thứ khi đang gửi hằng ngày không phải đổi lịch.
const ruleOf = (c: NotificationConfig) => (c.reportCadence === 'off' ? 'off'
    : c.reportCadence === 'daily' ? `daily:${c.reportHour}` : `weekly:${c.reportHour}:${c.reportWeekday}`);

function parseJson<T>(raw: string | null, valid: (v: any) => boolean): T | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && valid(v) ? v as T : null;
    } catch { return null; }
}

const parseCursor = (raw: string | null) => parseJson<CursorState>(raw, (v) => Number.isFinite(v.at) && Number.isFinite(v.id));

/**
 * `leads.found` được đánh dấu `deferred` (bridge im, chờ `leads.digest`) chỉ khi đang gom và con trỏ đã khởi tạo; trước đó
 * lead được gửi ngay như cũ, vì lần khởi tạo con trỏ sẽ coi mọi lead đã có là đã báo.
 */
export function isDeferringLeads(config: NotificationConfig, cursorRaw: string | null): boolean {
    return config.leadDigestMinutes > 0 && parseCursor(cursorRaw) !== null;
}

export class NotificationScheduler {
    private timer: unknown = null;
    private stopped = true;

    constructor(private readonly deps: NotificationSchedulerDeps) {}

    start(): void {
        this.stopped = false;
        this.arm();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) this.deps.clearTimer(this.timer);
        this.timer = null;
    }

    /** Một chu kỳ kiểm tra. Không bao giờ ném lỗi; lỗi báo cáo không chặn gom tin và ngược lại. */
    tickNow(): void {
        const { canPublish, readConfig, log } = this.deps;
        let config: NotificationConfig;
        try {
            if (!canPublish()) return;
            config = readConfig();
        } catch (err) {
            log(`[NotificationScheduler] đọc cấu hình lỗi: ${errorText(err)}`);
            return;
        }
        try { this.tickReport(config); } catch (err) { log(`[NotificationScheduler] báo cáo định kỳ lỗi: ${errorText(err)}`); }
        try { this.tickLeads(config); } catch (err) { log(`[NotificationScheduler] gom khách tiềm năng lỗi: ${errorText(err)}`); }
    }

    private tickReport(config: NotificationConfig): void {
        const { now, timeZone, readSetting, writeSetting, atomically, publish, buildReport } = this.deps;
        const state = parseJson<ReportState>(readSetting(REPORT_PERIOD_SETTING_KEY), (v) => typeof v.key === 'string' && typeof v.rule === 'string');
        const rule = ruleOf(config);
        const period = latestReportPeriod(config, now(), timeZone());
        const save = (key: string) => writeSetting(REPORT_PERIOD_SETTING_KEY, JSON.stringify({ key, rule }));
        if (!period) {
            if (state?.rule !== 'off') save('');
            return;
        }
        // Lần đầu, sau khi bật lại hoặc đổi lịch: ghi kỳ hiện tại, không gửi.
        if (!state || state.rule !== rule) { save(period.key); return; }
        // Cùng lịch nên khoá so được theo thứ tự ngày: đồng hồ bị lùi không gửi lại kỳ đã gửi.
        if (period.key <= state.key) return;
        const cadence = config.reportCadence as 'daily' | 'weekly';
        atomically(() => {
            publish('metrics.report', buildReport(period, cadence));
            save(period.key);
        });
    }

    private tickLeads(config: NotificationConfig): void {
        const { now, readSetting, leadsAfter, latestLeadCursor, isCollecting } = this.deps;
        const minutes = config.leadDigestMinutes;
        const state = parseCursor(readSetting(LEAD_DIGEST_CURSOR_SETTING_KEY));
        if (!state) {
            // Lead đã có coi như đã báo bằng leads.found (gửi ngay khi chưa có con trỏ); lượt thu đang chạy thì chờ nó phát xong.
            // Bảng trống thì mọi lead sau đều chưa báo.
            if (!isCollecting()) this.saveCursor(latestLeadCursor() ?? { at: 0, id: 0 }, minutes);
            return;
        }
        const pending = leadsAfter({ at: state.at, id: state.id });
        if (pending.length === 0) {
            if (state.minutes !== minutes) this.saveCursor(state, minutes);
            return;
        }
        // Gửi ngay: lead đã đi bằng leads.found. Riêng lead bị hoãn khi còn khoảng gom cũ thì gửi gộp một lần.
        if (minutes === 0 && !(state.minutes > 0)) { this.saveCursor(pending[pending.length - 1], minutes); return; }
        if (minutes > 0 && now() < pending[0].detectedAt + minutes * 60_000) return;
        this.flushDigest(pending, minutes);
    }

    /**
     * Đổi khoảng gom đồng bộ, gọi trong cùng giao dịch với lần lưu `leadDigestMinutes` mới (`notificationOperations.setConfig`).
     * Có lượt thu bình luận đang chạy thì ném `LEAD_DIGEST_BUSY_ERROR` (lead của lượt chỉ được phát lúc lượt xong).
     * 0 → N: con trỏ dời tới lead mới nhất (đã gửi ngay); N → M: chỉ đổi khoảng; N → 0: gửi gộp ngay mọi lead đang hoãn —
     * riêng nhánh này cần Control API đang ghi sự kiện, không có thì giữ con trỏ để nhịp kiểm tra gửi khi có lại.
     * Chưa có con trỏ thì không làm gì (nhịp kiểm tra sẽ khởi tạo). Ghi sự kiện lỗi thì ném, con trỏ giữ nguyên.
     */
    applyLeadDigestChange(next: NotificationConfig['leadDigestMinutes']): void {
        const { readSetting, canPublish, isCollecting, latestLeadCursor, leadsAfter } = this.deps;
        if (isCollecting()) throw new Error(LEAD_DIGEST_BUSY_ERROR);
        const state = parseCursor(readSetting(LEAD_DIGEST_CURSOR_SETTING_KEY));
        if (!state || state.minutes === next) return;
        if (state.minutes === 0) { this.saveCursor(latestLeadCursor() ?? state, next); return; }
        const pending = next === 0 ? leadsAfter({ at: state.at, id: state.id }) : [];
        if (!pending.length) this.saveCursor(state, next);
        else if (canPublish()) this.flushDigest(pending, next);
    }

    private flushDigest(pending: FbPosterLead[], minutes: number): void {
        const { now, timeZone, atomically, publish } = this.deps;
        const from = pending[0].detectedAt;
        const t = now();
        atomically(() => {
            publish('leads.digest', buildLeadsDigest({ ...buildLeadsFoundPayload(pending, true), from, to: t, label: clockLabel(from, t, timeZone()) }));
            this.saveCursor(pending[pending.length - 1], minutes);
        });
    }

    private saveCursor(c: LeadCursor | FbPosterLead, minutes: number): void {
        const at = 'detectedAt' in c ? c.detectedAt : c.at;
        this.deps.writeSetting(LEAD_DIGEST_CURSOR_SETTING_KEY, JSON.stringify({ at, id: c.id, minutes }));
    }

    private arm(): void {
        this.timer = this.deps.setTimer(() => this.fire(), NOTIFICATION_TICK_MS);
    }

    private fire(): void {
        if (this.stopped) return;
        this.timer = null;
        this.tickNow();
        if (!this.stopped) this.arm();
    }
}

/** Tổng hợp một kỳ: mọi bài (nhóm + Page) có `postedAt` trong [from, to); tương tác chỉ từ số đo thật. */
export function buildMetricsReport(
    store: Pick<FacebookPosterStore, 'listTracking' | 'latestStats' | 'listPageFollowers' | 'postTexts' | 'engagementCounts' | 'expireDueEngagement'>,
    period: ReportPeriod, cadence: 'daily' | 'weekly', pageName: (pageId: string) => string,
    autonomySummary?: (from: number, to: number) => AutonomySummary,
): MetricsReportPayload {
    const rows = store.listTracking({ sinceMs: period.from, untilMs: period.to - 1, limit: REPORT_ROWS_LIMIT });
    const latest = new Map(store.latestStats(rows.map((r) => r.resultId)).map((s) => [s.resultId, s]));
    const measured: { row: typeof rows[number]; engagement: number }[] = [];
    for (const row of rows) {
        const s = latest.get(row.resultId);
        if (!s || (s.reactions === null && s.comments === null && s.shares === null)) continue;
        measured.push({ row, engagement: engagementOf(s) });
    }
    const top = [...measured].sort((a, b) => b.engagement - a.engagement || b.row.postedAt - a.row.postedAt).slice(0, TOP_POSTS)
        .map(({ row, engagement }) => ({ resultId: row.resultId, targetKind: row.targetKind, text: row.textHead, postUrl: row.postUrl, engagement }));
    // Nội dung gốc (tham số lượt) thay cho đầu bài đã chuẩn hoá chữ thường khi lượt còn trong DB.
    const texts = store.postTexts(rows.filter((r) => top.some((t) => t.resultId === r.resultId)));
    for (const t of top) t.text = (texts.get(t.resultId) ?? t.text).slice(0, 100);

    // Người theo dõi: hiện tại = mốc cuối trước `to`; thay đổi chỉ khi có cả mốc trong kỳ và mốc cuối trước `from`, thiếu thì null.
        type Entry = { current: number | null; currentAt: number; base: number | null; approximate: boolean; step: number; baseStep: number };
    const pages = new Map<string, Entry>();
    const entryOf = (pageId: string): Entry => pages.get(pageId) ?? { current: null, currentAt: 0, base: null, approximate: false, step: 1, baseStep: 1 };
    for (const row of rows) if (row.targetKind === 'page' && row.pageId) pages.set(row.pageId, entryOf(row.pageId));
    for (const f of store.listPageFollowers({ sinceDay: '' })) {
        if (f.capturedAt >= period.to) continue;
        const entry = entryOf(f.pageId);
        entry.current = f.followers; // sắp theo ngày tăng dần nên dòng sau ghi đè
        entry.currentAt = f.capturedAt;
        entry.approximate = f.approximate === true;
        // Bước làm tròn của dòng; dòng chính xác = 1.
        const step = (f.approximate === true && f.followersText ? parseFollowerCount(f.followersText)?.step : 1) ?? 1;
        entry.step = step;
        if (f.capturedAt < period.from) { entry.base = f.followers; entry.baseStep = step; }
        pages.set(f.pageId, entry);
    }
    const followers = [...pages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pageId, { current, currentAt, base, approximate, step, baseStep }]) => {
        let change = current !== null && base !== null && currentAt >= period.from ? current - base : null;
        // Ít nhất một đầu làm tròn: đổi nhỏ hơn bước lớn hơn của hai đầu coi như không đổi.
        if (change !== null && Math.abs(change) < Math.max(step, baseStep)) change = 0;
        return { pageId, pageName: pageName(pageId), current, change, approximate };
    });

    // `to` là mốc loại trừ còn summary tính cả hai đầu.
    const summary = autonomySummary?.(period.from, period.to - 1);
    const autonomy = summary && Object.values(summary).some((n) => n > 0) ? summary : undefined;
    // Gợi ý chỉ chuyển `expired` khi có lần đọc hàng chờ; quét trước để số hết hạn đúng. `to` là mốc gửi đã qua nên không hết hạn sớm.
    store.expireDueEngagement(period.to);
    const counts = store.engagementCounts(period.from, period.to);
    const commentSuggestions = Object.values(counts).some((n) => n > 0) ? counts : undefined;
    return {
        cadence, periodKey: period.key, from: period.from, to: period.to, label: period.label,
        posts: rows.length, measured: measured.length,
        engagement: measured.length ? measured.reduce((sum, m) => sum + m.engagement, 0) : null,
        notFound: rows.filter((r) => r.linkStatus === 'not_found').length,
        top, followers,
        ...(autonomy ? { autonomy } : {}),
        ...(commentSuggestions ? { commentSuggestions } : {}),
    };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
