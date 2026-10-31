import Logger from '../../utils/Logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { CertificateStore, CertificateKeyUnreadableError, PLAIN_KEY_WARNING, WEAK_KEY_WARNING } from '../../services/control/CertificateStore';
import { ControlConfigError, buildFirewallCommand, parseStoredConfig, resolveAppVersion, validateConfigInput } from '../../services/control/controlConfig';
import { toSafeProfiles } from '../../services/control/controlProfiles';
import { buildPagesLearnFinished, buildBriefFinished, buildCheckFinished, buildDraftApproved, buildLoginProblem, buildResearchFinished, buildRunFinished, buildTrackFinished, buildLeadsFound, buildCollectFinished, buildVideoFinished, emitControlEvent, setControlEventSink } from '../../services/control/controlEvents';
import { createCertificate } from '../../services/control/certificate';
import { parseBotIp, withStoredPublicHost } from '../../services/control/controlConfig';
import { memoryDb } from '../facebookPoster/helpers';

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

  test('adopt copies an existing file into the inbox with a new id and keeps the extension', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'));
    const src = path.join(dir, 'clip.mp4');
    fs.writeFileSync(src, 'video-bytes');
    const saved = await store.adopt(src);
    expect(saved).toMatchObject({ name: 'clip.mp4', size: 11, kind: 'video' });
    const [file] = store.resolve([saved.mediaId]);
    expect(file.endsWith('.mp4')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('video-bytes');
    expect(fs.existsSync(src)).toBe(true);
  });

  test('adopt respects the file and byte limits and leaves no partial file', async () => {
    const src = path.join(dir, 'clip.mp4');
    fs.writeFileSync(src, '123456');
    const full = new InboxMediaStore(path.join(dir, 'inbox1'), { maxBytes: 1000, maxFiles: 0 });
    await expect(full.adopt(src)).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    const small = new InboxMediaStore(path.join(dir, 'inbox2'), { maxBytes: 5, maxFiles: 10 });
    await expect(small.adopt(src)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(fs.readdirSync(path.join(dir, 'inbox2'))).toEqual([]);
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

  test('refuses a new upload when the inbox already holds the maximum number of files', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'), { maxBytes: 1000, maxFiles: 2 });
    await store.save('a.jpg', 'image/jpeg', Readable.from([Buffer.from('1')]));
    await store.save('b.jpg', 'image/jpeg', Readable.from([Buffer.from('2')]));
    await expect(store.save('c.jpg', 'image/jpeg', Readable.from([Buffer.from('3')]))).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toHaveLength(2);
  });

  test('refuses an upload that would push the inbox over the byte cap, before and during writing', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'), { maxBytes: 10, maxFiles: 50 });
    await store.save('a.jpg', 'image/jpeg', Readable.from([Buffer.from('123456')]));
    await expect(store.save('b.jpg', 'image/jpeg', Readable.from([Buffer.from('1234'), Buffer.from('5678')]))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toHaveLength(1); // chỉ còn a.jpg, không để tệp dở
    await store.save('c.jpg', 'image/jpeg', Readable.from([Buffer.from('1234')])); // vừa đủ 10 byte
  });

  test('concurrent uploads are counted together so they cannot overshoot the caps', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'), { maxBytes: 10, maxFiles: 2 });
    const slow = () => new Readable({ read() { setTimeout(() => { this.push(Buffer.from('123456')); this.push(null); }, 20); } });
    const results = await Promise.allSettled([store.save('a.jpg', 'image/jpeg', slow()), store.save('b.jpg', 'image/jpeg', slow())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const third = await Promise.allSettled([store.save('c.jpg', 'image/jpeg', Readable.from([Buffer.from('1')])), store.save('d.jpg', 'image/jpeg', Readable.from([Buffer.from('1')]))]);
    expect(third.some((r) => r.status === 'rejected' && (r.reason as any).code === 'LIMIT_REACHED')).toBe(true);
  });

  test('overlapping uploads: bytes committed by a save that finished meanwhile still count toward the cap', async () => {
    const store = new InboxMediaStore(path.join(dir, 'inbox'), { maxBytes: 10, maxFiles: 50 });
    const late = new Readable({ read() { setTimeout(() => { this.push(Buffer.from('123456')); this.push(null); }, 60); } });
    const b = store.save('b.jpg', 'image/jpeg', late); // bắt đầu trước, khi inbox còn trống
    await store.save('a.jpg', 'image/jpeg', Readable.from([Buffer.from('123456')])); // xong trước b
    await expect(b).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(fs.readdirSync(path.join(dir, 'inbox'))).toHaveLength(1);
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
    expect(validateConfigInput({ enabled: true, port: 50000, allowList: '10.0.0.1 10.0.0.1 192.168.1.0/24' })).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1', '192.168.1.0/24'], publicHost: null, protectedWritesEnabled: false });
    expect(validateConfigInput({ enabled: false, port: 47321, allowList: [] }).enabled).toBe(false);
  });
  test('rejects bad ports', () => {
    for (const port of [0, 80, 70000, 1.5, 'x']) expect(() => validateConfigInput({ enabled: false, port, allowList: [] })).toThrow(/Cổng/);
  });
  test('stored config falls back safely and never enables with an empty list', () => {
    expect(parseStoredConfig(null).enabled).toBe(false);
    expect(parseStoredConfig('{bad').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":47321,"allowList":[]}').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":50000,"allowList":["10.0.0.1"]}')).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1'], publicHost: null, protectedWritesEnabled: false });
  });
  test('resolveAppVersion: keeps a real version, else first readable package.json, else the reported value', () => {
    const files: Record<string, string> = { '/b/package.json': '{"version":"26.17.0"}', '/c/package.json': '{"version":"9.9.9"}' };
    const readFile = (f: string) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
    expect(resolveAppVersion({ reported: '1.2.3', packageJsonPaths: ['/b/package.json'], readFile })).toBe('1.2.3');
    expect(resolveAppVersion({ reported: '0.0', packageJsonPaths: ['/a/package.json', '/b/package.json', '/c/package.json'], readFile })).toBe('26.17.0');
    expect(resolveAppVersion({ reported: '0.0', packageJsonPaths: ['/a/package.json'], readFile })).toBe('0.0');
    files['/bad/package.json'] = 'not json';
    expect(resolveAppVersion({ reported: '0.0', packageJsonPaths: ['/bad/package.json', '/c/package.json'], readFile })).toBe('9.9.9');
  });

  test('firewall command', () => {
    expect(buildFirewallCommand({ port: 47321, allowList: ['10.0.0.1', '10.0.0.2'] }))
      .toBe('netsh advfirewall firewall delete rule name="MaiHub Control API"\nnetsh advfirewall firewall add rule name="MaiHub Control API" dir=in action=allow protocol=TCP localport=47321 remoteip=10.0.0.1,10.0.0.2');
    expect(() => buildFirewallCommand({ port: 47321, allowList: [] })).toThrow(ControlConfigError);
  });
});

describe('toSafeProfiles', () => {
  test('exposes only safe fields', () => {
    const out = toSafeProfiles(
      [{ id: 'p1', name: 'A', group_id: 2, proxy_id: 9, fingerprint: { seed: 1, hardwareConcurrency: 4, language: 'vi', timezone: 'x' }, note: 'secret', last_opened_at: 5, created_at: 1, updated_at: 2 }],
      [{ id: 2, name: 'G', color: '', sort_order: 0, created_at: 0 }], ['p1']);
    expect(out).toEqual([{ id: 'p1', name: 'A', groupId: 2, groupName: 'G', running: true, lastOpenedAt: 5, createdAt: 1, lastScannedAt: null, loginState: 'unknown', loginCheckedAt: null, loginError: null }]);
    expect(JSON.stringify(out)).not.toMatch(/proxy|fingerprint|secret/);
  });

  test('lastScannedAt is the newest scanned group of that profile, null if never', () => {
    const base = { group_id: null, proxy_id: null, fingerprint: { seed: 1, hardwareConcurrency: 4, language: 'vi', timezone: 'x' }, note: '', last_opened_at: null, created_at: 1, updated_at: 2 };
    const out = toSafeProfiles([{ ...base, id: 'a', name: 'A' }, { ...base, id: 'b', name: 'B' }], [], [],
      { a: [{ scannedAt: 10 }, { scannedAt: 30 }] });
    expect(out.map((p) => p.lastScannedAt)).toEqual([30, null]);
  });
});

describe('toSafeProfiles login fields', () => {
  test('profiles.list has login fields with unknown default', () => {
    const base = { group_id: null, proxy_id: null, fingerprint: { seed: 1, hardwareConcurrency: 4, language: 'vi', timezone: 'x' }, note: '', last_opened_at: null, created_at: 1, updated_at: 2 };
    const out = toSafeProfiles([{ ...base, id: 'a', name: 'A' }, { ...base, id: 'b', name: 'B' }], [], [], {},
      [{ profileId: 'a', state: 'logged_out', checkedAt: 99, source: 'check', lastError: 'x', lastErrorAt: 98 }]);
    expect(out.map((p) => [p.loginState, p.loginCheckedAt, p.loginError])).toEqual([['logged_out', 99, 'x'], ['unknown', null, null]]);
  });
});

describe('control events', () => {
  test('briefs.finished retains only documented fields and omits absent error', () => {
    expect(buildBriefFinished({ profileId: 'p1', pageName: 'Page', ok: true, draftIds: ['d1'], claimedAt: 123, extra: 1 } as any))
      .toEqual({ profileId: 'p1', pageName: 'Page', ok: true, draftIds: ['d1'] });
    expect(buildBriefFinished({ profileId: 'p1', pageName: 'Page', ok: false, draftIds: [], error: 'Lỗi' }))
      .toEqual({ profileId: 'p1', pageName: 'Page', ok: false, draftIds: [], error: 'Lỗi' });
  });
  test('run.finished counts outcomes; draft.approved payload', () => {
    expect(buildRunFinished({ id: 'r', kind: 'post', status: 'done', scheduleId: 's' }, [{ outcome: 'posted' }, { outcome: 'posted' }, { outcome: 'failed' }, { outcome: 'skipped' }]))
      .toEqual({ runId: 'r', kind: 'post', status: 'done', scheduleId: 's', scheduleName: null, campaignId: null, posted: 2, failed: 1, skipped: 1 });
    expect(buildDraftApproved({ id: 's', name: 'n', kind: 'once', nextRunAt: 5 }, 'now')).toMatchObject({ scheduleId: 's', when: 'now' });
  });
  test('run.finished carries scheduleName', () => {
    const run = { id: 'r', kind: 'post' as const, status: 'done' as const, scheduleId: 's' };
    expect(buildRunFinished(run, [])).toMatchObject({ scheduleName: null });
    expect(buildRunFinished(run, [], 'Lịch sáng')).toMatchObject({ scheduleName: 'Lịch sáng' });
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

describe('parseBotIp', () => {
    test('accepts a single IPv4', () => expect(parseBotIp(' 203.0.113.7 ')).toBe('203.0.113.7'));
    test.each(['', '10.0.0.0/8', '1.2.3.4, 5.6.7.8', '::1', 'abc', '1.2.3'])('rejects %p', (v) => {
        expect(() => parseBotIp(v)).toThrow();
    });
    test('rejects non-string', () => expect(() => parseBotIp(undefined)).toThrow());
});

describe('withStoredPublicHost', () => {
    const base = { enabled: true, port: 47321, allowList: ['1.2.3.4'] };
    test('key absent keeps the stored value', () => {
        expect(validateConfigInput(withStoredPublicHost(base, 'a.example.com')).publicHost).toBe('a.example.com');
    });
    test.each([null, ''])('key present as %p clears it', (v) => {
        expect(validateConfigInput(withStoredPublicHost({ ...base, publicHost: v }, 'a.example.com')).publicHost).toBeNull();
    });
    test('key present valid replaces it', () => {
        expect(validateConfigInput(withStoredPublicHost({ ...base, publicHost: 'b.example.com' }, 'a.example.com')).publicHost).toBe('b.example.com');
    });
    test('undefined input does not throw', () => {
        expect(() => withStoredPublicHost(undefined, null)).not.toThrow();
    });
});

describe('control events: login checks', () => {
  test('buildLoginProblem keeps only the spec fields', () => {
    expect(buildLoginProblem({ profileId: 'p', profileName: 'Nick A', state: 'logged_out', source: 'check', extra: 1 } as any))
      .toEqual({ profileId: 'p', profileName: 'Nick A', state: 'logged_out', source: 'check' });
  });
  test('buildCheckFinished omits error when absent', () => {
    expect(buildCheckFinished({ checkId: 'c', source: 'daily', results: [
      { profileId: 'a', profileName: 'A', outcome: 'ok' },
      { profileId: 'b', profileName: 'B', outcome: 'error', error: 'timeout' },
    ] })).toEqual({ checkId: 'c', source: 'daily', results: [
      { profileId: 'a', profileName: 'A', outcome: 'ok' },
      { profileId: 'b', profileName: 'B', outcome: 'error', error: 'timeout' },
    ] });
    const first = buildCheckFinished({ checkId: 'c', source: 'api', results: [{ profileId: 'a', profileName: 'A', outcome: 'skipped' }] }).results[0];
    expect('error' in first).toBe(false);
  });
});

describe('control events: research', () => {
    it('buildResearchFinished keeps only the documented fields', () => {
        const payload = buildResearchFinished({ scanId: 's1', source: 'posts', query: 'kem', status: 'done', errorCode: '', itemCount: 7, extra: 1 } as any);
        expect(payload).toEqual({ scanId: 's1', source: 'posts', query: 'kem', status: 'done', errorCode: '', itemCount: 7 });
    });
});

describe('control events: post tracking', () => {
    it('buildTrackFinished keeps only the documented fields', () => {
        const input = { jobId: 'j1', auto: true, cancelled: false, groups: 2, checked: 5, found: 4, linked: 3, removedSuspected: 1, notFound: 0, errors: 0, extra: 9 };
        const { extra, ...expected } = input;
        expect(buildTrackFinished(input as any)).toEqual(expected);
    });
});

describe('control events: leads', () => {
    it('buildLeadsFound keeps only documented fields and at most 3 samples', () => {
        const sample = (i: number) => ({ authorName: `A${i}`, text: `t${i}`, postUrl: `u${i}`, authorUrl: 'x' });
        const out = buildLeadsFound({ count: 5, samples: [1, 2, 3, 4].map(sample), auto: true, extra: 1 } as any);
        expect(out).toEqual({
            count: 5, auto: true, leadIds: [], campaignIds: [],
            samples: [1, 2, 3].map((i) => ({ authorName: `A${i}`, text: `t${i}`, postUrl: `u${i}` })),
        });
    });
});

describe('control events: leads ids', () => {
    it('buildLeadsFound keeps leadIds / campaignIds and defaults them to []', () => {
        expect(buildLeadsFound({ count: 2, samples: [], auto: false, leadIds: [5, 4], campaignIds: ['c1'] })).toMatchObject({ leadIds: [5, 4], campaignIds: ['c1'] });
        expect(buildLeadsFound({ count: 2, samples: [], auto: false })).toMatchObject({ leadIds: [], campaignIds: [] });
    });
    it('buildRunFinished carries campaignId or null', () => {
        const run = { id: 'r', kind: 'post' as const, status: 'done' as const, scheduleId: 's' };
        expect(buildRunFinished({ ...run, campaignId: 'c9' }, [])).toMatchObject({ campaignId: 'c9' });
        expect(buildRunFinished(run, [])).toMatchObject({ campaignId: null });
    });
});

describe('control events: comment collection', () => {
    it('buildCollectFinished keeps only documented fields', () => {
        const input = { jobId: 'j1', auto: false, cancelled: true, posts: 3, collected: 20, leads: 2, errors: 1, extra: 'x' };
        expect(buildCollectFinished(input)).toEqual({ jobId: 'j1', auto: false, cancelled: true, posts: 3, collected: 20, leads: 2, errors: 1 });
    });
});

describe('control events: video', () => {
    it('buildVideoFinished keeps only documented fields and omits absent optional ones', () => {
        expect(buildVideoFinished({ videoId: 'v1', name: 'N', ok: true, durationSec: 20, sizeBytes: 5, mediaId: 'm', extra: 1 } as any))
            .toEqual({ videoId: 'v1', name: 'N', ok: true, durationSec: 20, sizeBytes: 5, mediaId: 'm' });
        expect(buildVideoFinished({ videoId: 'v2', name: 'M', ok: false, error: 'lỗi' } as any))
            .toEqual({ videoId: 'v2', name: 'M', ok: false, error: 'lỗi' });
        expect(buildVideoFinished({ videoId: 'v3', name: 'C', ok: false, error: 'Đã huỷ', cancelled: true }))
            .toEqual({ videoId: 'v3', name: 'C', ok: false, error: 'Đã huỷ', cancelled: true });
    });

    it('buildVideoFinished thêm warnings của video quảng cáo AI, bỏ khi mảng rỗng', () => {
        expect(buildVideoFinished({ videoId: 'a1', name: 'QC', ok: true, durationSec: 16.3, sizeBytes: 9, mediaId: 'm', warnings: ['stt_mismatch', 'fallback_still'] }))
            .toEqual({ videoId: 'a1', name: 'QC', ok: true, durationSec: 16.3, sizeBytes: 9, mediaId: 'm', warnings: ['stt_mismatch', 'fallback_still'] });
        expect(buildVideoFinished({ videoId: 'a2', name: 'QC', ok: true, warnings: [] }))
            .toEqual({ videoId: 'a2', name: 'QC', ok: true });
    });
});

describe('daily brief IPC wiring', () => {
    test('uses the current workspace, prepares each dbPath once, and emits briefs.finished', () => {
        const first = { ...memoryDb(), getDbPath: () => '/brief-a', getBrowserProfileById: (id: string) => id === 'p1' ? { id } : undefined };
        const second = { ...memoryDb(), getDbPath: () => '/brief-b', getBrowserProfileById: () => undefined };
        let current = first;
        const prepareFirst = jest.spyOn(first, 'exec');
        const prepareSecond = jest.spyOn(second, 'exec');
        jest.doMock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => current } }));
        jest.doMock('../../../electron/ipc/facebookPosterIpc', () => ({ learnPages: jest.fn() }));
        try {
            jest.isolateModules(() => {
                const { briefOperations: ops, getDailyBriefStore } = require('../../../electron/ipc/dailyBriefIpc');
                const events = require('../../services/control/controlEvents');
                const emitted = jest.fn();
                events.setControlEventSink(emitted);
                const store = getDailyBriefStore();
                store.upsertIdentity({ profileId: 'p1', kind: 'page', pageId: '123', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: 1, errorCode: '', error: '' });
                ops.save({ profileId: 'p1', keywords: ['x'], time: '00:00' });
                const claimed = ops.claimDue().briefs[0];
                expect(claimed).toMatchObject({ profileId: 'p1', pageName: 'Page' });
                ops.finish({ profileId: 'p1', claimedAt: claimed.claimedAt, ok: true, draftIds: ['d1'] });
                expect(emitted).toHaveBeenCalledWith('briefs.finished', { profileId: 'p1', pageName: 'Page', ok: true, draftIds: ['d1'] });
                current = second;
                expect(ops.list()).toEqual({ briefs: [] });
                expect(() => ops.save({ profileId: 'p1', keywords: ['x'] })).toThrow();
                current = first;
                expect(ops.get({ profileId: 'p1' }).brief.lastRunDate).not.toBeNull();
                expect(prepareFirst).toHaveBeenCalledTimes(1);
                expect(prepareSecond).toHaveBeenCalledTimes(1);
                events.setControlEventSink(null);
            });
        } finally { jest.dontMock('../../services/database/DatabaseService'); jest.dontMock('../../../electron/ipc/facebookPosterIpc'); }
    });

    test('connects ControlMethodDeps.briefs to the actual briefOperations export', async () => {
        const mockedModules = [
            '../../services/database/DatabaseService', '../../services/control/ControlEventRecorder',
            '../../services/control/ControlMethods', '../../../electron/ipc/facebookPosterIpc',
            '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc',
            '../../../electron/ipc/inboxMedia', '../../../electron/ipc/browserProfileIpc',
            '../../utils/Logger', '../../../electron/ipc/workspaceIpc',
        ];
        let captured: any;
        let api: any;
        let expected: any;
        jest.doMock(mockedModules[0], () => ({ __esModule: true, default: { getInstance: () => ({
            getSetting: () => JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'] }),
        }) } }));
        jest.doMock(mockedModules[1], () => ({ ControlEventRecorder: class { sync() {} deactivate() {} } }));
        jest.doMock(mockedModules[2], () => ({ createControlMethods: (deps: any) => { captured = deps; throw new Error('Captured before opening sockets'); } }));
        jest.doMock(mockedModules[3], () => ({ stopPageCampaignExecution: async () => true, setPageCampaignExecutionContext() {}, isFacebookPosterEmployeeBlocked: () => false,
            posterOperations: {}, trackingOperations: {}, campaignOperations: {}, leadOperations: {} }));
        jest.doMock(mockedModules[4], () => ({ researchOperations: {} }));
        jest.doMock(mockedModules[5], () => ({ videoOperations: {} }));
        jest.doMock(mockedModules[6], () => ({ getInboxMediaStore: () => ({}) }));
        jest.doMock(mockedModules[7], () => ({}));
        jest.doMock(mockedModules[8], () => ({ __esModule: true, default: { error: jest.fn() } }));
        jest.doMock(mockedModules[9], () => ({ isWorkspaceSwitchInProgress: () => false }));
        try {
            jest.isolateModules(() => {
                expected = require('../../../electron/ipc/dailyBriefIpc');
                api = require('../../../electron/ipc/controlApiIpc');
            });
            await api.restartControlApi();
            expect(captured?.briefs).toBe(expected.briefOperations);
            expect(captured?.pages).toBe(expected.pageOperations);
            expect(captured?.pages).toBeDefined();
            expect(captured?.briefs).toBeDefined();
        } finally {
            await api?.shutdownControlApi();
            mockedModules.forEach((name) => jest.dontMock(name));
        }
    });
});

describe('pages event sanitization', () => {
    test('projects only the public fields at both levels, omitting absent error', () => {
        const e = { jobId: 'j1', html: 'PRIVATE', results: [
            { profileId: 'p1', kind: 'page' as const, pageName: 'Page', token: 'SECRET', recentPosts: [] },
            { profileId: 'p2', kind: 'unknown' as const, pageName: '', error: 'safe error', cookie: 'SECRET' },
        ] };
        expect(buildPagesLearnFinished(e)).toEqual({ jobId: 'j1', results: [
            { profileId: 'p1', kind: 'page', pageName: 'Page' },
            { profileId: 'p2', kind: 'unknown', pageName: '', error: 'safe error' },
        ] });
    });
});


test('brief completion builder projects optional historical failure snapshots', () => {
    expect(buildBriefFinished({ profileId: 'p', pageName: 'Page', ok: false, draftIds: [],
        attempts: 3, attemptDate: '2026-10-26', privateData: 'omit' } as any))
        .toEqual({ profileId: 'p', pageName: 'Page', ok: false, draftIds: [], attempts: 3, attemptDate: '2026-10-26' });
});

describe('real protected IPC adapters and retired DB lifetimes', () => {
    let api: any; let posterIpc: any; let server: any; let options: any; let database: any; let activeDb: any; let originalDb: any;
    let workspace: string; let file: string; let blocked: boolean; let openActor: () => Promise<void>; let closes: number;
    let researchBoundary: () => Promise<any>; let videoBoundary: () => Promise<any>; let gate: boolean;
    let workspaceModule: any; let workspaceManager: any; let workspaceHandlers: Record<string, any>; let legacyResearchStopped: boolean;
    let maintenanceCallbacks: (() => void)[];
    let research: any; let researchStore: any; let inbox: InboxMediaStore; let broadcaster: any;
    let researchAdapter: any; let realResearchLifecycle: boolean; let nativeDrain: jest.Mock;
    const modules = ['electron', 'xlsx', '../../services/database/DatabaseService', '../../utils/WorkspaceManager', '../../utils/AppModeManager',
        '../../services/control/ControlApiServer', '../../services/control/CertificateStore', '../../services/ai/AIAssistantService',
        '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc', '../../../electron/ipc/inboxMedia',
        '../../../electron/ipc/workspaceIpc', '../../services/dailyBrief/pageIdentity', '../../services/event/EventBroadcaster',
        '../../services/file/FileStorageService', '../../services/http/HttpConnectionManager', '../../services/http/HttpRelayService', '../../utils/ConnectionManager'];
    beforeEach(async () => {
        workspace = 'workspace'; file = path.join(dir, 'workspace.db'); blocked = false; closes = 0; gate = true; openActor = async () => undefined;
        workspaceModule = undefined; workspaceHandlers = {}; legacyResearchStopped = true; maintenanceCallbacks = [];
        realResearchLifecycle = false; nativeDrain = jest.fn(async () => true);
        const setInterval = global.setInterval;
        jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: number, ...args: any[]) => {
            if (ms === 3600000) maintenanceCallbacks.push(fn); return setInterval(fn, ms, ...args);
        }) as any);
        workspaceManager = { getActiveWorkspace: () => ({ id: workspace }), getActiveWorkspaceId: () => workspace,
            canDeleteWorkspace: () => ({ success: true }), deleteWorkspace: jest.fn(() => { throw new Error('Unexpected active delete'); }) };
        researchBoundary = async () => { throw new Error('External research boundary not used'); };
        videoBoundary = async () => { throw new Error('External video boundary not used'); };
        activeDb = memoryDb(); originalDb = activeDb;
        database = { exec: (s: string) => activeDb.exec(s), run: (s: string, p?: unknown[]) => activeDb.run(s, p),
            runInsert: (s: string, p?: unknown[]) => activeDb.runInsert(s, p), query: (s: string, p?: unknown[]) => activeDb.query(s, p),
            queryOne: (s: string, p?: unknown[]) => activeDb.queryOne(s, p), transaction: (fn: () => unknown) => activeDb.transaction(fn),
            getDbPath: () => file, getSetting: () => JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'], protectedWritesEnabled: gate }),
            getBrowserProfileById: (id: string) => ({ id }), getBrowserProfiles: () => [{ id: 'profile', name: 'Profile' }] };
        database.exec(require('../../services/control/ControlStore').CONTROL_SCHEMA_SQL);
        new (require('../../services/facebookPoster/FacebookPosterStore').FacebookPosterStore)(database).ensureSchema();
        inbox = new InboxMediaStore(path.join(dir, 'inbox')); broadcaster = { emit: jest.fn() };
        const readFile = fs.readFileSync;
        jest.spyOn(require('fs'), 'readFileSync').mockImplementation(((name: any, ...args: any[]) => String(name).endsWith('maihub_bridge.py') ? Buffer.from('# test bridge') : (readFile as any)(name, ...args)) as any);
        jest.doMock(modules[0], () => ({ app: { getPath: () => dir, getAppPath: () => process.cwd(), getVersion: () => '1.0' }, ipcMain: { handle: (name: string, fn: any) => { workspaceHandlers[name] = fn; } }, safeStorage: {}, dialog: {}, BrowserWindow: { getAllWindows: () => [] } }));
        jest.doMock(modules[1], () => ({}));
        jest.doMock(modules[2], () => ({ __esModule: true, default: { getInstance: () => database } }));
        jest.doMock(modules[3], () => ({ __esModule: true, default: { getInstance: () => workspaceManager } }));
        jest.doMock(modules[4], () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => blocked }) } }));
        jest.doMock(modules[5], () => { const Actual = jest.requireActual('../../services/control/ControlApiServer').ControlApiServer;
            return { ...jest.requireActual('../../services/control/ControlApiServer'), ControlApiServer: class extends Actual {
                constructor(o: any) { super(o); options = o; server = this; } async start() {} async stop() {} } }; });
        jest.doMock(modules[6], () => ({ CertificateStore: class { async ensure() { return {}; } }, CertificateKeyUnreadableError: class extends Error {} }));
        jest.doMock(modules[7], () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null }) } }));
        jest.doMock(modules[8], () => ({
            pauseBrowserProfileAdmission: () => {}, resumeBrowserProfileAdmission: () => {},
            retireBrowserProfileGeneration: () => {}, closeAllBrowserProfilesAndWait: () => nativeDrain(),
            isBrowserEngineInstalled: () => true, getBrowserProfileService: () => ({
            onAvailabilityChanged: () => () => {}, tryReserveAutomation: (profileId: string) => ({ profileId }),
            releaseAutomationReservation: () => {}, isRunning: () => false, canReserveAutomation: () => true,
            openForAutomation: async () => { await openActor(); return { context: { once: jest.fn(), pages: () => [{}] }, close: async () => { closes++; } }; }, getRunningIds: () => [] }) }));
        jest.doMock(modules[9], () => ({ researchOperations: {},
            getResearchStore: () => realResearchLifecycle ? researchAdapter.getResearchStore() : researchStore,
            getResearchService: () => realResearchLifecycle ? researchAdapter.getResearchService() : research,
            cancelOwnedResearchScan: (scanId: string) => realResearchLifecycle ? researchAdapter.cancelOwnedResearchScan(scanId) : research?.cancelOwned(scanId) ?? false,
            cancelResearch: () => realResearchLifecycle ? researchAdapter.cancelResearch() : research?.stop(),
            retireResearchService: () => { if (realResearchLifecycle) researchAdapter.retireResearchService(); },
            isResearchRunning: () => realResearchLifecycle ? researchAdapter.isResearchRunning() : research?.isRunning() ?? false,
            RESEARCH_NOT_STOPPED_ERROR: 'Research not stopped',
            cancelAndWaitResearch: () => realResearchLifecycle ? researchAdapter.cancelAndWaitResearch() : Promise.resolve(legacyResearchStopped),
        }));
        jest.doMock(modules[10], () => ({ videoOperations: {}, getPageWorkVideoOperations: () => ({
            status: ({ videoId }: any) => ({ video: new (require('../../services/video/VideoStore').VideoStore)(database).get(videoId) }),
            openFile: () => videoBoundary() }) }));
        jest.doMock(modules[11], () => ({ getInboxMediaStore: () => inbox }));
        jest.doMock(modules[12], () => ({ isWorkspaceSwitchInProgress: () => workspaceModule?.isWorkspaceSwitchInProgress() ?? false }));
        jest.doMock(modules[13], () => ({ readPageIdentity: async (_page: unknown, o: any) => { o.assertCurrent(); return { kind: 'page', pageId: 'page' }; } }));
        jest.doMock(modules[14], () => ({ __esModule: true, default: broadcaster }));
        for (const name of modules.slice(15)) jest.doMock(name, () => ({ __esModule: true, default: { getInstance: () => ({}), getAllConnections: () => new Map() } }));
        jest.isolateModules(() => {
            posterIpc = require('../../../electron/ipc/facebookPosterIpc'); api = require('../../../electron/ipc/controlApiIpc');
            researchStore = new (require('../../services/research/ResearchStore').ResearchStore)(database); researchStore.ensureSchema();
            const shared = posterIpc.getProfileJobBinding();
            research = new (require('../../services/research/ResearchService').ResearchService)({ store: researchStore, ...shared,
                listProfiles: () => [{ id: 'profile', name: 'Profile' }], isProfileBusy: () => false, loginStates: () => [], groupMembership: () => ({}),
                readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), observeLogin() {}, emit() {}, now: Date.now, sleep: async () => undefined,
                openSession: () => researchBoundary() });
            researchAdapter = jest.requireActual('../../../electron/ipc/researchIpc');
            workspaceModule = jest.requireActual('../../../electron/ipc/workspaceIpc'); workspaceModule.registerWorkspaceIpc(null);
        });
        await api.restartControlApi();
    });
    afterEach(async () => { await api?.shutdownControlApi(); modules.forEach(name => jest.dontMock(name)); });
    function identityAndBusiness() {
        const Briefs = require('../../services/dailyBrief/DailyBriefStore').DailyBriefStore;
        const Business = require('../../services/dailyBrief/PageBusinessStore').PageBusinessStore;
        const briefs = new Briefs(database); briefs.upsertIdentity({ profileId: 'profile', kind: 'page', pageId: 'page', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: Date.now(), errorCode: '', error: '' });
        briefs.saveBrief('profile', { time: '00:00', draftsPerDay: 1 }, Date.now());
        const business = new Business(database); business.ensure('page', 'profile', Date.now()); business.setEnabled('page', true, 0, { confirmedAt: Date.now(), confirmationRef: 'owner' });
    }
    function key(kind = 'page_runner') {
        const policy = { kind, workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }], ...(kind === 'page_receiver' ? { ownerChatId: '1', ownerSenderId: '2' } : {}) };
        const created = options.store.createKey(kind, policy);
        const ctx = server.authorizationContext({ ...policy, keyId: created.id }, require('crypto').createHash('sha256').update(created.key).digest('hex'));
        return { ...created, ctx };
    }
    const run = (k: any, name: string, params = {}): Promise<any> => options.methods.find((m: any) => m.name === name).run(params, k.ctx);
    const invoke = async (credential: any, method: string, params: any, idempotencyKey?: string): Promise<any> => {
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ method, params, idempotencyKey }))]), { headers: {} });
        let response: any; const res = { on() {}, once() {}, writeHead() {}, end: (text: string) => { response = JSON.parse(text); } };
        await server.handleCall(request, res, credential.id, credential.name, '127.0.0.1', credential.ctx); return response;
    };
    const freshCredential = (credential: any) => ({ ...credential, ctx: server.authorizationContext(credential.ctx.principal,
        require('crypto').createHash('sha256').update(credential.key).digest('hex')) });
    test('campaignCollectorRetiresAndDrainsTheCapturedResearchBeforeDbClose',async()=>{
        identityAndBusiness();const runner=key(),receiver=key('page_receiver');
        const {work}=await run(runner,'pageWork.claimDue',{pageId:'page'});const now=Date.now();
        const campaigns=new (require('../../services/dailyBrief/PageCampaignStore').PageCampaignStore)(database);
        const scope={workspaceId:'workspace',pageId:'page',profileId:'profile'};
        const proposal=campaigns.saveProposal(scope,{workId:work.id,claimedAt:work.claimedAt},{name:'Measurements',goal:'',policy:{startsAt:now-1,expiresAt:now+604800000,maxPostsPerDay:1,maxPostsTotal:7,allowedMinutes:[420],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,actions:['schedulePost']}},null,now);
        const {campaignId}=campaigns.acceptProposal(scope,proposal.id,1,{confirmedAt:now,confirmationRef:'controlled-confirmation',receiverKeyId:receiver.id},now);
        database.run('INSERT INTO page_campaign_published VALUES (?,?,?,?,?,?)',[1,'workspace','page','profile',campaignId,JSON.stringify({...scope,campaignId,resultId:1,runId:'controlled-run',scheduleId:'controlled-schedule',runnerKeyId:runner.id,grantId:'controlled-grant',publishedAt:now-3600000,postId:'12345',postUrl:'https://www.facebook.com/page/posts/12345',sourceRef:'controlled-publish-proof',reason:'',selection:{variant:'A',contentRevision:'revision',factIds:[]}})]);
        let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),opened=new Promise<void>(resolve=>{entered=resolve;});
        researchBoundary=async()=>{entered();await waiting;return {session:{},readIdentity:async()=>({kind:'page',pageId:'page'}),close:async()=>{closes++;}};};
        const pending=invoke(runner,'pageCampaigns.collect',{workId:work.id,claimedAt:work.claimedAt,campaignId});
        await opened;expect(research.isRunning()).toBe(true);
        let drained=false;const stopping=api.stopPagePreparationForWorkspaceSwitch().then((value:boolean)=>{drained=true;return value;});
        await new Promise(resolve=>setImmediate(resolve));expect(drained).toBe(false);
        release();expect((await pending).ok).toBe(false);expect(await stopping).toBe(true);
        expect(research.isRunning()).toBe(false);expect(posterIpc.isFacebookPosterBusy()).toBe(false);expect(closes).toBe(1);
        expect(campaigns.listObservations(scope,campaignId,0,Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
    test('workspaceRetirementAwaitsOwnedCampaignExecutionBeforeAllowingDbClose',async()=>{
        let release!: (value:boolean)=>void;
        const drained=new Promise<boolean>(resolve=>{release=resolve;});
        const stop=jest.spyOn(posterIpc,'stopPageCampaignExecution').mockImplementation(()=>drained);
        let finished=false; const pending=api.stopPagePreparationForWorkspaceSwitch().then((value:boolean)=>{finished=true; return value;});
        await new Promise(resolve=>setImmediate(resolve));
        expect(stop).toHaveBeenCalledTimes(1); expect(finished).toBe(false);
        release(true); expect(await pending).toBe(true);
    });
    test('campaign HTTP registry scopes owner confirmation, durable events and pre-cache revocation', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver');
        const {work} = await run(runner, 'pageWork.claimDue', {pageId:'page'}); const now = Date.now();
        const p = {workId:work.id, claimedAt:work.claimedAt, expectedRevision:null, input:{name:'Pilot', goal:'Engagement', policy:{
            startsAt:now, expiresAt:now + 604800000, maxPostsPerDay:1, maxPostsTotal:7, allowedMinutes:[420],
            timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone, actions:['schedulePost']}}};
        const proposal = await invoke(runner, 'pageCampaigns.propose', p, 'campaign-proposal'); expect(proposal.ok).toBe(true);
        const action = {kind:'grantCampaign', pageId:'page', proposalId:proposal.result.id, expectedProposalRevision:1};
        expect((await invoke(runner, 'pageApprovals.prepare', {action})).error?.code).toBe('FORBIDDEN');
        expect((await invoke(runner, 'pageCampaigns.propose', {...p, input:{...p.input, owner:true}})).error?.code).toBe('INVALID_PARAMS');
        const prepared = await invoke(receiver, 'pageApprovals.prepare', {action}); expect(prepared.ok).toBe(true);
        const ticketId = prepared.result.ticket.id;
        await run(receiver, 'pageApprovals.bindMessage', {ticketId, chatId:'1', senderId:'2', messageId:10});
        const update = {updateId:1, messageId:11, chatId:'1', senderId:'2', replyToMessageId:10};
        const confirmed = await invoke(receiver, 'pageApprovals.confirm', {ticketId, update}, 'campaign-confirm'); expect(confirmed.ok).toBe(true);
        expect((await invoke(receiver, 'pageApprovals.confirm', {ticketId, update})).result.replayed).toBe(true);
        const params = {pageId:'page', campaignId:confirmed.result.resourceId};
        const view = await invoke(runner, 'pageCampaigns.get', params, 'campaign-get'); expect(view.ok).toBe(true);
        expect(view.result.grants).toHaveLength(1); expect(JSON.stringify(view)).not.toMatch(/confirmationRef|receiverKeyId|telegram:/);
        const missing = {...runner, ctx:{...runner.ctx, resources:{...runner.ctx.resources, getCampaignResource:undefined}}};
        expect((await invoke(missing, 'pageCampaigns.get', params, 'campaign-get')).error?.code).toBe('FORBIDDEN');
        database.run('DELETE FROM page_work_items WHERE id = ?', [work.id]);
        const report=await invoke(receiver,'pageCampaigns.report',params);
        expect(report.ok).toBe(true);expect(report.result.finance).toEqual({status:'unavailable',reason:'missing_financial_source'});
        const events = await invoke(receiver, 'pageWork.events', {after:0, timeoutSec:0});
        expect(events.result.events).toEqual(expect.arrayContaining([expect.objectContaining({type:'pageCampaigns.grantChanged', campaignId:params.campaignId})]));
        expect(JSON.stringify(events)).not.toMatch(/confirmationRef|receiverKeyId|telegram:/);
        const cache = jest.spyOn(options.idempotency, 'run'); options.store.revokeKey(runner.id);
        expect((await invoke(runner, 'pageCampaigns.get', params, 'campaign-get')).error?.code).toBe('FORBIDDEN'); expect(cache).not.toHaveBeenCalled();
        expect((await invoke(receiver, 'system.capabilities', {})).result).not.toHaveProperty('pageCampaigns');
    });
    test.each(['revoke', 'ABA'])('campaign read result is withheld after awaited authority change: %s', async change => {
        identityAndBusiness(); const runner = key();
        const method = options.methods.find((m: any) => m.name === 'pageCampaigns.list'); const original = method.run;
        method.run = async (params: any, context: any) => {
            const result = await original(params, context);
            if (change === 'revoke') options.store.revokeKey(runner.id);
            else {
                await api.stopControlApi(); workspace = 'other'; file = path.join(dir, 'other.db'); activeDb = memoryDb();
                workspace = 'workspace'; file = path.join(dir, 'workspace.db'); activeDb = originalDb;
            }
            return result;
        };
        const response = await invoke(runner, 'pageCampaigns.list', {pageId:'page'}, 'campaign-await');
        expect(response.error?.code).toBe('FORBIDDEN'); expect(response).not.toHaveProperty('result');
        expect(options.store.getIdempotent(runner.id, 'campaign-await')).toBeNull();
    });
    test('disabled mutation cannot replay a persisted live claim after actual runtime recovery', async () => {
        identityAndBusiness(); const runner = key(); const params = { pageId: 'page' };
        const first = await invoke(runner, 'pageWork.claimDue', params, 'gate-replay'); expect(first.ok).toBe(true);
        gate = false; await api.restartControlApi(); const current = freshCredential(runner);
        expect((await run(current, 'pageWork.get', { workId: first.result.work.id })).work.status).toBe('needs_review');
        await expect(run(current, 'pageWork.claimDue', params)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const cache = jest.spyOn(options.idempotency, 'run');
        expect((await invoke(current, 'pageWork.claimDue', params, 'gate-replay')).error?.code).toBe('FORBIDDEN');
        expect(cache).not.toHaveBeenCalled();
        expect((await invoke(current, 'pageWork.list', {})).ok).toBe(true);
    });
    test('actual pages.learn rechecks the current gate after its job-id await and before caching', async () => {
        identityAndBusiness(); const runner = key();
        database.run('UPDATE fb_page_identities SET learned_at = ?', [Date.now() - 3 * 86400000]);
        openActor = async () => { gate = false; };
        const response = await invoke(runner, 'pages.learn', { profileIds: ['profile'] }, 'learning-gate');
        expect(response.error?.code).toBe('FORBIDDEN');
        expect(options.store.getIdempotent(runner.id, 'learning-gate')).toBeNull();
        await posterIpc.cancelAndWaitFacebookPosterJobs();
    });
    test.each([false, true])('in-flight mutation owner and waiter reject current gate loss (provider rejection=%s)', async reject => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        let release!: () => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
        openActor = async () => { reached(); await new Promise<void>(resolve => { release = resolve; }); if (reject) throw new Error('private provider failure'); };
        const params = { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Not persisted' } };
        const owner = invoke(runner, 'pageWork.saveDraft', params, 'waiting-gate'); await entered;
        const waiter = invoke(runner, 'pageWork.saveDraft', params, 'waiting-gate'); await new Promise(resolve => setImmediate(resolve));
        gate = false; release(); const results = await Promise.all([owner, waiter]);
        for (const result of results) { expect(result.error?.code).toBe('FORBIDDEN'); expect(JSON.stringify(result)).not.toContain('private provider failure'); }
        expect(options.store.getIdempotent(runner.id, 'waiting-gate')).toBeNull();
        expect(database.query('SELECT * FROM fb_poster_schedules')).toEqual([]);
    });
    test('gate loss after a real committed body rejects the cache owner and its in-flight waiter', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        let release!: () => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
        openActor = async () => { reached(); await new Promise<void>(resolve => { release = resolve; }); };
        const notification = run(receiver, 'pageWork.events', { after: options.store.lastEventSeq(), timeoutSec: 25 }).then(() => { gate = false; });
        const params = { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Committed before gate loss' } };
        const owner = invoke(runner, 'pageWork.saveDraft', params, 'committed-flight'); await entered;
        const waiter = invoke(runner, 'pageWork.saveDraft', params, 'committed-flight'); await new Promise(resolve => setImmediate(resolve));
        release(); const results = await Promise.all([owner, waiter]); await notification;
        for (const result of results) expect(result.error?.code).toBe('FORBIDDEN');
        expect(database.query('SELECT * FROM fb_poster_schedules')).toHaveLength(1);
        expect(options.store.getIdempotent(runner.id, 'committed-flight')).toBeNull();
        expect((await run(runner, 'pageWork.get', { workId: work.id })).work.draftIds).toHaveLength(1);
    });
    async function historicalResearchWork() {
        identityAndBusiness();
        const { work } = await run(key(), 'pageWork.claimDue', { pageId: 'page' });
        const works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database);
        researchStore.createScan({ id: 'historical-scan', source: 'posts', query: 'product', params: {}, profileIds: ['profile'], origin: 'api', startedAt: Date.now() });
        researchStore.finishScan('historical-scan', 'done', '', '', {}, Date.now());
        works.linkResource(work.id, { kind: 'research', id: 'historical-scan' });
        return { work, works };
    }

    test('protected drain handles persisted research with no service while real admission remains paused', async () => {
        const { work, works } = await historicalResearchWork();
        realResearchLifecycle = true;
        posterIpc.pauseFacebookJobAdmission();
        expect(() => researchAdapter.getResearchService()).toThrow('Đang đổi workspace');
        const factory = jest.spyOn(researchAdapter, 'getResearchService');
        try {
            expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
            expect(factory).not.toHaveBeenCalled();
            expect(researchAdapter.isResearchRunning()).toBe(false);
            expect(works.get(work.id).status).toBe('needs_review');
            expect(() => researchAdapter.researchOperations.search({ source: 'posts', query: 'new' }, 'api')).toThrow('Đang đổi workspace');
        } finally { factory.mockRestore(); posterIpc.resumeFacebookJobAdmission(); }
    });

    test('workspace retry reaches the DB mutation boundary after research drained and native confirmation failed', async () => {
        await historicalResearchWork();
        realResearchLifecycle = true;
        researchAdapter.getResearchService(); // First attempt has an idle retained service; the research drain removes it.
        jest.spyOn(posterIpc, 'startFacebookPosterScheduler').mockImplementation(() => undefined);
        jest.spyOn(posterIpc, 'stopFacebookPosterScheduler').mockImplementation(() => undefined);
        nativeDrain.mockResolvedValueOnce(false).mockResolvedValue(true);
        workspaceManager.deleteWorkspace.mockReturnValue({ success: false, error: 'DB mutation boundary' });
        const first = await workspaceHandlers['workspace:delete']({}, { id: 'workspace' });
        expect(first).toEqual({ success: false, error: 'Việc Đăng Facebook chưa dừng được. Thử lại sau.' });
        expect(nativeDrain).toHaveBeenCalledTimes(1); expect(workspaceManager.deleteWorkspace).not.toHaveBeenCalled();
        expect(activeDb).toBe(originalDb); expect(posterIpc.isFacebookJobAdmissionPaused()).toBe(false);
        const second = await workspaceHandlers['workspace:delete']({}, { id: 'workspace' });
        expect(second).toEqual({ success: false, error: 'DB mutation boundary' });
        expect(nativeDrain).toHaveBeenCalledTimes(2); expect(workspaceManager.deleteWorkspace).toHaveBeenCalledTimes(1);
        expect(activeDb).toBe(originalDb); expect(posterIpc.isFacebookJobAdmissionPaused()).toBe(false);
    });

    test('non-creating research cancellation retains scan ownership checks and permits cleanup under paused admission', async () => {
        realResearchLifecycle = true;
        const current = researchAdapter.getResearchService();
        current.reserveSearch({ source: 'posts', query: 'product', origin: 'api' }, {
            scanId: 'owned-scan', profileId: 'profile', pageId: 'page', assertCurrent: () => {},
        });
        posterIpc.pauseFacebookJobAdmission();
        try {
            expect(researchAdapter.cancelOwnedResearchScan('other-scan')).toBe(false);
            expect(current.isRunning()).toBe(true);
            expect(researchAdapter.cancelOwnedResearchScan('owned-scan')).toBe(true);
            await current.whenIdle();
            expect(researchStore.getScan('owned-scan').status).toBe('cancelled');
            expect(() => current.search({ source: 'posts', query: 'new', origin: 'api' })).toThrow('Đang đổi workspace');
            expect(await researchAdapter.cancelAndWaitResearch()).toBe(true);
            expect(researchAdapter.cancelOwnedResearchScan('owned-scan')).toBe(false);
            expect(() => researchAdapter.getResearchService()).toThrow('Đang đổi workspace');
        } finally {
            current.cancel(); await current.whenIdle(); posterIpc.resumeFacebookJobAdmission();
        }
    });

    test('first protected-drain callback cannot admit poster or side work before the workspace await', async () => {
        jest.spyOn(posterIpc, 'startFacebookPosterScheduler').mockImplementation(() => undefined);
        jest.spyOn(posterIpc, 'stopFacebookPosterScheduler').mockImplementation(() => undefined);
        let rejected = 0;
        let paused = false;
        const before = database.query('SELECT * FROM fb_poster_runs');
        jest.spyOn(api, 'stopPagePreparationForWorkspaceSwitch').mockImplementation(async () => {
            paused = posterIpc.isFacebookJobAdmissionPaused();
            const attempts = [
                () => posterIpc.posterOperations.start({ kind: 'scan_groups', params: { profileIds: ['profile'] } }),
                () => posterIpc.checkFacebookLogins([], 'manual'),
                () => posterIpc.learnPages(['profile'], false),
                () => posterIpc.trackingOperations.track({}),
                () => posterIpc.leadOperations.collect({}),
            ];
            for (const attempt of attempts) { try { attempt(); } catch { rejected++; } }
            return false;
        });
        const result = await workspaceHandlers['workspace:delete']({}, { id: 'workspace' });
        expect(result.success).toBe(false); expect(paused).toBe(true); expect(rejected).toBe(5);
        expect(database.query('SELECT * FROM fb_poster_runs')).toEqual(before);
        expect(workspaceManager.deleteWorkspace).not.toHaveBeenCalled();
        expect(posterIpc.isFacebookJobAdmissionPaused()).toBe(false);
    });
    test.each(['protected-refusal', 'protected-rejection', 'research', 'poster', 'poster-rejection'])('refused active deletion rebuilds fresh authority on the retained actual DB: %s', async failure => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        jest.spyOn(posterIpc, 'startFacebookPosterScheduler').mockImplementation(() => undefined);
        jest.spyOn(posterIpc, 'stopFacebookPosterScheduler').mockImplementation(() => undefined);
        let release!: () => void; let pending: Promise<any> | undefined;
        const stop = api.stopPagePreparationForWorkspaceSwitch;
        if (failure === 'protected-refusal') {
            let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
            openActor = () => new Promise<void>(resolve => { release = resolve; entered(); });
            pending = run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Retired' } }).catch((error: any) => error);
            await reached;
            jest.spyOn(api, 'stopPagePreparationForWorkspaceSwitch').mockImplementation(() => stop(1));
        } else if (failure === 'protected-rejection') jest.spyOn(api, 'stopPagePreparationForWorkspaceSwitch').mockImplementation(async () => { await stop(50); throw new Error('drain rejected'); });
        else if (failure === 'research') legacyResearchStopped = false;
        else if (failure === 'poster-rejection') jest.spyOn(posterIpc, 'cancelAndWaitFacebookPosterJobs').mockRejectedValue(new Error('poster cleanup rejected'));
        else jest.spyOn(posterIpc, 'cancelAndWaitFacebookPosterJobs').mockResolvedValue(false);
        const response = await workspaceHandlers['workspace:delete']({}, { id: 'workspace' });
        if (pending) { release(); expect(await pending).toMatchObject({ code: 'FORBIDDEN' }); }
        expect(response.success).toBe(false);
        expect(response.error).toBe(failure.startsWith('protected-') ? 'Công việc Page chưa dừng an toàn. Thử lại sau.'
            : failure === 'research' ? 'Research not stopped'
                : failure === 'poster-rejection' ? 'poster cleanup rejected' : 'Việc Đăng Facebook chưa dừng được. Thử lại sau.');
        expect(workspace).toBe('workspace'); expect(activeDb).toBe(originalDb);
        expect(workspaceManager.deleteWorkspace).not.toHaveBeenCalled(); expect(workspaceModule.isWorkspaceSwitchInProgress()).toBe(false);
        expect(() => runner.ctx.assertCurrent()).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        const current = freshCredential(runner);
        expect((await run(current, 'pageWork.list')).items).toHaveLength(1);
        expect((await run(current, 'pageWork.get', { workId: work.id })).work.status).toBe('needs_review');
    });
    test.each(['startup', 'hourly'])('actual %s maintenance prunes only expired terminal journals in the captured workspace', async entry => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const lease = { workId: work.id, claimedAt: work.claimedAt };
        const saved = await run(runner, 'pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'Durable after retention' } });
        const works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database);
        const videos = new (require('../../services/video/VideoStore').VideoStore)(database); videos.ensureSchema();
        database.run("INSERT INTO video_jobs (id,name,source,spec_json,status,created_at) VALUES ('retained-video','Requested','bot','{}','done',?)", [Date.now()]);
        works.linkResource(work.id, { kind: 'video', id: 'retained-video' });
        await run(runner, 'pageWork.finish', { ...lease, reason: 'prepared', evidenceRefs: [] });
        const old = Date.now() - 31 * 86400000;
        database.run('UPDATE page_work_items SET updated_at = ? WHERE id = ?', [old, work.id]);
        for (const status of ['failed', 'cancelled', 'pending', 'running', 'waiting', 'needs_review', 'completed']) {
            database.run(`INSERT INTO page_work_items (id,workspace_id,page_id,profile_id,brief_date,status,wait_for,video_id,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`, [`sentinel-${status}`, 'workspace', `keep-${status}`, 'profile', 'previous', status,
                status === 'waiting' ? 'video' : null, status === 'waiting' ? 'waiting-video' : null, status === 'completed' ? Date.now() : old]);
        }
        database.run("INSERT INTO page_work_items (id,workspace_id,page_id,profile_id,brief_date,status,updated_at) VALUES ('foreign-retained','foreign','foreign','profile','previous','failed',?)", [old]);
        if (entry === 'startup') await api.restartControlApi(); else maintenanceCallbacks[maintenanceCallbacks.length - 1]();
        expect(works.get(work.id)).toBeNull(); expect(works.getStep(work.id, 'draft:0')).toBeNull();
        for (const status of ['failed', 'cancelled']) expect(works.get(`sentinel-${status}`)).toBeNull();
        for (const status of ['pending', 'running', 'waiting', 'needs_review', 'completed']) {
            expect(works.get(`sentinel-${status}`)).not.toBeNull();
            if (entry === 'hourly') expect(works.get(`sentinel-${status}`).status).toBe(status);
        }
        expect(works.get('foreign-retained')).not.toBeNull();
        expect(works.getResourceOwner({ kind: 'draft', id: saved.draftId }).workId).toBe(work.id);
        expect(works.getResourceOwner({ kind: 'video', id: 'retained-video' }).workId).toBe(work.id); expect(videos.get('retained-video')).not.toBeNull();
        const current = entry === 'startup' ? freshCredential(receiver) : receiver;
        const { ticket } = await run(current, 'pageApprovals.prepare', { action: { kind: 'approveDraft', pageId: 'page', draftId: saved.draftId, expectedRevision: saved.revision, timing: { when: 'now' } } });
        await run(current, 'pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 });
        expect((await run(current, 'pageApprovals.confirm', { ticketId: ticket.id, update: { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 } })).resourceId).toBe(saved.draftId);
    });
    test('retired hourly callback cannot maintain a replacement DB through the same singleton wrapper', async () => {
        const oldMaintenance = maintenanceCallbacks[maintenanceCallbacks.length - 1];
        workspace = 'other'; file = path.join(dir, 'other.db'); activeDb = memoryDb();
        const works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database); works.ensureSchema();
        database.run("INSERT INTO page_work_items (id,workspace_id,page_id,profile_id,brief_date,status,updated_at) VALUES ('other-expired','other','other','profile','previous','failed',0)");
        database.run("INSERT INTO control_events (type,payload,created_at) VALUES ('retained','{}',0)");
        oldMaintenance();
        expect(works.get('other-expired')).not.toBeNull(); expect(database.query('SELECT * FROM control_events')).toHaveLength(1);
        workspace = 'workspace'; file = path.join(dir, 'workspace.db'); activeDb = originalDb;
    });
    test('every registered scoped method rejects unknown top-level params before its operation', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const lease = { workId: work.id, claimedAt: work.claimedAt };
        const saved = await run(runner, 'pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'Ready' } });
        const works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database);
        researchStore.createScan({ id: 'scan', source: 'posts', query: 'product', params: {}, profileIds: ['profile'], origin: 'api', startedAt: Date.now() });
        researchStore.finishScan('scan', 'done', '', '', {}, Date.now()); works.linkResource(work.id, { kind: 'research', id: 'scan' });
        works.linkResource(work.id, { kind: 'video', id: 'video' });
        const action = { kind: 'confirmFact', pageId: 'page', expectedRevision: 1, fact: { topic: 'product', value: 'Owner', reason: '' } };
        const { ticket } = await run(receiver, 'pageApprovals.prepare', { action });
        await run(receiver, 'pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 });
        const cases: [string, any, any][] = [
            ['system.capabilities', {}, runner], ['pageBusiness.get', { pageId: 'page' }, runner],
            ['pageBusiness.propose', { ...lease, expectedRevision: 1, fact: { topic: 'product', value: 'Product', reason: '', status: 'observed', sourceType: 'page', sourceRef: 'page:profile:1', observedAt: 1 } }, runner],
            ['pageWork.list', {}, runner], ['pageWork.get', { workId: work.id }, runner], ['pageWork.claimDue', { pageId: 'page' }, runner],
            ['pageWork.research', { ...lease, input: { kind: 'search', keywords: ['product'] } }, runner],
            ['pageWork.researchResult', { workId: work.id, scanId: 'scan' }, runner],
            ['pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'Other' } }, runner],
            ['pageWork.draft', { workId: work.id, draftId: saved.draftId }, runner], ['pageWork.waitVideo', { ...lease, videoId: 'video' }, runner],
            ['pageWork.reconcile', { workId: work.id }, runner], ['pageWork.finish', { ...lease, reason: '', evidenceRefs: [] }, runner],
            ['pageWork.fail', { ...lease, code: 'busy', reason: '' }, runner], ['pageApprovals.prepare', { action }, receiver],
            ['pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 }, receiver],
            ['pageApprovals.confirm', { ticketId: ticket.id, update: { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 } }, receiver],
            ['pageWork.events', { after: 0, timeoutSec: 0 }, receiver],
        ];
        for (const [name, params, credential] of cases) await expect(run(credential, name, { ...params, unexpected: true })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        expect(works.getApproval(ticket.id).consumedAt).toBeNull(); expect(works.get(work.id).status).toBe('running');
    });
    test.each(['resolve', 'reject', 'revoke', 'employee'])('real actor/lease cleanup survives retirement or authority loss: %s', async outcome => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void; openActor = async () => { await new Promise<void>(resolve => { release = resolve; entered(); }); if (outcome === 'reject') throw new Error('open rejected'); };
        const pending = run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Not saved' } }).then(value => ({ value }), error => ({ error }));
        await reached;
        if (outcome === 'revoke') options.store.revokeKey(runner.id);
        if (outcome === 'employee') blocked = true;
        expect(await api.stopPagePreparationForWorkspaceSwitch(1)).toBe(false);
        expect(database.queryOne('SELECT status FROM page_work_items WHERE id = ?', [work.id]).status).toBe('needs_review');
        release(); const result = await pending; expect(result).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
        expect(database.query('SELECT * FROM fb_poster_schedules')).toEqual([]);
        if (outcome !== 'reject') expect(closes).toBe(1);
        workspace = 'other'; file = path.join(dir, 'other.db'); activeDb = memoryDb();
        workspace = 'workspace'; file = path.join(dir, 'workspace.db'); activeDb = originalDb;
        expect(() => runner.ctx.assertCurrent()).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
    test.each(['open-resolve', 'open-reject', 'media-save'])('actual video adoption retirement waits and marks ambiguous waiting intent: %s', async stage => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const Video = require('../../services/video/VideoStore').VideoStore; const videos = new Video(database); videos.ensureSchema();
        database.run("INSERT INTO video_jobs (id,name,source,spec_json,status,created_at) VALUES ('video','Requested','bot','{}','done',?)", [Date.now()]);
        const Work = require('../../services/dailyBrief/PageWorkStore').PageWorkStore; const works = new Work(database); works.linkResource(work.id, { kind: 'video', id: 'video' });
        await run(runner, 'pageWork.waitVideo', { workId: work.id, claimedAt: work.claimedAt, videoId: 'video' });
        let release!: () => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
        const stream = new Readable({ read() {} });
        videoBoundary = async () => {
            if (stage !== 'media-save') { reached(); await new Promise<void>(resolve => { release = resolve; }); if (stage === 'open-reject') throw new Error('video open failed'); }
            else { release = () => { stream.push(Buffer.from('video')); stream.push(null); }; setImmediate(reached); }
            return { stream, size: 5 };
        };
        gate = false;
        await expect(run(runner, 'pageWork.reconcile', { workId: work.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(works.get(work.id).step).toBeNull();
        gate = true;
        const pending = run(runner, 'pageWork.reconcile', { workId: work.id }).then(value => ({ value }), error => ({ error }));
        await entered; expect(await api.stopPagePreparationForWorkspaceSwitch(1)).toBe(false);
        const retiredStatus = works.get(work.id).status;
        release(); expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(retiredStatus).toBe('needs_review');
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
        expect(works.getVideoMediaIds(work.id, 'video')).toEqual([]);
        if (stage !== 'open-reject') expect(stream.destroyed).toBe(true);
    });
    test.each([false, true])('owned research cancellation drains actual reservation/session on success or rejection: %s', async reject => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        let release!: () => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
        researchBoundary = async () => { reached(); await new Promise<void>(resolve => { release = resolve; }); if (reject) throw new Error('research open failed');
            return { session: { open: async () => undefined }, readIdentity: async () => ({ kind: 'page', pageId: 'page' }), close: async () => { closes++; } }; };
        const pending = run(runner, 'pageWork.research', { workId: work.id, claimedAt: work.claimedAt, input: { kind: 'search', keywords: ['product'] } }).then(value => ({ value }), error => ({ error }));
        await entered; expect(research.isRunning()).toBe(true);
        expect(await api.stopPagePreparationForWorkspaceSwitch(1)).toBe(false);
        release(); expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
        expect(research.isRunning()).toBe(false);
        expect(database.queryOne('SELECT status FROM page_work_items WHERE id = ?', [work.id]).status).toBe('needs_review');
    });
    test('real bound receiver keeps unowned resources unavailable and approval hints occur only after commit once', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const saved = await run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Ready' } });
        const deps = posterIpc.createBoundPageApprovalDependencies(receiver.ctx.assertCurrent);
        expect(deps.db).toBe(database);
        database.run("INSERT INTO video_jobs (id,name,source,spec_json,status,created_at) VALUES ('legacy','Legacy','bot',?,'done',?)", [JSON.stringify({ pageId: 'page', profileId: 'profile' }), Date.now()]);
        expect(deps.inspectResource({ kind: 'video', id: 'legacy' }, work)).toBeNull();
        expect(deps.inspectResource({ kind: 'draft', id: saved.draftId }, work)).toMatchObject({ workspaceId: 'workspace', pageId: 'page', profileId: 'profile' });
        const media = await inbox.save('a.png', 'image/png', Readable.from(['image']));
        expect(deps.inspectResource({ kind: 'media', id: media.mediaId }, work)).toBeNull();
        const { ticket } = await run(receiver, 'pageApprovals.prepare', { action: { kind: 'approveDraft', pageId: 'page', draftId: saved.draftId, expectedRevision: saved.revision, timing: { when: 'now' } } });
        await run(receiver, 'pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 });
        const params = { ticketId: ticket.id, update: { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 } };
        database.exec("CREATE TRIGGER fail_approval_consume BEFORE UPDATE ON page_owner_approvals WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'consume failed'); END;");
        await expect(run(receiver, 'pageApprovals.confirm', params)).rejects.toMatchObject({ code: 'INTERNAL' });
        expect(database.queryOne('SELECT draft FROM fb_poster_schedules WHERE id = ?', [saved.draftId]).draft).toBe(1);
        expect(options.store.listEventsAfter(0, 100).filter((e: any) => e.type === 'draft.approved')).toHaveLength(0);
        expect(broadcaster.emit.mock.calls.filter((c: any) => c[0] === 'facebookPoster:schedulesChanged')).toHaveLength(0);
        database.exec('DROP TRIGGER fail_approval_consume');
        expect((await run(receiver, 'pageApprovals.confirm', params)).replayed).toBe(false);
        expect((await run(receiver, 'pageApprovals.confirm', params)).replayed).toBe(true);
        expect(options.store.listEventsAfter(0, 100).filter((e: any) => e.type === 'draft.approved')).toHaveLength(1);
        expect(broadcaster.emit.mock.calls.filter((c: any) => c[0] === 'facebookPoster:schedulesChanged')).toHaveLength(1);
    });
    test('receiver can prepare approval for an owned durable draft after terminal work journal retention', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const lease = { workId: work.id, claimedAt: work.claimedAt };
        const saved = await run(runner, 'pageWork.saveDraft', { ...lease, draftIndex: 0, draft: { text: 'Retained result' } });
        await run(runner, 'pageWork.finish', { ...lease, reason: 'prepared', evidenceRefs: [] });
        const works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database);
        expect(works.prune(Date.now() + 31 * 86400000)).toBe(1); expect(works.get(work.id)).toBeNull();
        expect(works.getResourceOwner({ kind: 'draft', id: saved.draftId }).workId).toBe(work.id);
        const action = { kind: 'approveDraft', pageId: 'page', draftId: saved.draftId, expectedRevision: saved.revision, timing: { when: 'now' } };
        const policy = { kind: 'page_receiver', workspaceId: 'workspace', assignments: [{ pageId: 'foreign', profileIds: ['foreign-profile'] }], ownerChatId: '1', ownerSenderId: '2' };
        const foreignKey = options.store.createKey('foreign receiver', policy);
        const foreign = { ctx: server.authorizationContext({ ...policy, keyId: foreignKey.id }, require('crypto').createHash('sha256').update(foreignKey.key).digest('hex')) };
        await expect(run(foreign, 'pageApprovals.prepare', { action })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        database.run("UPDATE fb_page_identities SET page_id = 'reassigned' WHERE profile_id = 'profile'");
        await expect(run(receiver, 'pageApprovals.prepare', { action })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(database.query('SELECT * FROM page_owner_approvals')).toEqual([]);
        database.run("UPDATE fb_page_identities SET page_id = 'page' WHERE profile_id = 'profile'");
        const { ticket } = await run(receiver, 'pageApprovals.prepare', { action }); expect(ticket.action.draftId).toBe(saved.draftId);
        await run(receiver, 'pageApprovals.bindMessage', { ticketId: ticket.id, chatId: '1', senderId: '2', messageId: 10 });
        const result = await run(receiver, 'pageApprovals.confirm', { ticketId: ticket.id, update: { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 } });
        expect(result).toEqual({ resourceId: saved.draftId, replayed: false });
        expect(database.queryOne('SELECT draft FROM fb_poster_schedules WHERE id = ?', [saved.draftId]).draft).toBe(0);
    });
    test('startup journal recovery never mutates a foreign-workspace row sharing a Page', async () => {
        identityAndBusiness(); const { work } = await run(key(), 'pageWork.claimDue', { pageId: 'page' });
        database.run('UPDATE page_work_items SET workspace_id = ? WHERE id = ?', ['foreign', work.id]);
        database.run("INSERT INTO page_work_items (id,workspace_id,page_id,profile_id,brief_date,status,updated_at) VALUES ('retained','workspace','page','profile','previous','failed',?)", [Date.now()]);
        await api.restartControlApi();
        expect(database.queryOne('SELECT status FROM page_work_items WHERE id = ?', [work.id]).status).toBe('running');
    });
    test('drain rechecks the mutable DB path after its await before declaring safe to swap', async () => {
        identityAndBusiness(); const runner = key(); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void; openActor = () => new Promise<void>(resolve => { release = resolve; entered(); });
        const pending = run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'Old workspace' } }).catch((error: any) => error);
        await reached;
        const draining = api.stopPagePreparationForWorkspaceSwitch(100);
        file = path.join(dir, 'other.db'); activeDb = memoryDb();
        release(); expect(await pending).toMatchObject({ code: 'FORBIDDEN' });
        expect(await draining).toBe(false);
        expect(activeDb.query("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
        file = path.join(dir, 'workspace.db'); activeDb = originalDb;
    });
    test('swallowed workspace journal discovery read refuses retirement swap instead of assuming no work', async () => {
        identityAndBusiness(); await run(key(), 'pageWork.claimDue', { pageId: 'page' });
        const query = database.query;
        database.query = (sql: string, params?: unknown[]) => sql.startsWith('SELECT DISTINCT page_id FROM page_work_items') ? [] : query(sql, params);
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(false);
        database.query = query;
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
    });
    test('real notifier wakes safe receiver events after commit and retirement rejects a pending read', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const saved = await run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { text: 'First' } });
        const after = options.store.lastEventSeq();
        const waiting = run(receiver, 'pageWork.events', { after, timeoutSec: 25 });
        await run(runner, 'pageWork.saveDraft', { workId: work.id, claimedAt: work.claimedAt, draftIndex: 0, draft: { id: saved.draftId, expectedRevision: saved.revision, text: 'Updated' } });
        const result = await waiting;
        expect(result.events).toHaveLength(1); expect(result.events[0]).toMatchObject({ type: 'pageWork.draftSaved', draftId: saved.draftId, revision: 2 });
        expect(result.nextCursor).toBeGreaterThan(after);
        const retired = run(receiver, 'pageWork.events', { after: result.nextCursor, timeoutSec: 25 }).then(value => ({ value }), error => ({ error }));
        expect(await api.stopPagePreparationForWorkspaceSwitch(50)).toBe(true);
        expect(await retired).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });
    test('actual receiver long polls share the existing per-key cap and release capacity on wake, rejection and abort', async () => {
        identityAndBusiness(); const receiver = key('page_receiver');
        const calls: any[] = [];
        const call = (params: any) => {
            const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ method: 'pageWork.events', params }))]), { headers: {} });
            let onClose!: () => void; let response: any;
            const res = { writableFinished: false, on: (_name: string, fn: () => void) => { onClose = fn; }, once() {}, writeHead() {},
                end: (text: string) => { response = JSON.parse(text); res.writableFinished = true; } };
            const promise = server.handleCall(request, res, receiver.id, receiver.name, '127.0.0.1', receiver.ctx);
            const entry = { promise, result: () => response, abort: () => onClose() }; calls.push(entry); return entry;
        };
        const after = options.store.lastEventSeq(); const waiting = Array.from({ length: 4 }, () => call({ after, timeoutSec: 25 }));
        await new Promise(resolve => setImmediate(resolve));
        const method = options.methods.find((m: any) => m.name === 'pageWork.events'); const handler = jest.spyOn(method, 'run');
        const excess = call({ after, timeoutSec: 25 }); await new Promise(resolve => setImmediate(resolve));
        const limited = excess.result(); waiting.forEach(entry => entry.abort()); excess.abort(); await Promise.all(calls.map(c => c.promise));
        expect(limited?.error?.code).toBe('RATE_LIMITED'); expect(handler).not.toHaveBeenCalled(); handler.mockRestore();
        const invalid = call({ after, timeoutSec: 26 }); await invalid.promise; expect(invalid.result().error.code).toBe('INVALID_PARAMS');
        const immediate = call({ after, timeoutSec: 0 }); await immediate.promise; expect(immediate.result().ok).toBe(true);
        expect(server.activeWaits.size).toBe(0);
        const next = call({ after, timeoutSec: 25 }); await new Promise(resolve => setImmediate(resolve));
        await run(key(), 'pageWork.claimDue', { pageId: 'page' }); await next.promise;
        expect(next.result().ok).toBe(true); expect(next.result().result.events).toHaveLength(1); expect(server.activeWaits.size).toBe(0);
        const aborted = call({ after: options.store.lastEventSeq(), timeoutSec: 25 }); await new Promise(resolve => setImmediate(resolve)); aborted.abort(); await aborted.promise;
        expect(server.activeWaits.size).toBe(0);
    });
    test('actual server rejects ticket scope before touching cache, and startup preserves approved schedules', async () => {
        identityAndBusiness(); const runner = key(); const receiver = key('page_receiver'); const { work } = await run(runner, 'pageWork.claimDue', { pageId: 'page' });
        const spy = jest.spyOn(options.idempotency, 'run'); let response: any;
        const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ method: 'pageApprovals.confirm', params: { ticketId: 'missing', update: {} }, idempotencyKey: 'replay' }))]), { headers: {} });
        const res = { on() {}, once() {}, writeHead() {}, end: (data: string) => { response = JSON.parse(data); } };
        await server.handleCall(request, res, receiver.id, receiver.name, '127.0.0.1', receiver.ctx);
        expect(response.error.code).toBe('FORBIDDEN'); expect(spy).not.toHaveBeenCalled();
        const independent = posterIpc.posterOperations.draftSave({ params: { mode: 'page', text: 'Independent schedule', mediaPaths: [], profiles: [{ profileId: 'profile', targets: ['https://www.facebook.com/'] }] } }).schedule;
        const approved = posterIpc.posterOperations.draftApprove({ id: independent.id, when: 'now' }).schedule;
        await api.restartControlApi();
        expect(database.queryOne('SELECT status FROM page_work_items WHERE id = ?', [work.id]).status).toBe('needs_review');
        expect(database.query('SELECT * FROM page_work_daily_usage')[0].attempts).toBe(1);
        const Store = require('../../services/facebookPoster/FacebookPosterStore').FacebookPosterStore;
        expect(new Store(database).getSchedule(approved.id)).toEqual(approved);
    });
});

describe('protected runtime registry and request resources', () => {
    let api: any; let options: any; let database: any; let activeDb: ReturnType<typeof memoryDb>;
    let workspace: string; let dbPath: string; let blocked: boolean; let settings: string; let certificateGate: () => Promise<void>;
    const modules = ['electron', '../../services/database/DatabaseService', '../../utils/WorkspaceManager',
        '../../services/control/ControlApiServer', '../../services/control/CertificateStore', '../../../electron/ipc/facebookPosterIpc',
        '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc', '../../../electron/ipc/inboxMedia',
        '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/workspaceIpc'];
    beforeEach(() => {
        options = undefined; workspace = 'workspace'; dbPath = path.join(dir, 'workspace.db'); blocked = false; certificateGate = async () => undefined;
        const readFile = fs.readFileSync;
        jest.spyOn(require('fs'), 'readFileSync').mockImplementation(((name: any, ...args: any[]) => String(name).endsWith('maihub_bridge.py') ? Buffer.from('# test bridge') : (readFile as any)(name, ...args)) as any);
        settings = JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'], protectedWritesEnabled: false });
        activeDb = memoryDb();
        database = { exec: (s: string) => activeDb.exec(s), run: (s: string, p?: unknown[]) => activeDb.run(s, p),
            runInsert: (s: string, p?: unknown[]) => activeDb.runInsert(s, p), query: (s: string, p?: unknown[]) => activeDb.query(s, p),
            queryOne: (s: string, p?: unknown[]) => activeDb.queryOne(s, p), transaction: (fn: () => unknown) => activeDb.transaction(fn),
            getDbPath: () => dbPath, getSetting: () => settings, getBrowserProfileById: (id: string) => id === 'profile' ? { id } : undefined };
        database.exec(require('../../services/control/ControlStore').CONTROL_SCHEMA_SQL);
        jest.doMock(modules[0], () => ({ app: { getPath: () => dir, getAppPath: () => process.cwd(), getVersion: () => '1.0' }, ipcMain: { handle() {} }, safeStorage: {} }));
        jest.doMock(modules[1], () => ({ __esModule: true, default: { getInstance: () => database } }));
        jest.doMock(modules[2], () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ id: workspace }) }) } }));
        jest.doMock(modules[3], () => ({ ControlApiServer: class { constructor(o: any) { options = o; } async start() {} async stop() {} } }));
        jest.doMock(modules[4], () => ({ CertificateStore: class { async ensure() { await certificateGate(); return {}; } }, CertificateKeyUnreadableError: class extends Error {} }));
        jest.doMock(modules[5], () => ({ stopPageCampaignExecution: async () => true, setPageCampaignExecutionContext() {}, isFacebookPosterEmployeeBlocked: () => blocked, posterOperations: {}, trackingOperations: {}, campaignOperations: {}, leadOperations: {}, learnPages() {} }));
        jest.doMock(modules[6], () => ({ researchOperations: {} }));
        jest.doMock(modules[7], () => ({ videoOperations: {} }));
        jest.doMock(modules[8], () => ({ getInboxMediaStore: () => ({ cleanup() {}, resolve: () => [] }) }));
        jest.doMock(modules[9], () => ({}));
        jest.doMock(modules[10], () => ({ isWorkspaceSwitchInProgress: () => false }));
        jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
        for (const kind of ['page_runner', 'page_receiver']) {
            const id = kind === 'page_runner' ? 'runner' : 'receiver';
            const policy = {kind, workspaceId:'workspace', assignments:[{pageId:'page', profileIds:['profile']}],
                ...(kind === 'page_receiver' ? {ownerChatId:'1', ownerSenderId:'2'} : {})};
            const created = new (require('../../services/control/ControlStore').ControlStore)(database).createKey(id, policy);
            database.run('UPDATE control_keys SET id = ? WHERE id = ?', [id, created.id]);
        }
        jest.isolateModules(() => { api = require('../../../electron/ipc/controlApiIpc'); });
    });
    afterEach(async () => { await api?.shutdownControlApi(); modules.forEach(name => jest.dontMock(name)); });
    const principal = () => ({ kind: 'page_runner', keyId: 'runner', workspaceId: 'workspace', assignments: [{ pageId: 'page', profileIds: ['profile'] }] });
    test('actual runtime appends every core method and truthful capability metadata', async () => {
        await api.restartControlApi();
        expect(options).toBeDefined(); expect(typeof options.authorizationResources).toBe('function');
        const coreNames = ['system.capabilities', 'pageBusiness.get', 'pageBusiness.propose', 'pageWork.list', 'pageWork.get', 'pageWork.claimDue',
            'pageWork.research', 'pageWork.researchResult', 'pageWork.saveDraft', 'pageWork.draft', 'pageWork.waitVideo', 'pageWork.reconcile', 'pageWork.finish', 'pageWork.fail',
            'pageApprovals.prepare', 'pageApprovals.bindMessage', 'pageApprovals.confirm', 'pageWork.events'];
        for (const name of coreNames) expect(options.methods.filter((m: any) => m.name === name)).toHaveLength(1);
        const resources = options.authorizationResources(principal());
        const context = { principal: principal(), assertCurrent: resources.assertCurrent, resources };
        expect(await options.methods.find((m: any) => m.name === 'system.capabilities').run({}, context))
            .toEqual({ pageOperations: 1, principal: { kind: 'page_runner', workspaceId: 'workspace', assignments: principal().assignments }, protectedWritesEnabled: false });
    });
    test('retired certificate await cannot open a server for its old DB lifetime', async () => {
        let release!: () => void; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
        certificateGate = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
        const starting = api.restartControlApi(); await ready;
        const stopped = api.stopControlApi(); release(); await starting; await stopped;
        expect(options).toBeUndefined();
    });
    test('captured singleton wrapper does not authorize after workspace ABA retirement', async () => {
        await api.restartControlApi();
        const resources = options.authorizationResources(principal()); resources.assertCurrent();
        await api.stopControlApi(); workspace = 'other'; dbPath = path.join(dir, 'other.db'); activeDb = memoryDb();
        workspace = 'workspace'; dbPath = path.join(dir, 'workspace.db');
        expect(() => resources.assertCurrent()).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
    test('receiver pre-cache callback is non-consuming and rejects other keys/missing tickets', async () => {
        await api.restartControlApi();
        const p = { ...principal(), kind: 'page_receiver', keyId: 'receiver', ownerChatId: '1', ownerSenderId: '2' };
        const resources = options.authorizationResources(p);
        resources.authorizeApproval('pageApprovals.prepare', { action: { kind: 'setEnabled', pageId: 'page', enabled: true, expectedRevision: 0 } });
        resources.authorizeApproval('pageApprovals.prepare', { action: { kind: 'setEnabled', pageId: 'page', enabled: true, expectedRevision: 0 } });
        expect(database.query('SELECT * FROM page_owner_approvals')).toEqual([]);
        expect(() => resources.authorizeApproval('pageApprovals.confirm', { ticketId: 'missing' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        const Work = require('../../services/dailyBrief/PageWorkStore').PageWorkStore;
        const work = new Work(database);
        work.createApproval({ id: 'ticket', receiverKeyId: 'other', workspaceId: 'workspace', pageId: 'page', action: {}, fingerprint: 'safe', chatId: '1', senderId: '2', expiresAt: Date.now() + 1000 });
        expect(() => resources.authorizeApproval('pageApprovals.bindMessage', { ticketId: 'ticket' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        database.run("UPDATE page_owner_approvals SET receiver_key_id = 'receiver' WHERE id = 'ticket'");
        resources.authorizeApproval('pageApprovals.bindMessage', { ticketId: 'ticket', chatId: '1', senderId: '2', messageId: 10 });
        expect(work.getApproval('ticket').messageId).toBeNull(); expect(work.getApproval('ticket').consumedAt).toBeNull();
        blocked = true; expect(() => resources.assertCurrent()).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
});

// Real IPC handlers + in-memory storage; only Electron/OS/provider boundaries are replaced.
describe('trusted local scope provisioning', () => {
    let api: any;
    let handlers: Record<string, (event: any, params?: any) => Promise<any>>;
    let database: any;
    let settings: Map<string, string>;
    let workspaceId: string;
    let blocked: boolean;
    let switching: boolean;
    let identities: any[];
    let onStart: () => void;
    const modules = ['electron', '../../services/database/DatabaseService', '../../utils/WorkspaceManager',
        '../../services/control/ControlEventRecorder', '../../services/control/ControlApiServer',
        '../../services/control/CertificateStore', '../../../electron/ipc/facebookPosterIpc',
        '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc', '../../../electron/ipc/inboxMedia',
        '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/dailyBriefIpc',
        '../../../electron/ipc/workspaceIpc', '../../services/control/ControlMethods', '../../utils/Logger'];
    const runner = () => ({ kind: 'page_runner', workspaceId: 'ws-a', assignments: [{ pageId: '123', profileIds: ['p1'] }] });
    const invoke = (method: string, params?: any) => handlers[`controlApi:${method}`]({}, params);
    beforeEach(() => {
        jest.useFakeTimers();
        handlers = {}; settings = new Map(); workspaceId = 'ws-a'; blocked = false; switching = false; onStart = () => {};
        const readFile = fs.readFileSync;
        jest.spyOn(require('fs'), 'readFileSync').mockImplementation(((file: any, ...args: any[]) => String(file).endsWith('maihub_bridge.py') ? Buffer.from('# mock bridge') : (readFile as any)(file, ...args)) as any);
        identities = [{ profileId: 'p1', kind: 'page', pageId: '123', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: 1, errorCode: '', error: '' }];
        database = { ...memoryDb(), getDbPath: () => '/mock-ws-a', getSetting: (key: string) => settings.get(key) ?? null,
            setSetting: (key: string, value: string) => settings.set(key, value), getBrowserProfileById: (id: string) => id === 'p1' ? { id } : undefined };
        database.exec(require('../../services/control/ControlStore').CONTROL_SCHEMA_SQL);
        jest.doMock(modules[0], () => ({ app: { getPath: () => dir, getAppPath: () => process.cwd(), getVersion: () => '1.0' },
            ipcMain: { handle: (name: string, fn: any) => { handlers[name] = fn; } }, safeStorage: {} }));
        jest.doMock(modules[1], () => ({ __esModule: true, default: { getInstance: () => database } }));
        jest.doMock(modules[2], () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ id: workspaceId }) }) } }));
        jest.doMock(modules[3], () => ({ ControlEventRecorder: class { sync() {} deactivate() {} } }));
        jest.doMock(modules[4], () => ({ DEFAULT_CONTROL_PORT: 47321, ControlApiServer: class { async start() { onStart(); } async stop() {} } }));
        jest.doMock(modules[5], () => ({ CertificateStore: class { async ensure() { return {}; } fingerprint() { return 'abc'; } }, CertificateKeyUnreadableError: class extends Error {} }));
        jest.doMock(modules[6], () => ({ stopPageCampaignExecution: async () => true, setPageCampaignExecutionContext() {}, isFacebookPosterEmployeeBlocked: () => blocked,
            posterOperations: {}, trackingOperations: {}, campaignOperations: {}, leadOperations: {} }));
        jest.doMock(modules[7], () => ({ researchOperations: {} }));
        jest.doMock(modules[8], () => ({ videoOperations: {} }));
        jest.doMock(modules[9], () => ({ getInboxMediaStore: () => ({ cleanup() {} }) }));
        jest.doMock(modules[10], () => ({}));
        jest.doMock(modules[11], () => ({ getDailyBriefStore: () => ({ listIdentities: () => identities }), briefOperations: {}, pageOperations: {} }));
        jest.doMock(modules[12], () => ({ isWorkspaceSwitchInProgress: () => switching }));
        jest.doMock(modules[13], () => ({ createControlMethods: () => [] }));
        jest.doMock(modules[14], () => ({ __esModule: true, default: { error() {} } }));
        jest.isolateModules(() => { api = require('../../../electron/ipc/controlApiIpc'); api.registerControlApiIpc(); });
    });
    afterEach(async () => { await api?.shutdownControlApi(); jest.useRealTimers(); modules.forEach(name => jest.dontMock(name)); });

    test('getScopeOptions returns one active workspace identity snapshot', async () => {
        expect(await invoke('getScopeOptions')).toEqual({ success: true, workspaceId: 'ws-a', workspaceGeneration: 0, identities });
    });
    test('creates a validated runner key and preserves legacy omission', async () => {
        expect((await invoke('createKey', { name: 'runner', policy: runner() })).success).toBe(true);
        expect((await invoke('createKey', { name: 'legacy' })).success).toBe(true);
        const keys = (await invoke('listKeys')).keys;
        expect(keys.find((k: any) => k.name === 'runner').policy).toEqual(runner());
        expect(keys.find((k: any) => k.name === 'legacy')).not.toHaveProperty('policy');
    });
    test.each(['person', 'unknown', 'wrong-page', 'missing-profile', 'workspace', 'null'])('invalidOrPersonAssignmentIsRejected: %s before settings changes', async kind => {
        let policy: any = runner();
        if (kind === 'person' || kind === 'unknown') identities[0].kind = kind;
        if (kind === 'wrong-page') identities[0].pageId = 'other';
        if (kind === 'missing-profile') database.getBrowserProfileById = () => undefined;
        if (kind === 'workspace') policy.workspaceId = 'ws-b';
        if (kind === 'null') policy = null;
        for (const method of ['createKey', 'createPairing']) {
            expect((await invoke(method, { name: 'bad', botIp: '203.0.113.5', publicHost: '203.0.113.7', policy })).success).toBe(false);
        }
        expect(settings.size).toBe(0);
        expect((await invoke('listKeys')).keys).toEqual([]);
    });
    test.each(['createKey', 'createPairing', 'getScopeOptions'])('employeeCannotProvisionKeys: %s', async method => {
        blocked = true;
        expect((await invoke(method, { name: 'bad', botIp: '203.0.113.5', publicHost: '203.0.113.7', policy: runner() })).success).toBe(false);
        expect(settings.size).toBe(0);
    });
    test.each(['createKey', 'createPairing', 'getScopeOptions'])('switch-in-progress refuses %s before mutation', async method => {
        switching = true;
        expect((await invoke(method, { name: 'bad', botIp: '203.0.113.5', publicHost: '203.0.113.7', policy: runner() })).success).toBe(false);
        expect(settings.size).toBe(0);
    });
    test.each(['workspace', 'db-path', 'identity', 'employee', 'switching'])('pairing revalidates %s after apply await', async change => {
        onStart = () => {
            if (change === 'workspace') workspaceId = 'ws-b';
            if (change === 'db-path') database.getDbPath = () => '/mock-ws-replaced';
            if (change === 'identity') identities[0].kind = 'person';
            if (change === 'employee') blocked = true;
            if (change === 'switching') switching = true;
        };
        const res = await invoke('createPairing', { name: 'runner', botIp: '203.0.113.5', publicHost: '203.0.113.7', policy: runner() });
        expect(res.success).toBe(false);
        expect(res).not.toHaveProperty('code');
    });
    test('legacy setConfig omission and pairing preserve an already stored protected gate', async () => {
        settings.set('control_api_config', JSON.stringify({ port: 47321, allowList: [], enabled: false, protectedWritesEnabled: true }));
        expect((await invoke('setConfig', { port: 47321, allowList: [], enabled: false })).protectedWritesEnabled).toBe(true);
        const res = await invoke('createPairing', { name: 'legacy', botIp: '203.0.113.5', publicHost: '203.0.113.7' });
        expect(res.success).toBe(true);
        expect(res.protectedWritesEnabled).toBe(true);
        expect(res.command).toContain('--install');
    });
    test('config view binds local saves to its workspace lifetime', async () => {
        const view = await invoke('getConfig');
        expect(view.workspaceId).toBe('ws-a');
        expect(Number.isInteger(view.workspaceGeneration)).toBe(true);
        const result = await invoke('setConfig', { enabled: false, port: 47321, allowList: [], protectedWritesEnabled: true,
            workspaceId: view.workspaceId, workspaceGeneration: view.workspaceGeneration });
        expect(result.success).toBe(true);
        expect(result.workspaceId).toBe('ws-a');
        expect(result.protectedWritesEnabled).toBe(true);
    });
    test.each(['missing-binding', 'workspace', 'generation', 'switching'])('config refuses stale explicit gate before writing: %s', async change => {
        const view = await invoke('getConfig');
        const input: any = { enabled: false, port: 47321, allowList: [], protectedWritesEnabled: true,
            workspaceId: view.workspaceId, workspaceGeneration: view.workspaceGeneration };
        if (change === 'missing-binding') { delete input.workspaceId; delete input.workspaceGeneration; }
        if (change === 'workspace') workspaceId = 'ws-b';
        if (change === 'generation') { await api.stopControlApi(); }
        if (change === 'switching') switching = true;
        expect((await invoke('setConfig', input)).success).toBe(false);
        expect(settings.size).toBe(0);
    });
    test('non-gate legacy config edits preserve the active stored gate without binding metadata', async () => {
        settings.set('control_api_config', JSON.stringify({ enabled: false, port: 47321, allowList: [], protectedWritesEnabled: true }));
        const result = await invoke('setConfig', { enabled: false, port: 47322, allowList: [] });
        expect(result.success).toBe(true);
        expect(result.port).toBe(47322);
        expect(result.protectedWritesEnabled).toBe(true);
    });
    test('a bound non-gate edit cannot overwrite another workspace', async () => {
        const view = await invoke('getConfig');
        workspaceId = 'ws-b';
        const result = await invoke('setConfig', { enabled: false, port: 47322, allowList: [], workspaceId: view.workspaceId, workspaceGeneration: view.workspaceGeneration });
        expect(result.success).toBe(false);
        expect(settings.size).toBe(0);
    });
    test.each(['workspace', 'db-path', 'employee', 'switching', 'generation'])('config save does not return a stale/new-workspace view after apply: %s', async change => {
        const view = await invoke('getConfig');
        onStart = () => {
            if (change === 'workspace') workspaceId = 'ws-b';
            if (change === 'db-path') database.getDbPath = () => '/mock-replaced';
            if (change === 'employee') blocked = true;
            if (change === 'switching') switching = true;
            if (change === 'generation') void api.stopControlApi();
        };
        const result = await invoke('setConfig', { enabled: true, port: 47321, allowList: ['203.0.113.5'], protectedWritesEnabled: true,
            workspaceId: view.workspaceId, workspaceGeneration: view.workspaceGeneration });
        expect(result.success).toBe(false);
        expect(result).not.toHaveProperty('protectedWritesEnabled');
        expect(result).not.toHaveProperty('workspaceId');
    });

    test('receiver staging keeps its credential destination separate', async () => {
        const policy = { ...runner(), kind: 'page_receiver', ownerChatId: '-9007199254740993', ownerSenderId: '9007199254740995' };
        const res = await invoke('createPairing', { name: 'receiver', botIp: '203.0.113.5', publicHost: '203.0.113.7', policy });
        expect(res.success).toBe(true);
        expect(res.command).toContain('--dir /root/maihub-page-receiver');
        expect(res.command).not.toContain('--install');
        expect(res.protectedWritesEnabled).toBe(false);
    });
});


describe('ControlKeyScope form validation', () => {
    const { scopeValidationError } = require('../../ui/components/settings/ControlKeyScope');
    const identities = [{ profileId: 'p1', kind: 'page', pageId: '123', pageName: 'Page' }, { profileId: 'person', kind: 'person', pageId: '456', pageName: 'Person' }];
    const policy = { kind: 'page_runner', workspaceId: 'ws-a', assignments: [{ pageId: '123', profileIds: ['p1'] }] };
    test('legacy null stays valid while scoped requires learned matching assignments', () => {
        expect(scopeValidationError(null, [], '')).toBe('');
        expect(scopeValidationError(policy, identities, 'ws-a')).toBe('');
        expect(scopeValidationError({ ...policy, assignments: [] }, identities, 'ws-a')).not.toBe('');
        expect(scopeValidationError(policy, identities, 'ws-b')).not.toBe('');
        expect(scopeValidationError({ ...policy, assignments: [{ pageId: '456', profileIds: ['person'] }] }, identities, 'ws-a')).not.toBe('');
    });
    test('receiver owner IDs stay exact decimal strings', () => {
        const receiver = { ...policy, kind: 'page_receiver', ownerChatId: '-9007199254740993', ownerSenderId: '9007199254740995' };
        expect(scopeValidationError(receiver, identities, 'ws-a')).toBe('');
        for (const ids of [{ ownerChatId: '' }, { ownerChatId: '0' }, { ownerSenderId: '-1' }, { ownerSenderId: '1e3' }]) {
            expect(scopeValidationError({ ...receiver, ...ids }, identities, 'ws-a')).not.toBe('');
        }
    });
});

describe('control preload provisioning boundary', () => {
    test('omits only absent legacy policy; invalid explicit null still reaches strict IPC', async () => {
        let exposed: any;
        const calls: any[] = [];
        jest.doMock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: any) => { exposed = value; } },
            ipcRenderer: { invoke: async (...args: any[]) => { calls.push(args); return {}; } } }));
        try {
            jest.isolateModules(() => require('../../../electron/preload'));
            await exposed.controlApi.createKey('legacy');
            await exposed.controlApi.createKey('invalid', null);
            await exposed.controlApi.getScopeOptions();
            expect(calls).toEqual([
                ['controlApi:createKey', { name: 'legacy' }],
                ['controlApi:createKey', { name: 'invalid', policy: null }],
                ['controlApi:getScopeOptions'],
            ]);
        } finally { jest.dontMock('electron'); }
    });
});


test('scope selector renders reachable purpose/owner labels and excludes learned person identities', () => {
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const ControlKeyScope = require('../../ui/components/settings/ControlKeyScope').default;
    const props = { onChange() {}, workspaceId: 'ws-a', identities: [
        { profileId: 'p1', kind: 'page', pageId: '123', pageName: 'Learned Page' },
        { profileId: 'private-person', kind: 'person', pageId: '456', pageName: 'Person Identity' },
    ] };
    const html = renderToStaticMarkup(React.createElement(ControlKeyScope, { ...props, value: {
        kind: 'page_receiver', workspaceId: 'ws-a', assignments: [], ownerChatId: '', ownerSenderId: '',
    } }));
    expect(html).toMatch(/<label for="[^"]+-purpose"/);
    expect(html).toMatch(/<select id="[^"]+-purpose"/);
    expect(html).toMatch(/<label for="[^"]+-chat"/);
    expect(html).toMatch(/<label for="[^"]+-sender"/);
    expect(html).toContain('Learned Page');
    expect(html).not.toContain('Person Identity');
    expect(html).not.toContain('private-person');
    expect(html).toContain('role="alert"');
    const empty = renderToStaticMarkup(React.createElement(ControlKeyScope, { ...props, identities: [], value: {
        kind: 'page_runner', workspaceId: 'ws-a', assignments: [],
    } }));
    expect(empty).toContain('Chưa có Page đã học');
    expect(empty).toContain('role="status"');
});

// Execute the real TSX handlers; only React scheduling, IPC and workspace events are controlled.
describe('ControlApiSettings workspace lifetime', () => {
    const fs = require('fs');
    const vm = require('vm');
    const assert = require('assert/strict');
    const root = require('path').resolve(__dirname, '../../..');
    const ts = require(root + '/node_modules/typescript');
    const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
    const identity = (profileId, pageId = profileId, kind = 'page') => ({ profileId, pageId, kind, pageName: profileId, category: '', about: '', recentPosts: [], learnedAt: 1, errorCode: '', error: '' });
    const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    function evaluate(file, requireFn) {
      const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
      const module = { exports: {} as any };
      vm.runInThisContext('(function(require,module,exports){' + output + '\n})', { filename: file })(requireFn, module, module.exports);
      return module.exports;
    }
    function createHarness() {
      const slots = [], effects = [], listeners = new Set<(state: any, previous: any) => void>(); let cursor = 0, tree;
      const state = { activeWorkspaceId: 'ws-a', isSwitching: false }; let generation = 0;
      const configs = { 'ws-a': { enabled: false, port: 47321, allowList: [], protectedWritesEnabled: true }, 'ws-b': { enabled: false, port: 47322, allowList: [], protectedWritesEnabled: false } };
      let identities = [identity('p1'), identity('p2')];
      const calls = [], notifications = []; let confirm = async (_options?: any) => true;
      const useWorkspaceStore = selector => selector ? selector(state) : state;
      useWorkspaceStore.getState = () => state;
      useWorkspaceStore.subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };
      const patch = values => { const before = { ...state }; Object.assign(state, values); listeners.forEach(fn => fn(state, before)); };
      const switchTo = id => { patch({ isSwitching: true }); generation++; patch({ activeWorkspaceId: id }); patch({ isSwitching: false }); };
      const snapshot = () => ({ success: true, workspaceId: state.activeWorkspaceId, workspaceGeneration: generation, ...configs[state.activeWorkspaceId] });
      const api = {
        async getConfig() { return snapshot(); },
        async getScopeOptions() { return { success: true, workspaceId: state.activeWorkspaceId, workspaceGeneration: generation, identities }; },
        async listKeys() { return { success: true, keys: [] }; }, async listAudit() { return { success: true, audit: [] }; }, async firewallCommand() { return { success: true }; },
        async setConfig(input) { calls.push({ workspace: state.activeWorkspaceId, input });
          if (input.workspaceId !== state.activeWorkspaceId || input.workspaceGeneration !== generation) return { success: false, error: 'stale workspace' };
          configs[state.activeWorkspaceId] = { ...input, allowList: [] }; return snapshot(); },
      };
      const React = {
        createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
        useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
        useRef(value) { const i = cursor++; if (!slots[i]) slots[i] = { current: value }; return slots[i]; },
        useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(deps, slots[i].deps)) slots[i] = { fn, deps }; return slots[i].fn; },
        useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(deps, slots[i].deps)) { const prior = slots[i]; slots[i] = { deps }; effects.push(() => { prior?.cleanup?.(); slots[i].cleanup = fn(); }); } },
        useId() { return 'fixture-id'; },
      };
      const reactImport = { __esModule: true, default: React, ...React };
      const scopeModule = evaluate(root + '/src/ui/components/settings/ControlKeyScope.tsx', name => { if (name === 'react') return reactImport; throw Error('Unexpected scope import ' + name); });
      const Scope = scopeModule.default;
      const Settings = evaluate(root + '/src/ui/components/settings/ControlApiSettings.tsx', name => {
        if (name === 'react') return reactImport;
        if (name === './ControlKeyScope') return scopeModule;
        if (name === '@/lib/ipc') return { __esModule: true, default: { controlApi: api } };
        if (name === '@/store/appStore') return { useAppStore: () => ({ showNotification: (...args) => notifications.push(args) }) };
        if (name.includes('workspaceStore')) return { useWorkspaceStore };
        if (name.includes('ConfirmDialog')) return { showConfirm: options => confirm(options) };
        if (name === './controlAllowList') return { findBroadCidrs: () => [] };
        return new Proxy({}, { get: () => function Stub() {} });
      }).default;
      function render() { cursor = 0; tree = Settings(); effects.splice(0).forEach(fn => fn()); return tree; }
      async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); render(); } }
      function walk(node, fn) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return; } fn(node); walk(node.props?.children, fn); }
      function text(node) { if (Array.isArray(node)) return node.map(text).join(''); if (node && typeof node === 'object') return text(node.props?.children); return node == null || typeof node === 'boolean' ? '' : String(node); }
      function find(predicate, required = true) { let result; walk(tree, node => { if (!result && predicate(node)) result = node; }); if (required) assert(result, 'element found'); return result; }
      const button = label => find(n => n.type === 'button' && text(n).trim() === label);
      const gate = () => find(n => n.type === 'input' && n.props.type === 'checkbox' && !n.props.role);
      const scope = () => find(n => n.type === Scope).props;
      return { render, settle, find, text, button, gate, scope, Scope, api, configs, calls, notifications, snapshot, switchTo, patch,
        get ids() { return identities; }, set ids(value) { identities = value; }, set confirm(value) { confirm = value; } };
    }
    test('save without refresh cannot copy A gate/config into B', async () => {
      const h = createHarness(); h.render(); await h.settle(); const staleSave = h.button('Lưu').props.onClick;
      h.switchTo('ws-b'); await staleSave(); await h.settle();
      assert.equal(h.configs['ws-b'].protectedWritesEnabled, false); assert.equal(h.calls.length, 0); assert.equal(h.gate().props.checked, false);
    });
    test('scope refresh reloads B gate/config and saves only its binding', async () => {
      const h = createHarness(); h.render(); await h.settle(); h.switchTo('ws-b'); await h.settle();
      await h.button('Tải lại phạm vi').props.onClick(); await h.settle(); await h.button('Lưu').props.onClick(); await h.settle();
      assert.equal(h.configs['ws-b'].protectedWritesEnabled, false); assert.equal(h.calls[0].input.workspaceId, 'ws-b'); assert.equal(h.calls[0].input.port, 47322);
    });
    test('stale getConfig and scope response cannot overwrite current B snapshot', async () => {
      const h = createHarness(); const pending = deferred(); const old = h.snapshot(); const get = h.api.getConfig; let first = true;
      h.api.getConfig = () => { if (first) { first = false; return pending.promise; } return get(); };
      h.render(); h.switchTo('ws-b'); await h.settle(); pending.resolve(old); await h.settle();
      assert.equal(h.gate().props.checked, false); assert.equal(h.scope().workspaceId, 'ws-b');
    });
    test('confirmation crossing A-B-A cannot attest the new A lifetime', async () => {
      const h = createHarness(); h.configs['ws-a'].protectedWritesEnabled = false; h.render(); await h.settle();
      const pending = deferred(); h.confirm = () => pending.promise; const confirmation = h.gate().props.onChange({ target: { checked: true } });
      h.switchTo('ws-b'); h.switchTo('ws-a'); await h.settle(); pending.resolve(true); await confirmation; await h.settle();
      assert.equal(h.gate().props.checked, false); await h.button('Lưu').props.onClick(); await h.settle(); assert.equal(h.configs['ws-a'].protectedWritesEnabled, false);
    });
    test('save response crossing switch does not apply A view or success notification to B', async () => {
      const h = createHarness(); h.render(); await h.settle(); const pending = deferred(), old = h.snapshot();
      h.api.setConfig = input => { h.calls.push({ input }); return pending.promise; }; const save = h.button('Lưu').props.onClick();
      h.switchTo('ws-b'); await h.settle(); pending.resolve(old); await save; await h.settle();
      assert.equal(h.gate().props.checked, false); assert.equal(h.scope().workspaceId, 'ws-b'); assert.equal(h.notifications.filter(n => n[0] === 'Đã lưu cấu hình').length, 0);
    });
    test('same-workspace refresh prunes hidden invalid assignments, preserves valid choices and receiver owners', async () => {
      const h = createHarness(); h.render(); await h.settle(); h.scope().onChange({ kind: 'page_receiver', workspaceId: 'ws-a', assignments: [
        { pageId: 'p1', profileIds: ['p1'] }, { pageId: 'p2', profileIds: ['p2'] },
      ], ownerChatId: '-9007199254740993', ownerSenderId: '9007199254740995' }); h.render();
      h.ids = [identity('p1', 'p1', 'person'), identity('p2'), identity('p3')];
      await h.button('Tải lại phạm vi').props.onClick(); await h.settle();
      expect(h.scope().value.assignments).toEqual([{ pageId: 'p2', profileIds: ['p2'] }]);
      assert.equal(h.scope().value.ownerChatId, '-9007199254740993'); assert.equal(h.scope().value.ownerSenderId, '9007199254740995');
    });
    test('workspace switch invalidates scoped assignments and receiver owners', async () => {
      const h = createHarness(); h.render(); await h.settle(); h.scope().onChange({ kind: 'page_receiver', workspaceId: 'ws-a', assignments: [{ pageId: 'p1', profileIds: ['p1'] }], ownerChatId: '-1', ownerSenderId: '2' });
      h.render(); h.switchTo('ws-b'); await h.settle(); const value = h.scope().value;
      assert.equal(value.kind, 'page_receiver'); assert.equal(value.workspaceId, 'ws-b'); expect(value.assignments).toEqual([]); assert.equal(value.ownerChatId, ''); assert.equal(value.ownerSenderId, '');
    });
    test('late auxiliary responses cannot repopulate another workspace', async () => {
      const h = createHarness(), pendingKeys = deferred(), pendingAudit = deferred(), pendingFirewall = deferred();
      for (const [method, pending] of [['listKeys', pendingKeys], ['listAudit', pendingAudit], ['firewallCommand', pendingFirewall]] as const) {
        const original = h.api[method]; let first = true;
        (h.api as any)[method] = () => { if (first) { first = false; return pending.promise; } return original(); };
      }
      h.render(); await h.settle(); h.switchTo('ws-b'); await h.settle();
      pendingKeys.resolve({ success: true, keys: [{ id: 'foreign', name: 'Foreign key', createdAt: 1, revokedAt: null }] });
      pendingAudit.resolve({ success: true, audit: [{ at: 1, method: 'foreign.method', ok: true }] });
      pendingFirewall.resolve({ success: true, command: 'foreign firewall' }); await h.settle();
      expect(h.text(h.render())).not.toContain('Foreign key');
      expect(h.text(h.render())).not.toContain('foreign.method');
      expect(h.find(n => n.props.text === 'foreign firewall', false)).toBeUndefined();
    });
    test('certificate refresh preserves the current config binding and unsaved input', async () => {
      const h = createHarness(); h.render(); await h.settle();
      (h.api as any).regenerateCertificate = async () => ({ success: true, fingerprint: 'updated-certificate', running: false });
      h.find(n => n.props.id === 'control-port').props.onChange({ target: { value: '47325' } }); h.render();
      await h.button('Tạo lại chứng chỉ').props.onClick(); await h.settle();
      expect(h.button('Lưu').props.disabled).toBe(false);
      await h.button('Lưu').props.onClick(); await h.settle();
      expect(h.calls[0].input.port).toBe(47325);
      expect(h.calls[0].input.workspaceId).toBe('ws-a');
    });
    test('pending certificate confirmation and regeneration block save until the view is settled', async () => {
      const h = createHarness(); h.render(); await h.settle();
      const confirmation = deferred(), certificate = deferred();
      h.confirm = () => confirmation.promise;
      (h.api as any).regenerateCertificate = () => certificate.promise;
      const regenerating = h.button('Tạo lại chứng chỉ').props.onClick(); await h.settle();
      expect(h.button('Lưu').props.disabled).toBe(true);
      confirmation.resolve(true); await h.settle();
      h.find(n => n.props.id === 'control-port').props.onChange({ target: { value: '47325' } }); h.render();
      expect(h.button('Lưu').props.disabled).toBe(true);
      await h.button('Lưu').props.onClick(); expect(h.calls).toHaveLength(0);
      certificate.resolve({ success: true, fingerprint: 'updated-certificate', running: false });
      await regenerating; await h.settle();
      expect(h.button('Lưu').props.disabled).toBe(false);
      await h.button('Lưu').props.onClick(); await h.settle();
      expect(h.find(n => n.props.label === 'Sao chép địa chỉ').props.text).toBe('https://<IP-VPS>:47325');
      expect(h.notifications.filter(n => n[0] === 'Đã lưu cấu hình')).toHaveLength(1);
    });
    test('pending save blocks certificate regeneration and cancelled confirmation releases save', async () => {
      const h = createHarness(); h.render(); await h.settle();
      const pending = deferred(), original = h.api.setConfig; let certificateCalls = 0;
      h.api.setConfig = async input => { const result = await original(input); await pending.promise; return result; };
      (h.api as any).regenerateCertificate = async () => { certificateCalls++; return { success: true }; };
      const saving = h.button('Lưu').props.onClick(); await h.settle();
      expect(h.button('Tạo lại chứng chỉ').props.disabled).toBe(true);
      await h.button('Tạo lại chứng chỉ').props.onClick(); expect(certificateCalls).toBe(0);
      pending.resolve(undefined); await saving; await h.settle();
      expect(h.button('Tạo lại chứng chỉ').props.disabled).toBe(false);
      h.confirm = async () => false;
      await h.button('Tạo lại chứng chỉ').props.onClick(); await h.settle();
      expect(h.button('Lưu').props.disabled).toBe(false); expect(certificateCalls).toBe(0);
    });
});
