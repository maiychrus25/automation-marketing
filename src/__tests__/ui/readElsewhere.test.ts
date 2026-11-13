import { unreadAfterReadElsewhere } from '../../ui/lib/chat/readElsewhere';

describe('unreadAfterReadElsewhere', () => {
  it.each([
    [5, 0, 0],
    [5, 2, 2],
    [3, '1', 1],
    [2, 5, null],
    [2, 2, null],
    [0, 0, null],
    [undefined, 0, null],
    [3, -1, null],
    [3, NaN, null],
    [3, 1.5, null],
  ])('current %p incoming %p gives %p', (current, incoming, expected) => {
    expect(unreadAfterReadElsewhere(current, incoming)).toBe(expected);
  });
});
