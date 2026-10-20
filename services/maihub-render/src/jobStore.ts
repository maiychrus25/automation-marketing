import * as fs from 'fs';
import * as path from 'path';
import { NormalizedSpec } from './spec';

export type JobStatus = 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  owner: string;
  status: JobStatus;
  progress: number; // 0–1
  position?: number;
  error?: string;
  spec: NormalizedSpec;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationSec?: number;
  sizeBytes?: number;
}

// Mã việc luôn do máy chủ sinh bằng crypto.randomUUID(); kiểm chặt trước khi ghép đường dẫn.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const RESTART_ERROR = 'Máy chủ khởi động lại khi đang render';

/** Kho việc: mỗi việc là `<dataDir>/jobs/<id>/job.json` kèm `input/` và `output/`. */
export class JobStore {
  private readonly jobsDir: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
  }

  /** Thư mục chứa mọi việc (để đo dung lượng trống). */
  rootDir(): string {
    return this.jobsDir;
  }

  /** Ném lỗi nếu id có thể thoát khỏi thư mục kho (ví dụ `../x`). */
  jobDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Mã việc không hợp lệ');
    return path.join(this.jobsDir, id);
  }

  create(job: Job): void {
    const dir = this.jobDir(job.id);
    fs.mkdirSync(path.join(dir, 'input'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
    this.write(job);
  }

  /** Việc hỏng (job.json không đọc được) trả về dạng `failed` không thuộc khoá nào để retention còn dọn được. */
  get(id: string): Job | undefined {
    const raw = this.read(id);
    if (raw !== 'corrupt') return raw;
    let finishedAt = 0;
    try { finishedAt = fs.statSync(path.join(this.jobDir(id), 'job.json')).mtimeMs; } catch { /* giữ 0 */ }
    return { id, owner: '', status: 'failed', progress: 0, error: 'Dữ liệu việc bị hỏng', spec: undefined as unknown as NormalizedSpec, createdAt: finishedAt, finishedAt };
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = this.read(id);
    if (!job || job === 'corrupt') throw new Error('Không tìm thấy việc');
    const next = { ...job, ...patch };
    this.write(next);
    return next;
  }

  list(): Job[] {
    return fs.readdirSync(this.jobsDir).map((id) => this.get(id)).filter((j): j is Job => !!j);
  }

  remove(id: string): void {
    fs.rmSync(this.jobDir(id), { recursive: true, force: true });
  }

  /** Nạp lại khi khởi động: việc đang `rendering` chuyển thành `failed`. */
  load(): Job[] {
    for (const job of this.list()) {
      if (job.status === 'rendering') {
        this.update(job.id, { status: 'failed', error: RESTART_ERROR, finishedAt: this.now() });
      }
    }
    return this.list();
  }

  private read(id: string): Job | 'corrupt' | undefined {
    if (!ID_RE.test(id)) return undefined;
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.jobDir(id), 'job.json'), 'utf8');
    } catch {
      return undefined; // chưa có
    }
    try {
      return JSON.parse(text) as Job;
    } catch {
      console.warn(`[render] job.json của việc ${id} bị hỏng`);
      return 'corrupt';
    }
  }

  private write(job: Job): void {
    const file = path.join(this.jobDir(job.id), 'job.json');
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(job));
      fs.fsyncSync(fd); // xuống đĩa trước khi rename
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }
}
