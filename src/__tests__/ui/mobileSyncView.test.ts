import {
  resolveSyncRange, mobileSyncStep, isMobileSyncRunning, mobileSyncNotes,
  reduceMobileSyncStatus, terminalEffects, isMobileSyncTerminal, mergeThreadMessages, refreshPlan, nextFocusIndex, tabStopIndexes,
} from '../../ui/lib/chat/mobileSyncView';

const now = new Date(2026, 10, 13, 15, 42, 7).getTime();

describe('resolveSyncRange', () => {
  it('week: local midnight 7 days ago, open end', () => {
    const d = new Date(now);
    expect(resolveSyncRange('week', '', '', now)).toEqual({
      fromTs: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7).getTime(), toTs: null,
    });
  });
  it('all: both null', () => {
    expect(resolveSyncRange('all', '', '', now)).toEqual({ fromTs: null, toTs: null });
  });
  it('custom: start of from-day to end of to-day', () => {
    expect(resolveSyncRange('custom', '2026-11-01', '2026-11-05', now)).toEqual({
      fromTs: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
      toTs: new Date(2026, 10, 5, 23, 59, 59, 999).getTime(),
    });
  });
  it('custom: same day is valid', () => {
    expect(resolveSyncRange('custom', '2026-11-05', '2026-11-05', now)).not.toHaveProperty('error');
  });
  it('custom: missing date', () => {
    expect(resolveSyncRange('custom', '', '2026-11-05', now)).toEqual({ error: 'Chọn đủ ngày bắt đầu và ngày kết thúc' });
    expect(resolveSyncRange('custom', '2026-11-05', '', now)).toEqual({ error: 'Chọn đủ ngày bắt đầu và ngày kết thúc' });
  });
  it('custom: impossible calendar date', () => {
    expect(resolveSyncRange('custom', '2026-02-31', '2026-03-05', now)).toEqual({ error: 'Chọn đủ ngày bắt đầu và ngày kết thúc' });
    expect(resolveSyncRange('custom', '2026-03-01', '2026-13-05', now)).toEqual({ error: 'Chọn đủ ngày bắt đầu và ngày kết thúc' });
  });
  it('custom: from after to', () => {
    expect(resolveSyncRange('custom', '2026-11-06', '2026-11-05', now)).toEqual({ error: 'Ngày bắt đầu phải trước ngày kết thúc' });
  });
});

describe('step helpers', () => {
  it('maps stages to steps', () => {
    const m: Record<string, number> = {
      requesting: 0, waiting_confirm: 0, waiting_backup: 1, mobile_idle: 1, downloading: 2,
      decrypting: 3, resolving_ids: 4, importing: 4, completed: -1, failed: -1, cancelled: -1,
    };
    for (const [k, v] of Object.entries(m)) expect(mobileSyncStep(k)).toBe(v);
    expect(mobileSyncStep(null)).toBe(-1);
    expect(mobileSyncStep(undefined)).toBe(-1);
    expect(mobileSyncStep('bogus')).toBe(-1);
  });
  it('running only for active stages', () => {
    expect(isMobileSyncRunning('downloading')).toBe(true);
    expect(isMobileSyncRunning('requesting')).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled', null, undefined]) expect(isMobileSyncRunning(s as any)).toBe(false);
  });
});

describe('mobileSyncNotes', () => {
  it('builds the four notes when > 0', () => {
    expect(mobileSyncNotes({ messagesSkipped: 3, conversationsUnresolved: 2, messagesOutOfRange: 5, conversationsFailed: 1 })).toEqual([
      'Bỏ qua 3 tin đã có hoặc không hỗ trợ',
      '2 hội thoại không còn truy cập được',
      '5 tin ngoài khoảng đã chọn',
      '1 hội thoại không đọc được',
    ]);
  });
  it('omits zero / missing', () => {
    expect(mobileSyncNotes({ messagesSkipped: 0, conversationsFailed: 0 })).toEqual([]);
    expect(mobileSyncNotes(null)).toEqual([]);
    expect(mobileSyncNotes(undefined)).toEqual([]);
  });
});

const st = (zaloId: string, stage: string, updatedAt: number, startedAt = 1): any => ({ zaloId, stage, progress: 0, message: '', updatedAt, startedAt });

describe('reduceMobileSyncStatus', () => {
  it('keeps latest per account and ignores stale updates', () => {
    let m = reduceMobileSyncStatus({}, st('a', 'downloading', 10));
    m = reduceMobileSyncStatus(m, st('b', 'importing', 5));
    m = reduceMobileSyncStatus(m, st('a', 'requesting', 9));
    expect(m.a.stage).toBe('downloading');
    expect(m.b.stage).toBe('importing');
    const m2 = reduceMobileSyncStatus(m, st('a', 'completed', 11));
    expect(m2.a.stage).toBe('completed');
    expect(m.a.stage).toBe('downloading'); // immutable
  });
  it('a newer run replaces an older one even if clock is lower', () => {
    const m = reduceMobileSyncStatus({ a: st('a', 'completed', 100, 1) }, st('a', 'requesting', 50, 40));
    expect(m.a.stage).toBe('requesting');
  });
});

const V = (open: boolean, activeAccountId: string | null = 'a') => ({ open, activeAccountId });

describe('terminalEffects', () => {
  it('non-terminal: nothing', () => {
    expect(terminalEffects(st('a', 'importing', 1), V(false), null)).toEqual({ key: null, notify: false, refresh: false });
  });
  it('completed with dialog closed: notify + refresh', () => {
    const r = terminalEffects(st('a', 'completed', 1), V(false), null);
    expect(r).toMatchObject({ notify: true, refresh: true });
    expect(r.key).toBeTruthy();
  });
  it('completed with dialog open: refresh only', () => {
    expect(terminalEffects(st('a', 'completed', 1), V(true), null)).toMatchObject({ notify: false, refresh: true });
  });
  it('failed closed: notify, no refresh; cancelled: nothing to notify', () => {
    expect(terminalEffects(st('a', 'failed', 1), V(false), null)).toMatchObject({ notify: true, refresh: false });
    expect(terminalEffects(st('a', 'cancelled', 1), V(false), null)).toMatchObject({ notify: false, refresh: false });
  });
  it('already handled: nothing', () => {
    const first = terminalEffects(st('a', 'completed', 1), V(false), null);
    expect(terminalEffects(st('a', 'completed', 2), V(false), first.key)).toMatchObject({ notify: false, refresh: false });
  });
});

describe('terminalEffects (fix round 1)', () => {
  it('dialog open on a different account: this account still toasts', () => {
    expect(terminalEffects(st('a', 'completed', 1), V(true, 'b'), null)).toMatchObject({ notify: true, refresh: true });
    expect(terminalEffects(st('a', 'failed', 1), V(true, 'b'), null)).toMatchObject({ notify: true });
  });
  it('completed seen via getStatus still refreshes once, event after it does not repeat', () => {
    const viaStatus = terminalEffects(st('a', 'completed', 1), V(true), null);
    expect(viaStatus.refresh).toBe(true);
    expect(terminalEffects(st('a', 'completed', 2), V(true), viaStatus.key).refresh).toBe(false);
  });
  it('a newer run after a handled one is not swallowed', () => {
    const old = terminalEffects(st('a', 'completed', 1, 10), V(false), null);
    expect(terminalEffects(st('a', 'completed', 5, 99), V(false), old.key)).toMatchObject({ notify: true, refresh: true });
  });
  it('accounts have independent keys', () => {
    const a = terminalEffects(st('a', 'completed', 1), V(false), null);
    const b = terminalEffects(st('b', 'completed', 1), V(false), a.key);
    expect(b).toMatchObject({ notify: true, refresh: true });
    expect(b.key).not.toBe(a.key);
  });
});

describe('isMobileSyncTerminal', () => {
  it('true only for completed/failed/cancelled', () => {
    for (const s of ['completed', 'failed', 'cancelled']) expect(isMobileSyncTerminal(s)).toBe(true);
    for (const s of ['downloading', 'requesting', null, undefined]) expect(isMobileSyncTerminal(s as any)).toBe(false);
  });
});

describe('mergeThreadMessages', () => {
  const m = (id: string, ts: number, extra: any = {}): any => ({ msg_id: id, timestamp: ts, ...extra });
  it('keeps pending/temp rows and older pages, adds new in order', () => {
    const existing = [m('old', 1), m('x', 10), m('temp_1', 20, { send_status: 'pending' }), m('retry_2', 25, { send_status: 'failed' })];
    const out = mergeThreadMessages(existing, [m('x', 10), m('new', 15), m('newer', 30)]);
    expect(out.map(r => r.msg_id)).toEqual(['old', 'x', 'new', 'temp_1', 'retry_2', 'newer']);
  });
  it('does not double duplicate ids (number vs string)', () => {
    const out = mergeThreadMessages([m('5', 1)], [m(5 as any, 1), m('6', 2)]);
    expect(out.map(r => String(r.msg_id))).toEqual(['5', '6']);
  });
  it('keeps existing row object as is', () => {
    const e = m('x', 10, { content: 'local' });
    expect(mergeThreadMessages([e], [m('x', 10, { content: 'db' })])[0]).toBe(e);
  });
  it('nothing new: same reference', () => {
    const existing = [m('x', 1)];
    expect(mergeThreadMessages(existing, [m('x', 1)])).toBe(existing);
    expect(mergeThreadMessages(existing, [])).toBe(existing);
  });
});

describe('refreshPlan', () => {
  it('other account finished: list only', () => {
    expect(refreshPlan('a', 'b', 't1')).toEqual({ list: true, thread: false });
  });
  it('same account, no open thread: list only', () => {
    expect(refreshPlan('a', 'a', null)).toEqual({ list: true, thread: false });
  });
  it('same account + open thread: both', () => {
    expect(refreshPlan('a', 'a', 't1')).toEqual({ list: true, thread: true });
  });
});

describe('nextFocusIndex', () => {
  it('wraps only at the ends', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });
  it('lets the browser move focus inside the list (null)', () => {
    expect(nextFocusIndex(3, 0, false)).toBeNull();
    expect(nextFocusIndex(3, 1, false)).toBeNull();
    expect(nextFocusIndex(3, 1, true)).toBeNull();
    expect(nextFocusIndex(3, 2, true)).toBeNull();
  });
  it('focus on the panel or outside the list: Shift+Tab goes to the last, Tab is left alone', () => {
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(3, -1, false)).toBeNull();
  });
  it('single element wraps onto itself in both directions', () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });
  it('empty list: -1 keeps focus on the panel', () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
    expect(nextFocusIndex(0, -1, true)).toBe(-1);
  });
});

describe('tabStopIndexes', () => {
  const b = { isRadio: false, checked: false, disabled: false };
  const r = { isRadio: true, checked: false, disabled: false };
  const rc = { ...r, checked: true };
  it('keeps only the checked radio of a group', () => {
    expect(tabStopIndexes([rc, r, r, b])).toEqual([0, 3]);
    expect(tabStopIndexes([r, rc, r, b, b])).toEqual([1, 3, 4]);
  });
  it('skips disabled entries; no radios means all', () => {
    expect(tabStopIndexes([b, { ...b, disabled: true }, b])).toEqual([0, 2]);
    expect(tabStopIndexes([b, b, b])).toEqual([0, 1, 2]);
  });
  it('a group with no checked member keeps every radio; separate groups are independent', () => {
    expect(tabStopIndexes([r, r, b])).toEqual([0, 1, 2]);
    expect(tabStopIndexes([{ ...rc, group: 'a' }, { ...r, group: 'a' }, { ...r, group: 'b' }, { ...rc, group: 'b' }]))
      .toEqual([0, 3]);
  });
});
