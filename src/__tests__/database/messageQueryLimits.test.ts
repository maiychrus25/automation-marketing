import assert from 'node:assert';
import { clampMessagesQuery } from '../../services/database/messageQueryLimits';

describe('clampMessagesQuery', () => {
  test('defaults', () => assert.deepStrictEqual(clampMessagesQuery({}), { limit: 50, offset: 0, before: 0 }));
  test('limit', () => {
    assert.strictEqual(clampMessagesQuery({ limit: 0 }).limit, 50);
    assert.strictEqual(clampMessagesQuery({ limit: -5 }).limit, 50);
    assert.strictEqual(clampMessagesQuery({ limit: '120' }).limit, 120);
    assert.strictEqual(clampMessagesQuery({ limit: 1e9 }).limit, 5000);
    assert.strictEqual(clampMessagesQuery({ limit: 12.9 }).limit, 12);
    assert.strictEqual(clampMessagesQuery({ limit: NaN }).limit, 50);
  });
  test('offset', () => {
    assert.strictEqual(clampMessagesQuery({ offset: -3 }).offset, 0);
    assert.strictEqual(clampMessagesQuery({ offset: '7' }).offset, 7);
  });
  test('before', () => {
    assert.strictEqual(clampMessagesQuery({ before: 'x' }).before, 0);
    assert.strictEqual(clampMessagesQuery({ before: 1712345678901.5 }).before, 1712345678901);
  });
});
