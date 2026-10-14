import Logger from '../../utils/Logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { CertificateStore, CertificateKeyUnreadableError, PLAIN_KEY_WARNING, WEAK_KEY_WARNING } from '../../services/control/CertificateStore';
import { ControlConfigError, buildFirewallCommand, parseStoredConfig, validateConfigInput } from '../../services/control/controlConfig';
import { toSafeProfiles } from '../../services/control/controlProfiles';
import { buildDraftApproved, buildRunFinished, emitControlEvent, setControlEventSink } from '../../services/control/controlEvents';
import { createCertificate } from '../../services/control/certificate';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('InboxMediaStore', () => {
  test('saves, resolves, and rejects unknown ids', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'));
    const saved = await store.save('a.PNG', 'image/png', Readable.from([Buffer.from('abc')]));
    expect(saved).toMatchObject({ name: 'a.PNG', size: 3, kind: 'image' });
    const [file] = store.resolve([saved.mediaId]);
    expect(path.isAbsolute(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
    expect(() => store.resolve(['00000000-0000-4000-8000-000000000000'])).toThrow(/mediaId/);
    expect(() => store.resolve(['../etc/passwd'])).toThrow(/mediaId/);
  });

  test('deletes the partial file when the stream fails', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'));
    const bad = new Readable({ read() { this.push(Buffer.from('x')); this.destroy(new Error('boom')); } });
    await expect(store.save('v.mp4', 'video/mp4', bad)).rejects.toThrow('boom');
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toEqual([]);
  });

  test('rejects empty uploads and leaves nothing behind', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'));
    await expect(store.save('a.jpg', 'image/jpeg', Readable.from([]))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toEqual([]);
  });

  test('cleanup removes only files older than the limit', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'));
    const old = await store.save('a.jpg', 'image/jpeg', Readable.from([Buffer.from('1')]));
    const fresh = await store.save('b.jpg', 'image/jpeg', Readable.from([Buffer.from('2')]));
    const [oldFile] = store.resolve([old.mediaId]);
    const past = (Date.now() - 25 * 3_600_000) / 1000;
    fs.utimesSync(oldFile, past, past);
    expect(store.cleanup(Date.now())).toBe(1);
    expect(() => store.resolve([old.mediaId])).toThrow();
    expect(store.resolve([fresh.mediaId])).toHaveLength(1);
  });
});

describe('controlConfig', () => {
  test('refuses enabling with an empty or invalid allow-list', () => {
    expect(() => validateConfigInput({ enabled: true, port: 47321, allowList: [] })).toThrow(ControlConfigError);
    try { validateConfigInput({ enabled: true, port: 47321, allowList: '10.0.0.1, nope' }); fail('should throw'); }
    catch (e: any) { expect(e.invalid).toEqual(['nope']); }
  });
  test('accepts valid input, dedupes, and allows disabled with empty list', () => {
    expect(validateConfigInput({ enabled: true, port: 50000, allowList: '10.0.0.1 10.0.0.1 192.168.1.0/24' })).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1', '192.168.1.0/24'] });
    expect(validateConfigInput({ enabled: false, port: 47321, allowList: [] }).enabled).toBe(false);
  });
  test('rejects bad ports', () => {
    for (const port of [0, 80, 70000, 1.5, 'x']) expect(() => validateConfigInput({ enabled: false, port, allowList: [] })).toThrow(/Cổng/);
  });
  test('stored config falls back safely and never enables with an empty list', () => {
    expect(parseStoredConfig(null).enabled).toBe(false);
    expect(parseStoredConfig('{bad').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":47321,"allowList":[]}').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":50000,"allowList":["10.0.0.1"]}')).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1'] });
  });
  test('firewall command', () => {
    expect(buildFirewallCommand({ port: 47321, allowList: ['10.0.0.1', '10.0.0.2'] }))
      .toBe('netsh advfirewall firewall add rule name="MaiHub Control API" dir=in action=allow protocol=TCP localport=47321 remoteip=10.0.0.1,10.0.0.2');
    expect(() => buildFirewallCommand({ port: 47321, allowList: [] })).toThrow(ControlConfigError);
  });
});

describe('toSafeProfiles', () => {
  test('exposes only safe fields', () => {
    const out = toSafeProfiles(
      [{ id: 'p1', name: 'A', group_id: 2, proxy_id: 9, fingerprint: { seed: 1, hardwareConcurrency: 4, language: 'vi', timezone: 'x' }, note: 'secret', last_opened_at: 5, created_at: 1, updated_at: 2 }],
      [{ id: 2, name: 'G', color: '', sort_order: 0, created_at: 0 }], ['p1']);
    expect(out).toEqual([{ id: 'p1', name: 'A', groupId: 2, groupName: 'G', running: true, lastOpenedAt: 5, createdAt: 1, lastScannedAt: null }]);
    expect(JSON.stringify(out)).not.toMatch(/proxy|fingerprint|secret/);
  });

  test('lastScannedAt is the newest scanned group of that profile, null if never', () => {
    const base = { group_id: null, proxy_id: null, fingerprint: { seed: 1, hardwareConcurrency: 4, language: 'vi', timezone: 'x' }, note: '', last_opened_at: null, created_at: 1, updated_at: 2 };
    const out = toSafeProfiles([{ ...base, id: 'a', name: 'A' }, { ...base, id: 'b', name: 'B' }], [], [],
      { a: [{ scannedAt: 10 }, { scannedAt: 30 }] });
    expect(out.map((p) => p.lastScannedAt)).toEqual([30, null]);
  });
});

describe('control events', () => {
  test('run.finished counts outcomes; draft.approved payload', () => {
    expect(buildRunFinished({ id: 'r', kind: 'post', status: 'done', scheduleId: 's' }, [{ outcome: 'posted' }, { outcome: 'posted' }, { outcome: 'failed' }, { outcome: 'skipped' }]))
      .toEqual({ runId: 'r', kind: 'post', status: 'done', scheduleId: 's', posted: 2, failed: 1, skipped: 1 });
    expect(buildDraftApproved({ id: 's', name: 'n', kind: 'once', nextRunAt: 5 }, 'now')).toMatchObject({ scheduleId: 's', when: 'now' });
  });
  test('sink errors never propagate; no sink is a no-op', () => {
    emitControlEvent('run.started', {});
    setControlEventSink(() => { throw new Error('db gone'); });
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    expect(() => emitControlEvent('run.started', {})).not.toThrow();
    setControlEventSink(null);
  });
});

describe('CertificateStore', () => {
  const fakeCert = async () => createCertificate();
  const cipher = (available: boolean) => ({
    isAvailable: () => available,
    encrypt: (s: string) => Buffer.from(s, 'utf8').reverse(),
    decrypt: (b: Buffer) => Buffer.from(b).reverse().toString('utf8'),
  });

  test('encrypts the key when the cipher is available and regenerate changes the fingerprint', async () => {
    const store = new CertificateStore(dir, cipher(true), fakeCert);
    expect(store.fingerprint()).toBeNull();
    const first = await store.ensure();
    expect(fs.existsSync(path.join(dir, 'key.pem'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'key.enc')).toString()).not.toContain('PRIVATE KEY');
    expect(store.load()?.key).toBe(first.key);
    expect(store.warning).toBeNull();
    const fp = store.fingerprint();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    await store.regenerate();
    expect(store.fingerprint()).not.toBe(fp);
  }, 60000);

  test('does NOT regenerate when an existing encrypted key cannot be decrypted', async () => {
    const good = new CertificateStore(dir, cipher(true), fakeCert);
    await good.ensure();
    const before = good.fingerprint();
    const broken = new CertificateStore(dir, { ...cipher(true), decrypt: () => { throw new Error('bad'); } }, fakeCert);
    await expect(broken.ensure()).rejects.toBeInstanceOf(CertificateKeyUnreadableError);
    expect(broken.fingerprint()).toBe(before);
  }, 60000);

  test('warns when the OS backend is only basic_text', async () => {
    const store = new CertificateStore(dir, { ...cipher(true), isWeak: () => true }, fakeCert);
    await store.ensure();
    expect(store.warning).toBe(WEAK_KEY_WARNING);
    expect(fs.existsSync(path.join(dir, 'key.enc'))).toBe(true);
  }, 60000);

  test('falls back to a 0600 key file with a warning', async () => {
    const store = new CertificateStore(dir, cipher(false), fakeCert);
    await store.ensure();
    expect(store.warning).toBe(PLAIN_KEY_WARNING);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'key.pem')).mode & 0o777).toBe(0o600);
    expect(new CertificateStore(dir, cipher(false), fakeCert).load()?.key).toContain('PRIVATE KEY');
  }, 60000);
});
