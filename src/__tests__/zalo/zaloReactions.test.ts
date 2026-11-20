import { Reactions } from 'zca-js';
import { zaloReactionEchoPlan, zaloReactionForEmoji, zaloReactionIconToEmoji, persistsReactionBeforeEcho, ZALO_REACTION_KEY_TO_ICON } from '../../utils/zaloReactions';

describe('Zalo reaction codes', () => {
  // Every emoji the app's Zalo pickers offer, and the emoji Zalo echoes back for it.
  const offered: Array<[string, string]> = [
    ['❤️', '❤️'], ['😆', '😆'], ['😄', '😆'], ['😮', '😮'], ['😯', '😮'], ['😢', '😢'], ['😡', '😡'], ['👍', '👍'],
    ['😘', '😘'], ['😂', '😂'], ['💩', '💩'], ['🌹', '🌹'], ['💔', '💔'], ['👎', '👎'], ['😍', '😍'], ['👌', '👌'],
    ['✌️', '✌️'], ['🙏', '🙏'], ['😉', '😉'], ['👋', '👋'], ['🫶', '🫶'], ['😭', '😭'], ['😕', '😕'], ['😁', '😁'],
    ['👊', '👊'], ['😎', '😎'], ['🎂', '🎂'],
  ];

  test.each(offered)('%s is sent with a Zalo code that comes back as %s', (picked, shown) => {
    const r = zaloReactionForEmoji(picked);
    expect(r).not.toBeNull();
    expect(r!.emoji).toBe(shown);
    expect(zaloReactionIconToEmoji(r!.icon)).toBe(shown);
  });

  test('everySendCodeIsTheZaloLibrarysOwnCode', () => {
    for (const [key, icon] of Object.entries(ZALO_REACTION_KEY_TO_ICON)) expect([key, icon]).toEqual([key, (Reactions as any)[key]]);
  });

  test('laughingEmojiIsSentAsHahaNotAsHeart', () => {
    expect(zaloReactionForEmoji('😆')).toEqual({ key: 'HAHA', icon: ':>', emoji: '😆' });
    expect(zaloReactionForEmoji('😯')).toEqual({ key: 'WOW', icon: ':o', emoji: '😮' });
  });

  test('anEmojiZaloHasNoReactionForIsNotSent', () => {
    expect(zaloReactionForEmoji('🦄')).toBeNull();
  });

  test('anUnknownIconIsShownAsReceived', () => {
    expect(zaloReactionIconToEmoji('/-unknown')).toBe('/-unknown');
  });
});

describe('what happens when Zalo echoes a reaction', () => {
  test('aReactionThisWindowSentAndStillShowsIsNotAddedAgain', () => {
    expect(zaloReactionEchoPlan({ sentHere: true, windowShowsIt: true, emoji: '❤️', employeeMode: false })).toEqual({ updateWindow: false, persist: true });
  });

  test('aReactionThisWindowSentButLostOnAConversationSwitchIsShownAgain', () => {
    expect(zaloReactionEchoPlan({ sentHere: true, windowShowsIt: false, emoji: '❤️', employeeMode: false })).toEqual({ updateWindow: true, persist: true });
  });

  test('anOwnReactionFromThePhoneOrAnotherMachineIsShown', () => {
    expect(zaloReactionEchoPlan({ sentHere: false, windowShowsIt: false, emoji: '❤️', employeeMode: false })).toEqual({ updateWindow: true, persist: true });
  });

  test('aRemovalIsAlwaysApplied', () => {
    expect(zaloReactionEchoPlan({ sentHere: false, windowShowsIt: false, emoji: '', employeeMode: false })).toEqual({ updateWindow: true, persist: true });
  });

  test('onlyTheBossMachineWritesTheDatabase', () => {
    expect(zaloReactionEchoPlan({ sentHere: false, windowShowsIt: false, emoji: '❤️', employeeMode: true }).persist).toBe(false);
  });
});

describe('when the chat window writes a reaction to the database', () => {
  test('aZaloReactionIsStoredFromItsEchoOnlyNotWhenClicked', () => {
    expect(persistsReactionBeforeEcho('zalo', false)).toBe(false);
    expect(persistsReactionBeforeEcho('zalo', true)).toBe(false);
    expect(persistsReactionBeforeEcho(undefined, false)).toBe(false); // no channel = Zalo, as in the chat window
  });

  test('otherChannelsKeepTheirCurrentRule', () => {
    expect(persistsReactionBeforeEcho('facebook', false)).toBe(true);
    expect(persistsReactionBeforeEcho('telegram_user', false)).toBe(true);
    expect(persistsReactionBeforeEcho('telegram_bot', true)).toBe(false);
    expect(persistsReactionBeforeEcho('facebook', true)).toBe(true);
  });
});
