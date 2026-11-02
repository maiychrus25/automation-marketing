import {
    DEFAULT_AUTONOMY_POLICY, inQuietHours, mergeAutonomyPolicy, minutesOf, parseAutonomyPolicy, validateAutonomyPolicy,
} from '../../services/autonomy/autonomyPolicy';

describe('autonomyPolicy', () => {
    it('defaultsMatchSpec', () => {
        expect(DEFAULT_AUTONOMY_POLICY).toEqual({
            enabled: false, quietStart: '22:00', quietEnd: '07:00',
            pageCampaignDays: 7, pagePostsPerDay: 1, pagePostsTotal: 7, pageWindowStart: '08:00', pageWindowEnd: '21:00',
            groupPostsPerDay: 3, groupRepeatDays: 3, leadRepliesPerDay: 10, facebookActionsPerDay: 12,
            videosPerDay: 2, videoReserveLast: true, agentRunsPerDay: 12,
        });
    });

    it('rejectsUnknownKeyAndOutOfRange', () => {
        const base = DEFAULT_AUTONOMY_POLICY;
        for (const bad of [
            { ...base, extra: 1 }, { ...base, groupPostsPerDay: -1 }, { ...base, groupPostsPerDay: 1.5 },
            { ...base, pageCampaignDays: 0 }, { ...base, pageCampaignDays: 31 },
            { ...base, pageWindowStart: '21:00', pageWindowEnd: '08:00' }, { ...base, pageWindowStart: '08:00', pageWindowEnd: '08:00' },
            { ...base, quietStart: '25:00' }, { ...base, enabled: 'yes' }, null, [],
        ]) expect(() => validateAutonomyPolicy(bad)).toThrow();
        expect(() => mergeAutonomyPolicy(base, { nope: 1 })).toThrow();
        expect(validateAutonomyPolicy(base)).toEqual(base);
    });

    it('mergeKeepsOtherFields', () => {
        const merged = mergeAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, { enabled: true, videosPerDay: 0 });
        expect(merged).toEqual({ ...DEFAULT_AUTONOMY_POLICY, enabled: true, videosPerDay: 0 });
    });

    it('parseFallsBackToDefault', () => {
        expect(parseAutonomyPolicy(null)).toEqual(DEFAULT_AUTONOMY_POLICY);
        expect(parseAutonomyPolicy('{oops')).toEqual(DEFAULT_AUTONOMY_POLICY);
        expect(parseAutonomyPolicy('{"enabled":true,"x":1}')).toEqual(DEFAULT_AUTONOMY_POLICY);
        expect(parseAutonomyPolicy('{"enabled":true}').enabled).toBe(true);
    });

    it('quietWindowAcrossMidnight', () => {
        const p = DEFAULT_AUTONOMY_POLICY;
        expect(inQuietHours(p, minutesOf('23:30'))).toBe(true);
        expect(inQuietHours(p, minutesOf('06:59'))).toBe(true);
        expect(inQuietHours(p, minutesOf('07:00'))).toBe(false);
        expect(inQuietHours(p, minutesOf('21:59'))).toBe(false);
        expect(inQuietHours({ ...p, quietStart: '08:00', quietEnd: '12:00' }, minutesOf('09:00'))).toBe(true);
        expect(inQuietHours({ ...p, quietStart: '08:00', quietEnd: '08:00' }, minutesOf('08:00'))).toBe(false);
    });
});
