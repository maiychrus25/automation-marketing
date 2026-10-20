// Cấu hình máy chủ render video (spec mục 6.1). Khoá API lưu mã hoá `enc:` + safeStorage như khoá AI.
export const VIDEO_SETTINGS_KEY = 'video_render_settings';

export interface VideoSettings { url: string; apiKey: string }

/** Phần DatabaseService mà module cần. */
export interface SettingsStore {
    getSetting(key: string): string | null | undefined;
    setSetting(key: string, value: string): void;
}

/** Hàm mã hoá được tiêm vào để chạy được ngoài Electron (test). */
export interface KeyCrypto {
    encrypt(plain: string): string;
    decrypt(raw: string): string;
}

/** Phần `safeStorage` của Electron mà module cần. */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(buf: Buffer): string;
}

export function createSafeStorageCrypto(safeStorage: SafeStorageLike): KeyCrypto {
    return {
        encrypt(key) {
            if (!key) return '';
            try {
                if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(key).toString('base64');
            } catch { /* rơi về lưu thường như khoá AI */ }
            return key;
        },
        decrypt(raw) {
            if (!raw) return '';
            if (raw.startsWith('enc:')) {
                try { return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')); } catch { return ''; }
            }
            return raw;
        },
    };
}

export function maskKey(key: string): string {
    return key ? `••••${key.slice(-4)}` : '';
}

export function loadVideoSettings(db: SettingsStore, crypto: KeyCrypto): VideoSettings {
    try {
        const stored = JSON.parse(db.getSetting(VIDEO_SETTINGS_KEY) || '{}');
        return { url: String(stored.url ?? ''), apiKey: crypto.decrypt(String(stored.apiKey ?? '')) };
    } catch {
        return { url: '', apiKey: '' };
    }
}

/** `apiKey` bỏ trống/undefined = giữ khoá cũ (giao diện chỉ hiện 4 ký tự cuối). */
export function saveVideoSettings(db: SettingsStore, crypto: KeyCrypto, input: { url: string; apiKey?: string }): VideoSettings {
    const url = input.url.trim().replace(/\/+$/, '');
    if (url) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error('Địa chỉ máy chủ render không hợp lệ'); }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Địa chỉ máy chủ render phải bắt đầu bằng https://');
    }
    const apiKey = input.apiKey ? input.apiKey.trim() : loadVideoSettings(db, crypto).apiKey;
    db.setSetting(VIDEO_SETTINGS_KEY, JSON.stringify({ url, apiKey: crypto.encrypt(apiKey) }));
    return { url, apiKey };
}
