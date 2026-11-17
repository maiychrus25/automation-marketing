import { sanitizeProfileIds } from '../../services/employee/profileAssignment';

describe('sanitizeProfileIds', () => {
  test('rejectsANonArray', () => {
    expect(sanitizeProfileIds('p1', ['p1'])).toBeNull();
    expect(sanitizeProfileIds(undefined, ['p1'])).toBeNull();
  });
  test('dropsNonStringsAndUnknownProfiles', () => {
    expect(sanitizeProfileIds(['p1', 5, null, 'gone', 'p2'], ['p1', 'p2'])).toEqual(['p1', 'p2']);
  });
});
