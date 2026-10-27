import { AHV_DEFAULT_BASE_URL, AHV_SETTINGS_KEY, loadAhvSettings, saveAhvSettings } from '../../services/video/ahvSettings';
import { maskKey, type KeyCrypto, type SettingsStore } from '../../services/video/videoSettings';

function memorySettings(): SettingsStore & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    return { raw, getSetting: (k) => raw.get(k) ?? null, setSetting: (k, v) => { raw.set(k, v); } };
}
const rot: KeyCrypto = { encrypt: (s) => (s ? `enc:${Buffer.from(s).toString('base64')}` : ''), decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString() : s) };

test('chưa lưu gì thì baseUrl là ai.ahvchat.com và chưa có khoá', () => {
    const db = memorySettings();
    expect(loadAhvSettings(db, rot)).toEqual({ baseUrl: AHV_DEFAULT_BASE_URL, apiKey: '' });
    expect(AHV_DEFAULT_BASE_URL).toBe('https://ai.ahvchat.com');
});

test('lưu khoá đã mã hoá, đọc lại ra khoá gốc, bỏ dấu / cuối', () => {
    const db = memorySettings();
    saveAhvSettings(db, rot, { baseUrl: 'https://ai.ahvchat.com/', apiKey: 'ahv-key-5678' });
    expect(db.raw.get(AHV_SETTINGS_KEY)).not.toContain('ahv-key-5678');
    expect(loadAhvSettings(db, rot)).toEqual({ baseUrl: 'https://ai.ahvchat.com', apiKey: 'ahv-key-5678' });
    expect(maskKey('ahv-key-5678')).toBe('••••5678');
});

test('lưu lại không kèm khoá thì giữ khoá cũ', () => {
    const db = memorySettings();
    saveAhvSettings(db, rot, { baseUrl: 'https://ai.ahvchat.com', apiKey: 'key-one-1111' });
    saveAhvSettings(db, rot, { baseUrl: 'http://127.0.0.1:2023' });
    expect(loadAhvSettings(db, rot)).toEqual({ baseUrl: 'http://127.0.0.1:2023', apiKey: 'key-one-1111' });
});

test('khoá chỉ có khoảng trắng không xoá khoá cũ', () => {
    const db = memorySettings();
    saveAhvSettings(db, rot, { baseUrl: 'https://ai.ahvchat.com', apiKey: 'key-giu-lai' });
    saveAhvSettings(db, rot, { baseUrl: 'https://ai.ahvchat.com', apiKey: '   ' });
    expect(loadAhvSettings(db, rot).apiKey).toBe('key-giu-lai');
});

test('địa chỉ phải https, chỉ http cho máy nội bộ; để trống thì về mặc định', () => {
    const db = memorySettings();
    expect(() => saveAhvSettings(db, rot, { baseUrl: 'not a url' })).toThrow();
    expect(() => saveAhvSettings(db, rot, { baseUrl: 'ftp://x.example' })).toThrow();
    expect(() => saveAhvSettings(db, rot, { baseUrl: 'http://ai.ahvchat.com' })).toThrow('https://');
    expect(saveAhvSettings(db, rot, { baseUrl: 'http://localhost:2023' }).baseUrl).toBe('http://localhost:2023');
    expect(saveAhvSettings(db, rot, { baseUrl: '   ' }).baseUrl).toBe(AHV_DEFAULT_BASE_URL);
});

test('giá trị lưu bị hỏng thì về mặc định, không ném', () => {
    const db = memorySettings();
    db.setSetting(AHV_SETTINGS_KEY, '{khong-phai-json');
    expect(loadAhvSettings(db, rot)).toEqual({ baseUrl: AHV_DEFAULT_BASE_URL, apiKey: '' });
});
