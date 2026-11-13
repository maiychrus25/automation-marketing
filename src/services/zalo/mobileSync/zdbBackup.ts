/** Port sát từ babyvibe/deplao-builder (MIT) src/services/zalo/mobileSync/zdbBackup.ts @2162f07 */
/**
 * Giải mã file sao lưu tin nhắn Zalo mobile (`*.db.crypt`, định dạng ZDB4.0 — db_format = 1).
 *
 * Quy trình (tương đương `decompressAndDecryptDb_V2` của Zalo PC, đã đối chiếu bản dịch ngược
 * db-cross-v4 và tài liệu docs-decrypt-db-zalo):
 *   1. RSA PKCS#1 v1.5 giải `encrypted_key` → khoá dạng hex. Khoá AES = 32 ký tự HEX VIẾT HOA đầu
 *      tiên lấy nguyên byte ASCII (không hex-decode).
 *   2. AES-256-CBC, IV = 0, giải độc lập từng khối 64KB (IV reset mỗi khối).
 *   3. Plaintext: "ZDB4.0" | ... | u32 BE số file @14 | [u32 BE nameLen][name][u32 BE size]... | XZ stream
 *   4. Giải nén XZ (LZMA2) → nối tiếp nội dung các file theo thứ tự bảng trên. Mỗi file là 1 SQLite:
 *      `<uid>.db` (chat 1-1) hoặc `group_<gid>.db` (nhóm), bảng chính `ChatContent`.
 *
 * Phần đuôi file có footer TLV không mã hoá → sau khi giải sẽ thành rác nằm sau XZ stream, nên phải
 * xác định chính xác điểm kết thúc XZ (footer "YZ") trước khi đưa vào bộ giải nén.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { XzReadableStream } from 'xz-decompress';

export const ZDB_MAGIC = Buffer.from('ZDB4.0', 'ascii');
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
export const ZDB_CHUNK_SIZE = 0x10000;
const ZDB_COUNT_OFFSET = 14;
const MAX_ENTRIES = 200000;
const MAX_NAME_LEN = 1024;
const SAFE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,200}$/;

// ─── RSA / khoá AES ──────────────────────────────────────────────────────────

export interface SyncKeyPair {
    /** SPKI DER base64 — gửi lên server trong pull_mobile_msg. */
    publicKey: string;
    /** PKCS#1 PEM — giữ lại để giải `encrypted_key`. */
    privateKey: string;
}

/** Sinh cặp khoá giống Zalo PC: RSA 2048, public SPKI/DER (base64), private PKCS#1/PEM. */
export function generateSyncKeyPair(): SyncKeyPair {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    return { publicKey: (publicKey as unknown as Buffer).toString('base64'), privateKey: String(privateKey) };
}

function b64urlToBigInt(value: string): bigint {
    return BigInt('0x' + Buffer.from(value, 'base64url').toString('hex'));
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
    }
    return result;
}

/**
 * RSA PKCS#1 v1.5 thuần BigInt (CRT) — dự phòng khi runtime chặn RSA_PKCS1_PADDING cho
 * privateDecrypt (CVE-2023-46809). Không có oracle nên không chịu rủi ro Marvin.
 */
export function rsaDecryptPkcs1Manual(privateKeyPem: string, cipher: Buffer): Buffer {
    const jwk = crypto.createPrivateKey(privateKeyPem).export({ format: 'jwk' }) as any;
    const n = b64urlToBigInt(jwk.n);
    const p = b64urlToBigInt(jwk.p);
    const q = b64urlToBigInt(jwk.q);
    const dp = b64urlToBigInt(jwk.dp);
    const dq = b64urlToBigInt(jwk.dq);
    const qi = b64urlToBigInt(jwk.qi);
    const c = BigInt('0x' + cipher.toString('hex'));
    const m1 = modPow(c, dp, p);
    const m2 = modPow(c, dq, q);
    const h = (qi * (((m1 - m2) % p) + p)) % p;
    const m = m2 + h * q;

    const k = Math.ceil(n.toString(16).length / 2);
    const em = Buffer.from(m.toString(16).padStart(k * 2, '0'), 'hex');
    if (em[0] !== 0x00 || em[1] !== 0x02) throw new Error('RSA: padding PKCS#1 không hợp lệ');
    const sep = em.indexOf(0x00, 2);
    if (sep < 10) throw new Error('RSA: padding PKCS#1 không hợp lệ');
    return em.subarray(sep + 1);
}

export function rsaDecryptPkcs1(privateKeyPem: string, cipher: Buffer): Buffer {
    try {
        return crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, cipher);
    } catch (err: any) {
        const code = String(err?.code || '');
        const msg = String(err?.message || '');
        if (code.includes('INVALID_ARG') || /RSA_PKCS1_PADDING|security-revert|not supported/i.test(msg)) {
            return rsaDecryptPkcs1Manual(privateKeyPem, cipher);
        }
        throw err;
    }
}

/** Khoá AES thực dùng cho ZDB4.0: ASCII của 32 ký tự hex viết hoa đầu tiên. */
export function deriveAesKey(keyHex: string): Buffer {
    const upper = keyHex.toUpperCase();
    if (upper.length < 32) throw new Error('Khoá giải mã quá ngắn');
    return Buffer.from(upper.slice(0, 32), 'ascii');
}

/** Giải `encrypted_key` của sự kiện syncmsg_info (db_format = 1 → khoá xuất dạng hex) ra khoá AES 32 byte. */
export function decryptBackupKey(encryptedKeyBase64: string, privateKeyPem: string): Buffer {
    const raw = rsaDecryptPkcs1(privateKeyPem, Buffer.from(encryptedKeyBase64, 'base64'));
    return deriveAesKey(raw.toString('hex'));
}

// ─── CRC32 (kiểm tra footer XZ) ──────────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Tìm vị trí kết thúc XZ stream trong `tail` (một đoạn plaintext bắt đầu tại `tailOffset`).
 * Footer XZ = CRC32(4, LE) | Backward Size(4) | Stream Flags(2) | "YZ"; CRC32 tính trên 6 byte giữa.
 */
export function findXzStreamEnd(tail: Buffer, tailOffset: number, xzStart: number, streamFlags: Buffer): number {
    for (let i = tail.length - 2; i >= 10; i--) {
        if (tail[i] !== 0x59 || tail[i + 1] !== 0x5a) continue; // "YZ"
        const footerStart = i - 10;
        if (tail[i - 2] !== streamFlags[0] || tail[i - 1] !== streamFlags[1]) continue;
        const end = tailOffset + i + 2;
        if ((end - xzStart) % 4 !== 0) continue;
        const stored = tail.readUInt32LE(footerStart);
        if (crc32(tail.subarray(footerStart + 4, footerStart + 10)) !== stored) continue;
        return end;
    }
    return -1;
}

// ─── Giải mã + giải nén ──────────────────────────────────────────────────────

export interface ZdbEntry {
    name: string;
    size: number;
}

export interface ExtractedFile {
    name: string;
    path: string;
    size: number;
}

export interface ExtractOptions {
    isCancelled?: () => boolean;
    onProgress?: (processedBytes: number, totalBytes: number) => void;
    /** Dung lượng trống (byte) của ổ chứa outDir; mặc định đọc bằng fs.promises.statfs. */
    freeBytes?: () => Promise<number>;
}

export interface ExtractResult {
    files: ExtractedFile[];
    skippedEntries: string[];
}

const TRUNCATED_MSG = 'Bản sao lưu ZDB4.0 bị cắt cụt hoặc không hợp lệ';

class AbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

/** Đọc + giải mã ngẫu nhiên từng khối 64KB (mỗi khối độc lập, IV = 0). */
class ChunkReader {
    readonly chunkCount: number;
    private readonly zeroIv = Buffer.alloc(16);

    constructor(
        private readonly fh: fs.promises.FileHandle,
        private readonly start: number,
        readonly encryptedLength: number,
        private readonly key: Buffer,
    ) {
        this.chunkCount = Math.ceil(encryptedLength / ZDB_CHUNK_SIZE);
    }

    async plainChunk(index: number): Promise<Buffer> {
        if (index < 0 || index >= this.chunkCount) throw new Error(TRUNCATED_MSG);
        const offset = index * ZDB_CHUNK_SIZE;
        const length = Math.min(ZDB_CHUNK_SIZE, this.encryptedLength - offset);
        const cipherText = Buffer.alloc(length);
        const { bytesRead } = await this.fh.read(cipherText, 0, length, this.start + offset);
        if (bytesRead !== length) throw new Error('Đọc file sao lưu thiếu dữ liệu');
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, this.zeroIv);
        decipher.setAutoPadding(false);
        return Buffer.concat([decipher.update(cipherText), decipher.final()]);
    }
}

/** Thử các bố cục đã gặp: ciphertext bắt đầu ở byte 0 hoặc có 4 byte tiền tố. */
async function openChunkReader(fh: fs.promises.FileHandle, fileSize: number, key: Buffer): Promise<ChunkReader> {
    for (const start of [0, 4]) {
        const encryptedLength = Math.floor((fileSize - start) / 16) * 16;
        if (encryptedLength < 16) continue;
        const reader = new ChunkReader(fh, start, encryptedLength, key);
        const first = await reader.plainChunk(0);
        if (first.subarray(0, ZDB_MAGIC.length).equals(ZDB_MAGIC)) return reader;
    }
    throw new Error('Sai khoá giải mã hoặc file không phải ZDB4.0 (không thấy magic "ZDB4.0")');
}

export function parseZdbHeader(head: Buffer): { entries: ZdbEntry[]; tocEnd: number } | 'need-more' {
    if (head.length < ZDB_COUNT_OFFSET + 4) return 'need-more';
    if (!head.subarray(0, ZDB_MAGIC.length).equals(ZDB_MAGIC)) throw new Error('Không phải định dạng ZDB4.0');
    const count = head.readUInt32BE(ZDB_COUNT_OFFSET);
    if (count > MAX_ENTRIES) throw new Error(`Bảng file ZDB4.0 không hợp lệ (${count} mục)`);
    let off = ZDB_COUNT_OFFSET + 4;
    const entries: ZdbEntry[] = [];
    for (let i = 0; i < count; i++) {
        if (off + 4 > head.length) return 'need-more';
        const nameLen = head.readUInt32BE(off);
        if (nameLen === 0 || nameLen > MAX_NAME_LEN) throw new Error('Tên file trong ZDB4.0 không hợp lệ');
        if (off + 4 + nameLen + 4 > head.length) return 'need-more';
        let name = head.toString('utf8', off + 4, off + 4 + nameLen);
        name = name.replace(/\0+$/, '');
        const size = head.readUInt32BE(off + 4 + nameLen);
        entries.push({ name, size });
        off += 4 + nameLen + 4;
    }
    return { entries, tocEnd: off };
}

// Tên thiết bị Windows (có hoặc không có đuôi) và tên kết thúc bằng dấu chấm/khoảng trắng.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isSafeEntryName(name: string): boolean {
    return (
        SAFE_NAME_RE.test(name) &&
        !name.includes('..') &&
        path.basename(name) === name &&
        !WINDOWS_DEVICE_RE.test(name) &&
        !/[. ]$/.test(name)
    );
}

/** Đường dẫn đích của mục; null nếu sau khi resolve không nằm trong outDir (phòng thủ thêm). */
export function resolveEntryPath(outDir: string, name: string): string | null {
    const root = path.resolve(outDir);
    const full = path.resolve(root, name);
    return full !== root && full.startsWith(root + path.sep) ? full : null;
}

async function defaultFreeBytes(dir: string): Promise<number> {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
}

/**
 * Giải mã + giải nén file `.db.crypt` vào `outDir`. Chỉ ghi các file có tên an toàn;
 * dữ liệu của mục tên lạ hoặc trùng tên (không phân biệt hoa thường) vẫn được đọc qua (để giữ đúng
 * vị trí) nhưng bỏ đi và ghi vào `skippedEntries`. File đích mở bằng 'wx' nên không bao giờ ghi đè.
 * Khi lỗi hoặc huỷ, file ghi dở có thể còn trong `outDir`: người gọi sở hữu `outDir` và phải xoá nó.
 */
export async function extractZdbBackup(
    cryptPath: string,
    aesKey: Buffer,
    outDir: string,
    opts: ExtractOptions = {},
): Promise<ExtractResult> {
    const { onProgress, isCancelled } = opts;
    const fh = await fs.promises.open(cryptPath, 'r');
    try {
        const fileSize = (await fh.stat()).size;
        const reader = await openChunkReader(fh, fileSize, aesKey);
        const checkAbort = () => {
            if (isCancelled?.()) throw new AbortedError();
        };

        // 1. Header + bảng file (có thể trải qua nhiều khối 64KB)
        let head = await reader.plainChunk(0);
        let headChunks = 1;
        let header = parseZdbHeader(head);
        while (header === 'need-more') {
            if (headChunks >= reader.chunkCount) throw new Error(TRUNCATED_MSG);
            head = Buffer.concat([head, await reader.plainChunk(headChunks++)]);
            header = parseZdbHeader(head);
        }
        const { entries, tocEnd } = header;

        // 2. Đầu XZ stream (ngay sau bảng file; dò thêm vài byte cho chắc)
        let xzStart = -1;
        const probeEnd = Math.min(head.length - XZ_MAGIC.length, tocEnd + 64);
        for (let i = tocEnd; i <= probeEnd; i++) {
            if (head.subarray(i, i + XZ_MAGIC.length).equals(XZ_MAGIC)) {
                xzStart = i;
                break;
            }
        }
        if (xzStart < 0) throw new Error('Không tìm thấy dữ liệu nén XZ trong bản sao lưu');
        if (head.length < xzStart + 12) {
            if (headChunks >= reader.chunkCount) throw new Error(TRUNCATED_MSG);
            head = Buffer.concat([head, await reader.plainChunk(headChunks++)]);
        }
        const streamFlags = head.subarray(xzStart + 6, xzStart + 8);

        // 3. Cuối XZ stream: giải riêng 1-2 khối cuối rồi dò footer
        const lastIdx = reader.chunkCount - 1;
        // Đuôi dư > 64 KB đẩy footer ra ngoài hai khối cuối → lùi từng khối (cửa sổ 2 khối chồng 1 khối) tới đầu XZ.
        // Không cắt đúng thì bộ giải nén gặp rác sau stream và báo lỗi làm mất đoạn dữ liệu cuối.
        const firstXzChunk = Math.floor(xzStart / ZDB_CHUNK_SIZE);
        let xzEnd = -1;
        for (let start = Math.max(0, lastIdx - 1); xzEnd < 0; start--) {
            checkAbort();
            const parts: Buffer[] = [];
            for (let i = start; i <= Math.min(start + 1, lastIdx); i++) parts.push(await reader.plainChunk(i));
            xzEnd = findXzStreamEnd(Buffer.concat(parts), start * ZDB_CHUNK_SIZE, xzStart, streamFlags);
            if (start <= firstXzChunk) break;
        }
        if (xzEnd < 0) xzEnd = reader.encryptedLength; // không thấy footer ở đâu → giao cho bộ giải nén tự xử lý

        // 4. Stream: giải mã từng khối → cắt đúng [xzStart, xzEnd) → XZ → tách file
        await fs.promises.mkdir(outDir, { recursive: true });
        const declaredTotal = entries.reduce((sum, e) => sum + e.size, 0);
        let free: number | null = null;
        try {
            free = await (opts.freeBytes ?? (() => defaultFreeBytes(outDir)))();
        } catch {
            free = null; // không đọc được dung lượng → không chặn
        }
        if (free !== null && declaredTotal > free) throw new Error('Không đủ dung lượng đĩa để giải nén bản sao lưu');
        const firstChunk = Math.floor(xzStart / ZDB_CHUNK_SIZE);
        const lastChunk = Math.floor((xzEnd - 1) / ZDB_CHUNK_SIZE);
        let nextChunk = firstChunk;
        const totalBytes = xzEnd - xzStart;
        let processedBytes = 0;

        const source = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    checkAbort();
                    if (nextChunk > lastChunk) {
                        controller.close();
                        return;
                    }
                    const idx = nextChunk++;
                    const plain = await reader.plainChunk(idx);
                    const base = idx * ZDB_CHUNK_SIZE;
                    const from = Math.max(0, xzStart - base);
                    const to = Math.min(plain.length, xzEnd - base);
                    if (to > from) {
                        controller.enqueue(new Uint8Array(plain.buffer, plain.byteOffset + from, to - from));
                        processedBytes += to - from;
                    }
                } catch (err) {
                    controller.error(err);
                }
            },
        });

        const files: ExtractedFile[] = [];
        const skippedEntries: string[] = [];
        let entryIdx = 0;
        let written = 0;
        let current: fs.promises.FileHandle | null = null;
        const seenNames = new Set<string>();

        const openNext = async () => {
            while (entryIdx < entries.length && entries[entryIdx].size === 0) entryIdx++;
            if (entryIdx >= entries.length) return;
            const entry = entries[entryIdx];
            current = null;
            const target = isSafeEntryName(entry.name) ? resolveEntryPath(outDir, entry.name) : null;
            const key = entry.name.toLowerCase();
            if (target && !seenNames.has(key)) {
                seenNames.add(key);
                try {
                    current = await fs.promises.open(target, 'wx');
                } catch (err: any) {
                    if (err?.code !== 'EEXIST') throw err;
                }
            }
            if (!current) skippedEntries.push(entry.name);
        };
        const finishCurrent = async () => {
            const entry = entries[entryIdx];
            if (current) {
                await current.close();
                files.push({ name: entry.name, path: path.join(outDir, entry.name), size: entry.size });
            }
            current = null;
            entryIdx++;
            written = 0;
            onProgress?.(processedBytes, totalBytes);
            await openNext();
        };

        await openNext();
        // Dừng ngay khi mục cuối đầy đủ (dữ liệu dư/độc hại không bị giải nén tiếp) rồi cancel để nhả mutex.
        // Nếu stream tự kết thúc hoặc lỗi thì xz-decompress đã tự giải phóng context (không cancel 2 lần).
        const xzReader = entryIdx < entries.length ? new XzReadableStream(source).getReader() : null;
        let streamFinished = false;
        try {
            while (xzReader && entryIdx < entries.length) {
                let chunk: { done: boolean; value?: Uint8Array };
                try {
                    chunk = await xzReader.read();
                } catch (err) {
                    streamFinished = true;
                    throw err;
                }
                if (chunk.done) {
                    streamFinished = true;
                    break;
                }
                checkAbort();
                const value = chunk.value;
                let off = 0;
                while (off < value.length && entryIdx < entries.length) {
                    const need = entries[entryIdx].size - written;
                    const take = Math.min(need, value.length - off);
                    if (current) await current.write(value, off, take);
                    written += take;
                    off += take;
                    if (written === entries[entryIdx].size) await finishCurrent();
                }
            }
        } finally {
            // Dừng giữa chừng (huỷ / lỗi ghi file) → cancel để xz-decompress nhả mutex toàn cục.
            if (xzReader && !streamFinished) await xzReader.cancel().catch(() => {});
            if (current) await (current as fs.promises.FileHandle).close().catch(() => {});
        }

        if (entryIdx < entries.length) {
            throw new Error(`Giải nén không đủ dữ liệu (${entryIdx}/${entries.length} file)`);
        }
        onProgress?.(totalBytes, totalBytes);
        return { files, skippedEntries };
    } finally {
        await fh.close().catch(() => {});
    }
}

/** So khớp checksum_code của sự kiện với file đã tải (md5 hoặc sha256, không phân biệt hoa thường). */
export async function verifyChecksum(
    filePath: string,
    expected: string | null | undefined,
): Promise<'ok' | 'mismatch' | 'skipped'> {
    const want = String(expected || '').trim().toLowerCase();
    const algo = want.length === 32 ? 'md5' : want.length === 64 ? 'sha256' : null;
    if (!algo) return 'skipped';
    const hash = crypto.createHash(algo);
    await new Promise<void>((resolve, reject) => {
        fs.createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve())
            .on('error', reject);
    });
    return hash.digest('hex') === want ? 'ok' : 'mismatch';
}
