import { isTelegramChannelName, isTelegramRelayPayload, telegramAccountIdsFrom } from '../../services/http/telegramRelayEvents';

const none = new Set<string>();

describe('isTelegramChannelName', () => {
  it('accepts the two Telegram channels only', () => {
    expect(isTelegramChannelName('telegram_user')).toBe(true);
    expect(isTelegramChannelName('telegram_bot')).toBe(true);
    for (const v of ['zalo', 'facebook', '', null, undefined, 3, {}]) expect(isTelegramChannelName(v)).toBe(false);
  });
});

describe('isTelegramRelayPayload', () => {
  it('detects the channel at the top level, in message and in message.data', () => {
    expect(isTelegramRelayPayload({ channel: 'telegram_user' }, none)).toBe(true);
    expect(isTelegramRelayPayload({ message: { channel: 'telegram_bot' } }, none)).toBe(true);
    expect(isTelegramRelayPayload({ message: { data: { channel: 'telegram_user' } } }, none)).toBe(true);
  });

  it('detects a known Telegram account id', () => {
    expect(isTelegramRelayPayload({ zaloId: 'tg-1' }, new Set(['tg-1']))).toBe(true);
    expect(isTelegramRelayPayload({ zaloId: 'tg-2' }, new Set(['tg-1']))).toBe(false);
  });

  it('is false for Zalo and Facebook payloads', () => {
    expect(isTelegramRelayPayload({ zaloId: 'z1', message: { data: { content: 'x' } } }, new Set(['tg-1']))).toBe(false);
    expect(isTelegramRelayPayload({ zaloId: 'z1', channel: 'zalo', message: { channel: 'zalo' } }, none)).toBe(false);
    expect(isTelegramRelayPayload({ fbAccountId: 'p1', message: { body: 'x' } }, none)).toBe(false);
  });

  it('is false for non-object payloads', () => {
    for (const v of [null, undefined, 'telegram_user', 5, ['telegram_user'], [{ channel: 'telegram_user' }]]) {
      expect(isTelegramRelayPayload(v, new Set(['telegram_user']))).toBe(false);
    }
  });
});

describe('telegramAccountIdsFrom', () => {
  it('keeps the ids of Telegram rows only and tolerates junk', () => {
    const ids = telegramAccountIdsFrom([
      { zalo_id: 'tg-1', channel: 'telegram_user' }, { zalo_id: 'tg-2', channel: 'telegram_bot' },
      { zalo_id: 'z1', channel: 'zalo' }, { zalo_id: 'f1' }, null, 'x', { channel: 'telegram_bot' },
    ]);
    expect([...ids].sort()).toEqual(['tg-1', 'tg-2']);
    expect(telegramAccountIdsFrom(undefined).size).toBe(0);
  });
});
