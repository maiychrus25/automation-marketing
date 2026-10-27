// Cấu hình API AHV AI cho engine `ad_video` (spec docs/specs/2026-10-27-ad-video.md mục 4).
// Khoá lưu `enc:` + safeStorage, dùng lại KeyCrypto/maskKey của videoSettings.ts — khoá này là
// khoá chung `X-API-Key` của ai.ahvchat.com, khác khoá Bearer của máy chủ render.
import type { KeyCrypto, SettingsStore } from './videoSettings';

export const AHV_SETTINGS_KEY = 'ahv_video_settings';
export const AHV_DEFAULT_BASE_URL = 'https://ai.ahvchat.com';

export interface AhvSettings { baseUrl: string; apiKey: string }

export function loadAhvSettings(db: SettingsStore, crypto: KeyCrypto): AhvSettings {
    try {
        const stored = JSON.parse(db.getSetting(AHV_SETTINGS_KEY) || '{}');
        return { baseUrl: String(stored.baseUrl || AHV_DEFAULT_BASE_URL), apiKey: crypto.decrypt(String(stored.apiKey ?? '')) };
    } catch {
        return { baseUrl: AHV_DEFAULT_BASE_URL, apiKey: '' };
    }
}

/** `apiKey` bỏ trống, chỉ khoảng trắng hoặc undefined = giữ khoá cũ; `baseUrl` bỏ trống = về mặc định. */
export function saveAhvSettings(db: SettingsStore, crypto: KeyCrypto, input: { baseUrl: string; apiKey?: string }): AhvSettings {
    const trimmed = input.baseUrl.trim().replace(/\/+$/, '');
    const baseUrl = trimmed || AHV_DEFAULT_BASE_URL;
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error('Địa chỉ API AHV AI không hợp lệ'); }
    // http chỉ cho máy nội bộ (thử với staging qua tunnel): khoá không được đi qua mạng dạng chữ thường
    const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !local) throw new Error('Địa chỉ API AHV AI phải bắt đầu bằng https://');
    const apiKey = input.apiKey?.trim() || loadAhvSettings(db, crypto).apiKey;
    db.setSetting(AHV_SETTINGS_KEY, JSON.stringify({ baseUrl, apiKey: crypto.encrypt(apiKey) }));
    return { baseUrl, apiKey };
}
