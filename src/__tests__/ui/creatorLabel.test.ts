import { creatorLine } from '../../ui/features/facebookPoster/creatorLabel';

test('creatorLine shows the display name, the deleted notice, or nothing', () => {
  const names = new Map([['e1', 'An']]);
  expect(creatorLine('e1', names)).toBe('Tạo bởi: An');
  expect(creatorLine('gone', names)).toBe('Tạo bởi: nhân viên đã xoá');
  expect(creatorLine(null, names)).toBeNull();
  expect(creatorLine(undefined, names)).toBeNull();
  expect(creatorLine('e1', null)).toBeNull();
});
