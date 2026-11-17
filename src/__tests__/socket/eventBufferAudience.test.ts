import EventBuffer from '../../services/socket/EventBuffer';

describe('EventBuffer audience', () => {
  it('stores the audience with the event and getSince keeps its contract', () => {
    const buf = new EventBuffer();
    const s1 = buf.push('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
    const s2 = buf.push('event:message', { n: 2 }, { kind: 'nobody' });
    expect(buf.size).toBe(2);
    expect(buf.getSince(0).map((e) => e.audience.kind)).toEqual(['accounts', 'nobody']);
    expect(buf.getSince(s1).map((e) => e.seqId)).toEqual([s2]);
  });
});
