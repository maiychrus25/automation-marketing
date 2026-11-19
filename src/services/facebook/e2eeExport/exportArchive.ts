// Mở ZIP bản sao lưu Facebook theo đường dẫn, đọc từng mục dạng luồng (không giải nén ra đĩa, không nạp cả tệp vào bộ nhớ).
import * as fs from 'fs';
import * as zlib from 'zlib';
import yauzl from 'yauzl';
import { parseExportChat, type ExportChat } from './exportParser';

export const EXPORT_LIMITS = {
  maxZipBytes: 2 * 1024 ** 3,
  maxEntries: 20_000,
  maxJsonBytes: 64 * 1024 ** 2,
  maxMediaBytes: 100 * 1024 ** 2,
  maxChatFiles: 2000,
  maxMessages: 500_000,
  maxTotalJsonBytes: 512 * 1024 ** 2,
  maxTotalMediaBytes: 2 * 1024 ** 3,
};
export type ExportLimits = typeof EXPORT_LIMITS;

export class ExportLimitError extends Error {
  readonly code = 'LIMIT';
  constructor(message: string) { super(message); this.name = 'ExportLimitError'; }
}

export interface ExportArchive {
  chats: ExportChat[];
  /** null = thiếu, quá lớn hoặc không đọc được (bị bỏ qua, không làm hỏng lượt nhập). */
  readMedia(uri: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

const openZip = (file: string) => new Promise<yauzl.ZipFile>((resolve, reject) => {
  // validateFileName mặc định bật: từ chối đường dẫn tuyệt đối và "..". Kích thước tự đếm trong readEntry nên tắt kiểm tra khai báo của yauzl (nó có thể treo luồng).
  yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: false }, (err, zip) => (err || !zip ? reject(err ?? new Error('ZIP_OPEN_FAILED')) : resolve(zip)));
});

/**
 * Đọc một mục; vượt `max` byte (khai báo hoặc thực tế) thì dừng và ném ExportLimitError.
 * Tự giải nén (decompress: false + zlib) vì yauzl 2.10 ghi đè `destroy` của luồng giải nén nên lỗi deflate trên Node mới không bao giờ
 * được báo và lời gọi treo mãi.
 */
function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > max) { reject(new ExportLimitError('ENTRY_TOO_LARGE')); return; }
    const compressed = entry.isCompressed();
    const onStream = (err: Error | null, raw?: NodeJS.ReadableStream) => {
      if (err || !raw) { reject(err ?? new Error('ZIP_READ_FAILED')); return; }
      const inflater = compressed ? zlib.createInflateRaw() : null;
      const out: NodeJS.ReadableStream = inflater ? raw.pipe(inflater) : raw;
      const chunks: Buffer[] = [];
      let total = 0, crc = 0, settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        (raw as any).destroy?.(); inflater?.destroy(); // giải phóng tay cầm kể cả khi mục hỏng hoặc quá lớn
        reject(e);
      };
      raw.on('error', fail);
      out.on('error', fail);
      out.on('data', (chunk: Buffer) => {
        total += chunk.length;
        crc = zlib.crc32(chunk, crc);
        if (total > max) { fail(new ExportLimitError('ENTRY_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      out.on('end', () => {
        if (settled) return;
        if (crc >>> 0 !== entry.crc32) { fail(new Error('ZIP_CRC_MISMATCH')); return; } // Electron 41 = Node 24: zlib.crc32 có sẵn
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      out.on('close', () => fail(new Error('ZIP_STREAM_CLOSED'))); // sau 'end' là vô hại (settled)
    };
    if (compressed) zip.openReadStream(entry, { decompress: false } as any, onStream as any);
    else zip.openReadStream(entry, onStream as any);
  });
}

function listEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith('/')) entries.push(entry); // bỏ qua thư mục
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function openExportArchive(zipPath: string, overrides: Partial<ExportLimits> = {}): Promise<ExportArchive> {
  const limits = { ...EXPORT_LIMITS, ...overrides };
  if (fs.statSync(zipPath).size > limits.maxZipBytes) throw new ExportLimitError('ZIP_TOO_LARGE');
  const zip = await openZip(zipPath);
  const close = async () => { try { zip.close(); } catch { /* đã đóng */ } };
  try {
    if (zip.entryCount > limits.maxEntries) throw new ExportLimitError('TOO_MANY_ENTRIES');
    const entries = await listEntries(zip);
    const byName = new Map(entries.map(e => [e.fileName, e]));
    const jsonEntries = entries.filter(e => !e.fileName.includes('/') && /\.json$/i.test(e.fileName));
    if (jsonEntries.length > limits.maxChatFiles) throw new ExportLimitError('TOO_MANY_CHATS');

    // Tổng kích thước khai báo kiểm trước khi đọc bất cứ mục nào; số byte thực được đếm lại khi đọc.
    if (jsonEntries.reduce((n, e) => n + e.uncompressedSize, 0) > limits.maxTotalJsonBytes) throw new ExportLimitError('JSON_TOTAL_TOO_LARGE');
    const chats: ExportChat[] = [];
    let messages = 0, jsonBytes = 0;
    for (const entry of jsonEntries) {
      let raw: Buffer;
      try {
        raw = await readEntry(zip, entry, limits.maxJsonBytes);
      } catch (err) {
        if (err instanceof ExportLimitError) throw err;
        continue; // không đọc được (nén lạ, mã hoá, hỏng, sai CRC): bỏ qua như tệp sai dạng
      }
      jsonBytes += raw.length;
      if (jsonBytes > limits.maxTotalJsonBytes) throw new ExportLimitError('JSON_TOTAL_TOO_LARGE');
      const chat = parseExportChat(raw.toString('utf8'));
      if (!chat) continue;
      messages += chat.messages.length;
      if (messages > limits.maxMessages) throw new ExportLimitError('TOO_MANY_MESSAGES');
      chats.push(chat);
    }
    let mediaBytes = 0;
    return {
      chats,
      async readMedia(uri: string) {
        const entry = byName.get(uri.replace(/^\.\//, ''));
        // Ngân sách tổng: hết thì bỏ qua các tệp còn lại (người gọi đếm là bỏ qua).
        if (!entry || mediaBytes + entry.uncompressedSize > limits.maxTotalMediaBytes) return null;
        try {
          const data = await readEntry(zip, entry, limits.maxMediaBytes);
          mediaBytes += data.length;
          return mediaBytes > limits.maxTotalMediaBytes ? null : data;
        } catch { return null; }
      },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
