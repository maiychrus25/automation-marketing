import { FacebookMQTTListener } from '../../services/facebook/FacebookMQTTListener';

function readReceipts(delta: Record<string, any>): any[] {
  const listener = new FacebookMQTTListener({} as any, 'acc-receipt');
  const out: any[] = [];
  listener.on('readReceipt' as any, (m: any) => out.push(m));
  (listener as any).processDelta(delta);
  return out;
}

describe('MQTT ReadReceipt delta', () => {
  test('directThread', () => {
    expect(readReceipts({ class: 'ReadReceipt', actorFbId: '111', threadKey: { otherUserFbId: '222' }, watermarkTimestampMs: '1760000000000' }))
      .toEqual([{ threadId: '222', actorFbId: '111', watermarkTimestampMs: 1760000000000 }]);
  });
  test('groupThread', () => {
    const [r] = readReceipts({ class: 'ReadReceipt', actorFbId: '111', threadKey: { threadFbId: '333' }, watermarkTimestampMs: 5 });
    expect(r.threadId).toBe('333');
  });
  test.each([
    ['noActor', { threadKey: { otherUserFbId: '2' } }],
    ['zeroThread', { actorFbId: '1', threadKey: { otherUserFbId: '0' } }],
    ['noThread', { actorFbId: '1', threadKey: {} }],
    ['badWatermark', { actorFbId: '1', threadKey: { otherUserFbId: '2' }, watermarkTimestampMs: 'x' }],
  ])('skips %s', (_n, extra) => {
    expect(readReceipts({ class: 'ReadReceipt', watermarkTimestampMs: 5, ...extra })).toEqual([]);
  });
  test('deliveryReceiptStillEmitted', () => {
    const listener = new FacebookMQTTListener({} as any, 'acc-receipt');
    const out: any[] = [];
    listener.on('deliveryReceipt', (m) => out.push(m));
    (listener as any).processDelta({ deliveredReceiptMessageId: 'mid.1', actorFbId: '9', threadKey: { otherUserFbId: '2' }, deliveredWatermarkTimestampMs: 77 });
    expect(out).toEqual([{ messageId: 'mid.1', threadId: '2', actorFbId: '9', timestampMs: 77 }]);
  });
  test('deliveryWithoutWatermarkEmitsZeroNotNow', () => {
    const listener = new FacebookMQTTListener({} as any, 'acc-receipt');
    const out: any[] = [];
    listener.on('deliveryReceipt', (m) => out.push(m));
    (listener as any).processDelta({ deliveredReceiptMessageId: 'mid.1', actorFbId: '9', threadKey: { otherUserFbId: '2' } });
    expect(out).toEqual([{ messageId: 'mid.1', threadId: '2', actorFbId: '9', timestampMs: 0 }]);
  });
});
