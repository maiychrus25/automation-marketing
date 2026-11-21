import * as jwt from 'jsonwebtoken';

jest.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from('X' + s),
    decryptString: (b: Buffer) => { if ((global as any).__keyStoreUp === false) throw new Error('locked'); const s = b.toString(); if (!s.startsWith('X')) throw new Error('bad'); return s.slice(1); },
    isEncryptionAvailable: () => (global as any).__keyStoreUp !== false,
  },
}));
const mockSettings = new Map<string, string>();
const mockDb: any = {
  getDbPath: () => '/tmp/jwt-at-rest-test.db',
  withDbPath: (_p: string, fn: () => any) => fn(),
  getSetting: (k: string) => (mockSettings.has(k) ? mockSettings.get(k) : null),
  setSetting: (k: string, v: string) => { mockSettings.set(k, v); },
};
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `id-${++mockUuid}` }));
import Logger from '../../utils/Logger';

function loadService(): any {
  let svc: any;
  jest.isolateModules(() => { svc = require('../../services/employee/EmployeeService').default.getInstance(); });
  return svc;
}

describe('employee signing key at rest', () => {
  beforeEach(() => { mockSettings.clear(); jest.clearAllMocks(); (global as any).__keyStoreUp = true; });

  test('aNewSecretIsStoredEncrypted', () => {
    const svc = loadService();
    const stored = mockSettings.get('employee_jwt_secret') as string;
    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored).not.toContain(svc.jwtSecret);
    expect(mockSettings.get('employee_jwt_secret_version')).toBe('2');
  });

  test('aLegacyPlainSecretIsKeptAndStoredEncrypted', () => {
    mockSettings.set('employee_jwt_secret', 'legacy-plain-secret');
    mockSettings.set('employee_jwt_secret_version', '2');
    const token = jwt.sign({ employee_id: 'e1' }, 'legacy-plain-secret');
    const svc = loadService();
    expect(svc.jwtSecret).toBe('legacy-plain-secret');
    expect(() => jwt.verify(token, svc.jwtSecret, { algorithms: ['HS256'] })).not.toThrow();
    const stored = mockSettings.get('employee_jwt_secret') as string;
    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored).not.toContain('legacy-plain-secret');
    // second start reads the encrypted copy back to the same key
    expect(loadService().jwtSecret).toBe('legacy-plain-secret');
  });

  test('aLegacyPlainKeyWithoutVersionRotatesOnceAndIsStoredEncrypted', () => {
    mockSettings.set('employee_jwt_secret', 'legacy-plain-secret');
    const svc = loadService();
    expect(svc.jwtSecret).not.toBe('legacy-plain-secret');
    const stored = mockSettings.get('employee_jwt_secret') as string;
    expect(stored.startsWith('enc:')).toBe(true);
    expect(mockSettings.get('employee_jwt_secret_version')).toBe('2');
    expect(loadService().jwtSecret).toBe(svc.jwtSecret);
  });

  test('anUnreadableSecretIsNeverOverwritten', () => {
    const unreadable = 'enc:' + Buffer.from('garbage').toString('base64');
    mockSettings.set('employee_jwt_secret', unreadable);
    mockSettings.set('employee_jwt_secret_version', '2');
    const svc = loadService();
    expect(mockSettings.get('employee_jwt_secret')).toBe(unreadable);
    expect(svc.jwtSecret).toBeTruthy();
    const token = jwt.sign({ employee_id: 'e1' }, svc.jwtSecret);
    expect(() => jwt.verify(token, svc.jwtSecret, { algorithms: ['HS256'] })).not.toThrow();
    const logged = (Logger.warn as jest.Mock).mock.calls.map(c => String(c[0])).join('\n');
    expect(logged).toContain('unreadable');
    expect(logged).not.toContain(svc.jwtSecret);
  });

  test('aLockedKeyStoreDoesNotRotateTheKey', () => {
    (global as any).__keyStoreUp = true;
    const first = loadService();
    const stored = mockSettings.get('employee_jwt_secret') as string;
    (global as any).__keyStoreUp = false;
    const second = loadService();
    expect(mockSettings.get('employee_jwt_secret')).toBe(stored);
    expect(second.jwtSecret).not.toBe(first.jwtSecret);
    (global as any).__keyStoreUp = true;
    expect(loadService().jwtSecret).toBe(first.jwtSecret);
  });
});
