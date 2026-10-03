import assert from 'node:assert';
import { normalizeTarget, parseFacebookUrl, pickDelaySeconds } from '../../services/facebookPoster/targets';

test('id thuần được ghép thành URL group', () => {
  assert.deepStrictEqual(normalizeTarget('1234567890'), {
    url: 'https://www.facebook.com/groups/1234567890/',
    kind: 'group',
  });
});

test('URL chứa /groups/ được giữ nguyên và nhận là group', () => {
  const u = 'https://www.facebook.com/groups/abc';
  assert.deepStrictEqual(normalizeTarget(u), { url: u, kind: 'group' });
});

test('URL không chứa /groups/ được nhận là page', () => {
  const u = 'https://www.facebook.com/MyPage';
  assert.deepStrictEqual(normalizeTarget(u), { url: u, kind: 'page' });
});

test('khoảng trắng thừa được cắt bỏ', () => {
  assert.strictEqual(normalizeTarget('  9999  ').url,
    'https://www.facebook.com/groups/9999/');
});

test('target rỗng thì ném lỗi', () => {
  assert.throws(() => normalizeTarget('   '), /rỗng/);
  assert.throws(() => normalizeTarget(null), /rỗng/);
});

test('delay luôn nằm trong khoảng min-max', () => {
  for (let i = 0; i < 300; i += 1) {
    const d = pickDelaySeconds(30, 60);
    assert.ok(d >= 30 && d <= 60, `d=${d} ngoài khoảng`);
  }
});

test('delay chịu được trường hợp min lớn hơn max', () => {
  for (let i = 0; i < 50; i += 1) {
    const d = pickDelaySeconds(60, 30);
    assert.ok(d >= 30 && d <= 60, `d=${d} ngoài khoảng`);
  }
});

test('parseFacebookUrl chỉ nhận https và host facebook.com', () => {
  assert.ok(parseFacebookUrl('https://facebook.com/groups/x'));
  assert.ok(parseFacebookUrl('https://m.facebook.com/groups/x'));
  assert.ok(parseFacebookUrl('https://www.facebook.com/groups/x'));
  for (const bad of ['https://evil.com/groups/x', 'https://www.facebook.com.evil.com/groups/x', 'https://evilfacebook.com/x',
    'http://www.facebook.com/groups/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
    assert.strictEqual(parseFacebookUrl(bad), null, bad);
  }
});

test('normalizeTarget từ chối URL không phải Facebook', () => {
  assert.throws(() => normalizeTarget('https://evil.com/groups/x'), /Đích không hợp lệ: https:\/\/evil.com\/groups\/x/);
  assert.throws(() => normalizeTarget('https://www.facebook.com.evil.com/groups/x'), /Đích không hợp lệ/);
  assert.throws(() => normalizeTarget('http://www.facebook.com/groups/x'), /Đích không hợp lệ/);
  assert.deepStrictEqual(normalizeTarget('https://m.facebook.com/groups/x'), { url: 'https://m.facebook.com/groups/x', kind: 'group' });
});
