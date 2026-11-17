import {
  CATCH_UP_ACK_TIMEOUT_MS,
  StreamPosition,
  resyncReasonForAck,
  shouldResyncAfterHeartbeat,
  shouldResyncAfterResume,
} from '../../services/http/employeeConnection';

describe('resyncReasonForAck', () => {
  it('maps the three ack shapes', () => {
    expect(resyncReasonForAck(null)).toBe('catchup-unverified');
    expect(resyncReasonForAck({ proto: 2, bootId: 'b', status: 'reset', reason: 'boss-restart', lastSeqId: 5 })).toBe('boss-restart');
    expect(resyncReasonForAck({ proto: 2, bootId: 'b', status: 'reset', reason: 'gap', lastSeqId: null })).toBe('gap');
    expect(resyncReasonForAck({ proto: 2, bootId: 'b', status: 'replayed', lastSeqId: 5 })).toBeNull();
  });
  it('keeps the documented timeout', () => expect(CATCH_UP_ACK_TIMEOUT_MS).toBe(10000));
});

describe('StreamPosition', () => {
  it('starts empty and requests proto 2', () => {
    expect(new StreamPosition().request()).toEqual({ proto: 2, bootId: null, lastSeqId: 0 });
  });
  it('only moves forward inside one stream', () => {
    const p = new StreamPosition();
    p.track({ bootId: 'a', seqId: 10 });
    p.track({ bootId: 'a', seqId: 12 });
    p.track({ bootId: 'a', seqId: 11 });
    expect(p.request()).toEqual({ proto: 2, bootId: 'a', lastSeqId: 12 });
  });
  it('a new bootId adopts a smaller number', () => {
    const p = new StreamPosition();
    p.track({ bootId: 'a', seqId: 1000 });
    p.track({ bootId: 'b', seqId: 3 });
    expect(p.request()).toEqual({ proto: 2, bootId: 'b', lastSeqId: 3 });
  });
  it('ignores envelopes without seqId', () => {
    const p = new StreamPosition();
    p.track({ bootId: 'a', seqId: 7 });
    p.track({ bootId: 'z' });
    expect(p.request()).toEqual({ proto: 2, bootId: 'a', lastSeqId: 7 });
  });
  it('adopt with a null lastSeqId starts at 0 in a new stream', () => {
    const p = new StreamPosition();
    p.track({ bootId: 'old', seqId: 50 });
    p.adopt('a', null);
    expect(p.request()).toEqual({ proto: 2, bootId: 'a', lastSeqId: 0 });
  });
  it('adopt with a null lastSeqId keeps the number in the same stream', () => {
    const p = new StreamPosition();
    p.track({ bootId: 'a', seqId: 50 });
    p.adopt('a', null);
    expect(p.request()).toEqual({ proto: 2, bootId: 'a', lastSeqId: 50 });
  });
});

describe('shouldResyncAfterHeartbeat', () => {
  it('only on failing -> ok', () => {
    expect(shouldResyncAfterHeartbeat(true, true)).toBe(true);
    expect(shouldResyncAfterHeartbeat(false, true)).toBe(false);
    expect(shouldResyncAfterHeartbeat(true, false)).toBe(false);
  });
});

describe('shouldResyncAfterResume', () => {
  it('needs a successful heartbeat that has not already reported recovery', () => {
    expect(shouldResyncAfterResume(true, false)).toBe(true);
    expect(shouldResyncAfterResume(false, false)).toBe(false);
    expect(shouldResyncAfterResume(true, true)).toBe(false);
  });
});
