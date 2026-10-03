import assert from 'node:assert';
import { COMPOSER_INVITE } from '../../services/facebookPoster/postToTargets';

const re = () => new RegExp(COMPOSER_INVITE, 'i');

test('nhận lời mời soạn bài đã đo trên trang thật', () => {
  for (const text of [
    'Bạn viết gì đi...',                       // nhóm, tiếng Việt, đo 02/10/2026
    'Media Soec ơi, bạn đang nghĩ gì thế?',    // Page, tiếng Việt, đo 30/09/2026
    'Lữ ơi, bạn đang nghĩ gì thế?',            // cá nhân, tiếng Việt
    "What's on your mind, Media Soec?",        // tiếng Anh
    'Write something...',
    'Viết gì đó...',
  ]) assert.ok(re().test(text), text);
});

test('không nhận nhầm ô bình luận hay nút khác', () => {
  for (const text of ['Bình luận dưới tên Lữ', 'Viết bình luận', 'Bài viết ẩn danh', 'Chia sẻ'])
    assert.ok(!re().test(text), text);
});
