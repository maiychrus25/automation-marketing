import * as fs from 'fs';
import * as os from 'os';
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
    it('reports malformed markers instead of ignoring them', () => {
      for (const bad of ['src/a.ts#MAX_A = 1_000', 'src/a.ts#MAX_A = 20MB', 'src/a.ts MAX_A = 10']) {
        expect(checkDocs.checkConstantMarkers('D.md', `<!-- docs-check: ${bad} -->`, read)).toHaveLength(1);
      }
      expect(checkDocs.checkConstantMarkers('D.md', '<!-- docs-check: src/a.ts#MAX_A = 10', read)).toHaveLength(1);
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

  describe('runChecks on fixtures', () => {
    const write = (dir: string, version: string, extra: string): void => {
      fs.writeFileSync(path.join(dir, 'package.json'), version);
      fs.writeFileSync(path.join(dir, 'SYSTEM_DOCUMENTATION.md'), `| Phiên bản ứng dụng được khảo sát | \`1.0.0\` |\n${extra}\n`);
      for (const f of ['README.md', 'DESIGN.md', 'AGENTS.md']) fs.writeFileSync(path.join(dir, f), '');
    };
    it('errors when the doc has zero markers, and on invalid package.json', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-'));
      try {
        write(dir, '{"version":"1.0.0"}', 'no markers');
        expect(checkDocs.runChecks(dir)).toEqual([expect.stringContaining('không có dấu docs-check')]);
        write(dir, '{oops', 'no markers');
        expect(checkDocs.runChecks(dir).some((e: string) => e.startsWith('package.json:'))).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('makePathExists', () => {
    it('accepts gitignored generated paths that are absent from a clean checkout', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-git-'));
      try {
        require('child_process').execFileSync('git', ['init', '-q', dir]);
        fs.writeFileSync(path.join(dir, '.gitignore'), 'src/gen/\n');
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'real.ts'), '');
        const exists = checkDocs.makePathExists(dir);
        expect(exists('src/real.ts')).toBe(true);
        expect(exists('src/gen')).toBe(true);
        expect(exists('src/missing.ts')).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the file system outside a git repository', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-nogit-'));
      try {
        fs.writeFileSync(path.join(dir, 'a.md'), '');
        const exists = checkDocs.makePathExists(dir);
        expect(exists('a.md')).toBe(true);
        expect(exists('src/gen')).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('runChecks is clean on the real repo', () => {
    expect(checkDocs.runChecks(path.resolve(__dirname, '../../..'))).toEqual([]);
  });
});
