import { firstSaveFailure, joinNotice, pausedNotice, pausedOf } from '../../ui/lib/employeeSaveSteps';

const ok = async () => ({ success: true });
const calls: string[] = [];
const step = (name: string, run: () => Promise<any>, fallback = `${name} thất bại`) => ({ run: async () => { calls.push(name); return run(); }, fallback });

describe('firstSaveFailure', () => {
  beforeEach(() => { calls.length = 0; });

  it('returns null and runs every step in order when all succeed', async () => {
    expect(await firstSaveFailure([step('a', ok), step('b', ok), step('c', async () => undefined)])).toBeNull();
    expect(calls).toEqual(['a', 'b', 'c']);
  });
  it('stops at the first success:false and returns its error text', async () => {
    expect(await firstSaveFailure([step('a', ok), step('b', async () => ({ success: false, error: 'Không đủ quyền' })), step('c', ok)])).toBe('Không đủ quyền');
    expect(calls).toEqual(['a', 'b']);
  });
  it('falls back to the step text when the result has no error', async () => {
    expect(await firstSaveFailure([step('a', async () => ({ success: false }), 'Lưu quyền thất bại')])).toBe('Lưu quyền thất bại');
  });
  it('turns a thrown error into its message, or the fallback when it has none', async () => {
    expect(await firstSaveFailure([step('a', async () => { throw new Error('Mất kết nối'); })])).toBe('Mất kết nối');
    expect(await firstSaveFailure([step('a', async () => { throw {}; }, 'Gán hồ sơ thất bại')])).toBe('Gán hồ sơ thất bại');
  });
});

test('pausedOf reads a positive count and ignores anything else', () => {
  expect(pausedOf({ success: true, pausedSchedules: 3 })).toBe(3);
  expect(pausedOf({ success: true })).toBe(0);
  expect(pausedOf({ pausedSchedules: -1 })).toBe(0);
  expect(pausedOf({ pausedSchedules: '2' })).toBe(0);
  expect(pausedOf(undefined)).toBe(0);
  expect(pausedOf({ pausedSchedules: NaN })).toBe(0);
  expect(pausedOf({ pausedSchedules: Infinity })).toBe(0);
});

test('pausedNotice names the count and the employee, or is null', () => {
  expect(pausedNotice(2, 'An')).toBe('Đã tạm dừng 2 lịch đăng của An. Bật lại trong Lịch đăng nếu bạn muốn giữ.');
  expect(pausedNotice(0, 'An')).toBeNull();
  expect(pausedNotice(-1, 'An')).toBeNull();
});

test('firstSaveFailure hands every result to onResult until the first failure', async () => {
  const seen: unknown[] = [];
  const out = await firstSaveFailure([
    { run: async () => ({ success: true, pausedSchedules: 1 }), fallback: 'a' },
    { run: async () => ({ success: false, error: 'boom' }), fallback: 'b' },
    { run: async () => ({ success: true, pausedSchedules: 5 }), fallback: 'c' },
  ], (r) => seen.push(r));
  expect(out).toBe('boom');
  expect(seen).toHaveLength(2);
});

test('joinNotice joins two sentences without a doubled full stop', () => {
  expect(joinNotice('Lưu thất bại', 'Đã tạm dừng 1 lịch.')).toBe('Lưu thất bại. Đã tạm dừng 1 lịch.');
  expect(joinNotice('Lưu thất bại.', 'Đã tạm dừng 1 lịch.')).toBe('Lưu thất bại. Đã tạm dừng 1 lịch.');
  expect(joinNotice('Lưu thất bại  ', 'x')).toBe('Lưu thất bại. x');
  expect(joinNotice('Đã xóa', null)).toBe('Đã xóa');
});
