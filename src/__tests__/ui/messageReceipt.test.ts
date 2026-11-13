import { lastOutgoingReceipt, mergeReceiptMarks, receiptDisplay, receiptLabel } from '../../ui/lib/chat/messageReceipt';

const own = (timestamp: number | string, extra: any = {}) => ({ is_sent: 1, timestamp, msg_id: 'm' + timestamp, ...extra });
const peer = (timestamp: number) => ({ is_sent: 0, timestamp, msg_id: 'p' + timestamp });

describe('lastOutgoingReceipt', () => {
  it('read when timestamp <= readTs', () => {
    expect(lastOutgoingReceipt([own(100)], { deliveredTs: 50, readTs: 100 }, 'zalo')).toBe('read');
  });
  it('delivered when only <= deliveredTs', () => {
    expect(lastOutgoingReceipt([own(100)], { deliveredTs: 100, readTs: 0 }, 'facebook')).toBe('delivered');
  });
  it('null when newer than both marks', () => {
    expect(lastOutgoingReceipt([own(100)], { deliveredTs: 99, readTs: 99 }, 'zalo')).toBeNull();
  });
  it('null when last message is from the peer', () => {
    expect(lastOutgoingReceipt([own(10), peer(20)], { deliveredTs: 99, readTs: 99 }, 'zalo')).toBeNull();
  });
  it('null while sending or failed', () => {
    for (const s of ['pending', 'sending', 'failed', 'timeout']) {
      expect(lastOutgoingReceipt([own(100, { send_status: s })], { readTs: 999 }, 'zalo')).toBeNull();
    }
    expect(lastOutgoingReceipt([own(100, { msg_id: 'temp_1' })], { readTs: 999 }, 'zalo')).toBeNull();
  });
  it('empty channel defaults to Zalo; telegram unsupported', () => {
    expect(lastOutgoingReceipt([own(1)], { readTs: 5 }, '')).toBe('read');
    expect(lastOutgoingReceipt([own(1)], { readTs: 5 }, null)).toBe('read');
    expect(lastOutgoingReceipt([own(1)], { readTs: 5 }, 'telegram_user')).toBeNull();
    expect(lastOutgoingReceipt([own(1)], { readTs: 5 }, 'telegram_bot')).toBeNull();
  });
  it('empty/null inputs', () => {
    expect(lastOutgoingReceipt([], { readTs: 5 }, 'zalo')).toBeNull();
    expect(lastOutgoingReceipt(null as any, { readTs: 5 }, 'zalo')).toBeNull();
    expect(lastOutgoingReceipt([own(1)], null, 'zalo')).toBeNull();
  });
  it('skips trailing system/recalled rows', () => {
    const msgs = [own(100), { is_sent: 0, timestamp: 200, msg_type: 'system' }, { is_sent: 1, timestamp: 300, is_recalled: 1 }];
    expect(lastOutgoingReceipt(msgs, { readTs: 150 }, 'zalo')).toBe('read');
  });
  it('accepts numeric-string timestamps and treats bad marks as 0', () => {
    expect(lastOutgoingReceipt([own('100')], { deliveredTs: 100 }, 'zalo')).toBe('delivered');
    expect(lastOutgoingReceipt([own(100)], { deliveredTs: NaN, readTs: null }, 'zalo')).toBeNull();
  });
});

describe('receiptLabel', () => {
  it('maps copy', () => {
    expect(receiptLabel('delivered')).toBe('Đã nhận');
    expect(receiptLabel('read')).toBe('Đã xem');
  });
});

describe('mergeReceiptMarks', () => {
  it('takes the max of each mark', () => {
    expect(mergeReceiptMarks({ peer_delivered_ts: 5, peer_read_ts: 3 }, { deliveredTs: 9, readTs: 1 }))
      .toEqual({ peer_delivered_ts: 9, peer_read_ts: 3 });
  });
  it('null when nothing changes', () => {
    expect(mergeReceiptMarks({ peer_delivered_ts: 5, peer_read_ts: 3 }, { deliveredTs: 5, readTs: 0 })).toBeNull();
    expect(mergeReceiptMarks({}, {})).toBeNull();
  });
  it('treats missing current as 0', () => {
    expect(mergeReceiptMarks({}, { deliveredTs: 4 })).toEqual({ peer_delivered_ts: 4, peer_read_ts: 0 });
  });
});

describe('receiptDisplay', () => {
  it('maps status and seen uids', () => {
    expect(receiptDisplay(null, true)).toBe('none');
    expect(receiptDisplay(null, false)).toBe('none');
    expect(receiptDisplay('delivered', true)).toBe('label');
    expect(receiptDisplay('delivered', false)).toBe('label');
    expect(receiptDisplay('read', true)).toBe('avatars');
    expect(receiptDisplay('read', false)).toBe('label');
  });
  it('stale seenInfo does not survive a newer unseen own message', () => {
    const show = (msgs: any[], marks: any, uids: boolean) =>
      receiptDisplay(lastOutgoingReceipt(msgs, marks, 'zalo'), uids);
    expect(show([own(100)], { deliveredTs: 100, readTs: 100 }, true)).toBe('avatars');
    expect(show([own(100)], { deliveredTs: 100, readTs: 100 }, false)).toBe('label');
    const two = [own(100), own(200)];
    expect(show(two, { deliveredTs: 150, readTs: 100 }, true)).toBe('none');
    const st = lastOutgoingReceipt(two, { deliveredTs: 200, readTs: 100 }, 'zalo');
    expect(receiptDisplay(st, true)).toBe('label');
    expect(receiptLabel(st!)).toBe('Đã nhận');
  });
});
