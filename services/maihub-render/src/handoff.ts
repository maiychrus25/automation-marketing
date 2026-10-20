import * as fs from 'fs';
import * as path from 'path';
import { LIMITS } from './limits';

/**
 * Hợp đồng worker (Task 4): job.json mang `jobId`; worker PHẢI ghi lại đúng `jobId` đó trong
 * out/progress.json (`{ jobId, percent }`) và out/result.json (`{ jobId, ok, error?, durationMs? }`).
 * Tệp nào có jobId khác (hoặc thiếu) bị coi là cũ: bỏ qua và xoá.
 * Khi api bỏ việc (im lặng / quá hạn) hoặc huỷ, api ghi `current/cancel` (nội dung là jobId).
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

  /** Chuyển kết quả sang `destDir` rồi dọn sạch `current/` và `out/`. Trả về các tệp đã chuyển. */
  collect(destDir: string): string[] {
    fs.mkdirSync(destDir, { recursive: true });
    const moved: string[] = [];
    const jobId = this.currentJobId();
    const result = jobId ? this.readScoped<HandoffResult>('result.json', jobId) : undefined;
    for (const name of ['video.mp4', 'thumb.jpg']) {
      const src = path.join(this.out, name);
      if (!result || !fs.existsSync(src)) continue; // chưa có kết quả đúng việc -> không nhận tệp
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
    const jobId = this.currentJobId() ?? '';
    this.clean();
    // báo worker dừng; tệp cancel được start() của việc sau xoá trước khi giao job.json mới
    fs.writeFileSync(path.join(this.current, 'cancel'), jobId);
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

  /** Đọc tệp của worker; chỉ nhận khi jobId khớp, tệp của việc khác bị xoá. */
  private readScoped<T extends { jobId?: string }>(name: string, jobId: string): T | undefined {
    const file = path.join(this.out, name);
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
}
