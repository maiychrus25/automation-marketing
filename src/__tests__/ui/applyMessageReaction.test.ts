import { applyMessageReaction } from '../../ui/lib/chat/applyMessageReaction';

const data = (emoji: Record<string, Record<string, number>>) => {
  const out: any = { total: 0, lastReact: '', emoji: {} };
  for (const [emo, users] of Object.entries(emoji)) {
    const total = Object.values(users).reduce((a, b) => a + b, 0);
    out.emoji[emo] = { total, users: { ...users } };
    out.total += total;
  }
  return out;
};

describe('applyMessageReaction', () => {
  // Lỗi thật 16/11/2026: thả tim rồi đổi sang like trong chat Facebook hiện cả hai.
  test('onePerUser_changingTheEmojiReplacesTheOldOne', () => {
    const r = applyMessageReaction(data({ '❤️': { me: 1, peer: 1 } }), 'me', '👍', true);
    expect(r.emoji).toEqual({ '❤️': { total: 1, users: { peer: 1 } }, '👍': { total: 1, users: { me: 1 } } });
    expect(r.total).toBe(2);
    expect(r.lastReact).toBe('👍');
  });

  test('onePerUser_sameEmojiAgainIsNotCountedTwice', () => {
    const r = applyMessageReaction(data({ '❤️': { me: 1 } }), 'me', '❤️', true);
    expect(r.emoji).toEqual({ '❤️': { total: 1, users: { me: 1 } } });
    expect(r.total).toBe(1);
  });

  test('onePerUser_lastOldReactionOfAnEmojiRemovesTheEmoji', () => {
    const r = applyMessageReaction(data({ '❤️': { me: 1 } }), 'me', '👍', true);
    expect(Object.keys(r.emoji)).toEqual(['👍']);
  });

  // Zalo cho một người thả nhiều lần / nhiều loại: giữ nguyên cách cộng dồn cũ.
  test('stacking_keepsEarlierReactionsOfTheSameUser', () => {
    let r = applyMessageReaction(data({ '❤️': { me: 1 } }), 'me', '👍', false);
    r = applyMessageReaction(r, 'me', '👍', false);
    expect(r.emoji).toEqual({ '❤️': { total: 1, users: { me: 1 } }, '👍': { total: 2, users: { me: 2 } } });
    expect(r.total).toBe(3);
  });

  test.each([true, false])('emptyEmojiRemovesAllReactionsOfThatUser_onePerUser=%s', (onePerUser) => {
    const r = applyMessageReaction(data({ '❤️': { me: 1, peer: 1 }, '👍': { me: 2 } }), 'me', '', onePerUser);
    expect(r.emoji).toEqual({ '❤️': { total: 1, users: { peer: 1 } } });
    expect(r.total).toBe(1);
  });
});
