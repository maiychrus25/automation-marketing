import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-zalo-read-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';
import Logger from '../../utils/Logger';
import {
  applyZaloClearUnread,
  attachZaloReadElsewhere,
  decodeWsEventData,
  extractClearUnreads,
} from '../../services/zalo/zaloReadElsewhere';

const KEY = crypto.randomBytes(32);
const KEY_B64 = KEY.toString('base64');
const PAYLOAD = {
  data: {
    clearUnreads: [
      { idTo: '1001', isGroup: 0, lastMsgId: 'm5', ts: 1, type: 0 },
      { idTo: '1002', isGroup: 0, lastMsgId: '', ts: 1, type: 0 },
    ],
  },
};
const json = JSON.stringify(PAYLOAD);

function encode(encrypt: number): string {
  if (encrypt === 0) return json;
  const body = encrypt === 3 ? Buffer.from(json) : zlib.deflateSync(Buffer.from(json));
  if (encrypt === 1) return body.toString('base64');
  const iv = crypto.randomBytes(16);
  const aad = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(body), cipher.final()]);
  const packed = Buffer.concat([iv, aad, enc, cipher.getAuthTag()]);
  return encodeURIComponent(packed.toString('base64'));
}

function frame(cmd: number, encrypt: number, opts: { version?: number; raw?: string } = {}): Buffer {
  const head = Buffer.from([opts.version ?? 1, cmd & 0xff, cmd >> 8, 0]);
  const text = opts.raw ?? JSON.stringify({ data: encode(encrypt), encrypt });
  return Buffer.concat([head, Buffer.from(text)]);
}

describe('decodeWsEventData / extractClearUnreads', () => {
  test.each([0, 1, 2, 3])('encrypt %i decodes to the same list', (encrypt) => {
    // encrypt 3 = AES-GCM without compression
    const items = extractClearUnreads(frame(504, encrypt), KEY_B64);
    expect(items).toEqual([
      { threadId: '1001', isGroup: false, lastMsgId: 'm5' },
      { threadId: '1002', isGroup: false, lastMsgId: '' },
    ]);
  });

  test('decodeWsEventData returns null for malformed envelope', () => {
    expect(decodeWsEventData({ data: 1, encrypt: 0 }, KEY_B64)).toBeNull();
    expect(decodeWsEventData({ data: 'x', encrypt: 2 }, null)).toBeNull();
  });

  test('cmd 524 marks groups; other cmd, short frame and version != 1 give []', () => {
    expect(extractClearUnreads(frame(524, 0), KEY_B64).every((i) => i.isGroup)).toBe(true);
    expect(extractClearUnreads(frame(501, 0), KEY_B64)).toEqual([]);
    expect(extractClearUnreads(Buffer.from([1, 0xf8, 1]), KEY_B64)).toEqual([]);
    expect(extractClearUnreads(frame(504, 0, { version: 2 }), KEY_B64)).toEqual([]);
  });

  test('drops type != 0 and invalid idTo', () => {
    const list = [
      { idTo: '-1', type: 0 }, { idTo: '0', type: 0 }, { idTo: 'abc', type: 0 },
      { idTo: '55', type: 2 }, { idTo: '77', type: 0, lastMsgId: 'x' },
    ];
    const raw = JSON.stringify({ data: JSON.stringify({ data: { clearUnreads: list } }), encrypt: 0 });
    expect(extractClearUnreads(frame(504, 0, { raw }), KEY_B64)).toEqual([
      { threadId: '77', isGroup: false, lastMsgId: 'x' },
    ]);
  });
});

describe('attachZaloReadElsewhere', () => {
  function fakeApi() {
    const handlers: Record<string, Function[]> = {};
    const mkWs = () => {
      const h: Function[] = [];
      return { h, on: (_e: string, f: Function) => h.push(f), off: (_e: string, f: Function) => { h.splice(h.indexOf(f), 1); } };
    };
    const listener: any = {
      cipherKey: KEY_B64,
      ws: mkWs(),
      on: (e: string, f: Function) => { (handlers[e] ||= []).push(f); },
      off: (e: string, f: Function) => { handlers[e] = (handlers[e] || []).filter((x) => x !== f); },
    };
    return { api: { listener }, listener, handlers, mkWs };
  }

  test('delivers items and rebinds to the new socket on connected', () => {
    const { api, listener, handlers, mkWs } = fakeApi();
    const got: any[] = [];
    attachZaloReadElsewhere('acc1', api, (items) => got.push(...items));
    const oldWs = listener.ws;
    oldWs.h[0](frame(504, 0));
    expect(got).toHaveLength(2);

    listener.ws = mkWs();
    handlers.connected.forEach((f) => f());
    expect(oldWs.h).toHaveLength(0);
    expect(listener.ws.h).toHaveLength(1);
    listener.ws.h[0](frame(524, 0));
    expect(got).toHaveLength(4);
  });

  test('re-attach for same account detaches the previous instance', () => {
    const a = fakeApi();
    const b = fakeApi();
    attachZaloReadElsewhere('acc2', a.api, () => {});
    attachZaloReadElsewhere('acc2', b.api, () => {});
    expect(a.listener.ws.h).toHaveLength(0);
    expect(b.listener.ws.h).toHaveLength(1);
  });

  test('swallows bad frames with one warning that carries no frame content', () => {
    const { api, listener } = fakeApi();
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => {});
    warn.mockClear(); // Logger is a module mock here: drop calls recorded by earlier tests
    const onItems = jest.fn();
    attachZaloReadElsewhere('acc3', api, onItems);
    listener.cipherKey = crypto.randomBytes(32).toString('base64');
    expect(() => listener.ws.h[0](frame(504, 2))).not.toThrow();
    expect(() => listener.ws.h[0](frame(504, 0, { raw: '{"data":"not json","encrypt":0}' }))).not.toThrow();
    expect(onItems).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain('not json');
      expect(String(call[0])).not.toContain(KEY_B64);
    }
    warn.mockRestore();
  });
});

describe('applyZaloClearUnread', () => {
  const db = DatabaseService.getInstance();
  const OWNER = 'ownerR';
  let seq = 0;

  const seed = (thread: string, unread: number, msgs: Array<{ id: string; ts: number; sent?: number }>, mention = 0) => {
    db.run('INSERT INTO contacts (owner_zalo_id, contact_id, unread_count, has_mention) VALUES (?,?,?,?)', [OWNER, thread, unread, mention]);
    for (const m of msgs) {
      db.run(
        `INSERT INTO messages (owner_zalo_id, msg_id, cli_msg_id, thread_id, sender_id, is_sent, timestamp, msg_type, status, channel)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [OWNER, m.id, `c${seq++}`, thread, 's1', m.sent ?? 0, m.ts, 'webchat', 'received', 'zalo'],
      );
    }
  };
  const unreadOf = (t: string) => db.queryOne<{ unread_count: number; has_mention: number }>(
    'SELECT unread_count, has_mention FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [OWNER, t])!;
  const item = (threadId: string, lastMsgId: string) => ({ threadId, isGroup: false, lastMsgId });

  beforeAll(async () => { await db.initialize(); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('counts received messages newer than lastMsgId', () => {
    seed('t1', 3, [{ id: 'a', ts: 10 }, { id: 'b', ts: 20 }, { id: 'c', ts: 30 }, { id: 'd', ts: 40, sent: 1 }]);
    expect(applyZaloClearUnread(db, OWNER, item('t1', 'a'))).toMatchObject({ unread: 2 });
    expect(unreadOf('t1').unread_count).toBe(2);
  });

  test('empty or unknown lastMsgId clears everything, marks read, clears mention', () => {
    seed('t2', 2, [{ id: 'e', ts: 10 }, { id: 'f', ts: 20 }], 1);
    expect(applyZaloClearUnread(db, OWNER, item('t2', ''))).toMatchObject({ unread: 0 });
    expect(unreadOf('t2')).toEqual({ unread_count: 0, has_mention: 0 });
    expect(db.queryOne<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE thread_id='t2' AND status!='read'")!.n).toBe(0);
    seed('t3', 1, [{ id: 'g', ts: 10 }]);
    expect(applyZaloClearUnread(db, OWNER, item('t3', 'nope'))).toMatchObject({ unread: 0 });
  });

  test('never increases the count', () => {
    seed('t4', 2, [{ id: 'h', ts: 1 }, ...[2, 3, 4, 5, 6].map((n) => ({ id: `i${n}`, ts: 10 * n }))]);
    expect(applyZaloClearUnread(db, OWNER, item('t4', 'h')).unread).toBeUndefined();
    expect(unreadOf('t4').unread_count).toBe(2);
  });

  test('unchanged gives undefined unread; missing contact creates no row', () => {
    seed('t5', 0, [{ id: 'j', ts: 10 }]);
    expect(applyZaloClearUnread(db, OWNER, item('t5', ''))).toEqual({ mentionCleared: false });
    expect(applyZaloClearUnread(db, OWNER, item('ghost', 'x'))).toEqual({ mentionCleared: false });
    expect(db.queryOne('SELECT 1 FROM contacts WHERE contact_id=?', ['ghost'])).toBeUndefined();
  });
});
