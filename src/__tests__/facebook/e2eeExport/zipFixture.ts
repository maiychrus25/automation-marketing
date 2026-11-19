import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

// Tiny ZIP writer for tests: stored or deflated entries, arbitrary names, lying declared sizes.
export interface FixtureEntry {
  name: string;
  data?: Buffer | string;
  /** Size written in both headers instead of the real one. */
  declaredSize?: number;
  deflate?: boolean;
  /** Bytes written as a deflate body as-is (to craft a corrupt entry). */
  rawBody?: Buffer;
  /** Compression method written in the headers (e.g. 99 = unsupported). */
  method?: number;
  /** CRC-32 written instead of the real one. */
  crc?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
    const body = e.rawBody ?? (e.deflate ? zlib.deflateRawSync(raw) : raw);
    const name = Buffer.from(e.name);
    const usize = e.declaredSize ?? raw.length;
    const method = e.method ?? (e.deflate || e.rawBody ? 8 : 0);
    const crc = e.crc ?? crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(usize, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(usize, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const made: string[] = [];
export function writeTempFile(content: Buffer | string, fileName = 'export.zip'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-e2ee-zip-'));
  made.push(dir);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content);
  return file;
}
export function cleanupTempFiles(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

// Synthetic chat JSON in the shape Facebook's export uses.
export function chatJson(opts: {
  participants?: string[]; threadName?: string;
  messages: Array<{ sender: string; text?: string; ts: number; type?: string; isUnsent?: boolean; media?: string[]; reactions?: Array<{ actor: string; reaction: string }> }>;
}): string {
  return JSON.stringify({
    participants: opts.participants ?? ['Alice Example', 'Bob Example'],
    threadName: opts.threadName ?? 'Alice Example',
    messages: opts.messages.map(m => ({
      isUnsent: !!m.isUnsent, senderName: m.sender, text: m.text ?? '', timestamp: m.ts, type: m.type ?? (m.media ? 'media' : 'text'),
      ...(m.media ? { media: m.media.map(uri => ({ uri })) } : {}), ...(m.reactions ? { reactions: m.reactions } : {}),
    })),
  });
}
