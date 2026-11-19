import { openExportArchive, EXPORT_LIMITS, ExportLimitError } from '../../../services/facebook/e2eeExport/exportArchive';
import * as fs from 'fs';
import * as path from 'path';
import { buildZip, chatJson, cleanupTempFiles, writeTempFile } from './zipFixture';

const T = 1_700_000_000_000;
const chat = (text = 'hello-1') => chatJson({ messages: [{ sender: 'Alice Example', text, ts: T }] });
const open = async (entries: Parameters<typeof buildZip>[0], limits?: Partial<typeof EXPORT_LIMITS>) =>
  openExportArchive(writeTempFile(buildZip(entries)), limits);

afterEach(cleanupTempFiles);

describe('openExportArchive', () => {
  it('reads root json chats and ignores directories and unrelated entries', async () => {
    const a = await open([{ name: 'media/' }, { name: 'Alice Example_1.json', data: chat() }, { name: 'sub/Other_2.json', data: chat('hello-2') }, { name: 'notes.txt', data: 'x' }]);
    try {
      expect(a.chats).toHaveLength(1);
      expect(a.chats[0].messages[0].text).toBe('hello-1');
    } finally { await a.close(); }
  });

  it('skips a json file with the wrong shape without failing the others', async () => {
    const a = await open([{ name: 'a_1.json', data: '[]' }, { name: 'b_1.json', data: chat() }]);
    try { expect(a.chats).toHaveLength(1); } finally { await a.close(); }
  });

  it('reads a referenced media entry and returns null for missing ones', async () => {
    const a = await open([{ name: 'a_1.json', data: chat() }, { name: 'media/x.jpg', data: Buffer.from('imgdata') }]);
    try {
      expect((await a.readMedia('media/x.jpg'))!.toString()).toBe('imgdata');
      expect(await a.readMedia('media/missing.jpg')).toBeNull();
      expect(await a.readMedia('../etc/passwd')).toBeNull();
    } finally { await a.close(); }
  });

  it('returns null for oversized media by declared size and by actual bytes', async () => {
    const a = await open([
      { name: 'a_1.json', data: chat() },
      { name: 'media/big.bin', data: 'tiny', declaredSize: 1000 },
      { name: 'media/real.bin', data: Buffer.alloc(300, 1), deflate: true },
    ], { maxMediaBytes: 100 });
    try {
      expect(await a.readMedia('media/big.bin')).toBeNull();
      expect(await a.readMedia('media/real.bin')).toBeNull();
    } finally { await a.close(); }
  });

  it.each([['path traversal', '../evil.json'], ['absolute path', '/evil.json']])('rejects a %s entry name', async (_n, name) => {
    await expect(open([{ name: 'a_1.json', data: chat() }, { name, data: chat() }])).rejects.toThrow();
  });

  it('rejects a json that is too big by declared size', async () => {
    await expect(open([{ name: 'a_1.json', data: chat(), declaredSize: 5000 }], { maxJsonBytes: 1000 })).rejects.toBeInstanceOf(ExportLimitError);
  });

  it('rejects a json that is too big by actual bytes', async () => {
    await expect(open([{ name: 'a_1.json', data: chat('x'.repeat(5000)), deflate: true, declaredSize: 10 }], { maxJsonBytes: 1000 })).rejects.toThrow();
    await expect(open([{ name: 'a_1.json', data: chat('x'.repeat(5000)), deflate: true }], { maxJsonBytes: 1000 })).rejects.toBeInstanceOf(ExportLimitError);
  });

  it('rejects too many entries, chat files and messages', async () => {
    await expect(open([{ name: 'a.json', data: chat() }, { name: 'b.json', data: chat() }, { name: 'c.txt', data: '' }], { maxEntries: 2 })).rejects.toBeInstanceOf(ExportLimitError);
    await expect(open([{ name: 'a.json', data: chat() }, { name: 'b.json', data: chat() }], { maxChatFiles: 1 })).rejects.toBeInstanceOf(ExportLimitError);
    const two = chatJson({ messages: [{ sender: 'Alice Example', text: 'm1', ts: T }, { sender: 'Alice Example', text: 'm2', ts: T + 1 }] });
    await expect(open([{ name: 'a.json', data: two }, { name: 'b.json', data: two }], { maxMessages: 3 })).rejects.toBeInstanceOf(ExportLimitError);
  });

  it('skips a JSON entry that cannot be read (unsupported method, wrong CRC) and still imports the valid ones', async () => {
    const a = await open([
      { name: 'a_1.json', data: chat('hello-1'), method: 99 }, { name: 'b_1.json', data: chat('hello-2'), crc: 123 }, { name: 'c_1.json', data: chat('hello-3') },
    ]);
    try {
      expect(a.chats.map(c => c.messages[0].text)).toEqual(['hello-3']);
    } finally { await a.close(); }
  });

  it('treats a media entry with a wrong CRC-32 as a read failure', async () => {
    const a = await open([{ name: 'a_1.json', data: chat() }, { name: 'm/bad.jpg', data: 'imgdata', crc: 1 }, { name: 'm/ok.jpg', data: 'imgdata' }]);
    try {
      expect(await a.readMedia('m/bad.jpg')).toBeNull();
      expect((await a.readMedia('m/ok.jpg'))!.toString()).toBe('imgdata');
    } finally { await a.close(); }
  });

  it('rejects when the JSON entries together exceed the total cap, by declared size before reading anything', async () => {
    const one = chat();
    await expect(open([{ name: 'a.json', data: one }, { name: 'b.json', data: one }], { maxTotalJsonBytes: one.length + 10 })).rejects.toBeInstanceOf(ExportLimitError);
  });

  it('skips media once the total media budget is used up', async () => {
    const a = await open([{ name: 'a.json', data: chat() }, { name: 'm/1.jpg', data: Buffer.alloc(60, 1) }, { name: 'm/2.jpg', data: Buffer.alloc(60, 2) }], { maxTotalMediaBytes: 100 });
    try {
      expect(await a.readMedia('m/1.jpg')).not.toBeNull();
      expect(await a.readMedia('m/2.jpg')).toBeNull();
    } finally { await a.close(); }
  });

  it('releases the archive after a corrupt entry (best effort: close resolves and the file can be moved)', async () => {
    const file = writeTempFile(buildZip([{ name: 'a.json', data: chat() }, { name: 'm/bad.jpg', data: 'x', rawBody: Buffer.from('this is not deflate data at all') }]));
    const a = await openExportArchive(file);
    expect(await a.readMedia('m/bad.jpg')).toBeNull();
    await expect(a.close()).resolves.toBeUndefined();
    const moved = path.join(path.dirname(file), 'moved.zip');
    fs.renameSync(file, moved); // proves nothing about handles on POSIX; on Windows an open handle would make this fail
    expect(fs.existsSync(moved)).toBe(true);
  });

  it('rejects a zip file over the size cap, a corrupt zip and a non-zip file', async () => {
    const good = writeTempFile(buildZip([{ name: 'a.json', data: chat() }]));
    await expect(openExportArchive(good, { maxZipBytes: 10 })).rejects.toBeInstanceOf(ExportLimitError);
    const zip = buildZip([{ name: 'a.json', data: chat() }]);
    await expect(openExportArchive(writeTempFile(zip.subarray(0, zip.length - 30)))).rejects.toThrow();
    await expect(openExportArchive(writeTempFile('this is not a zip'))).rejects.toThrow();
  });

  it('uses the documented limits', () => {
    expect(EXPORT_LIMITS).toEqual({ maxZipBytes: 2 * 1024 ** 3, maxEntries: 20_000, maxJsonBytes: 64 * 1024 ** 2, maxMediaBytes: 100 * 1024 ** 2, maxChatFiles: 2000, maxMessages: 500_000, maxTotalJsonBytes: 512 * 1024 ** 2, maxTotalMediaBytes: 2 * 1024 ** 3 });
  });
});
