import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-secrets-'));
const fake = {
  available: true,
  isEncryptionAvailable: () => fake.available,
  encryptString: (s: string) => Buffer.from('X' + s),
  decryptString: (b: Buffer) => { const s = b.toString(); if (!s.startsWith('X')) throw new Error('bad'); return s.slice(1); },
};
jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: fake,
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { decryptSecret } from '../../services/secure/secretCodec';
import DatabaseService from '../../services/database/DatabaseService';

describe('secrets at rest on a real database', () => {
  const db = DatabaseService.getInstance();
  const rawPassword = (id: number) => db.queryOne<{ password: string }>('SELECT password FROM proxies WHERE id = ?', [id])!.password;
  const proxy = (password?: string) => db.saveProxy({ name: 'p', type: 'http', host: 'h', port: 8080, username: 'u', password });
  const marker = () => db.queryOne<{ value: string }>("SELECT value FROM app_settings WHERE key = 'secrets_at_rest_migrated'")?.value;

  beforeAll(async () => { await db.initialize(); });
  beforeEach(() => { fake.available = true; db.run("DELETE FROM app_settings WHERE key = 'secrets_at_rest_migrated'"); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('aSavedProxyPasswordIsStoredEncryptedAndReadBackPlain', () => {
    const id = proxy('s3cret');
    expect(rawPassword(id).startsWith('enc:')).toBe(true);
    expect(db.getProxyById(id).password).toBe('s3cret');
    expect(db.getProxies().find((p: any) => p.id === id).password).toBe('s3cret');
  });

  test('updatingAProxyWithItsShownPasswordKeepsIt', () => {
    const id = proxy('s3cret');
    const shown = db.getProxyById(id).password;
    db.updateProxy(id, { password: shown });
    expect(db.getProxyById(id).password).toBe('s3cret');
    db.updateProxy(id, { password: rawPassword(id) });
    expect(db.getProxyById(id).password).toBe('s3cret');
  });

  test('anEmptyProxyPasswordStaysEmpty', () => {
    const id = proxy('');
    expect(rawPassword(id)).toBe('');
    expect(db.getProxyById(id).password).toBe('');
    db.updateProxy(id, { password: '' });
    expect(rawPassword(id)).toBe('');
  });

  test('theMigrationEncryptsLegacyProxyPasswordsOnce', () => {
    fake.available = false;
    const id = proxy('legacy-pw');
    fake.available = true;
    expect(rawPassword(id)).toBe('legacy-pw');
    db.migrateSecretsAtRest();
    const first = rawPassword(id);
    expect(first.startsWith('enc:')).toBe(true);
    expect(marker()).toBe('done');
    db.migrateSecretsAtRest();
    expect(rawPassword(id)).toBe(first);
    expect(db.getProxyById(id).password).toBe('legacy-pw');
  });

  test('anUndecryptableProxyPasswordReadsAsEmpty', () => {
    const id = proxy('x');
    db.run('UPDATE proxies SET password = ? WHERE id = ?', ['enc:' + Buffer.from('foreign').toString('base64'), id]);
    expect(db.getProxyById(id).password).toBe('');
  });

  describe('facebook cookie plain copy', () => {
    const fbAccount = (id: string, cookie: string) =>
      db.saveFBAccount({ id, facebook_id: id, name: 'n', avatar_url: '', cookie_encrypted: cookie, session_data: '{}', status: 'disconnected' });
    const column = (id: string) => db.queryOne<{ c: string }>('SELECT cookie_encrypted AS c FROM fb_accounts WHERE id = ?', [id])!.c;
    const store = (id: string) => db.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [`fb_cookie_${id}`])?.value;
    const putStore = (id: string, v: string) => db.run(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [`fb_cookie_${id}`, v]);
    const legacyRow = (id: string, cookie: string) => { fbAccount(id, ''); db.run('UPDATE fb_accounts SET cookie_encrypted = ? WHERE id = ?', [cookie, id]); };

    test('aNewFacebookAccountLeavesNoPlainCookieInItsRow', () => {
      fbAccount('fb-new', 'c_user=1; xs=secret');
      expect(column('fb-new')).toBe('');
    });

    test('theMigrationClearsThePlainCopyWhenTheStoreHasTheCookie', () => {
      legacyRow('fb-clear', 'c_user=2; xs=plain');
      putStore('fb-clear', 'enc:' + Buffer.from('Xc_user=2; xs=stored').toString('base64'));
      db.migrateSecretsAtRest();
      expect(column('fb-clear')).toBe('');
      expect(decryptSecret(store('fb-clear')!)).toBe('c_user=2; xs=stored');
    });

    test('theMigrationMovesThePlainCopyIntoTheStoreWhenTheStoreHasNoValue', () => {
      legacyRow('fb-missing', 'c_user=4; xs=plain');
      db.migrateSecretsAtRest();
      expect(column('fb-missing')).toBe('');
      expect(store('fb-missing')!.startsWith('enc:')).toBe(true);
      expect(decryptSecret(store('fb-missing')!)).toBe('c_user=4; xs=plain');
      expect(marker()).toBe('done');
    });

    test('anUnreadableStoredCookieIsNeverReplacedByThePlainCopy', () => {
      const unreadable = 'enc:' + Buffer.from('foreign').toString('base64');
      legacyRow('fb-keep', 'c_user=3; xs=plain');
      putStore('fb-keep', unreadable);
      const pid = proxy('legacy-pw2');
      db.run('UPDATE proxies SET password = ? WHERE id = ?', ['legacy-pw2', pid]);
      db.migrateSecretsAtRest();
      expect(store('fb-keep')).toBe(unreadable);
      expect(column('fb-keep')).toBe('c_user=3; xs=plain');
      expect(marker()).not.toBe('done');
      expect(rawPassword(pid).startsWith('enc:')).toBe(true);
      db.run('DELETE FROM fb_accounts WHERE id = ?', ['fb-keep']);
      db.run('DELETE FROM app_settings WHERE key = ?', ['fb_cookie_fb-keep']);
    });

    test('runningTheMigrationTwiceChangesNothing', () => {
      legacyRow('fb-twice', 'c_user=5; xs=plain');
      db.migrateSecretsAtRest();
      const first = store('fb-twice');
      db.run("DELETE FROM app_settings WHERE key = 'secrets_at_rest_migrated'");
      db.migrateSecretsAtRest();
      expect(store('fb-twice')).toBe(first);
      expect(column('fb-twice')).toBe('');
      expect(decryptSecret(first!)).toBe('c_user=5; xs=plain');
    });
  });
});
