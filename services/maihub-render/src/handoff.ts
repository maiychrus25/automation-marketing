import * as fs from 'fs';
import * as path from 'path';
import { LIMITS } from './limits';

/**
 * Hợp đồng api <-> worker (thư mục dùng chung):
 * - api giao việc bằng `current/job.json` (mang `jobId`), ghi CUỐI CÙNG.
 * - Mọi đầu ra của worker nằm trong `out/` và mang tên theo jobId: `<jobId>.mp4`, `<jobId>.jpg`
 *   (tệp tạm + rename), `<jobId>.progress.json` (`{ jobId, percent }`) và `<jobId>.result.json`
 *   (`{ jobId, ok, error?, durationMs? }`) được ghi SAU CÙNG. Tệp nào không mang jobId hiện tại
 *   đều là tệp cũ: bị xoá, không bao giờ được giao.
 * - Huỷ = `job.json` không còn nêu việc của worker: worker đọc lại `current/job.json` mỗi giây khi render;
 *   nếu mất, đổi jobId, hoặc `current/cancel` chứa jobId của nó thì dừng render và không ghi kết quả thành công
 *   (có thể ghi result `cancelled` cho jobId của chính nó, api bỏ qua nếu việc đó không còn hiện hành).
 *   Vì vậy api bỏ việc / huỷ / khởi động lại chỉ cần dọn `current/`.
 * - Worker không làm lại jobId đã xử lý.
 */
export interface HandoffResult { jobId?: string; ok: boolean; error?: string; durationMs?: number }
export interface HandoffPoll {
  state: 'idle' | 'running' | 'done';
  progress?: number; // 0–1
  result?: HandoffResult;
}

const SILENT_MS = 60 * 1000;

/** Giao việc cho worker qua thư mục dùng chung: `current/` (api ghi) và `out/` (worker ghi). */
export class Handoff {
  private readonly current: string;
  private readonly out: string;
  private startedAt: number | undefined;

  constructor(sharedDir: string, private readonly now: () => number = Date.now) {
    this.current = path.join(sharedDir, 'current');
    this.out = path.join(sharedDir, 'out');
    fs.mkdirSync(this.current, { recursive: true });
    fs.mkdirSync(this.out, { recursive: true });
  }

  /** Dọn sạch, chép tệp, và ghi `job.json` CUỐI CÙNG (tệp tạm + rename) để worker không thấy việc dở dang. */
  start(job: { id: string; [k: string]: unknown }, inputDir: string, workdirFiles: Record<string, string | Buffer> = {}): void {
    this.clean();
    for (const name of fs.readdirSync(inputDir)) {
      if (name === 'job.json' || name === 'cancel') continue; // tên dành riêng cho hợp đồng
      fs.copyFileSync(path.join(inputDir, name), path.join(this.current, name));
    }
    for (const [name, data] of Object.entries(workdirFiles)) {
      fs.writeFileSync(path.join(this.current, path.basename(name)), data);
    }
    const tmp = path.join(this.current, '.job.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ ...job, jobId: job.id }));
    this.startedAt = this.now();
    fs.renameSync(tmp, path.join(this.current, 'job.json'));
  }

  poll(): HandoffPoll {
    const jobId = this.currentJobId();
    if (!jobId) return { state: 'idle' };
    this.sweepStale(jobId);
    const result = this.readScoped<HandoffResult>('result.json', jobId);
    if (result) return { state: 'done', result };
    this.startedAt ??= this.now(); // api vừa khởi động lại: tính từ lần poll đầu
    const elapsed = this.now() - this.startedAt;
    const progress = this.readScoped<{ jobId?: string; percent: number }>('progress.json', jobId);
    if (elapsed > LIMITS.renderTimeoutMs) return this.abandon('timeout');
    if (!progress && elapsed > SILENT_MS) return this.abandon('Máy render không phản hồi');
    return { state: 'running', progress: progress ? Math.min(1, Math.max(0, progress.percent / 100)) : 0 };
  }

  cancel(): void {
    fs.writeFileSync(path.join(this.current, 'cancel'), this.currentJobId() ?? '');
  }

  /** Chuyển kết quả sang `destDir` rồi dọn sạch `current/` và `out/`. Chỉ nhận tệp mang jobId hiện tại. */
  collect(destDir: string): string[] {
    fs.mkdirSync(destDir, { recursive: true });
    const moved: string[] = [];
    const jobId = this.currentJobId();
    const result = jobId ? this.readScoped<HandoffResult>('result.json', jobId) : undefined;
    if (jobId && result) {
      for (const [ext, name] of [['mp4', 'video.mp4'], ['jpg', 'thumb.jpg']]) {
        const src = path.join(this.out, `${jobId}.${ext}`);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(destDir, name)); // volume khác nhau: không dùng rename
        moved.push(name);
      }
    }
    this.clean();
    return moved;
  }

  clean(): void {
    for (const dir of [this.current, this.out]) {
      fs.mkdirSync(dir, { recursive: true });
      for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    this.startedAt = undefined;
  }

  /** Bỏ việc: dọn `current/` (job.json mất = tín hiệu dừng cho worker) và `out/`. */
  private abandon(error: string): HandoffPoll {
    this.clean();
    return { state: 'done', result: { ok: false, error } };
  }

  private currentJobId(): string | undefined {
    try {
      const id = JSON.parse(fs.readFileSync(path.join(this.current, 'job.json'), 'utf8')).jobId;
      return typeof id === 'string' ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /** Đọc `out/<jobId>.<name>`; chỉ nhận khi jobId bên trong cũng khớp. */
  private readScoped<T extends { jobId?: string }>(name: string, jobId: string): T | undefined {
    const file = path.join(this.out, `${jobId}.${name}`);
    let parsed: T;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return undefined; // chưa có hoặc đang ghi dở
    }
    if (parsed?.jobId === jobId) return parsed;
    fs.rmSync(file, { force: true });
    return undefined;
  }

  /** Xoá mọi thứ trong `out/` không mang jobId hiện tại (worker bị bỏ ghi muộn, tệp cũ). */
  private sweepStale(jobId: string): void {
    for (const name of fs.readdirSync(this.out)) {
      if (name.startsWith(`${jobId}.`) || name.startsWith(`.${jobId}.`)) continue;
      fs.rmSync(path.join(this.out, name), { recursive: true, force: true });
    }
  }
}
