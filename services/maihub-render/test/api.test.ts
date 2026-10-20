import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Handoff } from '../src/handoff';
import { JobStore } from '../src/jobStore';
import { Queue } from '../src/queue';
import { Retention } from '../src/retention';
import { hashKey } from '../src/keys';
import { createServer } from '../src/server';
import { Orchestrator } from '../src/main-api';

const KEY_A = 'key-alpha-0000000000000000000000000000000000000';
const KEY_B = 'key-beta-00000000000000000000000000000000000000';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 2)]);

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer; json: any }
interface Part { name: string; data: Buffer | string; filename?: string }

function multipart(parts: Part[]): { body: Buffer; type: string } {
  const boundary = '----t' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"` + (p.filename !== undefined ? `; filename="${p.filename}"` : '');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n\r\n`), Buffer.from(p.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

describe('API maihub-render', () => {
  let root: string;
  let server: http.Server;
  let port: number;
  let store: JobStore;
  let queue: Queue;
  let handoff: Handoff;
  let orch: Orchestrator;
  let shared: string;
  let freeBytes = Number.MAX_SAFE_INTEGER;

  const templateSpec = (images: string[]) => JSON.stringify({
    template: { id: 't1', aspect: '9:16', variables: { title: 'Xin chào' }, images },
  });

  function call(method: string, p: string, opts: { key?: string; body?: Buffer; type?: string; headers?: Record<string, string> } = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { ...opts.headers };
      if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
      if (opts.type) headers['Content-Type'] = opts.type;
      if (opts.body) headers['Content-Length'] = opts.body.length;
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json: any;
          try { json = JSON.parse(body.toString('utf8')); } catch { /* không phải JSON */ }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
      });
      req.on('error', reject);
      if (opts.body) {
        // gửi theo từng khúc để server kịp ngắt giữa chừng
        const b = opts.body;
        for (let i = 0; i < b.length; i += 256 * 1024) req.write(b.subarray(i, i + 256 * 1024));
      }
      req.end();
    });
  }

  const create = (key: string, parts: Part[]) => {
    const m = multipart(parts);
    return call('POST', '/v1/jobs', { key, body: m.body, type: m.type });
  };
  const jobsDirEntries = () => fs.readdirSync(path.join(root, 'data', 'jobs'));

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'));
    shared = path.join(root, 'shared');
    const tdir = path.join(root, 'templates', 't1');
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, 'index.html'), '<div></div>');
    fs.writeFileSync(path.join(tdir, 'template.json'), JSON.stringify({
      id: 't1', name: 'Mẫu 1', description: '', aspects: ['9:16', '1:1'],
      durationSec: { min: 3, max: 30, default: 10 }, imageSlots: { min: 0, max: 5 },
      variables: { title: { type: 'string', label: 'Tiêu đề', maxLength: 40, default: 'x' } },
    }));
    store = new JobStore(path.join(root, 'data'));
    queue = new Queue(store);
    handoff = new Handoff(shared);
    orch = new Orchestrator({ store, queue, handoff, retention: new Retention(store) });
    freeBytes = Number.MAX_SAFE_INTEGER;
    server = createServer({
      keys: new Map([['alpha', hashKey(KEY_A)], ['beta', hashKey(KEY_B)]]),
      store, queue, orchestrator: orch,
      templatesDir: path.join(root, 'templates'),
      music: [{ id: 'm1', name: 'Nhạc 1', durationSec: 30, license: 'CC0', source: 'x', file: 'm1.mp3' }, { id: 'bad', name: 'x', durationSec: 1, license: 'CC0', source: 'x', file: '../secret.txt' }],
      musicDir: path.join(root, 'music'),
      version: '1.0.0', hyperframes: '0.8.181',
      limits: { maxTotalBytes: 3 * 1024 * 1024 },
      freeBytes: () => freeBytes,
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('health không cần khoá và không lộ chủ hàng đợi', async () => {
    await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }]);
    const r = await call('GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, version: '1.0.0', hyperframes: '0.8.181' });
    expect(JSON.stringify(r.json)).not.toMatch(/alpha|beta/);
    expect(r.json.queue).toEqual({ length: 1 });
  });

  it('507 LIMIT_REACHED khi ổ còn trống dưới 2 GB, không tạo việc', async () => {
    freeBytes = 2 * 1024 * 1024 * 1024 - 1;
    const r = await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }]);
    expect(r.status).toBe(507);
    expect(r.json.error).toMatchObject({ code: 'LIMIT_REACHED', message: 'Máy chủ render sắp hết dung lượng' });
    expect(jobsDirEntries()).toEqual([]);
    freeBytes = 2 * 1024 * 1024 * 1024;
    expect((await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).status).toBe(201);
  });

  it('401 khi thiếu hoặc sai khoá', async () => {
    for (const key of [undefined, 'sai-khoa']) {
      const r = await call('GET', '/v1/templates', { key });
      expect(r.status).toBe(401);
      expect(r.json.error.code).toBe('UNAUTHORIZED');
    }
    expect((await call('GET', '/v1/jobs/abc')).status).toBe(401);
  });

  it('/v1/templates trả mẫu và nhạc', async () => {
    const r = await call('GET', '/v1/templates', { key: KEY_A });
    expect(r.status).toBe(200);
    expect(r.json.templates.map((t: any) => t.id)).toEqual(['t1']);
    expect(r.json.music.map((x: any) => x.id)).toEqual(['m1', 'bad']);
  });

  it('/v1/music/:id cần khoá, chỉ phát nhạc trong manifest, hỗ trợ Range', async () => {
    fs.mkdirSync(path.join(root, 'music'), { recursive: true });
    fs.writeFileSync(path.join(root, 'music', 'm1.mp3'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'bí mật');
    expect((await call('GET', '/v1/music/m1')).status).toBe(401);
    const ok = await call('GET', '/v1/music/m1', { key: KEY_A });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/mpeg');
    expect(ok.body.toString()).toBe('0123456789');
    const part = await call('GET', '/v1/music/m1', { key: KEY_A, headers: { Range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('234');
    expect((await call('GET', '/v1/music/khong-co', { key: KEY_A })).status).toBe(404);
    expect((await call('GET', '/v1/music/bad', { key: KEY_A })).status).toBe(404);
    expect((await call('GET', '/v1/music/..%2Fsecret', { key: KEY_A })).status).toBe(404);
  });

  it('tạo việc theo mẫu: đổi tên tệp, bỏ qua tên client', async () => {
    const r = await create(KEY_A, [
      { name: 'spec', data: templateSpec(['evil.jpg']) },
      { name: 'files', data: JPEG, filename: '../../evil.jpg' },
    ]);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: 'queued', position: 1 });
    const id = r.json.jobId;
    expect(fs.readdirSync(path.join(store.jobDir(id), 'input'))).toEqual(['img1.jpg']);
    expect(fs.existsSync(path.join(root, 'evil.jpg'))).toBe(false);
    expect(store.get(id)!.spec).toMatchObject({ kind: 'template', images: ['img1.jpg'] });
    expect(r.json.files).toEqual({ 'evil.jpg': 'img1.jpg' });
  });

  it('tạo việc HTML: tệp thành assetN', async () => {
    const html = '<div data-composition-id="c" data-duration="5"></div>';
    const r = await create(KEY_A, [
      { name: 'spec', data: JSON.stringify({ html, width: 1080, height: 1920 }) },
      { name: 'files[]', data: JPEG, filename: 'a.jpg' },
      { name: 'files[]', data: MP3, filename: 'b.mp3' },
    ]);
    expect(r.status).toBe(201);
    expect(r.json.files).toEqual({ 'a.jpg': 'asset1.jpg', 'b.mp3': 'asset2.mp3' });
    expect(fs.readdirSync(path.join(store.jobDir(r.json.jobId), 'input')).sort()).toEqual(['asset1.jpg', 'asset2.mp3']);
  });

  it('tệp giả đuôi .jpg bị 415 và không để lại gì', async () => {
    const r = await create(KEY_A, [
      { name: 'spec', data: templateSpec(['a.jpg']) },
      { name: 'files', data: Buffer.from('#!/bin/sh\nrm -rf /\n'.repeat(10)), filename: 'a.jpg' },
    ]);
    expect(r.status).toBe(415);
    expect(r.json.error.code).toBe('UNSUPPORTED_FILE');
    expect(jobsDirEntries()).toEqual([]);
  });

  it('ảnh quá 20 MB bị 413 khi đang nhận và dọn phần đã ghi', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(21 * 1024 * 1024)]);
    const m = multipart([{ name: 'spec', data: templateSpec(['a.jpg']) }, { name: 'files', data: big, filename: 'a.jpg' }]);
    const r = await call('POST', '/v1/jobs', { key: KEY_A, body: m.body, type: m.type }).catch((e) => ({ status: 0, json: e }));
    expect([413, 0]).toContain(r.status);
    if (r.status === 413) expect((r as Res).json.error.code).toBe('TOO_LARGE');
    await new Promise((res) => setTimeout(res, 100));
    expect(jobsDirEntries()).toEqual([]);
  });

  it('tổng dung lượng vượt giới hạn bị 413 và dọn sạch', async () => {
    const f = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
    const r = await create(KEY_A, [
      { name: 'spec', data: templateSpec(['1.jpg', '2.jpg', '3.jpg', '4.jpg']) },
      ...['1', '2', '3', '4'].map((n) => ({ name: 'files', data: f, filename: `${n}.jpg` })),
    ]);
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('TOO_LARGE');
    expect(jobsDirEntries()).toEqual([]);
  });

  it('Content-Length quá lớn bị 413 ngay', async () => {
    const r = await call('POST', '/v1/jobs', { key: KEY_A, type: 'multipart/form-data; boundary=x', headers: { 'Content-Length': String(500 * 1024 * 1024) } });
    expect(r.status).toBe(413);
  });

  it('spec sai thì 400 INVALID_SPEC và dọn sạch', async () => {
    for (const parts of [
      [{ name: 'spec', data: '{không phải json' }],
      [{ name: 'spec', data: JSON.stringify({ template: { id: 'khong-co', aspect: '9:16' } }) }],
      [{ name: 'files', data: JPEG, filename: 'a.jpg' }],
    ] as Part[][]) {
      const r = await create(KEY_A, parts);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('INVALID_SPEC');
    }
    expect(jobsDirEntries()).toEqual([]);
  });

  it('không phải multipart thì 400', async () => {
    const r = await call('POST', '/v1/jobs', { key: KEY_A, body: Buffer.from('{}'), type: 'application/json' });
    expect(r.status).toBe(400);
  });

  it('429 khi quá 5 việc đang chờ mỗi khoá, khoá khác vẫn tạo được', async () => {
    for (let i = 0; i < 5; i++) expect((await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).status).toBe(201);
    const r = await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }]);
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe('LIMIT_REACHED');
    expect(jobsDirEntries()).toHaveLength(5);
    expect((await create(KEY_B, [{ name: 'spec', data: templateSpec([]) }])).status).toBe(201);
  });

  it('khoá khác xem/huỷ việc của người khác đều 404', async () => {
    const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
    for (const suffix of ['', '/video', '/thumb']) {
      const r = await call('GET', `/v1/jobs/${id}${suffix}`, { key: KEY_B });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('NOT_FOUND');
    }
    expect((await call('DELETE', `/v1/jobs/${id}`, { key: KEY_B })).status).toBe(404);
    expect((await call('GET', '/v1/jobs/khong-ton-tai', { key: KEY_A })).status).toBe(404);
    expect((await call('GET', '/v1/jobs/..%2F..%2Fx', { key: KEY_A })).status).toBe(404);
    expect(store.get(id)!.status).toBe('queued');
  });

  it('huỷ việc đang chờ', async () => {
    const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
    const r = await call('DELETE', `/v1/jobs/${id}`, { key: KEY_A });
    expect(r.status).toBe(200);
    const s = await call('GET', `/v1/jobs/${id}`, { key: KEY_A });
    expect(s.json).toMatchObject({ jobId: id, status: 'cancelled' });
    expect(queue.length).toBe(0);
  });

  describe('vòng điều phối với worker giả', () => {
    const out = (n: string) => path.join(shared, 'out', n);

    it('queued -> rendering -> done, phục vụ video (kèm Range) và bìa', async () => {
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec(['a.jpg']) }, { name: 'files', data: JPEG, filename: 'a.jpg' }])).json.jobId;
      orch.tick();
      expect(fs.existsSync(path.join(shared, 'current', 'job.json'))).toBe(true);
      expect(fs.existsSync(path.join(shared, 'current', 'img1.jpg'))).toBe(true);
      fs.writeFileSync(out(`${id}.progress.json`), `{"jobId":"${id}","percent":40}`);
      orch.tick();
      let s = await call('GET', `/v1/jobs/${id}`, { key: KEY_A });
      expect(s.json).toMatchObject({ status: 'rendering', progress: 0.4 });
      expect(s.json.position).toBeUndefined();
      expect((await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A })).status).toBe(404);

      fs.writeFileSync(out(`${id}.mp4`), Buffer.from('0123456789'));
      fs.writeFileSync(out(`${id}.jpg`), JPEG);
      fs.writeFileSync(out(`${id}.result.json`), `{"jobId":"${id}","ok":true,"durationMs":5000}`);
      orch.tick();
      s = await call('GET', `/v1/jobs/${id}`, { key: KEY_A });
      expect(s.json).toMatchObject({ status: 'done', progress: 1, sizeBytes: 10, durationSec: 5 });
      expect(s.json.finishedAt).toBeGreaterThan(0);

      const v = await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A });
      expect(v.status).toBe(200);
      expect(v.headers['content-type']).toBe('video/mp4');
      expect(v.body.toString()).toBe('0123456789');
      const part = await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A, headers: { Range: 'bytes=2-4' } });
      expect(part.status).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 2-4/10');
      expect(part.body.toString()).toBe('234');
      const t = await call('GET', `/v1/jobs/${id}/thumb`, { key: KEY_A });
      expect(t.headers['content-type']).toBe('image/jpeg');
      expect(t.body.equals(JPEG)).toBe(true);
      expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
    });

    it('xoá tệp đầu vào ngay khi việc kết thúc, giữ đầu ra', async () => {
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec(['a.jpg']) }, { name: 'files', data: JPEG, filename: 'a.jpg' }])).json.jobId;
      expect(fs.existsSync(path.join(store.jobDir(id), 'input', 'img1.jpg'))).toBe(true);
      orch.tick();
      fs.writeFileSync(out(`${id}.mp4`), 'vid');
      fs.writeFileSync(out(`${id}.result.json`), `{"jobId":"${id}","ok":true}`);
      orch.tick();
      expect(store.get(id)!.status).toBe('done');
      expect(fs.existsSync(path.join(store.jobDir(id), 'input'))).toBe(false);
      expect(fs.existsSync(path.join(store.jobDir(id), 'output', 'video.mp4'))).toBe(true);
    });

    it('liên kết tượng trưng trong out/ không làm rò video của khoá khác: việc failed', async () => {
      const victim = path.join(root, 'victim.mp4');
      fs.writeFileSync(victim, 'secret');
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      orch.tick();
      fs.symlinkSync(victim, out(`${id}.mp4`));
      fs.writeFileSync(out(`${id}.result.json`), `{"jobId":"${id}","ok":true}`);
      orch.tick();
      expect(store.get(id)).toMatchObject({ status: 'failed', error: 'Máy render trả về tệp không hợp lệ' });
      expect(fs.existsSync(path.join(store.jobDir(id), 'output', 'video.mp4'))).toBe(false);
      orch.tick(); // hàng đợi không bị treo
    });

    it('việc kế tiếp chỉ chạy sau khi việc trước xong; position cập nhật', async () => {
      const a = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      const b = (await create(KEY_B, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      orch.tick();
      expect((await call('GET', `/v1/jobs/${b}`, { key: KEY_B })).json).toMatchObject({ status: 'queued', position: 1 });
      fs.writeFileSync(out(`${a}.result.json`), `{"jobId":"${a}","ok":false,"error":"hỏng"}`);
      orch.tick();
      expect((await call('GET', `/v1/jobs/${a}`, { key: KEY_A })).json).toMatchObject({ status: 'failed', error: 'hỏng' });
      orch.tick();
      expect(store.get(b)!.status).toBe('rendering');
    });

    it('huỷ đang render: báo worker dừng, kết quả thành cancelled kể cả khi worker vẫn xong', async () => {
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      orch.tick();
      const r = await call('DELETE', `/v1/jobs/${id}`, { key: KEY_A });
      expect(r.status).toBe(202);
      expect(fs.existsSync(path.join(shared, 'current', 'cancel'))).toBe(true);
      fs.writeFileSync(out(`${id}.mp4`), 'x');
      fs.writeFileSync(out(`${id}.result.json`), `{"jobId":"${id}","ok":true}`);
      orch.tick();
      expect(store.get(id)).toMatchObject({ status: 'cancelled' });
      expect(fs.existsSync(path.join(store.jobDir(id), 'output', 'video.mp4'))).toBe(false);
      expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
      orch.tick(); // hàng đợi không bị treo
    });

    it('xoá việc đã kết thúc', async () => {
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      orch.tick();
      fs.writeFileSync(out(`${id}.result.json`), `{"jobId":"${id}","ok":false,"error":"x"}`);
      orch.tick();
      expect((await call('DELETE', `/v1/jobs/${id}`, { key: KEY_A })).status).toBe(200);
      expect((await call('GET', `/v1/jobs/${id}`, { key: KEY_A })).status).toBe(404);
    });

    it('worker chết (không tiến độ quá 60 giây) thì việc failed, hàng đợi chạy tiếp', async () => {
      let t = 1_000_000;
      const h = new Handoff(path.join(root, 'shared2'), () => t);
      const o = new Orchestrator({ store, queue, handoff: h, retention: new Retention(store) });
      const a = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      const b = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      o.tick();
      t += 61_000;
      o.tick();
      expect(store.get(a)).toMatchObject({ status: 'failed' });
      o.tick();
      expect(store.get(b)!.status).toBe('rendering');
    });

    it('khởi động lại: việc rendering thành failed và current/ được dọn', async () => {
      const id = (await create(KEY_A, [{ name: 'spec', data: templateSpec([]) }])).json.jobId;
      orch.tick();
      const store2 = new JobStore(path.join(root, 'data'));
      const queue2 = new Queue(store2);
      const orch2 = new Orchestrator({ store: store2, queue: queue2, handoff, retention: new Retention(store2) });
      orch2.init();
      expect(store2.get(id)!.status).toBe('failed');
      expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
    });
  });

  describe('độ bền (lỗi nội bộ, ngắt kết nối, giới hạn trước khi đọc thân)', () => {
    const spec0 = () => [{ name: 'spec', data: templateSpec([]) }];
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const afterEachRestore = () => jest.restoreAllMocks();
    afterEach(afterEachRestore);

    /** Tạo sẵn một việc `done` với tệp video cho trước. */
    function doneJob(video: Buffer): string {
      const id = '11111111-1111-4111-8111-111111111111';
      store.create({ id, owner: 'alpha', status: 'done', progress: 1, createdAt: Date.now(), finishedAt: Date.now(), spec: {} as any });
      fs.writeFileSync(path.join(store.jobDir(id), 'output', 'video.mp4'), video);
      return id;
    }

    /** Mở một yêu cầu tải lên và giữ dở dang (đã gửi header, chưa gửi hết thân). */
    function stalledUpload(key: string): http.ClientRequest {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/jobs', headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'multipart/form-data; boundary=zz', 'Content-Length': 100000,
      } });
      req.on('error', () => undefined);
      req.write('--zz\r\nContent-Disposition: form-data; name="spec"\r\n\r\n{');
      return req;
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('pollCurrent ném lỗi: việc failed, current/ được dọn, hàng đợi chạy tiếp', async () => {
      quiet();
      const a = (await create(KEY_A, spec0())).json.jobId;
      const b = (await create(KEY_B, spec0())).json.jobId;
      orch.tick();
      jest.spyOn(handoff, 'poll').mockImplementationOnce(() => { throw new Error('boom'); });
      orch.tick();
      expect(store.get(a)).toMatchObject({ status: 'failed', error: 'Lỗi nội bộ khi hoàn tất việc' });
      orch.tick();
      expect(store.get(b)!.status).toBe('rendering');
    });

    it('store.update ném lỗi khi cập nhật tiến độ cũng không làm kẹt hàng đợi', async () => {
      quiet();
      const a = (await create(KEY_A, spec0())).json.jobId;
      const b = (await create(KEY_B, spec0())).json.jobId;
      orch.tick();
      fs.writeFileSync(path.join(shared, 'out', `${a}.progress.json`), `{"jobId":"${a}","percent":10}`);
      const real = store.update.bind(store);
      let n = 0;
      jest.spyOn(store, 'update').mockImplementation((id, patch) => { if (n++ === 0) throw new Error('disk'); return real(id, patch); });
      orch.tick();
      expect(store.get(a)!.status).toBe('failed');
      orch.tick();
      expect(store.get(b)!.status).toBe('rendering');
    });

    it('queue.next: store.update ném lỗi thì đánh dấu failed và chạy việc kế tiếp', async () => {
      quiet();
      const a = (await create(KEY_A, spec0())).json.jobId;
      const b = (await create(KEY_B, spec0())).json.jobId;
      const real = store.update.bind(store);
      let n = 0;
      jest.spyOn(store, 'update').mockImplementation((id, patch) => { if (n++ === 0) throw new Error('disk'); return real(id, patch); });
      expect(queue.next()?.id).toBe(b);
      expect(store.get(a)).toMatchObject({ status: 'failed' });
    });

    it('khởi động với out/ và current/ còn tệp cũ: dọn sạch, không giao cho việc nào', async () => {
      fs.mkdirSync(path.join(shared, 'out'), { recursive: true });
      fs.mkdirSync(path.join(shared, 'current'), { recursive: true });
      for (const f of ['video.mp4', 'old.mp4', 'old.result.json', 'old.progress.json']) fs.writeFileSync(path.join(shared, 'out', f), 'x');
      fs.writeFileSync(path.join(shared, 'current', 'job.json'), '{"jobId":"old"}');
      const o = new Orchestrator({ store, queue, handoff, retention: new Retention(store) });
      o.init();
      expect(fs.readdirSync(path.join(shared, 'out'))).toEqual([]);
      expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
      const id = (await create(KEY_A, spec0())).json.jobId;
      o.tick();
      expect(store.get(id)!.status).toBe('rendering');
    });

    it('lỗi ghi tệp khi nhận upload: 500 INTERNAL, dọn sạch, tiến trình vẫn sống', async () => {
      quiet();
      const rawFs = require('fs');
      const real = rawFs.createWriteStream;
      const spy = jest.spyOn(rawFs, 'createWriteStream').mockImplementation(((_p: any, o: any) => real('/nonexistent-dir-xyz/f', o)) as any);
      const r = await create(KEY_A, [{ name: 'spec', data: templateSpec(['a.jpg']) }, { name: 'files', data: JPEG, filename: 'a.jpg' }]);
      expect(r.status).toBe(500);
      expect(r.json.error.code).toBe('INTERNAL');
      expect(jobsDirEntries()).toHaveLength(0);
      spy.mockRestore();
      expect((await call('GET', '/v1/health')).status).toBe(200);
      expect((await create(KEY_A, spec0())).status).toBe(201);
    });

    it('client ngắt khi đang tải video: luồng đọc bị đóng, máy chủ vẫn hoạt động', async () => {
      const id = doneJob(Buffer.alloc(40 * 1024 * 1024, 7));
      const streams: fs.ReadStream[] = [];
      const rawFs = require('fs');
      const real = rawFs.createReadStream;
      jest.spyOn(rawFs, 'createReadStream').mockImplementation(((...a: any[]) => { const s = (real as any)(...a); streams.push(s); return s; }) as any);
      await new Promise<void>((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/v1/jobs/${id}/video`, headers: { Authorization: `Bearer ${KEY_A}` } }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => undefined);
      });
      for (let i = 0; i < 40 && !streams[0]?.destroyed; i++) await sleep(50);
      expect(streams).toHaveLength(1);
      expect(streams[0].destroyed).toBe(true);
      expect((await call('GET', '/v1/health')).status).toBe(200);
    });

    it('video 0 byte: 200 rỗng; Range thì 416; không ném lỗi', async () => {
      const id = doneJob(Buffer.alloc(0));
      const r = await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A });
      expect(r.status).toBe(200);
      expect(r.headers['content-length']).toBe('0');
      expect(r.body.length).toBe(0);
      expect((await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A, headers: { Range: 'bytes=0-' } })).status).toBe(416);
      expect((await call('GET', `/v1/jobs/${id}/video`, { key: KEY_A, headers: { Range: 'bytes=-5' } })).status).toBe(416);
    });

    it('Range: vượt cỡ / ngược / hậu tố 0 là 416; hậu tố và đoạn cuối hợp lệ là 206', async () => {
      const id = doneJob(Buffer.from('0123456789'));
      const get = (range: string) => call('GET', `/v1/jobs/${id}/video`, { key: KEY_A, headers: { Range: range } });
      for (const bad of ['bytes=100-200', 'bytes=5-2', 'bytes=-0', 'bytes=10-', 'bytes=-', 'bytes=a-b']) {
        const r = await get(bad);
        expect([bad, r.status]).toEqual([bad, 416]);
        expect(r.headers['content-range']).toBe('bytes */10');
      }
      const suffix = await get('bytes=-3');
      expect([suffix.status, suffix.body.toString(), suffix.headers['content-range']]).toEqual([206, '789', 'bytes 7-9/10']);
      const open = await get('bytes=8-');
      expect([open.status, open.body.toString()]).toEqual([206, '89']);
      const clamp = await get('bytes=8-99');
      expect([clamp.status, clamp.headers['content-range']]).toEqual([206, 'bytes 8-9/10']);
      const big = await get('bytes=-99');
      expect([big.status, big.body.toString()]).toEqual([206, '0123456789']);
    });

    it('429 trả về ngay khi khoá đã đầy, trước khi đọc thân yêu cầu', async () => {
      for (let i = 0; i < 5; i++) expect((await create(KEY_A, spec0())).status).toBe(201);
      const r = await new Promise<{ status: number; code: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/jobs', headers: {
          Authorization: `Bearer ${KEY_A}`, 'Content-Type': 'multipart/form-data; boundary=zz', 'Content-Length': 100000,
        } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, code: JSON.parse(Buffer.concat(chunks).toString()).error.code }));
        });
        req.on('error', reject);
        req.write('--zz\r\n'); // chỉ gửi vài byte; thân không bao giờ gửi hết
        setTimeout(() => req.destroy(), 1500).unref();
      });
      expect(r).toEqual({ status: 429, code: 'LIMIT_REACHED' });
      expect(jobsDirEntries()).toHaveLength(5);
    });

    it('tối đa 2 lượt tải lên đồng thời mỗi khoá; xong hoặc ngắt thì nhả chỗ', async () => {
      const u1 = stalledUpload(KEY_A);
      const u2 = stalledUpload(KEY_A);
      await sleep(150);
      const r = await create(KEY_A, spec0());
      expect(r.status).toBe(429);
      expect((await create(KEY_B, spec0())).status).toBe(201); // khoá khác không bị ảnh hưởng
      u1.destroy(); u2.destroy();
      let ok = false;
      for (let i = 0; i < 40 && !ok; i++) { await sleep(50); ok = (await create(KEY_A, spec0())).status === 201; }
      expect(ok).toBe(true);
    });

    it('tối đa 4 lượt tải lên đồng thời toàn máy', async () => {
      const KEY_C = 'key-gamma-000000000000000000000000000000000000';
      const server2 = createServer({
        keys: new Map([['alpha', hashKey(KEY_A)], ['beta', hashKey(KEY_B)], ['gamma', hashKey(KEY_C)]]),
        store, queue, orchestrator: orch, templatesDir: path.join(root, 'templates'), music: [], version: '1', hyperframes: '0',
      });
      await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
      const saved = port;
      port = (server2.address() as AddressInfo).port;
      const ups = [stalledUpload(KEY_A), stalledUpload(KEY_A), stalledUpload(KEY_B), stalledUpload(KEY_B)];
      try {
        await sleep(200);
        expect((await create(KEY_C, spec0())).status).toBe(429);
      } finally {
        ups.forEach((u) => u.destroy());
        await sleep(100);
        port = saved;
        await new Promise((r) => server2.close(r));
      }
    });
  });

  it('start() đặt hẹn giờ 1 giây và 1 giờ, stop() huỷ; lỗi trong tick không làm sập', () => {
    const calls: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const fake = {
      setInterval: (fn: () => void, ms: number) => { calls.push({ fn, ms }); return calls.length as unknown as NodeJS.Timeout; },
      clearInterval: (h: unknown) => { cleared.push(h); },
    };
    const purge = jest.fn(() => 0);
    const o = new Orchestrator({ store, queue, handoff, retention: { purge } as unknown as Retention, timers: fake });
    o.start();
    expect(calls.map((c) => c.ms)).toEqual([1000, 3600000]);
    jest.spyOn(queue, 'next').mockImplementation(() => { throw new Error('boom'); });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => calls[0].fn()).not.toThrow();
    calls[1].fn();
    expect(purge).toHaveBeenCalled();
    o.stop();
    expect(cleared).toHaveLength(2);
  });
});
