/**
 * Dựng file sao lưu ZDB4.0 giả (tổng hợp) cho test: container XZ với khối LZMA2 không nén
 * + mã hoá AES-256-CBC từng khối 64KB (IV = 0), đúng bố cục thật.
 */
import * as crypto from 'crypto';
import * as zlib from 'zlib';

const CHUNK = 0x10000;

function crcLe(buf: Buffer): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(zlib.crc32(buf) >>> 0);
    return out;
}

function xzVarint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value;
    while (v >= 0x80) {
        bytes.push((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
    }
    bytes.push(v);
    return Buffer.from(bytes);
}

function padTo4(buf: Buffer): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

/** File .xz hợp lệ (check CRC32) chứa một khối LZMA2 gồm các chunk không nén. */
export function buildXzStored(data: Buffer): Buffer {
    const flags = Buffer.from([0x00, 0x01]);
    const streamHeader = Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), flags, crcLe(flags)]);

    // Block header 12 byte: size byte, flags, filter 0x21, props size 1, dict size byte, đệm, CRC32
    const headerBody = Buffer.from([0x02, 0x00, 0x21, 0x01, 0x16, 0x00, 0x00, 0x00]);
    const blockHeader = Buffer.concat([headerBody, crcLe(headerBody)]);

    const parts: Buffer[] = [];
    for (let off = 0; off < data.length; off += CHUNK) {
        const piece = data.subarray(off, Math.min(off + CHUNK, data.length));
        const head = Buffer.alloc(3);
        head[0] = off === 0 ? 0x01 : 0x02;
        head.writeUInt16BE(piece.length - 1, 1);
        parts.push(head, piece);
    }
    parts.push(Buffer.from([0x00]));
    const lzma2 = Buffer.concat(parts);

    const block = Buffer.concat([blockHeader, padTo4(lzma2), crcLe(data)]);
    const unpaddedSize = blockHeader.length + lzma2.length + 4;
    const indexBody = padTo4(
        Buffer.concat([Buffer.from([0x00]), xzVarint(1), xzVarint(unpaddedSize), xzVarint(data.length)]),
    );
    const index = Buffer.concat([indexBody, crcLe(indexBody)]);

    const footerBody = Buffer.alloc(6);
    footerBody.writeUInt32LE(index.length / 4 - 1, 0);
    flags.copy(footerBody, 4);
    const footer = Buffer.concat([crcLe(footerBody), footerBody, Buffer.from('YZ')]);

    return Buffer.concat([streamHeader, block, index, footer]);
}

/**
 * `leadingBytes: 4` đặt 4 byte tiền tố trước ciphertext; `trailingGarbage` nằm ngay sau XZ stream
 * (trong plaintext), giống phần đuôi footer TLV của file thật. `surplus` là dữ liệu giải nén dư sau các mục khai báo.
 */
export function buildZdbBackup(
    files: Array<{ name: string; data: Buffer }>,
    aesKey: Buffer,
    opts: { leadingBytes?: 0 | 4; trailingGarbage?: Buffer; surplus?: Buffer } = {},
): Buffer {
    const head = Buffer.alloc(18);
    Buffer.from('ZDB4.0').copy(head, 0);
    head.writeUInt32BE(files.length, 14);
    const table = files.map(f => {
        const name = Buffer.from(f.name, 'utf8');
        const row = Buffer.alloc(8 + name.length);
        row.writeUInt32BE(name.length, 0);
        name.copy(row, 4);
        row.writeUInt32BE(f.data.length, 4 + name.length);
        return row;
    });
    const xz = buildXzStored(Buffer.concat([...files.map(f => f.data), opts.surplus ?? Buffer.alloc(0)]));
    let plain = Buffer.concat([head, ...table, xz, opts.trailingGarbage ?? Buffer.alloc(0)]);
    plain = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);

    const blocks: Buffer[] = [];
    for (let off = 0; off < plain.length; off += CHUNK) {
        const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, Buffer.alloc(16));
        cipher.setAutoPadding(false);
        blocks.push(Buffer.concat([cipher.update(plain.subarray(off, off + CHUNK)), cipher.final()]));
    }
    const lead = opts.leadingBytes === 4 ? crypto.randomBytes(4) : Buffer.alloc(0);
    return Buffer.concat([lead, ...blocks]);
}
