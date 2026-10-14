import type { ControlStore } from './ControlStore';

/** Đánh thức các lời gọi `events.wait` đang chờ khi có sự kiện mới. */
export class EventNotifier {
    private readonly waiters = new Set<() => void>();

    constructor(private readonly store: Pick<ControlStore, 'listEventsAfter'>) {}

    /** Số lời gọi đang chờ (dùng cho test/chẩn đoán). */
    get pending(): number { return this.waiters.size; }

    /** Gọi sau mỗi `store.addEvent`. */
    notify(): void {
        for (const wake of [...this.waiters]) wake();
    }

    /**
     * Resolve khi có sự kiện mới, hết `timeoutMs` hoặc `signal` bị huỷ (không bao giờ reject).
     * Đăng ký người chờ đồng bộ rồi mới kiểm tra lại DB, nên sự kiện chen vào giữa không bị lỡ.
     */
    waitForEvent(afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            if (signal?.aborted) return resolve();
            let timer: NodeJS.Timeout | undefined;
            const done = () => {
                clearTimeout(timer);
                this.waiters.delete(done);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            this.waiters.add(done);
            signal?.addEventListener('abort', done, { once: true });
            timer = setTimeout(done, timeoutMs);
            if (this.store.listEventsAfter(afterSeq, 1).length) done();
        });
    }
}
