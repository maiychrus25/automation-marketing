import { firstSaveFailure } from '../../ui/lib/employeeSaveSteps';

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
