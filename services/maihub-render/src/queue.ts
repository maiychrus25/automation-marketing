import { LIMITS } from './limits';
import { Job, JobStore } from './jobStore';

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** Hàng đợi FIFO, một việc chạy mỗi lúc; giữ trong bộ nhớ, dựng lại từ kho khi khởi động. */
export class Queue {
  private waiting: string[] = [];
  private running: string | undefined;
  private readonly creations = new Map<string, number[]>(); // khoá -> thời điểm tạo (cửa sổ trượt)

  constructor(private readonly store: JobStore, private readonly now: () => number = Date.now) {}

  /** Dựng lại sau khởi động: việc `queued` theo createdAt; ghi nhận lần tạo để giữ giới hạn theo giờ. */
  restore(jobs: Job[]): void {
    const sorted = [...jobs].sort((a, b) => a.createdAt - b.createdAt);
    this.waiting = sorted.filter((j) => j.status === 'queued').map((j) => j.id);
    for (const j of sorted) this.record(j.owner, j.createdAt);
  }

  enqueue(job: Job): void {
    const t = this.checkLimits(job.owner);
    this.record(job.owner, t);
    this.waiting.push(job.id);
  }

  /** Ném `LimitError` nếu `owner` không được thêm việc (hàng đợi chung, việc chờ theo khoá, giới hạn theo giờ); trả về thời điểm kiểm. */
  checkLimits(owner: string): number {
    const t = this.now();
    if (this.waiting.length + (this.running ? 1 : 0) >= LIMITS.maxQueue) {
      throw new LimitError(`Hàng đợi đã đầy (tối đa ${LIMITS.maxQueue} việc).`);
    }
    if (this.waiting.filter((id) => this.store.get(id)?.owner === owner).length >= LIMITS.maxPendingPerKey) {
      throw new LimitError(`Đã có ${LIMITS.maxPendingPerKey} việc đang chờ, vui lòng đợi.`);
    }
    if (this.recent(owner, t).length >= LIMITS.maxJobsPerHourPerKey) {
      throw new LimitError(`Tối đa ${LIMITS.maxJobsPerHourPerKey} lần tạo video mỗi giờ.`);
    }
    return t;
  }

  /** Vị trí trong hàng đợi (1 = kế tiếp); undefined nếu không còn chờ. */
  positionOf(id: string): number | undefined {
    const i = this.waiting.indexOf(id);
    return i < 0 ? undefined : i + 1;
  }

  /** Lấy việc kế tiếp và đánh dấu `rendering`; việc không cập nhật được bị đánh dấu `failed` và bỏ qua. */
  next(): Job | undefined {
    if (this.running) return undefined;
    for (let id = this.waiting.shift(); id; id = this.waiting.shift()) {
      try {
        const job = this.store.update(id, { status: 'rendering', startedAt: this.now() });
        this.running = id;
        return job;
      } catch (e) {
        console.error('[render] Không bắt đầu được việc:', (e as Error).message);
        try {
          this.store.update(id, { status: 'failed', error: 'Lỗi nội bộ khi bắt đầu việc', finishedAt: this.now() });
        } catch { /* kho hỏng: bỏ qua việc này */ }
      }
    }
    return undefined;
  }

  /** Báo việc đang chạy đã xong (kể cả thất bại) để nhận việc kế tiếp. */
  finish(id: string): void {
    if (this.running === id) this.running = undefined;
  }

  /** 'removed': bỏ khỏi hàng; 'running': người gọi phải báo worker dừng; 'none': không có việc. */
  cancel(id: string): 'removed' | 'running' | 'none' {
    const i = this.waiting.indexOf(id);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      this.store.update(id, { status: 'cancelled', finishedAt: this.now() });
      return 'removed';
    }
    return this.running === id ? 'running' : 'none';
  }

  get length(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  private recent(owner: string, t: number): number[] {
    const kept = (this.creations.get(owner) ?? []).filter((x) => t - x < HOUR_MS);
    this.creations.set(owner, kept);
    return kept;
  }

  private record(owner: string, at: number): void {
    const list = this.creations.get(owner) ?? [];
    list.push(at);
    this.creations.set(owner, list);
  }
}
