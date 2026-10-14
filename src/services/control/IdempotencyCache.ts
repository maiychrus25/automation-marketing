import Logger from '../../utils/Logger';
import { ControlError } from './ControlMethods';
import { errorText } from './controlSecurity';
import { IDEMPOTENCY_TTL_MS, type ControlStore } from './ControlStore';

/** Khử trùng lặp theo (keyId, idemKey), khoá gắn với một thao tác: dùng lại idemKey cho thao tác khác trong 24 giờ bị từ chối. Gọi đồng thời dùng chung một promise; kết quả lưu 24 giờ. Kết quả phải JSON-serializable. */
export class IdempotencyCache {
    private readonly inFlight = new Map<string, { method: string; promise: Promise<unknown> }>();

    constructor(private readonly store: ControlStore, private readonly now: () => number = Date.now) {}

    async run<T>(keyId: string, method: string, idemKey: string | undefined, fn: () => Promise<T>): Promise<T> {
        if (!idemKey) return fn();
        const flightKey = JSON.stringify([keyId, idemKey]);
        const pending = this.inFlight.get(flightKey);
        if (pending) {
            this.assertSameMethod(pending.method, method);
            return pending.promise as Promise<T>;
        }

        const saved = this.store.getIdempotent(keyId, idemKey);
        if (saved && this.now() - saved.createdAt <= IDEMPOTENCY_TTL_MS) {
            this.assertSameMethod(saved.method, method);
            return JSON.parse(saved.result) as T;
        }

        const promise = (async () => {
            const result = await fn();
            // Lưu thất bại (không serialize được, lỗi DB) không được biến thành lỗi sau khi tác vụ đã chạy xong.
            // `undefined` được lưu thành null nên lần phát lại trả null.
            try {
                this.store.putIdempotent(keyId, idemKey, method, JSON.stringify(result ?? null), this.now());
            } catch (err) {
                Logger.warn('[control] Không lưu được kết quả idempotency:', errorText(err));
            }
            return result;
        })();
        this.inFlight.set(flightKey, { method, promise });
        try {
            return await promise;
        } finally {
            this.inFlight.delete(flightKey);
        }
    }

    /** `''` là dòng từ trước khi có cột method: không biết thao tác nào nên không coi là xung đột. */
    private assertSameMethod(used: string, requested: string): void {
        if (used && used !== requested) {
            throw new ControlError('INVALID_PARAMS', `idempotencyKey này đã dùng cho thao tác ${used}, hãy dùng khoá khác cho ${requested}`, { field: 'idempotencyKey' });
        }
    }
}
