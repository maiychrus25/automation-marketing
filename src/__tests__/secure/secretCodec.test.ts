const fake = {
  available: true,
  isEncryptionAvailable: () => fake.available,
  encryptString: (s: string) => Buffer.from('X' + s),
  decryptString: (b: Buffer) => { const s = b.toString(); if (!s.startsWith('X')) throw new Error('bad'); return s.slice(1); },
};
jest.mock('electron', () => ({ safeStorage: fake }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { ENC_PREFIX, encryptSecret, decryptSecret } from '../../services/secure/secretCodec';

describe('secretCodec', () => {
  beforeEach(() => { fake.available = true; });

  test('encryptsWithThePrefixAndDecryptsBack', () => {
    const stored = encryptSecret('hunter2');
    expect(stored.startsWith(ENC_PREFIX)).toBe(true);
    expect(stored).not.toContain('hunter2');
    expect(decryptSecret(stored)).toBe('hunter2');
  });

  test('emptyStaysEmpty', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeUndefined();
  });

  test('savingAnAlreadyEncryptedValueDoesNotEncryptTwice', () => {
    const once = encryptSecret('hunter2');
    expect(encryptSecret(once)).toBe(once);
  });

  test('legacyPlainValuesAreReadAsTheyAre', () => {
    expect(decryptSecret('plain-old')).toBe('plain-old');
  });

  test('aValueThatCannotBeDecryptedReadsAsNull', () => {
    expect(decryptSecret(ENC_PREFIX + Buffer.from('other-machine').toString('base64'))).toBeNull();
  });

  test('withoutEncryptionValuesStayPlain', () => {
    fake.available = false;
    expect(encryptSecret('hunter2')).toBe('hunter2');
  });
});
