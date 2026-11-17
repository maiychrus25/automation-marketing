// Store gia: chi `mode` va `bossUrl`. Chay that toLocalMediaUrl.
const state = { mode: 'standalone', bossUrl: '' };
const accounts: any[] = [
  { zalo_id: 'tg1', channel: 'telegram_user' }, { zalo_id: 'bot1', channel: 'telegram_bot' },
  { zalo_id: 'zl1', channel: 'zalo' }, { zalo_id: 'fb1', channel: 'facebook' },
];
jest.mock('../../ui/store/employeeStore', () => ({ useEmployeeStore: { getState: () => state } }));
jest.mock('../../ui/store/accountStore', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));

import { toLocalMediaUrl, toDiskMediaUrl, bossTelegramMediaUrl } from '../../ui/lib/localMedia';

const BOSS = 'https://boss.example:9900';
const asEmployee = () => { state.mode = 'employee'; state.bossUrl = BOSS; };
const asBoss = () => { state.mode = 'standalone'; state.bossUrl = ''; };

describe('toLocalMediaUrl on an employee machine', () => {
  beforeEach(asEmployee);

  it('turns a boss avatar local-media URL into the boss media URL', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/_avatars/telegram/u1.jpg')).toBe(`${BOSS}/api/media/_avatars/telegram/u1.jpg`);
  });
  it('turns the legacy media://local avatar into the boss media URL', () => {
    expect(toLocalMediaUrl('media://local//Users/boss/data/media/_avatars/telegram/u1.jpg')).toBe(`${BOSS}/api/media/_avatars/telegram/u1.jpg`);
  });
  it('handles a Windows boss path', () => {
    expect(toLocalMediaUrl('local-media:///C:/Users/boss/data/media/_avatars/telegram/u1.jpg')).toBe(`${BOSS}/api/media/_avatars/telegram/u1.jpg`);
  });
  it('turns a raw sticker path into the boss media URL (existing branch)', () => {
    expect(toLocalMediaUrl('/Users/boss/data/media/tg1/stickers/sticker_9.webp')).toBe(`${BOSS}/api/media/tg1/stickers/sticker_9.webp`);
  });
  it('turns a Telegram account folder (user or bot) into the boss URL', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/tg1/images/x.jpg')).toBe(`${BOSS}/api/media/tg1/images/x.jpg`);
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/tg1/stickers/sticker_9.webp')).toBe(`${BOSS}/api/media/tg1/stickers/sticker_9.webp`);
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/bot1/images/x.jpg')).toBe(`${BOSS}/api/media/bot1/images/x.jpg`);
  });
  it('leaves the same folder shape alone for a Zalo, Facebook or unknown account', () => {
    for (const id of ['zl1', 'fb1', 'nobody']) {
      expect(toLocalMediaUrl(`local-media:///Users/boss/data/media/${id}/images/x.jpg`)).toBe(`local-media:///Users/boss/data/media/${id}/images/x.jpg`);
    }
  });
  it('leaves an employee-local file in a media folder alone', () => {
    expect(toLocalMediaUrl('local-media:///Users/x/media/photo.jpg')).toBe('local-media:///Users/x/media/photo.jpg');
    expect(toLocalMediaUrl('local-media:///Users/x/_uploads/tg1/a.jpg')).toBe('local-media:///Users/x/_uploads/tg1/a.jpg');
    expect(toLocalMediaUrl('local-media:///Users/x/avatar/a.jpg')).toBe('local-media:///Users/x/avatar/a.jpg');
  });
  it('refuses a path with a .. segment', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/_avatars/telegram/../../../secret.db')).toBe('local-media:///Users/boss/data/media/_avatars/telegram/../../../secret.db');
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/tg1/../zl1/a.jpg')).toBe('local-media:///Users/boss/data/media/tg1/../zl1/a.jpg');
  });
  it('encodes # ? % and spaces in each segment', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/_avatars/telegram/a b#1?x%.jpg')).toBe(`${BOSS}/api/media/_avatars/telegram/a%20b%231%3Fx%25.jpg`);
  });
  it('uses the part after the LAST media folder', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/media/data/media/_avatars/telegram/u.jpg')).toBe(`${BOSS}/api/media/_avatars/telegram/u.jpg`);
  });
  it('leaves a local-media path that is not in a boss media folder alone', () => {
    expect(toLocalMediaUrl('local-media:///Users/me/Downloads/a.png')).toBe('local-media:///Users/me/Downloads/a.png');
  });
  it('turns the legacy media://local form of a non-boss path into local-media as before', () => {
    expect(toLocalMediaUrl('media://local//Users/x/media/photo.jpg')).toBe('local-media:///Users/x/media/photo.jpg');
  });
  it('leaves http URLs alone', () => {
    expect(toLocalMediaUrl('https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
  });
  it('keeps the local-media URL when the boss address is unknown', () => {
    state.bossUrl = '';
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/_avatars/telegram/u1.jpg')).toBe('local-media:///Users/boss/data/media/_avatars/telegram/u1.jpg');
  });
});

describe('toLocalMediaUrl for a boss or standalone app is unchanged', () => {
  beforeEach(asBoss);

  it('keeps a local-media URL as it is', () => {
    expect(toLocalMediaUrl('local-media:///Users/boss/data/media/_avatars/telegram/u1.jpg')).toBe('local-media:///Users/boss/data/media/_avatars/telegram/u1.jpg');
  });
  it('turns media://local into local-media', () => {
    expect(toLocalMediaUrl('media://local//Users/boss/data/media/a.jpg')).toBe('local-media:///Users/boss/data/media/a.jpg');
    expect(toLocalMediaUrl('media://local/C:\\data\\media\\a.jpg')).toBe('local-media:///C:/data/media/a.jpg');
  });
  it('turns a raw path into local-media and strips file://', () => {
    expect(toLocalMediaUrl('/Users/boss/data/media/acc1/a.jpg')).toBe('local-media:///Users/boss/data/media/acc1/a.jpg');
    expect(toLocalMediaUrl('file:///Users/boss/a.jpg')).toBe('local-media:///Users/boss/a.jpg');
  });
  it('returns an empty string for an empty path', () => {
    expect(toLocalMediaUrl('')).toBe('');
  });
  it.each([
    ['http://h/a.jpg', 'http://h/a.jpg'],
    ['https://h/a.jpg', 'https://h/a.jpg'],
    ['local-media:///Users/b/media/tg1/images/x.jpg', 'local-media:///Users/b/media/tg1/images/x.jpg'],
    ['local-media:///Users/b/media/_avatars/telegram/a b#.jpg', 'local-media:///Users/b/media/_avatars/telegram/a b#.jpg'],
    ['media://local/C:\\data\\media\\a.jpg', 'local-media:///C:/data/media/a.jpg'],
    ['/Users/b/media/tg1/a.jpg', 'local-media:///Users/b/media/tg1/a.jpg'],
    ['C:\\Users\\b\\a.jpg', 'local-media:///C:/Users/b/a.jpg'],
      ])('boss mode %s -> %s', (input, out) => {
    expect(toLocalMediaUrl(input)).toBe(out);
  });
});

describe('bossTelegramMediaUrl', () => {
  const ids = new Set(['tg1']);
  it('needs a boss address and a media folder', () => {
    expect(bossTelegramMediaUrl('/a/media/tg1/x.jpg', '', ids)).toBeNull();
    expect(bossTelegramMediaUrl('/a/tg1/x.jpg', BOSS, ids)).toBeNull();
    expect(bossTelegramMediaUrl('/a/media/tg1', BOSS, ids)).toBeNull();
    expect(bossTelegramMediaUrl('/a/media/_avatars/telegram', BOSS, ids)).toBeNull();
    expect(bossTelegramMediaUrl('/a/media/tg1//x.jpg', BOSS, ids)).toBeNull();
  });
  it('accepts Windows separators', () => {
    expect(bossTelegramMediaUrl('/C:\\d\\media\\tg1\\x.jpg', BOSS, ids)).toBe(`${BOSS}/api/media/tg1/x.jpg`);
  });
});

describe('V6/V7 localMedia', () => {
  it.each(['data:image/png;base64,AAAA', 'blob:https://x/1234'])('returns %s unchanged in boss and employee mode', (value) => {
    asBoss();
    expect(toLocalMediaUrl(value)).toBe(value);
    asEmployee();
    expect(toLocalMediaUrl(value)).toBe(value);
  });

  it('encodes a raw path with a space, percent, hash and question mark so the boss decodes the original relative path', () => {
    asEmployee();
    const name = 'sale 50% #1?.jpg';
    const url = toLocalMediaUrl(`/Users/boss/data/media/acc-a/2026-01-01/${name}`);
    expect(url).toBe(`${BOSS}/api/media/acc-a/2026-01-01/${encodeURIComponent(name)}`);
    expect(decodeURIComponent(new URL(url).pathname.replace('/api/media/', ''))).toBe(`acc-a/2026-01-01/${name}`);
  });

  it('encodes the other raw-path branches too (avatar folder, no-media fallback with an account)', () => {
    asEmployee();
    expect(toLocalMediaUrl('/x/avatar/acc-a/my pic.png')).toBe(`${BOSS}/api/avatar/acc-a/my%20pic.png`);
    expect(toLocalMediaUrl('/tmp/some dir/Ảnh 1.png', 'acc-a')).toBe(`${BOSS}/api/media/acc-a/misc/${encodeURIComponent('Ảnh 1.png')}`);
  });

  it('keeps the boss result unchanged', () => {
    asBoss();
    expect(toLocalMediaUrl('/Users/boss/data/media/acc-a/x y.jpg')).toBe('local-media:///Users/boss/data/media/acc-a/x y.jpg');
  });
});

describe('toDiskMediaUrl (a file picked on this machine)', () => {
  it('uses the local scheme on an employee machine, where toLocalMediaUrl points at the boss', () => {
    asEmployee();
    expect(toDiskMediaUrl('/Users/nv/Pictures/a.jpg')).toBe('local-media:///Users/nv/Pictures/a.jpg');
    expect(toDiskMediaUrl('C:\\Users\\nv\\b.mp4')).toBe('local-media:///C:/Users/nv/b.mp4');
    asBoss();
  });
  it('gives a boss the same URL as toLocalMediaUrl', () => {
    asBoss();
    for (const p of ['/Users/boss/a.jpg', 'C:\\x\\b.png', 'file:///Users/boss/c.jpg']) expect(toDiskMediaUrl(p)).toBe(toLocalMediaUrl(p));
  });
});
