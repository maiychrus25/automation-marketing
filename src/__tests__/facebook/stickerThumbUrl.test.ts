import { isFacebookStickerThumbUrl } from '../../services/facebook/pageSendHelpers';

describe('isFacebookStickerThumbUrl', () => {
  it.each([
    'https://scontent.xx.fbcdn.net/v/t39.1997-6/s.webp',
    'https://fbcdn.net/s.webp',
    'https://static.xx.facebook.com/s.png',
    'https://facebook.com/s.png',
  ])('accepts %s', (u) => expect(isFacebookStickerThumbUrl(u)).toBe(true));
  it.each([
    'http://scontent.xx.fbcdn.net/s.webp',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/s.webp',
    'https://fbcdn.net.evil.example/s.webp',
    'https://evilfbcdn.net/s.webp',
    'https://user:pw@scontent.fbcdn.net/s.webp',
    'https://scontent.fbcdn.net:8443/s.webp',
    'not a url', '', undefined, null, 42,
  ])('rejects %p', (u) => expect(isFacebookStickerThumbUrl(u)).toBe(false));
});
