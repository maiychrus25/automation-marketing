import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { parseBinNet } from '../../services/zalo/mobileSync/binNet';
import {
  parseBackupFileName, iterateChatContent, countOutOfRange, rowToPlainMessage, collectPlainUserIds, toZaloMessage,
  MobileRow, PlainMessage, MOBILE_MSG_TYPES, EXCLUDED_MOBILE_MSG_TYPES,
} from '../../services/zalo/mobileSync/mobileMessageConverter';
import { buildBinNet, createChatContentDb, tlvBox, ChatContentFixtureRow } from './helpers/chatContentFixture';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-chatcontent-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const ME_PLAIN = '100000001';
const PEER_PLAIN = '200000002';
const THIRD_PLAIN = '300000003';
const ME_NOISE = '1111111111111111111';
const PEER_NOISE = '2222222222222222222';
const THIRD_NOISE = '3333333333333333333';
const THREAD_NOISE = '4444444444444444444';
const NOISE: Record<string, string> = { [ME_PLAIN]: ME_NOISE, [PEER_PLAIN]: PEER_NOISE, [THIRD_PLAIN]: THIRD_NOISE };
const resolveUser = (id: string) => NOISE[id] ?? '';
const ctx = (isGroup = false) => ({ threadNoiseId: isGroup ? '5555555555555555555' : PEER_NOISE, isGroup, ownNoiseId: ME_NOISE, resolveUser });

let seq = 0;
const row = (o: Partial<ChatContentFixtureRow> = {}): ChatContentFixtureRow => ({
  SenderId: PEER_PLAIN, CliMsgId: 1000 + ++seq, GlbMsgId: 5000 + seq, MsgType: 0, TimeStamp: 1_700_000_000_000 + seq, MsgContent: 'xin chào', ...o,
});
const openDb = (rows: ChatContentFixtureRow[]) => {
  const file = path.join(tmpDir, `t${++seq}.db`);
  createChatContentDb(file, rows);
  const db = new Database(file, { readonly: true });
  db.defaultSafeIntegers(true);
  return db;
};
const plainOf = (r: ChatContentFixtureRow): PlainMessage => {
  const db = openDb([r]);
  try {
    const [first] = Array.from(iterateChatContent(db, { fromTs: null, toTs: null }));
    return rowToPlainMessage(first)!;
  } finally { db.close(); }
};

describe('parseBackupFileName', () => {
  it('accepts user and group files', () => {
    expect(parseBackupFileName('123456789.db')).toEqual({ kind: 'user', plainId: '123456789' });
    expect(parseBackupFileName('group_987654321.db')).toEqual({ kind: 'group', plainId: '987654321' });
  });
  it.each(['0123.db', 'abc.db', 'group_.db', 'x.txt'])('rejects %s', (n) => expect(parseBackupFileName(n)).toBeNull());
});

describe('parseBinNet', () => {
  it('returns {} for empty and null for a corrupt blob', () => {
    expect(parseBinNet(null)).toEqual({});
    expect(parseBinNet(Buffer.alloc(0))).toEqual({});
    expect(parseBinNet(Buffer.from([0, 0, 0, 6, 0, 0, 0, 99, 1]))).toBeNull();
  });
  it('round-trips attach, quote and mentions', () => {
    const parsed = parseBinNet(buildBinNet({
      attachs: [{ href: 'https://example.zdn.vn/a.jpg', title: 't' }],
      quote: { ownerId: 7, globalMsgId: '9007199254740993', msg: 'q' },
      mentions: [{ uid: -1, pos: 0, len: 4, type: 1 }],
    }))!;
    expect(parsed.attachs![0]).toMatchObject({ href: 'https://example.zdn.vn/a.jpg', title: 't' });
    expect(parsed.quote!.globalMsgId).toBe('9007199254740993');
    expect(parsed.mentions![0]).toEqual({ uid: -1, pos: 0, len: 4, type: 1 });
  });
});

describe('iterateChatContent / countOutOfRange', () => {
  const T = 1_700_000_000_000;
  it('filters status, null CliMsgId and excluded types', () => {
    const excluded = [20, 21, 25, 26, 29, 32, 34, 35, 45, 51, 52];
    const db = openDb([
      row({ MsgContent: 'keep' }),
      row({ MsgStatus: 0 }), row({ MsgStatus: -1 }), row({ CliMsgId: null }),
      ...excluded.map(t => row({ MsgType: t })),
    ]);
    const rows = Array.from(iterateChatContent(db, { fromTs: null, toTs: null }));
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].MsgContent).toBe('keep');
  });
  it('range bounds are inclusive and out-of-range is counted', () => {
    const db = openDb([row({ TimeStamp: T - 1 }), row({ TimeStamp: T }), row({ TimeStamp: T + 5 }), row({ TimeStamp: T + 6 }), row({ MsgStatus: 0, TimeStamp: T - 9 })]);
    const range = { fromTs: T, toTs: T + 5 };
    const got = Array.from(iterateChatContent(db, range)).map(r => Number(r.TimeStamp));
    expect(got).toEqual([T, T + 5]);
    expect(countOutOfRange(db, range)).toBe(2);
    expect(countOutOfRange(db, { fromTs: null, toTs: null })).toBe(0);
    expect(Array.from(iterateChatContent(db, { fromTs: T + 6, toTs: null })).length).toBe(1);
    db.close();
  });
  it('does not throw and yields nothing when ChatContent is missing', () => {
    const file = path.join(tmpDir, `empty${++seq}.db`);
    new Database(file).close();
    const db = new Database(file, { readonly: true });
    expect(Array.from(iterateChatContent(db, { fromTs: null, toTs: null }))).toEqual([]);
    expect(countOutOfRange(db, { fromTs: 1, toTs: null })).toBe(0);
    db.close();
  });
  it('treats malicious range values as numbers, not SQL', () => {
    const db = openDb([row()]);
    const bad = { fromTs: '1; DROP TABLE ChatContent' as any, toTs: null };
    expect(() => Array.from(iterateChatContent(db, bad))).not.toThrow();
    expect(Array.from(iterateChatContent(db, { fromTs: null, toTs: null }))).toHaveLength(1);
    db.close();
  });
});

describe('rowToPlainMessage', () => {
  const asRow = (o: Partial<MobileRow>): MobileRow => ({ SenderId: 1, CliMsgId: 2, GlbMsgId: 3, MsgType: 0, TimeStamp: 4, TTL: 0, MsgContent: '', BinNet: null, ...o });
  it.each([[0, 'webchat'], [3, 'chat.photo'], [4, 'chat.photo'], [31, 'chat.photo'], [6, 'chat.voice'], [10, 'chat.sticker'],
    [12, 'chat.recommended'], [18, 'chat.location.new'], [19, 'chat.video.msg'], [22, 'share.file'], [23, 'chat.gif'], [36, 'chat.undo']])(
    'maps mobile type %i to %s', (t, web) => expect(rowToPlainMessage(asRow({ MsgType: t }))!.msgType).toBe(web));
  it('returns null for unknown types, chat.delete and corrupt BinNet', () => {
    expect(rowToPlainMessage(asRow({ MsgType: 999 }))).toBeNull();
    expect(rowToPlainMessage(asRow({ MsgType: 33 }))).toBeNull();
    expect(rowToPlainMessage(asRow({ BinNet: Buffer.from([0, 0, 0, 6, 0, 0, 0, 99, 1]) }))).toBeNull();
  });
  it('keeps 64-bit ids as exact decimal strings', () => {
    const p = plainOf(row({ GlbMsgId: '9223372036854775001', CliMsgId: '9007199254740993' }));
    expect(p.globalMsgId).toBe('9223372036854775001');
    expect(p.cliMsgId).toBe('9007199254740993');
  });
});

describe('toZaloMessage', () => {
  it('converts a plain text message in a 1-1 chat', () => {
    const m = toZaloMessage(plainOf(row({ GlbMsgId: 77, CliMsgId: 88, TimeStamp: 1_700_000_123_456 })), ctx())!;
    expect(m).toMatchObject({ type: 0, threadId: PEER_NOISE, isSelf: false, isRecalled: false });
    expect(m.data).toMatchObject({ msgId: '77', cliMsgId: '88', msgType: 'webchat', uidFrom: PEER_NOISE, idTo: ME_NOISE, ts: '1700000123456', content: 'xin chào' });
  });
  it('marks own messages and routes idTo to the thread', () => {
    const m = toZaloMessage(plainOf(row({ SenderId: ME_PLAIN })), ctx())!;
    expect(m.isSelf).toBe(true);
    expect(m.data.uidFrom).toBe(ME_NOISE);
    expect(m.data.idTo).toBe(PEER_NOISE);
  });
  it('builds a group message', () => {
    const g = ctx(true);
    const m = toZaloMessage(plainOf(row({ SenderId: THIRD_PLAIN })), g)!;
    expect(m).toMatchObject({ type: 1, threadId: g.threadNoiseId });
    expect(m.data.idTo).toBe(g.threadNoiseId);
    expect(m.data.uidFrom).toBe(THIRD_NOISE);
  });
  it('converts a photo attach to object content without catId', () => {
    const m = toZaloMessage(plainOf(row({ MsgType: 3, BinNet: buildBinNet({ attachs: [{ href: 'https://example.zdn.vn/a.jpg', thumb: 'https://example.zdn.vn/t.jpg', catId: 5, childNumber: 2 }] }) })), ctx())!;
    expect(m.data.msgType).toBe('chat.photo');
    expect(m.data.content).toMatchObject({ href: 'https://example.zdn.vn/a.jpg', thumb: 'https://example.zdn.vn/t.jpg', childnumber: 2 });
    expect(m.data.content.catId).toBeUndefined();
  });
  it('carries quotes with the owner converted', () => {
    const m = toZaloMessage(plainOf(row({ BinNet: buildBinNet({ quote: { ownerId: Number(THIRD_PLAIN), cliMsgId: 11, globalMsgId: 22, msg: 'trích', cliMsgType: 1, ts: 5 } }) })), ctx())!;
    expect(m.data.quote).toMatchObject({ ownerId: THIRD_NOISE, cliMsgId: '11', globalMsgId: '22', msg: 'trích' });
  });
  it('carries mentions, keeping uid -1 as "-1"', () => {
    const m = toZaloMessage(plainOf(row({ BinNet: buildBinNet({ mentions: [{ uid: -1, pos: 0, len: 4, type: 1 }, { uid: Number(THIRD_PLAIN), pos: 5, len: 3, type: 0 }] }) })), ctx(true))!;
    expect(m.data.mentions).toEqual([{ uid: '-1', pos: 0, len: 4, type: 1 }, { uid: THIRD_NOISE, pos: 5, len: 3, type: 0 }]);
  });
  it('converts a contact card params to the web id', () => {
    const m = toZaloMessage(plainOf(row({ MsgType: 12, BinNet: buildBinNet({ attachs: [{ action: 'recommened.user', params: THIRD_PLAIN, title: 'Tên' }] }) })), ctx())!;
    expect(m.data.content.params).toBe(THIRD_NOISE);
    expect(collectPlainUserIds([plainOf(row({ MsgType: 12, BinNet: buildBinNet({ attachs: [{ action: 'recommened.user', params: THIRD_PLAIN }] }) }))])).toEqual(expect.arrayContaining([THIRD_PLAIN, PEER_PLAIN]));
  });
  it('marks recalled messages with empty content', () => {
    const m = toZaloMessage(plainOf(row({ MsgType: 36, MsgContent: 'x' })), ctx())!;
    expect(m.isRecalled).toBe(true);
    expect(m.data.content).toBe('');
  });
  it('returns null for chat.delete, unresolved sender and corrupt BinNet', () => {
    expect(rowToPlainMessage({ SenderId: 1, CliMsgId: 2, GlbMsgId: 3, MsgType: 33, TimeStamp: 4, TTL: 0, MsgContent: '', BinNet: null })).toBeNull();
    expect(toZaloMessage(plainOf(row({ SenderId: '999999999' })), ctx())).toBeNull();
  });
  it('uses mb_<CliMsgId> when GlbMsgId is 0', () => {
    expect(toZaloMessage(plainOf(row({ GlbMsgId: 0, CliMsgId: 4242 })), ctx())!.data.msgId).toBe('mb_4242');
  });
  it('keeps digits of ids above 2^53', () => {
    const m = toZaloMessage(plainOf(row({ GlbMsgId: '9223372036854775001', CliMsgId: '9007199254740993' })), ctx())!;
    expect(m.data.msgId).toBe('9223372036854775001');
    expect(m.data.cliMsgId).toBe('9007199254740993');
  });
});

describe('collectPlainUserIds', () => {
  it('collects senders, mentions and quote owners without duplicates', () => {
    const msgs = [
      plainOf(row({ BinNet: buildBinNet({ mentions: [{ uid: -1 }, { uid: Number(THIRD_PLAIN) }], quote: { ownerId: Number(ME_PLAIN), globalMsgId: 1 } }) })),
      plainOf(row()),
    ];
    expect(collectPlainUserIds(msgs).sort()).toEqual([ME_PLAIN, PEER_PLAIN, THIRD_PLAIN].sort());
  });
});

// ─── Bảng port: chốt từng mục, tag viết tay (đọc từ bảng upstream, không import hằng của reader) ─────────
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const i64 = (n: number | string) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b; };
const s8 = (v: string) => Buffer.from(v, 'utf8');
const attachBlob = (entries: Array<[number, Buffer]>) => tlvBox([[0x06, tlvBox(entries)]]);

describe('port tables', () => {
  const WEB_BY_MOBILE: Record<number, string> = {
    0: 'webchat', 2: 'chat.doodle', 3: 'chat.photo', 4: 'chat.photo', 6: 'chat.voice', 10: 'chat.sticker',
    12: 'chat.recommended', 15: 'chat.list.action', 18: 'chat.location.new', 19: 'chat.video.msg', 20: 'webchat',
    22: 'share.file', 23: 'chat.gif', 24: 'chat.webcontent', 25: 'chat.video.live.msg', 26: 'group.poll',
    31: 'chat.photo', 33: 'chat.delete', 36: 'chat.undo', 53: 'chat.webcontent.v2',
  };
  it('mobile -> web type map has exactly the 20 upstream entries', () => {
    expect(MOBILE_MSG_TYPES).toEqual(WEB_BY_MOBILE);
    expect(Object.keys(WEB_BY_MOBILE)).toHaveLength(20);
  });
  it.each(Object.entries(WEB_BY_MOBILE).filter(([, w]) => w !== 'chat.delete'))('rowToPlainMessage maps %s -> %s', (t, web) => {
    expect(rowToPlainMessage({ SenderId: 1, CliMsgId: 2, GlbMsgId: 3, MsgType: Number(t), TimeStamp: 4, TTL: 0, MsgContent: '', BinNet: null })!.msgType).toBe(web);
  });
  it('excluded type list is the upstream list and iterateChatContent drops each', () => {
    expect(EXCLUDED_MOBILE_MSG_TYPES).toEqual([20, 21, 25, 26, 29, 32, 34, 35, 45, 51, 52]);
    const db = openDb([row({ MsgContent: 'keep' }), ...[20, 21, 25, 26, 29, 32, 34, 35, 45, 51, 52].map(t => row({ MsgType: t }))]);
    const got = Array.from(iterateChatContent(db, { fromTs: null, toTs: null })).map(r => Number(r.MsgType));
    db.close();
    expect(got).toEqual([0]);
  });
});

describe('content rules', () => {
  const content = (r: Partial<ChatContentFixtureRow>) => toZaloMessage(plainOf(row(r)), ctx())?.data.content;
  const U = 'https://example.zdn.vn/x';

  it('webchat keeps plain text as string, rich text (rtf) as object with title fallback', () => {
    expect(content({ MsgContent: 'chào' })).toBe('chào');
    const c = content({ MsgContent: 'nội dung rtf', BinNet: attachBlob([[0x2d, s8('rtf')], [0x2e, s8('{"s":1}')]]) });
    expect(c).toEqual({ action: 'rtf', params: '{"s":1}', title: 'nội dung rtf' });
  });
  it('chat.webcontent needs pcItem in params, otherwise the message is dropped', () => {
    const withItem = content({ MsgType: 24, BinNet: attachBlob([[0x2e, s8('{"pcItem":{}}')], [0x2d, s8('open')], [0x2f, s8('T')]]) });
    expect(withItem).toMatchObject({ params: '{"pcItem":{}}', action: 'open', title: 'T', childnumber: 0, description: '', href: '', thumb: '' });
    expect(toZaloMessage(plainOf(row({ MsgType: 24, BinNet: attachBlob([[0x2e, s8('{"x":1}')]]) })), ctx())).toBeNull();
    expect(toZaloMessage(plainOf(row({ MsgType: 24 })), ctx())).toBeNull();
  });
  it('chat.webcontent.v2 exposes zinstant_msg / zinstant_data / action', () => {
    expect(content({ MsgType: 53, BinNet: attachBlob([[0x44, s8('MSG')], [0x43, s8('DATA')], [0x2d, s8('act')]]) }))
      .toEqual({ zinstant_msg: 'MSG', zinstant_data: 'DATA', action: 'act' });
  });
  it('chat.list.action keeps all attachs as an array', () => {
    const blob = tlvBox([[0x06, tlvBox([[0x2f, s8('A')]])], [0x06, tlvBox([[0x2f, s8('B')]])]]);
    expect(content({ MsgType: 15, BinNet: blob })).toEqual([{ title: 'A' }, { title: 'B' }]);
  });
  it('sticker keeps ids including catId', () => {
    expect(content({ MsgType: 10, BinNet: attachBlob([[0x29, i32(7)], [0x2a, i32(99)], [0x28, s8('webp')]]) }))
      .toEqual({ catId: 7, id: 99, type: 'webp' });
  });
  it('voice / video / location / file / gif / doodle default their listed string fields and childnumber', () => {
    const base = { childnumber: 0 };
    expect(content({ MsgType: 6, BinNet: attachBlob([[0x30, s8(U)], [0x2e, s8('{"d":1}')]]) }))
      .toEqual({ ...base, href: U, params: '{"d":1}', action: '', description: '', thumb: '', title: '', type: '' });
    expect(content({ MsgType: 19, BinNet: attachBlob([[0x30, s8(U)], [0x31, s8(U + 't')]]) }))
      .toEqual({ ...base, href: U, thumb: U + 't', action: '', description: '', type: '' });
    expect(content({ MsgType: 18, BinNet: attachBlob([[0x2f, s8('Vị trí')]]) }))
      .toEqual({ ...base, title: 'Vị trí', action: '', href: '', thumb: '', type: '' });
    expect(content({ MsgType: 22, BinNet: attachBlob([[0x2f, s8('f.pdf')], [0x30, s8(U)], [0x2c, i32(3)]]) }))
      .toEqual({ title: 'f.pdf', href: U, childnumber: 3, action: '', description: '', thumb: '', type: '' });
    expect(content({ MsgType: 23, BinNet: attachBlob([[0x30, s8(U)]]) }))
      .toEqual({ ...base, href: U, action: '', description: '', title: '', type: '' });
    expect(content({ MsgType: 2, BinNet: attachBlob([[0x30, s8(U)]]) }))
      .toEqual({ ...base, href: U, action: '', description: '', thumb: '', title: '' });
  });
});

describe('parseBinNet raw tags', () => {
  it('reads property 0x05 (0x1e..0x22) and reference 0x0b (0xaa, 0xab)', () => {
    const blob = tlvBox([
      [0x05, tlvBox([[0x1e, i32(10)], [0x1f, i32(2)], [0x20, i32(3)], [0x21, s8('png')], [0x22, i32(255)]])],
      [0x0b, tlvBox([[0xaa, i32(4)], [0xab, s8('ref-data')]])],
    ]);
    expect(parseBinNet(blob)).toEqual({
      property: { size: 10, subType: 2, type: 3, ext: 'png', color: 255 },
      reference: { type: 4, data: 'ref-data' },
    });
  });
  it('reads every attach tag', () => {
    const blob = attachBlob([
      [0x28, s8('t')], [0x29, i32(1)], [0x2a, i32(2)], [0x2b, s8('ext')], [0x2c, i32(3)], [0x2d, s8('act')], [0x2e, s8('par')],
      [0x2f, s8('ti')], [0x30, s8('hr')], [0x31, s8('th')], [0x32, s8('de')], [0x42, s8('re')], [0x43, s8('zd')], [0x44, s8('zm')],
    ]);
    expect(parseBinNet(blob)!.attachs![0]).toEqual({
      type: 't', catId: 1, id: 2, extInfo: 'ext', childNumber: 3, action: 'act', params: 'par', title: 'ti', href: 'hr',
      thumb: 'th', description: 'de', remains: 're', zinstantData: 'zd', zinstantMsg: 'zm',
    });
  });
  it('reads every quote tag', () => {
    const blob = tlvBox([[0x07, tlvBox([
      [0x50, i32(5)], [0x51, i64('9007199254740993')], [0x52, i64(22)], [0x53, i32(6)], [0x54, i64(1700000000000)], [0x55, i64(30)],
      [0x56, s8('m')], [0x57, s8('a')], [0x58, s8('f')], [0x5a, s8('qs')],
    ])]]);
    expect(parseBinNet(blob)!.quote).toEqual({
      ownerId: 5, cliMsgId: '9007199254740993', globalMsgId: '22', cliMsgType: 6, ts: 1700000000000, ttl: 30,
      msg: 'm', attach: 'a', fromD: 'f', quoteStatus: 'qs',
    });
  });
  it('reads mention tags 0x64..0x67', () => {
    const blob = tlvBox([[0x08, tlvBox([[0x64, i32(1)], [0x65, i32(-1)], [0x66, i32(2)], [0x67, i32(3)]])]]);
    expect(parseBinNet(blob)!.mentions).toEqual([{ type: 1, uid: -1, pos: 2, len: 3 }]);
  });
});

describe('own-id contract', () => {
  it('isSelf when resolveUser maps the sender to ownNoiseId; null when it returns ""', () => {
    const p = plainOf(row({ SenderId: ME_PLAIN }));
    expect(toZaloMessage(p, { ...ctx(), resolveUser: (id) => (id === ME_PLAIN ? ME_NOISE : '') })!.isSelf).toBe(true);
    expect(toZaloMessage(p, { ...ctx(), resolveUser: () => '' })).toBeNull();
  });
});
