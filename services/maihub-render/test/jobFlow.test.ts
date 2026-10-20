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
const mk = (id: string, owner = 'a', createdAt = clock): Job => ({ id, owner, status: 'queued', progress: 0, spec, createdAt });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mhr-')); clock = 1_000_000_000_000; });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('JobStore', () => {
  it('ghi nguyên tử và đọc lại', () => {
    const s = new JobStore(path.join(root, 'data'));
    s.create(mk('j1'));
    expect(s.get('j1')?.status).toBe('queued');
    s.update('j1', { status: 'done', progress: 1 });
    expect(new JobStore(path.join(root, 'data')).get('j1')?.status).toBe('done');
    expect(fs.readdirSync(s.jobDir('j1')).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(s.jobDir('j1'), 'input'))).toBe(true);
    expect(fs.existsSync(path.join(s.jobDir('j1'), 'output'))).toBe(true);
  });
  it('nạp lại: rendering -> failed, queued giữ nguyên', () => {
    const s = new JobStore(path.join(root, 'data'), now);
    s.create(mk('j1')); s.create(mk('j2'));
    s.update('j1', { status: 'rendering' });
    const s2 = new JobStore(path.join(root, 'data'), now);
    const jobs = s2.load();
    expect(jobs).toHaveLength(2);
    expect(s2.get('j1')).toMatchObject({ status: 'failed', error: 'Máy chủ khởi động lại khi đang render', finishedAt: clock });
    expect(s2.get('j2')?.status).toBe('queued');
  });
  it('id không hợp lệ bị từ chối (chống ../)', () => {
    const s = new JobStore(path.join(root, 'data'));
    expect(() => s.jobDir('../x')).toThrow();
    expect(s.get('../x')).toBeUndefined();
  });
});

describe('Queue', () => {
  const setup = () => { const s = new JobStore(path.join(root, 'data'), now); return { s, q: new Queue(s, now) }; };
  it('FIFO, một việc mỗi lúc, vị trí', () => {
    const { s, q } = setup();
    for (const id of ['a1', 'a2', 'a3']) { s.create(mk(id)); q.enqueue(s.get(id)!); }
    expect(q.positionOf('a1')).toBe(1);
    expect(q.positionOf('a3')).toBe(3);
    expect(q.next()?.id).toBe('a1');
    expect(s.get('a1')?.status).toBe('rendering');
    expect(q.next()).toBeUndefined();
    expect(q.positionOf('a2')).toBe(1);
    q.finish('a1');
    expect(q.next()?.id).toBe('a2');
  });
  it('tối đa 5 việc chờ mỗi khoá', () => {
    const { s, q } = setup();
    for (let i = 0; i < 5; i++) { s.create(mk('k' + i)); q.enqueue(s.get('k' + i)!); }
    s.create(mk('k5'));
    expect(() => q.enqueue(s.get('k5')!)).toThrow(LimitError);
    s.create(mk('other', 'b'));
    expect(() => q.enqueue(s.get('other')!)).not.toThrow();
  });
  it('tối đa 20 việc chung', () => {
    const { s, q } = setup();
    for (let i = 0; i < LIMITS.maxQueue; i++) { const id = 'x' + i; s.create(mk(id, 'o' + i)); q.enqueue(s.get(id)!); }
    s.create(mk('over', 'zz'));
    expect(() => q.enqueue(s.get('over')!)).toThrow(LimitError);
  });
  it('30 lần mỗi giờ mỗi khoá, cửa sổ trượt', () => {
    const { s, q } = setup();
    for (let i = 0; i < 30; i++) {
      const id = 'r' + i; s.create(mk(id)); q.enqueue(s.get(id)!);
      q.cancel(id);
    }
    s.create(mk('r30'));
    expect(() => q.enqueue(s.get('r30')!)).toThrow(LimitError);
    clock += 60 * 60 * 1000 + 1;
    expect(() => q.enqueue(s.get('r30')!)).not.toThrow();
  });
  it('huỷ khi chờ / khi chạy', () => {
    const { s, q } = setup();
    s.create(mk('c1')); s.create(mk('c2'));
    q.enqueue(s.get('c1')!); q.enqueue(s.get('c2')!);
    expect(q.cancel('c2')).toBe('removed');
    expect(s.get('c2')).toMatchObject({ status: 'cancelled', finishedAt: clock });
    expect(q.positionOf('c2')).toBeUndefined();
    q.next();
    expect(q.cancel('c1')).toBe('running');
    expect(s.get('c1')?.status).toBe('rendering');
    expect(q.cancel('nope')).toBe('none');
  });
  it('dựng lại hàng đợi sau khởi động theo createdAt', () => {
    const { s } = setup();
    s.create(mk('late', 'a', 300)); s.create(mk('early', 'a', 100)); s.create(mk('mid', 'a', 200));
    s.create({ ...mk('fin', 'a', 50), status: 'done' });
    const s2 = new JobStore(path.join(root, 'data'), now);
    const q2 = new Queue(s2, now);
    q2.restore(s2.load());
    expect(q2.next()?.id).toBe('early');
    q2.finish('early');
    expect(q2.next()?.id).toBe('mid');
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
    fs.writeFileSync(path.join(shared, 'out', 'result.json'), '{"ok":true}');
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
    expect(fs.existsSync(path.join(shared, 'out', 'result.json'))).toBe(false);
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
    fs.writeFileSync(path.join(shared, 'out', 'progress.json'), '{"percent":42}');
    clock += 100_000;
    expect(h.poll()).toMatchObject({ state: 'running', progress: 0.42 });
    fs.writeFileSync(path.join(shared, 'out', 'result.json'), '{"ok":true,"durationMs":1234}');
    expect(h.poll()).toMatchObject({ state: 'done', result: { ok: true, durationMs: 1234 } });
  });
  it('result.json ghi dở không làm hỏng poll', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'progress.json'), '{"percent":1}');
    fs.writeFileSync(path.join(shared, 'out', 'result.json'), '{"ok":');
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
    expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
    expect(h.poll()).toEqual({ state: 'idle' });
  });
  it('quá 15 phút dù có progress -> failed timeout', () => {
    const h = prep(); const { shared, input } = dirs();
    h.start({ id: 'j1', spec }, input, {});
    fs.writeFileSync(path.join(shared, 'out', 'progress.json'), '{"percent":50}');
    clock += LIMITS.renderTimeoutMs + 1;
    expect(h.poll().result).toMatchObject({ ok: false, error: 'timeout' });
    expect(fs.readdirSync(path.join(shared, 'current'))).toEqual([]);
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
    fs.writeFileSync(path.join(shared, 'out', 'video.mp4'), 'vid');
    fs.writeFileSync(path.join(shared, 'out', 'thumb.jpg'), 'th');
    fs.writeFileSync(path.join(shared, 'out', 'result.json'), '{"ok":true,"durationMs":1}');
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
    expect(s.get('old')).toBeUndefined();
    expect(fs.existsSync(s.jobDir('old'))).toBe(false);
    expect(s.get('new')).toBeDefined();
    expect(s.get('waiting')).toBeDefined();
  });
});
