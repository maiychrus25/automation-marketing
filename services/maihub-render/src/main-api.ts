import * as fs from 'fs';
import * as path from 'path';
import { Handoff } from './handoff';
import { JobStore } from './jobStore';
import { parseKeys } from './keys';
import { Queue } from './queue';
import { Retention } from './retention';
import { MusicInfo } from './routes';
import { createServer } from './server';

const POLL_MS = 1000;
const RETENTION_MS = 60 * 60 * 1000;

export interface Timers {
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
}

export interface OrchestratorDeps {
  store: JobStore;
  queue: Queue;
  handoff: Handoff;
  retention: Retention;
  now?: () => number;
  timers?: Timers;
}

/** Vòng điều phối: hàng đợi -> Handoff (worker) -> cập nhật JobStore; dọn việc cũ mỗi giờ. */
export class Orchestrator {
  private currentId: string | undefined;
  private cancelRequested = false;
  private handles: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) };
  }

  /** Khi khởi động: việc đang `rendering` thành `failed`, dựng lại hàng đợi, dọn thư mục giao việc. */
  init(): void {
    this.deps.queue.restore(this.deps.store.load());
    this.deps.handoff.clean();
  }

  start(): void {
    this.handles = [
      this.timers.setInterval(() => this.safely('vòng điều phối', () => this.tick()), POLL_MS),
      this.timers.setInterval(() => this.safely('dọn việc cũ', () => this.deps.retention.purge()), RETENTION_MS),
    ];
  }

  stop(): void {
    for (const h of this.handles) this.timers.clearInterval(h);
    this.handles = [];
  }

  /** Báo worker dừng việc đang chạy; kết quả cuối vẫn là `cancelled` dù worker kịp xong. */
  requestCancel(id: string): void {
    if (this.currentId !== id) return;
    this.cancelRequested = true;
    this.deps.handoff.cancel();
  }

  tick(): void {
    if (this.currentId) this.pollCurrent(this.currentId);
    if (!this.currentId) this.startNext();
  }

  private safely(label: string, fn: () => unknown): void {
    try { fn(); } catch (e) { console.error(`[render] Lỗi ${label}:`, (e as Error).message); }
  }

  private startNext(): void {
    const { store, queue, handoff } = this.deps;
    const job = queue.next();
    if (!job) return;
    this.currentId = job.id;
    this.cancelRequested = false;
    try {
      const spec = job.spec;
      const payload = spec.kind === 'html' ? { id: job.id, spec: { ...spec, html: undefined } } : { id: job.id, spec };
      handoff.start(payload, path.join(store.jobDir(job.id), 'input'), spec.kind === 'html' ? { 'index.html': spec.html } : {});
    } catch (e) {
      console.error('[render] Không giao được việc cho worker:', (e as Error).message);
      this.settle(job.id, { status: 'failed', error: 'Không giao được việc cho máy render' });
    }
  }

  private pollCurrent(id: string): void {
    const { store, handoff } = this.deps;
    const poll = handoff.poll();
    if (poll.state === 'idle') return this.settle(id, { status: 'failed', error: 'Mất việc đang giao cho máy render' });
    if (poll.state === 'running') {
      const progress = poll.progress ?? 0;
      if (store.get(id)?.progress !== progress) store.update(id, { progress });
      return;
    }
    const result = poll.result!;
    if (this.cancelRequested) {
      handoff.clean();
      return this.settle(id, { status: 'cancelled' });
    }
    if (!result.ok) {
      handoff.clean();
      return this.settle(id, { status: 'failed', error: result.error ?? 'Render thất bại' });
    }
    const outDir = path.join(store.jobDir(id), 'output');
    const moved = handoff.collect(outDir);
    if (!moved.includes('video.mp4')) return this.settle(id, { status: 'failed', error: 'Máy render không trả về video' });
    const job = store.get(id);
    const durationSec = result.durationMs !== undefined ? result.durationMs / 1000
      : job?.spec.kind === 'html' ? job.spec.durationSec : undefined;
    this.settle(id, { status: 'done', progress: 1, sizeBytes: fs.statSync(path.join(outDir, 'video.mp4')).size, ...(durationSec !== undefined && { durationSec }) });
  }

  private settle(id: string, patch: Parameters<JobStore['update']>[1]): void {
    try {
      this.deps.store.update(id, { ...patch, finishedAt: this.now() });
    } finally {
      this.deps.queue.finish(id);
      this.currentId = undefined;
      this.cancelRequested = false;
    }
  }
}

/** Đọc `.env` dạng KEY=VALUE (không ghi đè biến môi trường đã có). */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function main(): void {
  loadDotEnv(path.resolve('.env'));
  const env = process.env;
  const keys = parseKeys(env.RENDER_API_KEYS ?? '');
  const dataDir = env.DATA_DIR ?? path.resolve('data');
  const sharedDir = env.SHARED_DIR ?? path.resolve('shared');
  const port = Number(env.PORT ?? 8080);
  const templatesDir = env.TEMPLATES_DIR ?? path.resolve('templates');
  const musicFile = path.join(env.MUSIC_DIR ?? path.resolve('music'), 'music.json');
  const music: MusicInfo[] = fs.existsSync(musicFile) ? JSON.parse(fs.readFileSync(musicFile, 'utf8')) : [];
  const version = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;

  const store = new JobStore(dataDir);
  const queue = new Queue(store);
  const orchestrator = new Orchestrator({ store, queue, handoff: new Handoff(sharedDir), retention: new Retention(store) });
  orchestrator.init();
  orchestrator.start();
  createServer({
    keys, store, queue, orchestrator, templatesDir, music, version, hyperframes: env.HYPERFRAMES_VERSION ?? '0.8.181',
  }).listen(port, () => console.log(`[render] API đang chạy ở cổng ${port}`));
}

if (require.main === module) main();
