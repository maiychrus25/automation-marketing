import * as fs from 'fs';
import * as path from 'path';
import { LIMITS } from './limits';

export interface HandoffResult { ok: boolean; error?: string; durationMs?: number }
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
      fs.copyFileSync(path.join(inputDir, name), path.join(this.current, name));
    }
    for (const [name, data] of Object.entries(workdirFiles)) {
      fs.writeFileSync(path.join(this.current, path.basename(name)), data);
    }
    const tmp = path.join(this.current, '.job.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(job));
    this.startedAt = this.now();
    fs.renameSync(tmp, path.join(this.current, 'job.json'));
  }

  poll(): HandoffPoll {
    if (!fs.existsSync(path.join(this.current, 'job.json'))) return { state: 'idle' };
    const result = this.readJson<HandoffResult>('result.json');
    if (result) return { state: 'done', result };
    this.startedAt ??= this.now(); // api vừa khởi động lại: tính từ lần poll đầu
    const elapsed = this.now() - this.startedAt;
    const progress = this.readJson<{ percent: number }>('progress.json');
    if (elapsed > LIMITS.renderTimeoutMs) return this.abandon('timeout');
    if (!progress && elapsed > SILENT_MS) return this.abandon('Máy render không phản hồi');
    return { state: 'running', progress: progress ? Math.min(1, Math.max(0, progress.percent / 100)) : 0 };
  }

  cancel(): void {
    fs.writeFileSync(path.join(this.current, 'cancel'), '');
  }

  /** Chuyển kết quả sang `destDir` rồi dọn sạch `current/` và `out/`. Trả về các tệp đã chuyển. */
  collect(destDir: string): string[] {
    fs.mkdirSync(destDir, { recursive: true });
    const moved: string[] = [];
    for (const name of ['video.mp4', 'thumb.jpg']) {
      const src = path.join(this.out, name);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(destDir, name)); // volume khác nhau: không dùng rename
      moved.push(name);
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

  private abandon(error: string): HandoffPoll {
    this.clean();
    return { state: 'done', result: { ok: false, error } };
  }

  private readJson<T>(name: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.out, name), 'utf8')) as T;
    } catch {
      return undefined; // chưa có hoặc đang ghi dở
    }
  }
}
