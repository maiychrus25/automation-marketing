import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildWorkdir } from '../src/buildWorkdir';
import { prepareMusic } from '../src/music';
import { finalizeVideo, lintHtml, runRender } from '../src/renderRunner';
import { RenderWorker, WorkerConfig } from '../src/worker';

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE = path.join(FIXTURES, 'fake-hf.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const maybe = hasFfmpeg ? it : it.skip; // máy không có FFmpeg: bỏ qua có chủ đích

let root: string;
let video: string;
let audio: string;
const tpl = (name: string) => path.join(root, name);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  video = path.join(root, 'src.mp4');
  audio = path.join(root, 'src.wav');
  if (hasFfmpeg) {
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', video]);
    spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audio]);
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function dirs() {
  const base = fs.mkdtempSync(path.join(root, 'case-'));
  const d = { input: path.join(base, 'input'), tmp: path.join(base, 'tmp'), shared: path.join(base, 'shared'), music: path.join(base, 'music') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  return d;
}
const probeDur = (f: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());

describe('buildWorkdir', () => {
  const templatesDir = path.join(FIXTURES, 'tpl');
  const baseSpec = { width: 1080, height: 1920, fps: 30, quality: 'standard' as const };

  it('mẫu: chép mẫu, ảnh vào assets/, ghi variables.json', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    fs.writeFileSync(path.join(d.input, 'img2.png'), 'b');
    fs.writeFileSync(path.join(d.input, 'job.json'), '{}');
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 'demo', aspect: '9:16' as const, variables: { title: 'Hi' }, images: ['img1.jpg', 'img2.png'], musicId: null, musicFile: null };
    const r = await buildWorkdir({ id: 'j1', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect([r.width, r.height]).toEqual([1080, 1920]);
    expect(fs.existsSync(path.join(r.dir, 'index.html'))).toBe(true);
    expect(fs.readFileSync(path.join(r.dir, 'assets', 'img2.png'), 'utf8')).toBe('b');
    expect(fs.existsSync(path.join(r.dir, 'job.json'))).toBe(false);
    const vars = JSON.parse(fs.readFileSync(path.join(r.dir, 'variables.json'), 'utf8'));
    expect(vars).toMatchObject({ title: 'Hi', images: ['assets/img1.jpg', 'assets/img2.png'], width: 1080, height: 1920, durationSec: 6 });
    expect(fs.existsSync(path.join(templatesDir, 'demo', 'variables.json'))).toBe(false); // không sửa mẫu gốc
  });

  it('mẫu: tên ảnh có ../ hoặc id mẫu lạ bị từ chối', async () => {
    const d = dirs();
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 'demo', aspect: '9:16' as const, variables: {}, images: ['../x.jpg'], musicId: null, musicFile: null };
    const o = { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp };
    await expect(buildWorkdir({ id: 'j', spec }, o)).rejects.toThrow();
    await expect(buildWorkdir({ id: 'j', spec: { ...spec, images: [], templateId: '../demo' } }, o)).rejects.toThrow();
    await expect(buildWorkdir({ id: 'j', spec: { ...spec, images: [], templateId: 'none' } }, o)).rejects.toThrow(/none/);
  });

  it('HTML: ghi index.html và tài nguyên, không chép job.json/cancel', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'index.html'), '<div data-composition-id="m" data-duration="3"></div>');
    fs.writeFileSync(path.join(d.input, 'asset1.jpg'), 'z');
    fs.writeFileSync(path.join(d.input, 'job.json'), '{}');
    fs.writeFileSync(path.join(d.input, 'cancel'), 'j');
    const spec = { ...baseSpec, kind: 'html' as const, html: '', durationSec: 3, width: 1920, height: 1080 };
    const r = await buildWorkdir({ id: 'j2', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect([r.width, r.height]).toEqual([1920, 1080]);
    expect(fs.readdirSync(r.dir).sort()).toEqual(['asset1.jpg', 'index.html']);
  });

  it('HTML: tự thêm gsap.min.js đã ghim của mẫu (không có mạng để tải)', async () => {
    const d = dirs();
    const tplWithGsap = fs.mkdtempSync(path.join(root, 'tpl-'));
    fs.cpSync(templatesDir, tplWithGsap, { recursive: true });
    fs.writeFileSync(path.join(tplWithGsap, 'demo', 'gsap.min.js'), '/* gsap */');
    fs.writeFileSync(path.join(d.input, 'index.html'), '<div></div>');
    const spec = { ...baseSpec, kind: 'html' as const, html: '', durationSec: 3, width: 1080, height: 1080 };
    const r = await buildWorkdir({ id: 'j5', spec }, { templatesDir: tplWithGsap, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(fs.readdirSync(r.dir).sort()).toEqual(['gsap.min.js', 'index.html']);
    expect(fs.readFileSync(path.join(r.dir, 'gsap.min.js'), 'utf8')).toBe('/* gsap */');
  });

  maybe('mẫu có nhạc gửi kèm: tạo assets/music.m4a', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    fs.copyFileSync(audio, path.join(d.input, 'audio1.wav'));
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 'demo', aspect: '9:16' as const, variables: {}, images: ['img1.jpg'], musicId: null, musicFile: 'audio1.wav' };
    const r = await buildWorkdir({ id: 'j3', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(probeDur(path.join(r.dir, 'assets', 'music.m4a'))).toBeGreaterThan(5);
  });

  maybe('mẫu có nhạc có sẵn theo musicId', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    fs.copyFileSync(audio, path.join(d.music, 'calm.wav'));
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 'demo', aspect: '9:16' as const, variables: {}, images: ['img1.jpg'], musicId: 'calm', musicFile: null };
    const r = await buildWorkdir({ id: 'j4', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(fs.existsSync(path.join(r.dir, 'assets', 'music.m4a'))).toBe(true);
  });
});

describe('prepareMusic', () => {
  maybe('lặp nhạc ngắn cho đủ thời lượng, ra M4A', async () => {
    const out = path.join(root, 'loop.m4a');
    await prepareMusic(audio, 4, out);
    expect(probeDur(out)).toBeGreaterThan(3.7);
    expect(probeDur(out)).toBeLessThan(4.4);
  });
  maybe('cắt nhạc dài theo thời lượng', async () => {
    const out = path.join(root, 'cut.m4a');
    await prepareMusic(audio, 0.5, out);
    expect(probeDur(out)).toBeLessThan(0.8);
  });
  it('FFmpeg lỗi thì ném', async () => {
    await expect(prepareMusic(audio, 2, path.join(root, 'x.m4a'), '/nonexistent/ffmpeg')).rejects.toThrow();
  });
});

describe('runRender', () => {
  const base = (over: Record<string, unknown> = {}) => {
    const d = dirs();
    fs.writeFileSync(path.join(d.tmp, 'variables.json'), '{}');
    return {
      d,
      opts: { dir: d.tmp, outFile: path.join(d.tmp, 'o.mp4'), fps: 24, quality: 'high' as const, command: [process.execPath, FAKE], timeoutMs: 20000, killGraceMs: 300, env: { FAKE_VIDEO: video, FAKE_LOG: path.join(d.tmp, 'log.json') } as Record<string, string>, ...over },
    };
  };

  it('chạy đúng tham số, đọc @hf-progress, tắt telemetry', async () => {
    const { d, opts } = base();
    const seen: number[] = [];
    const r = await runRender({ ...opts, onProgress: (p) => seen.push(p) });
    expect(r).toEqual({ status: 'done' });
    expect(seen).toEqual([5, 50, 80, 99]);
    const log = JSON.parse(fs.readFileSync(path.join(d.tmp, 'log.json'), 'utf8'));
    expect(log.argv).toEqual(expect.arrayContaining(['render', d.tmp, '-o', opts.outFile, '--variables-file', path.join(d.tmp, 'variables.json'), '--fps', '24', '--quality', 'high', '--workers', '2']));
    expect(log.argv).not.toContain('--quiet');
    expect(log.env).toEqual({ t: '1', d: '1', s: '1' });
    expect(fs.existsSync(opts.outFile)).toBe(true);
  });

  it('CLI in ít dòng tiến độ: vẫn xong', async () => {
    const { opts } = base({ env: { FAKE_VIDEO: video, FAKE_MODE: 'silent' } });
    const seen: number[] = [];
    expect((await runRender({ ...opts, onProgress: (p) => seen.push(p) })).status).toBe('done');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('lỗi render -> failed kèm dòng lỗi cuối', async () => {
    const { opts } = base({ env: { FAKE_MODE: 'fail' } });
    const r = await runRender(opts);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('Boom');
  });

  it('lỗi render: báo dòng "Failed:" thật, không báo dòng gợi ý "Try --docker"', async () => {
    const { opts } = base({ env: { FAKE_MODE: 'fail-hint' } });
    const r = await runRender(opts);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Render thất bại (mã 1): Disk capture may need ~1990.7 MB of temporary frame storage, but only 2146.8 MB is free');
    expect(r.error).not.toContain('Try --docker');
  });

  it('quá hạn -> timeout, tiến trình bị dừng', async () => {
    const { opts } = base({ env: { FAKE_MODE: 'hang' }, timeoutMs: 400 });
    const t = Date.now();
    expect((await runRender(opts)).status).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('huỷ -> cancelled; tiến trình phớt lờ SIGTERM thì bị SIGKILL', async () => {
    const { opts } = base({ env: { FAKE_MODE: 'stubborn' } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const t = Date.now();
    expect((await runRender({ ...opts, signal: ac.signal })).status).toBe('cancelled');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('lệnh không tồn tại -> failed', async () => {
    const { opts } = base({ command: ['/nonexistent/hf'] });
    expect((await runRender(opts)).status).toBe('failed');
  });
});

describe('lintHtml', () => {
  const run = (env: Record<string, string>, command = [process.execPath, FAKE]) => lintHtml({ dir: root, command, env, timeoutMs: 10000 });
  it('có lỗi -> thông báo tiếng Việt kèm mã lỗi, bỏ cảnh báo', async () => {
    const msg = await run({ FAKE_LINT: 'errors' });
    expect(msg).toBe('HTML chưa đúng quy ước HyperFrames: root_missing_composition_id (Root composition is missing `data-composition-id`.); missing_timeline_registry (Missing `window.__timelines` registration.). Xem phần video HTML trong maihub_guide.');
  });
  it('không lỗi -> null', async () => { expect(await run({ FAKE_LINT: 'ok' })).toBeNull(); });
  it('đầu ra hỏng hoặc không chạy được lint -> null (không chặn render)', async () => {
    expect(await run({ FAKE_LINT: 'garbage' })).toBeNull();
    expect(await run({}, ['/nonexistent/hf'])).toBeNull();
  });
});

describe('finalizeVideo', () => {
  maybe('tạo thumb.jpg và đọc thời lượng', async () => {
    const d = dirs();
    const { durationMs } = await finalizeVideo({ videoFile: video, outDir: d.shared });
    expect(durationMs).toBeGreaterThan(1800);
    expect(durationMs).toBeLessThan(2300);
    expect(fs.readFileSync(path.join(d.shared, 'thumb.jpg')).subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(fs.readFileSync(path.join(d.shared, 'video.mp4')).length).toBe(fs.statSync(video).size);
    expect(fs.readdirSync(d.shared).sort()).toEqual(['thumb.jpg', 'video.mp4']); // không để tệp tạm
  });
});

describe('RenderWorker', () => {
  function setup(env: Record<string, string> = {}, over: Partial<WorkerConfig> = {}) {
    const d = dirs();
    const current = path.join(d.shared, 'current');
    const out = path.join(d.shared, 'out');
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(out, { recursive: true });
    const worker = new RenderWorker({
      sharedDir: d.shared, templatesDir: path.join(FIXTURES, 'tpl'), musicDir: d.music, tmpRoot: d.tmp,
      hyperframesCmd: [process.execPath, FAKE], pollMs: 50, cancelPollMs: 50, timeoutMs: 20000, killGraceMs: 300,
      env: { FAKE_VIDEO: video, ...env }, ...over,
    });
    const give = (id: string, spec?: unknown) => {
      fs.writeFileSync(path.join(current, 'img1.jpg'), 'x');
      const s = spec ?? { kind: 'template', templateId: 'demo', aspect: '9:16', width: 1080, height: 1920, fps: 24, quality: 'standard', variables: { title: 'T' }, images: ['img1.jpg'], musicId: null, musicFile: null };
      fs.writeFileSync(path.join(current, 'job.json'), JSON.stringify({ id, jobId: id, spec: s }));
    };
    const result = (id: string) => JSON.parse(fs.readFileSync(path.join(out, `${id}.result.json`), 'utf8'));
    return { d, current, out, worker, give, result };
  }

  maybe('việc thành công: video + thumb + progress, result.json ghi CUỐI, đúng jobId', async () => {
    const { out, worker, give, result, d } = setup();
    give('job-a');
    const placed: string[] = []; // thứ tự các tệp được đặt vào out/ (rename = lúc tệp xuất hiện)
    const real = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.dirname(String(to)) === out) placed.push(path.basename(String(to)));
      return real(from, to);
    });
    try { await worker.processOnce(); } finally { spy.mockRestore(); }
    const r = result('job-a');
    expect(r).toMatchObject({ jobId: 'job-a', ok: true });
    expect(r.durationMs).toBeGreaterThan(1800);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'job-a.progress.json'), 'utf8')).jobId).toBe('job-a');
    expect(fs.existsSync(path.join(out, 'job-a.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'job-a.jpg'))).toBe(true);
    expect(placed[placed.length - 1]).toBe('job-a.result.json');
    expect(placed).toEqual(expect.arrayContaining(['job-a.mp4', 'job-a.jpg', 'job-a.progress.json']));
    expect(fs.readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(fs.readdirSync(d.tmp)).toEqual([]); // đã dọn thư mục tạm
  });

  it('không xử lý lại việc đã xong (cùng jobId)', async () => {
    const { out, worker, give, result } = setup({ FAKE_MODE: 'fail' });
    give('job-b');
    await worker.processOnce();
    expect(result('job-b')).toMatchObject({ jobId: 'job-b', ok: false });
    fs.rmSync(path.join(out, 'job-b.result.json'));
    await worker.processOnce(); // job.json vẫn còn, api chưa dọn
    expect(fs.existsSync(path.join(out, 'job-b.result.json'))).toBe(false);
  });

  it('lỗi render -> result ok:false có thông báo, không có video', async () => {
    const { out, worker, give, result } = setup({ FAKE_MODE: 'fail' });
    give('job-c');
    await worker.processOnce();
    expect(result('job-c').ok).toBe(false);
    expect(result('job-c').error).toContain('Boom');
    expect(fs.existsSync(path.join(out, 'job-c.mp4'))).toBe(false);
  });

  it('HTML sai quy ước -> lỗi ngay từ lint, không render', async () => {
    const { out, worker, give, result } = setup({ FAKE_LINT: 'errors', FAKE_MODE: 'fail' });
    fs.writeFileSync(path.join(worker['current'], 'index.html'), '<div></div>');
    give('job-l', { kind: 'html', html: '', width: 1080, height: 1080, durationSec: 3, fps: 24, quality: 'standard' });
    await worker.processOnce();
    const r = result('job-l');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('root_missing_composition_id');
    expect(r.error).not.toContain('Boom'); // không chạy tới bước render
    expect(fs.existsSync(path.join(out, 'job-l.mp4'))).toBe(false);
  });

  it('HTML: lint không đọc được thì vẫn render (không chặn oan)', async () => {
    const { worker, give, result } = setup({ FAKE_LINT: 'garbage', FAKE_MODE: 'fail' });
    fs.writeFileSync(path.join(worker['current'], 'index.html'), '<div></div>');
    give('job-m', { kind: 'html', html: '', width: 1080, height: 1080, durationSec: 3, fps: 24, quality: 'standard' });
    await worker.processOnce();
    expect(result('job-m').error).toContain('Boom');
  });

  it('mẫu có sẵn không chạy lint', async () => {
    const { worker, give, result } = setup({ FAKE_LINT: 'errors', FAKE_MODE: 'fail' });
    give('job-n');
    await worker.processOnce();
    expect(result('job-n').error).toContain('Boom');
  });

  it('quá hạn -> error timeout', async () => {
    const { worker, give, result } = setup({ FAKE_MODE: 'hang' }, { timeoutMs: 300 });
    give('job-d');
    await worker.processOnce();
    expect(result('job-d')).toMatchObject({ jobId: 'job-d', ok: false, error: 'timeout' });
  });

  it('cancel giữa chừng -> result cancelled, không để video', async () => {
    const { current, out, worker, give, result } = setup({ FAKE_MODE: 'hang' });
    give('job-e');
    setTimeout(() => fs.writeFileSync(path.join(current, 'cancel'), 'job-e'), 400);
    await worker.processOnce();
    expect(result('job-e')).toMatchObject({ jobId: 'job-e', ok: false, error: 'cancelled' });
    expect(fs.existsSync(path.join(out, 'job-e.mp4'))).toBe(false);
  });

  it('cancel có sẵn trước khi bắt đầu -> cancelled ngay, không chạy CLI', async () => {
    const { current, worker, give, result, d } = setup({ FAKE_LOG: '' });
    const log = path.join(d.tmp, 'ran.json');
    (worker as any).cfg.env.FAKE_LOG = log;
    give('job-f');
    fs.writeFileSync(path.join(current, 'cancel'), 'job-f');
    await worker.processOnce();
    expect(result('job-f')).toMatchObject({ jobId: 'job-f', ok: false, error: 'cancelled' });
    expect(fs.existsSync(log)).toBe(false);
  });

  it('cancel cũ của việc khác không huỷ việc mới', async () => {
    const { current, worker, give, result } = setup({ FAKE_MODE: 'fail' });
    give('job-g');
    fs.writeFileSync(path.join(current, 'cancel'), 'older-job');
    await worker.processOnce();
    expect(result('job-g').error).toContain('Boom'); // đã chạy, không bị coi là huỷ
  });

  it('spec lỗi (mẫu không có) -> result ok:false', async () => {
    const { worker, give, result } = setup();
    give('job-h', { kind: 'template', templateId: 'none', aspect: '9:16', width: 1, height: 1, fps: 24, quality: 'standard', variables: {}, images: [], musicId: null, musicFile: null });
    await worker.processOnce();
    expect(result('job-h')).toMatchObject({ jobId: 'job-h', ok: false });
  });

  it('job.json hỏng hoặc không có jobId thì bỏ qua', async () => {
    const { current, out, worker } = setup();
    fs.writeFileSync(path.join(current, 'job.json'), '{oops');
    await worker.processOnce();
    fs.writeFileSync(path.join(current, 'job.json'), '{"spec":{}}');
    await worker.processOnce();
    expect(fs.readdirSync(out)).toEqual([]);
  });

  maybe('việc mới sau việc cũ: xoá tệp cũ trong out/ và render đúng jobId mới', async () => {
    const { out, worker, give, result } = setup();
    give('job-1');
    await worker.processOnce();
    give('job-2'); // api đã dọn out/ thật ra; ở đây cố ý để tệp cũ
    fs.writeFileSync(path.join(out, 'job-1.progress.json'), JSON.stringify({ jobId: 'job-1', percent: 50 }));
    await worker.processOnce();
    expect(result('job-2').jobId).toBe('job-2');
    expect(fs.existsSync(path.join(out, 'job-1.progress.json'))).toBe(false);
  });

  it('job.json bị xoá giữa chừng -> dừng render, không ghi kết quả thành công', async () => {
    const { current, out, worker, give } = setup({ FAKE_MODE: 'hang' });
    give('job-i');
    setTimeout(() => fs.rmSync(path.join(current, 'job.json')), 400);
    const t = Date.now();
    await worker.processOnce();
    expect(Date.now() - t).toBeLessThan(5000); // không chờ hết timeout 20 giây
    const files = fs.readdirSync(out);
    expect(files.filter((f) => /\.(mp4|jpg)$/.test(f))).toEqual([]);
    const r = path.join(out, 'job-i.result.json');
    if (fs.existsSync(r)) expect(JSON.parse(fs.readFileSync(r, 'utf8'))).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('job.json đổi sang jobId khác -> dừng; việc mới được xử lý sau đó', async () => {
    const { current, out, worker, give, result } = setup({ FAKE_MODE: 'hang' });
    give('job-j');
    setTimeout(() => give('job-k'), 400);
    await worker.processOnce();
    expect(fs.existsSync(path.join(out, 'job-j.mp4'))).toBe(false);
    if (fs.existsSync(path.join(out, 'job-j.result.json'))) expect(result('job-j').ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(current, 'job.json'), 'utf8')).jobId).toBe('job-k');
    expect(fs.existsSync(path.join(out, 'job-k.result.json'))).toBe(false); // chưa xử lý, chờ vòng sau
  });
});

describe('buildWorkdir: dấu {{...}} trong index.html của mẫu', () => {
  const baseSpec = { fps: 30, quality: 'standard' as const };
  function tplDir(id: string, def: Record<string, unknown>) {
    const dir = path.join(root, `tok-${id}`);
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'template.json'), JSON.stringify({ id, ...def }));
    fs.writeFileSync(path.join(dir, id, 'index.html'),
      '<div data-duration="{{durationSec}}" data-width="{{width}}" data-height="{{height}}">{{audio}}</div>');
    return dir;
  }
  const baseDef = { name: 'T', description: 'd', aspects: ['16:9'], imageSlots: { min: 1, max: 8 }, variables: {} };

  it('điền khổ, thời lượng; không có nhạc thì bỏ thẻ audio', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    const templatesDir = tplDir('t1', { ...baseDef, durationSec: { min: 5, max: 30, default: 12 } });
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 't1', aspect: '16:9' as const, width: 1920, height: 1080, variables: {}, images: ['img1.jpg'], musicId: null, musicFile: null };
    const r = await buildWorkdir({ id: 'k1', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8')).toBe('<div data-duration="12" data-width="1920" data-height="1080"></div>');
  });

  it('secondsPerImage: thời lượng = số ảnh × giây, kẹp trong khoảng của mẫu', async () => {
    const d = dirs();
    for (const n of ['img1.jpg', 'img2.jpg', 'img3.jpg']) fs.writeFileSync(path.join(d.input, n), 'a');
    const templatesDir = tplDir('t2', { ...baseDef, durationSec: { min: 15, max: 48, default: 30 }, secondsPerImage: 6 });
    const mk = (images: string[]) => ({ ...baseSpec, kind: 'template' as const, templateId: 't2', aspect: '16:9' as const, width: 1920, height: 1080, variables: {}, images, musicId: null, musicFile: null });
    const r = await buildWorkdir({ id: 'k2', spec: mk(['img1.jpg', 'img2.jpg', 'img3.jpg']) }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'variables.json'), 'utf8')).durationSec).toBe(18);
    const r2 = await buildWorkdir({ id: 'k3', spec: mk(['img1.jpg']) }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(JSON.parse(fs.readFileSync(path.join(r2.dir, 'variables.json'), 'utf8')).durationSec).toBe(15); // kẹp ở min
  });

  it('biến durationSec của người dùng bị kẹp trong khoảng của mẫu', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    const templatesDir = tplDir('t3', { ...baseDef, durationSec: { min: 15, max: 30, default: 20 } });
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 't3', aspect: '16:9' as const, width: 1920, height: 1080, variables: { durationSec: 9999 }, images: ['img1.jpg'], musicId: null, musicFile: null };
    const r = await buildWorkdir({ id: 'k4', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    expect(fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8')).toContain('data-duration="30"');
  });

  maybe('có nhạc thì chèn thẻ audio trỏ assets/music.m4a theo thời lượng', async () => {
    const d = dirs();
    fs.writeFileSync(path.join(d.input, 'img1.jpg'), 'a');
    fs.copyFileSync(audio, path.join(d.input, 'audio1.wav'));
    const templatesDir = tplDir('t4', { ...baseDef, durationSec: { min: 5, max: 30, default: 12 } });
    const spec = { ...baseSpec, kind: 'template' as const, templateId: 't4', aspect: '16:9' as const, width: 1920, height: 1080, variables: {}, images: ['img1.jpg'], musicId: null, musicFile: 'audio1.wav' };
    const r = await buildWorkdir({ id: 'k5', spec }, { templatesDir, musicDir: d.music, inputDir: d.input, tmpDir: d.tmp });
    const html = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf8');
    expect(html).toContain('<audio id="bgm" src="assets/music.m4a" data-start="0" data-duration="12" data-track-index="9"></audio>');
    expect(fs.existsSync(path.join(r.dir, 'assets', 'music.m4a'))).toBe(true);
  });
});
