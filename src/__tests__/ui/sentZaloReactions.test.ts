import { rememberSentZaloReaction, takeSentZaloReaction, windowShowsReaction, reactionsSnapshot, SENT_REACTION_TTL_MS } from '../../ui/lib/chat/sentZaloReactions';

describe('reactions sent from this window', () => {
  test('anEchoMatchesTheReactionSentOnce', () => {
    rememberSentZaloReaction('z1', 'm1', '❤️', 1000);
    expect(takeSentZaloReaction('z1', 'm1', '❤️', 2000)).toBe(true);
    expect(takeSentZaloReaction('z1', 'm1', '❤️', 2000)).toBe(false);
  });

  test('aDifferentEmojiOrMessageIsNotTheSameSend', () => {
    rememberSentZaloReaction('z1', 'm2', '❤️', 1000);
    expect(takeSentZaloReaction('z1', 'm2', '😆', 1000)).toBe(false);
    expect(takeSentZaloReaction('z1', 'm3', '❤️', 1000)).toBe(false);
    expect(takeSentZaloReaction('z2', 'm2', '❤️', 1000)).toBe(false);
  });

  test('twoTapsAreMatchedByTwoEchoes', () => {
    rememberSentZaloReaction('z1', 'm4', '❤️', 1000);
    rememberSentZaloReaction('z1', 'm4', '❤️', 1100);
    expect(takeSentZaloReaction('z1', 'm4', '❤️', 1200)).toBe(true);
    expect(takeSentZaloReaction('z1', 'm4', '❤️', 1200)).toBe(true);
    expect(takeSentZaloReaction('z1', 'm4', '❤️', 1200)).toBe(false);
  });

  test('anOldSendNoLongerMatches', () => {
    rememberSentZaloReaction('z1', 'm5', '❤️', 1000);
    expect(takeSentZaloReaction('z1', 'm5', '❤️', 1000 + SENT_REACTION_TTL_MS + 1)).toBe(false);
  });
});

describe('does the window already show a reaction', () => {
  test('readsTheStoredShapeAndTheJsonText', () => {
    const reactions = { total: 1, lastReact: '❤️', emoji: { '❤️': { total: 1, users: { me: 1 } } } };
    expect(windowShowsReaction(reactions, 'me', '❤️')).toBe(true);
    expect(windowShowsReaction(JSON.stringify(reactions), 'me', '❤️')).toBe(true);
    expect(windowShowsReaction(reactions, 'me', '😆')).toBe(false);
    expect(windowShowsReaction(reactions, 'other', '❤️')).toBe(false);
  });

  test('nothingStoredMeansNotShown', () => {
    expect(windowShowsReaction(undefined, 'me', '❤️')).toBe(false);
    expect(windowShowsReaction('not json', 'me', '❤️')).toBe(false);
  });
});

describe('the reactions to restore when Zalo refuses a new one', () => {
  test('keepsEveryEarlierReactionAsItWas', () => {
    const before = { total: 1, lastReact: '❤️', emoji: { '❤️': { total: 1, users: { me: 1 } } } };
    expect(reactionsSnapshot(before)).toEqual(before);
    expect(reactionsSnapshot(JSON.stringify(before))).toEqual(before);
  });

  test('isACopyNotTheLiveObject', () => {
    const before = { total: 1, lastReact: '❤️', emoji: { '❤️': { total: 1, users: { me: 1 } } } };
    const snap = reactionsSnapshot(before);
    before.emoji['❤️'].users.me = 5;
    expect(snap.emoji['❤️'].users.me).toBe(1);
  });

  test('nothingStoredMeansNoReactions', () => {
    expect(reactionsSnapshot(undefined)).toEqual({ total: 0, lastReact: '', emoji: {} });
    expect(reactionsSnapshot('not json')).toEqual({ total: 0, lastReact: '', emoji: {} });
  });
});
