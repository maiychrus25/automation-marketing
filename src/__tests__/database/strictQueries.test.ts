import * as fs from 'fs';
import * as path from 'path';

// DatabaseService cannot be loaded in Jest (it imports electron): pin the two query families by their source.
const source = fs.readFileSync(path.join(__dirname, '../../services/database/DatabaseService.ts'), 'utf8');
const body = (signature: string) => {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n    }\n', start));
};

describe('DatabaseService query variants', () => {
  test('queryAndQueryOneStillSwallowErrors', () => {
    expect(body('public query<T>(')).toMatch(/catch[\s\S]*return \[\]/);
    expect(body('queryOne<T>(sql: string')).toMatch(/catch[\s\S]*return undefined/);
  });
  test('theStrictVariantsDoNotCatch', () => {
    expect(body('public queryStrict<T>(')).not.toMatch(/catch|try/);
    expect(body('public queryOneStrict<T>(')).not.toMatch(/catch|try/);
  });
});
