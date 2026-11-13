// Fixture tổng hợp cho bảng ChatContent của bản sao lưu điện thoại (dữ liệu tự dựng, không phải dữ liệu thật).
import Database from 'better-sqlite3';

/** Dựng một TLV box: lặp [u32 BE type][u32 BE length][value]. */
export function tlvBox(entries: Array<[number, Buffer]>): Buffer {
  const parts: Buffer[] = [];
  for (const [type, value] of entries) {
    const head = Buffer.alloc(8);
    head.writeInt32BE(type, 0);
    head.writeInt32BE(value.length, 4);
    parts.push(head, value);
  }
  return Buffer.concat(parts);
}

const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const int64 = (n: number | string | bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b; };
const str = (s: string) => Buffer.from(s, 'utf8');

const PROPERTY: Record<string, [number, 'int' | 'int64' | 'str']> = {
  size: [0x1e, 'int'], subType: [0x1f, 'int'], type: [0x20, 'int'], ext: [0x21, 'str'], color: [0x22, 'int'],
};
const ATTACH: Record<string, [number, 'int' | 'int64' | 'str']> = {
  type: [0x28, 'str'], catId: [0x29, 'int'], id: [0x2a, 'int'], extInfo: [0x2b, 'str'], childNumber: [0x2c, 'int'],
  action: [0x2d, 'str'], params: [0x2e, 'str'], title: [0x2f, 'str'], href: [0x30, 'str'], thumb: [0x31, 'str'],
  description: [0x32, 'str'], remains: [0x42, 'str'], zinstantData: [0x43, 'str'], zinstantMsg: [0x44, 'str'],
};
const QUOTE: Record<string, [number, 'int' | 'int64' | 'str']> = {
  ownerId: [0x50, 'int'], cliMsgId: [0x51, 'int64'], globalMsgId: [0x52, 'int64'], cliMsgType: [0x53, 'int'],
  ts: [0x54, 'int64'], ttl: [0x55, 'int64'], msg: [0x56, 'str'], attach: [0x57, 'str'], fromD: [0x58, 'str'], quoteStatus: [0x5a, 'str'],
};
const MENTION: Record<string, [number, 'int' | 'int64' | 'str']> = {
  type: [0x64, 'int'], uid: [0x65, 'int'], pos: [0x66, 'int'], len: [0x67, 'int'],
};

function encodeFields(obj: Record<string, any>, table: Record<string, [number, 'int' | 'int64' | 'str']>): Buffer {
  const entries: Array<[number, Buffer]> = [];
  for (const [name, value] of Object.entries(obj)) {
    const def = table[name];
    if (!def || value === undefined) continue;
    entries.push([def[0], def[1] === 'int' ? int(value) : def[1] === 'int64' ? int64(value) : str(String(value))]);
  }
  return tlvBox(entries);
}

export interface BinNetFields {
  property?: Record<string, any>;
  attachs?: Array<Record<string, any>>;
  quote?: Record<string, any>;
  mentions?: Array<Record<string, any>>;
  reference?: { type?: number; data?: string };
}

/** Dựng blob BinNet đúng bố cục thật (property 0x05, attach 0x06, quote 0x07, mention 0x08, reference 0x0b). */
export function buildBinNet(fields: BinNetFields): Buffer {
  const entries: Array<[number, Buffer]> = [];
  if (fields.property) entries.push([0x05, encodeFields(fields.property, PROPERTY)]);
  for (const a of fields.attachs || []) entries.push([0x06, encodeFields(a, ATTACH)]);
  if (fields.quote) entries.push([0x07, encodeFields(fields.quote, QUOTE)]);
  for (const m of fields.mentions || []) entries.push([0x08, encodeFields(m, MENTION)]);
  if (fields.reference) {
    const ref: Array<[number, Buffer]> = [];
    if (fields.reference.type !== undefined) ref.push([0xaa, int(fields.reference.type)]);
    if (fields.reference.data !== undefined) ref.push([0xab, str(fields.reference.data)]);
    entries.push([0x0b, tlvBox(ref)]);
  }
  return tlvBox(entries);
}

export interface ChatContentFixtureRow {
  SenderId: string | number | bigint;
  CliMsgId: string | number | bigint | null;
  GlbMsgId: string | number | bigint;
  MsgType: number;
  TimeStamp: number;
  TTL?: number;
  MsgContent?: string;
  BinNet?: Buffer | null;
  MsgStatus?: number;
}

/** Tạo file SQLite có bảng ChatContent (đủ cột bản gốc đọc) và chèn các dòng; id lớn được ghi đúng 64-bit. */
export function createChatContentDb(filePath: string, rows: ChatContentFixtureRow[]): void {
  const db = new Database(filePath);
  try {
    db.exec(`CREATE TABLE ChatContent (SenderId INTEGER, CliMsgId INTEGER, GlbMsgId INTEGER, MsgType INTEGER,
      TimeStamp INTEGER, TTL INTEGER, MsgContent TEXT, BinNet BLOB, MsgStatus INTEGER)`);
    const insert = db.prepare('INSERT INTO ChatContent VALUES (?,?,?,?,?,?,?,?,?)');
    const big = (v: string | number | bigint | null) => (v === null ? null : BigInt(v));
    for (const r of rows) {
      insert.run(big(r.SenderId), big(r.CliMsgId), big(r.GlbMsgId), BigInt(r.MsgType), BigInt(r.TimeStamp),
        BigInt(r.TTL ?? 0), r.MsgContent ?? '', r.BinNet ?? null, BigInt(r.MsgStatus ?? 1));
    }
  } finally {
    db.close();
  }
}
