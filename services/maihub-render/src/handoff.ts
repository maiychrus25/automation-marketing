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
const MAX_JSON_BYTES = 64 * 1024;
const MAX_THUMB_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

/** `out/` do worker ghi nên không đáng tin: liên kết tượng trưng, tệp đặc biệt hoặc tệp quá lớn đều bị từ chối. */
class UnsafeOutputError extends Error {}

/** Mở tệp thường bằng O_NOFOLLOW (không theo liên kết) và kiểm kích thước trên chính fd đã mở. */
function openRegular(file: string, maxBytes: number): { fd: number; size: number } {
  const lst = fs.lstatSync(file);
  if (!lst.isFile()) throw new UnsafeOutputError(`${path.basename(file)} không phải tệp thường`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) throw new UnsafeOutputError(`${path.basename(file)} không hợp lệ`);
    return { fd, size: st.size };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/** Chép từ `src` (không theo liên kết) sang `dest` qua fd, tối đa `maxBytes`. */
function copyRegular(src: string, dest: string, maxBytes: number): void {
  const { fd, size } = openRegular(src, maxBytes);
  try {
    const out = fs.openSync(dest, 'w');
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let left = size;
      while (left > 0) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), null);
        if (n === 0) break;
        fs.writeSync(out, buf, 0, n);
        left -= n;
      }
    } finally {
      fs.closeSync(out);
    }
  } finally {
    fs.closeSync(fd);
  }
}

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
    let result: HandoffResult | undefined;
    let progress: { jobId?: string; percent: number } | undefined;
    try {
      result = this.readScoped<HandoffResult>('result.json', jobId);
      if (result) return { state: 'done', result };
      progress = this.readScoped<{ jobId?: string; percent: number }>('progress.json', jobId);
    } catch (e) {
      if (e instanceof UnsafeOutputError) return this.abandon('Máy render trả về tệp không hợp lệ');
      throw e;
    }
    this.startedAt ??= this.now(); // api vừa khởi động lại: tính từ lần poll đầu
    const elapsed = this.now() - this.startedAt;
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
    try {
      const result = jobId ? this.readScoped<HandoffResult>('result.json', jobId) : undefined;
      if (jobId && result) {
        for (const [ext, name, cap] of [['mp4', 'video.mp4', MAX_VIDEO_BYTES], ['jpg', 'thumb.jpg', MAX_THUMB_BYTES]] as const) {
          const src = path.join(this.out, `${jobId}.${ext}`);
          try {
            copyRegular(src, path.join(destDir, name), cap); // volume khác nhau: không dùng rename
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw e instanceof UnsafeOutputError ? e : new UnsafeOutputError(`${name}: ${(e as Error).message}`);
          }
          moved.push(name);
        }
      }
    } catch (e) {
      for (const name of moved) fs.rmSync(path.join(destDir, name), { force: true });
      this.clean();
      if (e instanceof UnsafeOutputError) throw new Error('Máy render trả về tệp không hợp lệ');
      throw e;
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
    let text: string;
    try {
      const { fd } = openRegular(file, MAX_JSON_BYTES);
      try { text = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    } catch (e) {
      if (e instanceof UnsafeOutputError) throw e;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; // chưa có
      if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new UnsafeOutputError(`${name} là liên kết`);
      return undefined;
    }
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      return undefined; // đang ghi dở
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
