import Logger from '../../utils/Logger';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import https from 'https';
import tls from 'tls';
import { Readable } from 'stream';
import { memoryDb } from '../facebookPoster/helpers';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { AuthLockout, RateLimiter } from '../../services/control/controlSecurity';
import { IdempotencyCache } from '../../services/control/IdempotencyCache';
import { EventNotifier } from '../../services/control/EventNotifier';
import { ControlError, createControlMethods, type ControlMethod } from '../../services/control/ControlMethods';
import { ControlApiServer, DEFAULT_CONTROL_PORT } from '../../services/control/ControlApiServer';
import { PairingTickets } from '../../services/control/PairingTickets';
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

async function setup(opts: { allowList?: string[]; rate?: number; saveMedia?: any; poster?: any; isBlocked?: () => boolean; bridgeScript?: () => Buffer | null } = {}) {
  const db = memoryDb();
  db.exec(CONTROL_SCHEMA_SQL);
  const store = new ControlStore(db);
  const notifier = new EventNotifier(store);
  const real = createControlMethods({
    poster: (opts.poster ?? {}) as any,
    research: {} as any,
    tracking: {} as any,
    listProfiles: () => [],
    checkLogins: (ids) => ({ checkId: 'c1', profileIds: ids ?? [] }),
    systemStatus: () => ({}),
    resolveMedia: (ids) => ids,
    events: { listEventsAfter: (s, l) => store.listEventsAfter(s, l), waitForEvent: (a, t, s) => notifier.waitForEvent(a, t, s), workspaceId: () => 'ws-test' },
  });
  const saved: any[] = [];
  const saveMedia = opts.saveMedia ?? (async (name: string, contentType: string, stream: Readable) => {
    let size = 0;
    for await (const chunk of stream) size += (chunk as Buffer).length;
    saved.push({ name, contentType, size });
    return { mediaId: 'm1', name, size, kind: contentType.startsWith('video/') ? 'video' : 'image' };
  });
  const lockout = new AuthLockout();
  const tickets = new PairingTickets();
  const paired: any[] = [];
  const server = new ControlApiServer({
    tls: { key: cert.key, cert: cert.cert }, port: 0, host: '127.0.0.1',
    allowList: opts.allowList ?? ['127.0.0.1'],
    store, methods: [...real, ...fakeMethods], idempotency: new IdempotencyCache(store),
    rateLimiter: new RateLimiter(opts.rate ?? 60), lockout, saveMedia, isBlocked: opts.isBlocked,
    pairing: { consume: (t, ip) => tickets.consume(t, ip), onPaired: (i) => { paired.push(i); } },
    bridgeScript: opts.bridgeScript,
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
  return { server, store, notifier, db, key, port, send, call, saved, lockout, tickets, paired };
}

let ctx: Awaited<ReturnType<typeof setup>>;
afterEach(async () => { jest.restoreAllMocks(); await ctx?.server.stop(); });

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

  it('IP outside allow-list: TLS handshake never completes', async () => {
    ctx = await setup({ allowList: ['10.9.9.9'] });
    const events = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      const sock = tls.connect({ host: '127.0.0.1', port: ctx.port, rejectUnauthorized: false });
      sock.on('secureConnect', () => seen.push('secureConnect'));
      sock.on('error', () => undefined);
      sock.on('close', () => resolve(seen));
    });
    expect(events).not.toContain('secureConnect');
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
    const spy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
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

  it('idempotencyKey reused for another method -> 400 INVALID_PARAMS, nothing executed', async () => {
    ctx = await setup();
    counter = 0;
    await ctx.call('count', {}, { idempotencyKey: 'shared' });
    const r = await ctx.call('echo', {}, { idempotencyKey: 'shared' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'idempotencyKey' } });
    expect(counter).toBe(1);
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
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
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

  it('full inbox: 422 LIMIT_REACHED promptly while the multi-MB body is still drained', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-media-'));
    try {
      const inbox = new InboxMediaStore(dir, { maxBytes: 1_000_000_000, maxFiles: 1 });
      ctx = await setup({ saveMedia: (n: string, t: string, st: Readable) => inbox.save(n, t, st) });
      expect((await upload('a.png', 'image/png', Buffer.alloc(10, 1))).status).toBe(200);
      const started = Date.now();
      // Như bridge: ghi hết thân rồi mới đọc phản hồi; thân không được rút cạn thì 'finish' của yêu cầu không bao giờ tới.
      const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        let sent = false;
        let reply: { status: number; body: any } | null = null;
        const done = () => { if (sent && reply) resolve(reply); };
        const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/media', rejectUnauthorized: false, agent: false,
          headers: { authorization: `Bearer ${ctx.key.key}`, 'content-type': 'video/mp4', 'x-filename': 'b.mp4' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { reply = { status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; done(); });
        });
        req.on('error', reject);
        req.on('finish', () => { sent = true; done(); });
        req.end(Buffer.alloc(64 * 1024 * 1024, 2));
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('LIMIT_REACHED');
      expect(Date.now() - started).toBeLessThan(5000);
      expect(fs.readdirSync(dir)).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejected upload: the reply comes only after the whole body was received (no EPIPE race)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-media-'));
    try {
      const inbox = new InboxMediaStore(dir, { maxBytes: 1_000_000_000, maxFiles: 0 });
      ctx = await setup({ saveMedia: (n: string, t: string, st: Readable) => inbox.save(n, t, st) });
      // Thân gửi thành nhiều đoạn có khoảng nghỉ: server trả lời trước khi nhận hết thì client còn đang ghi khi phản hồi tới.
      const events: string[] = [];
      const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        let reply: { status: number; body: any } | null = null;
        let sent = false;
        const done = () => { if (sent && reply) resolve(reply); };
        const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/media', rejectUnauthorized: false, agent: false,
          headers: { authorization: `Bearer ${ctx.key.key}`, 'content-type': 'video/mp4', 'x-filename': 'c.mp4', 'content-length': String(4 * 256 * 1024) } }, (res) => {
          events.push('response');
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { reply = { status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; done(); });
        });
        req.on('error', reject);
        req.on('finish', () => { events.push('finish'); sent = true; done(); });
        let n = 0;
        const writeNext = () => {
          n += 1;
          const chunk = Buffer.alloc(256 * 1024, 3);
          if (n === 4) { req.end(chunk); return; } // đoạn cuối kết thúc luôn yêu cầu
          req.write(chunk);
          setTimeout(writeNext, 80);
        };
        writeNext();
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('LIMIT_REACHED');
      expect(events).toEqual(['finish', 'response']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const r = await upload('a.png', 'image/png', Buffer.alloc(5));
    expect(r.status).toBe(500);
    expect(r.raw).not.toContain('disk exploded');
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

describe('ControlApiServer rejected-call audit', () => {
  it('audits 401 and lockout 429 on /v1/call without reading the body', async () => {
    ctx = await setup();
    const bad = (k: string) => ctx.send('POST', '/v1/call', { key: k, body: JSON.stringify({ method: 'echo' }) });
    for (let i = 0; i < 10; i++) expect((await bad('mh_bad' + i)).status).toBe(401);
    expect((await bad('mh_bad')).status).toBe(429);
    const rows = ctx.store.listAudit(20);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({ keyName: null, ip: '127.0.0.1', method: '(unauthenticated)', ok: false, errorCode: 'RATE_LIMITED' });
    expect(rows[1]).toMatchObject({ keyName: null, method: '(unauthenticated)', ok: false, errorCode: 'UNAUTHORIZED' });
    expect(rows.filter((r) => r.errorCode === 'UNAUTHORIZED')).toHaveLength(10);
  });

  it('audits lockout 429 only once per IP per window', async () => {
    ctx = await setup();
    const bad = (k: string) => ctx.send('POST', '/v1/call', { key: k, body: JSON.stringify({ method: 'echo' }) });
    for (let i = 0; i < 10; i++) await bad('mh_bad' + i);
    for (let i = 0; i < 5; i++) expect((await bad('mh_bad')).status).toBe(429);
    const rows = ctx.store.listAudit(30);
    expect(rows.filter((r) => r.errorCode === 'RATE_LIMITED')).toHaveLength(1);
    expect(rows).toHaveLength(11);
  });

  it('audits rate-limit 429 only once per key per window', async () => {
    ctx = await setup({ rate: 2 });
    await ctx.call('echo'); await ctx.call('echo');
    for (let i = 0; i < 4; i++) expect((await ctx.call('echo')).status).toBe(429);
    const rows = ctx.store.listAudit(20);
    const limited = rows.filter((r) => r.errorCode === 'RATE_LIMITED');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ keyName: 'Claude bot', method: '(rate-limited)', ok: false });
    expect(rows).toHaveLength(3);
  });
});

describe('ControlApiServer hardening', () => {
  it('caps audit paramsSummary (20 keys, <= 500 chars) for a body of 5000 empty keys', async () => {
    ctx = await setup();
    const params: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) params['key_number_' + i] = '';
    expect((await ctx.call('echo', params)).status).toBe(200);
    const summary = ctx.store.listAudit(1)[0].paramsSummary!;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(JSON.parse(summary).keys.length).toBeLessThanOrEqual(20);
  });

  it('405 carries details.field httpMethod', async () => {
    ctx = await setup();
    const r = await ctx.send('GET', '/v1/call');
    expect(r.body.error).toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'httpMethod' } });
  });

  it('saveMedia resolving undefined -> INTERNAL, not 413', async () => {
    ctx = await setup({ saveMedia: async (_n: string, _c: string, s: Readable) => { s.resume(); return undefined; } });
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const r = await ctx.send('POST', '/v1/media', { body: Buffer.alloc(5), headers: { 'content-type': 'image/png', 'x-filename': 'a.png' } });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
  });

  it('malformed request target -> 404, concise single-line log, no stack', async () => {
    ctx = await setup();
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const err = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const reply = await new Promise<string>((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port: ctx.port, rejectUnauthorized: false }, () => {
        sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let data = ''; sock.on('data', (c) => { data += c; }); sock.on('close', () => resolve(data)); sock.on('error', () => resolve(data));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 404/);
    expect(err).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(typeof warn.mock.calls[0][0]).toBe('string');
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  it('declared Content-Length over the limit is rejected immediately (fast path)', async () => {
    ctx = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/call', rejectUnauthorized: false, agent: false,
        headers: { authorization: `Bearer ${ctx.key.key}`, 'content-length': String(2_000_000) } }, (res) => { resolve(res.statusCode!); req.destroy(); });
      req.on('error', (e) => { if ((e as any).code !== 'ECONNRESET') reject(e); });
      req.write('{"method":"echo"'); // never sends the declared 2 MB
    });
    expect(status).toBe(413);
  });

  it('wrapped method throwing TypeError -> INTERNAL and original logged with method name', async () => {
    ctx = await setup({ poster: { current: () => { throw new TypeError('wrapped secret'); } } });
    const spy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const r = await ctx.call('runs.current');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
    expect(r.raw).not.toContain('wrapped secret');
    expect(spy.mock.calls.some((a) => String(a[0]).includes('runs.current') && typeof a[1] === 'string')).toBe(true);
  });

  it('caps concurrent events.wait long-polls per key at 4', async () => {
    ctx = await setup();
    const waits = Array.from({ length: 4 }, () => new Promise<void>((resolve) => {
      const req = https.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/call', rejectUnauthorized: false, agent: false,
        headers: { authorization: `Bearer ${ctx.key.key}` } }, (res) => { res.resume(); res.on('end', () => resolve()); });
      req.on('error', () => resolve());
      req.end(JSON.stringify({ method: 'events.wait', params: { after: 0, timeoutSec: 25 } }));
    }));
    for (let i = 0; i < 50 && ctx.notifier.pending < 4; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ctx.notifier.pending).toBe(4);
    const fifth = await ctx.call('events.wait', { after: 0, timeoutSec: 25 });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('RATE_LIMITED');
    ctx.store.addEvent('x', {}); ctx.notifier.notify();
    await Promise.all(waits);
    expect(ctx.notifier.pending).toBe(0);
    expect((await ctx.call('events.wait', { after: 0, timeoutSec: 1 })).status).toBe(200);
  });
});

describe('ControlApiServer employee-mode guard', () => {
  it('answers 503 BUSY to authenticated calls while blocked, and recovers; health stays open', async () => {
    let blocked = true;
    ctx = await setup({ isBlocked: () => blocked });
    const r = await ctx.call('echo', {});
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({ code: 'BUSY', message: 'MaiHub đang ở chế độ nhân viên, không nhận lệnh điều khiển' });
    expect((await ctx.send('GET', '/v1/describe')).status).toBe(503);
    expect((await ctx.send('GET', '/v1/health', { key: null })).status).toBe(200);
    blocked = false;
    expect((await ctx.call('echo', {})).status).toBe(200);
  });
});

describe('ControlApiServer pairing and bridge script', () => {
  const pair = (body: string, o: any = {}) => ctx.send('POST', '/v1/pair', { key: null, body, headers: { 'content-type': 'application/json' }, ...o });
  const BAD = 'Mã ghép nối không hợp lệ hoặc đã hết hạn';

  it('pair: valid ticket returns a working key', async () => {
    ctx = await setup();
    const { ticket } = ctx.tickets.create('Bot Một', '127.0.0.1');
    const r = await pair(JSON.stringify({ ticket }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result.keyName).toBe('Bot Một');
    expect(r.body.result.apiKey).toMatch(/^mh_/);
    const d = await ctx.send('GET', '/v1/describe', { key: r.body.result.apiKey });
    expect(d.status).toBe(200);
    expect(ctx.paired).toEqual([expect.objectContaining({ keyName: 'Bot Một', ip: '127.0.0.1' })]);
  });

  it('pair: reused or wrong-ip ticket is 401 and counts toward lockout', async () => {
    ctx = await setup();
    const other = ctx.tickets.create('Khác IP', '10.1.1.1');
    expect((await pair(JSON.stringify({ ticket: other.ticket }))).status).toBe(401);
    const { ticket } = ctx.tickets.create('Bot', '127.0.0.1');
    expect((await pair(JSON.stringify({ ticket }))).status).toBe(200);
    const again = await pair(JSON.stringify({ ticket }));
    expect(again.status).toBe(401);
    expect(again.body.error.message).toBe(BAD);
    expect(ctx.store.listKeys().filter((k: any) => k.name === 'Khác IP')).toHaveLength(0);
    for (let i = 0; i < 7; i++) expect((await pair(JSON.stringify({ ticket: 'x' + i }))).status).toBe(401);
    expect((await pair(JSON.stringify({ ticket: 'last' }))).status).toBe(401);
    expect((await pair(JSON.stringify({ ticket: 'blocked' }))).status).toBe(429);
  });

  it('pair: malformed JSON or missing ticket is 401; non-POST is 405', async () => {
    ctx = await setup();
    expect((await pair('{nope')).status).toBe(401);
    expect((await pair('{}')).status).toBe(401);
    expect((await pair(JSON.stringify({ ticket: 5 }))).status).toBe(401);
    expect((await ctx.send('GET', '/v1/pair', { key: null })).status).toBe(405);
  });

  it('pair: employee mode is 503', async () => {
    ctx = await setup({ isBlocked: () => true });
    const { ticket } = ctx.tickets.create('Bot', '127.0.0.1');
    const r = await pair(JSON.stringify({ ticket }));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('BUSY');
    expect(ctx.paired).toHaveLength(0);
  });

  it('pair: body over 1 KiB is 413', async () => {
    ctx = await setup();
    const r = await pair(JSON.stringify({ ticket: 'a'.repeat(2000) }));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('pair: audited', async () => {
    ctx = await setup();
    await pair(JSON.stringify({ ticket: 'bad' }));
    const { ticket } = ctx.tickets.create('Bot Hai', '127.0.0.1');
    await pair(JSON.stringify({ ticket }));
    const rows = ctx.store.listAudit(10);
    expect(rows[0]).toMatchObject({ method: 'pair', keyName: 'Bot Hai', ok: true, errorCode: null });
    expect(rows[1]).toMatchObject({ method: 'pair', keyName: null, ok: false, errorCode: 'UNAUTHORIZED' });
    expect(JSON.stringify(rows)).not.toContain(ticket);
  });

  it('pair: no Authorization header needed', async () => {
    ctx = await setup();
    const { ticket } = ctx.tickets.create('Bot', '127.0.0.1');
    const r = await pair(JSON.stringify({ ticket }), { key: null });
    expect(r.status).toBe(200);
  });

  it('bridge.py: served with python mime, no key needed', async () => {
    ctx = await setup({ bridgeScript: () => Buffer.from('print(1)\n') });
    const r = await ctx.send('GET', '/v1/bridge.py', { key: null });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/x-python; charset=utf-8');
    expect(r.raw).toBe('print(1)\n');
    expect((await ctx.send('POST', '/v1/bridge.py', { key: null })).status).toBe(405);
  });

  it('bridge.py: 404 when script missing', async () => {
    ctx = await setup({ bridgeScript: () => null });
    expect((await ctx.send('GET', '/v1/bridge.py', { key: null })).status).toBe(404);
    await ctx.server.stop();
    ctx = await setup();
    expect((await ctx.send('GET', '/v1/bridge.py', { key: null })).status).toBe(404);
  });

  it('non-allow-listed ip is closed before TLS for /v1/pair', async () => {
    ctx = await setup({ allowList: ['10.9.9.9'] });
    await expect(pair(JSON.stringify({ ticket: 'x' }))).rejects.toBeDefined();
  });
});
