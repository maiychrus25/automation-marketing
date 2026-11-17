import EventBuffer from '../../services/socket/EventBuffer';

const aud = { kind: 'everyone' } as const;

describe('EventBuffer stream identity', () => {
  it('a later buffer has a different bootId and larger sequence numbers', () => {
    let t = 1_700_000_000_000;
    const a = new EventBuffer({ now: () => t });
    let maxA = 0;
    for (let i = 0; i < 100; i++) maxA = a.push('c', {}, aud);
    t += 1;
    const b = new EventBuffer({ now: () => t });
    expect(b.bootId).not.toBe(a.bootId);
    expect(b.push('c', {}, aud)).toBeGreaterThan(maxA);
  });
  it('reset starts a new stream and drops events', () => {
    let t = 1_700_000_000_000;
    const b = new EventBuffer({ now: () => t });
    const first = b.bootId;
    let last = 0;
    for (let i = 0; i < 5; i++) last = b.push('c', {}, aud);
    b.reset(); // same millisecond: still larger
    expect(b.bootId).not.toBe(first);
    expect(b.size).toBe(0);
    expect(b.push('c', {}, aud)).toBeGreaterThan(last);
  });
  it('oldest, newest and countAfter follow the ring', () => {
    const b = new EventBuffer({ now: () => 1000 });
    expect(b.oldestSeqId()).toBeNull();
    expect(b.newestSeqId()).toBeNull();
    expect(b.countAfter(0)).toBe(0);
    const max = 100; // MAX_SIZE minimum clamp
    EventBuffer.setMaxSize(max);
    try {
      const first = b.push('c', {}, aud);
      for (let i = 1; i < max + 20; i++) b.push('c', {}, aud);
      expect(b.size).toBe(max);
      expect(b.oldestSeqId()).toBe(first + 20);
      expect(b.newestSeqId()).toBe(first + max + 19);
      expect(b.countAfter(first + 20)).toBe(max - 1);
      expect(b.countAfter(first)).toBe(max);
      expect(b.countAfter(first + max + 19)).toBe(0);
    } finally {
      EventBuffer.setMaxSize(5000);
    }
  });
  it('countAfter can count only the events a predicate accepts', () => {
    const b = new EventBuffer({ now: () => 1000 });
    const ids = [1, 2, 3, 4, 5].map((n) => b.push('c', { n }, aud));
    expect(b.countAfter(ids[0], (e) => e.data.n % 2 === 0)).toBe(2);
    expect(b.countAfter(ids[3], (e) => e.data.n % 2 === 0)).toBe(0);
  });
  it('evicted turns true only once the ring drops an event, and reset clears it', () => {
    const b = new EventBuffer({ now: () => 1000 });
    EventBuffer.setMaxSize(100);
    try {
      expect(b.evicted).toBe(false);
      for (let i = 0; i < 100; i++) b.push('c', {}, aud);
      expect(b.evicted).toBe(false);
      b.push('c', {}, aud);
      expect(b.evicted).toBe(true);
      b.reset();
      expect(b.evicted).toBe(false);
    } finally {
      EventBuffer.setMaxSize(5000);
    }
  });
});
