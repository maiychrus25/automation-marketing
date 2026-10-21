import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DIAGNOSTIC_MAX_FILES,
  DIAGNOSTIC_RETENTION_MS,
  diagnosticFileBase,
  pruneDiagnostics,
  saveDiagnosticFiles,
} from '../../services/facebookPoster/diagnostics';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-diag-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Tạo thư mục lượt có `files` tệp, mtime lùi `ageMs` so với NOW. */
function makeRunDir(name: string, files: number, ageMs: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
  const when = new Date(NOW - ageMs);
  fs.utimesSync(dir, when, when);
  return dir;
}

test('constants match the spec', () => {
  assert.strictEqual(DIAGNOSTIC_RETENTION_MS, 7 * DAY);
  assert.strictEqual(DIAGNOSTIC_MAX_FILES, 500);
});

test('diagnosticFileBase uses 8 chars of the profile id, target index and attempt', () => {
  assert.strictEqual(diagnosticFileBase('abcdef123456', 3, 2), 'abcdef12-3-l2');
});

test('pruneDiagnostics removes run folders older than 7 days and keeps 6-day ones', () => {
  const old = makeRunDir('old', 2, 8 * DAY);
  const recent = makeRunDir('recent', 2, 6 * DAY);
  pruneDiagnostics(root, NOW);
  assert.strictEqual(fs.existsSync(old), false);
  assert.strictEqual(fs.existsSync(recent), true);
});

test('pruneDiagnostics drops the oldest folders until at most 500 files remain', () => {
  const a = makeRunDir('a', 200, 3 * DAY);
  const b = makeRunDir('b', 200, 2 * DAY);
  const c = makeRunDir('c', 200, 1 * DAY);
  pruneDiagnostics(root, NOW);
  assert.strictEqual(fs.existsSync(a), false);
  assert.strictEqual(fs.existsSync(b), true);
  assert.strictEqual(fs.existsSync(c), true);
  assert.strictEqual(fs.readdirSync(b).length + fs.readdirSync(c).length, 400);
});

test('pruneDiagnostics does not throw when the folder is missing', () => {
  assert.doesNotThrow(() => pruneDiagnostics(path.join(root, 'nope'), NOW));
});

test('saveDiagnosticFiles writes a .jpg and a .txt with url, title, target, code, attempt, time', async () => {
  const page = {
    screenshot: jest.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    url: () => 'https://www.facebook.com/checkpoint/1/',
    title: async () => 'Xác minh',
  };
  const dir = path.join(root, 'run-1');
  const name = await saveDiagnosticFiles(dir, 'abcdef12-1-l1', page as never, {
    targetUrl: 'https://www.facebook.com/groups/9/', attempt: 1, errorCode: 'checkpoint', at: NOW,
  });
  assert.strictEqual(name, 'abcdef12-1-l1.jpg');
  assert.strictEqual(JSON.stringify(page.screenshot.mock.calls[0]), JSON.stringify([{ type: 'jpeg', quality: 60, timeout: 5000 }]));
  assert.deepStrictEqual([...fs.readFileSync(path.join(dir, name))], [0xff, 0xd8, 0xff, 0xd9]);
  const note = fs.readFileSync(path.join(dir, 'abcdef12-1-l1.txt'), 'utf8');
  for (const part of ['https://www.facebook.com/checkpoint/1/', 'Xác minh', 'https://www.facebook.com/groups/9/', 'checkpoint', new Date(NOW).toISOString()]) {
    assert.ok(note.includes(part), `${part} missing in:\n${note}`);
  }
});

test('saveDiagnosticFiles: a hanging title() still yields the .jpg and .txt quickly', async () => {
  const page = {
    screenshot: async () => Buffer.from([1, 2]),
    url: () => 'https://www.facebook.com/groups/1/',
    title: () => new Promise<string>(() => {}),
  };
  const dir = path.join(root, 'run-hang');
  const started = Date.now();
  const name = await saveDiagnosticFiles(dir, 'b', page as never, { targetUrl: 't', attempt: 1, errorCode: 'composer_not_found', at: NOW });
  assert.ok(Date.now() - started < 3000, 'title timeout must be about 1 s');
  assert.strictEqual(name, 'b.jpg');
  assert.ok(fs.existsSync(path.join(dir, 'b.jpg')));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
});

test('saveDiagnosticFiles writes the .jpg before title() is asked', async () => {
  const dir = path.join(root, 'run-order');
  let jpgExistedAtTitle = false;
  const page = {
    screenshot: async () => Buffer.from([1]),
    url: () => 'u',
    title: async () => { jpgExistedAtTitle = fs.existsSync(path.join(dir, 'c.jpg')); return 't'; },
  };
  await saveDiagnosticFiles(dir, 'c', page as never, { targetUrl: 't', attempt: 1, errorCode: 'x', at: NOW });
  assert.strictEqual(jpgExistedAtTitle, true);
});

test('pruneDiagnostics never deletes the newest run folder in the over-limit pass', () => {
  const a = makeRunDir('a', 100, 2 * DAY);
  const b = makeRunDir('b', 600, 1 * DAY);
  pruneDiagnostics(root, NOW);
  assert.strictEqual(fs.existsSync(a), false);
  assert.strictEqual(fs.existsSync(b), true, 'newest folder is kept even though it alone exceeds the limit');
});

test('pruneDiagnostics respects the keep set (even for old folders and in the over-limit pass)', () => {
  const a = makeRunDir('keep-me', 300, 3 * DAY);
  const b = makeRunDir('b', 300, 2 * DAY);
  const c = makeRunDir('c', 300, 1 * DAY);
  const ancient = makeRunDir('ancient', 1, 9 * DAY);
  pruneDiagnostics(root, NOW, undefined, new Set(['keep-me', 'ancient']));
  assert.strictEqual(fs.existsSync(a), true);
  assert.strictEqual(fs.existsSync(ancient), true);
  assert.strictEqual(fs.existsSync(b), false);
  assert.strictEqual(fs.existsSync(c), true);
});
