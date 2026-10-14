import { IDEMPOTENCY_TTL_MS, type ControlStore } from './ControlStore';

/** Khử trùng lặp theo (keyId, idemKey): gọi đồng thời dùng chung một promise; kết quả lưu 24 giờ. Kết quả phải JSON-serializable. */
export class IdempotencyCache {
    private readonly inFlight = new Map<string, Promise<unknown>>();

    constructor(private readonly store: ControlStore, private readonly now: () => number = Date.now) {}

    async run<T>(keyId: string, idemKey: string | undefined, fn: () => Promise<T>): Promise<T> {
        if (!idemKey) return fn();
        const flightKey = JSON.stringify([keyId, idemKey]);
        const pending = this.inFlight.get(flightKey);
        if (pending) return pending as Promise<T>;

        const saved = this.store.getIdempotent(keyId, idemKey);
        if (saved && this.now() - saved.createdAt <= IDEMPOTENCY_TTL_MS) return JSON.parse(saved.result) as T;

        const promise = (async () => {
            const result = await fn();
            this.store.putIdempotent(keyId, idemKey, JSON.stringify(result), this.now());
            return result;
        })();
        this.inFlight.set(flightKey, promise);
        try {
            return await promise;
        } finally {
            this.inFlight.delete(flightKey);
        }
    }
}
