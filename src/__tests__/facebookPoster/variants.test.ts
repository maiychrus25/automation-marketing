import { assignVariants, readVariants, variantText, variantKey, VARIANT_LABELS, MAX_VARIANTS } from '../../services/facebookPoster/variants';

const pairs = (n: number, profile = 'p1') => Array.from({ length: n }, (_, i) => ({ profileId: profile, url: `https://f/${String(i).padStart(3, '0')}` }));
const counts = (m: Map<string, number>, n: number) => {
  const c = new Array(n).fill(0);
  for (const v of m.values()) c[v]++;
  return c;
};

describe('assignVariants', () => {
  test('constants', () => {
    expect(VARIANT_LABELS).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(MAX_VARIANTS).toBe(5);
  });
  test('10 x 2 splits 5/5', () => expect(counts(assignVariants(pairs(10), 2, 0), 2)).toEqual([5, 5]));
  test('7 x 3 splits 3/2/2', () => expect(counts(assignVariants(pairs(7), 3, 0), 3)).toEqual([3, 2, 2]));
  test('input order does not matter', () => {
    const a = pairs(7);
    const b = [...a].reverse();
    expect([...assignVariants(a, 3, 0)]).toEqual([...assignVariants(a, 3, 0)]);
    const ma = assignVariants(a, 3, 0), mb = assignVariants(b, 3, 0);
    for (const p of a) expect(mb.get(variantKey(p.profileId, p.url))).toBe(ma.get(variantKey(p.profileId, p.url)));
  });
  test('offset shifts every target to the next variant', () => {
    const a = pairs(6);
    const m0 = assignVariants(a, 3, 0), m1 = assignVariants(a, 3, 1);
    for (const p of a) {
      const k = variantKey(p.profileId, p.url);
      expect(m1.get(k)).toBe((m0.get(k)! + 1) % 3);
    }
  });
  test('n = 1 gives all zero', () => {
    expect([...assignVariants(pairs(4), 1, 5).values()]).toEqual([0, 0, 0, 0]);
  });
  test('same target for two profiles is ordered by profileId', () => {
    const m = assignVariants([{ profileId: 'b', url: 'u' }, { profileId: 'a', url: 'u' }], 2, 0);
    expect(m.get(variantKey('a', 'u'))).toBe(0);
    expect(m.get(variantKey('b', 'u'))).toBe(1);
    expect(variantKey('a', 'u')).toBe('a\u0000u');
  });
});

describe('readVariants', () => {
  const fails = (p: Record<string, unknown>, msg: string) => expect(() => readVariants(p as any)).toThrow(new Error(msg));
  test('absent or empty gives []', () => {
    expect(readVariants({ text: 'a' })).toEqual([]);
    expect(readVariants({ text: 'a', variants: [] })).toEqual([]);
  });
  test('valid', () => expect(readVariants({ text: 'a', variants: ['b', 'c'] })).toEqual(['b', 'c']));
  test('too many', () => fails({ text: 'a', variants: ['b', 'c', 'd', 'e', 'f'] }, 'Tối đa 4 biến thể ngoài nội dung chính'));
  test('not an array', () => fails({ text: 'a', variants: 'b' }, 'Biến thể không hợp lệ'));
  test('empty item', () => {
    fails({ text: 'a', variants: ['  '] }, 'Biến thể B không được để trống');
    fails({ text: 'a', variants: [5] }, 'Biến thể B không được để trống');
  });
  test('too long', () => fails({ text: 'a', variants: ['x'.repeat(63207)] }, 'Biến thể B tối đa 63206 ký tự'));
  test('duplicates', () => {
    fails({ text: 'a', variants: [' a '] }, 'Biến thể B trùng với nội dung khác');
    fails({ text: 'a', variants: ['b', 'b '] }, 'Biến thể C trùng với nội dung khác');
  });
});

describe('variantText', () => {
  test('picks by index', () => {
    const p = { text: 'A', variants: ['B', 'C'] };
    expect([0, 1, 2].map((i) => variantText(p, i))).toEqual(['A', 'B', 'C']);
    expect(variantText({ text: 'A' }, 0)).toBe('A');
  });
});
