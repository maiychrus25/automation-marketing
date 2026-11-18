import { becameInactive, removedProfileIds, revokedFbPoster } from '../../services/employee/revocation';

test('removedProfileIds is previous minus next', () => {
  expect(removedProfileIds(['a', 'b'], ['b', 'c'])).toEqual(['a']);
  expect(removedProfileIds(['a'], ['a', 'b'])).toEqual([]);
  expect(removedProfileIds(['a'], ['a'])).toEqual([]);
  expect(removedProfileIds([], ['a'])).toEqual([]);
  expect(removedProfileIds(['a', 'b'], [])).toEqual(['a', 'b']);
});

test('revokedFbPoster only when held before and not after', () => {
  expect(revokedFbPoster({ fb_poster: true }, { fb_poster: false })).toBe(true);
  expect(revokedFbPoster({ fb_poster: true }, {})).toBe(true);
  expect(revokedFbPoster({ fb_poster: true }, { fb_poster: true })).toBe(false);
  expect(revokedFbPoster({ fb_poster: false }, { fb_poster: false })).toBe(false);
  expect(revokedFbPoster({}, { chat: true })).toBe(false);
});

test('becameInactive only for active -> inactive', () => {
  expect(becameInactive(1, 0)).toBe(true);
  expect(becameInactive(true, 0)).toBe(true);
  expect(becameInactive(1, undefined)).toBe(false);
  expect(becameInactive(1, 1)).toBe(false);
  expect(becameInactive(0, 0)).toBe(false);
  expect(becameInactive(undefined, 0)).toBe(false);
});
