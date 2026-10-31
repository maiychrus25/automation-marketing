import { memoryDb } from './helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { NotificationScheduler, buildMetricsReport, isDeferringLeads, type NotificationSchedulerDeps } from '../../services/facebookPoster/NotificationScheduler';
import {
    DEFAULT_NOTIFICATION_CONFIG, LEAD_DIGEST_CURSOR_SETTING_KEY, NOTIFICATION_TICK_MS, REPORT_PERIOD_SETTING_KEY,
    LEAD_DIGEST_BUSY_ERROR, clockLabel, latestReportPeriod, type LeadCursor, type NotificationConfig,
} from '../../services/facebookPoster/notificationRules';
import { BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import type { FbPosterLead } from '../../models/facebookPoster';

const NY = 'America/New_York';
const MIN = 60_000;
// Mondays 08:00 in New York: before (EDT, UTC-4) and after (EST, UTC-5) the 2026-11-01 DST end.
const MON_OCT_12 = Date.UTC(2026, 9, 12, 12, 0);
const MON_OCT_26 = Date.UTC(2026, 9, 26, 12, 0);
const MON_NOV_02 = Date.UTC(2026, 10, 2, 13, 0);
const MON_NOV_09 = Date.UTC(2026, 10, 9, 13, 0);

function lead(id: number, detectedAt: number, over: Partial<FbPosterLead> = {}): FbPosterLead {
    return { id, detectedAt, authorName: `Khách ${id}`, text: `ib giá ${id}`, postUrl: `https://www.facebook.com/p/${id}`, campaignId: null, ...over } as FbPosterLead;
}

function harness(init: { now: number; config?: Partial<NotificationConfig>; settings?: Map<string, string>; leads?: FbPosterLead[] }) {
    const h = {
        now: init.now,
        config: { ...DEFAULT_NOTIFICATION_CONFIG, ...init.config } as NotificationConfig,
        settings: init.settings ?? new Map<string, string>(),
        leads: init.leads ?? [] as FbPosterLead[],
        published: [] as { type: string; payload: any }[],
        logs: [] as string[],
        sink: true,
        collecting: false,
        failPublish: false,
        timers: [] as number[],
    };
    const deps: NotificationSchedulerDeps = {
        now: () => h.now,
        timeZone: () => NY,
        setTimer: (_fn, ms) => { h.timers.push(ms); return h.timers.length; },
        clearTimer: () => undefined,
        readConfig: () => h.config,
        readSetting: (k) => h.settings.get(k) ?? null,
        writeSetting: (k, v) => { h.settings.set(k, v); },
        atomically: (fn) => {
            const snapshot = new Map(h.settings);
            try { return fn(); } catch (err) { h.settings.clear(); snapshot.forEach((v, k) => h.settings.set(k, v)); throw err; }
        },
        canPublish: () => h.sink,
        isCollecting: () => h.collecting,
        publish: (type, payload) => {
            if (h.failPublish) throw new Error('sink down');
            h.published.push({ type, payload });
        },
        buildReport: (period, cadence) => ({ cadence, periodKey: period.key, from: period.from, to: period.to, label: period.label,
            posts: 0, measured: 0, engagement: null, notFound: 0, top: [], followers: [] }),
        leadsAfter: (c: LeadCursor) => h.leads.filter((l) => l.detectedAt > c.at || (l.detectedAt === c.at && l.id > c.id))
            .sort((a, b) => a.detectedAt - b.detectedAt || a.id - b.id),
        latestLeadCursor: () => {
            const last = [...h.leads].sort((a, b) => a.detectedAt - b.detectedAt || a.id - b.id).pop();
            return last ? { at: last.detectedAt, id: last.id } : null;
        },
        log: (m) => { h.logs.push(m); },
    };
    const make = () => new NotificationScheduler(deps);
    return { h, deps, make, reports: () => h.published.filter((p) => p.type === 'metrics.report'), digests: () => h.published.filter((p) => p.type === 'leads.digest') };
}

describe('NotificationScheduler — metrics.report', () => {
    test('firstRunInitializesWithoutSending', () => {
        const { h, make } = harness({ now: MON_NOV_02, leads: [lead(1, MON_NOV_02 - 5 * MIN)] });
        make().tickNow();
        expect(h.published).toEqual([]);
        expect(JSON.parse(h.settings.get(REPORT_PERIOD_SETTING_KEY)!)).toMatchObject({ key: 'weekly:2026-11-02' });
        expect(JSON.parse(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!)).toMatchObject({ at: MON_NOV_02 - 5 * MIN, id: 1 });
    });

    test('metricsReportsAreOncePerPeriodAcrossRestart', () => {
        const { h, make, reports } = harness({ now: MON_OCT_26 + 4 * 24 * 60 * MIN });
        const a = make();
        a.tickNow(); // init on weekly:2026-10-26
        expect(reports()).toHaveLength(0);
        h.now = MON_NOV_02 - MIN; // 07:59 EST: not yet due
        a.tickNow();
        expect(reports()).toHaveLength(0);
        h.now = MON_NOV_02;
        a.tickNow();
        expect(reports()).toHaveLength(1);
        expect(reports()[0].payload).toMatchObject({ cadence: 'weekly', periodKey: 'weekly:2026-11-02', from: MON_OCT_26, to: MON_NOV_02 });
        a.tickNow();
        h.now += 30 * MIN;
        a.tickNow();
        make().tickNow(); // restart, same persisted settings
        h.now = MON_NOV_09 - MIN;
        make().tickNow();
        expect(reports()).toHaveLength(1);
        h.now = MON_NOV_09;
        make().tickNow();
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['weekly:2026-11-02', 'weekly:2026-11-09']);
    });

    test('catchUpSendsExactlyOneForLatestPeriod', () => {
        const { h, make, reports } = harness({ now: MON_OCT_12 + 60 * MIN });
        make().tickNow(); // init weekly:2026-10-12, then the app is closed for three weekly send times
        h.now = MON_NOV_02 + 2 * 24 * 60 * MIN;
        const s = make();
        s.tickNow();
        s.tickNow();
        make().tickNow();
        expect(reports()).toHaveLength(1);
        expect(reports()[0].payload.periodKey).toBe('weekly:2026-11-02');
    });

    test('failedPublishLeavesStateForRetry', () => {
        const { h, make, reports } = harness({ now: MON_OCT_26 + 60 * MIN });
        const s = make();
        s.tickNow();
        const before = h.settings.get(REPORT_PERIOD_SETTING_KEY);
        h.now = MON_NOV_02;
        h.failPublish = true;
        s.tickNow();
        expect(h.settings.get(REPORT_PERIOD_SETTING_KEY)).toBe(before);
        expect(h.logs.join('\n')).toMatch(/sink down/);
        h.failPublish = false;
        h.now += MIN;
        s.tickNow();
        s.tickNow();
        expect(reports()).toHaveLength(1);
        expect(reports()[0].payload.periodKey).toBe('weekly:2026-11-02');
    });

    test('offSendsNothing', () => {
        const { h, make, reports } = harness({ now: MON_OCT_12, config: { reportCadence: 'off' } });
        for (let t = MON_OCT_12; t <= MON_NOV_09; t += 24 * 60 * MIN) { h.now = t; make().tickNow(); }
        expect(reports()).toEqual([]);
    });

    test('enabling after off and changing the rule record the current period without sending', () => {
        const { h, make, reports } = harness({ now: MON_OCT_12 + MIN });
        make().tickNow(); // weekly state for 2026-10-12
        h.config = { ...h.config, reportCadence: 'off' };
        h.now = MON_OCT_12 + 2 * MIN;
        make().tickNow();
        h.config = { ...h.config, reportCadence: 'weekly' };
        h.now = MON_NOV_02 + MIN; // re-enabled weeks later: no catch-up for the time it was off
        make().tickNow();
        expect(reports()).toHaveLength(0);
        h.config = { ...h.config, reportCadence: 'daily' }; // rule change: daily:2026-11-02 is recorded, not sent
        h.now += MIN;
        make().tickNow();
        expect(reports()).toHaveLength(0);
        h.config = { ...h.config, reportHour: 9 };
        h.now += MIN;
        make().tickNow();
        expect(reports()).toHaveLength(0);
        h.now = Date.UTC(2026, 10, 3, 14, 0); // Tue 09:00 EST
        make().tickNow();
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['daily:2026-11-03']);
        // Changing only the digest window is not a report rule change.
        h.config = { ...h.config, leadDigestMinutes: 15 };
        h.now = Date.UTC(2026, 10, 4, 14, 0);
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['daily:2026-11-03', 'daily:2026-11-04']);
    });

    test('a clock set back never resends an already-sent period', () => {
        const { h, make, reports } = harness({ now: MON_OCT_26 + MIN });
        make().tickNow();
        h.now = MON_NOV_02;
        make().tickNow();
        h.now = MON_OCT_26 + 2 * 24 * 60 * MIN; // clock moved back into the previous period
        make().tickNow();
        h.now = MON_NOV_02 + MIN;
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['weekly:2026-11-02']);
        h.now = MON_NOV_09;
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['weekly:2026-11-02', 'weekly:2026-11-09']);
    });

    test('changing the weekday while daily keeps the state and the next report', () => {
        const { h, make, reports } = harness({ now: MON_NOV_02 + MIN, config: { reportCadence: 'daily' } });
        make().tickNow(); // daily:2026-11-02 recorded
        h.config = { ...h.config, reportWeekday: 5 };
        h.now = Date.UTC(2026, 10, 3, 13, 0); // Tue 08:00 EST
        make().tickNow();
        expect(reports().map((r) => r.payload.periodKey)).toEqual(['daily:2026-11-03']);
    });

    test('noSinkDoesNothing', () => {
        const { h, make } = harness({ now: MON_NOV_02, leads: [lead(1, MON_NOV_02 - 120 * MIN)] });
        h.sink = false;
        make().tickNow();
        expect(h.settings.size).toBe(0);
        expect(h.published).toEqual([]);
    });

    test('malformed persisted state is re-initialised without sending', () => {
        const settings = new Map([[REPORT_PERIOD_SETTING_KEY, '{oops'], [LEAD_DIGEST_CURSOR_SETTING_KEY, '"x"']]);
        const { h, make } = harness({ now: MON_NOV_02, settings, leads: [lead(1, MON_NOV_02 - 120 * MIN)] });
        make().tickNow();
        expect(h.published).toEqual([]);
        expect(JSON.parse(h.settings.get(REPORT_PERIOD_SETTING_KEY)!).key).toBe('weekly:2026-11-02');
        expect(JSON.parse(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!)).toMatchObject({ at: MON_NOV_02 - 120 * MIN, id: 1 });
    });

    test('start arms a 60 s timer and stop ends it', () => {
        const { h, deps } = harness({ now: MON_NOV_02 });
        let fire: () => void = () => undefined;
        const s = new NotificationScheduler({ ...deps, setTimer: (fn, ms) => { fire = fn; h.timers.push(ms); return 1; } });
        s.start();
        expect(h.timers).toEqual([NOTIFICATION_TICK_MS]);
        fire();
        expect(h.settings.has(REPORT_PERIOD_SETTING_KEY)).toBe(true);
        expect(h.timers).toEqual([NOTIFICATION_TICK_MS, NOTIFICATION_TICK_MS]);
        s.stop();
        h.settings.clear();
        fire();
        expect(h.settings.size).toBe(0);
    });
});

describe('NotificationScheduler — leads.digest', () => {
    const T0 = Date.UTC(2026, 10, 3, 15, 0); // Tue 10:00 EST

    test('leadDigestWaitsForWindowThenSendsOne', () => {
        const { h, make, digests } = harness({ now: T0 - 10 * MIN });
        const s = make();
        s.tickNow(); // empty table → cursor at the very start, nothing sent
        h.leads.push(lead(1, T0), lead(2, T0 + 10 * MIN, { campaignId: 'c1' }), lead(3, T0 + 30 * MIN));
        h.now = T0 + 59 * MIN;
        s.tickNow();
        expect(digests()).toHaveLength(0);
        h.now = T0 + 60 * MIN;
        s.tickNow();
        s.tickNow();
        expect(digests()).toHaveLength(1);
        expect(digests()[0].payload).toEqual({
            count: 3, auto: true, leadIds: [3, 2, 1], campaignIds: ['c1'],
            samples: [3, 2, 1].map((i) => ({ authorName: `Khách ${i}`, text: `ib giá ${i}`, postUrl: `https://www.facebook.com/p/${i}` })),
            from: T0, to: T0 + 60 * MIN, label: clockLabel(T0, T0 + 60 * MIN, NY),
        });
        expect(digests()[0].payload.label).toBe('10:00–11:00');
        h.leads.push(lead(4, T0 + 70 * MIN));
        h.now = T0 + 129 * MIN;
        s.tickNow();
        expect(digests()).toHaveLength(1);
        h.now = T0 + 130 * MIN;
        s.tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[3, 2, 1], [4]]);
    });

    test('digestSurvivesRestartWithoutLossOrDuplicate', () => {
        const { h, make, digests } = harness({ now: T0 - MIN, leads: [lead(1, T0 - 2 * MIN)] });
        make().tickNow(); // cursor after lead 1 (already reported before digests existed)
        h.leads.push(lead(2, T0), lead(3, T0 + 5 * MIN));
        h.now = T0 + 30 * MIN;
        make().tickNow();
        h.leads.push(lead(4, T0 + 40 * MIN));
        h.now = T0 + 60 * MIN;
        h.failPublish = true;
        make().tickNow(); // restart + failed publish: cursor stays
        h.failPublish = false;
        h.now += MIN;
        make().tickNow();
        make().tickNow();
        expect(digests()).toHaveLength(1);
        expect(digests()[0].payload).toMatchObject({ count: 3, leadIds: [4, 3, 2], from: T0 });
    });

    test('a lead stamped just before the cursor was initialised on an empty table is not lost', () => {
        const { h, make, digests } = harness({ now: T0 });
        make().tickNow();
        h.leads.push(lead(1, T0 - 1000)); // collect run stamped it before the tick, committed after
        h.now = T0 + 60 * MIN;
        make().tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[1]]);
    });

    test('the lead cursor is not initialised while a comment collect is running', () => {
        const { h, make, digests } = harness({ now: T0 - 30 * MIN, leads: [lead(1, T0 - 60 * MIN)] });
        h.collecting = true;
        h.leads.push(lead(2, T0 - 20 * MIN)); // inserted mid-run; leads.found for it comes at the end of the run
        make().tickNow();
        expect(h.settings.has(LEAD_DIGEST_CURSOR_SETTING_KEY)).toBe(false);
        expect(isDeferringLeads(h.config, h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY) ?? null)).toBe(false); // so it is sent immediately
        h.collecting = false;
        make().tickNow();
        expect(JSON.parse(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!)).toMatchObject({ at: T0 - 20 * MIN, id: 2 });
        expect(isDeferringLeads(h.config, h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!)).toBe(true);
        h.now = T0 + 300 * MIN;
        make().tickNow();
        expect(digests()).toHaveLength(0);
    });

    test('isDeferringLeads needs a digest window and an initialised cursor', () => {
        const cursor = JSON.stringify({ at: 1, id: 1, minutes: 60 });
        expect(isDeferringLeads(DEFAULT_NOTIFICATION_CONFIG, cursor)).toBe(true);
        expect(isDeferringLeads(DEFAULT_NOTIFICATION_CONFIG, null)).toBe(false);
        expect(isDeferringLeads(DEFAULT_NOTIFICATION_CONFIG, '{bad')).toBe(false);
        expect(isDeferringLeads({ ...DEFAULT_NOTIFICATION_CONFIG, leadDigestMinutes: 0 }, cursor)).toBe(false);
    });

    test('same-millisecond leads are ordered by id and none is skipped', () => {
        const { h, make, digests } = harness({ now: T0 - MIN, leads: [lead(1, T0)] });
        make().tickNow();
        h.leads.push(lead(2, T0), lead(3, T0));
        h.now = T0 + 60 * MIN;
        make().tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[3, 2]]);
    });

    test('zeroMinutesAdvancesCursorWithoutDigest', () => {
        const { h, make, digests } = harness({ now: T0 - MIN, config: { leadDigestMinutes: 0 } });
        make().tickNow();
        h.leads.push(lead(1, T0), lead(2, T0 + MIN));
        h.now = T0 + 2 * MIN;
        make().tickNow();
        expect(digests()).toHaveLength(0);
        expect(JSON.parse(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!)).toMatchObject({ at: T0 + MIN, id: 2 });
        h.config = { ...h.config, leadDigestMinutes: 60 }; // leads already sent immediately are not re-sent as a digest
        h.now = T0 + 300 * MIN;
        make().tickNow();
        expect(digests()).toHaveLength(0);
    });

    test('switching to immediate flushes leads deferred under the old window exactly once', () => {
        const { h, make, digests } = harness({ now: T0 - MIN });
        make().tickNow();
        h.leads.push(lead(1, T0));
        h.now = T0 + 10 * MIN;
        make().tickNow();
        h.config = { ...h.config, leadDigestMinutes: 0 };
        h.now = T0 + 11 * MIN;
        make().tickNow();
        make().tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[1]]);
        h.leads.push(lead(2, T0 + 12 * MIN)); // immediate mode: sent by leads.found, never by a digest
        h.now = T0 + 200 * MIN;
        make().tickNow();
        expect(digests()).toHaveLength(1);
    });

    test('no sink keeps leads pending and delivers them once the sink is back', () => {
        const { h, make, digests } = harness({ now: T0 - MIN });
        make().tickNow();
        h.leads.push(lead(1, T0));
        h.sink = false;
        h.now = T0 + 90 * MIN;
        make().tickNow();
        expect(digests()).toHaveLength(0);
        h.sink = true;
        make().tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[1]]);
    });

    test('a failing report does not block the digest and vice versa', () => {
        const { h, deps, digests } = harness({ now: MON_OCT_26 + MIN });
        const s = new NotificationScheduler({ ...deps, buildReport: () => { throw new Error('report boom'); } });
        s.tickNow();
        h.leads.push(lead(1, MON_NOV_02 - 61 * MIN));
        h.now = MON_NOV_02;
        s.tickNow();
        expect(digests()).toHaveLength(1);
        expect(h.logs.join('\n')).toMatch(/report boom/);
    });
});

describe('NotificationScheduler.applyLeadDigestChange', () => {
    const T0 = Date.UTC(2026, 10, 3, 15, 0);
    const cursorOf = (h: { settings: Map<string, string> }) => JSON.parse(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)!);

    test('0 → N moves the cursor past leads already sent immediately', () => {
        const { h, make, digests } = harness({ now: T0, config: { leadDigestMinutes: 0 } });
        const s = make();
        s.tickNow();
        h.leads.push(lead(1, T0 + MIN), lead(2, T0 + 2 * MIN)); // sent by leads.found, the tick has not advanced yet
        h.now = T0 + 2 * MIN;
        s.applyLeadDigestChange(60);
        h.config = { ...h.config, leadDigestMinutes: 60 };
        expect(cursorOf(h)).toEqual({ at: T0 + 2 * MIN, id: 2, minutes: 60 });
        h.now = T0 + 300 * MIN;
        s.tickNow();
        expect(digests()).toHaveLength(0);
        h.leads.push(lead(3, T0 + 301 * MIN));
        h.now = T0 + 361 * MIN;
        s.tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[3]]);
    });

    test('N → 0 flushes the pending digest once, synchronously', () => {
        const { h, make, digests } = harness({ now: T0 });
        const s = make();
        s.tickNow();
        h.leads.push(lead(1, T0 + MIN), lead(2, T0 + 5 * MIN));
        h.now = T0 + 10 * MIN;
        s.applyLeadDigestChange(0);
        h.config = { ...h.config, leadDigestMinutes: 0 };
        expect(digests().map((d) => d.payload)).toEqual([expect.objectContaining({ leadIds: [2, 1], from: T0 + MIN, to: T0 + 10 * MIN })]);
        expect(cursorOf(h)).toEqual({ at: T0 + 5 * MIN, id: 2, minutes: 0 });
        s.tickNow();
        s.applyLeadDigestChange(0);
        expect(digests()).toHaveLength(1);
    });

    test('N → 0 with nothing pending and N → M only change the stored window', () => {
        const { h, make, digests } = harness({ now: T0, leads: [lead(1, T0 - MIN)] });
        const s = make();
        s.tickNow();
        s.applyLeadDigestChange(0);
        expect(cursorOf(h)).toEqual({ at: T0 - MIN, id: 1, minutes: 0 });
        s.applyLeadDigestChange(15);
        h.leads.push(lead(2, T0 + MIN));
        s.applyLeadDigestChange(30);
        expect(cursorOf(h)).toEqual({ at: T0 - MIN, id: 1, minutes: 30 });
        expect(digests()).toHaveLength(0);
    });

    test('a failed flush throws and leaves the cursor for the caller to retry', () => {
        const { h, make, digests } = harness({ now: T0 });
        const s = make();
        s.tickNow();
        h.leads.push(lead(1, T0 + MIN));
        const before = h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY);
        h.failPublish = true;
        expect(() => s.applyLeadDigestChange(0)).toThrow('sink down');
        expect(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)).toBe(before);
        h.failPublish = false;
        s.applyLeadDigestChange(0);
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[1]]);
    });

    test('without an initialised cursor or a sink nothing changes', () => {
        const { h, make } = harness({ now: T0 });
        make().applyLeadDigestChange(0);
        expect(h.settings.size).toBe(0);
        make().tickNow();
        const before = h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY);
        h.leads.push(lead(1, T0 + MIN));
        h.sink = false;
        make().applyLeadDigestChange(0); // the tick reconciles once the sink is back
        expect(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)).toBe(before);
        expect(h.published).toEqual([]);
    });

    test('without a sink 0 → N and N → M still apply; only the N → 0 flush waits for the sink', () => {
        const { h, make, digests } = harness({ now: T0, config: { leadDigestMinutes: 0 } });
        const s = make();
        s.tickNow();
        h.sink = false;
        h.leads.push(lead(1, T0 + MIN), lead(2, T0 + 2 * MIN));
        s.applyLeadDigestChange(60);
        expect(cursorOf(h)).toEqual({ at: T0 + 2 * MIN, id: 2, minutes: 60 });
        s.applyLeadDigestChange(120);
        expect(cursorOf(h)).toEqual({ at: T0 + 2 * MIN, id: 2, minutes: 120 });
        h.leads.push(lead(3, T0 + 3 * MIN));
        s.applyLeadDigestChange(0);
        expect(cursorOf(h)).toEqual({ at: T0 + 2 * MIN, id: 2, minutes: 120 }); // flush needs the sink: next tick with a sink sends it
        expect(h.published).toEqual([]);
        h.sink = true;
        h.config = { ...h.config, leadDigestMinutes: 0 };
        s.tickNow();
        expect(digests().map((d) => d.payload.leadIds)).toEqual([[3]]);
        expect(cursorOf(h)).toEqual({ at: T0 + 3 * MIN, id: 3, minutes: 0 });
    });

    test('refuses every switch while a comment collect runs and changes nothing', () => {
        const { h, make } = harness({ now: T0 });
        const s = make();
        s.tickNow();
        h.leads.push(lead(1, T0 + MIN));
        const before = h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY);
        h.collecting = true;
        for (const next of [0, 15, 240] as const) expect(() => s.applyLeadDigestChange(next)).toThrow(LEAD_DIGEST_BUSY_ERROR);
        expect(h.settings.get(LEAD_DIGEST_CURSOR_SETTING_KEY)).toBe(before);
        expect(h.published).toEqual([]);
        expect(LEAD_DIGEST_BUSY_ERROR).toContain(BUSY_ERROR); // Control API maps it to BUSY
        h.collecting = false;
        s.applyLeadDigestChange(0);
        expect(h.published.map((p) => p.type)).toEqual(['leads.digest']);
    });
});

describe('buildMetricsReport and lead cursor store', () => {
    function store() {
        const s = new FacebookPosterStore(memoryDb());
        s.ensureSchema();
        return s;
    }
    function track(s: FacebookPosterStore, resultId: number, postedAt: number, over: Record<string, unknown> = {}) {
        s.createTracking({
            resultId, runId: 'r1', scheduleId: null, profileId: 'p1', groupUrl: 'https://www.facebook.com/groups/1/', groupId: '',
            postId: '', postUrl: `https://www.facebook.com/groups/1/posts/${resultId}/`, postedAt, textHead: `bài ${resultId}`, linkStatus: 'known',
            removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null, statsDone: [], ...over,
        } as any);
    }
    const stats = (s: FacebookPosterStore, id: number, reactions: number | null, comments: number | null, shares: number | null, at = MON_NOV_02 - MIN) =>
        s.addPostStats(id, { capturedAt: at, reactions, comments, shares });

    test('reportPayloadCountsOnlyMeasuredEngagement', () => {
        const s = store();
        const period = latestReportPeriod(DEFAULT_NOTIFICATION_CONFIG, MON_NOV_02, NY)!;
        const inside = MON_OCT_26 + 60 * MIN;
        track(s, 1, inside, { targetKind: 'page', pageId: 'pg3', groupUrl: 'https://www.facebook.com/pg3' });
        stats(s, 1, 5, 2, null);
        track(s, 2, inside + 1); stats(s, 2, null, null, null); // "no data" mark: not measured, not 0
        track(s, 3, inside + 2); // never measured
        track(s, 4, inside + 3, { linkStatus: 'not_found', postUrl: null });
        track(s, 5, inside + 4); stats(s, 5, 10, 0, 0, MON_NOV_02 - 3 * MIN); stats(s, 5, 8, 2, 0); // latest snapshot wins
        track(s, 6, inside + 5); stats(s, 6, 3, 0, 0);
        track(s, 7, inside + 6); stats(s, 7, 3, 0, 0); // tie with 6: newer post ranks first
        track(s, 8, MON_OCT_26 - MIN); stats(s, 8, 100, 0, 0); // previous period
        track(s, 9, MON_NOV_02); stats(s, 9, 100, 0, 0); // next period (to is exclusive)
        s.recordPageFollowers({ pageId: 'pg1', profileId: 'p1', capturedOn: '2026-10-25', capturedAt: MON_OCT_26 - 24 * 60 * MIN, followers: 1000 });
        s.recordPageFollowers({ pageId: 'pg1', profileId: 'p1', capturedOn: '2026-11-01', capturedAt: MON_NOV_02 - 24 * 60 * MIN, followers: 1010 });
        s.recordPageFollowers({ pageId: 'pg1', profileId: 'p1', capturedOn: '2026-11-02', capturedAt: MON_NOV_02 + 60 * MIN, followers: 2000 });
        s.recordPageFollowers({ pageId: 'pg4', profileId: 'p4', capturedOn: '2026-10-20', capturedAt: MON_OCT_26 - 6 * 24 * 60 * MIN, followers: 800 }); // no reading in the period
        s.recordPageFollowers({ pageId: 'pg2', profileId: 'p2', capturedOn: '2026-10-30', capturedAt: MON_OCT_26 + 4 * 24 * 60 * MIN, followers: 500 });

        const report = buildMetricsReport(s, period, 'weekly', (id) => `Page ${id}`);
        expect(report).toMatchObject({
            cadence: 'weekly', periodKey: 'weekly:2026-11-02', from: MON_OCT_26, to: MON_NOV_02, label: period.label,
            posts: 7, measured: 4, engagement: 7 + 10 + 3 + 3, notFound: 1,
        });
        expect(report.top).toEqual([
            { resultId: 5, targetKind: 'group', text: 'bài 5', postUrl: 'https://www.facebook.com/groups/1/posts/5/', engagement: 10 },
            { resultId: 1, targetKind: 'page', text: 'bài 1', postUrl: 'https://www.facebook.com/groups/1/posts/1/', engagement: 7 },
            { resultId: 7, targetKind: 'group', text: 'bài 7', postUrl: 'https://www.facebook.com/groups/1/posts/7/', engagement: 3 },
        ]);
        expect(report.followers).toEqual([
            { pageId: 'pg1', pageName: 'Page pg1', current: 1010, change: 10 },
            { pageId: 'pg2', pageName: 'Page pg2', current: 500, change: null },
            { pageId: 'pg3', pageName: 'Page pg3', current: null, change: null },
            { pageId: 'pg4', pageName: 'Page pg4', current: 800, change: null },
        ]);
    });

    test('top posts show the original posted text (run params + variant), falling back to the normalized head', () => {
        const s = store();
        const period = latestReportPeriod(DEFAULT_NOTIFICATION_CONFIG, MON_NOV_02, NY)!;
        const inside = MON_OCT_26 + 60 * MIN;
        const original = `Ưu Đãi  Cuối Tuần 🎉 ${'x'.repeat(120)}`;
        s.createRun({ id: 'r-text', kind: 'post', mode: 'page', params: { text: original, variants: ['Bản B: Giảm Giá Sốc'] }, startedAt: inside, scheduleId: null, campaignId: null } as any);
        track(s, 1, inside, { runId: 'r-text', variant: '', textHead: 'ưu đãi cuối tuần' });
        track(s, 2, inside + 1, { runId: 'r-text', variant: 'B', textHead: 'bản b: giảm giá sốc' });
        track(s, 3, inside + 2, { runId: 'missing-run', textHead: 'bài không còn lượt' });
        for (const id of [1, 2, 3]) stats(s, id, 10 - id, 0, 0);
        const report = buildMetricsReport(s, period, 'weekly', (id) => id);
        expect(report.top.map((t) => t.text)).toEqual([original.slice(0, 100), 'Bản B: Giảm Giá Sốc', 'bài không còn lượt']);
    });

    test('an empty period reports null engagement, never a fake 0', () => {
        const report = buildMetricsReport(store(), latestReportPeriod(DEFAULT_NOTIFICATION_CONFIG, MON_NOV_02, NY)!, 'weekly', (id) => id);
        expect(report).toMatchObject({ posts: 0, measured: 0, engagement: null, notFound: 0, top: [], followers: [] });
    });

    // Hợp đồng đổi ở bản sửa cuối (M1): hàng chờ theo id (thứ tự ghi), không theo detected_at, để đồng hồ bị lùi không làm rơi lead.
    test('listLeadsAfter / latestLeadCursor follow insertion order (id), not detected_at', () => {
        const s = store();
        expect(s.latestLeadCursor()).toBeNull();
        const base = { postUrl: 'u', resultId: null, groupUrl: 'g', campaignId: null, variant: '', profileId: 'p1', authorId: 'a', authorName: 'A', authorUrl: '',
            text: 'ib', commentedAtMs: null, matched: ['ib'], aiIntent: null, aiScore: null, aiReason: null, status: 'new' as const, note: '', updatedAt: 1 };
        const [a, b, c] = s.createLeads([{ ...base, commentKey: 'k1', detectedAt: 200 }, { ...base, commentKey: 'k2', detectedAt: 100 }, { ...base, commentKey: 'k3', detectedAt: 200 }]);
        expect(s.latestLeadCursor()).toEqual({ at: 200, id: c.id });
        expect(s.listLeadsAfter({ at: 0, id: 0 }).map((l) => l.id)).toEqual([a.id, b.id, c.id]);
        expect(s.listLeadsAfter({ at: 200, id: a.id }).map((l) => l.id)).toEqual([b.id, c.id]); // b có detected_at sớm hơn nhưng ghi sau a
        expect(s.listLeadsAfter({ at: 200, id: c.id })).toEqual([]);
    });
});
