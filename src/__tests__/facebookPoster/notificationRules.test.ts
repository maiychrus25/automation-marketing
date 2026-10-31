import {
    DEFAULT_NOTIFICATION_CONFIG, LEAD_DIGEST_MINUTES, NOTIFICATION_TICK_MS, clockLabel, latestReportPeriod,
    mergeNotificationConfig, parseNotificationConfig, validateNotificationConfig, type NotificationConfig,
} from '../../services/facebookPoster/notificationRules';

const DEF = DEFAULT_NOTIFICATION_CONFIG;
const HCM = 'Asia/Ho_Chi_Minh';
const NY = 'America/New_York';

describe('notification config', () => {
    test('defaults', () => {
        expect(DEFAULT_NOTIFICATION_CONFIG).toEqual({ reportCadence: 'weekly', reportHour: 8, reportWeekday: 1, leadDigestMinutes: 60 });
        expect(NOTIFICATION_TICK_MS).toBe(60_000);
        expect([...LEAD_DIGEST_MINUTES]).toEqual([0, 15, 30, 60, 120, 240]);
    });

    test('validatesDomains', () => {
        const ok = (patch: Partial<NotificationConfig>) => validateNotificationConfig({ ...DEF, ...patch });
        for (const m of [0, 15, 30, 60, 120, 240] as const) expect(ok({ leadDigestMinutes: m }).leadDigestMinutes).toBe(m);
        for (const c of ['off', 'daily', 'weekly'] as const) expect(ok({ reportCadence: c }).reportCadence).toBe(c);
        expect(ok({ reportHour: 0 }).reportHour).toBe(0);
        expect(ok({ reportHour: 23, reportWeekday: 7 })).toMatchObject({ reportHour: 23, reportWeekday: 7 });
        expect(() => ok({ reportHour: -1 })).toThrow(/reportHour/);
        expect(() => ok({ reportHour: 24 })).toThrow(/reportHour/);
        expect(() => ok({ reportHour: 1.5 })).toThrow(/reportHour/);
        expect(() => ok({ reportWeekday: 0 })).toThrow(/reportWeekday/);
        expect(() => ok({ reportWeekday: 8 })).toThrow(/reportWeekday/);
        expect(() => ok({ leadDigestMinutes: 45 as never })).toThrow(/leadDigestMinutes/);
        expect(() => ok({ reportCadence: 'monthly' as never })).toThrow(/reportCadence/);
        expect(() => validateNotificationConfig({ ...DEF, extra: 1 })).toThrow(/extra/);
        expect(() => validateNotificationConfig({ reportCadence: 'daily' })).toThrow(/reportHour/);
        expect(() => validateNotificationConfig(null)).toThrow();
    });

    test('merge validates the patch and rejects unknown keys', () => {
        expect(mergeNotificationConfig(DEF, { reportCadence: 'daily', leadDigestMinutes: 0 }))
            .toEqual({ reportCadence: 'daily', reportHour: 8, reportWeekday: 1, leadDigestMinutes: 0 });
        expect(() => mergeNotificationConfig(DEF, { reportHour: 30 })).toThrow(/reportHour/);
        expect(() => mergeNotificationConfig(DEF, { foo: 1 })).toThrow(/foo/);
        expect(() => mergeNotificationConfig(DEF, 'x')).toThrow();
    });

    test('parse falls back to defaults on missing or broken settings', () => {
        expect(parseNotificationConfig(null)).toEqual(DEF);
        expect(parseNotificationConfig('{bad')).toEqual(DEF);
        expect(parseNotificationConfig(JSON.stringify({ ...DEF, reportHour: 99 }))).toEqual(DEF);
        expect(parseNotificationConfig(JSON.stringify({ ...DEF, reportCadence: 'daily' })).reportCadence).toBe('daily');
        parseNotificationConfig(null).reportHour = 3; // returned copy must not alias the default
        expect(DEF.reportHour).toBe(8);
    });
});

describe('latestReportPeriod', () => {
    test('weeklyKeyInHoChiMinh', () => {
        expect(latestReportPeriod(DEF, Date.UTC(2026, 9, 26, 1, 0), HCM)).toMatchObject({
            key: 'weekly:2026-10-26', to: Date.UTC(2026, 9, 26, 1, 0), from: Date.UTC(2026, 9, 19, 1, 0), label: '19/10 08:00 → 26/10 08:00',
        });
        expect(latestReportPeriod(DEF, Date.UTC(2026, 9, 26, 0, 59), HCM)!.key).toBe('weekly:2026-10-19');
        // Mid-week (Thursday) still points at the Monday that started the current cycle.
        expect(latestReportPeriod(DEF, Date.UTC(2026, 9, 29, 5, 30, 12, 345), HCM)).toMatchObject({ key: 'weekly:2026-10-26', to: Date.UTC(2026, 9, 26, 1, 0) });
    });

    test('weeklyKeyAcrossUsDstEnd', () => {
        const due = latestReportPeriod(DEF, Date.UTC(2026, 10, 2, 13, 0), NY)!;
        expect(due.key).toBe('weekly:2026-11-02');
        // 08:00 EST after DST ended; the period starts at 08:00 EDT one week earlier, so consecutive periods neither overlap nor gap.
        expect(due).toMatchObject({ to: Date.UTC(2026, 10, 2, 13, 0), from: Date.UTC(2026, 9, 26, 12, 0) });
        const before = latestReportPeriod(DEF, Date.UTC(2026, 10, 2, 12, 59), NY)!;
        expect(before.key).toBe('weekly:2026-10-26');
        expect(before.to).toBe(due.from);
    });

    test('dailyAndOff', () => {
        const daily: NotificationConfig = { ...DEF, reportCadence: 'daily' };
        expect(latestReportPeriod(daily, Date.UTC(2026, 9, 31, 0, 59), HCM)).toMatchObject({
            key: 'daily:2026-10-30', to: Date.UTC(2026, 9, 30, 1, 0), from: Date.UTC(2026, 9, 29, 1, 0), label: '29/10 08:00 → 30/10 08:00',
        });
        expect(latestReportPeriod(daily, Date.UTC(2026, 9, 31, 1, 0), HCM)!.key).toBe('daily:2026-10-31');
        // Daily across the US DST end: Nov 1 08:00 EST is 25 hours after Oct 31 08:00 EDT.
        expect(latestReportPeriod(daily, Date.UTC(2026, 10, 1, 13, 0), NY)).toMatchObject({
            key: 'daily:2026-11-01', from: Date.UTC(2026, 9, 31, 12, 0), to: Date.UTC(2026, 10, 1, 13, 0),
        });
        expect(latestReportPeriod({ ...DEF, reportCadence: 'off' }, Date.UTC(2026, 9, 31, 1, 0), HCM)).toBeNull();
    });

    test('midnight reports label whole days ending the day before', () => {
        const midnight: NotificationConfig = { ...DEF, reportHour: 0 };
        expect(latestReportPeriod(midnight, Date.UTC(2026, 9, 25, 17, 0), HCM)).toMatchObject({
            key: 'weekly:2026-10-26', from: Date.UTC(2026, 9, 18, 17, 0), to: Date.UTC(2026, 9, 25, 17, 0), label: '19/10–25/10',
        });
        expect(latestReportPeriod({ ...midnight, reportCadence: 'daily' }, Date.UTC(2026, 9, 30, 17, 30), HCM)).toMatchObject({
            key: 'daily:2026-10-31', from: Date.UTC(2026, 9, 29, 17, 0), to: Date.UTC(2026, 9, 30, 17, 0), label: '30/10',
        });
        expect(latestReportPeriod({ ...DEF, reportHour: 21 }, Date.UTC(2026, 10, 2, 14, 0), HCM)!.label).toBe('26/10 21:00 → 02/11 21:00');
    });

    test('weekday and hour other than the default', () => {
        const sunday21: NotificationConfig = { ...DEF, reportWeekday: 7, reportHour: 21 };
        // Sat 31/10 20:00 HCM → previous Sunday 25/10.
        expect(latestReportPeriod(sunday21, Date.UTC(2026, 9, 31, 13, 0), HCM)!.key).toBe('weekly:2026-10-25');
        // Sun 01/11 21:00 HCM → this Sunday.
        expect(latestReportPeriod(sunday21, Date.UTC(2026, 10, 1, 14, 0), HCM)!.key).toBe('weekly:2026-11-01');
    });

    test('processTimezoneDoesNotChangeKey', () => {
        const original = process.env.TZ;
        const now = Date.UTC(2026, 10, 2, 13, 0);
        try {
            const results = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'Asia/Ho_Chi_Minh'].map((tz) => {
                process.env.TZ = tz;
                return [latestReportPeriod(DEF, now, NY), latestReportPeriod({ ...DEF, reportCadence: 'daily' }, now - 60_000, NY), clockLabel(now, now + 3_600_000, NY)];
            });
            for (const r of results) expect(r).toEqual(results[0]);
            expect(results[0][0]).toMatchObject({ key: 'weekly:2026-11-02' });
            expect(results[0][1]).toMatchObject({ key: 'daily:2026-11-01' });
        } finally {
            if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
        }
    });
});

test('clockLabel formats HH:mm–HH:mm in the given zone', () => {
    expect(clockLabel(Date.UTC(2026, 9, 31, 1, 5), Date.UTC(2026, 9, 31, 2, 5), HCM)).toBe('08:05–09:05');
    expect(clockLabel(Date.UTC(2026, 9, 31, 16, 0), Date.UTC(2026, 9, 31, 17, 30), HCM)).toBe('23:00–00:30');
});
