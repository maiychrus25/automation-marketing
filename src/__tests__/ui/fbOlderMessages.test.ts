import {
  FB_E2EE_HISTORY_NOTE, shouldFetchFbHistoryOnOpen, shouldFetchFbOlder, fbOlderAnchor,
  interpretFbOlderResult, fbHistoryTriedKey, rowsFromGetMessages,
  shouldShowFbProbeButton, interpretFbProbeResult, closesFbProbe,
} from '../../ui/lib/chat/fbOlderMessages';
import type { FbHistoryPageResult } from '../../services/facebook/facebookHistory';

const ok = (over: Partial<Extract<FbHistoryPageResult, { success: true }>> = {}): FbHistoryPageResult => ({
  success: true, saved: 5, received: 5, stored: 5, count: 5, hasMoreBefore: true, minTimestampMs: 1, source: 'lightspeed', ...over,
});
const fail = (code: any, error = 'boom'): FbHistoryPageResult => ({ success: false, code, error });

describe('shouldFetchFbHistoryOnOpen', () => {
  const base = { channel: 'facebook', isEmployee: false, localCount: 0, alreadyTried: false };
  it('true for Facebook, boss mode, empty DB, not tried', () => expect(shouldFetchFbHistoryOnOpen(base)).toBe(true));
  it.each(['zalo', 'telegram_user', 'telegram_bot', undefined])('false for channel %s', (channel) =>
    expect(shouldFetchFbHistoryOnOpen({ ...base, channel })).toBe(false));
  it('false for employee', () => expect(shouldFetchFbHistoryOnOpen({ ...base, isEmployee: true })).toBe(false));
  it('false when already tried', () => expect(shouldFetchFbHistoryOnOpen({ ...base, alreadyTried: true })).toBe(false));
  it('false when local messages exist', () => expect(shouldFetchFbHistoryOnOpen({ ...base, localCount: 3 })).toBe(false));
  it('false for a Page account', () => expect(shouldFetchFbHistoryOnOpen({ ...base, isPage: true })).toBe(false));
  it('false for an employee on a Page too (empty Page thread has no anchor)', () =>
    expect(shouldFetchFbHistoryOnOpen({ ...base, isEmployee: true, isPage: true })).toBe(false));
});

describe('shouldFetchFbOlder', () => {
  it('true for Facebook non-employee', () => expect(shouldFetchFbOlder({ channel: 'facebook', isEmployee: false })).toBe(true));
  it('false for employee', () => expect(shouldFetchFbOlder({ channel: 'facebook', isEmployee: true })).toBe(false));
  it('true for an employee on a Page', () => expect(shouldFetchFbOlder({ channel: 'facebook', isEmployee: true, isPage: true })).toBe(true));
  it('false for an employee on a personal Facebook account', () => expect(shouldFetchFbOlder({ channel: 'facebook', isEmployee: true, isPage: false })).toBe(false));
  it('false for an employee on a Zalo Page flag', () => expect(shouldFetchFbOlder({ channel: 'zalo', isEmployee: true, isPage: true })).toBe(false));
  // Từ 26.44.0 tài khoản Page (kênh facebook) cũng kéo lên tải tin cũ được.
  it('true for a Facebook Page account', () => expect(shouldFetchFbOlder({ channel: 'facebook', isEmployee: false })).toBe(true));
  it.each(['zalo', 'telegram_user', undefined])('false for channel %s', (channel) =>
    expect(shouldFetchFbOlder({ channel, isEmployee: false })).toBe(false));
});

describe('fbOlderAnchor', () => {
  it('picks the oldest message and skips temp_ ones', () => {
    expect(fbOlderAnchor([
      { msg_id: 'mid.$b', timestamp: 200 },
      { msg_id: 'temp_1', timestamp: 50 },
      { msg_id: 'mid.$a', timestamp: 100 },
    ])).toEqual({ beforeTimestampMs: 100, beforeMessageId: 'mid.$a' });
  });
  it('ignores messages without a valid timestamp', () => {
    expect(fbOlderAnchor([{ msg_id: 'x' }, { msg_id: 'y', timestamp: 0 }, { msg_id: 'z', timestamp: 9 }]))
      .toEqual({ beforeTimestampMs: 9, beforeMessageId: 'z' });
  });
  it('null for empty or only temp', () => {
    expect(fbOlderAnchor([])).toBeNull();
    expect(fbOlderAnchor([{ msg_id: 'temp_1', timestamp: 5 }])).toBeNull();
  });
});

describe('interpretFbOlderResult', () => {
  it('loaded with more', () => expect(interpretFbOlderResult(ok())).toEqual({ kind: 'loaded', hasMore: true }));
  it('loaded, no more when hasMoreBefore=false', () =>
    expect(interpretFbOlderResult(ok({ hasMoreBefore: false }))).toEqual({ kind: 'loaded', hasMore: false }));
  it('loaded, no more when nothing stored', () =>
    expect(interpretFbOlderResult(ok({ stored: 0 }))).toEqual({ kind: 'loaded', hasMore: false }));
  it('E2EE stops with note', () =>
    expect(interpretFbOlderResult(fail('E2EE'))).toEqual({ kind: 'stop', note: FB_E2EE_HISTORY_NOTE }));
  it('RISK stops with warn', () =>
    expect(interpretFbOlderResult(fail('RISK', 'dừng'))).toEqual({ kind: 'stop', warn: 'dừng' }));
  it.each(['NOT_CONNECTED', 'BRIDGE_DOWN', 'BUSY', 'COOLDOWN', 'CANCELLED'])('%s is temporary (later)', (code) =>
    expect(interpretFbOlderResult(fail(code))).toEqual({ kind: 'later' }));
  it('BRIDGE_OLD stops silently', () =>
    expect(interpretFbOlderResult(fail('BRIDGE_OLD'))).toEqual({ kind: 'stop' }));
  it.each([fail('FETCH'), null, undefined])('retry for %p', (res) =>
    expect(interpretFbOlderResult(res as any)).toEqual({ kind: 'retry' }));
});

describe('fbHistoryTriedKey', () => {
  it('is stable and distinct per account/thread', () => {
    expect(fbHistoryTriedKey('a', 't')).toBe(fbHistoryTriedKey('a', 't'));
    expect(fbHistoryTriedKey('a', 't')).not.toBe(fbHistoryTriedKey('b', 't'));
    expect(fbHistoryTriedKey('a', 'bt')).not.toBe(fbHistoryTriedKey('ab', 't'));
  });
});

describe('rowsFromGetMessages', () => {
  it('reads messages (boss) or items (employee)', () => {
    expect(rowsFromGetMessages({ success: true, messages: [1, 2] })).toEqual([1, 2]);
    expect(rowsFromGetMessages({ items: [3] })).toEqual([3]);
  });
  it('empty for null / missing / non-array', () => {
    expect(rowsFromGetMessages(null)).toEqual([]);
    expect(rowsFromGetMessages({})).toEqual([]);
    expect(rowsFromGetMessages({ messages: 'x' })).toEqual([]);
  });
});

describe('shouldShowFbProbeButton', () => {
  const base = { note: FB_E2EE_HISTORY_NOTE, isEmployee: false, isPage: false, probeClosed: false };
  it('shows beside the encrypted note on a boss/standalone personal account', () => expect(shouldShowFbProbeButton(base)).toBe(true));
  it.each([
    ['another note', { note: 'khac' }], ['no note', { note: null }], ['employee', { isEmployee: true }],
    ['page', { isPage: true }], ['closed', { probeClosed: true }],
  ])('hidden for %s', (_n, over) => expect(shouldShowFbProbeButton({ ...base, ...over } as any)).toBe(false));
});

describe('interpretFbProbeResult', () => {
  it('loaded keeps hasMore', () => {
    expect(interpretFbProbeResult(ok())).toEqual({ kind: 'loaded', hasMore: true });
    expect(interpretFbProbeResult(ok({ hasMoreBefore: false }))).toEqual({ kind: 'loaded', hasMore: false });
  });
  it('E2EE means nothing came back and closes the button', () => {
    const o = interpretFbProbeResult(fail('E2EE'));
    expect(o).toEqual({ kind: 'empty', note: 'Không tải được tin nào từ trước khi mã hoá.' });
    expect(closesFbProbe(o)).toBe(true);
  });
  it('RISK warns with the result text and keeps the button', () => {
    const o = interpretFbProbeResult(fail('RISK', 'dừng'));
    expect(o).toEqual({ kind: 'warn', text: 'dừng' });
    expect(closesFbProbe(o)).toBe(false);
  });
  it.each(['NOT_CONNECTED', 'BRIDGE_DOWN', 'BUSY', 'COOLDOWN', 'CANCELLED'])('%s is temporary and keeps the button', (code) => {
    const o = interpretFbProbeResult(fail(code));
    expect(o).toEqual({ kind: 'later', notify: 'Chưa thử được lúc này, hãy thử lại sau.' });
    expect(closesFbProbe(o)).toBe(false);
  });
  it.each([fail('FETCH'), fail('BRIDGE_OLD'), null, undefined])('anything else fails and closes the button (%p)', (res) => {
    const o = interpretFbProbeResult(res as any);
    expect(o).toEqual({ kind: 'failed', notify: 'Không tải được, hãy thử lại sau.' });
    expect(closesFbProbe(o)).toBe(true);
  });
});
