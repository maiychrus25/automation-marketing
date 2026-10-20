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

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const RESTART_ERROR = 'Máy chủ khởi động lại khi đang render';

/** Kho việc: mỗi việc là `<dataDir>/jobs/<id>/job.json` kèm `input/` và `output/`. */
export class JobStore {
  private readonly jobsDir: string;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.jobsDir = path.join(dataDir, 'jobs');
    fs.mkdirSync(this.jobsDir, { recursive: true });
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

  get(id: string): Job | undefined {
    if (!ID_RE.test(id)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.jobDir(id), 'job.json'), 'utf8')) as Job;
    } catch {
      return undefined;
    }
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = this.get(id);
    if (!job) throw new Error('Không tìm thấy việc');
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

  private write(job: Job): void {
    const file = path.join(this.jobDir(job.id), 'job.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, file);
  }
}
