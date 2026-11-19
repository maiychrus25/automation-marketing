import {
  PAIR_WINDOW_MS, createSenderResolver, findPresentMessages, identifySelf, matchChatToThread, normalizeText, resolveThreadConflicts, stableMessageIds,
  type LocalMessageRow,
} from '../../../services/facebook/e2eeExport/exportMatcher';
import type { ExportChat, ExportMessage } from '../../../services/facebook/e2eeExport/exportParser';

const T = 1_700_000_000_000;
const row = (id: string, thread: string, text: string | null, ts: number, extra: Partial<LocalMessageRow> = {}): LocalMessageRow => ({
  id, thread_id: thread, sender_id: extra.is_self ? 'owner-1' : `u-${thread}`, sender_name: '', body: text, timestamp: ts, is_self: 0, is_unsent: 0, type: 'text', ...extra,
});
const msg = (sender: string, text: string, ts: number, extra: Partial<ExportMessage> = {}): ExportMessage => ({
  senderName: sender, text, timestamp: ts, isUnsent: false, media: [], reactions: [], ...extra,
});
const chat = (messages: ExportMessage[], participants = ['Alice Example', 'Bob Example'], threadName = 'Alice Example'): ExportChat =>
  ({ threadName, participants, messages, malformedSkipped: 0 });
const sorted = (rows: LocalMessageRow[]) => [...rows].sort((a, b) => a.timestamp - b.timestamp);

describe('normalizeText', () => {
  it('applies NFC, trims and collapses whitespace', () => {
    expect(normalizeText('  á   b\n\tc ')).toBe('á b c');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('matchChatToThread', () => {
  const two = [msg('Alice Example', 'hello-1', T), msg('Bob Example', 'hello-2', T + 5000)];

  it('resolves two chats with the same threadName to different threads by overlap', () => {
    const local = sorted([row('a1', 'A', 'hello-1', T), row('a2', 'A', 'hello-2', T + 5000), row('b1', 'B', 'other-1', T + 100_000), row('b2', 'B', 'other-2', T + 110_000)]);
    const c1 = chat(two, undefined, 'Same Name');
    const c2 = chat([msg('Alice Example', 'other-1', T + 100_000), msg('Bob Example', 'other-2', T + 110_000)], undefined, 'Same Name');
    expect(matchChatToThread(c1, local)!.threadId).toBe('A');
    expect(matchChatToThread(c2, local)!.threadId).toBe('B');
  });

  it('is unmatched on a tie between threads', () => {
    const local = sorted([row('a1', 'A', 'hello-1', T), row('a2', 'A', 'hello-2', T + 5000), row('b1', 'B', 'hello-1', T), row('b2', 'B', 'hello-2', T + 5000)]);
    expect(matchChatToThread(chat(two), local)).toBeNull();
  });

  it('is unmatched when the runner-up has more than half of the best score', () => {
    const four = [1, 2, 3, 4].map(i => msg('Alice Example', `hello-${i}`, T + i * 1000));
    const local = sorted([
      ...[1, 2, 3, 4].map(i => row(`a${i}`, 'A', `hello-${i}`, T + i * 1000)), ...[1, 2, 3].map(i => row(`b${i}`, 'B', `hello-${i}`, T + i * 1000)),
    ]);
    expect(matchChatToThread(chat(four), local)).toBeNull();
    expect(matchChatToThread(chat(four), local.filter(r => r.id !== 'b3' && r.id !== 'b2'))!.threadId).toBe('A');
  });

  it('is unmatched on a single short pair and matched on a single long pair without a rival', () => {
    expect(matchChatToThread(chat([msg('Alice Example', 'hi', T)]), [row('a1', 'A', 'hi', T)])).toBeNull();
    const long = chat([msg('Alice Example', 'hello-1', T)]);
    expect(matchChatToThread(long, [row('a1', 'A', 'hello-1', T)])!.threadId).toBe('A');
    expect(matchChatToThread(long, sorted([row('a1', 'A', 'hello-1', T), row('b1', 'B', 'hello-1', T + 10)]))).toBeNull();
  });

  it('pairs messages 4 s apart but not 6 s apart', () => {
    const c = chat([msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-2', T + 1000)]);
    expect(PAIR_WINDOW_MS).toBe(5000);
    expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T + 4000), row('a2', 'A', 'hello-2', T + 1000 - 4000)]))!.score).toBe(2);
    expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T + 6000), row('a2', 'A', 'hello-2', T + 1000 - 6000)]))).toBeNull();
  });

  it('is unmatched when the chat only pairs with local self rows', () => {
    const c = chat([msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-2', T + 1000)]);
    expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T, { is_self: 1 }), row('a2', 'A', 'hello-2', T + 1000, { is_self: 1 })]))).toBeNull();
  });

  describe('coverage rule', () => {
    const c = chat([msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-2', T + 1000), msg('Alice Example', 'last-msg', T + 100_000)]);
    it('rejects a thread whose other received text rows in the span are mostly unpaired', () => {
      const others = Array.from({ length: 10 }, (_, i) => row(`o${i}`, 'A', `other-${i}`, T + 2000 + i * 5000));
      expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T), row('a2', 'A', 'hello-2', T + 1000), ...others]))).toBeNull();
    });
    it('still matches when the unpaired rows were sent from MaiHub (is_self = 1)', () => {
      const sent = Array.from({ length: 12 }, (_, i) => row(`s${i}`, 'A', `sent-${i}`, T + 2000 + i * 5000, { is_self: 1 }));
      expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T), row('a2', 'A', 'hello-2', T + 1000), ...sent]))!.threadId).toBe('A');
    });
    it('ignores unsent, non-text and empty rows and rows outside the chat span', () => {
      const noise = [row('u', 'A', 'x1', T + 2000, { is_unsent: 1 }), row('i', 'A', 'x2', T + 3000, { type: 'image' }), row('e', 'A', '', T + 4000),
        row('far', 'A', 'x3', T + 500_000)];
      expect(matchChatToThread(c, sorted([row('a1', 'A', 'hello-1', T), row('a2', 'A', 'hello-2', T + 1000), ...noise]))!.threadId).toBe('A');
    });
  });

  it('never counts empty text or reuses a local row twice', () => {
    const c = chat([msg('Alice Example', '', T), msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-1', T + 1000)]);
    const m = matchChatToThread(c, [row('a1', 'A', '', T), row('a2', 'A', 'hello-1', T)]);
    expect(m!.score).toBe(1);
  });

  it('never matches by names', () => {
    expect(matchChatToThread(chat(two, ['A', 'B'], 'A'), [row('a1', 'A', 'unrelated', T)])).toBeNull();
  });
});

describe('resolveThreadConflicts', () => {
  const m = (threadId: string, score: number) => ({ threadId, score, pairs: [], bestText: '' });
  it('keeps the higher score when two chats claim one thread and skips both on a tie', () => {
    expect(resolveThreadConflicts([m('A', 3), m('A', 2), m('B', 2)])).toEqual([m('A', 3), null, m('B', 2)]);
    expect(resolveThreadConflicts([m('A', 2), m('A', 2), null])).toEqual([null, null, null]);
  });
});

describe('identifySelf', () => {
  const c = chat([msg('Alice Example', 'hello-1', T), msg('Bob Example', 'hello-2', T + 5000)]);
  const pair = (i: number, local: LocalMessageRow) => ({ exportIndex: i, local });

  it('uses the sender of messages paired with local self rows', () => {
    expect(identifySelf({ chat: c, pairs: [pair(0, row('a', 'A', 'hello-1', T, { is_self: 1 }))], isGroup: false, accountName: 'Zed' })).toBe('Alice Example');
  });
  it('falls back instead of returning unknown on a tie between two self names', () => {
    const g = chat(c.messages, ['Alice Example', 'Bob Example', 'Cara Example']);
    expect(identifySelf({ chat: g, pairs: [pair(0, row('a', 'A', 'x', T, { is_self: 1 })), pair(1, row('b', 'A', 'y', T, { is_self: 1 }))], isGroup: true, accountName: 'Cara Example' })).toBe('Cara Example');
  });
  it('survives one cross-direction mispair thanks to the votes', () => {
    // Self is Alice; the file only holds Bob's messages. m1 is paired with a local SELF row (identical text sent by the account), m2 and m3 with received rows.
    const two = chat([msg('Bob Example', 'm1-text', T), msg('Bob Example', 'm2-text', T + 2000), msg('Bob Example', 'm3-text', T + 4000)]);
    const pairs = [pair(0, row('x', 'A', 'm1-text', T, { is_self: 1 })), pair(1, row('y', 'A', 'm2-text', T + 2000)), pair(2, row('z', 'A', 'm3-text', T + 4000))];
    expect(identifySelf({ chat: two, pairs, isGroup: false, accountName: '' })).toBe('Alice Example');
  });
  it('does not pick the account display name when that name has at least as many votes against as for', () => {
    const g = chat([msg('Cara Example', 'a1', T), msg('Bob Example', 'b1', T + 1000)], ['Alice Example', 'Bob Example', 'Cara Example']);
    const received = [pair(0, row('p', 'A', 'a1', T)), pair(1, row('q', 'A', 'b1', T + 1000))];
    expect(identifySelf({ chat: g, pairs: received, isGroup: true, accountName: 'Cara Example' })).toBeNull();
    expect(identifySelf({ chat: g, pairs: [received[1]], isGroup: true, accountName: 'Cara Example' })).toBe('Cara Example');
  });
  it('requires the self name to be a participant', () => {
    const outsider = chat([msg('Ghost Example', 'hello-1', T)]);
    expect(identifySelf({ chat: outsider, pairs: [pair(0, row('a', 'A', 'hello-1', T, { is_self: 1 }))], isGroup: false, accountName: '' })).toBeNull();
  });
  it('falls back for a 1:1 chat to the participant who is not the received sender', () => {
    expect(identifySelf({ chat: c, pairs: [pair(1, row('b', 'A', 'hello-2', T + 5000))], isGroup: false, accountName: '' })).toBe('Alice Example');
  });
  it('falls back for a group to the account display name', () => {
    const g = chat(c.messages, ['Alice Example', 'Bob Example', 'Cara Example']);
    expect(identifySelf({ chat: g, pairs: [pair(1, row('b', 'A', 'hello-2', T + 5000))], isGroup: true, accountName: ' Cara  Example ' })).toBe('Cara Example');
  });
  it('is unknown when nothing identifies self', () => {
    expect(identifySelf({ chat: chat(c.messages, ['Alice Example', 'Bob Example', 'Cara Example']), pairs: [], isGroup: true, accountName: 'Zed' })).toBeNull();
    expect(identifySelf({ chat: c, pairs: [], isGroup: false, accountName: 'Zed' })).toBeNull();
  });
});

describe('createSenderResolver', () => {
  const g = chat([msg('Bob Example', 'hello-1', T)], ['Alice Example', 'Bob Example', 'Cara Example', 'Dan Example']);
  const rows = [
    row('1', 'G', 'x', T, { sender_id: 'id-bob', sender_name: 'Bob Example' }), row('2', 'G', 'y', T, { sender_id: 'id-cara1', sender_name: 'Cara Example' }),
    row('3', 'G', 'z', T, { sender_id: 'id-cara2', sender_name: 'Cara Example' }),
  ];
  it('maps a unique group name to an id, self to the owner, and leaves ambiguous or unknown names empty', () => {
    const r = createSenderResolver({ chat: g, pairs: [], threadRows: rows, threadId: 'G', isGroup: true, selfName: 'Alice Example', ownerId: 'owner-1' });
    expect(r.senderIdFor('Bob Example')).toBe('id-bob');
    expect(r.senderIdFor('Alice Example')).toBe('owner-1');
    expect(r.senderIdFor('Cara Example')).toBe('');
    expect(r.senderIdFor('Dan Example')).toBe('');
  });
  it('uses the thread id for the other person of a 1:1 chat', () => {
    const r = createSenderResolver({ chat: chat([]), pairs: [], threadRows: [], threadId: '555', isGroup: false, selfName: 'Alice Example', ownerId: 'owner-1' });
    expect(r.senderIdFor('Bob Example')).toBe('555');
    expect(r.isSelf('Alice Example')).toBe(true);
    expect(r.isSelf('Bob Example')).toBe(false);
  });
  it('never learns an e2ee-name sender id from pairs or thread rows', () => {
    const imported = [row('1', 'G', 'x', T, { sender_id: 'e2ee-name:Cara Example', sender_name: 'Cara Example' })];
    const r = createSenderResolver({ chat: g, pairs: [{ exportIndex: 0, local: row('9', 'G', 'hello-1', T, { sender_id: 'e2ee-name:Bob Example' }) }], threadRows: imported, threadId: 'G', isGroup: true, selfName: null, ownerId: 'owner-1' });
    expect(r.senderIdFor('Cara Example')).toBe('');
    expect(r.senderIdFor('Bob Example')).toBe('');
  });
  it('learns names from pairs', () => {
    const r = createSenderResolver({ chat: g, pairs: [{ exportIndex: 0, local: row('9', 'G', 'hello-1', T, { sender_id: 'id-pair' }) }], threadRows: [], threadId: 'G', isGroup: true, selfName: null, ownerId: 'owner-1' });
    expect(r.senderIdFor('Bob Example')).toBe('id-pair');
  });
});

describe('findPresentMessages', () => {
  it('pairs text messages one-to-one with matching direction when self is known', () => {
    const c = chat([msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-1', T + 2000), msg('Bob Example', 'hello-2', T + 4000)]);
    const local = [row('a', 'A', 'hello-1', T + 500, { is_self: 1 }), row('b', 'A', 'hello-2', T + 4000, { is_self: 1 })];
    expect([...findPresentMessages(c, local, 'Alice Example')]).toEqual([0]);
    expect([...findPresentMessages(c, local, null)].sort()).toEqual([0, 2]);
  });
  it('pairs messages without text with unpaired empty, unsent or non-text local rows', () => {
    const c = chat([msg('Bob Example', '', T, { media: ['m/a.jpg'] }), msg('Bob Example', '', T + 1000, { isUnsent: true }), msg('Bob Example', '', T + 2000, { media: ['m/b.jpg'] }), msg('Bob Example', '', T + 3000, { media: ['m/c.jpg'] })]);
    const local = [row('a', 'A', null, T + 10, { type: 'image' }), row('b', 'A', null, T + 1000, { is_unsent: 1 }), row('c', 'A', 'real text', T + 2000), row('d', 'A', '', T + 3000 + 6000)];
    expect([...findPresentMessages(c, local, 'Alice Example')].sort()).toEqual([0, 1]);
  });
});

describe('stableMessageIds', () => {
  it('is deterministic, never starts with mid. and separates identical tuples', () => {
    const ms = [msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-1', T), msg('Alice Example', 'hello-2', T)];
    const ids = stableMessageIds('acc-1', '555', ms);
    expect(ids).toEqual(stableMessageIds('acc-1', '555', ms));
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => /^e2ee-export\.[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(stableMessageIds('acc-1', '556', ms)[0]).not.toBe(ids[0]);
    expect(stableMessageIds('acc-2', '555', ms)[0]).not.toBe(ids[0]);
  });
});
