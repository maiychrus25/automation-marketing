import { planCatchUp, CATCH_UP_MAX_REPLAY } from '../../services/socket/catchUpProtocol';

const stream = (o: Partial<{ oldest: number | null; newest: number | null; count: number; evicted: boolean }> = {}) => ({
  bootId: 'boot-1',
  oldestSeqId: o.oldest === undefined ? 100 : o.oldest,
  newestSeqId: o.newest === undefined ? 200 : o.newest,
  countAfter: () => o.count ?? 10,
  evicted: o.evicted ?? false,
});

describe('planCatchUp', () => {
  it('request without proto is legacy, even with lastSeqId 0', () => {
    expect(planCatchUp({ lastSeqId: 0 }, stream())).toEqual({ mode: 'legacy', sinceSeqId: 0 });
    expect(planCatchUp({ lastSeqId: 150 }, stream())).toEqual({ mode: 'legacy', sinceSeqId: 150 });
    expect(planCatchUp({ proto: 1, lastSeqId: 7 }, stream())).toEqual({ mode: 'legacy', sinceSeqId: 7 });
    expect(planCatchUp({}, stream())).toEqual({ mode: 'legacy', sinceSeqId: 0 });
  });
  it('proto 2 without a bootId or with a malformed lastSeqId is fresh', () => {
    expect(planCatchUp({ proto: 2, lastSeqId: 150 }, stream())).toEqual({ mode: 'reset', reason: 'fresh' });
    expect(planCatchUp({ proto: 2, bootId: null, lastSeqId: 150 }, stream())).toEqual({ mode: 'reset', reason: 'fresh' });
    expect(planCatchUp({ proto: 2, lastSeqId: 0 }, stream())).toEqual({ mode: 'reset', reason: 'fresh' });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: null }, stream())).toEqual({ mode: 'reset', reason: 'fresh' });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: -5 }, stream())).toEqual({ mode: 'reset', reason: 'fresh' });
  });
  it('matching bootId with lastSeqId 0 replays everything the stream still holds', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 0 }, stream())).toEqual({ mode: 'replay', sinceSeqId: 0 });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 0 }, stream({ oldest: null, newest: null })))
      .toEqual({ mode: 'replay', sinceSeqId: 0 });
  });
  it('matching bootId with lastSeqId 0 after an eviction is a gap', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 0 }, stream({ evicted: true }))).toEqual({ mode: 'reset', reason: 'gap' });
  });
  it('lastSeqId 0 with a different bootId is still boss-restart and the cap still applies', () => {
    expect(planCatchUp({ proto: 2, bootId: 'old', lastSeqId: 0 }, stream())).toEqual({ mode: 'reset', reason: 'boss-restart' });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 0 }, stream({ count: CATCH_UP_MAX_REPLAY + 1 }))).toEqual({ mode: 'reset', reason: 'gap' });
  });
  it('different bootId is boss-restart', () => {
    expect(planCatchUp({ proto: 2, bootId: 'old', lastSeqId: 150 }, stream())).toEqual({ mode: 'reset', reason: 'boss-restart' });
  });
  it('empty buffer replays nothing', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 150 }, stream({ oldest: null, newest: null })))
      .toEqual({ mode: 'replay', sinceSeqId: 150 });
  });
  it('position just before the oldest event is still covered', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 99 }, stream())).toEqual({ mode: 'replay', sinceSeqId: 99 });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 98 }, stream())).toEqual({ mode: 'reset', reason: 'gap' });
  });
  it('position at the newest event replays nothing; beyond it is a gap', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 200 }, stream())).toEqual({ mode: 'replay', sinceSeqId: 200 });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 201 }, stream())).toEqual({ mode: 'reset', reason: 'gap' });
  });
  it('too many missed events is a gap', () => {
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 120 }, stream({ count: CATCH_UP_MAX_REPLAY }))).toEqual({ mode: 'replay', sinceSeqId: 120 });
    expect(planCatchUp({ proto: 2, bootId: 'boot-1', lastSeqId: 120 }, stream({ count: CATCH_UP_MAX_REPLAY + 1 }))).toEqual({ mode: 'reset', reason: 'gap' });
  });
});
