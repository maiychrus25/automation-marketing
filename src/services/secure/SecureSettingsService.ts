/**
 * SecureSettingsService.ts
 * Wrapper quanh electron.safeStorage để mã hóa data nhạy cảm trong SQLite.
 * Data được mã hóa bởi OS (Windows Credential Manager / macOS Keychain).
 * Chỉ app này trên đúng máy này mới giải mã được.
 */
import DatabaseService from '../database/DatabaseService';
import { encryptSecret, decryptSecret } from './secretCodec';

/** Cho phép ghi/đọc vào DB khác DB mặc định (vd. DB boss). */
export type SettingsDb = Pick<DatabaseService, 'getSetting' | 'setSetting'>;

/**
 * Lưu value được mã hóa bởi safeStorage vào SQLite settings.
 */
export function secureSet(key: string, value: string, db: SettingsDb = DatabaseService.getInstance()): void {
    if (!value && value !== '') {
        db.setSetting(key, '');
        return;
    }
    db.setSetting(key, encryptSecret(value));
}

/**
 * Đọc và giải mã value từ SQLite settings.
 * Trả về null nếu không tồn tại hoặc không giải mã được.
 */
export function secureGet(key: string, db: SettingsDb = DatabaseService.getInstance()): string | null {
    const raw = db.getSetting(key);
    if (!raw) return null;

    // Plaintext cũ (chưa migrate) được trả nguyên; `enc:` lỗi giải mã → null
    return decryptSecret(raw);
}

/**
 * Xóa secure setting.
 */
export function secureDelete(key: string, db: SettingsDb = DatabaseService.getInstance()): void {
    db.setSetting(key, '');
}


