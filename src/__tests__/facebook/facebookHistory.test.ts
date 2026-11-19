import {
  activityMs, isLightSpeedMessageId, messageInRange, threadActiveInRange, nextHistoryAnchor,
  isFbHistorySyncActive, emptyFbHistorySyncStatus, FB_HISTORY_SYNC_EVENT, planE2eeProbe,
} from '../../services/facebook/facebookHistory';

const OPEN = { fromTs: null, toTs: null };

describe('facebookHistory helpers', () => {
  it('activityMs normalises seconds and milliseconds', () => {
    expect(activityMs(1700000000)).toBe(1700000000000);
    expect(activityMs(1700000000123)).toBe(1700000000123);
    expect(activityMs('x')).toBe(0);
    expect(activityMs(-5)).toBe(0);
    expect(activityMs(NaN)).toBe(0);
    expect(activityMs(Infinity)).toBe(0);
    expect(activityMs(1e12)).toBe(1e12);
    expect(activityMs(999_999_999_999)).toBe(999_999_999_999_000);
  });

  it('isLightSpeedMessageId accepts only mid.$ ids', () => {
    expect(isLightSpeedMessageId('mid.$abc')).toBe(true);
    for (const bad of ['123456', 'temp_1', '', 'mid.$', null, undefined]) expect(isLightSpeedMessageId(bad)).toBe(false);
  });

  it('messageInRange is inclusive at both edges and true for unknown ts', () => {
    const range = { fromTs: 1_000_000_000_000, toTs: 2_000_000_000_000 };
    expect(messageInRange(1_000_000_000_000, range)).toBe(true);
    expect(messageInRange(2_000_000_000_000, range)).toBe(true);
    expect(messageInRange(999_999_999_999, range)).toBe(false);
    expect(messageInRange(2_000_000_000_001, range)).toBe(false);
    expect(messageInRange(null, range)).toBe(true);
  });

  it('messageInRange with one-sided and open ranges', () => {
    expect(messageInRange(1_500_000_000_000, { fromTs: 1_600_000_000_000, toTs: null })).toBe(false);
    expect(messageInRange(1_700_000_000_000, { fromTs: 1_600_000_000_000, toTs: null })).toBe(true);
    expect(messageInRange(1_700_000_000_000, { fromTs: null, toTs: 1_600_000_000_000 })).toBe(false);
    expect(messageInRange(1_500_000_000_000, { fromTs: null, toTs: 1_600_000_000_000 })).toBe(true);
    expect(messageInRange(1_500_000_000_000, OPEN)).toBe(true);
  });

  it('threadActiveInRange treats unknown activity as active', () => {
    const range = { fromTs: 1_700_000_000_000, toTs: null };
    expect(threadActiveInRange(0, range)).toBe(true);
    expect(threadActiveInRange(1_699_999_999_999, range)).toBe(false);
    expect(threadActiveInRange(1_700_000_000_000, range)).toBe(true);
  });

  describe('nextHistoryAnchor', () => {
    const prev = { timestampMs: 1_700_000_100_000, messageId: 'mid.$prev' };
    const page = { count: 20, hasMoreBefore: true, minTimestampMs: 1_700_000_000_000, minMessageId: 'mid.$min' };
    it('stops when nothing more, empty page or no timestamp', () => {
      expect(nextHistoryAnchor({ ...page, hasMoreBefore: false }, prev, OPEN)).toBeNull();
      expect(nextHistoryAnchor({ ...page, count: 0 }, prev, OPEN)).toBeNull();
      expect(nextHistoryAnchor({ ...page, minTimestampMs: 0 }, prev, OPEN)).toBeNull();
    });
    it('stops once the oldest message is before the range start', () => {
      expect(nextHistoryAnchor(page, prev, { fromTs: 1_700_000_000_001, toTs: null })).toBeNull();
    });
    it('stops when the anchor does not move back', () => {
      expect(nextHistoryAnchor({ ...page, minTimestampMs: prev.timestampMs, minMessageId: prev.messageId }, prev, OPEN)).toBeNull();
    });
    it('continues forward for a past-ending range (first page newer than the toTs anchor)', () => {
      const start = { timestampMs: 1_700_000_100_000, messageId: '' };
      const newer = { count: 20, hasMoreBefore: true, minTimestampMs: 1_700_000_200_000, minMessageId: 'mid.$b' };
      expect(nextHistoryAnchor(newer, start, { fromTs: null, toTs: 1_700_000_100_000 }))
        .toEqual({ timestampMs: 1_700_000_200_000, messageId: 'mid.$b' });
    });
    it('continues when the timestamp repeats with a different id', () => {
      expect(nextHistoryAnchor({ ...page, minTimestampMs: prev.timestampMs, minMessageId: 'mid.$other' }, prev, OPEN))
        .toEqual({ timestampMs: prev.timestampMs, messageId: 'mid.$other' });
    });
    it('returns the new anchor otherwise', () => {
      expect(nextHistoryAnchor(page, prev, OPEN)).toEqual({ timestampMs: 1_700_000_000_000, messageId: 'mid.$min' });
    });
  });

  it('status helpers', () => {
    expect(FB_HISTORY_SYNC_EVENT).toBe('event:fbHistorySync');
    expect(isFbHistorySyncActive({ stage: 'listing' })).toBe(true);
    expect(isFbHistorySyncActive({ stage: 'syncing' })).toBe(true);
    expect(isFbHistorySyncActive({ stage: 'completed' })).toBe(false);
    expect(isFbHistorySyncActive(null)).toBe(false);
    const s = emptyFbHistorySyncStatus('acc');
    expect(s).toMatchObject({ accountId: 'acc', stage: 'idle', range: OPEN, messagesSaved: 0, startedAt: 0 });
  });
});

describe('planE2eeProbe', () => {
  const base = { probe: true, isGroup: false, probedEmpty: false, resolved: null, callerTimestampMs: 0, oldestLocalMs: 0 };
  test('refusesBackgroundGroupAndAlreadyProbed', () => {
    expect(planE2eeProbe({ ...base, mode: 'background' })).toBeNull();
    expect(planE2eeProbe({ ...base, isGroup: true })).toBeNull();
    expect(planE2eeProbe({ ...base, probedEmpty: true })).toBeNull();
  });
  test('refusesUnlessProbeIsExactlyTrue', () => {
    for (const probe of [undefined, false, 'true' as any, 1 as any]) expect(planE2eeProbe({ ...base, probe })).toBeNull();
  });
  test('normalisesTheCallerTimestamp', () => {
    expect(planE2eeProbe({ ...base, callerTimestampMs: 1700000000 })).toEqual({ anchor: { timestampMs: 1700000000000, messageId: '' }, kind: 'timestamp' });
  });
  test('prefersMidAnchorThenCallerThenOldestLocalThenNone', () => {
    const mid = { timestampMs: 5, messageId: 'mid.$x' };
    expect(planE2eeProbe({ ...base, resolved: mid, callerTimestampMs: 9 })).toEqual({ anchor: mid, kind: 'mid' });
    expect(planE2eeProbe({ ...base, callerTimestampMs: 9e12, oldestLocalMs: 3e12 })).toEqual({ anchor: { timestampMs: 9e12, messageId: '' }, kind: 'timestamp' });
    expect(planE2eeProbe({ ...base, oldestLocalMs: 3e12 })).toEqual({ anchor: { timestampMs: 3e12, messageId: '' }, kind: 'timestamp' });
    expect(planE2eeProbe(base)).toEqual({ anchor: { timestampMs: 0, messageId: '' }, kind: 'none' });
  });
});
