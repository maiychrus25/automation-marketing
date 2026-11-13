import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { XzReadableStream } from 'xz-decompress';
import {
    decryptBackupKey,
    extractZdbBackup,
    generateSyncKeyPair,
    resolveEntryPath,
    isSafeEntryName,
    rsaDecryptPkcs1Manual,
    verifyChecksum,
} from '../../services/zalo/mobileSync/zdbBackup';
import { buildXzStored, buildZdbBackup } from './helpers/zdbFixture';

const KEY = Buffer.from('0123456789ABCDEF0123456789ABCDEF', 'ascii');

function pseudoRandom(size: number, seed: number): Buffer {
    const out = Buffer.alloc(size);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < size; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        out[i] = x >>> 24;
    }
    return out;
}

async function inflate(xz: Buffer): Promise<Buffer> {
    const stream = new XzReadableStream(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(xz)); c.close(); } }));
    const reader = stream.getReader();
    const parts: Buffer[] = [];
    for (;;) {
        const r = await reader.read();
        if (r.done) break;
        parts.push(Buffer.from(r.value));
    }
    return Buffer.concat(parts);
}

describe('zdbBackup', () => {
    let root: string;
    let outDir: string;
    let cryptPath: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'zdb-test-'));
        outDir = path.join(root, 'out');
        cryptPath = path.join(root, 'backup.db.crypt');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    const write = (buf: Buffer) => fs.writeFileSync(cryptPath, buf);

    it('buildXzStored output decompresses through xz-decompress', async () => {
        expect((await inflate(buildXzStored(Buffer.from('abc')))).toString()).toBe('abc');
        const big = pseudoRandom(150_000, 7); // nhiều chunk LZMA2
        expect((await inflate(buildXzStored(big))).equals(big)).toBe(true);
    });

    it('roundTripsTwoFiles', async () => {
        const a = pseudoRandom(100_000, 1);
        const b = pseudoRandom(70_000, 2);
        write(buildZdbBackup([{ name: '111.db', data: a }, { name: 'group_222.db', data: b }], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.skippedEntries).toEqual([]);
        expect(res.files).toEqual([
            { name: '111.db', path: path.join(outDir, '111.db'), size: a.length },
            { name: 'group_222.db', path: path.join(outDir, 'group_222.db'), size: b.length },
        ]);
        expect(fs.readFileSync(path.join(outDir, '111.db')).equals(a)).toBe(true);
        expect(fs.readFileSync(path.join(outDir, 'group_222.db')).equals(b)).toBe(true);
    });

    it('acceptsCiphertextAtOffset4', async () => {
        const a = pseudoRandom(5000, 3);
        write(buildZdbBackup([{ name: '1.db', data: a }], KEY, { leadingBytes: 4 }));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.files).toHaveLength(1);
        expect(fs.readFileSync(path.join(outDir, '1.db')).equals(a)).toBe(true);
    });

    it('rejectsWrongMagic', async () => {
        write(buildZdbBackup([{ name: '1.db', data: Buffer.from('x') }], KEY));
        await expect(extractZdbBackup(cryptPath, crypto.randomBytes(32), outDir)).rejects.toThrow(/ZDB4\.0/);
        expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    });

    it('rejectsUnsupportedLayout', async () => {
        const buf = buildZdbBackup([{ name: '1.db', data: Buffer.from('x') }], KEY);
        // đặt số mục 200001 trong plaintext rồi mã hoá lại bằng cách dựng thủ công
        const dec = crypto.createDecipheriv('aes-256-cbc', KEY, Buffer.alloc(16)).setAutoPadding(false);
        const plain = Buffer.concat([dec.update(buf), dec.final()]);
        plain.writeUInt32BE(200001, 14);
        const enc = crypto.createCipheriv('aes-256-cbc', KEY, Buffer.alloc(16)).setAutoPadding(false);
        write(Buffer.concat([enc.update(plain), enc.final()]));
        await expect(extractZdbBackup(cryptPath, KEY, outDir)).rejects.toThrow(/không hợp lệ/);
        expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    });

    it('skipsUnsafeNames', async () => {
        const long = 'a'.repeat(300) + '.db';
        const bad = ['../x.db', 'a/b.db', '/abs.db', '..', long];
        const good = pseudoRandom(3000, 9);
        const files = [
            { name: 'ok1.db', data: good },
            ...bad.map((name, i) => ({ name, data: pseudoRandom(500 + i, 20 + i) })),
            { name: 'ok2.db', data: Buffer.from('tail') },
        ];
        write(buildZdbBackup(files, KEY));
        const before = fs.readdirSync(root).sort();
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.skippedEntries).toEqual(bad);
        expect(res.files.map(f => f.name)).toEqual(['ok1.db', 'ok2.db']);
        expect(fs.readFileSync(path.join(outDir, 'ok1.db')).equals(good)).toBe(true);
        expect(fs.readFileSync(path.join(outDir, 'ok2.db')).toString()).toBe('tail');
        expect(fs.readdirSync(outDir).sort()).toEqual(['ok1.db', 'ok2.db']);
        expect(fs.readdirSync(root).sort()).toEqual([...before, 'out'].sort()); // không có gì ngoài outDir
    });

    it('truncatedFileFailsCleanly', async () => {
        const full = buildZdbBackup(
            [{ name: '1.db', data: pseudoRandom(300_000, 4) }, { name: '2.db', data: pseudoRandom(100_000, 5) }],
            KEY,
        );
        write(full.subarray(0, Math.floor(full.length / 2)));
        await expect(extractZdbBackup(cryptPath, KEY, outDir)).rejects.toThrow();
        // sau lỗi vẫn giải được file nguyên vẹn (mutex WASM không bị kẹt)
        write(full);
        const res = await extractZdbBackup(cryptPath, KEY, path.join(root, 'out2'));
        expect(res.files).toHaveLength(2);
    }, 20_000);

    it('emptyArchive', async () => {
        write(buildZdbBackup([], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.files).toEqual([]);
        expect(res.skippedEntries).toEqual([]);
    });

    it('cancelStopsEarly', async () => {
        write(buildZdbBackup([{ name: '1.db', data: pseudoRandom(400_000, 6) }], KEY));
        let calls = 0;
        let result: unknown;
        await expect(
            (async () => { result = await extractZdbBackup(cryptPath, KEY, outDir, { isCancelled: () => ++calls > 2 }); })(),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(result).toBeUndefined();
        // vẫn dùng lại được bộ giải nén sau khi huỷ
        const res = await extractZdbBackup(cryptPath, KEY, path.join(root, 'out2'));
        expect(res.files).toHaveLength(1);
    }, 20_000);

    it('stopsAfterLastEntry', async () => {
        const a = pseudoRandom(100, 12);
        write(buildZdbBackup([{ name: '1.db', data: a }], KEY, { surplus: pseudoRandom(3_000_000, 13) }));
        const totalBlocks = Math.ceil(fs.statSync(cryptPath).size / 0x10000);
        let reads = 0;
        const realOpen = fs.promises.open;
        const spy = jest.spyOn(fs.promises, 'open').mockImplementation((async (...args: any[]) => {
            const fh = await (realOpen as any)(...args);
            if (args[0] === cryptPath) {
                const realRead = fh.read.bind(fh);
                fh.read = (...a: any[]) => { reads++; return realRead(...a); };
            }
            return fh;
        }) as any);
        try {
            const res = await extractZdbBackup(cryptPath, KEY, outDir);
            expect(res.files.map(f => f.name)).toEqual(['1.db']);
            expect(fs.readFileSync(path.join(outDir, '1.db')).equals(a)).toBe(true);
        } finally {
            spy.mockRestore();
        }
        expect(totalBlocks).toBeGreaterThan(40);
        expect(reads).toBeLessThan(totalBlocks / 2);
        // bộ giải nén vẫn dùng lại được
        write(buildZdbBackup([{ name: '1.db', data: a }], KEY));
        expect((await extractZdbBackup(cryptPath, KEY, path.join(root, 'out2'))).files).toHaveLength(1);
    }, 20_000);

    it('rejectsWhenDeclaredSizeExceedsFreeSpace', async () => {
        write(buildZdbBackup([{ name: '1.db', data: pseudoRandom(500, 14) }, { name: '2.db', data: pseudoRandom(500, 15) }], KEY));
        await expect(
            extractZdbBackup(cryptPath, KEY, outDir, { freeBytes: async () => 10 }),
        ).rejects.toThrow('Không đủ dung lượng đĩa để giải nén bản sao lưu');
        expect(fs.readdirSync(outDir)).toEqual([]);
        const res = await extractZdbBackup(cryptPath, KEY, outDir, { freeBytes: async () => 1000 });
        expect(res.files).toHaveLength(2);
        const ok = await extractZdbBackup(cryptPath, KEY, path.join(root, 'out3'), {
            freeBytes: async () => { throw new Error('statfs failed'); },
        });
        expect(ok.files).toHaveLength(2);
    });

    it('duplicateNamesKeepFirst', async () => {
        write(buildZdbBackup([{ name: 'a.db', data: Buffer.from('first') }, { name: 'a.db', data: Buffer.from('second') }], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.files.map(f => f.name)).toEqual(['a.db']);
        expect(res.skippedEntries).toEqual(['a.db']);
        expect(fs.readFileSync(path.join(outDir, 'a.db')).toString()).toBe('first');
    });

    it('caseCollidingNamesKeepFirst', async () => {
        write(buildZdbBackup([{ name: 'a.db', data: Buffer.from('first') }, { name: 'A.DB', data: Buffer.from('second') }, { name: 'b.db', data: Buffer.from('third') }], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.files.map(f => f.name)).toEqual(['a.db', 'b.db']);
        expect(res.skippedEntries).toEqual(['A.DB']);
        expect(fs.readFileSync(path.join(outDir, 'a.db')).toString()).toBe('first');
        expect(fs.readFileSync(path.join(outDir, 'b.db')).toString()).toBe('third');
    });

    it('doesNotOverwriteExistingFile', async () => {
        fs.mkdirSync(outDir);
        fs.writeFileSync(path.join(outDir, 'a.db'), 'planted');
        write(buildZdbBackup([{ name: 'a.db', data: Buffer.from('new') }, { name: 'b.db', data: Buffer.from('ok') }], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.skippedEntries).toEqual(['a.db']);
        expect(res.files.map(f => f.name)).toEqual(['b.db']);
        expect(fs.readFileSync(path.join(outDir, 'a.db')).toString()).toBe('planted');
    });

    it('skipsWindowsDangerousNames', async () => {
        const bad = ['CON', 'nul.db', 'Com1.txt', 'LPT9', 'aux', 'prn.x.y', 'name.', 'x.db.'];
        write(buildZdbBackup([...bad.map(name => ({ name, data: Buffer.from('z') })), { name: 'console.db', data: Buffer.from('k') }], KEY));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.skippedEntries).toEqual(bad);
        expect(res.files.map(f => f.name)).toEqual(['console.db']);
        expect(isSafeEntryName('COM10')).toBe(true);
    });

    it('resolveEntryPathStaysInsideOutDir', () => {
        expect(resolveEntryPath(outDir, 'a.db')).toBe(path.join(path.resolve(outDir), 'a.db'));
        expect(resolveEntryPath(outDir, '../a.db')).toBeNull();
        expect(resolveEntryPath(outDir, '..')).toBeNull();
        expect(resolveEntryPath(outDir, '')).toBeNull();
    });

    it('rejectsTinyAndEmptyFiles', async () => {
        write(Buffer.alloc(10, 1));
        await expect(extractZdbBackup(cryptPath, KEY, outDir)).rejects.toThrow(/ZDB4\.0/);
        write(Buffer.alloc(0));
        await expect(extractZdbBackup(cryptPath, KEY, outDir)).rejects.toThrow(/ZDB4\.0/);
        // magic hợp lệ nhưng file ngắn hơn đầu XZ + 12 byte
        const plain = Buffer.alloc(32);
        Buffer.from('ZDB4.0').copy(plain, 0);
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]).copy(plain, 22);
        const enc = crypto.createCipheriv('aes-256-cbc', KEY, Buffer.alloc(16)).setAutoPadding(false);
        write(Buffer.concat([enc.update(plain), enc.final()]));
        await expect(extractZdbBackup(cryptPath, KEY, outDir)).rejects.toThrow(/cắt cụt/);
    });

    it('reportsProgress', async () => {
        write(buildZdbBackup([{ name: '1.db', data: pseudoRandom(200_000, 8) }], KEY));
        const seen: Array<[number, number]> = [];
        await extractZdbBackup(cryptPath, KEY, outDir, { onProgress: (p, t) => seen.push([p, t]) });
        const last = seen[seen.length - 1];
        expect(last[0]).toBe(last[1]);
    });

    it('toleratesTrailingGarbageAfterXz', async () => {
        const a = pseudoRandom(90_000, 10);
        write(buildZdbBackup([{ name: '1.db', data: a }], KEY, { trailingGarbage: pseudoRandom(1234, 11) }));
        const res = await extractZdbBackup(cryptPath, KEY, outDir);
        expect(res.files).toHaveLength(1);
        expect(fs.readFileSync(path.join(outDir, '1.db')).equals(a)).toBe(true);
    });

    it('extractsWhenTrailingGarbageHidesXzFooter', async () => {
        // >130 KB sau XZ stream: footer nằm ngoài hai khối 64 KB cuối, reader phải rơi về độ dài mã hoá
        const a = pseudoRandom(90_000, 12);
        write(buildZdbBackup([{ name: '1.db', data: a }], KEY, { trailingGarbage: pseudoRandom(140_000, 13) }));
        for (let i = 0; i < 2; i++) {
            fs.rmSync(outDir, { recursive: true, force: true });
            const res = await extractZdbBackup(cryptPath, KEY, outDir);
            expect(res.files).toHaveLength(1);
            expect(fs.readFileSync(path.join(outDir, '1.db')).equals(a)).toBe(true);
        }
    });

    describe('backup key', () => {
        const expectedKey = (raw: Buffer) => Buffer.from(raw.toString('hex').toUpperCase().slice(0, 32), 'ascii');

        it('keyPairAndBackupKeyRoundTrip', () => {
            const { publicKey, privateKey } = generateSyncKeyPair();
            const raw = crypto.randomBytes(32);
            const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
            const enc = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, raw);
            const key = decryptBackupKey(enc.toString('base64'), privateKey);
            expect(key).toHaveLength(32);
            expect(key.equals(expectedKey(raw))).toBe(true);
        });

        it('backupKeyFallbackMatchesNative', () => {
            const { publicKey, privateKey } = generateSyncKeyPair();
            const raw = crypto.randomBytes(32);
            const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
            const enc = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, raw);
            expect(rsaDecryptPkcs1Manual(privateKey, enc).equals(raw)).toBe(true);
        });
    });

    it('checksum', async () => {
        const f = path.join(root, 'c.bin');
        fs.writeFileSync(f, 'hello');
        const md5 = crypto.createHash('md5').update('hello').digest('hex');
        const sha = crypto.createHash('sha256').update('hello').digest('hex');
        expect(await verifyChecksum(f, md5.toUpperCase())).toBe('ok');
        expect(await verifyChecksum(f, sha)).toBe('ok');
        expect(await verifyChecksum(f, 'abc')).toBe('skipped');
        expect(await verifyChecksum(f, null)).toBe('skipped');
        expect(await verifyChecksum(f, '0'.repeat(32))).toBe('mismatch');
        expect(await verifyChecksum(f, '0'.repeat(64))).toBe('mismatch');
    });
});
