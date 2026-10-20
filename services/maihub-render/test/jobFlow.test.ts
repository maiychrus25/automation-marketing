import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobStore, Job } from '../src/jobStore';
import { Queue, LimitError } from '../src/queue';
import { Handoff } from '../src/handoff';
import { Retention } from '../src/retention';
import { LIMITS } from '../src/limits';

const spec: any = { kind: 'html', html: '<div></div>', durationSec: 5, width: 1080, height: 1920, fps: 30, quality: 'standard' };
let root: string;
let clock: number;
const now = () => clock;
const uid = (n: string | number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uidCache = new Map<string, string>();
const U = (n: string): string => { if (!uidCache.has(n)) uidCache.set(n, uid(uidCache.size + 1)); return uidCache.get(n)!; };
const mk = (id: string, owner = 'a', createdAt = clock): Job => ({ id: U(id), owner, status: 'queued', progress: 0, spec, createdAt });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhr-')); clock = 1_000_000_000_000; });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('JobStore', () => {
  it('ghi nguyên tử và đọc lại', () => {
    const s = new JobStore(path.join(root, 'data'));
    s.create(mk('j1'));
    expect(s.get(U('j1'))?.status).toBe('queued');
    s.update(U('j1'), { status: 'done', progress: 1 });
    expect(new JobStore(path.join(root, 'data')).get(U('j1'))?.status).toBe('done');
    expect(fs.readdirSync(s.jobDir(U('j1'))).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(s.jobDir(U('j1')), 'input'))).toBe(true);
    expect(fs.existsSync(path.join(s.jobDir(U('j1')), 'output'))).toBe(true);
  });
  it('nạp lại: rendering -> failed, queued giữ nguyên', () => {
    const s = new JobStore(path.join(root, 'data'), now);
    s.create(mk('j1')); s.create(mk('j2'));
    s.update(U('j1'), { status: 'rendering' });
    const s2 = new JobStore(path.join(root, 'data'), now);
    const jobs = s2.load();
    expect(jobs).toHaveLength(2);
    expect(s2.get(U('j1'))).toMatchObject({ status: 'failed', error: 'Máy chủ khởi động lại khi đang render', finishedAt: clock });
    expect(s2.get(U('j2'))?.status).toBe('queued');
  });
  it('job.json hỏng: ghi cảnh báo, hiện là failed (không thuộc khoá nào) và retention dọn được', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = new JobStore(path.join(root, 'data'), now);
    s.create(mk('bad'));
    fs.writeFileSync(path.join(s.jobDir(U('bad')), 'job.json'), '{hỏng');
    expect(s.get(U('bad'))).toMatchObject({ id: U('bad'), status: 'failed', owner: '' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(U('bad')));
    expect(s.list().map((j) => j.id)).toContain(U('bad'));
    expect(() => s.update(U('bad'), { progress: 1 })).toThrow();
    expect(new Retention(s, () => Date.now() + 8 * 24 * 3600 * 1000).purge()).toBe(1);
    expect(fs.existsSync(s.jobDir(U('bad')))).toBe(false);
    warn.mockRestore();
  });
  it('ghi job.json có fsync trước khi rename', () => {
    const order: string[] = [];
    const rawFs = require('fs');
    const f = jest.spyOn(rawFs, 'fsyncSync').mockImplementation(() => { order.push('fsync'); });
    const origRename = rawFs.renameSync;
    const r = jest.spyOn(rawFs, 'renameSync').mockImplementation(((...a: any[]) => { order.push('rename'); return origRename(...a); }) as any);
    const s = new JobStore(path.join(root, 'data'), now);
    s.create(mk('fs1'));
    f.mockRestore(); r.mockRestore();
    expect(order).toEqual(['fsync', 'rename']);
  });
  it('id không hợp lệ bị từ chối (chống ../)', () => {
    const s = new JobStore(path.join(root, 'data'));
    expect(() => s.jobDir('../x')).toThrow();
    expect(() => s.jobDir('not-a-uuid')).toThrow();
    expect(() => s.jobDir(U('ok') + '/..')).toThrow();
    expect(s.get('../x')).toBeUndefined();
  });
});

describe('Queue', () => {
  const setup = () => { const s = new JobStore(path.join(root, 'data'), now); return { s, q: new Queue(s, now) }; };
  it('FIFO, một việc mỗi lúc, vị trí', () => {
    const { s, q } = setup();
    for (const id of ['a1', 'a2', 'a3']) { s.create(mk(id)); q.enqueue(s.get(U(id))!); }
    expect(q.positionOf(U('a1'))).toBe(1);
    expect(q.positionOf(U('a3'))).toBe(3);
    expect(q.next()?.id).toBe(U('a1'));
    expect(s.get(U('a1'))?.status).toBe('rendering');
    expect(q.next()).toBeUndefined();
    expect(q.positionOf(U('a2'))).toBe(1);
    q.finish(U('a1'));
    expect(q.next()?.id).toBe(U('a2'));
  });
  it('tối đa 5 việc chờ mỗi khoá', () => {
    const { s, q } = setup();
    for (let i = 0; i < 5; i++) { s.create(mk('k' + i)); q.enqueue(s.get(U('k' + i))!); }
    s.create(mk('k5'));
    expect(() => q.enqueue(s.get(U('k5'))!)).toThrow(LimitError);
    s.create(mk('other', 'b'));
    expect(() => q.enqueue(s.get(U('other'))!)).not.toThrow();
  });
  it('tối đa 20 việc chung', () => {
    const { s, q } = setup();
    for (let i = 0; i < LIMITS.maxQueue; i++) { const id = 'x' + i; s.create(mk(id, 'o' + i)); q.enqueue(s.get(U(id))!); }
    s.create(mk('over', 'zz'));
    expect(() => q.enqueue(s.get(U('over'))!)).toThrow(LimitError);
  });
  it('30 lần mỗi giờ mỗi khoá, cửa sổ trượt', () => {
    const { s, q } = setup();
    for (let i = 0; i < 30; i++) {
      const id = 'r' + i; s.create(mk(id)); q.enqueue(s.get(U(id))!);
      q.cancel(U(id));
    }
    s.create(mk('r30'));
    expect(() => q.enqueue(s.get(U('r30'))!)).toThrow(LimitError);
    clock += 60 * 60 * 1000 + 1;
    expect(() => q.enqueue(s.get(U('r30'))!)).not.toThrow();
  });
  it('huỷ khi chờ / khi chạy', () => {
    const { s, q } = setup();
    s.create(mk('c1')); s.create(mk('c2'));
    q.enqueue(s.get(U('c1'))!); q.enqueue(s.get(U('c2'))!);
    expect(q.cancel(U('c2'))).toBe('removed');
    expect(s.get(U('c2'))).toMatchObject({ status: 'cancelled', finishedAt: clock });
    expect(q.positionOf(U('c2'))).toBeUndefined();
    q.next();
    expect(q.cancel(U('c1'))).toBe('running');
    expect(s.get(U('c1'))?.status).toBe('rendering');
    expect(q.cancel(U('nope'))).toBe('none');
  });
  it('dựng lại hàng đợi sau khởi động theo createdAt', () => {
    const { s } = setup();
    s.create(mk('late', 'a', 300)); s.create(mk('early', 'a', 100)); s.create(mk('mid', 'a', 200));
    s.create({ ...mk('fin', 'a', 50), status: 'done' });
    const s2 = new JobStore(path.join(root, 'data'), now);
    const q2 = new Queue(s2, now);
    q2.restore(s2.load());
    expect(q2.next()?.id).toBe(U('early'));
    q2.finish(U('early'));
    expect(q2.next()?.id).toBe(U('mid'));
  });
});

describe('Handoff', () => {
  const dirs = () => ({ shared: path.join(root, 'shared'), input: path.join(root, 'input') });
  const prep = () => {
    const { shared, input } = dirs();
    fs.mkdirSync(input, { recursive: true });
    fs.writeFileSync(path.join(input, 'img1.jpg'), 'x');
    return new Handoff(shared, now);
  };
  it('start: chép tệp, job.json ghi cuối cùng, không để lại tệp việc trước', () => {
    const h = prep(); const { shared, input } = dirs();
    fs.mkdirSync(path.join(shared, 'current'), { recursive: true });
    fs.mkdirSync(path.join(shared, 'out'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'current', 'old.jpg'), 'old');
    fs.writeFileSync(path.join(shared, 'out', 'old.result.json'), '{"ok":true}');
    const writes: string[] = [];
    const rawFs = require('fs');
    const orig = rawFs.renameSync;
    const spy = jest.spyOn(rawFs, 'renameSync').mockImplementation((a: any, b: any) => {
      writes.push(path.basename(String(b)) + ':' + fs.readdirSync(path.join(shared, 'current')).sort().join(','));
      return orig(a, b);
    });
    h.start({ id: 'j1', spec }, input, { 'index.html': '<html></html>' });
    spy.mockRestore();
    expect(fs.readdirSync(path.join(shared, 'current')).sort()).toEqual(['img1.jpg', 'index.html', 'job.json']);
    expect(fs.existsSync(path.join(shared, 'out', 'old.result.json'))).toBe(false);
    // khi đổi tên thành job.json, các tệp khác đã đủ
    expect(writes[writes.length - 1]).toMatch(/^job\.json:/);
    expect(writes[writes.length - 1]).toContain('img1.jpg');
    expect(writes[writes.length - 1]).toContain('index.html');
    expect(JSON.parse(fs.readFileSync(path.join(shared, 'current', 'job.json'), 'utf8')).id).toBe('j1');
  });
  it('poll: idle -> running -> done', () => {
    const h = prep(); const { shared, input } = dirs();
    expect(h.poll()).toEqual({ state: 'idle' });
    h.start({ id: 'j1', spec }, input, {});
    expect(h.poll().state).toBe('running');
    fs.writeFileSync(path.join(shared, 'out', 'j1.progress.json'), '{"jobId":"j1","percent":42}');
    clock += 100_000;
    expect(h.poll()).toMatchObject({ state: 'running', progress: 0.42 });
    fs.writeFileSync(path.join(shared, 'out', 'j1.result.json'), '{"jobId":"j1","ok":true,"durationMs":1234}');
    expect(h.poll()).toMatchObject({ state: 'done', result: { ok: true, durationMs: 1234 } });
  });
  it('result.json ghi dở không làm hỏng poll', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'j1.progress.json'), '{"jobId":"j1","percent":1}');
    fs.writeFileSync(path.join(shared, 'out', 'j1.result.json'), '{"ok":');
    expect(h.poll().state).toBe('running');
  });
  it('worker im lặng 60 giây -> failed và dọn sạch', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    clock += 59_000;
    expect(h.poll().state).toBe('running');
    clock += 2_000;
    const p = h.poll();
    expect(p.state).toBe('done');
    expect(p.result).toMatchObject({ ok: false });
    expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]); // job.json mất = worker tự dừng
    expect(h.poll()).toEqual({ state: 'idle' });
  });
  it('quá 15 phút dù có progress -> failed timeout', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'j1.progress.json'), '{"jobId":"j1","percent":50}');
    clock += LIMITS.renderTimeoutMs + 1;
    expect(h.poll().result).toMatchObject({ ok: false, error: 'timeout' });
    expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
  });
  it('kết quả muộn của việc đã bỏ không bị tính cho việc kế tiếp', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    clock += 61_000;
    expect(h.poll().result?.ok).toBe(false); // j1 bị bỏ
    h.start({ id: 'j2', spec }, input, {});
    // worker cũ vẫn còn chạy và ghi muộn (tên theo jobId của nó)
    fs.writeFileSync(path.join(shared, 'out', 'j1.mp4'), 'old');
    fs.writeFileSync(path.join(shared, 'out', 'j1.progress.json'), '{"jobId":"j1","percent":99}');
    fs.writeFileSync(path.join(shared, 'out', 'j1.result.json'), '{"jobId":"j1","ok":true}');
    expect(h.poll()).toMatchObject({ state: 'running', progress: 0 });
    expect(fs.readdirSync(path.join(shared, 'out'))).toEqual([]);
    expect(h.collect(path.join(root, 'dest'))).toEqual([]);
  });
  it('video muộn của việc bị bỏ không bao giờ giao cho việc kế tiếp, kể cả khi result của việc mới đã có', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    clock += 61_000;
    expect(h.poll().result?.ok).toBe(false);
    h.start({ id: 'j2', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'j2.result.json'), '{"jobId":"j2","ok":true,"durationMs":1}'); // j2 xong nhưng chưa có video
    fs.writeFileSync(path.join(shared, 'out', 'j1.mp4'), 'late-from-j1');
    fs.writeFileSync(path.join(shared, 'out', 'j1.jpg'), 'late-from-j1');
    expect(h.collect(path.join(root, 'dest'))).toEqual([]);
    expect(fs.existsSync(path.join(root, 'dest', 'video.mp4'))).toBe(false);
    expect(fs.readdirSync(path.join(shared, 'out'))).toEqual([]);
  });
  it('poll xoá mọi tệp lạ trong out/ (không mang jobId hiện tại)', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j2', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'video.mp4'), 'x');
    fs.writeFileSync(path.join(shared, 'out', 'j1.mp4'), 'x');
    fs.writeFileSync(path.join(shared, 'out', 'j2.mp4'), 'mine');
    h.poll();
    expect(fs.readdirSync(path.join(shared, 'out'))).toEqual(['j2.mp4']);
  });
  it('out/ cũ còn sót lúc khởi động bị bỏ qua', () => {
    const { shared, input } = dirs();
    fs.mkdirSync(input, { recursive: true });
    fs.mkdirSync(path.join(shared, 'out'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'out', 'old.result.json'), '{"jobId":"old","ok":true}');
    fs.writeFileSync(path.join(shared, 'out', 'old.mp4'), 'old');
    const h = new Handoff(shared, now);
    h.clean(); // api dọn khi khởi động
    expect(h.poll()).toEqual({ state: 'idle' });
    h.start({ id: 'j1', spec }, input, {});
    expect(h.poll().state).toBe('running');
    expect(fs.readdirSync(path.join(shared, 'out'))).toEqual([]);
  });
  it('result.json của việc khác (không dọn khi khởi động) không được nhận', () => {
    const { shared, input } = dirs();
    fs.mkdirSync(input, { recursive: true });
    const h = new Handoff(shared, now);
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'j1.result.json'), '{"ok":true}'); // thiếu jobId bên trong
    expect(h.poll().state).toBe('running');
  });
  it('cancel ghi current/cancel', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    h.cancel();
    expect(fs.existsSync(path.join(shared, 'current', 'cancel'))).toBe(true);
  });
  it('collect chuyển video/thumb và dọn sạch', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'j1.mp4'), 'vid');
    fs.writeFileSync(path.join(shared, 'out', 'j1.jpg'), 'th');
    fs.writeFileSync(path.join(shared, 'out', 'j1.result.json'), '{"jobId":"j1","ok":true,"durationMs":1}');
    const dest = path.join(root, 'dest');
    h.collect(dest);
    expect(fs.readFileSync(path.join(dest, 'video.mp4'), 'utf8')).toBe('vid');
    expect(fs.readFileSync(path.join(dest, 'thumb.jpg'), 'utf8')).toBe('th');
    expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
    expect(fs.readdirSync(path.join(shared, 'out'))).toEqual([]);
    expect(h.poll()).toEqual({ state: 'idle' });
  });
});

describe('Retention', () => {
  it('xoá việc quá 7 ngày, giữ việc mới và việc chưa xong', () => {
    const s = new JobStore(path.join(root, 'data'), now);
    const day = 24 * 3600 * 1000;
    s.create({ ...mk('old', 'a', clock - 8 * day), status: 'done', finishedAt: clock - 8 * day });
    s.create({ ...mk('new', 'a', clock - 1 * day), status: 'done', finishedAt: clock - 1 * day });
    s.create(mk('waiting', 'a', clock - 9 * day));
    expect(new Retention(s, now).purge()).toBe(1);
    expect(s.get(U('old'))).toBeUndefined();
    expect(fs.existsSync(s.jobDir(U('old')))).toBe(false);
    expect(s.get(U('new'))).toBeDefined();
    expect(s.get(U('waiting'))).toBeDefined();
  });
});
