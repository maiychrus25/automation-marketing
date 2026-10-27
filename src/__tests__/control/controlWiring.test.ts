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
    expect(validateConfigInput({ enabled: true, port: 50000, allowList: '10.0.0.1 10.0.0.1 192.168.1.0/24' })).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1', '192.168.1.0/24'], publicHost: null });
    expect(validateConfigInput({ enabled: false, port: 47321, allowList: [] }).enabled).toBe(false);
  });
  test('rejects bad ports', () => {
    for (const port of [0, 80, 70000, 1.5, 'x']) expect(() => validateConfigInput({ enabled: false, port, allowList: [] })).toThrow(/Cổng/);
  });
  test('stored config falls back safely and never enables with an empty list', () => {
    expect(parseStoredConfig(null).enabled).toBe(false);
    expect(parseStoredConfig('{bad').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":47321,"allowList":[]}').enabled).toBe(false);
    expect(parseStoredConfig('{"enabled":true,"port":50000,"allowList":["10.0.0.1"]}')).toEqual({ enabled: true, port: 50000, allowList: ['10.0.0.1'], publicHost: null });
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
            '../../utils/Logger',
        ];
        let captured: any;
        let api: any;
        let expected: any;
        jest.doMock(mockedModules[0], () => ({ __esModule: true, default: { getInstance: () => ({
            getSetting: () => JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'] }),
        }) } }));
        jest.doMock(mockedModules[1], () => ({ ControlEventRecorder: class { sync() {} deactivate() {} } }));
        jest.doMock(mockedModules[2], () => ({ createControlMethods: (deps: any) => { captured = deps; throw new Error('Captured before opening sockets'); } }));
        jest.doMock(mockedModules[3], () => ({ isFacebookPosterEmployeeBlocked: () => false,
            posterOperations: {}, trackingOperations: {}, campaignOperations: {}, leadOperations: {} }));
        jest.doMock(mockedModules[4], () => ({ researchOperations: {} }));
        jest.doMock(mockedModules[5], () => ({ videoOperations: {} }));
        jest.doMock(mockedModules[6], () => ({ getInboxMediaStore: () => ({}) }));
        jest.doMock(mockedModules[7], () => ({}));
        jest.doMock(mockedModules[8], () => ({ __esModule: true, default: { error: jest.fn() } }));
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
