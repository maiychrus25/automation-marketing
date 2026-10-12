import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkDocs: Record<string, (...args: any[]) => any> = require('../../../scripts/check-docs.js');

const marker = (file: string, name: string, value: number): string =>
  `Giới hạn <!-- docs-check: ${file}#${name} = ${value} -->`;

describe('check-docs', () => {
  describe('evaluateNumber', () => {
    it('evaluates products, separators and rejects anything else', () => {
      expect(checkDocs.evaluateNumber('20 * 1024 * 1024')).toBe(20971520);
      expect(checkDocs.evaluateNumber('86_400')).toBe(86400);
      expect(checkDocs.evaluateNumber('2 * 60 + 5')).toBe(125);
      expect(checkDocs.evaluateNumber('process.env.X')).toBeNull();
    });
  });

  describe('findConstant', () => {
    it('reads const and export const', () => {
      expect(checkDocs.findConstant('const MAX_A = 5;', 'MAX_A')).toBe(5);
      expect(checkDocs.findConstant('export const MAX_A = 60 * 1000;', 'MAX_A')).toBe(60000);
    });
    it('returns null when missing, prefixed, or only in a comment', () => {
      expect(checkDocs.findConstant('const OTHER = 1;', 'MAX_A')).toBeNull();
      expect(checkDocs.findConstant('const MAX_TEXTX = 1;', 'MAX_TEXT')).toBeNull();
      expect(checkDocs.findConstant('// const MAX_A = 5;', 'MAX_A')).toBeNull();
    });
  });

  describe('checkVersion', () => {
    const line = (v: string): string => `| Phiên bản ứng dụng được khảo sát | \`${v}\` (ghi chú) |`;
    it('passes on match', () => {
      expect(checkDocs.checkVersion(line('1.2.3'), '1.2.3')).toEqual([]);
    });
    it('reports both versions on mismatch', () => {
      const errors = checkDocs.checkVersion(line('1.2.2'), '1.2.3');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('1.2.2');
      expect(errors[0]).toContain('1.2.3');
    });
    it('reports a missing line', () => {
      expect(checkDocs.checkVersion('nothing here', '1.2.3')).toHaveLength(1);
    });
  });

  describe('checkConstantMarkers', () => {
    const read = (rel: string): string | null => (rel === 'src/a.ts' ? 'const MAX_A = 10;' : null);
    it('passes on matching value', () => {
      expect(checkDocs.checkConstantMarkers('D.md', marker('src/a.ts', 'MAX_A', 10), read)).toEqual([]);
    });
    it('reports a wrong value', () => {
      expect(checkDocs.checkConstantMarkers('D.md', marker('src/a.ts', 'MAX_A', 11), read)).toHaveLength(1);
    });
    it('reports a missing constant or file', () => {
      expect(checkDocs.checkConstantMarkers('D.md', marker('src/a.ts', 'MAX_B', 10), read)).toHaveLength(1);
      expect(checkDocs.checkConstantMarkers('D.md', marker('src/zz.ts', 'MAX_A', 10), read)).toHaveLength(1);
    });
  });

  describe('checkPaths', () => {
    const exists = (rel: string): boolean => rel === 'src/a.ts';
    it('skips patterns and non-repo paths', () => {
      expect(checkDocs.checkPaths('D.md', 'see `src/**/*.ts` and `docs/specs/<tên>.md` and `foo/bar.ts`', exists)).toEqual([]);
    });
    it('strips line and anchor suffixes', () => {
      expect(checkDocs.checkPaths('D.md', 'x `src/a.ts:12` y `src/a.ts#frag`', exists)).toEqual([]);
    });
    it('reports a missing path', () => {
      const errors = checkDocs.checkPaths('D.md', '`src/missing.ts`', exists);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('src/missing.ts');
    });
  });

  it('runChecks is clean on the real repo', () => {
    expect(checkDocs.runChecks(path.resolve(__dirname, '../../..'))).toEqual([]);
  });
});
