interface ReactionCounts {
  total: number;
  lastReact: string;
  emoji: Record<string, { total: number; users: Record<string, number> }>;
}

function removeUserReactions(current: ReactionCounts, userId: string): void {
  for (const emo of Object.keys(current.emoji)) {
    const userCount = current.emoji[emo].users[userId] || 0;
    if (userCount > 0) {
      current.emoji[emo].total -= userCount;
      current.total -= userCount;
      delete current.emoji[emo].users[userId];
      if (current.emoji[emo].total <= 0) delete current.emoji[emo];
    }
  }
}

/**
 * Áp một lượt cảm xúc lên dữ liệu cảm xúc của tin (sửa tại chỗ rồi trả lại). icon rỗng = người đó gỡ cảm xúc.
 * onePerUser: mỗi người chỉ có một cảm xúc trên một tin (Facebook) nên cảm xúc mới thay cảm xúc cũ;
 * false thì cộng dồn như Zalo.
 */
export function applyMessageReaction<T extends ReactionCounts>(current: T, userId: string, icon: string, onePerUser: boolean): T {
  if (!icon || onePerUser) removeUserReactions(current, userId);
  if (!icon) return current;
  if (!current.emoji[icon]) current.emoji[icon] = { total: 0, users: {} };
  current.emoji[icon].total++;
  current.emoji[icon].users[userId] = (current.emoji[icon].users[userId] || 0) + 1;
  current.total++;
  current.lastReact = icon;
  return current;
}
