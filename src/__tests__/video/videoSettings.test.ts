import { createSafeStorageCrypto, loadVideoSettings, maskKey, saveVideoSettings, VIDEO_SETTINGS_KEY, type KeyCrypto, type SettingsStore } from '../../services/video/videoSettings';

function memorySettings(): SettingsStore & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    return { raw, getSetting: (k) => raw.get(k) ?? null, setSetting: (k, v) => { raw.set(k, v); } };
}
const rot: KeyCrypto = { encrypt: (s) => (s ? `enc:${Buffer.from(s).toString('base64')}` : ''), decrypt: (s) => (s.startsWith('enc:') ? Buffer.from(s.slice(4), 'base64').toString() : s) };

test('lưu khoá đã mã hoá, đọc lại ra khoá gốc', () => {
    const db = memorySettings();
    saveVideoSettings(db, rot, { url: 'https://render.example.com/', apiKey: 'abcd1234wxyz' });
    expect(db.raw.get(VIDEO_SETTINGS_KEY)).not.toContain('abcd1234wxyz');
    expect(loadVideoSettings(db, rot)).toEqual({ url: 'https://render.example.com', apiKey: 'abcd1234wxyz' });
});

test('lưu lại không kèm khoá thì giữ khoá cũ', () => {
    const db = memorySettings();
    saveVideoSettings(db, rot, { url: 'https://a.example', apiKey: 'k-one-1111' });
    saveVideoSettings(db, rot, { url: 'https://b.example' });
    expect(loadVideoSettings(db, rot)).toEqual({ url: 'https://b.example', apiKey: 'k-one-1111' });
});

test('địa chỉ sai bị từ chối; chưa cấu hình trả rỗng', () => {
    const db = memorySettings();
    expect(loadVideoSettings(db, rot)).toEqual({ url: '', apiKey: '' });
    expect(() => saveVideoSettings(db, rot, { url: 'not a url' })).toThrow();
    expect(() => saveVideoSettings(db, rot, { url: 'ftp://x.example' })).toThrow();
});

test('maskKey chỉ hiện 4 ký tự cuối', () => {
    expect(maskKey('abcd1234wxyz')).toBe('••••wxyz');
    expect(maskKey('')).toBe('');
});

test('createSafeStorageCrypto dùng enc: khi có safeStorage, rơi về chữ thường khi không', () => {
    const on = createSafeStorageCrypto({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`X${s}`), decryptString: (b) => b.toString().slice(1) });
    const enc = on.encrypt('key');
    expect(enc.startsWith('enc:')).toBe(true);
    expect(on.decrypt(enc)).toBe('key');
    const off = createSafeStorageCrypto({ isEncryptionAvailable: () => false, encryptString: () => { throw new Error('x'); }, decryptString: () => '' });
    expect(off.encrypt('key')).toBe('key');
    expect(off.decrypt('key')).toBe('key');
});
