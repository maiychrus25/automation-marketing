import assert from 'node:assert';
import { MAX_IMAGE_BYTES, acceptDroppedMedia, dedupePaths, extensionOf, isVideo, validateMediaSelection } from '../../services/facebookPoster/mediaRules';

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

describe('acceptDroppedMedia', () => {
  test('lọc đuôi hợp lệ, bỏ trùng (có sẵn + trùng nhau), giữ size', () => {
    const existing = [{ path: '/a/x.jpg', size: 10 }];
    const dropped = [
      { path: '/a/x.jpg', size: 10 },   // trùng existing → bỏ
      { path: '/a/y.png', size: 20 },   // mới, hợp lệ
      { path: '/a/y.png', size: 20 },   // trùng trong batch → bỏ
      { path: '/a/doc.pdf', size: 5 },  // đuôi không hỗ trợ → bỏ
      { path: '/a/clip.mp4', size: 30 },// video hợp lệ
    ];
    assert.deepStrictEqual(acceptDroppedMedia(dropped, existing), [{ path: '/a/y.png', size: 20 }, { path: '/a/clip.mp4', size: 30 }]);
  });
  test('path rỗng → bỏ', () => {
    assert.deepStrictEqual(acceptDroppedMedia([{ path: '', size: 1 }], []), []);
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
