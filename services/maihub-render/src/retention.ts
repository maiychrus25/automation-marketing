import { LIMITS } from './limits';
import { JobStore } from './jobStore';

/** Xoá việc đã kết thúc quá `retentionDays` ngày. */
export class Retention {
  constructor(private readonly store: JobStore, private readonly now: () => number = Date.now) {}

  purge(): number {
    const cutoff = this.now() - LIMITS.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const job of this.store.list()) {
      if (job.status === 'queued' || job.status === 'rendering') continue;
      if ((job.finishedAt ?? job.createdAt) < cutoff) {
        this.store.remove(job.id);
        removed++;
      }
    }
    return removed;
  }
}
