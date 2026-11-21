/**
 * secretCodec.ts
 * Mã hoá/giải mã MỘT giá trị bằng electron.safeStorage, dạng lưu `enc:` + base64.
 * Không import DatabaseService (tránh vòng phụ thuộc); không bao giờ log giá trị.
 */
import { safeStorage } from 'electron';
import Logger from '../../utils/Logger';

export const ENC_PREFIX = 'enc:';

let warnedUnavailable = false;

/** Rỗng → rỗng; đã có `enc:` → giữ nguyên; không có mã hoá hoặc lỗi → lưu thô như cũ. */
export function encryptSecret(value: string): string {
    if (!value || value.startsWith(ENC_PREFIX)) return value;
    if (!safeStorage.isEncryptionAvailable()) {
        if (!warnedUnavailable) {
            warnedUnavailable = true;
            Logger.warn('[SecretCodec] safeStorage unavailable - secrets are stored as plaintext');
        }
        return value;
    }
    try {
        return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
    } catch (err: any) {
        Logger.error(`[SecretCodec] Encrypt failed - storing plaintext: ${err.message}`);
        return value;
    }
}

/** null/rỗng → giữ nguyên; không có `enc:` → dạng thô cũ; giải mã lỗi → null (không bao giờ trả chuỗi `enc:`). */
export function decryptSecret(stored: string | null | undefined): string | null {
    if (!stored) return stored as null;
    if (!stored.startsWith(ENC_PREFIX)) return stored;
    try {
        return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
    } catch (err: any) {
        Logger.warn(`[SecretCodec] Decrypt failed - may be from a different machine: ${err.message}`);
        return null;
    }
}
