import Logger from '../../utils/Logger';
import { ControlError } from './ControlMethods';
import { errorText } from './controlSecurity';
import { IDEMPOTENCY_TTL_MS, type ControlStore } from './ControlStore';

/** Khử trùng lặp theo (keyId, idemKey), khoá gắn với một thao tác: dùng lại idemKey cho thao tác khác trong 24 giờ bị từ chối. Gọi đồng thời dùng chung một promise; kết quả lưu 24 giờ. Kết quả phải JSON-serializable. */
export class IdempotencyCache {
    private readonly inFlight = new Map<string, { method: string; requestHash?: string; promise: Promise<unknown> }>();

    constructor(private readonly store: ControlStore, private readonly now: () => number = Date.now) {}

    async run<T>(keyId: string, method: string, idemKey: string | undefined, fn: () => Promise<T>, requestHash?: string, assertCurrent?: () => void, replay?: () => Promise<T>): Promise<T> {
        const validateReplay = async (result: T): Promise<T> => {
            assertCurrent?.();
            // Opt-in durable operations revalidate their evidence; failure never falls back to cached success.
            const validated = replay ? await replay() : result;
            assertCurrent?.();
            return validated;
        };
        assertCurrent?.();
        if (!idemKey) {
            const result = await fn();
            assertCurrent?.();
            return result;
        }
        const flightKey = JSON.stringify([keyId, idemKey]);
        const pending = this.inFlight.get(flightKey);
        if (pending) {
            this.assertSameRequest(pending, method, requestHash);
            const result = await pending.promise as T;
            return validateReplay(result);
        }

        const saved = this.store.getIdempotent(keyId, idemKey);
        if (saved && this.now() - saved.createdAt <= IDEMPOTENCY_TTL_MS) {
            this.assertSameRequest(saved, method, requestHash);
            return validateReplay(JSON.parse(saved.result) as T);
        }

        const promise = (async () => {
            const result = await fn();
            assertCurrent?.(); // Outside the persistence-error catch: stale authorization must fail.
            // Lưu thất bại (không serialize được, lỗi DB) không được biến thành lỗi sau khi tác vụ đã chạy xong.
            // `undefined` được lưu thành null nên lần phát lại trả null.
            try {
                this.store.putIdempotent(keyId, idemKey, method, JSON.stringify(result ?? null), this.now(), requestHash);
            } catch (err) {
                Logger.warn('[control] Không lưu được kết quả idempotency:', errorText(err));
            }
            return result;
        })();
        this.inFlight.set(flightKey, { method, requestHash, promise });
        try {
            const result = await promise;
            assertCurrent?.();
            return result;
        } finally {
            this.inFlight.delete(flightKey);
        }
    }

    private assertSameRequest(used: { method: string; requestHash?: string }, method: string, requestHash?: string): void {
        if (requestHash !== undefined && (used.requestHash !== requestHash || used.method !== method)) {
            throw new ControlError('CONFLICT', 'idempotencyKey đã dùng cho yêu cầu khác, hãy dùng khoá khác', { field: 'idempotencyKey' });
        }
        this.assertSameMethod(used.method, method);
    }

    /** `''` là dòng từ trước khi có cột method: không biết thao tác nào nên không coi là xung đột. */
    private assertSameMethod(used: string, requested: string): void {
        if (used && used !== requested) {
            throw new ControlError('INVALID_PARAMS', `idempotencyKey này đã dùng cho thao tác ${used}, hãy dùng khoá khác cho ${requested}`, { field: 'idempotencyKey' });
        }
    }
}
