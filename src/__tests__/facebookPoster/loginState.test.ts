import assert from 'node:assert';
import { isLoggedIn } from '../../services/facebookPoster/loginState';

/** Context giả, chỉ cần đúng phương thức cookies() mà isLoggedIn dùng. */
function fakeCtx(cookies: Array<{ name: string; value: string }>) {
  return { cookies: async () => cookies } as any;
}

test('không có cookie c_user thì coi là chưa đăng nhập', async () => {
  assert.strictEqual(await isLoggedIn(fakeCtx([])), false);
  assert.strictEqual(
    await isLoggedIn(fakeCtx([{ name: 'datr', value: 'x' }])), false);
});

test('c_user rỗng thì vẫn coi là chưa đăng nhập', async () => {
  assert.strictEqual(
    await isLoggedIn(fakeCtx([{ name: 'c_user', value: '' }])), false);
});

test('có c_user thì coi là đã đăng nhập', async () => {
  assert.strictEqual(
    await isLoggedIn(fakeCtx([{ name: 'c_user', value: '100012345' }])), true);
});
