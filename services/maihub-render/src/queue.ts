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
    const t = this.now();
    if (this.waiting.length + (this.running ? 1 : 0) >= LIMITS.maxQueue) {
      throw new LimitError(`Hàng đợi đã đầy (tối đa ${LIMITS.maxQueue} việc).`);
    }
    if (this.waiting.filter((id) => this.store.get(id)?.owner === job.owner).length >= LIMITS.maxPendingPerKey) {
      throw new LimitError(`Đã có ${LIMITS.maxPendingPerKey} việc đang chờ, vui lòng đợi.`);
    }
    if (this.recent(job.owner, t).length >= LIMITS.maxJobsPerHourPerKey) {
      throw new LimitError(`Tối đa ${LIMITS.maxJobsPerHourPerKey} lần tạo video mỗi giờ.`);
    }
    this.record(job.owner, t);
    this.waiting.push(job.id);
  }

  /** Vị trí trong hàng đợi (1 = kế tiếp); undefined nếu không còn chờ. */
  positionOf(id: string): number | undefined {
    const i = this.waiting.indexOf(id);
    return i < 0 ? undefined : i + 1;
  }

  /** Lấy việc kế tiếp và đánh dấu `rendering`; undefined nếu đang có việc chạy hoặc hàng trống. */
  next(): Job | undefined {
    if (this.running) return undefined;
    const id = this.waiting.shift();
    if (!id) return undefined;
    this.running = id;
    return this.store.update(id, { status: 'rendering', startedAt: this.now() });
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
