import { createHash } from 'crypto';
import { generateKey, hashKey, parseKeys, verifyKey } from '../src/keys';

describe('keys', () => {
  it('hashKey trả sha256 hex', () => {
    expect(hashKey('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('generateKey sinh khoá 32 byte base64url khớp hash', () => {
    const { raw, hash } = generateKey();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    expect(hash).toBe(hashKey(raw));
    expect(generateKey().raw).not.toBe(raw);
  });

  it('parseKeys đọc JSON hợp lệ', () => {
    const h = hashKey('x');
    const keys = parseKeys(JSON.stringify({ maihub1: h }));
    expect(keys.get('maihub1')).toBe(h);
  });

  it.each([
    ['không phải JSON', '{oops'],
    ['mảng', '[]'],
    ['null', 'null'],
    ['hash sai độ dài', JSON.stringify({ a: 'abcd' })],
    ['hash không phải hex', JSON.stringify({ a: 'z'.repeat(64) })],
    ['giá trị không phải chuỗi', JSON.stringify({ a: 5 })],
    ['rỗng', ''],
  ])('parseKeys ném lỗi khi %s', (_n, input) => {
    expect(() => parseKeys(input)).toThrow();
  });

  it('parseKeys ném lỗi khi không có khoá nào', () => {
    expect(() => parseKeys('{}')).toThrow();
  });

  it('verifyKey trả tên khi đúng, null khi sai hoặc khác độ dài', () => {
    const a = generateKey();
    const b = generateKey();
    const keys = parseKeys(JSON.stringify({ one: a.hash, two: b.hash }));
    expect(verifyKey(a.raw, keys)).toBe('one');
    expect(verifyKey(b.raw, keys)).toBe('two');
    expect(verifyKey('sai', keys)).toBeNull();
    expect(verifyKey('', keys)).toBeNull();
    expect(verifyKey(a.raw + 'x', keys)).toBeNull();
  });
});
