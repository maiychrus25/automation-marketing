import assert from 'node:assert';
import { MAX_IMAGE_BYTES, dedupePaths, extensionOf, isVideo, validateMediaSelection } from '../../services/facebookPoster/mediaRules';

const img = (name: string, size = 1) => ({ path: `/a/${name}`, size });
const images = (n: number, size = 1) => Array.from({ length: n }, (_, i) => img(`${i}.jpg`, size));

describe('validateMediaSelection', () => {
  test('empty and up to 10 images are valid', () => {
    assert.strictEqual(validateMediaSelection([]), null);
    assert.strictEqual(validateMediaSelection(images(10)), null);
  });
  test('11 images', () => assert.strictEqual(validateMediaSelection(images(11)), 'Tối đa 10 ảnh mỗi bài'));
  test('video rules', () => {
    const msg = 'Một bài chỉ có 1 video, không kèm ảnh khác';
    assert.strictEqual(validateMediaSelection([{ path: '/a/v.mp4', size: 1 }]), null);
    assert.strictEqual(validateMediaSelection([{ path: '/a/v.mp4', size: 1 }, img('a.jpg')]), msg);
    assert.strictEqual(validateMediaSelection([{ path: '/a/v.mp4', size: 1 }, { path: '/a/w.mov', size: 1 }]), msg);
  });
  test('unsupported extension', () => {
    assert.strictEqual(validateMediaSelection([{ path: '/a/doc.txt', size: 1 }]), 'Chỉ hỗ trợ ảnh/video: jpg, jpeg, png, gif, webp, mp4, mov, webm');
  });
  test('size limits', () => {
    assert.strictEqual(validateMediaSelection([img('big.jpg', MAX_IMAGE_BYTES + 1)]), 'Ảnh "big.jpg" lớn hơn 20 MB');
    assert.strictEqual(validateMediaSelection(images(6, 18 * 1024 * 1024)), 'Tổng dung lượng ảnh vượt 100 MB');
  });
});

describe('helpers', () => {
  test('dedupePaths keeps first occurrence', () => assert.deepStrictEqual(dedupePaths(['a', 'b', 'a']), ['a', 'b']));
  test('extensionOf / isVideo', () => {
    assert.strictEqual(extensionOf('/x/Y.JPG'), 'jpg');
    assert.strictEqual(extensionOf('/x/noext'), '');
    assert.strictEqual(isVideo('/x/a.MP4'), true);
    assert.strictEqual(isVideo('/x/a.jpg'), false);
  });
});
