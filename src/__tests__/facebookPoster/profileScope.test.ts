import {
  PROFILE_SCOPE_PARAM, profileIdsOfStoredParams, isWithinScope, readProfileScope,
} from '../../services/facebookPoster/profileScope';

describe('profileIdsOfStoredParams', () => {
  test('unionOfProfilesProfileIdsAndProfileIdFromJsonOrObject', () => {
    const obj = { profiles: [{ profileId: 'a' }], profileIds: ['b', 'a'], profileId: 'c' };
    expect(profileIdsOfStoredParams(JSON.stringify(obj)).sort()).toEqual(['a', 'b', 'c']);
    expect(profileIdsOfStoredParams(obj).sort()).toEqual(['a', 'b', 'c']);
  });
  test('brokenJsonGivesNothing', () => {
    expect(profileIdsOfStoredParams('{nope')).toEqual([]);
    expect(profileIdsOfStoredParams(null)).toEqual([]);
    expect(profileIdsOfStoredParams('[1]')).toEqual([]);
  });
});

describe('isWithinScope', () => {
  test('undefinedScopeMeansTheBossAndPasses', () => expect(isWithinScope(['a'], undefined)).toBe(true));
  test('noProfilesIsRefusedUnderAScope', () => expect(isWithinScope([], ['a'])).toBe(false));
  test('allInsidePasses', () => expect(isWithinScope(['a', 'b'], ['a', 'b', 'c'])).toBe(true));
  test('oneMissingIsRefused', () => expect(isWithinScope(['a', 'x'], ['a', 'b'])).toBe(false));
});

describe('readProfileScope', () => {
  test('needsFromRelayTrue', () => {
    expect(readProfileScope({ _fromRelay: true, [PROFILE_SCOPE_PARAM]: ['a'] })).toEqual(['a']);
    expect(readProfileScope({ [PROFILE_SCOPE_PARAM]: ['a'] })).toBeUndefined();
    expect(readProfileScope({ _fromRelay: 1, [PROFILE_SCOPE_PARAM]: ['a'] })).toBeUndefined();
  });
  test('needsAnArrayOfStrings', () => {
    expect(readProfileScope({ _fromRelay: true, _profileScope: 'a' })).toBeUndefined();
    expect(readProfileScope({ _fromRelay: true, _profileScope: ['a', 1] })).toBeUndefined();
    expect(readProfileScope(null)).toBeUndefined();
  });
});
