import fs from 'fs';
import path from 'path';
import { buildWorkdir } from './buildWorkdir';
import { LIMITS } from './limits';
import { finalizeVideo, runRender } from './renderRunner';
import { NormalizedSpec } from './spec';

export interface WorkerConfig {
  sharedDir: string;
  templatesDir: string;
  musicDir: string;
  tmpRoot: string;
  hyperframesCmd: string[];
  ffmpegPath?: string;
  ffprobePath?: string;
  pollMs?: number;
  cancelPollMs?: number;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: Record<string, string>;
}

interface JobFile { jobId: string; spec: NormalizedSpec }

/**
 * Worker: đọc /shared/current/job.json, render, ghi out/<jobId>.{mp4,jpg,progress.json,result.json} (result cuối cùng).
 * Hợp đồng ở handoff.ts: đầu ra mang tên theo jobId; job.json mất hoặc đổi jobId (hoặc current/cancel chứa jobId)
 * thì dừng render và không ghi kết quả thành công; việc đã xử lý không làm lại.
 */
export class RenderWorker {
  private readonly current: string;
  private readonly out: string;
  private readonly finished = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly cfg: WorkerConfig) {
    this.current = path.join(cfg.sharedDir, 'current');
    this.out = path.join(cfg.sharedDir, 'out');
  }

  start(): void {
    const tick = () => {
      this.processOnce()
        .catch((e) => console.error('[worker] Lỗi vòng lặp:', (e as Error).message))
        .finally(() => { if (this.timer) this.timer = setTimeout(tick, this.cfg.pollMs ?? 1000); });
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Xử lý tối đa một việc mới (nếu có). */
  async processOnce(): Promise<void> {
    if (this.running) return;
    const job = this.readJob();
    if (!job || this.finished.has(job.jobId)) return;
    this.running = true;
    try {
      await this.runJob(job);
    } finally {
      this.finished.add(job.jobId);
      this.running = false;
    }
  }

  private readJob(): JobFile | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.current, 'job.json'), 'utf8'));
      return typeof data?.jobId === 'string' && data.jobId && data.spec ? data : undefined;
    } catch {
      return undefined; // chưa có hoặc hỏng
    }
  }

  /** Việc không còn hiện hành: job.json mất / đổi jobId, hoặc current/cancel chứa jobId. */
  private isCancelled(jobId: string): boolean {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.current, 'job.json'), 'utf8'));
      if (data?.jobId !== jobId) return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      // job.json ghi dở / hỏng thoáng qua: coi là chưa đổi
    }
    try {
      return fs.readFileSync(path.join(this.current, 'cancel'), 'utf8').trim() === jobId; // cancel của việc khác là tệp cũ
    } catch {
      return false;
    }
  }

  private writeJson(jobId: string, name: string, data: unknown): void {
    fs.mkdirSync(this.out, { recursive: true });
    const tmp = path.join(this.out, `.${jobId}.${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, path.join(this.out, `${jobId}.${name}`));
  }

  private discardOutputs(jobId: string): void {
    for (const ext of ['mp4', 'jpg']) fs.rmSync(path.join(this.out, `${jobId}.${ext}`), { force: true });
  }

  private async runJob(job: JobFile): Promise<void> {
    const { jobId } = job;
    fs.mkdirSync(this.out, { recursive: true });
    for (const f of fs.readdirSync(this.out)) fs.rmSync(path.join(this.out, f), { recursive: true, force: true }); // tệp cũ của việc khác
    const fail = (error: string) => this.writeJson(jobId, 'result.json', { jobId, ok: false, error });
    if (this.isCancelled(jobId)) return fail('cancelled');

    this.writeJson(jobId, 'progress.json', { jobId, percent: 0 });
    fs.mkdirSync(this.cfg.tmpRoot, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(this.cfg.tmpRoot, 'job-'));
    const ac = new AbortController();
    const watcher = setInterval(() => { if (this.isCancelled(jobId)) ac.abort(); }, this.cfg.cancelPollMs ?? 500);
    try {
      const work = await buildWorkdir({ id: jobId, spec: job.spec }, {
        templatesDir: this.cfg.templatesDir, musicDir: this.cfg.musicDir, inputDir: this.current, tmpDir: tmp, ffmpegPath: this.cfg.ffmpegPath,
      });
      if (ac.signal.aborted) return fail('cancelled');
      const outFile = path.join(tmp, 'render.mp4');
      let last = 0;
      const outcome = await runRender({
        dir: work.dir, outFile, fps: job.spec.fps, quality: job.spec.quality, command: this.cfg.hyperframesCmd,
        timeoutMs: this.cfg.timeoutMs ?? LIMITS.renderTimeoutMs, killGraceMs: this.cfg.killGraceMs, signal: ac.signal, env: this.cfg.env,
        onProgress: (pct) => {
          const percent = Math.min(99, Math.floor(pct));
          if (percent > last) { last = percent; this.writeJson(jobId, 'progress.json', { jobId, percent }); }
        },
      });
      if (outcome.status === 'cancelled') return fail('cancelled');
      if (outcome.status !== 'done') return fail(outcome.error ?? 'Render thất bại');
      if (ac.signal.aborted) return fail('cancelled');
      const { durationMs } = await finalizeVideo({
        videoFile: outFile, outDir: this.out, videoName: `${jobId}.mp4`, thumbName: `${jobId}.jpg`,
        ffmpegPath: this.cfg.ffmpegPath, ffprobePath: this.cfg.ffprobePath,
      });
      if (this.isCancelled(jobId)) return this.discardOutputs(jobId); // đã bị bỏ: không báo thành công
      this.writeJson(jobId, 'result.json', { jobId, ok: true, durationMs }); // CUỐI CÙNG
    } catch (e) {
      this.discardOutputs(jobId);
      fail(`Render thất bại: ${(e as Error).message}`.slice(0, 300));
    } finally {
      clearInterval(watcher);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
