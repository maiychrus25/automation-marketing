import https from 'https';
import { Readable } from 'stream';
import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { AuthLockout, RateLimiter } from '../../services/control/controlSecurity';
import { IdempotencyCache } from '../../services/control/IdempotencyCache';
import { EventNotifier } from '../../services/control/EventNotifier';
import { ControlError, createControlMethods, type ControlMethod } from '../../services/control/ControlMethods';
import { ControlApiServer, DEFAULT_CONTROL_PORT } from '../../services/control/ControlApiServer';
import { createCertificate } from '../../services/control/certificate';

interface Reply { status: number; headers: any; body: any; raw: string; fingerprint: string }
let cert: Awaited<ReturnType<typeof createCertificate>>;
beforeAll(async () => { cert = await createCertificate(); });

const obj = { type: 'object' };
let counter = 0;
const fakeMethods: ControlMethod[] = [
  { name: 'echo', description: 'echo', destructive: false, paramsSchema: obj, resultSchema: obj, run: async (p, ctx) => ({ p, key: ctx.keyName }) },
  { name: 'count', description: 'count', destructive: false, paramsSchema: obj, resultSchema: obj, run: async () => ({ n: ++counter }) },
  { name: 'denied', description: 'x', destructive: true, paramsSchema: obj, resultSchema: obj, run: async () => { throw new ControlError('CONFIRMATION_REQUIRED', 'Cần xác nhận'); } },
  { name: 'plainFail', description: 'x', destructive: false, paramsSchema: obj, resultSchema: obj, run: async () => { throw new Error('Tham số sai'); } },
  { name: 'crash', description: 'x', destructive: false, paramsSchema: obj, resultSchema: obj, run: async () => { throw new TypeError('secret internal detail'); } },
];

async function setup(opts: { allowList?: string[]; rate?: number; saveMedia?: any } = {}) {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  const store = new ControlStore(db);
  const notifier = new EventNotifier(store);
  const real = createControlMethods({
    poster: {} as any,
    listProfiles: () => [],
    systemStatus: () => ({}),
    resolveMedia: (ids) => ids,
    events: { listEventsAfter: (s, l) => store.listEventsAfter(s, l), waitForEvent: (a, t, s) => notifier.waitForEvent(a, t, s) },
  });
  const saved: any[] = [];
  const saveMedia = opts.saveMedia ?? (async (name: string, contentType: string, stream: Readable) => {
    let size = 0;
    for await (const chunk of stream) size += (chunk as Buffer).length;
    saved.push({ name, contentType, size });
    return { mediaId: 'm1', name, size, kind: contentType.startsWith('video/') ? 'video' : 'image' };
  });
  const lockout = new AuthLockout();
  const server = new ControlApiServer({
    tls: { key: cert.key, cert: cert.cert }, port: 0, host: '127.0.0.1',
    allowList: opts.allowList ?? ['127.0.0.1'],
    store, methods: [...real, ...fakeMethods], idempotency: new IdempotencyCache(store),
    rateLimiter: new RateLimiter(opts.rate ?? 60), lockout, saveMedia,
  });
  const { port } = await server.start();
  const key = store.createKey('Claude bot');
  const send = (method: string, path: string, o: { key?: string | null; body?: Buffer | string; headers?: Record<string, string> } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      const k = o.key === undefined ? key.key : o.key;
      if (k) headers.authorization = `Bearer ${k}`;
      const req = https.request({ host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: any; try { body = JSON.parse(raw); } catch { body = undefined; }
          resolve({ status: res.statusCode!, headers: res.headers, body, raw, fingerprint: (res.socket as any).getPeerCertificate().fingerprint256 });
        });
      });
      req.on('error', reject);
      if (o.body !== undefined) req.write(o.body);
      req.end();
    });
  const call = (method: string, params: any = {}, extra: any = {}, o: any = {}) =>
    send('POST', '/v1/call', { ...o, body: JSON.stringify({ method, params, ...extra }), headers: { 'content-type': 'application/json' } });
  return { server, store, notifier, db, key, port, send, call, saved, lockout };
}

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => { await ctx?.server.stop(); });

describe('ControlApiServer basics', () => {
  it('exports default port', () => { expect(DEFAULT_CONTROL_PORT).toBe(47321); });

  it('health without key, json content type, pinned fingerprint', async () => {
    ctx = await setup();
    const r = await ctx.send('GET', '/v1/health', { key: null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, protocol: 1 });
    expect(r.headers['content-type']).toMatch(/application\/json/);
    const hex = r.fingerprint.replace(/:/g, '').toLowerCase();
    expect(hex).toBe(cert.fingerprintSha256);
  });

  it('describe lists methods', async () => {
    ctx = await setup();
    const r = await ctx.send('GET', '/v1/describe');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result.protocol).toBe(1);
    expect(r.body.result.methods.map((m: any) => m.name)).toEqual(expect.arrayContaining(['events.wait', 'echo']));
  });

  it('404 unknown path, 405 wrong method', async () => {
    ctx = await setup();
    expect((await ctx.send('GET', '/v1/nope')).status).toBe(404);
    const r = await ctx.send('GET', '/v1/call');
    expect(r.status).toBe(405);
    expect(r.body.ok).toBe(false);
    expect((await ctx.send('POST', '/v1/health', { key: null })).status).toBe(405);
  });
});

describe('ControlApiServer auth pipeline', () => {
  it('missing or wrong key -> 401 UNAUTHORIZED; bearer scheme is case-insensitive', async () => {
    ctx = await setup();
    const a = await ctx.send('GET', '/v1/describe', { key: null });
    expect(a.status).toBe(401);
    expect(a.body.error.code).toBe('UNAUTHORIZED');
    const b = await ctx.send('GET', '/v1/describe', { key: 'mh_wrong' });
    expect(b.status).toBe(401);
    const c = await ctx.send('GET', '/v1/describe', { key: null, headers: { authorization: `bEaReR ${ctx.key.key}` } });
    expect(c.status).toBe(200);
  });

  it('successful call touches the key', async () => {
    ctx = await setup();
    await ctx.send('GET', '/v1/describe');
    expect(ctx.store.listKeys()[0].lastUsedAt).not.toBeNull();
  });

  it('revoked key is rejected', async () => {
    ctx = await setup();
    ctx.store.revokeKey(ctx.key.id);
    expect((await ctx.send('GET', '/v1/describe')).status).toBe(401);
  });

  it('IP outside allow-list: socket destroyed with no response, even for health', async () => {
    ctx = await setup({ allowList: ['10.9.9.9'] });
    const outcome = await new Promise<string>((resolve) => {
      const req = https.request({ host: '127.0.0.1', port: ctx.port, path: '/v1/health', rejectUnauthorized: false, agent: false }, () => resolve('response'));
      req.on('error', () => resolve('closed'));
      req.end();
    });
    expect(outcome).toBe('closed');
  });

  it('empty allow-list denies everything', async () => {
    ctx = await setup({ allowList: [] });
    await expect(ctx.send('GET', '/v1/health', { key: null })).rejects.toBeDefined();
  });

  it('locks the IP after 10 bad keys, even for a valid key', async () => {
    ctx = await setup();
    for (let i = 0; i < 10; i++) expect((await ctx.send('GET', '/v1/describe', { key: 'mh_bad' + i })).status).toBe(401);
    const r = await ctx.send('GET', '/v1/describe');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('per-key rate limit -> 429 RATE_LIMITED', async () => {
    ctx = await setup({ rate: 2 });
    expect((await ctx.send('GET', '/v1/describe')).status).toBe(200);
    expect((await ctx.send('GET', '/v1/describe')).status).toBe(200);
    const r = await ctx.send('GET', '/v1/describe');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('ControlApiServer /v1/call', () => {
  it('success returns result and passes key name', async () => {
    ctx = await setup();
    const r = await ctx.call('echo', { a: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { p: { a: 1 }, key: 'Claude bot' } });
  });

  it('error mapping: ControlError, plain Error, internal hidden', async () => {
    ctx = await setup();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await ctx.call('denied');
    expect(a.status).toBe(409);
    expect(a.body.error).toMatchObject({ code: 'CONFIRMATION_REQUIRED', message: 'Cần xác nhận' });
    const b = await ctx.call('plainFail');
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe('INVALID_PARAMS');
    const c = await ctx.call('crash');
    expect(c.status).toBe(500);
    expect(c.body.error.code).toBe('INTERNAL');
    expect(c.raw).not.toContain('secret internal detail');
    expect(spy.mock.calls.some((args) => String(args[0]).includes('crash'))).toBe(true);
    spy.mockRestore();
  });

  it('unknown method -> 404 UNKNOWN_METHOD; bad JSON / bad shape -> INVALID_PARAMS', async () => {
    ctx = await setup();
    const a = await ctx.call('nope');
    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe('UNKNOWN_METHOD');
    const b = await ctx.send('POST', '/v1/call', { body: '{not json' });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe('INVALID_PARAMS');
    const c = await ctx.send('POST', '/v1/call', { body: JSON.stringify({ params: {} }) });
    expect(c.body.error).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'method' } });
    const d = await ctx.send('POST', '/v1/call', { body: JSON.stringify({ method: 'echo', params: [] }) });
    expect(d.body.error).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'params' } });
  });

  it('idempotencyKey validated (string, <= 64)', async () => {
    ctx = await setup();
    const a = await ctx.call('echo', {}, { idempotencyKey: 'x'.repeat(65) });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'idempotencyKey' } });
    const b = await ctx.call('echo', {}, { idempotencyKey: 5 });
    expect(b.body.error.details.field).toBe('idempotencyKey');
    expect((await ctx.call('echo', {}, { idempotencyKey: 'x'.repeat(64) })).status).toBe(200);
  });

  it('idempotent replay returns the same body without re-running', async () => {
    ctx = await setup();
    counter = 0;
    const a = await ctx.call('count', {}, { idempotencyKey: 'k1' });
    const b = await ctx.call('count', {}, { idempotencyKey: 'k1' });
    expect(b.raw).toBe(a.raw);
    expect(counter).toBe(1);
    await ctx.call('count', {});
    expect(counter).toBe(2);
  });

  it('body over 1 MiB -> 413 PAYLOAD_TOO_LARGE, nothing executed', async () => {
    ctx = await setup();
    counter = 0;
    const big = JSON.stringify({ method: 'count', params: { pad: 'a'.repeat(1_048_576) } });
    const r = await ctx.send('POST', '/v1/call', { body: big });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(counter).toBe(0);
    // Server remains healthy
    expect((await ctx.call('echo')).status).toBe(200);
  });

  it('chunked body over limit (no content-length) -> 413', async () => {
    ctx = await setup();
    const r = await new Promise<Reply>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/call', rejectUnauthorized: false, agent: false,
        headers: { authorization: `Bearer ${ctx.key.key}`, 'transfer-encoding': 'chunked' } }, (res) => {
        let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(raw) } as any));
      });
      req.on('error', reject);
      req.write('{"method":"echo","params":{"p":"'); req.write('a'.repeat(1_100_000)); req.end('"}}');
    });
    expect(r.status).toBe(413);
  });

  it('writes audit for ok and failed calls, without bodies', async () => {
    ctx = await setup();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await ctx.call('echo', { id: 'd1', text: 'SECRET POST BODY', comment: 'SECRET COMMENT', mediaIds: ['a', 'b'] });
    await ctx.call('denied', {});
    const rows = ctx.store.listAudit(10);
    expect(rows).toHaveLength(2);
    const [failed, ok] = rows;
    expect(ok).toMatchObject({ keyName: 'Claude bot', ip: '127.0.0.1', method: 'echo', ok: true, errorCode: null });
    expect(ok.durationMs).not.toBeNull();
    expect(ok.paramsSummary).toContain('"id":"d1"');
    expect(ok.paramsSummary).toContain('text');
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(failed).toMatchObject({ method: 'denied', ok: false, errorCode: 'CONFIRMATION_REQUIRED' });
    jest.restoreAllMocks();
  });
});

describe('ControlApiServer /v1/media', () => {
  const upload = (name: string | undefined, type: string, body: Buffer, key?: string | null) =>
    ctx.send('POST', '/v1/media', { key, body, headers: { 'content-type': type, ...(name ? { 'x-filename': encodeURIComponent(name) } : {}) } });

  it('stores an image: sanitized name, type and size', async () => {
    ctx = await setup();
    const r = await upload('../../evil/ảnh\u0001 1.PNG', 'image/png', Buffer.alloc(1234, 1));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { mediaId: 'm1', name: 'ảnh 1.PNG', size: 1234, kind: 'image' } });
    expect(ctx.saved).toEqual([{ name: 'ảnh 1.PNG', contentType: 'image/png', size: 1234 }]);
  });

  it('accepts video by extension', async () => {
    ctx = await setup();
    const r = await upload('clip.mp4', 'video/mp4', Buffer.alloc(10));
    expect(r.body.result.kind).toBe('video');
  });

  it('rejects bad extension, missing filename, mismatched content type', async () => {
    ctx = await setup();
    const a = await upload('run.exe', 'application/octet-stream', Buffer.alloc(5));
    expect(a.status).toBe(400);
    expect(a.body.error.code).toBe('INVALID_PARAMS');
    expect((await upload(undefined, 'image/png', Buffer.alloc(5))).body.error.details.field).toBe('X-Filename');
    expect((await upload('a.png', 'video/mp4', Buffer.alloc(5))).body.error.details.field).toBe('Content-Type');
    expect(ctx.saved).toHaveLength(0);
  });

  it('image over 20 MiB -> 413 PAYLOAD_TOO_LARGE', async () => {
    ctx = await setup();
    const r = await upload('big.jpg', 'image/jpeg', Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('requires auth', async () => {
    ctx = await setup();
    expect((await upload('a.png', 'image/png', Buffer.alloc(5), null)).status).toBe(401);
  });

  it('saveMedia failure -> INTERNAL, no raw message', async () => {
    ctx = await setup({ saveMedia: async (_n: string, _c: string, s: Readable) => { s.resume(); throw new Error('disk exploded'); } });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await upload('a.png', 'image/png', Buffer.alloc(5));
    expect(r.status).toBe(500);
    expect(r.raw).not.toContain('disk exploded');
    jest.restoreAllMocks();
  });
});

describe('ControlApiServer events.wait long-poll', () => {
  it('returns immediately when events exist', async () => {
    ctx = await setup();
    ctx.store.addEvent('run.started', { runId: 'r1' });
    const t = Date.now();
    const r = await ctx.call('events.wait', { after: 0, timeoutSec: 20 });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.body.result.events).toHaveLength(1);
  });

  it('waits then wakes on notify', async () => {
    ctx = await setup();
    const pending = ctx.call('events.wait', { after: 0, timeoutSec: 20 });
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.notifier.pending).toBe(1);
    ctx.store.addEvent('run.finished', { runId: 'r1' });
    ctx.notifier.notify();
    const r = await pending;
    expect(r.body.result.events.map((e: any) => e.type)).toEqual(['run.finished']);
    expect(ctx.notifier.pending).toBe(0);
  });

  it('times out with empty list', async () => {
    ctx = await setup();
    const t = Date.now();
    const r = await ctx.call('events.wait', { after: 0, timeoutSec: 1 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    expect(r.body.result.events).toEqual([]);
    expect(ctx.notifier.pending).toBe(0);
  });

  it('client abort cancels the waiter cleanly and the server keeps working', async () => {
    ctx = await setup();
    const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/call', rejectUnauthorized: false, agent: false,
      headers: { authorization: `Bearer ${ctx.key.key}` } });
    req.on('error', () => undefined);
    req.end(JSON.stringify({ method: 'events.wait', params: { after: 0, timeoutSec: 25 } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.notifier.pending).toBe(1);
    req.destroy();
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.notifier.pending).toBe(0);
    expect((await ctx.call('echo')).status).toBe(200);
    // the aborted call is still audited
    expect(ctx.store.listAudit(10).some((a) => a.method === 'events.wait')).toBe(true);
  });
});

describe('EventNotifier', () => {
  it('does not lose an event added between check and wait (registers before re-check)', async () => {
    const calls: number[] = [];
    let has = false;
    const notifier = new EventNotifier({ listEventsAfter: () => { calls.push(1); return has ? [{} as any] : []; } });
    has = true;
    await expect(notifier.waitForEvent(0, 5000)).resolves.toBeUndefined();
    expect(notifier.pending).toBe(0);
  });

  it('abort signal resolves and removes waiter and timer', async () => {
    const notifier = new EventNotifier({ listEventsAfter: () => [] });
    const ac = new AbortController();
    const p = notifier.waitForEvent(0, 60_000, ac.signal);
    expect(notifier.pending).toBe(1);
    ac.abort();
    await p;
    expect(notifier.pending).toBe(0);
    await notifier.waitForEvent(0, 60_000, ac.signal); // already aborted
    expect(notifier.pending).toBe(0);
  });
});
